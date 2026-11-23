// Ascensions tab views for the new UI. Pure functions: model in, HTML out.
// The model is built in script.js (buildAscensionsModel) from
// Stats.summarize() and lib/ascension-info.js; nothing here reads run data
// or touches the DOM.
//
// Every metric the classic tab shows is re-housed once:
//   filters    → one climber, Standard or Blitz ladder, Solo or Co-op (all three blocks follow)
//   spire      → per-level win rate and runs (replaces the bar chart)
//   tiers      → the difficulty-tier legend, with each tier's blurb + record
//   breakdown  → per-level modifier detail as expandable rows (details[data-asc]);
//                with every climber shown, an open row also lists each
//                climber's record at that level (a Reddit ask, 2026-11-22)
// On the Blitz ladder (STS2 beta) the tiers and modifier breakdown give way to
// one note: Blitz has its own levels and this app does not describe them.
// Tier colours are never passed in: each element carries data-tier and the
// colour is a token chosen in styles/src/surfaces/ascensions.css.

import { esc, fixed, clamp } from "./html.js?v=1";
import { segmentedHtml, summaryHtml } from "./filter-controls.js?v=1";

/**
 * One climber's record at one level.
 * @typedef {Object} AscClimber
 * @property {string} key          "ironclad"; picks the colour (tokens.css [data-char])
 * @property {string} label        "Ironclad"
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 * @property {number} streak       current win streak at this level; 0 when too short to show
 */

/**
 * @typedef {Object} AscLevel
 * @property {number} level
 * @property {string} tierKey      standard | early | mid | expert | master | blitz | unknown
 * @property {string} tierLabel
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 * @property {string} title        short modifier title ("More elites")
 * @property {string|null} modifier
 * @property {string} detail
 * @property {ReadonlyArray<AscClimber>} [climbers]  each climber with runs here; empty when one climber is picked
 * @property {ReadonlyArray<string>} [untried]       climbers with runs on this ladder but none here ("Defect")
 */

/**
 * @typedef {Object} AscTier
 * @property {string} key
 * @property {string} label
 * @property {string} range        "A1–A3"
 * @property {string} blurb
 * @property {number} runs
 * @property {number} wins
 */

/**
 * @typedef {Object} AscFilterModel
 * @property {ReadonlyArray<import("./filter-controls.js").SegOption>} climbers
 * @property {ReadonlyArray<import("./filter-controls.js").SegOption>|null} ladders  null without Blitz runs
 * @property {ReadonlyArray<import("./filter-controls.js").SegOption>|null} [parties]  null without co-op runs
 * @property {string} label        "Ironclad · Blitz"; "" when nothing is filtered
 * @property {number} shownRuns
 * @property {number|null} totalRuns   runs on the ladder, all climbers; null when no climber is picked
 */

/**
 * @typedef {Object} AscensionsModel
 * @property {ReadonlyArray<AscLevel>} levels   A0 → cap, every level, played or not
 * @property {ReadonlyArray<AscTier>} tiers
 * @property {number} cap                        highest level the game has
 * @property {number} hiddenAbove                buckets above the cap that are not shown
 * @property {number|null} peak                  highest level with at least one run
 * @property {"standard"|"blitz"} ladder
 * @property {string} climber                    "Ironclad", or "" for every climber
 * @property {{ runs: number, wins: number }} record   every run on the spire
 * @property {AscFilterModel} filter
 */

const ICONS = Object.freeze({
  chevron: '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
  // The flame the By character banners use for a streak (views.js).
  streak: '<path fill-rule="evenodd" fill="currentColor" d="M12.6 1.6c.5 3.5 3.5 5.4 5 8.3 1.5 2.9 1.4 6.5-.9 8.9a7 7 0 0 1-11.3-2c-1-2.7-.2-5.6 1.9-7.6.1 1.9.9 3.2 2.1 3.8-.6-4.5.6-8.4 3.2-11.4zM12.2 12.4c-1 1.3-1.9 2.5-1.9 4.1a2.3 2.3 0 0 0 4.6.1c0-1.6-1.2-2.8-2.7-4.2z"/>',
});

/** The lowest storey narrow enough for the "Your peak" flag to fit beside
 *  it (the tower tapers by --asc-taper per level, ascensions.css). */
const FLAG_BESIDE_FROM = 7;

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** @param {number} count @param {string} noun */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** @param {number} wins @param {number} runs */
function pct(wins, runs) {
  return runs > 0 ? (wins / runs) * 100 : 0;
}

/**
 * One storey of the spire. A0 is the widest; every level up is narrower
 * (the taper is CSS: --i × --asc-taper). A storey opens its modifier row;
 * Blitz levels have none here, so their storeys are not buttons.
 * @param {AscLevel} level
 * @param {number|null} peak
 * @param {boolean} jumps
 */
function storey(level, peak, jumps) {
  const lit = level.runs > 0;
  const isPeak = peak === level.level;
  const spoken = lit
    ? `${fixed(level.winratePct)} percent win rate, ${plural(level.wins, "win")} over ${plural(level.runs, "run")}`
    : "no runs yet";
  const body = lit
    ? `<span class="v-asc-st-meter" aria-hidden="true"><i style="width:${clamp(level.winratePct, 0, 100).toFixed(1)}%"></i></span>
       <span class="v-asc-st-wr">${fixed(level.winratePct)}<small>%</small></span>
       <span class="v-asc-st-runs">${plural(level.runs, "run")}</span>`
    : `<span class="v-asc-st-lock">${icon("lock")}<span>Unlit</span></span>`;
  const face = jumps
    ? `<button class="v-asc-st-btn" type="button" data-asc-jump="${level.level}"
              aria-label="A${level.level}, ${esc(level.tierLabel)}: ${spoken}. Show the A${level.level} modifier.">`
    : `<span class="v-asc-st-btn is-static" role="img" aria-label="${esc(level.tierLabel)} A${level.level}: ${spoken}.">`;
  // Beside a wide (low) storey the flag would run past the panel, so it
  // sits on the storey's top edge instead, as on phones.
  const flagInside = isPeak && level.level < FLAG_BESIDE_FROM;
  return `
    <li class="v-asc-st${lit ? " is-lit" : ""}${isPeak ? " is-peak" : ""}${flagInside ? " is-flag-in" : ""}" data-tier="${esc(level.tierKey)}"
        style="--i:${level.level};--wr:${clamp(level.winratePct, 0, 100).toFixed(1)}%">
      ${face}
        <span class="v-asc-st-key">A${level.level}</span>
        ${body}
      ${jumps ? "</button>" : "</span>"}
      ${isPeak ? '<span class="v-asc-st-flag" aria-hidden="true">Your peak</span>' : ""}
    </li>`;
}

/** @param {AscensionsModel} model */
function spire(model) {
  const top = model.levels.slice().reverse();
  const litCount = model.levels.filter((level) => level.runs > 0).length;
  const isBlitz = model.ladder === "blitz";
  const who = [model.climber, isBlitz ? "Blitz" : ""].filter(Boolean).join(" · ");
  const lit = `${litCount} of ${model.levels.length} levels lit${isBlitz ? "" : " · tap one for its modifier"}`;
  const sub = litCount > 0
    ? (who ? `${who} · ${lit}` : lit)
    : model.filter.label ? "No ascension runs match this filter" : "No ascension runs yet — every level is unlit";
  return `
    <section class="v-panel v-asc-spire" data-reveal style="--r:0" aria-labelledby="v-asc-spire-h">
      <header class="v-asc-panel-head">
        <h3 id="v-asc-spire-h">Ascension spire</h3>
        <p>${esc(sub)}</p>
      </header>
      <div class="v-asc-tower">
        <span class="v-asc-roof" aria-hidden="true">
          <svg viewBox="0 0 120 80" preserveAspectRatio="none"><path d="M60 4 112 78H8z"/></svg>
          <span class="v-asc-roof-flag"></span>
        </span>
        <ol class="v-asc-storeys" aria-label="${esc(who ? `${who}: win rate` : "Win rate")} by ascension level, highest first">
          ${top.map((level) => storey(level, model.peak, !isBlitz)).join("")}
        </ol>
        <span class="v-asc-plinth" aria-hidden="true"></span>
      </div>
    </section>`;
}

/** @param {AscTier} tier */
function tierRow(tier) {
  const record = tier.runs > 0
    ? `<span class="v-asc-tier-rec"><b>${fixed(pct(tier.wins, tier.runs))}%</b> · ${tier.wins}W / ${plural(tier.runs, "run")}</span>`
    : `<span class="v-asc-tier-rec is-none">No runs yet</span>`;
  return `
    <li class="v-asc-tier${tier.runs > 0 ? "" : " is-none"}" data-tier="${esc(tier.key)}">
      <span class="v-asc-tier-swatch" aria-hidden="true"></span>
      <span class="v-asc-tier-label">${esc(tier.label)}</span>
      <span class="v-asc-tier-range">${esc(tier.range)}</span>
      ${record}
      <p class="v-asc-tier-blurb">${esc(tier.blurb)}</p>
    </li>`;
}

/** @param {AscensionsModel} model */
function tiers(model) {
  return `
    <section class="v-panel v-asc-tiers" data-reveal style="--r:1" aria-labelledby="v-asc-tiers-h">
      <header class="v-asc-panel-head">
        <h3 id="v-asc-tiers-h">Difficulty tiers</h3>
        <p>Five bands, from first clear to the ceiling</p>
      </header>
      <ul class="v-asc-tier-list" aria-label="Ascension tiers">
        ${model.tiers.map(tierRow).join("")}
      </ul>
    </section>`;
}

/**
 * One climber's line in an open row: colour dot and name, a meter in the
 * climber's colour, win rate, record and (from 2 wins) a streak flame.
 * @param {AscClimber} c
 * @param {number} level
 */
function climberLine(c, level) {
  const streak = c.streak > 0
    ? `<span class="v-asc-climber-streak" title="${esc(c.label)}: ${c.streak} wins in a row at A${level}">${icon("streak")}<b>${c.streak}</b><span class="v-sr"> wins in a row</span></span>`
    : "";
  return `
        <li class="v-asc-climber" data-char="${esc(c.key)}">
          <span class="v-asc-climber-name"><i class="v-asc-climber-dot" aria-hidden="true"></i>${esc(c.label)}</span>
          <span class="v-asc-climber-meter" aria-hidden="true"><i style="width:${clamp(c.winratePct, 0, 100).toFixed(1)}%"></i></span>
          <span class="v-asc-climber-wr">${fixed(c.winratePct)}%</span>
          <span class="v-asc-climber-rec">${c.wins}W / ${plural(c.runs, "run")}</span>
          <span class="v-asc-climber-flame">${streak}</span>
        </li>`;
}

/**
 * Every climber's record at this level, under its modifier. Drawn only
 * when the tab shows every climber and the level has runs.
 * @param {AscLevel} level
 */
function climbersBlock(level) {
  const climbers = level.climbers || [];
  if (climbers.length === 0) return "";
  const untried = level.untried && level.untried.length > 0
    ? `<p class="v-asc-climbers-untried">No runs here yet: ${esc(level.untried.join(", "))}</p>`
    : "";
  return `
      <div class="v-asc-climbers">
        <p class="v-asc-climbers-title">Your climbers at A${level.level}</p>
        <ul class="v-asc-climber-list" aria-label="Your climbers at A${level.level}">
          ${climbers.map((c) => climberLine(c, level.level)).join("")}
        </ul>
        ${untried}
      </div>`;
}

/** @param {AscLevel} level */
function detailRow(level) {
  const lit = level.runs > 0;
  const badge = level.modifier || level.tierLabel;
  const stats = lit
    ? `<span class="v-asc-row-meter" aria-hidden="true"><i style="width:${clamp(level.winratePct, 0, 100).toFixed(1)}%"></i></span>
       <span class="v-asc-row-wr">${fixed(level.winratePct)}%</span>
       <span class="v-asc-row-rec">${level.wins}W / ${plural(level.runs, "run")}</span>`
    : `<span class="v-asc-row-none">No runs yet</span>`;
  return `
    <details class="v-asc-row${lit ? "" : " is-none"}" data-asc="${level.level}" data-tier="${esc(level.tierKey)}">
      <summary>
        <span class="v-asc-row-key">A${level.level}</span>
        <span class="v-asc-row-mod">
          <span class="v-asc-row-title">${esc(level.title)}</span>
          <span class="v-asc-row-badge">${esc(badge)}</span>
        </span>
        ${stats}
        <span class="v-asc-row-chev">${icon("chevron")}</span>
      </summary>
      <div class="v-asc-row-body">
        <p><span class="v-asc-row-tier">${esc(level.tierLabel)}</span>${esc(level.detail)}</p>
        ${climbersBlock(level)}
      </div>
    </details>`;
}

/** @param {AscensionsModel} model */
function breakdown(model) {
  return `
    <div class="v-section-title v-asc-title"><h3>Detailed breakdown</h3><p>${model.climber ? "Open a level for its modifier" : "Open a level for its modifier and your climbers there"}</p></div>
    <p class="v-asc-note">Slay the Spire 2 is in Early Access — modifiers can shift between patches. Confirm live details on the in-game level-select screen.</p>
    <div class="v-asc-rows" data-reveal style="--r:2">
      ${model.levels.map(detailRow).join("")}
    </div>`;
}

/**
 * Takes the tiers panel's place on the Blitz ladder.
 * @param {AscensionsModel} model
 */
function blitzNote(model) {
  const { runs, wins } = model.record;
  const record = runs > 0
    ? `<p class="v-asc-blitz-rec"><b>${fixed(pct(wins, runs))}%</b> · ${wins}W / ${plural(runs, "Blitz run")}</p>`
    : "";
  return `
    <section class="v-panel v-asc-tiers v-asc-blitz" data-reveal style="--r:1" aria-labelledby="v-asc-blitz-h">
      <header class="v-asc-panel-head">
        <h3 id="v-asc-blitz-h">Blitz ladder</h3>
        <p>Its own levels, apart from A0–A10</p>
      </header>
      ${record}
      <p class="v-asc-blitz-text">Blitz has its own ascension levels, shared by every character, so these runs never count toward your standard climb. SpireVault does not describe Blitz modifiers yet; the in-game level select lists them.</p>
    </section>`;
}

/** @param {AscFilterModel} filter */
function filtersBar(filter) {
  const ladders = filter.ladders ? segmentedHtml("spire.ladder", "Ladder", filter.ladders) : "";
  const parties = filter.parties ? segmentedHtml("spire.party", "Party", filter.parties) : "";
  const summary = filter.label ? summaryHtml("spire.clear", filter.label, filter.shownRuns, filter.totalRuns) : "";
  return `
    <section class="v-panel v-asc-filters" aria-label="Filter the ascension spire" data-reveal style="--r:0">
      <div class="v-asc-filters-row">
        ${segmentedHtml("spire.character", "Climber", filter.climbers)}
        ${ladders}
        ${parties}
      </div>
      ${summary}
    </section>`;
}

/**
 * The Ascensions tab body.
 * @param {AscensionsModel} model
 * @returns {string}
 */
export function ascensionsHtml(model) {
  const isBlitz = model.ladder === "blitz";
  const hint = model.hiddenAbove > 0
    ? `<p class="v-asc-note"><strong>${model.hiddenAbove}</strong> additional level${model.hiddenAbove === 1 ? "" : "s"} detected above the Early Access cap of A${model.cap}. Hidden until we update this view.</p>`
    : "";
  return `
    <div class="v-asc">
      ${filtersBar(model.filter)}
      ${hint}
      <div class="v-asc-top">
        ${spire(model)}
        ${isBlitz ? blitzNote(model) : tiers(model)}
      </div>
      ${isBlitz ? "" : breakdown(model)}
    </div>`;
}
