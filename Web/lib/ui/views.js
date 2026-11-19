// Presentational views for the new UI. Pure functions: model in, HTML out.
// All data work (stats, streaks, formatting of names) happens in script.js
// with the existing helpers; nothing here touches parsedRuns or the DOM.
// The Overview's sections are widgets: overview/registry.js builds each one's
// model and lays them out; this file draws them.
// Styles: styles/src/surfaces/overview.css, overview-grid.css, components/cards.css.

import { esc, fixed, clamp } from "./html.js?v=1";
import { segmentedHtml, selectHtml, summaryHtml } from "./filter-controls.js?v=1";

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
 * @property {number} streak     current win streak in the filtered runs, 0 when too short to show
 */

/**
 * The By character panel's filters (state lives in script.js).
 * @typedef {Object} CharacterFilterModel
 * @property {ReadonlyArray<import("./filter-controls.js").SegOption>|null} modes
 *           null when the history holds only standard runs (no mode control)
 * @property {ReadonlyArray<import("./filter-controls.js").SelectOption>} levels
 * @property {boolean} levelsDisabled   Dread: its runs sit on no ascension ladder
 * @property {string} label             "Blitz A2"; "" when nothing is filtered
 * @property {string} emptyText         a banner with no runs under the filter
 * @property {number} shownRuns
 * @property {number} totalRuns
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
 * @typedef {Object} WinRateModel
 * @property {{ total: number, wins: number, losses: number, winratePct: number }} totals
 * @property {{ key: string, label: string, winratePct: number, runs: number }|null} bestCharacter
 * @property {{ level: number, runs: number }|null} highestAscension
 * @property {string} avgAscension
 * @property {ReadonlyArray<{ won: boolean, abandoned: boolean }>} recentRuns   up to 20, oldest → newest
 * @property {{ wins: number, losses: number, count: number }} lastTen
 *
 * @typedef {{ characters: ReadonlyArray<CharacterRow>, characterFilter?: CharacterFilterModel }} CharactersModel
 * @typedef {{ kpis: ReadonlyArray<KpiCard> }} HandModel
 * @typedef {{ relics: ReadonlyArray<RelicRow> }} RelicsModel
 *
 * @typedef {Object} OverviewCell  one placed widget, already drawn
 * @property {string} key    layout key, escaped
 * @property {string} id     widget id
 * @property {string} size   S | M | L | W
 * @property {number} span   columns on the 12-column grid
 * @property {"start"|"end"|null} [pair]  one of the two halves of a split row
 * @property {string} html   trusted widget markup
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

const ICONS = Object.freeze({
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor"/>',
  flame: '<path d="M12 2c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4-1-6 1-10z" fill="currentColor"/>',
  // The streak tag's flame is drawn at 13px, where the solid one above reads
  // as a droplet; a hollow core keeps it a flame.
  streak: '<path fill-rule="evenodd" fill="currentColor" d="M12.6 1.6c.5 3.5 3.5 5.4 5 8.3 1.5 2.9 1.4 6.5-.9 8.9a7 7 0 0 1-11.3-2c-1-2.7-.2-5.6 1.9-7.6.1 1.9.9 3.2 2.1 3.8-.6-4.5.6-8.4 3.2-11.4zM12.2 12.4c-1 1.3-1.9 2.5-1.9 4.1a2.3 2.3 0 0 0 4.6.1c0-1.6-1.2-2.8-2.7-4.2z"/>',
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

/**
 * Win rate ring, totals, best character, ascension chips and the last 20.
 * @param {WinRateModel} model
 * @param {number} order  entrance beat
 * @returns {string}
 */
export function winRateHtml(model, order) {
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
    <section class="v-panel v-wr" data-reveal style="--r:${order}" aria-label="Win rate and run totals">
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
 * @param {WinRateModel} model
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

/** "9 wins in a row", plus the filter it counts within: " (Standard A10)". @param {number} streak @param {string} scope */
function streakWords(streak, scope) {
  return `${streak} wins in a row${scope ? ` (${scope})` : ""}`;
}

/**
 * "🔥 9 in a row" under the banner's record. When any climber in the grid
 * has a streak, a banner without one keeps an empty line in its place, so
 * every bar stays level. The banner's label says the streak for a screen
 * reader.
 * @param {CharacterRow} row
 * @param {boolean} reserve
 * @param {string} scope   the active filter's label, "" when unfiltered
 */
function streakTag(row, reserve, scope) {
  if (row.streak <= 0) return reserve ? '<span class="v-char-streak is-empty" aria-hidden="true"></span>' : "";
  return `
      <span class="v-char-streak" title="${esc(row.label)}: ${esc(streakWords(row.streak, scope))}" aria-hidden="true">${icon("streak")}<b>${row.streak}</b><span class="v-char-streak-unit"> in a row</span></span>`;
}

/**
 * @param {CharacterRow} row
 * @param {CharacterFilterModel} filter
 * @param {boolean} reserveStreak
 */
function characterBanner(row, filter, reserveStreak) {
  const emptyText = filter.emptyText;
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
    : `<span>${esc(emptyText)}</span>`;
  const streak = row.streak > 0 ? `, ${streakWords(row.streak, filter.label)}` : "";
  const spoken = played ? `${fixed(row.winratePct)} percent win rate, ${winLoss} · ${runCount}${streak}` : emptyText.toLowerCase();
  return `
    <button class="v-char${played ? "" : " is-unplayed"}" type="button" data-char="${esc(row.key)}"
            data-action="goto-tab" data-tab="characters"
            aria-label="${esc(row.label)}: ${esc(spoken)}. Open Characters.">
      <span class="v-char-art">${art}</span>
      <span class="v-char-name">${esc(row.label)}</span>
      <span class="v-char-wr">${played ? `${fixed(row.winratePct)}<small>%</small>` : "—"}</span>
      <span class="v-char-rec">${record}</span>${streakTag(row, reserveStreak, filter.label)}
      <span class="v-char-bar" aria-hidden="true"><i style="width:${clamp(row.winratePct, 0, 100).toFixed(1)}%"></i></span>
    </button>`;
}

/**
 * Mode chips (only when the history has Blitz or Dread runs) and the
 * ascension picker.
 * @param {CharacterFilterModel} filter
 */
function characterFilters(filter) {
  const modes = filter.modes ? segmentedHtml("chars.mode", "Mode", filter.modes) : "";
  const levels = selectHtml("chars.asc", "Ascension", filter.levels, {
    disabled: filter.levelsDisabled,
    title: filter.levelsDisabled ? "Dread runs have no ascension level" : "",
  });
  return `<div class="v-chars-filters">${modes}${levels}</div>`;
}

/**
 * One banner per climber.
 * @param {CharactersModel} model
 * @param {number} order  entrance beat
 * @returns {string}
 */
export function charactersHtml(model, order) {
  if (model.characters.length === 0) return "";
  // A caller with no section filter (a preview) draws the plain panel.
  const filter = model.characterFilter ?? { label: "", modes: null, levels: [], levelsDisabled: false, shownRuns: 0, totalRuns: 0 };
  const summary = filter.label ? summaryHtml("chars.clear", filter.label, filter.shownRuns, filter.totalRuns) : "";
  const reserveStreak = model.characters.some((row) => row.streak > 0);
  return `
    <section class="v-panel v-chars" data-reveal style="--r:${order}" aria-label="Win rate by character">
      <header class="v-chars-head">
        <p class="v-eyebrow">By character</p>
        ${characterFilters(filter)}
      </header>
      ${summary}
      <div class="v-chars-grid" style="--cols:${model.characters.length}">
        ${model.characters.map((row) => characterBanner(row, filter, reserveStreak)).join("")}
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

/**
 * The six at-a-glance stats as a fanned hand of cards (cards 0..5 of the
 * entrance).
 * @param {HandModel} model
 * @returns {string}
 */
export function handHtml(model) {
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

/**
 * @param {RelicsModel} model
 * @param {number} order  entrance beat
 * @returns {string}
 */
export function relicsHtml(model, order) {
  if (model.relics.length === 0) return "";
  return `
    ${sectionTitleHtml("Top relics", "by win rate, weighted by runs")}
    <div class="v-relics" data-reveal style="--r:${order}">
      ${model.relics.map(relicTile).join("")}
    </div>`;
}

/**
 * A section title with its dashed rule.
 * @param {string} title  plain text
 * @param {string} [sub]  plain text
 * @returns {string}
 */
export function sectionTitleHtml(title, sub = "") {
  return `<div class="v-section-title"><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}</div>`;
}

/** The Arrange button's quill. */
const QUILL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 2.4c-6.6.5-11.2 5.4-11.7 11.9 6.5-.5 11.3-5.3 11.7-11.9z" fill="currentColor"/><path d="M20.6 2.4 9.4 13.6M15.2 6.4l2.3.6M12.6 9.1l2.6.5" fill="none" stroke="rgb(0 0 0 / 0.55)" stroke-width="1.3" stroke-linecap="round"/><path d="M10.4 12.6 3.8 20.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

/**
 * The Overview body: the player's widgets on the 12-column grid
 * (overview-grid.css). The default layout keeps the classic layout's order
 * (at-a-glance stats, win rate, trends, relics) so a person who switches
 * between the two looks finds each number in the same place.
 *
 * Normally the Arrange button rides on the first widget's section title
 * (`bar`: "center" for the hand, "start" for a left title) or gets a row of
 * its own. While arranging (overview/edit.js), each widget's content sits in
 * an inert body under its tools, and the bar and the sticky foot come from
 * the editor.
 * @param {ReadonlyArray<OverviewCell & { tools?: string }>} cells
 * @param {{ bar?: "center"|"start"|"row", arrange?: boolean, barHtml?: string, footHtml?: string }} [options]
 * @returns {string}
 */
export function overviewHtml(cells, options = {}) {
  const arrange = !!options.arrange;
  const bar = arrange ? "row" : options.bar || "row";
  const items = cells
    .map((cell) => {
      const pair = cell.pair === "start" || cell.pair === "end" ? ` data-pair="${cell.pair}"` : "";
      const body = arrange ? `${cell.tools || ""}<div class="v-w-body" inert>${cell.html}</div>` : cell.html;
      return `
      <div class="v-w" data-w="${esc(cell.id)}" data-key="${cell.key}" data-size="${esc(cell.size)}"${pair} style="--span:${Number(cell.span) || 12}">${body}</div>`;
    })
    .join("");
  const empty = cells.length > 0
    ? ""
    : arrange
      ? `
      <div class="v-ov-empty">
        <p class="v-ov-empty-title">Your board is empty</p>
        <p>Add widgets from the gallery, or Reset for the default Overview.</p>
        <button class="v-btn v-btn--paper" type="button" data-arr="add">Add widget</button>
      </div>`
      : `
      <div class="v-ov-empty">
        <p class="v-ov-empty-title">Your Overview is empty</p>
        <p>Pick the widgets you want from the gallery.</p>
        <button class="v-btn v-btn--primary" type="button" data-action="ov-arrange">Add widgets</button>
      </div>`;
  const head = arrange
    ? options.barHtml || ""
    : `<div class="v-ov-bar">
        <button class="v-btn v-ov-arrange" type="button" data-action="ov-arrange" aria-label="Arrange your Overview" title="Arrange your Overview">${QUILL_ICON}<span>Arrange</span></button>
      </div>`;
  return `
    <div class="v-ov" data-bar="${bar}"${arrange ? " data-arrange" : ""}>
      ${head}
      <div class="v-ov-grid">${items}${empty}
      </div>${arrange ? options.footHtml || "" : ""}
    </div>`;
}
