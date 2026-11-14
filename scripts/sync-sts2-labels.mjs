#!/usr/bin/env node
/**
 * Adds the cards and relics labels.json is missing, straight from the game.
 *
 * labels.json started life as an export of the iOS companion's GameDatabase,
 * which stops at whatever patch it was last updated for. This reads the
 * installed game's English localization and its art index (see
 * sts2-pck/pck.mjs) and adds every card and relic the app has no name for,
 * with the exact in-game title. It only ever adds: existing entries, even ones
 * the game has since renamed, are left alone and listed so a person can decide.
 *
 *   Card   key  <pool>_<id with underscores removed>   "Foolish Shot"
 *          key  <pool>_<...>_plus                       "Foolish Shot+1"
 *   Relic  key  <id lowercased, underscores removed>   "Song Bow"
 *
 * <pool> comes from the card_portraits folder the card's art lives in (fool,
 * ironclad, ...; event, token, curse, status and quest cards file under
 * colorless, as the existing labels do). Ids ending in their pool
 * (STRIKE_FOOL) become `fool_strike`, matching the app's slug-swap lookup.
 *
 *   node scripts/sync-sts2-labels.mjs [path/to/Slay the Spire 2.pck] [--dry]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardCatalog, flag, openPck, pckPathFromArgs, relicCatalog } from "./sts2-pck/pck.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LABELS_FILE = join(REPO_ROOT, "Web", "assets", "sts2", "labels.json");

const concat = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** label keys grouped by the name part after the prefix (base cards only). */
function keysByName(cards) {
  const map = new Map();
  for (const key of Object.keys(cards)) {
    if (key.endsWith("_plus")) continue;
    const name = key.slice(key.indexOf("_") + 1);
    map.set(name, [...(map.get(name) ?? []), key]);
  }
  return map;
}

function addCards(labels, catalog) {
  const byName = keysByName(labels.cards);
  const added = [];
  const alreadyNamed = [];
  for (const card of catalog) {
    if (labels.cards[card.slug]) continue;
    // A card can already be labelled under another prefix (Rip and Tear lives in
    // the event art folder but the app files it under defect) or under its
    // title instead of its id (Neow's Abundance). Pool-suffixed ids (STRIKE_FOOL)
    // are the exception: every character has its own Strike.
    const pooled = card.id.toLowerCase().endsWith(`_${card.pool}`);
    const name = card.slug.slice(card.slug.indexOf("_") + 1);
    const elsewhere = pooled ? [] : [...(byName.get(name) ?? []), ...(byName.get(concat(card.title)) ?? [])];
    if (elsewhere.length > 0) {
      alreadyNamed.push(`${card.id} -> ${elsewhere.join(", ")}`);
      continue;
    }
    labels.cards[card.slug] = card.title;
    labels.cards[`${card.slug}_plus`] = `${card.title}+1`;
    added.push(card);
  }
  labels.cards = Object.fromEntries(Object.entries(labels.cards).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { added, alreadyNamed };
}

function addRelics(labels, catalog) {
  const added = [];
  for (const relic of catalog) {
    if (labels.relics[relic.slug]) continue;
    labels.relics[relic.slug] = relic.title;
    added.push(relic);
  }
  return added;
}

function main() {
  const pck = openPck(pckPathFromArgs());
  try {
    const labels = JSON.parse(readFileSync(LABELS_FILE, "utf8"));
    const cards = cardCatalog(pck);
    const relics = relicCatalog(pck);
    const { added: newCards, alreadyNamed } = addCards(labels, cards.cards);
    const newRelics = addRelics(labels, relics.relics);
    labels.counts = {
      ...labels.counts,
      cards: Object.keys(labels.cards).length,
      relics: Object.keys(labels.relics).length,
      bosses: Object.keys(labels.bosses).length,
    };

    const byPrefix = {};
    for (const card of newCards) byPrefix[card.prefix] = (byPrefix[card.prefix] ?? 0) + 1;
    process.stdout.write(`cards: ${newCards.length} added (+ as many _plus) ${JSON.stringify(byPrefix)}\n`);
    for (const card of newCards) process.stdout.write(`  ${card.slug.padEnd(32)} ${card.title}\n`);
    process.stdout.write(`relics: ${newRelics.length} added\n`);
    for (const relic of newRelics) process.stdout.write(`  ${relic.slug.padEnd(32)} ${relic.title}\n`);
    process.stdout.write(`already named under another key: ${alreadyNamed.length}\n`);
    process.stdout.write(`not added, no art anywhere in the pack (test or cut content):\n`);
    process.stdout.write(`  cards  ${cards.skipped.join(" ")}\n  relics ${relics.skipped.join(" ")}\n`);

    if (flag("dry")) return;
    writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
  } finally {
    pck.close();
  }
}

main();
