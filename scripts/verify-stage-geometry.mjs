#!/usr/bin/env node
/**
 * Measures the new look's header Stage on every stage tab, for every climber,
 * at every width from a small phone to a wide desktop, and fails on any
 * overlap that would make the scene read wrong:
 *
 *   - the spire behind (or touching) a figure — "sitting on the tower"
 *   - the spire or moon under the title, subtitle, torches or toolbar
 *   - the two figures touching each other, or standing far apart
 *   - the speech balloon over the title, the toolbar or either figure, not
 *     above whoever is speaking, or with its tail not over them
 *   - anything poking out of the header sideways
 *
 * Every layout is measured twice: once with the climber speaking, once with
 * the boss.
 *
 * Elements that are display:none at a width (the spire on the narrowest
 * phones, the moon on tablets) are skipped and listed, not failed.
 *
 *   node scripts/verify-stage-geometry.mjs                     # starts its own server
 *   node scripts/verify-stage-geometry.mjs --base-url http://127.0.0.1:8788
 *   node scripts/verify-stage-geometry.mjs --widths 375,1440 --climbers defect
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8793;
const SETTLE_MS = 900;
const SERVER_BOOT_TIMEOUT_MS = 10000;
/** Minimum open ground between the spire and the climber, in CSS px. */
const SPIRE_CLEARANCE_PX = 12;
/** Figures may not touch; their hard shadows need a little air. */
const FIGURE_CLEARANCE_PX = 8;
/** ...and stand close, squared up, not across the stage from each other. */
const MAX_DUEL_GAP_PX = 60;
const SPEAKERS = ["climber", "boss"];

const STAGE_TABS = ["overview", "characters", "ascensions", "relics", "cards"];
const CLIMBERS = ["ironclad", "silent", "defect", "regent", "necrobinder"];
const WIDTHS = [320, 360, 375, 390, 414, 480, 600, 700, 768, 820, 880, 900, 1024, 1100, 1180, 1280, 1366, 1440, 1680, 1920];

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
/** @param {string} value */
const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

const options = {
  baseUrl: arg("base-url", ""),
  widths: list(arg("widths", WIDTHS.join(","))).map(Number),
  climbers: list(arg("climbers", CLIMBERS.join(","))),
  tabs: list(arg("tabs", STAGE_TABS.join(","))),
  theme: arg("theme", "inked"),
  // Animations change measured boxes (the balloon pops in from 70%); run
  // with --motion on as well, or a fit that measured mid-animation slips by.
  motion: arg("motion", "off"),
  // The longest line in the quote tables (script.js CLIMBER_LINES / BOSSES):
  // the balloon is measured at its worst, not at whatever line was rolled.
  line: arg("line", "You cannot change the past with anger."),
};

function startServer() {
  const child = spawn(process.execPath, [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(DEFAULT_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("dev server did not start")), SERVER_BOOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => reject(new Error(`dev server exited (${code})`)));
  });
}

/**
 * Runs in the page: rects of every stage part on the visible tab, in
 * viewport coordinates, null when not rendered.
 * @param {string} tab
 */
function measure(tab) {
  const panel = document.querySelector(`.tab-panel[data-tab="${tab}"]`);
  const head = panel && panel.querySelector(":scope > .panel-head");
  if (!head) return { error: `no panel head for ${tab}` };
  /** @param {Element|null} el */
  const rect = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  /** Union of the rects of the matching, rendered elements. */
  const union = (selector) => {
    const rects = [...head.querySelectorAll(selector)].map(rect).filter(Boolean);
    if (rects.length === 0) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  };
  // Text boxes: measure the text itself, not the block that holds it.
  const textRect = (selector) => {
    const els = [...head.querySelectorAll(selector)].filter((el) => rect(el));
    const rects = els.flatMap((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].filter((r) => r.width > 0);
    });
    if (rects.length === 0) return null;
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  };
  const headRect = head.getBoundingClientRect();
  return {
    head: { left: headRect.left, top: headRect.top, right: headRect.right, bottom: headRect.bottom },
    spire: rect(head.querySelector(".v-spire")),
    moon: rect(head.querySelector(".v-stage-moon")),
    climber: rect(head.querySelector(".v-actor--climber .v-actor-art")),
    boss: rect(head.querySelector(".v-actor--boss .v-actor-art")),
    bubble: rect(head.querySelector(".v-bubble")),
    tail: rect(head.querySelector(".v-bubble-tail")),
    speaker: head.querySelector(".v-duel--boss-speaks") ? "boss" : "climber",
    title: textRect(".panel-head-stage h1, .panel-head-stage h2, .panel-head-stage .panel-title"),
    subtitle: textRect(".panel-head-stage p"),
    torches: union(".v-torches svg, .v-torches .v-stage-cap"),
    spireCap: rect(head.querySelector(".v-spire-cap")),
    toolbar: union(".app-toolbar button, .app-toolbar a, .app-toolbar .app-toolbar-empty"),
    climberVars: getComputedStyle(head).getPropertyValue("--climber-aspect").trim(),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
}

/** Horizontal and vertical gap between two rects; negative = overlap. */
function gap(a, b) {
  const dx = Math.max(a.left - b.right, b.left - a.right);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom);
  return Math.max(dx, dy);
}

/**
 * @param {Record<string, any>} m
 * @returns {{ problems: string[], skipped: string[] }}
 */
function check(m) {
  const problems = [];
  const skipped = [];
  /** @param {string} a @param {string} b @param {number} min */
  const apart = (a, b, min = 0) => {
    if (!m[a] || !m[b]) return;
    const g = gap(m[a], m[b]);
    if (g < min) problems.push(`${a} vs ${b}: ${g < 0 ? "overlap" : "gap"} ${Math.round(g)}px (need ≥ ${min})`);
  };
  ["spire", "moon", "climber", "boss", "bubble", "title"].forEach((k) => {
    if (!m[k]) skipped.push(k);
  });
  if (!m.climber) problems.push("climber not rendered");
  if (!m.boss) problems.push("boss not rendered");
  if (!m.title) problems.push("title not rendered");
  if (m.climber && !m.climberVars) problems.push("climber size never reached the header (syncDuelGeometry)");
  apart("spire", "climber", SPIRE_CLEARANCE_PX);
  apart("spire", "boss", SPIRE_CLEARANCE_PX);
  apart("spire", "title", 8);
  apart("spire", "subtitle", 8);
  apart("spire", "torches", 8);
  apart("spire", "toolbar", 4);
  apart("spire", "bubble", 4);
  apart("moon", "title", 4);
  apart("moon", "subtitle", 4);
  apart("moon", "toolbar", 4);
  apart("moon", "climber", 0);
  apart("spireCap", "torches", 6);
  apart("spireCap", "climber", 4);
  apart("climber", "boss", FIGURE_CLEARANCE_PX);
  if (m.climber && m.boss) {
    const duelGap = m.boss.left - m.climber.right;
    if (duelGap > MAX_DUEL_GAP_PX) problems.push(`figures stand ${Math.round(duelGap)}px apart (want ≤ ${MAX_DUEL_GAP_PX})`);
  }
  apart("bubble", "climber", 4);
  apart("bubble", "boss", 4);
  const who = m[m.speaker];
  if (m.bubble && who) {
    if (m.bubble.bottom > who.top - 4) {
      problems.push(`balloon is not above the ${m.speaker} (balloon bottom ${Math.round(m.bubble.bottom)} vs head ${Math.round(who.top)})`);
    }
    if (m.tail) {
      const tip = (m.tail.left + m.tail.right) / 2;
      if (tip < who.left || tip > who.right) {
        problems.push(`balloon tail (x ${Math.round(tip)}) is not over the ${m.speaker} (${Math.round(who.left)}..${Math.round(who.right)})`);
      }
    }
  }
  apart("climber", "title", 4);
  apart("climber", "subtitle", 4);
  apart("climber", "torches", 4);
  apart("boss", "toolbar", 0);
  apart("bubble", "title", 4);
  apart("bubble", "subtitle", 4);
  apart("bubble", "toolbar", 4);
  apart("climber", "toolbar", 0);
  ["spire", "moon", "climber", "boss", "bubble"].forEach((k) => {
    if (m[k] && (m[k].left < m.head.left - 1 || m[k].right > m.head.right + 1)) {
      problems.push(`${k} pokes out of the header (${Math.round(m[k].left)}..${Math.round(m[k].right)} vs ${Math.round(m.head.left)}..${Math.round(m.head.right)})`);
    }
  });
  if (m.scrollW > m.clientW + 1) problems.push(`page scrolls sideways (${m.scrollW} > ${m.clientW})`);
  return { problems, skipped };
}

async function main() {
  const server = options.baseUrl ? null : await startServer();
  const baseUrl = options.baseUrl || `http://127.0.0.1:${DEFAULT_PORT}`;
  const browser = await chromium.launch();
  let failures = 0;
  let checks = 0;
  const skippedAt = new Map();
  try {
    for (const climber of options.climbers) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: options.motion === "on" ? "no-preference" : "reduce",
      });
      await context.addInitScript((c) => {
        try { window.localStorage.setItem("vault.web.companion.v2", c); } catch { /* none */ }
      }, climber);
      const page = await context.newPage();
      // A fit that throws leaves the stage half laid out; fail loudly on it.
      page.on("pageerror", (err) => {
        failures += 1;
        console.log(`FAIL ${climber}: uncaught ${String(err.message).slice(0, 200)}`);
      });
      await page.goto(`${baseUrl}/?ui=next&theme=${options.theme}`, { waitUntil: "load" });
      await page.waitForFunction(() => document.querySelector(".v-duel"), null, { timeout: 15000 });
      for (const width of options.widths) {
        await page.setViewportSize({ width, height: width < 600 ? 800 : 900 });
        for (const tab of options.tabs) {
          await page.evaluate((t) => window.SpireVault.switchTab(t), tab);
          await page.waitForTimeout(SETTLE_MS);
          for (const speaker of SPEAKERS) {
            await page.evaluate(([line, who]) => {
              if (line) document.querySelectorAll(".v-bubble-text").forEach((el) => { el.textContent = line; });
              document.querySelectorAll(".v-duel").forEach((duel) => {
                duel.classList.toggle("v-duel--climber-speaks", who === "climber");
                duel.classList.toggle("v-duel--boss-speaks", who === "boss");
              });
            }, [options.line, speaker]);
            // Nudge the width so the stage re-fits around the new line, the
            // way a re-roll does in the app.
            // Two real size changes, a frame apart each, or the observer
            // coalesces them into none.
            await page.setViewportSize({ width: width + 1, height: width < 600 ? 800 : 900 });
            await page.waitForTimeout(200);
            await page.setViewportSize({ width, height: width < 600 ? 800 : 900 });
            await page.waitForTimeout(300);
            const m = await page.evaluate(measure, tab);
            checks += 1;
            const label = `${climber} ${width}px ${tab} (${speaker} speaks)`;
            if (m.error) {
              failures += 1;
              console.log(`FAIL ${label}: ${m.error}`);
              continue;
            }
            const { problems, skipped } = check(m);
            skipped.forEach((k) => {
              const key = `${k}`;
              if (!skippedAt.has(key)) skippedAt.set(key, new Set());
              skippedAt.get(key).add(width);
            });
            if (problems.length) {
              failures += 1;
              console.log(`FAIL ${label}:\n  - ${problems.join("\n  - ")}`);
            }
          }
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }
  for (const [k, widths] of skippedAt) {
    console.log(`note: ${k} not shown at ${[...widths].sort((a, b) => a - b).join(", ")}px`);
  }
  console.log(`${checks - failures}/${checks} stage layouts clean`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
