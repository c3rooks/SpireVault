#!/usr/bin/env node
/**
 * Checks for the landing page in Site/ (spirevault.app). Exits 1 if any fail.
 *
 * Serves Site/ through scripts/dev-site.mjs, so the page runs under its real
 * headers and content-security-policy, with the two endpoints it calls
 * (presence, GitHub release) answered by stubs.
 *
 *   layout   no sideways scroll, nothing off-screen, cut or covered, no broken
 *            pictures; on phones 44px tap targets and 11px text
 *   fold     the whole first screen (headline, buttons, duel, hand) fits in
 *            1440x760 and 1728x950, and the copy fits the hero at every
 *            desktop width
 *   duel     each climber: figures, balloon and hand inside the hero, balloon
 *            clear of the boss
 *   health   no console errors, failed requests, CSP violations or requests
 *            to hosts the CSP does not list
 *   content  old brand names gone, Mega Crit notice and anchors present, every
 *            asset reference exists and is versioned, one shared ?v=
 *   links    every external link the old page had is still there
 *   wiring   live count, release links and version pills in three cases
 *            (people signed up, nobody, both endpoints down); the screenshot
 *            buttons; the climber's own speech line
 *   motion   nothing runs under reduced motion; otherwise only transform /
 *            opacity animate and the hero ignores the pointer
 *   perf     fonts load, the hero's room picture is preloaded, layout shift
 *            under 0.1, first-screen weight inside its budget
 *   contrast body text and button labels reach 4.5:1 (3:1 when large)
 *
 *   node scripts/verify-site.mjs
 *   node scripts/verify-site.mjs --only wiring,content
 *   node scripts/verify-site.mjs --engines chromium,webkit --widths 320,390,1440
 *   node scripts/verify-site.mjs --base-url http://127.0.0.1:8791
 */

import { chromium, firefox, webkit } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSiteServer } from "./site-server.mjs";
import { heroGeometry, lowContrast } from "./verify-site-page.mjs";
import { gzipSync } from "node:zlib";
import { collectFindings } from "./mobile-audit/page-checks.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_ROOT = join(REPO_ROOT, "Site");
const OWN_PORT = 8797;
const ENGINES = Object.freeze({ chromium, firefox, webkit });
const GROUPS = Object.freeze(["layout", "fold", "duel", "health", "content", "links", "wiring", "motion", "perf", "contrast"]);
const HEIGHTS = Object.freeze({ 320: 568, 375: 812, 390: 844, 768: 1024, 1024: 768, 1100: 720, 1280: 720, 1366: 768, 1440: 900, 1728: 1000, 1920: 1080, 2560: 1300 });
const DEFAULT_WIDTHS = "320,375,390,768,1024,1100,1280,1366,1440,1728,1920,2560";
/** The duel is checked at a phone and the two review windows, whatever --widths says. */
const DUEL_WIDTHS = Object.freeze([320, 390, 768, 1024, 1440, 1728]);
/** Every screen button's picture must exist in these sizes. */
const SHOT_FILES = Object.freeze(["960", "1440", "1920", "phone-780"]);
const PHONE_MAX_W = 480;
const DESKTOP_MIN_W = 1100;
const NAV_TIMEOUT_MS = 180_000;
/** Windows the first screen must fit whole: a 1440 laptop and his 1728 Safari. */
const FOLDS = Object.freeze([{ width: 1440, height: 760 }, { width: 1728, height: 950 }]);
const CLIMBERS = Object.freeze(["ironclad", "silent", "defect", "regent", "necrobinder", "fool"]);
const OLD_BRAND = /\bThe Vault\b|\bSpire Vault\b/i;
/** Hosts the content-security-policy allows the page to talk to. */
const ALLOWED_HOSTS = Object.freeze(["127.0.0.1", "localhost", "vault-coop.coreycrooks.workers.dev", "api.github.com", "static.cloudflareinsights.com", "cloudflareinsights.com"]);
/** Asset files that keep an unversioned name on purpose (old links point at them). */
const UNVERSIONED_OK = Object.freeze(["/assets/vault-mark.svg", "/assets/og.png"]);
/** Every external link today's page has: the new page must keep each. */
const REQUIRED_LINKS = Object.freeze([
  "https://github.com/c3rooks/SpireVault",
  "https://app.spirevault.app",
  "https://github.com/c3rooks/SpireVault/blob/main/SECURITY.md",
  "https://github.com/c3rooks/SpireVault/releases/latest",
  "https://github.com/c3rooks/SpireVault/blob/main/LICENSE",
  "https://github.com/c3rooks/SpireVault/issues/new",
  "https://github.com/c3rooks/SpireVault#build-from-source",
  "https://github.com/c3rooks/SpireVault#run-coach-beta",
  "https://coreycrooks.com",
  "https://apps.apple.com/us/app/ascension-companion/id6761977581",
]);
const REQUIRED_IDS = Object.freeze(["main", "features", "showcase", "coop", "trust", "install", "install-web", "install-mac", "install-win", "faq", "runcoach"]);
const FIRST_SCREEN_BUDGET = Object.freeze({ desktop: 520 * 1024, phone: 320 * 1024 });
/** Everything fetched before scrolling, lazy pictures included, may be this many times the budget. */
const LAZY_HEADROOM = 1.5;
const PHONE_LIMITS = Object.freeze({ ignore: "", minTapPx: 44, goodTapPx: 44, minTextPx: 11, goodTextPx: 12, zoomSafeInputPx: 16, maxSamples: 6, maxCoveredProbes: 300 });
const DESKTOP_LIMITS = Object.freeze({ ...PHONE_LIMITS, minTapPx: 24 });

const RELEASE = Object.freeze({
  dmg: "https://github.com/c3rooks/SpireVault/releases/download/v9.9.9-test/The.Vault.dmg",
  exe: "https://github.com/c3rooks/SpireVault/releases/download/v9.9.9-test/The.Vault_9.9.9_x64-setup.exe",
});
const RELEASES_PAGE = "https://github.com/c3rooks/SpireVault/releases/latest";
/** The three network cases the page must handle. */
const SCENARIOS = Object.freeze({
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

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const list = (name, fallback) => String(arg(name, fallback)).split(",").map((s) => s.trim()).filter(Boolean);

// ---- Server and pages ----------------------------------------------------------


/** Answers the page's two endpoints for one scenario. */
async function stubNetwork(page, scenario) {
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
async function openPage(browser, baseUrl, { width, height, scenario = SCENARIOS.busy, query = "climber=ironclad&motion=off", reducedMotion, phone = false, engine = "chromium" }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
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

async function loadLazy(page) {
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

// ---- Check groups ---------------------------------------------------------------

/** @returns {Promise<string[]>} */
async function checkLayout(browser, baseUrl, engine, width) {
  const phone = width <= PHONE_MAX_W;
  const { page, context, log } = await openPage(browser, baseUrl, { width, height: HEIGHTS[width] || 900, phone, engine });
  const failures = [];
  try {
    await loadLazy(page);
    const report = await page.evaluate(collectFindings, phone ? PHONE_LIMITS : DESKTOP_LIMITS);
    const names = (bucket) => (bucket.samples || []).map((s) => `${s.el || ""} "${s.text || ""}"`).join("; ");
    if (report.pageOverflowPx > 0) failures.push(`page scrolls sideways by ${report.pageOverflowPx}px`);
    for (const key of ["offscreen", "clipped", "truncated", "covered", "brokenImages"]) {
      if (report[key].count > 0) failures.push(`${key}: ${report[key].count} (${names(report[key])})`);
    }
    if (phone && report.targetsTooSmall.count > 0) failures.push(`tap targets under 44px: ${report.targetsTooSmall.count} (${names(report.targetsTooSmall)})`);
    if (report.textTooSmall.count > 0) failures.push(`text under 11px: ${report.textTooSmall.count} (${names(report.textTooSmall)})`);
    const emptyImages = await page.evaluate(() =>
      Array.from(document.images)
        .filter((img) => img.getBoundingClientRect().width > 0 && (!img.complete || img.naturalWidth === 0))
        .map((img) => img.getAttribute("src")),
    );
    if (emptyImages.length) failures.push(`pictures that did not load: ${emptyImages.join(", ")}`);
    if (log.failed.length) failures.push(`failed requests: ${[...new Set(log.failed)].join("; ")}`);
    if (width >= DESKTOP_MIN_W) {
      const geo = await page.evaluate(heroGeometry);
      if (geo.copyOverflow > 1) failures.push(`hero copy is ${geo.copyOverflow}px taller than the hero`);
      if (geo.lastCopyChild && geo.hero && geo.lastCopyChild.bottom > geo.hero.bottom - 8) failures.push("hero copy runs into the hero's bottom edge");
    }
  } finally {
    await context.close();
  }
  return failures;
}

async function checkFold(browser, baseUrl) {
  const failures = [];
  for (const fold of FOLDS) {
    const { page, context } = await openPage(browser, baseUrl, { ...fold });
    try {
      const geo = await page.evaluate(heroGeometry);
      const where = `${fold.width}x${fold.height}`;
      const inside = (box, label) => {
        if (!box) return failures.push(`${where}: ${label} missing`);
        if (box.bottom > fold.height + 0.5) failures.push(`${where}: ${label} runs ${Math.round(box.bottom - fold.height)}px below the fold`);
        if (geo.hero && (box.top < geo.hero.top - 0.5 || box.bottom > geo.hero.bottom + 0.5)) failures.push(`${where}: ${label} sticks out of the hero`);
        return null;
      };
      inside(geo.hero, "hero");
      inside(geo.lastCopyChild, "copy");
      inside(geo.climber, "climber");
      inside(geo.boss, "boss");
      inside(geo.balloon, "balloon");
      geo.cards.forEach((card, i) => inside(card, `stat card ${i + 1}`));
      if (geo.cards.length !== 6) failures.push(`${where}: expected 6 stat cards, found ${geo.cards.length}`);
    } finally {
      await context.close();
    }
  }
  return failures;
}

async function checkDuel(browser, baseUrl, widths) {
  const failures = [];
  const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  for (const width of widths) {
    for (const climber of CLIMBERS) {
      const { page, context } = await openPage(browser, baseUrl, { width, height: HEIGHTS[width] || 900, query: `climber=${climber}&motion=off`, phone: width <= PHONE_MAX_W });
      try {
        // The page picks a line at random: measure with this climber's longest
        // one, which makes the widest balloon, so the result is the same every run.
        await page.evaluate(() => {
          const balloon = document.getElementById("hero-balloon");
          const lines = window.SpireVaultSite ? window.SpireVaultSite.linesFor(document.documentElement.dataset.climber) : [];
          const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
          if (balloon && longest) balloon.textContent = longest;
        });
        const geo = await page.evaluate(heroGeometry);
        const where = `${climber} at ${width}`;
        for (const [label, box] of [["climber", geo.climber], ["boss", geo.boss], ["balloon", geo.balloon]]) {
          if (!box || box.width < 2) {
            failures.push(`${where}: ${label} not drawn`);
            continue;
          }
          if (box.left < 0 || box.right > geo.viewport.width + 0.5) failures.push(`${where}: ${label} runs off the side`);
          if (geo.hero && (box.top < geo.hero.top || box.bottom > geo.hero.bottom)) failures.push(`${where}: ${label} sticks out of the hero`);
        }
        if (geo.nav && geo.balloon && geo.balloon.top < geo.nav.bottom) failures.push(`${where}: balloon under the nav`);
        if (overlap(geo.balloon, geo.boss)) failures.push(`${where}: balloon overlaps the boss`);
        if (geo.balloon && geo.cards.some((card) => overlap(geo.balloon, card))) failures.push(`${where}: balloon overlaps the hand`);
        // Feet together: the climber's box sits on the ground line, the boss's boots at 92.2% of his.
        if (geo.climber && geo.boss) {
          const bossBoots = geo.boss.top + geo.boss.height * 0.922;
          if (Math.abs(geo.climber.bottom - bossBoots) > 3) failures.push(`${where}: feet ${Math.round(Math.abs(geo.climber.bottom - bossBoots))}px apart in height`);
          if (geo.climber.right > geo.boss.left + geo.boss.width * 0.25) failures.push(`${where}: climber stands inside the boss`);
        }
        const art = await page.evaluate(() => getComputedStyle(document.querySelector(".actor--climber .actor-art")).backgroundImage);
        if (!art.includes(climber === "regent" ? "regent-ink-v2" : `${climber}-ink-v1`)) failures.push(`${where}: wrong sprite (${art})`);
      } finally {
        await context.close();
      }
    }
  }
  return failures;
}

async function checkHealth(browser, baseUrl) {
  const { page, context, log } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad" });
  const failures = [];
  try {
    await loadLazy(page);
    await page.waitForTimeout(600);
    const bare = await page.evaluate(() => Array.from(document.querySelectorAll("[data-lazy-art]")).filter((el) => getComputedStyle(el).backgroundImage === "none" || getComputedStyle(el.querySelector(".actor-art")).backgroundImage === "none").length);
    if (bare) failures.push(`${bare} room(s) further down never loaded their picture after scrolling to them`);
    const csp = await page.evaluate(() => window.__csp || []);
    if (csp.length) failures.push(`content-security-policy violations: ${[...new Set(csp)].join("; ")}`);
    if (log.console.length) failures.push(`console errors: ${[...new Set(log.console)].join("; ")}`);
    if (log.failed.length) failures.push(`failed requests: ${[...new Set(log.failed)].join("; ")}`);
    if (log.hosts.length) failures.push(`requests to hosts the CSP does not list: ${[...new Set(log.hosts)].join(", ")}`);
    const inline = await page.evaluate(() => ({ styles: document.querySelectorAll("[style]").length, styleTags: document.querySelectorAll("style").length, scripts: document.querySelectorAll("script:not([src])").length }));
    if (inline.styleTags || inline.scripts) failures.push(`inline <style> or <script> in the page (${inline.styleTags}/${inline.scripts})`);
    if (inline.styles) failures.push(`${inline.styles} element(s) carry a style attribute, which the CSP would block`);
  } finally {
    await context.close();
  }
  return failures;
}

async function checkContent(browser, baseUrl) {
  const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900 });
  const failures = [];
  try {
    const found = await page.evaluate(() => {
      const attrs = [];
      document.querySelectorAll("[alt], [title], [aria-label], meta[content]").forEach((el) => {
        for (const name of ["alt", "title", "aria-label", "content"]) {
          const value = el.getAttribute(name);
          if (value) attrs.push(value);
        }
      });
      const refs = new Set();
      document.querySelectorAll("[src], link[href], [srcset]").forEach((el) => {
        for (const name of ["src", "href"]) {
          const value = el.getAttribute(name);
          if (value && value.startsWith("/")) refs.add(value);
        }
        const srcset = el.getAttribute("srcset");
        if (srcset) srcset.split(",").forEach((part) => refs.add(part.trim().split(/\s+/)[0]));
      });
      // Link-preview pictures are absolute URLs on the live host: check the file they name.
      document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
        try {
          const url = new URL(meta.getAttribute("content") || "");
          if (url.hostname === "spirevault.app") refs.add(url.pathname + url.search);
        } catch {
          refs.add("(unreadable link-preview picture URL)");
        }
      });
      return {
        text: document.body.innerText,
        title: document.title,
        attrs,
        refs: [...refs],
        ids: Array.from(document.querySelectorAll("[id]"), (el) => el.id),
        h1: document.querySelectorAll("h1").length,
      };
    });
    const everything = [found.title, found.text, ...found.attrs].join("\n");
    const brand = OLD_BRAND.exec(everything);
    if (brand) failures.push(`old brand name on the page: "${brand[0]}"`);
    if (!/Not affiliated with Mega Crit/i.test(found.text)) failures.push("Mega Crit notice missing");
    if (!/SpireVault/.test(found.title)) failures.push("title does not say SpireVault");
    if (found.h1 !== 1) failures.push(`expected one h1, found ${found.h1}`);
    for (const id of REQUIRED_IDS) if (!found.ids.includes(id)) failures.push(`anchor #${id} missing`);
    const dupes = found.ids.filter((id, i) => found.ids.indexOf(id) !== i);
    if (dupes.length) failures.push(`duplicate ids: ${[...new Set(dupes)].join(", ")}`);

    // Every local reference, in the page and in the stylesheets, must exist;
    // everything under /assets/ must carry a version in its name.
    const cssRefs = [];
    for (const ref of found.refs.filter((r) => /\.css(\?|$)/.test(r))) {
      const file = join(SITE_ROOT, ref.split("?")[0]);
      if (!existsSync(file)) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)) cssRefs.push(m[1]);
    }
    const versions = new Set();
    for (const ref of [...new Set([...found.refs, ...cssRefs])]) {
      const [path, query] = ref.split("?");
      if (!existsSync(join(SITE_ROOT, path))) failures.push(`missing file: ${ref}`);
      if (path.startsWith("/assets/") && !UNVERSIONED_OK.includes(path) && !/-v\d+\.[a-z0-9]+$/.test(path)) failures.push(`asset without a version in its name: ${path}`);
      if (/\.(css|js)$/.test(path)) versions.add(query || "(none)");
    }
    if (versions.size !== 1 || versions.has("(none)")) failures.push(`CSS and JS must share one ?v=; found ${[...versions].join(", ")}`);
  } finally {
    await context.close();
  }
  return failures;
}

async function checkLinks(browser, baseUrl) {
  const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, scenario: SCENARIOS.down });
  const failures = [];
  try {
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]"), (a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel })));
    const all = hrefs.map((h) => (h.href || "").replace(/\/$/, ""));
    for (const want of REQUIRED_LINKS) if (!all.includes(want)) failures.push(`link missing: ${want}`);
    for (const h of hrefs) {
      if (h.target === "_blank" && !/noopener/.test(h.rel)) failures.push(`new-tab link without rel=noopener: ${h.href}`);
      if (/^https?:/.test(h.href || "") && !/^https:\/\/(github\.com\/c3rooks\/SpireVault|app\.spirevault\.app|coreycrooks\.com|apps\.apple\.com\/us\/app\/ascension-companion)/.test(h.href)) failures.push(`unexpected external link: ${h.href}`);
    }
  } finally {
    await context.close();
  }
  return failures;
}

async function checkWiring(browser, baseUrl) {
  const failures = [];
  const read = (page) =>
    page.evaluate(() => {
      const text = (id) => (document.getElementById(id)?.textContent || "").trim();
      const link = (id) => {
        const a = document.getElementById(id);
        return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") } : null;
      };
      return {
        presence: text("presence-text"),
        count: text("presence-count"),
        label: text("presence-label"),
        ingame: text("presence-ingame"),
        empty: document.getElementById("coop-card")?.classList.contains("is-empty"),
        pills: ["hero-version", "hero-version-win", "install-version", "install-version-win"].map(text),
        dmg: link("dmg-link"),
        macCta: link("download-cta-mac"),
        exe: link("exe-link"),
        winCta: link("download-cta-win"),
      };
    });
  const expect = (where, label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${where}: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  const cases = [
    ["busy", SCENARIOS.busy, (s) => {
      expect("busy", "hero line", s.presence, "7 signed up · 2 currently in Slay the Spire 2");
      expect("busy", "count", [s.count, s.label, s.ingame, s.empty], ["7", "players signed up", "2", false]);
      expect("busy", "version pills", s.pills, ["v9.9.9-test", "v9.9.9-test", "v9.9.9-test", "v9.9.9-test"]);
      expect("busy", "macOS download", s.dmg, { href: RELEASE.dmg, target: "_blank", rel: "noopener" });
      expect("busy", "hero macOS link", s.macCta, { href: RELEASE.dmg, target: "_blank", rel: "noopener" });
      expect("busy", "Windows download", s.exe, { href: RELEASE.exe, target: "_blank", rel: "noopener" });
      expect("busy", "hero Windows link", s.winCta, { href: RELEASE.exe, target: "_blank", rel: "noopener" });
    }],
    ["empty", SCENARIOS.empty, (s) => {
      expect("empty", "hero line", s.presence, "Be the first to sign up.");
      expect("empty", "count", [s.count, s.label, s.ingame, s.empty], ["—", "no one signed up yet · be the first", "—", true]);
      // A release with no installers: the tag is known for macOS; no Windows pill is claimed.
      expect("empty", "version pills", s.pills, ["v1.2.3", "", "v1.2.3", ""]);
      expect("empty", "macOS download", s.dmg?.href, RELEASES_PAGE);
      expect("empty", "hero macOS link", s.macCta?.href, "#install-mac");
      expect("empty", "Windows download", s.exe?.href, RELEASES_PAGE);
      expect("empty", "hero Windows link", s.winCta?.href, "#install-win");
    }],
    ["down", SCENARIOS.down, (s) => {
      expect("down", "hero line", s.presence, "Live count unavailable right now.");
      expect("down", "count", [s.count, s.label, s.ingame, s.empty], ["—", "live count unavailable right now", "—", true]);
      expect("down", "version pills", s.pills, ["", "", "", ""]);
      expect("down", "macOS download", s.dmg?.href, RELEASES_PAGE);
      expect("down", "Windows download", s.exe?.href, RELEASES_PAGE);
    }],
  ];
  for (const [name, scenario, assert] of cases) {
    const { page, context, log } = await openPage(browser, baseUrl, { width: 1440, height: 900, scenario });
    try {
      await page.waitForTimeout(500);
      assert(await read(page));
      if (log.console.length && name !== "down") failures.push(`${name}: console errors: ${log.console.join("; ")}`);
    } finally {
      await context.close();
    }
  }

  // The screenshot buttons: each one swaps the picture, by click and by arrow key.
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900 });
    try {
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".viewer-tab"), (t) => t.dataset.shot));
      if (tabs.length < 5) failures.push(`viewer: expected at least 5 screen buttons, found ${tabs.length}`);
      for (const shot of tabs) {
        await page.click(`.viewer-tab[data-shot="${shot}"]`);
        const state = await page.evaluate((name) => {
          const tab = document.querySelector(`.viewer-tab[data-shot="${name}"]`);
          const img = document.getElementById("viewer-shot");
          return { selected: tab.getAttribute("aria-selected"), src: img.getAttribute("src"), alt: img.getAttribute("alt"), others: document.querySelectorAll('.viewer-tab[aria-selected="true"]').length, labelledby: document.getElementById("viewer-panel").getAttribute("aria-labelledby"), id: tab.id };
        }, shot);
        await page
          .waitForFunction((name) => {
            const img = document.getElementById("viewer-shot");
            return img.complete && img.naturalWidth > 0 && img.currentSrc.includes(`/assets/shots/${name}-`);
          }, shot, { timeout: 20_000 })
          .catch(() => failures.push(`viewer: the ${shot} picture did not load`));
        for (const size of SHOT_FILES) {
          if (!existsSync(join(SITE_ROOT, "assets", "shots", `${shot}-${size}-v1.webp`))) failures.push(`viewer: missing file assets/shots/${shot}-${size}-v1.webp`);
        }
        if (state.selected !== "true" || state.others !== 1) failures.push(`viewer: ${shot} not the one selected button`);
        if (!state.src.includes(`/assets/shots/${shot}-`)) failures.push(`viewer: ${shot} shows ${state.src}`);
        if (!state.alt || state.alt.length < 20) failures.push(`viewer: ${shot} has no description`);
        if (state.labelledby !== state.id) failures.push(`viewer: panel not labelled by the ${shot} button`);
      }
      await page.focus(`.viewer-tab[data-shot="${tabs[0]}"]`);
      await page.keyboard.press("ArrowDown");
      const moved = await page.evaluate(() => document.activeElement?.dataset?.shot || "");
      if (moved !== tabs[1]) failures.push(`viewer: ArrowDown from the first button lands on "${moved}"`);
    } finally {
      await context.close();
    }
  }

  // A link to an answer opens it; on a phone the hand's scroll row can be reached by keyboard.
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 390, height: 844, query: "climber=ironclad&motion=off#runcoach", phone: true });
    try {
      const state = await page.evaluate(() => ({ open: document.getElementById("runcoach")?.open === true, handTab: document.querySelector(".hand")?.getAttribute("tabindex") }));
      if (!state.open) failures.push("a link to #runcoach does not open that answer");
      if (state.handTab !== "0") failures.push("on a phone the hand's scroll row has no tab stop");
    } finally {
      await context.close();
    }
  }

  // The climber speaks one of their own lines, and is named for screen readers.
  for (const climber of CLIMBERS) {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: `climber=${climber}&motion=off` });
    try {
      const state = await page.evaluate(() => ({ line: document.getElementById("hero-balloon")?.textContent?.trim() || "", label: document.getElementById("hero-climber")?.getAttribute("aria-label") || "", lines: window.SpireVaultSite ? window.SpireVaultSite.linesFor(document.documentElement.dataset.climber) : null }));
      if (!state.lines) failures.push(`balloon (${climber}): window.SpireVaultSite.linesFor missing`);
      else if (!state.lines.includes(state.line)) failures.push(`balloon (${climber}): "${state.line}" is not one of their lines`);
      const name = climber === "fool" ? "The Fool" : climber[0].toUpperCase() + climber.slice(1);
      if (!state.label.includes(name)) failures.push(`climber label "${state.label}" does not name ${name}`);
    } finally {
      await context.close();
    }
  }
  return failures;
}

async function checkMotion(browser, baseUrl) {
  const failures = [];
  const ALLOWED = ["transform", "translate", "rotate", "scale", "opacity", "clipPath", "filter", "offset", "computedOffset", "easing", "composite"];
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad", reducedMotion: "reduce" });
    try {
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
      if (running > 0) failures.push(`reduced motion: ${running} animation(s) still running`);
      const hidden = await page.evaluate(() => Array.from(document.querySelectorAll("[data-reveal]")).filter((el) => getComputedStyle(el).opacity !== "1").length);
      if (hidden > 0) failures.push(`reduced motion: ${hidden} section(s) left invisible`);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad" });
    try {
      const report = await page.evaluate((allowed) => {
        const animations = document.getAnimations();
        const bad = new Set();
        for (const animation of animations) {
          const frames = animation.effect && animation.effect.getKeyframes ? animation.effect.getKeyframes() : [];
          for (const frame of frames) for (const key of Object.keys(frame)) if (!allowed.includes(key)) bad.add(key);
        }
        return { running: animations.filter((a) => a.playState === "running").length, bad: [...bad] };
      }, ALLOWED);
      if (report.running < 1) failures.push("motion: nothing is animating in the hero");
      if (report.bad.length) failures.push(`motion: animating layout properties: ${report.bad.join(", ")}`);

      // The hero must not answer the pointer: freeze the clocks, move the mouse, compare.
      // pause() only takes hold on the next frame, so wait for it before measuring.
      await page.evaluate(async () => {
        const all = document.getAnimations();
        all.forEach((a) => a.pause());
        await Promise.all(all.map((a) => a.ready.catch(() => null)));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      const snapshot = () => page.evaluate(() => Array.from(document.querySelectorAll(".actor, .stat-card, .balloon, .scene-plane"), (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10)).join(","); }).join("|"));
      const before = await snapshot();
      for (const [x, y] of [[900, 300], [1100, 620], [1300, 200]]) {
        await page.mouse.move(x, y, { steps: 4 });
        await page.waitForTimeout(120);
      }
      if ((await snapshot()) !== before) failures.push("motion: something in the hero moved with the pointer");
    } finally {
      await context.close();
    }
  }
  return failures;
}

async function checkPerf(browser, baseUrl) {
  const failures = [];
  for (const [label, width, height, budget] of [["desktop", 1440, 900, FIRST_SCREEN_BUDGET.desktop], ["phone", 390, 844, FIRST_SCREEN_BUDGET.phone]]) {
    const { page, context, log } = await openPage(browser, baseUrl, { width, height, query: "climber=ironclad", phone: label === "phone" });
    try {
      await page.waitForTimeout(800);
      const state = await page.evaluate(() => ({
        fonts: ['900 40px "Grenze Gotisch"', '500 16px "Figtree"'].map((f) => document.fonts.check(f)),
        cls: window.__cls,
        preloads: Array.from(document.querySelectorAll('link[rel="preload"][as="image"]')).filter((l) => !l.media || matchMedia(l.media).matches).map((l) => new URL(l.href, location.href).pathname),
        roomPicture: getComputedStyle(document.querySelector(".scene-plane--base")).backgroundImage,
        lazy: Array.from(document.querySelectorAll('img[loading="lazy"]'), (img) => (img.currentSrc ? new URL(img.currentSrc).pathname : "")).filter(Boolean),
        heldBack: Array.from(document.querySelectorAll("[data-lazy-art]"), (el) => getComputedStyle(el).backgroundImage),
      }));
      if (state.fonts.includes(false)) failures.push(`${label}: a font did not load`);
      if (state.cls >= 0.1) failures.push(`${label}: layout shift ${state.cls.toFixed(3)}`);
      const room = /url\(["']?[^"')]*?(\/assets\/[^"')]+)["']?\)/.exec(state.roomPicture);
      if (!room) failures.push(`${label}: the hero has no room picture`);
      else if (!state.preloads.includes(room[1])) failures.push(`${label}: the room picture ${room[1]} is not preloaded (preloads: ${state.preloads.join(", ") || "none"})`);
      // Lazy pictures further down are fetched early by some browsers and not
      // by others; they are weighed apart, with a looser ceiling on the lot.
      const lazyBytes = log.responses.filter((r) => state.lazy.includes(new URL(r.url).pathname)).reduce((sum, r) => sum + r.bytes, 0);
      const needed = log.bytes - lazyBytes;
      const kb = (n) => Math.round(n / 1024);
      if (needed > budget) failures.push(`${label}: first screen weighs ${kb(needed)} KB, budget ${kb(budget)} KB`);
      if (log.bytes > budget * LAZY_HEADROOM) failures.push(`${label}: ${kb(log.bytes)} KB fetched before any scrolling, ceiling ${kb(budget * LAZY_HEADROOM)} KB`);
      const lit = state.heldBack.filter((image) => image !== "none").length;
      if (lit > 0) failures.push(`${label}: ${lit} room(s) below the first screen loaded their picture before any scrolling`);
      process.stdout.write(`    ${label}: first screen ${kb(needed)} KB + ${kb(lazyBytes)} KB of lazy pictures fetched early, ${log.responses.length} requests, shift ${Number(state.cls).toFixed(3)}\n`);
    } finally {
      await context.close();
    }
  }
  return failures;
}

async function checkContrast(browser, baseUrl) {
  const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900 });
  try {
    await loadLazy(page);
    // Open every answer, so its text is measured too.
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
    return await page.evaluate(lowContrast);
  } finally {
    await context.close();
  }
}

// ---- Runner ---------------------------------------------------------------------

async function main() {
  const only = list("only", GROUPS.join(","));
  const engines = list("engines", "chromium");
  const widths = list("widths", DEFAULT_WIDTHS).map(Number);
  for (const group of only) if (!GROUPS.includes(group)) throw new Error(`unknown group: ${group} (have: ${GROUPS.join(", ")})`);
  for (const engine of engines) if (!ENGINES[engine]) throw new Error(`unknown engine: ${engine}`);

  const external = arg("base-url");
  const server = external ? { baseUrl: external.replace(/\/$/, ""), stop: () => {} } : await startSiteServer(OWN_PORT);
  let failed = 0;
  let passed = 0;
  const run = async (name, check) => {
    let failures;
    try {
      failures = await check();
    } catch (error) {
      failures = [`check crashed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`];
    }
    if (failures.length) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}\n${failures.map((f) => `       - ${f}`).join("\n")}\n`);
    } else {
      passed += 1;
      process.stdout.write(`  ok   ${name}\n`);
    }
  };

  try {
    for (const engine of engines) {
      process.stdout.write(`${engine}\n`);
      const browser = await ENGINES[engine].launch();
      try {
        const want = (group) => only.includes(group);
        if (want("layout")) for (const width of widths) await run(`layout ${width}`, () => checkLayout(browser, server.baseUrl, engine, width));
        if (want("fold")) await run("fold", () => checkFold(browser, server.baseUrl));
        if (want("duel")) await run("duel", () => checkDuel(browser, server.baseUrl, DUEL_WIDTHS));
        if (want("health")) await run("health", () => checkHealth(browser, server.baseUrl));
        if (want("content")) await run("content", () => checkContent(browser, server.baseUrl));
        if (want("links")) await run("links", () => checkLinks(browser, server.baseUrl));
        if (want("wiring")) await run("wiring", () => checkWiring(browser, server.baseUrl));
        if (want("motion")) await run("motion", () => checkMotion(browser, server.baseUrl));
        if (want("perf") && engine === "chromium") await run("perf", () => checkPerf(browser, server.baseUrl));
        if (want("contrast")) await run("contrast", () => checkContrast(browser, server.baseUrl));
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.stop();
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`verify-site failed to run: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
