// stats-engine.js
// =========================================================================
// Direct JS port of TheVault/Sources/VaultCore/Stats/StatsEngine.swift.
// Same input shape (a list of RunRecord objects), same bucket math, same
// thresholds, same sort. Output shape mirrors `StatsReport` so the rendering
// layer doesn't have to think about which engine produced it.
//
// Pure functions — zero side effects, no I/O. Safe to run on the main thread
// for histories well into the thousands. (We did some napkin math: 10k runs
// × ~50 cards each × ~5 ascensions averages ≈ a few million ops, all object
// keys, all native — comfortably <100ms even on mid-range phones.)
// =========================================================================

const VALID_CHARACTERS = new Set(["ironclad", "silent", "regent", "necrobinder", "defect"]);

/**
 * Normalize a single record so downstream math doesn't have to care about the
 * dozen ways a save file might disagree with itself ("Ironclad" vs "ironclad",
 * `won: 1` vs `won: true`, missing keys, etc).
 */
export function normalizeRun(run) {
  if (!run || typeof run !== "object") return null;
  const character = (() => {
    const raw = run.character;
    if (typeof raw !== "string") return null;
    const k = raw.toLowerCase().replace(/\s+/g, "");
    if (k === "ironclad" || k === "ic") return "ironclad";
    if (k === "silent"   || k === "si") return "silent";
    if (k === "regent"   || k === "re" || k === "rg") return "regent";
    if (k === "necrobinder" || k === "nb" || k === "binder") return "necrobinder";
    if (k === "defect"   || k === "df" || k === "de") return "defect";
    return null;
  })();
  return {
    id: String(run.id ?? `${run.seed ?? "noseed"}-${run.endedAt ?? run.parsedAt ?? Date.now()}`),
    character,
    ascension: Number.isFinite(run.ascension) ? Math.max(0, Math.min(20, run.ascension | 0)) : null,
    seed: typeof run.seed === "string" ? run.seed : null,
    won: run.won === true || run.won === 1,
    floorReached: Number.isFinite(run.floorReached) ? run.floorReached | 0 : null,
    playTimeSeconds: Number.isFinite(run.playTimeSeconds) ? run.playTimeSeconds | 0 : null,
    startedAt: parseDate(run.startedAt),
    endedAt: parseDate(run.endedAt) ?? parseDate(run.parsedAt),
    relics: Array.isArray(run.relics) ? run.relics.map(String) : [],
    deckAtEnd: Array.isArray(run.deckAtEnd) ? run.deckAtEnd.map(String) : [],
    cardPicks: Array.isArray(run.cardPicks) ? run.cardPicks : [],
  };
}

function parseDate(d) {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Mirror of `StatsEngine.summarize` in Swift.
 */
export function summarize(runs, opts = {}) {
  const relicMinSample = opts.relicMinSample ?? 3;
  const cardMinSample  = opts.cardMinSample  ?? 3;
  const topN           = opts.topN           ?? 15;

  const total = runs.length;
  const wins  = runs.reduce((acc, r) => acc + (r.won === true ? 1 : 0), 0);

  const byCharacter = bucket(
    runs,
    (r) => r.character,
    (r) => r.won === true,
  );

  const byAscension = bucket(
    runs,
    (r) => r.ascension == null ? null : `A${r.ascension}`,
    (r) => r.won === true,
  ).sort((a, b) => parseAsc(a.key) - parseAsc(b.key));

  const byRelic = relicBuckets(runs, relicMinSample, topN);

  const { picked, skipped } = cardPickStats(runs, cardMinSample, topN);

  return {
    totalRuns: total,
    totalWins: wins,
    overallWinrate: total === 0 ? 0 : wins / total,
    byCharacter,
    byAscension,
    byRelic,
    topPickedCards: picked,
    topSkippedCards: skipped,
    generatedAt: new Date().toISOString(),
  };
}

function parseAsc(key) {
  const n = Number((key ?? "").replace(/^A/, ""));
  return Number.isFinite(n) ? n : -1;
}

function bucket(runs, keyFn, wonFn) {
  const counts = new Map();
  for (const r of runs) {
    const k = keyFn(r);
    if (k == null) continue;
    const c = counts.get(k) ?? { runs: 0, wins: 0 };
    c.runs += 1;
    if (wonFn(r)) c.wins += 1;
    counts.set(k, c);
  }
  const out = [];
  for (const [key, c] of counts) {
    out.push({
      key,
      runs: c.runs,
      wins: c.wins,
      winrate: c.runs === 0 ? 0 : c.wins / c.runs,
      pickedRate: null,
    });
  }
  return out.sort((a, b) => (b.runs - a.runs) || (b.wins - a.wins));
}

/**
 * Wilson lower-bound at 95% confidence. Penalizes small samples so a
 * 3-run / 2-win relic (66.7% raw) doesn't out-rank a 30-run / 17-win
 * relic (56.7% raw) just because the small sample lucked out. Used for
 * both ranking and color-tone in the relic and card panels — keeps the
 * "top winrate" lists honest when total runs are low.
 */
function wilsonLowerBound(wins, runs) {
  if (runs <= 0) return 0;
  const z = 1.96;
  const p = wins / runs;
  const denom = 1 + (z * z) / runs;
  const center = p + (z * z) / (2 * runs);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * runs)) / runs);
  return Math.max(0, (center - margin) / denom);
}

function relicBuckets(runs, minSample, topN) {
  const seen = new Map();
  for (const r of runs) {
    const unique = new Set(r.relics ?? []);
    for (const relic of unique) {
      const c = seen.get(relic) ?? { runs: 0, wins: 0 };
      c.runs += 1;
      if (r.won === true) c.wins += 1;
      seen.set(relic, c);
    }
  }
  const total = Math.max(runs.length, 1);
  const out = [];
  for (const [key, c] of seen) {
    if (c.runs < minSample) continue;
    const winrate = c.runs === 0 ? 0 : c.wins / c.runs;
    out.push({
      key,
      runs: c.runs,
      wins: c.wins,
      winrate,
      lb: wilsonLowerBound(c.wins, c.runs),
      pickedRate: c.runs / total,
    });
  }
  return out
    .sort((a, b) => (b.lb - a.lb) || (b.winrate - a.winrate) || (b.runs - a.runs))
    .slice(0, topN);
}

function cardPickStats(runs, minSample, topN) {
  const offered = new Map();
  const picked = new Map();
  const pickedWins = new Map();

  const inc = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const r of runs) {
    const won = r.won === true;
    for (const choice of r.cardPicks ?? []) {
      const opts = Array.isArray(choice.offered) ? new Set(choice.offered) : null;
      if (opts) for (const o of opts) inc(offered, String(o));
      if (typeof choice.picked === "string" && choice.picked.length) {
        inc(picked, choice.picked);
        if (won) inc(pickedWins, choice.picked);
      }
    }
  }

  // Most picked: weighted by raw pick count, with derived winrate.
  const mostPicked = [];
  for (const [k, n] of picked) {
    if (n < minSample) continue;
    const w = pickedWins.get(k) ?? 0;
    const off = offered.get(k) ?? n;
    mostPicked.push({
      key: k,
      runs: n,
      wins: w,
      winrate: n === 0 ? 0 : w / n,
      lb: wilsonLowerBound(w, n),
      pickedRate: n / Math.max(off, 1),
    });
  }
  mostPicked.sort((a, b) => b.runs - a.runs || b.winrate - a.winrate);

  // Most skipped: offered enough to be meaningful AND picked < 50% of the time.
  const mostSkipped = [];
  for (const [k, off] of offered) {
    if (off < minSample) continue;
    const p = picked.get(k) ?? 0;
    const rate = p / off;
    if (rate >= 0.5) continue;
    mostSkipped.push({
      key: k,
      runs: off,
      wins: p,
      winrate: 0,
      pickedRate: rate,
    });
  }
  mostSkipped.sort((a, b) => (a.pickedRate ?? 0) - (b.pickedRate ?? 0) || b.runs - a.runs);

  return {
    picked: mostPicked.slice(0, topN),
    skipped: mostSkipped.slice(0, topN),
  };
}

/**
 * Filter helpers — replicate the macOS app's RunFilter.
 */
export function applyFilter(runs, filter = {}) {
  const { character, won, since } = filter;
  const sinceMs = since ? Date.parse(since) : null;
  return runs.filter((r) => {
    if (character && r.character !== character) return false;
    if (won === true  && r.won !== true)  return false;
    if (won === false && r.won === true)  return false;
    if (sinceMs && r.endedAt && r.endedAt.getTime() < sinceMs) return false;
    return true;
  });
}

/**
 * Pull a clean list of normalized runs out of whatever shape `history.json` is on disk.
 * Tolerates {header, runs}, {runs}, and bare arrays.
 */
export function extractRuns(parsed) {
  let arr;
  if (Array.isArray(parsed)) arr = parsed;
  else if (Array.isArray(parsed?.runs)) arr = parsed.runs;
  else if (Array.isArray(parsed?.history)) arr = parsed.history;
  else return { ok: false, error: "Couldn't find a run list in this file." };

  const runs = arr.map(normalizeRun).filter(Boolean);
  return { ok: true, runs };
}

export const VALID_CHAR_KEYS = VALID_CHARACTERS;
