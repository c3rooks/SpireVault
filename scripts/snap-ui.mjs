#!/usr/bin/env node
/**
 * Captures screenshots of the web app for design review.
 *
 * Drives a local server (default: `node Web/scripts/dev-static.mjs`, which is
 * started automatically unless --base-url is given) and writes PNGs for each
 * combination of layout, theme, tab and viewport.
 *
 *   node scripts/snap-ui.mjs                       # the design-lock set
 *   node scripts/snap-ui.mjs --themes inked,vault --tabs overview --widths 1440,375
 *   node scripts/snap-ui.mjs --ui classic --tabs overview --out /tmp/classic
 *   node scripts/snap-ui.mjs --viewport-only       # above-the-fold instead of full page
 *   node scripts/snap-ui.mjs --viewport-only --picker --scale 2   # theme picker open, retina
 *   node scripts/snap-ui.mjs --stage-only --scale 2 --seed 3      # just the header stage; --seed fixes the random line
 *
 * This is a review aid, not a regression test — it has no assertions. The
 * assertion-bearing suite lives under tests/ui.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8799;
const VIEWPORT_HEIGHT = 900;
const MOBILE_MAX_WIDTH = 480;
const SETTLE_MS = 2400;
const SERVER_BOOT_TIMEOUT_MS = 10000;

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** @param {string} value */
function list(value) {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

const options = {
  ui: arg("ui", "next"),
  themes: list(arg("themes", "inked,vault,silent")),
  tabs: list(arg("tabs", "overview")),
  widths: list(arg("widths", "1440,1024,768,375")).map(Number),
  outDir: arg("out", join(REPO_ROOT, "docs", "screenshots", "ui-next")),
  baseUrl: arg("base-url", ""),
  companion: arg("companion", "ironclad"),
  viewportOnly: process.argv.includes("--viewport-only"),
  stageOnly: process.argv.includes("--stage-only"),
  openPicker: process.argv.includes("--picker"),
  scale: Number(arg("scale", "0")),
  seed: Number(arg("seed", "0")),
};

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

/**
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 * @param {{ theme: string, tab: string, width: number }} shot
 */
async function capture(browser, baseUrl, shot) {
  const isMobile = shot.width <= MOBILE_MAX_WIDTH;
  const context = await browser.newContext({
    viewport: { width: shot.width, height: VIEWPORT_HEIGHT },
    deviceScaleFactor: options.scale || (isMobile ? 2 : 1),
    hasTouch: isMobile,
  });
  // A fixed companion keeps the header comparable between shots.
  await context.addInitScript((companion) => {
    try {
      window.localStorage.setItem("vault.web.companion.v2", companion);
    } catch {
      /* storage unavailable: the companion is rolled randomly */
    }
  }, options.companion);
  // The header's line (and who says it) is rolled with Math.random; a seed
  // makes a run repeatable so two captures can be compared.
  if (options.seed) {
    await context.addInitScript((seed) => {
      let state = seed >>> 0;
      Math.random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }, options.seed);
  }
  // Hermetic: no analytics or third-party requests from screenshot runs.
  await context.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    (route) => route.abort()
  );
  const page = await context.newPage();
  const params = new URLSearchParams({ ui: options.ui });
  if (options.ui === "next") params.set("theme", shot.theme);
  await page.goto(`${baseUrl}/?${params}`, { waitUntil: "domcontentloaded" });
  // Route through the host bridge rather than ?tab=: on a local dev host the
  // app's fast first paint normalises the URL before boot reads the deep link.
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub);
  await page.waitForSelector(".demo-banner, .v-ov, .kpi-strip, .empty-state", { timeout: 15000 }).catch(() => {});
  if (shot.tab !== "overview") {
    await page.evaluate((tab) => window.SpireVault.switchTab(tab), shot.tab);
  }
  await page.waitForSelector(`.tab-panel[data-tab="${shot.tab}"]:not([hidden])`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(SETTLE_MS);
  if (!options.viewportOnly && !options.stageOnly) {
    // Grow the viewport to the document so sticky chrome (the rail) spans
    // the whole capture, as it would while scrolling.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: shot.width, height: Math.max(VIEWPORT_HEIGHT, height) });
    await page.waitForTimeout(300);
  }
  if (options.openPicker) {
    await page.click(".sidebar-brand .v-theme-btn");
    await page.waitForSelector("#v-theme-pop");
    await page.waitForTimeout(400);
  }
  const suffix = options.ui === "next" ? shot.theme : "classic";
  const name = options.openPicker ? "themes" : shot.tab;
  const file = join(options.outDir, `${name}-${suffix}-${shot.width}.png`);
  if (options.stageOnly) {
    const head = page.locator(`.tab-panel[data-tab="${shot.tab}"] > .panel-head`);
    const box = await head.boundingBox();
    if (!box) throw new Error(`no panel head found for tab ${shot.tab}`);
    // A little of the page below, to judge how the ledge meets the content.
    await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: box.width, height: box.height + 24 } });
  } else {
    await page.screenshot({ path: file, fullPage: !options.viewportOnly });
  }
  await context.close();
  return file;
}

async function main() {
  mkdirSync(options.outDir, { recursive: true });
  const server = options.baseUrl ? null : await startServer();
  const baseUrl = options.baseUrl || `http://127.0.0.1:${DEFAULT_PORT}`;
  const browser = await chromium.launch();
  const themes = options.ui === "next" ? options.themes : ["classic"];
  try {
    for (const theme of themes) {
      for (const tab of options.tabs) {
        for (const width of options.widths) {
          const file = await capture(browser, baseUrl, { theme, tab, width });
          process.stdout.write(`${file}\n`);
        }
      }
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`snap-ui failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
