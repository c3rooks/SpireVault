#!/usr/bin/env node
/**
 * Offline checks for "Your co-op climbs" on the Co-op tab:
 *
 *   · lib/sts2-run-parser.js   a save file's whole party is kept, not only its first player
 *   · lib/coop-climbs.js       the numbers shown: runs, wins, win rate, best floor,
 *                              the last few co-op runs and the party you have won most with
 *
 * What a co-op save looks like comes from the game itself: its run history
 * holds a list of players (RunHistoryPlayer: a 64-bit id, the character, deck,
 * relics…), one per player. Which of them is the local player is not recorded,
 * so everything here is about the party as a whole.
 *
 * Run: node Web/scripts/verify-coop-climbs.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseSTS2Run } = await import(join(WEB, "lib", "sts2-run-parser.js"));
const Climbs = await import(join(WEB, "lib", "coop-climbs.js"));

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

// ---- the parser ------------------------------------------------------------------

/** A save file shaped like the game's (schema 11), with the given players. */
const saveFile = (characters, extra = {}) => ({
  schema_version: 11,
  ascension: 4,
  seed: "ABCDEF",
  start_time: 1794000000,
  run_time: 1800,
  win: true,
  game_mode: "standard",
  killed_by_encounter: "NONE.NONE",
  players: characters.map((character, i) => ({
    // Solo saves use id 1; in multiplayer each player's id is a 64-bit number.
    id: characters.length === 1 ? 1 : 76561198000000000 + i,
    character,
    deck: [{ id: "CARD.STRIKE", current_upgrade_level: 0 }],
    relics: [{ id: "RELIC.BURNING_BLOOD" }],
    potions: [],
  })),
  map_point_history: [[{ rooms: [{ room_type: "monster" }], player_stats: characters.map(() => ({ current_hp: 50, max_hp: 70, current_gold: 99 })) }]],
  ...extra,
});

await check("a solo save is a party of one", () => {
  const run = parseSTS2Run(saveFile(["CHARACTER.SILENT"]), "1.run");
  assert.equal(run.character, "silent");
  assert.equal(run.partySize, 1);
  assert.deepEqual(run.party, ["silent"]);
});

await check("a co-op save keeps every player's character, in the file's order", () => {
  const duo = parseSTS2Run(saveFile(["CHARACTER.IRONCLAD", "CHARACTER.SILENT"]), "2.run");
  assert.equal(duo.partySize, 2);
  assert.deepEqual(duo.party, ["ironclad", "silent"]);
  assert.equal(duo.character, "ironclad", "the run's own character is still the first player's, as before");

  const four = parseSTS2Run(saveFile(["CHARACTER.DEFECT", "CHARACTER.REGENT", "CHARACTER.NECROBINDER", "CHARACTER.FOOL"]), "4.run");
  assert.equal(four.partySize, 4);
  assert.deepEqual(four.party, ["defect", "regent", "necrobinder", "fool"]);
});

await check("a player whose character cannot be read is kept as unknown, not dropped", () => {
  const run = parseSTS2Run(saveFile(["CHARACTER.SILENT", "CHARACTER.SOMETHING_NEW"]), "x.run");
  assert.equal(run.partySize, 2);
  assert.deepEqual(run.party, ["silent", null]);
});

// ---- the numbers -------------------------------------------------------------------

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
let n = 0;
const run = (party, extra = {}) => {
  n += 1;
  return {
    id: `r${n}`, character: party[0], party, partySize: party.length, won: false, wasAbandoned: false,
    floorReached: 20, ascension: 3, endedAt: new Date(T0 + n * DAY), ...extra,
  };
};

await check("with no saves read yet, nothing is known", () => {
  const empty = Climbs.summarizeCoopClimbs([]);
  assert.equal(empty.known, false);
  assert.equal(empty.runs, 0);
  // Runs imported before parties were kept carry no party size.
  const old = Climbs.summarizeCoopClimbs([{ id: "a", character: "silent", won: true }]);
  assert.equal(old.known, false);
  assert.equal(Climbs.summarizeCoopClimbs(null).known, false);
});

await check("solo runs are known but are not co-op climbs", () => {
  const s = Climbs.summarizeCoopClimbs([run(["silent"], { won: true }), run(["ironclad"])]);
  assert.equal(s.known, true);
  assert.equal(s.runs, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.bestParty, null);
  assert.deepEqual(s.recent, []);
});

await check("runs, wins, win rate and best floor count co-op runs only", () => {
  const s = Climbs.summarizeCoopClimbs([
    run(["silent"], { won: true, floorReached: 60 }), // solo: ignored
    run(["ironclad", "silent"], { won: true, floorReached: 51 }),
    run(["ironclad", "silent"], { floorReached: 33 }),
    run(["defect", "regent", "silent"], { floorReached: 12, wasAbandoned: true }),
    run(["ironclad", "defect"], { won: true, floorReached: 48 }),
  ]);
  assert.equal(s.runs, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.abandoned, 1);
  assert.equal(s.winRate, 2 / 4, "wins over every co-op run, abandoned ones included, like the rest of the app");
  assert.equal(s.bestFloor, 51);
});

await check("the last few co-op runs come newest first, with the whole party", () => {
  const s = Climbs.summarizeCoopClimbs([
    run(["ironclad", "silent"], { won: true }),
    run(["silent"]),
    run(["defect", "regent"]),
    run(["ironclad", "defect"], { wasAbandoned: true }),
    run(["fool", "silent", "regent", "necrobinder"], { won: true, ascension: 9, floorReached: 51 }),
  ]);
  assert.equal(s.recent.length, Climbs.RECENT_COUNT);
  assert.deepEqual(s.recent.map((r) => r.party.join("+")), ["fool+silent+regent+necrobinder", "ironclad+defect", "defect+regent"]);
  assert.deepEqual(s.recent.map((r) => r.result), ["won", "abandoned", "lost"]);
  assert.equal(s.recent[0].ascension, 9);
  assert.equal(s.recent[0].floor, 51);
  assert.ok(s.recent[0].when instanceof Date);
});

await check("the best party is the one with the most wins, whatever order its players were listed in", () => {
  const s = Climbs.summarizeCoopClimbs([
    run(["ironclad", "silent"], { won: true }),
    run(["silent", "ironclad"], { won: true }), // same pair, other order
    run(["ironclad", "silent"]),
    run(["defect", "regent"], { won: true }),
    run(["defect", "regent"]),
  ]);
  assert.deepEqual(s.bestParty, { party: ["ironclad", "silent"], wins: 2, runs: 3 });
});

await check("ties go to the party with fewer runs, and no wins means no best party", () => {
  const tie = Climbs.summarizeCoopClimbs([
    run(["ironclad", "silent"], { won: true }),
    run(["ironclad", "silent"]),
    run(["defect", "regent"], { won: true }),
  ]);
  assert.deepEqual(tie.bestParty, { party: ["defect", "regent"], wins: 1, runs: 1 });
  const none = Climbs.summarizeCoopClimbs([run(["ironclad", "silent"]), run(["defect", "regent"], { wasAbandoned: true })]);
  assert.equal(none.bestParty, null);
  assert.equal(none.winRate, 0);
});

await check("an unknown character stays in the party as unknown", () => {
  const s = Climbs.summarizeCoopClimbs([run(["silent", null], { won: true })]);
  assert.deepEqual(s.recent[0].party, ["silent", null]);
  assert.deepEqual(s.bestParty.party, ["silent", null]);
});

await check("runs from elsewhere with missing or odd fields never throw and never invent players", () => {
  const odd = [
    null, 42, "run", {},
    { id: "a", partySize: 2, won: true },                       // no party list at all
    { id: "b", partySize: 3, party: ["silent"], won: false },    // a shorter list than the party
    { id: "c", partySize: "2", party: ["silent", "defect"] },    // size is not a number: unknown, not co-op
    { id: "d", partySize: 2, party: [7, { x: 1 }], endedAt: "not a date", floorReached: "high", ascension: null },
    { id: "e", partySize: 9999, party: [] },
  ];
  const before = JSON.stringify(odd);
  const s = Climbs.summarizeCoopClimbs(odd);
  assert.equal(JSON.stringify(odd), before, "the runs handed in are not changed");
  assert.equal(s.known, true);
  assert.equal(s.runs, 4, "a, b, d and e list more than one player");
  assert.equal(s.wins, 1);
  assert.equal(s.bestFloor, 0);
  const byId = Object.fromEntries(s.recent.map((r) => [r.id, r]));
  assert.ok(s.recent.every((r) => r.party.length <= 8 && r.party.every((c) => c === null || typeof c === "string")));
  assert.deepEqual(Climbs.summarizeCoopClimbs([odd[4]]).recent[0].party, [null, null], "two players, both unknown");
  assert.deepEqual(Climbs.summarizeCoopClimbs([odd[5]]).recent[0].party, ["silent", null, null]);
  assert.deepEqual(Climbs.summarizeCoopClimbs([odd[7]]).recent[0], { id: "d", when: null, result: "lost", floor: 0, ascension: null, party: [null, null] });
  assert.equal(Object.keys(byId).length, s.recent.length);
});

await check("in-progress runs are left out", () => {
  const s = Climbs.summarizeCoopClimbs([run(["ironclad", "silent"], { inProgress: true }), run(["ironclad", "silent"], { won: true })]);
  assert.equal(s.runs, 1);
});

console.log(`coop-climbs: ${passed} checks passed${process.exitCode ? " (with failures above)" : ""}`);
