// Co-op Play — "Your co-op climbs": the numbers from the player's own saves.
//
// A run is a co-op climb when its save lists more than one player
// (`partySize`, kept by lib/sts2-run-parser.js). The game's run history holds
// one entry per player with their character, but nothing that says which
// entry is the local player. So every number here is about the party as a
// whole: how many co-op runs, how they ended, how far they got, who was in
// them. Nothing claims "you played X".
//
// Pure and import-free, so Web/scripts/verify-coop-climbs.mjs loads it
// straight into Node.

/** How many recent co-op runs the panel lists. */
export const RECENT_COUNT = 3;

/** The game's own order, so a party reads the same way wherever it is shown. */
const CLIMBER_ORDER = Object.freeze(["ironclad", "silent", "defect", "regent", "necrobinder", "fool"]);

/**
 * @typedef {"won" | "abandoned" | "lost"} ClimbResult
 * @typedef {{ id: string, when: Date | null, result: ClimbResult, floor: number, ascension: number | null, party: Array<string | null> }} RecentClimb
 * @typedef {{ party: Array<string | null>, wins: number, runs: number }} BestParty
 * @typedef {Object} CoopClimbs
 * @property {boolean} known        false until at least one loaded run records its party size
 * @property {number} runs          finished co-op runs
 * @property {number} wins
 * @property {number} abandoned
 * @property {number | null} winRate  wins over every co-op run, abandoned ones included, as everywhere else in the app; null when there are none
 * @property {number} bestFloor
 * @property {RecentClimb[]} recent   newest first
 * @property {BestParty | null} bestParty  the party with the most wins, if any run was won
 */

/** No real party is this large; the cap only keeps odd data from building a huge list. */
const PARTY_CAP = 8;

/**
 * The party in the save's own order. A player whose climber is missing or
 * unreadable is null, so a party of three always has three entries.
 * @param {any} run
 * @returns {Array<string | null>}
 */
function partyOf(run) {
  const listed = Array.isArray(run.party) ? run.party.map((c) => (typeof c === "string" && c ? c : null)) : [];
  const size = Math.min(PARTY_CAP, Number.isFinite(run.partySize) ? Math.max(0, Math.floor(run.partySize)) : listed.length);
  const party = listed.slice(0, size);
  return party.length < size ? [...party, ...new Array(size - party.length).fill(null)] : party;
}

/** @param {Array<string | null>} party @returns {Array<string | null>} in the game's order, unknowns last */
function inGameOrder(party) {
  const rank = (c) => (c === null ? CLIMBER_ORDER.length : CLIMBER_ORDER.indexOf(c) >>> 0);
  return [...party].sort((a, b) => rank(a) - rank(b));
}

/** @param {any} run @returns {Date | null} */
function whenOf(run) {
  const raw = run.endedAt || run.startedAt;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** @param {any} run @returns {ClimbResult} */
function resultOf(run) {
  if (run.won === true) return "won";
  return run.wasAbandoned === true ? "abandoned" : "lost";
}

/**
 * @param {unknown} runs the app's loaded runs (any shape of extra fields)
 * @returns {CoopClimbs}
 */
export function summarizeCoopClimbs(runs) {
  const finished = Array.isArray(runs) ? runs.filter((r) => r && typeof r === "object" && !r.inProgress) : [];
  const sized = finished.filter((r) => Number.isFinite(r.partySize));
  const coop = sized.filter((r) => r.partySize > 1);

  const results = coop.map(resultOf);
  const wins = results.filter((r) => r === "won").length;
  const abandoned = results.filter((r) => r === "abandoned").length;

  const recent = coop
    .map((run, index) => ({ run, index, at: whenOf(run)?.getTime() ?? 0 }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .slice(0, RECENT_COUNT)
    .map(({ run }) => ({
      id: String(run.id ?? ""),
      when: whenOf(run),
      result: resultOf(run),
      floor: Number.isFinite(run.floorReached) ? run.floorReached : 0,
      ascension: Number.isFinite(run.ascension) ? run.ascension : null,
      party: partyOf(run),
    }));

  return {
    known: sized.length > 0,
    runs: coop.length,
    wins,
    abandoned,
    winRate: coop.length > 0 ? wins / coop.length : null,
    bestFloor: coop.reduce((best, r) => Math.max(best, Number.isFinite(r.floorReached) ? r.floorReached : 0), 0),
    recent,
    bestParty: bestPartyOf(coop),
  };
}

/**
 * The party (as a set of characters) with the most wins. Ties go to the one
 * that needed fewer runs for them.
 * @param {any[]} coop
 * @returns {BestParty | null}
 */
function bestPartyOf(coop) {
  /** @type {Map<string, BestParty>} */
  const byParty = new Map();
  for (const run of coop) {
    const party = inGameOrder(partyOf(run));
    const key = party.map((c) => c ?? "?").join("+");
    const prev = byParty.get(key) ?? { party, wins: 0, runs: 0 };
    byParty.set(key, { party, wins: prev.wins + (run.won === true ? 1 : 0), runs: prev.runs + 1 });
  }
  const winners = [...byParty.values()].filter((p) => p.wins > 0);
  if (winners.length === 0) return null;
  return winners.reduce((best, p) => (p.wins > best.wins || (p.wins === best.wins && p.runs < best.runs) ? p : best));
}
