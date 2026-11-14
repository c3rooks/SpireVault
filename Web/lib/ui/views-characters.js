// Characters tab views for the new UI. Pure functions: model in, HTML out.
// The model is built in script.js (buildCharactersTabModel /
// buildCharacterCodexModel) from Stats.summarize() and lib/character-info.js;
// nothing here reads run data or touches the DOM.
//
// Contract kept from the classic tab: every banner carries
// data-action="char-expand" + data-char-key (the shared drill-down handler in
// renderStatsTab looks the bucket up by that key), the codex page carries
// data-char-detail, its close button data-action="char-collapse", and the
// slot is #char-detail-slot.
// Styles: styles/src/surfaces/characters.css.

import { esc, fixed, clamp } from "./html.js?v=1";

/**
 * @typedef {Object} CharacterBanner
 * @property {string} key            lowercase slug: colour token + art
 * @property {string} actionKey      the bucket key the drill-down looks up
 * @property {string} label
 * @property {number} runs
 * @property {number} wins
 * @property {number} winratePct
 * @property {string|null} portraitSrc
 * @property {boolean} [isPortraitInked]  portraitSrc is tight-cropped stage art
 * @property {string} iconHtml       trusted fallback icon markup
 * @property {string} role           "" when there is no codex entry
 * @property {number} difficulty     1–5, 0 when unknown
 */

/**
 * @typedef {Object} CharactersModel
 * @property {ReadonlyArray<CharacterBanner>} characters
 */

/**
 * @typedef {Object} CodexInfo
 * @property {string} name
 * @property {string} tagline
 * @property {string} role
 * @property {number} difficulty
 * @property {string} summary
 * @property {{ aggression: number, complexity: number }} playstyle
 * @property {ReadonlyArray<string>} archetypes
 * @property {ReadonlyArray<{ title: string, detail: string }>} mechanics
 * @property {ReadonlyArray<string>} tips
 */

/**
 * @typedef {Object} CodexModel
 * @property {string} key            lowercase slug
 * @property {string} detailKey      echoed into data-char-detail (the handler's toggle check)
 * @property {string} label
 * @property {string|null} portraitSrc
 * @property {boolean} [isPortraitInked]
 * @property {string} iconHtml
 * @property {{ runs: number, wins: number, winratePct: number }|null} record   null = never played
 * @property {CodexInfo|null} info   null = no hand-written entry for this character
 */

const DIFFICULTY_MAX = 5;
const METER_MAX = 5;
/** Most banners one row holds once the row gets narrow (tablet widths). */
const NARROW_ROW_MAX = 5;

const ICONS = Object.freeze({
  chevron: '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>',
  swords: '<path d="M4 4l11 11M20 4 9 15M6.5 13.5l4 4M17.5 13.5l-4 4M3.5 20.5 7 17M20.5 20.5 17 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  branch: '<path d="M6 3v12a4 4 0 0 0 4 4h2M6 9a6 6 0 0 0 6 6M18 5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM14 19a2 2 0 1 1 4 0 2 2 0 0 1-4 0z" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
  cog: '<path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z" fill="none" stroke="currentColor" stroke-width="2.3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>',
  scroll: '<path d="M7 4h11a2 2 0 0 1 2 2v1h-4M7 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7M7 4a2 2 0 0 1 2 2v1M9 11h6M9 15h4" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
});

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** @param {number} count @param {string} noun @param {string} [pluralNoun] */
function plural(count, noun, pluralNoun) {
  return `${count} ${count === 1 ? noun : pluralNoun || `${noun}s`}`;
}

/**
 * Filled / empty pips, e.g. difficulty 3 of 5.
 * @param {number} value
 * @param {number} max
 * @param {string} className
 */
function pips(value, max, className) {
  const on = clamp(Math.round(value), 0, max);
  const cells = Array.from({ length: max }, (_, index) => `<i${index < on ? ' class="is-on"' : ""}></i>`).join("");
  return `<span class="${className}" aria-hidden="true">${cells}</span>`;
}

/**
 * The portrait for a banner, the codex card, or a fallback glyph.
 * @param {{ portraitSrc: string|null, isPortraitInked?: boolean, iconHtml: string }} row
 * @param {"lazy"|"eager"} loading
 */
function portrait(row, loading) {
  if (!row.portraitSrc) return `<span class="v-cb-glyph">${row.iconHtml}</span>`;
  const inked = row.isPortraitInked ? ' class="is-inked"' : "";
  return `<img${inked} src="${esc(row.portraitSrc)}" alt="" loading="${loading}" decoding="async" draggable="false">`;
}

/**
 * Win-rate meter: ink-outlined well, character-coloured fill, a tick at 50%.
 * @param {number} pct
 * @param {string} className
 */
function meter(pct, className) {
  return `<span class="${className}" aria-hidden="true"><i style="width:${clamp(pct, 0, 100).toFixed(1)}%"></i></span>`;
}

/**
 * @param {CharacterBanner} row
 * @param {number} index
 */
function banner(row, index) {
  const played = row.runs > 0;
  const losses = row.runs - row.wins;
  const spoken = played
    ? `${fixed(row.winratePct)} percent win rate, ${plural(row.wins, "win")} and ${plural(losses, "loss", "losses")} over ${plural(row.runs, "run")}`
    : "no runs yet";
  const difficulty = row.difficulty > 0
    ? `<span class="v-cb-diff" title="Difficulty ${row.difficulty} of ${DIFFICULTY_MAX}">${pips(row.difficulty, DIFFICULTY_MAX, "v-pips")}</span>`
    : "";
  const record = played
    ? `<b class="is-win">${row.wins}W</b><b class="is-loss">${losses}L</b><span>${plural(row.runs, "run")}</span>`
    : `<span>No runs yet</span>`;
  return `
    <li class="v-cb-cell" data-reveal style="--r:${index}">
    <button class="v-cb${played ? "" : " is-unplayed"}" type="button"
            data-char="${esc(row.key)}" data-action="char-expand" data-char-key="${esc(row.actionKey)}"
            aria-controls="char-detail-slot"
            aria-label="${esc(row.label)}: ${spoken}. Open the codex page.">
      <span class="v-cb-plate">
        ${difficulty}
        ${played ? "" : '<span class="v-cb-tag">Unplayed</span>'}
        ${portrait(row, "eager")}
      </span>
      <span class="v-cb-name">${esc(row.label)}</span>
      ${row.role ? `<span class="v-cb-role">${esc(row.role)}</span>` : ""}
      <span class="v-cb-stats">
        <span class="v-cb-wr">${played ? `${fixed(row.winratePct)}<small>%</small>` : "—"}</span>
        ${meter(played ? row.winratePct : 0, "v-cb-meter")}
        <span class="v-cb-rec">${record}</span>
      </span>
      <span class="v-cb-cta" aria-hidden="true">Codex ${icon("chevron")}</span>
    </button>
    </li>`;
}

/**
 * Columns for a narrow row: every banner in one row up to five, otherwise the
 * widest even split so no row is left with an orphan (6 → 3 × 2, 8 → 4 × 2).
 * @param {number} count
 */
function narrowColumns(count) {
  if (count <= NARROW_ROW_MAX) return count;
  for (let cols = NARROW_ROW_MAX; cols >= 2; cols -= 1) {
    if (count % cols === 0) return cols;
  }
  return Math.ceil(count / 2);
}

/**
 * The Characters tab body: every character's banner in one row (however
 * many there are), then the codex slot.
 * @param {CharactersModel} model
 * @returns {string}
 */
export function charactersHtml(model) {
  const rows = model.characters;
  if (rows.length === 0) {
    return `<div class="v-chx"><p class="v-chx-none">No character data yet.</p></div>`;
  }
  return `
    <div class="v-chx">
      <div class="v-section-title v-chx-title"><h3>Your climbers</h3></div>
      <ul class="v-cb-row" aria-label="Win rate by character" style="--cols:${rows.length};--cols-narrow:${narrowColumns(rows.length)}">
        ${rows.map(banner).join("")}
      </ul>
      <div id="char-detail-slot" class="v-cx-slot"></div>
    </div>`;
}

/**
 * One accordion section of the codex page.
 * @param {{ title: string, hint: string, icon: keyof typeof ICONS, open?: boolean, bodyHtml: string }} section
 */
function accordion(section) {
  return `
    <details class="v-cx-acc"${section.open ? " open" : ""}>
      <summary>
        <span class="v-cx-acc-orb">${icon(section.icon)}</span>
        <span class="v-cx-acc-title">${esc(section.title)}</span>
        <span class="v-cx-acc-hint">${esc(section.hint)}</span>
        <span class="v-cx-acc-chev">${icon("chevron")}</span>
      </summary>
      <div class="v-cx-acc-body">${section.bodyHtml}</div>
    </details>`;
}

/** @param {string} label @param {number} value */
function playstyleMeter(label, value) {
  return `
    <div class="v-cx-gauge">
      <span class="v-cx-gauge-label">${esc(label)}</span>
      ${pips(value, METER_MAX, "v-pips v-pips--lg")}
      <span class="v-cx-gauge-val">${clamp(value, 0, METER_MAX)}/${METER_MAX}</span>
    </div>`;
}

/** @param {CodexInfo} info */
function accordions(info) {
  const archetypes = info.archetypes.map((name) => `<li class="v-chip">${esc(name)}</li>`).join("");
  const mechanics = info.mechanics
    .map((mech) => `<li class="v-cx-mech"><strong>${esc(mech.title)}</strong><p>${esc(mech.detail)}</p></li>`)
    .join("");
  const tips = info.tips.map((tip) => `<li>${esc(tip)}</li>`).join("");
  // 0 means not rated yet (a new character): say nothing rather than 0/5.
  const rated = info.playstyle.aggression > 0 || info.playstyle.complexity > 0;
  return [
    accordion({
      title: "Playstyle",
      hint: rated
        ? `Aggression ${info.playstyle.aggression}/${METER_MAX} · Complexity ${info.playstyle.complexity}/${METER_MAX}`
        : "Not rated yet",
      icon: "swords",
      open: true,
      bodyHtml: `
        <p class="v-cx-summary">${esc(info.summary)}</p>
        ${rated ? `<div class="v-cx-gauges">
          ${playstyleMeter("Aggression", info.playstyle.aggression)}
          ${playstyleMeter("Complexity", info.playstyle.complexity)}
        </div>` : ""}`,
    }),
    accordion({
      title: "Archetypes",
      hint: info.archetypes.join(" · "),
      icon: "branch",
      bodyHtml: `<ul class="v-cx-chips">${archetypes}</ul>`,
    }),
    accordion({
      title: "Core mechanics",
      hint: plural(info.mechanics.length, "mechanic"),
      icon: "cog",
      bodyHtml: `<ul class="v-cx-mechs">${mechanics}</ul>`,
    }),
    accordion({
      title: "Climbing tips",
      hint: plural(info.tips.length, "tip"),
      icon: "scroll",
      bodyHtml: `<ol class="v-cx-tips">${tips}</ol>`,
    }),
  ].join("");
}

/** @param {CodexModel} model */
function recordBlock(model) {
  const { record } = model;
  if (!record || record.runs === 0) {
    return `
      <section class="v-cx-record is-empty" aria-label="Your record">
        <p class="v-eyebrow">Your record</p>
        <p class="v-cx-record-none">You haven't climbed as ${esc(model.label)} yet. Your record starts with the first run.</p>
      </section>`;
  }
  const losses = record.runs - record.wins;
  return `
    <section class="v-cx-record" aria-label="Your record">
      <div class="v-cx-record-top">
        <p class="v-eyebrow">Your record</p>
        <span class="v-cx-wr"><span>${fixed(record.winratePct)}</span><small>%</small></span>
      </div>
      ${meter(record.winratePct, "v-cx-meter")}
      <dl class="v-cx-nums">
        <div><dt>Runs</dt><dd>${record.runs}</dd></div>
        <div><dt>Wins</dt><dd class="is-win">${record.wins}</dd></div>
        <div><dt>Losses</dt><dd class="is-loss">${losses}</dd></div>
      </dl>
    </section>`;
}

/** @param {CodexModel} model */
function codexCard(model) {
  const { info } = model;
  const orb = info
    ? `<span class="v-cx-orb" title="Difficulty ${info.difficulty} of ${DIFFICULTY_MAX}"><b>${info.difficulty}</b></span>`
    : "";
  const text = info
    ? `<span class="v-cx-role">${esc(info.role)}</span>
       <span class="v-cx-diff">Difficulty ${pips(info.difficulty, DIFFICULTY_MAX, "v-pips")}</span>`
    : `<span class="v-cx-role">No codex entry yet</span>`;
  return `
    <div class="v-cx-card">
      ${orb}
      <header class="v-cx-band"><span class="v-cx-name" id="v-cx-name">${esc(info ? info.name : model.label)}</span></header>
      <div class="v-cx-art">${portrait(model, "eager")}</div>
      <p class="v-cx-text">${text}</p>
    </div>`;
}

/**
 * The codex page for one character, rendered into #char-detail-slot.
 * @param {CodexModel} model
 * @returns {string}
 */
export function characterCodexHtml(model) {
  const { info } = model;
  // Without a hand-written entry the record moves into the main column, so
  // the page stays one compact spread instead of a card beside a void.
  const main = info
    ? `<p class="v-cx-tagline">${esc(info.tagline)}</p>
       <div class="v-cx-accs">${accordions(info)}</div>`
    : `<p class="v-cx-tagline">No codex entry for ${esc(model.label)} yet — the guide arrives with the next update.</p>
       ${recordBlock(model)}`;
  return `
    <article class="v-cx${info ? "" : " is-bare"}" data-char-detail="${esc(model.detailKey)}" data-char="${esc(model.key)}" aria-labelledby="v-cx-name">
      <div class="v-cx-side">
        ${codexCard(model)}
        ${info ? recordBlock(model) : ""}
      </div>
      <div class="v-cx-main">
        <header class="v-cx-head">
          <p class="v-eyebrow">Codex page</p>
          <button class="v-icon-btn v-cx-close" type="button" data-action="char-collapse" aria-label="Close the ${esc(model.label)} codex page">${icon("close")}</button>
        </header>
        ${main}
      </div>
    </article>`;
}
