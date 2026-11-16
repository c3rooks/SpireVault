#!/usr/bin/env node
/**
 * Builds the painted world the landing page (Site/) is set in, from the app's
 * own header art, so the page and the app live in one place:
 *
 *   Site/assets/scene/<id>-<width>-v1.webp        the first screen's scenes, in
 *                                                 the widths the page picks from
 *   Site/assets/scene/<id>-band-<width>-v1.webp   a strip of each section band's
 *                                                 scene (only the strip shows)
 *   Site/assets/figure/<file>                     the app's redrawn figures, at
 *                                                 full and half size
 *   Site/assets/art/epoch/<id>-hand-v1.webp       the hand cards' paintings, at
 *                                                 the size the cards are drawn
 *   Site/css/world-data.css                       generated: each scene's
 *                                                 picture, colours, lights,
 *                                                 shafts and air, each band, and
 *                                                 each climber's figure, seat and
 *                                                 glows, as rules keyed on
 *                                                 [data-scene] / [data-band] /
 *                                                 [data-climber]
 *
 * Every picture is encoded from the masters (scripts/stage-art/scenes, the
 * app's built figures, the game paintings) at the size it is drawn, never
 * past its pixels on a 2x screen and no heavier than it needs to be: the
 * first screen has a weight budget (scripts/verify-site.mjs, perf).
 *
 * The page's CSP has no 'unsafe-inline' for styles, so nothing per-scene or
 * per-climber can be an inline style: it is all here, selected by the
 * attributes boot.js sets before first paint. Hand-written layout and motion
 * are in Site/css/world.css.
 *
 *   node scripts/build-site-world.mjs                 # into Site/
 *   node scripts/build-site-world.mjs --root <dir>    # into a copy of Site/
 *
 * Needs `cwebp` and `dwebp` (Homebrew: brew install webp). Re-run after the
 * app's scenes or figures change (build-stage-scenes.mjs,
 * build-stage-sprites.mjs). The climbers' staging (height, seat, glows) is
 * copied from ACTOR_STAGING in Web/lib/ui/stage.js: keep the two in step.
 * Files are versioned (-v1) because /assets/* is cached for a year: bump
 * ART_VERSION when a picture's pixels change.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootArg = process.argv.indexOf("--root");
const SITE = rootArg === -1 ? join(REPO_ROOT, "Site") : resolve(process.argv[rootArg + 1] || "");
if (!existsSync(join(SITE, "index.html"))) {
  process.stderr.write(`build-site-world: no index.html under ${SITE}\n`);
  process.exit(1);
}

const { STAGE_SCENES } = await import(pathToFileURL(join(REPO_ROOT, "Web/lib/ui/stage-scene-list.js")).href);
const { STAGE_ACTOR_ART } = await import(pathToFileURL(join(REPO_ROOT, "Web/lib/ui/stage-actors.js")).href);

const ART_VERSION = 1;
const SCENE_MASTERS = join(REPO_ROOT, "scripts/stage-art/scenes");
const FIGURES = join(REPO_ROOT, "Web/assets/stage");
const EPOCH = join(SITE, "assets/art/epoch");

/** Scenes used as section bands (index.html data-band), and the closing call's full painting. */
const BANDS = Object.freeze(["campfire", "clouds", "merchant"]);
const CLOSING = "glory";
/** Scenes the first screen deals from (boot.js): every scene not used further down. */
const HERO_SCENES = STAGE_SCENES.map((scene) => scene.id).filter((id) => !BANDS.includes(id) && id !== CLOSING);

/**
 * The first screen's widths, and the window widths that pick them. The plate
 * is at least 780 CSS px on a phone, 1000 on a tablet, the window elsewhere
 * (world.css), so each pair covers 1x and 2x for its windows.
 */
const HERO_WIDTHS = Object.freeze({ 960: 72, 1440: 70, 1920: 66, 2880: 60, 3840: 58 });
const HERO_PICKS = Object.freeze([
  { media: null, x1: 1920, x2: 3840 },
  { media: "(max-width: 1440px)", x1: 1440, x2: 2880 },
  { media: "(max-width: 699px)", x1: 960, x2: 1920 },
]);
/** A band shows a strip of its painting: the ground and the landmark's foot. */
const BAND_STRIP = Object.freeze({ top: 0.38, bottom: 0.96 });
const BAND_WIDTHS = Object.freeze({ 1920: 68, 3840: 58 });
/** The figures: full size, and half size for phones (drawn at most ~160 CSS px tall there). */
const FIGURE_QUALITY = 80;
/**
 * Hand cards are at most ~150 CSS px wide with a 5:4 window, and the
 * paintings are wider (about 1.6:1), so the window crops by height: 400px
 * paintings are ~246px tall, enough for the window's ~120 CSS px at 2x.
 */
const HAND_WIDTH = 400;

/** Lights, shafts and motes the hero's markup has room for. */
const MAX_LIGHTS = 9;
const MAX_SHAFTS = 3;
const MOTES = 24;

/**
 * The climbers' staging, from ACTOR_STAGING in Web/lib/ui/stage.js: height
 * relative to the stage, seat (fractions of the figure's box) and glows
 * (x, y, r as fractions of the figure, colour, flicker or breathe).
 */
const STAGING = Object.freeze({
  ironclad: { height: 0.52, seat: { left: -0.04, top: 0.5, width: 0.6, height: 0.44 }, glows: [[0.53, 0.165, 0.08, "#ff3a2a"]] },
  silent: { height: 0.56, seat: { left: 0.34, top: 0.5, width: 0.64, height: 0.43 }, glows: [[0.255, 0.215, 0.075, "#f2ff5a"]] },
  defect: { height: 0.48, glows: [[0.415, 0.115, 0.09, "#6fe6ff"], [0.42, 0.43, 0.1, "#4fd8ff"]] },
  regent: { height: 0.58, glows: [[0.555, 0.37, 0.07, "#ffe04a"]] },
  necrobinder: { height: 0.55, seat: { left: 0.02, top: 0.58, width: 0.62, height: 0.34 }, glows: [[0.33, 0.19, 0.07, "#4aa8ff"]] },
});
const BOSS = Object.freeze({ id: "architect", height: 0.67, footY: 0.922, glows: [[0.12, 0.215, 0.13, "#5cb8ff", "flicker"]] });
/** Every climber with a hand card, and the painting each card is cut from. */
const HAND = Object.freeze({
  ironclad: "ironclad-2x-v1.webp",
  silent: "silent-2x-v1.webp",
  defect: "defect-2x-v1.webp",
  regent: "regent-2x-v1.webp",
  necrobinder: "necrobinder-2x-v1.webp",
  fool: "fool-560-v1.webp",
});

const pct = (n) => `${Math.round(n * 10000) / 100}%`;
const num = (n) => Math.round(n * 1000) / 1000;
const v = `v${ART_VERSION}`;

/** @param {string} path */
function pixelSize(path) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  return { width: Number(/pixelWidth: (\d+)/.exec(out)?.[1]), height: Number(/pixelHeight: (\d+)/.exec(out)?.[1]) };
}

/**
 * Encodes `from` into `to` with cwebp, unless `to` already exists (files are
 * versioned and immutable: delete one, or bump ART_VERSION, to rebuild it).
 * @param {string} from @param {string} to @param {string[]} args
 */
function encode(from, to, args) {
  if (existsSync(to)) return;
  if (!existsSync(from)) throw new Error(`build-site-world: missing ${from}`);
  if (statSync(from).size === 0) throw new Error(`build-site-world: ${from} is empty (iCloud-evicted? run brctl download on it)`);
  execFileSync("cwebp", ["-quiet", "-m", "6", ...args, from, "-o", to]);
}

/** A deterministic sequence in [0, 1), so the motes sit the same way every build. */
function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** image-set(), prefixed first for Safari before 17. */
function backgrounds(selector, x1, x2) {
  const set = `image-set(url("${x1}") 1x, url("${x2}") 2x)`;
  return `${selector} { background-image: -webkit-${set}; background-image: ${set}; }`;
}

const PULSES = Object.freeze({ breathe: "w-breathe", flicker: "w-flicker", shimmer: "w-shimmer", sway: "w-sway" });
const AIRS = Object.freeze({ dust: "w-dust", fireflies: "w-wander", embers: "w-ember", spores: "w-rise", snow: "w-snow", stars: "w-twinkle" });

function sceneRules(scene) {
  const at = `[data-scene="${scene.id}"]`;
  const lines = [
    `${at} { --sc-deep: ${scene.deep}; --sc-haze: ${scene.haze}; --sc-accent: ${scene.accent}; --sc-veil: ${pct(scene.veil)}; --sc-mist: ${num(scene.mist)}; --sc-focus: ${scene.focus}; }`,
  ];
  scene.lights.slice(0, MAX_LIGHTS).forEach((light, index) => {
    const pace = light.pulse === "flicker" ? 1.6 + (index % 3) * 0.45 : light.pulse === "sway" ? 15 + index * 2 : 6 + (index % 4);
    lines.push(
      `${at} .world-light:nth-of-type(${index + 1}) { display: block; --x: ${pct(light.x)}; --y: ${pct(light.y)}; --r: ${num(light.r)}; --c: ${light.color}; --t: ${num(pace)}s; --d: ${num(-pace * ((index * 0.37) % 1))}s; animation-name: ${PULSES[light.pulse]}; }`
    );
  });
  scene.shafts.slice(0, MAX_SHAFTS).forEach((shaft, index) => {
    lines.push(
      `${at} .world-shaft:nth-of-type(${index + 1}) { display: block; --x: ${pct(shaft.x)}; --w: ${pct(shaft.w)}; --a: ${shaft.angle}deg; --c: ${shaft.color}; --t: ${10 + index * 2.5}s; --d: ${-index * 3.1}s; }`
    );
  });
  const air = scene.air[0];
  if (air) {
    const [left, top, right, bottom] = air.box;
    lines.push(
      `${at} .world-motes { --box-l: ${pct(left)}; --box-t: ${pct(top)}; --box-w: ${pct(right - left)}; --box-h: ${pct(bottom - top)}; }`,
      `${at} .world-motes i { animation-name: ${AIRS[air.kind]}; }`,
      `${at} .world-motes i:nth-child(n + ${Math.min(MOTES, air.count) + 1}) { display: none; }`
    );
  }
  return lines.join("\n");
}

function heroPictureRules() {
  return HERO_PICKS.map(({ media, x1, x2 }) => {
    const rules = HERO_SCENES.map((id) =>
      backgrounds(`[data-scene="${id}"] .world-img`, `/assets/scene/${id}-${x1}-${v}.webp`, `/assets/scene/${id}-${x2}-${v}.webp`)
    ).join("\n");
    return media ? `@media ${media} {\n${rules}\n}` : rules;
  }).join("\n");
}

/** Bands and the closing painting are only painted once near the screen (script.js adds .is-near), or always with JavaScript off. */
function nearSelector(attr, id) {
  return `[${attr}="${id}"].is-near, html:not(.js) [${attr}="${id}"]`;
}

function bandRules(id) {
  const scene = STAGE_SCENES.find((s) => s.id === id);
  return [
    `[data-band="${id}"] { --band-accent: ${scene.accent}; --band-deep: ${scene.deep}; }`,
    `.room[data-room="${id}"] { --room-tint: ${scene.accent}; --room-deep: ${scene.deep}; }`,
    backgrounds(nearSelector("data-band", id), `/assets/scene/${id}-band-1920-${v}.webp`, `/assets/scene/${id}-band-3840-${v}.webp`),
  ].join("\n");
}

function closingRules(id) {
  const scene = STAGE_SCENES.find((s) => s.id === id);
  return [
    `[data-art="${id}"] { --band-accent: ${scene.accent}; --band-deep: ${scene.deep}; }`,
    backgrounds(nearSelector("data-art", id), `/assets/scene/${id}-1920-${v}.webp`, `/assets/scene/${id}-3840-${v}.webp`),
  ].join("\n");
}

function moteRules() {
  const next = sequence(20261115);
  const lines = [];
  for (let i = 1; i <= MOTES; i += 1) {
    const x = num(next());
    const y = num(next());
    const size = num(2.5 + next() * 3.5);
    const pace = num(6 + next() * 9);
    const delay = num(-next() * pace);
    lines.push(
      `.world-motes i:nth-child(${i}) { left: calc(var(--box-l) + var(--box-w) * ${x}); top: calc(var(--box-t) + var(--box-h) * ${y}); --s: ${size}px; --t: ${pace}s; --d: ${delay}s; }`
    );
  }
  return lines.join("\n");
}

/** The figure's two files: full size, and half size for phones. */
const figureFiles = (id) => {
  const full = STAGE_ACTOR_ART[id].src.split("/").pop();
  return { full, half: full.replace(/-v(\d+)\.webp$/, "-half-v$1.webp") };
};

function figureRules(id, staging, art) {
  const at = `[data-climber="${id}"]`;
  const files = figureFiles(id);
  const lines = [
    `${at} .duel-fig--climber { --fig-h: ${staging.height}; --fig-aspect: ${num(art.width / art.height)}; --shadow-l: ${pct(Math.max(0, art.groundLeft - 0.08))}; --shadow-w: ${pct(Math.min(1, art.groundRight + 0.08) - Math.max(0, art.groundLeft - 0.08))}; }`,
    `${at} .duel-fig--climber .duel-art { background-image: url("/assets/figure/${files.full}"); }`,
    `@media (max-width: 699px) { ${at} .duel-fig--climber .duel-art { background-image: url("/assets/figure/${files.half}"); } }`,
  ];
  if (staging.seat) {
    const s = staging.seat;
    lines.push(`${at} .duel-seat { display: block; left: ${pct(s.left)}; top: ${pct(s.top)}; width: ${pct(s.width)}; height: ${pct(s.height)}; }`);
  }
  staging.glows.forEach(([x, y, r, color, pulse], index) => {
    lines.push(
      `${at} .duel-fig--climber .duel-glow:nth-of-type(${index + 1}) { display: block; --x: ${pct(x)}; --y: ${pct(y)}; --r: ${r}; --c: ${color}; --t: ${pulse === "flicker" ? 1.7 : 3.4}s; --d: ${-index * 0.9}s; animation-name: ${pulse === "flicker" ? "w-glow-flicker" : "w-glow-breathe"}; }`
    );
  });
  return lines.join("\n");
}

function bossRules() {
  const art = STAGE_ACTOR_ART[BOSS.id];
  const files = figureFiles(BOSS.id);
  return [
    `.duel-fig--boss { --fig-h: ${BOSS.height}; --fig-aspect: ${num(art.width / art.height)}; --fig-foot: ${BOSS.footY}; --shadow-l: ${pct(art.groundLeft - 0.08)}; --shadow-w: ${pct(art.groundRight - art.groundLeft + 0.16)}; }`,
    `.duel-fig--boss .duel-art { background-image: url("/assets/figure/${files.full}"); }`,
    `@media (max-width: 699px) { .duel-fig--boss .duel-art { background-image: url("/assets/figure/${files.half}"); } }`,
    ...BOSS.glows.map(
      ([x, y, r, color], index) =>
        `.duel-fig--boss .duel-glow:nth-of-type(${index + 1}) { display: block; --x: ${pct(x)}; --y: ${pct(y)}; --r: ${r}; --c: ${color}; --t: 1.7s; --d: 0s; animation-name: w-glow-flicker; }`
    ),
  ].join("\n");
}

function handRules() {
  return Object.keys(HAND)
    .map((id) => `[data-c="${id}"] { --art-hand: url("/assets/art/epoch/${id}-hand-${v}.webp"); }`)
    .join("\n");
}

function buildPictures() {
  const sceneDir = join(SITE, "assets", "scene");
  const figureDir = join(SITE, "assets", "figure");
  mkdirSync(sceneDir, { recursive: true });
  mkdirSync(figureDir, { recursive: true });
  const keepScenes = new Set();
  const keepFigures = new Set();

  for (const id of HERO_SCENES) {
    for (const [width, quality] of Object.entries(HERO_WIDTHS)) {
      const file = `${id}-${width}-${v}.webp`;
      encode(join(SCENE_MASTERS, `${id}.webp`), join(sceneDir, file), ["-q", String(quality), "-sharp_yuv", "-resize", width, "0"]);
      keepScenes.add(file);
    }
  }
  for (const id of BANDS) {
    const master = join(SCENE_MASTERS, `${id}.webp`);
    const { width, height } = pixelSize(master);
    const top = Math.round(height * BAND_STRIP.top);
    const strip = Math.round(height * (BAND_STRIP.bottom - BAND_STRIP.top));
    for (const [out, quality] of Object.entries(BAND_WIDTHS)) {
      const file = `${id}-band-${out}-${v}.webp`;
      encode(master, join(sceneDir, file), ["-q", String(quality), "-sharp_yuv", "-crop", "0", String(top), String(width), String(strip), "-resize", out, "0"]);
      keepScenes.add(file);
    }
  }
  for (const [width, quality] of [[1920, 66], [3840, 58]]) {
    const file = `${CLOSING}-${width}-${v}.webp`;
    encode(join(SCENE_MASTERS, `${CLOSING}.webp`), join(sceneDir, file), ["-q", String(quality), "-sharp_yuv", "-resize", String(width), "0"]);
    keepScenes.add(file);
  }

  // Figures: decoded once, then encoded lighter, full and half height.
  const work = mkdtempSync(join(tmpdir(), "site-world-"));
  try {
    for (const id of [...Object.keys(STAGING), BOSS.id]) {
      const art = STAGE_ACTOR_ART[id];
      const files = figureFiles(id);
      const source = join(FIGURES, art.src.split("/").pop());
      const png = join(work, `${id}.png`);
      if (!existsSync(join(figureDir, files.full)) || !existsSync(join(figureDir, files.half))) execFileSync("dwebp", ["-quiet", source, "-o", png]);
      const alpha = ["-q", String(FIGURE_QUALITY), "-alpha_q", "90", "-exact"];
      encode(png, join(figureDir, files.full), alpha);
      encode(png, join(figureDir, files.half), [...alpha, "-resize", "0", String(Math.round(art.height / 2))]);
      keepFigures.add(files.full);
      keepFigures.add(files.half);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  for (const [id, source] of Object.entries(HAND)) {
    encode(join(EPOCH, source), join(EPOCH, `${id}-hand-${v}.webp`), ["-q", "74", "-sharp_yuv", "-resize", String(HAND_WIDTH), "0"]);
  }

  for (const [dir, keep] of [[sceneDir, keepScenes], [figureDir, keepFigures]]) {
    for (const name of readdirSync(dir)) if (!keep.has(name)) rmSync(join(dir, name));
  }
  return { scenes: keepScenes.size, figures: keepFigures.size };
}

function main() {
  const built = buildPictures();
  const css = [
    "/* GENERATED by scripts/build-site-world.mjs — do not edit by hand.",
    "   The painted world's data, keyed on the attributes boot.js and the",
    "   markup set: each first-screen scene's picture, colours, lights, shafts",
    "   and air ([data-scene]); the section bands and the closing painting",
    "   ([data-band], [data-room], [data-art]); each climber's figure, seat and",
    "   glows ([data-climber]); the hand cards' paintings ([data-c]). Layout",
    "   and motion are in world.css. */",
    ...STAGE_SCENES.filter((scene) => HERO_SCENES.includes(scene.id)).map(sceneRules),
    heroPictureRules(),
    ...BANDS.map(bandRules),
    closingRules(CLOSING),
    moteRules(),
    ...Object.entries(STAGING).map(([id, staging]) => figureRules(id, staging, STAGE_ACTOR_ART[id])),
    bossRules(),
    handRules(),
    "",
  ].join("\n");
  writeFileSync(join(SITE, "css", "world-data.css"), css);
  process.stdout.write(`scenes: ${built.scenes} files, figures: ${built.figures} files, world-data.css ${(css.length / 1024).toFixed(1)} KB\n`);
  process.stdout.write(`first screen deals from: ${HERO_SCENES.join(", ")}\n`);
}

main();
