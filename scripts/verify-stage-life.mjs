#!/usr/bin/env node
/**
 * Checks the life in the new look's header scenes (Web/lib/ui/stage-life.js,
 * Web/styles/src/components/stage-life.css) against a running app:
 *
 *   - every scene draws its life, and every painted sprite it uses loads
 *   - every animation in the header moves only transform, opacity or filter
 *     (or the individual translate / rotate / scale), never layout
 *   - something can happen in every scene on a wide desktop and on a phone:
 *     at least one event plays inside the part of the picture each shows
 *   - under reduced motion nothing in the scene's life runs, and the
 *     scheduler plays no events
 *   - the page throws nothing
 *
 *   VERIFY_UI_PORT=8790 node scripts/verify-stage-life.mjs
 *
 * Needs the app served (make -C Web dev, or the web-steam launch config).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(`${REPO_ROOT}/`);
const { chromium } = require("playwright");

const BASE = `http://127.0.0.1:${process.env.VERIFY_UI_PORT || 8790}`;
const SCENES = ["glory", "hive", "study", "overgrowth", "underdocks", "campfire", "merchant", "crystal", "aurora", "embers", "clouds", "crypt"];
const LAYOUTS = [
  { name: "desktop", width: 1728, height: 1000 },
  { name: "phone", width: 390, height: 844, phone: true },
];
const ALLOWED = new Set(["opacity", "transform", "translate", "rotate", "scale", "filter", "visibility"]);
const KEYFRAME_META = new Set(["offset", "computedOffset", "easing", "composite"]);
/** How much of an event's area must be on screen (as in stage-life.js). */
const MIN_AREA_SHOWN = 0.35;

const failures = [];
/** @param {boolean} ok @param {string} what */
function check(ok, what) {
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${what}\n`);
  if (!ok) failures.push(what);
}

/** @param {import("playwright").Browser} browser */
async function openApp(browser, layout, reducedMotion = "no-preference") {
  const context = await browser.newContext({
    viewport: { width: layout.width, height: layout.height },
    deviceScaleFactor: 1,
    reducedMotion,
    ...(layout.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(() => {
    localStorage.setItem("vault.web.ui.notice", "keep");
    localStorage.setItem("vault.web.stage-scene", "glory");
  });
  await context.route(/api\.github\.com|googletagmanager|google-analytics/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/?ui=next`, { waitUntil: "load" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: 30000 });
  await page.waitForSelector(".v-torches", { timeout: 20000 });
  return { context, page, errors };
}

/** Pins a scene and reopens Overview so it is dealt. */
async function showScene(page, scene) {
  await page.evaluate((id) => {
    localStorage.setItem("vault.web.stage-scene", id);
    window.SpireVault.switchTab("characters");
    window.SpireVault.switchTab("overview");
  }, scene);
  await page.waitForFunction(
    (id) => {
      const s = document.querySelector('.tab-panel[data-tab="overview"] .v-scene');
      return s?.dataset.sceneId === id && s.querySelector(".v-scene-img")?.classList.contains("is-in");
    },
    scene,
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);
}

/** What the scene draws, and which events land inside the shown part. */
function readScene(minShown) {
  const plate = document.querySelector('.tab-panel[data-tab="overview"] .v-scene-plate');
  const picture = plate.getBoundingClientRect();
  const frame = plate.parentElement.getBoundingClientRect();
  const shown = [
    (frame.left - picture.left) / picture.width,
    (frame.top - picture.top) / picture.height,
    (frame.right - picture.left) / picture.width,
    (frame.bottom - picture.top) / picture.height,
  ];
  const events = [...plate.querySelectorAll("[data-life-event]")].map((event) => {
    const [l, t, r, b] = event.dataset.lifeArea.split(",").map(Number);
    const ow = Math.max(0, Math.min(r, shown[2]) - Math.max(l, shown[0])) / Math.max(r - l, 0.001);
    const oh = Math.max(0, Math.min(b, shown[3]) - Math.max(t, shown[1])) / Math.max(b - t, 0.001);
    return ow * oh >= minShown;
  });
  const sprites = [...plate.querySelectorAll(".v-life-sprite")];
  return {
    items: plate.querySelector(".v-life")?.children.length || 0,
    events: events.length,
    shownEvents: events.filter(Boolean).length,
    sprites: sprites.length,
    brokenSprites: sprites.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.getAttribute("src")),
  };
}

/** Every animation in the header that moves something other than the allowed properties. */
function readAnimations({ allowed, meta }) {
  const head = document.querySelector('.tab-panel[data-tab="overview"] .v-stage-bg');
  const bad = new Set();
  let total = 0;
  document.getAnimations().forEach((animation) => {
    const target = animation.effect && animation.effect.target;
    if (!target || !head.contains(target)) return;
    total += 1;
    animation.effect.getKeyframes().forEach((frame) => {
      Object.keys(frame).forEach((key) => {
        if (!meta.includes(key) && !allowed.includes(key)) bad.add(`${animation.animationName || "?"}:${key}`);
      });
    });
  });
  return { total, bad: [...bad] };
}

async function checkLayout(browser, layout) {
  process.stdout.write(`\n${layout.name} (${layout.width}px)\n`);
  const { context, page, errors } = await openApp(browser, layout);
  for (const scene of SCENES) {
    await showScene(page, scene);
    // Let every sprite settle before judging it.
    await page.waitForFunction(() => [...document.querySelectorAll('.tab-panel[data-tab="overview"] .v-life-sprite')].every((img) => img.complete), null, { timeout: 15000 }).catch(() => {});
    const seen = await page.evaluate(readScene, MIN_AREA_SHOWN);
    const motion = await page.evaluate(readAnimations, { allowed: [...ALLOWED], meta: [...KEYFRAME_META] });
    check(seen.items > 0, `${scene}: draws its life (${seen.items} items, ${seen.sprites} sprites)`);
    check(seen.brokenSprites.length === 0, `${scene}: every sprite loads ${seen.brokenSprites.join(" ")}`);
    check(seen.shownEvents > 0, `${scene}: ${seen.shownEvents} of ${seen.events} events can play in what this layout shows`);
    check(motion.bad.length === 0, `${scene}: ${motion.total} animations move only transform/opacity/filter ${motion.bad.join(" ")}`);
  }
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await context.close();
}

async function checkReducedMotion(browser) {
  process.stdout.write("\nreduced motion\n");
  const { context, page, errors } = await openApp(browser, LAYOUTS[0], "reduce");
  for (const scene of ["campfire", "clouds", "embers"]) {
    await showScene(page, scene);
    const running = await page.evaluate(() => {
      const head = document.querySelector('.tab-panel[data-tab="overview"] .v-stage-bg');
      return document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target && head.contains(a.effect.target) && a.effect.target.closest(".v-life, .v-life-near")).length;
    });
    check(running === 0, `${scene}: nothing in its life runs (${running} running)`);
  }
  // The scheduler's first event comes within a few seconds; none may play.
  await page.waitForTimeout(6000);
  const played = await page.evaluate(() => document.querySelectorAll(".v-life-ev.is-on").length);
  check(played === 0, `the scheduler plays no events (${played} playing)`);
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
  await context.close();
}

async function checkEventsPlay(browser) {
  process.stdout.write("\nevents\n");
  const { context, page } = await openApp(browser, LAYOUTS[0]);
  await showScene(page, "campfire");
  const played = await page
    .waitForFunction(() => document.querySelector('.tab-panel[data-tab="overview"] .v-life-ev.is-on')?.className, null, { timeout: 16000 })
    .then((handle) => handle.jsonValue())
    .catch(() => "");
  check(Boolean(played), `the scheduler plays an event on its own (${played || "none"})`);
  await context.close();
}

const browser = await chromium.launch();
try {
  for (const layout of LAYOUTS) await checkLayout(browser, layout);
  await checkReducedMotion(browser);
  await checkEventsPlay(browser);
} finally {
  await browser.close();
}
process.stdout.write(failures.length ? `\n${failures.length} FAILED\n` : "\nall passed\n");
process.exit(failures.length ? 1 : 0);
