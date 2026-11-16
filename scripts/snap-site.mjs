#!/usr/bin/env node
/**
 * Review captures of the landing page in Site/ (spirevault.app).
 *
 * Serves Site/ through scripts/dev-site.mjs (real headers and CSP), opens it
 * in a real browser at each width, and writes PNGs a person can judge the
 * design from:
 *
 *   first-<climber>-<width>.png          the first screen, exactly the viewport
 *   full-<width>.png                     the whole page
 *   sections/<id>-<width>.png            one picture per section
 *   motion/hero-<width>.webm             a few seconds of the hero moving
 *
 * Stills are taken with the page's motion off (`?motion=off`), which is the
 * resting state: cards dealt, balloon up, nothing mid-flight. Live numbers
 * (players signed up, release version) come from the real endpoints unless
 * --stub is passed.
 *
 *   node scripts/snap-site.mjs                         # first screens, 1728/1440/390
 *   node scripts/snap-site.mjs --full --sections       # whole page and per-section
 *   node scripts/snap-site.mjs --climbers ironclad,defect   # which climber is featured
 *   node scripts/snap-site.mjs --engines chromium,webkit --widths 320,768,1440
 *   node scripts/snap-site.mjs --clip --widths 1728     # motion clip
 *   node scripts/snap-site.mjs --og                     # Site/assets/og-v<N>.jpg, the link-preview picture
 *   node scripts/snap-site.mjs --base-url http://127.0.0.1:8791
 */

import { chromium, firefox, webkit } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSiteServer } from "./site-server.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Its own port, so a capture can run while the checks (8797) do.
const OWN_PORT = 8795;
const ENGINES = Object.freeze({ chromium, firefox, webkit });
/** Viewport height for each width: a real device or window of that width. */
const HEIGHTS = Object.freeze({ 320: 568, 375: 812, 390: 844, 768: 1024, 1024: 768, 1100: 720, 1280: 720, 1366: 768, 1440: 900, 1728: 1000, 1920: 1080, 2560: 1300 });
const PHONE_MAX_W = 480;
const SETTLE_MS = 400;
/** Pause after each scroll step of a stitched capture, for paint to catch up. */
const SLICE_SETTLE_MS = 150;
const LIVE_WAIT_MS = 8000;
const NAV_TIMEOUT_MS = 180_000;
/** The link-preview picture: size every platform accepts, and its file. */
const OG = Object.freeze({ width: 1200, height: 630, file: join(REPO_ROOT, "Site", "assets", "og-v3.jpg"), quality: 88 });

/** @param {string} name @param {string} [fallback] */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
/** @param {string} name */
const flag = (name) => process.argv.includes(`--${name}`);
/** @param {string} name @param {string} fallback */
const list = (name, fallback) => String(arg(name, fallback)).split(",").map((s) => s.trim()).filter(Boolean);

/** Canned answers for the two endpoints the page calls. */
async function stubNetwork(page) {
  await page.route("**/vault-coop.coreycrooks.workers.dev/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ inSTS2: i < 2 }))),
    }),
  );
  await page.route("**/api.github.com/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ tag_name: "v0.0.0-stub", assets: [] }),
    }),
  );
}

/** Waits for fonts, pictures and (when live) the first presence answer. */
async function settle(page, { live }) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  if (live) {
    await page
      .waitForFunction(() => {
        const el = document.getElementById("presence-text");
        return el && !/Checking/.test(el.textContent || "");
      }, null, { timeout: LIVE_WAIT_MS })
      .catch(() => {});
  }
  await page.waitForTimeout(SETTLE_MS);
}

/** Scrolls the page end to end so lazy pictures load, then returns to the top. */
async function loadLazy(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight - 100);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
    // decode() on a picture that never loads never settles: stop waiting after a while.
    const giveUp = new Promise((r) => setTimeout(r, 15_000));
    await Promise.race([Promise.all(Array.from(document.images, (img) => (img.complete ? null : img.decode().catch(() => null)))), giveUp]);
  });
}

/** The sticky nav would repeat in every slice and sit over each section: put it back in the flow. */
async function unpinNav(page) {
  // Through the CSSOM; the page's CSP forbids injected styles.
  await page.evaluate(() => {
    const nav = document.querySelector(".nav");
    if (nav) nav.style.position = "static";
  });
}

/**
 * The whole page as one picture, stitched from screen-height slices.
 *
 * Playwright's own fullPage mode resizes the window to shoot a very tall
 * page. That makes the page's responsive pictures swap (the phone picture
 * loads into the desktop frame) and the frame is caught blank mid-swap. A
 * slice is exactly what a visitor's window shows, so nothing swaps.
 */
async function captureWholePage(page, file) {
  await unpinNav(page);
  const { width, height } = page.viewportSize();
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const work = mkdtempSync(join(tmpdir(), "snap-site-"));
  try {
    const parts = [];
    for (let top = 0; top < total; top += height) {
      const sliceHeight = Math.min(height, total - top);
      await page.evaluate((y) => window.scrollTo(0, y), top);
      await page.waitForTimeout(SLICE_SETTLE_MS);
      // The last slice cannot scroll a full screen: take its part of the window.
      const scrolled = await page.evaluate(() => window.scrollY);
      const part = join(work, `part-${String(parts.length).padStart(3, "0")}.png`);
      await page.screenshot({ path: part, clip: { x: 0, y: top - scrolled, width, height: sliceHeight } });
      parts.push(part);
    }
    if (parts.length === 1) {
      copyFileSync(parts[0], file);
    } else {
      try {
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...parts.flatMap((p) => ["-i", p]), "-filter_complex", `vstack=inputs=${parts.length}`, file]);
      } catch (error) {
        throw new Error(`could not stitch ${file} (ffmpeg is needed for --full): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const widths = list("widths", "1728,1440,390").map(Number);
  const engines = list("engines", "chromium");
  const climbers = list("climbers", "ironclad");
  const outRoot = arg("out", join(REPO_ROOT, "docs", "screenshots", "site"));
  const wantFull = flag("full");
  const wantSections = flag("sections");
  const wantClip = flag("clip");
  const wantFirst = !flag("no-first");
  const live = !flag("stub");
  const scaleOverride = arg("scale");

  for (const engine of engines) {
    if (!ENGINES[engine]) throw new Error(`unknown engine: ${engine}`);
  }

  const external = arg("base-url");
  const server = external ? { baseUrl: external.replace(/\/$/, ""), stop: () => {} } : await startSiteServer(OWN_PORT);
  const written = [];
  try {
    if (flag("og")) {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: { width: OG.width, height: OG.height }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        await stubNetwork(page);
        await page.goto(`${server.baseUrl}/?climber=${climbers[0]}&motion=off&line=3&og=1`, { waitUntil: "load" });
        await settle(page, { live: false });
        await page.screenshot({ path: OG.file, type: "jpeg", quality: OG.quality });
        written.push(OG.file);
      } finally {
        await browser.close();
      }
    }
    for (const engine of engines) {
      const outDir = engines.length > 1 || engine !== "chromium" ? join(outRoot, engine) : outRoot;
      mkdirSync(join(outDir, "sections"), { recursive: true });
      mkdirSync(join(outDir, "motion"), { recursive: true });
      const browser = await ENGINES[engine].launch();
      try {
        for (const width of widths) {
          const height = HEIGHTS[width] || 900;
          const phone = width <= PHONE_MAX_W;
          const scale = scaleOverride ? Number(scaleOverride) : phone ? 3 : 2;
          const contextOptions = {
            viewport: { width, height },
            deviceScaleFactor: scale,
            ...(phone && engine !== "firefox" ? { isMobile: true, hasTouch: true } : {}),
          };

          if (wantFirst || wantFull || wantSections) {
            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();
            page.setDefaultTimeout(NAV_TIMEOUT_MS);
            if (!live) await stubNetwork(page);
            let first = true;
            {
              for (const climber of climbers) {
                await page.goto(`${server.baseUrl}/?climber=${climber}&motion=off&line=3`, { waitUntil: "load" });
                await settle(page, { live });
                if (wantFirst) {
                  const file = join(outDir, `first-${climber}-${width}.png`);
                  await page.screenshot({ path: file });
                  written.push(file);
                }
                if (first && (wantFull || wantSections)) {
                  await loadLazy(page);
                  await page.waitForTimeout(SETTLE_MS);
                  const whole = wantFull ? join(outDir, `full-${width}.png`) : join(outDir, "sections", `.whole-${width}.png`);
                  await captureWholePage(page, whole);
                  if (wantFull) written.push(whole);
                  if (wantSections) {
                    // Cut each section out of the stitched page (an element
                    // screenshot of a tall section has the same resize problem).
                    const parts = await page.evaluate(() =>
                      Array.from(document.querySelectorAll("main > section, footer"), (el, i) => {
                        const box = el.getBoundingClientRect();
                        return { id: el.id || el.classList[0] || `part-${i}`, top: box.top + window.scrollY, height: box.height };
                      }),
                    );
                    try {
                      for (const part of parts) {
                        const file = join(outDir, "sections", `${part.id}-${width}.png`);
                        const y = Math.round(part.top * scale);
                        const h = Math.round(part.height * scale);
                        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", whole, "-vf", `crop=iw:${h}:0:${y}`, file]);
                        written.push(file);
                      }
                    } finally {
                      // The working copy of the whole page goes even if a crop fails.
                      if (!wantFull) rmSync(whole, { force: true });
                    }
                  }
                }
                first = false;
              }
            }
            await context.close();
          }

          if (wantClip) {
            const clipDir = join(outDir, "motion", `.tmp-${width}`);
            const context = await browser.newContext({
              viewport: { width, height },
              deviceScaleFactor: 1,
              recordVideo: { dir: clipDir, size: { width, height } },
            });
            const page = await context.newPage();
            page.setDefaultTimeout(NAV_TIMEOUT_MS);
            if (!live) await stubNetwork(page);
            await page.goto(`${server.baseUrl}/?climber=${climbers[0]}&line=3`, { waitUntil: "load" });
            await page.waitForTimeout(Number(arg("clip-ms", "8000")));
            const video = page.video();
            await context.close();
            if (video) {
              const file = join(outDir, "motion", `hero-${width}.webm`);
              renameSync(await video.path(), file);
              written.push(file);
            }
            rmSync(clipDir, { recursive: true, force: true });
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.stop();
  }
  process.stdout.write(`${written.map((f) => f.replace(`${REPO_ROOT}/`, "")).join("\n")}\n${written.length} file(s) written\n`);
}

main().catch((error) => {
  process.stderr.write(`snap-site failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
