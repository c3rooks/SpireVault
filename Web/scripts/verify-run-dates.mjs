#!/usr/bin/env node
/**
 * Offline checks for lib/run-dates.js, the day maths behind the Recent Runs
 * date filter: day keys, quick picks, the mini calendar's month grid, labels.
 *
 * Run: node Web/scripts/verify-run-dates.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const D = await import(pathToFileURL(join(WEB, "lib", "run-dates.js")).href);

let passed = 0;
/** @param {string} label @param {() => void} fn */
function check(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/** Strips the thin / narrow no-break spaces ICU puts around range dashes. */
const plain = (s) => s.replace(/[   ]/g, " ");
const TODAY = "2026-11-18";

check("dayKey writes the local calendar day, zero-padded", () => {
  assert.equal(D.dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(D.dayKey(new Date(2026, 10, 18, 0, 0)), "2026-11-18");
  assert.equal(D.dayKey(null), "");
  assert.equal(D.dayKey(new Date("nope")), "");
});

check("isDayKey accepts only real days", () => {
  assert.equal(D.isDayKey("2026-02-28"), true);
  assert.equal(D.isDayKey("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(D.isDayKey("2028-02-29"), true);
  assert.equal(D.isDayKey("2026-13-01"), false);
  assert.equal(D.isDayKey("2026-1-01"), false);
  assert.equal(D.isDayKey(20261118), false);
});

check("addDays crosses months and years", () => {
  assert.equal(D.addDays("2026-11-30", 1), "2026-12-01");
  assert.equal(D.addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(D.addDays("2026-03-08", 7), "2026-03-15", "a DST change in between does not skew the day");
  assert.equal(D.addDays("bad", 1), "");
});

check("addMonths clamps to the shorter month", () => {
  assert.equal(D.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(D.addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(D.addMonths("2026-11-18", 12), "2027-11-18");
  assert.equal(D.addMonths("2026-12-15", 1), "2027-01-15");
});

check("month bounds", () => {
  assert.equal(D.startOfMonth(TODAY), "2026-11-01");
  assert.equal(D.endOfMonth(TODAY), "2026-11-30");
  assert.equal(D.endOfMonth("2028-02-10"), "2028-02-29");
  assert.equal(D.monthKey(TODAY), "2026-11");
});

check("normalizeRange orders the two picks", () => {
  assert.deepEqual(D.normalizeRange("2026-11-16", "2026-11-10"), { from: "2026-11-10", to: "2026-11-16" });
  assert.deepEqual(D.normalizeRange("2026-11-10", "2026-11-10"), { from: "2026-11-10", to: "2026-11-10" });
  assert.equal(D.normalizeRange("2026-11-10", "x"), null);
});

check("sanitizeRange drops anything malformed", () => {
  assert.deepEqual(D.sanitizeRange({ from: "2026-11-10", to: "2026-11-16", preset: "week" }), { from: "2026-11-10", to: "2026-11-16", preset: "week" });
  assert.deepEqual(D.sanitizeRange({ from: "2026-11-10", to: "2026-11-16", preset: "evil" }), { from: "2026-11-10", to: "2026-11-16" });
  assert.equal(D.sanitizeRange({ from: "2026-11-16", to: "2026-11-10" }), null, "backwards");
  assert.equal(D.sanitizeRange({ from: "2026-11-10" }), null);
  assert.equal(D.sanitizeRange("2026-11-10"), null);
  assert.equal(D.sanitizeRange(null), null);
});

check("quick picks: Today, Last 7 days (today and the six before), This month (1st to today)", () => {
  assert.deepEqual(D.presetRange("today", TODAY), { from: TODAY, to: TODAY, preset: "today" });
  assert.deepEqual(D.presetRange("week", TODAY), { from: "2026-11-12", to: TODAY, preset: "week" });
  assert.deepEqual(D.presetRange("month", TODAY), { from: "2026-11-01", to: TODAY, preset: "month" });
  assert.deepEqual(D.presetRange("week", "2026-03-03"), { from: "2026-02-25", to: "2026-03-03", preset: "week" });
  assert.equal(D.presetRange("year", TODAY), null);
  assert.deepEqual(D.DATE_PRESETS.map((p) => p.label), ["Today", "Last 7 days", "This month"]);
});

check("inRange is inclusive at both ends", () => {
  const r = { from: "2026-11-10", to: "2026-11-16" };
  assert.equal(D.inRange("2026-11-10", r), true);
  assert.equal(D.inRange("2026-11-16", r), true);
  assert.equal(D.inRange("2026-11-09", r), false);
  assert.equal(D.inRange("2026-11-17", r), false);
  assert.equal(D.inRange("", r), false);
  assert.equal(D.inRange("2026-11-12", null), false);
});

check("monthGrid: six full weeks starting on the week's first day", () => {
  // November 2026 starts on a Sunday.
  const sun = D.monthGrid(2026, 10, 0);
  assert.equal(sun.length, 6);
  assert.ok(sun.every((w) => w.length === 7));
  assert.deepEqual(sun[0][0], { key: "2026-11-01", inMonth: true });
  assert.deepEqual(sun[4][1], { key: "2026-11-30", inMonth: true });
  assert.deepEqual(sun[5][6], { key: "2026-12-12", inMonth: false });
  const mon = D.monthGrid(2026, 10, 1);
  assert.deepEqual(mon[0][0], { key: "2026-10-26", inMonth: false }, "Monday-first weeks lead with October");
  assert.deepEqual(mon[0][6], { key: "2026-11-01", inMonth: true });
  assert.equal(mon.flat().filter((d) => d.inMonth).length, 30);
});

check("countByDay tallies runs and wins per day", () => {
  const m = D.countByDay([
    { key: "2026-11-16", won: true },
    { key: "2026-11-16", won: false },
    { key: "2026-11-15", won: false },
    { key: "", won: true },
  ]);
  assert.deepEqual(m.get("2026-11-16"), { runs: 2, wins: 1 });
  assert.deepEqual(m.get("2026-11-15"), { runs: 1, wins: 0 });
  assert.equal(m.size, 2, "undated runs carry no dot");
});

check("weekStartFor: Sunday for the US, Monday for Britain", () => {
  assert.equal(D.weekStartFor("en-US"), 0);
  assert.equal(D.weekStartFor("en-GB"), 1);
  assert.equal(D.weekStartFor("not a locale!"), 0);
});

check("formatRange: short, with the year only outside this one", () => {
  assert.equal(plain(D.formatRange({ from: "2026-11-10", to: "2026-11-16" }, TODAY, "en-US")), "Nov 10 – 16");
  assert.equal(plain(D.formatRange({ from: "2026-10-28", to: "2026-11-03" }, TODAY, "en-US")), "Oct 28 – Nov 3");
  assert.equal(plain(D.formatRange({ from: "2026-11-16", to: "2026-11-16" }, TODAY, "en-US")), "Nov 16");
  assert.match(plain(D.formatRange({ from: "2025-12-28", to: "2026-01-03" }, TODAY, "en-US")), /Dec 28, 2025 – Jan 3, 2026/);
});

check("the chip names a quick pick, else the dates", () => {
  assert.equal(D.rangeChipLabel(null, TODAY, "en-US"), "Any date");
  assert.equal(D.rangeChipLabel(D.presetRange("week", TODAY), TODAY, "en-US"), "Last 7 days");
  assert.equal(D.rangeChipLabel({ from: TODAY, to: TODAY }, TODAY, "en-US"), "Today");
  assert.equal(plain(D.rangeChipLabel({ from: "2026-11-10", to: "2026-11-16" }, TODAY, "en-US")), "Nov 10 – 16");
});

check("ledger day dividers: Today, Yesterday, then the weekday and date", () => {
  assert.equal(D.dayGroupLabel(TODAY, TODAY, "en-US"), "Today");
  assert.equal(D.dayGroupLabel("2026-11-17", TODAY, "en-US"), "Yesterday");
  assert.equal(D.dayGroupLabel("2026-11-15", TODAY, "en-US"), "Sunday, Nov 15");
  assert.equal(D.dayGroupLabel("2025-11-15", TODAY, "en-US"), "Saturday, Nov 15, 2025");
});

check("screen-reader and heading labels", () => {
  assert.equal(D.dayLongLabel("2026-11-16", "en-US"), "Monday, November 16, 2026");
  assert.equal(D.monthLabel("2026-11-16", "en-US"), "November 2026");
  const names = D.weekdayNames(1, "en-US");
  assert.equal(names[0].long, "Monday");
  assert.equal(names[6].long, "Sunday");
  assert.equal(names[0].short, "M");
});

if (process.exitCode) {
  console.error(`verify-run-dates: FAILED (${passed} passed)`);
} else {
  console.log(`verify-run-dates: all ${passed} checks passed`);
}
