// "Go by date": the mini calendar behind the Recent Runs Date chip (new look).
//
// One <dialog>, opened modal so focus stays inside and Esc closes it. On a
// wide screen it is a popover pinned under the chip; at phone widths (the
// same 880px line as the phone tab bar) the CSS turns it into a bottom sheet.
// Days with climbs carry a dot (green when a run that day was won), so the
// calendar also shows when you played.
//
// Picking applies at once (the ledger behind updates): one day selects that
// day, a second day makes a range from the first. Quick picks apply and close.
// Keyboard: the APG date-picker grid (arrows, Home/End, PageUp/PageDown,
// Shift+PageUp/PageDown for a year), Esc closes and focus returns to the chip.
//
// The calendar owns no filter state: script.js passes the current range, the
// per-day counts and callbacks, and does the filtering.
// Styles: styles/src/surfaces/runs-calendar.css.

import { esc } from "./html.js?v=1";
import { reduced } from "./motion.js?v=2";
import * as D from "../run-dates.js?v=1";

/** @typedef {import("../run-dates.js").DayRange} DayRange */

/**
 * @typedef {Object} CalendarOptions
 * @property {() => HTMLElement|null} getAnchor  the Date chip; looked up fresh because the ledger re-renders it
 * @property {DayRange|null} range
 * @property {string} today                      day key
 * @property {Map<string, { runs: number, wins: number }>} days   climbs per day, with the other filters applied
 * @property {string} [firstDay]                 earliest day with a climb (the month arrows stop there)
 * @property {string} [lastDay]                  latest day with a climb (where the calendar opens without a range)
 * @property {(range: DayRange|null) => number} count   runs a range would show
 * @property {(range: DayRange|null) => void} onChange
 * @property {(changed: boolean) => void} [onClose]
 * @property {boolean} [fromKeyboard]            focus a day rather than the title
 */

const DIALOG_ID = "v-rcal";
const SHEET_QUERY = "(max-width: 880px)";
const CLOSE_MS = 180;
const EDGE = 16;
const GAP = 8;

/** A quick pick's tooltip when it would show nothing. */
const EMPTY_PICK = Object.freeze({ today: "No runs today", week: "No runs in the last 7 days", month: "No runs this month" });

const ICONS = Object.freeze({
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
});

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/**
 * @typedef {Object} CalendarState
 * @property {CalendarOptions} opts
 * @property {DayRange|null} range
 * @property {string|null} pending   first day of a range still waiting for its second
 * @property {string} view           any day of the month on screen
 * @property {string} focus          the day that holds the grid's tab stop
 * @property {boolean} changed
 * @property {number} firstDow
 */

/** @type {CalendarState|null} */
let state = null;
/** @type {HTMLDialogElement|null} */
let dialog = null;
let closeTimer = 0;
let frame = 0;

/** @param {Partial<CalendarState>} patch */
function setState(patch) {
  if (state) state = { ...state, ...patch };
}

const isSheet = () => window.matchMedia(SHEET_QUERY).matches;
const plural = (n, noun) => `${n} ${n === 1 ? noun : `${noun}s`}`;

/** The month arrows stop at the first month with a climb and at this month. */
function monthBounds() {
  if (!state) return { min: "", max: "" };
  const { today, firstDay } = state.opts;
  const first = firstDay && firstDay < today ? firstDay : today;
  return { min: D.monthKey(first), max: D.monthKey(today) };
}

/** Days the arrow keys may reach: the 1st of the first month through today. */
function clampDay(key) {
  if (!state) return key;
  const { min } = monthBounds();
  const lo = `${min}-01`;
  const hi = state.opts.today;
  return key < lo ? lo : key > hi ? hi : key;
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function quickPicksHtml() {
  if (!state) return "";
  const { today, count } = state.opts;
  return D.DATE_PRESETS.map((p) => {
    const range = D.presetRange(p.id, today);
    const n = count(range);
    const pressed = !!state?.range && state.range.preset === p.id && D.sameRange(state.range, range);
    const off = n === 0 ? ` disabled title="${esc(EMPTY_PICK[p.id] || "No runs")}"` : "";
    return `<button class="v-rcal-pick" type="button" data-rcal-preset="${esc(p.id)}" aria-pressed="${pressed}"${off}>
      ${esc(p.label)}<span class="v-rcal-pick-n" aria-label="${esc(plural(n, "run"))}">${n}</span></button>`;
  }).join("");
}

function monthHeadHtml() {
  if (!state) return "";
  const { min, max } = monthBounds();
  const month = D.monthKey(state.view);
  const prev = D.addMonths(state.view, -1);
  const next = D.addMonths(state.view, 1);
  let climbs = 0;
  for (const [key, v] of state.opts.days) if (D.monthKey(key) === month) climbs += v.runs;
  return `
    <button class="v-rcal-nav" type="button" data-rcal-step="-1" aria-label="Previous month, ${esc(D.monthLabel(prev))}"${month <= min ? " disabled" : ""}>${icon("prev")}</button>
    <h3 class="v-rcal-month-label" id="v-rcal-month" aria-live="polite">
      <span>${esc(D.monthLabel(state.view))}</span>
      <small>${climbs ? esc(plural(climbs, "climb")) : "No climbs"}</small>
    </h3>
    <button class="v-rcal-nav" type="button" data-rcal-step="1" aria-label="Next month, ${esc(D.monthLabel(next))}"${month >= max ? " disabled" : ""}>${icon("next")}</button>`;
}

/** @param {string} key */
function dayCellHtml(key) {
  if (!state) return "";
  const { today, days } = state.opts;
  const { range, pending, focus } = state;
  const info = days.get(key);
  const isFuture = key > today;
  const isEnd = !!range && (key === range.from || key === range.to);
  const isIn = D.inRange(key, range);
  const classes = [
    "v-rcal-day",
    isIn ? "is-in" : "",
    range && key === range.from ? "is-from" : "",
    range && key === range.to ? "is-to" : "",
    key === pending ? "is-pending" : "",
  ].filter(Boolean).join(" ");
  const tally = info
    ? `${plural(info.runs, "climb")}${info.wins ? `, ${plural(info.wins, "win")}` : ""}`
    : "no climbs";
  const label = `${D.dayLongLabel(key)}${key === today ? ", today" : ""}, ${tally}`;
  const dot = info ? `<i class="v-rcal-dot${info.wins ? " is-win" : ""}" aria-hidden="true"></i>` : "";
  return `<td class="${classes}" aria-selected="${isEnd || isIn}">
    <button type="button" data-rcal-day="${key}" tabindex="${key === focus ? 0 : -1}" aria-label="${esc(label)}"
      ${key === today ? ' aria-current="date"' : ""}${isFuture ? " disabled" : ""}>${Number(key.slice(8))}${dot}</button></td>`;
}

function gridHtml() {
  if (!state) return "";
  const d = D.parseDayKey(state.view);
  if (!d) return "";
  const weeks = D.monthGrid(d.getFullYear(), d.getMonth(), state.firstDow);
  const names = D.weekdayNames(state.firstDow);
  const head = names.map((n) => `<th scope="col" abbr="${esc(n.long)}"><span aria-hidden="true">${esc(n.short)}</span><span class="v-sr">${esc(n.long)}</span></th>`).join("");
  const body = weeks.map((week) => `<tr>${week.map((day) => (day.inMonth
    ? dayCellHtml(day.key)
    : `<td class="v-rcal-day is-out" aria-hidden="true"><span>${Number(day.key.slice(8))}</span></td>`)).join("")}</tr>`).join("");
  return `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
}

function statusHtml() {
  if (!state) return "";
  const { range, pending } = state;
  const { today, count } = state.opts;
  // One span: the status is a flex box (to centre it), and loose text
  // beside a <b> would become separate items and lose the spaces between.
  if (!range) return "<span>Pick a day or a range.</span>";
  const n = count(range);
  const what = `<b>${esc(D.formatRange(range, today))}</b> · ${esc(plural(n, "run"))}`;
  return `<span>${what}${pending ? '<span class="v-rcal-hint"> · now pick the last day</span>' : ""}</span>`;
}

function shellHtml() {
  return `
    <div class="v-rcal-scrim" data-rcal-close></div>
    <div class="v-rcal-panel">
      <header class="v-rcal-head">
        <h2 class="v-rcal-title" id="v-rcal-title" tabindex="-1">Go by date</h2>
        <button class="v-rcal-x" type="button" data-rcal-close aria-label="Close the calendar">${icon("close")}</button>
      </header>
      <div class="v-rcal-quick" role="group" aria-label="Quick picks" data-rcal-part="quick"></div>
      <div class="v-rcal-month" data-rcal-part="month"></div>
      <table class="v-rcal-grid" role="grid" data-rcal-part="grid"></table>
      <p class="v-rcal-legend" aria-hidden="true">
        <span><i class="v-rcal-dot"></i>Climbed</span><span><i class="v-rcal-dot is-win"></i>Won a run</span>
      </p>
      <footer class="v-rcal-foot">
        <p class="v-rcal-status" aria-live="polite" data-rcal-part="status"></p>
        <div class="v-rcal-actions">
          <button class="v-btn v-rcal-clear" type="button" data-rcal-clear>Clear</button>
          <button class="v-btn v-btn--paper v-rcal-done" type="button" data-rcal-done>Done</button>
        </div>
      </footer>
    </div>`;
}

// ---------------------------------------------------------------------------
// Rendering and placement
// ---------------------------------------------------------------------------

/** What each part last drew, so an unchanged part (the month heading, a
 *  live region) is not redrawn and re-announced on every pick. */
const drawn = new Map();

/** @param {string} part @param {string} html */
function fill(part, html) {
  const el = dialog?.querySelector(`[data-rcal-part="${part}"]`);
  if (!el || drawn.get(part) === html) return;
  el.innerHTML = html;
  drawn.set(part, html);
}

function render() {
  if (!dialog || !state) return;
  fill("quick", quickPicksHtml());
  fill("month", monthHeadHtml());
  fill("grid", gridHtml());
  fill("status", statusHtml());
  // The grid is named by its month alone; the heading also says the climbs.
  dialog.querySelector(".v-rcal-grid")?.setAttribute("aria-label", D.monthLabel(state.view));
  const clear = /** @type {HTMLButtonElement|null} */ (dialog.querySelector("[data-rcal-clear]"));
  if (clear) clear.disabled = !state.range;
}

/** @param {string} key */
function focusDay(key) {
  const btn = dialog?.querySelector(`[data-rcal-day="${key}"]`);
  if (btn instanceof HTMLElement) btn.focus({ preventScroll: true });
}

/** Pins the popover under the chip (above it when there is no room below). */
function place() {
  if (!dialog || !state) return;
  const panel = /** @type {HTMLElement|null} */ (dialog.querySelector(".v-rcal-panel"));
  if (!panel) return;
  const sheet = isSheet();
  dialog.dataset.mode = sheet ? "sheet" : "popover";
  const anchor = state.opts.getAnchor();
  if (anchor) anchor.setAttribute("aria-expanded", "true");
  if (sheet || !anchor) {
    panel.style.removeProperty("top");
    panel.style.removeProperty("left");
    return;
  }
  const a = anchor.getBoundingClientRect();
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(EDGE, a.left), vw - w - EDGE);
  const below = a.bottom + GAP;
  const above = a.top - GAP - h;
  const top = below + h <= vh - EDGE ? below : above >= EDGE ? above : Math.max(EDGE, vh - h - EDGE);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.dataset.side = top === below ? "below" : "above";
}

function schedulePlace() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(place);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** @param {DayRange|null} range @param {string|null} pending */
function apply(range, pending) {
  if (!state) return;
  setState({ range, pending, changed: true });
  state.opts.onChange(range);
  render();
  schedulePlace();
}

/** @param {string} key */
function pickDay(key) {
  if (!state || key > state.opts.today) return;
  const { pending } = state;
  setState({ focus: key });
  if (pending && pending !== key) apply(D.normalizeRange(pending, key), null);
  else if (pending === key) apply({ from: key, to: key }, null);
  else apply({ from: key, to: key }, key);
  focusDay(key);
}

/** @param {string} key  move the grid's tab stop, turning the month if needed */
function moveFocus(key) {
  if (!state) return;
  const target = clampDay(key);
  const turned = D.monthKey(target) !== D.monthKey(state.view);
  setState({ focus: target, view: turned ? target : state.view });
  if (turned) render();
  else {
    dialog?.querySelectorAll("[data-rcal-day]").forEach((b) => b.setAttribute("tabindex", b.getAttribute("data-rcal-day") === target ? "0" : "-1"));
  }
  focusDay(target);
  paintPreview(target);
}

/** @param {number} step  months */
function turnMonth(step) {
  if (!state) return;
  const { min, max } = monthBounds();
  const view = D.addMonths(state.view, step);
  const month = D.monthKey(view);
  if (month < min || month > max) return;
  // The tab stop follows to the same day of the new month (clamped to today).
  setState({ view, focus: clampDay(D.addMonths(state.focus, step)) });
  render();
}

/** While a range waits for its second day, shade the days it would cover. */
function paintPreview(key) {
  if (!dialog || !state) return;
  const { pending } = state;
  dialog.querySelectorAll(".v-rcal-day.is-preview").forEach((td) => td.classList.remove("is-preview"));
  if (!pending || !key || key === pending) return;
  const span = D.normalizeRange(pending, key);
  dialog.querySelectorAll("[data-rcal-day]").forEach((b) => {
    const k = b.getAttribute("data-rcal-day") || "";
    if (D.inRange(k, span)) b.parentElement?.classList.add("is-preview");
  });
}

/** @param {KeyboardEvent} event */
function onGridKey(event) {
  if (!state) return;
  const btn = event.target instanceof Element ? event.target.closest("[data-rcal-day]") : null;
  if (!btn) return;
  const key = btn.getAttribute("data-rcal-day") || "";
  const d = D.parseDayKey(key);
  if (!d) return;
  const dow = (d.getDay() - state.firstDow + 7) % 7;
  /** @type {Record<string, () => string>} */
  const moves = {
    ArrowLeft: () => D.addDays(key, -1),
    ArrowRight: () => D.addDays(key, 1),
    ArrowUp: () => D.addDays(key, -7),
    ArrowDown: () => D.addDays(key, 7),
    Home: () => D.addDays(key, -dow),
    End: () => D.addDays(key, 6 - dow),
    PageUp: () => D.addMonths(key, event.shiftKey ? -12 : -1),
    PageDown: () => D.addMonths(key, event.shiftKey ? 12 : 1),
  };
  const move = moves[event.key];
  if (!move) return;
  event.preventDefault();
  moveFocus(move());
}

/** @param {MouseEvent} event */
function onClick(event) {
  if (!state) return;
  const target = event.target instanceof Element ? event.target : null;
  // A click on the dialog itself is a click outside the panel.
  if (!target || target === dialog || target.closest("[data-rcal-close]")) {
    closeRunsCalendar();
    return;
  }
  const day = target.closest("[data-rcal-day]");
  if (day) {
    pickDay(day.getAttribute("data-rcal-day") || "");
    return;
  }
  const preset = target.closest("[data-rcal-preset]");
  if (preset) {
    const range = D.presetRange(preset.getAttribute("data-rcal-preset") || "", state.opts.today);
    if (range) {
      apply(range, null);
      closeRunsCalendar();
    }
    return;
  }
  const step = target.closest("[data-rcal-step]");
  if (step) {
    const dir = step.getAttribute("data-rcal-step") || "";
    turnMonth(Number(dir));
    // The heading was redrawn: stay on the same arrow, or on the grid once
    // the arrow has reached the last month it can turn to.
    const again = dialog?.querySelector(`[data-rcal-step="${dir}"]`);
    if (again instanceof HTMLButtonElement && !again.disabled) again.focus({ preventScroll: true });
    else if (state) focusDay(state.focus);
    return;
  }
  if (target.closest("[data-rcal-clear]")) {
    apply(null, null);
    /** @type {HTMLElement|null} */ (dialog?.querySelector(".v-rcal-title") ?? null)?.focus({ preventScroll: true });
    return;
  }
  if (target.closest("[data-rcal-done]")) closeRunsCalendar();
}

/** @param {Event} event */
function onPointerOver(event) {
  const btn = event.target instanceof Element ? event.target.closest("[data-rcal-day]") : null;
  if (btn) paintPreview(btn.getAttribute("data-rcal-day") || "");
}

function ensureDialog() {
  if (dialog && dialog.isConnected) return dialog;
  const el = /** @type {HTMLDialogElement} */ (document.createElement("dialog"));
  el.id = DIALOG_ID;
  el.className = "v-rcal";
  el.setAttribute("aria-labelledby", "v-rcal-title");
  el.innerHTML = shellHtml();
  drawn.clear();
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", onGridKey);
  el.addEventListener("pointerover", onPointerOver);
  // Esc: animate out rather than vanish; `close` still tidies up if the
  // browser will not let the cancel be prevented.
  el.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeRunsCalendar();
  });
  // A native close (an Esc the browser would not let us delay) still tidies
  // up; one arriving after a quick reopen must leave the new calendar alone.
  el.addEventListener("close", () => {
    if (!el.open) afterClose();
  });
  document.body.append(el);
  dialog = el;
  return el;
}

function afterClose() {
  window.clearTimeout(closeTimer);
  cancelAnimationFrame(frame);
  window.removeEventListener("resize", schedulePlace);
  document.documentElement.classList.remove("v-rcal-lock", "v-rcal-gutter");
  if (!state) return;
  const { opts, changed } = state;
  state = null;
  dialog?.removeAttribute("data-closing");
  const anchor = opts.getAnchor();
  if (anchor) {
    anchor.setAttribute("aria-expanded", "false");
    anchor.focus({ preventScroll: true });
  }
  opts.onClose?.(changed);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Closes at once and tidies up; safe to call twice. */
function closeNow() {
  window.clearTimeout(closeTimer);
  if (dialog?.open) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
  afterClose();
}

/** @param {CalendarOptions} opts */
export function openRunsCalendar(opts) {
  if (state) {
    // Still animating out: finish that, then open afresh.
    if (!dialog?.hasAttribute("data-closing")) return;
    closeNow();
  }
  const el = ensureDialog();
  window.clearTimeout(closeTimer);
  el.removeAttribute("data-closing");
  const range = D.sanitizeRange(opts.range);
  const start = range?.to || (opts.lastDay && opts.lastDay <= opts.today ? opts.lastDay : opts.today);
  state = {
    opts,
    range,
    pending: null,
    view: start,
    focus: start,
    changed: false,
    firstDow: D.weekStartFor(),
  };
  render();
  // Lock the page behind. Keep a classic scrollbar's room so nothing shifts;
  // with overlay scrollbars there is no room to keep (reserving one anyway
  // would narrow the page by 15px while the calendar is open).
  const root = document.documentElement;
  const hasScrollbar = window.innerWidth - root.clientWidth > 0;
  root.classList.add("v-rcal-lock");
  if (hasScrollbar) root.classList.add("v-rcal-gutter");
  if (typeof el.showModal === "function") el.showModal();
  else el.setAttribute("open", "");
  place();
  window.addEventListener("resize", schedulePlace);
  // From the keyboard, land on a day ready for the arrows; from a tap, on the
  // title, so no day looks picked that was not.
  if (opts.fromKeyboard) focusDay(start);
  else /** @type {HTMLElement|null} */ (el.querySelector(".v-rcal-title"))?.focus({ preventScroll: true });
}

/** @param {{ instant?: boolean }} [options] */
export function closeRunsCalendar(options = {}) {
  if (!dialog || !state) return;
  if (options.instant || reduced()) {
    closeNow();
    return;
  }
  dialog.setAttribute("data-closing", "");
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closeNow, CLOSE_MS);
}

/** @returns {boolean} */
export function isRunsCalendarOpen() {
  return !!state;
}
