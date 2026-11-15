#!/usr/bin/env node
/**
 * Builds the inked actor sprites for the new UI's header stage.
 *
 * The classic layout shows the game's painterly character art as-is. On the
 * new stage — flat colour, bold ink outlines, hard shadows — that art looked
 * pasted on. This re-inks each sprite in the stage's own language (see
 * stage-sprites/ink-filter.js), crops it tight so its bottom edge is exactly
 * where it touches the ground, mirrors the climbers so they all face the
 * boss, and writes:
 *
 *   Web/assets/stage/<id>-ink-v<N>.webp   one image per actor
 *   Web/lib/ui/stage-actors.js            sizes + ground contact, generated
 *
 * It is an asset build, run by hand when a source sprite or a setting below
 * changes — not part of `make preflight`, because it needs Playwright.
 *
 *   node scripts/build-stage-sprites.mjs                    # build everything
 *   node scripts/build-stage-sprites.mjs --preview <dir>    # also write a contact sheet
 *   node scripts/build-stage-sprites.mjs --only ironclad --dry --preview <dir>
 *
 * Output filenames carry a version because /assets/* is cached for a year:
 * bump ART_VERSION whenever the shared settings change, or an actor's own
 * `version` when only its pixels do.
 */

import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(REPO_ROOT, "Web");
const SOURCE_ROOT = join(WEB_ROOT, "assets", "sts2");
const OUT_DIR = join(WEB_ROOT, "assets", "stage");
const MODULE_FILE = join(WEB_ROOT, "lib", "ui", "stage-actors.js");
const FILTER_FILE = join(dirname(fileURLToPath(import.meta.url)), "stage-sprites", "ink-filter.js");

const ART_VERSION = 1;

/** Filter settings shared by every actor. Units are working-canvas pixels. */
const DEFAULTS = Object.freeze({
  workScale: 2, // process at 2x the source so cuts and curves come out smooth
  mirror: false,
  alphaCut: 236, // below this the pixel is floor shadow or halo, not figure
  matteSmooth: 1.6,
  minIslandRatio: 0.0006,
  maxHoleRatio: 0.0003,
  smoothPasses: 2,
  smoothRadius: 4,
  smoothSpace: 3,
  smoothRange: 0.06,
  colors: 16,
  accentColors: 3,
  paletteSamples: 50000,
  paletteRounds: 14,
  chromaWeight: 1.6,
  seed: 20261111,
  majorityPasses: 2,
  majorityRadius: 3,
  saturation: 1.32,
  gamma: 0.84,
  contrast: 1.06,
  lift: 0.015,
  // Lines are sized for the stage, where a figure is shown at roughly a sixth
  // of the working canvas: anything thinner than ~5px here disappears there.
  lineContrast: 0.2,
  lineWidth: 2,
  lineGain: 4.5,
  lineOpacity: 0.72,
  // No baked outline: the page draws it with CSS so it stays a constant 2px
  // at every stage size and takes the theme's outline colour.
  contour: 0,
  edgeSoftness: 0.9,
  ink: [10, 6, 22], // --v-ink
  outHeight: 420,
  type: "image/webp",
  quality: 0.92,
  groundBand: 0.2,
});

/**
 * Settings for drawn figures: art that is already inked (clean outlines,
 * flat cel shading, transparent background), redrawn from the game's own
 * sprites and kept as masters in scripts/stage-art/figures/. They skip the
 * ink filter: only trimmed, turned to face the boss, sized and measured.
 */
const DRAWN_DEFAULTS = Object.freeze({
  mirror: false,
  boundsAlpha: 24, // fainter than this is stray haze, not figure
  groundAlpha: 128,
  groundBand: 0.08,
  outHeight: 640,
  type: "image/webp",
  quality: 0.9,
});

/**
 * One entry per actor. `kind` decides which side of the stage it stands on.
 * The climbers' source art faces left; mirroring bakes in "faces the boss"
 * so the page needs no flip (a CSS flip would also flip the hard shadow).
 *
 * `drawn` (a repo-relative path) marks a figure built from drawn art instead
 * of the ink filter; see DRAWN_DEFAULTS. Drawn masters are redrawn from the
 * game sprite named in `source`, pose and costume unchanged.
 */
const ACTORS = Object.freeze([
  {
    id: "ironclad",
    kind: "climber",
    source: "characters/ironclad-v2.webp",
    drawn: "scripts/stage-art/figures/ironclad.webp",
    version: 3,
    options: { mirror: true },
  },
  {
    id: "silent",
    kind: "climber",
    source: "characters/silent-v2.webp",
    drawn: "scripts/stage-art/figures/silent.webp",
    version: 3,
    options: { mirror: true },
  },
  {
    id: "defect",
    kind: "climber",
    source: "characters/defect-v2.webp",
    drawn: "scripts/stage-art/figures/defect.webp",
    version: 3,
    options: { mirror: true },
  },
  {
    // The game's Regent art is him on his throne with a creature crushed
    // under its front corner. On the stage that creature read as the Regent
    // sitting on an enemy, so his redraw leaves it out: the throne stands on
    // an intact stone base.
    id: "regent",
    kind: "climber",
    source: "characters/regent-v2.webp",
    drawn: "scripts/stage-art/figures/regent.webp",
    version: 3,
    options: { mirror: true },
  },
  {
    id: "necrobinder",
    kind: "climber",
    source: "characters/necrobinder-v2.webp",
    drawn: "scripts/stage-art/figures/necrobinder.webp",
    version: 3,
    options: { mirror: true },
  },
  // The Fool (STS2 public beta v0.113.0). Source: the game's own rest-site
  // art for him (images/rooms/rest_sites/rest_site_fool_placeholder.png in
  // the v0.113.0 pack), the same crouched campfire pose the others use.
  // Unlike the others it is painted facing right, toward the boss: no mirror.
  {
    id: "fool",
    kind: "climber",
    source: "characters/fool-v2.webp",
    drawn: "scripts/stage-art/figures/fool.webp",
    version: 3,
    options: { mirror: false },
  },
  {
    // The ink filter cut his painting into blotches ("choppy"); the redraw
    // keeps the painting's pose and costume in the same inked style as the
    // climbers.
    id: "architect",
    kind: "boss",
    source: "bosses/architect-crystal-v4@2x.webp",
    drawn: "scripts/stage-art/figures/architect.webp",
    version: 4,
    options: { outHeight: 820 },
  },
]);

/** @param {string} name */
function flag(name) {
  return process.argv.includes(`--${name}`);
}

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

/** Reads `--set key=value,key=value` overrides (numbers only) for experiments. */
function overrides() {
  const raw = arg("set", "");
  const entries = raw
    .split(",")
    .map((pair) => pair.split("="))
    .filter((pair) => pair.length === 2 && pair[0] in DEFAULTS && Number.isFinite(Number(pair[1])));
  return Object.fromEntries(entries.map(([key, value]) => [key, Number(value)]));
}

/** @param {number} value */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * @param {import("playwright").Page} page
 * @param {typeof ACTORS[number]} actor
 * @param {object} extra
 */
async function inkActor(page, actor, extra) {
  const bytes = readFileSync(join(SOURCE_ROOT, actor.source));
  if (bytes.length === 0) {
    throw new Error(`build-stage-sprites: ${actor.source} is empty (iCloud-evicted? run brctl download on it)`);
  }
  const url = `data:image/webp;base64,${bytes.toString("base64")}`;
  const options = { ...DEFAULTS, ...actor.options, ...extra };
  const result = await page.evaluate(([dataUrl, settings]) => window.InkFilter.process(dataUrl, settings), [url, options]);
  return {
    id: actor.id,
    kind: actor.kind,
    file: `${actor.id}-ink-v${actor.version ?? ART_VERSION}.webp`,
    bytes: Buffer.from(result.base64, "base64"),
    width: result.width,
    height: result.height,
    ground: { left: round3(result.ground.left), right: round3(result.ground.right) },
  };
}

/**
 * Page side, for drawn figures: draws the art (mirrored if asked), finds the
 * figure's bounds and where it meets the ground, and encodes it cropped to
 * the output height.
 */
async function drawnInPage({ dataUrl, settings }) {
  const source = new Image();
  source.src = dataUrl;
  await source.decode();
  const width = source.naturalWidth;
  const height = source.naturalHeight;
  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  const ctx = full.getContext("2d", { willReadFrequently: true });
  if (settings.mirror) {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < settings.boundsAlpha) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("drawn figure is empty: no pixel above boundsAlpha");
  const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const bandTop = Math.floor(bounds.y + bounds.height * (1 - settings.groundBand));
  let left = Infinity;
  let right = -Infinity;
  for (let y = bandTop; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (data[(y * width + x) * 4 + 3] < settings.groundAlpha) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  const ground = Number.isFinite(left)
    ? { left: (left - minX) / bounds.width, right: (right - minX + 1) / bounds.width }
    : { left: 0, right: 1 };
  const outHeight = settings.outHeight;
  const outWidth = Math.round((bounds.width / bounds.height) * outHeight);
  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const out = canvas.getContext("2d");
  out.imageSmoothingEnabled = true;
  out.imageSmoothingQuality = "high";
  out.drawImage(full, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, outWidth, outHeight);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, settings.type, settings.quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), width: outWidth, height: outHeight, ground };
}

/**
 * @param {import("playwright").Page} page
 * @param {typeof ACTORS[number]} actor
 */
async function drawActor(page, actor) {
  const path = join(REPO_ROOT, actor.drawn);
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error(`build-stage-sprites: ${actor.drawn} is empty (iCloud-evicted? run brctl download on it)`);
  const type = actor.drawn.endsWith(".png") ? "png" : "webp";
  const settings = { ...DRAWN_DEFAULTS, ...actor.options };
  const result = await page.evaluate(drawnInPage, { dataUrl: `data:image/${type};base64,${bytes.toString("base64")}`, settings });
  return {
    id: actor.id,
    kind: actor.kind,
    file: `${actor.id}-ink-v${actor.version ?? ART_VERSION}.webp`,
    bytes: Buffer.from(result.base64, "base64"),
    width: result.width,
    height: result.height,
    ground: { left: round3(result.ground.left), right: round3(result.ground.right) },
  };
}

/** The generated ES module the page imports. */
function moduleSource(results) {
  const rows = results
    .map(
      (r) =>
        `  ${r.id}: Object.freeze({ kind: "${r.kind}", src: "/assets/stage/${r.file}", width: ${r.width}, height: ${r.height}, groundLeft: ${r.ground.left}, groundRight: ${r.ground.right} }),`
    )
    .join("\n");
  return `// GENERATED by scripts/build-stage-sprites.mjs — do not edit by hand.
//
// The inked actor art for the header stage. Each image is cropped tight, so
// its bottom edge is exactly where the figure meets the ground; groundLeft /
// groundRight give the horizontal span of that contact as fractions of the
// image width (used to centre the ground shadow under the feet).

/**
 * @typedef {Object} StageActorArt
 * @property {"climber" | "boss"} kind
 * @property {string} src
 * @property {number} width        intrinsic pixel width
 * @property {number} height       intrinsic pixel height
 * @property {number} groundLeft   0–1, left end of the ground contact
 * @property {number} groundRight  0–1, right end of the ground contact
 */

/** @type {Readonly<Record<string, StageActorArt>>} */
export const STAGE_ACTOR_ART = Object.freeze({
${rows}
});
`;
}

/** Stage-sized heights (CSS px) used by the contact sheet's "as shown" row. */
const SHEET_SHOWN = Object.freeze({ climber: 132, boss: 196 });
const SHEET_DETAIL = Object.freeze({ climber: 300, boss: 420 });

/**
 * Renders every result on a stage-coloured backdrop for a visual check: one
 * row at the size the page shows them (with the page's outline + hard shadow
 * filter), one enlarged row for detail.
 */
async function writeContactSheet(page, results, dir) {
  mkdirSync(dir, { recursive: true });
  const row = (sizes, withCaption) =>
    results
      .map((r) => {
        const url = `data:image/webp;base64,${r.bytes.toString("base64")}`;
        const caption = withCaption
          ? `<figcaption>${r.id} ${r.width}x${r.height} · ${(r.bytes.length / 1024).toFixed(1)} KB</figcaption>`
          : "";
        return `<figure><img src="${url}" style="height:${sizes[r.kind]}px">${caption}</figure>`;
      })
      .join("");
  await page.setViewportSize({ width: 1500, height: 820 });
  await page.setContent(`<!doctype html><style>
    body{margin:0;padding:24px;background:linear-gradient(180deg,#1a1340 0%,#25507a 70%,#2ad4c0 100%);
      font:12px system-ui;color:#fff1cf}
    .row{display:flex;gap:36px;align-items:flex-end;margin-bottom:36px}
    figure{margin:0;text-align:center}
    img{display:block;filter:drop-shadow(2px 0 0 #0a0616) drop-shadow(-2px 0 0 #0a0616)
      drop-shadow(0 2px 0 #0a0616) drop-shadow(0 -2px 0 #0a0616) drop-shadow(3px 3px 0 #0a0616)}
    figcaption{margin-top:10px;text-shadow:1px 1px 0 #0a0616}
  </style><div class="row">${row(SHEET_SHOWN, false)}</div><div class="row">${row(SHEET_DETAIL, true)}</div>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(dir, "stage-actors.png") });
}

async function main() {
  const only = arg("only", "");
  const previewDir = arg("preview", "");
  const dry = flag("dry");
  const extra = overrides();
  const actors = ACTORS.filter((actor) => !only || only.split(",").includes(actor.id));
  if (actors.length === 0) throw new Error(`build-stage-sprites: no actor matches --only ${only}`);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.addScriptTag({ path: FILTER_FILE });
    const results = [];
    for (const actor of actors) {
      const result = actor.drawn ? await drawActor(page, actor) : await inkActor(page, actor, extra);
      results.push(result);
      process.stdout.write(
        `${result.id.padEnd(12)} ${result.width}x${result.height}  ${(result.bytes.length / 1024).toFixed(1)} KB\n`
      );
    }
    if (previewDir) await writeContactSheet(page, results, previewDir);
    if (dry) return;
    if (only) {
      process.stdout.write("--only builds images but leaves stage-actors.js alone; run without it to regenerate.\n");
    }
    mkdirSync(OUT_DIR, { recursive: true });
    results.forEach((result) => writeFileSync(join(OUT_DIR, result.file), result.bytes));
    if (!only) writeFileSync(MODULE_FILE, moduleSource(results));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
