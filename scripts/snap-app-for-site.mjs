#!/usr/bin/env node
/**
 * Fresh pictures of the app's new look for the landing page in Site/.
 *
 * Opens the web app (Web/, new look, Inked theme, sample data, as a guest),
 * and writes what the landing page shows of it:
 *
 *   Site/assets/shots/<tab>-<960|1440|1920|2880>-v<N>.webp   one screen per tab
 *   Site/assets/shots/<tab>-phone-<780|1170>-v<N>.webp   the same tab on a phone
 *   Site/assets/share/share-sample-<1200|2400>-v<N>.webp  a real share card
 *   docs/screenshots/site/app-src/*.png                  the PNG sources
 *   docs/screenshots/site/app-src/hand.json              the "Your hand" values
 *                                                        the app shows, so the
 *                                                        landing hero's sample
 *                                                        hand can match them
 *
 * The app's header scene is pinned to the same room as the landing hero and
 * its random rolls are seeded, so a rerun gives the same pictures. This only
 * reads Web/; it never writes there.
 *
 *   node scripts/snap-app-for-site.mjs
 *   node scripts/snap-app-for-site.mjs --tabs overview,runs --no-share
 *   node scripts/snap-app-for-site.mjs --no-desktop --no-share   # phone pictures only
 *   node scripts/snap-app-for-site.mjs --base-url http://127.0.0.1:8788
 *   node scripts/snap-app-for-site.mjs --look classic   # the classic look, for the
 *                                                       # viewer's "Try me" swap
 *
 * With --look classic the same tabs are written as <tab>-classic-<width> and
 * <tab>-classic-phone-<width>, in the app's classic look and default theme;
 * the hand values and the share card are new-look only, so they are skipped.
 */

import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(REPO_ROOT, "docs", "screenshots", "site", "app-src");
const SHOTS_DIR = join(REPO_ROOT, "Site", "assets", "shots");
const SHARE_DIR = join(REPO_ROOT, "Site", "assets", "share");
const CWEBP = "/opt/homebrew/bin/cwebp";
const OWN_PORT = 8792;
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const SCALE = 2;
const SHOT_WIDTHS = Object.freeze([960, 1440, 1920, 2880]);
/** A phone: the landing page shows its whole first screen, down to the app's own tab bar,
 *  at 780px (2x phones) and 1170px (3x phones) so the app's text stays sharp. */
const PHONE = Object.freeze({ width: 390, height: 844, scale: 3, crop: 844, outWidths: Object.freeze([780, 1170]) });
const SHARE_WIDTHS = Object.freeze([1200, 2400]);
const SHARE_PIXELS = Object.freeze({ width: 2400, height: 1260 });
const ART_VERSION = 3;
const SETTLE_MS = 2600;
const TIMEOUT_MS = 180_000;
const DEFAULT_TABS = "overview,characters,ascensions,relics,cards,runs";
/** How each look is asked for, what says it has drawn, and its file-name suffix. */
const LOOKS = Object.freeze({
  next: { query: "?ui=next&theme=inked", ready: ".v-ov, .demo-banner", suffix: "" },
  classic: { query: "?ui=classic", ready: '.tab-panel[data-tab="overview"]:not([hidden])', suffix: "-classic" },
});

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

/** @returns {Promise<{ baseUrl: string, stop: () => void }>} */
function startAppServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(OWN_PORT)], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("the server did not start within 30s"), 30_000);
    child.stdout.on("data", (chunk) => {
      if (settled || !String(chunk).includes("serving")) return;
      settled = true;
      clearTimeout(timer);
      resolve({ baseUrl: `http://127.0.0.1:${OWN_PORT}`, stop: () => child.kill() });
    });
    child.stderr.on("data", (chunk) => {
      // Offloaded-file notices are routine here; anything before "serving" is a failure to start.
      if (!settled) fail(`dev-static did not start: ${String(chunk).trim()}`);
    });
    child.on("exit", (code) => fail(`dev-static exited early (code ${code})`));
  });
}

/** Writes `source` (a PNG) as WebP at each width into `dir`. */
function toWebp(source, dir, name, widths, quality) {
  mkdirSync(dir, { recursive: true });
  return widths.map((width) => {
    const out = join(dir, `${name}-${width}-v${ART_VERSION}.webp`);
    execFileSync(CWEBP, ["-quiet", "-q", String(quality), "-resize", String(width), "0", source, "-o", out]);
    return out;
  });
}

/** The app as a guest on sample data in the given look (new look: Inked, fixed climber, room and rolls). */
async function openApp(browser, baseUrl, { companion, room, seed, look, phone = false }) {
  const context = await browser.newContext(
    phone
      ? { viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: PHONE.scale, isMobile: true, hasTouch: true }
      : { viewport: VIEWPORT, deviceScaleFactor: SCALE },
  );
  await context.addInitScript(
    ({ who, scene, rollSeed }) => {
      try {
        window.localStorage.setItem("vault.web.companion.v2", who);
        window.localStorage.setItem("vault.web.stage-scene", scene);
      } catch {
        /* storage unavailable: the header is rolled randomly */
      }
      let state = rollSeed >>> 0;
      Math.random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    { who: companion, scene: room, rollSeed: seed },
  );
  // Hermetic: no analytics or third-party requests from a capture run.
  await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  await page.goto(`${baseUrl}/${LOOKS[look].query}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub);
  await page.waitForSelector(LOOKS[look].ready, { timeout: TIMEOUT_MS });
  return { context, page };
}

async function showTab(page, tab) {
  // Through the host bridge, not ?tab=: on a local host the app's fast first
  // paint tidies the URL before boot reads the deep link.
  await page.evaluate((name) => window.SpireVault.switchTab(name), tab);
  await page.waitForSelector(`.tab-panel[data-tab="${tab}"]:not([hidden])`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

/** The six "Your hand" cards exactly as the app shows them. */
function readHand() {
  return Array.from(document.querySelectorAll(".v-hand .v-card"), (card) => ({
    title: (card.querySelector(".v-card-band")?.textContent || "").trim(),
    value: (card.querySelector(".v-card-value")?.textContent || "").trim(),
    text: (card.querySelector(".v-card-text")?.textContent || "").replace(/\s+/g, " ").trim(),
    tone: card.getAttribute("data-tone") || "",
  }));
}

async function exportShareCard(page) {
  await showTab(page, "runs");
  const clicked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".v-run"));
    const won = rows.find((row) => /victory/i.test(row.querySelector(".v-stamp")?.textContent || "")) || rows[0];
    const button = won && won.querySelector('[data-action="share-run"]');
    if (!button) return null;
    button.click();
    return { character: won.getAttribute("data-char"), result: (won.querySelector(".v-stamp")?.textContent || "").trim() };
  });
  if (!clicked) throw new Error("no run row with a share button was found");
  await page.waitForSelector("#share-modal:not([hidden])");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  // The card is drawn once at once, then again when its art has loaded.
  await page.waitForTimeout(3500);
  const card = await page.evaluate(() => {
    const canvas = document.getElementById("share-canvas");
    return canvas ? { width: canvas.width, height: canvas.height, data: canvas.toDataURL("image/png") } : null;
  });
  if (!card) throw new Error("the share canvas was not found");
  if (card.width !== SHARE_PIXELS.width || card.height !== SHARE_PIXELS.height) {
    throw new Error(`share card is ${card.width}x${card.height}, expected ${SHARE_PIXELS.width}x${SHARE_PIXELS.height} (is the new look on?)`);
  }
  const source = join(SRC_DIR, "share-card@2x.png");
  writeFileSync(source, Buffer.from(card.data.split(",")[1], "base64"));
  return { source, ...clicked };
}

async function main() {
  if (!existsSync(CWEBP)) throw new Error(`cwebp not found at ${CWEBP}`);
  const tabs = String(arg("tabs", DEFAULT_TABS)).split(",").map((s) => s.trim()).filter(Boolean);
  mkdirSync(SRC_DIR, { recursive: true });
  const external = arg("base-url");
  const server = external ? { baseUrl: external.replace(/\/$/, ""), stop: () => {} } : await startAppServer();
  const written = [];
  const look = String(arg("look", "next"));
  if (!Object.prototype.hasOwnProperty.call(LOOKS, look)) throw new Error(`--look must be one of ${Object.keys(LOOKS).join(", ")}, not "${look}"`);
  const isNext = look === "next";
  const suffix = LOOKS[look].suffix;
  const who = { companion: arg("companion", "ironclad"), room: arg("room", "glory"), seed: Number(arg("seed", "3")), look };
  let browser = null;
  try {
    browser = await chromium.launch();
    if (!flag("no-phone")) {
      const { context, page } = await openApp(browser, server.baseUrl, { ...who, phone: true });
      for (const tab of tabs) {
        await showTab(page, tab);
        await page.evaluate(() => window.scrollTo(0, 0));
        const source = join(SRC_DIR, `${tab}${suffix}-phone@3x.png`);
        await page.screenshot({ path: source, clip: { x: 0, y: 0, width: PHONE.width, height: PHONE.crop } });
        written.push(source, ...toWebp(source, SHOTS_DIR, `${tab}${suffix}-phone`, PHONE.outWidths, 82));
      }
      await context.close();
    }
    if (flag("no-desktop")) return;
    const { context, page } = await openApp(browser, server.baseUrl, who);
    for (const tab of tabs) {
      await showTab(page, tab);
      await page.evaluate(() => window.scrollTo(0, 0));
      const source = join(SRC_DIR, `${tab}${suffix}-1440@2x.png`);
      await page.screenshot({ path: source });
      written.push(source, ...toWebp(source, SHOTS_DIR, `${tab}${suffix}`, SHOT_WIDTHS, 82));
      if (isNext && tab === "overview") {
        const hand = await page.evaluate(readHand);
        const handFile = join(SRC_DIR, "hand.json");
        writeFileSync(handFile, `${JSON.stringify(hand, null, 2)}\n`);
        written.push(handFile);
        process.stdout.write(`hand: ${JSON.stringify(hand)}\n`);
      }
    }
    if (isNext && !flag("no-share")) {
      const share = await exportShareCard(page);
      process.stdout.write(`share card: ${share.character}, ${share.result}\n`);
      written.push(share.source, ...toWebp(share.source, SHARE_DIR, "share-sample", SHARE_WIDTHS, 86));
    }
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.stop();
    process.stdout.write(`${written.map((f) => f.replace(`${REPO_ROOT}/`, "")).join("\n")}\n${written.length} file(s) written\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`snap-app-for-site failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
