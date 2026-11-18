#!/usr/bin/env node
/**
 * Smoke test for a deployed web app (a Pages preview, or production right
 * after a deploy). Read-only: it loads pages as a first-time guest and never
 * signs in, posts, or changes anything.
 *
 * For each engine (Chromium, WebKit), look (new look by default, classic via
 * ?ui=classic) and viewport (390x844 phone, 1440x900 desktop) it opens every
 * tab and checks:
 *   - the build marker matches the local Web/script.js (VAULT_BUILD)
 *   - the default look is the new look, and ?ui=classic gives classic
 *   - every tab's panel shows, with no sideways scroll
 *   - no uncaught page errors, no 5xx, no failed same-origin static file
 *   - og:image points at the host being tested
 *   - /sw.js (the co-op ping worker; it caches nothing) is served as JavaScript
 *   - (optional) news post 015 carries the release date
 * A preview must never make the browser request production
 * (app.spirevault.app): Pages answers a not-yet-deployed /assets/ path with
 * HTML under a year-long cache header. On a preview such requests are
 * blocked and reported as failures.
 *
 *   node scripts/smoke-web.mjs --url https://rc-1117.vault-web-e90.pages.dev
 *   node scripts/smoke-web.mjs --url https://app.spirevault.app --news-date "November 17, 2026"
 *   options: --engines chromium,webkit   --out <dir>   --build <VAULT_BUILD>
 */

import { chromium, webkit } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROD_HOST = "app.spirevault.app";
const VIEWPORTS = Object.freeze([
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
]);
const LOOKS = Object.freeze([
  { name: "next", query: "", expect: "next" },
  { name: "classic", query: "?ui=classic", expect: "classic" },
]);
const SKIP_TABS = new Set(["overlay"]);
const READY_TIMEOUT_MS = 30_000;
/** Guests are expected to get these. */
const EXPECTED_STATUS = Object.freeze([{ path: /^\/api\/_session$/, status: 401 }]);

function parseArgs(argv) {
  const options = { url: "", engines: ["chromium", "webkit"], out: "", build: "", newsDate: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const value = () => argv[(i += 1)] || "";
    if (token === "--url") options.url = value();
    else if (token === "--engines") options.engines = value().split(",").filter(Boolean);
    else if (token === "--out") options.out = value();
    else if (token === "--build") options.build = value();
    else if (token === "--news-date") options.newsDate = value();
    else throw new Error(`unknown option: ${token}`);
  }
  const isOrigin = /^https:\/\/[a-z0-9.-]+\/?$/.test(options.url) || /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(options.url);
  if (!isOrigin) throw new Error("--url must be an https origin (or http://127.0.0.1:<port> to test the script), e.g. https://app.spirevault.app");
  options.url = options.url.replace(/\/$/, "");
  if (!options.build) {
    const match = readFileSync(join(REPO_ROOT, "Web/script.js"), "utf8").match(/const VAULT_BUILD = "([^"]+)"/);
    if (!match) throw new Error("could not read VAULT_BUILD from Web/script.js");
    options.build = match[1];
  }
  const host = new URL(options.url).host;
  if (!options.out) options.out = join(homedir(), "Library", "Caches", "spirevault-web", `smoke-${host}`);
  return { ...options, host, isProd: host === PROD_HOST, isLocal: host.startsWith("127.0.0.1:") };
}

/** Collects problems for one page; returns a function that reads them. */
function watch(page, options, problems, label) {
  page.on("pageerror", (error) => problems.push(`${label}: page error: ${String(error.message).slice(0, 200)}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    const status = response.status();
    if (status < 400) return;
    if (EXPECTED_STATUS.some((rule) => rule.path.test(url.pathname) && rule.status === status)) return;
    const sameOrigin = url.host === options.host;
    const isApi = url.pathname.startsWith("/api/");
    if (status >= 500 || (sameOrigin && !isApi)) problems.push(`${label}: ${status} ${url.pathname}`);
    else problems.push(`${label}: (note) ${status} ${url.host}${url.pathname}`);
  });
}

async function openTabs(page, look, viewport, engineName, options, problems) {
  const label = `${engineName}/${look.name}/${viewport.name}`;
  await page.goto(`${options.url}/${look.query}`, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__VAULT_BUILD__ && window.SpireVault), null, { timeout: READY_TIMEOUT_MS });
  const head = await page.evaluate(() => ({
    build: window.__VAULT_BUILD__,
    ui: document.documentElement.dataset.ui || "classic",
    og: document.querySelector('meta[property="og:image"]')?.content || "",
    tabs: window.SpireVault.knownTabs(),
    eyebrow: document.querySelector("#news-015")?.dataset?.newsEyebrow || "",
  }));
  if (head.build !== options.build) problems.push(`${label}: build ${head.build}, expected ${options.build}`);
  if (head.ui !== look.expect) problems.push(`${label}: look is "${head.ui}", expected "${look.expect}"`);
  if (head.og && !options.isLocal && new URL(head.og).host !== options.host) problems.push(`${label}: og:image points at ${new URL(head.og).host}`);
  if (options.newsDate && !head.eyebrow.includes(options.newsDate)) problems.push(`${label}: news 015 eyebrow is "${head.eyebrow}"`);
  const seen = [];
  for (const tab of head.tabs.filter((t) => !SKIP_TABS.has(t))) {
    const switched = await page.evaluate((t) => window.SpireVault.switchTab(t), tab);
    if (!switched) { problems.push(`${label}: switchTab("${tab}") refused`); continue; }
    try {
      await page.waitForSelector(`.tab-panel[data-tab="${tab}"]:not([hidden])`, { timeout: 10_000 });
    } catch {
      problems.push(`${label}: ${tab} panel never showed`);
      continue;
    }
    await page.evaluate(() => document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${label}: ${tab} scrolls sideways by ${overflow}px`);
    await page.screenshot({ path: join(options.out, `${engineName}-${look.name}-${viewport.name}-${tab}.png`) });
    seen.push(tab);
  }
  return seen;
}

/** The co-op ping worker must be served as JavaScript (an HTML fallback would break pings). */
async function serviceWorkerFile(page) {
  return page.evaluate(async () => {
    const r = await fetch("/sw.js", { cache: "no-store" });
    return { status: r.status, type: r.headers.get("content-type") || "" };
  });
}

async function run(options) {
  mkdirSync(options.out, { recursive: true });
  const engines = { chromium, webkit };
  const problems = [];
  const notes = [];
  for (const engineName of options.engines) {
    const browser = await engines[engineName].launch();
    try {
      for (const look of LOOKS) {
        for (const viewport of VIEWPORTS) {
          const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
          const label = `${engineName}/${look.name}/${viewport.name}`;
          if (!options.isProd) {
            await context.route((url) => url.host === PROD_HOST, (route) => {
              problems.push(`${label}: blocked a request to production: ${route.request().url()}`);
              return route.abort();
            });
          }
          const page = await context.newPage();
          watch(page, options, problems, label);
          try {
            const seen = await openTabs(page, look, viewport, engineName, options, problems);
            notes.push(`${label}: ${seen.length} tabs`);
            if (engineName === "chromium" && look.name === "next" && viewport.name === "desktop") {
              const sw = await serviceWorkerFile(page);
              if (sw.status !== 200 || !/javascript/.test(sw.type)) problems.push(`${label}: /sw.js answered ${sw.status} ${sw.type}`);
              else notes.push(`${label}: /sw.js served as ${sw.type.split(";")[0]}`);
            }
          } catch (error) {
            problems.push(`${label}: ${String(error.message).split("\n")[0]}`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  return { problems, notes };
}

const options = parseArgs(process.argv.slice(2));
const { problems, notes } = await run(options);
const failures = problems.filter((p) => !p.includes("(note)"));
process.stdout.write(`Smoke test of ${options.url} (build ${options.build})\n${notes.map((n) => `  ok  ${n}`).join("\n")}\n`);
if (problems.length) process.stdout.write(`${problems.map((p) => `  ${p.includes("(note)") ? "note" : "FAIL"}  ${p}`).join("\n")}\n`);
process.stdout.write(`Screenshots: ${options.out}\n${failures.length ? `${failures.length} failures` : "all checks passed"}\n`);
process.exit(failures.length ? 1 : 0);
