#!/usr/bin/env node
/**
 * Phone audit for the web app: both layouts, every tab, real phone profiles.
 *
 * iPhones are driven in WebKit (Safari's engine) and Android phones in
 * Chromium, each with its real screen size, pixel density, touch and user
 * agent. Every tab is opened and measured by mobile-audit/page-checks.mjs:
 * content running off the screen, controls too small to tap, text too small
 * to read, form fields that make iOS zoom, controls covered by something
 * else, and how much of the screen the fixed bars take.
 *
 *   node scripts/audit-mobile.mjs                        # both layouts, all phones, all tabs
 *   node scripts/audit-mobile.mjs --ui classic --phones mini,pixel --tabs overview,runs
 *   node scripts/audit-mobile.mjs --strips mini          # also write screen-by-screen filmstrips
 *   node scripts/audit-mobile.mjs --ui classic --base-url https://app.spirevault.app
 *   node scripts/audit-mobile.mjs --strict               # exit 1 if anything is broken
 *   node scripts/audit-mobile.mjs --signed-in --tabs coop,highlights,beta
 *                                                        # as a signed-in visitor: Co-op, Highlights and
 *                                                        # Beta show their content instead of the lock
 *
 * Against a remote --base-url only GET requests to that origin are let
 * through: no analytics, no beacons, nothing is written.
 *
 * Writes <out>/report.json (every finding with examples) and prints a table
 * of the worst case per tab. Default <out> is docs/screenshots/mobile-audit.
 */

import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFindings } from "./mobile-audit/page-checks.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8796;
const SERVER_BOOT_TIMEOUT_MS = 10000;
const APP_READY_TIMEOUT_MS = 20000;
const FIRST_SETTLE_MS = 2200;
const TAB_SETTLE_MS = 1100;
const FRAME_SETTLE_MS = 180;
const MAX_STRIP_FRAMES = 8;
const FIXTURE_SEED = 7;
const FIXTURE_COMPANION = "ironclad";

const ALL_TABS = Object.freeze([
  "overview",
  "characters",
  "ascensions",
  "relics",
  "cards",
  "runs",
  "coop",
  "highlights",
  "news",
  "beta",
  "settings",
]);

/** Phone profiles come from Playwright's device list; `engine` is the real browser engine on that phone. */
const PHONES = Object.freeze([
  { id: "se", device: "iPhone SE", engine: "webkit" },
  { id: "mini", device: "iPhone 13 Mini", engine: "webkit" },
  { id: "iphone", device: "iPhone 15", engine: "webkit" },
  { id: "galaxy", device: "Galaxy S8", engine: "chromium" },
  { id: "pixel", device: "Pixel 7", engine: "chromium" },
  { id: "sideways", device: "iPhone 15 landscape", engine: "webkit", sideways: true },
  // 768px wide: below the 880px line where the app switches to its phone shell.
  { id: "tablet", device: "iPad Mini", engine: "webkit" },
]);

/**
 * Thresholds, in CSS pixels. 24 is the WCAG 2.2 AA minimum target size and 44
 * is Apple's recommended one; 11 is the smallest text Apple's guidelines
 * allow; under 16 an input makes iOS Safari zoom the page on focus.
 */
const LIMITS = Object.freeze({
  // The co-op sandbox controls only exist on localhost; visitors never see them.
  ignore: "#coop-sandbox-toggle, .coop-beta-dev-sandbox, .coop-sandbox-panel",
  minTapPx: 24,
  goodTapPx: 44,
  minTextPx: 11,
  goodTextPx: 12,
  zoomSafeInputPx: 16,
  maxSamples: 8,
  maxCoveredProbes: 400,
});

const ENGINES = Object.freeze({ chromium, webkit });

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** @param {string} value */
function list(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

const options = Object.freeze({
  uis: list(arg("ui", "classic,next")),
  phones: list(arg("phones", PHONES.map((phone) => phone.id).join(","))),
  tabs: list(arg("tabs", ALL_TABS.join(","))),
  strips: list(arg("strips", "")),
  baseUrl: arg("base-url", ""),
  outDir: arg("out", join(REPO_ROOT, "docs", "screenshots", "mobile-audit")),
  label: arg("label", ""),
  strict: process.argv.includes("--strict"),
  signedIn: process.argv.includes("--signed-in"),
});

/** A stored Steam session, as Web/script.js keeps one (for --signed-in). */
const TEST_SESSION = Object.freeze({
  steamID: "76561198000000001",
  personaName: "TestClimber",
  sessionToken: "test-token",
  signedInAt: "2026-11-01T00:00:00.000Z",
});

/** Starts the static dev server and resolves once it is listening. */
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(DEFAULT_PORT)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => reject(new Error("dev-static did not start in time")), SERVER_BOOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Runs in the page before any app code: a fixed companion and a seeded Math.random. */
function installFixture({ companion, seed, session }) {
  try {
    window.localStorage.setItem("vault.web.companion.v2", companion);
    if (session) {
      window.localStorage.setItem("vault.web.session", JSON.stringify(session));
      // Co-op greets a new account with a one-time dialog that covers the
      // page (lib/party-finder-scene.js). Mark it seen: the audit measures
      // the tabs, not that dialog.
      window.localStorage.setItem("spirevault.coop.welcome.v1", "1");
    }
  } catch {
    /* storage unavailable: the companion is rolled randomly */
  }
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {import("playwright").Browser} browser
 * @param {typeof PHONES[number]} phone
 * @param {string} baseUrl
 */
async function openPhone(browser, phone, baseUrl) {
  const context = await browser.newContext({ ...devices[phone.device] });
  await context.addInitScript(installFixture, {
    companion: FIXTURE_COMPANION,
    seed: FIXTURE_SEED,
    session: options.signedIn ? TEST_SESSION : null,
  });
  const origin = new URL(baseUrl).origin;
  // Read-only and hermetic: same-origin GETs only.
  await context.route(
    (url) => url.protocol === "http:" || url.protocol === "https:",
    (route) => {
      const request = route.request();
      const sameOrigin = new URL(request.url()).origin === origin;
      return sameOrigin && request.method() === "GET" ? route.continue() : route.abort();
    }
  );
  return context;
}

/**
 * @param {import("playwright").Page} page
 * @param {string} tab
 * @param {boolean} isFirst
 */
async function showTab(page, tab, isFirst) {
  await page.evaluate((id) => window.SpireVault.switchTab(id), tab);
  await page.waitForSelector(`.tab-panel[data-tab="${tab}"]:not([hidden])`, { timeout: 8000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(isFirst ? FIRST_SETTLE_MS : TAB_SETTLE_MS);
}

/**
 * Captures the page one screen at a time, as someone scrolling would see it
 * (fixed bars included), and lays the screens out left to right.
 * @param {import("playwright").Page} page
 * @param {import("playwright").Page} composer
 * @param {string} title
 * @param {string} file
 */
async function writeStrip(page, composer, title, file) {
  const { pageHeight, screenHeight, screenWidth } = await page.evaluate(() => ({
    pageHeight: document.documentElement.scrollHeight,
    screenHeight: window.innerHeight,
    screenWidth: document.documentElement.clientWidth,
  }));
  const screens = Math.max(1, Math.ceil(pageHeight / screenHeight));
  const frames = [];
  for (let index = 0; index < Math.min(screens, MAX_STRIP_FRAMES); index++) {
    await page.evaluate((y) => window.scrollTo(0, y), index * screenHeight);
    await page.waitForTimeout(FRAME_SETTLE_MS);
    const png = await page.screenshot({ scale: "css" });
    frames.push(`data:image/png;base64,${png.toString("base64")}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const more = screens > MAX_STRIP_FRAMES ? ` · first ${MAX_STRIP_FRAMES} shown` : "";
  const figures = frames
    .map((src, index) => `<figure><img src="${src}" width="${screenWidth}" height="${screenHeight}"><figcaption>${index + 1}</figcaption></figure>`)
    .join("");
  await composer.setViewportSize({ width: frames.length * (screenWidth + 14) + 30, height: screenHeight + 90 });
  await composer.setContent(`<!doctype html><style>
    body{margin:0;background:#15131c;font:13px system-ui;color:#e9e4f5}
    #strip{display:inline-block;padding:12px 14px 10px}
    h1{font:600 14px system-ui;margin:0 0 10px}
    .row{display:flex;gap:14px}
    figure{margin:0}
    img{display:block;outline:1px solid #4a4560}
    figcaption{margin-top:6px;text-align:center;color:#a79fc0}
  </style><div id="strip"><h1>${title} · ${screens} screen${screens === 1 ? "" : "s"} long${more}</h1><div class="row">${figures}</div></div>`);
  await composer.locator("#strip").screenshot({ path: file });
  return screens;
}

/**
 * @param {import("playwright").Page} page
 * @param {import("playwright").Page} composer
 * @param {typeof PHONES[number]} phone
 * @param {string} ui
 * @param {string} tab
 */
async function stripFor(page, composer, phone, ui, tab) {
  const dir = join(options.outDir, "strips", ui);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tab}-${phone.id}.png`);
  const screens = await writeStrip(page, composer, `${ui} · ${phone.device} · ${tab}`, file);
  return { screens, strip: file };
}

/**
 * @param {import("playwright").Browser} browser
 * @param {import("playwright").Page} composer
 * @param {typeof PHONES[number]} phone
 * @param {string} ui
 * @param {string} baseUrl
 */
async function auditPhone(browser, composer, phone, ui, baseUrl) {
  const context = await openPhone(browser, phone, baseUrl);
  const results = [];
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
    await page.goto(`${baseUrl}/?ui=${ui}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: APP_READY_TIMEOUT_MS });
    await page.waitForSelector(".demo-banner, .v-ov, .kpi-strip, .empty-state", { timeout: 15000 }).catch(() => {});
    const actualUi = await page.evaluate(() => document.documentElement.getAttribute("data-ui") || "classic");
    if (actualUi !== ui) throw new Error(`asked for the ${ui} layout but the page booted ${actualUi}`);
    for (const [index, tab] of options.tabs.entries()) {
      try {
        await showTab(page, tab, index === 0);
      } catch (error) {
        results.push({ ui, phone: phone.id, tab, error: `could not open the tab: ${error instanceof Error ? error.message.split("\n")[0] : error}` });
        continue;
      }
      // Pictures first, so they can never include a side effect of measuring.
      const strip = options.strips.includes(phone.id) ? await stripFor(page, composer, phone, ui, tab) : null;
      const findings = await page.evaluate(collectFindings, LIMITS);
      results.push({ ui, phone: phone.id, tab, findings, pageErrors: pageErrors.splice(0), ...(strip || {}) });
    }
  } finally {
    await context.close();
  }
  return results;
}

/** Worst case across phones for one layout + tab. */
function worstCase(entries) {
  const measured = entries.filter((entry) => entry.findings);
  const max = (pick) => Math.max(0, ...measured.map((entry) => pick(entry.findings)));
  return {
    failedToOpen: entries.length - measured.length,
    overflowPx: max((f) => f.pageOverflowPx),
    offscreen: max((f) => f.offscreen.count),
    clipped: max((f) => f.clipped.count),
    covered: max((f) => f.covered.count),
    tinyTaps: max((f) => f.targetsTooSmall.count),
    tightTaps: max((f) => f.targetsTight.count),
    taps: max((f) => f.targetsChecked),
    tinyText: max((f) => f.textTooSmall.count),
    smallText: max((f) => f.textSmall.count),
    zoomInputs: max((f) => f.zoomInputs.count),
    pinnedShare: max((f) => (f.pinned.topPx + f.pinned.bottomPx) / f.viewport.height),
    startShare: max((f) => (f.contentStartPx === null ? 0 : f.contentStartPx / f.viewport.height)),
    screens: max((f) => f.pageHeightPx / f.viewport.height),
  };
}

/** Things that stop someone using the page, as opposed to things that are merely poor. */
function isBroken(worst) {
  return worst.failedToOpen > 0 || worst.overflowPx > 0 || worst.offscreen > 0 || worst.covered > 0 || worst.zoomInputs > 0;
}

/**
 * One row per layout + tab, worst case across the phones given. Upright and
 * sideways phones are summarised apart: a share of a 340px-tall screen is not
 * comparable with a share of a 660px-tall one.
 * @param {Array<object>} results
 * @param {ReadonlyArray<string>} phoneIds
 */
function summarise(results, phoneIds) {
  const rows = [];
  for (const ui of options.uis) {
    for (const tab of options.tabs) {
      const entries = results.filter((entry) => entry.ui === ui && entry.tab === tab && phoneIds.includes(entry.phone));
      if (entries.length === 0) continue;
      rows.push({ ui, tab, ...worstCase(entries) });
    }
  }
  return rows;
}

/** @param {ReturnType<typeof summarise>} rows */
function printTable(rows) {
  const percent = (value) => `${Math.round(value * 100)}%`;
  const columns = [
    ["layout", (r) => r.ui],
    ["tab", (r) => r.tab],
    ["wider", (r) => (r.overflowPx ? `${r.overflowPx}px` : "-")],
    ["off-screen", (r) => r.offscreen || "-"],
    ["cut", (r) => r.clipped || "-"],
    ["covered", (r) => r.covered || "-"],
    ["taps<24", (r) => `${r.tinyTaps}/${r.taps}`],
    ["taps<44", (r) => `${r.tightTaps}/${r.taps}`],
    ["text<11", (r) => r.tinyText || "-"],
    ["text<12", (r) => r.smallText || "-"],
    ["zoom", (r) => r.zoomInputs || "-"],
    ["bars", (r) => percent(r.pinnedShare)],
    ["starts", (r) => percent(r.startShare)],
    ["screens", (r) => r.screens.toFixed(1)],
    ["", (r) => (isBroken(r) ? "BROKEN" : "")],
  ];
  const cells = rows.map((row) => columns.map(([, render]) => String(render(row))));
  const widths = columns.map(([head], index) => Math.max(head.length, ...cells.map((line) => line[index].length)));
  const line = (parts) => parts.map((part, index) => part.padEnd(widths[index])).join("  ");
  process.stdout.write(`${line(columns.map(([head]) => head))}\n`);
  cells.forEach((parts) => process.stdout.write(`${line(parts)}\n`));
}

async function main() {
  const phones = PHONES.filter((phone) => options.phones.includes(phone.id));
  if (phones.length === 0) throw new Error(`audit-mobile: no phone matches --phones ${options.phones.join(",")}`);
  mkdirSync(options.outDir, { recursive: true });
  const server = options.baseUrl ? null : await startServer();
  const baseUrl = (options.baseUrl || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, "");
  const browsers = new Map();
  const results = [];
  try {
    const composerBrowser = await chromium.launch();
    browsers.set("composer", composerBrowser);
    const composer = await composerBrowser.newPage();
    for (const phone of phones) {
      if (!browsers.has(phone.engine)) browsers.set(phone.engine, await ENGINES[phone.engine].launch());
      for (const ui of options.uis) {
        process.stderr.write(`· ${ui} on ${phone.device}\n`);
        try {
          results.push(...(await auditPhone(browsers.get(phone.engine), composer, phone, ui, baseUrl)));
        } catch (error) {
          const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
          options.tabs.forEach((tab) => results.push({ ui, phone: phone.id, tab, error: message }));
          process.stderr.write(`  failed: ${message}\n`);
        }
      }
    }
  } finally {
    await Promise.all(Array.from(browsers.values()).map((browser) => browser.close()));
    if (server) server.kill();
  }
  const upright = summarise(results, phones.filter((phone) => !phone.sideways).map((phone) => phone.id));
  const sideways = summarise(results, phones.filter((phone) => phone.sideways).map((phone) => phone.id));
  const name = options.label ? `report-${options.label}.json` : "report.json";
  writeFileSync(
    join(options.outDir, name),
    `${JSON.stringify({ baseUrl, limits: LIMITS, phones, summary: { upright, sideways }, results }, null, 1)}\n`
  );
  if (upright.length > 0) {
    process.stdout.write("Upright — worst case across phones\n");
    printTable(upright);
  }
  if (sideways.length > 0) {
    process.stdout.write("\nHeld sideways\n");
    printTable(sideways);
  }
  process.stdout.write(`\nreport: ${join(options.outDir, name)}\n`);
  if (options.strict && [...upright, ...sideways].some(isBroken)) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`audit-mobile failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
