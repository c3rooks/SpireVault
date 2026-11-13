// Ascensions tab views for the new UI. Pure functions: model in, HTML out.
// The model is built in script.js (buildAscensionsModel) from
// Stats.summarize() and lib/ascension-info.js; nothing here reads run data
// or touches the DOM.
//
// Every metric the classic tab shows is re-housed once:
//   spire      → per-level win rate and runs (replaces the bar chart)
//   tiers      → the difficulty-tier legend, with each tier's blurb + record
//   breakdown  → per-level modifier detail as expandable rows (details[data-asc])
// Tier colours are never passed in: each element carries data-tier and the
// colour is a token chosen in styles/src/surfaces/ascensions.css.

import { esc, fixed, clamp } from "./html.js?v=1";

/**
 * @typedef {Object} AscLevel
 * @property {number} level
 * @property {string} tierKey      standard | early | mid | expert | master | unknown
 * @property {string} tierLabel
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 * @property {string} title        short modifier title ("More elites")
 * @property {string|null} modifier
 * @property {string} detail
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
 * @typedef {Object} AscensionsModel
 * @property {ReadonlyArray<AscLevel>} levels   A0 → cap, every level, played or not
 * @property {ReadonlyArray<AscTier>} tiers
 * @property {number} cap                        highest level the game has
 * @property {number} hiddenAbove                buckets above the cap that are not shown
 * @property {number|null} peak                  highest level with at least one run
 */

const ICONS = Object.freeze({
  chevron: '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
});

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
 * (the taper is CSS: --i × --asc-taper).
 * @param {AscLevel} level
 * @param {number|null} peak
 */
function storey(level, peak) {
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
  return `
    <li class="v-asc-st${lit ? " is-lit" : ""}${isPeak ? " is-peak" : ""}" data-tier="${esc(level.tierKey)}"
        style="--i:${level.level};--wr:${clamp(level.winratePct, 0, 100).toFixed(1)}%">
      <button class="v-asc-st-btn" type="button" data-asc-jump="${level.level}"
              aria-label="A${level.level}, ${esc(level.tierLabel)}: ${spoken}. Show the A${level.level} modifier.">
        <span class="v-asc-st-key">A${level.level}</span>
        ${body}
      </button>
      ${isPeak ? '<span class="v-asc-st-flag" aria-hidden="true">Your peak</span>' : ""}
    </li>`;
}

/** @param {AscensionsModel} model */
function spire(model) {
  const top = model.levels.slice().reverse();
  const litCount = model.levels.filter((level) => level.runs > 0).length;
  const sub = litCount > 0
    ? `${litCount} of ${model.levels.length} storeys lit · tap one for its modifier`
    : "No ascension runs yet — every storey is unlit";
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
        <ol class="v-asc-storeys" aria-label="Win rate by ascension level, highest first">
          ${top.map((level) => storey(level, model.peak)).join("")}
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
      </div>
    </details>`;
}

/** @param {AscensionsModel} model */
function breakdown(model) {
  return `
    <div class="v-section-title v-asc-title"><h3>Detailed breakdown</h3><p>Open a level for its modifier</p></div>
    <p class="v-asc-note">Slay the Spire 2 is in Early Access — modifiers can shift between patches. Confirm live details on the in-game level-select screen.</p>
    <div class="v-asc-rows" data-reveal style="--r:2">
      ${model.levels.map(detailRow).join("")}
    </div>`;
}

/**
 * The Ascensions tab body.
 * @param {AscensionsModel} model
 * @returns {string}
 */
export function ascensionsHtml(model) {
  const hint = model.hiddenAbove > 0
    ? `<p class="v-asc-note"><strong>${model.hiddenAbove}</strong> additional level${model.hiddenAbove === 1 ? "" : "s"} detected above the Early Access cap of A${model.cap}. Hidden until we update this view.</p>`
    : "";
  return `
    <div class="v-asc">
      ${hint}
      <div class="v-asc-top">
        ${spire(model)}
        ${tiers(model)}
      </div>
      ${breakdown(model)}
    </div>`;
}
