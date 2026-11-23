// The customizable Overview (new look). Eager part: the widget registry, the
// saved layout and the Arrange button. The editor (edit.js) and the widget
// gallery (gallery.js) load with a dynamic import the first time Arrange is
// pressed, so nobody downloads them just to read their stats.
//
// Arrange state lives on `.v-ov[data-arrange]`, never on <html>: a root class
// or attribute change makes lib/ui/stage.js re-fit every header.

import { CATALOG, cellHtml } from "./registry.js?v=3";
import { loadLayout, saveLayout } from "./store.js?v=3";
import { configure } from "./layout.js?v=1";

export { WIDGETS, CATALOG, DEFAULT_ENTRIES, defaultLayout, renderOverview, cellHtml } from "./registry.js?v=3";
export { loadLayout, saveLayout, STORAGE_KEY } from "./store.js?v=3";

/**
 * @typedef {Object} OverviewDeps  what script.js lends the editor
 * @property {() => import("./registry.js").OverviewContext} context  one render's data
 * @property {() => HTMLElement|null} body       #overview-body
 * @property {(root: Element) => void} afterRender  Motion.afterRender (no entrance replay)
 * @property {() => void} rerender               draws the Overview again, normally
 * @property {(message: string) => void} [toast]
 * @property {(name: string, params: Record<string, unknown>) => void} [track]
 */

/** @type {OverviewDeps|null} */
let deps = null;
let arranging = false;
let tourChecked = false;

/** Set once the tour is finished or skipped. */
const TOUR_KEY = "vault.web.overview.tour.v1";
/** Answered by lib/ui/look-notice.js; the tour waits until it is. */
const LOOK_NOTICE_KEY = "vault.web.ui.notice";
/** Lets the first screen settle (stage fit, entrance) before the tour dims it. */
const TOUR_DELAY_MS = 1200;
/** Boot can render the Overview while its panel is still hidden: look again. */
const TOUR_RETRY_MS = 600;
const TOUR_RETRIES = 10;
let tourRetries = 0;
let tourRetryTimer = 0;
/** While the look notice is up, look again this often for its answer. */
const NOTICE_RECHECK_MS = 1500;
let noticeTimer = 0;

/** @param {string} key @returns {string|null} */
function readKey(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return "blocked";
  }
}

/** True while the Overview is in Arrange mode; script.js holds re-renders until Done. */
export function isArranging() {
  return arranging;
}

/** @param {MouseEvent} event */
function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const setting = target.closest("[data-ov-set]");
  if (setting) {
    event.preventDefault();
    applyWidgetSetting(/** @type {HTMLElement} */ (setting));
    return;
  }
  if (!target.closest('[data-action="ov-arrange"]')) return;
  event.preventDefault();
  void openArrange();
}

/**
 * A chip inside a widget (the calendar's All / Solo / Co-op) changes that
 * widget's own setting: saved with the layout, redrawn in place.
 * @param {HTMLElement} chip  carries data-ov-set (the setting) and data-value
 */
function applyWidgetSetting(chip) {
  if (!deps || arranging) return;
  const cell = /** @type {HTMLElement|null} */ (chip.closest(".v-w[data-key]"));
  const name = chip.getAttribute("data-ov-set");
  if (!cell || !name) return;
  const key = cell.dataset.key || "";
  const layout = configure(loadLayout(), CATALOG, key, { [name]: chip.getAttribute("data-value") }, Date.now());
  saveLayout(layout);
  const item = layout.items.find((it) => it.key === key);
  if (!item) return;
  const html = cellHtml(item, deps.context(), 0);
  if (!html) return;
  cell.innerHTML = html;
  const again = cell.querySelector(`[data-ov-set="${name}"][aria-pressed="true"]`);
  if (again instanceof HTMLElement) again.focus({ preventScroll: true });
  if (deps.track) deps.track("overview_widget_setting", { widget: item.id, setting: name });
}

/**
 * Call once at boot.
 * @param {OverviewDeps} overviewDeps
 */
export function initOverview(overviewDeps) {
  if (deps) return;
  deps = overviewDeps;
  document.addEventListener("click", onClick);
}

/**
 * Enters Arrange mode on the Overview that is on screen.
 * @param {{ pickKey?: string }} [options]  start with this widget picked up (phone long-press)
 * @returns {Promise<void>}
 */
export async function openArrange(options = {}) {
  if (!deps || arranging) return;
  const lent = deps;
  arranging = true;
  try {
    const editor = await import("./edit.js?v=4");
    editor.enterArrange({
      ...lent,
      pickKey: options.pickKey,
      startTour: (fromStep) => void startTour(fromStep),
      onExit: () => {
        arranging = false;
        lent.rerender();
        // Focus goes back where the keyboard left from.
        const button = lent.body()?.querySelector('[data-action="ov-arrange"]');
        if (button instanceof HTMLElement) button.focus({ preventScroll: true });
      },
    });
    if (lent.track) lent.track("overview_arrange_open", {});
  } catch (error) {
    arranging = false;
    if (lent.toast) lent.toast("Couldn't open Arrange. Reload the page and try again.");
    throw error;
  }
}

/**
 * Shows the step-by-step tour once, the first time someone sees their
 * Overview: not on a ?ui= link (tests, shared links), not while the "new
 * look" notice still waits for an answer (it starts a moment after the notice
 * is answered), and never twice. Call after each Overview render.
 */
export function maybeStartTour() {
  if (tourChecked || arranging || !deps) return;
  if (window.__VAULT_UI_SOURCE__ === "link" || readKey(TOUR_KEY)) {
    tourChecked = true;
    return;
  }
  const noticePending = document.getElementById("v-look-notice")
    || (window.__VAULT_UI_SOURCE__ === "default" && !readKey(LOOK_NOTICE_KEY));
  if (noticePending) {
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(maybeStartTour, NOTICE_RECHECK_MS);
    return;
  }
  const body = deps.body();
  const button = body && body.querySelector('[data-action="ov-arrange"]');
  if (!(button instanceof HTMLElement) || button.getClientRects().length === 0) {
    window.clearTimeout(tourRetryTimer);
    if (tourRetries < TOUR_RETRIES) {
      tourRetries += 1;
      tourRetryTimer = window.setTimeout(maybeStartTour, TOUR_RETRY_MS);
    }
    return;
  }
  window.clearTimeout(tourRetryTimer);
  tourChecked = true;
  window.setTimeout(() => {
    // Boot may have drawn the Overview again since: find today's button.
    const current = deps && deps.body()?.querySelector('[data-action="ov-arrange"]');
    const ready = current instanceof HTMLElement && current.getClientRects().length > 0
      && !arranging && !document.querySelector("dialog[open]") && !document.getElementById("v-look-notice");
    if (ready) void startTour(0);
    else tourChecked = false;
  }, TOUR_DELAY_MS);
}

/**
 * Runs the tour (again, from Arrange's "Show me how").
 * @param {number} [fromStep]
 * @returns {Promise<void>}
 */
export async function startTour(fromStep = 0) {
  if (!deps) return;
  const lent = deps;
  const { runTour } = await import("./tour.js?v=2");
  runTour({
    fromStep,
    openArrange: () => openArrange(),
    isArranging,
    onClose: (how, step) => {
      try {
        window.localStorage.setItem(TOUR_KEY, how);
      } catch {
        /* storage blocked: it may show again next visit */
      }
      if (lent.track) lent.track("overview_tour_close", { how, step: step + 1 });
      const focus = isArranging()
        ? lent.body()?.querySelector('[data-arr="grip"]')
        : lent.body()?.querySelector('[data-action="ov-arrange"]');
      if (focus instanceof HTMLElement) focus.focus({ preventScroll: true });
    },
  });
  if (lent.track) lent.track("overview_tour_open", { from: fromStep + 1 });
}
