#!/usr/bin/env node
/**
 * Offline checks for lib/stat-filters.js, the filters behind:
 *
 *   · Overview → By character   mode (All / Standard / Blitz / Dread) and ascension
 *   · Ascensions                one climber, Standard or Blitz ladder
 *   · the win streak on each character's card
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
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 2 }, RUNS), { mode: "blitz", asc: 2 });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "all", asc: 10 }, RUNS), { mode: "all", asc: 10 });
});

await check("sanitizeCharacterFilter drops what the data cannot show", () => {
  assert.deepEqual(F.sanitizeCharacterFilter(undefined, RUNS), { mode: "all", asc: null });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "bogus", asc: "x" }, RUNS), { mode: "all", asc: null });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 10 }, RUNS), { mode: "blitz", asc: null }, "no Blitz A10 runs");
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "dread", asc: 10 }, RUNS), { mode: "dread", asc: null }, "Dread has no levels");
  const standardOnly = F.filterRuns(RUNS, { mode: "standard" });
  // With no Blitz or Dread runs the mode control is hidden, so no mode may stay selected.
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "standard", asc: 9 }, standardOnly), { mode: "all", asc: 9 });
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 2 }, standardOnly), { mode: "all", asc: null });
});

await check("a level whose ladder goes away is dropped, even when the other ladder has that level", () => {
  // Saved as Blitz A2; now only standard runs are loaded, and they include A2.
  const withStandardA2 = [...F.filterRuns(RUNS, { mode: "standard" }), run("silent", true, 2, 7)];
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "blitz", asc: 2 }, withStandardA2), { mode: "all", asc: null });
  // Blitz runs but no Dread: Dread falls back to All, which has no level to keep.
  assert.deepEqual(F.sanitizeCharacterFilter({ mode: "dread", asc: 2 }, F.filterRuns(RUNS, { mode: "blitz" }).concat(withStandardA2)), { mode: "all", asc: null });
});

await check("pressing a mode keeps the level only while the ladder stays the same", () => {
  assert.deepEqual(F.withMode({ mode: "blitz", asc: 2 }, "standard"), { mode: "standard", asc: null }, "Blitz A2 never becomes standard A2");
  assert.deepEqual(F.withMode({ mode: "standard", asc: 2 }, "blitz"), { mode: "blitz", asc: null });
  assert.deepEqual(F.withMode({ mode: "standard", asc: 7 }, "all"), { mode: "all", asc: 7 }, "All and Standard share a ladder");
  assert.deepEqual(F.withMode({ mode: "all", asc: 7 }, "dread"), { mode: "dread", asc: null });
});

await check("sanitizeSpireFilter keeps the ladder and climber only when they have runs", () => {
  assert.deepEqual(F.sanitizeSpireFilter({ character: "silent", ladder: "blitz" }, RUNS), { character: "silent", ladder: "blitz" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "defect", ladder: "blitz" }, RUNS), { character: "all", ladder: "blitz" }, "Defect has no Blitz runs");
  assert.deepEqual(F.sanitizeSpireFilter({ character: "ironclad", ladder: "dread" }, RUNS), { character: "ironclad", ladder: "standard" });
  const standardOnly = F.filterRuns(RUNS, { mode: "standard" });
  assert.deepEqual(F.sanitizeSpireFilter({ character: "all", ladder: "blitz" }, standardOnly), { character: "all", ladder: "standard" });
  assert.deepEqual(F.sanitizeSpireFilter(null, RUNS), { character: "all", ladder: "standard" });
});

await check("filter labels read the way the summary line shows them", () => {
  assert.equal(F.characterFilterLabel({ mode: "all", asc: null }), "");
  assert.equal(F.characterFilterLabel({ mode: "all", asc: 10 }), "A10");
  assert.equal(F.characterFilterLabel({ mode: "standard", asc: null }), "Standard");
  assert.equal(F.characterFilterLabel({ mode: "standard", asc: 7 }), "Standard A7");
  assert.equal(F.characterFilterLabel({ mode: "blitz", asc: 2 }), "Blitz A2");
  assert.equal(F.characterFilterLabel({ mode: "dread", asc: null }), "Dread");
});

console.log(process.exitCode ? `✘ stat filters: ${passed} passed, some failed` : `✓ stat filters: ${passed} checks passed`);
