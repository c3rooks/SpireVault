// Recent Runs views for the new UI: the run ledger, the run-detail page and
// the compare page. Pure functions: model in, HTML out. All data work
// (filtering, labels, image lookups, dates) happens in script.js with the
// existing helpers; nothing here touches parsedRuns or the DOM.
//
// Every hook script.js listens for is kept: `.run-row[data-run-id]`,
// `[data-filter-kind][data-filter-value]`, `input[data-filter-kind="search"]`,
// and the data-action names (compare-toggle, clear-filters, copy-row-link,
// share-run, share-from-detail, copy-run-link, close-detail).
// Styles: styles/src/surfaces/runs.css.

import { esc } from "./html.js?v=1";

/**
 * @typedef {"win"|"loss"|"abandon"} RunResult
 */

/**
 * @typedef {Object} RunArt
 * @property {string} charKey      lowercase character key, "" when unknown
 * @property {string} charName
 * @property {string|null} artSrc
 * @property {boolean} isArtInked  artSrc is the tight-cropped stage figure
 * @property {string} iconHtml     trusted fallback glyph
 */

/**
 * @typedef {RunArt & {
 *   id: string,
 *   ascension: number|null,
 *   ascLabel?: string,   "A7", or "Blitz A2" / "Dread" for STS2 beta modes
 *   floor: number|null,
 *   floorShare: number,
 *   duration: string,
 *   dateDay: string,     "Nov 14, 2026"
 *   dateRest: string,    " at 4:02 AM" (dropped on phones)
 *   result: RunResult,
 *   killedBy: string,
 *   group: string,       ledger divider: "Today", "Last week", "October 2026"
 *   isSelected: boolean,
 * }} RunRowModel
 */

/**
 * @typedef {Object} RunsModel
 * @property {{ outcome: string, ascensionTier: string, character: string, search: string }} filters
 * @property {ReadonlyArray<{ id: string, label: string }>} outcomes
 * @property {ReadonlyArray<{ id: string, label: string, title?: string }>} tiers   title: the tier's name (Early climb …)
 * @property {ReadonlyArray<{ key: string, label: string, disabled?: boolean }>} characters   every climber; unplayed ones disabled
 * @property {number} total          runs before filters
 * @property {number} filteredCount  runs after filters
 * @property {boolean} isFiltered
 * @property {boolean} compareMode
 * @property {ReadonlyArray<RunRowModel>} rows   the visible page, newest first
 * @property {number} pageSize
 * @property {string} autoRefreshHtml   trusted legacy status pill
 */

/**
 * @typedef {Object} PathNode
 * @property {number} floor
 * @property {string} type        combat | elite | shop | rest | event | chest | boss | unknown
 * @property {string} typeLabel
 * @property {""|"death"|"abandon"|"win"} mark
 */

/**
 * @typedef {Object} ActModel
 * @property {number} act
 * @property {string} numeral
 * @property {string} name
 * @property {string} summary
 * @property {ReadonlyArray<PathNode>} nodes
 */

/**
 * @typedef {RunArt & {
 *   result: RunResult,
 *   ascension: number|null,
 *   date: string,
 *   seed: string,
 *   sourceFile: string,
 *   fate: string,
 *   stats: ReadonlyArray<{ label: string, value: string }>,
 *   acts: ReadonlyArray<ActModel>,
 *   roomCount: number,
 *   legend: ReadonlyArray<{ type: string, label: string }>,
 *   relics: ReadonlyArray<{ label: string, src: string|null }>,
 *   deck: ReadonlyArray<{ label: string, src: string|null, count: number, upgraded: boolean }>,
 *   deckCount: number,
 *   picks: ReadonlyArray<{ floor: number, picked: string|null, skipped: ReadonlyArray<string> }>,
 *   pickCount: number,
 * }} RunDetailModel
 */

/**
 * @typedef {RunArt & {
 *   result: RunResult,
 *   ascension: number|null,
 *   date: string,
 *   stats: ReadonlyArray<{ label: string, value: string }>,
 *   relics: ReadonlyArray<{ label: string, src: string|null, isShared: boolean }>,
 *   relicTotal: number,
 *   uniqueCards: ReadonlyArray<{ label: string, src: string|null, upgraded: boolean }>,
 *   killedBy: string,
 * }} CompareColumn
 */

/**
 * @typedef {Object} CompareModel
 * @property {ReadonlyArray<CompareColumn>} columns
 * @property {ReadonlyArray<{ label: string, src: string|null }>} sharedRelics
 * @property {ReadonlyArray<{ label: string, src: string|null }>} sharedCards
 * @property {number} sharedRelicTotal
 * @property {number} sharedCardTotal
 */

const RESULT_LABEL = Object.freeze({ win: "Victory", loss: "Defeat", abandon: "Abandoned" });
const MARK_LABEL = Object.freeze({ death: "Fell here", abandon: "Abandoned here", win: "Victory" });

const ICONS = Object.freeze({
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.6-4.6"/>',
  compare: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  skull: '<path d="M12 3a8 8 0 0 0-8 8v3l2 2v4h12v-4l2-2v-3a8 8 0 0 0-8-8z"/><circle cx="9" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  crown: '<path d="m3 8 4 4 5-7 5 7 4-4-1 11H4z" fill="currentColor"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
});

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** @param {number} count @param {string} noun @param {string} [pluralNoun] */
function plural(count, noun, pluralNoun) {
  return `${count} ${count === 1 ? noun : pluralNoun || `${noun}s`}`;
}

/** @param {RunResult} result @param {string} [extraClass] */
function stamp(result, extraClass = "") {
  return `<span class="v-stamp${extraClass ? ` ${extraClass}` : ""}" data-result="${esc(result)}">${esc(RESULT_LABEL[result])}</span>`;
}

/**
 * The character plate: inked stage figure (or classic portrait / glyph) on
 * the character's colour.
 * @param {RunArt} art
 * @param {string} className
 */
function plate(art, className) {
  const inner = art.artSrc
    ? `<img${art.isArtInked ? ' class="is-inked"' : ""} src="${esc(art.artSrc)}" alt="" loading="lazy" decoding="async" draggable="false">`
    : art.iconHtml;
  return `<span class="${className}" data-char="${esc(art.charKey)}" aria-hidden="true">${inner}</span>`;
}

/**
 * A relic orb or card thumbnail with a text fallback when the art is missing.
 * @param {{ label: string, src: string|null }} item
 * @param {string} fallbackClass
 */
function art(item, fallbackClass) {
  const initials = esc(item.label.slice(0, 2));
  if (!item.src) return `<span class="${fallbackClass}">${initials}</span>`;
  return `<img src="${esc(item.src)}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span class="${fallbackClass}" hidden>${initials}</span>`;
}

// ---------------------------------------------------------------------------
// The run ledger
// ---------------------------------------------------------------------------

/**
 * @param {string} kind
 * @param {string} value
 * @param {string} label
 * @param {boolean} pressed
 * @param {string} [charKey]
 * @param {boolean} [disabled]  shown but not clickable (a climber with no runs)
 * @param {string} [title]      tooltip, e.g. an ascension tier's name
 */
function chip(kind, value, label, pressed, charKey, disabled = false, title = "") {
  const char = charKey ? ` data-char="${esc(charKey)}"` : "";
  const dot = charKey ? '<i class="v-runs-dot" aria-hidden="true"></i>' : "";
  const tip = disabled ? ` disabled title="No runs as ${esc(label)} yet"` : title ? ` title="${esc(title)}"` : "";
  return `<button class="v-runs-chip" type="button" data-filter-kind="${esc(kind)}" data-filter-value="${esc(value)}" aria-pressed="${pressed}"${char}${tip}>${dot}${esc(label)}</button>`;
}

/** @param {string} label @param {string} chipsHtml */
function chipGroup(label, chipsHtml) {
  return `
    <div class="v-runs-group" role="group" aria-label="${esc(label)}">
      <span class="v-runs-group-label" aria-hidden="true">${esc(label)}</span>
      <div class="v-runs-chips">${chipsHtml}</div>
    </div>`;
}

/** @param {RunsModel} model */
function filtersBar(model) {
  const { filters } = model;
  const outcome = model.outcomes.map((o) => chip("outcome", o.id, o.label, filters.outcome === o.id)).join("");
  const tiers = model.tiers.map((t) => chip("ascensionTier", t.id, t.label, filters.ascensionTier === t.id, undefined, false, t.title)).join("");
  const chars = [
    chip("character", "all", "All", filters.character === "all"),
    ...model.characters.map((c) => chip("character", c.key, c.label, filters.character === c.key, c.key, c.disabled)),
  ].join("");
  const summary = model.isFiltered
    ? `Showing <b>${model.filteredCount}</b> of <b>${model.total}</b> runs
       <button class="v-runs-clear" type="button" data-action="clear-filters">Clear filters</button>`
    : `All <b>${model.total}</b> runs`;
  return `
    <section class="v-panel v-runs-filters" role="region" aria-label="Filter runs" data-reveal style="--r:0">
      <div class="v-runs-filters-top">
        <label class="v-runs-search">
          ${icon("search")}
          <span class="v-sr">Search runs</span>
          <input type="search" placeholder="Search runs" title="Search by seed, character, win or loss" value="${esc(filters.search)}" data-filter-kind="search" autocomplete="off" enterkeyhint="search">
        </label>
        <button class="v-btn v-runs-compare" type="button" data-action="compare-toggle" aria-pressed="${model.compareMode}"
                title="Compare mode (c): pick 2 or 3 runs and see them side by side">
          ${icon("compare")}<span>${model.compareMode ? "Exit compare" : "Compare"}</span>
        </button>
      </div>
      <div class="v-runs-groups">
        ${chipGroup("Outcome", outcome)}
        ${chipGroup("Ascension", tiers)}
        ${chipGroup("Character", chars)}
      </div>
      <p class="v-runs-summary" aria-live="polite">${summary}</p>
    </section>`;
}

/** "A7", the model's mode-aware label when given (Blitz/Dread), or "". @param {{ ascension: number|null, ascLabel?: string }} row  a run row, detail or compare column */
function ascText(row) {
  if (typeof row.ascLabel === "string") return row.ascLabel;
  return row.ascension !== null ? `A${row.ascension}` : "";
}

/** @param {RunRowModel} row @param {boolean} compareMode */
function rowLabel(row, compareMode) {
  const prefix = compareMode ? `${row.isSelected ? "Deselect" : "Select"} run for compare: ` : "Open run details: ";
  const asc = ascText(row) ? ` ${ascText(row)}` : "";
  const floor = row.floor !== null ? ` on floor ${row.floor}` : "";
  return `${prefix}${row.charName}${asc} ${RESULT_LABEL[row.result].toLowerCase()}${floor}`;
}

/** @param {RunRowModel} row @param {boolean} compareMode */
function runRow(row, compareMode) {
  const role = compareMode ? "checkbox" : "button";
  const checked = compareMode && row.isSelected ? "true" : "false";
  const check = compareMode ? `<span class="v-run-check" aria-hidden="true">${icon("check")}</span>` : "";
  const asc = ascText(row) ? `<span class="v-run-asc">${esc(ascText(row))}</span>` : "";
  const floor = row.floor !== null
    ? `<span class="v-run-floor"><span class="v-run-num">${row.floor}</span><span class="v-run-cap">Floor</span>
         <span class="v-run-meter" aria-hidden="true"><i style="--p:${row.floorShare.toFixed(3)}"></i></span></span>`
    : '<span class="v-run-floor is-empty"></span>';
  const time = row.duration
    ? `<span class="v-run-time"><span class="v-run-num">${esc(row.duration)}</span><span class="v-run-cap">Time</span></span>`
    : '<span class="v-run-time is-empty"></span>';
  const id = esc(row.id);
  return `
    <div class="run-row v-run${row.isSelected ? " is-compare-selected" : ""}" data-char="${esc(row.charKey)}" data-result="${row.result}"
         data-run-id="${id}" tabindex="0" role="${role}" aria-checked="${checked}" aria-label="${esc(rowLabel(row, compareMode))}"
         data-run-preview="${compareMode ? "0" : "1"}">
      ${check}
      ${plate(row, "v-run-sigil")}
      <span class="v-run-id">
        <span class="v-run-name">${esc(row.charName)}${asc}</span>
        ${row.dateDay || row.killedBy
          ? `<span class="v-run-date">${esc(row.dateDay)}${row.dateRest ? `<span class="v-run-at">${esc(row.dateRest)}</span>` : ""}${row.killedBy ? `<span class="v-run-killer">${row.dateDay ? '<span aria-hidden="true"> · </span>' : ""}Slain by <b>${esc(row.killedBy)}</b></span>` : ""}</span>`
          : ""}
      </span>
      <span class="v-run-stats">${floor}${time}</span>
      ${stamp(row.result, "v-run-stamp")}
      <span class="v-run-actions">
        <button class="v-run-btn v-run-btn--link" type="button" data-action="copy-row-link" data-run-id="${id}"
                title="Copy a direct link to this run" aria-label="Copy link to this run"></button>
        <button class="v-run-btn v-run-btn--share" type="button" data-action="share-run" data-run-id="${id}"
                title="Share this run" aria-label="Share this run">${icon("share")}<span>Share</span></button>
      </span>
    </div>`;
}

/** @param {RunsModel} model */
function moreBar(model) {
  const shown = model.rows.length;
  const remaining = model.filteredCount - shown;
  if (remaining <= 0) {
    return model.filteredCount > model.pageSize
      ? `<p class="v-runs-more is-done">All ${model.filteredCount} runs shown</p>`
      : "";
  }
  const next = Math.min(model.pageSize, remaining);
  return `
    <div class="v-runs-more">
      <p>Showing <b>${shown}</b> of <b>${model.filteredCount}</b></p>
      <button class="v-btn v-btn--paper" type="button" data-action="runs-show-more">Show ${next} more</button>
      <button class="v-btn" type="button" data-action="runs-show-all">Show all ${model.filteredCount}</button>
    </div>`;
}

/**
 * The Recent Runs tab body.
 * @param {RunsModel} model
 * @returns {string}
 */
export function runsHtml(model) {
  const heading = `
    <div class="v-section-title v-runs-title">
      <h3>Run history</h3>
      <p>Newest first · ${model.compareMode ? "pick 2 or 3 runs to compare" : "open a run for its act path, relics and deck"}</p>
    </div>`;
  if (!model.rows.length) {
    return `
      <div class="v-runs${model.compareMode ? " is-comparing" : ""}">
        ${filtersBar(model)}
        ${model.autoRefreshHtml}
        ${heading}
        <div class="v-runs-empty" data-reveal style="--r:1">
          <span class="v-stamp" data-result="abandon">No runs</span>
          <p>Nothing matches these filters.</p>
          <button class="v-btn v-btn--paper" type="button" data-action="clear-filters">Clear filters</button>
        </div>
      </div>`;
  }
  return `
    <div class="v-runs${model.compareMode ? " is-comparing" : ""}">
      ${filtersBar(model)}
      ${model.autoRefreshHtml}
      ${heading}
      <div class="v-runs-list" data-reveal style="--r:1">
        ${model.rows
          .map((row, index) => {
            const isNewGroup = row.group && (index === 0 || model.rows[index - 1].group !== row.group);
            const head = isNewGroup ? `<h4 class="v-runs-day">${esc(row.group)}</h4>` : "";
            return head + runRow(row, model.compareMode);
          })
          .join("")}
      </div>
      ${moreBar(model)}
    </div>`;
}

// ---------------------------------------------------------------------------
// Run detail: a parchment page
// ---------------------------------------------------------------------------

/** @param {PathNode} node */
function pathNode(node) {
  const isBoss = node.type === "boss";
  const markClass = node.mark === "death" ? " path-node--death"
    : node.mark === "abandon" ? " path-node--death is-abandon"
    : node.mark === "win" ? " path-node--win" : "";
  const badge = node.mark === "death" ? `<span class="v-node-badge">${icon("skull")}</span>`
    : node.mark === "win" ? `<span class="v-node-badge">${icon("crown")}</span>`
    : node.mark === "abandon" ? `<span class="v-node-badge">${icon("flag")}</span>` : "";
  const sr = `Floor ${node.floor}, ${node.typeLabel}${node.mark ? `, ${MARK_LABEL[node.mark]}` : ""}`;
  return `
    <li class="v-node v-node--${esc(node.type)}${isBoss ? " is-boss" : ""}${markClass}" title="Floor ${node.floor} · ${esc(node.typeLabel)}${node.mark ? ` · ${MARK_LABEL[node.mark]}` : ""}">
      <span class="v-node-orb"><span class="path-node-icon" data-node-type="${esc(node.type)}" aria-hidden="true"></span>${badge}</span>
      <span class="v-node-floor" aria-hidden="true">${node.floor}</span>
      <span class="v-sr">${esc(sr)}</span>
    </li>`;
}

/** @param {ActModel} act */
function actBlock(act) {
  const last = act.nodes[act.nodes.length - 1];
  const marker = last && last.mark
    ? `<li class="v-act-mark" aria-hidden="true"><span class="v-stamp" data-result="${last.mark === "death" ? "loss" : last.mark}">${esc(MARK_LABEL[last.mark])}</span></li>`
    : "";
  return `
    <section class="v-act${last && last.mark ? " is-final" : ""}" aria-label="Act ${act.act}: ${esc(act.name)}">
      <header class="v-act-head">
        <span class="v-act-num" aria-hidden="true">${esc(act.numeral)}</span>
        <h5>Act ${act.act} <span>${esc(act.name)}</span></h5>
        <span class="v-act-sum">${esc(act.summary)}</span>
      </header>
      <ol class="v-act-trail">
        ${act.nodes.map(pathNode).join("")}
        ${marker}
      </ol>
    </section>`;
}

/** @param {RunDetailModel} model */
function pathSection(model) {
  if (!model.acts.length) return "";
  const legend = model.legend
    .map((item) => `<li><span class="path-node-icon" data-node-type="${esc(item.type)}" aria-hidden="true"></span>${esc(item.label)}</li>`)
    .join("");
  return `
    <section class="v-rd-sec v-rd-path">
      <header class="v-rd-sec-head">
        <h4>The path you took</h4>
        <span class="v-rd-count">${plural(model.roomCount, "room")}</span>
      </header>
      <p class="v-rd-note">Every room you walked through, read from your <code>.run</code> file. The save only records rooms you visited, so the branches you skipped are not drawn.</p>
      ${model.acts.map(actBlock).join("")}
      <ul class="v-rd-legend" aria-label="Map legend">${legend}</ul>
    </section>`;
}

/** @param {RunDetailModel} model */
function relicSection(model) {
  if (!model.relics.length) return "";
  const items = model.relics
    .map((relic) => `
      <li class="v-rd-relic" title="${esc(relic.label)}">
        <span class="v-rd-relic-orb">${art(relic, "v-rd-fallback")}</span>
        <span class="v-rd-relic-name">${esc(relic.label)}</span>
      </li>`)
    .join("");
  return `
    <section class="v-rd-sec">
      <header class="v-rd-sec-head"><h4>Relics</h4><span class="v-rd-count">${model.relics.length}</span></header>
      <ul class="v-rd-relics">${items}</ul>
    </section>`;
}

/** @param {RunDetailModel} model */
function deckSection(model) {
  if (!model.deck.length) return "";
  const items = model.deck
    .map((card) => {
      const name = `${card.label}${card.upgraded ? "+" : ""}`;
      return `
        <li class="v-rd-card${card.count > 1 ? " is-stack" : ""}${card.upgraded ? " is-upgraded" : ""}"
            title="${esc(name)}${card.count > 1 ? ` ×${card.count}` : ""}${card.upgraded ? " (upgraded)" : ""}">
          <span class="v-rd-card-art">${art(card, "v-rd-card-fallback")}</span>
          ${card.count > 1 ? `<span class="v-rd-card-count" aria-hidden="true">×${card.count}</span>` : ""}
          <span class="v-sr">${esc(name)}${card.count > 1 ? `, ${card.count} copies` : ""}</span>
        </li>`;
    })
    .join("");
  return `
    <section class="v-rd-sec">
      <header class="v-rd-sec-head"><h4>Final deck</h4><span class="v-rd-count">${plural(model.deckCount, "card")}</span></header>
      <ul class="v-rd-deck">${items}</ul>
    </section>`;
}

/** @param {RunDetailModel} model */
function picksSection(model) {
  if (!model.picks.length) return "";
  const rows = model.picks
    .map((pick) => `
      <li class="v-rd-pick">
        <span class="v-rd-pick-floor">F${pick.floor}</span>
        <span class="v-rd-pick-body">
          ${pick.picked ? `<b>${esc(pick.picked)}</b>` : '<em>Skipped all</em>'}
          ${pick.skipped.length ? `<span class="v-rd-pick-skip">over ${pick.skipped.map(esc).join(" · ")}</span>` : ""}
        </span>
      </li>`)
    .join("");
  return `
    <section class="v-rd-sec">
      <header class="v-rd-sec-head"><h4>Card picks by floor</h4><span class="v-rd-count">${plural(model.pickCount, "choice")}</span></header>
      <ol class="v-rd-picks">${rows}</ol>
    </section>`;
}

/**
 * The body of the run-detail modal.
 * @param {RunDetailModel} model
 * @returns {string}
 */
export function runDetailHtml(model) {
  const asc = ascText(model) ? `<span class="v-rd-asc">${esc(ascText(model))}</span>` : "";
  const meta = [
    model.seed ? `Seed <b>${esc(model.seed)}</b>` : "",
    model.sourceFile ? `From <b>${esc(model.sourceFile)}</b>` : "",
  ].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  const stats = model.stats
    .map((stat) => `<div><dt>${esc(stat.label)}</dt><dd>${esc(stat.value)}</dd></div>`)
    .join("");
  return `
    <article class="v-rd" data-char="${esc(model.charKey)}" data-result="${model.result}">
      <header class="v-rd-hero">
        ${plate(model, "v-rd-plate")}
        <div class="v-rd-id">
          <p class="v-rd-date">${esc(model.date)}</p>
          <h3 class="v-rd-name">${esc(model.charName)}${asc}</h3>
          <p class="v-rd-fate">${esc(model.fate)}</p>
          ${meta ? `<p class="v-rd-meta">${meta}</p>` : ""}
        </div>
        ${stamp(model.result, "v-rd-stamp")}
      </header>
      <dl class="v-rd-stats">${stats}</dl>
      ${pathSection(model)}
      ${relicSection(model)}
      ${deckSection(model)}
      ${picksSection(model)}
      <footer class="v-rd-actions">
        <button class="v-btn v-btn--primary" type="button" data-action="share-from-detail">${icon("share")}<span>Share this run</span></button>
        <button class="v-btn v-rd-copy" type="button" data-action="copy-run-link" title="Copy a direct link to this run">Copy link</button>
        <button class="v-btn" type="button" data-action="close-detail">Close</button>
      </footer>
    </article>`;
}

// ---------------------------------------------------------------------------
// Compare: two or three pages side by side
// ---------------------------------------------------------------------------

/** @param {ReadonlyArray<{ label: string, src: string|null, isShared?: boolean }>} relics */
function relicOrbs(relics) {
  return relics
    .map((relic) => `
      <li class="v-cmp-relic${relic.isShared ? " is-shared" : ""}" title="${esc(relic.label)}${relic.isShared ? " · in every selected run" : ""}">
        ${art(relic, "v-rd-fallback")}<span class="v-sr">${esc(relic.label)}${relic.isShared ? ", shared" : ""}</span>
      </li>`)
    .join("");
}

/** @param {ReadonlyArray<{ label: string, src: string|null, upgraded?: boolean }>} cards */
function cardThumbs(cards) {
  return cards
    .map((card) => `
      <li class="v-cmp-card${card.upgraded ? " is-upgraded" : ""}" title="${esc(card.label)}${card.upgraded ? " (upgraded)" : ""}">
        ${art(card, "v-rd-card-fallback")}<span class="v-sr">${esc(card.label)}${card.upgraded ? ", upgraded" : ""}</span>
      </li>`)
    .join("");
}

/** @param {CompareColumn} col */
function compareColumn(col) {
  const asc = ascText(col) ? `<span class="v-rd-asc">${esc(ascText(col))}</span>` : "";
  const stats = col.stats.map((stat) => `<div><dt>${esc(stat.label)}</dt><dd>${esc(stat.value)}</dd></div>`).join("");
  const more = col.relicTotal > col.relics.length ? ` <small>top ${col.relics.length} of ${col.relicTotal}</small>` : "";
  const relics = col.relics.length
    ? `<ul class="v-cmp-relics">${relicOrbs(col.relics)}</ul>`
    : '<p class="v-cmp-empty">No relics recorded.</p>';
  const cards = col.uniqueCards.length
    ? `<ul class="v-cmp-cards">${cardThumbs(col.uniqueCards)}</ul>`
    : '<p class="v-cmp-empty">No unique cards: this deck overlaps fully with the others.</p>';
  return `
    <article class="v-cmp-col" data-char="${esc(col.charKey)}" data-result="${col.result}">
      <header class="v-cmp-head">
        ${plate(col, "v-cmp-plate")}
        <div class="v-cmp-id">
          <h3 class="v-rd-name">${esc(col.charName)}${asc}</h3>
          ${col.date ? `<p class="v-rd-date">${esc(col.date)}</p>` : ""}
        </div>
        ${stamp(col.result, "v-cmp-stamp")}
      </header>
      <dl class="v-cmp-stats">${stats}</dl>
      <section class="v-cmp-sec"><h4>Relics${more}</h4>${relics}</section>
      <section class="v-cmp-sec"><h4>Unique cards${col.uniqueCards.length ? ` <small>top ${col.uniqueCards.length}</small>` : ""}</h4>${cards}</section>
      <p class="v-cmp-fate">${col.killedBy ? `Slain by <b>${esc(col.killedBy)}</b>` : col.result === "win" ? "Conquered the Spire" : col.result === "abandon" ? "Abandoned" : "Fell in the Spire"}</p>
    </article>`;
}

/** @param {CompareModel} model */
function sharedBlock(model) {
  const n = model.columns.length;
  if (!model.sharedRelics.length && !model.sharedCards.length) {
    return `<p class="v-cmp-none">No relic or card turns up in all ${n} runs: these are different builds.</p>`;
  }
  const relics = model.sharedRelics.length
    ? `<div class="v-cmp-shared-block"><h4>${plural(model.sharedRelicTotal, "relic")}</h4><ul class="v-cmp-relics">${relicOrbs(model.sharedRelics.map((r) => ({ ...r, isShared: true })))}</ul></div>`
    : "";
  const cards = model.sharedCards.length
    ? `<div class="v-cmp-shared-block"><h4>${plural(model.sharedCardTotal, "card")}</h4><ul class="v-cmp-cards">${cardThumbs(model.sharedCards)}</ul></div>`
    : "";
  return `
    <section class="v-cmp-shared">
      <header><h3>In all ${n} runs</h3><p>What every selected run had in common.</p></header>
      <div class="v-cmp-shared-grid">${relics}${cards}</div>
    </section>`;
}

/**
 * The body of the compare modal.
 * @param {CompareModel} model
 * @returns {string}
 */
export function compareHtml(model) {
  return `
    <div class="v-cmp" style="--cols:${model.columns.length}">
      <div class="v-cmp-grid">${model.columns.map(compareColumn).join("")}</div>
      ${sharedBlock(model)}
      <p class="v-cmp-foot">Press <kbd>Esc</kbd> to close · <kbd>c</kbd> toggles compare mode on Recent Runs.</p>
    </div>`;
}
