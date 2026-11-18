// Cards tab for the new UI. Pure functions: model in, HTML out.
// Data work (labels, art lookup, class, Wilson tone, pick rate) happens in
// script.js; nothing here touches parsedRuns or the DOM.
// Styles: styles/src/surfaces/cards.css.
//
// Most-picked: the top three stand on a podium as real cards, the rest sit
// in a ledger with a card thumbnail, how-often bar and win-rate bar.
// Most-skipped: one ledger (offered, picked, pick rate) — secondary, so no
// podium.

import { esc, fixed, clamp } from "./html.js?v=1";
import { toneKey, toneLegendHtml } from "./tone-legend.js?v=2";

/** @typedef {"win"|"gold"|"accent"} CardTone */

/**
 * @typedef {Object} PickedCard
 * @property {string} key
 * @property {string} label
 * @property {string|null} src           the 205x256 face (thumbnail size)
 * @property {string|null} [srcLarge]    the same face at twice the size, when there is one
 * @property {string|null} classKey      ironclad … necrobinder | colorless | curse | status | null
 * @property {number} picks
 * @property {number} wins
 * @property {number} winratePct
 * @property {number|null} pickRatePct   null when the history has no offer data
 * @property {CardTone} tone
 */

/**
 * @typedef {Object} SkippedCard
 * @property {string} key
 * @property {string} label
 * @property {string|null} src
 * @property {string|null} [srcLarge]
 * @property {string|null} classKey
 * @property {number} offered
 * @property {number} picks
 * @property {number} pickRatePct
 */

/**
 * @typedef {Object} CardsModel
 * @property {ReadonlyArray<PickedCard>} picked     most picked first
 * @property {ReadonlyArray<SkippedCard>} skipped   least picked first
 * @property {boolean} hasOffers                    pick rate is meaningful
 * @property {number} lowSampleRuns
 * @property {number} baselinePct                   the player's overall win rate, 0..100
 */

const PODIUM_SIZE = 3;
const CHARACTERS = new Set(["ironclad", "silent", "defect", "regent", "necrobinder", "fool"]);

const CARD_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2.5" fill="currentColor"/></svg>';
const SKIP_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>';

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

/** @param {string|null} classKey */
function classAttrs(classKey) {
  if (!classKey) return "";
  return CHARACTERS.has(classKey) ? ` data-char="${esc(classKey)}"` : ` data-class="${esc(classKey)}"`;
}

/** @param {string|null} classKey */
function classChip(classKey) {
  if (!classKey) return "";
  const label = classKey.charAt(0).toUpperCase() + classKey.slice(1);
  return `<span class="v-cd-class"${classAttrs(classKey)}>${esc(label)}</span>`;
}

/**
 * @param {number} pct
 * @param {string} kind   "win" | "pick" | "skip"
 */
function meter(pct, kind) {
  return `<span class="v-cd-bar" data-kind="${kind}" aria-hidden="true"><i style="width:${clamp(pct, 0, 100).toFixed(1)}%"></i></span>`;
}

/**
 * Card art at row size. The image grows into a full-size card on hover (CSS
 * transform), so the row loads the large face from the start. It used to
 * load the small face and swap the large one in when the row neared the
 * screen, and players watched every card go soft-to-sharp a couple of
 * seconds after the tab opened. The large face is ~15KB more per row, and
 * rows load lazily.
 * @param {{ src: string|null, srcLarge?: string|null }} card
 * @param {boolean} [isSkip]
 */
function thumb(card, isSkip = false) {
  const src = card.srcLarge || card.src;
  const art = src
    ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : `<span class="v-cd-thumb-glyph">${isSkip ? SKIP_GLYPH : CARD_GLYPH}</span>`;
  return `<span class="v-cd-thumb${src ? "" : " is-missing"}" aria-hidden="true">${art}${isSkip ? `<span class="v-cd-skip-badge">${SKIP_GLYPH}</span>` : ""}</span>`;
}

/**
 * How-often bar: the real pick rate when offers are recorded, otherwise the
 * card's picks against the most-picked card's.
 * @param {PickedCard} card
 * @param {number} maxPicks
 */
function oftenPct(card, maxPicks) {
  return card.pickRatePct ?? (maxPicks > 0 ? (card.picks / maxPicks) * 100 : 0);
}

/**
 * @param {PickedCard} card
 * @param {number} rank
 * @param {boolean} isLow
 */
function pickedLabel(card, rank, isLow) {
  const rate = card.pickRatePct == null ? "" : ` Picked ${fixed(card.pickRatePct, 0)} percent of the times offered.`;
  const sample = isLow ? " Small sample." : "";
  return `Rank ${rank}, ${card.label}: picked ${card.picks} times.${rate} ${fixed(card.winratePct)} percent win rate, ${plural(card.wins, "win")}.${sample}`;
}

/**
 * @param {PickedCard} card
 * @param {number} rank
 * @param {CardsModel} model
 */
function podiumItem(card, rank, model) {
  const isLow = card.picks < model.lowSampleRuns;
  // The podium shows the card large: the large face, when there is one.
  const art = card.src
    ? `<img src="${esc(card.srcLarge || card.src)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : `<span class="v-cd-top-glyph">${CARD_GLYPH}</span>`;
  const rate = card.pickRatePct == null
    ? ""
    : `<div><dt>Pick rate</dt><dd>${fixed(card.pickRatePct, 0)}<small>%</small></dd></div>`;
  return `
    <li class="v-cd-step${isLow ? " is-low" : ""}" data-rank="${rank}" data-tone="${toneKey(card.tone)}"
        data-reveal style="--r:${rank === 1 ? 0 : rank === 2 ? 1 : 2}">
      <span class="v-sr">${esc(pickedLabel(card, rank, isLow))}</span>
      <span class="v-cd-top-card${card.src ? "" : " is-missing"}" data-tilt aria-hidden="true">${art}</span>
      <div class="v-cd-top-plate" aria-hidden="true">
        <span class="v-cd-top-band"><span class="v-cd-top-rank">${ordinal(rank)}</span></span>
        <span class="v-cd-top-name">${esc(card.label)}</span>
        ${classChip(card.classKey)}
        <dl class="v-cd-top-stats">
          <div><dt>Picked</dt><dd>${card.picks}<small>×</small></dd></div>
          ${rate}
          <div class="is-hero"><dt>Win rate</dt><dd>${fixed(card.winratePct)}<small>%</small></dd></div>
        </dl>
        ${meter(card.winratePct, "win")}
        ${isLow ? '<span class="v-cd-stamp">Low sample</span>' : ""}
      </div>
    </li>`;
}

/**
 * One stat cell. The small label only shows on phones, where the column
 * header is gone.
 * @param {string} className
 * @param {string} label
 * @param {string} valueHtml   trusted
 * @param {string} [meterHtml] trusted
 */
function cell(className, label, valueHtml, meterHtml = "") {
  return `<span class="v-cd-cell ${className}"><span class="v-cd-cell-k">${label}</span>${meterHtml}<b>${valueHtml}</b></span>`;
}

/**
 * @param {PickedCard} card
 * @param {number} rank
 * @param {CardsModel} model
 * @param {number} maxPicks
 */
function pickedRow(card, rank, model, maxPicks) {
  const isLow = card.picks < model.lowSampleRuns;
  const often = model.hasOffers
    ? cell("v-cd-picks", "Picked", `${card.picks}<small>×</small>`) +
      cell("v-cd-often", "Pick rate", `${fixed(card.pickRatePct ?? 0, 0)}<small>%</small>`, meter(oftenPct(card, maxPicks), "pick"))
    : cell("v-cd-often", "Picked", `${card.picks}<small>×</small>`, meter(oftenPct(card, maxPicks), "pick"));
  return `
    <li class="v-cd-row${isLow ? " is-low" : ""}" data-tone="${toneKey(card.tone)}" data-hd-zoom>
      <span class="v-sr">${esc(pickedLabel(card, rank, isLow))}</span>
      <span class="v-cd-rank" aria-hidden="true">${rank}</span>
      ${thumb(card)}
      <span class="v-cd-id" aria-hidden="true">
        <span class="v-cd-name">${esc(card.label)}</span>
        <span class="v-cd-tags">${classChip(card.classKey)}${isLow ? '<span class="v-cd-tag is-low">Low sample</span>' : ""}</span>
      </span>
      <span class="v-cd-stats" aria-hidden="true">
        ${often}
        ${cell("v-cd-win", "Win rate", `${fixed(card.winratePct)}<small>%</small>`, meter(card.winratePct, "win"))}
      </span>
    </li>`;
}

/**
 * @param {SkippedCard} card
 * @param {number} rank
 */
function skippedRow(card, rank) {
  const label = `Rank ${rank}, ${card.label}: offered ${card.offered} times, picked ${card.picks}. Picked ${fixed(card.pickRatePct)} percent of the time.`;
  return `
    <li class="v-cd-row v-cd-row--skip" data-hd-zoom>
      <span class="v-sr">${esc(label)}</span>
      <span class="v-cd-rank" aria-hidden="true">${rank}</span>
      ${thumb(card, true)}
      <span class="v-cd-id" aria-hidden="true">
        <span class="v-cd-name">${esc(card.label)}</span>
        <span class="v-cd-tags">${classChip(card.classKey)}</span>
      </span>
      <span class="v-cd-stats" aria-hidden="true">
        ${cell("v-cd-offered", "Offered", String(card.offered))}
        ${cell("v-cd-picked", "Picked", String(card.picks))}
        ${cell("v-cd-often", "Pick rate", `${fixed(card.pickRatePct)}<small>%</small>`, meter(card.pickRatePct, "skip"))}
      </span>
    </li>`;
}

/** @param {CardsModel} model */
function pickedHead(model) {
  const often = model.hasOffers
    ? '<span class="v-cd-picks">Picked</span><span class="v-cd-often">Pick rate</span>'
    : '<span class="v-cd-often">Picked</span>';
  return `
    <div class="v-cd-head" aria-hidden="true">
      <span>#</span><span></span><span>Card</span>
      <span class="v-cd-stats">${often}<span class="v-cd-win">Win rate</span></span>
    </div>`;
}

/** @param {CardsModel} model */
function pickedSection(model) {
  const title = `
    <div class="v-section-title v-cd-title"><h3 id="v-cd-picked-h">Most-picked cards</h3></div>`;
  if (model.picked.length === 0) {
    return `
      <section class="v-cd-sec" aria-labelledby="v-cd-picked-h">
        ${title}
        <div class="v-cd-empty v-panel" data-reveal style="--r:0">
          <span class="v-cd-empty-art" aria-hidden="true">${CARD_GLYPH}</span>
          <p>No card-pick data in your history yet.</p>
        </div>
      </section>`;
  }
  const maxPicks = Math.max(...model.picked.map((card) => card.picks));
  const podium = model.picked.slice(0, PODIUM_SIZE);
  const rest = model.picked.slice(PODIUM_SIZE);
  // The tab subtitle already says "how those runs end"; the lede says what
  // the numbers are instead of saying that again.
  const lede = model.hasOffers
    ? "How often you take each card when it's offered, and how many of those picks went on to win."
    : "Most-taken first, with how often those picks went on to win. Bars compare each card with your top pick.";
  const ledger = rest.length
    ? `
      <div class="v-panel v-cd-ledger" data-offers="${model.hasOffers ? "1" : "0"}" data-reveal style="--r:3">
        ${pickedHead(model)}
        <ol class="v-cd-list" start="${PODIUM_SIZE + 1}">
          ${rest.map((card, index) => pickedRow(card, PODIUM_SIZE + 1 + index, model, maxPicks)).join("")}
        </ol>
      </div>`
    : "";
  // The win-rate bars carry the same colours as Top Relics; the shared key
  // says what they mean (tone-legend.js).
  return `
    <section class="v-cd-sec" aria-labelledby="v-cd-picked-h">
      ${title}
      <div class="v-cd-intro">
        <p class="v-cd-lede">${lede}</p>
        ${toneLegendHtml({ baselinePct: model.baselinePct, lowSampleRuns: model.lowSampleRuns, lowSampleNoun: "picks" })}
      </div>
      <ol class="v-cd-podium" data-size="${podium.length}">
        ${podium.map((card, index) => podiumItem(card, index + 1, model)).join("")}
      </ol>
      ${ledger}
    </section>`;
}

/** @param {CardsModel} model */
function skippedSection(model) {
  if (model.skipped.length === 0) return "";
  return `
    <section class="v-cd-sec v-cd-sec--skip" aria-labelledby="v-cd-skipped-h">
      <div class="v-section-title v-cd-title"><h3 id="v-cd-skipped-h">Most-skipped cards</h3><p>Offered often, picked rarely.</p></div>
      <div class="v-panel v-cd-ledger v-cd-ledger--skip" data-reveal style="--r:4">
        <div class="v-cd-head" aria-hidden="true">
          <span>#</span><span></span><span>Card</span>
          <span class="v-cd-stats"><span class="v-cd-offered">Offered</span><span class="v-cd-picked">Picked</span><span class="v-cd-often">Pick rate</span></span>
        </div>
        <ol class="v-cd-list">
          ${model.skipped.map((card, index) => skippedRow(card, index + 1)).join("")}
        </ol>
      </div>
    </section>`;
}

/**
 * The Cards body.
 * @param {CardsModel} model
 * @returns {string}
 */
export function cardsTabHtml(model) {
  return `
    <div class="v-cd">
      ${pickedSection(model)}
      ${skippedSection(model)}
    </div>`;
}
