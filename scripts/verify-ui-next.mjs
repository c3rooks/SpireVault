#!/usr/bin/env node
/**
 * Behavioural checks for the new UI ("next") and for the promise that the
 * classic layout is untouched unless a visitor opts in.
 *
 * Starts Web/scripts/dev-static.mjs (which enforces the production CSP),
 * drives it with Playwright and exits non-zero on the first failed check.
 *
 *   node scripts/verify-ui-next.mjs
 *   node scripts/verify-ui-next.mjs --only parity,switch   # a subset of groups
 *
 * Covers: default variant, opt-in and URL tidy-up, the DOM contract other
 * code depends on, the data-driven stage, sticky rail, instant theme
 * switching and persistence, deep links, reduced motion, desktop-host mode
 * and the host bridge, the load-failure fallback, analytics tagging,
 * horizontal overflow across breakpoints, the header duel's staging, the
 * one-word brand, the opt-in beta switch (Settings, Beta tab, news post),
 * parity: the new Overview shows every number the classic one does, and the
 * section filters (By character mode + ascension + Solo / Co-op, the
 * Ascensions climber, ladder and party, the Runs mode and party chips) with
 * each climber's win streak (Custom and daily runs left out), the Co-op and
 * Custom tags on run rows and each climber's record in an open Ascensions
 * level, in both looks (`--only filters`).
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** VERIFY_UI_PORT moves the test server when 8798 is taken by something else. */
const PORT = Number(process.env.VERIFY_UI_PORT) || 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 20000;
const WIDTHS = [320, 375, 768, 1024, 1440, 1920];
const PHONE_VIEWPORT = { width: 375, height: 812 };
/** "/" opens the new look (the default since 2026-11-15); classic checks ask for it. */
const CLASSIC_PATH = "/?ui=classic";
/** Set by lib/ui/look-notice.js once the first-visit notice is answered. */
const NOTICE_KEY = "vault.web.ui.notice";
/** Set by lib/ui/overview/index.js once the Overview tour is finished or skipped. */
const TOUR_KEY = "vault.web.overview.tour.v1";
/** Where lib/ui/overview/store.js keeps a player's own Overview layout. */
const LAYOUT_KEY = "vault.web.overview.layout.v1";
/** Tabs that need a Steam account (STEAM_LOCKED_TABS in Web/script.js). */
const STEAM_LOCKED_TABS = ["coop", "highlights", "beta"];
/** A signed-in visitor, as script.js stores one (`open(..., { signedIn: true })`). */
const TEST_SESSION = Object.freeze({
  steamID: "76561198000000001",
  personaName: "TestClimber",
  sessionToken: "test-token",
  signedInAt: "2026-11-01T00:00:00.000Z",
});
/** Community endpoints a signed-out visitor has no screen for. The lobby
 *  runtimes call some of them without the /api prefix (/coop/daily-challenge). */
const STEAM_ONLY_API = /^\/(api\/)?(highlights|coop|presence)(\/|$)/;
const TAB_IDS = ["overview", "characters", "ascensions", "relics", "cards", "runs", "coop", "highlights", "news", "overlay", "beta", "settings"];
const NAV_TAB_COUNT = 10;
const THEME_COUNT = 8;
const CLIMBER_IDS = ["ironclad", "silent", "defect", "regent", "necrobinder"];
const BETA_NEWS_ID = "015";
/** The brand is one word. These spellings must not reach a visitor. */
const OLD_BRAND = /Spire Vault|The Vault/;
/** The demo data's classic Overview shows well over this many numbers; far
 *  fewer means the page did not render and the parity check would pass empty. */
const MIN_OVERVIEW_NUMBERS = 40;
/** Lets the speech balloon's pop-in finish before it is measured. */
const BUBBLE_SETTLE_MS = 600;

/** Selectors that script.js, analytics and the native shells depend on. */
const CONTRACT = [
  "#app-shell", "#app-content", "#overview-body", "#overview-sub", "#community-pulse",
  "#h-tooltip", "#me-pill", "#status-dot", "#status-label", "#signout-btn", "#signin-btn-mobile",
  "#nav-news-count", "#nav-beta-btn", "#nav-runs-count", "#nav-coop-count", "#nav-highlights-count",
  '.head-crest[data-crest="overview"]', '.tab-panel[data-tab="overview"] .companion-slot',
  '.tab-panel[data-tab="overview"] [data-action="upload"]',
  '.tab-panel[data-tab="overview"] [data-action="reload-saves"]',
  '.tab-panel[data-tab="overview"] [data-action="toggle-export"]',
  '.tab-panel[data-tab="coop"]', "#run-detail-modal", "#share-modal",
];

let passed = 0;

/** VERIFY_UI_MATCH="name tags" runs only the checks whose name matches (a regular expression). */
const NAME_FILTER = process.env.VERIFY_UI_MATCH ? new RegExp(process.env.VERIFY_UI_MATCH) : null;

/** @param {string} name @param {() => Promise<void>} fn */
// Never pass a Playwright handle to assert.equal/deepEqual (`assert.equal(await
// page.$(sel), null)`): when it fails, Node formats the whole handle graph for
// the message and runs out of memory, so the run dies (exit 137) with no FAIL
// line. Count with page.locator(sel).count() instead.
async function check(name, fn) {
  if (NAME_FILTER && !NAME_FILTER.test(name)) return;
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(PORT)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => reject(new Error("dev-static did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

/**
 * Opens a fresh, storage-isolated page and waits for the app to finish boot.
 * @param {import("playwright").Browser} browser
 * @param {string} path
 * @param {import("playwright").BrowserContextOptions & { abort?: string, signedIn?: boolean, routes?: Array<[string, (route: import("playwright").Route) => unknown]> }} [options]
 *   signedIn: start with a stored Steam session (the Steam-only tabs open)
 *   freshVisitor: do not pre-answer the first-visit look notice (every other
 *             check starts as a returning visitor, so the notice never sits
 *             over what it clicks)
 *   tour:     do not pre-answer the Overview tour (it is pre-answered like the
 *             notice everywhere else, so it never dims a page under test)
 *   routes:   request mocks installed before the page boots (the static
 *             server has no /api)
 */
async function open(browser, path, options = {}) {
  const { abort, signedIn, freshVisitor, tour, routes = [], ...contextOptions } = options;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOptions });
  if (!freshVisitor) {
    await context.addInitScript((keys) => {
      try { keys.forEach((key) => window.localStorage.setItem(key, "seen")); } catch { /* storage blocked */ }
    }, [NOTICE_KEY, ...(options.tour ? [] : [TOUR_KEY])]);
  }
  if (signedIn) {
    await context.addInitScript((value) => {
      try { window.localStorage.setItem("vault.web.session", value); } catch { /* storage blocked */ }
    }, JSON.stringify(TEST_SESSION));
  }
  const page = await context.newPage();
  /** @type {string[]} */
  const requests = [];
  /** @type {string[]} */
  const errors = [];
  page.on("request", (request) => requests.push(new URL(request.url()).pathname));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // The static server has no Pages Functions; /api 404s are expected.
    if (message.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(message.text())) errors.push(message.text());
  });
  // Hermetic: nothing leaves the machine. Keeps test traffic out of the
  // production analytics stream and stops a slow third party (fonts, gtag)
  // from stalling the run.
  await context.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    (route) => route.abort()
  );
  if (abort) await page.route(abort, (route) => route.abort());
  for (const [pattern, handler] of routes) await context.route(pattern, handler);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
  // Signed out, Overview shows the sample data. A signed-in account with no
  // runs yet gets the "restore your runs" screen instead.
  const overviewReady = signedIn
    ? "#overview-body .v-ov, #overview-body .kpi-strip, #overview-body .empty-state, #overview-body .v-empty"
    : "#overview-body .v-ov, #overview-body .kpi-strip";
  await page.waitForSelector(overviewReady, { timeout: BOOT_TIMEOUT_MS });
  return { context, page, requests, errors };
}

/** @param {import("playwright").Page} page */
function htmlState(page) {
  return page.evaluate(() => ({
    ui: document.documentElement.dataset.ui,
    theme: document.documentElement.dataset.theme || null,
    search: window.location.search,
  }));
}

async function run(browser) {
  // ---- The new look is the default; classic loads none of it ---------------
  await check("a new visitor gets the new look by default, without anything stored", async () => {
    const { context, page: p, errors } = await open(browser, "/");
    const state = await p.evaluate(() => ({
      ui: document.documentElement.dataset.ui,
      source: window.__VAULT_UI_SOURCE__,
      stored: localStorage.getItem("vault.web.ui"),
    }));
    assert.deepEqual(state, { ui: "next", source: "default", stored: null });
    assert.ok(await p.$("#overview-body .v-ov"), "the new Overview renders");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the classic look, once chosen, loads none of the new UI", async () => {
    const { context, page, requests, errors } = await open(browser, CLASSIC_PATH);
    const state = await htmlState(page);
    assert.equal(state.ui, "classic");
    assert.equal(state.theme, null);
    assert.ok(await page.$("#vault-legacy-css"), "legacy stylesheet link must stay");
    assert.ok(await page.$("#overview-body .kpi-strip"), "classic Overview renderer must run");
    assert.equal(await page.locator('.head-crest[data-crest="overview"] .crest-plaque').count(), 3, "classic header plaques");
    assert.equal(await page.locator(".v-stage-bg, .v-theme-btn").count(), 0, "no new-UI DOM in classic");
    assert.equal(await page.locator("#overview-body .v-ov").count(), 0, "no new Overview in classic");
    assert.deepEqual(requests.filter((p) => p.startsWith("/lib/ui/") || p === "/styles.next.css"), []);
    assert.equal(await page.textContent(".sidebar-wordmark"), "SpireVault");
    assert.deepEqual(errors, []);
    await context.close();
  });

  // ---- Opting in -----------------------------------------------------------
  const next = await open(browser, "/?ui=next");
  const { page } = next;

  await check("?ui=next opts in, persists, and is stripped from the URL", async () => {
    const state = await htmlState(page);
    assert.equal(state.ui, "next");
    assert.equal(state.theme, "inked");
    assert.equal(state.search, "");
    assert.equal(await page.evaluate(() => localStorage.getItem("vault.web.ui")), "next");
    assert.deepEqual(next.errors, []);
  });

  await check("the DOM contract is intact", async () => {
    for (const selector of CONTRACT) assert.ok(await page.$(selector), `missing ${selector}`);
    assert.equal(await page.locator(".nav-row[data-tab]").count(), NAV_TAB_COUNT);
    const panels = await page.$$eval(".tab-panel[data-tab]", (els) => els.map((el) => el.dataset.tab).sort());
    assert.deepEqual(panels, [...TAB_IDS].sort());
    assert.deepEqual(await page.evaluate(() => window.SpireVault.knownTabs().sort()), [...TAB_IDS].sort());
  });

  await check("new Overview renders every metric group once", async () => {
    assert.ok(await page.$("#overview-body .v-ov"));
    assert.equal(await page.locator("#overview-body .kpi-strip").count(), 0, "no classic KPI strip in the new look");
    assert.equal(await page.locator(".v-ring").count(), 1);
    assert.equal(await page.locator(".v-hand .v-card").count(), 6);
    // Six climbers: The Fool (STS2 beta) is on the roster for everyone, unplayed or not.
    assert.equal(await page.locator(".v-char").count(), 6);
    assert.equal(await page.locator('.v-chart[data-chart="trend"]').count(), 1);
    assert.equal(await page.locator('.v-chart[data-chart="floors"]').count(), 1);
    assert.equal(await page.locator(".v-relic").count(), 6);
    assert.equal(await page.locator(".crest-plaque").count(), 0, "duplicate header plaques are gone");
  });

  await check("the stage is driven by the data", async () => {
    const stage = await page.evaluate(() => {
      const root = document.querySelector('.tab-panel[data-tab="overview"] .v-stage-bg');
      return {
        lit: root.querySelectorAll(".v-spire-win.is-lit").length,
        windows: root.querySelectorAll(".v-spire-win").length,
        door: !!root.querySelector(".v-spire-door"),
        beacon: !!root.querySelector(".v-spire-beacon"),
        flames: root.querySelectorAll(".v-torch.is-won .v-torch-flame").length,
        cold: root.querySelectorAll(".v-torch.is-lost .v-torch-smoke").length,
        newest: root.querySelectorAll(".v-torch.is-newest").length,
        spireLabel: root.querySelector(".v-spire").getAttribute("aria-label"),
      };
    });
    const model = await page.evaluate(() => {
      const chips = [...document.querySelectorAll(".v-wr-chips .v-chip")].map((el) => el.textContent);
      const tenText = document.querySelector(".v-path-head span").textContent;
      return { highest: Number(/A(\d+)/.exec(chips[0])[1]), wins: Number(/(\d+)W/.exec(tenText)[1]), losses: Number(/(\d+)L/.exec(tenText)[1]) };
    });
    // The painted tower: the door is A0, a window per level A1–A10, the
    // brazier a beacon at A10.
    assert.equal(stage.windows, 10, "ten windows");
    assert.equal(stage.lit, Math.min(model.highest, 10), "one lit window per ascension A1–A10");
    assert.equal(stage.door, model.highest >= 0, "any finished run lights the door");
    assert.equal(stage.beacon, model.highest >= 10, "the beacon burns at A10");
    assert.equal(stage.flames, model.wins, "a won run's torch burns");
    assert.equal(stage.cold, model.losses, "a lost run's torch stands cold and smoking");
    assert.equal(stage.newest, 1, "the newest run is marked");
    assert.match(stage.spireLabel, new RegExp(`ascension ${model.highest} `));
  });

  await check("the rail stays put while the page scrolls", async () => {
    await page.evaluate(() => window.scrollTo(0, 700));
    const top = await page.evaluate(() => document.querySelector('.nav-row[data-tab="overview"]').getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 400, `first nav row left the viewport (top=${top})`);
    await page.evaluate(() => window.scrollTo(0, 0));
  });

  await check("tab entry tags page_view with ui_variant", async () => {
    await page.evaluate(() => window.SpireVault.switchTab("characters"));
    const variant = await page.evaluate(() => {
      const hits = (window.dataLayer || []).filter((entry) => entry[0] === "event" && entry[1] === "page_view");
      return hits.length ? hits[hits.length - 1][2].ui_variant : null;
    });
    assert.equal(variant, "next");
    await page.evaluate(() => window.SpireVault.switchTab("overview"));
  });

  // ---- Themes ---------------------------------------------------------------
  await check("themes switch instantly: no navigation, no re-render", async () => {
    await page.evaluate(() => {
      window.__sameDocument = true;
      document.querySelector("#overview-body .v-ov").dataset.marker = "kept";
    });
    await page.click(".sidebar-brand .v-theme-btn");
    await page.waitForSelector("#v-theme-pop");
    assert.equal(await page.locator("#v-theme-pop [data-theme-id]").count(), THEME_COUNT);
    const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--v-bg").trim());
    await page.click('#v-theme-pop [data-theme-id="vault"]');
    await page.waitForFunction(() => document.documentElement.dataset.theme === "vault");
    const after = await page.evaluate(() => ({
      bg: getComputedStyle(document.documentElement).getPropertyValue("--v-bg").trim(),
      same: window.__sameDocument === true,
      kept: document.querySelector("#overview-body .v-ov").dataset.marker,
      stored: localStorage.getItem("vault.web.theme"),
      checked: document.querySelector('#v-theme-pop [aria-checked="true"]').dataset.themeId,
      meta: document.querySelector('meta[name="theme-color"]').content,
    }));
    assert.notEqual(after.bg, before);
    assert.equal(after.same, true, "page must not reload");
    assert.equal(after.kept, "kept", "Overview DOM must not be re-rendered");
    assert.equal(after.stored, "vault");
    assert.equal(after.checked, "vault");
    assert.notEqual(after.meta, "#0c0a14");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#v-theme-pop").count(), 0, "theme pop-up closed");
  });

  await check("T cycles themes; the choice survives a reload", async () => {
    await page.keyboard.press("t");
    await page.waitForFunction(() => localStorage.getItem("vault.web.theme") === "auto");
    await page.evaluate(() => window.SpireVault.setTheme("defect"));
    await page.reload();
    await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub);
    assert.deepEqual(await htmlState(page), { ui: "next", theme: "defect", search: "" });
    // The theme half of the host bridge answers once lib/ui has loaded; the
    // new Overview appearing is the signal that it has.
    await page.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
  });

  await check("host bridge exposes layout and theme controls", async () => {
    const bridge = await page.evaluate(() => ({
      ui: window.SpireVault.ui(),
      themes: window.SpireVault.themes().length,
      bad: window.SpireVault.setTheme("nope"),
      good: window.SpireVault.setTheme("silent"),
      theme: window.SpireVault.theme(),
    }));
    assert.deepEqual(bridge, { ui: "next", themes: THEME_COUNT, bad: false, good: true, theme: "silent" });
  });
  await next.context.close();

  await check("?theme= deep link applies before first paint", async () => {
    const { context, page: p } = await open(browser, "/?ui=next&theme=regent");
    assert.deepEqual(await htmlState(p), { ui: "next", theme: "regent", search: "" });
    await context.close();
  });

  await check("an unknown ?theme= falls back to the default", async () => {
    const { context, page: p } = await open(browser, "/?ui=next&theme=%22%3E%3Cimg%20src%3Dx%3E");
    assert.equal((await htmlState(p)).theme, "inked");
    await context.close();
  });

  // ---- Motion ----------------------------------------------------------------
  await check("reduced motion leaves nothing animating", async () => {
    const { context, page: p } = await open(browser, "/?ui=next", { reducedMotion: "reduce" });
    await p.waitForTimeout(600);
    const running = await p.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
    assert.equal(running, 0);
    assert.equal(await p.textContent(".v-ring-pct [data-count]"), await p.getAttribute(".v-ring-pct [data-count]", "data-count"));
    await context.close();
  });

  // ---- Desktop shells --------------------------------------------------------
  await check("the new UI never paints classic markup while its module loads", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await context.newPage();
    await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    // Hold the module back long enough for every early render to run.
    await p.route("**/lib/ui/index.js*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    await p.addInitScript(() => {
      window.__sawClassicOverview = false;
      new MutationObserver(() => {
        if (document.querySelector("#overview-body .kpi-strip, #overview-body .hero-overview")) window.__sawClassicOverview = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await p.goto(`${BASE}/?ui=next`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
    assert.equal(await p.evaluate(() => window.__sawClassicOverview), false);
    assert.equal(await p.evaluate(() => window.SpireVault.__isStub === true), false, "host bridge is live");
    await context.close();
  });

  await check("desktop-host mode hides the rail and keeps the bridge working", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next&desktop=1");
    const state = await p.evaluate(() => ({
      host: document.documentElement.classList.contains("is-desktop-host"),
      rail: getComputedStyle(document.querySelector(".sidebar")).display,
      toolbarTheme: getComputedStyle(document.querySelector('.tab-panel[data-tab="overview"] .v-theme-btn--toolbar')).display,
      switched: window.SpireVault.switchTab("relics"),
      active: window.SpireVault.activeTab(),
    }));
    assert.equal(state.host, true);
    assert.equal(state.rail, "none");
    assert.notEqual(state.toolbarTheme, "none", "themes must be reachable without the rail");
    assert.equal(state.switched, true);
    assert.equal(state.active, "relics");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("an overlay window always gets the classic layout", async () => {
    const { context, page: p } = await open(browser, "/?ui=next&desktop=1&overlay=1");
    assert.equal((await htmlState(p)).ui, "classic");
    await context.close();
  });

  // ---- Failure fallback -------------------------------------------------------
  await check("if the new UI fails to load, this visit falls back to classic without opting out", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await context.newPage();
    await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
    await p.route("**/lib/ui/index.js*", (route) => route.abort());
    await p.goto(`${BASE}/?ui=next&room=abc`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => document.documentElement.dataset.ui === "classic", null, { timeout: BOOT_TIMEOUT_MS });
    await p.waitForSelector("#overview-body .kpi-strip", { timeout: BOOT_TIMEOUT_MS });
    const state = await p.evaluate(() => ({
      stored: localStorage.getItem("vault.web.ui"),
      search: window.location.search,
    }));
    assert.equal(state.stored, "next", "a load failure must not silently opt the visitor out");
    assert.equal(state.search, "?room=abc", "other query parameters must survive the fallback");
    // The hash is not asserted: the app itself clears it on every non-News
    // tab (syncTabUrl), in both layouts.
    await context.close();
  });

  await check("the theme picker is a keyboard-operable radio group", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    await p.focus(".sidebar-brand .v-theme-btn");
    await p.keyboard.press("Enter");
    await p.waitForSelector("#v-theme-pop");
    const tabStops = await p.locator('#v-theme-pop [data-theme-id][tabindex="0"]').count();
    assert.equal(tabStops, 1, "exactly one swatch is in the tab order");
    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(() => document.documentElement.dataset.theme === "vault");
    assert.equal(await p.evaluate(() => document.activeElement.dataset.themeId), "vault");
    await p.keyboard.press("Escape");
    assert.equal(await p.locator("#v-theme-pop").count(), 0, "theme pop-up closed");
    assert.equal(await p.evaluate(() => document.activeElement.classList.contains("v-theme-btn")), true, "focus returns to the trigger");
    await context.close();
  });

  // ---- Responsive -------------------------------------------------------------
  for (const width of WIDTHS) {
    await check(`no horizontal overflow at ${width}px`, async () => {
      const { context, page: p } = await open(browser, "/?ui=next", { viewport: { width, height: 900 } });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 0, `page is ${overflow}px wider than the viewport`);
      await context.close();
    });
  }

  await check("phones get a top bar with the brand and a bottom tab bar", async () => {
    const { context, page: p } = await open(browser, "/?ui=next", { viewport: { width: 375, height: 812 } });
    const layout = await p.evaluate(() => {
      const nav = document.querySelector(".sidebar-nav").getBoundingClientRect();
      return {
        navBottomGap: Math.round(window.innerHeight - nav.bottom),
        navPosition: getComputedStyle(document.querySelector(".sidebar-nav")).position,
        brand: getComputedStyle(document.querySelector(".sidebar-brand")).display,
      };
    });
    assert.deepEqual(layout, { navBottomGap: 0, navPosition: "fixed", brand: "flex" });
    await context.close();
  });
}

/**
 * Measures the header duel on the Overview tab.
 * @param {import("playwright").Page} page
 */
function duelGeometry(page) {
  return page.evaluate(() => {
    const head = document.querySelector('.tab-panel[data-tab="overview"] > .panel-head');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const images = [...head.querySelectorAll(".v-actor-art")];
    const toolbar = head.querySelector(".app-toolbar-right");
    return {
      head: box(head),
      title: box(head.querySelector(".panel-head-title-wrap h2")),
      climber: box(head.querySelector(".v-actor--climber")),
      boss: box(head.querySelector(".v-actor--boss")),
      bubble: box(head.querySelector(".v-bubble")),
      tail: box(head.querySelector(".v-bubble-tail")),
      bossSpeaks: !!head.querySelector(".v-duel--boss-speaks"),
      toolbarBottom: toolbar ? toolbar.getBoundingClientRect().bottom : 0,
      // Where the boss's feet are down his box (1 = its bottom edge).
      bossFootY: parseFloat(head.querySelector(".v-actor--boss").dataset.footY || "1"),
      gapToken: parseFloat(getComputedStyle(head).getPropertyValue("--duel-gap")),
      artCount: images.length,
      artLoaded: images.every((img) => img.complete && img.naturalWidth > 0),
      artInked: images.every((img) => (img.getAttribute("src") || "").startsWith("/assets/stage/")),
    };
  });
}

/**
 * Staging rules that hold at every width: the two figures are inked, the
 * climber stands left of the boss, both stand with their feet on one ground
 * line inside the header (the boss's staff tip hangs below his boots, so his
 * box reaches lower than his feet), and the line of speech
 * sits above whoever is speaking, tail over them, covering neither figure and
 * never sliding under the toolbar.
 * @param {Awaited<ReturnType<typeof duelGeometry>>} g
 * @param {string} label
 */
function assertDuelStaging(g, label) {
  assert.equal(g.artCount, 2, `${label}: expected a climber and a boss`);
  assert.ok(g.artLoaded, `${label}: actor art failed to load`);
  assert.ok(g.artInked, `${label}: actors must use the inked stage art`);
  assert.ok(g.climber.right < g.boss.left, `${label}: the climber stands left of the boss`);
  const bossFeet = g.boss.top + (g.boss.bottom - g.boss.top) * g.bossFootY;
  assert.ok(Math.abs(g.climber.bottom - bossFeet) <= 1, `${label}: both figures' feet share one ground line (climber ${g.climber.bottom}, boss ${bossFeet})`);
  assert.ok(g.boss.bottom <= g.head.bottom - 4, `${label}: the boss's staff tip stays inside the header`);
  const groundInset = g.head.bottom - g.climber.bottom;
  assert.ok(groundInset > 6 && groundInset < 40, `${label}: feet rest on the ledge (inset ${groundInset}px)`);
  assert.ok(g.bubble.top >= g.toolbarBottom - 1, `${label}: the balloon sits below the toolbar`);
  assert.ok(g.bubble.left >= g.head.left && g.bubble.right <= g.head.right, `${label}: the balloon stays inside the header`);
  const speaker = g.bossSpeaks ? g.boss : g.climber;
  assert.ok(g.bubble.bottom <= speaker.top, `${label}: the balloon sits above the speaker`);
  const tip = (g.tail.left + g.tail.right) / 2;
  assert.ok(tip >= speaker.left && tip <= speaker.right, `${label}: the balloon's tail is over the speaker`);
  [g.climber, g.boss].forEach((figure) => {
    const clear = g.bubble.bottom <= figure.top || g.bubble.right <= figure.left || g.bubble.left >= figure.right;
    assert.ok(clear, `${label}: the balloon covers no figure`);
  });
}

async function runDuel(browser) {
  await check("header duel: every climber squares up to the boss on one ground line, balloon above", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    for (const id of CLIMBER_IDS) {
      await p.evaluate((companion) => {
        document.querySelector(`.tab-panel[data-tab="overview"] [data-companion-id="${companion}"]`).click();
      }, id);
      await p.waitForFunction(
        (companion) => (document.querySelector(".v-actor--climber .v-actor-art")?.getAttribute("src") || "").includes(`/${companion}-ink-`),
        id
      );
      await p.waitForFunction(() => [...document.querySelectorAll(".v-actor-art")].every((img) => img.complete));
      await p.waitForTimeout(BUBBLE_SETTLE_MS);
      const g = await duelGeometry(p);
      assertDuelStaging(g, id);
      const gap = g.boss.left - g.climber.right;
      assert.ok(gap >= 30 && gap <= 60, `${id}: the two stand close, squared up (gap ${gap}px)`);
      // stage.css carries the boss's width as a constant (--duel-boss-w) so the
      // scenery can be placed around the duel. If the boss art or its staging
      // height changes without it, the real gap drifts from the token.
      assert.ok(Math.abs(gap - g.gapToken) <= 1, `${id}: gap is ${gap}px but --duel-gap says ${g.gapToken}px`);
      assert.ok(g.title.right < g.climber.left, `${id}: the title is clear of the duel`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  for (const width of [1024, 768, 375, 320]) {
    await check(`header duel holds its staging at ${width}px`, async () => {
      const { context, page: p } = await open(browser, "/?ui=next", { viewport: { width, height: 900 } });
      await p.waitForFunction(() => [...document.querySelectorAll(".v-actor-art")].every((img) => img.complete));
      await p.waitForTimeout(BUBBLE_SETTLE_MS);
      const g = await duelGeometry(p);
      assertDuelStaging(g, `${width}px`);
      await context.close();
    });
  }

  for (const width of [1440, 1024, 375]) {
    await check(`re-rolling the line never changes the header's height (${width}px)`, async () => {
      const { context, page: p } = await open(browser, "/?ui=next", { viewport: { width, height: 900 } });
      const bubble = '.tab-panel[data-tab="overview"] .v-bubble';
      const height = () => p.evaluate(() => document.querySelector('.tab-panel[data-tab="overview"] > .panel-head').getBoundingClientRect().height);
      await p.waitForTimeout(BUBBLE_SETTLE_MS);
      const first = await height();
      const speakers = new Set();
      for (let i = 0; i < 12; i += 1) {
        await p.click(bubble);
        await p.waitForTimeout(120);
        speakers.add(await p.evaluate(() => (document.querySelector(".v-duel--boss-speaks") ? "boss" : "climber")));
        const now = await height();
        assert.ok(Math.abs(now - first) < 1, `re-roll ${i + 1}: header went from ${first}px to ${now}px`);
      }
      assert.equal(speakers.size, 2, "both the climber and the boss spoke during the re-rolls");
      await context.close();
    });
  }

  await check("re-rolling the line from the keyboard keeps focus on the balloon", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    const bubble = '.tab-panel[data-tab="overview"] .v-bubble';
    await p.focus(bubble);
    await p.keyboard.press("Enter");
    await p.waitForTimeout(150);
    const focused = await p.evaluate(() => ({
      action: document.activeElement ? document.activeElement.getAttribute("data-action") : null,
      inOverview: !!(document.activeElement && document.activeElement.closest('.tab-panel[data-tab="overview"]')),
    }));
    assert.deepEqual(focused, { action: "scene-reroll", inOverview: true });
    await context.close();
  });

  await check("both figures answer the pointer, and tapping the boss gives him the line", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    await p.waitForFunction(() => [...document.querySelectorAll(".v-actor-art")].every((img) => img.complete));
    await p.waitForTimeout(BUBBLE_SETTLE_MS);
    const scope = '.tab-panel[data-tab="overview"]';
    const lift = (selector) => p.evaluate((sel) => getComputedStyle(document.querySelector(sel)).translate, `${scope} ${selector} .v-actor-art`);
    for (const who of ["climber", "boss"]) {
      assert.equal(await p.evaluate((sel) => document.querySelector(sel).tagName, `${scope} .v-actor--${who}`), "BUTTON", `the ${who} is a button`);
      await p.hover(`${scope} .v-actor--${who}`);
      await p.waitForTimeout(350);
      assert.equal(await lift(`.v-actor--${who}`), "0px -3px", `the ${who} lifts under the pointer`);
    }
    const state = () =>
      p.evaluate((sel) => {
        const duel = document.querySelector(`${sel} .v-duel`);
        return {
          speaker: duel.classList.contains("v-duel--boss-speaks") ? "boss" : "climber",
          climber: duel.querySelector(".v-actor--climber .v-actor-art").getAttribute("src"),
          height: document.querySelector(`${sel} > .panel-head`).getBoundingClientRect().height,
          focus: document.activeElement ? document.activeElement.getAttribute("data-action") : null,
        };
      }, scope);
    const before = await state();
    for (let i = 0; i < 3; i += 1) {
      await p.click(`${scope} .v-actor--boss`);
      await p.waitForTimeout(150);
      const now = await state();
      assert.equal(now.speaker, "boss", `tap ${i + 1}: the boss speaks`);
      assert.equal(now.climber, before.climber, "the climber stays");
      assert.ok(Math.abs(now.height - before.height) < 1, `tap ${i + 1}: the header keeps its height`);
    }
    await p.focus(`${scope} .v-actor--boss`);
    await p.keyboard.press("Enter");
    await p.waitForTimeout(150);
    const keyed = await state();
    assert.equal(keyed.speaker, "boss");
    assert.equal(keyed.focus, "boss-speak", "focus stays on the boss after the keyboard");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the classic header keeps the game's original sprites", async () => {
    const { context, page: p, requests } = await open(browser, CLASSIC_PATH);
    assert.equal(await p.locator(".v-duel, .v-actor").count(), 0);
    assert.ok(await p.$('.tab-panel[data-tab="overview"] .scene-figure-climber'), "classic diorama markup");
    assert.deepEqual(requests.filter((path) => path.startsWith("/assets/stage/")), []);
    await context.close();
  });
}

/** Visible text of the page, without script or style contents. */
function visibleDocumentText(page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement && node.parentElement.closest("script, style, noscript")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let text = "";
    while (walker.nextNode()) text += `${walker.currentNode.nodeValue} `;
    return text;
  });
}

async function runBrand(browser) {
  for (const [label, path] of [["classic", CLASSIC_PATH], ["new look", "/?ui=next"]]) {
    await check(`the brand is one word in the tab title and the page (${label})`, async () => {
      const { context, page: p } = await open(browser, path);
      const title = await p.title();
      // "<page> · SpireVault", the page named after the sidebar tab.
      assert.match(title, /^(\(\d+\) )?[A-Z][A-Za-z -]+ · SpireVault$/, `tab title was "${title}"`);
      assert.doesNotMatch(title, OLD_BRAND);
      assert.doesNotMatch(await visibleDocumentText(p), OLD_BRAND);
      await context.close();
    });
  }
  await check("the sign-in page's tab title carries the brand too", async () => {
    const html = await (await fetch(`${BASE}/auth.html`)).text();
    assert.match(html, /<title>[^<]*SpireVault<\/title>/);
    assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, (block) => block.replace(/\/\/[^\n]*/g, "")), OLD_BRAND);
  });
}

/**
 * Clicks a layout-switch control and waits for the page to come back up in
 * the requested layout.
 * @param {import("playwright").Page} page
 * @param {string} selector
 * @param {"next" | "classic"} variant
 */
async function switchLayout(page, selector, variant) {
  await page.click(selector);
  await page.waitForFunction(
    (want) => document.documentElement.dataset.ui === want && window.SpireVault && !window.SpireVault.__isStub,
    variant,
    { timeout: BOOT_TIMEOUT_MS }
  );
  // Switching keeps the tab, so wait for whichever tab is open to be drawn.
  await page.waitForSelector(".tab-panel[data-tab]:not([hidden]) > *", { timeout: BOOT_TIMEOUT_MS });
  if (await page.$('.tab-panel[data-tab="overview"]:not([hidden])')) {
    await page.waitForSelector(variant === "next" ? "#overview-body .v-ov" : "#overview-body .kpi-strip", {
      timeout: BOOT_TIMEOUT_MS,
    });
  }
}

async function runBetaSwitch(browser) {
  await check("the desktop shells default to the new look as well", async () => {
    const { context, page: p } = await open(browser, "/?desktop=1");
    assert.equal((await htmlState(p)).ui, "next");
    assert.equal(await p.evaluate(() => window.__VAULT_UI_SOURCE__), "default");
    await context.close();
  });

  for (const [label, viewport] of [["laptop", { width: 1440, height: 900 }], ["phone", PHONE_VIEWPORT], ["small phone", { width: 320, height: 640 }]]) {
    await check(`first visit (${label}): a notice points at the palette button; "Keep" closes it for good`, async () => {
      const { context, page: p, errors } = await open(browser, "/", { freshVisitor: true, viewport });
      await p.waitForSelector("#v-look-notice", { timeout: BOOT_TIMEOUT_MS });
      const state = await p.evaluate(() => {
        const notice = document.getElementById("v-look-notice").getBoundingClientRect();
        const hint = document.querySelector(".v-look-hint");
        const button = hint ? hint.getBoundingClientRect() : null;
        return {
          docked: document.getElementById("v-look-notice").classList.contains("is-docked"),
          onScreen: notice.left >= 0 && notice.right <= innerWidth && notice.top >= 0 && notice.bottom <= innerHeight,
          pointsAtPalette: !!hint && hint.matches('[data-action="v-theme-open"]'),
          belowButton: !!button && notice.top >= button.bottom,
          sideways: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.deepEqual(state, { docked: false, onScreen: true, pointsAtPalette: true, belowButton: true, sideways: false });
      // Layout height, not the bounding box: the card scales in from 96%, so a
      // box read during that entrance makes a 44px button measure 42px.
      for (const name of ["Keep the new look", "Switch to classic"]) {
        const height = await p.getByRole("button", { name }).evaluate((el) => el.offsetHeight);
        assert.ok(height >= 44, `"${name}" is a full-size tap target (${height}px)`);
      }
      await p.getByRole("button", { name: "Keep the new look" }).click();
      await p.waitForSelector("#v-look-notice", { state: "detached" });
      assert.equal(await p.locator(".v-look-hint").count(), 0, "the ring on the palette button goes too");
      assert.equal(await p.evaluate((key) => localStorage.getItem(key), NOTICE_KEY), "keep");
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
      await p.waitForTimeout(1500);
      assert.equal(await p.locator("#v-look-notice").count(), 0, "answered once, never again");
      assert.deepEqual(errors, []);
      await context.close();
    });
  }

  await check('the notice\'s "Switch to classic" switches, and the notice never comes back', async () => {
    const { context, page: p, errors } = await open(browser, "/", { freshVisitor: true });
    await p.waitForSelector("#v-look-notice", { timeout: BOOT_TIMEOUT_MS });
    await switchLayout(p, '#v-look-notice [data-ui="classic"]', "classic");
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "classic");
    await switchLayout(p, ".sidebar-brand .skin-switch--brand", "next");
    await p.waitForTimeout(1500);
    assert.equal(await p.locator("#v-look-notice").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("a visitor who chose a look never sees the notice", async () => {
    for (const path of ["/?ui=next", CLASSIC_PATH]) {
      const { context, page: p } = await open(browser, path, { freshVisitor: true });
      await p.waitForTimeout(1800);
      assert.equal(await p.locator("#v-look-notice").count(), 0, path);
      await context.close();
    }
  });

  await check("Escape closes the notice, and opening the palette menu does too", async () => {
    for (const how of ["escape", "palette"]) {
      const { context, page: p } = await open(browser, "/", { freshVisitor: true });
      await p.waitForSelector("#v-look-notice", { timeout: BOOT_TIMEOUT_MS });
      if (how === "escape") await p.keyboard.press("Escape");
      else await p.click(".sidebar-brand .v-theme-btn");
      await p.waitForSelector("#v-look-notice", { state: "detached" });
      if (how === "palette") assert.ok(await p.$("#v-theme-pop .v-look"), "the menu opens on the look switch");
      await context.close();
    }
  });

  await check("switching looks keeps the tab you are on, both ways", async () => {
    const { context, page: p, errors } = await open(browser, "/");
    await p.evaluate(() => window.SpireVault.switchTab("runs"));
    await p.click(".sidebar-brand .v-theme-btn");
    await p.click('#v-theme-pop [data-ui="classic"]');
    await p.waitForFunction(() => document.documentElement.dataset.ui === "classic" && window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await p.waitForSelector('.tab-panel[data-tab="runs"]:not([hidden])', { timeout: BOOT_TIMEOUT_MS });
    await p.click(".sidebar-brand .skin-switch--brand");
    await p.waitForFunction(() => document.documentElement.dataset.ui === "next" && window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await p.waitForSelector('.tab-panel[data-tab="runs"]:not([hidden])', { timeout: BOOT_TIMEOUT_MS });
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the desktop apps on the classic look: each stats toolbar carries the switch back", async () => {
    const { context, page: p, errors } = await open(browser, `${CLASSIC_PATH}&desktop=1`);
    const button = '.tab-panel[data-tab="overview"] [data-ui-toolbar-switch]';
    await p.waitForSelector(button, { state: "visible" });
    assert.equal(await p.locator("[data-ui-toolbar-switch]").count(), await p.locator(".app-toolbar-right").count());
    await switchLayout(p, button, "next");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the look and theme menu fits a small phone", async () => {
    const { context, page: p } = await open(browser, "/", { viewport: { width: 320, height: 568 } });
    await p.click('[data-action="v-theme-open"]:visible');
    await p.waitForSelector("#v-theme-pop .v-look");
    await p.waitForTimeout(400);
    const fits = await p.evaluate(() => {
      const box = document.getElementById("v-theme-pop").getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    });
    assert.ok(fits, "the menu stays on screen (it scrolls inside itself)");
    await context.close();
  });

  await check("the overlay window declines the new look instead of reloading for nothing", async () => {
    const { context, page: p } = await open(browser, "/?overlay=1");
    await p.evaluate(() => { window.__sameDocument = true; });
    assert.equal(await p.evaluate(() => window.SpireVault.setUI("next")), false);
    await p.waitForTimeout(400);
    const state = await p.evaluate(() => ({
      ui: document.documentElement.dataset.ui,
      same: window.__sameDocument === true,
      stored: localStorage.getItem("vault.web.ui"),
    }));
    assert.deepEqual(state, { ui: "classic", same: true, stored: null });
    await context.close();
  });

  await check("Settings: opt in to the new look, then back, one click each way", async () => {
    const { context, page: p, errors } = await open(browser, CLASSIC_PATH);
    await p.evaluate(() => window.SpireVault.switchTab("settings"));
    const optIn = '#settings-body [data-ui-beta-card] [data-action="ui-set"][data-ui="next"]';
    await p.waitForSelector(optIn);
    await switchLayout(p, optIn, "next");
    // ?ui= is stripped; the tab stays in the address, so the switch keeps it.
    assert.deepEqual(await htmlState(p), { ui: "next", theme: "inked", search: "?tab=settings" });
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "next");
    assert.ok(await p.$('.tab-panel[data-tab="settings"]:not([hidden])'), "switching keeps you on Settings");

    await p.evaluate(() => window.SpireVault.switchTab("settings"));
    const optOut = '#settings-body .v-appearance [data-action="ui-set"][data-ui="classic"]';
    await p.waitForSelector(optOut);
    assert.equal(await p.locator("#settings-body [data-ui-beta-card]").count(), 0, "no opt-in card once opted in");
    await switchLayout(p, optOut, "classic");
    assert.equal((await htmlState(p)).ui, "classic");
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "classic");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the theme picker and the host bridge can both switch layouts", async () => {
    const { context, page: p } = await open(browser, CLASSIC_PATH);
    await p.evaluate(() => window.SpireVault.setUI("next"));
    await p.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
    assert.equal(await p.evaluate(() => window.SpireVault.setUI("sideways")), false);
    await p.click(".sidebar-brand .v-theme-btn");
    await switchLayout(p, '#v-theme-pop [data-action="ui-set"][data-ui="classic"]', "classic");
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "classic");
    await context.close();
  });

  await check("classic sidebar: the button beside the logo turns the new look on in one click", async () => {
    const { context, page: p, errors } = await open(browser, CLASSIC_PATH);
    const button = ".sidebar-brand .skin-switch--brand";
    await p.waitForSelector(button, { state: "visible" });
    const fit = await p.evaluate((selector) => {
      const box = (query) => document.querySelector(query).getBoundingClientRect();
      const chip = document.querySelector(".skin-switch--strip");
      return {
        clearOfWordmark: box(selector).left >= box(".sidebar-wordmark").right,
        insideRail: box(selector).right <= box(".sidebar").right,
        named: (document.querySelector(selector).getAttribute("aria-label") || "").includes("new look"),
        stripChipShown: !!chip && getComputedStyle(chip).display !== "none",
      };
    }, button);
    assert.deepEqual(fit, { clearOfWordmark: true, insideRail: true, named: true, stripChipShown: false });
    await switchLayout(p, button, "next");
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "next");
    assert.ok(await p.$('.tab-panel[data-tab="overview"]:not([hidden])'), "switching keeps you on Overview");
    // The new look keeps its own control in the same spot; the classic ones stay out of it.
    await p.waitForSelector(".sidebar-brand .v-theme-btn", { state: "visible" });
    assert.equal(await p.locator(".skin-switch:visible").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("classic on a phone: the tab strip ends with the same switch", async () => {
    const { context, page: p, errors } = await open(browser, CLASSIC_PATH, { viewport: PHONE_VIEWPORT });
    const chip = ".sidebar-nav .skin-switch--strip";
    await p.waitForSelector(chip, { state: "attached" });
    const state = await p.evaluate((selector) => {
      const el = document.querySelector(selector);
      const brand = document.querySelector(".skin-switch--brand");
      return {
        shown: getComputedStyle(el).display !== "none",
        last: el.parentElement.lastElementChild === el,
        tall: el.getBoundingClientRect().height >= 36,
        brandButtonShown: !!brand && brand.getClientRects().length > 0,
        pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
      };
    }, chip);
    assert.deepEqual(state, { shown: true, last: true, tall: true, brandButtonShown: false, pageScrollsSideways: false });
    await switchLayout(p, chip, "next");
    assert.equal(await p.locator(".skin-switch:visible").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the classic switch is not offered where the new look cannot run", async () => {
    const overlay = await open(browser, "/?overlay=1");
    assert.equal(await overlay.page.locator(".skin-switch").count(), 2, "both switches are in the markup");
    assert.equal(await overlay.page.locator(".skin-switch:visible").count(), 0, "overlay window");
    await overlay.context.close();

    // A browser without cascade layers: the boot script keeps it on classic.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await context.newPage();
    await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
    await p.addInitScript(() => { delete window.CSSLayerBlockRule; });
    await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    assert.equal(await p.evaluate(() => typeof window.CSSLayerBlockRule), "undefined", "the test removed cascade layers");
    assert.equal(await p.locator(".skin-switch:visible").count(), 0, "old browser");
    await context.close();
  });

  for (const [label, path, target] of [["classic", CLASSIC_PATH, "next"], ["new look", "/", "classic"]]) {
    await check(`the Beta tab carries the switch and keeps it through re-renders (${label})`, async () => {
      // Beta is a Steam-only tab: signed out it shows the sign-in screen.
      const { context, page: p } = await open(browser, path, { signedIn: true });
      await p.evaluate(() => window.SpireVault.switchTab("beta"));
      const card = `#beta-body [data-ui-beta-card] [data-action="ui-set"][data-ui="${target}"]`;
      await p.waitForSelector(card);
      // run-coach.js owns this tab and replaces its markup when its state changes.
      await p.evaluate(() => window.RunCoach.renderBetaTab());
      await p.waitForSelector(card);
      assert.equal(await p.locator("#beta-body [data-ui-beta-card]").count(), 1);
      await context.close();
    });
  }
}

/**
 * Every number a tab body shows as text, skipping drawings (chart axis ticks
 * differ by design), the screen-reader data tables and the sample-data notice.
 * @param {import("playwright").Page} page
 * @returns {Promise<string[]>}
 */
function overviewNumbers(page) {
  return page.evaluate(() => {
    const body = document.getElementById("overview-body");
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const parts = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (parent && parent.closest("svg, .demo-banner, .v-sr")) continue;
      parts.push(walker.currentNode.nodeValue || "");
    }
    return parts.join(" ").match(/\d+(?:[.:]\d+)?/g) || [];
  });
}

/**
 * The two looks are skins of one app: a person who switches must find the
 * same numbers, in the same order, on the other side.
 */
async function runParity(browser) {
  const classic = await open(browser, CLASSIC_PATH);
  const next = await open(browser, "/?ui=next");
  // The new look counts its headline numbers up from zero; read them once
  // every counter has landed on its value.
  await next.page.waitForFunction(
    () => [...document.querySelectorAll("#overview-body [data-count]")]
      .every((el) => Number.parseFloat(el.textContent || "") === Number.parseFloat(el.dataset.count || "")),
    null,
    { timeout: BOOT_TIMEOUT_MS }
  );

  await check("every number on the classic Overview is on the new Overview", async () => {
    const want = await overviewNumbers(classic.page);
    const have = new Set(await overviewNumbers(next.page));
    assert.ok(
      want.length >= MIN_OVERVIEW_NUMBERS,
      `the classic Overview on demo data should show at least ${MIN_OVERVIEW_NUMBERS} numbers, found ${want.length}`
    );
    const missing = [...new Set(want)].filter((value) => !have.has(value));
    assert.deepEqual(missing, [], "numbers the classic Overview shows and the new one does not");
  });

  await check("the six at-a-glance stats read the same in both looks", async () => {
    const strip = (text) => text.replace(/[▲▼●]/g, "").replace(/\s+/g, "");
    const classicCards = await classic.page.$$eval(".kpi-strip .kpi-card", (cards) =>
      cards.map((card) => ({
        value: card.querySelector(".kpi-card-value").textContent,
        glyph: (card.querySelector(".kpi-trend") || { textContent: "" }).textContent.trim(),
        hasSpark: !!card.querySelector(".kpi-card-spark path"),
      }))
    );
    const nextCards = await next.page.$$eval(".v-hand .v-card", (cards) =>
      cards.map((card) => {
        const arrow = card.querySelector(".v-card-trend");
        return {
          value: card.querySelector(".v-card-value").textContent,
          glyph: !arrow ? "" : arrow.classList.contains("is-up") ? "▲" : "▼",
          hasSpark: !!card.querySelector(".v-card-spark polyline"),
        };
      })
    );
    assert.equal(classicCards.length, 6);
    assert.deepEqual(nextCards.map((card) => strip(card.value)), classicCards.map((card) => strip(card.value)));
    // Classic marks "level with lifetime" with a dot; the new card says it in words.
    assert.deepEqual(nextCards.map((card) => card.glyph), classicCards.map((card) => card.glyph.replace("●", "")));
    assert.deepEqual(nextCards.map((card) => card.hasSpark), classicCards.map((card) => card.hasSpark));
  });

  await check("the new Overview keeps the classic section order", async () => {
    // Stats first, then win rate, then trends, then relics, as in classic.
    // Each section is a widget (lib/ui/overview/registry.js); this is the
    // default layout. (Relics only render when the data has some; the demo
    // data does.)
    const sections = ["hand", "winRate", "characters", "trend", "floors", "relics"];
    const order = await next.page.$$eval(
      "#overview-body .v-ov-grid > .v-w[data-w]",
      (els, names) => els.map((el) => el.dataset.w).filter((id) => names.includes(id)),
      sections
    );
    assert.deepEqual(order, sections.filter((name) => order.includes(name)));
    assert.deepEqual(order.slice(0, 5), sections.slice(0, 5));
    const titles = await next.page.$$eval("#overview-body .v-section-title h3", (els) => els.map((el) => el.textContent));
    assert.deepEqual(titles.slice(0, 2), ["Your hand", "Trends"]);
    assert.ok(await next.page.locator(".v-wr .v-eyebrow", { hasText: "Run history" }).count(), "Run history label");
  });

  assert.deepEqual([...classic.errors, ...next.errors], []);
  await classic.context.close();
  await next.context.close();
}

async function runNewsPost(browser) {
  // Newer posts (014: The Fool) have since landed above it, so the beta post
  // is no longer the one that opens by default; it only has to be listed,
  // open from the list, and have working switches.
  await check("the beta news post is listed, News is flagged NEW, and the post's switches work", async () => {
    const { context, page: p, errors } = await open(browser, CLASSIC_PATH);
    assert.equal(await p.locator("#nav-news-count").isHidden(), false, "the News tab should show the NEW pill");
    await p.evaluate(() => window.SpireVault.switchTab("news"));
    await p.waitForSelector("#news-list .news-list-item");
    const listItem = `#news-list .news-list-item[data-news-id="${BETA_NEWS_ID}"]`;
    assert.ok(await p.locator(listItem).count(), "the beta post is in the news list");
    await p.click(listItem);
    const post = `#news-${BETA_NEWS_ID}`;
    await p.waitForSelector(`${post}:not([hidden])`);
    assert.ok(await p.locator(post).isVisible(), "the beta post opens from the list");
    await p.waitForFunction((selector) => {
      const img = document.querySelector(`${selector} .news-post-banner img`);
      return img && img.complete && img.naturalWidth > 0;
    }, post);

    const turnOn = `${post} [data-action="ui-set"][data-ui="next"]`;
    const goBack = `${post} [data-action="ui-set"][data-ui="classic"]`;
    assert.equal(await p.isDisabled(goBack), true, "already on classic: the way back is a no-op");
    assert.equal(await p.isEnabled(turnOn), true);
    await switchLayout(p, turnOn, "next");

    // The reload lands on the newest post again; go back to the beta one.
    await p.evaluate(() => window.SpireVault.switchTab("news"));
    await p.waitForSelector(listItem);
    await p.click(listItem);
    await p.waitForSelector(post);
    assert.equal(await p.isDisabled(turnOn), true);
    assert.equal((await p.textContent(turnOn)).trim(), "The new look is on");
    await switchLayout(p, goBack, "classic");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("\"What's new\" opens the beta post from Settings", async () => {
    const { context, page: p } = await open(browser, CLASSIC_PATH);
    await p.evaluate(() => window.SpireVault.switchTab("settings"));
    await p.click('#settings-body [data-action="ui-open-news"]');
    await p.waitForSelector(`#news-${BETA_NEWS_ID}`);
    assert.ok(await p.locator(`#news-${BETA_NEWS_ID}`).isVisible());
    assert.ok(await p.$('.tab-panel[data-tab="news"]:not([hidden])'));
    await context.close();
  });
}

/** Check groups in run order. `--only parity,switch` runs a subset. */
/**
 * What the sidebar and one tab's panel show, for the lock checks.
 * @param {import("playwright").Page} page
 * @param {string} tab  switched to before reading
 */
async function lockState(page, tab) {
  await page.evaluate((id) => window.SpireVault.switchTab(id), tab);
  await page.waitForSelector(`.tab-panel[data-tab="${tab}"]:not([hidden])`);
  return page.evaluate((id) => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const panel = document.querySelector(`.tab-panel[data-tab="${id}"]`);
    const gate = panel.querySelector(":scope > .tab-lock");
    const cta = gate ? gate.querySelector('[data-action="signin-cta"]') : null;
    return {
      steam: document.documentElement.dataset.steam,
      lockedRows: [...document.querySelectorAll(".sidebar-nav .nav-row[data-tab]")]
        .filter((row) => shown(row.querySelector(".nav-lock")))
        .map((row) => row.dataset.tab),
      badgesOnLockedRows: [...document.querySelectorAll(".sidebar-nav .nav-row[data-steam-lock] .nav-badge")].filter(shown).length,
      markedRows: [...document.querySelectorAll(".nav-row[data-steam-lock]")].map((row) => row.dataset.tab),
      markedPanels: [...document.querySelectorAll(".tab-panel[data-steam-lock]")].map((el) => el.dataset.tab),
      gateShown: shown(gate),
      gateHeading: gate && shown(gate) ? gate.querySelector("h2").textContent.trim() : "",
      ctaHeight: cta && shown(cta) ? Math.round(cta.getBoundingClientRect().height) : 0,
      otherChildrenShown: [...panel.children].filter((el) => el !== gate && shown(el)).length,
      pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  }, tab);
}

/**
 * Co-op, Highlights and Beta need a Steam account. Signed out, each shows a
 * lock in the sidebar and a sign-in screen in place of its content, in both
 * looks and at every size; nothing is fetched for them. Signed in, nothing
 * is locked.
 */
async function runLock(browser) {
  for (const [look, path] of [["classic", CLASSIC_PATH], ["new look", "/?ui=next"]]) {
    await check(`signed out: Co-op, Highlights and Beta are locked, the rest is open (${look})`, async () => {
      const { context, page: p, errors, requests } = await open(browser, path);
      for (const tab of STEAM_LOCKED_TABS) {
        const state = await lockState(p, tab);
        assert.equal(state.steam, "out", `${tab}: <html data-steam>`);
        assert.deepEqual(state.lockedRows, STEAM_LOCKED_TABS, `${tab}: rows showing a lock`);
        assert.deepEqual(state.markedRows, STEAM_LOCKED_TABS, "index.html rows marked data-steam-lock");
        assert.deepEqual(state.markedPanels, STEAM_LOCKED_TABS, "index.html panels marked data-steam-lock");
        assert.equal(state.badgesOnLockedRows, 0, `${tab}: a locked row shows no badge`);
        assert.equal(state.gateShown, true, `${tab}: the sign-in screen shows`);
        assert.match(state.gateHeading, /^Sign in to /, `${tab}: the sign-in screen says what to do`);
        assert.ok(state.ctaHeight >= 44, `${tab}: the sign-in button is a full fingertip (${state.ctaHeight}px)`);
        assert.equal(state.otherChildrenShown, 0, `${tab}: nothing of the tab itself shows`);
        assert.equal(state.pageScrollsSideways, false, `${tab}: no sideways scroll`);
      }
      for (const tab of ["overview", "runs", "news", "settings"]) {
        const state = await lockState(p, tab);
        assert.equal(state.gateShown, false, `${tab} is not locked`);
        assert.ok(state.otherChildrenShown > 0, `${tab} shows its content`);
      }
      // A theme switch rewrites attributes across the page; the co-op lobby
      // scripts used to answer every such change with another fetch.
      await lockState(p, "coop");
      await p.evaluate(() => {
        if (typeof window.SpireVault.setTheme === "function") window.SpireVault.setTheme("vault");
      });
      await p.waitForTimeout(800);
      assert.deepEqual(requests.filter((pathname) => STEAM_ONLY_API.test(pathname)), [], "nothing is fetched for the locked tabs");
      assert.deepEqual(errors, []);
      await context.close();
    });

    await check(`signed in: nothing is locked (${look})`, async () => {
      const { context, page: p } = await open(browser, path, { signedIn: true });
      for (const tab of STEAM_LOCKED_TABS) {
        const state = await lockState(p, tab);
        assert.equal(state.steam, "in", `${tab}: <html data-steam>`);
        assert.deepEqual(state.lockedRows, [], `${tab}: no row shows a lock`);
        assert.equal(state.gateShown, false, `${tab}: no sign-in screen`);
        assert.ok(state.otherChildrenShown > 0, `${tab}: the tab's own content shows`);
      }
      await p.waitForSelector("#beta-body .beta-grid, #beta-body .v-beta", { state: "visible" });
      await context.close();
    });
  }

  await check("the lock is decided before the app script runs, so it never flashes", async () => {
    for (const [signedIn, want] of [[false, "out"], [true, "in"]]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      if (signedIn) {
        await context.addInitScript((value) => window.localStorage.setItem("vault.web.session", value), JSON.stringify(TEST_SESSION));
      }
      const p = await context.newPage();
      await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
      // Without script.js, only the boot script in index.html has run.
      await p.route("**/script.js*", (route) => route.abort());
      await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      assert.equal(await p.evaluate(() => document.documentElement.dataset.steam), want, signedIn ? "signed in" : "signed out");
      await context.close();
    }
  });

  await check("the sign-in screen's button starts Steam sign-in", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    await lockState(p, "beta");
    const started = p.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/steam/start");
    await p.click('.tab-panel[data-tab="beta"] > .tab-lock [data-action="signin-cta"]');
    await started;
    await context.close();
  });

  await check("classic on a phone: locked chips in the tab strip, sign-in screen fits", async () => {
    const { context, page: p, errors } = await open(browser, CLASSIC_PATH, { viewport: PHONE_VIEWPORT });
    for (const tab of STEAM_LOCKED_TABS) {
      const state = await lockState(p, tab);
      assert.deepEqual(state.lockedRows, STEAM_LOCKED_TABS, `${tab}: chips showing a lock`);
      assert.equal(state.gateShown, true, `${tab}: the sign-in screen shows`);
      assert.ok(state.ctaHeight >= 44, `${tab}: sign-in button height ${state.ctaHeight}px`);
      assert.equal(state.otherChildrenShown, 0, `${tab}: nothing of the tab itself shows`);
      assert.equal(state.pageScrollsSideways, false, `${tab}: no sideways scroll`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("new look on a phone: the bar and the More sheet show the locks, sign-in screen fits", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next", { viewport: PHONE_VIEWPORT });
    const coop = await lockState(p, "coop");
    assert.ok(coop.lockedRows.includes("coop"), "the Co-op slot in the bottom bar shows a lock");
    assert.equal(coop.gateShown, true);
    assert.ok(coop.ctaHeight >= 44, `sign-in button height ${coop.ctaHeight}px`);
    assert.equal(coop.pageScrollsSideways, false);
    await p.click(".v-mnav-more");
    await p.waitForSelector("#v-mnav-sheet[open], dialog.v-mnav-sheet[open]", { state: "visible" });
    const tiles = await p.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll("[data-mnav-badge]")].map((badge) => [
          badge.dataset.mnavBadge,
          badge.hidden ? "none" : badge.dataset.kind,
        ])
      )
    );
    assert.equal(tiles.highlights, "lock", "Highlights tile");
    assert.equal(tiles.beta, "lock", "Beta tile");
    assert.notEqual(tiles.news, "lock", "News tile stays open");
    await p.click('[data-mnav-tab="beta"]');
    const beta = await lockState(p, "beta");
    assert.equal(beta.gateShown, true, "tapping a locked tile opens its sign-in screen");
    assert.equal(beta.otherChildrenShown, 0);
    assert.equal(beta.pageScrollsSideways, false);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

/** A context whose first page load already has the header scenery pinned. */
function pinnedScene(take) {
  return { storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: "vault.web.stage-scene", value: take }] }] } };
}

/**
 * Scenes the header must be able to deal from: Corey asked for at least ten
 * (2026-11-15). The painted masters live in scripts/stage-art/scenes/
 * (build-stage-scenes.mjs).
 */
const MIN_STAGE_SCENES = 10;

/**
 * The header's scenery: one painted plate per scene, a new scene each time a
 * tab is opened, moving on its own and holding still under the pointer.
 */
async function runScene(browser) {
  await check("every scene's pictures are on disk", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    const result = await p.evaluate(async () => {
      const { STAGE_SCENES } = await import("/lib/ui/stage-scene-list.js?v=1");
      const srcs = STAGE_SCENES.flatMap((scene) => scene.srcset.split(",").map((part) => part.trim().split(" ")[0]));
      const bad = [];
      for (const src of srcs) {
        const response = await fetch(src);
        if (!response.ok || !/^image\/webp/.test(response.headers.get("content-type") || "")) bad.push(`${src} -> ${response.status}`);
      }
      return { scenes: STAGE_SCENES.length, ids: new Set(STAGE_SCENES.map((scene) => scene.id)).size, files: srcs.length, bad };
    });
    assert.ok(result.scenes >= MIN_STAGE_SCENES, `${result.scenes} scenes`);
    assert.equal(result.ids, result.scenes, "scene ids are unique");
    assert.deepEqual(result.bad, [], "every picture loads as a WebP");
    await context.close();
  });

  await check("the scene is one painted plate covering the header, alive on its own", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next", pinnedScene("glory"));
    await p.waitForSelector('.tab-panel[data-tab="overview"] .v-scene[data-scene-id="glory"] .v-scene-img.is-in');
    const read = () =>
      p.evaluate(() => {
        const root = document.querySelector('.tab-panel[data-tab="overview"] .v-stage-bg');
        const scene = root.querySelector(".v-scene").getBoundingClientRect();
        const plate = root.querySelector(".v-scene-plate");
        const box = plate.getBoundingClientRect();
        return {
          scene: root.dataset.scene,
          images: root.querySelectorAll(".v-scene-img").length,
          src: root.querySelector(".v-scene-img").currentSrc,
          covers: box.left <= scene.left + 1 && box.right >= scene.right - 1 && box.top <= scene.top + 1 && box.bottom >= scene.bottom - 1,
          camera: getComputedStyle(plate).transform,
          mistX: new DOMMatrix(getComputedStyle(root.querySelector(".v-scene-mist--near")).transform).m41,
          lights: root.querySelectorAll(".v-scene-light").length,
          motes: root.querySelectorAll(".v-scene-motes i").length,
          moving: document.getAnimations().filter((a) => a.playState === "running" && /^v-(scene|mote|light|shaft)-/.test(a.animationName || "")).length,
        };
      });
    const first = await read();
    assert.equal(first.scene, "glory");
    assert.equal(first.images, 1, "one picture, never tiled or repeated");
    assert.match(first.src, /\/assets\/stage\/scenes\/glory-\d+-v\d+\.webp$/);
    assert.equal(first.covers, true, "the plate covers the whole scene");
    assert.ok(first.lights >= 2, `${first.lights} lights`);
    assert.ok(first.motes >= 9, `${first.motes} motes in the air`);
    assert.ok(first.moving >= 8, `${first.moving} scenery animations running`);
    await p.waitForTimeout(1500);
    const later = await read();
    assert.notEqual(later.camera, first.camera, "the camera eased");
    assert.ok(Math.abs(later.mistX - first.mistX) > 2, `the mist moved (${first.mistX} -> ${later.mistX})`);
    assert.equal(later.covers, true, "the plate still covers the scene mid-move");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("each tab opened shows a new scene", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    await p.waitForSelector('.tab-panel[data-tab="overview"] .v-scene-img');
    const seen = await p.evaluate(async () => {
      const sceneOf = (tab) => document.querySelector(`.tab-panel[data-tab="${tab}"] .v-stage-bg`).dataset.scene;
      const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
      const log = [["overview", sceneOf("overview")]];
      for (const tab of ["characters", "characters", "ascensions", "overview", "cards", "relics"]) {
        window.SpireVault.switchTab(tab);
        await pause();
        log.push([tab, sceneOf(tab)]);
      }
      return log;
    });
    for (let i = 1; i < seen.length; i += 1) {
      const [tab, scene] = seen[i];
      const [prevTab, prevScene] = seen[i - 1];
      if (tab === prevTab) assert.equal(scene, prevScene, `re-selecting ${tab} keeps its scene`);
      else assert.notEqual(scene, prevScene, `${prevTab} -> ${tab}: a new scene (${seen.map((s) => s.join(":")).join(", ")})`);
    }
    const overview = seen.filter(([tab]) => tab === "overview").map(([, scene]) => scene);
    assert.notEqual(overview[1], overview[0], "coming back to Overview deals it a new scene");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the header holds still under the pointer", async () => {
    const { context, page: p } = await open(browser, "/?ui=next", pinnedScene("hive"));
    await p.waitForFunction(() => [...document.querySelectorAll(".v-actor-art")].every((img) => img.complete));
    await p.waitForTimeout(BUBBLE_SETTLE_MS);
    const boxes = () =>
      p.evaluate(() => {
        const head = document.querySelector('.tab-panel[data-tab="overview"] > .panel-head');
        const names = { torches: ".v-torches", ledge: ".v-stage-ledge", spire: ".v-spire", climber: ".v-actor--climber", boss: ".v-actor--boss", torchCap: ".v-torches .v-stage-cap", scene: ".v-scene" };
        const out = { px: head.style.getPropertyValue("--px") };
        for (const [key, selector] of Object.entries(names)) {
          const el = head.querySelector(selector);
          out[key] = el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null;
        }
        return out;
      });
    const before = await boxes();
    const head = await p.evaluate(() => {
      const r = document.querySelector('.tab-panel[data-tab="overview"] > .panel-head').getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    // Along the top edge, then through the middle, end to end.
    for (const y of [head.top + 6, (head.top + head.bottom) / 2]) {
      for (const share of [0.05, 0.3, 0.6, 0.95]) {
        await p.mouse.move(head.left + (head.right - head.left) * share, y, { steps: 4 });
        await p.waitForTimeout(120);
      }
    }
    await p.waitForTimeout(400);
    assert.deepEqual(await boxes(), before, "nothing in the header shifted sideways");
    assert.equal(before.px, "", "no pointer offset is set on the header");
    await context.close();
  });
}

/**
 * The share dialog: the new look draws the compact 1200 x 630 card; the
 * classic look keeps its own card and never loads the new one.
 */
async function runShare(browser) {
  /** Opens Recent Runs and the share dialog for its first run. */
  const openShare = async (p) => {
    await p.evaluate(() => window.SpireVault.switchTab("runs"));
    await p.waitForSelector('[data-action="share-run"]');
    await p.locator('[data-action="share-run"]').first().click();
    await p.waitForSelector("#share-modal:not([hidden])");
  };
  /** The canvas's size, and how many different colours a grid of samples finds. */
  const cardState = (p) =>
    p.evaluate(() => {
      const canvas = document.getElementById("share-canvas");
      const ctx = canvas.getContext("2d");
      const colours = new Set();
      for (let y = 0.05; y < 1; y += 0.05) {
        for (let x = 0.02; x < 1; x += 0.02) {
          const [r, g, b] = ctx.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data;
          colours.add(`${r >> 3},${g >> 3},${b >> 3}`);
        }
      }
      const corner = ctx.getImageData(2, 2, 1, 1).data[3];
      const modal = document.querySelector("#share-modal .modal").getBoundingClientRect();
      const body = document.querySelector("#share-modal .modal-body");
      return {
        size: [canvas.width, canvas.height],
        colours: colours.size,
        cornerAlpha: corner,
        fits: modal.top >= 0 && modal.bottom <= window.innerHeight,
        scrolls: body.scrollHeight > body.clientHeight + 1,
      };
    });

  await check("new look: the share card is the compact card, with the run's art on it", async () => {
    const { context, page: p, errors, requests } = await open(browser, "/?ui=next");
    await openShare(p);
    await p.waitForFunction(() => document.fonts.status === "loaded");
    await p.waitForTimeout(1500);
    const card = await cardState(p);
    assert.deepEqual(card.size, [2400, 1260], "1200 x 630 at 2x");
    assert.ok(card.colours > 150, `art is on the card (${card.colours} colours sampled)`);
    assert.equal(card.cornerAlpha, 0, "the corners outside the rounded card are clear");
    assert.equal(card.fits, true, "the dialog fits a 1440 x 900 window");
    assert.equal(card.scrolls, false, "nothing in the dialog needs scrolling");
    assert.ok(requests.some((pathname) => /^\/assets\/stage\/backdrops\/.+\.webp$/.test(pathname)), "a room was loaded for the card");
    assert.ok(requests.some((pathname) => /^\/assets\/stage\/.+-ink-v\d+\.webp$/.test(pathname)), "the climber's sprite was loaded");
    const [download] = await Promise.all([p.waitForEvent("download"), p.click("#share-download")]);
    assert.match(download.suggestedFilename(), /^spirevault-.+\.png$/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("new look on a phone: the share dialog fits and the card keeps its shape", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next", { viewport: PHONE_VIEWPORT });
    await openShare(p);
    await p.waitForTimeout(1200);
    const shape = await p.evaluate(() => {
      const canvas = document.getElementById("share-canvas").getBoundingClientRect();
      return { ratio: canvas.width / canvas.height, right: canvas.right, sideways: document.documentElement.scrollWidth > window.innerWidth };
    });
    assert.ok(Math.abs(shape.ratio - 1200 / 630) < 0.02, `card ratio ${shape.ratio.toFixed(3)}`);
    assert.ok(shape.right <= PHONE_VIEWPORT.width, "the card stays inside the screen");
    assert.equal(shape.sideways, false);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("classic keeps its own share card and never loads the new one", async () => {
    const { context, page: p, errors, requests } = await open(browser, CLASSIC_PATH);
    await openShare(p);
    await p.waitForTimeout(1200);
    const card = await cardState(p);
    assert.deepEqual(card.size, [1760, 1240], "the classic 880 x 620 card at 2x");
    assert.ok(card.colours > 40, "the classic card painted");
    assert.deepEqual(requests.filter((pathname) => /share-card\.js|\/assets\/stage\/backdrops\//.test(pathname)), []);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

/**
 * Card faces come in two sizes: 205x256 for thumbnails, and twice that
 * wherever the new look shows a card large. The classic look only ever uses
 * the small ones.
 */
// ---- Saved runs: importing is a one-time thing ------------------------------
/** The last signed-in Steam account on this device (Web/script.js). */
const OWNER_KEY = "vault.web.history.owner";
/** How many sample runs a seeded save holds: fewer than the 73-run sample set. */
const SEEDED_RUNS = 12;

/**
 * Writes runs into this origin's saved-runs store under `key`, the way the
 * app saves an import ("current" for a guest, "current:<steamID>" for an account).
 * @param {import("playwright").Page} page @param {string} key
 */
async function seedSavedRuns(page, key) {
  await page.evaluate(async ({ key, count }) => {
    const { getDemoRuns } = await import("/lib/demo-runs.js?v=2");
    const runs = getDemoRuns().slice(0, count).map((r) => ({
      ...r,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    }));
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("vault-web", 2);
      req.onupgradeneeded = () => {
        for (const name of ["history", "handles"]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("history", "readwrite");
      tx.objectStore("history").put({ savedAt: new Date().toISOString(), sourceFilename: "verify", runs }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { key, count: SEEDED_RUNS });
}

/** @param {import("playwright").Page} page */
async function savedRunsState(page) {
  await page.waitForSelector("#overview-body .v-ov, #overview-body .kpi-strip", { timeout: BOOT_TIMEOUT_MS });
  return page.evaluate(() => ({
    sample: !!document.querySelector(".demo-banner"),
    status: document.getElementById("status-dot")?.dataset.state ?? "",
    label: document.getElementById("status-label")?.textContent.trim() ?? "",
    note: document.querySelector(".me-pill-guest-note")?.textContent.trim() ?? "",
  }));
}

async function runSaves(browser) {
  await check("a lapsed sign-in keeps your runs on screen, with a nudge to sign in again", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    await seedSavedRuns(p, `current:${TEST_SESSION.steamID}`);
    await p.evaluate(({ key, id }) => localStorage.setItem(key, id), { key: OWNER_KEY, id: TEST_SESSION.steamID });
    await p.reload({ waitUntil: "domcontentloaded" });
    const state = await savedRunsState(p);
    assert.equal(state.sample, false, "your saved runs show, not the sample data");
    assert.equal(state.status, "expired", "the connection line says the sign-in lapsed");
    assert.match(state.label, /sign in/i);
    assert.match(state.note, /signed out.*sign in again/i, "the card says what happened and what to do");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("after a deliberate sign-out, a shared computer shows nobody's runs", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    await seedSavedRuns(p, `current:${TEST_SESSION.steamID}`);
    await p.reload({ waitUntil: "domcontentloaded" });
    const state = await savedRunsState(p);
    assert.equal(state.sample, true, "with no account on record, a signed-out visitor sees the sample data");
    assert.match(state.note, /^Optional\. Unlocks/, "with only sample data, the card says what signing in unlocks");
    await context.close();
  });

  await check("a guest's own import still shows on the next visit", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    await seedSavedRuns(p, "current");
    await p.reload({ waitUntil: "domcontentloaded" });
    const state = await savedRunsState(p);
    assert.equal(state.sample, false);
    assert.equal(state.status, "offline", "a guest is a guest, not a lapsed sign-in");
    assert.match(state.note, /saved in this browser only.*back up/i, "the card says where the runs live and how to keep them");
    await context.close();
  });

  await check("signing in records the account as this device's owner", async () => {
    const { context, page: p } = await open(browser, "/?ui=next", { signedIn: true });
    const owner = await p.evaluate((key) => localStorage.getItem(key), OWNER_KEY);
    assert.equal(owner, TEST_SESSION.steamID);
    await context.close();
  });
}

async function runCards(browser) {
  await check("the large card faces are on disk at twice the size", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    const result = await p.evaluate(async () => {
      const { CARD_ART_HD, hdCardSrc } = await import("/lib/ui/card-art-hd.js?v=1");
      const manifest = await (await fetch("/assets/sts2/manifest.json")).json();
      const withLarge = manifest.cards.filter((slug) => !CARD_ART_HD.missing.has(slug));
      const bad = [];
      // Every 20th card, so the check stays quick but covers every pool.
      for (let i = 0; i < withLarge.length; i += 20) {
        const src = hdCardSrc(`/assets/sts2/cards/${withLarge[i]}.webp`);
        const image = new Image();
        image.src = src;
        try {
          await image.decode();
          if (image.naturalWidth !== CARD_ART_HD.width || image.naturalHeight !== CARD_ART_HD.height) bad.push(`${src} is ${image.naturalWidth}x${image.naturalHeight}`);
        } catch {
          bad.push(`${src} did not load`);
        }
      }
      const missing = [...CARD_ART_HD.missing];
      return {
        cards: manifest.cards.length,
        withLarge: withLarge.length,
        bad,
        missingKeepsSmall: missing.length === 0 || hdCardSrc(`/assets/sts2/cards/${missing[0]}.webp`) === `/assets/sts2/cards/${missing[0]}.webp`,
        otherUrlsUntouched: hdCardSrc("/assets/sts2/relics/anchor.webp") === "/assets/sts2/relics/anchor.webp" && hdCardSrc(null) === null,
        versionedUrlWorks: hdCardSrc(`/assets/sts2/cards/${withLarge[0]}.webp?v=2`) === `${CARD_ART_HD.dir}/${withLarge[0]}.webp`,
      };
    });
    assert.ok(result.withLarge > result.cards * 0.95, `${result.withLarge} of ${result.cards} cards have a large face`);
    assert.deepEqual(result.bad, []);
    assert.equal(result.missingKeepsSmall, true, "a card without a large face keeps its small one");
    assert.equal(result.otherUrlsUntouched, true, "only card image URLs are rewritten");
    assert.equal(result.versionedUrlWorks, true, "a card URL with its ?v= token maps to the large face");
    await context.close();
  });

  await check("new look: the podium shows large faces, and a row's card is sharp before it is hovered", async () => {
    // A short window, so some rows start well below the fold.
    const { context, page: p, errors } = await open(browser, "/?ui=next", { deviceScaleFactor: 2, viewport: { width: 1440, height: 640 } });
    await p.evaluate(() => window.SpireVault.switchTab("cards"));
    await p.waitForSelector(".v-cd-podium img");
    await p.waitForFunction(() => [...document.querySelectorAll(".v-cd-podium img")].every((img) => img.complete && img.naturalWidth > 0));
    const podium = await p.evaluate(() =>
      [...document.querySelectorAll(".v-cd-podium img")].map((img) => ({
        natural: img.naturalWidth,
        needed: Math.ceil(img.getBoundingClientRect().width * window.devicePixelRatio),
      }))
    );
    assert.ok(podium.length >= 1, "the podium has cards");
    for (const card of podium) {
      assert.ok(card.natural >= card.needed, `a podium card needs ${card.needed}px and its file has ${card.natural}px`);
    }
    // Every row names its large face from the start and the picture never
    // changes after it appears: rows used to show the small face and swap
    // the large one in as they neared the screen, and players watched each
    // card go soft-to-sharp. Lazy loading still keeps far rows from loading.
    const sources = await p.evaluate(() => [...document.querySelectorAll(".v-cd-row .v-cd-thumb img")].map((img) => ({ src: img.getAttribute("src"), hd: img.hasAttribute("data-hd") })));
    assert.ok(sources.length >= 2, "the table has card rows");
    assert.ok(sources.every((s) => /cards-hd/.test(s.src) && !s.hd), "every row names its large face from the start");
    const row = p.locator(".v-cd-row").last();
    const image = await row.locator(".v-cd-thumb img").elementHandle();
    const before = await image.evaluate((img) => img.getAttribute("src"));
    await row.scrollIntoViewIfNeeded();
    await p.waitForFunction((img) => img.complete && img.naturalWidth === 410, image);
    assert.equal(await image.evaluate((img) => img.getAttribute("src")), before, "the picture is not swapped once it is on screen");
    await row.hover();
    assert.equal(await image.evaluate((img) => img.naturalWidth), 410, "hovered, it is already the large face");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("classic never loads the large card faces", async () => {
    const { context, page: p, errors, requests } = await open(browser, CLASSIC_PATH, { deviceScaleFactor: 2 });
    await p.evaluate(() => window.SpireVault.switchTab("cards"));
    await p.waitForSelector("#cards-body img");
    await p.waitForTimeout(800);
    assert.deepEqual(requests.filter((pathname) => /cards-hd|card-art-hd/.test(pathname)), []);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// ---- Co-op: one-tap Play ------------------------------------------------------

const COOP_ME = TEST_SESSION.steamID;
const COOP_MATE = "76561198000000002";
const COOP_T0 = Date.UTC(2026, 10, 14, 20, 0, 0);

/** Server answers for each state, shaped like Backend/src/coop-play-core.ts viewFor(). */
function coopView(state, extra = {}) {
  const base = { ok: true, lookingCount: 0, playingCount: 0, lookingByBranch: { stable: 0, beta: 0 }, pings: { looking: false }, pushOn: false };
  const members = (youHost) => [
    { sid: youHost ? COOP_ME : COOP_MATE, name: youHost ? "TestClimber" : "Boble", character: youHost ? "silent" : "ironclad", isHost: true, isYou: youHost, steamAdded: false, status: "joined" },
    { sid: youHost ? COOP_MATE : COOP_ME, name: youHost ? "Boble" : "TestClimber", character: youHost ? "ironclad" : "silent", isHost: false, isYou: !youHost, steamAdded: false, status: "joined" },
  ];
  const match = (youHost, locked = false) => ({
    matchId: "ab".repeat(16), branch: "stable", createdAt: COOP_T0, youAreHost: youHost, hostSid: youHost ? COOP_ME : COOP_MATE,
    hostHosting: false, locked, seatsLeft: 2, members: members(youHost),
  });
  switch (state) {
    case "idle": return { ...base, state: "idle", lookingCount: 1, lookingByBranch: { stable: 1, beta: 0 }, ...extra };
    case "searching": return { ...base, state: "searching", lookingCount: 1, lookingByBranch: { stable: 1, beta: 0 }, ticket: { createdAt: Date.now() - 42000, character: "silent", branch: "stable", push: false }, ...extra };
    case "host": return { ...base, state: "matched", playingCount: 2, match: match(true), ...extra };
    case "joiner": return { ...base, state: "matched", playingCount: 2, match: match(false), ...extra };
    case "in_game": return { ...base, state: "in_game", playingCount: 2, match: match(true, true), ...extra };
    default: throw new Error(state);
  }
}

/**
 * The roster the app polls (/api/presence/roster), for the sign in the room's
 * sky: you and five others in STS2, one more who is not. The sign counts the
 * five and shows their faces, never yours.
 */
const COOP_ROSTER = Object.freeze([
  { steamID: COOP_ME, personaName: "TestClimber", avatarURL: "", status: "looking", inSTS2: true },
  ...["Boble", "Mako", "Rook", "Vex", "Tallow"].map((name, i) => ({ steamID: `7656119800000020${i}`, personaName: name, avatarURL: "", status: "looking", inSTS2: true })),
  { steamID: "76561198000000299", personaName: "Away", avatarURL: "", status: "looking", inSTS2: false },
]);
const COOP_ROSTER_ROUTE = ["**/api/presence/roster**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(COOP_ROSTER) })];

/** A mock of /api/coop/play whose answer the test can change, recording what was sent. */
function coopServer(initial) {
  const server = { view: coopView(initial), posts: [] };
  server.route = ["**/api/coop/play**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") server.posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(server.view) });
  }];
  return server;
}

/** @param {import("playwright").Page} page */
async function coopCard(page, state) {
  await page.evaluate(() => window.SpireVault.switchTab("overview"));
  await page.evaluate(() => window.SpireVault.switchTab("coop"));
  await page.waitForSelector(`#coop-play-root .cp[data-cp-state="${state}"]`, { timeout: 8000 });
  return page.evaluate(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0;
    const play = document.querySelector(".cp-play");
    const bar = document.querySelector("[data-v-mnav]");
    // On phones the new look turns the nav into a bottom tab bar; Play must
    // clear it. On desktop the same element is the sidebar, so ignore it.
    const barTop = bar && shown(bar) ? bar.getBoundingClientRect().top : Infinity;
    const floor = barTop > window.innerHeight / 2 && barTop < window.innerHeight ? barTop : window.innerHeight;
    return {
      cards: document.querySelectorAll("#coop-play-root .cp-card").length,
      title: document.querySelector(".cp-title")?.textContent.trim() ?? "",
      playOnScreen: play ? play.getBoundingClientRect().bottom <= floor && play.getBoundingClientRect().top >= 0 : null,
      playAt: play ? `${Math.round(play.getBoundingClientRect().top)}–${Math.round(play.getBoundingClientRect().bottom)} of ${Math.round(floor)}; page scrolled ${Math.round(window.scrollY)}; head ${Math.round(document.querySelector(".tab-panel[data-tab='coop'] .panel-head")?.getBoundingClientRect().height ?? 0)}px` : "",
      oldPieces: ["#pf-root", ".coop-bar", "#coop-showtime-strip", ".pf-welcome", ".pf-welcome-backdrop", "#pf-intents", ".guest-coop"]
        .filter((sel) => document.querySelector(sel)).join(", "),
      sideways: document.documentElement.scrollWidth > window.innerWidth,
      liveCoopLinks: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .filter((l) => /\/lib\/coop-play\.css/.test(l.href) && l.media !== "not all").length,
    };
  });
}

async function runCoop(browser) {
  for (const [label, path] of [["classic", CLASSIC_PATH], ["new look", "/?ui=next"]]) {
    for (const width of [1440, 1024, 390]) {
      await check(`co-op (${label}, ${width}px): one card, Play on screen, no old lobby pieces`, async () => {
        const server = coopServer("idle");
        const { context, page: p, errors, requests } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 768 },
        });
        const card = await coopCard(p, "idle");
        assert.equal(card.cards, 1);
        assert.equal(card.title, "Play co-op");
        assert.equal(card.playOnScreen, true, `the Play button is visible without scrolling (${card.playAt})`);
        assert.equal(card.oldPieces, "", "old co-op pieces are still in the page");
        assert.equal(card.sideways, false, "the page scrolls sideways");
        if (label === "new look") assert.equal(card.liveCoopLinks, 0, "coop-play.css must sit in the legacy layer in the new look");
        assert.deepEqual(requests.filter((x) => /party-finder|coop-lobbies|party-room|coop-sandbox/.test(x)), [], "old lobby scripts were requested");
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // A full party of four, one with a long Steam name: the name tags above the
  // climbers must keep an even gap, stay inside the room and never cut a
  // short name, from a laptop down to a 320px phone (where they step into two
  // rows), in both looks.
  const fullParty = () => {
    const view = coopView("host");
    const people = [
      { sid: COOP_ME, name: "c3rooks", character: "fool", isYou: true },
      { sid: COOP_MATE, name: "Boble", character: "ironclad" },
      { sid: "76561198000000003", name: "Mako", character: "defect" },
      { sid: "76561198000000004", name: "IAmWeirdAndLong", character: "necrobinder" },
    ];
    view.match.members = people.map((m, i) => ({ isYou: false, ...m, isHost: i === 0, steamAdded: false, status: "joined" }));
    view.match.seatsLeft = 0;
    return view;
  };
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1440, 390, 360, 320]) {
      await check(`co-op (${label}, ${width}px): a full party's name tags are evenly spaced, inside the room, short names whole`, async () => {
        const server = coopServer("idle");
        server.view = fullParty();
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 900 },
        });
        await coopCard(p, "matched");
        await p.waitForTimeout(300);
        const tags = await p.evaluate(() => {
          const scene = document.querySelector('.cp[data-cp-state="matched"] .cp-scene');
          const frame = scene.getBoundingClientRect();
          return [...scene.querySelectorAll(".cp-climber > .cp-tag")].map((tag) => {
            const r = tag.getBoundingClientRect();
            const name = tag.querySelector(".cp-tag-name");
            return { name: name.textContent, left: r.left - frame.left, right: r.right - frame.left, top: Math.round(r.top), width: Math.round(r.width), frame: frame.width, cut: name.scrollWidth > name.clientWidth + 1 };
          });
        });
        assert.equal(tags.length, 4);
        assert.equal(new Set(tags.map((t) => t.width)).size, 1, `one shared width (${tags.map((t) => t.width).join(", ")})`);
        for (const t of tags) {
          assert.ok(t.left >= 7.5 && t.frame - t.right >= 7.5, `${t.name} stays 8px inside the room (${Math.round(t.left)} / ${Math.round(t.frame - t.right)})`);
        }
        for (const [i, t] of tags.entries()) {
          const next = tags.slice(i + 1).find((u) => Math.abs(u.top - t.top) < 3);
          if (next) assert.ok(next.left - t.right >= 7.5, `${t.name} and ${next.name} keep an 8px gap (${Math.round(next.left - t.right)})`);
        }
        assert.deepEqual(tags.filter((t) => t.cut && t.name !== "IAmWeirdAndLong").map((t) => t.name), [], "short names are never cut");
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  await check("co-op: every state is one card with its own title", async () => {
    const server = coopServer("idle");
    const { context, page: p, errors } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    const expect = [
      ["searching", "searching", "Looking for a partner…"],
      ["host", "matched", "You're in a party"],
      ["joiner", "matched", "You're in a party"],
      ["in_game", "in_game", "Have a good climb"],
    ];
    for (const [fixture, state, title] of expect) {
      server.view = coopView(fixture);
      const card = await coopCard(p, state);
      assert.equal(card.cards, 1, fixture);
      assert.equal(card.title, title, fixture);
    }
    server.view = coopView("host");
    await coopCard(p, "matched");
    const host = await p.evaluate(() => ({
      add: [...document.querySelectorAll('[data-cp="steam-add"]')].map((b) => b.textContent.trim()),
      hosting: !!document.querySelector('[data-cp="hosting"]'),
      launch: document.querySelector('[data-cp="launch"]')?.getAttribute("href"),
      figures: document.querySelectorAll(".cp-card .cp-scene .cp-climber").length,
      seats: document.querySelectorAll(".cp-card .cp-scene .cp-seat").length,
      stones: document.querySelectorAll(".cp-card .cp-scene .cp-stone").length,
    }));
    assert.deepEqual(host.add, ["Add Boble"], "the host adds each joiner");
    assert.equal(host.hosting, true);
    assert.equal(host.launch, "steam://run/2868840", "Launch opens STS2 (app 2868840)");
    assert.equal(host.figures, 2);
    assert.equal(host.seats, 2);
    assert.equal(host.stones, 2, "seated climbers (Silent, Ironclad) rest on a stone");
    server.view = coopView("joiner");
    await coopCard(p, "matched");
    const joiner = await p.evaluate(() => ({
      add: [...document.querySelectorAll('[data-cp="steam-add"]')].map((b) => b.textContent.trim()),
      hosting: !!document.querySelector('[data-cp="hosting"]'),
    }));
    assert.deepEqual(joiner.add, ["Add Boble"], "a joiner adds the host only");
    assert.equal(joiner.hosting, false, "only the host says they're hosting");
    assert.deepEqual(errors, []);
    await context.close();
  });

  // Share to Discord (lib/coop-play-share.js): offered only while a friend
  // could still take a seat, in both looks, and never pushing the page wide.
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1440, 390]) {
      await check(`co-op (${label}, ${width}px): Share to Discord shows while looking and with open seats, and only then`, async () => {
        const server = coopServer("idle");
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 900 },
        });
        const shareButton = () => p.evaluate(() => {
          const b = document.querySelector('#coop-play-root .cp-card [data-cp="share"]');
          if (!b) return null;
          const r = b.getBoundingClientRect();
          const bar = document.querySelector("[data-v-mnav]");
          const barTop = bar && bar.getClientRects().length ? bar.getBoundingClientRect().top : Infinity;
          const floor = barTop > window.innerHeight / 2 && barTop < window.innerHeight ? barTop : window.innerHeight;
          return {
            text: b.innerText.trim(), height: Math.round(r.height), onScreen: r.top >= 0 && r.bottom <= floor,
            inside: r.left >= 0 && r.right <= window.innerWidth, sideways: document.documentElement.scrollWidth > window.innerWidth,
            background: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color,
          };
        });
        await coopCard(p, "idle");
        assert.equal(await shareButton(), null, "the card has no Share button before you tap Play");
        for (const [fixture, state] of [["searching", "searching"], ["host", "matched"], ["joiner", "matched"]]) {
          server.view = coopView(fixture);
          await coopCard(p, state);
          const b = await shareButton();
          assert.ok(b, `${fixture}: the button is there`);
          assert.equal(b.text, "Share to Discord", fixture);
          assert.ok(b.height >= 44, `${fixture}: ${b.height}px tall`);
          assert.equal(b.onScreen, true, `${fixture}: visible without scrolling`);
          assert.equal(b.inside && !b.sideways, true, `${fixture}: inside the page`);
          assert.equal(b.background, "rgb(88, 101, 242)", `${fixture}: Discord's blurple`);
          assert.equal(b.color, "rgb(255, 255, 255)", fixture);
        }
        const full = coopView("host");
        full.match.seatsLeft = 0;
        server.view = full;
        await coopCard(p, "matched");
        assert.equal(await shareButton(), null, "a full party has no seat to offer");
        server.view = coopView("in_game");
        await coopCard(p, "in_game");
        assert.equal(await shareButton(), null, "a run under way cannot be joined");
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // Under the card: the live strip, the invite panel and the co-op numbers.
  const coopSave = (n, party, extra = {}) => {
    const ended = new Date(Date.UTC(2026, 10, 1 + n, 21, 0, 0));
    return {
      id: `coop-${n}`, character: party[0], party, partySize: party.length, ascension: 5, seed: `T${n}`, won: false, floorReached: 24,
      playTimeSeconds: 2400, startedAt: new Date(ended.getTime() - 2400_000).toISOString(), endedAt: ended.toISOString(),
      relics: [], deckAtEnd: [], cardPicks: [], pathByAct: [], sourceFile: `coop-${n}.run`, schemaVersion: 11, gameMode: "standard",
      wasAbandoned: false, modifiers: [], inProgress: false, ...extra,
    };
  };
  const SOLO_SAVES = [coopSave(1, ["silent"], { won: true, floorReached: 51 }), coopSave(2, ["ironclad"])];
  const COOP_SAVES = [
    ...SOLO_SAVES,
    coopSave(4, ["fool", "necrobinder"], { ascension: 3, floorReached: 20 }),
    coopSave(6, ["ironclad", "silent"], { won: true, ascension: 7, floorReached: 51 }),
    coopSave(9, ["defect", "regent", "silent"], { floorReached: 12, wasAbandoned: true }),
    coopSave(12, ["ironclad", "silent"], { ascension: 9, floorReached: 33 }),
    coopSave(14, ["silent", "ironclad"], { won: true, ascension: 8, floorReached: 51 }),
  ];

  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1728, 1440, 390, 320]) {
      await check(`co-op (${label}, ${width}px): the live counts hang in the room's sky before a match and under the card after; the invite and your co-op climbs sit under the card, all inside the page`, async () => {
        const server = coopServer("idle");
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route, COOP_ROSTER_ROUTE], viewport: { width, height: width < 600 ? 844 : width > 1600 ? 1000 : 900 },
        });
        // The sign in the room's sky (before a match), read as it is drawn.
        const sky = () => p.evaluate(() => {
          const sign = document.querySelector("#coop-play-root .cp-card .cp-sky");
          if (!sign) return null;
          const shown = (el) => el.getClientRects().length > 0;
          const s = sign.getBoundingClientRect();
          const scene = sign.closest(".cp-scene");
          const room = scene.getBoundingClientRect();
          const cs = getComputedStyle(sign);
          const innerL = s.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
          const innerR = s.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
          const items = [...sign.querySelectorAll(".cp-sky-item")];
          const range = document.createRange();
          return {
            counts: items.map((li) => li.querySelector(".cp-sky-n").textContent.trim()),
            // The words only: faces without a picture show an initial in the same line.
            labels: items.map((li) => [...li.querySelectorAll(".cp-sky-long, .cp-sky-brief")].filter(shown).map((el) => el.textContent.trim()).join(" ")),
            dots: items.map((li) => (li.classList.contains("is-on") ? "green" : "grey")),
            faces: [...sign.querySelectorAll(".cp-sky-face")].filter(shown).length,
            more: [...sign.querySelectorAll(".cp-sky-more")].filter(shown).map((el) => el.textContent.trim()),
            // Its width inside the padding: what it shows grows with this (coop-play.css).
            inner: innerR - innerL,
            readOut: scene.closest("[aria-hidden='true']") === null,
            inRoom: s.top >= room.top && s.bottom <= room.bottom && s.left >= room.left - 0.5 && s.right <= room.right + 0.5,
            // Nothing that stands on the floor reaches up behind the sign.
            clear: [...scene.querySelectorAll(".cp-scene-floor > *")].every((el) => el.getBoundingClientRect().top >= s.bottom),
            spill: [...sign.querySelectorAll(".cp-sky-list *")].filter((el) => {
              if (!shown(el)) return false;
              const r = el.getBoundingClientRect();
              const innerT = s.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
              const innerB = s.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
              return r.right > innerR + 0.01 || r.left < innerL - 0.01 || r.top < innerT - 0.01 || r.bottom > innerB + 0.01;
            }).length,
            // The title tab overlaps the plate's top edge, never a number.
            tabClear: Math.min(...items.map((li) => li.querySelector(".cp-sky-n").getBoundingClientRect().top)) - sign.querySelector(".cp-sky-title").getBoundingClientRect().bottom,
            // All three numbers stand on one line, each centred over its label.
            level: (() => {
              const ns = items.map((li) => li.querySelector(".cp-sky-n").getBoundingClientRect());
              const off = items.map((li, i) => Math.abs((ns[i].left + ns[i].right) / 2 - (li.querySelector(".cp-sky-label").getBoundingClientRect().left + li.querySelector(".cp-sky-label").getBoundingClientRect().right) / 2));
              return { tops: Math.max(...ns.map((r) => r.top)) - Math.min(...ns.map((r) => r.top)), centre: Math.max(...off) };
            })(),
            // Drawn text against its item's box, in fractions of a pixel (a 0.3px cut is invisible to scrollWidth).
            cut: items.filter((li) => {
              const right = li.getBoundingClientRect().right - parseFloat(getComputedStyle(li).paddingRight);
              return [...li.querySelectorAll(".cp-sky-label, .cp-sky-count")].some((part) => { range.selectNodeContents(part); return range.getBoundingClientRect().right > right + 0.01; });
            }).length,
            smallText: [...sign.querySelectorAll("*")].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 11).length,
          };
        });
        const below = () => p.evaluate(async () => {
          const root = document.querySelector("#coop-play-root");
          await Promise.all([...root.querySelectorAll(".cp-more img")].map((img) => img.decode().catch(() => {})));
          const wide = (sel) => [...root.querySelectorAll(sel)].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5 || el.getBoundingClientRect().left < -0.5).length;
          const card = root.querySelector(".cp-card").getBoundingClientRect();
          const more = root.querySelector(".cp-more")?.getBoundingClientRect();
          return {
            now: [...root.querySelectorAll(".cp-now-item")].map((li) => li.innerText.replace(/\s+/g, " ").trim()),
            dots: [...root.querySelectorAll(".cp-now-item")].map((li) => (li.querySelector(".cp-live-dot") ? (li.classList.contains("is-on") ? "green" : "grey") : "none")),
            post: [...root.querySelectorAll(".cp-bring .cp-post-line")].map((el) => el.innerText.replace(/\s+/g, " ").trim()),
            art: root.querySelector(".cp-post-art")?.naturalWidth ?? 0,
            bringButtons: [...root.querySelectorAll(".cp-bring .cp-btn")].map((b) => ({ text: b.innerText.trim(), height: Math.round(b.getBoundingClientRect().height) })),
            climbs: root.querySelector(".cp-climbs")?.innerText.replace(/\s+/g, " ").trim() ?? null,
            solo: !!root.querySelector(".cp-more--solo"),
            belowCard: more ? more.top >= card.bottom - 0.5 : null,
            sameEdges: more ? Math.abs(more.left - card.left) < 1 && Math.abs(more.right - card.right) < 1 : null,
            outside: wide(".cp-more, .cp-panel, .cp-post, .cp-now, .cp-stats, .cp-recent-row, .cp-btn"),
            cut: [...root.querySelectorAll(".cp-post-line, .cp-panel-title, .cp-result, .cp-stat dd, .cp-best-head, .cp-climbs-note p")].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
            example: !!root.querySelector(".cp-climbs.is-example .cp-example-tag"),
            noteButton: (() => { const b = root.querySelector(".cp-climbs-note .cp-btn"); return b ? { text: b.innerText.trim(), height: Math.round(b.getBoundingClientRect().height) } : null; })(),
            stats: [...root.querySelectorAll(".cp-climbs .cp-stat dd")].map((dd) => dd.textContent.trim()),
            sprites: [...root.querySelectorAll(".cp-climbs .cp-recent-row .cp-mini")].filter((img) => img.tagName !== "IMG" || img.naturalWidth > 0).length,
            roomFigures: root.querySelectorAll(".cp-climbs .cp-best .cp-scene .cp-climber").length,
            // Side by side, the two panels end on one line and are filled to their feet.
            panels: (() => {
              const bring = root.querySelector(".cp-bring"), climbs = root.querySelector(".cp-climbs");
              if (!bring || !climbs) return null;
              const b = bring.getBoundingClientRect(), c = climbs.getBoundingClientRect();
              const foot = (panel) => {
                const last = panel.lastElementChild.getBoundingClientRect();
                return Math.round(panel.getBoundingClientRect().bottom - last.bottom - parseFloat(getComputedStyle(panel).paddingBottom) - parseFloat(getComputedStyle(panel).borderBottomWidth));
              };
              // The widest space between two neighbouring parts of a panel: a hole shows up here.
              const hole = (panel) => { const kids = [...panel.children].map((k) => k.getBoundingClientRect()); return Math.round(Math.max(0, ...kids.slice(1).map((k, i) => k.top - kids[i].bottom))); };
              return { sideBySide: Math.abs(b.top - c.top) < 1, bottoms: Math.abs(b.bottom - c.bottom), bringGap: foot(bring), climbsGap: foot(climbs), bringHole: hole(bring), climbsHole: hole(climbs), room: Math.round(climbs.querySelector(".cp-best .cp-scene").getBoundingClientRect().height) };
            })(),
            sideways: document.documentElement.scrollWidth > window.innerWidth,
            // Text that is actually drawn (a hidden avatar chip has no boxes).
            smallText: [...root.querySelectorAll(".cp-more *")].filter((el) => el.children.length === 0 && el.textContent.trim() && el.getClientRects().length > 0 && parseFloat(getComputedStyle(el).fontSize) < 11).length,
          };
        });

        await coopCard(p, "idle");
        // The roster arrives on its own poll; the sign redraws when it does.
        await p.waitForFunction(() => document.querySelector("#coop-play-root .cp-card .cp-sky .cp-sky-faces"), null, { timeout: 8000 });
        const idle = await below();
        const idleSky = await sky();
        assert.deepEqual(idle.now, [], "before a match the counts are in the room's sky, not under the card");
        assert.ok(idleSky, "the room has the sign in its sky");
        assert.deepEqual(idleSky.counts, ["1", "0", "5"], "you are not counted among the players in STS2");
        assert.deepEqual(idleSky.labels, idleSky.inner >= 520 ? ["looking on Stable", "in a party", "in Slay the Spire 2"] : ["looking", "in a party", "in STS2"]);
        assert.deepEqual(idleSky.dots, ["green", "grey", "green"], "every count has the same dot: green when someone is there, grey at zero");
        assert.deepEqual([idleSky.faces, idleSky.more], idleSky.inner >= 320 ? [4, ["+1"]] : idleSky.inner >= 270 ? [2, ["+3"]] : [0, []], `four faces, two in a narrower sign, none in the narrowest, then the rest as +N (${idleSky.inner.toFixed(1)}px inside)`);
        assert.equal(idleSky.readOut, true, "the sign is read out; the rest of the room stays a picture");
        assert.equal(idleSky.inRoom, true, "the sign stays inside the room");
        assert.equal(idleSky.clear, true, "no figure or seat stands behind the sign");
        assert.ok(idleSky.tabClear >= 2, `the Right now tab stays clear of the numbers (${idleSky.tabClear.toFixed(1)}px)`);
        assert.ok(idleSky.level.tops <= 0.5 && idleSky.level.centre <= 1, `the three numbers stand level, each centred over its label (tops off by ${idleSky.level.tops.toFixed(2)}px, centres by ${idleSky.level.centre.toFixed(2)}px)`);
        assert.deepEqual([idleSky.spill, idleSky.cut, idleSky.smallText], [0, 0, 0], "nothing spills out of the sign, no label is cut, no text under 11px");
        assert.deepEqual(idle.post, [
          "Slay the Spire 2 co-op · who's up for a run?",
          `${TEST_SESSION.personaName} wants to climb · Any climber · Stable version · up to 4 in a party`,
          "Tap Play to get matched: https://app.spirevault.app/coop?branch=stable",
        ]);
        assert.ok(idle.art > 0, "the link card's picture loaded");
        assert.deepEqual(idle.bringButtons.map((b) => b.text), ["Share to Discord", "Copy link"]);
        assert.ok(idle.bringButtons.every((b) => b.height >= 44), `buttons are tappable (${idle.bringButtons.map((b) => b.height).join(", ")}px)`);
        assert.match(idle.climbs, /Your co-op climbs/);
        assert.equal(idle.example, true, "with no co-op runs the panel is tagged Example");
        assert.match(idle.climbs, /This is an example\. Import your saves to see your own co-op runs here\./, "only the sample runs are loaded");
        assert.equal(idle.noteButton?.text, "Import saves");
        assert.ok(idle.noteButton.height >= 44, `the note's button is tappable (${idle.noteButton.height}px)`);
        assert.deepEqual(idle.stats, ["12", "5", "42%", "51"], "the example's numbers: 5 wins in 12 runs is 42%");
        assert.equal(idle.sprites, 7, "every climber in the example's runs is drawn");
        assert.equal(idle.roomFigures, 2, "the example's best party stands in the room");
        if (width >= 1024) {
          assert.equal(idle.panels.sideBySide, true);
          assert.ok(idle.panels.bottoms <= 1, `the two panels end on one line (off by ${idle.panels.bottoms}px)`);
          assert.ok(Math.abs(idle.panels.bringGap) <= 1 && Math.abs(idle.panels.climbsGap) <= 1, `both are filled to the foot (gaps ${idle.panels.bringGap}px and ${idle.panels.climbsGap}px)`);
          assert.ok(idle.panels.bringHole <= 20 && idle.panels.climbsHole <= 20, `neither panel has an empty stretch inside (${idle.panels.bringHole}px and ${idle.panels.climbsHole}px between parts)`);
        } else {
          assert.equal(idle.panels.sideBySide, false, "on a phone the panels stack");
        }
        for (const [name, s] of [["idle", idle]]) {
          assert.equal(s.belowCard, true, `${name}: the section starts under the card`);
          assert.equal(s.sameEdges, true, `${name}: it lines up with the card's edges`);
          assert.equal(s.outside, 0, `${name}: nothing sticks out of the page`);
          assert.equal(s.cut, 0, `${name}: no clipped text`);
          assert.equal(s.sideways, false, `${name}: no sideways scroll`);
          assert.equal(s.smallText, 0, `${name}: no text under 11px`);
        }

        server.view = coopView("searching");
        await coopCard(p, "searching");
        const looking = await below();
        const lookingSky = await sky();
        assert.equal(looking.post[1], `${TEST_SESSION.personaName} is waiting · Silent · Stable version · 3 seats open`);
        assert.deepEqual([looking.outside, looking.cut, looking.sideways], [0, 0, false], "while looking");
        assert.deepEqual(looking.now, [], "while looking the counts stay in the room's sky");
        assert.deepEqual(lookingSky?.counts, ["1", "0", "5"]);
        assert.deepEqual([lookingSky.inRoom, lookingSky.clear, lookingSky.spill, lookingSky.cut], [true, true, 0, 0], "while looking the sign fits too");

        server.view = coopView("host");
        await coopCard(p, "matched");
        const partyState = await below();
        assert.equal(partyState.post[0], "Slay the Spire 2 co-op · 2 seats open");
        assert.deepEqual(partyState.now, ["0 looking on Stable", "0 looking on Beta", "2 players in a party"], "in a party the counts are back under the card");
        assert.deepEqual(partyState.dots, ["grey", "grey", "green"]);
        assert.equal(await sky(), null, "a party's room has no sign: the party fills it");
        assert.deepEqual([partyState.outside, partyState.cut, partyState.sideways], [0, 0, false], "in a party");

        server.view = coopView("in_game");
        await coopCard(p, "in_game");
        const started = await below();
        assert.deepEqual(started.post, [], "no invite once the run is under way");
        assert.equal(started.solo, true);
        assert.match(started.climbs, /Your co-op climbs/);
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // The Play card: one left axis, the ping row on one centre line, and the
  // seats standing in the middle of the room in every state.
  const coopParty = (size) => {
    const view = coopView("host");
    const extra = [
      { sid: "76561198000000003", name: "Mako", character: "defect" },
      { sid: "76561198000000004", name: "IAmWeirdAndLong", character: "necrobinder" },
    ].slice(0, size - 2);
    view.match.members = [...view.match.members, ...extra.map((m) => ({ ...m, isHost: false, isYou: false, steamAdded: false, status: "joined" }))];
    view.match.seatsLeft = 4 - size;
    return view;
  };
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1728, 1440, 390, 320]) {
      await check(`co-op (${label}, ${width}px): the Play card's controls share one left edge, the ping row one centre line, and the seats stand in the middle of the room`, async () => {
        const server = coopServer("idle");
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 1000 },
        });
        const room = () => p.evaluate(async () => {
          const scene = document.querySelector("#coop-play-root .cp-card .cp-scene");
          await Promise.all([...scene.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
          const frame = scene.getBoundingClientRect(), border = parseFloat(getComputedStyle(scene).borderLeftWidth);
          const items = [...scene.querySelectorAll(".cp-scene-floor > *")].map((el) => el.getBoundingClientRect());
          const tags = [...scene.querySelectorAll(".cp-tag")].map((el) => el.getBoundingClientRect());
          return {
            left: items[0].left - frame.left - border, right: frame.right - border - items[items.length - 1].right, items: items.length,
            tagsInside: tags.every((t) => t.left >= frame.left + 6 && t.right <= frame.right - 6),
          };
        });
        await coopCard(p, "idle");
        const card = await p.evaluate(() => {
          const root = document.querySelector("#coop-play-root");
          const box = (sel) => root.querySelector(sel).getBoundingClientRect();
          const words = (sel) => { const range = document.createRange(); range.selectNodeContents(root.querySelector(sel)); return range.getBoundingClientRect(); };
          const mid = (r) => r.top + r.height / 2;
          const lefts = { label: words("#cp-branch-label").left, pickLabel: words("#cp-pick-label").left, climbers: box(".cp-pick").left, version: box(".cp-branch").left, play: box(".cp-play").left, toggle: box(".cp-ping-switch").left };
          const gaps = {
            labelToClimbers: box(".cp-pick").top - box("#cp-pick-label").bottom, labelToVersion: box(".cp-branch").top - box("#cp-branch-label").bottom,
            climbersToVersion: box("#cp-branch-label").top - box(".cp-pick").bottom, versionToPlay: box(".cp-play").top - box(".cp-branch").bottom, playToPing: box(".cp-ping").top - box(".cp-play").bottom,
          };
          return { lefts, gaps, ping: { toggle: mid(box(".cp-ping-switch")), bell: mid(box(".cp-ping-text svg")), words: mid(box(".cp-ping-text > span")) } };
        });
        const lefts = Object.values(card.lefts);
        assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, `one left edge (${JSON.stringify(card.lefts)})`);
        assert.ok(Math.abs(card.gaps.labelToClimbers - card.gaps.labelToVersion) <= 1, "a label sits the same distance above its control");
        const between = [card.gaps.climbersToVersion, card.gaps.versionToPlay, card.gaps.playToPing];
        assert.ok(Math.max(...between) - Math.min(...between) <= 1, `one gap between the groups (${between.map((g) => Math.round(g)).join(", ")}px)`);
        assert.ok(Math.abs(card.ping.bell - card.ping.toggle) <= 1 && Math.abs(card.ping.words - card.ping.toggle) <= 1, `toggle, bell and words share a centre line (${JSON.stringify(card.ping)})`);

        for (const [name, state, view] of [["idle", "idle", coopView("idle")], ["looking", "searching", coopView("searching")], ["party of 2", "matched", coopParty(2)], ["party of 3", "matched", coopParty(3)], ["party of 4", "matched", coopParty(4)]]) {
          server.view = view;
          await coopCard(p, state);
          await p.waitForTimeout(200);
          const r = await room();
          assert.equal(r.items, 4, `${name}: four places in the room`);
          assert.ok(Math.abs(r.left - r.right) <= 2, `${name}: as much bare ground left as right (${r.left.toFixed(1)}px and ${r.right.toFixed(1)}px)`);
          assert.equal(r.tagsInside, true, `${name}: name tags stay inside the room`);
        }
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // Pings on every device (2026-11-18). With pings reaching you somewhere,
  // the card offers how long to keep looking after you step away and lists
  // the devices that get pings. Both follow the card's one left edge and one
  // gap between groups; a device's name is never broken across lines; the
  // choice reaches the server with Play; the looking card says how long it
  // keeps going; and the party says who is on the way.
  const COOP_DEVICES = [
    { id: "a1".repeat(8), kind: "webpush", label: "Chrome on Mac", createdAt: COOP_T0, lastSeenAt: COOP_T0 },
    { id: "b2".repeat(8), kind: "webpush", label: "Safari on iPhone", createdAt: COOP_T0, lastSeenAt: COOP_T0 },
  ];
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1728, 1440, 390, 320]) {
      await check(`co-op (${label}, ${width}px): with pings on, the keep-looking choice and the device list line up, names stay whole, and the choice reaches Play`, async () => {
        const answer = { view: coopView("idle", { pushOn: true }), posts: [] };
        const route = ["**/api/coop/play**", async (r) => {
          const req = r.request();
          if (new URL(req.url()).pathname.endsWith("/devices")) {
            return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, devices: COOP_DEVICES }) });
          }
          if (req.method() === "POST") answer.posts.push(req.postDataJSON());
          return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer.view) });
        }];
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [route], viewport: { width, height: width < 600 ? 844 : 1000 },
        });
        await coopCard(p, "idle");
        await p.waitForSelector("#coop-play-root .cp-devices", { timeout: 8000 });
        await p.click("#coop-play-root .cp-devices summary");
        const card = await p.evaluate(() => {
          const root = document.querySelector("#coop-play-root .cp-card");
          const box = (sel) => root.querySelector(sel).getBoundingClientRect();
          const cardBox = root.getBoundingClientRect();
          const opts = [...root.querySelectorAll(".cp-stay-opt")].map((o) => ({ top: Math.round(o.getBoundingClientRect().top), h: o.getBoundingClientRect().height, on: o.getAttribute("aria-checked") }));
          const lines = (el) => { const range = document.createRange(); range.selectNodeContents(el); return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size; };
          const inside = [...root.querySelectorAll(".cp-device, .cp-device-remove, .cp-stay")].every((el) => { const r = el.getBoundingClientRect(); return r.left >= cardBox.left - 0.5 && r.right <= cardBox.right + 0.5; });
          return {
            lefts: { version: box(".cp-branch:not(.cp-stay)").left, stayLabel: box("#cp-stay-label").left, stay: box(".cp-stay").left, devices: box(".cp-devices").left },
            gaps: { versionToPlay: box(".cp-play").top - box(".cp-branch:not(.cp-stay)").bottom, pingToStay: box(".cp-field--stay").top - box(".cp-ping").bottom, stayToDevices: box(".cp-devices").top - box(".cp-field--stay").bottom },
            opts, inside,
            nameLines: [...root.querySelectorAll(".cp-device-name")].map(lines),
            removes: [...root.querySelectorAll(".cp-device-remove")].map((b) => b.getBoundingClientRect().height),
            summary: root.querySelector(".cp-devices summary").textContent.trim(),
            sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        });
        const lefts = Object.values(card.lefts);
        assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 1, `one left edge (${JSON.stringify(card.lefts)})`);
        assert.ok(Math.abs(card.gaps.pingToStay - card.gaps.versionToPlay) <= 1 && Math.abs(card.gaps.stayToDevices - card.gaps.versionToPlay) <= 1, `one gap between groups (${JSON.stringify(card.gaps)})`);
        assert.equal(card.opts.length, 3);
        assert.equal(new Set(card.opts.map((o) => o.top)).size, 1, "30 min, 1 hour and 2 hours stand on one line");
        assert.ok(card.opts.every((o) => o.h >= 43.5) && card.removes.every((h) => h >= 43.5), "44px tap targets");
        assert.deepEqual(card.opts.map((o) => o.on), ["false", "true", "false"], "an hour by default");
        assert.deepEqual(card.nameLines, [1, 1], "each device name on one line");
        assert.equal(card.inside, true, "the controls stay inside the card");
        assert.equal(card.sideways, false, "the page scrolls sideways");
        assert.equal(card.summary, "Pings go to Chrome on Mac and Safari on iPhone");

        await p.click('#coop-play-root [data-cp-stay="120"]');
        await p.click('#coop-play-root [data-cp="play"]');
        for (let i = 0; i < 30 && answer.posts.length === 0; i++) await p.waitForTimeout(100);
        assert.equal(answer.posts.at(-1)?.stay, 120, `Play sends the choice (${JSON.stringify(answer.posts.at(-1))})`);

        answer.view = coopView("searching", { pushOn: true, ticket: { createdAt: Date.now() - 42000, character: "silent", branch: "stable", push: true, stayMs: 7_200_000 } });
        await coopCard(p, "searching");
        const hint = await p.$eval("#coop-play-root .cp-hint", (el) => el.textContent);
        assert.match(hint, /two hours after you leave it/);
        assert.equal(await p.$('#coop-play-root [data-cp="ping-on"]'), null, "no 'Ping me instead' when pings already reach you");

        const party = coopView("host", { pushOn: true });
        party.match.members = party.match.members.map((m) => (m.isYou ? m : { ...m, coming: true }));
        answer.view = party;
        await coopCard(p, "matched");
        assert.equal(await p.$eval("#coop-play-root .cp-coming", (el) => el.textContent.trim()), "Boble is on the way.");
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // The Nov 16 UI audit. A name is never cut where there is room for it: in
  // the Play card's room, in the "Most wins together" room (two climbers
  // standing close) and in the climber picker on either game version. Widths
  // are compared in fractions of a pixel, because a tag 0.3px narrower than
  // its name is enough for the browser to draw "Ma…". Also: the recent runs
  // share one left edge, the room fills the card beside a taller left column,
  // the version switch is a 44px target, an empty seat hides the props behind
  // it, and classic has no empty bar above the card.
  const duo = () => {
    const view = coopView("host");
    view.match.members = [
      { sid: COOP_ME, name: "Mako", character: "silent", isHost: true, isYou: true, steamAdded: false, status: "joined" },
      { sid: COOP_MATE, name: "Bo", character: "ironclad", isHost: false, isYou: false, steamAdded: false, status: "joined" },
    ];
    return view;
  };
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1920, 1440, 1280, 1180, 768, 390]) {
      await check(`co-op (${label}, ${width}px): no name is cut where there is room, recent runs line up, the room fills the card`, async () => {
        const server = coopServer("idle");
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 1000 },
        });
        const measure = () => p.evaluate(async () => {
          const root = document.querySelector("#coop-play-root");
          await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
          await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
          const box = (el) => el.getBoundingClientRect();
          const words = (el) => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect(); };
          // Short of its own text by more than a twentieth of a pixel: the browser draws an ellipsis.
          const cutBy = (el) => { const pad = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight); return Math.max(0, words(el).width - (box(el).width - pad)); };
          const rooms = [...root.querySelectorAll(".cp-scene")].map((scene) => {
            const frame = box(scene);
            const tags = [...scene.querySelectorAll(".cp-climber > .cp-tag")].map((tag) => {
              const name = tag.querySelector(".cp-tag-name"), r = box(tag);
              return { name: name.textContent, cutBy: cutBy(name), left: r.left - frame.left, right: frame.right - r.right, top: r.top, width: r.width };
            });
            return { where: scene.closest(".cp-best") ? "most wins together" : "the Play card", tags };
          });
          const card = root.querySelector(".cp-card"), main = root.querySelector(".cp-main"), side = root.querySelector(".cp-side"), scene = side?.querySelector(".cp-scene");
          const beside = !!main && !!side && box(side).left >= box(main).right - 1;
          const inner = card ? box(card).bottom - parseFloat(getComputedStyle(card).paddingBottom) - parseFloat(getComputedStyle(card).borderBottomWidth) : 0;
          const seat = root.querySelector(".cp-card .cp-seat");
          const head = document.querySelector('.tab-panel[data-tab="coop"] > .panel-head');
          const headStyle = getComputedStyle(head);
          return {
            rooms,
            pickCut: [...root.querySelectorAll(".cp-pick-name")].filter((n) => cutBy(n) > 0.05 || n.scrollWidth > n.clientWidth).map((n) => n.textContent),
            pickSmall: [...root.querySelectorAll(".cp-pick-name")].filter((n) => parseFloat(getComputedStyle(n).fontSize) < 11).length,
            rows: [...root.querySelectorAll(".cp-recent-row")].map((row) => ({ names: words(row.querySelector(".cp-recent-names")).left, meta: words(row.querySelector(".cp-recent-meta")).left })),
            hero: beside ? { emptyUnderRoomSide: inner - box(side.lastElementChild).bottom, room: [box(scene).width, box(scene).height] } : null,
            switch: [...root.querySelectorAll(".cp-branch-opt")].map((b) => Math.round(box(b).height)),
            seatFill: seat ? Number((getComputedStyle(seat).backgroundColor.match(/rgba?\([^)]*?,\s*([\d.]+)\)$/) ?? [])[1] ?? 1) : null,
            head: { height: box(head).height, position: headStyle.position, rule: parseFloat(headStyle.borderBottomWidth) },
            sideways: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        const wholeNames = (m, when) => {
          for (const room of m.rooms) {
            assert.deepEqual(room.tags.filter((t) => t.cutBy > 0.05).map((t) => `${t.name} (short by ${t.cutBy.toFixed(2)}px)`), [], `${when}: every name in ${room.where} is whole`);
            for (const t of room.tags) assert.ok(t.left >= 7.5 && t.right >= 7.5, `${when}: ${t.name} stays 8px inside ${room.where} (${t.left.toFixed(1)} / ${t.right.toFixed(1)})`);
            for (const [i, t] of room.tags.entries()) {
              const next = room.tags.slice(i + 1).find((u) => Math.abs(u.top - t.top) < 3);
              if (next) assert.ok(next.left - (t.left + t.width) >= 7.5, `${when}: ${t.name} and ${next.name} keep an 8px gap in ${room.where}`);
            }
          }
        };

        await coopCard(p, "idle");
        const idle = await measure();
        assert.equal(idle.rooms.length, 2, "the Play card's room and the example's room");
        wholeNames(idle, "idle");
        assert.deepEqual(idle.pickCut, [], "every climber's name in the picker is whole");
        assert.equal(idle.pickSmall, 0, "and none is drawn under 11px");
        const edges = (key) => idle.rows.map((r) => r[key]);
        assert.equal(idle.rows.length, 3);
        assert.ok(Math.max(...edges("names")) - Math.min(...edges("names")) <= 0.5, `recent runs start their names on one left edge (${edges("names").map((x) => x.toFixed(1)).join(", ")})`);
        assert.ok(Math.max(...edges("meta")) - Math.min(...edges("meta")) <= 0.5, `and their second lines too (${edges("meta").map((x) => x.toFixed(1)).join(", ")})`);
        if (idle.hero) {
          assert.ok(Math.abs(idle.hero.emptyUnderRoomSide) <= 1, `the room's column reaches the foot of the card (${idle.hero.emptyUnderRoomSide.toFixed(1)}px left empty)`);
          assert.ok(idle.hero.room[1] >= idle.hero.room[0] / 2 - 1, `the room is never flatter than 2:1 (${idle.hero.room.map(Math.round).join("x")})`);
        } else {
          assert.ok(width < 1100, "from a laptop up the room stands beside the controls");
        }
        assert.ok(idle.switch.length === 2 && idle.switch.every((h) => h >= 44), `Stable and Beta branch are 44px targets (${idle.switch.join(", ")}px)`);
        assert.ok(idle.seatFill >= 0.5, `an empty seat is dark enough to hide what stands behind it (fill ${idle.seatFill})`);
        if (label === "classic") {
          assert.ok(idle.head.height <= 1 && idle.head.rule === 0 && idle.head.position !== "sticky", `no empty bar above the card (${JSON.stringify(idle.head)})`);
        }
        assert.equal(idle.sideways, false);

        // Seven tiles on the beta branch.
        await p.click('[data-cp-branch="beta"]');
        await p.waitForSelector('.cp-pick[data-cp-n="7"]');
        const beta = await measure();
        assert.deepEqual(beta.pickCut, [], "beta branch: every climber's name in the picker is whole");
        assert.equal(beta.sideways, false);

        // A four-letter name of your own, in a party of two.
        server.view = duo();
        await coopCard(p, "matched");
        wholeNames(await measure(), "party of two");

        // A name that outgrows its measurement afterwards (a web font landing
        // late does this) must widen its tag while there is room, not get cut.
        server.view = coopView("idle");
        await coopCard(p, "idle");
        await measure();
        await p.evaluate(() => {
          for (const name of document.querySelectorAll("#coop-play-root .cp-tag-name")) name.style.letterSpacing = "0.5px";
        });
        const grown = await measure();
        for (const room of grown.rooms) {
          assert.deepEqual(room.tags.filter((t) => t.cutBy > 0.05).map((t) => t.name), [], `a name that grows after the fit stays whole in ${room.where}`);
        }
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // Names stand under the figures, not over their heads (owner, 2026-11-18:
  // "the names of the players need to be below the cut out not on top").
  // Every tag starts below its own figure's feet and ends inside the room, in
  // each state that seats someone and at the phone widths where a full
  // party's tags stack in two rows. The host's crown floats over the host's
  // head, inside the room, and the tag holds nothing but the name (a crown in
  // the tag cut "c3rooks" short on a 320px phone).
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1440, 390, 320]) {
      await check(`co-op (${label}, ${width}px): every name stands under its figure, inside the room`, async () => {
        const server = coopServer("idle");
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 1000 },
        });
        const rooms = () => p.evaluate(async () => {
          const root = document.querySelector("#coop-play-root");
          const settled = (img) => Promise.race([img.decode().catch(() => {}), new Promise((ok) => setTimeout(ok, 3000))]);
          await Promise.all([...root.querySelectorAll(".cp-scene img")].map(settled));
          await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
          return [...root.querySelectorAll(".cp-scene")].map((scene) => {
            const frame = scene.getBoundingClientRect(), border = parseFloat(getComputedStyle(scene).borderBottomWidth);
            return {
              where: scene.closest(".cp-best") ? "most wins together" : "the Play card",
              stacked: scene.classList.contains("is-stacked"),
              rows: new Set([...scene.querySelectorAll(".cp-climber > .cp-tag")].map((tag) => Math.round(tag.getBoundingClientRect().top))).size,
              tags: [...scene.querySelectorAll(".cp-climber")].map((climber) => {
                const art = climber.querySelector(".cp-climber-art").getBoundingClientRect();
                const tag = climber.querySelector(".cp-tag").getBoundingClientRect();
                const figure = climber.querySelector(".cp-figure-img, .cp-figure-blank").getBoundingClientRect();
                const crown = climber.querySelector(".cp-crown svg")?.getBoundingClientRect();
                const nameEl = climber.querySelector(".cp-tag-name"), words = document.createRange();
                words.selectNodeContents(nameEl);
                return {
                  name: nameEl.textContent,
                  host: climber.classList.contains("is-host"),
                  underFeet: tag.top - art.bottom,
                  toFloor: frame.bottom - border - tag.bottom,
                  cutBy: Math.max(0, words.getBoundingClientRect().width - nameEl.getBoundingClientRect().width),
                  crownInTag: climber.querySelectorAll(".cp-tag svg").length,
                  crown: crown ? { overHead: figure.top - crown.bottom, toCeiling: crown.top - frame.top - border, across: (crown.left + crown.width / 2 - figure.left) / figure.width } : null,
                };
              }),
            };
          });
        });
        // A host who picked "Any climber" stands as a blank figure and still wears the crown.
        const blankHost = () => {
          const view = coopParty(2);
          view.match.members = view.match.members.map((m) => (m.isHost ? { ...m, character: undefined } : m));
          return view;
        };
        const states = [
          ["idle", "idle", coopView("idle")], ["looking", "searching", coopView("searching")], ["party of 2", "matched", coopParty(2)],
          ["party of 4", "matched", coopParty(4)], ["party of 2 after a full party", "matched", coopParty(2)], ["host on any climber", "matched", blankHost()],
        ];
        for (const [name, state, view] of states) {
          server.view = view;
          await coopCard(p, state);
          await p.waitForTimeout(250);
          const found = await rooms();
          assert.ok(found.length >= 1 && found[0].tags.length >= 1, `${name}: the Play card's room has a name in it`);
          // The two-row path is real on the narrowest phone, and a smaller party goes back to one row.
          if (name === "party of 4" && width === 320) {
            assert.ok(found[0].stacked && found[0].rows === 2, `${name}: a full party's names stand in two rows here (stacked ${found[0].stacked}, ${found[0].rows} rows)`);
          }
          if (name === "party of 2 after a full party") {
            assert.ok(!found[0].stacked && found[0].rows === 1, `${name}: back to one row (stacked ${found[0].stacked}, ${found[0].rows} rows)`);
          }
          if (name === "host on any climber") {
            assert.equal(found[0].tags.filter((t) => t.host && t.crown).length, 1, `${name}: the blank host wears the crown`);
          }
          for (const room of found) {
            for (const t of room.tags) {
              assert.ok(t.underFeet >= 2, `${name}: ${t.name} starts under its figure in ${room.where} (${t.underFeet.toFixed(1)}px below the feet)`);
              assert.ok(t.toFloor >= 4, `${name}: ${t.name} ends inside ${room.where} (${t.toFloor.toFixed(1)}px above the room's foot)`);
              assert.equal(t.crownInTag, 0, `${name}: ${t.name}'s tag holds the name only`);
              assert.equal(Boolean(t.crown), t.host, `${name}: only the host wears the crown (${t.name})`);
              if (t.crown) {
                assert.ok(t.crown.overHead >= 0 && t.crown.overHead <= 6, `${name}: the crown floats just over ${t.name}'s head (${t.crown.overHead.toFixed(1)}px)`);
                assert.ok(t.crown.toCeiling >= 2, `${name}: the crown is inside ${room.where} (${t.crown.toCeiling.toFixed(1)}px under the frame)`);
                assert.ok(t.crown.across >= 0.2 && t.crown.across <= 0.8, `${name}: the crown is over ${t.name}'s figure (${t.crown.across.toFixed(2)} across)`);
              }
            }
          }
          // From a 390px phone up, a party of two has room for both names whole.
          if (name === "party of 2" && width >= 390) {
            assert.deepEqual(found[0].tags.filter((t) => t.cutBy > 0.05).map((t) => t.name), [], `${name}: both names are whole`);
          }
        }
        // Text set half as large again by the reader: a tag is taller than the
        // stylesheet's figure, so the floor's band is sized from the tag itself.
        await p.evaluate(() => { document.documentElement.style.fontSize = "150%"; });
        server.view = coopParty(4);
        await coopCard(p, "matched");
        await p.waitForTimeout(250);
        for (const room of await rooms()) {
          for (const t of room.tags) {
            assert.ok(t.underFeet >= 2 && t.toFloor >= 4, `larger text: ${t.name} still stands under its figure and inside ${room.where} (${t.underFeet.toFixed(1)}px under the feet, ${t.toFloor.toFixed(1)}px above the room's foot)`);
          }
        }
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  // The tags are sized by script, so they are sized again whenever a font
  // finishes loading: a face that lands after the first fit changes every
  // name's width without changing the size of anything the page watches.
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    await check(`co-op (${label}): name tags are fitted again when a font arrives late`, async () => {
      const server = coopServer("idle");
      server.view = duo();
      const { context, page: p, errors } = await open(browser, path, { signedIn: true, routes: [server.route] });
      await coopCard(p, "matched");
      await p.waitForTimeout(250);
      const tags = () => p.evaluate(() => [...document.querySelectorAll("#coop-play-root .cp-card .cp-tag")].map((tag) => {
        const name = tag.querySelector(".cp-tag-name"), range = document.createRange();
        range.selectNodeContents(name);
        return { name: name.textContent, width: tag.getBoundingClientRect().width, cutBy: Math.max(0, range.getBoundingClientRect().width - name.getBoundingClientRect().width) };
      }));
      const before = await tags();
      assert.equal(before.length, 2);
      // A wider face for the tags only, so nothing else on the page moves.
      await p.evaluate(async () => {
        const face = new FontFace("Late Face", 'url("/assets/fonts/figtree-latin-var-v1.woff2?late=1") format("woff2")', { weight: "100 900", sizeAdjust: "130%" });
        document.fonts.add(face);
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('#coop-play-root .cp-tag { font-family: "Late Face", system-ui, sans-serif; }');
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        await face.loaded;
        await document.fonts.ready;
      });
      await p.waitForTimeout(250);
      const after = await tags();
      assert.ok(after[0].width > before[0].width + 2, `the late face is wider (${before[0].width.toFixed(1)}px to ${after[0].width.toFixed(1)}px)`);
      assert.deepEqual(after.filter((t) => t.cutBy > 0.05).map((t) => t.name), [], "no name is cut after the font lands");
      assert.ok(Math.abs(after[0].width - after[1].width) <= 0.5, `the party still shares one tag width (${after.map((t) => t.width.toFixed(1)).join(", ")})`);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }

  // In a party the three steps stand side by side under the heading and the
  // room, so the card has no empty column under the room. On a phone they
  // stay stacked under the room. Checked as the host of a full party (three
  // Add buttons, one for the longest Steam name there can be) and as a joiner.
  const longNameParty = () => {
    const view = coopView("host");
    const extra = [
      { sid: "76561198000000003", name: "Mako", character: "defect" },
      { sid: "76561198000000004", name: "W".repeat(32), character: "necrobinder" },
    ];
    view.match.members = [...view.match.members, ...extra.map((m) => ({ ...m, isHost: false, isYou: false, steamAdded: false, status: "joined" }))];
    view.match.seatsLeft = 0;
    return view;
  };
  for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    for (const width of [1920, 1440, 1280, 1180, 768, 390]) {
      await check(`co-op (${label}, ${width}px): in a party the steps stand side by side under the room, with no empty column`, async () => {
        const server = coopServer("idle");
        server.view = longNameParty();
        const { context, page: p, errors } = await open(browser, path, {
          signedIn: true, routes: [server.route], viewport: { width, height: width < 600 ? 844 : 1000 },
        });
        // Measured once fonts and images are in: under load a button measured
        // before its web font arrived read 1-2px short of 44.
        const measure = () => p.evaluate(async () => {
          const root = document.querySelector("#coop-play-root");
          await document.fonts.ready;
          await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
          await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
          const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
          const card = root.querySelector(".cp-card--party"), style = getComputedStyle(card), outer = box(card);
          const inner = {
            left: outer.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
            right: outer.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
            bottom: outer.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth),
          };
          const steps = [...card.querySelectorAll(".cp-step")];
          return {
            inner,
            steps: steps.map(box),
            actions: steps.map((step) => box(step.querySelector(".cp-step-actions")).bottom),
            // Anything in a step that reaches its card's edge or sticks out of it.
            spills: steps.flatMap((step) => {
              const edge = box(step);
              return [...step.querySelectorAll(".cp-btn, .cp-step-text, .cp-step-title, .cp-step-status")]
                .filter((el) => box(el).right > edge.right - 4 || box(el).left < edge.left + 4)
                .map((el) => el.textContent.replace(/\s+/g, " ").trim().slice(0, 24));
            }),
            head: box(card.querySelector(".cp-head")),
            room: box(card.querySelector(".cp-side .cp-scene")),
            help: box(card.querySelector(".cp-help")),
            summary: box(card.querySelector(".cp-help summary")),
            leave: box(card.querySelector('[data-cp="leave"]')),
            smallTargets: [...card.querySelectorAll("button, a.cp-btn")].filter((el) => el.getBoundingClientRect().height < 44).map((el) => `${el.textContent.trim()} (${el.getBoundingClientRect().height.toFixed(1)}px)`),
            sideways: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        const near = (a, b, by = 1) => Math.abs(a - b) <= by;
        const layout = (m, when) => {
          const [one, two, three] = m.steps;
          assert.equal(m.steps.length, 3, `${when}: three steps`);
          if (width >= 1100) {
            assert.ok(near(one.top, two.top) && near(two.top, three.top) && one.left < two.left && two.left < three.left, `${when}: the three steps stand side by side (tops ${m.steps.map((s) => Math.round(s.top)).join(", ")}, lefts ${m.steps.map((s) => Math.round(s.left)).join(", ")})`);
            assert.ok(near(one.bottom, two.bottom) && near(two.bottom, three.bottom), `${when}: and end on one line`);
            assert.ok(near(one.left, m.inner.left) && near(three.right, m.inner.right), `${when}: the row of steps spans the card (${Math.round(one.left)}–${Math.round(three.right)} of ${Math.round(m.inner.left)}–${Math.round(m.inner.right)})`);
            assert.ok(near(two.left - one.right, three.left - two.right), `${when}: with even gaps between them`);
            assert.ok(m.room.left >= m.head.right - 1 && near(m.room.right, m.inner.right), `${when}: the room stands beside the heading`);
            const underRoom = one.top - m.room.bottom;
            assert.ok(underRoom > 0 && underRoom <= 44, `${when}: the steps start right under the room (${Math.round(underRoom)}px below it)`);
            assert.ok(Math.max(...m.actions) - Math.min(...m.actions) <= 1, `${when}: each step's buttons end on one line (${m.actions.map((y) => Math.round(y)).join(", ")})`);
            assert.ok(near(m.help.left, m.inner.left) && near(m.leave.right, m.inner.right), `${when}: help on the left edge, Leave party on the right`);
            assert.ok(near((m.help.top + m.help.bottom) / 2, (m.leave.top + m.leave.bottom) / 2, 1.5), `${when}: on one centre line`);
            assert.ok(m.inner.bottom - Math.max(m.help.bottom, m.leave.bottom) <= 1, `${when}: nothing empty at the foot of the card`);
          } else {
            assert.ok(near(one.left, two.left) && near(two.left, three.left) && one.bottom <= two.top && two.bottom <= three.top, `${when}: on a narrow screen the steps stay stacked`);
            assert.ok(m.room.top >= m.head.bottom - 1 && m.room.bottom <= one.top, `${when}: with the room between the heading and the steps`);
          }
          assert.deepEqual(m.spills, [], `${when}: nothing reaches the edge of its step`);
          assert.ok(m.summary.height >= 44, `${when}: the help line is a 44px target (${Math.round(m.summary.height)}px)`);
          assert.deepEqual(m.smallTargets, [], `${when}: every button is a 44px target`);
          assert.equal(m.sideways, false, `${when}: no sideways scroll`);
        };

        await coopCard(p, "matched");
        await p.waitForTimeout(200);
        layout(await measure(), "host of a full party");

        server.view = coopView("joiner");
        await coopCard(p, "matched");
        await p.waitForTimeout(200);
        layout(await measure(), "joiner");
        assert.deepEqual(errors, []);
        await context.close();
      });
    }
  }

  await check("co-op: the idle invite copies a post that does not claim you are waiting, and Copy link copies the link", async () => {
    const server = coopServer("idle");
    const { context, page: p, errors } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await coopCard(p, "idle");
    await p.click('[data-cp-branch="beta"]');
    await p.click('[data-cp-pick="fool"]');
    assert.match(await p.innerText(".cp-bring .cp-post"), /The Fool · Beta branch/, "the preview follows the picks");
    await p.click('.cp-bring [data-cp="share"]');
    await p.waitForSelector('.cp-bring [data-cp="share"].is-done');
    assert.equal(
      await p.evaluate(() => navigator.clipboard.readText()),
      [
        "**Slay the Spire 2 co-op** · who's up for a run?",
        `${TEST_SESSION.personaName} wants to climb · The Fool · Beta branch · up to 4 in a party`,
        "Tap Play to get matched: https://app.spirevault.app/coop?branch=beta",
      ].join("\n"),
    );
    await p.waitForSelector('.cp-bring [data-cp="share"]:not(.is-done)', { timeout: 6000 });
    const before = await p.evaluate(() => Math.round(document.querySelector('[data-cp="copy-link"]').getBoundingClientRect().width));
    await p.click('[data-cp="copy-link"]');
    await p.waitForSelector('[data-cp="copy-link"].is-done');
    assert.equal((await p.innerText('[data-cp="copy-link"]')).trim(), "Link copied");
    assert.equal(await p.evaluate(() => Math.round(document.querySelector('[data-cp="copy-link"]').getBoundingClientRect().width)), before, "the button keeps its width");
    assert.equal(await p.evaluate(() => navigator.clipboard.readText()), "https://app.spirevault.app/coop?branch=beta");
    assert.match(await p.evaluate(() => document.getElementById("toast")?.textContent ?? ""), /Link copied/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("co-op: your co-op climbs counts runs with a party, from your own saves", async () => {
    const server = coopServer("idle");
    const { context, page: p, errors } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    await coopCard(p, "idle");
    // Loading saves takes the app to Overview (as it always has); come back to Co-op.
    const loadSaves = async (runs) => {
      await p.evaluate((list) => window.SpireVault.ingestDesktopRuns(list), runs);
      await p.waitForFunction(() => window.SpireVault.activeTab() === "overview", null, { timeout: 8000 });
      await p.evaluate(() => window.SpireVault.switchTab("coop"));
    };
    // Both buttons in the note are the app's own: they end at its folder picker.
    await p.evaluate(() => {
      window.__pickerOpened = 0;
      window.showDirectoryPicker = () => { window.__pickerOpened += 1; return Promise.reject(new DOMException("closed", "AbortError")); };
    });
    // Which picker the app opens depends on the browser and the OS: the folder
    // API where the folder can be kept, a folder input elsewhere. Either counts.
    const opensPicker = async (selector) => {
      const before = await p.evaluate(() => window.__pickerOpened);
      const viaInput = p.waitForEvent("filechooser", { timeout: 8000 }).then(() => true, () => false);
      await p.click(selector);
      const viaApi = p.waitForFunction((n) => window.__pickerOpened > n, before, { timeout: 8000 }).then(() => true, () => false);
      return new Promise((resolve) => {
        let pending = 2;
        const settle = (opened) => { if (opened) resolve(true); else if (--pending === 0) resolve(false); };
        viaInput.then(settle);
        viaApi.then(settle);
      });
    };
    assert.equal(await opensPicker('.cp-climbs-note [data-cp="import-saves"]'), true, "Import saves opens the app's save picker");

    await loadSaves(SOLO_SAVES);
    await p.waitForFunction(() => /Your saves have no co-op runs yet/.test(document.querySelector(".cp-climbs-note")?.textContent ?? ""), null, { timeout: 8000 });
    // Compared in the page: assert cannot describe two page handles (Node runs out of memory trying).
    assert.equal(await p.evaluate(() => document.querySelector(".cp-climbs")?.classList.contains("is-example") ?? false), true, "solo saves still show the example, marked as one");
    assert.equal(await opensPicker('.cp-climbs-note [data-cp="refresh-saves"]'), true, "Refresh asks for the save folder again when the browser cannot re-read it");

    await loadSaves(COOP_SAVES);
    await p.waitForSelector(".cp-climbs:not(.is-example) .cp-stats", { timeout: 8000 });
    const shown = await p.evaluate(() => ({
      example: !!document.querySelector(".cp-climbs .cp-example-tag, .cp-climbs .cp-climbs-note"),
      stats: [...document.querySelectorAll(".cp-stat")].map((s) => `${s.querySelector("dt").textContent.trim()}: ${s.querySelector("dd").textContent.trim()}`),
      best: document.querySelector(".cp-best-head")?.innerText.replace(/\s+/g, " ").trim(),
      room: [...document.querySelectorAll(".cp-best .cp-scene .cp-tag-name")].map((t) => t.textContent.trim()),
      recent: [...document.querySelectorAll(".cp-recent-row")].map((row) => ({
        party: row.querySelector(".cp-recent-names").textContent.trim(),
        sprites: row.querySelectorAll(".cp-mini").length,
        label: row.querySelector(".cp-minis").getAttribute("aria-label"),
        meta: row.querySelector(".cp-recent-meta").textContent.replace(/\s+/g, " ").trim().replace(/^.*?(A\d)/, "$1"),
        result: row.querySelector(".cp-result").textContent.trim(),
      })),
    }));
    assert.equal(shown.example, false, "real co-op runs are never tagged Example");
    const filled = await p.evaluate(() => {
      const bring = document.querySelector(".cp-bring"), climbs = document.querySelector(".cp-climbs");
      const foot = (panel) => Math.round(panel.getBoundingClientRect().bottom - panel.lastElementChild.getBoundingClientRect().bottom - parseFloat(getComputedStyle(panel).paddingBottom) - parseFloat(getComputedStyle(panel).borderBottomWidth));
      return { bottoms: Math.abs(bring.getBoundingClientRect().bottom - climbs.getBoundingClientRect().bottom), bringGap: foot(bring), climbsGap: foot(climbs) };
    });
    assert.ok(filled.bottoms <= 1 && Math.abs(filled.bringGap) <= 1 && Math.abs(filled.climbsGap) <= 1, `with real runs both panels still end on one line, filled (off by ${filled.bottoms}px, gaps ${filled.bringGap}px and ${filled.climbsGap}px)`);
    assert.deepEqual(shown.stats, ["Co-op runs: 5", "Wins: 2", "Win rate: 40%", "Best floor: 51"], "5 co-op runs, 2 won: 40%, counted over every run like the rest of the app");
    assert.equal(shown.best, "Most wins together Ironclad + Silent · 2 wins in 3 runs");
    assert.deepEqual(shown.room, ["Ironclad", "Silent"], "that party stands in the room");
    assert.deepEqual(shown.recent, [
      { party: "Silent + Ironclad", sprites: 2, label: "Silent, Ironclad", meta: "A8 · Floor 51", result: "Won" },
      { party: "Ironclad + Silent", sprites: 2, label: "Ironclad, Silent", meta: "A9 · Floor 33", result: "Lost" },
      { party: "Defect + Regent + Silent", sprites: 3, label: "Defect, Regent, Silent", meta: "A5 · Floor 12", result: "Abandoned" },
    ]);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("co-op: Share to Discord copies the post and says so", async () => {
    const server = coopServer("searching");
    const { context, page: p, errors } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await coopCard(p, "searching");
    await p.click('.cp-card [data-cp="share"]');
    await p.waitForSelector('.cp-card [data-cp="share"].is-done');
    assert.equal((await p.innerText('.cp-card [data-cp="share"]')).trim(), "Post copied");
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    assert.equal(
      copied,
      [
        "**Slay the Spire 2 co-op** · looking for a partner right now",
        `${TEST_SESSION.personaName} is waiting · Silent · Stable version · 3 seats open`,
        "Tap Play to team up: https://app.spirevault.app/coop?branch=stable",
      ].join("\n"),
    );
    const toast = await p.evaluate(() => {
      const t = document.getElementById("toast");
      return t && t.classList.contains("is-visible") ? t.textContent : "";
    });
    assert.match(toast, /Discord post copied/);
    await p.waitForSelector('[data-cp="share"]:not(.is-done)', { timeout: 6000 });
    assert.equal((await p.innerText('[data-cp="share"]')).trim(), "Share to Discord", "the button goes back to its label");

    // In a party the post names everyone and the seats left.
    server.view = coopView("host");
    await coopCard(p, "matched");
    await p.click('[data-cp="share"]');
    await p.waitForSelector('[data-cp="share"].is-done');
    const party = await p.evaluate(() => navigator.clipboard.readText());
    assert.match(party, /^\*\*Slay the Spire 2 co-op\*\* · 2 seats open\n/);
    assert.match(party, /TestClimber \(Silent\) and Boble \(Ironclad\) are gathering a party · Stable version/);
    assert.match(party, /https:\/\/app\.spirevault\.app\/coop\?branch=stable$/);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("co-op: on a phone, Share to Discord opens the share sheet with the whole post", async () => {
    const server = coopServer("searching");
    const { context, page: p, errors } = await open(browser, "/?ui=next", {
      signedIn: true, routes: [server.route], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    });
    await p.evaluate(() => {
      window.__shared = [];
      navigator.share = (data) => { window.__shared.push(data); return Promise.resolve(); };
    });
    await coopCard(p, "searching");
    assert.equal(await p.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the test phone reports a touch screen");
    await p.tap('[data-cp="share"]');
    await p.waitForSelector('[data-cp="share"].is-done');
    const shared = await p.evaluate(() => window.__shared);
    assert.equal(shared.length, 1);
    assert.deepEqual(Object.keys(shared[0]), ["text"]);
    assert.match(shared[0].text, /Tap Play to team up: https:\/\/app\.spirevault\.app\/coop\?branch=stable$/);
    assert.equal((await p.innerText('[data-cp="share"]')).trim(), "Shared");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("co-op: a shared link opens Play on the sharer's game version", async () => {
    const server = coopServer("idle");
    const { context, page: p, errors } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    // Follow the link the post carries, as a friend would: a fresh page load.
    await p.goto(`${BASE}/coop?branch=beta`, { waitUntil: "domcontentloaded" });
    await p.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await p.waitForSelector('#coop-play-root .cp[data-cp-state="idle"]', { timeout: 8000 });
    const state = await p.evaluate(() => ({
      onCoop: document.querySelector('.tab-panel[data-tab="coop"]')?.getClientRects().length > 0,
      beta: document.querySelector('[data-cp-branch="beta"]')?.getAttribute("aria-checked"),
      fool: !!document.querySelector('[data-cp-pick="fool"]'),
      invite: localStorage.getItem("vault.coop.invite.v1"),
      saved: JSON.parse(localStorage.getItem("vault.coop.play.v1") || "{}").branch,
    }));
    assert.deepEqual(state, { onCoop: true, beta: "true", fool: true, invite: null, saved: "beta" });
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("co-op: Play sends the chosen climber and game version", async () => {
    const server = coopServer("idle");
    const { context, page: p } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    await coopCard(p, "idle");
    await p.click('[data-cp-branch="beta"]');
    await p.click('[data-cp-pick="fool"]');
    server.view = coopView("searching");
    await p.click('[data-cp="play"]');
    await p.waitForSelector('.cp[data-cp-state="searching"]');
    const post = server.posts.find((x) => x.path === "/api/coop/play");
    assert.deepEqual({ character: post?.body?.character, branch: post?.body?.branch }, { character: "fool", branch: "beta" });
    const timer = await p.textContent("[data-cp-timer]");
    assert.match(timer.trim(), /^0:4\d$/, "the wait timer counts from the ticket's start");
    await context.close();
  });

  await check("co-op: The Fool is offered only on the beta branch", async () => {
    const server = coopServer("idle");
    const { context, page: p } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    await coopCard(p, "idle");
    assert.equal(await p.locator('[data-cp-pick="fool"]').count(), 0, "not offered on the stable version");
    await p.click('[data-cp-branch="beta"]');
    assert.equal(await p.locator('[data-cp-pick="fool"]').count(), 1, "offered on the beta branch");
    await context.close();
  });

  await check("co-op: while you wait, other tabs show a Looking pill that cancels", async () => {
    const server = coopServer("searching");
    const { context, page: p } = await open(browser, "/?ui=next", { signedIn: true, routes: [server.route] });
    await coopCard(p, "searching");
    await p.evaluate(() => window.SpireVault.switchTab("overview"));
    await p.waitForSelector(".cp-float-wrap:not([hidden]) .cp-float");
    assert.match(await p.textContent(".cp-float"), /Looking\s+0:\d\d/);
    server.view = coopView("idle");
    await p.click(".cp-float-x");
    await p.waitForSelector(".cp-float-wrap[hidden]", { state: "attached" });
    await context.close();
  });
}

// ---- In-between widths ------------------------------------------------------------
// The audits that only looked at 320/390/768/1024/1440 missed defects that live
// between them (the rail's 881-912 handover, 890-960 beside the rail,
// 1120-1340 where two columns get cramped). These widths sit in those gaps.
const IN_BETWEEN_WIDTHS = Object.freeze([
  320, 340, 360, 390, 430, 470, 520, 600, 700, 768, 820, 881, 890, 900, 912, 940, 980,
  1024, 1080, 1120, 1180, 1250, 1310, 1366, 1440, 1600, 1920,
]);
const IN_BETWEEN_TABS = Object.freeze(["overview", "characters", "ascensions", "relics", "cards", "runs", "news", "settings"]);

/** Problems on the open tab: sideways scroll, a footer link split over two lines. */
function inBetweenProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const over = document.documentElement.scrollWidth - window.innerWidth;
    if (over > 1) out.push(`scrolls sideways by ${over}px`);
    for (const link of document.querySelectorAll(".footer-links a")) {
      const range = document.createRange();
      range.selectNodeContents(link);
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size;
      if (lines > 1) out.push(`footer link "${link.textContent.trim()}" takes ${lines} lines`);
    }
    return out;
  });
}

async function runWidths(browser) {
  for (const [look, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
    await check(`${look}: no sideways scroll or split footer link at ${IN_BETWEEN_WIDTHS.length} in-between widths`, async () => {
      const { context, page, errors } = await open(browser, path);
      try {
        /** @type {string[]} */
        const problems = [];
        for (const width of IN_BETWEEN_WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          for (const tab of IN_BETWEEN_TABS) {
            await page.evaluate((t) => window.SpireVault.switchTab(t), tab);
            await page.waitForSelector(`.tab-panel[data-tab="${tab}"]:not([hidden])`);
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            for (const problem of await inBetweenProblems(page)) problems.push(`${tab} at ${width}px: ${problem}`);
          }
        }
        assert.deepEqual(problems, []);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
}

/** The widget ids of the Overview, in page order. @param {import("playwright").Page} page */
function widgetOrder(page) {
  return page.$$eval("#overview-body .v-ov-grid > .v-w[data-w]", (els) => els.map((el) => el.dataset.key));
}

/** @param {import("playwright").Page} page */
async function enterArrange(page) {
  await page.click('#overview-body [data-action="ov-arrange"]');
  await page.waitForSelector("#overview-body .v-ov[data-arrange]");
}

/**
 * The customizable Overview (new look): Arrange mode by pointer and keyboard,
 * sizes, remove and Undo, the gallery, Reset, saving across reloads, the
 * first-visit tour, and that none of it touches <html> (a root change re-fits
 * every stage header).
 */
async function runArrange(browser) {
  await check("Arrange opens in the Overview body and leaves <html> alone", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    const root = () => p.evaluate(() => {
      const html = document.documentElement;
      return { cls: html.className, attrs: [...html.attributes].map((a) => `${a.name}=${a.value}`).sort().join(" ") };
    });
    const before = await root();
    assert.equal(await p.locator('.panel-head [data-action="ov-arrange"], .toolbar [data-action="ov-arrange"]').count(), 0, "not in the header or toolbar");
    await enterArrange(p);
    const state = await p.evaluate(() => ({
      cells: document.querySelectorAll("#overview-body .v-ov-grid > .v-w").length,
      tools: document.querySelectorAll("#overview-body .v-w > .v-w-tools").length,
      inert: [...document.querySelectorAll("#overview-body .v-w-body")].every((el) => el.inert),
      foot: !!document.querySelector("#overview-body .v-arr-foot [data-arr='done']"),
    }));
    assert.ok(state.cells >= 6, `widgets in Arrange (${state.cells})`);
    assert.equal(state.tools, state.cells, "every widget has its tools");
    assert.equal(state.inert, true, "widget content is inert while arranging");
    assert.equal(state.foot, true, "the foot bar has Done");
    assert.deepEqual(await root(), before, "<html> class and attributes unchanged");
    await p.click('[data-arr="done"]');
    await p.waitForSelector('#overview-body .v-ov:not([data-arrange]) [data-action="ov-arrange"]');
    assert.deepEqual(await root(), before, "<html> unchanged after Done");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("a widget moves by pointer drag, saves, and stays moved after a reload", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    await enterArrange(p);
    const before = await widgetOrder(p);
    assert.ok(before.indexOf("winRate") < before.indexOf("characters"), "win rate starts before by character");
    await p.evaluate(() => document.querySelector('.v-w[data-key="winRate"]').scrollIntoView({ block: "center" }));
    const grip = await p.locator('.v-w[data-key="winRate"] [data-arr="grip"]').boundingBox();
    const target = await p.locator('.v-w[data-key="characters"]').boundingBox();
    await p.mouse.move(grip.x + 20, grip.y + grip.height / 2);
    await p.mouse.down();
    const to = { x: target.x + target.width * 0.8, y: target.y + target.height / 2 };
    for (let i = 1; i <= 12; i += 1) {
      await p.mouse.move(grip.x + 20 + (to.x - grip.x - 20) * (i / 12), grip.y + grip.height / 2 + (to.y - grip.y - grip.height / 2) * (i / 12));
    }
    assert.equal(await p.locator(".v-w.is-lifted").count(), 1, "the widget lifts while dragged");
    assert.equal(await p.locator(".v-w-slot").count(), 1, "a slot shows where it will land");
    await p.mouse.up();
    await p.waitForFunction(() => !document.querySelector(".v-w.is-lifted"));
    const after = await widgetOrder(p);
    assert.ok(after.indexOf("winRate") > after.indexOf("characters"), `win rate dropped after by character (${after.join(",")})`);
    const stored = await p.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), LAYOUT_KEY);
    assert.deepEqual(stored && stored.items.map((item) => item.key), after, "the new order is saved");
    await p.click('[data-arr="done"]');
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector("#overview-body .v-ov");
    // Normally a widget with nothing to show is not drawn (sample data has no "since your last visit").
    const shown = await widgetOrder(p);
    assert.deepEqual(shown, after.filter((key) => shown.includes(key)), "the order survives a reload");
    assert.ok(shown.indexOf("winRate") > shown.indexOf("characters"), "still after by character");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("keyboard: Space picks up, arrows move, Space drops, Escape puts back", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    await enterArrange(p);
    const start = await widgetOrder(p);
    const grip = '.v-w[data-key="trend"] [data-arr="grip"]';
    await p.focus(grip);
    await p.keyboard.press("Space");
    assert.equal(await p.locator(".v-w.is-picked").count(), 1, "picked up");
    await p.keyboard.press("ArrowUp");
    await p.keyboard.press("Space");
    const moved = await widgetOrder(p);
    assert.equal(moved.indexOf("trend"), start.indexOf("trend") - 1, "one place earlier");
    assert.equal(await p.evaluate(() => document.activeElement && document.activeElement.closest(".v-w")?.dataset.key), "trend", "focus stays on its grip");
    const live = await p.textContent('[data-arr="live"]');
    assert.match(live || "", /moved to \d+ of \d+/, "screen readers hear the new place");
    await p.keyboard.press("Space");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.press("Escape");
    assert.deepEqual(await widgetOrder(p), moved, "Escape puts it back");
    await context.close();
  });

  await check("size chips resize a widget, remove has Undo, Reset brings the default back", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    await enterArrange(p);
    await p.click('.v-w[data-key="winRate"] [data-arr="size"][data-size="W"]');
    const sized = await p.evaluate(() => {
      const cell = document.querySelector('.v-w[data-key="winRate"]');
      return { size: cell.dataset.size, span: cell.style.getPropertyValue("--span"), pair: cell.dataset.pair || null };
    });
    assert.deepEqual(sized, { size: "W", span: "12", pair: null }, "W spans the row");
    await p.click('.v-w[data-key="relics"] [data-arr="remove"]');
    assert.equal(await p.locator('.v-w[data-key="relics"]').count(), 0, "removed");
    assert.match(await p.textContent('[data-arr="toast"]'), /Removed/, "an Undo toast shows");
    await p.click('[data-arr="undo"]');
    await p.waitForSelector('.v-w[data-key="relics"]');
    await p.click('[data-arr="clear"]');
    assert.equal(await p.locator("#overview-body .v-ov-grid > .v-w").count(), 0, "Clear all empties the board");
    assert.equal(await p.locator('#overview-body .v-ov-empty [data-arr="add"]').count(), 1, "the empty board offers Add widget");
    assert.match(await p.textContent('[data-arr="toast"]'), /Cleared the board/, "with an Undo");
    await p.click('[data-arr="undo"]');
    await p.waitForSelector('.v-w[data-key="relics"]');
    await p.click('[data-arr="reset"]');
    await p.click('[data-arr="reset-yes"]');
    await p.waitForSelector('.v-w[data-key="winRate"][data-size="L"]');
    assert.equal(await p.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY), null, "the default layout is not stored");
    await context.close();
  });

  await check("the climb calendar's Solo / Co-op chips filter it and are remembered", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    await enterArrange(p);
    await p.click('[data-arr="add"]');
    await p.waitForSelector('dialog.v-gal[open] [data-gal-add="calendar"]');
    await p.click('dialog.v-gal [data-gal-add="calendar"]');
    await p.waitForSelector('#overview-body .v-w[data-w="calendar"] .v-cal-grid');
    await p.click('[data-arr="done"]');
    const chip = '#overview-body .v-w[data-w="calendar"] [data-ov-set="mode"][data-value="coop"]';
    await p.waitForSelector(chip);
    await p.click(chip);
    await p.waitForSelector(`${chip}[aria-pressed="true"]`);
    const stored = await p.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), LAYOUT_KEY);
    assert.equal(stored.items.find((item) => item.id === "calendar").settings.mode, "coop", "the choice is saved with the layout");
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector(`${chip}[aria-pressed="true"]`);
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the gallery adds a live widget with your own numbers", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    await enterArrange(p);
    await p.click('[data-arr="add"]');
    await p.waitForSelector("dialog.v-gal[open] .v-gal-tile");
    const tiles = await p.$$eval("dialog.v-gal .v-gal-tile", (els) => els.map((el) => el.querySelector("h3").textContent));
    assert.ok(tiles.includes("Solo vs co-op") && tiles.includes("Stat tile"), "new widgets are offered");
    assert.equal(await p.locator('dialog.v-gal .v-gal-tile:has(h3:text-is("Your hand")) .v-gal-placed').count(), 1, "placed widgets say so");
    await p.fill("dialog.v-gal [data-gal-search]", "solo vs");
    assert.equal(await p.locator("dialog.v-gal .v-gal-tile:not([hidden])").count(), 1, "search filters the gallery");
    await p.click('dialog.v-gal [data-gal-add="coopSplit"]');
    await p.waitForSelector('#overview-body .v-w[data-w="coopSplit"] .v-split');
    assert.equal(await p.locator("dialog.v-gal[open]").count(), 0, "the sheet closes");
    const text = await p.textContent('#overview-body .v-w[data-w="coopSplit"]');
    assert.match(text || "", /Solo/, "it draws the player's solo record");
    assert.deepEqual(errors, []);
    await context.close();
  });

  await check("the first-visit tour steps through Arrange once, with Next and Skip", async () => {
    const { context, page: p, errors } = await open(browser, "/", { tour: true });
    await p.waitForSelector(".v-tour:not(.is-moving) .v-tour-card", { timeout: BOOT_TIMEOUT_MS });
    await p.waitForTimeout(450); // the ring's slide (320ms)
    assert.match(await p.textContent(".v-tour-count"), /Step 1 of 6/);
    const ring = await p.evaluate(() => {
      const hole = document.querySelector(".v-tour-hole").getBoundingClientRect();
      const btn = document.querySelector('[data-action="ov-arrange"]').getBoundingClientRect();
      return hole.left <= btn.left && hole.right >= btn.right && hole.top <= btn.top && hole.bottom >= btn.bottom;
    });
    assert.equal(ring, true, "the ring is around the Arrange button");
    await p.click('[data-tour="next"]');
    await p.waitForSelector("#overview-body .v-ov[data-arrange]");
    await p.waitForFunction(() => /Step 2 of 6/.test(document.querySelector(".v-tour-count")?.textContent || ""));
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector(".v-tour"));
    assert.equal(await p.evaluate((key) => localStorage.getItem(key), TOUR_KEY), "skip", "skipping is remembered");
    await p.click('[data-arr="done"]');
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForSelector("#overview-body .v-ov");
    await p.waitForTimeout(2500);
    assert.equal(await p.locator(".v-tour").count(), 0, "it does not come back");
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// ---- Section filters and win streaks ----------------------------------------
// Overview → By character: mode (All / Standard / Blitz / Dread) and one
// ascension level, plus each climber's current win streak on its card.
// Ascensions: one climber, Standard or Blitz ladder. Both looks.

/**
 * Demo runs plus some of the STS2 beta's Blitz and Dread runs and two fresh
 * win streaks (Ironclad 9, Silent 3), pushed in the way the desktop apps push
 * runs. Returns what was sent, so expectations never come from the app's code.
 * `newer` adds runs after those, newest last: [character, fields] pairs.
 * @param {import("playwright").Page} page
 * @param {Array<[string, Record<string, unknown>]>} [newer]
 * @returns {Promise<Array<{ id: string, character: string, won: boolean, ascension: number|null, gameMode: string, partySize: number|null, isCustom: boolean }>>}
 */
async function seedFilterRuns(page, newer = []) {
  const runs = await page.evaluate(async (newer) => {
    const { getDemoRuns } = await import("/lib/demo-runs.js?v=2");
    const demo = getDemoRuns();
    const newest = Math.max(...demo.map((r) => +r.endedAt));
    const extras = [];
    let i = 0;
    const add = (character, extra) => {
      const template = demo.find((r) => r.character === character) || demo[0];
      const endedAt = new Date(newest + ++i * 5 * 3_600_000);
      extras.push({ ...template, id: `filters-${i}`, seed: `FILTERS${i}`, startedAt: new Date(+endedAt - 3_000_000), endedAt, ...extra });
    };
    for (const [c, won, ascension] of [["ironclad", true, 1], ["ironclad", false, 2], ["silent", true, 1], ["defect", false, 1], ["ironclad", true, 2], ["silent", false, 3], ["regent", true, 1], ["ironclad", false, 3]]) {
      add(c, { won, ascension, gameMode: "blitz" });
    }
    for (const [c, won] of [["ironclad", false], ["silent", false], ["ironclad", false], ["defect", true]]) add(c, { won, ascension: 10, gameMode: "dread" });
    for (let k = 0; k < 3; k++) add("silent", { won: true, ascension: 6 });
    for (let k = 0; k < 9; k++) add("ironclad", { won: true, ascension: k % 3 === 0 ? 9 : 10 });
    for (const [c, fields] of newer) add(c, fields);
    const all = [...demo, ...extras].map((r) => ({ ...r, startedAt: r.startedAt?.toISOString?.() ?? r.startedAt, endedAt: r.endedAt?.toISOString?.() ?? r.endedAt }));
    window.SpireVault.ingestDesktopRuns(all);
    return all.map((r) => ({
      id: String(r.id),
      character: r.character,
      won: r.won === true,
      ascension: Number.isFinite(r.ascension) ? r.ascension : null,
      gameMode: r.gameMode || "",
      partySize: Number.isFinite(r.partySize) ? r.partySize : null,
      isCustom: r.isCustom === true,
    }));
  }, newer);
  await page.waitForFunction(
    () => document.querySelector("#overview-body .v-char-streak:not(.is-empty), #overview-body .char-card-streak"),
    null,
    { timeout: BOOT_TIMEOUT_MS }
  );
  return runs;
}

/** Co-op runs for the Solo / Co-op checks: newer than every other seeded run.
 *  Ironclad wins one with Silent (A10); Defect loses one with Regent (A10);
 *  Regent wins a party of three (A5). @type {Array<[string, Record<string, unknown>]>} */
const COOP_SEED = Object.freeze([
  ["ironclad", { won: true, ascension: 10, partySize: 2, party: ["ironclad", "silent"] }],
  ["defect", { won: false, ascension: 10, partySize: 2, party: ["defect", "regent"] }],
  ["regent", { won: true, ascension: 5, partySize: 3, party: ["regent", "necrobinder", "silent"] }],
]);
/** @param {{ partySize: number|null }} run */
const isCoopRun = (run) => (run.partySize ?? 1) > 1;

/** @param {{ gameMode: string }} run */
const modeOf = (run) => (/blitz/i.test(run.gameMode) ? "blitz" : /dread/i.test(run.gameMode) ? "dread" : "standard");
/** @param {Array<any>} runs @param {{ character?: string, mode?: string, asc?: number }} want */
const pickRuns = (runs, want) => runs.filter((r) =>
  (!want.character || r.character === want.character) && (!want.mode || modeOf(r) === want.mode) && (want.asc === undefined || r.ascension === want.asc));
/** "6W · 0L", as a banner shows it. @param {Array<any>} list */
const recordOf = (list) => `${list.filter((r) => r.won).length}W · ${list.filter((r) => !r.won).length}L`;

/** Per-level "wins/runs" of the storeys or classic bars on the Ascensions tab. @param {import("playwright").Page} page */
function ladderCounts(page) {
  return page.evaluate(() => {
    const out = {};
    for (const st of document.querySelectorAll("#ascensions-body .v-asc-st.is-lit")) {
      const key = st.querySelector(".v-asc-st-key").textContent.trim();
      const runs = Number.parseInt(st.querySelector(".v-asc-st-runs").textContent, 10);
      out[key] = runs;
    }
    for (const col of document.querySelectorAll("#ascensions-body .asc-bar-col")) {
      const key = col.querySelector(".asc-bar-label").textContent.trim();
      const match = col.querySelector(".asc-bar-tooltip").textContent.match(/(\d+)r/);
      out[key] = match ? Number(match[1]) : NaN;
    }
    return out;
  });
}

/** Expected runs per level on one ladder. @param {Array<any>} runs */
function expectedLadder(runs) {
  const out = {};
  for (const r of runs) if (r.ascension !== null && r.ascension <= 10) out[`A${r.ascension}`] = (out[`A${r.ascension}`] || 0) + 1;
  return out;
}

async function runStatFilters(browser) {
  await check("By character: a climber's current win streak shows on its card, in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        await seedFilterRuns(p);
        const shown = await p.evaluate(() => {
          const out = {};
          for (const el of document.querySelectorAll("#overview-body .v-char[data-char]")) {
            out[el.dataset.char] = { tag: el.querySelector(".v-char-streak:not(.is-empty) b")?.textContent || "", spoken: el.getAttribute("aria-label") || "" };
          }
          for (const el of document.querySelectorAll("#overview-body .char-card")) {
            const key = (el.querySelector(".char-card-name")?.textContent || "").trim().toLowerCase();
            out[key] = { tag: el.querySelector(".char-card-streak strong")?.textContent || "", spoken: el.getAttribute("aria-label") || "" };
          }
          return out;
        });
        assert.equal(shown.ironclad?.tag, "9", `${label}: Ironclad has won its last 9 runs`);
        assert.equal(shown.silent?.tag, "3", `${label}: Silent has won its last 3`);
        assert.equal(shown.defect?.tag, "", `${label}: Defect's newest run is not a win`);
        assert.match(shown.ironclad.spoken, /9 wins in a row/, `${label}: the card's label says the streak`);
        if (label === "new look") {
          // Every bar stays level: a banner without a streak keeps the line.
          const lines = await p.$$eval("#overview-body .v-char", (els) => els.map((el) => !!el.querySelector(".v-char-streak")));
          assert.ok(lines.every(Boolean), "every banner has a streak line (empty when there is no streak)");
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("By character: no mode control without Blitz or Dread runs; they bring one", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    try {
      assert.equal(await p.locator('#overview-body [data-stat-filter="chars.mode"]').count(), 0, "sample data has only standard runs");
      assert.equal(await p.locator('#overview-body select[data-stat-filter="chars.asc"]').count(), 1, "the ascension picker is there");
      await seedFilterRuns(p);
      const modes = await p.$$eval('#overview-body [data-stat-filter="chars.mode"]', (els) => els.map((el) => el.dataset.value));
      assert.deepEqual(modes, ["all", "standard", "blitz", "dread"]);
      assert.equal(await p.locator('#overview-body [data-stat-filter="chars.mode"][aria-pressed="true"]').getAttribute("data-value"), "all");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("By character: an ascension narrows every card and says so; Clear undoes it", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    try {
      const runs = await seedFilterRuns(p);
      await p.selectOption('#overview-body select[data-stat-filter="chars.asc"]', "10");
      const a10 = pickRuns(runs, { mode: "standard", asc: 10 });
      const ironclad = pickRuns(a10, { character: "ironclad" });
      const state = await p.evaluate(() => ({
        summary: document.querySelector("#overview-body .v-chars .v-filter-summary")?.textContent.replace(/\s+/g, " ").trim(),
        ironclad: document.querySelector('#overview-body .v-char[data-char="ironclad"] .v-char-rec')?.textContent.replace(/\s+/g, " ").trim(),
        silent: document.querySelector('#overview-body .v-char[data-char="silent"] .v-char-rec')?.textContent.trim(),
        focused: document.activeElement?.matches('select[data-stat-filter="chars.asc"]') ?? false,
        value: document.querySelector('#overview-body select[data-stat-filter="chars.asc"]').value,
      }));
      assert.equal(state.summary, `Showing A10 · ${a10.length} of ${runs.length} runs Clear`);
      assert.ok(state.ironclad?.startsWith(recordOf(ironclad)), `Ironclad at A10: "${state.ironclad}", expected ${recordOf(ironclad)}`);
      assert.equal(state.silent, "No runs", "a climber with no A10 runs says so, short enough for a narrow banner");
      assert.equal(state.value, "10");
      assert.ok(state.focused, "focus stays on the picker after the re-render");
      await p.click('#overview-body [data-stat-filter="chars.clear"]');
      assert.equal(await p.locator("#overview-body .v-chars .v-filter-summary").count(), 0, "Clear removes the summary");
      const all = pickRuns(runs, { character: "ironclad" });
      const back = await p.textContent('#overview-body .v-char[data-char="ironclad"] .v-char-rec');
      assert.ok(back.replace(/\s+/g, " ").trim().startsWith(recordOf(all)), `after Clear: "${back}"`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("By character: Blitz counts Blitz runs only; Dread turns the ascension picker off", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    try {
      const runs = await seedFilterRuns(p);
      await p.click('#overview-body [data-stat-filter="chars.mode"][data-value="blitz"]');
      const blitz = pickRuns(runs, { mode: "blitz" });
      const levels = [...new Set(blitz.map((r) => r.ascension))].sort((a, b) => b - a).map(String);
      const state = await p.evaluate(() => ({
        ironclad: document.querySelector('#overview-body .v-char[data-char="ironclad"] .v-char-rec')?.textContent.replace(/\s+/g, " ").trim(),
        options: [...document.querySelectorAll('#overview-body select[data-stat-filter="chars.asc"] option')].map((o) => o.value),
        focused: document.activeElement?.matches('[data-stat-filter="chars.mode"][data-value="blitz"]') ?? false,
      }));
      assert.ok(state.ironclad?.startsWith(recordOf(pickRuns(blitz, { character: "ironclad" }))), `Ironclad in Blitz: "${state.ironclad}"`);
      assert.deepEqual(state.options, ["", ...levels], "the picker offers the Blitz levels that have runs, highest first");
      assert.ok(state.focused, "focus stays on the Blitz chip");
      // A Blitz level does not survive a switch to the standard ladder.
      await p.selectOption('#overview-body select[data-stat-filter="chars.asc"]', levels[levels.length - 1]);
      await p.click('#overview-body [data-stat-filter="chars.mode"][data-value="standard"]');
      assert.equal(await p.inputValue('#overview-body select[data-stat-filter="chars.asc"]'), "", "Blitz A1 does not become standard A1");
      assert.match((await p.textContent("#overview-body .v-chars .v-filter-summary")).replace(/\s+/g, " "), /Showing Standard · /);
      await p.click('#overview-body [data-stat-filter="chars.mode"][data-value="dread"]');
      assert.equal(await p.locator('#overview-body select[data-stat-filter="chars.asc"]').isDisabled(), true, "Dread runs have no ascension level");
      const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("vault.web.statfilters.v1") || "null"));
      assert.deepEqual(saved?.chars, { mode: "dread", asc: null, party: "all" }, "the choice is kept for the next visit");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("Ascensions: one climber redraws the spire, tiers and breakdown, in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        const runs = await seedFilterRuns(p);
        await p.evaluate(() => window.SpireVault.switchTab("ascensions"));
        await p.waitForSelector('#ascensions-body [data-stat-filter="spire.character"]');
        assert.equal(await p.locator('#ascensions-body [data-stat-filter="spire.character"][data-value="fool"]').isDisabled(), true, `${label}: a climber with no runs cannot be picked`);
        await p.click('#ascensions-body [data-stat-filter="spire.character"][data-value="silent"]');
        const silent = pickRuns(runs, { character: "silent", mode: "standard" });
        assert.deepEqual(await ladderCounts(p), expectedLadder(silent), `${label}: Silent's runs per level`);
        const standardRuns = pickRuns(runs, { mode: "standard" }).length;
        const summary = (await p.textContent("#ascensions-body .v-filter-summary, #ascensions-body .stat-filters .run-filter-summary")).replace(/\s+/g, " ").trim();
        assert.ok(summary.startsWith(`Showing Silent · ${silent.length} of ${standardRuns} runs`), `${label}: "${summary}"`);
        if (label === "new look") {
          assert.match(await p.textContent("#ascensions-body .v-asc-panel-head p"), /^Silent · /);
          const a0 = pickRuns(silent, { asc: 0 });
          assert.match(await p.textContent('#ascensions-body .v-asc-tier[data-tier="standard"] .v-asc-tier-rec'), new RegExp(`${a0.filter((r) => r.won).length}W / ${a0.length} run`));
          assert.equal(await p.locator("#ascensions-body .v-asc-row").count(), 11, "the breakdown keeps every level");
        } else {
          assert.equal(await p.locator("#ascensions-body .asc-detail-row").count(), Object.keys(expectedLadder(silent)).length);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("Ascensions: the Blitz ladder draws its own levels and drops the standard tiers", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        const runs = await seedFilterRuns(p);
        await p.evaluate(() => window.SpireVault.switchTab("ascensions"));
        await p.click('#ascensions-body [data-stat-filter="spire.ladder"][data-value="blitz"]');
        assert.deepEqual(await ladderCounts(p), expectedLadder(pickRuns(runs, { mode: "blitz" })), `${label}: Blitz runs per level`);
        assert.equal(await p.locator('#ascensions-body [data-stat-filter="spire.character"][data-value="necrobinder"]').isDisabled(), true, `${label}: no Blitz runs as Necrobinder`);
        if (label === "new look") {
          assert.equal(await p.locator("#ascensions-body .v-asc-blitz").count(), 1, "the Blitz note takes the tiers' place");
          assert.equal(await p.locator("#ascensions-body .v-asc-tier-list, #ascensions-body .v-asc-rows").count(), 0, "no standard tiers or modifiers");
          assert.equal(await p.locator("#ascensions-body .v-asc-st").count(), 6, "A0 to Blitz A5");
          assert.equal(await p.locator("#ascensions-body .v-asc-st button").count(), 0, "a Blitz storey has no modifier row to open");
        } else {
          assert.equal(await p.locator("#ascensions-body .asc-detail-panel, #ascensions-body .asc-tier-legend").count(), 0, "no standard tiers or modifiers");
          assert.match(await p.textContent("#ascensions-body"), /Blitz ladder/);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("Runs: Blitz or Dread runs bring Mode chips that count that mode only and switch the tiers off, in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        await p.evaluate(() => window.SpireVault.switchTab("runs"));
        await p.waitForSelector('#runs-body [data-filter-kind="outcome"]');
        assert.equal(await p.locator('#runs-body [data-filter-kind="mode"]').count(), 0, `${label}: sample data has only standard runs`);
        // The seed waits for Overview to show the streaks, so it runs there.
        await p.evaluate(() => window.SpireVault.switchTab("overview"));
        const runs = await seedFilterRuns(p);
        await p.evaluate(() => window.SpireVault.switchTab("runs"));
        await p.waitForSelector('#runs-body [data-filter-kind="mode"]');
        const modes = await p.$$eval('#runs-body button[data-filter-kind="mode"]', (els) => els.map((el) => el.dataset.filterValue));
        assert.deepEqual(modes, ["all", "standard", "blitz", "dread"], label);
        const summary = async () => (await p.textContent("#runs-body .v-runs-summary, #runs-body .run-filter-summary")).replace(/\s+/g, " ").trim();
        // A standard tier, then Blitz: the tier gives way, since Blitz levels are not on that ladder.
        await p.click('#runs-body button[data-filter-kind="ascensionTier"][data-filter-value="master"]');
        await p.click('#runs-body button[data-filter-kind="mode"][data-filter-value="blitz"]');
        const blitz = pickRuns(runs, { mode: "blitz" }).length;
        assert.match(await summary(), new RegExp(`^Showing ${blitz} of ${runs.length} runs`), `${label}: Blitz`);
        const tiers = await p.$$eval('#runs-body button[data-filter-kind="ascensionTier"]', (els) => els.map((el) => ({ id: el.dataset.filterValue, pressed: el.getAttribute("aria-pressed"), off: el.disabled })));
        assert.deepEqual(tiers.filter((t) => t.pressed === "true").map((t) => t.id), ["all"], `${label}: the A10 tier was dropped`);
        assert.ok(tiers.filter((t) => t.id !== "all").every((t) => t.off), `${label}: standard tiers are off under Blitz`);
        await p.click('#runs-body button[data-filter-kind="mode"][data-filter-value="dread"]');
        assert.match(await summary(), new RegExp(`^Showing ${pickRuns(runs, { mode: "dread" }).length} of ${runs.length} runs`), `${label}: Dread`);
        const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("vault.web.runfilters.v1") || "null"));
        assert.equal(saved?.mode, "dread", `${label}: the mode is kept with the other Runs filters`);
        await p.click('#runs-body [data-action="clear-filters"]');
        assert.match(await summary(), new RegExp(`(All|Showing all) ${runs.length} runs`), `${label}: Clear resets the mode`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("a saved filter the loaded runs cannot show is never applied", async () => {
    const { context, page: p, errors } = await open(browser, "/?ui=next");
    try {
      // Saved while Blitz runs were loaded; the sample data has none.
      await p.evaluate(() => localStorage.setItem("vault.web.statfilters.v1", JSON.stringify({ chars: { mode: "blitz", asc: 2 }, spire: { character: "fool", ladder: "blitz" } })));
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
      assert.equal(await p.locator("#overview-body .v-filter-summary").count(), 0);
      assert.equal(await p.inputValue('#overview-body select[data-stat-filter="chars.asc"]'), "");
      await p.evaluate(() => window.SpireVault.switchTab("ascensions"));
      await p.waitForSelector('#ascensions-body [data-stat-filter="spire.character"]');
      assert.equal(await p.locator('#ascensions-body [data-stat-filter="spire.character"][aria-pressed="true"]').getAttribute("data-value"), "all");
      assert.equal(await p.locator('#ascensions-body [data-stat-filter="spire.ladder"]').count(), 0, "no ladder choice without Blitz runs");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("streaks: a Custom Run and a daily run neither break nor extend one; an abandoned run breaks it, in both looks", async () => {
    // The newest runs: Ironclad abandons a Custom Run, Silent loses a daily,
    // Regent wins a daily, Defect abandons a standard run.
    const newer = [
      ["ironclad", { won: false, wasAbandoned: true, isCustom: true, gameMode: "standard", ascension: 0 }],
      ["silent", { won: false, gameMode: "daily", ascension: 0 }],
      ["regent", { won: true, gameMode: "daily", ascension: 0 }],
      ["defect", { won: true, ascension: 1 }],
      ["defect", { won: true, ascension: 1 }],
      ["defect", { won: false, wasAbandoned: true, ascension: 1 }],
    ];
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        await seedFilterRuns(p, newer);
        const tags = await p.evaluate(() => {
          const out = {};
          for (const el of document.querySelectorAll("#overview-body .v-char[data-char]")) out[el.dataset.char] = el.querySelector(".v-char-streak:not(.is-empty) b")?.textContent || "";
          for (const el of document.querySelectorAll("#overview-body .char-card")) {
            out[(el.querySelector(".char-card-name")?.textContent || "").trim().toLowerCase()] = el.querySelector(".char-card-streak strong")?.textContent || "";
          }
          return out;
        });
        assert.equal(tags.ironclad, "9", `${label}: the abandoned Custom Run does not break Ironclad's 9`);
        assert.equal(tags.silent, "3", `${label}: the lost daily does not break Silent's 3`);
        assert.equal(tags.defect, "", `${label}: an abandoned standard run ends Defect's 2, as in the game`);
        // The page-wide streak cards: the newest climb run is Defect's abandon.
        const streakCard = await p.evaluate(() => {
          const el = [...document.querySelectorAll("#overview-body .v-card, #overview-body .kpi-card")].find((c) => /streak/i.test(c.textContent) && !/best|longest/i.test(c.textContent));
          return el ? { text: el.textContent.replace(/\s+/g, " ").trim(), title: el.getAttribute("title") || "" } : null;
        });
        if (streakCard) {
          assert.match(streakCard.text, /Loss streak/, `${label}: "${streakCard.text}"`);
          assert.match(streakCard.title, /Custom and daily runs are not counted/, `${label}: the card says what it counts`);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("Solo / Co-op: co-op runs bring Party chips to By character, Ascensions and Runs; each counts its party only, in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        assert.equal(await p.locator('[data-stat-filter$=".party"], [data-filter-kind="party"]').count(), 0, `${label}: no Party chips without co-op runs`);
        const runs = await seedFilterRuns(p, COOP_SEED);
        const coop = runs.filter(isCoopRun);
        const solo = runs.filter((r) => !isCoopRun(r));
        // By character
        const parties = await p.$$eval('#overview-body [data-stat-filter="chars.party"]', (els) => els.map((el) => el.dataset.value));
        assert.deepEqual(parties, ["all", "solo", "coop"], `${label}: By character`);
        await p.click('#overview-body [data-stat-filter="chars.party"][data-value="coop"]');
        const recOf = (key) => p.evaluate((k) => (document.querySelector(`#overview-body .v-char[data-char="${k}"] .v-char-rec`)
          || [...document.querySelectorAll("#overview-body .char-card")].find((el) => el.querySelector(".char-card-name")?.textContent.trim().toLowerCase() === k))?.textContent.replace(/\s+/g, " ").trim() || "", key);
        const summaryChars = (await p.textContent("#overview-body .v-chars .v-filter-summary, #overview-body .stat-filters--chars .run-filter-summary")).replace(/\s+/g, " ").trim();
        assert.ok(summaryChars.startsWith(`Showing Co-op · ${coop.length} of ${runs.length} runs`), `${label}: "${summaryChars}"`);
        if (label === "new look") {
          assert.ok((await recOf("ironclad")).startsWith(recordOf(pickRuns(coop, { character: "ironclad" }))), `${label}: Ironclad in co-op`);
          assert.equal(await recOf("silent"), "No runs", `${label}: Silent has no co-op runs of its own`);
        }
        await p.click('#overview-body [data-stat-filter="chars.party"][data-value="solo"]');
        if (label === "new look") {
          assert.ok((await recOf("regent")).startsWith(recordOf(pickRuns(solo, { character: "regent" }))), `${label}: Regent solo`);
        }
        const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("vault.web.statfilters.v1") || "null"));
        assert.equal(saved?.chars?.party, "solo", `${label}: the party is kept`);
        // Ascensions
        await p.evaluate(() => window.SpireVault.switchTab("ascensions"));
        await p.waitForSelector('#ascensions-body [data-stat-filter="spire.party"]');
        await p.click('#ascensions-body [data-stat-filter="spire.party"][data-value="coop"]');
        assert.deepEqual(await ladderCounts(p), expectedLadder(pickRuns(coop, { mode: "standard" })), `${label}: co-op runs per level`);
        const summaryAsc = (await p.textContent("#ascensions-body .v-filter-summary, #ascensions-body .stat-filters .run-filter-summary")).replace(/\s+/g, " ").trim();
        assert.ok(summaryAsc.startsWith(`Showing Co-op · ${pickRuns(coop, { mode: "standard" }).length} of ${pickRuns(runs, { mode: "standard" }).length} runs`), `${label}: "${summaryAsc}"`);
        // Runs
        await p.evaluate(() => window.SpireVault.switchTab("runs"));
        await p.waitForSelector('#runs-body button[data-filter-kind="party"]');
        await p.click('#runs-body button[data-filter-kind="party"][data-filter-value="coop"]');
        const runsSummary = (await p.textContent("#runs-body .v-runs-summary, #runs-body .run-filter-summary")).replace(/\s+/g, " ").trim();
        assert.match(runsSummary, new RegExp(`^Showing ${coop.length} of ${runs.length} runs`), `${label}: Runs`);
        const rowTags = await p.$$eval("#runs-body .run-row", (rows) => rows.map((row) => [...row.querySelectorAll('[data-tag="coop"]')].length));
        assert.equal(rowTags.length, coop.length, `${label}: one row per co-op run`);
        assert.ok(rowTags.every((n) => n === 1), `${label}: every co-op row says Co-op`);
        const title = await p.getAttribute('#runs-body [data-tag="coop"]', "title");
        assert.match(title, /^Co-op run: /, `${label}: the tag names the party`);
        const savedRuns = await p.evaluate(() => JSON.parse(localStorage.getItem("vault.web.runfilters.v1") || "null"));
        assert.equal(savedRuns?.party, "coop", `${label}: kept with the other Runs filters`);
        await p.click('#runs-body [data-action="clear-filters"]');
        assert.match((await p.textContent("#runs-body .v-runs-summary, #runs-body .run-filter-summary")).replace(/\s+/g, " "), new RegExp(`(All|Showing all) ${runs.length} runs`), `${label}: Clear resets the party`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("Runs: a Custom Run says so on its row and is found by searching \"custom\", in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        await seedFilterRuns(p, [["ironclad", { won: false, wasAbandoned: true, isCustom: true, gameMode: "standard", ascension: 0 }]]);
        await p.evaluate(() => window.SpireVault.switchTab("runs"));
        await p.waitForSelector('#runs-body [data-tag="custom"]');
        assert.equal(await p.locator('#runs-body [data-tag="custom"]').count(), 1, `${label}: one Custom tag`);
        assert.match(await p.getAttribute('#runs-body [data-tag="custom"]', "title"), /not counted in win streaks/);
        await p.fill('#runs-body input[data-filter-kind="search"]', "custom");
        await p.waitForFunction(() => document.querySelectorAll("#runs-body .run-row").length === 1, null, { timeout: 5000 });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("Ascensions: an open level lists every climber's record there; with one climber picked it does not, in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path);
      try {
        const runs = await seedFilterRuns(p, COOP_SEED);
        await p.evaluate(() => window.SpireVault.switchTab("ascensions"));
        await p.waitForSelector('#ascensions-body details[data-asc="10"]');
        await p.click('#ascensions-body details[data-asc="10"] > summary');
        const a10 = pickRuns(runs, { mode: "standard", asc: 10 });
        const want = {};
        for (const r of a10) {
          const w = want[r.character] || { runs: 0, wins: 0 };
          want[r.character] = { runs: w.runs + 1, wins: w.wins + (r.won ? 1 : 0) };
        }
        const shown = await p.evaluate(() => {
          const row = document.querySelector('#ascensions-body details[data-asc="10"]');
          return {
            title: row.querySelector(".v-asc-climbers-title, .asc-climbers-title")?.textContent.trim() || "",
            lines: [...row.querySelectorAll(".v-asc-climber, .asc-climber")].map((li) => ({
              name: li.querySelector(".v-asc-climber-name, .asc-climber-name").textContent.trim(),
              rec: li.querySelector(".v-asc-climber-rec, .asc-climber-record").textContent.trim(),
              streak: li.querySelector(".v-asc-climber-streak b, .asc-climber-streak")?.textContent.replace(/\D+/g, "") || "",
            })),
            visible: row.querySelector(".v-asc-climbers, .asc-climbers")?.getBoundingClientRect().height > 0,
          };
        });
        assert.equal(shown.title, "Your climbers at A10", label);
        assert.ok(shown.visible, `${label}: the list shows once the row is open`);
        const pretty = (k) => (k === "fool" ? "The Fool" : k.charAt(0).toUpperCase() + k.slice(1));
        const expected = Object.entries(want).map(([k, w]) => ({ name: pretty(k), rec: label === "classic" ? `${w.wins}w / ${w.runs}r` : `${w.wins}W / ${w.runs} run${w.runs === 1 ? "" : "s"}` }));
        assert.deepEqual(shown.lines.map(({ name, rec }) => ({ name, rec })).sort((a, b) => a.name.localeCompare(b.name)), expected.sort((a, b) => a.name.localeCompare(b.name)), `${label}: one line per climber with A10 runs`);
        // Ironclad's newest A10 runs are wins (the seed's streak of 9 mostly at A10, then a co-op win).
        const iron = shown.lines.find((l) => l.name === "Ironclad");
        assert.ok(Number(iron?.streak) >= 2, `${label}: Ironclad's A10 streak shows (${iron?.streak})`);
        await p.click('#ascensions-body [data-stat-filter="spire.character"][data-value="ironclad"]');
        await p.waitForSelector('#ascensions-body details[data-asc="10"]');
        assert.equal(await p.locator("#ascensions-body .v-asc-climbers, #ascensions-body .asc-climbers").count(), 0, `${label}: one climber picked, no list`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });

  await check("the section filters fit a phone in both looks", async () => {
    for (const [label, path] of [["new look", "/?ui=next"], ["classic", CLASSIC_PATH]]) {
      const { context, page: p, errors } = await open(browser, path, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true });
      try {
        await seedFilterRuns(p, COOP_SEED);
        for (const tab of ["overview", "ascensions"]) {
          await p.evaluate((id) => window.SpireVault.switchTab(id), tab);
          await p.waitForSelector(`#${tab}-body [data-stat-filter]`);
          const problems = await p.evaluate((id) => {
            const out = [];
            const doc = document.documentElement;
            if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
            for (const el of document.querySelectorAll(`#${id}-body [data-stat-filter]`)) {
              const box = el.getBoundingClientRect();
              if (box.width === 0) continue;
              const name = `${el.dataset.statFilter}=${el.dataset.value ?? el.value}`;
              if (box.height < 43.5) out.push(`${name} is ${box.height.toFixed(1)}px tall`);
              if (el.tagName === "SELECT" && Number.parseFloat(getComputedStyle(el).fontSize) < 16) out.push(`${name} text under 16px (iOS zooms in)`);
            }
            return out;
          }, tab);
          assert.deepEqual(problems, [], `${label} ${tab}`);
        }
        // An open level's climber lines and the Runs tab's tags fit too.
        await p.evaluate(() => window.SpireVault.switchTab("ascensions"));
        await p.click('#ascensions-body details[data-asc="10"] > summary');
        const climberProblems = await p.evaluate(() => {
          const out = [];
          const doc = document.documentElement;
          if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
          for (const li of document.querySelectorAll('#ascensions-body details[data-asc="10"] :is(.v-asc-climber, .asc-climber)')) {
            const box = li.getBoundingClientRect();
            for (const part of li.children) {
              const r = part.getBoundingClientRect();
              if (r.width === 0) continue;
              if (r.right > box.right + 0.5 || r.left < box.left - 0.5) out.push(`${part.className} leaves its line`);
              if (part.scrollWidth > part.clientWidth + 0.5) out.push(`${part.className} is cut ("${part.textContent.trim()}")`);
            }
          }
          return out;
        });
        assert.deepEqual(climberProblems, [], `${label} A10 climbers`);
        await p.evaluate(() => window.SpireVault.switchTab("runs"));
        await p.waitForSelector('#runs-body [data-tag="coop"]');
        const tagProblems = await p.evaluate(() => {
          const out = [];
          const doc = document.documentElement;
          if (doc.scrollWidth > doc.clientWidth + 1) out.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
          for (const tag of document.querySelectorAll("#runs-body [data-tag]")) {
            const row = tag.closest(".run-row").getBoundingClientRect();
            const r = tag.getBoundingClientRect();
            if (r.right > row.right + 0.5) out.push(`a ${tag.dataset.tag} tag runs out of its row`);
          }
          for (const chip of document.querySelectorAll('#runs-body button[data-filter-kind="party"]')) {
            const r = chip.getBoundingClientRect();
            if (r.height < 43.5) out.push(`party chip ${chip.dataset.filterValue} is ${r.height.toFixed(1)}px tall`);
          }
          return out;
        });
        assert.deepEqual(tagProblems, [], `${label} Runs tags`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  });
}

// ---- Recent Runs: go by date (the mini calendar) ------------------------------

/** Opens Recent Runs in the new look and waits for the Date chip. */
async function openRunsTab(page) {
  await page.evaluate(() => window.SpireVault.switchTab("runs"));
  await page.waitForSelector('#runs-body [data-action="runs-date-open"]');
}

/** The calendar and the ledger as a reader sees them. */
function dateState(page) {
  return page.evaluate(() => {
    const dlg = document.getElementById("v-rcal");
    const chip = document.querySelector('#runs-body [data-action="runs-date-open"]');
    const focused = document.activeElement;
    /** "Nov 16, 2026 at 2:09 PM" → "2026-11-16" */
    const keyOf = (text) => {
      const d = new Date(text.split(" at ")[0]);
      return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    return {
      open: !!dlg?.open,
      mode: dlg?.dataset.mode || "",
      chip: chip?.textContent.replace(/\s+/g, " ").trim() || "",
      chipSet: chip?.getAttribute("data-set") || "",
      expanded: chip?.getAttribute("aria-expanded") || "",
      focusIsChip: focused === chip,
      focusDay: focused?.getAttribute?.("data-rcal-day") || "",
      month: dlg?.querySelector(".v-rcal-month-label span")?.textContent || "",
      summary: document.querySelector("#runs-body .v-runs-summary")?.textContent.replace(/\s+/g, " ").trim() || "",
      dayHeads: [...document.querySelectorAll("#runs-body .v-runs-day")].map((h) => h.textContent.trim()),
      rows: [...document.querySelectorAll("#runs-body .run-row")].map((r) => ({
        key: keyOf(r.querySelector(".v-run-date")?.textContent || ""),
        result: r.getAttribute("data-result"),
      })),
    };
  });
}

async function runDates(browser) {
  await check("runs date filter: the Date chip opens a calendar under it, dotted on the days you climbed; Esc closes and hands focus back", async () => {
    const { context, page, errors } = await open(browser, "/");
    try {
      await openRunsTab(page);
      const before = await dateState(page);
      assert.match(before.chip, /^Any date$/, "the chip starts at Any date");
      await page.click('[data-action="runs-date-open"]');
      await page.waitForSelector("#v-rcal[open] [data-rcal-day]");
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.target?.closest?.("#v-rcal")).map((a) => a.finished)));
      const geo = await page.evaluate(() => {
        const chip = document.querySelector('#runs-body [data-action="runs-date-open"]').getBoundingClientRect();
        const panel = document.querySelector("#v-rcal .v-rcal-panel").getBoundingClientRect();
        const dots = [...document.querySelectorAll("#v-rcal [data-rcal-day] .v-rcal-dot")];
        return {
          gap: panel.top - chip.bottom,
          leftDelta: panel.left - chip.left,
          inside: panel.left >= 0 && panel.right <= document.documentElement.clientWidth && panel.bottom <= innerHeight,
          dots: dots.length,
          dotsSayClimbs: dots.every((d) => /\d+ climbs?/.test(d.parentElement.getAttribute("aria-label") || "")),
          bare: [...document.querySelectorAll("#v-rcal [data-rcal-day]:not(:has(.v-rcal-dot))")]
            .every((b) => /no climbs/.test(b.getAttribute("aria-label") || "")),
          todayMarked: document.querySelectorAll('#v-rcal [aria-current="date"]').length,
          role: document.querySelector("#v-rcal table")?.getAttribute("role"),
        };
      });
      const open1 = await dateState(page);
      assert.equal(open1.mode, "popover", "a wide screen gets the popover");
      assert.equal(open1.expanded, "true");
      assert.ok(geo.gap >= 4 && geo.gap <= 12, `the popover hangs just under the chip (gap ${geo.gap.toFixed(1)}px)`);
      assert.ok(Math.abs(geo.leftDelta) <= 1, `and lines up with its left edge (off by ${geo.leftDelta.toFixed(1)}px)`);
      assert.ok(geo.inside, "the popover is fully on screen");
      assert.ok(geo.dots > 0, "days with climbs carry a dot");
      assert.ok(geo.dotsSayClimbs && geo.bare, "every day says its climbs to a screen reader");
      assert.equal(geo.todayMarked, 1, "today is marked aria-current");
      assert.equal(geo.role, "grid");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.getElementById("v-rcal")?.open);
      const closed = await dateState(page);
      assert.equal(closed.focusIsChip, true, "focus is back on the chip");
      assert.equal(closed.expanded, "false");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("runs date filter: two days make a range that filters the ledger with the other filters; chip, count line and day dividers say it; × clears", async () => {
    const { context, page, errors } = await open(browser, "/");
    try {
      await openRunsTab(page);
      const all = await dateState(page);
      const total = Number(/All (\d+) runs/.exec(all.summary)?.[1]);
      assert.ok(total > 0, `the count line reads "All N runs" (${all.summary})`);
      await page.click('#runs-body [data-filter-kind="outcome"][data-filter-value="losses"]');
      await page.click('#runs-body [data-action="runs-date-open"]');
      await page.waitForSelector("#v-rcal[open] [data-rcal-day]");
      const days = await page.$$eval("#v-rcal [data-rcal-day]:not([disabled])", (els) => els.map((e) => e.getAttribute("data-rcal-day")));
      const [from, to] = [days[Math.max(0, days.length - 9)], days[Math.max(0, days.length - 3)]];
      await page.click(`#v-rcal [data-rcal-day="${to}"]`);
      await page.click(`#v-rcal [data-rcal-day="${from}"]`);
      const banded = await page.$$eval("#v-rcal td.is-in", (tds) => tds.length);
      assert.equal(banded, 7, "picked in either order, the band covers the seven days");
      await page.click("#v-rcal [data-rcal-done]");
      await page.waitForFunction(() => !document.getElementById("v-rcal")?.open);
      const s = await dateState(page);
      assert.ok(s.rows.length > 0, "the range has runs in the sample data");
      assert.ok(s.rows.every((r) => r.key >= from && r.key <= to), `every run is inside ${from}…${to}: ${s.rows.map((r) => r.key).join(", ")}`);
      assert.ok(s.rows.every((r) => r.result !== "win"), "and the Losses filter still holds");
      assert.equal(s.chipSet, "true", "the chip turns gold");
      assert.doesNotMatch(s.chip, /Any date/);
      assert.match(s.summary, new RegExp(`Showing ${s.rows.length} of ${total} runs · ${s.chip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `the count line names the range (${s.summary})`);
      assert.ok(s.dayHeads.length >= 1 && s.dayHeads.every((h) => /^(Today|Yesterday|\w+day, \w{3} \d{1,2})$/.test(h)), `one divider per day: ${s.dayHeads.join(" | ")}`);
      await page.click('#runs-body [data-action="runs-date-clear"]');
      const cleared = await dateState(page);
      assert.match(cleared.chip, /^Any date$/, "× puts the chip back to Any date");
      assert.equal(cleared.focusIsChip, true, "and focus lands on the chip");
      assert.match(cleared.summary, new RegExp(`of ${total} runs`), "the Losses filter alone is left");
      assert.doesNotMatch(cleared.summary, /·/, "no range in the count line");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("runs date filter: keyboard — Enter opens on a day, arrows and PageUp move, Enter picks, a quick pick applies and closes", async () => {
    const { context, page, errors } = await open(browser, "/");
    try {
      await openRunsTab(page);
      await page.focus('#runs-body [data-action="runs-date-open"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("#v-rcal[open] [data-rcal-day]");
      const start = (await dateState(page)).focusDay;
      assert.match(start, /^\d{4}-\d{2}-\d{2}$/, "focus lands on a day");
      const shift = (key, days) => {
        const [y, m, d] = key.split("-").map(Number);
        const t = new Date(y, m - 1, d + days);
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      };
      await page.keyboard.press("ArrowLeft");
      assert.equal((await dateState(page)).focusDay, shift(start, -1), "← is the day before");
      await page.keyboard.press("ArrowUp");
      assert.equal((await dateState(page)).focusDay, shift(start, -8), "↑ is a week earlier");
      const monthBefore = (await dateState(page)).month;
      await page.keyboard.press("PageUp");
      const turned = await dateState(page);
      assert.notEqual(turned.month, monthBefore, "PageUp turns to the month before");
      assert.equal(turned.focusDay.slice(0, 7) < shift(start, -8).slice(0, 7), true, "and the focus goes with it");
      await page.keyboard.press("Enter");
      const picked = await dateState(page);
      assert.equal(picked.open, true, "one day picked: still open for a second");
      assert.ok(picked.rows.every((r) => r.key === turned.focusDay), "the ledger shows that day only");
      // The month arrows keep focus when the heading redraws (or hand it to
      // the grid once the arrow has run out of months).
      await page.focus('#v-rcal [data-rcal-step="1"]');
      await page.keyboard.press("Enter");
      const arrowFocus = await page.evaluate(() => {
        const a = document.activeElement;
        return a?.getAttribute("data-rcal-step") || (a?.hasAttribute("data-rcal-day") ? "day" : a?.tagName || "none");
      });
      assert.ok(arrowFocus === "1" || arrowFocus === "day", `focus stays put after turning the month (on ${arrowFocus})`);
      await page.click('#v-rcal [data-rcal-preset="week"]');
      await page.waitForFunction(() => !document.getElementById("v-rcal")?.open);
      const week = await dateState(page);
      assert.equal(week.chip, "Last 7 days");
      assert.equal(week.focusIsChip, true);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  for (const width of [375, 320]) {
    await check(`runs date filter (phone ${width}px): a bottom sheet, every control a 44px target, nothing off-screen`, async () => {
      const { context, page, errors } = await open(browser, "/", { viewport: { width, height: 812 }, hasTouch: true });
      try {
        await openRunsTab(page);
        const chip = await page.evaluate(() => {
          const r = document.querySelector('#runs-body [data-action="runs-date-open"]').getBoundingClientRect();
          return { w: r.width, h: r.height };
        });
        assert.ok(chip.h >= 44, `the Date chip is ${chip.h}px tall`);
        await page.tap('#runs-body [data-action="runs-date-open"]');
        await page.waitForSelector("#v-rcal[open] [data-rcal-day]");
        await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.target?.closest?.("#v-rcal")).map((a) => a.finished)));
        const sheet = await page.evaluate(() => {
          const panel = document.querySelector("#v-rcal .v-rcal-panel").getBoundingClientRect();
          const small = [...document.querySelectorAll("#v-rcal .v-rcal-panel button:not([disabled])")]
            .map((b) => ({ b, r: b.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && (r.width < 43.5 || r.height < 43.5))
            .map(({ b, r }) => `${b.getAttribute("data-rcal-day") || b.textContent.trim() || b.getAttribute("aria-label")} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
          const cut = [...document.querySelectorAll("#v-rcal .v-rcal-panel *")]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -0.5 || r.right > innerWidth + 0.5); })
            .map((el) => el.className || el.tagName);
          return {
            mode: document.getElementById("v-rcal").dataset.mode,
            bottomGap: innerHeight - panel.bottom,
            left: panel.left,
            right: innerWidth - panel.right,
            small,
            cut,
          };
        });
        assert.equal(sheet.mode, "sheet");
        assert.ok(Math.abs(sheet.bottomGap) <= 1, `the sheet sits on the bottom edge (gap ${sheet.bottomGap}px)`);
        assert.ok(sheet.left >= -0.5 && sheet.right >= -0.5, "and spans the screen without spilling");
        assert.deepEqual(sheet.small, [], "no control under 44px");
        assert.deepEqual(sheet.cut, [], "nothing runs off the sides");
        await page.tap("#v-rcal .v-rcal-x");
        await page.waitForFunction(() => !document.getElementById("v-rcal")?.open);
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains("v-rcal-lock")), false, "the page scrolls again once it closes");
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }

  await check("runs date filter: classic has no Date chip and is not filtered by a date picked in the new look", async () => {
    const { context, page, errors } = await open(browser, CLASSIC_PATH);
    try {
      await page.evaluate(() => window.SpireVault.switchTab("runs"));
      await page.waitForSelector("#runs-body .run-filters");
      assert.equal(await page.locator('[data-action="runs-date-open"]').count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}


// ---- Whose side of a co-op run is shown ------------------------------------------
// A co-op save lists every player and does not mark the local one. The reader
// took the first until 2026-11-22, so a player who joined a friend's game saw
// the friend's climber. These go through the real import (the folder input).

/** A friend's Steam ID, listed first in the co-op save: the friend hosted. */
const COOP_FRIEND = "76561198000004177";

/** A save's text the way the game writes it: player ids as bare 64-bit numbers. */
function coopSaveText(players, start) {
  const isMe = (id) => id === TEST_SESSION.steamID;
  const climber = (id) => (isMe(id) ? "SILENT" : "IRONCLAD");
  const entry = (id) => `{"character":"CHARACTER.${climber(id)}","deck":[{"id":"CARD.STRIKE_${climber(id)}","current_upgrade_level":0}],"id":${id},"max_potion_slot_count":3,"potions":[],"relics":[{"id":"RELIC.BURNING_BLOOD"}]}`;
  const stats = (id) => `{"card_choices":[{"card":{"id":"CARD.${isMe(id) ? "BLADE_DANCE" : "INFLAME"}"},"was_picked":true}],"current_gold":99,"current_hp":40,"max_hp":80,"player_id":${id}}`;
  return `{"acts":["ACT.OVERGROWTH"],"ascension":3,"build_id":"v0.113.0","game_mode":"standard","killed_by_encounter":"NONE.NONE","map_point_history":[[{"map_point_type":"monster","player_stats":[${players.map(stats).join(",")}],"rooms":[{"room_type":"monster"}]}]],"platform_type":"steam","players":[${players.map(entry).join(",")}],"run_time":900,"schema_version":11,"seed":"COOPSEED","start_time":${start},"was_abandoned":false,"win":true}`;
}

/** Another friend, for imports where the saves themselves tell who the local player is. */
const COOP_FRIEND_2 = "76561198000090211";

/**
 * A save folder on disk with co-op runs friends hosted.
 * @param {"account" | "history"} level what the player will pick: the folder
 *   that holds `steam/<id>/…`, or the history folder by itself
 * @param {string[][]} [parties] each run's players in the save's order
 * @returns {{ pick: string, dispose: () => void }}
 */
function coopSaveFolder(level, parties = [[COOP_FRIEND, TEST_SESSION.steamID]]) {
  const root = mkdtempSync(join(tmpdir(), "vault-coop-owner-"));
  const history = join(root, "SlayTheSpire2", "steam", TEST_SESSION.steamID, "profile1", "saves", "history");
  mkdirSync(history, { recursive: true });
  parties.forEach((players, i) => {
    const start = 1790000000 + i * 86_400;
    writeFileSync(join(history, `${start}.run`), coopSaveText(players, start));
  });
  return { pick: level === "account" ? join(root, "SlayTheSpire2") : history, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** What the app shows once an import lands: the status line (Overview has it) and each run's climber. */
async function shownAfterImport(page) {
  await page.waitForFunction(() => window.SpireVault.activeTab() === "overview"
    && [...document.querySelectorAll("[data-sync-pill]")].some((el) => el.getClientRects().length > 0 && el.textContent.trim()), null, { timeout: BOOT_TIMEOUT_MS });
  const status = await page.evaluate(() => [...document.querySelectorAll("[data-sync-pill]")]
    .find((el) => el.getClientRects().length > 0)?.textContent.replace(/\s+/g, " ").trim() ?? "");
  await page.evaluate(() => window.SpireVault.switchTab("runs"));
  await page.waitForSelector("#runs-body .run-row");
  const climbers = await page.evaluate(() => [...document.querySelectorAll("#runs-body .run-row")].map((row) => row.dataset.char));
  return { status, climbers };
}

/** Linux Chrome: the one desktop where the app opens the browser's own folder picker. */
const LINUX_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function runCoopOwner(browser) {
  await check("a co-op run a friend hosted shows your own climber when the folder says whose saves they are", async () => {
    const folder = coopSaveFolder("account");
    const { context, page, errors } = await open(browser, "/?ui=next");
    try {
      await page.setInputFiles("#history-folder-input", folder.pick);
      const shown = await shownAfterImport(page);
      assert.deepEqual(shown.climbers, ["silent"], "the local player's climber, not the host's Ironclad");
      assert.match(shown.status, /^Saves read /);
      assert.doesNotMatch(shown.status, /teammate/, "nothing to warn about");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      folder.dispose();
    }
  });

  await check("with only the history folder and nobody signed in, it is the first player, and the status says how to fix it", async () => {
    const folder = coopSaveFolder("history");
    const { context, page, errors } = await open(browser, "/?ui=next");
    try {
      await page.setInputFiles("#history-folder-input", folder.pick);
      const shown = await shownAfterImport(page);
      assert.deepEqual(shown.climbers, ["ironclad"], "nothing says who the local player is");
      assert.match(shown.status, /1 co-op run may show a teammate's climber\. Refresh your saves to fix\./);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      folder.dispose();
    }
  });

  await check("signed in with Steam, the history folder alone is enough", async () => {
    const folder = coopSaveFolder("history");
    const { context, page, errors } = await open(browser, "/?ui=next", { signedIn: true });
    try {
      await page.setInputFiles("#history-folder-input", folder.pick);
      const shown = await shownAfterImport(page);
      assert.deepEqual(shown.climbers, ["silent"]);
      assert.doesNotMatch(shown.status, /teammate/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      folder.dispose();
    }
  });

  await check("with nothing else to go on, the saves vote: you are the player in most of them", async () => {
    const folder = coopSaveFolder("history", [[COOP_FRIEND, TEST_SESSION.steamID], [COOP_FRIEND_2, TEST_SESSION.steamID]]);
    const { context, page, errors } = await open(browser, "/?ui=next");
    try {
      await page.setInputFiles("#history-folder-input", folder.pick);
      const shown = await shownAfterImport(page);
      assert.deepEqual(shown.climbers, ["silent", "silent"], "both friends' games show the local player");
      assert.doesNotMatch(shown.status, /teammate/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      folder.dispose();
    }
  });

  await check("a dropped SlayTheSpire2 folder says whose saves they are too", async () => {
    const { context, page, errors } = await open(browser, "/?ui=next");
    try {
      await page.evaluate(({ text, me }) => {
        // A dropped folder reaches a page as entries; these stand in for the browser's.
        const fileEntry = (name, fullPath) => ({ isFile: true, isDirectory: false, name, fullPath, file: (done) => done(new File([text], name)) });
        const dirEntry = (name, fullPath, children) => ({
          isFile: false, isDirectory: true, name, fullPath,
          createReader: () => { let read = false; return { readEntries: (done) => { done(read ? [] : children); read = true; } }; },
        });
        const parts = ["SlayTheSpire2", "steam", me, "profile1", "saves", "history"];
        let entry = fileEntry("1790000000.run", `/${parts.join("/")}/1790000000.run`);
        for (let depth = parts.length; depth > 0; depth--) entry = dirEntry(parts[depth - 1], `/${parts.slice(0, depth).join("/")}`, [entry]);
        const drop = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [], items: [{ kind: "file", webkitGetAsEntry: () => entry }] } });
        window.dispatchEvent(drop);
      }, { text: coopSaveText([COOP_FRIEND, TEST_SESSION.steamID], 1790000000), me: TEST_SESSION.steamID });
      const shown = await shownAfterImport(page);
      assert.deepEqual(shown.climbers, ["silent"]);
      assert.doesNotMatch(shown.status, /teammate/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });

  await check("so does a folder picked in the browser's own folder picker", async () => {
    const { context, page, errors } = await open(browser, "/?ui=next", { userAgent: LINUX_CHROME });
    try {
      await page.evaluate(async ({ text, me }) => {
        // The browser's private folder store gives a real folder handle to walk.
        const root = await navigator.storage.getDirectory();
        let dir = root;
        for (const name of ["steam", me, "profile1", "saves", "history"]) dir = await dir.getDirectoryHandle(name, { create: true });
        const writer = await (await dir.getFileHandle("1790000000.run", { create: true })).createWritable();
        await writer.write(text);
        await writer.close();
        window.showDirectoryPicker = async () => root;
        // The app asks the platform as well as the user agent which desktop this is.
        Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "Linux x86_64" });
        document.querySelector('[data-action="scan"]').click();
      }, { text: coopSaveText([COOP_FRIEND, TEST_SESSION.steamID], 1790000000), me: TEST_SESSION.steamID });
      const shown = await shownAfterImport(page);
      assert.deepEqual(shown.climbers, ["silent"]);
      assert.doesNotMatch(shown.status, /teammate/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
}

const GROUPS = Object.freeze({
  owner: runCoopOwner,
  dates: runDates,
  saves: runSaves,
  core: run,
  coop: runCoop,
  duel: runDuel,
  brand: runBrand,
  switch: runBetaSwitch,
  lock: runLock,
  parity: runParity,
  news: runNewsPost,
  scene: runScene,
  share: runShare,
  cards: runCards,
  widths: runWidths,
  arrange: runArrange,
  filters: runStatFilters,
});

/** @returns {string[]} the group names to run */
function selectedGroups() {
  const index = process.argv.indexOf("--only");
  if (index === -1) return Object.keys(GROUPS);
  const wanted = (process.argv[index + 1] || "").split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = wanted.filter((name) => !(name in GROUPS));
  if (wanted.length === 0 || unknown.length > 0) {
    throw new Error(`--only takes a comma-separated list of: ${Object.keys(GROUPS).join(", ")}`);
  }
  return wanted;
}

async function main() {
  const groups = selectedGroups();
  const server = await startServer();
  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const name of groups) await GROUPS[name](browser);
  } catch {
    failed = true;
  } finally {
    await browser.close();
    server.kill();
  }
  process.stdout.write(failed ? `\nverify-ui-next: FAILED after ${passed} passing checks\n` : `\nverify-ui-next: all ${passed} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`verify-ui-next crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
