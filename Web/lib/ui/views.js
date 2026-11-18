// Presentational views for the new UI. Pure functions: model in, HTML out.
// All data work (stats, streaks, formatting of names) happens in script.js
// with the existing helpers; nothing here touches parsedRuns or the DOM.
// Styles: styles/src/surfaces/overview.css, components/cards.css.

import { esc, fixed, clamp } from "./html.js?v=1";
import { trendChartHtml, floorChartHtml } from "./charts.js?v=2";

/**
 * @typedef {Object} CharacterRow
 * @property {string} key
 * @property {string} label
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 * @property {string|null} portraitSrc
 * @property {boolean} [isPortraitInked]  portraitSrc is tight-cropped stage art
 * @property {string} iconHtml   trusted fallback icon markup
 */

/**
 * @typedef {Object} KpiCard
 * @property {string} title
 * @property {"win"|"loss"|"gold"|"accent"|"info"|"violet"} tone
 * @property {"bolt"|"flame"|"crown"|"stairs"|"clock"|"calendar"} icon
 * @property {string} value      trusted, pre-escaped
 * @property {string} [unit]
 * @property {string} textHtml   trusted, pre-escaped rules text
 * @property {"up"|"down"|"flat"} [trend]    arrow drawn beside the value
 * @property {ReadonlyArray<number>} [spark] 0..1 series, oldest → newest, drawn under the value
 */

/**
 * @typedef {Object} RelicRow
 * @property {string} label
 * @property {string|null} src
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 */

/**
 * @typedef {Object} OverviewModel
 * @property {string} noticesHtml   trusted legacy strips (since-last-visit, weekly digest)
 * @property {{ total: number, wins: number, losses: number, winratePct: number }} totals
 * @property {{ key: string, label: string, winratePct: number, runs: number }|null} bestCharacter
 * @property {{ level: number, runs: number }|null} highestAscension
 * @property {string} avgAscension
 * @property {ReadonlyArray<{ won: boolean, abandoned: boolean }>} recentRuns   up to 20, oldest → newest
 * @property {{ wins: number, losses: number, count: number }} lastTen
 * @property {ReadonlyArray<CharacterRow>} characters
 * @property {ReadonlyArray<KpiCard>} kpis
 * @property {{ values: number[], lifetime: number, windowSize: number }|null} trend
 * @property {{ bins: Array<{ label: string, wins: number, losses: number }> }|null} floors
 * @property {ReadonlyArray<RelicRow>} relics
 */

const RING_RADIUS = 60;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const FAN_DEGREES_PER_CARD = 5;
const FAN_LIFT_PX = 3.4;
const PATH_VIEW_W = 400;
const PATH_VIEW_H = 44;
const LONG_VALUE_LENGTH = 4;
const SPARK_W = 64;
const SPARK_H = 18;
const SPARK_PAD = 3;
const SPARK_DOT_R = 2.6;
/** Reveal order (× 55ms). The hand leads the page (cards 0..5); the two
 *  panels under it rise alongside the later cards rather than after them. */
const REVEAL_WIN_RATE = 3;
const REVEAL_CHARACTERS = 4;
const REVEAL_TREND = 8;
const REVEAL_FLOORS = 9;

const ICONS = Object.freeze({
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/>',
  flame: '<path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z" fill="currentColor"/>',
  crown: '<path d="m3 8 4 4 5-7 5 7 4-4-1 11H4z" fill="currentColor"/>',
  stairs: '<path d="M4 20h4v-4h4v-4h4V8h4" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
});

/** @param {string} name */
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.bolt}</svg>`;
}

/** @param {number} count @param {string} noun */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** @param {OverviewModel} model */
function winRatePanel(model) {
  const { totals, bestCharacter, highestAscension } = model;
  const dash = (clamp(totals.winratePct, 0, 100) / 100) * RING_CIRCUMFERENCE;
  const best = bestCharacter
    ? `<p class="v-wr-best">Best: <b data-char="${esc(bestCharacter.key)}">${esc(bestCharacter.label)}</b>
         · ${fixed(bestCharacter.winratePct)}% over ${plural(bestCharacter.runs, "run")}</p>`
    : "";
  const highest = highestAscension
    ? `<button class="v-chip" type="button" data-action="goto-tab" data-tab="ascensions" title="Open Ascensions">
         Highest <b>A${highestAscension.level}</b> · ${plural(highestAscension.runs, "run")}
       </button>`
    : "";
  return `
    <section class="v-panel v-wr" data-reveal style="--r:${REVEAL_WIN_RATE}" aria-label="Win rate and run totals">
      <div class="v-wr-main">
        <div class="v-ring">
          <svg viewBox="0 0 160 160" aria-hidden="true">
            <circle class="v-ring-ink" cx="80" cy="80" r="${RING_RADIUS}"/>
            <circle class="v-ring-track" cx="80" cy="80" r="${RING_RADIUS}"/>
            <circle class="v-ring-fill" cx="80" cy="80" r="${RING_RADIUS}" transform="rotate(-90 80 80)"
                    style="--dash:${dash.toFixed(2)};--circ:${RING_CIRCUMFERENCE.toFixed(2)}"/>
          </svg>
          <div class="v-ring-text">
            <span class="v-ring-pct"><span data-count="${fixed(totals.winratePct)}" data-decimals="1">${fixed(totals.winratePct)}</span><small>%</small></span>
            <span class="v-ring-label">Win rate</span>
          </div>
        </div>
        <div class="v-wr-side">
          <p class="v-eyebrow">Run history</p>
          <dl class="v-nums">
            <div><dt>Runs</dt><dd data-count="${totals.total}">${totals.total}</dd></div>
            <div><dt>Wins</dt><dd class="is-win" data-count="${totals.wins}">${totals.wins}</dd></div>
            <div><dt>Losses</dt><dd class="is-loss" data-count="${totals.losses}">${totals.losses}</dd></div>
          </dl>
          ${best}
          <div class="v-wr-chips">
            ${highest}
            <button class="v-chip" type="button" data-action="goto-tab" data-tab="ascensions" title="Open Ascensions">
              Average <b>A${esc(model.avgAscension)}</b>
            </button>
          </div>
        </div>
      </div>
      ${recentPath(model)}
    </section>`;
}

/**
 * The last 20 runs as a map trail of win/loss nodes.
 * @param {OverviewModel} model
 */
function recentPath(model) {
  const runs = model.recentRuns;
  if (runs.length < 2) return "";
  const step = (PATH_VIEW_W - 24) / (runs.length - 1);
  const points = runs.map((_, index) => ({
    x: 12 + index * step,
    y: PATH_VIEW_H / 2 + Math.sin(index * 0.95) * 9,
  }));
  const trail = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const nodes = runs
    .map((run, index) => {
      const isLatest = index === runs.length - 1;
      const outcome = run.won ? "is-win" : run.abandoned ? "is-abandon" : "is-loss";
      const point = points[index];
      return `<circle class="v-path-node ${outcome}${isLatest ? " is-latest" : ""}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${isLatest ? 8 : 6.5}"/>`;
    })
    .join("");
  const { lastTen } = model;
  const wins = runs.filter((run) => run.won).length;
  const abandoned = runs.filter((run) => !run.won && run.abandoned).length;
  const lost = runs.length - wins - abandoned;
  const summary = `${wins} won, ${lost} lost${abandoned ? `, ${abandoned} abandoned` : ""}`;
  return `
    <div class="v-path">
      <div class="v-path-head">
        <p class="v-eyebrow">Last ${runs.length} climbs</p>
        <span>${lastTen.wins}W · ${lastTen.losses}L in the last ${lastTen.count}</span>
      </div>
      <svg viewBox="0 0 ${PATH_VIEW_W} ${PATH_VIEW_H}" role="img"
           aria-label="Last ${runs.length} runs, oldest first: ${summary}.">
        <polyline class="v-path-trail" points="${trail}"/>
        ${nodes}
      </svg>
    </div>`;
}

/** @param {CharacterRow} row */
function characterBanner(row) {
  const played = row.runs > 0;
  const art = row.portraitSrc
    ? `<img${row.isPortraitInked ? ' class="is-inked"' : ""} src="${esc(row.portraitSrc)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : row.iconHtml;
  const winLoss = `${row.wins}W · ${row.runs - row.wins}L`;
  const runCount = plural(row.runs, "run");
  // Two parts, so a narrow banner stacks "15W · 16L" over "31 runs" instead
  // of clipping the line at both edges (overview.css .v-char-rec).
  const record = played
    ? `<span>${winLoss}</span><span class="v-char-rec-sep" aria-hidden="true"> · </span><span>${runCount}</span>`
    : "<span>No runs yet</span>";
  return `
    <button class="v-char${played ? "" : " is-unplayed"}" type="button" data-char="${esc(row.key)}"
            data-action="goto-tab" data-tab="characters"
            aria-label="${esc(row.label)}: ${played ? `${fixed(row.winratePct)} percent win rate, ${winLoss} · ${runCount}` : "no runs yet"}. Open Characters.">
      <span class="v-char-art">${art}</span>
      <span class="v-char-name">${esc(row.label)}</span>
      <span class="v-char-wr">${played ? `${fixed(row.winratePct)}<small>%</small>` : "—"}</span>
      <span class="v-char-rec">${record}</span>
      <span class="v-char-bar" aria-hidden="true"><i style="width:${clamp(row.winratePct, 0, 100).toFixed(1)}%"></i></span>
    </button>`;
}

/** @param {OverviewModel} model */
function charactersPanel(model) {
  if (model.characters.length === 0) return "";
  return `
    <section class="v-panel v-chars" data-reveal style="--r:${REVEAL_CHARACTERS}" aria-label="Win rate by character">
      <p class="v-eyebrow">By character</p>
      <div class="v-chars-grid" style="--cols:${model.characters.length}">
        ${model.characters.map(characterBanner).join("")}
      </div>
    </section>`;
}

/**
 * A small trajectory line for a card's art window. Decorative: the card's
 * rules text states the same trend in words.
 * @param {ReadonlyArray<number>|undefined} values  0..1, oldest → newest
 * @returns {string}
 */
function sparkline(values) {
  if (!values || values.length < 2) return "";
  const step = (SPARK_W - SPARK_PAD * 2) / (values.length - 1);
  const points = values.map((value, index) => ({
    x: SPARK_PAD + index * step,
    y: SPARK_PAD + (1 - clamp(value, 0, 1)) * (SPARK_H - SPARK_PAD * 2),
  }));
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const end = points[points.length - 1];
  return `
        <svg class="v-card-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true">
          <polyline points="${line}"/>
          <circle cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="${SPARK_DOT_R}"/>
        </svg>`;
}

/**
 * @param {KpiCard} card
 * @param {number} index
 * @param {number} count
 */
function handCard(card, index, count) {
  const offset = index - (count - 1) / 2;
  const rot = offset * FAN_DEGREES_PER_CARD;
  const lift = offset * offset * FAN_LIFT_PX;
  const hasArrow = card.trend === "up" || card.trend === "down";
  const arrow = hasArrow ? `<i class="v-card-trend is-${card.trend}" aria-hidden="true"></i>` : "";
  const plain = `${card.value}${card.unit || ""}`.replace(/<[^>]+>/g, "");
  const long = plain.length + (hasArrow ? 1 : 0) > LONG_VALUE_LENGTH;
  // The fan goes in as --fan-rot / --fan-lift, not --rot / --lift: an inline
  // --rot would beat the stylesheet, so hover could never straighten a card
  // and phones (cards.css, 880px) could never lay the hand flat.
  return `
    <article class="v-card" role="listitem" tabindex="0" data-tilt data-tone="${esc(card.tone)}"
             data-reveal style="--r:${index};--fan-rot:${rot.toFixed(2)}deg;--fan-lift:${lift.toFixed(1)}px">
      <span class="v-card-orb">${icon(card.icon)}</span>
      <header class="v-card-band">${esc(card.title)}</header>
      <div class="v-card-art">
        <span class="v-card-value${long ? " is-long" : ""}">${arrow}${card.value}${card.unit ? `<small>${esc(card.unit)}</small>` : ""}</span>${sparkline(card.spark)}
      </div>
      <p class="v-card-text"><span>${card.textHtml}</span></p>
    </article>`;
}

/** @param {OverviewModel} model */
function hand(model) {
  if (model.kpis.length === 0) return "";
  return `
    <div class="v-section-title v-hand-title"><h3>Your hand</h3></div>
    <div class="v-hand" role="list" aria-label="At-a-glance stats">
      ${model.kpis.map((card, index) => handCard(card, index, model.kpis.length)).join("")}
    </div>`;
}

/** @param {RelicRow} row */
function relicTile(row) {
  const art = row.src ? `<img src="${esc(row.src)}" alt="" loading="lazy" decoding="async">` : "";
  return `
    <button class="v-relic" type="button" data-action="goto-tab" data-tab="relics"
            aria-label="${esc(row.label)}: ${fixed(row.winratePct)} percent win rate over ${plural(row.runs, "run")}. Open Top Relics.">
      <span class="v-relic-orb">${art}</span>
      <span class="v-relic-name">${esc(row.label)}</span>
      <span class="v-relic-wr">${fixed(row.winratePct)}%</span>
      <span class="v-relic-meta">${plural(row.wins, "win")} · ${plural(row.runs, "run")}</span>
    </button>`;
}

/** @param {OverviewModel} model */
function relics(model) {
  if (model.relics.length === 0) return "";
  return `
    <div class="v-section-title"><h3>Top relics</h3><p>by win rate, weighted by runs</p></div>
    <div class="v-relics" data-reveal style="--r:10">
      ${model.relics.map(relicTile).join("")}
    </div>`;
}

/**
 * The Overview body. Sections follow the classic layout's order (at-a-glance
 * stats, win rate, trends, relics) so a person who switches between the two
 * looks finds each number in the same place.
 * @param {OverviewModel} model
 * @returns {string}
 */
export function overviewHtml(model) {
  return `
    <div class="v-ov">
      ${model.noticesHtml}
      ${hand(model)}
      <div class="v-ov-top">
        ${winRatePanel(model)}
        ${charactersPanel(model)}
      </div>
      <div class="v-section-title"><h3>Trends</h3><p>win rate over time, and where climbs end</p></div>
      <div class="v-ov-charts">
        ${trendChartHtml(model.trend, REVEAL_TREND)}
        ${floorChartHtml(model.floors, REVEAL_FLOORS)}
      </div>
      ${relics(model)}
    </div>`;
}
