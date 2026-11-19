// stat-filters.js
// =========================================================================
// The filters behind two stats sections, shared by both looks:
//
//   · Overview → By character   game mode (All / Standard / Blitz / Dread)
//                               and one ascension level
//   · Ascensions                one climber, on the Standard or Blitz ladder
//
// plus each character's current win streak.
//
// An ascension number means different things per mode (STS2 beta v0.113):
// Blitz has its own ladder and Dread turns every modifier on, so its number
// is on no ladder at all. A chosen level therefore only ever selects runs
// of one ladder: "All modes + A10" means standard-ladder A10, the same rule
// the Runs tab's ascension chips and Stats.summarize().byAscension follow.
//
// Pure functions over normalized runs (Stats.normalizeRun's shape). No DOM,
// no storage, no input mutation. Checked by scripts/verify-stat-filters.mjs.
// =========================================================================

import { offLadderMode } from "./stats-engine.js?v=8";

/** @typedef {"all"|"standard"|"blitz"|"dread"} ModeId */
/** @typedef {"standard"|"blitz"} LadderId */
/** @typedef {{ mode: ModeId, asc: number|null }} CharacterFilter */
/** @typedef {{ character: string, ladder: LadderId }} SpireFilter */
/** @typedef {{ key: string, level: number, runs: number, wins: number, winrate: number }} AscBucket */

/** Every mode filter, in the order the control shows them. */
export const MODE_IDS = Object.freeze(["all", "standard", "blitz", "dread"]);
/** The two ladders a level can belong to. */
export const LADDER_IDS = Object.freeze(["standard", "blitz"]);
/** Display names, shared by both looks. */
export const MODE_LABELS = Object.freeze({ all: "All", standard: "Standard", blitz: "Blitz", dread: "Dread" });

/** A character's card shows its win streak from this many wins in a row
 *  (a single win is not a streak yet). Both looks use it. */
export const STREAK_SHOWN_FROM = 2;

export const DEFAULT_CHARACTER_FILTER = Object.freeze({ mode: "all", asc: null });
export const DEFAULT_SPIRE_FILTER = Object.freeze({ character: "all", ladder: "standard" });

/**
 * @param {{ gameMode?: string }|null|undefined} run
 * @returns {"standard"|"blitz"|"dread"}
 */
export function runMode(run) {
  return offLadderMode(run?.gameMode) || "standard";
}

/**
 * @param {ReadonlyArray<object>} runs
 * @returns {{ standard: number, blitz: number, dread: number }}
 */
export function modeCounts(runs) {
  const counts = { standard: 0, blitz: 0, dread: 0 };
  for (const r of runs) counts[runMode(r)] += 1;
  return counts;
}

/**
 * The modes a mode control offers for these runs: All and Standard, plus
 * Blitz and Dread when there are runs of them. null when every run is a
 * standard one: then no control is shown at all.
 * @param {ReadonlyArray<object>} runs
 * @returns {ModeId[]|null}
 */
export function modeChoices(runs) {
  const counts = modeCounts(runs);
  if (counts.blitz + counts.dread === 0) return null;
  return MODE_IDS.filter((id) => id === "all" || id === "standard" || counts[id] > 0);
}

/**
 * The mode that actually applies: a chosen mode the runs cannot show (no
 * runs of it, or no control on screen) falls back to All, so a saved
 * choice is never applied unseen.
 * @param {unknown} mode
 * @param {ReadonlyArray<object>} runs
 * @returns {ModeId}
 */
export function availableMode(mode, runs) {
  const choices = modeChoices(runs);
  return choices && choices.includes(/** @type {any} */ (mode)) ? /** @type {ModeId} */ (mode) : "all";
}

/**
 * The ladder a mode filter's ascension levels belong to; null for Dread.
 * @param {string} mode
 * @returns {LadderId|null}
 */
export function ladderOf(mode) {
  if (mode === "blitz") return "blitz";
  if (mode === "dread") return null;
  return "standard";
}

/** @param {unknown} value @returns {number|null} */
function asLevel(value) {
  return Number.isInteger(value) && value >= 0 ? /** @type {number} */ (value) : null;
}

/**
 * @template {{ character?: string|null, gameMode?: string, ascension?: number|null }} R
 * @param {ReadonlyArray<R>} runs
 * @param {{ mode?: string, asc?: number|null, character?: string }} [filter]
 * @returns {R[]}
 */
export function filterRuns(runs, filter = {}) {
  const mode = MODE_IDS.includes(/** @type {any} */ (filter.mode)) ? filter.mode : "all";
  const character = filter.character || "all";
  const ladder = ladderOf(mode);
  const level = ladder ? asLevel(filter.asc) : null;
  return runs.filter((r) => {
    if (character !== "all" && r.character !== character) return false;
    const m = runMode(r);
    if (mode !== "all" && m !== mode) return false;
    if (level !== null && (m !== ladder || r.ascension !== level)) return false;
    return true;
  });
}

/**
 * Win rate per level on one ladder, lowest level first, levels with runs
 * only. For "standard" this is exactly Stats.summarize().byAscension.
 * @param {ReadonlyArray<{ won?: boolean, gameMode?: string, ascension?: number|null }>} runs
 * @param {LadderId} [ladder]
 * @returns {AscBucket[]}
 */
export function ascensionBuckets(runs, ladder = "standard") {
  /** @type {Map<number, { runs: number, wins: number }>} */
  const counts = new Map();
  for (const r of runs) {
    if (runMode(r) !== ladder) continue;
    const level = asLevel(r.ascension);
    if (level === null) continue;
    const c = counts.get(level) || { runs: 0, wins: 0 };
    counts.set(level, { runs: c.runs + 1, wins: c.wins + (r.won === true ? 1 : 0) });
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, c]) => ({ key: `A${level}`, level, runs: c.runs, wins: c.wins, winrate: c.runs ? c.wins / c.runs : 0 }));
}

/**
 * The levels the ascension picker offers for a mode, highest first.
 * @param {ReadonlyArray<object>} runs
 * @param {string} mode
 * @returns {AscBucket[]}
 */
export function ascensionLevels(runs, mode) {
  const ladder = ladderOf(mode);
  return ladder ? ascensionBuckets(runs, ladder).reverse() : [];
}

/** @param {{ endedAt?: Date|null, startedAt?: Date|null }} r */
function runTime(r) {
  const at = r.endedAt || r.startedAt;
  return at instanceof Date ? at.getTime() : 0;
}

/**
 * Consecutive wins back from the newest run (0 when the newest is not a
 * win). Same ordering as script.js's currentStreak.
 * @param {ReadonlyArray<{ won?: boolean, endedAt?: Date|null, startedAt?: Date|null }>} runs
 * @returns {number}
 */
export function currentWinStreak(runs) {
  const newestFirst = runs.slice().sort((a, b) => runTime(b) - runTime(a));
  let count = 0;
  for (const r of newestFirst) {
    if (r.won !== true) break;
    count += 1;
  }
  return count;
}

/**
 * @param {ReadonlyArray<{ character?: string|null }>} runs
 * @returns {Map<string, number>}  current win streak per character with runs
 */
export function winStreaksByCharacter(runs) {
  // Grouped into arrays made here (one pass, linear); the input is not touched.
  /** @type {Map<string, Array<any>>} */
  const byChar = new Map();
  for (const r of runs) {
    if (!r.character) continue;
    const list = byChar.get(r.character);
    if (list) list.push(r);
    else byChar.set(r.character, [r]);
  }
  return new Map([...byChar].map(([key, list]) => [key, currentWinStreak(list)]));
}

/**
 * The By-character filter after a mode chip is pressed. The level stays
 * only while the ladder does (All ↔ Standard), so Blitz A2 never turns
 * into standard A2.
 * @param {CharacterFilter} filter
 * @param {ModeId} mode
 * @returns {CharacterFilter}
 */
export function withMode(filter, mode) {
  return { mode, asc: ladderOf(mode) === ladderOf(filter.mode) ? filter.asc : null };
}

/**
 * A saved By-character filter, cut down to what these runs can show: a
 * mode with no runs (or any mode, when the history has only standard runs
 * and the control is hidden) falls back to All; a level with no runs on
 * the mode's ladder falls back to every level.
 * @param {unknown} raw
 * @param {ReadonlyArray<object>} runs
 * @returns {CharacterFilter}
 */
export function sanitizeCharacterFilter(raw, runs) {
  const f = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const wanted = MODE_IDS.includes(/** @type {any} */ (f.mode)) ? /** @type {ModeId} */ (f.mode) : "all";
  const mode = availableMode(wanted, runs);
  // A level belongs to its mode's ladder: Blitz A2 never becomes standard A2.
  const level = ladderOf(mode) === ladderOf(wanted) ? asLevel(f.asc) : null;
  const asc = level !== null && ascensionLevels(runs, mode).some((b) => b.level === level) ? level : null;
  return { mode, asc };
}

/**
 * A saved spire filter, cut down to what these runs can show.
 * @param {unknown} raw
 * @param {ReadonlyArray<{ character?: string|null }>} runs
 * @returns {SpireFilter}
 */
export function sanitizeSpireFilter(raw, runs) {
  const f = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const ladder = f.ladder === "blitz" && modeCounts(runs).blitz > 0 ? "blitz" : "standard";
  const wanted = typeof f.character === "string" ? f.character : "all";
  const character = wanted !== "all" && filterRuns(runs, { character: wanted, mode: ladder }).length > 0 ? wanted : "all";
  return { character, ladder };
}

/**
 * "", "A10", "Standard", "Standard A7", "Blitz A2", "Dread".
 * @param {CharacterFilter} f
 * @returns {string}
 */
export function characterFilterLabel(f) {
  const level = ladderOf(f.mode) ? asLevel(f.asc) : null;
  const mode = f.mode === "all" ? "" : MODE_LABELS[f.mode] || "";
  return [mode, level === null ? "" : `A${level}`].filter(Boolean).join(" ");
}
