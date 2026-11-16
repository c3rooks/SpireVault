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
 * one-word brand, the opt-in beta switch (Settings, Beta tab, news post), and
 * parity: the new Overview shows every number the classic one does.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
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
const BETA_NEWS_ID = "013";
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

/** @param {string} name @param {() => Promise<void>} fn */
async function check(name, fn) {
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
 *   routes:   request mocks installed before the page boots (the static
 *             server has no /api)
 */
async function open(browser, path, options = {}) {
  const { abort, signedIn, freshVisitor, routes = [], ...contextOptions } = options;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOptions });
  if (!freshVisitor) {
    await context.addInitScript((key) => {
      try { window.localStorage.setItem(key, "seen"); } catch { /* storage blocked */ }
    }, NOTICE_KEY);
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
    assert.equal(await page.$("#overview-body .v-ov"), null);
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
    assert.equal(await page.$("#overview-body .kpi-strip"), null);
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
        flames: root.querySelectorAll(".v-torch-flame").length,
        embers: root.querySelectorAll(".v-torch-ember").length,
        spireLabel: root.querySelector(".v-spire").getAttribute("aria-label"),
      };
    });
    const model = await page.evaluate(() => {
      const chips = [...document.querySelectorAll(".v-wr-chips .v-chip")].map((el) => el.textContent);
      const tenText = document.querySelector(".v-path-head span").textContent;
      return { highest: Number(/A(\d+)/.exec(chips[0])[1]), wins: Number(/(\d+)W/.exec(tenText)[1]), losses: Number(/(\d+)L/.exec(tenText)[1]) };
    });
    assert.equal(stage.lit, model.highest + 1, "one lit window per ascension reached, A0 included");
    assert.ok(stage.windows >= 11);
    assert.equal(stage.flames, model.wins);
    assert.equal(stage.embers, model.losses);
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
    assert.equal(await page.$("#v-theme-pop"), null);
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
    assert.equal(await p.$("#v-theme-pop"), null);
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
      assert.match(title, /^(\(\d+\) )?SpireVault · /, `tab title was "${title}"`);
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
    // (Relics only render when the data has some; the demo data does.)
    const sections = ["v-hand", "v-ov-top", "v-ov-charts", "v-relics"];
    const order = await next.page.$$eval(
      "#overview-body .v-ov > *",
      (els, names) => els.map((el) => names.find((name) => el.classList.contains(name))).filter(Boolean),
      sections
    );
    assert.deepEqual(order, sections.filter((name) => order.includes(name)));
    assert.deepEqual(order.slice(0, 3), sections.slice(0, 3));
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
    // A row far down the page keeps its small face (no fetch for a card no
    // one can see) until it nears the screen; then its large face arrives
    // without any hover, so the card never grows blurry first.
    const row = p.locator(".v-cd-row").last();
    const image = await row.locator(".v-cd-thumb img").elementHandle();
    assert.equal(await image.evaluate((img) => img.hasAttribute("data-hd")), true, "a far row has not fetched its large face");
    await row.scrollIntoViewIfNeeded();
    await p.waitForFunction((img) => img.complete && img.naturalWidth === 410, image);
    assert.equal(await image.evaluate((img) => img.hasAttribute("data-hd")), false, "the swap happens once");
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
      figures: document.querySelectorAll(".cp-scene .cp-climber").length,
      seats: document.querySelectorAll(".cp-scene .cp-seat").length,
      stones: document.querySelectorAll(".cp-scene .cp-stone").length,
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
    assert.equal(await p.$('[data-cp-pick="fool"]'), null);
    await p.click('[data-cp-branch="beta"]');
    assert.notEqual(await p.$('[data-cp-pick="fool"]'), null);
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

const GROUPS = Object.freeze({
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
