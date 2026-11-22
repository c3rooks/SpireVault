#!/usr/bin/env node
/**
 * Offline checks for whose side of a co-op run SpireVault shows
 * (lib/run-owner.js, lib/sts2-run-parser.js, lib/cloud-run-wire.js).
 *
 * A co-op save lists every player and does not mark the local one. Until
 * 2026-11-22 the reader took the first player listed, so a player who joined
 * a friend's game saw the friend's climber, deck, relics and card picks
 * ("It seems to pull my friends' results instead of mine for the co-op
 * runs", a player on Reddit).
 *
 *   · run-owner        the Steam ID in a save's path, exact 64-bit ids, the vote
 *   · the reader       the local player's climber, deck, relics, card picks and HP
 *   · the Steam copy   a corrected record travels, and beats one that may show a teammate
 *
 * Run: node Web/scripts/verify-run-owner.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const Owner = await import(join(WEB, "lib", "run-owner.js"));
const { parseSTS2Run } = await import(join(WEB, "lib", "sts2-run-parser.js"));
const Stats = await import(join(WEB, "lib", "stats-engine.js"));
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

// ---- saves shaped like the game's ----------------------------------------------
// Ids as the game writes them: 1 in a solo run, each player's 17-digit
// SteamID64 in co-op. These three are made up; no two share their first 16
// digits, and ME's last digits do not survive JSON.parse as a number.

const ME = "76561198000000043";
const ANA = "76561198000004177";
const BO = "76561198000090211";

const CLIMBERS = {
  [ME]: { character: "CHARACTER.SILENT", deck: ["CARD.NEUTRALIZE", "CARD.SURVIVOR"], relic: "RELIC.RING_OF_THE_SNAKE", pick: "CARD.BLADE_DANCE", hp: 41, gold: 210 },
  [ANA]: { character: "CHARACTER.IRONCLAD", deck: ["CARD.BASH"], relic: "RELIC.BURNING_BLOOD", pick: "CARD.INFLAME", hp: 70, gold: 99 },
  [BO]: { character: "CHARACTER.DEFECT", deck: ["CARD.ZAP", "CARD.DUALCAST"], relic: "RELIC.CRACKED_CORE", pick: "CARD.BALL_LIGHTNING", hp: 55, gold: 150 },
};

/** The save's text, ids written as bare numbers the way the game writes them. */
function saveText(order, { start = 1790000000, statsOrder = order, solo = false } = {}) {
  const id = (steamId) => (solo ? "1" : steamId);
  const players = order.map((steamId) => {
    const c = CLIMBERS[steamId];
    return `{"character":"${c.character}","deck":[${c.deck.map((card) => `{"id":"${card}","current_upgrade_level":0}`).join(",")}],"id":${id(steamId)},"max_potion_slot_count":3,"potions":[],"relics":[{"id":"${c.relic}"}]}`;
  });
  const stats = statsOrder.map((steamId) => {
    const c = CLIMBERS[steamId];
    return `{"card_choices":[{"card":{"id":"${c.pick}"},"was_picked":true},{"card":{"id":"CARD.SKIPPED"},"was_picked":false}],"current_gold":${c.gold},"current_hp":${c.hp},"max_hp":80,"player_id":${id(steamId)}}`;
  });
  return `{"acts":["ACT.OVERGROWTH"],"ascension":5,"build_id":"v0.113.0","game_mode":"standard","killed_by_encounter":"NONE.NONE","map_point_history":[[{"map_point_type":"monster","player_stats":[${stats.join(",")}],"rooms":[{"room_type":"monster"}]}]],"platform_type":"steam","players":[${players.join(",")}],"run_time":900,"schema_version":11,"seed":"COOPSEED","start_time":${start},"was_abandoned":false,"win":true}`;
}

/** The save as the app reads it: player ids kept whole. */
const read = (text) => JSON.parse(Owner.keepPlayerIds(text));
/** The save as an older build read it: ids rounded by JSON.parse. */
const readRounded = (text) => JSON.parse(text);

const myPath = `SlayTheSpire2/steam/${ME}/profile1/saves/history/1790000000.run`;

// ---- run-owner ------------------------------------------------------------------

await check("the Steam ID in a save's path is the folder's account", () => {
  assert.equal(Owner.ownerFromPath(myPath), ME);
  assert.equal(Owner.ownerFromPath(`steam/${ME}/modded/profile2/saves/history/1.run`), ME, "the modded save set too");
  assert.equal(Owner.ownerFromPath(`C:\\Users\\ana\\AppData\\Roaming\\SlayTheSpire2\\steam\\${ANA}\\profile1\\saves\\history\\1.run`), ANA);
  assert.equal(Owner.ownerFromPath(`/SlayTheSpire2/steam/${BO}/profile1/saves/history/1.run`), BO, "a dropped folder's full path");
  assert.equal(Owner.ownerFromPath("history/1790000000.run"), "", "picking the history folder itself says nothing");
  assert.equal(Owner.ownerFromPath("1790000000.run"), "");
  assert.equal(Owner.ownerFromPath(`${ME}/profile1/saves/history/1.run`), ME, "the account folder picked by itself");
  assert.equal(Owner.ownerFromPath("steam/7656119800000004/profile1/1.run"), "", "16 digits is not a Steam ID");
  assert.equal(Owner.ownerFromPath("steam/12345678901234567/profile1/1.run"), "", "17 digits that are not a Steam account");
  assert.equal(Owner.ownerFromPath(`history/${ME}.run`), "", "a file's name is not a folder");
  assert.equal(Owner.ownerFromPath(undefined), "");
});

await check("a dropped or picked file keeps its place in the folder, though a File's own path cannot be set", () => {
  // A File's webkitRelativePath is a getter on its prototype: setting it throws in a module.
  class PickedFile { constructor(name) { this.name = name; } get webkitRelativePath() { return ""; } }
  const file = new PickedFile("1790000000.run");
  assert.throws(() => { "use strict"; file.webkitRelativePath = "steam/x"; }, TypeError);
  assert.equal(Owner.pathOf(file), "1790000000.run", "its name until a path is noted");
  Owner.notePath(file, `/SlayTheSpire2/steam/${ME}/profile1/saves/history/1790000000.run`);
  assert.equal(Owner.ownerFromPath(Owner.pathOf(file)), ME);
  assert.equal(Owner.pathOf({ name: "a.run", webkitRelativePath: "history/a.run" }), "history/a.run", "a folder input's own path is used as it is");
  assert.equal(Owner.pathOf(null), "");
});

await check("64-bit player ids keep every digit; nothing else in the save changes", () => {
  const text = saveText([ANA, ME]);
  assert.notEqual(String(readRounded(text).players[1].id), ME, "JSON.parse alone rounds the id");
  const save = read(text);
  assert.deepEqual(save.players.map((p) => p.id), [ANA, ME]);
  assert.deepEqual(save.map_point_history[0][0].player_stats.map((row) => row.player_id), [ANA, ME]);
  assert.equal(save.start_time, 1790000000, "a 10-digit number is left alone");
  assert.equal(save.players[0].deck[0].id, "CARD.BASH");
  const solo = read(saveText([ME], { solo: true }));
  assert.equal(solo.players[0].id, 1, "a solo save's id stays the number 1");
  assert.equal(Owner.keepPlayerIds('{"current_gold":76561198000000043,"id":"CARD.X"}'), '{"current_gold":76561198000000043,"id":"CARD.X"}');
});

await check("two ids are the same player exactly, or as JSON.parse rounded them", () => {
  assert.equal(Owner.sameId(ME, ME), true);
  assert.equal(Owner.sameId(ME, ANA), false);
  assert.equal(Owner.sameId(readRounded(saveText([ME, ANA])).players[0].id, ME), true, "a rounded number against the whole id");
  assert.equal(Owner.sameId(readRounded(saveText([ME, ANA])).players[1].id, ME), false);
  assert.equal(Owner.sameId(1, 1), true);
  assert.equal(Owner.sameId(1, ME), false);
  assert.equal(Owner.sameId("", ""), false);
  assert.equal(Owner.sameId(undefined, ME), false);
});

await check("the vote names the player who is in more co-op saves than anyone", () => {
  const vote = (...saves) => Owner.ownerByVote(saves.map(Owner.coopPlayerIds));
  assert.equal(vote(read(saveText([ANA, ME])), read(saveText([ME, BO])), read(saveText([BO, ANA, ME])), read(saveText([ME], { solo: true }))), ME);
  assert.equal(vote(read(saveText([ANA, ME])), read(saveText([ME, ANA]))), "", "always the same friend: the saves cannot tell");
  assert.equal(vote(read(saveText([ANA, ME]))), "", "one co-op save is not a vote");
  assert.equal(vote(read(saveText([ME], { solo: true }))), "", "solo saves say nothing");
  assert.equal(Owner.ownerByVote([]), "");
  assert.equal(Owner.ownerByVote([[], [ME, ANA], [ME, BO]]), ME, "it takes each save's player ids, not the saves");
});

await check("hints come most trusted first: path, the folder read, signed in, the vote", () => {
  assert.deepEqual(Owner.ownerHints({ path: myPath, given: ANA, signedIn: BO, voted: ANA }), [ME, ANA, BO]);
  assert.deepEqual(Owner.ownerHints({ path: "history/1.run", signedIn: ME }), [ME]);
  assert.deepEqual(Owner.ownerHints({}), []);
});

// ---- the reader -----------------------------------------------------------------

/** What a record says about whose run it is. */
const side = (run) => ({
  character: run.character,
  deck: run.deckAtEnd,
  relics: run.relics,
  picked: run.cardPicks.map((pick) => pick.picked),
  hp: run.currentHp,
  gold: run.currentGold,
});
const MINE = { character: "silent", deck: ["neutralize", "survivor"], relics: ["ring_of_the_snake"], picked: ["blade_dance"], hp: 41, gold: 210 };
const ANAS = { character: "ironclad", deck: ["bash"], relics: ["burning_blood"], picked: ["inflame"], hp: 70, gold: 99 };

await check("a friend hosted: the record is still the local player's", () => {
  const run = parseSTS2Run(read(saveText([ANA, ME])), "x.run", { ownerIds: [ME] });
  assert.deepEqual(side(run), MINE);
  assert.equal(run.seat, 1, "second in the save's list");
  assert.deepEqual(run.party, ["ironclad", "silent"], "the party stays in the save's order");
  assert.equal(run.partySize, 2);
  assert.equal(run.id, "sts2-1790000000", "the run's id does not depend on whose side it is");
});

await check("the local player's card picks are found by id, wherever their row is", () => {
  const run = parseSTS2Run(read(saveText([ANA, BO, ME], { statsOrder: [ME, ANA, BO] })), "x.run", { ownerIds: [ME] });
  assert.deepEqual(side(run), MINE);
  assert.equal(run.seat, 2);
  assert.deepEqual(run.party, ["ironclad", "defect", "silent"]);
});

await check("ids rounded by an older read still find the local player", () => {
  const run = parseSTS2Run(readRounded(saveText([ANA, ME])), "x.run", { ownerIds: [ME] });
  assert.deepEqual(side(run), MINE);
  assert.equal(run.seat, 1);
});

await check("the first hint that names a player in the run decides", () => {
  const save = read(saveText([ANA, ME]));
  assert.deepEqual(side(parseSTS2Run(save, "x.run", { ownerIds: [BO, ME, ANA] })), MINE, "BO was not in this run");
  assert.deepEqual(side(parseSTS2Run(save, "x.run", { ownerIds: [ANA, ME] })), ANAS, "the folder's account outranks the signed-in one");
});

await check("with nothing to tell the players apart it is the first one, and the record says so", () => {
  for (const context of [undefined, {}, { ownerIds: [] }, { ownerIds: [BO] }, { ownerIds: [""] }]) {
    const run = parseSTS2Run(read(saveText([ANA, ME])), "x.run", context);
    assert.deepEqual(side(run), ANAS);
    assert.equal("seat" in run, false, "no seat: the app knows this may be a teammate's side");
  }
});

await check("a solo run reads as it always did", () => {
  const run = parseSTS2Run(read(saveText([ME], { solo: true })), "x.run", { ownerIds: [ANA] });
  assert.deepEqual(side(run), MINE);
  assert.equal("seat" in run, false, "no new field on a solo record");
  assert.deepEqual(run.party, ["silent"]);
  assert.equal(run.partySize, 1);
  // The same record whatever the caller knows, and with ids read either way.
  const strip = ({ parsedAt, ...rest }) => rest;
  assert.deepEqual(strip(run), strip(parseSTS2Run(readRounded(saveText([ME], { solo: true })), "x.run")));
});

await check("a floor that holds only a teammate's row is not taken for the local player's", () => {
  const raw = read(saveText([ANA, ME]));
  const point = raw.map_point_history[0][0];
  const theirs = point.player_stats.filter((row) => row.player_id === ANA);
  assert.equal(theirs.length, 1);
  point.player_stats = theirs;
  const run = parseSTS2Run(raw, "x.run", { ownerIds: [ME] });
  assert.equal(run.character, "silent");
  assert.deepEqual(run.cardPicks.map((pick) => pick.picked), [], "the teammate's pick is not ours");
  // Rows that carry no ids are still read by their place in the player list.
  const unnamed = read(saveText([ANA, ME]));
  for (const row of unnamed.map_point_history[0][0].player_stats) delete row.player_id;
  assert.deepEqual(parseSTS2Run(unnamed, "x.run", { ownerIds: [ME] }).cardPicks.map((pick) => pick.picked), MINE.picked);
});

await check("the app's entry point passes the hints through", async () => {
  const result = await Stats.extractRuns(read(saveText([ANA, ME])), { ownerIds: Owner.ownerHints({ path: myPath }) });
  assert.equal(result.ok, true);
  assert.deepEqual(side(result.runs[0]), MINE);
  const blind = await Stats.extractRuns(read(saveText([ANA, ME])));
  assert.deepEqual(side(blind.runs[0]), ANAS);
});

// ---- the Steam copy -------------------------------------------------------------

const mine = () => parseSTS2Run(read(saveText([ANA, ME])), "x.run", { ownerIds: [ME] });
const teammates = () => parseSTS2Run(read(saveText([ANA, ME])), "x.run");
const soloRun = () => parseSTS2Run(read(saveText([ME], { solo: true })), "x.run");
const throughCopy = (run) => Wire.fromWire(JSON.parse(JSON.stringify(Wire.toWire(run))));

await check("a corrected record keeps its side through the Steam copy", () => {
  assert.equal(Wire.toWire(mine()).seat, 1);
  assert.equal(throughCopy(mine()).seat, 1);
  assert.equal(throughCopy(mine()).character, "silent");
  assert.equal("seat" in Wire.toWire(teammates()) && Wire.toWire(teammates()).seat !== undefined, false, "an unknown side sends none");
  assert.equal(Wire.toWire(soloRun()).seat, undefined, "a solo run has no side to send");
  assert.equal("seat" in Wire.fromWire({ ...Wire.toWire(mine()), seat: 7 }), false, "a seat outside the party is dropped");
  assert.equal("seat" in Wire.fromWire({ ...Wire.toWire(mine()), seat: "1" }), false);
});

await check("a record knows whether it says whose side it tells", () => {
  assert.equal(Wire.hasSeat(mine()), true);
  assert.equal(Wire.hasSeat(teammates()), false);
  assert.equal(Wire.hasSeat(soloRun()), true, "a solo run always does");
  assert.equal(Wire.hasSeat({ id: "old" }), true, "a record older than party sizes is not known to be co-op");
});

await check("a device keeps the corrected record, whichever side holds it", () => {
  // A phone holding the old record gets the corrected one from the copy.
  assert.equal(Wire.cloudCopyWins(throughCopy(teammates()), throughCopy(mine())), true);
  assert.equal(Wire.bestOf(throughCopy(teammates()), throughCopy(mine())).character, "silent");
  // A computer that just read the saves keeps its own over the copy's old one.
  assert.equal(Wire.cloudCopyWins(mine(), throughCopy(teammates())), false);
  assert.equal(Wire.bestOf(mine(), throughCopy(teammates())).character, "silent");
  // Both corrected: nothing changes.
  assert.equal(Wire.bestOf(mine(), throughCopy(mine())).character, "silent");
  // Other readers stamp the same run's end differently: the corrected record still stays.
  const later = (run) => ({ ...run, endedAt: new Date(new Date(run.endedAt).getTime() + 60_000) });
  assert.equal(Wire.cloudCopyWins(mine(), later(throughCopy(teammates()))), false);
  assert.equal(Wire.cloudCopyWins(later(throughCopy(teammates())), throughCopy(mine())), true);
  // Between two records that both know, the later ending wins as before.
  assert.equal(Wire.cloudCopyWins(mine(), later(throughCopy(mine()))), true);
});

await check("card picks never cross from a teammate's record to the local player's", () => {
  const minePicksLost = { ...throughCopy(mine()), cardPicks: [] };
  assert.deepEqual(Wire.bestOf(teammates(), minePicksLost).cardPicks, [], "the other record tells the first player's side");
  assert.equal(Wire.bestOf(teammates(), minePicksLost).character, "silent");
  // Two records of the same side still fill each other in.
  const host = () => parseSTS2Run(read(saveText([ME, ANA])), "x.run", { ownerIds: [ME] });
  const hostOld = () => parseSTS2Run(read(saveText([ME, ANA])), "x.run");
  assert.deepEqual(Wire.bestOf(hostOld(), { ...throughCopy(host()), cardPicks: [] }).cardPicks.map((pick) => pick.picked), MINE.picked);
});

await check("corrected co-op runs go up to a copy that holds the old record, once", () => {
  const copyOld = Wire.indexOfCopy([Wire.toWire(teammates()), Wire.toWire(soloRun())].map((run, i) => ({ ...run, id: i === 0 ? "sts2-1790000000" : "solo" })));
  const solo = { ...soloRun(), id: "solo" };
  assert.deepEqual(Wire.runsToSend([mine(), solo], copyOld).map((run) => run.id), ["sts2-1790000000"]);
  assert.equal(Wire.hasDetailCopyLacks([mine()], [throughCopy(teammates())]), true);
  const copyNew = Wire.indexAfterSend(copyOld, [mine()]);
  assert.deepEqual(Wire.runsToSend([mine(), solo], copyNew), [], "nothing is sent twice");
  assert.equal(Wire.hasDetailCopyLacks([mine()], [throughCopy(mine())]), false);
  // A browser that cannot tell the players apart never overwrites the corrected copy.
  assert.deepEqual(Wire.runsToSend([teammates()], Wire.indexOfCopy([Wire.toWire(mine())])), []);
});

if (process.exitCode) {
  console.error("verify-run-owner: FAILED");
} else {
  console.log(`✓ co-op runs show the local player: all ${passed} checks passed`);
}
