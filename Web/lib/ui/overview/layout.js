// The Overview layout (new look): which widgets a player keeps, in what order,
// at what size, with what settings. Pure and immutable: every function takes a
// layout and returns a new frozen one, or the same object when nothing would
// change, so callers can tell a no-op by identity. No DOM, no storage, no
// clock: the caller passes `now`.
//
// A catalog describes what each widget allows. registry.js builds it from the
// widget definitions; the tests use a small one.
//   { [id]: { sizes, defaultSize, repeatable?, pairSpan?, settings? } }
//
// Stored shape (localStorage `vault.web.overview.layout.v1`):
//   { v: 1, updatedAt, items: [{ key, id, size, settings }] }

export const LAYOUT_VERSION = 1;
/** Most widgets one Overview can hold. */
export const MAX_ITEMS = 24;
export const SIZES = Object.freeze(["S", "M", "L", "W"]);
/** Columns each size spans on the 12-column grid (overview-grid.css). */
export const SIZE_SPAN = Object.freeze({ S: 3, M: 4, L: 6, W: 12 });
export const COLUMNS = 12;

const KEY_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * @typedef {{ type: "choice", options: ReadonlyArray<string>, default: string }
 *         | { type: "text", maxLength: number, default: string }} SettingSpec
 * @typedef {{
 *   sizes: ReadonlyArray<string>,
 *   defaultSize: string,
 *   repeatable?: boolean,
 *   pairSpan?: number,
 *   settings?: Readonly<Record<string, SettingSpec>>,
 * }} CatalogEntry
 * @typedef {Readonly<Record<string, CatalogEntry>>} Catalog
 * @typedef {Readonly<{ key: string, id: string, size: string, settings: Readonly<Record<string, string>> }>} LayoutItem
 * @typedef {Readonly<{ v: number, updatedAt: number, items: ReadonlyArray<LayoutItem> }>} Layout
 * @typedef {{ id: string, size?: string, settings?: Record<string, unknown> }} Entry
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Catalog} catalog @param {string} id @returns {CatalogEntry|null} */
function entryFor(catalog, id) {
  return Object.prototype.hasOwnProperty.call(catalog, id) ? catalog[id] : null;
}

/** @param {CatalogEntry} entry @param {unknown} size @returns {string} */
function cleanSize(entry, size) {
  return typeof size === "string" && entry.sizes.includes(size) ? size : entry.defaultSize;
}

/** @param {SettingSpec} spec @param {unknown} value @returns {string} */
function cleanSetting(spec, value) {
  if (spec.type === "choice") {
    return typeof value === "string" && spec.options.includes(value) ? value : spec.default;
  }
  if (typeof value !== "string") return spec.default;
  return value.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().slice(0, spec.maxLength).trim();
}

/**
 * Every setting the widget declares, each valid; nothing else.
 * @param {CatalogEntry} entry @param {unknown} raw
 * @returns {Readonly<Record<string, string>>}
 */
function cleanSettings(entry, raw) {
  const given = isRecord(raw) ? raw : {};
  const specs = entry.settings || {};
  const out = {};
  for (const name of Object.keys(specs)) {
    out[name] = cleanSetting(specs[name], Object.prototype.hasOwnProperty.call(given, name) ? given[name] : undefined);
  }
  return Object.freeze(out);
}

/** @param {ReadonlySet<string>} taken @param {string} id @returns {string} */
function nextKey(taken, id) {
  if (!taken.has(id)) return id;
  for (let n = 2; ; n += 1) {
    const key = `${id}-${n}`;
    if (!taken.has(key)) return key;
  }
}

/** @param {ReadonlyArray<LayoutItem>} items @param {number} updatedAt @returns {Layout} */
function freezeLayout(items, updatedAt) {
  return Object.freeze({ v: LAYOUT_VERSION, updatedAt, items: Object.freeze(items.slice()) });
}

/** @param {string} key @param {string} id @param {string} size @param {Readonly<Record<string, string>>} settings */
function makeItem(key, id, size, settings) {
  return Object.freeze({ key, id, size, settings });
}

/**
 * Builds a layout from a list of widget entries (used for the default).
 * Unknown ids are skipped; non-repeatable duplicates keep the first.
 * @param {ReadonlyArray<Entry>} entries @param {Catalog} catalog @param {number} now
 * @returns {Layout}
 */
export function createLayout(entries, catalog, now) {
  return sanitize({ v: LAYOUT_VERSION, updatedAt: now, items: entries.map((entry) => ({ ...entry })) }, catalog, null);
}

/**
 * Turns anything read from storage into a valid layout. Not a layout at all:
 * `fallback`. Otherwise unknown widgets go, sizes are clamped to what each
 * widget offers, a widget that cannot repeat keeps its first copy, keys are
 * made unique and the list is capped at MAX_ITEMS.
 * @param {unknown} raw @param {Catalog} catalog @param {Layout|null} fallback
 * @returns {Layout}
 */
export function sanitize(raw, catalog, fallback) {
  if (!isRecord(raw) || raw.v !== LAYOUT_VERSION || !Array.isArray(raw.items)) {
    return fallback || freezeLayout([], 0);
  }
  const updatedAt = Number.isFinite(raw.updatedAt) && Number(raw.updatedAt) >= 0 ? Number(raw.updatedAt) : 0;
  /** @type {Set<string>} */
  const seenIds = new Set();
  /** @type {Set<string>} */
  const seenKeys = new Set();
  /** @type {Array<{ rawKey: unknown, id: string, size: string, settings: Readonly<Record<string, string>> }>} */
  const kept = [];
  for (const item of raw.items) {
    if (kept.length >= MAX_ITEMS) break;
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const entry = entryFor(catalog, item.id);
    if (!entry) continue;
    if (!entry.repeatable && seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    kept.push({ rawKey: item.key, id: item.id, size: cleanSize(entry, item.size), settings: cleanSettings(entry, item.settings) });
  }
  // Valid, unclaimed keys first, so a repaired item never steals one.
  const claimed = kept.map(({ rawKey }) => {
    if (typeof rawKey !== "string" || !KEY_PATTERN.test(rawKey) || seenKeys.has(rawKey)) return null;
    seenKeys.add(rawKey);
    return rawKey;
  });
  const items = kept.map(({ id, size, settings }, index) => {
    const key = claimed[index] || nextKey(seenKeys, id);
    seenKeys.add(key);
    return makeItem(key, id, size, settings);
  });
  return freezeLayout(items, updatedAt);
}

/**
 * @param {Layout} layout @param {string} key
 * @returns {number} the item's index, or -1
 */
export function indexOfKey(layout, key) {
  return layout.items.findIndex((item) => item.key === key);
}

/**
 * Adds a widget. Unchanged when the id is unknown, the widget cannot repeat
 * and is already placed, or the layout is full.
 * @param {Layout} layout @param {Catalog} catalog @param {Entry} entry
 * @param {{ index?: number, now: number }} options
 * @returns {Layout}
 */
export function add(layout, catalog, entry, options) {
  const spec = entryFor(catalog, entry.id);
  if (!spec || layout.items.length >= MAX_ITEMS) return layout;
  if (!spec.repeatable && layout.items.some((item) => item.id === entry.id)) return layout;
  const key = nextKey(new Set(layout.items.map((item) => item.key)), entry.id);
  const item = makeItem(key, entry.id, cleanSize(spec, entry.size), cleanSettings(spec, entry.settings));
  const at = Number.isInteger(options.index) ? Math.min(Math.max(0, /** @type {number} */ (options.index)), layout.items.length) : layout.items.length;
  return freezeLayout([...layout.items.slice(0, at), item, ...layout.items.slice(at)], options.now);
}

/**
 * @param {Layout} layout @param {string} key @param {number} now
 * @returns {Layout}
 */
export function remove(layout, key, now) {
  const index = indexOfKey(layout, key);
  if (index === -1) return layout;
  return freezeLayout(layout.items.filter((_, i) => i !== index), now);
}

/**
 * Moves an item to `toIndex` (its index after the move), clamped to the list.
 * @param {Layout} layout @param {string} key @param {number} toIndex @param {number} now
 * @returns {Layout}
 */
export function move(layout, key, toIndex, now) {
  const from = indexOfKey(layout, key);
  if (from === -1) return layout;
  const to = Math.min(Math.max(0, Math.trunc(toIndex) || 0), layout.items.length - 1);
  if (to === from) return layout;
  const rest = layout.items.filter((_, i) => i !== from);
  return freezeLayout([...rest.slice(0, to), layout.items[from], ...rest.slice(to)], now);
}

/**
 * @param {Layout} layout @param {Catalog} catalog @param {string} key @param {string} size @param {number} now
 * @returns {Layout}
 */
export function resize(layout, catalog, key, size, now) {
  const index = indexOfKey(layout, key);
  if (index === -1) return layout;
  const item = layout.items[index];
  const spec = entryFor(catalog, item.id);
  if (!spec || !spec.sizes.includes(size) || item.size === size) return layout;
  return freezeLayout(layout.items.map((it, i) => (i === index ? makeItem(it.key, it.id, size, it.settings) : it)), now);
}

/**
 * Merges `patch` into an item's settings and cleans the result.
 * @param {Layout} layout @param {Catalog} catalog @param {string} key
 * @param {Record<string, unknown>} patch @param {number} now
 * @returns {Layout}
 */
export function configure(layout, catalog, key, patch, now) {
  const index = indexOfKey(layout, key);
  if (index === -1) return layout;
  const item = layout.items[index];
  const spec = entryFor(catalog, item.id);
  if (!spec) return layout;
  const settings = cleanSettings(spec, { ...item.settings, ...(isRecord(patch) ? patch : {}) });
  const names = Object.keys(settings);
  if (names.every((name) => settings[name] === item.settings[name])) return layout;
  return freezeLayout(layout.items.map((it, i) => (i === index ? makeItem(it.key, it.id, it.size, settings) : it)), now);
}

/**
 * The default layout again, stamped `now`.
 * @param {ReadonlyArray<Entry>} entries @param {Catalog} catalog @param {number} now
 * @returns {Layout}
 */
export function reset(entries, catalog, now) {
  return createLayout(entries, catalog, now);
}

/**
 * True when two layouts show the same widgets in the same order at the same
 * sizes with the same settings (keys and timestamps aside).
 * @param {Layout} a @param {Layout} b
 * @returns {boolean}
 */
export function sameArrangement(a, b) {
  if (a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => {
    const other = b.items[index];
    if (item.id !== other.id || item.size !== other.size) return false;
    const names = Object.keys(item.settings);
    return names.length === Object.keys(other.settings).length && names.every((name) => item.settings[name] === other.settings[name]);
  });
}

/**
 * Where each item sits on the 12-column grid, row by row as the grid flows
 * them. Each size has its span (SIZE_SPAN); the one exception is a row of
 * exactly two halves whose widgets carry their own share (`pairSpan`) and
 * whose shares add up to the row, e.g. win rate 5 beside by-character 7. That
 * keeps today's Overview proportions while every other pairing stays even.
 * Such a row's two cells are marked `pair: "start" | "end"`, so the grid can
 * split the row the way `5fr 7fr` would (overview-grid.css).
 * @param {ReadonlyArray<LayoutItem>} items @param {Catalog} catalog
 * @returns {Array<{ span: number, pair: "start"|"end"|null }>}
 */
export function columnPlan(items, catalog) {
  const spans = items.map((item) => SIZE_SPAN[item.size] || COLUMNS);
  /** @type {Array<"start"|"end"|null>} */
  const pairs = items.map(() => null);
  /** @type {number[][]} */
  const rows = [];
  let row = [];
  let used = 0;
  spans.forEach((span, index) => {
    if (used + span > COLUMNS && row.length > 0) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(index);
    used += span;
  });
  if (row.length > 0) rows.push(row);
  for (const members of rows) {
    if (members.length !== 2 || !members.every((index) => items[index].size === "L")) continue;
    const shares = members.map((index) => entryFor(catalog, items[index].id)?.pairSpan || SIZE_SPAN.L);
    if (shares[0] + shares[1] !== COLUMNS || shares[0] === SIZE_SPAN.L) continue;
    spans[members[0]] = shares[0];
    spans[members[1]] = shares[1];
    pairs[members[0]] = "start";
    pairs[members[1]] = "end";
  }
  return spans.map((span, index) => ({ span, pair: pairs[index] }));
}

/**
 * Just the spans of columnPlan.
 * @param {ReadonlyArray<LayoutItem>} items @param {Catalog} catalog
 * @returns {number[]}
 */
export function columnSpans(items, catalog) {
  return columnPlan(items, catalog).map((cell) => cell.span);
}
