#!/usr/bin/env node
/**
 * Builds full-height combat-room art for the landing page (Site/) from the
 * installed game.
 *
 * The same rooms, layer recipes and tone curve as the web app's header
 * (build-stage-backdrops.mjs), with three differences: the WHOLE canvas is
 * kept instead of a 420px band (the landing hero is a tall scene whose
 * figures stand on the game's own floor), every room is composed at its
 * native resolution, and nothing under Web/ is touched.
 *
 *   Site/assets/hero/<room>-<take>-<base|mid|front>-v<N>.webp   layered rooms
 *   Site/assets/hero/<room>-<take>-flat-v<N>.webp               every take, flattened
 *   Site/assets/hero/<room>-<take>-flat-sm-v<N>.webp            phone cut of the same
 *   scripts/site-rooms.generated.json                           what was written
 *
 * An asset build, run by hand; it needs Playwright and the game.
 *
 *   node scripts/build-site-backdrops.mjs --list
 *   node scripts/build-site-backdrops.mjs --all --dry --preview <dir> [--guides]
 *   node scripts/build-site-backdrops.mjs --room glory,hive --take a
 *   node scripts/build-site-backdrops.mjs --room study-a --room underdocks-b
 *   node scripts/build-site-backdrops.mjs --room falls --saturation 1.3 --highlight 0.64 --median 0.2
 *   node scripts/build-site-backdrops.mjs --all "/path/to/Slay the Spire 2.pck"
 *
 * `--room` takes `<id>` or `<id>-<take>`, repeated or comma separated;
 * `--take` is the take for rooms named without one (else every take).
 * `--out <dir>` moves the images (never inside Web/). `--dry` composes and
 * writes previews only. `--preview <dir>` writes one flattened JPEG per take
 * and `contact-sheet.png`; `--guides` adds `contact-sheet-guides.png`, the
 * same sheet with the wall foot and the duel's two spots marked.
 * `--saturation`, `--highlight` and `--median` take a number (GRADE below).
 *
 * Filenames carry a version because /assets/* is cached for a year: bump
 * ART_VERSION when the pixels change. Nothing is ever deleted.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openPck, loadImage, imageDataUrl, pckPathFromArgs, arg, flag } from "./sts2-pck/pck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(REPO_ROOT, "Web");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "Site", "assets", "hero");
const MANIFEST_FILE = join(REPO_ROOT, "scripts", "site-rooms.generated.json");
const SCRIPT_NAME = "build-site-backdrops";

const ART_VERSION = 1;

/** The game's background canvas: recipes measure `foot` on it, and every layer is stretched over it. */
const GAME_CANVAS = Object.freeze({ width: 2048, height: 960 });

/** The band the app's header cuts around the foot; only used to carry `water` rectangles over. */
const APP_BAND = Object.freeze({ above: 344, below: 76 });

/** Tone targets after grading, as 0–1 luma (the app's curve; saturation is the landing page's). */
const GRADE = Object.freeze({
  highlight: 0.6, // where the room's 98th percentile lands
  median: 0.19, // where its median lands
  maxGain: 2.6,
  minGamma: 0.62,
  maxGamma: 1.6,
  saturation: 1.2,
});

/** WebP quality per picture. */
const ENCODE = Object.freeze({ base: 0.72, mid: 0.7, front: 0.74, flat: 0.78, flatSm: 0.78 });

/** How each picture is named in a file. */
const FILE_SUFFIX = Object.freeze({ base: "base", mid: "mid", front: "front", flat: "flat", flatSm: "flat-sm" });

/** The phone cut: this share of the width from the right-hand edge, full height, scaled to this height. */
const PHONE_CUT = Object.freeze({ share: 0.55, height: 720 });

const PREVIEW = Object.freeze({ width: 1024, quality: 0.85 });
const SHEET = Object.freeze({ columns: 3, tileWidth: 640 });

/** Where the landing hero stands its duel, as fractions of the picture (drawn by --guides). */
const FIGURES = Object.freeze({ player: 0.58, boss: 0.75, floor: 0.7 });

/** The strip the hero's cards sit on: its mean luma is reported per take. */
const FLOOR_SHARE = 0.25;

/** The machine this runs on is often saturated; nothing here should time out early. */
const TIMEOUT_MS = 300_000;

const PLANES = Object.freeze(["base", "mid", "front"]);

/** Godot Image::Format of a GPU-compressed texture, as --list names it. */
const VRAM_NAMES = Object.freeze({ 17: "dxt1", 18: "dxt3", 19: "dxt5", 22: "bc7" });

const room = (dir, names) => names.map((name) => `images/rooms/${dir}/${name}.png`);

/**
 * Rooms and their takes, as in build-stage-backdrops.mjs (keep the two in
 * step). Each plane lists full-canvas textures, back to front; `foot` is the
 * game-canvas y of the foot of the wall; `flip` mirrors a take whose
 * right-hand end is busy where the duel stands; `water` marks falling water
 * as [left, top, width, height] fractions of the app's band, before any flip.
 *
 * @typedef {{ base: string[], mid?: string[], front?: string[], foot: number, flip?: boolean, water?: number[][] }} Take
 * @typedef {{ id: string, label: string, takes: Record<string, Take> }} Room
 * @type {ReadonlyArray<Room>}
 */
const ROOMS = Object.freeze([
  {
    id: "glory",
    label: "Glory",
    takes: {
      a: { base: room("glory", ["glory_00"]), mid: room("glory", ["glory_01_a", "glory_02_a"]), front: room("glory", ["glory_03_a"]), foot: 462 },
      b: { base: room("glory", ["glory_00"]), mid: room("glory", ["glory_01_b", "glory_02_b"]), front: room("glory", ["glory_03_b"]), foot: 470 },
      c: { base: room("glory", ["glory_00"]), mid: room("glory", ["glory_01_c", "glory_02_c"]), front: room("glory", ["glory_03_c"]), foot: 474 },
    },
  },
  {
    id: "hive",
    label: "Hive",
    takes: {
      a: { base: room("hive", ["hive_00"]), mid: room("hive", ["hive_01_a", "hive_02_a"]), front: room("hive", ["hive_03_a"]), foot: 446 },
      b: { base: room("hive", ["hive_00"]), mid: room("hive", ["hive_01_b", "hive_02_b"]), front: room("hive", ["hive_03_b"]), foot: 446 },
      c: { base: room("hive", ["hive_00"]), mid: room("hive", ["hive_01_a", "hive_02_c"]), front: room("hive", ["hive_03_c"]), foot: 446 },
    },
  },
  {
    id: "overgrowth",
    label: "Overgrowth",
    takes: {
      a: {
        base: room("overgrowth", ["overgrowth_00"]),
        mid: room("overgrowth", ["overgrowth_01_a", "overgrowth_02_a"]),
        front: room("overgrowth", ["overgrowth_03_a", "overgrowth_04_a"]),
        foot: 496,
      },
      b: {
        base: room("overgrowth", ["overgrowth_00"]),
        mid: room("overgrowth", ["overgrowth_01_b", "overgrowth_02_b"]),
        front: room("overgrowth", ["overgrowth_03_b"]),
        foot: 496,
      },
    },
  },
  {
    id: "underdocks",
    label: "Underdocks",
    takes: {
      a: { base: room("underdocks", ["underdocks_00"]), mid: room("underdocks", ["underdocks_01_a"]), front: room("underdocks", ["underdocks_02_a"]), foot: 404, flip: true },
      b: { base: room("underdocks", ["underdocks_00"]), mid: room("underdocks", ["underdocks_01_b"]), front: room("underdocks", ["underdocks_02_b"]), foot: 404 },
      c: { base: room("underdocks", ["underdocks_00"]), mid: room("underdocks", ["underdocks_01_c"]), front: room("underdocks", ["underdocks_02_c"]), foot: 404, flip: true },
    },
  },
  {
    // The Architect's own room (the_architect_event_encounter): his study.
    id: "study",
    label: "The Architect's study",
    takes: {
      // Mirrored: his easel would otherwise stand right behind the climber's head.
      a: { base: ["images/rooms/architect_victory/architect_victory_bg.png"], foot: 600, flip: true },
    },
  },
  {
    id: "falls",
    label: "Waterfall grotto",
    takes: {
      a: {
        base: ["images/rooms/waterfall_giant_bg/waterfallgiant_bg_4.png"],
        foot: 430,
        // The three falls on the right, and the wide curtain behind the pool.
        water: [
          [0.683, 0, 0.079, 0.74],
          [0.772, 0.1, 0.03, 0.62],
          [0.826, 0.02, 0.05, 0.72],
          [0.36, 0, 0.045, 0.2],
        ],
      },
    },
  },
]);

/** A mistake in how the script was called: reported without a stack. */
class UsageError extends Error {}

// ---------------------------------------------------------------- page side
// These run inside the Chromium page, not in Node: the helpers are injected
// once as globals (see openPage), the two *InPage functions go to evaluate().

/* global document, Image */

function newCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** One plane: its layer textures stretched over the canvas, back to front, mirrored when `flip`. */
async function stackLayers(urls, size, flip) {
  const canvas = newCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  if (flip) ctx.setTransform(-1, 0, 0, 1, size.width, 0);
  for (const url of urls) {
    const image = new Image();
    image.src = url;
    await image.decode();
    ctx.drawImage(image, 0, 0, size.width, size.height);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

/** Canvases drawn over one another, in order. */
function flatten(canvases, size) {
  const flat = newCanvas(size.width, size.height);
  const ctx = flat.getContext("2d", { willReadFrequently: true });
  for (const canvas of canvases) ctx.drawImage(canvas, 0, 0);
  return flat;
}

/** The room's tone curve — one gain, one gamma — measured on the flattened room. */
function toneCurve(flat, grade) {
  const data = flat.getContext("2d").getImageData(0, 0, flat.width, flat.height).data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    histogram[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
  }
  const total = data.length / 4;
  const percentile = (share) => {
    let seen = 0;
    for (let value = 0; value < 256; value++) {
      seen += histogram[value];
      if (seen >= total * share) return value / 255;
    }
    return 1;
  };
  const p50 = Math.max(percentile(0.5), 1 / 255);
  const p98 = Math.max(percentile(0.98), 2 / 255);
  const gain = Math.min(grade.maxGain, Math.max(1, grade.highlight / p98));
  const lifted = Math.min(0.98, p50 * gain);
  const gamma = Math.min(grade.maxGamma, Math.max(grade.minGamma, Math.log(grade.median) / Math.log(lifted)));
  const curve = new Uint8ClampedArray(256);
  for (let value = 0; value < 256; value++) {
    curve[value] = Math.round(255 * Math.pow(Math.min(1, (value / 255) * gain), gamma));
  }
  return { curve, stats: { p50: +p50.toFixed(3), p98: +p98.toFixed(3), gain: +gain.toFixed(2), gamma: +gamma.toFixed(2) } };
}

/** Grades a canvas in place: every pixel through the same curve, so the room keeps its own colours. */
function applyGrade(canvas, curve, saturation, opaque) {
  const ctx = canvas.getContext("2d");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = curve[data[i]];
    const g = curve[data[i + 1]];
    const b = curve[data[i + 2]];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    data[i] = luma + (r - luma) * saturation;
    data[i + 1] = luma + (g - luma) * saturation;
    data[i + 2] = luma + (b - luma) * saturation;
    if (opaque) data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
}

/** A full-height slice of `source` (from `left`, `sliceWidth` wide) resampled to width x height. */
function resample(source, left, sliceWidth, width, height) {
  const out = newCanvas(width, height);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, left, 0, sliceWidth, source.height, 0, 0, width, height);
  return out;
}

/** Mean luma (0–1) of the bottom `share` of a canvas. */
function meanLumaOfFloor(canvas, share) {
  const rows = Math.round(canvas.height * share);
  const data = canvas.getContext("2d").getImageData(0, canvas.height - rows, canvas.width, rows).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return +(sum / (data.length / 4) / 255).toFixed(3);
}

/**
 * Composes one take: stacks each plane on the canvas, grades every plane
 * with the one curve measured on the flattened room, and encodes the planes
 * (layered rooms only), the flattened picture, its phone cut and a preview.
 * @returns {Promise<{ files: Record<string, { url: string, width: number, height: number }>, preview: string, stats: object, floorLuma: number }>}
 */
async function composeTakeInPage({ planes, size, flip, grade, encode, phone, preview, floorShare }) {
  const names = Object.keys(planes);
  const canvases = [];
  for (const name of names) canvases.push(await stackLayers(planes[name], size, flip));
  const { curve, stats } = toneCurve(flatten(canvases, size), grade);
  names.forEach((name, index) => applyGrade(canvases[index], curve, grade.saturation, name === "base"));
  const flat = flatten(canvases, size);

  const sliceWidth = Math.round(size.width * phone.share);
  const small = resample(flat, size.width - sliceWidth, sliceWidth, Math.round((sliceWidth * phone.height) / size.height), phone.height);
  const shown = resample(flat, 0, size.width, preview.width, Math.round((preview.width * size.height) / size.width));

  const webp = (canvas, quality) => ({ url: canvas.toDataURL("image/webp", quality), width: canvas.width, height: canvas.height });
  const files = {};
  // A room painted as one picture is its own flattened picture: no planes.
  if (names.length > 1) names.forEach((name, index) => (files[name] = webp(canvases[index], encode[name])));
  files.flat = webp(flat, encode.flat);
  files.flatSm = webp(small, encode.flatSm);
  return { files, preview: shown.toDataURL("image/jpeg", preview.quality), stats, floorLuma: meanLumaOfFloor(flat, floorShare) };
}

/** A tile's name plate and, with `figures`, the wall foot and the two spots the duel stands on. */
function drawTileMarks(ctx, tile, box, figures) {
  ctx.font = "600 20px Helvetica, Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(10, 10, 12, 0.78)";
  ctx.fillRect(box.x, box.y, ctx.measureText(tile.name).width + 20, 32);
  ctx.fillStyle = "#f4ecd8";
  ctx.fillText(tile.name, box.x + 10, box.y + 17);
  if (!figures) return;
  const footY = box.y + tile.footRatio * box.height;
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.fillRect(box.x, footY, box.width, 1);
  ctx.fillStyle = "#ffd23f";
  for (const across of [figures.player, figures.boss]) {
    const x = box.x + across * box.width;
    const y = box.y + figures.floor * box.height;
    ctx.fillRect(x - 1, y - 12, 2, 24);
    ctx.fillRect(x - 12, y - 1, 24, 2);
  }
}

/** Every take's preview in one grid, each with its name drawn on it. Returns a PNG data URL. */
async function contactSheetInPage({ tiles, columns, tileWidth, tileHeight, figures }) {
  const sheet = newCanvas(columns * tileWidth, Math.ceil(tiles.length / columns) * tileHeight);
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "#101012";
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.imageSmoothingQuality = "high";
  for (const [index, tile] of tiles.entries()) {
    const box = { x: (index % columns) * tileWidth, y: Math.floor(index / columns) * tileHeight, width: tileWidth, height: tileHeight };
    const image = new Image();
    image.src = tile.url;
    await image.decode();
    ctx.drawImage(image, box.x, box.y, box.width, box.height);
    drawTileMarks(ctx, tile, box, figures);
  }
  return sheet.toDataURL("image/png");
}

const PAGE_HELPERS = Object.freeze([newCanvas, stackLayers, flatten, toneCurve, applyGrade, resample, meanLumaOfFloor, drawTileMarks]);

// ---------------------------------------------------------------- node side

/** Every `--name value` occurrence, comma lists split. */
function valuesOf(name) {
  return process.argv.flatMap((value, index) => (value === `--${name}` && process.argv[index + 1] ? process.argv[index + 1].split(",") : [])).filter(Boolean);
}

/** `--name <number>` within [min, max], or the fallback when the flag is absent. */
function numberArg(name, fallback, min, max) {
  if (!flag(name)) return fallback;
  const value = Number(arg(name) || NaN);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new UsageError(`--${name} needs a number from ${min} to ${max}`);
  }
  return value;
}

/** The command line, validated. */
function readOptions() {
  const options = {
    list: flag("list"),
    all: flag("all"),
    dry: flag("dry"),
    guides: flag("guides"),
    rooms: valuesOf("room"),
    take: arg("take"),
    outDir: arg("out") ? resolve(arg("out")) : DEFAULT_OUT_DIR,
    previewDir: arg("preview") ? resolve(arg("preview")) : "",
    grade: {
      ...GRADE,
      saturation: numberArg("saturation", GRADE.saturation, 0, 3),
      highlight: numberArg("highlight", GRADE.highlight, 0.05, 1),
      median: numberArg("median", GRADE.median, 0.01, 0.9),
    },
  };
  if (options.all && (options.rooms.length || options.take)) throw new UsageError("--all cannot be combined with --room or --take");
  for (const [name, dir] of [["out", options.outDir], ["preview", options.previewDir]]) {
    if (dir && isInside(WEB_ROOT, dir)) throw new UsageError(`--${name} resolves inside Web/ (${dir}); this script never writes there`);
  }
  return options;
}

/** The real path of something that may not exist yet (its nearest existing parent decides). */
function canonical(path) {
  let existing = resolve(path);
  const missing = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync.native(existing), ...missing);
}

/** Whether `child` is `parent` or anything below it. Case-blind: the default macOS volume is. */
function isInside(parent, child) {
  const path = relative(canonical(parent).toLowerCase(), canonical(child).toLowerCase());
  return path === "" || (path.split(sep)[0] !== ".." && !isAbsolute(path));
}

/** The takes a `--room` value names: `<id>-<take>`, or `<id>` with `--take`, or every take of `<id>`. */
function takesOfSpec(spec, defaultTake) {
  const [id, take = defaultTake] = spec.split("-");
  const found = ROOMS.find((candidate) => candidate.id === id);
  if (!found) throw new UsageError(`unknown room "${id}" (rooms: ${ROOMS.map((candidate) => candidate.id).join(", ")})`);
  if (take && !found.takes[take]) throw new UsageError(`${id} has no take "${take}" (takes: ${Object.keys(found.takes).join(", ")})`);
  return (take ? [take] : Object.keys(found.takes)).map((name) => ({ room: found, take: name }));
}

/**
 * The takes this run is about, in ROOMS order, each once.
 * @returns {Array<{ room: Room, take: string }>}
 */
function selectTakes(options) {
  const everything = ROOMS.flatMap((found) => Object.keys(found.takes).map((take) => ({ room: found, take })));
  if (options.all || (options.list && options.rooms.length === 0)) return everything;
  if (options.rooms.length === 0) throw new UsageError("nothing to build: pass --room <id>[-<take>] (repeatable), or --all");
  const wanted = new Set(options.rooms.flatMap((spec) => takesOfSpec(spec, options.take)).map(({ room: found, take }) => `${found.id}-${take}`));
  return everything.filter(({ room: found, take }) => wanted.has(`${found.id}-${take}`));
}

/** A take's layer textures from the pack, per plane, back to front. */
function loadPlanes(pck, recipe) {
  const planes = {};
  for (const name of PLANES) {
    if (!recipe[name]) continue;
    planes[name] = recipe[name].map((path) => {
      const image = loadImage(pck, path);
      if (!image) throw new Error(`cannot decode ${path}`);
      return image;
    });
  }
  return planes;
}

/**
 * The canvas a take is composed on: the game's, or larger when a layer
 * texture is (the game stretches every layer over the same rectangle, so the
 * widest texture sets the detail there is to keep).
 */
function canvasFor(planes) {
  const width = Math.max(GAME_CANVAS.width, ...Object.values(planes).flat().map((image) => image.width));
  return { width, height: Math.round((width * GAME_CANVAS.height) / GAME_CANVAS.width) };
}

/** `--list`: every selected take's layers with their native pixel sizes. */
function printList(pck, selection) {
  for (const { room: found, take } of selection) {
    const planes = loadPlanes(pck, found.takes[take]);
    const size = canvasFor(planes);
    const mirrored = found.takes[take].flip ? ", mirrored" : "";
    process.stdout.write(`${found.id}-${take}  (${found.label}; composed at ${size.width}x${size.height}, foot ${found.takes[take].foot}/${GAME_CANVAS.height}${mirrored})\n`);
    for (const [name, images] of Object.entries(planes)) {
      for (const image of images) {
        const stretched = Math.abs(image.width / image.height - size.width / size.height) > 0.01 ? "  (aspect differs from the canvas)" : "";
        const texture = image.kind === "vram" ? VRAM_NAMES[image.format] || `vram ${image.format}` : image.kind;
        process.stdout.write(`  ${name.padEnd(6)}${image.source.padEnd(58)}${`${image.width}x${image.height}`.padEnd(11)}${texture}${stretched}\n`);
      }
    }
  }
}

/**
 * The app's `water` rectangles (fractions of its band) as fractions of the
 * whole canvas, mirrored with the picture. A rectangle that starts at the
 * band's top edge runs on up to the top of the canvas: the band cut it off
 * there, the water does not start there.
 */
function waterOnCanvas(recipe) {
  const bandTop = Math.max(0, Math.round(recipe.foot - APP_BAND.above));
  const bandHeight = Math.min(GAME_CANVAS.height - bandTop, APP_BAND.above + APP_BAND.below);
  return (recipe.water || []).map(([left, top, width, height]) => {
    const start = top === 0 ? 0 : bandTop + top * bandHeight;
    const end = bandTop + (top + height) * bandHeight;
    return [+(recipe.flip ? 1 - left - width : left).toFixed(3), +(start / GAME_CANVAS.height).toFixed(3), width, +((end - start) / GAME_CANVAS.height).toFixed(3)];
  });
}

const bytesOf = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
const kilobytes = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

/**
 * Builds one take: reads its layers, composes them in the page, writes the
 * images (unless --dry) and returns its manifest entry and preview.
 * @param {import("playwright").Page} page
 * @param {{ room: Room, take: string }} selected
 */
async function buildTake(page, pck, { room: found, take }, options) {
  const recipe = found.takes[take];
  const images = loadPlanes(pck, recipe);
  const size = canvasFor(images);
  const planes = {};
  for (const [name, list] of Object.entries(images)) {
    planes[name] = [];
    for (const image of list) planes[name].push(await imageDataUrl(page, image));
  }
  const composed = await page.evaluate(composeTakeInPage, {
    planes,
    size,
    flip: Boolean(recipe.flip),
    grade: options.grade,
    encode: ENCODE,
    phone: PHONE_CUT,
    preview: PREVIEW,
    floorShare: FLOOR_SHARE,
  });
  const files = {};
  for (const [name, picture] of Object.entries(composed.files)) {
    const file = `${found.id}-${take}-${FILE_SUFFIX[name]}-v${ART_VERSION}.webp`;
    const bytes = bytesOf(picture.url);
    if (!options.dry) writeFileSync(join(options.outDir, file), bytes);
    files[name] = { file, width: picture.width, height: picture.height, bytes: bytes.length };
  }
  const water = waterOnCanvas(recipe);
  const entry = {
    room: found.id,
    take,
    label: found.label,
    width: size.width,
    height: size.height,
    footRatio: +(recipe.foot / GAME_CANVAS.height).toFixed(4),
    flip: Boolean(recipe.flip),
    ...(water.length ? { water } : {}),
    floorLuma: composed.floorLuma,
    grade: { saturation: options.grade.saturation, highlight: options.grade.highlight, median: options.grade.median, ...composed.stats },
    files,
  };
  return { entry, preview: composed.preview };
}

/** The one progress line a take gets. */
function reportTake(entry) {
  const sizes = Object.entries(entry.files).map(([name, picture]) => `${FILE_SUFFIX[name]} ${kilobytes(picture.bytes)}`);
  const facts = `foot ${entry.footRatio}${entry.flip ? " mirrored" : ""}  floor ${entry.floorLuma}  ${JSON.stringify(entry.grade)}`;
  process.stdout.write(`${`${entry.room}-${entry.take}`.padEnd(14)}${`${entry.width}x${entry.height}`.padEnd(11)}${sizes.join(", ")}  ${facts}\n`);
}

/** Entries of an earlier run that this one did not rebuild and whose images are still in `outDir`. */
function keptEntries(outDir, rebuilt) {
  if (!existsSync(MANIFEST_FILE)) return [];
  let previous;
  try {
    previous = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  } catch (error) {
    process.stderr.write(`${SCRIPT_NAME}: ignoring the unreadable ${MANIFEST_FILE} (${error.message})\n`);
    return [];
  }
  if (previous.outDir !== relative(REPO_ROOT, outDir) || !Array.isArray(previous.rooms)) return [];
  const done = new Set(rebuilt.map((entry) => `${entry.room}-${entry.take}`));
  return previous.rooms.filter(
    (entry) => !done.has(`${entry.room}-${entry.take}`) && Object.values(entry.files || {}).every((picture) => existsSync(join(outDir, picture.file))),
  );
}

/** Writes the list of everything in `outDir`: this run's takes plus the earlier ones still there. */
function writeManifest(outDir, entries) {
  const order = ROOMS.flatMap((found) => Object.keys(found.takes).map((take) => `${found.id}-${take}`));
  const rooms = [...keptEntries(outDir, entries), ...entries].sort((a, b) => order.indexOf(`${a.room}-${a.take}`) - order.indexOf(`${b.room}-${b.take}`));
  const manifest = { generatedBy: `scripts/${SCRIPT_NAME}.mjs`, artVersion: ART_VERSION, outDir: relative(REPO_ROOT, outDir), phoneCut: PHONE_CUT, rooms };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${MANIFEST_FILE} (${rooms.length} takes)\n`);
}

/** Writes each take's preview and the sheet of all of them (with --guides, a second sheet with the marks). */
async function writePreviews(page, previewDir, built, guides) {
  for (const { entry, preview } of built) writeFileSync(join(previewDir, `${entry.room}-${entry.take}.jpg`), bytesOf(preview));
  const tiles = built.map(({ entry, preview }) => ({ name: `${entry.room}-${entry.take}${entry.flip ? " (mirrored)" : ""}`, url: preview, footRatio: entry.footRatio }));
  const tileHeight = Math.round((SHEET.tileWidth * GAME_CANVAS.height) / GAME_CANVAS.width);
  const sheets = [["contact-sheet.png", null], ...(guides ? [["contact-sheet-guides.png", FIGURES]] : [])];
  for (const [file, figures] of sheets) {
    const sheet = await page.evaluate(contactSheetInPage, { tiles, columns: SHEET.columns, tileWidth: SHEET.tileWidth, tileHeight, figures });
    writeFileSync(join(previewDir, file), bytesOf(sheet));
  }
  process.stdout.write(`wrote ${built.length} previews and ${sheets.map(([file]) => file).join(", ")} in ${previewDir}\n`);
}

/** The one page every take is composed in, with the page-side helpers installed. */
async function openPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  await page.setContent("<!doctype html><title>site backdrops</title>");
  await page.addScriptTag({ content: PAGE_HELPERS.map(String).join("\n") });
  return page;
}

async function main() {
  const options = readOptions();
  const selection = selectTakes(options);
  const pck = openPck(pckPathFromArgs());
  let browser = null;
  try {
    if (options.list) return printList(pck, selection);
    if (!options.dry) mkdirSync(options.outDir, { recursive: true });
    if (options.previewDir) mkdirSync(options.previewDir, { recursive: true });
    browser = await chromium.launch({ timeout: TIMEOUT_MS, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await openPage(browser);
    const built = [];
    for (const selected of selection) {
      built.push(await buildTake(page, pck, selected, options));
      reportTake(built.at(-1).entry);
    }
    if (options.previewDir) await writePreviews(page, options.previewDir, built, options.guides);
    if (!options.dry) writeManifest(options.outDir, built.map(({ entry }) => entry));
  } finally {
    if (browser) await browser.close();
    pck.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${SCRIPT_NAME}: ${error instanceof UsageError ? error.message : error.stack || error}\n`);
  process.exitCode = 1;
});
