#!/usr/bin/env node
/**
 * Builds the backdrops for the new UI's header stage from the game's own
 * combat rooms.
 *
 * The header stages a fight (climber vs the Architect), so what stands behind
 * it is a place you fight in: each backdrop is one of Slay the Spire 2's
 * combat backgrounds, read straight from the installed game's pack. The game
 * paints a room as depth layers stacked on one canvas (sky and floor, far
 * scenery, near wall); this keeps that depth instead of flattening it, as up
 * to three planes per backdrop:
 *
 *   base    the sky and the floor: opaque, never moves
 *   mid     what stands in the distance: drifts slowly behind the front
 *   front   the near wall, rooted on the floor: never moves
 *
 * Every plane is cut to the band around the foot of the wall and lifted out
 * of the game's near-black with one shared tone curve (the game lights its
 * rooms at runtime; a header has no lights). The acts ship several takes of
 * each layer; every take becomes its own backdrop, so a refresh can land in
 * a different corner of the same place. Rooms painted as a single picture
 * (the study, the grotto) have a base only.
 *
 *   Web/assets/stage/backdrops/<room>-<take>-<plane>-v<N>.webp
 *   Web/lib/ui/stage-backdrops.js                        the list, generated
 *
 * An asset build, run by hand when the game updates or a setting below
 * changes — not part of `make preflight`: it needs Playwright and the game.
 *
 *   node scripts/build-stage-backdrops.mjs                     # build everything
 *   node scripts/build-stage-backdrops.mjs --preview <dir>     # also write flattened previews
 *   node scripts/build-stage-backdrops.mjs --only glory --dry --preview <dir>
 *   node scripts/build-stage-backdrops.mjs "/path/to/Slay the Spire 2.pck"
 *
 * Filenames carry a version because /assets/* is cached for a year: bump
 * ART_VERSION when the shared settings change, or a room's own `version`
 * when only its pixels do. A full build that succeeds then removes the
 * images its list no longer names, so older versions do not pile up.
 */

import { chromium } from "playwright";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openPck, loadImage, imageDataUrl, pckPathFromArgs, arg, flag } from "./sts2-pck/pck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(REPO_ROOT, "Web");
const OUT_DIR = join(WEB_ROOT, "assets", "stage", "backdrops");
const MODULE_FILE = join(WEB_ROOT, "lib", "ui", "stage-backdrops.js");

const ART_VERSION = 2;

/** The game's background canvas: every layer texture is stretched over it. */
const CANVAS = Object.freeze({ width: 2048, height: 960 });

/**
 * The band cut from the canvas, in canvas pixels measured from the foot of
 * the wall (`foot`, per room): this much wall above it, this much floor
 * below. The floor strip is what the figures stand in front of; the header's
 * own ledge covers the cut edge.
 */
const BAND = Object.freeze({ above: 344, below: 76 });

/** Tone targets after grading, as 0–1 luma. */
const GRADE = Object.freeze({
  highlight: 0.6, // where the band's 98th percentile lands
  median: 0.19, // where its median lands
  maxGain: 2.6,
  minGamma: 0.62,
  maxGamma: 1.6,
  saturation: 1.12,
});

/**
 * How each plane is saved. The planes behind the front are the distance:
 * three quarters of the size and a softer encode are plenty there, and they
 * are most of the bytes.
 */
const ENCODE = Object.freeze({
  base: Object.freeze({ scale: 0.75, quality: 0.72 }),
  mid: Object.freeze({ scale: 0.75, quality: 0.7 }),
  front: Object.freeze({ scale: 1, quality: 0.74 }),
});

const PLANES = Object.freeze(["base", "mid", "front"]);

const room = (dir, names) => names.map((name) => `images/rooms/${dir}/${name}.png`);

/**
 * Rooms and their takes. Each plane lists full-canvas textures, back to
 * front, as `scenes/backgrounds/<room>/layers/*_bg_NN_x.tscn` stacks them;
 * the game's foreground layers (drawn in front of the fighters) are left
 * out. `foot` is the canvas y of the foot of the wall.
 *
 * The header puts the duel in the backdrop's right-hand corner (the last
 * ~570 canvas pixels). `flip` mirrors a take whose right end has something
 * bright or busy exactly there (a glowing porthole behind the boss's head, a
 * coral bed behind the climber's legs), so the figures stand against the
 * room's quiet end and the feature moves out into the open.
 *
 * `water` marks falling water, as [left, top, width, height] fractions of
 * the cut band (before any flip); the header runs a shimmer down it.
 *
 * @typedef {{ base: string[], mid?: string[], front?: string[], foot: number, flip?: boolean, water?: number[][] }} Take
 * @type {ReadonlyArray<{ id: string, label: string, version?: number, takes: Record<string, Take> }>}
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

/**
 * Page side: stacks each plane's layers on the canvas, cuts the band, and
 * grades every plane with one curve measured on the flattened room, so the
 * planes still belong together. Returns each plane as a WebP data URL.
 */
async function composeInPage({ planes, canvas, band, foot, flip, grade, encode, wantPreview }) {
  const top = Math.max(0, Math.round(foot - band.above));
  const height = Math.min(canvas.height - top, band.above + band.below);

  /** @param {string[]} urls */
  const cutOf = async (urls) => {
    const full = document.createElement("canvas");
    full.width = canvas.width;
    full.height = canvas.height;
    const fullCtx = full.getContext("2d");
    for (const url of urls) {
      const image = new Image();
      image.src = url;
      await image.decode();
      fullCtx.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    const cut = document.createElement("canvas");
    cut.width = canvas.width;
    cut.height = height;
    const ctx = cut.getContext("2d", { willReadFrequently: true });
    if (flip) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(full, 0, top, canvas.width, height, 0, 0, canvas.width, height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return cut;
  };

  const cuts = {};
  for (const [name, urls] of Object.entries(planes)) cuts[name] = await cutOf(urls);

  // The flattened room, for measuring (and for the preview).
  const flat = document.createElement("canvas");
  flat.width = canvas.width;
  flat.height = height;
  const flatCtx = flat.getContext("2d", { willReadFrequently: true });
  for (const cut of Object.values(cuts)) flatCtx.drawImage(cut, 0, 0);

  const measured = flatCtx.getImageData(0, 0, flat.width, flat.height).data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < measured.length; i += 4) {
    histogram[Math.round(0.2126 * measured[i] + 0.7152 * measured[i + 1] + 0.0722 * measured[i + 2])]++;
  }
  const total = measured.length / 4;
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

  /** One gain + gamma for every pixel, so the room keeps its own colours. */
  const gradeCanvas = (target, opaque) => {
    const ctx = target.getContext("2d", { willReadFrequently: true });
    const pixels = ctx.getImageData(0, 0, target.width, target.height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = curve[data[i]];
      const g = curve[data[i + 1]];
      const b = curve[data[i + 2]];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      data[i] = luma + (r - luma) * grade.saturation;
      data[i + 1] = luma + (g - luma) * grade.saturation;
      data[i + 2] = luma + (b - luma) * grade.saturation;
      if (opaque) data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
  };

  const out = {};
  for (const [name, cut] of Object.entries(cuts)) {
    gradeCanvas(cut, name === "base");
    // A room painted as one picture has only a base: it is the whole view, so
    // it is saved like a front plane.
    const { scale, quality } = Object.keys(cuts).length === 1 ? encode.front : encode[name];
    let saved = cut;
    if (scale < 1) {
      saved = document.createElement("canvas");
      saved.width = Math.round(cut.width * scale);
      saved.height = Math.round(cut.height * scale);
      const savedCtx = saved.getContext("2d");
      savedCtx.imageSmoothingQuality = "high";
      savedCtx.drawImage(cut, 0, 0, saved.width, saved.height);
    }
    out[name] = saved.toDataURL("image/webp", quality);
  }
  let preview = "";
  if (wantPreview) {
    flatCtx.clearRect(0, 0, flat.width, flat.height);
    for (const cut of Object.values(cuts)) flatCtx.drawImage(cut, 0, 0);
    preview = flat.toDataURL("image/jpeg", 0.85);
  }
  return {
    planes: out,
    preview,
    width: canvas.width,
    height,
    foot: (foot - top) / height,
    stats: { p50: +p50.toFixed(3), p98: +p98.toFixed(3), gain: +gain.toFixed(2), gamma: +gamma.toFixed(2) },
  };
}

const bytesOf = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

/** Water rectangles follow the picture when it is mirrored. */
const placeWater = (water, flipped) =>
  (water || []).map(([left, top, width, height]) => [+(flipped ? 1 - left - width : left).toFixed(3), top, width, height]);

function moduleSource(entries) {
  const rows = entries
    .map((e) => {
      const planes = PLANES.filter((name) => e.planes[name])
        .map((name) => `${name}: "${e.planes[name]}"`)
        .join(", ");
      const water = e.water.length ? `, water: Object.freeze(${JSON.stringify(e.water)})` : "";
      return `  Object.freeze({ room: "${e.room}", take: "${e.take}", planes: Object.freeze({ ${planes} }), width: ${e.width}, height: ${e.height}, foot: ${e.foot}${water} }),`;
    })
    .join("\n");
  return `// GENERATED by scripts/build-stage-backdrops.mjs — do not edit by hand.
//
// The header stage's backdrops: the game's own combat rooms, one entry per
// take. A room is up to three planes cut from the same band: \`base\` (sky
// and floor, opaque), \`mid\` (the distance, drifts) and \`front\` (the near
// wall). \`foot\` is where the wall meets the floor, as a fraction of the
// image height from its top; \`water\` lists falling water as
// [left, top, width, height] fractions of the image.

/**
 * @typedef {Object} StageBackdrop
 * @property {string} room    the place ("glory", "hive", …); also the scene id
 * @property {string} take    which take of that place
 * @property {Readonly<{ base: string, mid?: string, front?: string }>} planes  image per plane
 * @property {number} width
 * @property {number} height
 * @property {number} foot    0–1, the foot of the wall from the top
 * @property {ReadonlyArray<ReadonlyArray<number>>} [water]
 */

/** @type {ReadonlyArray<StageBackdrop>} */
export const STAGE_BACKDROPS = Object.freeze([
${rows}
]);
`;
}

async function main() {
  const only = arg("only");
  const previewDir = arg("preview");
  const dry = flag("dry");
  const writeAll = !dry && !only;
  const pck = openPck(pckPathFromArgs());
  const entries = [];
  let browser = null;
  try {
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>backdrops</title>");
    if (!dry) mkdirSync(OUT_DIR, { recursive: true });
    if (previewDir) mkdirSync(previewDir, { recursive: true });
    for (const { id, takes, version = ART_VERSION } of ROOMS) {
      if (only && only !== id) continue;
      for (const [take, recipe] of Object.entries(takes)) {
        const flipped = Boolean(recipe.flip);
        const planes = {};
        for (const name of PLANES) {
          if (!recipe[name]) continue;
          planes[name] = [];
          for (const layer of recipe[name]) {
            const image = loadImage(pck, layer);
            if (!image) throw new Error(`cannot decode ${layer}`);
            planes[name].push(await imageDataUrl(page, image));
          }
        }
        const result = await page.evaluate(composeInPage, {
          planes,
          canvas: CANVAS,
          band: BAND,
          foot: recipe.foot,
          flip: flipped,
          grade: GRADE,
          encode: ENCODE,
          wantPreview: Boolean(previewDir),
        });
        const srcs = {};
        const sizes = [];
        for (const [name, dataUrl] of Object.entries(result.planes)) {
          const file = `${id}-${take}-${name}-v${version}.webp`;
          const bytes = bytesOf(dataUrl);
          if (!dry) writeFileSync(join(OUT_DIR, file), bytes);
          srcs[name] = `/assets/stage/backdrops/${file}`;
          sizes.push(`${name} ${(bytes.length / 1024).toFixed(0)} KB`);
        }
        if (previewDir) writeFileSync(join(previewDir, `${id}-${take}.jpg`), bytesOf(result.preview));
        entries.push({
          room: id,
          take,
          planes: srcs,
          width: result.width,
          height: result.height,
          foot: +result.foot.toFixed(3),
          water: placeWater(recipe.water, flipped),
        });
        process.stdout.write(`${`${id}-${take}`.padEnd(14)} ${result.width}x${result.height}  ${sizes.join(", ").padEnd(40)} ${JSON.stringify(result.stats)}\n`);
      }
    }
  } finally {
    if (browser) await browser.close();
    pck.close();
  }
  if (writeAll) {
    writeFileSync(MODULE_FILE, moduleSource(entries));
    process.stdout.write(`wrote ${MODULE_FILE}\n`);
    // Only now, with every image written and the list updated: drop the
    // images the list no longer names (older versions, retired takes). A
    // build that failed part-way leaves the previous set intact.
    const current = new Set(entries.flatMap((entry) => Object.values(entry.planes)).map((src) => src.split("/").pop()));
    for (const file of readdirSync(OUT_DIR)) {
      if (file.endsWith(".webp") && !current.has(file)) rmSync(join(OUT_DIR, file));
    }
  }
}

main().catch((error) => {
  process.stderr.write(`build-stage-backdrops: ${error.stack || error}\n`);
  process.exitCode = 1;
});
