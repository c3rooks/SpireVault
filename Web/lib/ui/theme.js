// Theme engine: instant, user-selectable themes.
//
// A theme is one block of token values under `[data-theme="x"]` in
// styles/src/tokens/themes.css. Switching is a single attribute write on
// <html> — no reload, no re-render. SVG that uses `var(--v-…)` re-colours on
// its own; the only JS consumers are canvas helpers, whose cache is dropped
// here.
//
// The stored choice is applied before first paint by the inline boot script
// in index.html, so there is no flash. This module must agree with that
// script on the storage keys and the list of theme ids.

import { invalidateColorCache, isCharacterKey } from "./tokens.js?v=1";
import { esc } from "./html.js?v=1";
import { reduced } from "./motion.js?v=1";

const STORAGE_PREFERENCE = "vault.web.theme";
const STORAGE_RESOLVED = "vault.web.theme.resolved";
const DEFAULT_THEME = "inked";
const POPOVER_ID = "v-theme-pop";
const POPOVER_GAP_PX = 10;

/**
 * @typedef {Object} ThemeDef
 * @property {string} id
 * @property {string} label
 * @property {string} note
 */

/** @type {ReadonlyArray<ThemeDef>} */
export const THEMES = Object.freeze([
  { id: "inked", label: "Inked Codex", note: "The default" },
  { id: "vault", label: "Classic Vault", note: "Ember and gold" },
  { id: "auto", label: "Auto", note: "Your most-played hero" },
  { id: "ironclad", label: "Ironclad", note: "Crimson dusk" },
  { id: "silent", label: "Silent", note: "Emerald mist" },
  { id: "defect", label: "Defect", note: "Azure storm" },
  { id: "regent", label: "Regent", note: "Gilded hall" },
  { id: "necrobinder", label: "Necrobinder", note: "Violet grave" },
]);

const THEME_IDS = Object.freeze(THEMES.map((theme) => theme.id));

const PALETTE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A3.7 3.7 0 0 0 21 10.6C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/></svg>';

/** @type {{ preference: string, autoCharacter: string|null }} */
let state = Object.freeze({ preference: DEFAULT_THEME, autoCharacter: null });
/** @type {ReadonlyArray<(detail: { theme: string, preference: string }) => void>} */
let listeners = Object.freeze([]);
/** @type {(name: string, params: Record<string, unknown>) => void} */
let track = () => {};
/** The button that opened the popover, so focus can return to it. */
/** @type {HTMLElement|null} */
let pickerTrigger = null;
/** Viewport width when the popover opened (see handleResize). */
let pickerOpenedAtWidth = 0;

/** @param {string} key */
function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the theme still applies for this page.
  }
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isThemeId(id) {
  return THEME_IDS.includes(String(id));
}

/**
 * Maps a preference to the concrete theme painted on <html>.
 * @param {string} preference
 * @param {string|null} autoCharacter
 * @returns {string}
 */
function resolve(preference, autoCharacter) {
  if (preference !== "auto") return preference;
  // Only characters that have a theme of their own; a hero without one
  // (a new patch's character) gets the default.
  return autoCharacter && isCharacterKey(autoCharacter) && isThemeId(autoCharacter) ? autoCharacter : DEFAULT_THEME;
}

/** @returns {string} the user's choice; may be "auto" */
export function getThemePreference() {
  return state.preference;
}

/** @returns {string} the concrete theme currently painted */
export function getTheme() {
  return document.documentElement.dataset.theme || DEFAULT_THEME;
}

function syncMetaThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--v-bg-deep").trim();
  if (color) meta.setAttribute("content", color);
}

/** Keeps every picker on the page in step: checked state and roving tabindex. */
function syncPickers() {
  document.querySelectorAll("[data-theme-id]").forEach((button) => {
    const checked = /** @type {HTMLElement} */ (button).dataset.themeId === state.preference;
    button.setAttribute("aria-checked", String(checked));
    button.setAttribute("tabindex", checked ? "0" : "-1");
  });
}

/**
 * Paints a concrete theme. With an origin point and motion allowed, the new
 * theme wipes in as a circle from that point; otherwise it swaps instantly.
 * @param {string} resolved
 * @param {{ x: number, y: number }|null} origin
 */
function paint(resolved, origin) {
  const root = document.documentElement;
  if (root.dataset.theme === resolved) {
    syncPickers();
    return;
  }
  const swap = () => {
    root.dataset.theme = resolved;
    invalidateColorCache();
    syncMetaThemeColor();
    syncPickers();
  };
  writeStorage(STORAGE_RESOLVED, resolved);
  const canReveal = origin && typeof document.startViewTransition === "function" && !reduced();
  if (!canReveal) {
    swap();
    return;
  }
  root.style.setProperty("--v-reveal-x", `${Math.round(origin.x)}px`);
  root.style.setProperty("--v-reveal-y", `${Math.round(origin.y)}px`);
  document.startViewTransition(swap);
}

/**
 * Switches theme. Instant: no reload, no re-render.
 * @param {string} id  a theme id from THEMES (including "auto")
 * @param {{ origin?: { x: number, y: number }|null, source?: string }} [options]
 * @returns {boolean} false when the id is unknown
 */
export function setTheme(id, options = {}) {
  if (!isThemeId(id)) return false;
  const previous = state.preference;
  state = Object.freeze({ ...state, preference: id });
  writeStorage(STORAGE_PREFERENCE, id);
  const resolved = resolve(id, state.autoCharacter);
  paint(resolved, options.origin || null);
  if (previous !== id) {
    track("theme_change", { theme: id, resolved_theme: resolved, source: options.source || "picker" });
    try {
      window.dispatchEvent(new CustomEvent("spirevault:theme", { detail: { theme: resolved, preference: id } }));
    } catch {
      // CustomEvent unavailable — listeners below still fire.
    }
    listeners.forEach((listener) => listener({ theme: resolved, preference: id }));
  }
  return true;
}

/** Advances to the next theme in the list. Bound to the `T` key. */
export function cycleTheme() {
  const index = THEME_IDS.indexOf(state.preference);
  const next = THEME_IDS[(index + 1) % THEME_IDS.length];
  setTheme(next, { source: "shortcut" });
  return next;
}

/**
 * Tells the engine which character the player uses most, for the Auto theme.
 * @param {string|null} characterKey
 */
export function setAutoCharacter(characterKey) {
  const key = characterKey && isCharacterKey(characterKey) ? String(characterKey).toLowerCase() : null;
  if (key === state.autoCharacter) return;
  state = Object.freeze({ ...state, autoCharacter: key });
  if (state.preference === "auto") paint(resolve("auto", key), null);
}

/**
 * @param {(detail: { theme: string, preference: string }) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onThemeChange(listener) {
  listeners = Object.freeze([...listeners, listener]);
  return () => {
    listeners = Object.freeze(listeners.filter((entry) => entry !== listener));
  };
}

// ---------------------------------------------------------------------------
// Picker UI
// ---------------------------------------------------------------------------

/**
 * The swatch grid. Each preview carries its own data-theme, so it renders
 * from that theme's real tokens.
 * @returns {string}
 */
export function themeSwatchesHtml() {
  const auto = resolve("auto", state.autoCharacter);
  const swatches = THEMES.map((theme) => {
    const previewTheme = theme.id === "auto" ? auto : theme.id;
    return `
      <button class="v-theme" type="button" role="radio"
              aria-checked="${theme.id === state.preference}"
              tabindex="${theme.id === state.preference ? 0 : -1}"
              data-theme-id="${esc(theme.id)}">
        <span class="v-theme-prev" data-theme="${esc(previewTheme)}" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>${esc(theme.label)}</span>
        <small>${esc(theme.note)}</small>
      </button>`;
  }).join("");
  return `<div class="v-themes" role="radiogroup" aria-label="Theme">${swatches}</div>`;
}

/**
 * @param {{ restoreFocus?: boolean }} [options]  return focus to the trigger
 *   (keyboard dismissal); skip it when the user clicked somewhere else.
 */
export function closeThemePicker(options = {}) {
  const popover = document.getElementById(POPOVER_ID);
  if (!popover) return;
  const hadFocus = popover.contains(document.activeElement);
  popover.remove();
  document.querySelectorAll('[data-action="v-theme-open"]').forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  if ((options.restoreFocus || hadFocus) && pickerTrigger && pickerTrigger.isConnected) pickerTrigger.focus();
  pickerTrigger = null;
}

/**
 * Opens the picker as a popover anchored to a trigger button.
 * @param {Element} anchor
 */
export function openThemePicker(anchor) {
  closeThemePicker();
  const popover = document.createElement("div");
  popover.id = POPOVER_ID;
  popover.className = "v-theme-pop";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Choose a theme");
  popover.innerHTML = `
    <div class="v-theme-pop-head">
      <h3>Themes</h3>
      <span>Press <kbd>T</kbd> to cycle</span>
    </div>
    ${themeSwatchesHtml()}
    <div class="v-theme-foot">
      <span>Switches instantly. Saved on this device.</span>
      <button class="v-link" type="button" data-action="ui-set" data-ui="classic" data-source="theme-picker">Back to the classic look</button>
    </div>`;
  document.body.appendChild(popover);

  const anchorBox = anchor.getBoundingClientRect();
  // offsetWidth/Height, not getBoundingClientRect: the popover is mid-way
  // through its scale-in animation here, and a transformed box reads small —
  // which placed the picker partly off the right edge of a phone.
  const popWidth = popover.offsetWidth;
  const popHeight = popover.offsetHeight;
  const maxLeft = window.innerWidth - popWidth - POPOVER_GAP_PX;
  const left = Math.max(POPOVER_GAP_PX, Math.min(anchorBox.left, maxLeft));
  const below = anchorBox.bottom + POPOVER_GAP_PX;
  const fitsBelow = below + popHeight <= window.innerHeight - POPOVER_GAP_PX;
  const top = fitsBelow ? below : Math.max(POPOVER_GAP_PX, anchorBox.top - popHeight - POPOVER_GAP_PX);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  pickerTrigger = anchor instanceof HTMLElement ? anchor : null;
  pickerOpenedAtWidth = window.innerWidth;
  anchor.setAttribute("aria-expanded", "true");
  /** @type {HTMLElement|null} */ (popover.querySelector('[aria-checked="true"]'))?.focus();
}

/**
 * @param {string} extraClass
 * @returns {HTMLButtonElement}
 */
function createTriggerButton(extraClass) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `v-icon-btn v-theme-btn ${extraClass}`.trim();
  button.dataset.action = "v-theme-open";
  button.title = "Themes (T)";
  button.setAttribute("aria-label", "Choose a theme");
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = PALETTE_ICON;
  return button;
}

/**
 * Adds the theme trigger to the rail brand row and to each stats toolbar
 * (the toolbar copy is what the desktop shells show, where the rail is
 * hidden). Idempotent.
 */
export function mountThemeButtons() {
  const brand = document.querySelector(".sidebar-brand");
  if (brand && !brand.querySelector(".v-theme-btn")) brand.appendChild(createTriggerButton(""));
  document.querySelectorAll(".app-toolbar-right").forEach((toolbar) => {
    if (!toolbar.querySelector(".v-theme-btn")) toolbar.prepend(createTriggerButton("v-theme-btn--toolbar"));
  });
}

/** @param {MouseEvent} event */
function handleClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const swatch = target.closest("[data-theme-id]");
  if (swatch) {
    const id = /** @type {HTMLElement} */ (swatch).dataset.themeId || "";
    setTheme(id, { origin: { x: event.clientX, y: event.clientY }, source: "picker" });
    return;
  }
  const trigger = target.closest('[data-action="v-theme-open"]');
  if (trigger) {
    const isOpen = trigger.getAttribute("aria-expanded") === "true";
    if (isOpen) closeThemePicker();
    else openThemePicker(trigger);
    return;
  }
  if (!target.closest(`#${POPOVER_ID}`)) closeThemePicker();
}

/**
 * Radio-group keyboard model: arrows move and select (so arrowing through
 * the swatches previews each theme live), Home/End jump to the ends.
 * @param {KeyboardEvent} event
 * @returns {boolean} true when the key was handled
 */
function handleSwatchKeys(event) {
  const current = event.target instanceof Element ? event.target.closest("[data-theme-id]") : null;
  const group = current ? current.closest(".v-themes") : null;
  if (!current || !group) return false;
  const swatches = /** @type {HTMLElement[]} */ ([...group.querySelectorAll("[data-theme-id]")]);
  const index = swatches.indexOf(/** @type {HTMLElement} */ (current));
  const last = swatches.length - 1;
  const moves = {
    ArrowRight: index === last ? 0 : index + 1,
    ArrowDown: index === last ? 0 : index + 1,
    ArrowLeft: index === 0 ? last : index - 1,
    ArrowUp: index === 0 ? last : index - 1,
    Home: 0,
    End: last,
  };
  if (!(event.key in moves)) return false;
  const next = swatches[moves[event.key]];
  event.preventDefault();
  setTheme(next.dataset.themeId || "", { source: "picker" });
  next.focus();
  return true;
}

/** Phones resize the viewport when the URL bar hides; only a width change
 *  means the anchor has really moved. */
function handleResize() {
  if (window.innerWidth !== pickerOpenedAtWidth) closeThemePicker();
}

/** @param {KeyboardEvent} event */
function handleKeydown(event) {
  if (event.key === "Escape") {
    closeThemePicker({ restoreFocus: true });
    return;
  }
  if (handleSwatchKeys(event)) return;
  if (event.key !== "t" && event.key !== "T") return;
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  const active = document.activeElement;
  const typing =
    active instanceof HTMLElement &&
    (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  if (typing) return;
  cycleTheme();
}

/**
 * Starts the engine. Reads the stored preference (already painted by the
 * boot script), wires the picker, the `T` shortcut and cross-tab sync.
 * @param {{ track?: (name: string, params: Record<string, unknown>) => void }} [deps]
 */
export function initTheme(deps = {}) {
  if (typeof deps.track === "function") track = deps.track;
  const stored = readStorage(STORAGE_PREFERENCE);
  state = Object.freeze({ ...state, preference: isThemeId(stored) ? String(stored) : DEFAULT_THEME });
  syncMetaThemeColor();

  document.addEventListener("click", handleClick);
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("resize", handleResize, { passive: true });
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_PREFERENCE || !isThemeId(event.newValue)) return;
    state = Object.freeze({ ...state, preference: String(event.newValue) });
    paint(resolve(state.preference, state.autoCharacter), null);
  });
}
