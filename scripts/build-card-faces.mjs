#!/usr/bin/env node
/**
 * Builds card faces for every card the web app has no render for.
 *
 * The shipped card art (Web/assets/sts2/cards/*.webp) is a 205x256 render of
 * the whole in-game card. Cards newer than that art set (all of The Fool's,
 * the v0.113.0 event and token cards) had nothing. This composes a face for
 * each from the installed game itself — see sts2-pck/card-face.js for the
 * drawing — and adds it to manifest.json:
 *
 *   portrait     the card's own art from the pack (release art, else the
 *                game's beta placeholder art, which is what the game shows too)
 *   frame        the game's frame texture, tinted with the pool's colour
 *                material (materials/cards/frames/*.tres, shaders/hsv.gdshader)
 *   banner       the game's banner + portrait border, tinted for rarity
 *   title        the English title in the game's font (Kreon), green with "+"
 *                for the upgraded copy (<slug>_plus.webp)
 *   type plaque  only when the card's type is known (see cardTraits)
 *
 * What a face leaves out, and why: rules text, energy cost and card type are
 * not in the pack's data. The localized description has placeholders whose
 * numbers live in compiled code, and keyword lines such as "Exhaust." are
 * appended by code too, so the text cannot be reproduced honestly. A card
 * whose type is unknown gets the plain (skill-shaped) frame with no type
 * plaque; a card whose rarity is unknown gets the scene's default (common,
 * grey) banner. Types and rarities come only from KNOWN_TRAITS below or from
 * the iOS companion's GameDatabase (cards that predate The Fool).
 *
 * It is an asset build, run by hand after a game patch — not part of
 * `make preflight`, because it needs the game installed and Playwright.
 *
 *   node scripts/build-card-faces.mjs [path/to/Slay the Spire 2.pck]
 *        [--dry] [--preview <dir>] [--only <slug,...>] [--zoom <n>]
 *        [--calibrate <slug,...> --preview <dir>]   render cards that already
 *            have art, side by side with the shipped render (no files written)
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arg, cardCatalog, flag, imageDataUrl, loadFont, loadImage, openPck, pckPathFromArgs } from "./sts2-pck/pck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_ROOT = join(REPO_ROOT, "Web", "assets", "sts2");
const MANIFEST_FILE = join(ASSET_ROOT, "manifest.json");
const CARD_DIR = join(ASSET_ROOT, "cards");
const DRAW_FILE = join(dirname(fileURLToPath(import.meta.url)), "sts2-pck", "card-face.js");
const GAME_DATABASE_DIR = join(REPO_ROOT, "SlayTheSpire2Companion", "SlayTheSpire2Companion", "Data");
/** The faces this script made. Re-running rebuilds exactly these; every other card image is shipped art and never touched. */
const GENERATED_FILE = join(dirname(fileURLToPath(import.meta.url)), "sts2-pck", "generated-card-faces.json");

const QUALITY = 0.9;

const TEXTURE = Object.freeze({
  frame: (type) => `images/packed/common_ui/card/card_frame_${type}_s.png`,
  border: (type) => `images/packed/common_ui/card/card_portrait_border_${type}_s.png`,
  banner: "images/packed/common_ui/card/card_banner.png",
  plaque: "images/ui/cards/card_portrait_border_plaque2.png",
});

/**
 * Pool -> frame colour material. The five existing characters' colours are
 * confirmed against their shipped renders (--calibrate). The Fool's is yellow:
 * card_frame_yellow_mat is the one frame material no other pool uses, and the
 * v0.113.0 patch notes print his name in [yellow].
 */
const FRAME_COLOUR = Object.freeze({
  ironclad: "red",
  silent: "green",
  defect: "blue",
  regent: "orange",
  necrobinder: "pink",
  fool: "yellow",
  curse: "curse",
});

/** Rarity -> banner material (materials/cards/banners/card_banner_<x>_mat.tres). */
const RARITY_BANNER = Object.freeze({
  basic: "common",
  starter: "common",
  common: "common",
  token: "common",
  shop: "common",
  uncommon: "uncommon",
  rare: "rare",
  curse: "curse",
  status: "status",
  event: "event",
});

/**
 * Traits known without the game's code. Every character's Strike is a basic
 * Attack and every Defend a basic Skill; The Fool's carry the same
 * "Deal {Damage} damage." / "Gain {Block} Block." text as the other five.
 * Add an entry here only with a source.
 */
const KNOWN_TRAITS = Object.freeze({
  fool_strike: { type: "attack", rarity: "basic" },
  fool_defend: { type: "skill", rarity: "basic" },
});

const TYPE_LABEL = Object.freeze({ attack: "Attack", skill: "Skill", power: "Power", curse: "Curse", status: "Status" });

/** Type and rarity per app slug from the iOS companion's GameDatabase*.swift. */
function gameDatabaseTraits() {
  const prefixes = { ic: "ironclad", si: "silent", de: "defect", re: "regent", nb: "necrobinder", cl: "colorless" };
  const traits = new Map();
  for (const file of readdirSync(GAME_DATABASE_DIR).filter((f) => /^GameDatabase.*\.swift$/.test(f))) {
    const source = readFileSync(join(GAME_DATABASE_DIR, file), "utf8");
    const pattern = /Card\(id: "([a-z]+)_([a-z0-9_]+)",[^)]*?rarity: \.([a-z]+), type: \.([a-z]+)/g;
    for (const [, short, name, rarity, type] of source.matchAll(pattern)) {
      if (prefixes[short]) traits.set(`${prefixes[short]}_${name.replace(/_/g, "")}`, { type, rarity });
    }
  }
  return traits;
}

function cardTraits(card, database) {
  const known = KNOWN_TRAITS[card.slug] ?? database.get(card.slug) ?? {};
  const type = known.type in TYPE_LABEL ? known.type : null;
  const rarity = known.rarity ?? (card.pool === "curse" ? "curse" : card.pool === "status" ? "status" : null);
  return { type, rarity };
}

/** h/s/v of one of the game's hsv.gdshader materials (shader defaults are 1). */
function material(pck, path) {
  const text = pck.text(path);
  const value = (name) => Number(text.match(new RegExp(`shader_parameter/${name} = ([0-9.]+)`))?.[1] ?? 1);
  return { h: value("h"), s: value("s"), v: value("v") };
}

/** Art the app's resolver can already find (cardImageSrc collapses underscores and swaps pool order). */
function artIndex(manifestCards) {
  const exact = new Set();
  const names = new Set();
  for (const slug of manifestCards) {
    const plus = slug.endsWith("_plus") ? "_plus" : "";
    const base = plus ? slug.slice(0, -5) : slug;
    const cut = base.indexOf("_");
    const name = base.slice(cut + 1).replace(/_/g, "");
    exact.add(`${base.slice(0, cut)}_${name}${plus}`);
    names.add(`${name}${plus}`);
  }
  return {
    /** Pool-suffixed cards (every pool has a Strike) must match exactly; others by name in any pool. */
    has(card, plus) {
      const suffix = plus ? "_plus" : "";
      if (card.id.toLowerCase().endsWith(`_${card.pool}`)) return exact.has(card.slug + suffix);
      return names.has(card.slug.slice(card.slug.indexOf("_") + 1) + suffix);
    },
  };
}

async function assets(page, pck) {
  const url = async (path) => {
    const image = loadImage(pck, path);
    if (!image) throw new Error(`no readable texture for ${path}`);
    return imageDataUrl(page, image);
  };
  const types = ["attack", "skill", "power"];
  const frames = Object.fromEntries(await Promise.all(types.map(async (t) => [t, await url(TEXTURE.frame(t))])));
  const borders = Object.fromEntries(await Promise.all(types.map(async (t) => [t, await url(TEXTURE.border(t))])));
  return {
    frames,
    borders,
    banner: await url(TEXTURE.banner),
    plaque: await url(TEXTURE.plaque),
    fonts: {
      // card.tscn: TitleLabel uses Kreon Regular (FontVariation, glyph spacing 1), TypeLabel Kreon Bold.
      titleBase64: loadFont(pck, "fonts/kreon_regular.ttf").toString("base64"),
      typeBase64: loadFont(pck, "fonts/kreon_bold.ttf").toString("base64"),
    },
  };
}

async function renderFace(page, pck, shared, card, traits, upgraded) {
  const portrait = loadImage(pck, card.portrait);
  if (!portrait) throw new Error(`${card.id}: no readable portrait at ${card.portrait}`);
  const frameType = traits.type === "attack" || traits.type === "power" ? traits.type : "skill";
  const colour = FRAME_COLOUR[card.pool] ?? "colorless";
  const banner = RARITY_BANNER[traits.rarity] ?? "common";
  const spec = {
    title: upgraded ? `${card.title}+` : card.title,
    upgraded,
    typeLabel: traits.type ? TYPE_LABEL[traits.type] : null,
    portrait: await imageDataUrl(page, portrait),
    frame: shared.frames[frameType],
    border: shared.borders[frameType],
    banner: shared.banner,
    plaque: shared.plaque,
    frameMaterial: material(pck, `materials/cards/frames/card_frame_${colour}_mat.tres`),
    rarityMaterial: material(pck, `materials/cards/banners/card_banner_${banner}_mat.tres`),
    fonts: shared.fonts,
    quality: QUALITY,
  };
  return Buffer.from(await page.evaluate((s) => window.CardFace.render(s), spec), "base64");
}

async function writeSheet(page, rows, dir, file) {
  mkdirSync(dir, { recursive: true });
  const zoom = Number(arg("zoom", "1"));
  const figure = ({ label, bytes }) =>
    `<figure><img src="data:image/webp;base64,${bytes.toString("base64")}"><figcaption>${label}</figcaption></figure>`;
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.setContent(`<!doctype html><style>body{margin:12px;background:#1d1a22;display:flex;flex-wrap:wrap;gap:10px;font:11px system-ui;color:#ddd}
    figure{margin:0;width:${205 * zoom}px}img{display:block;width:${205 * zoom}px;height:${256 * zoom}px;image-rendering:pixelated}figcaption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>${rows.map(figure).join("")}`);
  await page.screenshot({ path: join(dir, file), fullPage: true });
}

/** Card images on disk, by slug. */
function cardFilesOnDisk() {
  return readdirSync(CARD_DIR).filter((f) => f.endsWith(".webp")).map((f) => f.slice(0, -".webp".length));
}

function readGenerated() {
  return existsSync(GENERATED_FILE) ? JSON.parse(readFileSync(GENERATED_FILE, "utf8")) : [];
}

async function main() {
  const pck = openPck(pckPathFromArgs());
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const database = gameDatabaseTraits();
  const generated = new Set(readGenerated());
  // Shipped art = everything listed or on disk that this script did not make.
  const art = artIndex([...new Set([...manifest.cards, ...cardFilesOnDisk()])].filter((slug) => !generated.has(slug)));
  const { cards } = cardCatalog(pck);
  const calibrate = arg("calibrate", "");
  const only = arg("only", "");
  const previewDir = arg("preview", "");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: DRAW_FILE });
    const shared = await assets(page, pck);

    if (calibrate) {
      const rows = [];
      for (const slug of calibrate.split(",")) {
        const upgraded = slug.endsWith("_plus");
        const card = cards.find((c) => c.slug === slug.replace(/_plus$/, ""));
        if (!card) throw new Error(`--calibrate: ${slug} is not a card in the pack`);
        const traits = cardTraits(card, database);
        rows.push({ label: `${slug} · shipped`, bytes: readFileSync(join(CARD_DIR, `${slug}.webp`)) });
        rows.push({ label: `${slug} · built (${traits.type ?? "?"}/${traits.rarity ?? "?"})`, bytes: await renderFace(page, pck, shared, card, traits, upgraded) });
      }
      await writeSheet(page, rows, previewDir || ".", "card-faces-calibration.png");
      return;
    }

    const todo = cards.filter((card) => !art.has(card, false) && (!only || only.split(",").includes(card.slug)));
    const results = [];
    for (const card of todo) {
      const traits = cardTraits(card, database);
      const variants = art.has(card, true) ? [false] : [false, true];
      for (const upgraded of variants) {
        const slug = upgraded ? `${card.slug}_plus` : card.slug;
        results.push({ slug, label: slug, bytes: await renderFace(page, pck, shared, card, traits, upgraded) });
      }
      const traitText = `${traits.type ?? "type ?"} / ${traits.rarity ?? "rarity ?"}`;
      process.stdout.write(`${card.slug.padEnd(30)} ${traitText.padEnd(22)} ${card.portraitIsBeta ? "beta art" : "release art"}\n`);
    }
    if (previewDir) await writeSheet(page, results.filter((r) => !r.slug.endsWith("_plus")), previewDir, "card-faces.png");
    if (flag("dry")) return;
    for (const r of results) writeFileSync(join(CARD_DIR, `${r.slug}.webp`), r.bytes);
    const made = only ? [...generated, ...results.map((r) => r.slug)] : results.map((r) => r.slug);
    writeFileSync(GENERATED_FILE, `${JSON.stringify([...new Set(made)].sort(), null, 2)}\n`);
    // The manifest lists the art that exists: exactly the files on disk.
    manifest.cards = cardFilesOnDisk().sort();
    manifest.counts.cards = manifest.cards.length;
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    process.stdout.write(`${results.length} faces written; manifest lists ${manifest.cards.length} cards\n`);
  } finally {
    await browser.close();
    pck.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
