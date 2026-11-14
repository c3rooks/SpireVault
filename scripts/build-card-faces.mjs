#!/usr/bin/env node
/**
 * Builds card faces for every card the web app has no render for.
 *
 * The shipped card art (Web/assets/sts2/cards/*.webp) is a 205x256 render of
 * the whole in-game card. Cards newer than that art set (all of The Fool's,
 * the v0.113.0 event and token cards) had nothing. This draws each the way the
 * game's card scene does (see sts2-pck/card-face.js), from the installed game:
 *
 *   portrait      the card's art from the pack (release art, else the game's
 *                 beta art, which is what the game shows too)
 *   frame         the frame texture for the card's type, tinted with its pool's
 *                 colour material (materials/cards/frames/*.tres, hsv.gdshader)
 *   banner        banner, portrait border and type plaque tinted for rarity
 *   title         Kreon, outlined in the rarity's colour; green with "+" when upgraded
 *   cost          the pool's energy orb with the cost (X, or none when unplayable),
 *                 plus the star orb for star costs
 *   rules text    the localized description with the card's real numbers and
 *                 keyword lines, laid out like the game's DescriptionLabel
 *
 * Cost, type, rarity, keywords and numbers come from sts2-pck/card-data.json,
 * which extract-card-data.mjs reads out of the game's compiled code. The
 * upgraded face (<slug>_plus.webp) shows what the game's upgrade preview
 * shows: changed numbers, cost and upgrade-only text in green.
 *
 * It is an asset build, run by hand after a game patch — not part of
 * `make preflight`, because it needs the game installed and Playwright:
 *
 *   node scripts/sts2-pck/extract-card-data.mjs       # refresh card-data.json
 *   node scripts/build-card-faces.mjs [path/to/Slay the Spire 2.pck]
 *        [--dry] [--preview <dir>] [--dump <dir>] [--only <slug,...>] [--zoom <n>]
 *        [--calibrate <slug,...> --preview <dir> [--sheet <file>] [--columns <n>] [--dump <dir>]]
 *            render cards that already have art, side by side with the shipped
 *            render (nothing in the repo is written; --dump saves the built faces)
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { arg, cardCatalog, flag, imageDataUrl, loadFont, loadImage, loadLocalization, openPck, pckPathFromArgs } from "./sts2-pck/pck.mjs";
import { cardDescription } from "./sts2-pck/card-text.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const ASSET_ROOT = join(REPO_ROOT, "Web", "assets", "sts2");
const MANIFEST_FILE = join(ASSET_ROOT, "manifest.json");
const CARD_DIR = join(ASSET_ROOT, "cards");
const DRAW_FILE = join(HERE, "sts2-pck", "card-face.js");
const CARD_DATA_FILE = join(HERE, "sts2-pck", "card-data.json");
/** The faces this script made. Re-running rebuilds exactly these; every other card image is shipped art and never touched. */
const GENERATED_FILE = join(HERE, "sts2-pck", "generated-card-faces.json");

const QUALITY = 0.9;

const TEXTURE = Object.freeze({
  frame: (type) => `images/packed/common_ui/card/card_frame_${type}_s.png`,
  border: (type) => `images/packed/common_ui/card/card_portrait_border_${type}_s.png`,
  banner: "images/packed/common_ui/card/card_banner.png",
  plaque: "images/ui/cards/card_portrait_border_plaque2.png",
  star: "images/ui/combat/energy_star.png",
  // EnergyIconHelper.GetPath: the ui atlas sprite when there is one, else packed/energy_icons.
  energy: (pck, name) => (pck.has(`images/atlases/ui_atlas.sprites/card/energy_${name}.tres`)
    ? `images/packed/common_ui/card/energy_${name}.png`
    : `images/packed/energy_icons/energy_${name}.png`),
  ancient: {
    mask: "images/compressed_ui/ancient_portrait_mask_large.png",
    glass: "images/vfx/ui/card/ancient/ui_card_ancient_border_main.png",
    border: "images/compressed_ui/ancient_card_border.png",
    textBg: (type) => `images/compressed_ui/ancient_text_bg_${type}.png`,
    banner: "images/packed/common_ui/card/ancient_banner.png",
    flame: "images/compressed_ui/ancient_card_flame_0.png",
  },
});

/** Fallback frame colour by portrait folder, only for a card the code has no data for. */
const FRAME_BY_FOLDER = Object.freeze({
  ironclad: "card_frame_red", silent: "card_frame_green", defect: "card_frame_blue", regent: "card_frame_orange",
  necrobinder: "card_frame_pink", fool: "card_frame_yellow", curse: "card_frame_curse", quest: "card_frame_quest",
});

/** CardModel.BannerMaterialPath: rarity -> materials/cards/banners/card_banner_<x>_mat.tres. */
const RARITY_BANNER = Object.freeze({
  Uncommon: "uncommon", Rare: "rare", Ancient: "ancient", Event: "event", Status: "status", Curse: "curse", Quest: "quest",
});

/** NCard.GetTitleLabelOutlineColor (StsColors.cardTitleOutline*); upgraded titles use green + cardTitleOutlineSpecial. */
const TITLE_OUTLINE = Object.freeze({
  Uncommon: "#005C75", Rare: "#6B4B00", Event: "#1B6131", Status: "#4F522F", Curse: "#550B9E", Quest: "#7E3E15",
});
const TITLE_OUTLINE_COMMON = "#4D4B40";
const COLOR = Object.freeze({ cream: "#FFF6E2", green: "#7FFF00", upgradeOutline: "#1B6131", energyGreenOutline: "#1F5923", starOutline: "rgba(23,85,97,0.863)" });

/** CardModel.FramePath / PortraitBorderPath: which texture each card type uses. */
const FRAME_TYPE = Object.freeze({ Attack: "attack", Skill: "skill", Power: "power", Quest: "quest" });
const BORDER_TYPE = Object.freeze({ Attack: "attack", Skill: "skill", Power: "power" });

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

/**
 * A TrueType font's vertical metrics as fractions of the font size: the hhea
 * ascent/descent and the taller OS/2 winAscent/winDescent. The shipped renders
 * use both (see DESCRIPTION in card-face.js).
 */
function fontMetrics(ttf) {
  const tables = {};
  for (let i = 0; i < ttf.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    tables[ttf.toString("latin1", record, record + 4)] = ttf.readUInt32BE(record + 8);
  }
  const unitsPerEm = ttf.readUInt16BE(tables.head + 18);
  const os2 = tables["OS/2"];
  const hhea = tables.hhea;
  return {
    ascent: ttf.readInt16BE(hhea + 4) / unitsPerEm,
    descent: -ttf.readInt16BE(hhea + 6) / unitsPerEm,
    winAscent: ttf.readUInt16BE(os2 + 74) / unitsPerEm,
    winDescent: ttf.readUInt16BE(os2 + 76) / unitsPerEm,
  };
}

/** Everything shared by every face: textures (as data URLs), fonts, localized strings. */
async function sharedAssets(page, pck) {
  const cache = new Map();
  const url = async (path) => {
    if (!cache.has(path)) {
      const image = loadImage(pck, path);
      if (!image) throw new Error(`no readable texture for ${path}`);
      cache.set(path, await imageDataUrl(page, image));
    }
    return cache.get(path);
  };
  const regular = loadFont(pck, "fonts/kreon_regular.ttf");
  const keywords = loadLocalization(pck, "card_keywords");
  const gameplay = loadLocalization(pck, "gameplay_ui");
  return {
    url,
    fonts: {
      // card.tscn: TitleLabel and DescriptionLabel use Kreon Regular, TypeLabel and EnergyLabel Kreon Bold.
      titleBase64: regular.toString("base64"),
      bodyBase64: regular.toString("base64"),
      boldBase64: loadFont(pck, "fonts/kreon_bold.ttf").toString("base64"),
    },
    metrics: fontMetrics(regular),
    loc: loadLocalization(pck, "cards"),
    keywordTitles: Object.fromEntries(Object.entries(keywords)
      .filter(([k]) => k.endsWith(".title"))
      .map(([k, v]) => [k[0] + k.slice(1, -".title".length).toLowerCase(), v])),
    typeLabel: (type) => gameplay[`CARD_TYPE.${type.toUpperCase()}`] ?? type,
  };
}

/** A card the compiled code has no class for: what the pack alone says (no cost, type or rarity). */
function stubData(card) {
  return { vars: [], keywords: [], upgrade: { cost: 0, starCost: 0, addKeywords: [], removeKeywords: [] }, energyIcon: card.pool, target: "None", missing: true };
}

/** Title text: CardModel.Title appends "+" (or "+<level>" for cards that upgrade more than once). */
function titleText(card, data, upgraded) {
  if (!upgraded) return card.title;
  return (data.maxUpgradeLevel ?? 1) > 1 ? `${card.title}+1` : `${card.title}+`;
}

function costSpec(data, upgraded, icon) {
  if (data.missing) return null;
  if (data.costX) return { text: "X", color: COLOR.cream, outline: `#${data.energyOutline}`, icon };
  if (data.cost < 0) return null; // NCard hides the orb for a negative cost (unplayable cards)
  const changed = upgraded && data.upgrade.cost !== 0;
  return {
    text: String(data.cost + (upgraded ? data.upgrade.cost : 0)),
    color: changed ? COLOR.green : COLOR.cream,
    outline: changed ? COLOR.energyGreenOutline : `#${data.energyOutline}`,
    icon,
  };
}

function starSpec(data, upgraded, icon) {
  if (data.starCostX) return { text: "X", color: COLOR.cream, outline: COLOR.starOutline, icon };
  if (data.starCost == null || data.starCost < 0) return null;
  const changed = upgraded && data.upgrade.starCost !== 0;
  return {
    text: String(data.starCost + (upgraded ? data.upgrade.starCost : 0)),
    color: changed ? COLOR.green : COLOR.cream,
    outline: changed ? COLOR.energyGreenOutline : COLOR.starOutline,
    icon,
  };
}

async function renderFace(page, pck, shared, card, data, upgraded) {
  const portrait = loadImage(pck, card.portrait);
  if (!portrait) throw new Error(`${card.id}: no readable portrait at ${card.portrait}`);
  const ancient = data.rarity === "Ancient";
  const frameName = data.frame ?? FRAME_BY_FOLDER[card.pool] ?? "card_frame_colorless";
  const bannerName = RARITY_BANNER[data.rarity] ?? "common";
  const description = cardDescription(data, shared.loc[`${card.id}.description`] ?? "", { upgraded, keywordTitles: shared.keywordTitles });
  const icons = {};
  for (const [, path] of description.matchAll(/\[img\]res:\/\/([^[]+)\[\/img\]/g)) icons[`res://${path}`] = await shared.url(path);
  const spec = {
    title: titleText(card, data, upgraded),
    titleColor: upgraded ? COLOR.green : COLOR.cream,
    titleOutline: upgraded ? COLOR.upgradeOutline : TITLE_OUTLINE[data.rarity] ?? TITLE_OUTLINE_COMMON,
    typeLabel: data.type ? shared.typeLabel(data.type) : null,
    ancient,
    portrait: await imageDataUrl(page, portrait),
    frame: await shared.url(TEXTURE.frame(FRAME_TYPE[data.type] ?? "skill")),
    border: await shared.url(TEXTURE.border(BORDER_TYPE[data.type] ?? "skill")),
    banner: await shared.url(TEXTURE.banner),
    plaque: await shared.url(TEXTURE.plaque),
    frameMaterial: material(pck, `materials/cards/frames/${frameName}_mat.tres`),
    bannerMaterial: material(pck, `materials/cards/banners/card_banner_${bannerName}_mat.tres`),
    cost: costSpec(data, upgraded, await shared.url(TEXTURE.energy(pck, data.energyIcon ?? "colorless"))),
    star: starSpec(data, upgraded, await shared.url(TEXTURE.star)),
    description,
    icons,
    fonts: shared.fonts,
    metrics: shared.metrics,
    tuning: JSON.parse(arg("tuning", "{}")), // --calibrate experiments only
    quality: QUALITY,
  };
  if (ancient) {
    const a = TEXTURE.ancient;
    spec.ancientAssets = {
      mask: await shared.url(a.mask),
      glass: await shared.url(a.glass),
      border: await shared.url(a.border),
      textBg: await shared.url(a.textBg(BORDER_TYPE[data.type] ?? "skill")),
      banner: await shared.url(a.banner),
      flame: await shared.url(a.flame),
    };
  }
  return Buffer.from(await page.evaluate((s) => window.CardFace.render(s), spec), "base64");
}

async function writeSheet(page, rows, dir, file, columns = 0) {
  mkdirSync(dir, { recursive: true });
  const zoom = Number(arg("zoom", "1"));
  const figure = ({ label, bytes }) =>
    `<figure><img src="data:image/webp;base64,${bytes.toString("base64")}"><figcaption>${label}</figcaption></figure>`;
  const width = columns ? columns * (205 * zoom + 10) + 24 : 1500;
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(`<!doctype html><style>body{margin:12px;background:#1d1a22;display:flex;flex-wrap:wrap;gap:10px;font:11px system-ui;color:#ddd}
    figure{margin:0;width:${205 * zoom}px}img{display:block;width:${205 * zoom}px;height:${256 * zoom}px}figcaption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style>${rows.map(figure).join("")}`);
  await page.screenshot({ path: join(dir, file), fullPage: true });
}

/** Card images on disk, by slug. */
function cardFilesOnDisk() {
  return readdirSync(CARD_DIR).filter((f) => f.endsWith(".webp")).map((f) => f.slice(0, -".webp".length));
}

function readGenerated() {
  return existsSync(GENERATED_FILE) ? JSON.parse(readFileSync(GENERATED_FILE, "utf8")) : [];
}

function readCardData() {
  const { cards } = JSON.parse(readFileSync(CARD_DATA_FILE, "utf8"));
  return cards;
}

async function main() {
  const pck = openPck(pckPathFromArgs());
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  const cardData = readCardData();
  const generated = new Set(readGenerated());
  // Shipped art = everything listed or on disk that this script did not make.
  const art = artIndex([...new Set([...manifest.cards, ...cardFilesOnDisk()])].filter((slug) => !generated.has(slug)));
  const { cards } = cardCatalog(pck);
  const calibrate = arg("calibrate", "");
  const only = arg("only", "");
  const previewDir = arg("preview", "");
  const dataFor = (card) => cardData[card.id] ?? stubData(card);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: DRAW_FILE });
    const shared = await sharedAssets(page, pck);

    if (calibrate) {
      const rows = [];
      for (const slug of calibrate.split(",")) {
        const upgraded = slug.endsWith("_plus");
        const base = slug.replace(/_plus$/, "");
        const name = (x) => x.slice(x.indexOf("_") + 1);
        // Shipped art can file a card under its character while the pack files it as an event card.
        const card = cards.find((c) => c.slug === base) ?? cards.find((c) => name(c.slug) === name(base));
        if (!card) throw new Error(`--calibrate: ${slug} is not a card in the pack`);
        const bytes = await renderFace(page, pck, shared, card, dataFor(card), upgraded);
        rows.push({ label: `${slug} · shipped`, bytes: readFileSync(join(CARD_DIR, `${slug}.webp`)) });
        rows.push({ label: `${slug} · built`, bytes });
        if (arg("dump", "")) {
          mkdirSync(arg("dump", ""), { recursive: true });
          writeFileSync(join(arg("dump", ""), `${slug}.webp`), bytes);
        }
      }
      await writeSheet(page, rows, previewDir || ".", arg("sheet", "card-faces-calibration.png"), Number(arg("columns", "0")));
      return;
    }

    const todo = cards.filter((card) => !art.has(card, false) && (!only || only.split(",").includes(card.slug)));
    const results = [];
    const uncertain = [];
    for (const card of todo) {
      const data = dataFor(card);
      if (data.missing) uncertain.push(`${card.slug}: no card class in sts2.dll — no cost, type or rarity printed`);
      for (const problem of data.problems ?? []) uncertain.push(`${card.slug}: ${problem}`);
      const variants = art.has(card, true) ? [false] : [false, true];
      for (const upgraded of variants) {
        const slug = upgraded ? `${card.slug}_plus` : card.slug;
        results.push({ slug, label: slug, bytes: await renderFace(page, pck, shared, card, data, upgraded) });
      }
      const traits = data.missing ? "no code data" : `${data.costX ? "X" : data.cost} ${data.type} / ${data.rarity}`;
      process.stdout.write(`${card.slug.padEnd(30)} ${traits.padEnd(24)} ${card.portraitIsBeta ? "beta art" : "release art"}\n`);
    }
    if (previewDir) await writeSheet(page, results, previewDir, "card-faces.png");
    for (const line of uncertain) process.stdout.write(`! ${line}\n`);
    if (arg("dump", "")) {
      mkdirSync(arg("dump", ""), { recursive: true });
      for (const r of results) writeFileSync(join(arg("dump", ""), `${r.slug}.webp`), r.bytes);
    }
    if (flag("dry")) return;
    for (const r of results) writeFileSync(join(CARD_DIR, `${r.slug}.webp`), r.bytes);
    const made = only ? [...generated, ...results.map((r) => r.slug)] : results.map((r) => r.slug);
    writeFileSync(GENERATED_FILE, `${JSON.stringify([...new Set(made)].sort(), null, 2)}\n`);
    // The manifest lists the art that exists: exactly the files on disk. Rewritten only when that changed.
    const before = JSON.stringify(manifest, null, 2);
    manifest.cards = cardFilesOnDisk().sort();
    manifest.counts.cards = manifest.cards.length;
    const after = JSON.stringify(manifest, null, 2);
    if (after !== before) writeFileSync(MANIFEST_FILE, after);
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
