#!/usr/bin/env node
/**
 * Offline checks for the Steam copy of a player's runs (lib/cloud-run-wire.js).
 *
 * The copy is what a signed-in player's other devices show: a phone, a second
 * browser, any browser that has not read the save folder. Until 2026-11-18 it
 * carried no card picks at all (the upload read a field the parsed runs never
 * had), so those devices showed an empty Cards tab, every abandoned run as a
 * defeat and no act timeline, which reads as lost data.
 *
 *   · toWire / fromWire   a parsed run survives the trip with what the tabs show
 *   · bestOf              which copy of one run a device keeps, without trading detail away
 *   · hasRunsCopyLacks, hasDetailCopyLacks  when a device must send its runs up again
 *
 * Run: node Web/scripts/verify-cloud-run-wire.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseSTS2Run } = await import(join(WEB, "lib", "sts2-run-parser.js"));
const Stats = await import(join(WEB, "lib", "stats-engine.js"));
const Climbs = await import(join(WEB, "lib", "coop-climbs.js"));
const Wire = await import(join(WEB, "lib", "cloud-run-wire.js"));

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

// ---- a save file shaped like the game's ------------------------------------------

const choice = (id, picked) => ({ card: { id: `CARD.${id}` }, was_picked: picked });

/** One map point: a room, and optionally the cards it offered. */
const point = (roomType, choices, mapType) => ({
  ...(mapType ? { map_point_type: mapType } : {}),
  rooms: [{ room_type: roomType }],
  player_stats: [{ current_hp: 50, max_hp: 70, current_gold: 99, ...(choices ? { card_choices: choices } : {}) }],
});

const saveFile = (extra = {}) => ({
  schema_version: 11,
  ascension: 7,
  seed: "ABCDEF",
  start_time: 1794000000,
  run_time: 1800,
  win: false,
  game_mode: "standard",
  killed_by_encounter: "ENCOUNTER.SLIME",
  players: [{
    id: 1,
    character: "CHARACTER.IRONCLAD",
    deck: [{ id: "CARD.STRIKE", current_upgrade_level: 0 }, { id: "CARD.INFLAME", current_upgrade_level: 0 }],
    relics: [{ id: "RELIC.BURNING_BLOOD" }],
    potions: [],
  }],
  map_point_history: [
    [
      point("monster", [choice("INFLAME", true), choice("CLOTHESLINE", false), choice("ANGER", false)]),
      point("event"),
      point("monster", [choice("SHRUG_IT_OFF", false), choice("CLEAVE", false), choice("UPPERCUT", false)]),
      point("shop", [choice("OFFERING", true), choice("BLUDGEON", false)], "shop"),
      point("rest", null, "rest"),
      point("boss", [choice("FEED", true), choice("REAPER", false), choice("IMPERVIOUS", false)], "boss"),
    ],
    [point("monster", [choice("ANGER", true), choice("CLEAVE", false)]), point("elite", null, "elite"), point("treasure")],
  ],
  ...extra,
});

/** A parsed run after the trip a second device sees: up as JSON, back down. */
const trip = (run) => Wire.fromWire(JSON.parse(JSON.stringify(Wire.toWire(run))));

/** The Cards tab's numbers for a set of runs. */
const cardNumbers = (runs) => {
  const summary = Stats.summarize(runs.map((r) => Stats.normalizeRun(r)), { cardMinSample: 1, relicMinSample: 1, topN: 50 });
  return JSON.stringify(Object.fromEntries(Object.entries(summary).filter(([key]) => /card/i.test(key))));
};

const parsed = parseSTS2Run(saveFile(), "1794000000.run");

// ---- card picks ------------------------------------------------------------------

await check("the save used here has card picks to lose", () => {
  assert.equal(parsed.cardPicks.length, 5);
  assert.deepEqual(parsed.cardPicks[0], { floor: 1, offered: ["inflame", "clothesline", "anger"], picked: "inflame", source: "combat" });
});

await check("the upload carries every card pick", () => {
  const wire = Wire.toWire(parsed);
  const screens = wire.picks.split(";");
  assert.equal(screens.length, 5, "one entry per reward screen");
  assert.equal(screens[0], "1:inflame|clothesline,anger");
  assert.equal(screens[1], "3:|shrug_it_off,cleave,uppercut", "a skipped reward keeps what was offered");
  assert.equal("cardChoices" in wire, false, "one string per run, not a list of objects (the server's processor budget)");
});

await check("the picks string holds only what the server accepts", () => {
  // Backend/src/runs.ts drops a `picks` string with any other character.
  const SERVER_PATTERN = /^[A-Za-z0-9_+.%:|,;-]*$/;
  assert.match(Wire.toWire(parsed).picks, SERVER_PATTERN);
  // Ids the game does not use but a mod might: none may break the format, and none is lost.
  const offered = ["mymod:Big Card", "a;b", "x|y", "50%,off", "fine.card", "strike+1", "(what)!", "カード"];
  const odd = { ...parsed, cardPicks: [{ floor: 2, offered, picked: "mymod:Big Card", source: "combat" }] };
  const wire = Wire.toWire(odd);
  assert.match(wire.picks, SERVER_PATTERN);
  assert.equal(wire.picks.split(";").length, 1, "still one reward screen");
  const back = trip(odd).cardPicks[0];
  assert.equal(back.picked, "mymod:Big Card");
  assert.deepEqual([...back.offered].sort(), [...offered].sort(), "every card comes back as it was");
  assert.equal(Wire.toWire({ ...parsed, cardPicks: [{ floor: 1, offered: ["song_path"], picked: "song_path", source: "combat" }] }).picks, "1:song_path|", "the game's own ids travel unescaped");
});

await check("the older object form still loads", () => {
  // The server still stores `cardChoices` from any client that sends it.
  const choices = [{ floor: 1, picked: "inflame", skipped: ["anger"] }];
  const back = Wire.fromWire({ ...Wire.toWire(parsed), picks: undefined, cardChoices: choices });
  assert.deepEqual(back.cardPicks, [{ floor: 1, offered: ["inflame", "anger"], picked: "inflame", source: "combat" }]);
  const unreadable = Wire.fromWire({ ...Wire.toWire(parsed), picks: ";;", cardChoices: choices });
  assert.equal(unreadable.cardPicks.length, 1, "a picks string that holds nothing falls back to it too");
});

await check("card picks come back on another device", () => {
  const back = trip(parsed);
  assert.equal(back.cardPicks.length, parsed.cardPicks.length);
  back.cardPicks.forEach((pick, i) => {
    const original = parsed.cardPicks[i];
    assert.equal(pick.floor, original.floor);
    assert.equal(pick.picked, original.picked);
    assert.deepEqual([...pick.offered].sort(), [...original.offered].sort(), `floor ${pick.floor}: the same cards were on offer`);
    assert.equal(pick.source, original.source, `floor ${pick.floor}: the room it came from`);
  });
  assert.equal("cardChoices" in back, false, "the wire name does not leak into the app's run");
});

await check("the Cards tab shows the same numbers from the Steam copy", () => {
  const second = parseSTS2Run(saveFile({ start_time: 1794100000, win: true, killed_by_encounter: "NONE.NONE" }), "1794100000.run");
  const fromSaves = cardNumbers([parsed, second]);
  assert.ok(fromSaves.includes("inflame"), "the check is looking at real card numbers");
  assert.equal(cardNumbers([trip(parsed), trip(second)]), fromSaves);
});

await check("tied cards rank the same on every device", () => {
  // Cards that tie on every number used to rank by the order the runs and
  // offers happened to arrive in. A device that loads the Steam copy holds
  // its runs newest first, with each offer's picked card first, so the same
  // history listed tied cards differently (and, past the list's cut-off,
  // different cards) from the device that read the saves.
  const saves = [0, 1, 2, 3].map((i) => parseSTS2Run(saveFile({
    start_time: 1794000000 + i * 5000,
    map_point_history: [[
      point("monster", [choice("ANGER", i % 2 === 0), choice("CLEAVE", i % 2 === 1), choice("UPPERCUT", false)]),
      point("monster", [choice("FEED", false), choice("REAPER", i % 2 === 0), choice("INFLAME", i % 2 === 1)]),
    ]],
  }), `${i}.run`));
  const fromSaves = cardNumbers(saves);
  const fromCopy = cardNumbers(saves.map(trip).reverse());
  assert.equal(fromCopy, fromSaves);
  const ranked = JSON.parse(fromSaves);
  assert.deepEqual(ranked.topPickedCards.map((c) => c.key), ["anger", "cleave", "inflame", "reaper"], "ties in name order");
});

// ---- the rest of what the tabs show ------------------------------------------------

await check("an abandoned run stays abandoned, not a defeat", () => {
  const quit = parseSTS2Run(saveFile({ was_abandoned: true }), "quit.run");
  assert.equal(quit.wasAbandoned, true);
  assert.equal(trip(quit).wasAbandoned, true);
  assert.equal(trip(parsed).wasAbandoned, false);
});

await check("a daily run keeps its mode and modifiers", () => {
  const daily = parseSTS2Run(saveFile({ game_mode: "daily", modifiers: ["MODIFIER.DOUBLE_TIME", { id: "MODIFIER.FLIGHT" }] }), "daily.run");
  const back = trip(daily);
  assert.equal(back.gameMode, "daily");
  assert.deepEqual(back.modifiers, ["double_time", "flight"]);
  assert.equal(trip(parsed).gameMode, "standard");
  assert.deepEqual(trip(parsed).modifiers, []);
});

await check("the act timeline survives, room for room", () => {
  assert.deepEqual(trip(parsed).pathByAct, parsed.pathByAct);
  assert.equal(parsed.pathByAct[1].nodes[2].type, "chest");
});

await check("a co-op run keeps its party", () => {
  const coop = parseSTS2Run(saveFile({
    players: ["CHARACTER.IRONCLAD", "CHARACTER.SILENT"].map((character, i) => ({
      id: 76561198000000000 + i, character, deck: [{ id: "CARD.STRIKE", current_upgrade_level: 0 }], relics: [], potions: [],
    })),
  }), "coop.run");
  const back = trip(coop);
  assert.deepEqual(back.party, ["ironclad", "silent"]);
  assert.equal(back.partySize, 2);
  assert.equal(trip(parsed).partySize, 1);
  const climbs = Climbs.summarizeCoopClimbs([back, trip(parsed)].map((r) => ({ ...r, endedAt: new Date(r.endedAt) })));
  assert.equal(climbs.known, true);
  assert.equal(climbs.runs, 1);
});

await check("the basics are unchanged", () => {
  const wire = Wire.toWire(parsed);
  assert.equal(wire.id, parsed.id);
  assert.equal(wire.character, "ironclad");
  assert.equal(wire.ascension, 7);
  assert.equal(wire.won, false);
  assert.equal(wire.floorReached, parsed.floorReached);
  assert.equal(wire.endedAt, parsed.endedAt.toISOString());
  assert.equal(wire.startedAt, parsed.startedAt.toISOString());
  assert.deepEqual(wire.relics, parsed.relics);
  assert.deepEqual(wire.deckAtEnd, parsed.deckAtEnd);
});

// ---- copies made before the fix ----------------------------------------------------

/** What the server holds for a run uploaded before 2026-11-18. */
const oldCopy = (run) => {
  const { id, character, ascension, floorReached, won, playTimeSeconds, endedAt, startedAt, seed, relics, deckAtEnd } = Wire.toWire(run);
  return { id, character, ascension, floorReached, won, playTimeSeconds, endedAt, startedAt, seed, relics, deckAtEnd, cardChoices: [] };
};

await check("a copy from before the fix still loads, with nothing invented", () => {
  const back = Wire.fromWire(oldCopy(parsed));
  assert.deepEqual(back.cardPicks, []);
  assert.deepEqual(back.pathByAct, []);
  assert.deepEqual(back.modifiers, []);
  assert.equal(back.wasAbandoned, false);
  assert.equal(back.partySize, undefined, "unknown, not solo");
  assert.equal(Climbs.summarizeCoopClimbs([back]).known, false);
  assert.equal(Wire.hasCardPicks(back), false);
  assert.equal(Wire.hasCardPicks(trip(parsed)), true);
});

await check("junk in the copy cannot break the app", () => {
  const back = Wire.fromWire({ ...oldCopy(parsed), cardChoices: [null, { floor: "x", picked: 7, skipped: "no" }, { floor: 4, picked: "anger" }], path: ["cz!", 9], modifiers: "x", party: [null, "silent"], partySize: 2 });
  assert.deepEqual(back.cardPicks, [{ floor: 4, offered: ["anger"], picked: "anger", source: "unknown" }]);
  const garbled = Wire.fromWire({ ...oldCopy(parsed), picks: ";;nonsense;x:|;7:anger|%E0%A4%A;:|cleave,,%;9" });
  assert.deepEqual(garbled.cardPicks, [
    { floor: 7, offered: ["anger"], picked: "anger", source: "unknown" },
    { floor: 0, offered: ["cleave"], picked: null, source: "unknown" },
  ]);
  assert.deepEqual(Wire.fromWire({ ...oldCopy(parsed), picks: 42 }).cardPicks, []);
  assert.deepEqual(back.pathByAct, [{ act: 1, nodes: [{ floor: 1, type: "combat" }, { floor: 2, type: "unknown" }, { floor: 3, type: "unknown" }] }, { act: 2, nodes: [] }]);
  assert.deepEqual(back.modifiers, []);
  assert.deepEqual(back.party, [null, "silent"]);
});

// ---- limits the server also applies ------------------------------------------------

await check("a corrupt save cannot send an unbounded upload", () => {
  const many = { ...parsed, cardPicks: Array.from({ length: 500 }, (_, i) => ({ floor: i + 1, offered: Array.from({ length: 100 }, (_, j) => `card_${j}`), picked: "card_0", source: "combat" })) };
  const wire = Wire.toWire(many);
  assert.ok(wire.picks.length <= Wire.LIMITS.picksChars, `picks is ${wire.picks.length} characters`);
  const screens = wire.picks.split(";");
  assert.ok(screens.length >= 20 && screens.length <= Wire.LIMITS.choices);
  assert.equal(screens[0].split("|")[1].split(",").length, Wire.LIMITS.skipped);
  assert.equal(screens.at(-1).split("|")[1].split(",").length, Wire.LIMITS.skipped, "the last screen kept is whole, not cut off");
  assert.ok(Wire.LIMITS.skipped >= 30, "a 30-card offer (seen in real saves) fits whole");
});

await check("a long real run fits whole", () => {
  // The longest run in a real 726-run library: 31 reward screens, one a 30-card offer.
  const screens = Array.from({ length: 31 }, (_, i) => ({ floor: i * 2 + 1, offered: Array.from({ length: i === 9 ? 30 : 4 }, (_, j) => `some_card_name_${i}_${j}`), picked: i % 2 ? `some_card_name_${i}_0` : null, source: "combat" }));
  const back = trip({ ...parsed, cardPicks: screens });
  assert.equal(back.cardPicks.length, 31);
  assert.equal(back.cardPicks[9].offered.length, 30);
});

// ---- which copy of a run a device keeps ----------------------------------------------

const asLoaded = (run) => ({ ...run, endedAt: run.endedAt ? new Date(run.endedAt) : null });
/** GET /api/runs as the server answers it for these loaded runs. */
const served = (runs) => JSON.parse(JSON.stringify(runs.map(Wire.toWire)));
const rich = asLoaded(trip(parsed));
const thin = asLoaded(Wire.fromWire(oldCopy(parsed)));

await check("a later end time wins, as before", () => {
  const later = { ...thin, endedAt: new Date(thin.endedAt.getTime() + 60_000), floorReached: 40 };
  assert.equal(Wire.cloudCopyWins(rich, later), true);
  assert.equal(Wire.cloudCopyWins(later, rich), false);
  assert.equal(Wire.bestOf(rich, later).floorReached, 40);
});

await check("at the same end time the copy with card picks wins", () => {
  assert.equal(Wire.bestOf(thin, rich), rich, "a device holding the old thin copy takes the full one");
  assert.equal(Wire.bestOf(rich, thin), rich, "a device holding the full run never trades it for a thin copy");
  assert.equal(Wire.bestOf(rich, { ...rich }), rich, "identical copies: the device keeps its own object, so nothing re-renders");
  assert.equal(Wire.bestOf(thin, { ...thin }), thin);
});

await check("a later record without card picks never erases them", () => {
  // A run with no end time is stamped with the upload time, and builds before
  // the fix sent no picks: the copy then looks later AND is thinner.
  const laterThin = { ...thin, endedAt: new Date(thin.endedAt.getTime() + 60_000), floorReached: 40 };
  const fromSave = { ...asLoaded(parsed), wasAbandoned: true, modifiers: ["flight"], gameMode: "daily" };
  const kept = Wire.bestOf(fromSave, laterThin);
  assert.equal(kept.floorReached, 40, "the later record's numbers");
  assert.deepEqual(kept.cardPicks, fromSave.cardPicks, "…with the card picks the device had");
  assert.deepEqual(kept.pathByAct, fromSave.pathByAct);
  assert.equal(kept.wasAbandoned, true);
  assert.deepEqual(kept.modifiers, ["flight"]);
  assert.equal(kept.gameMode, "daily");
  assert.equal(kept.sourceFile, "1794000000.run", "…and the file it was read from");
  // The other way round: the device's record is later but thin.
  const filled = Wire.bestOf(laterThin, rich);
  assert.equal(filled.floorReached, 40);
  assert.deepEqual(filled.cardPicks, rich.cardPicks);
});

// ---- when a device sends its runs up again -------------------------------------------

await check("a device whose runs have card picks fills a copy that lacks them", () => {
  assert.equal(Wire.hasDetailCopyLacks([rich], [thin]), true);
});

// A run abandoned before its first card reward: no card picks to send, but
// its abandoned flag, mode and rooms are what a second device shows. The
// first release of the fix (v248) sent only runs with card picks, and left
// 56 of one library's 176 abandoned runs showing as defeats elsewhere.
const quitEarlySave = parseSTS2Run(saveFile({ start_time: 1794200000, was_abandoned: true, game_mode: "daily", map_point_history: [[point("monster"), point("event")]] }), "1794200000.run");
const quitEarly = asLoaded(trip(quitEarlySave));
const quitEarlyThin = asLoaded(Wire.fromWire(oldCopy(quitEarlySave)));

await check("a run with no card rewards still carries its detail up", () => {
  assert.equal(quitEarly.cardPicks.length, 0, "the save offered no cards");
  assert.equal(quitEarly.wasAbandoned, true);
  assert.equal(Wire.hasDetailCopyLacks([quitEarly], [quitEarlyThin]), true);
  assert.deepEqual(Wire.runsToSend([quitEarly], Wire.indexOfCopy([oldCopy(quitEarlySave)])), [quitEarly]);
  // …and once the copy has it, it is not sent again.
  assert.equal(Wire.hasDetailCopyLacks([quitEarly], [quitEarly]), false);
  assert.deepEqual(Wire.runsToSend([quitEarly], Wire.indexOfCopy(served([quitEarly]))), []);
  const after = Wire.indexAfterSend(Wire.indexOfCopy([oldCopy(quitEarlySave)]), [quitEarly]);
  assert.deepEqual(Wire.runsToSend([quitEarly], after), []);
});

await check("a device with nothing new stays quiet", () => {
  for (const [local, copy] of [[[rich], [rich]], [[thin], [rich]], [[thin], [thin]], [[], [rich]]]) {
    assert.equal(Wire.hasDetailCopyLacks(local, copy), false);
    assert.equal(Wire.hasRunsCopyLacks(local, copy), false);
  }
});

await check("a run the copy has never seen goes up", () => {
  const local = [rich, { ...thin, id: "another-run" }];
  assert.equal(Wire.hasRunsCopyLacks(local, [rich]), true);
  assert.equal(Wire.hasDetailCopyLacks(local, [rich]), false, "that is a missing run, not missing detail");
});

// ---- sending only what the copy lacks -------------------------------------------------

await check("with the copy unread, everything goes up, as before", () => {
  assert.deepEqual(Wire.runsToSend([rich, thin], null), [rich, thin]);
});

await check("an import sends only the runs the copy lacks", () => {
  const fresh = { ...rich, id: "new-run" };
  const index = Wire.indexOfCopy(served([rich]));
  assert.deepEqual(Wire.runsToSend([rich, fresh], index), [fresh]);
  assert.deepEqual(Wire.runsToSend([rich], index), [], "nothing new: no request and no write at all");
});

await check("a copy without card picks gets the runs that have them", () => {
  const index = Wire.indexOfCopy([oldCopy(parsed)]);
  assert.deepEqual(Wire.runsToSend([rich], index), [rich]);
  assert.deepEqual(Wire.runsToSend([thin], index), [], "a device that has no picks either has nothing to add");
  const objectForm = Wire.indexOfCopy([{ ...oldCopy(parsed), cardChoices: [{ floor: 1, picked: "inflame", skipped: [] }] }]);
  assert.equal(objectForm.get(parsed.id).hasPicks, true, "picks stored in the older object form count as held");
  const picksOnly = { ...thin, cardPicks: rich.cardPicks };
  assert.deepEqual(Wire.runsToSend([picksOnly], objectForm), [], "…so a device with nothing but those picks sends nothing");
});

await check("a run that ended later than the copy's record goes up", () => {
  const index = Wire.indexOfCopy(served([rich]));
  const later = { ...rich, endedAt: new Date(rich.endedAt.getTime() + 1000) };
  assert.deepEqual(Wire.runsToSend([later], index), [later]);
  const earlier = { ...rich, endedAt: new Date(rich.endedAt.getTime() - 1000) };
  assert.deepEqual(Wire.runsToSend([earlier], index), []);
});

await check("what was just sent is not sent twice", () => {
  const before = Wire.indexOfCopy([oldCopy(parsed)]);
  const after = Wire.indexAfterSend(before, [rich, { ...rich, id: "new-run" }]);
  assert.deepEqual(Wire.runsToSend([rich, { ...rich, id: "new-run" }], after), []);
  assert.equal(before.size, 1, "the earlier index is left as it was");
  assert.equal(before.get(rich.id).hasPicks, false);
  assert.equal(Wire.indexAfterSend(null, [rich]), null, "still unread: keep sending everything");
});

await check("a large library goes up in several requests", () => {
  const library = Array.from({ length: Wire.UPLOAD_CHUNK_RUNS * 2 + 5 }, (_, i) => ({ ...rich, id: `run-${i}` }));
  const chunks = Wire.inChunks(library, Wire.UPLOAD_CHUNK_RUNS);
  assert.deepEqual(chunks.map((c) => c.length), [Wire.UPLOAD_CHUNK_RUNS, Wire.UPLOAD_CHUNK_RUNS, 5]);
  assert.deepEqual(chunks.flat(), library, "every run, once, in order");
  assert.deepEqual(Wire.inChunks([], 10), []);
});

if (process.exitCode) {
  console.error("verify-cloud-run-wire: FAILED");
} else {
  console.log(`✓ Steam copy of runs: all ${passed} checks passed`);
}
