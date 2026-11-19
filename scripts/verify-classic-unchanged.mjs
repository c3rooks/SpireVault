#!/usr/bin/env node
/**
 * Proves that uncommitted work has not changed the CLASSIC layout.
 *
 * The redesign ships opt-in, so everyone who has not opted in must keep
 * seeing exactly what they saw before. This renders the classic layout twice
 * under identical conditions — once from the last commit's `Web/index.html`
 * and `Web/script.js`, once from the working tree — and compares the pixels
 * tab by tab.
 *
 *   node scripts/verify-classic-unchanged.mjs
 *   node scripts/verify-classic-unchanged.mjs --tabs overview,runs
 *   node scripts/verify-classic-unchanged.mjs --width 375               # the phone layout (default is 1440)
 *   node scripts/verify-classic-unchanged.mjs --allow 76,27,185,42      # x0,y0,x1,y1; join several with ";"
 *   node scripts/verify-classic-unchanged.mjs --out /tmp/classic-diff    # keep both sets of PNGs
 *
 * Exits non-zero if any tab still differs outside the `--allow` rectangles
 * after being rendered again (a late-arriving thumbnail is not a change). Use
 * `--allow` for a change that is meant to be visible to everyone (say why in
 * the commit message); intended changes to a whole tab are better left out
 * of `--tabs`.
 *
 * Only index.html and script.js are taken from the commit. Everything else
 * (styles.css, lib/, assets) is served from the working tree, which is right
 * as long as those are either unchanged or not loaded by the classic layout —
 * `make -C Web preflight` guards the immutable ones.
 *
 * Both renders share a seeded Math.random, a fixed clock and a fixed
 * companion, block third-party requests, and disable animations, so the only
 * thing that can differ is the code under test.
 */

import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** VERIFY_CLASSIC_PORT moves the test server when 8794 is taken (another session's run). */
const PORT = Number(process.env.VERIFY_CLASSIC_PORT) || 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const DEFAULT_TABS = "overview,characters,ascensions,relics,cards,runs,coop,highlights";
const BOOT_TIMEOUT_MS = 20000;
const TAB_SETTLE_MS = 1200;
const RESIZE_SETTLE_MS = 300;
const IMAGE_TIMEOUT_MS = 8000;
/** How long one image may take to decode before the capture goes ahead without it. */
const IMAGE_DECODE_TIMEOUT_MS = 3000;
/** A differing tab is rendered again this many times before it counts. */
const MAX_RETRIES = 2;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Per-pixel channel-sum difference below this is rendering noise. */
const PIXEL_TOLERANCE = 6;
const RANDOM_SEED = 7;
/** One clock for both renders (relative dates in the demo data depend on it). */
const FIXED_NOW_MS = Date.UTC(2026, 10, 11, 18, 0, 0);

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** The width under test: `--width 375` checks the phone layout, which has its own CSS. */
function viewport() {
  const width = Number(arg("width", String(DEFAULT_WIDTH)));
  if (!Number.isInteger(width) || width < 240) throw new Error(`verify-classic-unchanged: --width ${arg("width", "")} is not a usable width`);
  return Object.freeze({ width, height: VIEWPORT_HEIGHT });
}

const VIEWPORT = viewport();

/** Parses `--allow "x0,y0,x1,y1;x0,y0,x1,y1"`. */
function allowedRegions() {
  return arg("allow", "")
    .split(";")
    .map((part) => part.split(",").map(Number))
    .filter((numbers) => numbers.length === 4 && numbers.every(Number.isFinite));
}

/** Reads one file from the last commit. Path-scoped, so it works on a repo with evicted pack data. */
function fromHead(path) {
  return execFileSync("git", ["show", `HEAD:${path}`], { cwd: REPO_ROOT, maxBuffer: GIT_MAX_BUFFER });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(PORT)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const timer = setTimeout(() => reject(new Error("dev-static did not start")), BOOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

/** Runs in the page before any app code: same dice, same clock, same companion. */
function pinEnvironment([seed, now]) {
  try {
    window.localStorage.setItem("vault.web.companion.v2", "ironclad");
  } catch {
    /* storage unavailable: nothing to pin */
  }
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const RealDate = Date;
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
}

/**
 * Waits until every image in the visible tab is loaded, decoded and painted.
 * Lazy thumbnails only start loading once the page is full height, and a
 * capture taken before they land shows up as a false difference.
 * @param {import("playwright").Page} page
 */
async function settleImages(page) {
  const visibleImages = ".tab-panel:not([hidden]) img";
  await page
    .waitForFunction((selector) => [...document.querySelectorAll(selector)].every((img) => img.complete), visibleImages, {
      timeout: IMAGE_TIMEOUT_MS,
    })
    .catch(() => {});
  // decode() is raced against a timer: on a lazy image that never starts
  // loading it never settles. At phone width that is every thumbnail parked
  // off to the side in a swipeable strip, and it froze the whole run.
  await page.evaluate(
    async ([selector, decodeTimeoutMs]) => {
      const settled = (img) =>
        Promise.race([img.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, decodeTimeoutMs))]);
      await Promise.all([...document.querySelectorAll(selector)].map(settled));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    [visibleImages, IMAGE_DECODE_TIMEOUT_MS]
  );
}

/**
 * Renders every tab of the classic layout and returns one full-page PNG each.
 * @param {import("playwright").Browser} browser
 * @param {ReadonlyArray<string>} tabs
 * @param {{ index: Buffer, script: Buffer } | null} head  commit files to serve instead of the working tree's
 */
async function renderClassic(browser, tabs, head) {
  const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: "reduce" });
  await context.addInitScript(pinEnvironment, [RANDOM_SEED, FIXED_NOW_MS]);
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  const page = await context.newPage();
  if (head) {
    await page.route(
      (url) => url.pathname === "/",
      (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: head.index })
    );
    await page.route(
      (url) => url.pathname === "/script.js",
      (route) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: head.script })
    );
  }
  await page.goto(`${BASE}/?ui=classic`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
  await page.waitForSelector("#overview-body .kpi-strip", { timeout: BOOT_TIMEOUT_MS });
  /** @type {Record<string, Buffer>} */
  const shots = {};
  for (const tab of tabs) {
    await page.setViewportSize(VIEWPORT);
    await page.evaluate((id) => window.SpireVault.switchTab(id), tab);
    await page.waitForSelector(`.tab-panel[data-tab="${tab}"]:not([hidden])`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(TAB_SETTLE_MS);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.max(VIEWPORT.height, height) });
    await page.waitForTimeout(RESIZE_SETTLE_MS);
    await settleImages(page);
    shots[tab] = await page.screenshot({ animations: "disabled" });
  }
  await context.close();
  return shots;
}

/**
 * Counts the pixels that differ between two PNGs, ignoring allowed regions.
 * Runs in a page so Chromium does the decoding.
 */
function comparePngs([before, after, tolerance, allowed]) {
  const load = async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const isAllowed = (x, y) => allowed.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  return Promise.all([load(before), load(after)]).then(([a, b]) => {
    if (a.width !== b.width || a.height !== b.height) {
      return { sizeChanged: `${a.width}x${a.height} -> ${b.width}x${b.height}` };
    }
    let unexpected = 0;
    let expected = 0;
    const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        const delta =
          Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
        if (delta <= tolerance) continue;
        if (isAllowed(x, y)) {
          expected += 1;
          continue;
        }
        unexpected += 1;
        box.x0 = Math.min(box.x0, x);
        box.y0 = Math.min(box.y0, y);
        box.x1 = Math.max(box.x1, x);
        box.y1 = Math.max(box.y1, y);
      }
    }
    return { unexpected, expected, box: unexpected ? [box.x0, box.y0, box.x1, box.y1] : null };
  });
}

/** @param {Buffer} png */
function dataUrl(png) {
  return `data:image/png;base64,${png.toString("base64")}`;
}

/**
 * Compares one tab, rendering it again if it differs. A real change is
 * deterministic and survives the retries; a thumbnail that was still
 * arriving (this repo's assets can be evicted from local disk) does not.
 * @returns {Promise<{ changed: boolean, detail: string, before: Buffer, after: Buffer }>}
 */
async function compareTab(browser, page, tab, shots, context) {
  let before = shots.before[tab];
  let after = shots.after[tab];
  for (let attempt = 0; ; attempt += 1) {
    const result = await page.evaluate(comparePngs, [dataUrl(before), dataUrl(after), PIXEL_TOLERANCE, context.allowed]);
    const changed = Boolean(result.sizeChanged) || result.unexpected > 0;
    if (!changed || attempt === MAX_RETRIES) {
      const where = result.box ? ` in [${result.box.join(",")}]` : "";
      const detail = result.sizeChanged
        ? `page size changed (${result.sizeChanged})`
        : `${result.unexpected} unexpected px${where}, ${result.expected} allowed${attempt ? ` (attempt ${attempt + 1})` : ""}`;
      return { changed, detail, before, after };
    }
    before = (await renderClassic(browser, [tab], context.head))[tab];
    after = (await renderClassic(browser, [tab], null))[tab];
  }
}

async function main() {
  const tabs = arg("tabs", DEFAULT_TABS).split(",").map((tab) => tab.trim()).filter(Boolean);
  const outDir = arg("out", "");
  const context = {
    allowed: allowedRegions(),
    head: { index: fromHead("Web/index.html"), script: fromHead("Web/script.js") },
  };
  const server = await startServer();
  const browser = await chromium.launch();
  let failures = 0;
  try {
    // A throwaway pass first: the header art is large, and a cold first read
    // can still be decoding when the screenshot is taken.
    await renderClassic(browser, tabs, null);
    const shots = {
      before: await renderClassic(browser, tabs, context.head),
      after: await renderClassic(browser, tabs, null),
    };
    const page = await browser.newPage();
    for (const tab of tabs) {
      const outcome = await compareTab(browser, page, tab, shots, context);
      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${tab}-commit.png`), outcome.before);
        writeFileSync(join(outDir, `${tab}-working.png`), outcome.after);
      }
      if (outcome.changed) failures += 1;
      process.stdout.write(`${outcome.changed ? "DIFF" : "  ok"}  ${tab.padEnd(11)} ${outcome.detail}\n`);
    }
  } finally {
    await browser.close();
    server.kill();
  }
  process.stdout.write(
    failures
      ? `\nverify-classic-unchanged: ${failures} tab(s) differ from the last commit\n`
      : `\nverify-classic-unchanged: classic matches the last commit on all ${tabs.length} tabs\n`
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`verify-classic-unchanged crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
