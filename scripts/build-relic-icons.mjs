#!/usr/bin/env node
/**
 * Writes the relic icons the web app is missing, from the installed game.
 *
 * For every relic the game has a title and an icon for (see sts2-pck/pck.mjs)
 * whose art the app cannot resolve, this decodes the game's own icon and
 * writes Web/assets/sts2/relics/<slug>.webp, then lists it in manifest.json.
 * Existing icons are never touched; to rebuild one, delete its file first.
 *
 * Framing matches the icons already shipped: the game's 256x256 icon scaled
 * to 0.48 (122.9px) and centred on a transparent 128x128 canvas. That was
 * measured, not guessed: downscaling the game's own Akabeko, Pen Nib and
 * Anchor icons that way reproduces the shipped webps to within lossy-codec
 * noise (mean abs. error ~3.5/255), where a plain 256->128 resize is off by 14-17.
 *
 * Icon sources, in order: images/relics/<id>.png (release art, VRAM BC7/DXT5,
 * decoded by Chromium's WebGL), images/relics/beta/<id>.png (placeholder art),
 * then the relic atlas sprite (85px, upscaled — only relics with nothing else).
 *
 *   node scripts/build-relic-icons.mjs [path/to/Slay the Spire 2.pck] [--dry] [--preview <dir>]
 */

import { chromium } from "playwright";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arg, flag, imageDataUrl, loadImage, openPck, pckPathFromArgs, readAtlasTexture, relicCatalog } from "./sts2-pck/pck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_ROOT = join(REPO_ROOT, "Web", "assets", "sts2");
const MANIFEST_FILE = join(ASSET_ROOT, "manifest.json");
const RELIC_DIR = join(ASSET_ROOT, "relics");

const ICON = Object.freeze({ size: 128, contentScale: 0.96, quality: 0.9 });

/** True when the app's relic resolver can already find art for this slug. */
function hasArt(manifestRelics, slug) {
  // Mirrors relicImageSrc: exact, underscore-split variants, and the "the" article form.
  return manifestRelics.some((existing) => [slug, `the${slug}`].includes(existing.replace(/_/g, "")));
}

/** Page side: draws a source (full icon, or an atlas region) onto the 128px canvas. */
function renderIconInPage({ url, crop, quality, size, contentScale }) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      // An atlas sprite is trimmed: rebuild its original square before scaling.
      let source = image;
      if (crop) {
        const [x, y, w, h] = crop.region;
        const [left, top, extraW, extraH] = crop.margin;
        const full = document.createElement("canvas");
        full.width = w + extraW;
        full.height = h + extraH;
        full.getContext("2d").drawImage(image, x, y, w, h, left, top, w, h);
        source = full;
      }
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      const side = size * contentScale;
      const inset = (size - side) / 2;
      ctx.drawImage(source, inset, inset, side, side);
      resolve(canvas.toDataURL("image/webp", quality).split(",")[1]);
    };
    image.onerror = () => reject(new Error("icon failed to decode"));
    image.src = url;
  });
}

/** Relic icons on disk, by slug. */
function relicFilesOnDisk() {
  return readdirSync(RELIC_DIR).filter((f) => f.endsWith(".webp")).map((f) => f.slice(0, -".webp".length));
}

async function iconFor(page, pck, relic) {
  if (relic.icon) {
    const image = loadImage(pck, relic.icon);
    if (!image) throw new Error(`${relic.id}: ${relic.icon} has no readable texture`);
    return { url: await imageDataUrl(page, image), crop: null, from: relic.icon };
  }
  const sprite = readAtlasTexture(pck, relic.atlas);
  const atlas = sprite && loadImage(pck, sprite.atlas);
  if (!atlas) throw new Error(`${relic.id}: atlas sprite ${relic.atlas} is unreadable`);
  return { url: await imageDataUrl(page, atlas), crop: sprite, from: `${relic.atlas} (atlas, upscaled)` };
}

async function writePreview(page, results, dir) {
  mkdirSync(dir, { recursive: true });
  const figures = results
    .map((r) => `<figure><img src="data:image/webp;base64,${r.base64}"><figcaption>${r.slug}</figcaption></figure>`)
    .join("");
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.setContent(`<!doctype html><style>body{margin:12px;background:#2b2433;display:flex;flex-wrap:wrap;gap:10px;font:11px system-ui;color:#eee}
    figure{margin:0;text-align:center}img{display:block;width:128px;height:128px;background:#3a3145}</style>${figures}`);
  await page.screenshot({ path: join(dir, "relic-icons.png"), fullPage: true });
}

async function main() {
  const pck = openPck(pckPathFromArgs());
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const only = arg("only", "");
  const existing = [...new Set([...manifest.relics, ...relicFilesOnDisk()])];
  const todo = relicCatalog(pck).relics.filter(
    (relic) => !hasArt(existing, relic.slug) && (!only || only.split(",").includes(relic.slug))
  );
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const results = [];
    for (const relic of todo) {
      const { url, crop, from } = await iconFor(page, pck, relic);
      const base64 = await page.evaluate(renderIconInPage, { url, crop, quality: ICON.quality, size: ICON.size, contentScale: ICON.contentScale });
      results.push({ slug: relic.slug, base64 });
      process.stdout.write(`${relic.slug.padEnd(24)} ${from}\n`);
    }
    const previewDir = arg("preview", "");
    if (previewDir) await writePreview(page, results, previewDir);
    if (flag("dry")) return;
    for (const r of results) writeFileSync(join(RELIC_DIR, `${r.slug}.webp`), Buffer.from(r.base64, "base64"));
    // The manifest lists the art that exists: exactly the files on disk.
    manifest.relics = relicFilesOnDisk().sort();
    manifest.counts.relics = manifest.relics.length;
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    process.stdout.write(`${results.length} icons written; manifest lists ${manifest.relics.length} relics\n`);
  } finally {
    await browser.close();
    pck.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
