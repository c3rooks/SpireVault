// stat-filters.js
// =========================================================================
// The filters behind three stats sections, shared by both looks:
//
//   · Overview → By character   game mode (All / Standard / Blitz / Dread),
//                               one ascension level, Solo or Co-op
//   · Ascensions                one climber, on the Standard or Blitz ladder,
//                               Solo or Co-op; each climber's record per level
//   · Runs                      Solo or Co-op (script.js applies the rest)
//
// plus each character's current win streak.
//
// Streaks count climb runs only. The game's own per-character stats
// (progress.save: total_wins, total_losses, current_streak, best_win_streak)
// match a real 730-run history exactly when an abandoned run counts as a
// loss and daily runs are left out. Custom Runs are left out too: they are
// not a run of your climb (a player who started one by mistake and
// abandoned it saw it break their streak; Reddit, 2026-11-22).
//
// Solo or co-op comes from `partySize`. The web reader writes it on every
// record; the Mac app writes it on co-op records only, so a record that
// does not say is a solo run.
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

import { offLadderMode } from "./stats-engine.js?v=10";

/** @typedef {"all"|"standard"|"blitz"|"dread"} ModeId */
/** @typedef {"standard"|"blitz"} LadderId */
/** @typedef {"all"|"solo"|"coop"} PartyId */
/** @typedef {{ mode: ModeId, asc: number|null, party: PartyId }} CharacterFilter */
/** @typedef {{ character: string, ladder: LadderId, party: PartyId }} SpireFilter */
/** @typedef {{ key: string, level: number, runs: number, wins: number, winrate: number }} AscBucket */
/** @typedef {{ character: string, runs: number, wins: number, winrate: number, streak: number }} ClimberAtLevel */

/** Every mode filter, in the order the control shows them. */
export const MODE_IDS = Object.freeze(["all", "standard", "blitz", "dread"]);
/** The two ladders a level can belong to. */
export const LADDER_IDS = Object.freeze(["standard", "blitz"]);
/** Display names, shared by both looks. */
export const MODE_LABELS = Object.freeze({ all: "All", standard: "Standard", blitz: "Blitz", dread: "Dread" });
/** Every party filter, in the order the control shows them. */
export const PARTY_IDS = Object.freeze(["all", "solo", "coop"]);
export const PARTY_LABELS = Object.freeze({ all: "All", solo: "Solo", coop: "Co-op" });

/** A character's card shows its win streak from this many wins in a row
 *  (a single win is not a streak yet). Both looks use it. */
export const STREAK_SHOWN_FROM = 2;

export const DEFAULT_CHARACTER_FILTER = Object.freeze({ mode: "all", asc: null, party: "all" });
export const DEFAULT_SPIRE_FILTER = Object.freeze({ character: "all", ladder: "standard", party: "all" });

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
 * @param {{ partySize?: unknown }|null|undefined} run
 * @returns {"solo"|"coop"}  co-op when the save lists more than one player
 */
export function runParty(run) {
  const size = run?.partySize;
  return typeof size === "number" && Number.isFinite(size) && size > 1 ? "coop" : "solo";
}

/**
 * @param {ReadonlyArray<object>} runs
 * @returns {{ solo: number, coop: number }}
 */
export function partyCounts(runs) {
  const counts = { solo: 0, coop: 0 };
  for (const r of runs) counts[runParty(r)] += 1;
  return counts;
}

/**
 * The parties a Solo / Co-op control offers: null (no control) until the
 * history has a co-op run; Solo only when there are solo runs.
 * @param {ReadonlyArray<object>} runs
 * @returns {PartyId[]|null}
 */
export function partyChoices(runs) {
  const counts = partyCounts(runs);
  if (counts.coop === 0) return null;
  return PARTY_IDS.filter((id) => id !== "solo" || counts.solo > 0);
}

/**
 * The party that actually applies: one the runs cannot show (or any, with
 * no control on screen) falls back to All.
 * @param {unknown} party
 * @param {ReadonlyArray<object>} runs
 * @returns {PartyId}
 */
export function availableParty(party, runs) {
  const choices = partyChoices(runs);
  return choices && choices.includes(/** @type {any} */ (party)) ? /** @type {PartyId} */ (party) : "all";
}

/** "Solo", "Co-op", or "" for All. @param {unknown} party @returns {string} */
export function partyLabel(party) {
  return party === "solo" || party === "coop" ? PARTY_LABELS[party] : "";
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
 * @template {{ character?: string|null, gameMode?: string, ascension?: number|null, partySize?: number }} R
 * @param {ReadonlyArray<R>} runs
 * @param {{ mode?: string, asc?: number|null, character?: string, party?: string }} [filter]
 * @returns {R[]}
 */
export function filterRuns(runs, filter = {}) {
  const mode = MODE_IDS.includes(/** @type {any} */ (filter.mode)) ? filter.mode : "all";
  const character = filter.character || "all";
  const party = filter.party === "solo" || filter.party === "coop" ? filter.party : "all";
  const ladder = ladderOf(mode);
  const level = ladder ? asLevel(filter.asc) : null;
  return runs.filter((r) => {
    if (character !== "all" && r.character !== character) return false;
    if (party !== "all" && runParty(r) !== party) return false;
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

/** The save's `game_mode`, wherever the record keeps it: the web reader's
 *  `gameMode`, or the Mac app's `raw.game_mode`. @param {any} run */
function savedMode(run) {
  const mode = run?.gameMode ?? run?.game_mode ?? run?.raw?.game_mode;
  return typeof mode === "string" ? mode.trim().toLowerCase() : "";
}

/**
 * A run from the game's Custom Run screen: the reader's `isCustom` (the
 * save's `is_custom_game`, v0.113+), or `game_mode: "custom"` in older saves.
 * @param {any} run
 * @returns {boolean}
 */
export function isCustomRun(run) {
  const rawFlag = run?.raw?.is_custom_game;
  return run?.isCustom === true || rawFlag === true || rawFlag === 1 || savedMode(run) === "custom";
}

/**
 * Whether a run counts toward a win streak: not a Custom Run, not a daily
 * run (the game leaves both out of its own streaks). An abandoned run does
 * count, as a loss, as it does in the game.
 * @param {any} run
 * @returns {boolean}
 */
export function countsTowardStreak(run) {
  return !isCustomRun(run) && savedMode(run) !== "daily";
}

/**
 * The runs a streak counts (a new array; the input is not touched).
 * @template R
 * @param {ReadonlyArray<R>} runs
 * @returns {R[]}
 */
export function streakRuns(runs) {
  return runs.filter(countsTowardStreak);
}

/**
 * Consecutive wins back from the newest run that counts toward a streak
 * (0 when that run is not a win). Same ordering as script.js's currentStreak.
 * @param {ReadonlyArray<{ won?: boolean, endedAt?: Date|null, startedAt?: Date|null }>} runs
 * @returns {number}
 */
export function currentWinStreak(runs) {
  const newestFirst = streakRuns(runs).sort((a, b) => runTime(b) - runTime(a));
  let count = 0;
  for (const r of newestFirst) {
    if (r.won !== true) break;
    count += 1;
  }
  return count;
}

/**
 * @param {ReadonlyArray<{ character?: string|null }>} runs
 * @returns {Map<string, number>}  current win streak per character with runs that count
 */
export function winStreaksByCharacter(runs) {
  // Grouped into arrays made here (one pass, linear); the input is not touched.
  /** @type {Map<string, Array<any>>} */
  const byChar = new Map();
  for (const r of runs) {
    if (!r.character || !countsTowardStreak(r)) continue;
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
  return { ...filter, mode, asc: ladderOf(mode) === ladderOf(filter.mode) ? filter.asc : null };
}

/**
 * Each climber's record at every level of one ladder: runs, wins and win
 * rate (every run, as the level's own row counts them) and current win
 * streak there (climb runs only). Climbers come in `order`, then any not
 * in it by key; a climber with no runs at a level is not listed there.
 * @param {ReadonlyArray<{ character?: string|null, won?: boolean, gameMode?: string, ascension?: number|null }>} runs
 * @param {LadderId} [ladder]
 * @param {ReadonlyArray<string>} [order]
 * @returns {Map<number, ClimberAtLevel[]>}
 */
export function climbersByLevel(runs, ladder = "standard", order = []) {
  /** @type {Map<number, Map<string, Array<any>>>} */
  const grouped = new Map();
  for (const r of runs) {
    const level = asLevel(r.ascension);
    if (level === null || !r.character || runMode(r) !== ladder) continue;
    const byChar = grouped.get(level) || new Map();
    if (!grouped.has(level)) grouped.set(level, byChar);
    const list = byChar.get(r.character);
    if (list) list.push(r);
    else byChar.set(r.character, [r]);
  }
  const rank = (key) => {
    const i = order.indexOf(key);
    return i < 0 ? order.length : i;
  };
  return new Map([...grouped].map(([level, byChar]) => [level, [...byChar]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([character, list]) => {
      const wins = list.filter((r) => r.won === true).length;
      return { character, runs: list.length, wins, winrate: wins / list.length, streak: currentWinStreak(list) };
    })]));
}

/**
 * A saved By-character filter, cut down to what these runs can show: a
 * mode with no runs (or any mode, when the history has only standard runs
 * and the control is hidden) falls back to All; a level with no runs on
 * the mode's ladder in the chosen party (Solo / Co-op) falls back to every
 * level, so Co-op + A10 never draws a grid of empty cards.
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
  const party = availableParty(f.party, runs);
  const asc = level !== null && ascensionLevels(filterRuns(runs, { party }), mode).some((b) => b.level === level) ? level : null;
  return { mode, asc, party };
}

/**
 * A saved spire filter, cut down to what these runs can show: a climber
 * with no runs on the ladder in the chosen party falls back to All.
 * @param {unknown} raw
 * @param {ReadonlyArray<{ character?: string|null }>} runs
 * @returns {SpireFilter}
 */
export function sanitizeSpireFilter(raw, runs) {
  const f = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const ladder = f.ladder === "blitz" && modeCounts(runs).blitz > 0 ? "blitz" : "standard";
  const wanted = typeof f.character === "string" ? f.character : "all";
  const party = availableParty(f.party, runs);
  const character = wanted !== "all" && filterRuns(runs, { character: wanted, mode: ladder, party }).length > 0 ? wanted : "all";
  return { character, ladder, party };
}

/**
 * "", "A10", "Standard", "Standard A7", "Blitz A2", "Dread", "Co-op",
 * "Solo · Standard A7".
 * @param {{ mode: string, asc?: number|null, party?: string }} f
 * @returns {string}
 */
export function characterFilterLabel(f) {
  const level = ladderOf(f.mode) ? asLevel(f.asc) : null;
  const mode = f.mode === "all" ? "" : MODE_LABELS[/** @type {ModeId} */ (f.mode)] || "";
  const ladder = [mode, level === null ? "" : `A${level}`].filter(Boolean).join(" ");
  return [partyLabel(f.party), ladder].filter(Boolean).join(" · ");
}
