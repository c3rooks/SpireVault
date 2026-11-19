// Calendar-day helpers for the Recent Runs date filter ("go by date").
//
// Pure: no DOM, no app state. A day is a local calendar day written as a
// "YYYY-MM-DD" key, so keys compare as strings and survive JSON. A range is
// { from, to } with from <= to, both inclusive, plus the quick pick it came
// from (preset) when there was one, so the chip can say "Last 7 days".
//
// Used by script.js (filtering, ledger day dividers, the count line) and by
// lib/ui/runs-calendar.js (the mini calendar). Checked offline by
// scripts/verify-run-dates.mjs.

/** @typedef {"today"|"week"|"month"} DatePresetId */
/** @typedef {{ from: string, to: string, preset?: DatePresetId }} DayRange */
/** @typedef {{ key: string, inMonth: boolean }} GridDay */

/** The calendar's quick picks, in the order they are shown. */
export const DATE_PRESETS = Object.freeze([
  Object.freeze({ id: /** @type {DatePresetId} */ ("today"), label: "Today" }),
  Object.freeze({ id: /** @type {DatePresetId} */ ("week"), label: "Last 7 days" }),
  Object.freeze({ id: /** @type {DatePresetId} */ ("month"), label: "This month" }),
]);

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GRID_WEEKS = 6;

/** @param {number} n @returns {string} */
const pad2 = (n) => String(n).padStart(2, "0");

/**
 * The local calendar day of a date, or "" for a missing / invalid one.
 * @param {Date|null|undefined} date
 * @returns {string}
 */
export function dayKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** @param {unknown} value @returns {value is string} */
export function isDayKey(value) {
  if (typeof value !== "string") return false;
  const m = KEY_RE.exec(value);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d) === value;
}

/**
 * Local midnight of a day key, or null when the key is not a real day.
 * @param {string} key
 * @returns {Date|null}
 */
export function parseDayKey(key) {
  if (!isDayKey(key)) return null;
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** @param {string} key @param {number} days @returns {string} */
export function addDays(key, days) {
  const d = parseDayKey(key);
  if (!d) return "";
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

/**
 * The same day of the month `months` away, clamped to that month's length
 * (Jan 31 + 1 month = Feb 28/29).
 * @param {string} key @param {number} months @returns {string}
 */
export function addMonths(key, months) {
  const d = parseDayKey(key);
  if (!d) return "";
  const first = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return dayKey(new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last)));
}

/** @param {string} key @returns {string} the 1st of key's month */
export function startOfMonth(key) {
  return isDayKey(key) ? `${key.slice(0, 8)}01` : "";
}

/** @param {string} key @returns {string} the last day of key's month */
export function endOfMonth(key) {
  const d = parseDayKey(key);
  return d ? dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 0)) : "";
}

/** "2026-11" for any day in November 2026. @param {string} key */
export function monthKey(key) {
  return isDayKey(key) ? key.slice(0, 7) : "";
}

/**
 * A range from two days picked in either order.
 * @param {string} a @param {string} b @param {DatePresetId} [preset]
 * @returns {DayRange|null}
 */
export function normalizeRange(a, b, preset) {
  if (!isDayKey(a) || !isDayKey(b)) return null;
  const [from, to] = a <= b ? [a, b] : [b, a];
  return preset ? { from, to, preset } : { from, to };
}

/**
 * Accepts only a well-formed range (from <= to, real days); anything else is
 * "no date filter".
 * @param {unknown} value
 * @returns {DayRange|null}
 */
export function sanitizeRange(value) {
  if (!value || typeof value !== "object") return null;
  const { from, to, preset } = /** @type {Record<string, unknown>} */ (value);
  if (!isDayKey(from) || !isDayKey(to) || from > to) return null;
  const isPreset = DATE_PRESETS.some((p) => p.id === preset);
  return isPreset ? { from, to, preset: /** @type {DatePresetId} */ (preset) } : { from, to };
}

/**
 * The range a quick pick stands for on `today`.
 * @param {string} id @param {string} today
 * @returns {DayRange|null}
 */
export function presetRange(id, today) {
  if (!isDayKey(today)) return null;
  if (id === "today") return { from: today, to: today, preset: "today" };
  if (id === "week") return { from: addDays(today, -6), to: today, preset: "week" };
  if (id === "month") return { from: startOfMonth(today), to: today, preset: "month" };
  return null;
}

/** @param {string} key @param {DayRange|null} range */
export function inRange(key, range) {
  return !!range && isDayKey(key) && key >= range.from && key <= range.to;
}

/** @param {DayRange|null} a @param {DayRange|null} b */
export function sameRange(a, b) {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to;
}

/**
 * Six weeks of days covering one month, starting on the locale's first day of
 * the week. Six rows always, so the calendar never changes height between
 * months.
 * @param {number} year
 * @param {number} month  0-11
 * @param {number} firstDow  0 = Sunday … 6 = Saturday
 * @returns {GridDay[][]}
 */
export function monthGrid(year, month, firstDow = 0) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - firstDow + 7) % 7;
  const weeks = [];
  for (let w = 0; w < GRID_WEEKS; w += 1) {
    const week = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(year, month, 1 - lead + w * 7 + d);
      week.push(Object.freeze({ key: dayKey(date), inMonth: date.getMonth() === month }));
    }
    weeks.push(Object.freeze(week));
  }
  return weeks;
}

/**
 * Runs and wins per day.
 * @param {Iterable<{ key: string, won: boolean }>} entries
 * @returns {Map<string, { runs: number, wins: number }>}
 */
export function countByDay(entries) {
  const map = new Map();
  for (const { key, won } of entries) {
    if (!isDayKey(key)) continue;
    const prev = map.get(key) || { runs: 0, wins: 0 };
    map.set(key, { runs: prev.runs + 1, wins: prev.wins + (won ? 1 : 0) });
  }
  return map;
}

/**
 * The locale's first day of the week (0 = Sunday … 6 = Saturday). Sunday when
 * the browser cannot say.
 * @param {string} [locale]
 * @returns {number}
 */
export function weekStartFor(locale) {
  try {
    const loc = new Intl.Locale(locale || Intl.DateTimeFormat().resolvedOptions().locale);
    // Chrome/Safari ship getWeekInfo(); older engines a weekInfo getter.
    const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo;
    const first = info && Number(info.firstDay);
    return first >= 1 && first <= 7 ? first % 7 : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {Date} d @param {Intl.DateTimeFormatOptions} opts @param {string} [locale]
 */
function fmt(d, opts, locale) {
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/**
 * "Nov 10 – 16", "Oct 28 – Nov 3", "Nov 16"; the year joins in when the
 * range is not all in today's year.
 * @param {DayRange} range @param {string} today @param {string} [locale]
 * @returns {string}
 */
export function formatRange(range, today, locale) {
  const a = parseDayKey(range.from);
  const b = parseDayKey(range.to);
  if (!a || !b) return "";
  const thisYear = today.slice(0, 4);
  const showYear = range.from.slice(0, 4) !== thisYear || range.to.slice(0, 4) !== thisYear;
  const opts = { month: "short", day: "numeric", ...(showYear ? { year: "numeric" } : {}) };
  const f = new Intl.DateTimeFormat(locale, /** @type {Intl.DateTimeFormatOptions} */ (opts));
  if (range.from === range.to) return f.format(a);
  if (typeof f.formatRange === "function") return f.formatRange(a, b);
  return `${f.format(a)} – ${f.format(b)}`;
}

/**
 * What the Date chip says: the quick pick's name, else the dates.
 * @param {DayRange|null} range @param {string} today @param {string} [locale]
 */
export function rangeChipLabel(range, today, locale) {
  if (!range) return "Any date";
  const preset = range.preset && DATE_PRESETS.find((p) => p.id === range.preset);
  if (preset) return preset.label;
  if (range.from === range.to && range.to === today) return "Today";
  return formatRange(range, today, locale);
}

/**
 * The ledger's divider for one day while a date filter is on: "Today",
 * "Yesterday", else "Saturday, Nov 15" (with the year outside today's).
 * @param {string} key @param {string} today @param {string} [locale]
 */
export function dayGroupLabel(key, today, locale) {
  const d = parseDayKey(key);
  if (!d) return "Undated";
  if (key === today) return "Today";
  if (key === addDays(today, -1)) return "Yesterday";
  const showYear = key.slice(0, 4) !== today.slice(0, 4);
  return fmt(d, { weekday: "long", month: "short", day: "numeric", ...(showYear ? { year: "numeric" } : {}) }, locale);
}

/** "Sunday, November 16, 2026" for screen readers. @param {string} key @param {string} [locale] */
export function dayLongLabel(key, locale) {
  const d = parseDayKey(key);
  return d ? fmt(d, { weekday: "long", month: "long", day: "numeric", year: "numeric" }, locale) : "";
}

/** "November 2026". @param {string} key  any day of the month @param {string} [locale] */
export function monthLabel(key, locale) {
  const d = parseDayKey(key);
  return d ? fmt(d, { month: "long", year: "numeric" }, locale) : "";
}

/**
 * Seven weekday names starting at firstDow, short and long ("M", "Monday").
 * @param {number} firstDow @param {string} [locale]
 * @returns {Array<{ short: string, long: string }>}
 */
export function weekdayNames(firstDow, locale) {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2023, 0, 1 + ((firstDow + i) % 7));
    return { short: fmt(d, { weekday: "narrow" }, locale), long: fmt(d, { weekday: "long" }, locale) };
  });
}
