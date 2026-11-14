#!/usr/bin/env node
/**
 * End-to-end check of every feature of the new look ("Inked Codex", ?ui=next)
 * driven with the player's own STS2 run history and real interactions.
 *
 * Runs are fed through the app's own Import button (the folder picker), read
 * from the STS2 save folder at test time. They are staged as hard links in a
 * temp directory outside the repo (Chromium does not follow symlinks in a
 * folder upload) and the staging directory is deleted on exit. Nothing from
 * the save folder is written into the repo.
 *
 * Expected numbers (totals, per character, per ascension, streaks, floors)
 * are computed here straight from the raw .run JSON, independently of the
 * app's parser and stats engine.
 *
 * Every check runs (no stop on first failure). Each one records console
 * errors, uncaught exceptions and failed same-origin requests (/api/* is
 * expected to 404 on the static dev server) and saves a screenshot when it
 * fails.
 *
 *   node scripts/verify-ui-next-e2e.mjs
 *   node scripts/verify-ui-next-e2e.mjs --base-url http://127.0.0.1:8788 --out /tmp/e2e
 *   node scripts/verify-ui-next-e2e.mjs --only runs,phone      (substring match on check names)
 *   STS2_HISTORY=/path/to/history node scripts/verify-ui-next-e2e.mjs
 *
 * --only needs "1. import" for the desktop checks to see real data (they
 * import on their own if it was skipped). Modules live in scripts/e2e/.
 */

import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, OUT, SUBSET_SIZE } from "./e2e/config.mjs";
import { findHistoryDir, readRuns, charKey, endOf, expectations, stageRuns } from "./e2e/history.mjs";
import { results, session } from "./e2e/harness.mjs";
import { coreChecks } from "./e2e/checks-core.mjs";
import { surfaceChecks } from "./e2e/checks-surfaces.mjs";
import { sessionChecks } from "./e2e/checks-sessions.mjs";

/** @param {import("playwright").Browser} browser @param {any} data @param {string} historyDir @param {any} fullExp */
async function run(browser, data, historyDir, fullExp) {
  const labels = JSON.parse(await (await fetch(`${BASE}/assets/sts2/labels.json`)).text());
  const desk = await session(browser);
  const ctx = {
    browser, page: desk.page, data, exp: data.exp, fullExp, historyDir,
    knownCards: new Set(Object.values(labels.cards || {})),
    knownRelics: new Set(Object.values(labels.relics || {})),
  };
  await coreChecks(ctx);
  await surfaceChecks(ctx);
  await desk.context.close();
  await sessionChecks(ctx);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  const historyDir = findHistoryDir();
  const allRuns = readRuns(historyDir);
  const subset = allRuns.slice(0, SUBSET_SIZE);
  for (const fool of allRuns.filter((r) => charKey(r) === "fool")) if (!subset.includes(fool)) subset.push(fool);
  const exp = expectations(subset);
  const fullExp = expectations(allRuns);
  const stage = stageRuns(historyDir, subset);
  // The staged hard links must not outlive the run, even on Ctrl-C.
  process.once("SIGINT", () => { rmSync(stage.root, { recursive: true, force: true }); process.exit(130); });
  const endTimes = new Map(subset.map((r) => [r.json.start_time, endOf(r)]));
  process.stdout.write(`verify-ui-next-e2e: ${BASE}, ${subset.length} runs staged (${exp.foolRuns.length} as The Fool), full history ${allRuns.length} runs\n`);
  process.stdout.write(`expected: ${exp.total} runs, ${exp.wins} wins (${exp.winratePct}%), peak A${exp.peak}, most played ${exp.mostPlayed}\n\n`);
  const browser = await chromium.launch();
  try {
    await run(browser, { dir: stage.dir, exp, runs: subset, endTimes }, historyDir, fullExp);
  } finally {
    await browser.close();
    rmSync(stage.root, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed · details: ${join(OUT, "results.json")}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`verify-ui-next-e2e crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(2);
});
