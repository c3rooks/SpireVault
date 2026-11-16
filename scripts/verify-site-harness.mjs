/**
 * The page-loading half of scripts/verify-site.mjs: the canned network cases,
 * a page with its problems recorded as they happen, and two file and scroll
 * helpers. The checks themselves are in verify-site.mjs.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SITE_ROOT = join(REPO_ROOT, "Site");
export const NAV_TIMEOUT_MS = 180_000;
/** Hosts the content-security-policy allows the page to talk to. */
export const ALLOWED_HOSTS = Object.freeze(["127.0.0.1", "localhost", "vault-coop.coreycrooks.workers.dev", "api.github.com", "static.cloudflareinsights.com", "cloudflareinsights.com"]);

export const RELEASE = Object.freeze({
  dmg: "https://github.com/c3rooks/SpireVault/releases/download/v9.9.9-test/The.Vault.dmg",
  exe: "https://github.com/c3rooks/SpireVault/releases/download/v9.9.9-test/The.Vault_9.9.9_x64-setup.exe",
});
export const RELEASES_PAGE = "https://github.com/c3rooks/SpireVault/releases/latest";
/** The three network cases the page must handle. */
export const SCENARIOS = Object.freeze({
  busy: {
    presence: () => Array.from({ length: 7 }, (_, i) => ({ inSTS2: i < 2 })),
    release: () => ({
      tag_name: "v9.9.9-test",
      assets: [
        { name: "The.Vault.dmg", browser_download_url: RELEASE.dmg },
        { name: "The.Vault_9.9.9_x64-setup.exe", browser_download_url: RELEASE.exe },
        { name: "The.Vault_9.9.9_x64-setup.exe.blockmap", browser_download_url: `${RELEASE.exe}.blockmap` },
      ],
    }),
  },
  empty: { presence: () => [], release: () => ({ tag_name: "v1.2.3", assets: [] }) },
  down: { presence: null, release: null },
});



/**
 * True when the file exists under exactly this spelling. This Mac's disk
 * ignores letter case and Cloudflare Pages does not, so a bare existsSync
 * would pass a reference that is missing once deployed.
 * @param {string} file
 */
export function existsExactly(file) {
  if (!existsSync(file)) return false;
  try {
    return realpathSync.native(file) === join(realpathSync.native(SITE_ROOT), file.slice(SITE_ROOT.length));
  } catch {
    return false;
  }
}

/** Answers the page's two endpoints for one scenario. */
export async function stubNetwork(page, scenario) {
  const answer = (route, make) => {
    if (!make) return route.abort("failed");
    return route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(make()) });
  };
  await page.route("**/vault-coop.coreycrooks.workers.dev/**", (route) => answer(route, scenario.presence));
  await page.route("**/api.github.com/**", (route) => answer(route, scenario.release));
}

/**
 * A page on the site with its problems recorded as they happen.
 * @returns {Promise<{ page: import("playwright").Page, context: import("playwright").BrowserContext, log: { console: string[], failed: string[], hosts: string[], bytes: number, responses: Array<{ url: string, status: number, bytes: number }> } }>}
 */
export async function openPage(browser, baseUrl, { width, height, scenario = SCENARIOS.busy, query = "climber=ironclad&motion=off", reducedMotion, phone = false, scale = 1 }) {
  const engine = browser.browserType().name();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    ...(reducedMotion ? { reducedMotion } : {}),
    ...(phone && engine !== "firefox" ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const log = { console: [], failed: [], hosts: [], bytes: 0, responses: [] };
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective}: ${e.blockedURI || "inline"}`));
    window.__cls = 0;
    try {
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) if (!entry.hadRecentInput) window.__cls += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      /* engines without these observers: the perf group only runs in Chromium */
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") log.console.push(message.text());
  });
  page.on("pageerror", (error) => log.console.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const url = request.url();
    // The "down" scenario aborts these two on purpose.
    if (/vault-coop\.coreycrooks\.workers\.dev|api\.github\.com/.test(url)) return;
    log.failed.push(`${request.failure()?.errorText || "failed"} ${url}`);
  });
  page.on("request", (request) => {
    try {
      const host = new URL(request.url()).hostname;
      if (!ALLOWED_HOSTS.includes(host)) log.hosts.push(host);
    } catch {
      /* data: and blob: URLs have no host to check */
    }
  });
  page.on("response", async (response) => {
    const url = response.url();
    if (response.status() >= 400) log.failed.push(`HTTP ${response.status()} ${url}`);
    if (!url.startsWith(baseUrl)) return;
    const body = await response.body().catch(() => null);
    const raw = body ? body.length : 0;
    // Text is weighed as it travels (gzipped); "/" and "/?…" are the document.
    const bytes = body && /(\.(html|css|js|svg|json)|\/)(\?|$)/.test(url) ? gzipSync(body).length : raw;
    log.bytes += bytes;
    log.responses.push({ url, status: response.status(), bytes });
  });
  await stubNetwork(page, scenario);
  await page.goto(`${baseUrl}/?${query}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(350);
  return { page, context, log };
}

export async function loadLazy(page) {
  await page.evaluate(async () => {
    // "instant" matters: with motion on, the page scrolls smoothly, a 50 ms
    // step never arrives anywhere, and the lazy images further down never
    // start loading.
    const step = Math.max(200, window.innerHeight - 100);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 50));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    // decode() on an image that never loads never settles, and evaluate()
    // has no timeout of its own: give up on a slow image and let the
    // broken-image check report it.
    const giveUp = new Promise((r) => setTimeout(r, 15_000));
    const decoded = Promise.all(Array.from(document.images, (img) => (img.complete ? null : img.decode().catch(() => null))));
    await Promise.race([decoded, giveUp]);
  });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
}
