#!/usr/bin/env node
/**
 * Offline logic checks — no network, no deployed Worker, no KV.
 *
 * The sibling `verify-*.mjs` scripts drive a live server. These cover the pure
 * functions where a subtle mistake produces a plausible-looking wrong number
 * rather than an error, which is the worst kind of bug in analytics code:
 *
 *   · computeRetention      cohort windows, eligibility, activation backfill
 *   · computeIngestFunnel   stage ordering and auto-refresh exclusion
 *   · coop-intents          window validation, overlap matching, cleanup
 *
 * Run: node scripts/verify-offline.mjs   (or `npm run verify:offline`)
 *
 * The source under test is bundled with esbuild before import rather than
 * loaded through Node's TypeScript support: the Worker sources use
 * extensionless imports (`from "./coop-types"`), which esbuild and wrangler
 * resolve but Node's ESM loader does not. Bundling with the same tool the
 * deploy uses also means we are testing what actually ships.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const workDir = mkdtempSync(join(tmpdir(), "vault-verify-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

const entry = join(workDir, "entry.ts");
writeFileSync(
  entry,
  `export { computeRetention, computeIngestFunnel } from ${JSON.stringify(join(SRC, "admin"))};\n` +
    `export * as intents from ${JSON.stringify(join(SRC, "coop-intents"))};\n`
);

const bundle = join(workDir, "bundle.mjs");
execFileSync(
  "npx",
  ["esbuild", entry, "--bundle", "--format=esm", "--platform=neutral", `--outfile=${bundle}`, "--log-level=error"],
  { stdio: "inherit" }
);

const { computeRetention, computeIngestFunnel, intents } = await import(pathToFileURL(bundle).href);

const DAY = 86_400_000;
const HOUR = 3_600_000;

let passed = 0;

/**
 * Runs one assertion block and records the outcome.
 *
 * Must be awaited. Several checks are async, and a non-awaiting version
 * silently lets their rejections escape the try/catch — which aborts the whole
 * run on the first async failure instead of reporting every failure, and
 * counts the check as passed on the way out.
 */
async function check(label, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Minimal KV double. Supports the three operations the code under test uses.
 * Single-page listing only — asserts if anything paginates, so a future change
 * that needs a cursor fails loudly here instead of silently truncating.
 */
function makeKV(seedKeys = []) {
  const store = new Map(seedKeys.map((k) => [k, "1"]));
  return {
    _store: store,
    LOBBIES: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
      list: async ({ prefix, cursor }) => {
        assert.equal(cursor, undefined, "test fixture does not paginate");
        return {
          keys: [...store.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((name) => ({ name })),
          list_complete: true,
        };
      },
    },
  };
}

// ---------------------------------------------------------------- retention

{
  const NOW = new Date("2026-08-23T12:00:00Z");
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const daysAgo = (n) => ymd(new Date(NOW.getTime() - n * DAY));
  const at = (n) => new Date(NOW.getTime() - n * DAY).toISOString();

  // alice  40d old · active signup day, +3, +39   → D1 no,  D7 yes, D30 yes
  // bob    40d old · active signup day only       → never returned
  // carol  40d old · active signup day, +1        → D1 yes, D7 yes, D30 yes
  // dave    2d old · active signup day, +1        → D1 yes, D7/D30 not yet judgeable
  const A = "76561190000000001";
  const B = "76561190000000002";
  const C = "76561190000000003";
  const D = "76561190000000004";

  const env = makeKV([
    `seen:${daysAgo(40)}:${A}`, `seen:${daysAgo(37)}:${A}`, `seen:${daysAgo(1)}:${A}`,
    `seen:${daysAgo(40)}:${B}`,
    `seen:${daysAgo(40)}:${C}`, `seen:${daysAgo(39)}:${C}`,
    `seen:${daysAgo(2)}:${D}`,  `seen:${daysAgo(1)}:${D}`,
    `funnel:ingest-first:${A}`,
    `runs:${C}`, // activated before the marker existed — backfill path
  ]);

  const users = [
    { steamID: A, firstSeen: at(40) },
    { steamID: B, firstSeen: at(40) },
    { steamID: C, firstSeen: at(40) },
    { steamID: D, firstSeen: at(2) },
  ];

  const r = await computeRetention(env, users, NOW);
  const w = (arr, days) => arr.find((x) => x.days === days);

  await check("activation counts both the marker and the runs: backfill", () => {
    assert.equal(r.totals.users, 4);
    assert.equal(r.totals.activated, 2);
    assert.equal(r.totals.neverActivated, 2);
  });

  await check("one-and-done counts users with exactly one active day", () => {
    assert.equal(r.totals.oneAndDone, 1);
  });

  await check("D1 counts only returns on the day after signup", () => {
    assert.deepEqual(w(r.allWindows, 1), { days: 1, eligible: 4, returned: 2 });
  });

  await check("windows exclude users too new to have completed them", () => {
    // Dave is 2 days old: judgeable at D1, not at D7 or D30.
    assert.deepEqual(w(r.allWindows, 7), { days: 7, eligible: 3, returned: 2 });
    assert.deepEqual(w(r.allWindows, 30), { days: 30, eligible: 3, returned: 2 });
  });

  await check("activated-only denominator is the activated cohort", () => {
    assert.deepEqual(w(r.activatedWindows, 30), { days: 30, eligible: 2, returned: 2 });
  });

  await check("a too-new cohort reports an empty denominator, not 0%", () => {
    const young = r.cohorts.find((c) => c.signups === 1);
    assert.equal(w(young.windows, 30).eligible, 0);
  });

  await check("same-week signups collapse into one cohort", () => {
    const old = r.cohorts.find((c) => c.signups === 3);
    assert.ok(old);
    assert.equal(old.activated, 2);
  });

  await check("cohorts are newest-first", () => {
    const starts = r.cohorts.map((c) => c.weekStart);
    assert.deepEqual(starts, [...starts].sort().reverse());
  });

  await check("empty input does not throw or divide by zero", async () => {
    const empty = await computeRetention(makeKV(), [], NOW);
    assert.equal(empty.totals.users, 0);
    assert.equal(empty.historyDays, 0);
    assert.ok(empty.allWindows.every((x) => x.eligible === 0));
  });
}

// ------------------------------------------------------------ ingest funnel

await check("entry beacons sum and stage conversion is computed", () => {
  const f = computeIngestFunnel({
    "ingest-picker-opened": 40,
    "ingest-drop-folder": 10,
    "ingest-files-chosen": 30,
    "ingest-runs-committed": 12,
    "cloud-runs-uploaded": 11,
    "ingest-no-plausible": 15,
    "ingest-runs-zero": 3,
    // Background auto-refresh must not inflate the interactive funnel.
    "ingest-runs-committed-auto": 900,
    "ingest-files-chosen-auto": 900,
  });
  assert.equal(f.stages[0].count, 50);
  assert.equal(f.stages[0].pctOfPrev, null);
  assert.equal(f.stages[1].count, 30);
  assert.equal(f.stages[1].pctOfPrev, 60);
  assert.equal(f.stages[2].count, 12);
  assert.equal(f.stages[2].pctOfPrev, 40);
  assert.equal(f.biggestLoss.key, "ingest-no-plausible");
  assert.ok(f.hasData);
});

await check("an empty funnel reports no data instead of zeros", () => {
  const f = computeIngestFunnel({});
  assert.equal(f.hasData, false);
  assert.equal(f.biggestLoss, null);
  assert.equal(f.stages[1].pctOfPrev, null);
});

// ------------------------------------------------------------------ intents

{
  const BASE = Date.now();
  const iso = (offset) => new Date(BASE + offset).toISOString();
  const A = "76561190000000001";
  const B = "76561190000000002";
  const C = "76561190000000003";

  await (async () => {
    const env = makeKV();
    const reject = async (label, input, expected) => {
      const r = await intents.addIntentWindow(env, A, input);
      await check(label, () => {
        assert.equal(r.ok, false);
        assert.equal(r.error, expected);
      });
    };

    await reject("rejects a window under 30 minutes",
      { startsAt: iso(HOUR), endsAt: iso(HOUR + 10 * 60_000) }, "window_too_short");
    await reject("rejects a window over 12 hours",
      { startsAt: iso(HOUR), endsAt: iso(HOUR + 20 * HOUR) }, "window_too_long");
    await reject("rejects a window that already ended",
      { startsAt: iso(-5 * HOUR), endsAt: iso(-4 * HOUR) }, "window_in_past");
    await reject("rejects scheduling beyond the lead limit",
      { startsAt: iso(40 * DAY), endsAt: iso(40 * DAY + 2 * HOUR) }, "window_too_far_out");
    await reject("rejects an end before its start",
      { startsAt: iso(2 * HOUR), endsAt: iso(HOUR) }, "invalid_window");

    const inProgress = await intents.addIntentWindow(env, A, {
      startsAt: iso(-HOUR), endsAt: iso(2 * HOUR),
    });
    await check("accepts a window already under way", () => assert.equal(inProgress.ok, true));
  })();

  await (async () => {
    const env = makeKV();
    await intents.addIntentWindow(env, A, { startsAt: iso(4 * HOUR), endsAt: iso(7 * HOUR), goal: "heart" });
    await intents.addIntentWindow(env, B, { startsAt: iso(5 * HOUR), endsAt: iso(9 * HOUR), goal: "heart" });
    // Overlaps A by only 15 minutes — below the floor.
    await intents.addIntentWindow(env, C, { startsAt: iso(6 * HOUR + 45 * 60_000), endsAt: iso(10 * HOUR) });

    const forA = await intents.findIntentMatches(env, A);
    await check("matches on overlap and reports the intersection", () => {
      assert.equal(forA.length, 1);
      assert.equal(forA[0].withSteamId, B);
      assert.equal(forA[0].overlapMinutes, 120);
      assert.equal(Date.parse(forA[0].overlapStartsAt), BASE + 5 * HOUR);
    });

    await check("filters overlaps below the 30-minute floor", async () => {
      const forC = await intents.findIntentMatches(env, C);
      assert.ok(forC.every((m) => m.withSteamId !== A));
    });

    await check("matching is symmetric", async () => {
      const forB = await intents.findIntentMatches(env, B);
      assert.ok(forB.some((m) => m.withSteamId === A));
    });

    await check("a user never matches themselves", () => {
      assert.ok(forA.every((m) => m.withSteamId !== A));
    });
  })();

  await (async () => {
    const env = makeKV();
    await intents.addIntentWindow(env, A, {
      startsAt: iso(HOUR), endsAt: iso(5 * HOUR), goal: "heart", ascensionMin: 15, ascensionMax: 20,
    });
    await intents.addIntentWindow(env, B, { startsAt: iso(HOUR), endsAt: iso(5 * HOUR), goal: "casual" });
    await intents.addIntentWindow(env, C, {
      startsAt: iso(HOUR), endsAt: iso(5 * HOUR), goal: "any", ascensionMin: 0, ascensionMax: 5,
    });
    await check("incompatible goal and ascension range are both filtered", async () => {
      assert.equal((await intents.findIntentMatches(env, A)).length, 0);
    });
  })();

  await (async () => {
    const env = makeKV();
    await intents.addIntentWindow(env, A, { startsAt: iso(HOUR), endsAt: iso(5 * HOUR), goal: "heart" });
    await intents.addIntentWindow(env, B, { startsAt: iso(HOUR), endsAt: iso(5 * HOUR) });
    await check("an unset goal is no constraint rather than a mismatch", async () => {
      assert.equal((await intents.findIntentMatches(env, A)).length, 1);
    });
  })();

  await (async () => {
    const env = makeKV();
    for (let i = 1; i <= 5; i++) {
      await intents.addIntentWindow(env, A, {
        startsAt: iso(i * DAY), endsAt: iso(i * DAY + 2 * HOUR),
      });
    }
    const overflow = await intents.addIntentWindow(env, A, {
      startsAt: iso(6 * DAY), endsAt: iso(6 * DAY + 2 * HOUR),
    });
    await check("caps the number of queued windows", () => assert.equal(overflow.error, "too_many_windows"));

    const row = await intents.readIntent(env, A);
    await check("windows come back sorted by start time", () => {
      assert.equal(row.windows.length, 5);
      assert.ok(row.windows.every((w, i, a) => i === 0 || w.startsAt >= a[i - 1].startsAt));
    });

    for (const w of row.windows) await intents.removeIntentWindow(env, A, w.id);
    await check("the row and its index entry are removed once empty", async () => {
      assert.equal(await intents.readIntent(env, A), null);
      assert.equal(await intents.countScheduledPlayers(env), 0);
      assert.ok(![...env._store.keys()].some((k) => /^coop:intent:\d{17}$/.test(k)));
    });

    await check("removing an unknown window reports not_found", async () => {
      assert.equal((await intents.removeIntentWindow(env, A, "deadbeef")).error, "not_found");
    });
  })();

  await (async () => {
    const env = makeKV();
    await intents.addIntentWindow(env, A, {
      startsAt: iso(HOUR), endsAt: iso(5 * HOUR), goal: "heart", note: "private note",
    });
    const slots = await intents.upcomingIntents(env);
    await check("the public board carries no Steam ID and no free text", () => {
      assert.equal(slots.length, 1);
      assert.equal(slots[0].steamId, undefined);
      assert.equal(slots[0].note, undefined);
      assert.equal(slots[0].goal, "heart");
    });
  })();

  await (async () => {
    const env = makeKV();
    await intents.addIntentWindow(env, A, {
      startsAt: iso(HOUR), endsAt: iso(5 * HOUR),
      note: "x".repeat(500) + "\u0000 control chars",
    });
    const note = (await intents.readIntent(env, A)).windows[0].note;
    await check("notes are clamped and stripped of control characters", () => {
      assert.ok(note.length <= 140);
      assert.ok(!note.includes("\u0000"));
    });
  })();
}

if (process.exitCode) {
  console.error("offline verification FAILED");
} else {
  console.log(`offline verification passed — ${passed} checks`);
}
