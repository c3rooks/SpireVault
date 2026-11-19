// The Overview's widgets (new look) and the renderer that lays them out.
//
// Each widget wraps a section that already existed (views.js, charts.js) with
// a model builder and a description of what it allows. The renderer walks a
// layout (layout.js), builds each widget's model from one shared context and
// hands the cells to views.js `overviewHtml`.
//
// Widgets read nothing global. script.js passes a context per render:
//   { runs, byDateDesc, report, h }  where `h` holds the script.js helpers
// (stats wording, names, art paths) so both looks keep computing every number
// the same way.

import { esc } from "../html.js?v=1";
import { handHtml, winRateHtml, charactersHtml, relicsHtml, sectionTitleHtml, overviewHtml } from "../views.js?v=9";
import { trendChartHtml, floorChartHtml } from "../charts.js?v=2";
import { createLayout, columnPlan } from "./layout.js?v=1";
import { MORE_WIDGETS, VISIT_WIDGET } from "./widgets-more.js?v=2";
import { SHOWCASE_WIDGETS } from "./widgets-showcase.js?v=1";

const RECENT_PATH_RUNS = 20;
const RECENT_FORM_RUNS = 10;
const TOP_RELICS = 6;
/** A character needs this many runs to be called your best. */
const BEST_CHARACTER_MIN_RUNS = 3;
/** Entrance beats (× 55ms, motion.css): the hand deals cards 0..5. */
const HAND_FIRST_BEAT = 3;
const HAND_LAST_BEAT = 5;
const LAST_BEAT = 16;

/**
 * @typedef {Object} OverviewHelpers  script.js functions, passed in per render
 * @property {(runs: ReadonlyArray<object>) => ReadonlyArray<object>} kpiCards  the six hand cards
 * @property {(report: object) => ReadonlyArray<object>} characterRows
 * @property {(runs: ReadonlyArray<object>) => object|null} trendData
 * @property {(runs: ReadonlyArray<object>) => object|null} floorData
 * @property {(byDateDesc: ReadonlyArray<object>) => { newRuns: number, sinceSession: number, demo: boolean }} visitNews
 * @property {(byDateDesc: ReadonlyArray<object>, now: number) => ReadonlyArray<object>} weekRuns  this week, as the hand counts it
 * @property {(key: string) => string} characterName
 * @property {(key: string) => number} ascensionLevel
 * @property {(run: object) => boolean} isLadderRun
 * @property {(id: string) => string} relicLabel
 * @property {(id: string) => string|null} relicImageSrc
 * @property {(id: string) => string} cardLabel
 * @property {(id: string) => string|null} cardImageSrc
 *
 * @typedef {Object} OverviewContext
 * @property {number} now                     epoch ms, for "this week" numbers
 * @property {ReadonlyArray<any>} runs        every parsed run
 * @property {ReadonlyArray<any>} byDateDesc  the same runs, newest first
 * @property {any} report                     Stats.summarize(runs)
 * @property {OverviewHelpers} h
 *
 * @typedef {Object} RenderOptions
 * @property {string} size    S | M | L | W
 * @property {number} order   entrance beat
 * @property {Readonly<Record<string, string>>} settings
 * @property {string} key
 *
 * @typedef {Object} Widget
 * @property {string} id
 * @property {string} title
 * @property {string} blurb      one line on what it tells you
 * @property {string} category   progress | characters | cards-relics | paths | coop | community | layout
 * @property {ReadonlyArray<string>} sizes
 * @property {string} defaultSize
 * @property {string} needs      what the data must hold for it to say anything
 * @property {boolean} [repeatable]
 * @property {boolean} [reveals]   rises in on tab entry (takes an entrance beat)
 * @property {number} [pairSpan]   its share of a row it splits with one other half
 * @property {"center"|"start"} [titled]  opens with a section title (centered or left), which
 *                                 the Arrange button can ride on when the widget comes first
 * @property {Readonly<Record<string, { label: string, options?: Readonly<Record<string, string>> }>>} [settingLabels]
 *                                 how the gear names each setting and choice
 * @property {string} [nameSetting]  the setting whose choice names the widget in Arrange
 *                                 ("Hours played" rather than "Stat tile")
 * @property {string} [emptyText]    what Arrange says while it has nothing to show
 * @property {number} [previewWidth] width the gallery draws it at before scaling (default by size)
 * @property {Readonly<Record<string, import("./layout.js").SettingSpec>>} [settings]
 * @property {(ctx: OverviewContext, settings: Readonly<Record<string, string>>) => any} model
 * @property {(model: any, options: RenderOptions) => string} html
 */

/** @param {OverviewContext} ctx */
function winRateModel(ctx) {
  const { report, byDateDesc, h } = ctx;
  const total = report.totalRuns;
  const lastTen = byDateDesc.slice(0, RECENT_FORM_RUNS);
  const lastTenWins = lastTen.filter((r) => r.won).length;
  const best = report.byCharacter
    .filter((b) => b.runs >= BEST_CHARACTER_MIN_RUNS)
    .slice()
    .sort((a, b) => b.winrate - a.winrate)[0] || report.byCharacter[0] || null;
  const highest = report.byAscension
    .slice()
    .sort((a, b) => h.ascensionLevel(b.key) - h.ascensionLevel(a.key))
    .find((b) => b.runs > 0) || null;
  const ascensions = ctx.runs
    .filter(h.isLadderRun)
    .map((r) => Number(r.ascension))
    .filter((n) => Number.isFinite(n));
  return {
    totals: {
      total,
      wins: report.totalWins,
      losses: total - report.totalWins,
      winratePct: report.overallWinrate * 100,
    },
    bestCharacter: best
      ? { key: String(best.key).toLowerCase(), label: h.characterName(best.key), winratePct: best.winrate * 100, runs: best.runs }
      : null,
    highestAscension: highest ? { level: h.ascensionLevel(highest.key), runs: highest.runs } : null,
    avgAscension: ascensions.length > 0 ? (ascensions.reduce((a, b) => a + b, 0) / ascensions.length).toFixed(1) : "—",
    recentRuns: byDateDesc
      .slice(0, RECENT_PATH_RUNS)
      .reverse()
      .map((r) => ({ won: !!r.won, abandoned: !!r.wasAbandoned })),
    lastTen: { wins: lastTenWins, losses: lastTen.length - lastTenWins, count: lastTen.length },
  };
}

/** @param {OverviewContext} ctx */
function relicsModel(ctx) {
  const { report, h } = ctx;
  return {
    relics: report.byRelic.slice(0, TOP_RELICS).map((b) => ({
      label: h.relicLabel(b.key),
      src: h.relicImageSrc(b.key),
      runs: b.runs,
      wins: b.wins,
      winratePct: b.winrate * 100,
    })),
  };
}

/** @type {ReadonlyArray<Widget>} */
const WIDGET_LIST = [
  VISIT_WIDGET,
  {
    id: "hand",
    title: "Your hand",
    blurb: "Recent form, streaks, best floor, fastest win and this week, dealt as six cards.",
    category: "progress",
    sizes: ["W"],
    defaultSize: "W",
    titled: "center",
    needs: "One climb",
    model: (ctx) => ({ kpis: ctx.report.totalRuns > 0 ? ctx.h.kpiCards(ctx.runs) : [] }),
    html: (model) => handHtml(model),
  },
  {
    id: "winRate",
    title: "Win rate",
    blurb: "Your win rate, wins and losses, best character and your last 20 climbs.",
    category: "progress",
    sizes: ["L", "W"],
    defaultSize: "L",
    pairSpan: 5,
    reveals: true,
    needs: "One climb",
    model: (ctx) => winRateModel(ctx),
    html: (model, { order }) => winRateHtml(model, order),
  },
  {
    id: "characters",
    title: "By character",
    blurb: "Win rate and record for every climber.",
    category: "characters",
    sizes: ["L", "W"],
    defaultSize: "L",
    pairSpan: 7,
    reveals: true,
    needs: "One climb",
    model: (ctx) => (ctx.h.characterPanel ? ctx.h.characterPanel(ctx.report) : { characters: ctx.h.characterRows(ctx.report) }),
    html: (model, { order }) => charactersHtml(model, order),
  },
  {
    id: "trend",
    title: "Win-rate trend",
    blurb: "Your rolling win rate over time against your lifetime average.",
    category: "progress",
    sizes: ["M", "L", "W"],
    defaultSize: "L",
    pairSpan: 7,
    reveals: true,
    needs: "Five climbs",
    model: (ctx) => ctx.h.trendData(ctx.runs),
    html: (model, { order }) => trendChartHtml(model, order),
  },
  {
    id: "floors",
    title: "Where climbs end",
    blurb: "The floor each climb ended on: victories rise, defeats fall.",
    category: "paths",
    sizes: ["M", "L", "W"],
    defaultSize: "L",
    pairSpan: 5,
    reveals: true,
    needs: "Five climbs",
    model: (ctx) => ctx.h.floorData(ctx.runs),
    html: (model, { order }) => floorChartHtml(model, order),
  },
  {
    id: "relics",
    title: "Top relics",
    blurb: "The six relics you win with most, weighted by how often you take them.",
    category: "cards-relics",
    sizes: ["W"],
    defaultSize: "W",
    titled: "start",
    reveals: true,
    needs: "Relics from your save files",
    model: (ctx) => relicsModel(ctx),
    html: (model, { order }) => relicsHtml(model, order),
  },
  {
    id: "heading",
    title: "Section title",
    blurb: "A title with a dashed rule, to group the widgets under it.",
    category: "layout",
    sizes: ["W"],
    defaultSize: "W",
    repeatable: true,
    titled: "start",
    needs: "",
    settings: {
      text: { type: "text", maxLength: 32, default: "Section" },
      sub: { type: "text", maxLength: 80, default: "" },
    },
    settingLabels: { text: { label: "Title" }, sub: { label: "Note beside it" } },
    previewWidth: 460,
    model: (_ctx, settings) => ({ text: settings.text || "Section", sub: settings.sub }),
    html: (model) => sectionTitleHtml(model.text, model.sub),
  },
  ...SHOWCASE_WIDGETS,
  ...MORE_WIDGETS,
];

/** Every widget, by id. */
export const WIDGETS = Object.freeze(Object.fromEntries(WIDGET_LIST.map((widget) => [widget.id, Object.freeze(widget)])));

/** What layout.js needs to know about each widget. */
export const CATALOG = Object.freeze(
  Object.fromEntries(
    WIDGET_LIST.map((w) => [
      w.id,
      Object.freeze({ sizes: w.sizes, defaultSize: w.defaultSize, repeatable: !!w.repeatable, pairSpan: w.pairSpan, settings: w.settings }),
    ])
  )
);

/**
 * Today's Overview, in today's order. Anyone who has not arranged their own
 * sees exactly this, and it keeps the classic look's section order
 * (verify-ui-next --only parity). The hand leads the first screen; "Since
 * your last visit" sits under it and only shows when something happened.
 */
export const DEFAULT_ENTRIES = Object.freeze([
  { id: "hand" },
  { id: "notices" },
  { id: "winRate" },
  { id: "characters" },
  { id: "heading", settings: { text: "Trends", sub: "win rate over time, and where climbs end" } },
  { id: "trend" },
  { id: "floors" },
  { id: "relics" },
]);

/** @returns {import("./layout.js").Layout} */
export function defaultLayout() {
  return createLayout(DEFAULT_ENTRIES, CATALOG, 0);
}

/**
 * Entrance beat for the k-th revealing widget. With the hand on the page,
 * the first two rise alongside its last cards and the rest follow once it
 * has landed (today's Overview: 3, 4, then 8, 9, 10).
 * @param {number} k @param {boolean} hasHand
 * @returns {number}
 */
function revealBeat(k, hasHand) {
  if (!hasHand) return Math.min(k, LAST_BEAT);
  const beat = k < 2 ? HAND_FIRST_BEAT + k : HAND_LAST_BEAT + 1 + k;
  return Math.min(beat, LAST_BEAT);
}

/**
 * Draws one placed widget; "" when it has nothing to show.
 * @param {import("./layout.js").LayoutItem} item
 * @param {OverviewContext} ctx
 * @param {number} order  entrance beat
 * @returns {string}
 */
export function cellHtml(item, ctx, order = 0) {
  const widget = WIDGETS[item.id];
  if (!widget) return "";
  const html = widget.html(widget.model(ctx, item.settings), { size: item.size, order, settings: item.settings, key: item.key });
  return html && html.trim() ? html : "";
}

/**
 * Where the Arrange button sits: on the first widget's section title when it
 * opens with one (centered for the hand, at the end of the rule for the
 * others), else on a row of its own.
 * @param {string|undefined} firstId
 * @returns {"center"|"start"|"row"}
 */
export function barPlacement(firstId) {
  return (firstId && WIDGETS[firstId] && WIDGETS[firstId].titled) || "row";
}

/**
 * Renders a layout into the Overview body.
 * @param {import("./layout.js").Layout} layout
 * @param {OverviewContext} ctx
 * @returns {string}
 */
export function renderOverview(layout, ctx) {
  const plan = columnPlan(layout.items, CATALOG);
  const hasHand = layout.items.some((item) => item.id === "hand");
  let revealed = 0;
  const cells = [];
  layout.items.forEach((item, index) => {
    const widget = WIDGETS[item.id];
    if (!widget) return;
    const order = widget.reveals ? revealBeat(revealed++, hasHand) : 0;
    const html = cellHtml(item, ctx, order);
    if (!html) return;
    cells.push({ key: esc(item.key), id: item.id, size: item.size, span: plan[index].span, pair: plan[index].pair, html });
  });
  return overviewHtml(cells, { bar: barPlacement(cells[0] && cells[0].id) });
}
