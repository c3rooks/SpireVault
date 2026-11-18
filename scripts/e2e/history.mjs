// The player's STS2 run history: locate it, read it, stage a subset for the
// folder picker, and compute the numbers the UI must show — straight from the
// raw .run JSON, independent of the app's parser and stats engine.

import { existsSync, linkSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { arg, RELIC_MIN_RUNS, RELIC_TOP_N } from "./config.mjs";

export function findHistoryDir() {
  if (process.env.STS2_HISTORY) return process.env.STS2_HISTORY;
  const custom = arg("history", "");
  if (custom) return custom;
  const steam = join(os.homedir(), "Library", "Application Support", "SlayTheSpire2", "steam");
  if (!existsSync(steam)) throw new Error(`no STS2 save folder at ${steam}; pass --history`);
  for (const id of readdirSync(steam)) {
    const dir = join(steam, id, "profile1", "saves", "history");
    if (existsSync(dir)) return dir;
  }
  throw new Error("no profile1/saves/history folder found; pass --history");
}

/** @param {string} dir */
export function readRuns(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".run"))
    .map((name) => ({ name, json: JSON.parse(readFileSync(join(dir, name), "utf8")) }))
    .sort((a, b) => b.json.start_time - a.json.start_time);
}

export const charKey = (run) => String(run.json.players?.[0]?.character || "").replace(/^CHARACTER\./, "").toLowerCase();
export const floorsOf = (run) => (run.json.map_point_history || []).reduce((n, act) => n + (Array.isArray(act) ? act.length : 0), 0);
export const endOf = (run) => run.json.start_time + (run.json.run_time || 0);

/** Independent expectations from raw .run JSON. @param {Array<{name: string, json: any}>} runs */
export function expectations(runs) {
  const total = runs.length;
  const wins = runs.filter((r) => r.json.win === true).length;
  const byChar = {};
  const byAsc = {};
  const relicRuns = new Map();
  for (const run of runs) {
    const c = charKey(run);
    byChar[c] = byChar[c] || { runs: 0, wins: 0 };
    byChar[c].runs += 1;
    if (run.json.win) byChar[c].wins += 1;
    const mode = String(run.json.game_mode || "").toLowerCase();
    if (!mode.includes("blitz") && !mode.includes("dread")) {
      const a = Math.min(20, Math.max(0, run.json.ascension | 0));
      byAsc[a] = byAsc[a] || { runs: 0, wins: 0 };
      byAsc[a].runs += 1;
      if (run.json.win) byAsc[a].wins += 1;
    }
    for (const relic of new Set((run.json.players?.[0]?.relics || []).map((r) => r.id))) relicRuns.set(relic, (relicRuns.get(relic) || 0) + 1);
  }
  const newestFirst = runs.slice().sort((a, b) => endOf(b) - endOf(a));
  const last10 = newestFirst.slice(0, 10);
  let lossStreak = 0;
  for (const run of newestFirst) { if (run.json.win) break; lossStreak += 1; }
  let best = 0;
  let cur = 0;
  for (const run of newestFirst.slice().reverse()) { cur = run.json.win ? cur + 1 : 0; best = Math.max(best, cur); }
  const bestChar = Object.entries(byChar).filter(([, b]) => b.runs >= 3).sort((a, b) => b[1].wins / b[1].runs - a[1].wins / a[1].runs)[0];
  const mostPlayed = Object.entries(byChar).sort((a, b) => b[1].runs - a[1].runs)[0][0];
  const peak = Math.max(...Object.keys(byAsc).map(Number));
  const tier = (lo, hi) => runs.filter((r) => { const a = r.json.ascension | 0; return a >= lo && a <= hi; }).length;
  return {
    total, wins, losses: total - wins, winratePct: ((wins / total) * 100).toFixed(1),
    byChar, byAsc, peak, bestChar: bestChar ? bestChar[0] : null, mostPlayed,
    last10: { wins: last10.filter((r) => r.json.win).length, losses: last10.filter((r) => !r.json.win).length },
    lossStreak: newestFirst[0]?.json.win ? 0 : lossStreak, bestStreak: best,
    bestFloor: Math.max(...runs.map(floorsOf)),
    relicCount: Math.min(RELIC_TOP_N, [...relicRuns.values()].filter((n) => n >= RELIC_MIN_RUNS).length),
    // The Runs ascension chips use the Ascensions tab's tiers (lib/ascension-info.js).
    tiers: { a0: tier(0, 0), early: tier(1, 3), mid: tier(4, 6), expert: tier(7, 9), master: tier(10, 10) },
    newestWin: newestFirst.find((r) => r.json.win) || null,
    foolRuns: runs.filter((r) => charKey(r) === "fool"),
    modes: [...new Set(runs.map((r) => r.json.game_mode))],
  };
}

/** Hard-links the chosen runs into <tmp>/history (copies if links fail). */
export function stageRuns(historyDir, runs) {
  const root = mkdtempSync(join(os.tmpdir(), "sv-e2e-"));
  const dir = join(root, "history");
  mkdirSync(dir);
  for (const run of runs) {
    try { linkSync(join(historyDir, run.name), join(dir, run.name)); }
    catch { copyFileSync(join(historyDir, run.name), join(dir, run.name)); }
  }
  return { root, dir };
}
