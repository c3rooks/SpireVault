#!/usr/bin/env node
/**
 * Builds every SpireVault logo file from the two crest masters in
 * scripts/brand-art/ (prompts and history in scripts/brand-art/README.md):
 *
 *   crest.webp        the full emblem: a shield, the spire dark against an
 *                     ember sky. Used at 48px and up.
 *   crest-small.webp  the same crest simplified for 16-32px (plain sky, a
 *                     wider spire, a bigger flame).
 *
 * Shaped surfaces (the rail, the landing page, favicons, install icons) get
 * the bare shield. Surfaces that frame the emblem in a rounded square (the
 * macOS app's views, the Windows overlay, placeholder avatars, home-screen
 * icons) get it on a night-indigo plate, so the frame holds a tile, not a
 * shield floating in a box.
 *
 * The 16 and 32px favicons are fitted to the pixel grid: hard edges and a
 * 1px ink ring, the app's own outline, so they stay crisp on dark and light
 * browser tabs alike.
 *
 * Web files are written under new versioned names (/assets is cached as
 * immutable for a year): bump VERSION and the references when a master
 * changes. Desktop app icons have fixed names and are rewritten in place.
 *
 *   node scripts/build-brand-icons.mjs
 *
 * Needs sharp (installed under Backend/node_modules) and, for the .icns,
 * macOS's iconutil.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO, "Backend", "package.json"));
const sharp = loadSharp();

const VERSION = 1;
const MASTER_FULL = join(REPO, "scripts", "brand-art", "crest.webp");
const MASTER_SMALL = join(REPO, "scripts", "brand-art", "crest-small.webp");

// The masters come back from the model with no fully opaque pixel (the
// shield is alpha 250-254) and a faint haze around it. Same cleanup as the
// stage figures (build-stage-sprites.mjs): haze below ALPHA_CUT goes, the
// body from ALPHA_SOLID up becomes solid.
const ALPHA_CUT = 24;
const ALPHA_SOLID = 236;
// A pixel at least this opaque is shield in the pixel-fitted favicons.
const FAVICON_EDGE = 128;

const INK = { r: 10, g: 6, b: 22 }; // --v-ink
const PLATE_INNER = "#2a2163";
const PLATE_OUTER = "#120c2c";

const WEB = join(REPO, "Web", "assets", "brand");
const SITE = join(REPO, "Site", "assets", "art");
const MAC_ICON = join(REPO, "VaultApp", "Resources", "Assets.xcassets", "AppIcon.appiconset");
const MAC_EMBLEM = join(REPO, "VaultApp", "Resources", "Assets.xcassets", "VaultEmblem.imageset");
const WIN_ICONS = join(REPO, "WindowsApp", "src-tauri", "icons");
const WIN_UI = join(REPO, "WindowsApp", "ui");

function loadSharp() {
  try {
    return require("sharp");
  } catch {
    process.stderr.write("build-brand-icons: sharp not found; run `npm install` in Backend/ first.\n");
    process.exit(1);
  }
}

const name = (base, size, ext) => `crest-${base ? `${base}-` : ""}${size}-v${VERSION}.${ext}`;

/** The master with its alpha cleaned and trimmed to the shield. */
async function loadShield(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 3; i < out.length; i += 4) {
    const a = out[i];
    out[i] = a < ALPHA_CUT ? 0 : a >= ALPHA_SOLID ? 255 : Math.round(((a - ALPHA_CUT) / (ALPHA_SOLID - ALPHA_CUT)) * 255);
  }
  return sharp(out, { raw: info }).trim({ threshold: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

const blank = (size) =>
  sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });

/** The shield alone, `height` px tall: no padding, so its ink starts on the box edge. */
async function trimmed(shield, height) {
  const meta = await sharp(shield).metadata();
  return sharp(shield).resize(Math.round((meta.width * height) / meta.height), height, { kernel: "lanczos3" }).png().toBuffer();
}

/** The shield scaled to `height` px and centred on a size x size canvas (or over `base`). */
async function place(shield, size, height, { base = null, top = null } = {}) {
  const meta = await sharp(shield).metadata();
  const width = Math.round((meta.width * height) / meta.height);
  const art = await sharp(shield).resize(width, height, { kernel: "lanczos3" }).png().toBuffer();
  const canvas = base ? sharp(base) : blank(size);
  const y = top ?? Math.floor((size - height) / 2);
  return canvas.composite([{ input: art, left: Math.floor((size - width) / 2), top: y }]).png().toBuffer();
}

/** Hard edge at FAVICON_EDGE, then a 1px ink ring wherever the canvas has room for it. */
async function inkToGrid(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= FAVICON_EDGE;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (solid(x, y)) {
        out.set([data[i], data[i + 1], data[i + 2], 255], i);
      } else if (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1)) {
        out.set([INK.r, INK.g, INK.b, 255], i);
      }
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** 16px: full height (the window and spire need every row), ring on the sides. 32px: 30 tall, ring all round. */
async function favicon(small, size) {
  return inkToGrid(await place(small, size, size <= 16 ? size : size - 2));
}

/** A night-indigo tile. `shape`: "square" (full bleed) or "squircle" (macOS: inset, rounded, shadowed). */
function plate(size, shape = "square") {
  const s = size;
  const svg =
    shape === "squircle"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="g" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="${PLATE_INNER}"/><stop offset="1" stop-color="${PLATE_OUTER}"/></radialGradient>
    <filter id="d" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="14"/><feOffset dy="12"/><feComponentTransfer><feFuncA type="linear" slope="0.45"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)" stroke="#0a0616" stroke-width="10" filter="url(#d)"/>
</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">
  <defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="${PLATE_INNER}"/><stop offset="1" stop-color="${PLATE_OUTER}"/></radialGradient></defs>
  <rect width="100" height="100" fill="url(#g)"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The shield on a full-bleed plate, `ratio` of the tile tall. */
async function tile(shield, size, ratio) {
  return place(shield, size, Math.round(size * ratio), { base: await plate(size) });
}

/** macOS app icon: squircle plate (824 of 1024), shield 74% of the plate. */
async function macIcon(shield, size) {
  const body = (824 / 1024) * size;
  return place(shield, size, Math.round(body * 0.74), { base: await plate(size, "squircle") });
}

/** White silhouette for Android's notification badge (only its alpha is used). */
async function badge(small, size) {
  const placed = await place(small, size, Math.round(size * 0.92));
  const { data, info } = await sharp(placed).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) data.set([255, 255, 255], i);
  return sharp(data, { raw: info }).png().toBuffer();
}

/** .ico with PNG-compressed entries (Windows Vista+ and every browser). */
function ico(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, n) => {
    const at = 6 + 16 * n;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

function icns(pngsBySize, outPath) {
  const dir = mkdtempSync(join(tmpdir(), "crest-"));
  const set = join(dir, "icon.iconset");
  mkdirSync(set);
  for (const pt of [16, 32, 128, 256, 512]) {
    writeFileSync(join(set, `icon_${pt}x${pt}.png`), pngsBySize[pt]);
    writeFileSync(join(set, `icon_${pt}x${pt}@2x.png`), pngsBySize[pt * 2]);
  }
  try {
    execFileSync("iconutil", ["-c", "icns", set, "-o", outPath]);
  } catch (error) {
    process.stderr.write(`build-brand-icons: iconutil failed, ${outPath} left as it was (${error.message})\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const written = [];
function write(path, buf) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  written.push([path.slice(REPO.length + 1), buf.length]);
}
const webp = (buf) => sharp(buf).webp({ lossless: true, effort: 6 }).toBuffer();
const png = (buf) => sharp(buf).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();

async function buildWeb(full, small) {
  const fav16 = await png(await favicon(small, 16));
  const fav32 = await png(await favicon(small, 32));
  const fav48 = await png(await favicon(small, 48));
  const rail = await webp(await trimmed(full, 96));
  const touch = await png(await tile(full, 180, 0.74));
  const files = {
    // Sized by height (the rail at 32-44px, the landing nav and footer at 40px), so it is
    // trimmed: the shield's ink lines up with the rows under it.
    [name("trim", 96, "webp")]: rail,
    // Square: the sign-in page (64px), Run Coach (32px), the classic fallback top bar (32px).
    [name("", 128, "webp")]: await webp(await place(full, 128, 128)),
    [name("favicon", 16, "png")]: fav16,
    [name("favicon", 32, "png")]: fav32,
    [name("icon", 192, "png")]: await png(await place(full, 192, Math.round(192 * 0.94))),
    [name("icon", 512, "png")]: await png(await place(full, 512, Math.round(512 * 0.94))),
    // Android crops maskable icons to a circle of 80%: a shield 60% tall keeps its corners inside it.
    [name("maskable", 512, "png")]: await png(await tile(full, 512, 0.6)),
    [name("touch", 180, "png")]: touch,
    // Avatars are cropped to a circle: the small cut, 68% tall, clears it.
    [name("avatar", 128, "png")]: await png(await tile(small, 128, 0.68)),
    [name("badge", 96, "png")]: await png(await badge(small, 96)),
  };
  for (const [file, buf] of Object.entries(files)) write(join(WEB, file), buf);
  const favicons = ico([{ size: 16, png: fav16 }, { size: 32, png: fav32 }, { size: 48, png: fav48 }]);
  write(join(REPO, "Web", "favicon.ico"), favicons);

  for (const file of [name("trim", 96, "webp"), name("favicon", 16, "png"), name("favicon", 32, "png"), name("touch", 180, "png")]) {
    write(join(SITE, file), files[file]);
  }
  write(join(REPO, "Site", "favicon.ico"), favicons);
}

async function buildMac(full, small) {
  const bySize = {};
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    bySize[size] = await png(await macIcon(size <= 64 ? small : full, size));
    write(join(MAC_ICON, `icon_${size}.png`), bySize[size]);
  }
  // The app's views clip this to a rounded square with a gold stroke.
  write(join(MAC_EMBLEM, "emblem.png"), await png(await tile(full, 256, 0.74)));
  write(join(MAC_EMBLEM, "emblem@2x.png"), await png(await tile(full, 512, 0.74)));
  write(join(MAC_EMBLEM, "emblem@3x.png"), await png(await tile(full, 1024, 0.74)));
  return bySize;
}

async function buildWindows(full, small, macBySize) {
  const shield = async (size) => png(size <= 48 ? await favicon(small, size) : await place(full, size, Math.round(size * 0.94)));
  const s = {};
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) s[size] = await shield(size);
  write(join(WIN_ICONS, "16x16.png"), s[16]);
  write(join(WIN_ICONS, "32x32.png"), s[32]);
  write(join(WIN_ICONS, "64x64.png"), s[64]);
  write(join(WIN_ICONS, "128x128.png"), s[128]);
  write(join(WIN_ICONS, "128x128@2x.png"), s[512]);
  write(join(WIN_ICONS, "icon.png"), s[256]);
  write(join(WIN_ICONS, "icon.ico"), ico([16, 24, 32, 48, 64, 256].map((size) => ({ size, png: s[size] }))));
  write(join(WIN_ICONS, "tray.png"), await png(await place(small, 64, 60)));
  write(join(WIN_ICONS, "tray@2x.png"), await png(await place(small, 128, 120)));
  // The overlay frames this at 22-24px in a rounded square.
  write(join(WIN_UI, "emblem.png"), await png(await tile(small, 256, 0.74)));
  // Tauri's macOS bundle icon: the same squircle set as the native app.
  const icnsPath = join(WIN_ICONS, "icon.icns");
  icns(macBySize, icnsPath);
  written.push([icnsPath.slice(REPO.length + 1), "iconutil"]);
}

async function main() {
  const full = await loadShield(MASTER_FULL);
  const small = await loadShield(MASTER_SMALL);
  await buildWeb(full, small);
  const macBySize = await buildMac(full, small);
  await buildWindows(full, small, macBySize);
  for (const [path, bytes] of written) process.stdout.write(`${path}  ${bytes}\n`);
}

main().catch((error) => {
  process.stderr.write(`build-brand-icons failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
