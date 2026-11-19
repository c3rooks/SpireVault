// The Overview's showcase widgets (new look): the ones that tell a player
// something about themselves they could not see before.
//   calendar  every day you climbed, a year at a glance, solo / co-op
//   gauntlet  how far your climbs get, and what ends them in each act
//   clock     when you climb, and when you win
//   cards     the card picks that lift your win rate, and the ones that sink it
// All from data the parser already keeps (dates, pathByAct, cardPicks,
// partySize). Every rate says how many climbs it stands on and waits for
// enough of them. Styles: styles/src/surfaces/overview-showcase.css.

import { esc, fixed } from "../html.js?v=1";
import { dayKey, addDays, countByDay, weekStartFor } from "../../run-dates.js?v=1";

const WEEKS_BY_SIZE = Object.freeze({ M: 18, L: 30, W: 53 });
const CAL_LEVELS = 4;
const MODE_LABELS = Object.freeze({ all: "All", solo: "Solo", coop: "Co-op" });
const CLOCK_MIN_CLIMBS = 10;
const CARD_MIN_CLIMBS = 8;
const CARD_ROWS = 3;
const Z_95 = 1.96;
const SHORT_DATE = Object.freeze({ month: "short", day: "numeric" });

/** @param {number} count @param {string} noun @param {string} [many] */
function plural(count, noun, many) {
  return `${count} ${count === 1 ? noun : many || `${noun}s`}`;
}

/** @param {any} run */
const isCoop = (run) => Number(run.partySize) >= 2;

/** @param {ReadonlyArray<any>} runs @param {string} mode */
function byMode(runs, mode) {
  if (mode === "coop") return runs.filter(isCoop);
  if (mode === "solo") return runs.filter((r) => !isCoop(r));
  return runs;
}

/** @param {any} run @returns {Date|null} */
function when(run) {
  const d = run.endedAt || run.startedAt;
  const date = d instanceof Date ? d : d ? new Date(d) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/** "Nov 12" for a day key. @param {string} key */
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", SHORT_DATE);
}

/** Wilson score interval at 95%. */
function wilson(wins, runs) {
  if (runs <= 0) return { lo: 0, hi: 1 };
  const p = wins / runs;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / runs;
  const center = p + z2 / (2 * runs);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * runs)) / runs);
  return { lo: Math.max(0, (center - margin) / denom), hi: Math.min(1, (center + margin) / denom) };
}

/** Chips that change one of the widget's own settings in place (index.js). */
function modeChips(setting, current, counts) {
  return `
      <div class="v-sc-chips" role="group" aria-label="Show">
        ${Object.entries(MODE_LABELS)
          .map(([value, label]) => `<button class="v-sc-chip" type="button" data-ov-set="${setting}" data-value="${value}" aria-pressed="${value === current}">${esc(label)}<small>${counts[value]}</small></button>`)
          .join("")}
      </div>`;
}

// ---- Climb calendar ---------------------------------------------------------------

/** @param {any} ctx @param {Readonly<Record<string, string>>} settings */
function calendarModel(ctx, settings) {
  const mode = MODE_LABELS[settings.mode] ? settings.mode : "all";
  const runs = byMode(ctx.runs, mode);
  const days = countByDay(runs.map((r) => ({ key: dayKey(when(r)), won: !!r.won })));
  const keys = [...days.keys()].sort();
  const today = dayKey(new Date(ctx.now));
  // Streaks of consecutive days played.
  let longest = 0;
  let longestEnd = "";
  let run = 0;
  let prev = "";
  for (const key of keys) {
    run = prev && addDays(prev, 1) === key ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = key;
    }
    prev = key;
  }
  let current = 0;
  for (let key = days.has(today) ? today : addDays(today, -1); days.has(key); key = addDays(key, -1)) current += 1;
  const best = keys.reduce((top, key) => (!top || days.get(key).runs > days.get(top).runs ? key : top), "");
  return {
    mode,
    counts: { all: ctx.runs.length, solo: ctx.runs.filter((r) => !isCoop(r)).length, coop: ctx.runs.filter(isCoop).length },
    days,
    today,
    firstDow: weekStartFor("en-US"),
    total: runs.length,
    daysPlayed: keys.length,
    winDays: keys.filter((key) => days.get(key).wins > 0).length,
    longest,
    longestEnd,
    current,
    best: best ? { key: best, runs: days.get(best).runs } : null,
    max: keys.reduce((m, key) => Math.max(m, days.get(key).runs), 0),
  };
}

/** @param {ReturnType<typeof calendarModel>} model @param {string} size */
function calendarGrid(model, size) {
  const weeks = WEEKS_BY_SIZE[size] || WEEKS_BY_SIZE.W;
  const todayDate = new Date(`${model.today}T00:00:00`);
  const lead = (todayDate.getDay() - model.firstDow + 7) % 7;
  const start = addDays(model.today, -(lead + (weeks - 1) * 7));
  const cols = [];
  const months = [];
  for (let w = 0; w < weeks; w += 1) {
    const cells = [];
    for (let d = 0; d < 7; d += 1) {
      const key = addDays(start, w * 7 + d);
      if (key > model.today) {
        cells.push('<i class="v-cal-day is-future"></i>');
        continue;
      }
      const day = model.days.get(key);
      const level = day ? Math.max(1, Math.ceil((day.runs / Math.max(1, model.max)) * CAL_LEVELS)) : 0;
      const tip = day ? `${dayLabel(key)} · ${plural(day.runs, "climb")}${day.wins ? `, ${plural(day.wins, "win")}` : ""}` : `${dayLabel(key)} · no climbs`;
      cells.push(`<i class="v-cal-day${day && day.wins ? " is-won" : ""}${key === model.today ? " is-today" : ""}" data-level="${level}" title="${esc(tip)}"></i>`);
      if (key.endsWith("-01") || (w === 0 && d === 0)) months.push({ w, label: new Date(`${key}T00:00:00`).toLocaleDateString("en-US", { month: "short" }) });
    }
    cols.push(`<span class="v-cal-week">${cells.join("")}</span>`);
  }
  const labels = months
    .filter((m, i) => i === 0 || m.w - months[i - 1].w >= 3)
    .map((m) => `<span style="--w:${m.w}">${esc(m.label)}</span>`)
    .join("");
  return { html: cols.join(""), labels, weeks };
}

/** @param {ReturnType<typeof calendarModel>} model @param {{ order: number, size: string }} opts */
function calendarHtml(model, { order, size }) {
  const grid = calendarGrid(model, size);
  const empty = model.total === 0
    ? `<div class="v-cal-empty"><p>${model.mode === "coop" ? "No co-op climbs yet. Every climb with a party lights a day here." : "No climbs yet."}</p>${model.mode === "coop" ? '<button class="v-chip" type="button" data-action="goto-tab" data-tab="coop">Find a party</button>' : ""}</div>`
    : "";
  const facts = [
    `<li><b>${model.daysPlayed}</b> ${model.daysPlayed === 1 ? "day" : "days"} climbed</li>`,
    `<li><b>${model.current}</b>-day streak${model.current ? " now" : ""}</li>`,
    `<li>Longest <b>${model.longest}</b> ${model.longest === 1 ? "day" : "days"}${model.longestEnd ? ` <small>to ${esc(dayLabel(model.longestEnd))}</small>` : ""}</li>`,
    model.best ? `<li>Busiest <b>${model.best.runs}</b> climbs <small>${esc(dayLabel(model.best.key))}</small></li>` : "",
  ].join("");
  return `
    <section class="v-panel v-cal" data-reveal style="--r:${order}" aria-label="Climb calendar">
      <header class="v-sc-head">
        <div><p class="v-eyebrow">Climb calendar</p><h3 class="v-sc-title">Every day you climbed</h3></div>
        ${modeChips("mode", model.mode, model.counts)}
      </header>
      <div class="v-cal-frame">
        <div class="v-cal-months" aria-hidden="true" style="--weeks:${grid.weeks}">${grid.labels}</div>
        <div class="v-cal-grid" role="img" style="--weeks:${grid.weeks}"
             aria-label="${esc(`${MODE_LABELS[model.mode]} climbs: ${model.daysPlayed} days played, ${model.winDays} with a win, longest streak ${model.longest} days.`)}">${grid.html}</div>
        ${empty}
      </div>
      <footer class="v-cal-foot">
        <ul class="v-sc-facts">${facts}</ul>
        <span class="v-cal-legend" aria-hidden="true">Less <i data-level="1"></i><i data-level="2"></i><i data-level="3"></i><i data-level="4"></i> More <i class="is-won" data-level="2"></i> a win</span>
      </footer>
    </section>`;
}

// ---- The gauntlet ------------------------------------------------------------------

const CAUSES = Object.freeze([
  { id: "elite", label: "Elites" },
  { id: "boss", label: "Bosses" },
  { id: "combat", label: "Monsters" },
  { id: "abandoned", label: "Abandoned" },
  { id: "other", label: "Other" },
]);
const ACTS = 3;

/** @param {any} ctx */
function gauntletModel(ctx) {
  const runs = ctx.runs.filter((r) => Array.isArray(r.pathByAct) && r.pathByAct.length > 0);
  const total = runs.length;
  const acts = Array.from({ length: ACTS }, (_, i) => ({ act: i + 1, reached: 0, ended: 0, causes: Object.fromEntries(CAUSES.map((c) => [c.id, 0])) }));
  let wins = 0;
  for (const run of runs) {
    const entered = Math.min(run.pathByAct.length, ACTS);
    for (let i = 0; i < entered; i += 1) acts[i].reached += 1;
    if (run.won) {
      wins += 1;
      continue;
    }
    const last = run.pathByAct[run.pathByAct.length - 1].nodes.at(-1);
    const type = run.wasAbandoned ? "abandoned" : last && ["elite", "boss", "combat"].includes(last.type) ? last.type : "other";
    const act = acts[entered - 1];
    act.ended += 1;
    act.causes[type] += 1;
  }
  // The single biggest thing that ends climbs, abandoning aside.
  let worst = null;
  for (const act of acts) {
    for (const cause of CAUSES) {
      if (cause.id === "abandoned" || cause.id === "other") continue;
      const n = act.causes[cause.id];
      if (!worst || n > worst.n) worst = { act: act.act, cause: cause.id, n };
    }
  }
  const abandoned = acts.reduce((sum, a) => sum + a.causes.abandoned, 0);
  return { total, wins, acts, worst, abandoned };
}

const CAUSE_WORDS = Object.freeze({ elite: "elites", boss: "the boss", combat: "monsters" });

/** @param {ReturnType<typeof gauntletModel>} model @param {{ order: number }} opts */
function gauntletHtml(model, { order }) {
  if (model.total < 5) {
    return `<section class="v-panel v-gnt" data-reveal style="--r:${order}"><p class="v-eyebrow">The gauntlet</p><p class="v-widget-needs">Needs ${plural(5 - model.total, "more climb")} with a map path to show where your climbs end.</p></section>`;
  }
  const pct = (n) => (model.total ? (n / model.total) * 100 : 0);
  const rows = model.acts
    .map((act) => {
      const segs = CAUSES.filter((c) => act.causes[c.id] > 0)
        .map((c) => `<i class="is-${c.id}" style="flex-grow:${act.causes[c.id]}" title="${esc(`${c.label}: ${act.causes[c.id]}`)}"></i>`)
        .join("");
      const top = CAUSES.filter((c) => act.causes[c.id] > 0).sort((a, b) => act.causes[b.id] - act.causes[a.id])[0];
      return `
        <li class="v-gnt-row">
          <span class="v-gnt-act">Act ${act.act}</span>
          <span class="v-gnt-reach"><i style="width:${pct(act.reached).toFixed(1)}%"></i><b>${fixed(pct(act.reached), 0)}%</b></span>
          <span class="v-gnt-end">
            <span class="v-gnt-segs" style="width:${pct(act.ended).toFixed(1)}%">${segs}</span>
            <small>${act.ended ? `${plural(act.ended, "climb")} end here${top ? (top.id === "abandoned" ? ", most abandoned" : `, most to ${esc(top.label.toLowerCase())}`) : ""}` : "None end here"}</small>
          </span>
        </li>`;
    })
    .join("");
  const worst = model.worst && model.worst.n > 0
    ? `Act ${model.worst.act} ${CAUSE_WORDS[model.worst.cause]} end <b>${fixed(pct(model.worst.n), 0)}%</b> of your climbs`
    : "";
  const quit = model.abandoned ? ` · you abandon <b>1 in ${Math.max(1, Math.round(model.total / model.abandoned))}</b>` : "";
  return `
    <section class="v-panel v-gnt" data-reveal style="--r:${order}" aria-label="How far your climbs get">
      <header class="v-sc-head">
        <div><p class="v-eyebrow">The gauntlet</p><h3 class="v-sc-title">How far your climbs get</h3></div>
      </header>
      <p class="v-sc-insight">${worst}${quit}</p>
      <ol class="v-gnt-list">
        ${rows}
        <li class="v-gnt-row is-win">
          <span class="v-gnt-act">Victory</span>
          <span class="v-gnt-reach"><i style="width:${pct(model.wins).toFixed(1)}%"></i><b>${fixed(pct(model.wins), 1)}%</b></span>
          <span class="v-gnt-end"><small>${plural(model.wins, "win")} of ${model.total}</small></span>
        </li>
      </ol>
      <p class="v-gnt-key" aria-hidden="true">${CAUSES.map((c) => `<span><i class="is-${c.id}"></i>${esc(c.label)}</span>`).join("")}</p>
    </section>`;
}

// ---- Play clock --------------------------------------------------------------------

/** @param {any} ctx */
function clockModel(ctx) {
  const hours = Array.from({ length: 24 }, () => ({ runs: 0, wins: 0 }));
  for (const run of ctx.runs) {
    const d = run.startedAt instanceof Date ? run.startedAt : null;
    if (!d || !Number.isFinite(d.getTime())) continue;
    const h = hours[d.getHours()];
    h.runs += 1;
    if (run.won) h.wins += 1;
  }
  const total = hours.reduce((s, h) => s + h.runs, 0);
  const wins = hours.reduce((s, h) => s + h.wins, 0);
  const peak = hours.reduce((best, h, i) => (h.runs > hours[best].runs ? i : best), 0);
  const ranked = hours
    .map((h, i) => ({ i, ...h, lo: wilson(h.wins, h.runs).lo }))
    .filter((h) => h.runs >= CLOCK_MIN_CLIMBS)
    .sort((a, b) => b.lo - a.lo);
  const night = hours.reduce((s, h, i) => s + (i >= 22 || i < 4 ? h.runs : 0), 0);
  return { hours, total, baseline: total ? wins / total : 0, peak, bestHour: ranked[0] || null, night };
}

/** "9 PM" @param {number} h */
function hourLabel(h) {
  const suffix = h < 12 ? "AM" : "PM";
  return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
}

/** @param {ReturnType<typeof clockModel>} model @param {{ order: number }} opts */
function clockHtml(model, { order }) {
  if (model.total < CLOCK_MIN_CLIMBS) {
    return `<section class="v-panel v-clock" data-reveal style="--r:${order}"><p class="v-eyebrow">Play clock</p><p class="v-widget-needs">Needs ${plural(CLOCK_MIN_CLIMBS - model.total, "more climb")} to find your hours.</p></section>`;
  }
  const max = Math.max(...model.hours.map((h) => h.runs), 1);
  const R0 = 34;
  const R1 = 92;
  const wedges = model.hours
    .map((h, i) => {
      if (!h.runs) return "";
      const r = R0 + ((R1 - R0) * h.runs) / max;
      const a0 = ((i - 6) / 24) * Math.PI * 2 + 0.02;
      const a1 = ((i - 5) / 24) * Math.PI * 2 - 0.02;
      const p = (rad, a) => `${(100 + rad * Math.cos(a)).toFixed(1)} ${(100 + rad * Math.sin(a)).toFixed(1)}`;
      const rate = h.wins / h.runs;
      const tone = h.runs < CLOCK_MIN_CLIMBS ? "is-thin" : rate > model.baseline ? "is-up" : rate < model.baseline ? "is-down" : "";
      return `<path class="v-clock-w ${tone}" d="M${p(R0, a0)} L${p(r, a0)} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${p(r, a1)} L${p(R0, a1)} A${R0} ${R0} 0 0 0 ${p(R0, a0)} Z"><title>${esc(`${hourLabel(i)}: ${plural(h.runs, "climb")}, ${fixed(rate * 100, 0)}% won`)}</title></path>`;
    })
    .join("");
  const ticks = [0, 6, 12, 18]
    .map((h) => {
      const a = ((h - 6) / 24) * Math.PI * 2;
      return `<text x="${(100 + 104 * Math.cos(a)).toFixed(1)}" y="${(100 + 104 * Math.sin(a) + 4).toFixed(1)}">${h === 0 ? "12a" : h === 12 ? "12p" : h === 6 ? "6a" : "6p"}</text>`;
    })
    .join("");
  const best = model.bestHour
    ? `<li>You win most at <b>${hourLabel(model.bestHour.i)}</b> <small>${fixed((model.bestHour.wins / model.bestHour.runs) * 100, 0)}% of ${model.bestHour.runs}</small></li>`
    : `<li>Hours with ${CLOCK_MIN_CLIMBS}+ climbs show their win rate</li>`;
  const nightShare = model.total ? Math.round((model.night / model.total) * 100) : 0;
  return `
    <section class="v-panel v-clock" data-reveal style="--r:${order}" aria-label="When you climb">
      <header class="v-sc-head"><div><p class="v-eyebrow">Play clock</p><h3 class="v-sc-title">When you climb</h3></div></header>
      <div class="v-clock-body">
        <svg class="v-clock-dial" viewBox="-10 -10 220 220" role="img" aria-label="${esc(`Climbs by starting hour. Busiest at ${hourLabel(model.peak)}.`)}">
          <circle class="v-clock-ring" cx="100" cy="100" r="${R1 + 2}"/>
          ${wedges}
          <circle class="v-clock-hub" cx="100" cy="100" r="${R0 - 4}"/>
          <text class="v-clock-peak" x="100" y="98">${esc(hourLabel(model.peak))}</text>
          <text class="v-clock-sub" x="100" y="114">busiest</text>
          <g class="v-clock-ticks">${ticks}</g>
        </svg>
        <ul class="v-sc-facts is-stack">
          ${best}
          <li><b>${nightShare}%</b> of climbs start after 10 PM</li>
          <li class="v-clock-key"><span><i class="is-up"></i>wins more than usual</span><span><i class="is-down"></i>less</span></li>
        </ul>
      </div>
    </section>`;
}

// ---- Picks that win ----------------------------------------------------------------

/** @param {any} ctx */
function cardsModel(ctx) {
  const baseline = ctx.report.overallWinrate;
  /** @type {Map<string, { runs: number, wins: number }>} */
  const tally = new Map();
  let withPicks = 0;
  for (const run of ctx.runs) {
    const picked = new Set((run.cardPicks || []).map((p) => p.picked).filter(Boolean));
    if (picked.size) withPicks += 1;
    for (const id of picked) {
      const t = tally.get(id) || { runs: 0, wins: 0 };
      t.runs += 1;
      if (run.won) t.wins += 1;
      tally.set(id, t);
    }
  }
  const rows = [...tally]
    .filter(([, t]) => t.runs >= CARD_MIN_CLIMBS)
    .map(([id, t]) => ({ id, ...t, rate: t.wins / t.runs, ...wilson(t.wins, t.runs) }))
    .map((row) => ({ ...row, label: ctx.h.cardLabel(row.id), src: ctx.h.cardImageSrc(row.id), lift: (row.rate - baseline) * 100 }));
  return {
    withPicks,
    baseline,
    best: rows.filter((r) => r.rate > baseline).sort((a, b) => b.lo - a.lo).slice(0, CARD_ROWS),
    worst: rows.filter((r) => r.rate < baseline).sort((a, b) => a.hi - b.hi).slice(0, CARD_ROWS),
  };
}

function cardFace(row) {
  const sign = row.lift >= 0 ? "+" : "−";
  return `
        <li class="v-pick">
          <span class="v-pick-art">${row.src ? `<img src="${esc(row.src)}" alt="" loading="lazy" decoding="async" width="205" height="256">` : ""}</span>
          <span class="v-pick-name">${esc(row.label)}</span>
          <span class="v-pick-lift ${row.lift >= 0 ? "is-win" : "is-loss"}">${sign}${fixed(Math.abs(row.lift), 0)}<small> pts</small></span>
          <span class="v-pick-n">${plural(row.runs, "climb")}</span>
        </li>`;
}

/** @param {ReturnType<typeof cardsModel>} model @param {{ order: number }} opts */
function cardsHtml(model, { order }) {
  if (model.withPicks < 20) {
    return `<section class="v-panel v-picks" data-reveal style="--r:${order}"><p class="v-eyebrow">Picks that win</p><p class="v-widget-needs">Needs card picks from ${plural(20 - model.withPicks, "more climb")}; they come from your save files.</p></section>`;
  }
  return `
    <section class="v-panel v-picks" data-reveal style="--r:${order}" aria-label="Card picks that change your win rate">
      <header class="v-sc-head">
        <div><p class="v-eyebrow">Picks that win</p><h3 class="v-sc-title">Cards that change your odds</h3></div>
        <span class="v-chip">vs your <b>${fixed(model.baseline * 100)}%</b></span>
      </header>
      <div class="v-picks-cols">
        <div><p class="v-impact-head is-win">Take these</p><ol class="v-picks-row">${model.best.map(cardFace).join("") || '<li class="v-impact-empty">Nothing clears the bar yet</li>'}</ol></div>
        <div><p class="v-impact-head is-loss">Think twice</p><ol class="v-picks-row">${model.worst.map(cardFace).join("") || '<li class="v-impact-empty">Nothing stands out</li>'}</ol></div>
      </div>
      <p class="v-sc-note">Climbs where you picked the card at least once, ranked so a lucky few climbs can't top the list.</p>
    </section>`;
}

/** Widget definitions, in the shape registry.js expects. */
export const SHOWCASE_WIDGETS = Object.freeze([
  {
    id: "calendar",
    title: "Climb calendar",
    blurb: "Every day you climbed this year, your streaks and your busiest day. Switch between solo and co-op.",
    category: "progress",
    sizes: ["M", "L", "W"],
    defaultSize: "W",
    repeatable: true,
    reveals: true,
    needs: "One climb",
    settings: { mode: { type: "choice", options: ["all", "solo", "coop"], default: "all" } },
    settingLabels: { mode: { label: "Climbs", options: { all: "All", solo: "Solo", coop: "Co-op" } } },
    previewWidth: 760,
    model: (ctx, settings) => calendarModel(ctx, settings),
    html: (model, opts) => calendarHtml(model, opts),
  },
  {
    id: "gauntlet",
    title: "The gauntlet",
    blurb: "How far your climbs get, act by act, and what ends them: elites, bosses, monsters or quitting.",
    category: "paths",
    sizes: ["M", "L", "W"],
    defaultSize: "L",
    reveals: true,
    needs: "Five climbs",
    model: (ctx) => gauntletModel(ctx),
    html: (model, opts) => gauntletHtml(model, opts),
  },
  {
    id: "clock",
    title: "Play clock",
    blurb: "The hours you climb and the hours you win, on a 24-hour dial.",
    category: "paths",
    sizes: ["M", "L"],
    defaultSize: "M",
    reveals: true,
    needs: `${CLOCK_MIN_CLIMBS} climbs`,
    model: (ctx) => clockModel(ctx),
    html: (model, opts) => clockHtml(model, opts),
  },
  {
    id: "cards",
    title: "Picks that win",
    blurb: "The card picks that lift your win rate above your own average, and the ones that sink it, with their art.",
    category: "cards-relics",
    sizes: ["M", "L", "W"],
    defaultSize: "L",
    reveals: true,
    needs: "Card picks from 20 climbs",
    model: (ctx) => cardsModel(ctx),
    html: (model, opts) => cardsHtml(model, opts),
  },
]);
