#!/usr/bin/env node
/**
 * Builds the painted scenes behind the new UI's header stage.
 *
 * Each scene is one hand-painted, ink-lined panorama (3840x1280, 3:1) kept as
 * a master under scripts/stage-art/scenes/<id>.webp. The page never loads a
 * master: this writes two web sizes per scene and the list the header reads.
 *
 *   Web/assets/stage/scenes/<id>-<width>-v<N>.webp   1920 and 3840 wide
 *   Web/lib/ui/stage-scene-list.js                    the list, generated
 *
 * Every scene also carries its look, authored here beside its file: the
 * room's own colours (deep shadow, haze, accent), where its lights burn and
 * how they move (a candle flickers, the moon breathes), the light shafts that
 * fall through it, what floats in its air, and `focus`, the height of the
 * picture (0 top, 1 bottom) that sits on the stage's bottom edge, so some
 * near floor can be cropped and the room shows more wall. Positions are
 * fractions of the picture, so they stay put however the header crops it.
 *
 * Adding a scene: drop its master in scripts/stage-art/scenes/, add an entry
 * to SCENES below, run this. The header deals scenes from this list, a new
 * one every time a tab with a stage is opened (lib/ui/stage-scenes.js).
 *
 *   node scripts/build-stage-scenes.mjs            # build everything
 *   node scripts/build-stage-scenes.mjs --dry      # check masters, write nothing
 *
 * Needs `cwebp` (Homebrew: brew install webp). Not part of `make preflight`.
 * Filenames carry a version because /assets/* is cached for a year: bump
 * ART_VERSION when the encode settings change, or a scene's own `version`
 * when only its picture does. A full build removes images the list no
 * longer names.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER_DIR = join(REPO_ROOT, "scripts", "stage-art", "scenes");
const OUT_DIR = join(REPO_ROOT, "Web", "assets", "stage", "scenes");
const MODULE_FILE = join(REPO_ROOT, "Web", "lib", "ui", "stage-scene-list.js");

const ART_VERSION = 1;

/** The masters' shape: every scene is painted at this size. */
const MASTER = Object.freeze({ width: 3840, height: 1280 });

/**
 * Web sizes. The small one serves phones and 1x screens; the large one 2x
 * desktops, where the header is up to ~1900 CSS px wide.
 */
const SIZES = Object.freeze([
  Object.freeze({ width: 1920, quality: 74 }),
  Object.freeze({ width: 3840, quality: 64 }),
]);

/**
 * @typedef {{ x: number, y: number, r: number, color: string, pulse: "breathe" | "flicker" | "shimmer" | "sway" }} Light
 *   x, y: centre as fractions of the picture; r: radius as a fraction of its width.
 *   breathe: slow rise and fall (moon, honey, crystal); flicker: a flame;
 *   shimmer: a reflection on water or polish; sway: a wide band drifting side
 *   to side (an aurora's curtains)
 * @typedef {{ x: number, w: number, angle: number, color: string }} Shaft
 *   x: where the shaft starts along the top edge; w: its width; angle: lean in
 *   degrees, as CSS rotate (negative swings the foot to the right)
 * @typedef {{ kind: "dust" | "fireflies" | "embers" | "spores" | "snow" | "stars", count: number,
 *             box: [number, number, number, number] }} Air
 *   box: [left, top, right, bottom] fractions of the picture the motes live in
 * @typedef {{ id: string, label: string, version?: number, focus: number,
 *             deep: string, haze: string, accent: string, veil?: number, mist?: number,
 *             lights: Light[], shafts: Shaft[], air: Air[] }} Scene
 *   veil: how much of the theme's dark settles over the whole room (0-1);
 *   mist: how thick the drifting mist is, 1 being the usual (0 none, up to 1.6)
 */

const PULSES = new Set(["breathe", "flicker", "shimmer", "sway"]);
const AIRS = new Set(["dust", "fireflies", "embers", "spores", "snow", "stars"]);

/** @type {ReadonlyArray<Scene>} */
const SCENES = Object.freeze([
  {
    id: "glory",
    label: "The Hall of Glory",
    focus: 0.86,
    deep: "#0a1233",
    haze: "#a6e4ff",
    accent: "#bff4ff",
    mist: 0.8,
    lights: [
      { x: 0.435, y: 0.133, r: 0.07, color: "#c9f6ff", pulse: "breathe" },
      { x: 0.47, y: 0.7, r: 0.09, color: "#7fdcff", pulse: "shimmer" },
      { x: 0.47, y: 0.83, r: 0.11, color: "#5fc8ff", pulse: "shimmer" },
    ],
    shafts: [
      { x: 0.38, w: 0.045, angle: -10, color: "#a6eaff" },
      { x: 0.43, w: 0.07, angle: -12, color: "#c2f3ff" },
      { x: 0.5, w: 0.035, angle: -14, color: "#a6eaff" },
    ],
    air: [{ kind: "dust", count: 16, box: [0.3, 0.15, 0.62, 0.85] }],
  },
  {
    id: "hive",
    label: "The Hive",
    focus: 0.86,
    deep: "#1c0f04",
    haze: "#ffd36b",
    accent: "#ffc53d",
    mist: 0.7,
    lights: [
      { x: 0.47, y: 0.22, r: 0.15, color: "#ffb52e", pulse: "breathe" },
      { x: 0.44, y: 0.58, r: 0.08, color: "#ffd25a", pulse: "breathe" },
      { x: 0.56, y: 0.74, r: 0.17, color: "#c4e85a", pulse: "breathe" },
      { x: 0.82, y: 0.1, r: 0.07, color: "#ffb52e", pulse: "breathe" },
    ],
    shafts: [],
    air: [{ kind: "spores", count: 18, box: [0.3, 0.3, 0.98, 0.88] }],
  },
  {
    id: "study",
    label: "The Architect's observatory",
    focus: 0.87,
    deep: "#140c26",
    haze: "#ffd2a0",
    accent: "#ffd27a",
    veil: 0.06,
    mist: 0.35,
    lights: [
      { x: 0.225, y: 0.35, r: 0.035, color: "#ffc062", pulse: "flicker" },
      { x: 0.31, y: 0.47, r: 0.03, color: "#ffc062", pulse: "flicker" },
      { x: 0.36, y: 0.53, r: 0.028, color: "#ffc062", pulse: "flicker" },
      { x: 0.578, y: 0.48, r: 0.026, color: "#ffc062", pulse: "flicker" },
      { x: 0.508, y: 0.57, r: 0.022, color: "#ffc062", pulse: "flicker" },
      { x: 0.45, y: 0.3, r: 0.1, color: "#ffcf7a", pulse: "breathe" },
    ],
    shafts: [],
    air: [{ kind: "stars", count: 22, box: [0.6, 0.02, 0.99, 0.36] }],
  },
  {
    id: "overgrowth",
    label: "The Overgrowth",
    focus: 0.86,
    deep: "#06140c",
    haze: "#b8f5c8",
    accent: "#d6ff8a",
    mist: 0.9,
    lights: [
      { x: 0.53, y: 0.44, r: 0.06, color: "#c8ff8a", pulse: "breathe" },
      { x: 0.385, y: 0.48, r: 0.022, color: "#a8ffe0", pulse: "breathe" },
      { x: 0.365, y: 0.66, r: 0.024, color: "#a8ffe0", pulse: "breathe" },
      { x: 0.6, y: 0.665, r: 0.024, color: "#a8ffe0", pulse: "breathe" },
      { x: 0.625, y: 0.445, r: 0.02, color: "#a8ffe0", pulse: "breathe" },
      { x: 0.065, y: 0.785, r: 0.026, color: "#a8ffe0", pulse: "breathe" },
      { x: 0.975, y: 0.92, r: 0.022, color: "#a8ffe0", pulse: "breathe" },
    ],
    shafts: [
      { x: 0.3, w: 0.035, angle: -34, color: "#e4ff9a" },
      { x: 0.335, w: 0.05, angle: -32, color: "#d8ff8a" },
      { x: 0.375, w: 0.03, angle: -30, color: "#e4ff9a" },
    ],
    air: [{ kind: "fireflies", count: 22, box: [0.25, 0.35, 0.98, 0.84] }],
  },
  {
    id: "underdocks",
    label: "The Underdocks",
    focus: 0.86,
    deep: "#120a1f",
    haze: "#b9a6ff",
    accent: "#8dffb0",
    mist: 1.1,
    lights: [
      { x: 0.375, y: 0.24, r: 0.05, color: "#7dff9a", pulse: "flicker" },
      { x: 0.338, y: 0.42, r: 0.02, color: "#7dff9a", pulse: "flicker" },
      { x: 0.444, y: 0.455, r: 0.02, color: "#7dff9a", pulse: "flicker" },
      { x: 0.508, y: 0.51, r: 0.016, color: "#7dff9a", pulse: "flicker" },
      { x: 0.551, y: 0.43, r: 0.016, color: "#7dff9a", pulse: "flicker" },
      { x: 0.4, y: 0.75, r: 0.06, color: "#6dff9a", pulse: "shimmer" },
      { x: 0.535, y: 0.735, r: 0.05, color: "#6dff9a", pulse: "shimmer" },
    ],
    shafts: [],
    air: [{ kind: "dust", count: 14, box: [0.3, 0.2, 0.75, 0.75] }],
  },
  {
    id: "campfire",
    label: "The rest site",
    focus: 0.86,
    deep: "#070b1f",
    haze: "#8ea4e6",
    accent: "#ffb15a",
    mist: 0.6,
    lights: [
      { x: 0.395, y: 0.72, r: 0.13, color: "#ff7a2a", pulse: "flicker" },
      { x: 0.395, y: 0.69, r: 0.045, color: "#ffd27a", pulse: "flicker" },
      { x: 0.535, y: 0.3, r: 0.05, color: "#ff5a3a", pulse: "breathe" },
    ],
    shafts: [],
    air: [
      { kind: "embers", count: 18, box: [0.36, 0.42, 0.44, 0.72] },
      { kind: "stars", count: 16, box: [0.6, 0.02, 0.98, 0.3] },
    ],
  },
  {
    id: "merchant",
    label: "The merchant's tent",
    focus: 0.87,
    deep: "#1a0614",
    haze: "#ffb3c8",
    accent: "#ffd27a",
    mist: 0.25,
    lights: [
      { x: 0.443, y: 0.24, r: 0.035, color: "#ffc35a", pulse: "flicker" },
      { x: 0.495, y: 0.2, r: 0.05, color: "#ffc35a", pulse: "flicker" },
      { x: 0.59, y: 0.26, r: 0.03, color: "#ffc35a", pulse: "flicker" },
      { x: 0.44, y: 0.39, r: 0.04, color: "#ff7ab8", pulse: "breathe" },
    ],
    shafts: [],
    air: [{ kind: "dust", count: 18, box: [0.3, 0.15, 0.7, 0.8] }],
  },
  {
    id: "crystal",
    label: "The Crystal Depths",
    focus: 0.86,
    deep: "#12061f",
    haze: "#e7b8ff",
    accent: "#ffc2f0",
    mist: 0.8,
    lights: [
      { x: 0.44, y: 0.4, r: 0.1, color: "#e08aff", pulse: "breathe" },
      { x: 0.32, y: 0.48, r: 0.05, color: "#ff9ad6", pulse: "breathe" },
      { x: 0.27, y: 0.64, r: 0.03, color: "#e08aff", pulse: "breathe" },
      { x: 0.7, y: 0.45, r: 0.04, color: "#ff8ad0", pulse: "breathe" },
      { x: 0.65, y: 0.1, r: 0.04, color: "#ff9ae0", pulse: "breathe" },
      { x: 0.42, y: 0.74, r: 0.08, color: "#f0a0ff", pulse: "shimmer" },
    ],
    shafts: [],
    air: [{ kind: "stars", count: 20, box: [0.28, 0.12, 0.75, 0.7] }],
  },
  {
    id: "aurora",
    label: "The Frozen Ledge",
    focus: 0.86,
    deep: "#04101e",
    haze: "#b8ecff",
    accent: "#c8fff0",
    mist: 0.8,
    lights: [
      { x: 0.42, y: 0.12, r: 0.14, color: "#4dffb0", pulse: "sway" },
      { x: 0.58, y: 0.22, r: 0.12, color: "#3dffc8", pulse: "sway" },
      { x: 0.8, y: 0.1, r: 0.12, color: "#3dffb0", pulse: "sway" },
      // The curtains' lower hems, low enough to show in a wide header.
      { x: 0.44, y: 0.33, r: 0.07, color: "#4dffb0", pulse: "sway" },
      { x: 0.64, y: 0.36, r: 0.08, color: "#3dffc8", pulse: "sway" },
      { x: 0.51, y: 0.55, r: 0.05, color: "#a8f0ff", pulse: "breathe" },
    ],
    shafts: [],
    air: [{ kind: "snow", count: 32, box: [0.02, 0, 0.98, 0.75] }],
  },
  {
    id: "embers",
    label: "The Ember Wastes",
    focus: 0.86,
    deep: "#1a0604",
    haze: "#ff9a7a",
    accent: "#ffb05a",
    veil: 0.16,
    mist: 0.6,
    lights: [
      { x: 0.405, y: 0.21, r: 0.08, color: "#ffa040", pulse: "breathe" },
      { x: 0.44, y: 0.55, r: 0.06, color: "#ff7a2a", pulse: "shimmer" },
      { x: 0.55, y: 0.66, r: 0.07, color: "#ff6a2a", pulse: "shimmer" },
      { x: 0.72, y: 0.58, r: 0.05, color: "#ff7a2a", pulse: "shimmer" },
      { x: 0.3, y: 0.9, r: 0.05, color: "#ff5a1a", pulse: "breathe" },
      { x: 0.85, y: 0.93, r: 0.04, color: "#ff5a1a", pulse: "breathe" },
    ],
    shafts: [],
    air: [{ kind: "embers", count: 26, box: [0.1, 0.35, 0.98, 0.95] }],
  },
  {
    id: "clouds",
    label: "Above the clouds",
    focus: 0.86,
    deep: "#2a1a3a",
    haze: "#ffd6e6",
    accent: "#ffe2b8",
    veil: 0.24,
    mist: 1.2,
    lights: [{ x: 0.385, y: 0.27, r: 0.09, color: "#fff1c0", pulse: "breathe" }],
    shafts: [],
    air: [{ kind: "dust", count: 12, box: [0.3, 0.2, 0.9, 0.8] }],
  },
  {
    id: "crypt",
    label: "The Ossuary",
    focus: 0.86,
    deep: "#031210",
    haze: "#9dffd6",
    accent: "#a8ffc8",
    mist: 1.3,
    lights: [
      { x: 0.42, y: 0.4, r: 0.08, color: "#6dffc0", pulse: "breathe" },
      { x: 0.295, y: 0.53, r: 0.03, color: "#7dff9a", pulse: "flicker" },
      { x: 0.355, y: 0.45, r: 0.03, color: "#7dff9a", pulse: "flicker" },
      { x: 0.39, y: 0.64, r: 0.03, color: "#7dff9a", pulse: "flicker" },
      { x: 0.475, y: 0.49, r: 0.022, color: "#7dff9a", pulse: "flicker" },
      { x: 0.485, y: 0.59, r: 0.028, color: "#7dff9a", pulse: "flicker" },
      { x: 0.535, y: 0.53, r: 0.022, color: "#7dff9a", pulse: "flicker" },
      { x: 0.61, y: 0.56, r: 0.02, color: "#7dff9a", pulse: "flicker" },
    ],
    shafts: [],
    air: [{ kind: "fireflies", count: 14, box: [0.25, 0.3, 0.95, 0.8] }],
  },
]);

/** @param {string} message */
function fail(message) {
  process.stderr.write(`build-stage-scenes: ${message}\n`);
  process.exit(1);
}

/** @param {string} path */
function pixelSize(path) {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
  const width = Number(/pixelWidth: (\d+)/.exec(out)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(out)?.[1]);
  return { width, height };
}

/** @param {Scene} scene */
function checkScene(scene) {
  const master = join(MASTER_DIR, `${scene.id}.webp`);
  if (!existsSync(master)) fail(`no master for "${scene.id}" (expected ${master})`);
  if (statSync(master).size === 0) fail(`${master} is empty (iCloud-evicted? run brctl download on it)`);
  const { width, height } = pixelSize(master);
  if (width !== MASTER.width || height !== MASTER.height) {
    fail(`${scene.id}: master is ${width}x${height}, expected ${MASTER.width}x${MASTER.height}`);
  }
  if (!(scene.focus > 0.5 && scene.focus <= 1)) fail(`${scene.id}: focus ${scene.focus} out of range`);
  if (scene.mist !== undefined && !(scene.mist >= 0 && scene.mist <= 1.6)) fail(`${scene.id}: mist ${scene.mist} out of range`);
  if (scene.veil !== undefined && !(scene.veil >= 0 && scene.veil <= 1)) fail(`${scene.id}: veil ${scene.veil} out of range`);
  for (const light of scene.lights) {
    if (!PULSES.has(light.pulse)) fail(`${scene.id}: unknown light pulse "${light.pulse}"`);
  }
  if (!Array.isArray(scene.air) || scene.air.length === 0) fail(`${scene.id}: air must list at least one layer`);
  for (const air of scene.air) {
    if (!AIRS.has(air.kind)) fail(`${scene.id}: unknown air "${air.kind}"`);
    if (air.box.length !== 4 || air.box.some((edge) => !(edge >= 0 && edge <= 1))) fail(`${scene.id}: air box out of range`);
  }
  return master;
}

/** @param {Scene} scene */
const fileName = (scene, width) => `${scene.id}-${width}-v${scene.version ?? ART_VERSION}.webp`;

/** @param {number} n */
const round = (n) => Math.round(n * 1000) / 1000;

/** The generated ES module the page imports. */
function moduleSource() {
  const rows = SCENES.map((scene) => {
    const srcset = SIZES.map((size) => `"/assets/stage/scenes/${fileName(scene, size.width)} ${size.width}w"`).join(", ");
    const lights = scene.lights
      .map((l) => `{ x: ${round(l.x)}, y: ${round(l.y)}, r: ${round(l.r)}, color: "${l.color}", pulse: "${l.pulse}" }`)
      .join(", ");
    const shafts = scene.shafts
      .map((s) => `{ x: ${round(s.x)}, w: ${round(s.w)}, angle: ${s.angle}, color: "${s.color}" }`)
      .join(", ");
    const air = scene.air
      .map((layer) => `{ kind: "${layer.kind}", count: ${layer.count}, box: [${layer.box.map(round).join(", ")}] }`)
      .join(", ");
    return [
      `  Object.freeze({`,
      `    id: "${scene.id}",`,
      `    label: ${JSON.stringify(scene.label)},`,
      `    srcset: [${srcset}].join(", "),`,
      `    src: "/assets/stage/scenes/${fileName(scene, SIZES[0].width)}",`,
      `    width: ${MASTER.width},`,
      `    height: ${MASTER.height},`,
      `    focus: ${scene.focus},`,
      `    deep: "${scene.deep}",`,
      `    haze: "${scene.haze}",`,
      `    accent: "${scene.accent}",`,
      `    veil: ${scene.veil ?? 0.14},`,
      `    mist: ${scene.mist ?? 1},`,
      `    lights: Object.freeze([${lights}]),`,
      `    shafts: Object.freeze([${shafts}]),`,
      `    air: Object.freeze([${air}]),`,
      `  }),`,
    ].join("\n");
  }).join("\n");
  return `// GENERATED by scripts/build-stage-scenes.mjs — do not edit by hand.
//
// The painted scenes behind the header stage, one entry per scene: the
// picture (3:1, two widths) and its look. Positions (lights, shafts, the
// air's box) are fractions of the picture; a light's r is a fraction of its
// width. focus is the height of the picture (0 top, 1 bottom) that sits on
// the stage's bottom edge. veil is how strongly the theme's dark settles
// over the whole room; mist how thick its drifting mist is (1 the usual).
// air lists what floats in the room, one layer per kind.

/**
 * @typedef {{ x: number, y: number, r: number, color: string, pulse: "breathe" | "flicker" | "shimmer" | "sway" }} SceneLight
 * @typedef {{ x: number, w: number, angle: number, color: string }} SceneShaft
 * @typedef {{ kind: "dust" | "fireflies" | "embers" | "spores" | "snow" | "stars", count: number, box: ReadonlyArray<number> }} SceneAir
 * @typedef {Object} StageScene
 * @property {string} id
 * @property {string} label
 * @property {string} srcset
 * @property {string} src
 * @property {number} width
 * @property {number} height
 * @property {number} focus
 * @property {string} deep
 * @property {string} haze
 * @property {string} accent
 * @property {number} veil
 * @property {number} mist
 * @property {ReadonlyArray<SceneLight>} lights
 * @property {ReadonlyArray<SceneShaft>} shafts
 * @property {ReadonlyArray<SceneAir>} air
 */

/** @type {ReadonlyArray<StageScene>} */
export const STAGE_SCENES = Object.freeze([
${rows}
]);
`;
}

function main() {
  const dry = process.argv.includes("--dry");
  const ids = new Set();
  const masters = SCENES.map((scene) => {
    if (ids.has(scene.id)) fail(`duplicate scene id "${scene.id}"`);
    ids.add(scene.id);
    return { scene, master: checkScene(scene) };
  });
  if (dry) {
    process.stdout.write(`${masters.length} scenes OK\n`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const written = new Set();
  for (const { scene, master } of masters) {
    for (const size of SIZES) {
      const out = join(OUT_DIR, fileName(scene, size.width));
      const resize = size.width === MASTER.width ? [] : ["-resize", String(size.width), "0"];
      execFileSync("cwebp", ["-quiet", "-q", String(size.quality), "-m", "6", "-sharp_yuv", ...resize, master, "-o", out]);
      written.add(fileName(scene, size.width));
      process.stdout.write(`${fileName(scene, size.width).padEnd(28)} ${(statSync(out).size / 1024).toFixed(0)} KB\n`);
    }
  }
  for (const name of readdirSync(OUT_DIR)) {
    if (name.endsWith(".webp") && !written.has(name)) rmSync(join(OUT_DIR, name));
  }
  writeFileSync(MODULE_FILE, moduleSource());
  process.stdout.write(`wrote ${MODULE_FILE}\n`);
}

main();
