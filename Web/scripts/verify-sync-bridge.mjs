#!/usr/bin/env node
/**
 * Offline checks for SpireVault Sync on the page side (lib/sync-bridge-core.js):
 *
 *   · new runs from the extension join the runs already loaded, never replace them
 *   · the run in progress stays on screen until that run shows up finished
 *   · the record of files already taken in survives storage and bad input
 *   · only desktop Chromium browsers are offered the extension
 *   · the status line and the pull back-off say what they should
 *
 * The extension's own checks are in Extension/tests (node --test).
 *
 * Run: node Web/scripts/verify-sync-bridge.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const Core = await import(join(WEB, "lib", "sync-bridge-core.js"));
const { parseSTS2Run } = await import(join(WEB, "lib", "sts2-run-parser.js"));

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

const run = (id, extra = {}) => ({ id: `sts2-${id}`, startedAt: new Date(id * 1000), endedAt: new Date(id * 1000 + 60_000), ...extra });
const ids = (runs) => runs.map((r) => r.id).sort();
const key = (n, profile = "profile1") => `${profile}/saves/history/${n}.run`;

// ---- joining new runs to the loaded ones --------------------------------------------

check("new runs are added to the loaded ones", () => {
  const merged = Core.mergeWithLoaded([run(30)], { loaded: [run(10), run(20)], live: null });
  assert.deepEqual(ids(merged), ["sts2-10", "sts2-20", "sts2-30"]);
});

check("a run read again from disk replaces the loaded copy, once", () => {
  const fresh = run(20, { from: "disk" });
  const merged = Core.mergeWithLoaded([fresh], { loaded: [run(10), run(20, { from: "steam copy" })], live: null });
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.id === "sts2-20").from, "disk");
});

check("nothing loaded: the new runs are the whole set, and the inputs are not changed", () => {
  const fresh = [run(1), run(2)];
  const loaded = [];
  const merged = Core.mergeWithLoaded(fresh, { loaded, live: null });
  assert.deepEqual(ids(merged), ["sts2-1", "sts2-2"]);
  assert.notEqual(merged, fresh);
  assert.equal(fresh.length, 2);
  assert.equal(loaded.length, 0);
});

check("the run in progress stays while the new runs are older ones", () => {
  const live = run(50, { inProgress: true });
  const merged = Core.mergeWithLoaded([run(30)], { loaded: [run(10)], live });
  assert.ok(merged.includes(live));
});

check("the run in progress goes when that same run arrives finished", () => {
  const live = run(50, { inProgress: true });
  const merged = Core.mergeWithLoaded([run(50)], { loaded: [run(10)], live });
  assert.deepEqual(ids(merged), ["sts2-10", "sts2-50"]);
  assert.equal(merged.some((r) => r.inProgress), false);
});

check("the run in progress goes when a later run has finished", () => {
  const live = run(50, { inProgress: true });
  const merged = Core.mergeWithLoaded([run(60)], { loaded: [], live });
  assert.equal(merged.some((r) => r.inProgress), false);
});

check("runs parsed from real save files merge by the id the parser gives them", () => {
  /** A save file shaped like the game's: the fields the parser needs and no more. */
  const fixture = {
    schema_version: 9, build_id: "v0.104.0", game_mode: "standard", seed: "TESTSEED12", ascension: 8,
    start_time: 1777000000, run_time: 1200, win: true, was_abandoned: false,
    killed_by_encounter: "NONE.NONE", killed_by_event: "NONE.NONE", acts: [], modifiers: [], map_point_history: [],
    players: [{ character: "CHARACTER.IRONCLAD", deck: [], relics: [] }],
  };
  const loaded = parseSTS2Run(fixture, "1777000000.run");
  const again = parseSTS2Run(fixture, "1777000000.run");
  const newer = parseSTS2Run({ ...fixture, start_time: fixture.start_time + 3600 }, "1777003600.run");
  assert.ok(loaded && again && newer, "the fixture parses");
  const merged = Core.mergeWithLoaded([again, newer], { loaded: [loaded], live: null });
  assert.equal(merged.length, 2);
});

// ---- the record of files already taken in ------------------------------------------

check("delivered and skipped files are recorded; files gone from disk are forgotten", () => {
  const known = { [key(1)]: [10, 1], [key(2)]: [10, 2] };
  const next = Core.updateKnown(known, {
    files: [{ key: key(3), size: 30, mtime: 3 }],
    skipped: [{ key: key(4), size: 9_000_000, mtime: 4 }],
    gone: [key(1)],
  });
  assert.deepEqual(next, { [key(2)]: [10, 2], [key(3)]: [30, 3], [key(4)]: [9_000_000, 4] });
  assert.deepEqual(known, { [key(1)]: [10, 1], [key(2)]: [10, 2] }, "the old record is not changed");
});

check("entries that are not run files never enter the record", () => {
  const next = Core.updateKnown({}, { files: [{ key: "../../etc/passwd", size: 1, mtime: 1 }, { key: key(1), size: "1", mtime: 1 }, null] });
  assert.deepEqual(next, {});
});

check("a stored record is read back entry by entry; damage reads as empty", () => {
  const good = { [key(1)]: [10, 1], [key(2, "modded/profile1")]: [20, 2] };
  assert.deepEqual(Core.parseKnown(JSON.stringify(good)), good);
  assert.deepEqual(Core.parseKnown("not json"), {});
  assert.deepEqual(Core.parseKnown("[1,2]"), {});
  assert.deepEqual(Core.parseKnown(null), {});
  assert.deepEqual(Core.parseKnown(JSON.stringify({ [key(1)]: [10, 1], "x.run": [1, 1], [key(2)]: [-5, 1], [key(3)]: "no" })), { [key(1)]: [10, 1] });
});

check("a stored record is thrown away when the page holds fewer runs than it did, or the epoch moved", () => {
  const record = { epoch: 1, count: 729, files: {} };
  assert.equal(Core.isRecordStale(record, { epoch: 1, runCount: 729 }), false);
  assert.equal(Core.isRecordStale(record, { epoch: 1, runCount: 740 }), false, "more runs (from the Steam copy, say) is fine");
  assert.equal(Core.isRecordStale(record, { epoch: 1, runCount: 700 }), true, "runs were lost since: read the folder in full");
  assert.equal(Core.isRecordStale(record, { epoch: 2, runCount: 729 }), true);
  assert.equal(Core.isRecordStale({ epoch: 1, files: {} }, { epoch: 1, runCount: 5 }), false, "a record without a count is kept");
  assert.equal(Core.isRecordStale(null, { epoch: 1, runCount: 5 }), true);
  assert.equal(Core.isRecordStale("x", { epoch: 1, runCount: 5 }), true);
});

check("only files that are JSON and named like a run are handed to the import", () => {
  const ok = { key: key(1), name: "1.run", size: 2, mtime: 1, text: "{}" };
  const files = [
    ok,
    { key: key(2), name: "2.run", size: 9, mtime: 1, text: '{"half":' },
    { key: key(3), name: "../3.run", size: 2, mtime: 1, text: "{}" },
    { key: "profile1/saves/current_run.save", name: "current_run.save", size: 2, mtime: 1, text: "{}" },
    { key: key(4), name: "4.run", size: 2, mtime: 1, text: 42 },
    null,
  ];
  assert.deepEqual(Core.readableFiles(files), [ok]);
  assert.deepEqual(Core.readableFiles("nope"), []);
});

// ---- which browsers are offered the extension ----------------------------------------

const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/157.0.0.0 Mobile/15E148 Safari/604.1",
};

check("desktop Chrome, Edge and other Chromium browsers are offered the extension", () => {
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.chromeMac }), true);
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.edgeWin }), true);
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.chromeMac, userAgentData: { mobile: false, brands: [{ brand: "Chromium" }, { brand: "Brave" }] } }), true);
});

check("Safari, Firefox and phones keep the manual import", () => {
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.safariMac }), false);
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.firefox }), false);
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.chromeAndroid }), false);
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.chromeIphone }), false);
  assert.equal(Core.isSupportedBrowser({ userAgent: UA.chromeAndroid, userAgentData: { mobile: true, brands: [{ brand: "Chromium" }] } }), false);
  assert.equal(Core.isSupportedBrowser({}), false);
});

check("Edge is sent to its own store, everything else to the Chrome store", () => {
  assert.equal(Core.storeFor({ userAgent: UA.edgeWin }), "edge");
  assert.equal(Core.storeFor({ userAgent: UA.chromeMac, userAgentData: { brands: [{ brand: "Microsoft Edge" }] } }), "edge");
  assert.equal(Core.storeFor({ userAgent: UA.chromeMac }), "chrome");
});

// ---- wording and pacing -----------------------------------------------------------------

check("ages read in plain words", () => {
  const now = 1_800_000_000_000;
  assert.equal(Core.agoLabel(now - 20_000, now), "just now");
  assert.equal(Core.agoLabel(now - 2 * 60_000, now), "2 min ago");
  assert.equal(Core.agoLabel(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(Core.agoLabel(now - 24 * 3_600_000, now), "1 day ago");
  assert.equal(Core.agoLabel(now - 72 * 3_600_000, now), "3 days ago");
  assert.equal(Core.runsLabel(1), "1 run");
  assert.equal(Core.runsLabel(732), "732 runs");
});

check("the status line shows only while sync is live", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(Core.statusLine({ phase: "connected", lastOkAt: now - 2 * 60_000 }, { count: 732, now }), {
    live: true, stale: false, main: "Synced 2 min ago", sub: "732 runs",
  });
  assert.equal(Core.statusLine({ phase: "reading", lastOkAt: 0 }, { count: 732, now }), null);
  assert.equal(Core.statusLine({ phase: "needs-switch", lastOkAt: now }, { count: 732, now }), null);
  assert.equal(Core.statusLine({ phase: "connected", lastOkAt: now - Core.LIVE_FOR_MS - 1 }, { count: 732, now }), null, "a sync that stopped answering is not live");
});

check("failed pulls of the Steam copy back off, up to a ceiling", () => {
  const pace = { everyMs: 5 * 60_000, maxMs: 30 * 60_000 };
  assert.equal(Core.nextPullAt({ lastAt: 1000, failures: 0 }, pace), 1000 + 5 * 60_000);
  assert.equal(Core.nextPullAt({ lastAt: 1000, failures: 1 }, pace), 1000 + 10 * 60_000);
  assert.equal(Core.nextPullAt({ lastAt: 1000, failures: 2 }, pace), 1000 + 20 * 60_000);
  assert.equal(Core.nextPullAt({ lastAt: 1000, failures: 9 }, pace), 1000 + 30 * 60_000);
});

if (!process.exitCode) console.log(`✓ SpireVault Sync page checks passed (${passed})`);
