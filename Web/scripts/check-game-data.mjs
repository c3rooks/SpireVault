#!/usr/bin/env node
/**
 * Game-data drift guard.
 *
 * The app describes Slay the Spire 2 content from several hand-maintained
 * sources — labels.json, relic-info.js, ascension-info.js, demo-runs.js,
 * the boss list in script.js, and the Swift AI-overlay glossary. Each can
 * silently rot when the game patches or when one file is edited without
 * the others. This guard makes the cross-source invariants a failed deploy
 * instead of a quiet lie. It found real bugs on its first run; keep it in
 * preflight.
 *
 * Checks:
 *   1. labels.json structural integrity (counts honest, prefixes valid,
 *      no Watcher — STS2 has no Watcher).
 *   2. Every RELIC_INFO key resolves to a labels.json relic; every rarity
 *      has a color; every effect is non-empty.
 *   3. Ascension tiers cover 0-10 contiguously and every level renders.
 *   4. Every demo-run card/relic slug resolves to labels (art + names on
 *      the first-visit experience must never regress to placeholders).
 *   5. Boss ids in script.js's BOSSES list exist in labels.bosses.
 *   6. script.js character enumerations contain exactly the 5-character
 *      STS2 roster (regression guard on the Watcher cleanup).
 *   7. Every Swift glossary card/relic key resolves to a labels entry, so
 *      the AI overlay can never describe a card the game doesn't have.
 *   8. The GAME_SYNC version constants match docs/game-data-sync.md.
 *
 * Run: node Web/scripts/check-game-data.mjs  (wired into Web `make preflight`)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, "..");

const errors = [];
const fail = (msg) => errors.push(msg);

const labels = JSON.parse(readFileSync(join(WEB, "assets/sts2/labels.json"), "utf8"));
const cardKeys = new Set(Object.keys(labels.cards));
const relicKeys = new Set(Object.keys(labels.relics));
const bossKeys = new Set(Object.keys(labels.bosses));

const ROSTER = ["ironclad", "silent", "defect", "regent", "necrobinder"];
const CARD_PREFIXES = new Set([...ROSTER, "colorless"]);

// ---- 1. labels.json integrity ----------------------------------------------

for (const [field, actual] of [
  ["cards", cardKeys.size],
  ["relics", relicKeys.size],
  ["bosses", bossKeys.size],
]) {
  if (labels.counts?.[field] !== actual) {
    fail(`labels.json counts.${field} says ${labels.counts?.[field]} but there are ${actual} entries`);
  }
}
for (const k of cardKeys) {
  const prefix = k.split("_")[0];
  if (!CARD_PREFIXES.has(prefix)) {
    fail(`labels.json card "${k}" has unknown class prefix "${prefix}"`);
  }
}
for (const k of [...cardKeys, ...relicKeys]) {
  if (k.includes("watcher")) fail(`labels.json contains Watcher content: "${k}" — STS2 has no Watcher`);
}

// ---- helpers ----------------------------------------------------------------

const strip = (s) => s.replace(/[^a-z0-9]/g, "");
/** True when a concatenated card name exists under any class prefix. */
function cardExistsAnyClass(concat) {
  for (const p of CARD_PREFIXES) if (cardKeys.has(`${p}_${concat}`)) return true;
  return false;
}
function relicExists(slug) {
  return relicKeys.has(slug) || relicKeys.has(strip(slug));
}

// ---- 2. relic-info.js --------------------------------------------------------

const relicInfo = await import(pathToFileURL(join(WEB, "lib/relic-info.js")).href);
{
  const rarities = new Set(Object.keys(relicInfo.RARITY_COLORS));
  for (const [slug, entry] of Object.entries(relicInfo.RELIC_INFO)) {
    if (!relicExists(slug)) fail(`relic-info.js "${slug}" is not a labels.json relic`);
    if (!rarities.has(entry.rarity)) fail(`relic-info.js "${slug}" rarity "${entry.rarity}" has no RARITY_COLORS entry`);
    if (!entry.effect?.trim()) fail(`relic-info.js "${slug}" has an empty effect string`);
  }
}

// ---- 3. ascension-info.js ----------------------------------------------------

const asc = await import(pathToFileURL(join(WEB, "lib/ascension-info.js")).href);
for (let lvl = 0; lvl <= 10; lvl++) {
  const tier = asc.tierFor(lvl);
  if (!tier || tier.key === "unknown") fail(`ascension-info.js has no tier covering level ${lvl}`);
  const mod = asc.modifierFor(lvl);
  if (!mod?.detail) fail(`ascension-info.js modifierFor(${lvl}) renders empty`);
}

// ---- 4. demo-runs.js ---------------------------------------------------------

{
  const src = readFileSync(join(WEB, "lib/demo-runs.js"), "utf8");
  const cardSlugs = [...src.matchAll(/"((?:ironclad|silent|defect|regent|necrobinder|colorless)_[a-z0-9_]+)"/g)]
    .map((m) => m[1]);
  for (const slug of new Set(cardSlugs)) {
    if (!cardKeys.has(slug) && !cardKeys.has(slug.replace(/_plus$/, ""))) {
      fail(`demo-runs.js card "${slug}" is not in labels.json — first-visit art would be a placeholder`);
    }
  }
  // Relic vocab lives in two named arrays; parse their contents specifically.
  for (const arrName of ["RELICS_COMMON", "RELICS_RARE"]) {
    const m = src.match(new RegExp(`const ${arrName} = \\[([^\\]]+)\\]`, "s"));
    if (!m) { fail(`demo-runs.js: could not find ${arrName}`); continue; }
    for (const slug of [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1])) {
      if (!relicExists(slug)) fail(`demo-runs.js relic "${slug}" (${arrName}) is not in labels.json`);
    }
  }
}

// ---- 5 + 6. script.js boss list and roster enumerations ---------------------

{
  const src = readFileSync(join(WEB, "script.js"), "utf8");

  const bossBlock = src.match(/const BOSSES = \[([\s\S]*?)\n\];/);
  if (!bossBlock) fail("script.js: could not locate the BOSSES array");
  else {
    for (const m of bossBlock[1].matchAll(/id: "([a-z0-9_]+)"/g)) {
      if (!bossKeys.has(m[1])) fail(`script.js BOSSES id "${m[1]}" is not in labels.json bosses`);
    }
  }

  // Each enum ends differently: CLASS_PREFIXES is `new Set([...])`,
  // CHAR_THEME a plain object, CHAR_META an IIFE. A generic lazy match
  // stops at the first `};` INSIDE the IIFE and silently checks an empty
  // block, so the terminator is explicit per constant.
  const ENUM_END = {
    CLASS_PREFIXES: "\\]\\);",
    CHAR_THEME: "\\};",
    CHAR_META: "\\}\\)\\(\\);",
  };
  for (const constName of ["CLASS_PREFIXES", "CHAR_THEME", "CHAR_META"]) {
    const block = src.match(new RegExp(`const ${constName} = [\\s\\S]*?${ENUM_END[constName]}`));
    if (!block) { fail(`script.js: could not locate ${constName}`); continue; }
    if (/watcher/i.test(block[0])) fail(`script.js ${constName} still references Watcher`);
    for (const ch of ROSTER) {
      if (!block[0].includes(ch)) fail(`script.js ${constName} is missing "${ch}"`);
    }
  }
}

// ---- 7. Swift glossary -------------------------------------------------------

{
  const src = readFileSync(join(ROOT, "VaultApp/App/Overlay/STS2CardGlossary.swift"), "utf8");
  const cardsBlock = src.slice(src.indexOf("static let cards"), src.indexOf("static let relics"));
  const relicsBlock = src.slice(src.indexOf("static let relics"), src.indexOf("// MARK: - Lookup"));

  const STRIKE_DEFEND = /^(strike|defend)_(red|green|blue|regent|necrobinder)$/;
  const SUFFIX_CLASS = { red: "ironclad", green: "silent", blue: "defect", regent: "regent", necrobinder: "necrobinder" };

  for (const m of cardsBlock.matchAll(/^\s{8}"([a-z0-9_']+)": \.init/gm)) {
    const key = m[1];
    const sd = key.match(STRIKE_DEFEND);
    const concat = sd ? sd[1] : strip(key);
    const ok = sd
      ? cardKeys.has(`${SUFFIX_CLASS[sd[2]]}_${sd[1]}`)
      : cardExistsAnyClass(concat);
    if (!ok) fail(`STS2CardGlossary card "${key}" does not resolve to any labels.json card`);
  }
  for (const m of relicsBlock.matchAll(/^\s{8}"([a-z0-9_']+)": \.init/gm)) {
    if (!relicExists(m[1])) fail(`STS2CardGlossary relic "${m[1]}" is not a labels.json relic`);
  }
}

// ---- 8. version constants stay in sync with the ledger ----------------------

{
  const sync = await import(pathToFileURL(join(WEB, "lib/game-sync.js")).href);
  const ledger = readFileSync(join(ROOT, "docs/game-data-sync.md"), "utf8");
  for (const [what, v] of [["main", sync.GAME_SYNC.main], ["betaWatch", sync.GAME_SYNC.betaWatch]]) {
    if (!ledger.includes(v)) {
      fail(`game-sync.js ${what}="${v}" does not appear in docs/game-data-sync.md — one of them is stale`);
    }
  }
  if (!/^v0\.\d+\.\d+$/.test(sync.GAME_SYNC.main)) fail(`game-sync.js main "${sync.GAME_SYNC.main}" is not a vX.Y.Z version`);
}

// ---- report ------------------------------------------------------------------

if (errors.length > 0) {
  console.error(`\nGame-data check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error("");
  process.exit(1);
}
console.log(
  `Game-data check passed — ${cardKeys.size} card labels, ${relicKeys.size} relics, ` +
  `${bossKeys.size} bosses, ${Object.keys(relicInfo.RELIC_INFO).length} relic tooltips, all cross-referenced.`
);
