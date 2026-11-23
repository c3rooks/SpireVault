#!/usr/bin/env node
/**
 * Offline checks for lib/stat-filters.js, the filters behind:
 *
 *   · Overview → By character   mode (All / Standard / Blitz / Dread) and ascension
 *   · Ascensions                one climber, Standard or Blitz ladder
 *   · the win streak on each character's card, which leaves out Custom Runs
 *     and daily runs (the game's own per-character streaks do the same)
 *   · Solo / Co-op on By character, Ascensions and Runs
 *   · each climber's record at one ascension level (an open breakdown row)
 *
 * Blitz has its own ascension ladder and Dread gives `ascension` no ladder
 * meaning, so an ascension level only ever selects runs of one ladder.
 *
 * Run: node Web/scripts/verify-stat-filters.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const F = await import(pathToFileURL(join(WEB, "lib", "stat-filters.js")).href);
const Stats = await import(pathToFileURL(join(WEB, "lib", "stats-engine.js")).href);

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

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
let seq = 0;
/** A normalized run, `day` days after T0 (bigger = newer). */
function run(character, won, ascension, day, gameMode) {
  seq += 1;
  return {
    id: `r${seq}`,
    character,
    won,
    ascension,
    endedAt: new Date(T0 + day * DAY),
    startedAt: new Date(T0 + day * DAY - 3_600_000),
    ...(gameMode ? { gameMode } : {}),
    relics: [],
    deckAtEnd: [],
    cardPicks: [],
  };
}

// Ironclad: an old loss, then 4 wins in a row (newest). Silent: newest is a loss.
// Blitz and Dread runs mixed in by date.
const RUNS = Object.freeze([
  run("ironclad", false, 10, 1),
  run("ironclad", true, 10, 2),
  run("ironclad", true, 9, 3),
  run("ironclad", true, 2, 4, "blitz"),
  run("ironclad", true, 10, 5),
  run("silent", true, 5, 2),
  run("silent", false, 5, 6),
  run("silent", true, 1, 3, "blitz"),
  run("silent", false, 3, 4, "blitz"),
  run("defect", false, 10, 5, "dread"),
  run("defect", true, 0, 1),
  run("regent", true, null, 2),
]);

// ---- modes -------------------------------------------------------------------------

await check("runMode tells standard, Blitz and Dread apart", () => {
  assert.equal(F.runMode(run("ironclad", true, 1, 0)), "standard");
  assert.equal(F.runMode(run("ironclad", true, 1, 0, "blitz")), "blitz");
  assert.equal(F.runMode(run("ironclad", true, 1, 0, "dread")), "dread");
  assert.equal(F.runMode(run("ironclad", true, 1, 0, "daily")), "standard", "a daily run is on the standard ladder");
  assert.equal(F.runMode(null), "standard");
});

await check("modeCounts counts each mode once", () => {
  assert.deepEqual(F.modeCounts(RUNS), { standard: 8, blitz: 3, dread: 1 });
  assert.deepEqual(F.modeCounts([]), { standard: 0, blitz: 0, dread: 0 });
});

await check("ladderOf: All and Standard share the standard ladder, Dread has none", () => {
  assert.equal(F.ladderOf("all"), "standard");
  assert.equal(F.ladderOf("standard"), "standard");
  assert.equal(F.ladderOf("blitz"), "blitz");
  assert.equal(F.ladderOf("dread"), null);
  assert.equal(F.ladderOf("nonsense"), "standard");
});

await check("modeChoices lists the modes a control should offer, or null for standard-only histories", () => {
  assert.deepEqual(F.modeChoices(RUNS), ["all", "standard", "blitz", "dread"]);
  assert.deepEqual(F.modeChoices(F.filterRuns(RUNS, { mode: "standard" }).concat(F.filterRuns(RUNS, { mode: "blitz" }))), ["all", "standard", "blitz"]);
  assert.equal(F.modeChoices(F.filterRuns(RUNS, { mode: "standard" })), null);
  assert.equal(F.modeChoices([]), null);
});

await check("availableMode falls back to All for a mode the runs cannot show", () => {
  assert.equal(F.availableMode("blitz", RUNS), "blitz");
  assert.equal(F.availableMode("standard", RUNS), "standard");
  assert.equal(F.availableMode("dread", F.filterRuns(RUNS, { mode: "blitz" }).concat(F.filterRuns(RUNS, { mode: "standard" }))), "all");
  assert.equal(F.availableMode("standard", F.filterRuns(RUNS, { mode: "standard" })), "all", "no control is shown, so no mode applies");
  assert.equal(F.availableMode("nonsense", RUNS), "all");
});

// ---- filtering ---------------------------------------------------------------------

await check("filterRuns with no filter returns every run", () => {
  assert.equal(F.filterRuns(RUNS).length, RUNS.length);
  assert.equal(F.filterRuns(RUNS, { mode: "all", asc: null, character: "all" }).length, RUNS.length);
});

await check("filterRuns by mode", () => {
  assert.equal(F.filterRuns(RUNS, { mode: "standard" }).length, 8);
  assert.equal(F.filterRuns(RUNS, { mode: "blitz" }).length, 3);
  assert.equal(F.filterRuns(RUNS, { mode: "dread" }).length, 1);
});

await check("an ascension level only selects runs of its mode's ladder", () => {
  // All + A10: standard A10 runs only, never the Dread run recorded at 10.
  const allA10 = F.filterRuns(RUNS, { mode: "all", asc: 10 });
  assert.deepEqual(allA10.map((r) => r.id).sort(), ["r1", "r2", "r5"].sort());
  // Blitz + A2: only the Blitz run at 2, not a standard A2.
  assert.deepEqual(F.filterRuns(RUNS, { mode: "blitz", asc: 2 }).map((r) => r.id), ["r4"]);
  // Dread ignores an ascension level.
  assert.equal(F.filterRuns(RUNS, { mode: "dread", asc: 10 }).length, 1);
});

await check("filterRuns by character, combined with a ladder", () => {
  assert.equal(F.filterRuns(RUNS, { character: "silent" }).length, 4);
  assert.equal(F.filterRuns(RUNS, { character: "silent", mode: "blitz" }).length, 2);
  assert.equal(F.filterRuns(RUNS, { character: "nobody" }).length, 0);
});

await check("filterRuns never mutates its input", () => {
  const copy = RUNS.map((r) => ({ ...r }));
  F.filterRuns(RUNS, { mode: "blitz", asc: 2, character: "ironclad" });
  assert.deepEqual(RUNS.map((r) => r.id), copy.map((r) => r.id));
});

// ---- ascension buckets -------------------------------------------------------------

await check("standard ascension buckets match Stats.summarize().byAscension", () => {
  const ours = F.ascensionBuckets(RUNS, "standard").map(({ key, runs, wins }) => ({ key, runs, wins }));
  const theirs = Stats.summarize(RUNS).byAscension.map(({ key, runs, wins }) => ({ key, runs, wins }));
  assert.deepEqual(ours, theirs);
});

await check("Blitz ascension buckets count Blitz runs only, lowest level first", () => {
  const blitz = F.ascensionBuckets(RUNS, "blitz");
  assert.deepEqual(blitz.map((b) => [b.level, b.runs, b.wins]), [[1, 1, 1], [2, 1, 1], [3, 1, 0]]);
  assert.equal(blitz[0].key, "A1");
  assert.equal(blitz[0].winrate, 1);
});

await check("ascensionLevels lists the mode's levels with runs, highest first", () => {
  assert.deepEqual(F.ascensionLevels(RUNS, "all").map((l) => [l.level, l.runs]), [[10, 3], [9, 1], [5, 2], [0, 1]]);
  assert.deepEqual(F.ascensionLevels(RUNS, "blitz").map((l) => l.level), [3, 2, 1]);
  assert.deepEqual(F.ascensionLevels(RUNS, "dread"), []);
});

// ---- streaks -----------------------------------------------------------------------

await check("currentWinStreak counts wins back from the newest run", () => {
  assert.equal(F.currentWinStreak(F.filterRuns(RUNS, { character: "ironclad" })), 4);
  assert.equal(F.currentWinStreak(F.filterRuns(RUNS, { character: "silent" })), 0, "newest Silent run is a loss");
  assert.equal(F.currentWinStreak([]), 0);
  // Input order does not matter: the newest run decides.
  const shuffled = F.filterRuns(RUNS, { character: "ironclad" }).slice().reverse();
  assert.equal(F.currentWinStreak(shuffled), 4);
});

await check("a streak inside a filter counts that filter's runs only", () => {
  // Standard Ironclad: r5 (win) r3 (win) r2 (win) r1 (loss) → 3; the Blitz win is not on this ladder.
  assert.equal(F.currentWinStreak(F.filterRuns(RUNS, { character: "ironclad", mode: "standard" })), 3);
});

await check("winStreaksByCharacter keys every character with runs", () => {
  const streaks = F.winStreaksByCharacter(RUNS);
  assert.equal(streaks.get("ironclad"), 4);
  assert.equal(streaks.get("silent"), 0);
  assert.equal(streaks.get("defect"), 0);
  assert.equal(streaks.get("regent"), 1);
  assert.equal(streaks.has("necrobinder"), false);
});

// ---- saved filters -----------------------------------------------------------------

await check("sanitizeCharacterFilter keeps a valid saved filter", () => {
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 2 }, RUNS), { mode: "blitz", asc: 2, party: "all" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 10 }, RUNS), { mode: "all", asc: 10, party: "all" });
});

await check("sanitizeCharacterFilter drops what the data cannot show", () => {
  assert.deepEqual(F.sanitizeCharacterFilter(undefined, RUNS), { mode: "all", asc: null, party: "all" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "bogus", asc: "x" }, RUNS), { mode: "all", asc: null, party: "all" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 10 }, RUNS), { mode: "blitz", asc: null, party: "all" }, "no Blitz A10 runs");
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "dread", asc: 10 }, RUNS), { mode: "dread", asc: null, party: "all" }, "Dread has no levels");
  const standardOnly = F.filterRuns(RUNS, { mode: "standard" });
  // With no Blitz or Dread runs the mode control is hidden, so no mode may stay selected.
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "standard", asc: 9 }, standardOnly), { mode: "all", asc: 9, party: "all" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 2 }, standardOnly), { mode: "all", asc: null, party: "all" });
});

await check("a level whose ladder goes away is dropped, even when the other ladder has that level", () => {
  // Saved as Blitz A2; now only standard runs are loaded, and they include A2.
  const withStandardA2 = [...F.filterRuns(RUNS, { mode: "standard" }), run("silent", true, 2, 7)];
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 2 }, withStandardA2), { mode: "all", asc: null, party: "all" });
  // Blitz runs but no Dread: Dread falls back to All, which has no level to keep.
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "dread", asc: 2 }, F.filterRuns(RUNS, { mode: "blitz" }).concat(withStandardA2)), { mode: "all", asc: null, party: "all" });
});

await check("pressing a mode keeps the level only while the ladder stays the same", () => {
  assert.deepEqual(F.withMode({ mode: "blitz", asc: 2, party: "all" }, "standard"), { mode: "standard", asc: null, party: "all" }, "Blitz A2 never becomes standard A2");
  assert.deepEqual(F.withMode({ mode: "standard", asc: 2, party: "all" }, "blitz"), { mode: "blitz", asc: null, party: "all" });
  assert.deepEqual(F.withMode({ mode: "standard", asc: 7, party: "all" }, "all"), { mode: "all", asc: 7, party: "all" }, "All and Standard share a ladder");
  assert.deepEqual(F.withMode({ mode: "all", asc: 7, party: "coop" }, "dread"), { mode: "dread", asc: null, party: "coop" }, "the party stays");
});

await check("sanitizeSpireFilter keeps the ladder and climber only when they have runs", () => {
  assert.deepEqual(F.sanitizeSpireFilter({ character: "silent", ladder: "blitz" }, RUNS), { character: "silent", ladder: "blitz", party: "all" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "defect", ladder: "blitz" }, RUNS), { character: "all", ladder: "blitz", party: "all" }, "Defect has no Blitz runs");
  assert.deepEqual(F.sanitizeSpireFilter({ character: "ironclad", ladder: "dread" }, RUNS), { character: "ironclad", ladder: "standard", party: "all" });
  const standardOnly = F.filterRuns(RUNS, { mode: "standard" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "all", ladder: "blitz" }, standardOnly), { character: "all", ladder: "standard", party: "all" });
  assert.deepEqual(F.sanitizeSpireFilter(null, RUNS), { character: "all", ladder: "standard", party: "all" });
});

await check("filter labels read the way the summary line shows them", () => {
  assert.equal(F.characterFilterLabel({ mode: "all", asc: null }), "");
  assert.equal(F.characterFilterLabel({ mode: "all", asc: 10 }), "A10");
  assert.equal(F.characterFilterLabel({ mode: "standard", asc: null }), "Standard");
  assert.equal(F.characterFilterLabel({ mode: "standard", asc: 7 }), "Standard A7");
  assert.equal(F.characterFilterLabel({ mode: "blitz", asc: 2 }), "Blitz A2");
  assert.equal(F.characterFilterLabel({ mode: "dread", asc: null }), "Dread");
  assert.equal(F.characterFilterLabel({ mode: "all", asc: null, party: "coop" }), "Co-op");
  assert.equal(F.characterFilterLabel({ mode: "standard", asc: 7, party: "solo" }), "Solo · Standard A7");
  assert.equal(F.characterFilterLabel({ mode: "all", asc: null, party: "all" }), "");
});

// ---- Custom Runs and daily runs stay out of win streaks ------------------------------
// The game's own per-character stats (progress.save: total_wins, total_losses,
// current_streak, best_win_streak) match a real 730-run history exactly when
// abandoned runs count as losses and daily runs are left out. A Custom Run is
// not a run of your climb either: a player who started one by mistake and
// abandoned it saw it break their streak (Reddit, 2026-11-22).

await check("a Custom Run is recognized by the flag or by its older game mode", () => {
  assert.equal(F.isCustomRun({ isCustom: true, gameMode: "standard" }), true, "the reader's flag (v0.113+ saves)");
  assert.equal(F.isCustomRun({ gameMode: "custom" }), true, "older saves wrote the mode");
  assert.equal(F.isCustomRun({ raw: { game_mode: "custom" } }), true, "the Mac app keeps the save's mode under raw");
  assert.equal(F.isCustomRun({ raw: { is_custom_game: true } }), true);
  assert.equal(F.isCustomRun({ gameMode: "standard" }), false);
  assert.equal(F.isCustomRun({ isCustom: "yes" }), false);
  assert.equal(F.isCustomRun(null), false);
});

await check("only climb runs count toward a streak: not custom, not daily", () => {
  assert.equal(F.countsTowardStreak(run("ironclad", true, 10, 0)), true);
  assert.equal(F.countsTowardStreak(run("ironclad", true, 10, 0, "blitz")), true, "Blitz is filtered by the mode control, not here");
  assert.equal(F.countsTowardStreak(run("ironclad", true, 10, 0, "daily")), false);
  assert.equal(F.countsTowardStreak({ ...run("ironclad", false, 10, 0), isCustom: true }), false);
  assert.equal(F.countsTowardStreak({ ...run("ironclad", false, 10, 0), raw: { game_mode: "daily" } }), false);
});

await check("a custom loss after a streak does not break it", () => {
  const ironclad = F.filterRuns(RUNS, { character: "ironclad" });
  const abandonedCustom = { ...run("ironclad", false, 0, 9), isCustom: true, wasAbandoned: true };
  assert.equal(F.currentWinStreak([...ironclad, abandonedCustom]), 4);
  assert.equal(F.winStreaksByCharacter([...RUNS, abandonedCustom]).get("ironclad"), 4);
});

await check("a daily run neither breaks nor extends a streak", () => {
  const ironclad = F.filterRuns(RUNS, { character: "ironclad" });
  assert.equal(F.currentWinStreak([...ironclad, run("ironclad", false, 10, 9, "daily")]), 4);
  assert.equal(F.currentWinStreak([...ironclad, run("ironclad", true, 10, 9, "daily")]), 4);
});

await check("an abandoned standard run still breaks a streak, as in the game", () => {
  const ironclad = F.filterRuns(RUNS, { character: "ironclad" });
  assert.equal(F.currentWinStreak([...ironclad, { ...run("ironclad", false, 10, 9), wasAbandoned: true }]), 0);
});

await check("a character whose only runs are custom has no streak entry", () => {
  const streaks = F.winStreaksByCharacter([{ ...run("fool", true, 0, 1), isCustom: true }]);
  assert.equal(streaks.has("fool"), false);
});

await check("streakRuns keeps the runs a streak counts, without touching the input", () => {
  const custom = { ...run("silent", true, 0, 9), isCustom: true };
  const daily = run("silent", true, 0, 9, "daily");
  const input = Object.freeze([...RUNS, custom, daily]);
  assert.deepEqual(F.streakRuns(input).map((r) => r.id), RUNS.map((r) => r.id));
  assert.equal(input.length, RUNS.length + 2);
});

// ---- Solo / Co-op -------------------------------------------------------------------
// The web reader writes partySize on every record; the Mac app writes it only on
// co-op ones. So a record that does not say is a solo run.

const coop = (character, won, ascension, day, size = 2) => ({ ...run(character, won, ascension, day), partySize: size, party: [character, "silent"].slice(0, size) });
const WITH_COOP = Object.freeze([
  ...RUNS,
  coop("ironclad", true, 10, 7),
  coop("ironclad", false, 10, 8, 3),
  coop("regent", true, 4, 3),
]);

await check("runParty: more than one player is co-op; one or unknown is solo", () => {
  assert.equal(F.runParty({ partySize: 2 }), "coop");
  assert.equal(F.runParty({ partySize: 4 }), "coop");
  assert.equal(F.runParty({ partySize: 1 }), "solo");
  assert.equal(F.runParty({}), "solo");
  assert.equal(F.runParty({ partySize: "2" }), "solo", "only a number counts");
  assert.equal(F.runParty(null), "solo");
});

await check("partyCounts and partyChoices: no control until there is a co-op run", () => {
  assert.deepEqual(F.partyCounts(WITH_COOP), { solo: RUNS.length, coop: 3 });
  assert.deepEqual(F.partyChoices(WITH_COOP), ["all", "solo", "coop"]);
  assert.equal(F.partyChoices(RUNS), null);
  assert.equal(F.partyChoices([]), null);
  assert.deepEqual(F.partyChoices([coop("ironclad", true, 1, 1)]), ["all", "coop"], "no solo runs: no Solo choice");
});

await check("availableParty falls back to All for a party the runs cannot show", () => {
  assert.equal(F.availableParty("coop", WITH_COOP), "coop");
  assert.equal(F.availableParty("solo", WITH_COOP), "solo");
  assert.equal(F.availableParty("coop", RUNS), "all", "no co-op runs: no control, no party");
  assert.equal(F.availableParty("nonsense", WITH_COOP), "all");
});

await check("filterRuns by party, combined with the other filters", () => {
  assert.equal(F.filterRuns(WITH_COOP, { party: "coop" }).length, 3);
  assert.equal(F.filterRuns(WITH_COOP, { party: "solo" }).length, RUNS.length);
  assert.equal(F.filterRuns(WITH_COOP, { party: "coop", character: "ironclad", asc: 10 }).length, 2);
  assert.equal(F.filterRuns(WITH_COOP, { party: "bogus" }).length, WITH_COOP.length);
});

await check("a solo streak leaves co-op runs out when Solo is picked", () => {
  // Ironclad: …4 solo wins, then a co-op win and a co-op loss (newest).
  assert.equal(F.winStreaksByCharacter(WITH_COOP).get("ironclad"), 0, "All: the co-op loss is newest");
  assert.equal(F.winStreaksByCharacter(F.filterRuns(WITH_COOP, { party: "solo" })).get("ironclad"), 4);
});

await check("saved filters keep a party only while co-op runs are loaded", () => {
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 10, party: "coop" }, WITH_COOP), { mode: "all", asc: 10, party: "coop" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 10, party: "coop" }, RUNS), { mode: "all", asc: 10, party: "all" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "regent", ladder: "standard", party: "solo" }, WITH_COOP), { character: "regent", ladder: "standard", party: "solo" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "all", ladder: "standard", party: "coop" }, RUNS), { character: "all", ladder: "standard", party: "all" });
});

await check("a level or climber the chosen party has no runs of falls back, so the section is never all empty", () => {
  // Co-op runs here: Ironclad A10 (two) and Regent A4. No co-op A9, no co-op Silent.
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 9, party: "coop" }, WITH_COOP), { mode: "all", asc: null, party: "coop" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 10, party: "coop" }, WITH_COOP), { mode: "all", asc: 10, party: "coop" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 9, party: "solo" }, WITH_COOP), { mode: "all", asc: 9, party: "solo" });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 4, party: "solo" }, WITH_COOP), { mode: "all", asc: null, party: "solo" }, "A4 is co-op only");
  assert.deepEqual(F.sanitizeSpireFilter({ character: "silent", ladder: "standard", party: "coop" }, WITH_COOP), { character: "all", ladder: "standard", party: "coop" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "regent", ladder: "standard", party: "coop" }, WITH_COOP), { character: "regent", ladder: "standard", party: "coop" });
});

await check("the Mac app's raw custom flag counts as true or 1", () => {
  assert.equal(F.isCustomRun({ raw: { is_custom_game: 1 } }), true);
  assert.equal(F.isCustomRun({ raw: { is_custom_game: 0 } }), false);
  assert.equal(F.isCustomRun({ raw: { is_custom_game: false } }), false);
});

await check("partyLabel names a picked party only", () => {
  assert.equal(F.partyLabel("coop"), "Co-op");
  assert.equal(F.partyLabel("solo"), "Solo");
  assert.equal(F.partyLabel("all"), "");
  assert.equal(F.partyLabel(undefined), "");
});

// ---- each climber at one level (an open breakdown row on Ascensions) ---------------

await check("climbersByLevel: each climber's runs, wins and streak at each level of one ladder", () => {
  const byLevel = F.climbersByLevel(WITH_COOP, "standard", ["silent", "ironclad", "defect", "regent"]);
  const a10 = byLevel.get(10);
  // Defect's run recorded at 10 is Dread, off this ladder.
  assert.deepEqual(a10.map((c) => c.character), ["ironclad"], "climbers with runs at A10 only");
  const iron = a10[0];
  assert.deepEqual([iron.runs, iron.wins], [5, 3]);
  assert.equal(iron.winrate, 3 / 5);
  assert.equal(iron.streak, 0, "the newest A10 Ironclad run (co-op) is a loss");
  assert.deepEqual(byLevel.get(5).map((c) => [c.character, c.runs, c.wins]), [["silent", 2, 1]]);
  assert.deepEqual(byLevel.get(4).map((c) => c.character), ["regent"]);
  const order = F.climbersByLevel(WITH_COOP, "standard", ["defect", "regent", "ironclad"]);
  assert.deepEqual(order.get(0).map((c) => c.character), ["defect"]);
  assert.deepEqual(F.climbersByLevel(WITH_COOP, "standard", ["regent"]).get(5).map((c) => c.character), ["silent"], "a climber missing from the order comes after it");
});

await check("climbersByLevel stays on its ladder and leaves no-level runs out", () => {
  const standard = F.climbersByLevel(RUNS, "standard");
  assert.equal(standard.get(10).some((c) => c.character === "defect"), false, "the Dread run at 10 is not on the standard ladder");
  assert.equal([...standard.values()].flat().some((c) => c.character === "regent"), false, "Regent's run has no level");
  const blitz = F.climbersByLevel(RUNS, "blitz");
  assert.deepEqual([...blitz.keys()].sort(), [1, 2, 3]);
  assert.deepEqual(blitz.get(2).map((c) => [c.character, c.runs, c.wins]), [["ironclad", 1, 1]]);
});

await check("a climber's streak at a level skips custom and daily runs", () => {
  const runs = [
    run("silent", true, 7, 1),
    run("silent", true, 7, 2),
    { ...run("silent", false, 7, 3), isCustom: true },
    run("silent", false, 7, 4, "daily"),
  ];
  const [silent] = F.climbersByLevel(runs, "standard").get(7);
  assert.deepEqual([silent.runs, silent.wins, silent.streak], [4, 2, 2]);
});

console.log(process.exitCode ? `✘ stat filters: ${passed} passed, some failed` : `✓ stat filters: ${passed} checks passed`);
