// Chart builder for the new UI.
//
// Replaces the per-chart hand-built SVG strings with two builders that share
// one structure: an SVG of shapes stretched to its box, HTML labels and
// markers laid over it, a hidden data table for screen readers, and delegated
// pointer + keyboard interaction. Colours are CSS variables, so charts follow
// the theme with no re-render.

import { esc, clamp } from "./html.js?v=1";

const VIEW_W = 1000;
const VIEW_H = 300;
const PAD_Y = 10;
const PLOT_H = VIEW_H - PAD_Y * 2;
const TIP_ID = "v-tip";
const TIP_OFFSET_PX = 14;
const MIN_POINTS = 5;
const MAX_X_LABELS = 5;
const MAX_TABLE_ROWS = 60;
/** Share of the plot height above the baseline in the floors chart. */
const FLOOR_BASELINE_RATIO = 0.36;
/** Share of the trend plot's width, from the right, under the "avg" chip
 *  (a phone is the narrow case: about 70px of a 300px plot). */
const AVG_LABEL_SPAN = 0.25;
/** An average this close to the top or bottom of the plot keeps its label
 *  on the inside, so the label is never cut off by the plot's edge. */
const AVG_LABEL_EDGE = 0.15;
/** How far the "avg" chip reaches off the dashed line, as a share of the
 *  plot (chip + gap + half the inked line on the 160px phone plot). */
const AVG_LABEL_BAND = 0.18;
/** The chip may step this far off the dashed line to clear a spike (about
 *  12px on a phone); further than that it would stop reading as the
 *  line's label, so it stays put and the spike passes behind it. */
const AVG_LABEL_MAX_LIFT = 0.08;

/** @param {number} value 0..1 → y in viewBox units */
function yFor(value) {
  return PAD_Y + (1 - clamp(value, 0, 1)) * PLOT_H;
}

/** @param {number} value 0..1 → % from the top of the plot box */
function topPct(value) {
  return (yFor(value) / VIEW_H) * 100;
}

/** @param {number} value */
function pct(value) {
  return `${Math.round(value * 100)}%`;
}

/**
 * Which side of the dashed average line the "avg" label sits on: the side
 * where fewer runs at the right end would pass behind the label, and on a
 * tie away from where the line mostly runs. The label is an opaque chip
 * (charts.css), so a spike that still reaches it goes behind it, not
 * through the text.
 * @param {ReadonlyArray<number>} values  0..1, oldest → newest
 * @param {number} lifetime               0..1
 * @returns {"above"|"below"}
 */
function avgLabelSide(values, lifetime) {
  if (lifetime > 1 - AVG_LABEL_EDGE) return "below";
  if (lifetime < AVG_LABEL_EDGE) return "above";
  const tail = labelTail(values);
  const hitsAbove = tail.filter((value) => value > lifetime && value <= lifetime + AVG_LABEL_BAND).length;
  const hitsBelow = tail.filter((value) => value < lifetime && value >= lifetime - AVG_LABEL_BAND).length;
  if (hitsAbove !== hitsBelow) return hitsAbove < hitsBelow ? "above" : "below";
  const above = tail.filter((value) => value > lifetime).length;
  return above > tail.length / 2 ? "below" : "above";
}

/**
 * The runs under the "avg" chip: the right-hand end of the plot.
 * @param {ReadonlyArray<number>} values
 * @returns {ReadonlyArray<number>}
 */
function labelTail(values) {
  return values.slice(Math.floor(values.length * (1 - AVG_LABEL_SPAN)));
}

/**
 * The value the "avg" chip sits against: the average itself, or, when a
 * spike at the right end would reach into the chip, just past the highest
 * (lowest, below the line) such spike, so the chip clears the line instead
 * of sitting on it. Never more than AVG_LABEL_MAX_LIFT off the average.
 * @param {ReadonlyArray<number>} values  0..1, oldest → newest
 * @param {number} lifetime               0..1
 * @param {"above"|"below"} side
 * @returns {number}
 */
function avgLabelAnchor(values, lifetime, side) {
  const dir = side === "above" ? 1 : -1;
  const tail = labelTail(values);
  let anchor = lifetime;
  for (;;) {
    const reach = tail
      .map((value) => (value - anchor) * dir)
      .filter((step) => step > 0 && step <= AVG_LABEL_BAND);
    if (reach.length === 0) return anchor;
    const next = anchor + dir * Math.max(...reach);
    if (Math.abs(next - lifetime) > AVG_LABEL_MAX_LIFT) return lifetime;
    anchor = next;
  }
}

/**
 * @param {string} title
 * @param {string} message
 * @param {number} order  reveal order
 * @returns {string}
 */
function emptyPanel(title, message, order) {
  return `
    <section class="v-panel v-chart-panel" data-reveal style="--r:${order}">
      <header class="v-chart-head"><h3>${esc(title)}</h3></header>
      <p class="v-chart-empty">${esc(message)}</p>
    </section>`;
}

/**
 * Rolling win-rate line.
 * @param {{ values: number[], lifetime: number, windowSize: number }|null} data
 *   values: trailing win rate (0..1) at each run, oldest → newest
 * @param {number} [order]
 * @returns {string}
 */
export function trendChartHtml(data, order = 0) {
  const title = "Win-rate trend";
  if (!data || data.values.length < MIN_POINTS) {
    return emptyPanel(title, `Play at least ${MIN_POINTS} runs to see your rolling win rate over time.`, order);
  }
  const { values, lifetime, windowSize } = data;
  const count = values.length;
  const xFor = (index) => (index / (count - 1)) * VIEW_W;
  const line = values
    .map((value, index) => `${index === 0 ? "M" : "L"}${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${VIEW_W} ${VIEW_H} L0 ${VIEW_H} Z`;
  const last = values[count - 1];
  const labelSide = avgLabelSide(values, lifetime);
  const grid = [0, 0.5, 1]
    .map((tick) => `<line class="v-chart-grid" x1="0" x2="${VIEW_W}" y1="${yFor(tick)}" y2="${yFor(tick)}"/>`)
    .join("");
  const yLabels = [1, 0.5, 0]
    .map((tick) => `<span style="top:${topPct(tick).toFixed(2)}%">${pct(tick)}</span>`)
    .join("");
  // The table is for screen readers; thousands of rows help nobody. Sample
  // evenly and always include the latest run.
  const rowStep = Math.max(1, Math.ceil(count / MAX_TABLE_ROWS));
  const rows = values
    .map((value, index) => ({ value, index }))
    .filter(({ index }) => index % rowStep === 0 || index === count - 1)
    .map(({ value, index }) => `<tr><td>${index + 1}</td><td>${pct(value)}</td></tr>`)
    .join("");

  return `
    <section class="v-panel v-chart-panel" data-reveal style="--r:${order}">
      <header class="v-chart-head">
        <h3>${title}</h3>
        <p>Trailing ${windowSize}-run win rate. Dashed line is your lifetime average.</p>
      </header>
      <figure class="v-chart" data-chart="trend" tabindex="0"
              data-values="${values.map((value) => value.toFixed(3)).join(",")}"
              data-window="${windowSize}"
              aria-label="Rolling win rate across ${count} runs. Now ${pct(last)}, lifetime average ${pct(lifetime)}. Use the arrow keys to step through runs.">
        <div class="v-chart-y" aria-hidden="true">${yLabels}</div>
        <div class="v-chart-plot">
          <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="v-trend-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style="stop-color:var(--v-title);stop-opacity:0.34"/>
                <stop offset="1" style="stop-color:var(--v-title);stop-opacity:0"/>
              </linearGradient>
            </defs>
            ${grid}
            <line class="v-chart-avg" x1="0" x2="${VIEW_W}" y1="${yFor(lifetime).toFixed(1)}" y2="${yFor(lifetime).toFixed(1)}"/>
            <path class="v-chart-area" d="${area}" fill="url(#v-trend-fill)"/>
            <path class="v-chart-ink" d="${line}"/>
            <path class="v-chart-line" d="${line}" pathLength="1"/>
          </svg>
          <span class="v-chart-avg-label" data-side="${labelSide}" style="top:${topPct(avgLabelAnchor(values, lifetime, labelSide)).toFixed(2)}%">avg ${pct(lifetime)}</span>
          <span class="v-chart-cross"></span>
          <span class="v-chart-dot" style="left:100%;top:${topPct(last).toFixed(2)}%"></span>
        </div>
        <div class="v-chart-x" aria-hidden="true"><span>Run 1</span><span>Run ${count}</span></div>
        <div class="v-sr"><table>
          <caption>Trailing ${windowSize}-run win rate by run</caption>
          <thead><tr><th>Run</th><th>Win rate</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </figure>
    </section>`;
}

/**
 * Where runs end: victories rise from the baseline, defeats fall below it.
 * Direction carries the meaning as well as colour.
 *
 * The two directions are scaled separately, and the axis says so. Victories
 * almost all end on the final floor, so on a shared scale one tall bar would
 * flatten every defeat bar into a sliver — and where runs die is the point
 * of the chart.
 * @param {{ bins: Array<{ label: string, wins: number, losses: number }> }|null} data
 * @param {number} [order]
 * @returns {string}
 */
export function floorChartHtml(data, order = 0) {
  const title = "Where climbs end";
  const total = data ? data.bins.reduce((sum, bin) => sum + bin.wins + bin.losses, 0) : 0;
  if (!data || total < MIN_POINTS) {
    return emptyPanel(title, `Play at least ${MIN_POINTS} runs to see where your climbs end.`, order);
  }
  const { bins } = data;
  const maxWins = Math.max(...bins.map((bin) => bin.wins), 0);
  const maxLosses = Math.max(...bins.map((bin) => bin.losses), 0);
  const ratio = maxWins === 0 ? 0 : maxLosses === 0 ? 1 : FLOOR_BASELINE_RATIO;
  const baseline = PAD_Y + PLOT_H * ratio;
  const winUnit = maxWins > 0 ? (baseline - PAD_Y) / maxWins : 0;
  const lossUnit = maxLosses > 0 ? (PAD_Y + PLOT_H - baseline) / maxLosses : 0;
  const slot = VIEW_W / bins.length;
  const barW = slot * 0.7;
  const basePct = (baseline / VIEW_H) * 100;
  const yLabels = [
    maxWins > 0 ? `<span class="is-win" style="top:${((PAD_Y / VIEW_H) * 100).toFixed(2)}%">${maxWins}</span>` : "",
    `<span style="top:${basePct.toFixed(2)}%">0</span>`,
    maxLosses > 0 ? `<span class="is-loss" style="top:${(((PAD_Y + PLOT_H) / VIEW_H) * 100).toFixed(2)}%">${maxLosses}</span>` : "",
  ].join("");

  const bars = bins
    .map((bin, index) => {
      const x = index * slot + (slot - barW) / 2;
      const winH = bin.wins * winUnit;
      const lossH = bin.losses * lossUnit;
      const tip = `Floor ${bin.label}: ${bin.wins} won, ${bin.losses} lost`;
      return `
        <g class="v-bar" style="--i:${index}" data-tip="${esc(tip)}">
          <rect class="v-bar-hit" x="${(index * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${VIEW_H}"/>
          ${bin.wins > 0 ? `<rect class="v-bar-win" x="${x.toFixed(1)}" y="${(baseline - winH).toFixed(1)}" width="${barW.toFixed(1)}" height="${winH.toFixed(1)}"/>` : ""}
          ${bin.losses > 0 ? `<rect class="v-bar-loss" x="${x.toFixed(1)}" y="${baseline.toFixed(1)}" width="${barW.toFixed(1)}" height="${lossH.toFixed(1)}"/>` : ""}
        </g>`;
    })
    .join("");

  const labelStep = Math.max(1, Math.ceil(bins.length / MAX_X_LABELS));
  const xLabels = bins
    .filter((_, index) => index % labelStep === 0 || index === bins.length - 1)
    .map((bin) => `<span>${esc(bin.label)}</span>`)
    .join("");
  const rows = bins
    .map((bin) => `<tr><td>${esc(bin.label)}</td><td>${bin.wins}</td><td>${bin.losses}</td></tr>`)
    .join("");

  return `
    <section class="v-panel v-chart-panel" data-reveal style="--r:${order}">
      <header class="v-chart-head">
        <h3>${title}</h3>
        <div class="v-chart-legend" aria-hidden="true">
          <span class="v-chip"><i style="--c:var(--v-win)"></i>Victories rise</span>
          <span class="v-chip"><i style="--c:var(--v-loss)"></i>Defeats fall</span>
        </div>
        <p class="v-chart-note">By the floor a run ended on. Each direction has its own scale.</p>
      </header>
      <figure class="v-chart" data-chart="floors"
              aria-label="Floor where each run ended. Victories are drawn above the line, defeats below, each on its own scale.">
        <div class="v-chart-y" aria-hidden="true">${yLabels}</div>
        <div class="v-chart-plot v-chart-bars">
          <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="none" aria-hidden="true">
            ${bars}
            <line class="v-chart-base" x1="0" x2="${VIEW_W}" y1="${baseline.toFixed(1)}" y2="${baseline.toFixed(1)}"/>
          </svg>
        </div>
        <div class="v-chart-x" aria-hidden="true">${xLabels}</div>
        <div class="v-sr"><table>
          <caption>Runs ended by floor</caption>
          <thead><tr><th>Floor</th><th>Won</th><th>Lost</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </figure>
    </section>`;
}

// ---------------------------------------------------------------------------
// Interaction (delegated; survives innerHTML re-renders)
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} the single shared tooltip */
function tipEl() {
  const existing = document.getElementById(TIP_ID);
  if (existing) return existing;
  const tip = document.createElement("div");
  tip.id = TIP_ID;
  tip.className = "v-tip";
  tip.setAttribute("role", "status");
  tip.hidden = true;
  document.body.appendChild(tip);
  return tip;
}

/**
 * @param {string} html  trusted markup built in this module
 * @param {number} clientX
 * @param {number} clientY
 */
function showTip(html, clientX, clientY) {
  const tip = tipEl();
  tip.innerHTML = html;
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const x = clamp(clientX + TIP_OFFSET_PX, 8, window.innerWidth - box.width - 8);
  const above = clientY - box.height - TIP_OFFSET_PX;
  const y = above > 8 ? above : clientY + TIP_OFFSET_PX;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

export function hideChartTip() {
  const tip = document.getElementById(TIP_ID);
  if (tip) tip.hidden = true;
}

/**
 * @param {HTMLElement} figure
 * @returns {number[]}
 */
function trendValues(figure) {
  return (figure.dataset.values || "")
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

/**
 * Moves the crosshair, marker and tooltip to a run index.
 * @param {HTMLElement} figure
 * @param {number} index
 */
function focusTrendPoint(figure, index) {
  const values = trendValues(figure);
  if (values.length < 2) return;
  const safe = clamp(Math.round(index), 0, values.length - 1);
  const plot = /** @type {HTMLElement|null} */ (figure.querySelector(".v-chart-plot"));
  const dot = /** @type {HTMLElement|null} */ (figure.querySelector(".v-chart-dot"));
  const cross = /** @type {HTMLElement|null} */ (figure.querySelector(".v-chart-cross"));
  if (!plot || !dot || !cross) return;
  const leftPct = (safe / (values.length - 1)) * 100;
  dot.style.left = `${leftPct}%`;
  dot.style.top = `${topPct(values[safe])}%`;
  cross.style.left = `${leftPct}%`;
  figure.classList.add("is-active");
  figure.dataset.index = String(safe);
  const box = plot.getBoundingClientRect();
  showTip(
    `<b>${pct(values[safe])}</b> · run ${safe + 1} of ${values.length}<br>over the previous ${esc(figure.dataset.window || "10")}`,
    box.left + (leftPct / 100) * box.width,
    box.top + (topPct(values[safe]) / 100) * box.height
  );
}

/** @param {HTMLElement} figure */
function resetTrend(figure) {
  const values = trendValues(figure);
  const dot = /** @type {HTMLElement|null} */ (figure.querySelector(".v-chart-dot"));
  figure.classList.remove("is-active");
  delete figure.dataset.index;
  if (dot && values.length) {
    dot.style.left = "100%";
    dot.style.top = `${topPct(values[values.length - 1])}%`;
  }
  hideChartTip();
}

/** Wires chart interaction once for the whole document. */
export function initCharts() {
  document.addEventListener(
    "pointermove",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const plot = target ? target.closest(".v-chart-plot") : null;
      if (!plot) return;
      const figure = /** @type {HTMLElement|null} */ (plot.closest(".v-chart"));
      if (!figure) return;
      if (figure.dataset.chart === "trend") {
        const box = plot.getBoundingClientRect();
        const ratio = clamp((event.clientX - box.left) / box.width, 0, 1);
        focusTrendPoint(figure, ratio * (trendValues(figure).length - 1));
        return;
      }
      const bar = target ? target.closest(".v-bar") : null;
      const tip = bar ? /** @type {SVGElement} */ (bar).dataset.tip : "";
      if (tip) showTip(esc(tip), event.clientX, event.clientY);
      else hideChartTip();
    },
    { passive: true }
  );

  document.addEventListener(
    "pointerout",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const plot = target ? target.closest(".v-chart-plot") : null;
      if (!plot) return;
      const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
      if (next && plot.contains(next)) return;
      const figure = /** @type {HTMLElement|null} */ (plot.closest(".v-chart"));
      if (figure && figure.dataset.chart === "trend") resetTrend(figure);
      else hideChartTip();
    },
    { passive: true }
  );

  document.addEventListener("keydown", (event) => {
    const figure = event.target instanceof HTMLElement ? event.target.closest('.v-chart[data-chart="trend"]') : null;
    if (!figure || event.target !== figure) return;
    const element = /** @type {HTMLElement} */ (figure);
    const count = trendValues(element).length;
    const current = Number(element.dataset.index ?? count - 1);
    if (event.key === "ArrowLeft") focusTrendPoint(element, current - 1);
    else if (event.key === "ArrowRight") focusTrendPoint(element, current + 1);
    else if (event.key === "Home") focusTrendPoint(element, 0);
    else if (event.key === "End") focusTrendPoint(element, count - 1);
    else if (event.key === "Escape") resetTrend(element);
    else return;
    event.preventDefault();
  });

  document.addEventListener("focusout", (event) => {
    const figure = event.target instanceof HTMLElement ? event.target.closest('.v-chart[data-chart="trend"]') : null;
    if (figure) resetTrend(/** @type {HTMLElement} */ (figure));
  });
  window.addEventListener("scroll", hideChartTip, { passive: true });
}
