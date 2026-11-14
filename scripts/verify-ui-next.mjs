#!/usr/bin/env node
/**
 * Behavioural checks for the new UI ("next") and for the promise that the
 * classic layout is untouched unless a visitor opts in.
 *
 * Starts Web/scripts/dev-static.mjs (which enforces the production CSP),
 * drives it with Playwright and exits non-zero on the first failed check.
 *
 *   node scripts/verify-ui-next.mjs
 *
 * Covers: default variant, opt-in and URL tidy-up, the DOM contract other
 * code depends on, the data-driven stage, sticky rail, instant theme
 * switching and persistence, deep links, reduced motion, desktop-host mode
 * and the host bridge, the load-failure fallback, analytics tagging,
 * horizontal overflow across breakpoints, the header duel's staging, the
 * one-word brand, and the opt-in beta switch (Settings, Beta tab, news post).
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 20000;
const WIDTHS = [320, 375, 768, 1024, 1440, 1920];
const TAB_IDS = ["overview", "characters", "ascensions", "relics", "cards", "runs", "coop", "highlights", "news", "overlay", "beta", "settings"];
const NAV_TAB_COUNT = 10;
const THEME_COUNT = 8;
const CLIMBER_IDS = ["ironclad", "silent", "defect", "regent", "necrobinder"];
const BETA_NEWS_ID = "013";
/** The brand is one word. These spellings must not reach a visitor. */
const OLD_BRAND = /Spire Vault|The Vault/;
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
 * @param {import("playwright").BrowserContextOptions & { abort?: string }} [options]
 */
async function open(browser, path, options = {}) {
  const { abort, ...contextOptions } = options;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...contextOptions });
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
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
  await page.waitForSelector("#overview-body .v-ov, #overview-body .kpi-strip", { timeout: BOOT_TIMEOUT_MS });
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
  // ---- Classic is the default and loads none of the new UI ----------------
  await check("classic is the default; no new-UI assets are requested", async () => {
    const { context, page, requests, errors } = await open(browser, "/");
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
    assert.equal(await page.locator(".v-char").count(), 5);
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

  // ---- Legacy CSS layering ---------------------------------------------------
  await check("runtime co-op stylesheets join the legacy layer, once each", async () => {
    const { context, page: p } = await open(browser, "/?ui=next");
    for (let visit = 0; visit < 2; visit += 1) {
      await p.evaluate(() => window.SpireVault.switchTab("coop"));
      await p.waitForTimeout(1500);
      await p.evaluate(() => window.SpireVault.switchTab("overview"));
    }
    const state = await p.evaluate(() => {
      const links = [...document.querySelectorAll('link[rel="stylesheet"]')].filter((link) =>
        new URL(link.href).pathname.startsWith("/lib/")
      );
      const layered = [...document.querySelectorAll("style[data-v-layer-for]")].map((style) => style.dataset.vLayerFor);
      return {
        links: links.length,
        live: links.filter((link) => link.media !== "not all").length,
        layered: layered.length,
        unique: new Set(layered).size,
      };
    });
    assert.ok(state.links > 0, "expected the co-op tab to inject stylesheets");
    assert.equal(state.live, 0, "an injected stylesheet is still unlayered");
    assert.equal(state.layered, state.links);
    assert.equal(state.unique, state.layered, "a stylesheet was layered more than once");
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
      float: parseFloat(getComputedStyle(head).getPropertyValue("--duel-float")),
      gapToken: parseFloat(getComputedStyle(head).getPropertyValue("--duel-gap")),
      artCount: images.length,
      artLoaded: images.every((img) => img.complete && img.naturalWidth > 0),
      artInked: images.every((img) => (img.getAttribute("src") || "").startsWith("/assets/stage/")),
    };
  });
}

/**
 * Staging rules that hold at every width: the two figures are inked, the
 * climber stands left of the boss, both share one ground line (the boss
 * hovers `--duel-float` above it) inside the header, and the line of speech
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
  assert.ok(Math.abs(g.climber.bottom - (g.boss.bottom + g.float)) <= 1, `${label}: both figures share one ground line`);
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

  await check("the classic header keeps the game's original sprites", async () => {
    const { context, page: p, requests } = await open(browser, "/");
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
  for (const [label, path] of [["classic", "/"], ["new look", "/?ui=next"]]) {
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
  await page.waitForSelector(variant === "next" ? "#overview-body .v-ov" : "#overview-body .kpi-strip", {
    timeout: BOOT_TIMEOUT_MS,
  });
}

async function runBetaSwitch(browser) {
  await check("the desktop shells default to classic as well", async () => {
    const { context, page: p } = await open(browser, "/?desktop=1");
    assert.equal((await htmlState(p)).ui, "classic");
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
    const { context, page: p, errors } = await open(browser, "/");
    await p.evaluate(() => window.SpireVault.switchTab("settings"));
    const optIn = '#settings-body [data-ui-beta-card] [data-action="ui-set"][data-ui="next"]';
    await p.waitForSelector(optIn);
    await switchLayout(p, optIn, "next");
    assert.deepEqual(await htmlState(p), { ui: "next", theme: "inked", search: "" });
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "next");
    assert.ok(await p.$('.tab-panel[data-tab="overview"]:not([hidden])'), "opting in lands on Overview");

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
    const { context, page: p } = await open(browser, "/");
    await p.evaluate(() => window.SpireVault.setUI("next"));
    await p.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
    assert.equal(await p.evaluate(() => window.SpireVault.setUI("sideways")), false);
    await p.click(".sidebar-brand .v-theme-btn");
    await switchLayout(p, '#v-theme-pop [data-action="ui-set"][data-ui="classic"]', "classic");
    assert.equal(await p.evaluate(() => localStorage.getItem("vault.web.ui")), "classic");
    await context.close();
  });

  for (const [label, path, target] of [["classic", "/", "next"], ["new look", "/?ui=next", "classic"]]) {
    await check(`the Beta tab carries the switch and keeps it through re-renders (${label})`, async () => {
      const { context, page: p } = await open(browser, path);
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

async function runNewsPost(browser) {
  // Newer posts (014: The Fool) have since landed above it, so the beta post
  // is no longer the one that opens by default; it only has to be listed,
  // open from the list, and have working switches.
  await check("the beta news post is listed, News is flagged NEW, and the post's switches work", async () => {
    const { context, page: p, errors } = await open(browser, "/");
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
    const { context, page: p } = await open(browser, "/");
    await p.evaluate(() => window.SpireVault.switchTab("settings"));
    await p.click('#settings-body [data-action="ui-open-news"]');
    await p.waitForSelector(`#news-${BETA_NEWS_ID}`);
    assert.ok(await p.locator(`#news-${BETA_NEWS_ID}`).isVisible());
    assert.ok(await p.$('.tab-panel[data-tab="news"]:not([hidden])'));
    await context.close();
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();
  let failed = false;
  try {
    await run(browser);
    await runDuel(browser);
    await runBrand(browser);
    await runBetaSwitch(browser);
    await runNewsPost(browser);
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
