// First-visit notice for the new look.
//
// The new look is the default. Anyone who lands in it without having chosen
// it (no ?ui= link, no stored choice) sees this once per device: a small card
// beside the palette button saying what changed and how to get the classic
// look back. It never blocks the page, never takes focus, and is gone for good
// once answered.
//
// Where it points: the visible palette button (the rail's brand row on a
// laptop, the top bar on a phone, the panel toolbar in the desktop apps).
// When no palette button is on screen (a desktop-app tab with no toolbar) it
// sits at the bottom of the window instead and says where the button lives.

import { esc } from "./html.js?v=1";
import { reduced } from "./motion.js?v=2";

/** Set once the visitor has answered; never shown again on this device. */
const STORAGE_SEEN = "vault.web.ui.notice";
const NOTICE_ID = "v-look-notice";
/** Lets the first screen finish drawing before anything appears over it. */
const SHOW_DELAY_MS = 900;
/** Gap from the window's edges and from the palette button, in CSS px. */
const EDGE_PX = 12;
const GAP_PX = 12;
/** The tail never sits closer than this to the card's rounded corners. */
const TAIL_INSET_PX = 22;

/** @type {(name: string, params: Record<string, unknown>) => void} */
let track = () => {};
/** @type {HTMLElement|null} */
let notice = null;
/** @type {HTMLElement|null} */
let anchor = null;

/** @param {string} key */
function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode: the notice simply comes back next visit.
  }
}

/**
 * True when the visitor is on the new look only because it is the default.
 * The boot script in index.html records why it picked the layout.
 */
function landedByDefault() {
  return window.__VAULT_UI_SOURCE__ === "default";
}

/** The palette button the visitor can see right now, if any. */
function visiblePaletteButton() {
  const buttons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-action="v-theme-open"]')]);
  return (
    buttons.find((button) => {
      const box = button.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
    }) || null
  );
}

/** Points the card at the palette button, or parks it at the bottom. */
function place() {
  if (!notice) return;
  const next = visiblePaletteButton();
  if (anchor && anchor !== next) anchor.classList.remove("v-look-hint");
  anchor = next;
  notice.classList.toggle("is-docked", !anchor);
  if (!anchor) {
    notice.style.left = "";
    notice.style.top = "";
    notice.style.removeProperty("--tail-x");
    return;
  }
  anchor.classList.add("v-look-hint");
  const box = anchor.getBoundingClientRect();
  const width = notice.offsetWidth;
  const height = notice.offsetHeight;
  const centre = box.left + box.width / 2;
  const left = Math.max(EDGE_PX, Math.min(centre - TAIL_INSET_PX * 1.5, window.innerWidth - width - EDGE_PX));
  const below = box.bottom + GAP_PX;
  const fitsBelow = below + height <= window.innerHeight - EDGE_PX;
  const top = fitsBelow ? below : Math.max(EDGE_PX, box.top - height - GAP_PX);
  const tail = Math.max(TAIL_INSET_PX, Math.min(centre - left, width - TAIL_INSET_PX));
  notice.classList.toggle("is-above", !fitsBelow);
  notice.style.left = `${Math.round(left)}px`;
  notice.style.top = `${Math.round(top)}px`;
  notice.style.setProperty("--tail-x", `${Math.round(tail)}px`);
}

/**
 * @param {"keep"|"classic"|"dismiss"|"palette"} action  how it was answered
 */
function close(action) {
  if (!notice) return;
  writeStorage(STORAGE_SEEN, action);
  track("ui_notice_action", { action });
  if (anchor) anchor.classList.remove("v-look-hint");
  notice.remove();
  notice = null;
  anchor = null;
  window.removeEventListener("resize", place);
  window.removeEventListener("spirevault:tab", placeSoon);
  document.removeEventListener("keydown", handleKeydown);
  document.removeEventListener("click", handleClick, true);
}

function placeSoon() {
  // The tab's toolbar is drawn after the event: measure on the next frame.
  window.requestAnimationFrame(place);
}

/** @param {KeyboardEvent} event */
function handleKeydown(event) {
  if (event.key === "Escape") close("dismiss");
}

/**
 * Capture phase, so it runs before script.js switches the look and before
 * the theme engine opens its menu.
 * @param {MouseEvent} event
 */
function handleClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const answer = target.closest("[data-look-notice]");
  if (answer) {
    close(/** @type {"keep"|"classic"} */ (answer.getAttribute("data-look-notice")));
    return;
  }
  // Opening the palette menu shows the switch itself: the notice has done its job.
  if (target.closest('[data-action="v-theme-open"]')) close("palette");
}

function show() {
  if (notice || readStorage(STORAGE_SEEN)) return;
  notice = document.createElement("aside");
  notice.id = NOTICE_ID;
  notice.className = "v-look-notice";
  notice.setAttribute("role", "dialog");
  notice.setAttribute("aria-modal", "false");
  notice.setAttribute("aria-labelledby", `${NOTICE_ID}-title`);
  notice.setAttribute("aria-describedby", `${NOTICE_ID}-body`);
  if (reduced()) notice.classList.add("is-still");
  notice.innerHTML = `
    <span class="v-look-notice-tail" aria-hidden="true"></span>
    <h2 class="v-look-notice-title" id="${NOTICE_ID}-title">${esc("SpireVault has a new look")}</h2>
    <p class="v-look-notice-body" id="${NOTICE_ID}-body">
      ${esc("Everything is still here: your runs, stats and co-op.")}
      <span class="v-look-notice-here">${esc("Prefer the classic look? Switch any time with the palette button, here.")}</span>
      <span class="v-look-notice-there">${esc("Prefer the classic look? Switch any time with the palette button at the top of the Stats tabs.")}</span>
    </p>
    <div class="v-look-notice-actions">
      <button class="v-btn v-btn--primary" type="button" data-look-notice="keep">${esc("Keep the new look")}</button>
      <button class="v-btn" type="button" data-look-notice="classic" data-action="ui-set" data-ui="classic" data-source="look-notice">${esc("Switch to classic")}</button>
    </div>`;
  document.body.appendChild(notice);
  place();
  window.addEventListener("resize", place, { passive: true });
  window.addEventListener("spirevault:tab", placeSoon);
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("click", handleClick, true);
  track("ui_notice_shown", { anchored: anchor ? 1 : 0 });
}

/**
 * Shows the notice once, a moment after the first screen has drawn, to a
 * visitor who is on the new look by default and has not answered it before.
 * @param {{ track?: (name: string, params: Record<string, unknown>) => void }} [deps]
 */
export function initLookNotice(deps = {}) {
  if (typeof deps.track === "function") track = deps.track;
  if (!landedByDefault() || readStorage(STORAGE_SEEN)) return;
  window.setTimeout(show, SHOW_DELAY_MS);
}
