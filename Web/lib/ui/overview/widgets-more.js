// Overview widgets that are new with the customizable Overview (not on the
// default layout). Each reads only what the parser already keeps. Rules for
// every stat: say how many climbs a number stands on, rank by the Wilson
// bound rather than raw rate, and below the minimum say what is missing
// instead of showing a misleading number.
// Styles: styles/src/surfaces/overview-widgets.css.

import { esc, fixed } from "../html.js?v=1";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_ASCENSION = 10;
const RELIC_MIN_RUNS = 6;
const RELIC_MIN_TOTAL = 20;
const RELIC_ROWS = 3;
const Z_95 = 1.96;

/** @param {number} count @param {string} noun */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** @param {any} run @returns {number} ms since the run ended (or started); Infinity when undated */
function ageMs(run, now) {
  const when = run.endedAt || run.startedAt;
  const t = when ? new Date(when).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, now - t) : Infinity;
}

/**
 * A save's run time counts the whole time the climb was open, so a game left
 * paused overnight shows a 20-hour climb (one player's 729 saves: median 35 minutes,
 * 109 over 6 hours). Past this, a run counts as a typical climb.
 */
const IDLE_CAP_SECONDS = 4 * 3600;

/** @param {ReadonlyArray<number>} values @returns {number} NaN when empty */
function median(values) {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Seconds each run was really played: idle-inflated runs count as a typical one. */
function playedSeconds(runs) {
  const timed = runs.filter((r) => Number.isFinite(r.playTimeSeconds) && r.playTimeSeconds > 0);
  const typical = median(timed.filter((r) => r.playTimeSeconds <= IDLE_CAP_SECONDS).map((r) => r.playTimeSeconds)) || 0;
  return (run) => {
    const t = run.playTimeSeconds;
    if (!Number.isFinite(t) || t <= 0) return 0;
    return t > IDLE_CAP_SECONDS ? typical : t;
  };
}

/** "41m", "1h 05m" */
function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "1:05" */
function clockText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Wilson score interval at 95%. @returns {{ lo: number, hi: number }} */
function wilson(wins, runs) {
  if (runs <= 0) return { lo: 0, hi: 1 };
  const p = wins / runs;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / runs;
  const center = p + z2 / (2 * runs);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * runs)) / runs);
  return { lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom) };
}

// ---- Stat tile (S only: one number needs no more room) -------------------------

/** What a stat tile can show. Order = the gear's list. */
export const STAT_CHOICES = Object.freeze({
  climbs: "Climbs",
  hours: "Hours played",
  avgClimb: "Typical climb",
  bestWin: "Highest win",
  winsMonth: "Wins this month",
  avgFloor: "Average floor",
});

/**
 * @param {any} ctx  OverviewContext
 * @param {string} stat  a STAT_CHOICES key
 */
function statModel(ctx, stat) {
  const runs = ctx.runs;
  const now = ctx.now;
  const week = runs.filter((r) => ageMs(r, now) < WEEK_MS);
  const label = STAT_CHOICES[stat] || STAT_CHOICES.climbs;
  if (stat === "hours") {
    const played = playedSeconds(runs);
    const total = runs.reduce((sum, r) => sum + played(r), 0);
    const weekly = week.reduce((sum, r) => sum + played(r), 0);
    const hours = total / 3600;
    return { label, tone: "info", value: hours >= 10 ? String(Math.round(hours)) : fixed(hours), unit: "h", note: `${fixed(weekly / 3600)}h this week` };
  }
  if (stat === "avgClimb") {
    // The median, so a few climbs left open overnight cannot drag it up.
    const timed = runs.filter((r) => Number.isFinite(r.playTimeSeconds) && r.playTimeSeconds > 0);
    const perFloor = median(
      timed.filter((r) => r.playTimeSeconds <= IDLE_CAP_SECONDS && r.floorReached > 0).map((r) => r.playTimeSeconds / r.floorReached)
    );
    return {
      label,
      tone: "violet",
      value: durationText(median(timed.map((r) => r.playTimeSeconds))),
      unit: "",
      note: Number.isFinite(perFloor) ? `${clockText(perFloor)} per floor` : "Needs timed climbs",
    };
  }
  if (stat === "bestWin") {
    const wins = runs.filter((r) => r.won && ctx.h.isLadderRun(r) && Number.isFinite(r.ascension));
    const best = wins.reduce((top, r) => (!top || r.ascension > top.ascension ? r : top), null);
    return {
      label,
      tone: "gold",
      value: best ? `A${best.ascension}` : "—",
      unit: "",
      note: best ? `${ctx.h.characterName(best.character || "Unknown")}` : "No victories yet",
    };
  }
  if (stat === "winsMonth") {
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const month = runs.filter((r) => ageMs(r, now) <= now - start.getTime());
    const wins = month.filter((r) => r.won).length;
    return { label, tone: "win", value: String(wins), unit: "", note: `of ${plural(month.length, "climb")} this month` };
  }
  if (stat === "avgFloor") {
    const ended = runs.filter((r) => Number.isFinite(r.floorReached) && r.floorReached > 0);
    const avg = ended.length ? ended.reduce((sum, r) => sum + r.floorReached, 0) / ended.length : NaN;
    const best = ended.reduce((top, r) => Math.max(top, r.floorReached), 0);
    return { label, tone: "violet", value: Number.isFinite(avg) ? String(Math.round(avg)) : "—", unit: "", note: best ? `best ${best}` : "" };
  }
  return { label: STAT_CHOICES.climbs, tone: "accent", value: String(runs.length), unit: "", note: `${week.length} this week` };
}

/** @param {ReturnType<typeof statModel>} model @param {number} order */
function statHtml(model, order) {
  return `
    <section class="v-panel v-stat" data-tone="${esc(model.tone)}" data-reveal style="--r:${order}">
      <p class="v-eyebrow">${esc(model.label)}</p>
      <p class="v-stat-row">
        <span class="v-stat-value">${esc(model.value)}${model.unit ? `<small>${esc(model.unit)}</small>` : ""}</span>
        <span class="v-stat-note">${esc(model.note)}</span>
      </p>
    </section>`;
}

// ---- Ascension ladder (M) ------------------------------------------------------

/** @param {any} ctx */
function ladderModel(ctx) {
  const rows = ctx.h.characterRows(ctx.report).map((row) => {
    const mine = ctx.runs.filter((r) => String(r.character || "").toLowerCase() === row.key && ctx.h.isLadderRun(r) && Number.isFinite(r.ascension));
    const cleared = mine.filter((r) => r.won).reduce((top, r) => Math.max(top, r.ascension), -1);
    const next = cleared >= MAX_ASCENSION ? null : cleared + 1;
    const tries = next === null ? 0 : mine.filter((r) => r.ascension === next).length;
    return { key: row.key, label: row.label, portraitSrc: row.portraitSrc, isPortraitInked: row.isPortraitInked, played: mine.length, cleared, next, tries };
  });
  return { rows };
}

/** @param {ReturnType<typeof ladderModel>["rows"][number]} row */
function ladderRow(row) {
  const rungs = Array.from({ length: MAX_ASCENSION + 1 }, (_, level) => {
    const state = level <= row.cleared ? "is-cleared" : level === row.next ? "is-next" : "";
    return `<i class="${state}"></i>`;
  }).join("");
  const status = row.played === 0
    ? "No climbs yet"
    : row.next === null
      ? "A10 cleared"
      : `Next <b>A${row.next}</b> · ${row.tries === 0 ? "not tried yet" : row.tries === 1 ? "1 try" : `${row.tries} tries`}`;
  const art = row.portraitSrc
    ? `<img${row.isPortraitInked ? ' class="is-inked"' : ""} src="${esc(row.portraitSrc)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : "";
  return `
    <li class="v-ladder-row${row.played === 0 ? " is-unplayed" : ""}" data-char="${esc(row.key)}">
      <span class="v-ladder-art">${art}</span>
      <span class="v-ladder-name">${esc(row.label)}</span>
      <span class="v-ladder-rungs" role="img" aria-label="${row.cleared >= 0 ? `Cleared up to A${row.cleared}` : "No ascension cleared"}">${rungs}</span>
      <span class="v-ladder-status">${status}</span>
    </li>`;
}

/** @param {ReturnType<typeof ladderModel>} model @param {number} order */
function ladderHtml(model, order) {
  return `
    <section class="v-panel v-ladder" data-reveal style="--r:${order}" aria-label="Ascension ladder">
      <p class="v-eyebrow">Ascension ladder</p>
      <ol class="v-ladder-list">${model.rows.map(ladderRow).join("")}</ol>
    </section>`;
}

// ---- Relic impact (M) ----------------------------------------------------------

/** @param {any} ctx */
function relicImpactModel(ctx) {
  const total = ctx.runs.length;
  const baseline = ctx.report.overallWinrate;
  /** @type {Map<string, { runs: number, wins: number }>} */
  const tally = new Map();
  for (const run of ctx.runs) {
    for (const relic of new Set(run.relics || [])) {
      const t = tally.get(relic) || { runs: 0, wins: 0 };
      t.runs += 1;
      if (run.won === true) t.wins += 1;
      tally.set(relic, t);
    }
  }
  const rows = [...tally]
    .filter(([, t]) => t.runs >= RELIC_MIN_RUNS)
    .map(([key, t]) => ({ key, ...t, rate: t.wins / t.runs, ...wilson(t.wins, t.runs) }))
    .map((row) => ({ ...row, label: ctx.h.relicLabel(row.key), src: ctx.h.relicImageSrc(row.key), liftPts: (row.rate - baseline) * 100 }));
  const lifts = rows.filter((r) => r.rate > baseline).sort((a, b) => b.lo - a.lo).slice(0, RELIC_ROWS);
  const drags = rows.filter((r) => r.rate < baseline).sort((a, b) => a.hi - b.hi).slice(0, RELIC_ROWS);
  return { total, missing: Math.max(0, RELIC_MIN_TOTAL - total), baselinePct: baseline * 100, lifts, drags };
}

function relicImpactRow(row) {
  const sign = row.liftPts >= 0 ? "+" : "−";
  return `
    <li class="v-impact-row">
      <span class="v-impact-orb">${row.src ? `<img src="${esc(row.src)}" alt="" loading="lazy" decoding="async">` : ""}</span>
      <span class="v-impact-name">${esc(row.label)}</span>
      <span class="v-impact-lift ${row.liftPts >= 0 ? "is-win" : "is-loss"}">${sign}${fixed(Math.abs(row.liftPts), 0)}<small> pts</small></span>
      <span class="v-impact-n">${plural(row.runs, "climb")}</span>
    </li>`;
}

/** @param {ReturnType<typeof relicImpactModel>} model @param {number} order */
function relicImpactHtml(model, order) {
  const body = model.missing > 0
    ? `<p class="v-widget-needs">Needs ${plural(model.missing, "more climb")}: relic impact compares each relic with your own win rate.</p>`
    : `
      <div class="v-impact-cols">
        <div><p class="v-impact-head is-win">Lifts you</p><ol class="v-impact-list">${model.lifts.map(relicImpactRow).join("") || '<li class="v-impact-empty">Nothing clears the bar yet</li>'}</ol></div>
        <div><p class="v-impact-head is-loss">Drags you down</p><ol class="v-impact-list">${model.drags.map(relicImpactRow).join("") || '<li class="v-impact-empty">Nothing stands out</li>'}</ol></div>
      </div>`;
  return `
    <section class="v-panel v-impact" data-reveal style="--r:${order}" aria-label="Relic impact">
      <header class="v-impact-top">
        <p class="v-eyebrow">Relic impact</p>
        <span class="v-chip">vs your <b>${fixed(model.baselinePct)}%</b></span>
      </header>
      ${body}
    </section>`;
}

// ---- Since your last visit (W or L) -------------------------------------------

/** @param {any} ctx */
function visitModel(ctx) {
  const news = ctx.h.visitNews(ctx.byDateDesc);
  if (news.demo) return null;
  const week = ctx.h.weekRuns(ctx.byDateDesc, ctx.now);
  const wins = week.filter((r) => r.won).length;
  const best = week
    .filter((r) => r.won && ctx.h.isLadderRun(r))
    .sort((a, b) => (b.ascension || 0) - (a.ascension || 0))[0];
  return {
    newRuns: news.newRuns,
    sinceSession: news.sinceSession,
    week: { runs: week.length, wins, losses: week.length - wins },
    best: best ? { level: best.ascension || 0, name: ctx.h.characterName(best.character || "Unknown") } : null,
  };
}

/** A win/loss bar: green rises with wins, red with losses. */
function recordBar(wins, losses, label) {
  return `<span class="v-wl-bar" role="img" aria-label="${esc(label)}"><i class="is-win" style="flex-grow:${wins}"></i><i class="is-loss" style="flex-grow:${losses}"></i></span>`;
}

/** Nothing new and no climbs this week: the widget stays out of the way. */
function visitHtml(model, order) {
  if (!model || (model.newRuns === 0 && model.sinceSession === 0 && model.week.runs === 0)) return "";
  const fresh = model.newRuns || model.sinceSession;
  const news = fresh
    ? `<div class="v-visit-new">
        <span class="v-visit-num">${fresh}</span>
        <span class="v-visit-say"><b>new ${fresh === 1 ? "climb" : "climbs"}</b> ${model.newRuns ? "since your last visit" : "since last session"}</span>
      </div>`
    : '<div class="v-visit-new is-quiet"><span class="v-visit-say">Nothing new since your last visit</span></div>';
  const { runs, wins, losses } = model.week;
  const week = runs
    ? `<p class="v-visit-line"><b>${plural(runs, "climb")}</b><span class="v-visit-wl"><b class="is-win">${wins}W</b> · <b class="is-loss">${losses}L</b></span></p>
       ${recordBar(wins, losses, `${wins} won, ${losses} lost this week`)}`
    : '<p class="v-visit-line is-quiet">No climbs yet this week</p>';
  const best = model.best ? `<span class="v-chip v-visit-best">Best win <b>A${model.best.level}</b> ${esc(model.best.name)}</span>` : "";
  return `
    <section class="v-panel v-visit" data-reveal style="--r:${order}" aria-label="Since your last visit">
      ${news}
      <div class="v-visit-week">
        <p class="v-eyebrow">This week</p>
        ${week}
      </div>
      ${best}
    </section>`;
}

// ---- Solo vs co-op (M) -------------------------------------------------------------

const SPLIT_MIN_CLIMBS = 6;

/** @param {any} ctx */
function splitModel(ctx) {
  const side = (runs) => {
    const wins = runs.filter((r) => r.won).length;
    return { runs: runs.length, wins, losses: runs.length - wins, rate: runs.length ? wins / runs.length : 0 };
  };
  const coop = ctx.runs.filter((r) => Number(r.partySize) >= 2);
  const solo = ctx.runs.filter((r) => !(Number(r.partySize) >= 2));
  return { solo: side(solo), coop: side(coop) };
}

/** @param {string} name @param {{ runs: number, wins: number, losses: number, rate: number }} s */
function splitSide(name, s, emptyHtml) {
  if (s.runs === 0) {
    return `<div class="v-split-side is-empty"><p class="v-split-name">${esc(name)}</p>${emptyHtml}</div>`;
  }
  const enough = s.runs >= SPLIT_MIN_CLIMBS;
  const rate = enough
    ? `<p class="v-split-rate">${fixed(s.rate * 100)}<small>%</small></p>`
    : `<p class="v-split-needs">Needs ${plural(SPLIT_MIN_CLIMBS - s.runs, "more climb")} for a win rate</p>`;
  return `
      <div class="v-split-side">
        <p class="v-split-name">${esc(name)}</p>
        ${rate}
        <p class="v-split-rec"><b class="is-win">${s.wins}W</b> · <b class="is-loss">${s.losses}L</b> · ${plural(s.runs, "climb")}</p>
        ${recordBar(s.wins, s.losses, `${name}: ${s.wins} won, ${s.losses} lost`)}
      </div>`;
}

/** @param {ReturnType<typeof splitModel>} model @param {number} order */
function splitHtml(model, order) {
  const { solo, coop } = model;
  const both = solo.runs >= SPLIT_MIN_CLIMBS && coop.runs >= SPLIT_MIN_CLIMBS;
  const gap = both ? Math.round((coop.rate - solo.rate) * 100) : 0;
  const verdict = !both
    ? ""
    : gap === 0
      ? '<p class="v-split-verdict">Same win rate solo and in co-op</p>'
      : `<p class="v-split-verdict">You win <b>${Math.abs(gap)} pts</b> more often ${gap > 0 ? "in co-op" : "solo"}</p>`;
  const coopEmpty = `
        <p class="v-split-none">No co-op climbs yet</p>
        <button class="v-chip" type="button" data-action="goto-tab" data-tab="coop">Find a party</button>`;
  return `
    <section class="v-panel v-split" data-reveal style="--r:${order}" aria-label="Solo and co-op record">
      <p class="v-eyebrow">Solo vs co-op</p>
      <div class="v-split-cols">
        ${splitSide("Solo", solo, '<p class="v-split-none">No solo climbs yet</p>')}
        ${splitSide("Co-op", coop, coopEmpty)}
      </div>
      ${verdict}
    </section>`;
}

/** "Since your last visit", on the default layout (registry.js keeps it first). */
export const VISIT_WIDGET = Object.freeze({
  id: "notices",
  title: "Since your last visit",
  blurb: "New climbs since you were last here, and this week's wins and losses.",
  category: "progress",
  sizes: ["L", "W"],
  defaultSize: "W",
  reveals: false,
  needs: "Climbs from your save files",
  emptyText: "Shows up when you have new climbs since your last visit, or climbs this week.",
  previewWidth: 680,
  model: (ctx) => visitModel(ctx),
  html: (model) => visitHtml(model, 0),
});

/** Widget definitions, in the shape registry.js expects. */
export const MORE_WIDGETS = Object.freeze([
  {
    id: "stat",
    title: "Stat tile",
    blurb: "One number at a glance: climbs, hours, typical climb, highest win, wins this month or average floor.",
    category: "progress",
    sizes: ["S"],
    defaultSize: "S",
    repeatable: true,
    reveals: true,
    needs: "One climb",
    settings: { stat: { type: "choice", options: Object.keys(STAT_CHOICES), default: "climbs" } },
    settingLabels: { stat: { label: "Shows", options: STAT_CHOICES } },
    nameSetting: "stat",
    model: (ctx, settings) => statModel(ctx, settings.stat),
    html: (model, { order }) => statHtml(model, order),
  },
  {
    id: "ladder",
    title: "Ascension ladder",
    blurb: "The next ascension to clear with each climber, and how many tries it has taken.",
    category: "characters",
    sizes: ["M", "L", "W"],
    defaultSize: "M",
    reveals: true,
    needs: "One climb",
    model: (ctx) => ladderModel(ctx),
    html: (model, { order }) => ladderHtml(model, order),
  },
  {
    id: "relicImpact",
    title: "Relic impact",
    blurb: "Relics that lift your win rate above your own average, and the ones that drag it down.",
    category: "cards-relics",
    sizes: ["M", "L", "W"],
    defaultSize: "M",
    reveals: true,
    needs: `${RELIC_MIN_TOTAL} climbs`,
    model: (ctx) => relicImpactModel(ctx),
    html: (model, { order }) => relicImpactHtml(model, order),
  },
  {
    id: "coopSplit",
    title: "Solo vs co-op",
    blurb: "Your wins and losses climbing alone against climbing with a party.",
    category: "coop",
    sizes: ["M", "L", "W"],
    defaultSize: "M",
    reveals: true,
    needs: "One climb",
    model: (ctx) => splitModel(ctx),
    html: (model, { order }) => splitHtml(model, order),
  },
]);

