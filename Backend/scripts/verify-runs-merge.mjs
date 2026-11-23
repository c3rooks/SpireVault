#!/usr/bin/env node
/**
 * Offline checks for the Steam copy of a player's runs (src/runs.ts).
 *
 * No network and no deployed Worker: uploadRuns and getRuns run against an
 * in-memory stand-in for the KV namespace. Bundled with esbuild first, like
 * verify-offline.mjs, because the Worker sources use extensionless imports.
 *
 *   · what one stored run keeps: card picks, the abandoned flag, mode,
 *     modifiers, party and the rooms walked
 *   · an upload that lacks those never erases them. Web builds before
 *     2026-11-18 send no card picks at all and stay cached in browsers for a
 *     while, so without this one stale tab would empty every other device's
 *     Cards tab again.
 *   · GET /runs hands back the stored text untouched, and one player's copy
 *     can never outgrow what KV stores
 *
 * Run: node scripts/verify-runs-merge.mjs   (part of `npm run preflight`)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const workDir = mkdtempSync(join(tmpdir(), "vault-runs-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

const entry = join(workDir, "entry.ts");
writeFileSync(entry, `export * from ${JSON.stringify(join(SRC, "runs"))};\n`);
const bundle = join(workDir, "bundle.mjs");
execFileSync(
  "npx",
  ["esbuild", entry, "--bundle", "--format=esm", "--platform=neutral", `--outfile=${bundle}`, "--log-level=error"],
  { stdio: "inherit" },
);
const Runs = await import(pathToFileURL(bundle).href);

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

const STEAM_ID = "76561197960287930";

/** A KV namespace that lives in a Map. */
function fakeEnv() {
  const store = new Map();
  return {
    LOBBIES: {
      get: async (key) => store.get(key) ?? null,
      put: async (key, value) => { store.set(key, value); },
      delete: async (key) => { store.delete(key); },
    },
  };
}

const ENDED = "2026-11-18T16:36:19.000Z";

/** A run as web builds since 2026-11-18 send it. */
const fullRun = (extra = {}) => ({
  id: "run-1",
  character: "ironclad",
  ascension: 7,
  floorReached: 9,
  won: false,
  playTimeSeconds: 1800,
  endedAt: ENDED,
  relics: ["burning_blood"],
  deckAtEnd: ["strike", "inflame"],
  picks: "1:inflame|clothesline,anger;3:|shrug_it_off,cleave,uppercut",
  gameMode: "daily",
  wasAbandoned: true,
  modifiers: ["double_time", "flight"],
  path: ["cvcsrb", "cet"],
  partySize: 2,
  party: ["ironclad", "silent"],
  ...extra,
});

/** The same run as older web builds send it: totals only. */
const thinRun = (extra = {}) => {
  const { picks, gameMode, wasAbandoned, modifiers, path, partySize, party, ...basics } = fullRun();
  return { ...basics, ...extra };
};

async function stored(env) {
  const blob = await Runs.getRuns(env, STEAM_ID);
  return blob.runs;
}

const PICKS = "1:inflame|clothesline,anger;3:|shrug_it_off,cleave,uppercut";

await check("a stored run keeps what the tabs show", async () => {
  const env = fakeEnv();
  const res = await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  assert.equal(res.ok, true);
  const [run] = await stored(env);
  assert.equal(run.picks, PICKS);
  assert.equal(run.wasAbandoned, true);
  assert.equal(run.gameMode, "daily");
  assert.deepEqual(run.modifiers, ["double_time", "flight"]);
  assert.deepEqual(run.path, ["cvcsrb", "cet"]);
  assert.equal(run.partySize, 2);
  assert.deepEqual(run.party, ["ironclad", "silent"]);
});

await check("an older build's upload does not erase card picks", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun()] }, "web");
  const [run] = await stored(env);
  assert.equal(run.picks, PICKS, "card picks are still there");
  assert.equal(run.wasAbandoned, true);
  assert.equal(run.gameMode, "daily");
  assert.deepEqual(run.modifiers, ["double_time", "flight"]);
  assert.deepEqual(run.path, ["cvcsrb", "cet"]);
  assert.deepEqual(run.party, ["ironclad", "silent"]);
});

await check("a Custom Run stays marked, even after an older build's upload", async () => {
  // Custom runs stay out of win streaks; a phone that reads only this copy
  // needs the mark to leave them out too.
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ isCustom: true })] }, "web");
  assert.equal((await stored(env))[0].isCustom, true);
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun({ endedAt: "2026-11-18T17:00:00.000Z" })] }, "web");
  assert.equal((await stored(env))[0].isCustom, true, "the later, thinner record keeps the mark");
});

await check("only a real true marks a run as custom", async () => {
  const env = fakeEnv();
  for (const isCustom of ["yes", 1, "true", false, null]) {
    await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ id: `custom-${String(isCustom)}`, isCustom })] }, "web");
  }
  assert.ok((await stored(env)).every((run) => run.isCustom === undefined));
});

await check("the same upload still refreshes the basics", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun({ floorReached: 12 })] }, "web");
  const [run] = await stored(env);
  assert.equal(run.floorReached, 12);
  assert.equal(run.picks, PICKS);
});

await check("a full upload fills a thin copy", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun()] }, "web");
  assert.equal((await stored(env))[0].picks, undefined);
  const res = await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  assert.equal(res.result.added, 0, "the same run, not a new one");
  const [run] = await stored(env);
  assert.equal(run.picks, PICKS);
  assert.deepEqual(run.path, ["cvcsrb", "cet"]);
});

await check("a later record without card picks keeps the stored ones", async () => {
  // A run with no end time is stamped with the upload time, so an older
  // build's thin upload of it always looks later than what is stored.
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun({ endedAt: "2026-11-18T17:00:00.000Z", floorReached: 14 })] }, "web");
  const [run] = await stored(env);
  assert.equal(run.endedAt, "2026-11-18T17:00:00.000Z", "the later record stays");
  assert.equal(run.floorReached, 14);
  assert.equal(run.picks, PICKS, "…with the card picks already stored");
  assert.equal(run.wasAbandoned, true);
});

await check("a later record with its own card picks replaces them", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ endedAt: "2026-11-18T17:00:00.000Z", picks: "1:anger|cleave" })] }, "web");
  const [run] = await stored(env);
  assert.equal(run.picks, "1:anger|cleave");
});

await check("an older record never replaces a newer one, but fills what it lacks", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun({ endedAt: "2026-11-18T17:00:00.000Z", floorReached: 14 })] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun()] }, "web");
  const [run] = await stored(env);
  assert.equal(run.endedAt, "2026-11-18T17:00:00.000Z");
  assert.equal(run.floorReached, 14, "the newer record's numbers");
  assert.equal(run.picks, PICKS, "…and the card picks only the older upload had");
});

await check("card picks in the older object form are still stored and kept", async () => {
  const env = fakeEnv();
  const choices = [{ floor: 1, picked: "inflame", skipped: ["anger"] }];
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun({ cardChoices: choices })] }, "ios");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun()] }, "web");
  const [run] = await stored(env);
  assert.deepEqual(run.cardChoices, choices);
});

await check("a 30-card offer is kept whole", async () => {
  const env = fakeEnv();
  const offer = `4:offering|${Array.from({ length: 29 }, (_, i) => `card_${i}`).join(",")}`;
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ picks: offer })] }, "web");
  const [run] = await stored(env);
  assert.equal(run.picks, offer);
});

await check("limits hold against a pathological upload", async () => {
  const env = fakeEnv();
  const screen = `1:x|${Array.from({ length: 40 }, () => "y".repeat(20)).join(",")}`;
  await Runs.uploadRuns(env, STEAM_ID, {
    runs: [fullRun({
      picks: Array.from({ length: 30 }, () => screen).join(";"),
      modifiers: Array.from({ length: 100 }, () => "m".repeat(500)),
      path: Array.from({ length: 100 }, () => "c".repeat(500)),
      party: Array.from({ length: 100 }, () => "silent"),
      partySize: 1e9,
    })],
  }, "web");
  const [run] = await stored(env);
  assert.ok(run.picks.length <= 8000, `picks is ${run.picks.length} characters`);
  assert.ok(run.picks.split(";").every((part) => part === screen), "cut at a whole reward screen, never mid-card");
  assert.equal(run.modifiers.length, 16);
  assert.equal(run.path.length, 12);
  assert.equal(run.path[0].length, 80);
  assert.equal(run.party.length, 8);
  assert.equal(run.partySize, 8);
});

await check("junk in the new fields is dropped, not stored", async () => {
  const env = fakeEnv();
  for (const picks of ['1:<script>|x', "1:a b|c", 42, ["1:a|b"], "x".repeat(40_000), ""]) {
    await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun({ id: `junk-${String(picks).length}`, picks })] }, "web");
  }
  assert.ok((await stored(env)).every((run) => run.picks === undefined), "a picks string with anything but card ids and separators is not stored");
  await Runs.uploadRuns(env, STEAM_ID, {
    runs: [fullRun({ wasAbandoned: "yes", modifiers: "double_time", path: ["c<script>", 7, "ce"], party: "silent", partySize: "two", gameMode: 5 })],
  }, "web");
  const run = (await stored(env)).find((r) => r.id === "run-1");
  assert.equal(run.wasAbandoned, undefined);
  assert.equal(run.modifiers, undefined);
  assert.equal(run.path, undefined, "one bad act drops the whole path rather than shifting floors");
  assert.equal(run.party, undefined);
  assert.equal(run.partySize, undefined);
  assert.equal(run.gameMode, undefined);
});

await check("a thin run stores no empty extras", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [thinRun()] }, "web");
  const [run] = await stored(env);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(run))).sort(),
    ["ascension", "cardChoices", "character", "deckAtEnd", "endedAt", "floorReached", "id", "playTimeSeconds", "relics", "won"]);
});

// ---- reading the copy back ----------------------------------------------------------

// ---- whose side of a co-op run a record tells ------------------------------------
// Until 2026-11-22 the web reader took the first player in a co-op save, so a
// player who joined a friend's game had the friend's climber, deck and card
// picks on record. Records from a reader that knew the local player carry
// `seat`; the copy must take those, and never trade one back for a record
// that does not say.

await check("a co-op record keeps whose side it tells; a solo one has none", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [
    fullRun({ id: "coop", seat: 1 }),
    fullRun({ id: "solo", partySize: 1, party: undefined, seat: 0 }),
    fullRun({ id: "outside", seat: 5 }),
    fullRun({ id: "junk", seat: "1" }),
    fullRun({ id: "half", seat: 0.5 }),
  ] }, "web");
  const byId = new Map((await stored(env)).map((run) => [run.id, run]));
  assert.equal(byId.get("coop").seat, 1);
  assert.equal("seat" in byId.get("solo"), false, "a solo run has no side to tell");
  assert.equal("seat" in byId.get("outside"), false, "a seat outside the party is dropped");
  assert.equal("seat" in byId.get("junk"), false);
  assert.equal("seat" in byId.get("half"), false);
});

await check("a corrected co-op record replaces the one that showed a teammate", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "ironclad", deckAtEnd: ["bash"] })] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "silent", deckAtEnd: ["neutralize"], seat: 1 })] }, "web");
  const [run] = await stored(env);
  assert.equal(run.character, "silent");
  assert.deepEqual(run.deckAtEnd, ["neutralize"]);
  assert.equal(run.seat, 1);
});

await check("an older build's record never replaces a corrected one", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "silent", deckAtEnd: ["neutralize"], seat: 1 })] }, "web");
  // Same run, same end time, from a tab still running the old reader.
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "ironclad", deckAtEnd: ["bash"] })] }, "web");
  const [run] = await stored(env);
  assert.equal(run.character, "silent", "the copy keeps the local player's side");
  assert.deepEqual(run.deckAtEnd, ["neutralize"]);
  assert.equal(run.seat, 1);
});

await check("end times do not decide between a record that knows the player and one that does not", async () => {
  // Other readers stamp the same run's end differently, and a run sent with
  // no end time is stamped with the upload time, which always looks later.
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "silent", seat: 1 })] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "ironclad", endedAt: "2026-11-18T17:00:00.000Z" })] }, "macos");
  assert.equal((await stored(env))[0].character, "silent", "a later record that does not say stays out");

  const other = fakeEnv();
  await Runs.uploadRuns(other, STEAM_ID, { runs: [fullRun({ character: "ironclad", endedAt: "2026-11-18T17:00:00.000Z" })] }, "macos");
  await Runs.uploadRuns(other, STEAM_ID, { runs: [fullRun({ character: "silent", seat: 1 })] }, "web");
  const [run] = await stored(other);
  assert.equal(run.character, "silent", "an earlier record that knows the player still goes in");
  assert.equal(run.seat, 1);
});

await check("between two records that both know the player, the later ending wins as before", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "silent", seat: 1, deckAtEnd: ["neutralize"] })] }, "web");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "silent", seat: 1, deckAtEnd: ["neutralize", "backflip"], endedAt: "2026-11-18T17:00:00.000Z" })] }, "web");
  assert.deepEqual((await stored(env))[0].deckAtEnd, ["neutralize", "backflip"]);
});

await check("card picks do not cross from a teammate's record to the local player's", async () => {
  const env = fakeEnv();
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun({ character: "ironclad" })] }, "web");
  const { picks, cardChoices, ...noPicks } = fullRun({ character: "silent", seat: 1 });
  await Runs.uploadRuns(env, STEAM_ID, { runs: [noPicks] }, "web");
  const [run] = await stored(env);
  assert.equal(run.character, "silent");
  assert.equal(run.picks, undefined, "the first player's picks are not kept under the second player");
  assert.equal((run.cardChoices ?? []).length, 0);
});

await check("GET hands back exactly what is stored", async () => {
  const env = fakeEnv();
  assert.deepEqual(JSON.parse(await Runs.getRunsText(env, STEAM_ID)), { runs: [], updatedAt: new Date(0).toISOString(), count: 0 }, "no copy yet: an empty list, not an error");
  await Runs.uploadRuns(env, STEAM_ID, { runs: [fullRun(), fullRun({ id: "run-2", endedAt: "2026-11-17T10:00:00.000Z" })] }, "web");
  const text = await Runs.getRunsText(env, STEAM_ID);
  assert.equal(text, await env.LOBBIES.get(`runs:${STEAM_ID}`), "the stored text, byte for byte");
  const body = JSON.parse(text);
  assert.equal(body.count, 2);
  assert.deepEqual(body.runs.map((r) => r.id), ["run-1", "run-2"], "newest first");
  assert.equal(body.source, "web");
});

await check("a damaged stored value reads as an empty copy", async () => {
  const env = fakeEnv();
  for (const damaged of ["not json", '{"runs":"nope"}', "[1,2,3]", '{"runs":[{"id":"x"'] ) {
    await env.LOBBIES.put(`runs:${STEAM_ID}`, damaged);
    const body = JSON.parse(await Runs.getRunsText(env, STEAM_ID));
    assert.ok(Array.isArray(body.runs), `"${damaged.slice(0, 20)}" still answers with a runs list`);
  }
});

await check("one player's copy cannot outgrow what KV stores", async () => {
  const env = fakeEnv();
  // 1,500 runs, each as large as the limits allow a deck and picks to be.
  const deck = Array.from({ length: 256 }, (_, i) => `c${i}`.padEnd(64, "x"));
  const picks = Array.from({ length: 60 }, (_, i) => `${i}:picked_card_name|${Array.from({ length: 6 }, (_, j) => `skipped_card_${j}`).join(",")}`).join(";");
  const runs = Array.from({ length: 1500 }, (_, i) => fullRun({ id: `big-${i}`, endedAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(), deckAtEnd: deck, picks }));
  const res = await Runs.uploadRuns(env, STEAM_ID, { runs }, "web");
  const text = await env.LOBBIES.get(`runs:${STEAM_ID}`);
  assert.ok(text.length <= 8_000_000, `stored copy is ${text.length} characters`);
  const body = JSON.parse(text);
  assert.equal(res.result.truncated, true);
  assert.equal(res.result.count, body.runs.length);
  assert.equal(body.count, body.runs.length);
  assert.equal(body.runs[0].id, "big-1499", "the newest runs are the ones kept");
  assert.ok(body.runs.length > 100, `kept ${body.runs.length} runs`);
});

if (process.exitCode) {
  console.error("verify-runs-merge: FAILED");
} else {
  console.log(`✓ Steam copy merge: all ${passed} checks passed`);
}
