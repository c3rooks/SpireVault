// Section filter controls for the new UI: a segmented track of toggle chips
// and a labelled native select. Used by Overview → By character
// (views.js) and the Ascensions tab (views-ascensions.js).
//
// Every control carries data-stat-filter="<section>.<key>"; script.js
// (wireStatFilters) owns the state and re-renders the tab. Pure functions,
// markup only. Styles: styles/src/components/filters.css.

import { esc } from "./html.js?v=1";

/**
 * @typedef {Object} SegOption
 * @property {string} value
 * @property {string} label
 * @property {boolean} pressed
 * @property {boolean} [disabled]
 * @property {string} [title]     tooltip; a disabled chip says why
 * @property {string} [charKey]   draws the climber's colour dot
 */

/**
 * @typedef {Object} SelectOption
 * @property {string} value
 * @property {string} label
 * @property {boolean} selected
 */

/** @param {string} filter @param {SegOption} option */
function chip(filter, option) {
  const char = option.charKey ? ` data-char="${esc(option.charKey)}"` : "";
  const dot = option.charKey ? '<i class="v-seg-dot" aria-hidden="true"></i>' : "";
  const title = option.title ? ` title="${esc(option.title)}"` : "";
  const disabled = option.disabled ? " disabled" : "";
  return `<button class="v-seg-chip" type="button" data-stat-filter="${esc(filter)}" data-value="${esc(option.value)}" aria-pressed="${option.pressed}"${char}${title}${disabled}>${dot}${esc(option.label)}</button>`;
}

/**
 * A captioned group of toggle chips, one of them pressed.
 * @param {string} filter   "chars.mode", "spire.character", …
 * @param {string} label    caption, also the group's accessible name
 * @param {ReadonlyArray<SegOption>} options
 * @returns {string}
 */
export function segmentedHtml(filter, label, options) {
  return `
    <div class="v-filter" role="group" aria-label="${esc(label)}">
      <span class="v-filter-label" aria-hidden="true">${esc(label)}</span>
      <div class="v-seg">${options.map((option) => chip(filter, option)).join("")}</div>
    </div>`;
}

/**
 * A captioned native select (a phone gets its own picker).
 * @param {string} filter
 * @param {string} label
 * @param {ReadonlyArray<SelectOption>} options
 * @param {{ disabled?: boolean, title?: string }} [state]
 * @returns {string}
 */
export function selectHtml(filter, label, options, state = {}) {
  const disabled = state.disabled ? " disabled" : "";
  const title = state.title ? ` title="${esc(state.title)}"` : "";
  const items = options
    .map((option) => `<option value="${esc(option.value)}"${option.selected ? " selected" : ""}>${esc(option.label)}</option>`)
    .join("");
  return `
    <label class="v-filter">
      <span class="v-filter-label">${esc(label)}</span>
      <span class="v-select"><select data-stat-filter="${esc(filter)}"${disabled}${title}>${items}</select></span>
    </label>`;
}

/**
 * "Showing <b>A10</b> · 12 of 162 runs  Clear" under a filtered section.
 * @param {string} filter      the section's clear key, e.g. "chars.clear"
 * @param {string} label       what is selected, plain text
 * @param {number} shown
 * @param {number|null} total  null leaves out "of N" (nothing to compare with)
 * @returns {string}
 */
export function summaryHtml(filter, label, shown, total) {
  const count = total === null ? `${shown} run${shown === 1 ? "" : "s"}` : `${shown} of ${total} runs`;
  return `
    <p class="v-filter-summary">
      <span>Showing <b>${esc(label)}</b> · ${count}</span>
      <button class="v-filter-clear" type="button" data-stat-filter="${esc(filter)}" data-value="">Clear</button>
    </p>`;
}
