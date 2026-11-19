// Top Relics tab for the new UI. Pure functions: model in, HTML out.
// Data work (ranking, labels, art lookup, Wilson tone) happens in script.js;
// nothing here touches parsedRuns or the DOM.
// Styles: styles/src/surfaces/relics.css.
//
// Layout: the top three stand on a podium (#1 in the middle, tallest), the
// rest sit in a ranked ledger, and a click on either opens the relic's
// parchment page in #relic-detail-slot (wired by script.js through the
// existing data-action="relic-expand" / "relic-collapse" contract).

import { esc, fixed, clamp } from "./html.js?v=1";
import { hdRelicSrc } from "./relic-art-hd.js?v=2";
import { TONE_LABELS, toneKey, toneLegendHtml } from "./tone-legend.js?v=3";

/** @typedef {"win"|"gold"|"accent"} RelicTone */

/**
 * @typedef {Object} RelicEntry
 * @property {string} key
 * @property {string} label
 * @property {string|null} src
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 * @property {RelicTone} tone        win rate against the player's average (tone-legend.js)
 * @property {string|null} rarity    starter | common | … | null when unknown
 */

/**
 * @typedef {Object} RelicsModel
 * @property {ReadonlyArray<RelicEntry>} relics   ranked best first (Wilson lower bound)
 * @property {number} minRuns                      fewer runs than this are not listed
 * @property {number} lowSampleRuns                fewer runs than this are flagged
 * @property {number} baselinePct                  the player's overall win rate, 0..100
 */

/**
 * @typedef {Object} RelicDetailModel
 * @property {string} key
 * @property {string} label
 * @property {string|null} src
 * @property {string|null} rarity
 * @property {{ effect: string, tip: string, synergy: ReadonlyArray<string> }|null} info
 * @property {{ runs: number, wins: number, winratePct: number, tone: RelicTone }|null} record
 * @property {number} lowSampleRuns
 */

const PODIUM_SIZE = 3;

const KNOWN_RARITIES = new Set(["starter", "common", "uncommon", "rare", "ancient", "shop", "event", "boss"]);

const SPARKLE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5l1.5 5L18.5 8 14 11l1.5 5L12 13l-3.5 3L10 11 5.5 8l5-1.5z" fill="currentColor"/></svg>';
const CHEVRON =
  '<svg class="v-rl-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';

/** @param {number} count @param {string} noun */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** @param {number} rank */
function ordinal(rank) {
  if (rank === 1) return "1st";
  if (rank === 2) return "2nd";
  if (rank === 3) return "3rd";
  return `${rank}th`;
}

/** @param {string|null} rarity */
function rarityKey(rarity) {
  const key = String(rarity || "").toLowerCase();
  return KNOWN_RARITIES.has(key) ? key : "unknown";
}

/** @param {string|null} rarity */
function rarityLabel(rarity) {
  const key = rarityKey(rarity);
  if (key === "unknown") return "";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * @param {string|null} src
 * @param {string} [className]
 */
function relicArt(src, className = "") {
  return src
    ? `<img${className ? ` class="${className}"` : ""} src="${esc(src)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : SPARKLE;
}

/**
 * Win-rate meter. Hatched when the sample is small, so a shaky number reads
 * as shaky before anyone reads the label.
 * @param {number} pct
 */
function meter(pct) {
  return `<span class="v-rl-bar" aria-hidden="true"><i style="width:${clamp(pct, 0, 100).toFixed(1)}%"></i></span>`;
}

/**
 * @param {RelicEntry} entry
 * @param {number} rank
 * @param {boolean} isLow
 */
function tileLabel(entry, rank, isLow) {
  const sample = isLow ? " Small sample, treat the win rate as a hint." : "";
  return `Rank ${rank}, ${entry.label}: ${fixed(entry.winratePct)} percent win rate, ${plural(entry.wins, "win")} in ${plural(entry.runs, "run")}. ${TONE_LABELS[toneKey(entry.tone)]}.${sample} Show details.`;
}

/**
 * @param {RelicEntry} entry
 * @param {number} rank
 * @param {number} lowSampleRuns
 */
function podiumItem(entry, rank, lowSampleRuns) {
  const isLow = entry.runs < lowSampleRuns;
  const rarity = rarityLabel(entry.rarity);
  return `
    <li class="v-rl-step" data-rank="${rank}" data-reveal style="--r:${rank === 1 ? 0 : rank === 2 ? 1 : 2}">
      <button class="v-rl-top${isLow ? " is-low" : ""}" type="button" data-tone="${toneKey(entry.tone)}"
              data-action="relic-expand" data-relic-key="${esc(entry.key)}" aria-controls="relic-detail-slot"
              aria-label="${esc(tileLabel(entry, rank, isLow))}">
        <span class="v-rl-top-art" aria-hidden="true">${relicArt(hdRelicSrc(entry.src))}</span>
        <span class="v-rl-top-plate">
          <span class="v-rl-top-band">
            <span class="v-rl-top-rank">${ordinal(rank)}</span>
          </span>
          <span class="v-rl-top-name">${esc(entry.label)}</span>
          ${rarity
            ? `<span class="v-rl-top-rarity" data-rarity="${rarityKey(entry.rarity)}">${esc(rarity)}</span>`
            : '<span class="v-rl-top-rarity is-empty" aria-hidden="true"></span>'}
          <span class="v-rl-top-wr"><span data-count="${fixed(entry.winratePct)}" data-decimals="1">${fixed(entry.winratePct)}</span><small>%</small></span>
          ${meter(entry.winratePct)}
          <span class="v-rl-top-meta"><span>${plural(entry.wins, "win")}</span><span>${plural(entry.runs, "run")}</span></span>
          ${isLow ? '<span class="v-rl-stamp">Low sample</span>' : ""}
        </span>
      </button>
    </li>`;
}

/**
 * @param {RelicEntry} entry
 * @param {number} rank
 * @param {number} lowSampleRuns
 */
function ledgerRow(entry, rank, lowSampleRuns) {
  const isLow = entry.runs < lowSampleRuns;
  const rarity = rarityLabel(entry.rarity);
  // A row with no tag keeps an invisible one, so every row is the same
  // height (on a phone a tagless row came out 74px against 99px).
  const tags = [
    rarity ? `<span class="v-rl-tag" data-rarity="${rarityKey(entry.rarity)}">${esc(rarity)}</span>` : "",
    isLow ? '<span class="v-rl-tag is-low">Low sample</span>' : "",
  ].join("") || '<span class="v-rl-tag is-empty" aria-hidden="true">&nbsp;</span>';
  return `
    <li>
      <button class="v-rl-row${isLow ? " is-low" : ""}" type="button" data-tone="${toneKey(entry.tone)}"
              data-action="relic-expand" data-relic-key="${esc(entry.key)}" aria-controls="relic-detail-slot"
              aria-label="${esc(tileLabel(entry, rank, isLow))}">
        <span class="v-rl-rank">${rank}</span>
        <span class="v-rl-orb" aria-hidden="true">${relicArt(entry.src)}</span>
        <span class="v-rl-id">
          <span class="v-rl-name">${esc(entry.label)}</span>
          <span class="v-rl-tags">${tags}</span>
        </span>
        <span class="v-rl-counts"><span><b>${entry.wins}</b> ${entry.wins === 1 ? "win" : "wins"}</span><span><b>${entry.runs}</b> ${entry.runs === 1 ? "run" : "runs"}</span></span>
        ${meter(entry.winratePct)}
        <span class="v-rl-wr">${fixed(entry.winratePct)}<small>%</small></span>
        ${CHEVRON}
      </button>
    </li>`;
}

/**
 * Section title, how the list is ranked, and the colour key. The ranking is
 * the Wilson lower bound (stats-engine.js relicBuckets); the tab subtitle
 * says "weighted by runs" (otherwise 81.8% above 83.3% reads as a sorting
 * bug), so the lede says why instead of saying it again.
 * @param {RelicsModel} model
 */
function intro(model) {
  return `
    <header class="v-rl-intro">
      <div class="v-section-title v-rl-title"><h3>Best relics</h3></div>
      <p class="v-rl-lede">
        A relic you've had in only a few runs counts for less, so one lucky run can't top the list.
        It needs ${model.minRuns}+ runs to show. <strong>Tap any relic for details.</strong>
      </p>
      ${toneLegendHtml({ baselinePct: model.baselinePct, lowSampleRuns: model.lowSampleRuns, lowSampleNoun: "runs" })}
    </header>`;
}

/** @param {RelicsModel} model */
function emptyNote(model) {
  return `
    <div class="v-rl-empty v-panel" data-reveal style="--r:0">
      <span class="v-rl-empty-art" aria-hidden="true">${SPARKLE}</span>
      <div>
        <h3>The shelf is still bare</h3>
        <p>Not enough data yet — pick a relic at least ${model.minRuns} times to see a win rate here.</p>
      </div>
    </div>`;
}

/**
 * The Top Relics body.
 * @param {RelicsModel} model
 * @returns {string}
 */
export function relicsTabHtml(model) {
  const { relics, lowSampleRuns } = model;
  if (relics.length === 0) return `<div class="v-rl">${emptyNote(model)}</div>`;
  const podium = relics.slice(0, PODIUM_SIZE);
  const rest = relics.slice(PODIUM_SIZE);
  const ledger = rest.length
    ? `
      <section class="v-panel v-rl-ledger" data-reveal style="--r:3" aria-label="Relics ranked ${PODIUM_SIZE + 1} to ${relics.length}">
        <div class="v-rl-head" aria-hidden="true">
          <span>#</span><span></span><span>Relic</span><span class="v-rl-head-counts"><span>Wins</span><span>Runs</span></span><span class="v-rl-head-wr">Win rate</span>
        </div>
        <ol class="v-rl-list" start="${PODIUM_SIZE + 1}">
          ${rest.map((entry, index) => ledgerRow(entry, PODIUM_SIZE + 1 + index, lowSampleRuns)).join("")}
        </ol>
      </section>`
    : "";
  return `
    <div class="v-rl">
      ${intro(model)}
      <ol class="v-rl-podium" data-size="${podium.length}" aria-label="Top ${podium.length} relics">
        ${podium.map((entry, index) => podiumItem(entry, index + 1, lowSampleRuns)).join("")}
      </ol>
      ${ledger}
      <div id="relic-detail-slot" class="relic-detail-slot v-rl-slot" aria-live="polite"></div>
    </div>`;
}

/** @param {RelicDetailModel} model */
function recordBox(model) {
  const { record, lowSampleRuns } = model;
  if (!record) {
    return `
      <aside class="v-rl-record">
        <h4>Your record with this relic</h4>
        <p class="v-rl-record-none">You haven't picked this relic yet.</p>
      </aside>`;
  }
  const losses = record.runs - record.wins;
  const isLow = record.runs < lowSampleRuns;
  const tone = toneKey(record.tone);
  return `
    <aside class="v-rl-record${isLow ? " is-low" : ""}" data-tone="${tone}">
      <div class="v-rl-record-main">
        <h4>Your record with this relic</h4>
        <p class="v-rl-record-wr"><span>${fixed(record.winratePct)}<small>%</small></span> win rate</p>
        ${meter(record.winratePct)}
        <p class="v-rl-record-tone"><i aria-hidden="true"></i>${TONE_LABELS[tone]}${isLow ? ` · under ${lowSampleRuns} runs, so treat it as a hint` : ""}</p>
      </div>
      <dl class="v-rl-record-nums">
        <div><dt>Picked</dt><dd>${record.runs}<small> ${record.runs === 1 ? "run" : "runs"}</small></dd></div>
        <div class="is-win"><dt><i aria-hidden="true"></i>Wins</dt><dd>${record.wins}</dd></div>
        <div class="is-loss"><dt><i aria-hidden="true"></i>Losses</dt><dd>${losses}</dd></div>
      </dl>
    </aside>`;
}

/** @param {RelicDetailModel} model */
function loreColumn(model) {
  const { info } = model;
  // No sourced copy: say so in the band and give the record the page.
  if (!info) return "";
  const chips = info.synergy.map((item) => `<li>${esc(item)}</li>`).join("");
  return `
    <div class="v-rl-lore">
      <section>
        <h4>In-game effect</h4>
        <p class="v-rl-effect">${esc(info.effect)}</p>
      </section>
      <section>
        <h4>When to pick</h4>
        <p>${esc(info.tip)}</p>
      </section>
      ${chips ? `<section><h4>Pairs with</h4><ul class="v-rl-pairs">${chips}</ul></section>` : ""}
    </div>`;
}

/**
 * A relic's parchment page, shown in #relic-detail-slot.
 * Keeps data-relic-detail (script.js uses it to toggle the same relic shut)
 * and data-action="relic-collapse" on the close button.
 * @param {RelicDetailModel} model
 * @returns {string}
 */
export function relicDetailHtml(model) {
  const rarity = rarityLabel(model.rarity);
  const kicker = rarity ? `${rarity} relic` : "Relic";
  const isBare = !model.info;
  return `
    <article class="v-rl-page" data-relic-detail="${esc(model.key)}" data-rarity="${rarityKey(model.rarity)}"
             aria-labelledby="v-rl-page-title">
      <header class="v-rl-page-band">
        <span class="v-rl-page-orb" aria-hidden="true">${relicArt(hdRelicSrc(model.src))}</span>
        <div class="v-rl-page-titles">
          <p class="v-rl-page-kicker">${esc(kicker)}</p>
          <h3 class="v-rl-page-name" id="v-rl-page-title">${esc(model.label)}</h3>
          ${isBare ? '<p class="v-rl-page-tagline">In-game effect copy not yet on file. Personal stats below.</p>' : ""}
        </div>
        <button class="v-icon-btn v-rl-page-close" type="button" data-action="relic-collapse" aria-label="Close detail">${CLOSE}</button>
      </header>
      <div class="v-rl-page-body${isBare ? " is-bare" : ""}">
        ${loreColumn(model)}
        ${recordBox(model)}
      </div>
    </article>`;
}
