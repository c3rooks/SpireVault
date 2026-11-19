// Unit tests for Web/lib/ui/overview/layout.js, the pure layout model behind
// the customizable Overview (new look). Run: node --test tests/overview/*.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUT_VERSION,
  MAX_ITEMS,
  SIZE_SPAN,
  createLayout,
  sanitize,
  add,
  remove,
  move,
  resize,
  configure,
  reset,
  sameArrangement,
  columnSpans,
  columnPlan,
  indexOfKey,
} from "../../Web/lib/ui/overview/layout.js";

const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;

/** A small catalog in the shape registry.js exports. */
const CATALOG = Object.freeze({
  hand: { sizes: ["W"], defaultSize: "W" },
  winRate: { sizes: ["M", "L", "W"], defaultSize: "L", pairSpan: 5 },
  characters: { sizes: ["L", "W"], defaultSize: "L", pairSpan: 7 },
  trend: {
    sizes: ["M", "L", "W"],
    defaultSize: "L",
    pairSpan: 7,
    repeatable: true,
    settings: {
      character: { type: "choice", options: ["all", "ironclad", "silent"], default: "all" },
      range: { type: "choice", options: ["all", "30d", "50"], default: "all" },
    },
  },
  floors: { sizes: ["M", "L", "W"], defaultSize: "L", pairSpan: 5 },
  tile: { sizes: ["S", "M"], defaultSize: "S", repeatable: true },
  heading: {
    sizes: ["W"],
    defaultSize: "W",
    repeatable: true,
    settings: { text: { type: "text", maxLength: 12, default: "Section" } },
  },
});

const DEFAULT_ENTRIES = Object.freeze([
  { id: "hand" },
  { id: "winRate" },
  { id: "characters" },
  { id: "heading", settings: { text: "Trends" } },
  { id: "trend" },
  { id: "floors" },
]);

const fallback = () => createLayout(DEFAULT_ENTRIES, CATALOG, 0);
const ids = (layout) => layout.items.map((item) => item.id);
const keys = (layout) => layout.items.map((item) => item.key);

describe("createLayout", () => {
  test("fills in default sizes, complete settings and unique keys", () => {
    const layout = createLayout(DEFAULT_ENTRIES, CATALOG, T0);
    assert.equal(layout.v, LAYOUT_VERSION);
    assert.equal(layout.updatedAt, T0);
    assert.deepEqual(ids(layout), ["hand", "winRate", "characters", "heading", "trend", "floors"]);
    assert.deepEqual(layout.items.map((item) => item.size), ["W", "L", "L", "W", "L", "L"]);
    assert.deepEqual(layout.items[3].settings, { text: "Trends" });
    assert.deepEqual(layout.items[4].settings, { character: "all", range: "all" });
    assert.deepEqual(layout.items[0].settings, {});
    assert.equal(new Set(keys(layout)).size, layout.items.length);
  });

  test("gives a repeated widget a numbered key", () => {
    const layout = createLayout([{ id: "trend" }, { id: "trend" }, { id: "trend" }], CATALOG, T0);
    assert.deepEqual(keys(layout), ["trend", "trend-2", "trend-3"]);
  });

  test("returns frozen data", () => {
    const layout = createLayout(DEFAULT_ENTRIES, CATALOG, T0);
    assert.ok(Object.isFrozen(layout));
    assert.ok(Object.isFrozen(layout.items));
    assert.ok(Object.isFrozen(layout.items[0]));
    assert.ok(Object.isFrozen(layout.items[4].settings));
  });
});

describe("sanitize", () => {
  test("falls back when the stored value is not a layout", () => {
    for (const raw of [null, undefined, 42, "x", [], { v: 2, items: [] }, { v: 1 }, { v: 1, items: "no" }]) {
      assert.deepEqual(sanitize(raw, CATALOG, fallback()), fallback(), JSON.stringify(raw));
    }
  });

  test("keeps a valid layout as it is", () => {
    const stored = createLayout([{ id: "floors", size: "W" }, { id: "hand" }], CATALOG, T1);
    assert.deepEqual(sanitize(JSON.parse(JSON.stringify(stored)), CATALOG, fallback()), stored);
  });

  test("drops unknown widgets and items that are not objects", () => {
    const raw = { v: 1, updatedAt: T1, items: [{ key: "a", id: "nope", size: "W" }, 7, null, { key: "hand", id: "hand", size: "W" }] };
    assert.deepEqual(ids(sanitize(raw, CATALOG, fallback())), ["hand"]);
  });

  test("clamps a size the widget does not offer to its default", () => {
    const raw = { v: 1, updatedAt: T1, items: [{ key: "hand", id: "hand", size: "S" }, { key: "tile", id: "tile", size: "XL" }] };
    assert.deepEqual(sanitize(raw, CATALOG, fallback()).items.map((item) => item.size), ["W", "S"]);
  });

  test("keeps only the first copy of a widget that cannot repeat", () => {
    const raw = {
      v: 1,
      updatedAt: T1,
      items: [
        { key: "hand", id: "hand", size: "W" },
        { key: "hand-2", id: "hand", size: "W" },
        { key: "trend", id: "trend", size: "L" },
        { key: "trend-2", id: "trend", size: "M" },
      ],
    };
    assert.deepEqual(ids(sanitize(raw, CATALOG, fallback())), ["hand", "trend", "trend"]);
  });

  test("caps the list", () => {
    const raw = { v: 1, updatedAt: T1, items: Array.from({ length: MAX_ITEMS + 10 }, (_, i) => ({ key: `t${i}`, id: "tile", size: "S" })) };
    assert.equal(sanitize(raw, CATALOG, fallback()).items.length, MAX_ITEMS);
  });

  test("repairs duplicate, missing and malformed keys", () => {
    const raw = {
      v: 1,
      updatedAt: T1,
      items: [
        { key: "x", id: "tile", size: "S" },
        { key: "x", id: "tile", size: "S" },
        { id: "tile", size: "S" },
        { key: "<script>", id: "tile", size: "S" },
      ],
    };
    const result = keys(sanitize(raw, CATALOG, fallback()));
    assert.equal(new Set(result).size, 4);
    assert.equal(result[0], "x");
    for (const key of result) assert.match(key, /^[A-Za-z0-9-]{1,40}$/);
  });

  test("cleans settings: unknown keys go, bad choices reset, text is trimmed and capped", () => {
    const raw = {
      v: 1,
      updatedAt: T1,
      items: [
        { key: "trend", id: "trend", size: "L", settings: { character: "watcher", range: "50", evil: "1" } },
        { key: "heading", id: "heading", size: "W", settings: { text: "  A very long\u0000 title here  " } },
        { key: "heading-2", id: "heading", size: "W", settings: "nope" },
      ],
    };
    const items = sanitize(raw, CATALOG, fallback()).items;
    assert.deepEqual(items[0].settings, { character: "all", range: "50" });
    assert.deepEqual(items[1].settings, { text: "A very long" });
    assert.deepEqual(items[2].settings, { text: "Section" });
  });

  test("an emptied layout stays empty", () => {
    const raw = { v: 1, updatedAt: T1, items: [] };
    assert.deepEqual(sanitize(raw, CATALOG, fallback()).items, []);
  });

  test("a bad timestamp becomes 0", () => {
    assert.equal(sanitize({ v: 1, updatedAt: "soon", items: [] }, CATALOG, fallback()).updatedAt, 0);
    assert.equal(sanitize({ v: 1, updatedAt: -5, items: [] }, CATALOG, fallback()).updatedAt, 0);
  });
});

describe("add", () => {
  test("appends with the default size and stamps the time", () => {
    const before = fallback();
    const after = add(before, CATALOG, { id: "tile" }, { now: T1 });
    assert.deepEqual(ids(after).slice(-1), ["tile"]);
    assert.equal(after.items.at(-1).size, "S");
    assert.equal(after.updatedAt, T1);
    assert.equal(before.items.length, DEFAULT_ENTRIES.length, "the original is untouched");
  });

  test("inserts at an index, with settings and a size", () => {
    const after = add(fallback(), CATALOG, { id: "trend", size: "W", settings: { character: "silent" } }, { index: 1, now: T1 });
    assert.equal(after.items[1].id, "trend");
    assert.equal(after.items[1].key, "trend-2");
    assert.equal(after.items[1].size, "W");
    assert.deepEqual(after.items[1].settings, { character: "silent", range: "all" });
  });

  test("refuses unknown widgets, a second copy of a single widget, and a full layout", () => {
    const base = fallback();
    assert.equal(add(base, CATALOG, { id: "nope" }, { now: T1 }), base);
    assert.equal(add(base, CATALOG, { id: "hand" }, { now: T1 }), base);
    let full = createLayout([], CATALOG, T0);
    for (let i = 0; i < MAX_ITEMS; i += 1) full = add(full, CATALOG, { id: "tile" }, { now: T0 });
    assert.equal(full.items.length, MAX_ITEMS);
    assert.equal(add(full, CATALOG, { id: "tile" }, { now: T1 }), full);
  });
});

describe("remove / move / resize / configure", () => {
  test("remove takes one item out by key", () => {
    const after = remove(fallback(), "characters", T1);
    assert.deepEqual(ids(after), ["hand", "winRate", "heading", "trend", "floors"]);
    assert.equal(after.updatedAt, T1);
    const base = fallback();
    assert.equal(remove(base, "missing", T1), base);
  });

  test("move puts an item at a new index, clamped to the list", () => {
    assert.deepEqual(ids(move(fallback(), "floors", 0, T1)), ["floors", "hand", "winRate", "characters", "heading", "trend"]);
    assert.deepEqual(ids(move(fallback(), "hand", 99, T1)), ["winRate", "characters", "heading", "trend", "floors", "hand"]);
    assert.deepEqual(ids(move(fallback(), "hand", -3, T1)), ids(fallback()));
    const base = fallback();
    assert.equal(move(base, "hand", 0, T1), base, "a move to the same place changes nothing");
    assert.equal(move(base, "missing", 2, T1), base);
  });

  test("resize accepts only a size the widget offers", () => {
    const base = fallback();
    const after = resize(base, CATALOG, "winRate", "W", T1);
    assert.equal(after.items[1].size, "W");
    assert.equal(after.updatedAt, T1);
    assert.equal(resize(base, CATALOG, "winRate", "S", T1), base);
    assert.equal(resize(base, CATALOG, "winRate", "L", T1), base, "same size: no change");
    assert.equal(resize(base, CATALOG, "missing", "W", T1), base);
  });

  test("configure merges and cleans settings", () => {
    const after = configure(fallback(), CATALOG, "trend", { range: "30d", bogus: "x" }, T1);
    assert.deepEqual(after.items[4].settings, { character: "all", range: "30d" });
    const renamed = configure(fallback(), CATALOG, "heading", { text: "My goals" }, T1);
    assert.deepEqual(renamed.items[3].settings, { text: "My goals" });
    const base = fallback();
    assert.equal(configure(base, CATALOG, "trend", { range: "all" }, T1), base, "no change");
  });
});

describe("reset and sameArrangement", () => {
  test("reset returns the defaults, stamped now", () => {
    const after = reset(DEFAULT_ENTRIES, CATALOG, T1);
    assert.equal(after.updatedAt, T1);
    assert.ok(sameArrangement(after, fallback()));
  });

  test("sameArrangement ignores keys and time, not order, size or settings", () => {
    const base = fallback();
    assert.ok(sameArrangement(base, { ...base, updatedAt: T1, items: base.items.map((item, i) => ({ ...item, key: `k${i}` })) }));
    assert.ok(!sameArrangement(base, move(base, "floors", 0, T1)));
    assert.ok(!sameArrangement(base, resize(base, CATALOG, "winRate", "W", T1)));
    assert.ok(!sameArrangement(base, configure(base, CATALOG, "trend", { range: "50" }, T1)));
  });

  test("indexOfKey finds an item", () => {
    assert.equal(indexOfKey(fallback(), "heading"), 3);
    assert.equal(indexOfKey(fallback(), "nope"), -1);
  });
});

describe("columnSpans (12-column rows)", () => {
  test("sizes map to their column spans", () => {
    assert.deepEqual(SIZE_SPAN, { S: 3, M: 4, L: 6, W: 12 });
    const layout = createLayout([{ id: "tile" }, { id: "tile", size: "M" }, { id: "floors", size: "W" }], CATALOG, T0);
    assert.deepEqual(columnSpans(layout.items, CATALOG), [3, 4, 12]);
  });

  test("two halves that share a row take each widget's own share", () => {
    // Today's Overview: win rate 5 / by character 7, trend 7 / floors 5.
    assert.deepEqual(columnSpans(fallback().items, CATALOG), [12, 5, 7, 12, 7, 5]);
  });

  test("a pair whose shares do not add up to the row stays even", () => {
    const layout = createLayout([{ id: "winRate" }, { id: "floors" }, { id: "characters" }, { id: "trend" }], CATALOG, T0);
    assert.deepEqual(columnSpans(layout.items, CATALOG), [6, 6, 6, 6]);
  });

  test("a half that shares its row with smaller widgets stays a half", () => {
    const layout = createLayout([{ id: "tile" }, { id: "winRate" }, { id: "tile" }, { id: "characters" }], CATALOG, T0);
    assert.deepEqual(columnSpans(layout.items, CATALOG), [3, 6, 3, 6]);
  });

  test("marks the two cells of a split row, and only those", () => {
    const pairs = columnPlan(fallback().items, CATALOG).map((cell) => cell.pair);
    assert.deepEqual(pairs, [null, "start", "end", null, "start", "end"]);
    const even = createLayout([{ id: "winRate" }, { id: "floors" }], CATALOG, T0);
    assert.deepEqual(columnPlan(even.items, CATALOG), [{ span: 6, pair: null }, { span: 6, pair: null }]);
  });

  test("rows wrap where the next widget would not fit", () => {
    // tile 3 + tile 3 + characters 6 = 12; then winRate starts a row with floors.
    const layout = createLayout(
      [{ id: "tile" }, { id: "tile" }, { id: "characters" }, { id: "winRate" }, { id: "floors" }],
      CATALOG,
      T0
    );
    assert.deepEqual(columnSpans(layout.items, CATALOG), [3, 3, 6, 6, 6]);
  });
});
