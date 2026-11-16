#!/usr/bin/env node
/**
 * The three map symbols on the landing page's setup steps (Site/), copied
 * straight out of the installed game: the monster, chest and rest-site marks
 * the game draws on its own act map. They are the game's hand-inked art at
 * its own size (128px), so the page shows them at 64 CSS px at most.
 *
 *   node scripts/build-site-map-icons.mjs
 *   node scripts/build-site-map-icons.mjs "/path/to/Slay the Spire 2.pck"
 *
 * Writes Site/assets/art/map/<name>-128-v<N>.webp. /assets is cached as
 * immutable, so a changed picture needs a new VERSION.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadImage, openPck, pckPathFromArgs } from "./sts2-pck/pck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "Site", "assets", "art", "map");
const VERSION = 1;
const SIZE = 128;
const ICONS = Object.freeze([
  { name: "monster", source: "images/packed/common_ui/map/icons/map_monster.png" },
  { name: "chest", source: "images/packed/common_ui/map/icons/map_chest.png" },
  { name: "rest", source: "images/packed/common_ui/map/icons/map_rest.png" },
]);

function main() {
  const pck = openPck(pckPathFromArgs());
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const icon of ICONS) {
      const image = loadImage(pck, icon.source);
      if (!image) throw new Error(`${icon.source}: no readable texture in the pack`);
      if (image.kind !== "webp") throw new Error(`${icon.source}: expected a WebP texture, found ${image.kind}`);
      if (image.width !== SIZE || image.height !== SIZE) {
        throw new Error(`${icon.source}: expected ${SIZE}x${SIZE}, found ${image.width}x${image.height} (did the game change it?)`);
      }
      const out = join(OUT_DIR, `${icon.name}-${SIZE}-v${VERSION}.webp`);
      writeFileSync(out, image.bytes);
      process.stdout.write(`${out.replace(`${REPO_ROOT}/`, "")}  ${image.bytes.length} bytes\n`);
    }
  } finally {
    pck.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`build-site-map-icons failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
