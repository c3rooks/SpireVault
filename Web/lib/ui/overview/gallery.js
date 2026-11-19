// "Add a widget": the gallery sheet opened from Arrange mode (edit.js). A
// side sheet on wide screens, a bottom sheet on phones. Every tile shows a
// live preview drawn from the player's own climbs, one line on what it tells
// them, and either Add or "On your Overview" for a widget that cannot repeat.

import { esc } from "../html.js?v=1";
import { WIDGETS, cellHtml } from "./registry.js?v=2";

const CATEGORY_NAMES = Object.freeze({
  progress: "Progress",
  characters: "Characters",
  "cards-relics": "Cards & relics",
  paths: "Paths",
  coop: "Co-op",
  community: "Community",
  layout: "Layout",
});
/** Width each size is drawn at before the preview scales it down. */
const PREVIEW_WIDTH = Object.freeze({ S: 300, M: 420, L: 620, W: 1100 });
/** Space kept around a preview inside its frame. */
const PREVIEW_INSET = 10;
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';
const ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

/**
 * @param {import("./registry.js").Widget} widget
 * @param {import("./layout.js").Layout} layout
 * @param {import("./registry.js").OverviewContext} ctx
 */
function tileHtml(widget, layout, ctx) {
  const placed = layout.items.some((item) => item.id === widget.id);
  const blocked = placed && !widget.repeatable;
  const item = { key: `preview-${widget.id}`, id: widget.id, size: widget.defaultSize, settings: defaults(widget) };
  const drawn = cellHtml(item, ctx, 0);
  const empty = widget.emptyText || `Needs ${(widget.needs || "more climbs").toLowerCase()} to show anything.`;
  const action = blocked
    ? '<span class="v-gal-placed">On your Overview <span aria-hidden="true">✓</span></span>'
    : `<button class="v-btn v-btn--primary v-gal-add" type="button" data-gal-add="${esc(widget.id)}" aria-label="Add ${esc(widget.title)}">${placed ? "Add another" : "Add"}</button>`;
  return `
    <li class="v-gal-tile${blocked ? " is-placed" : ""}" data-category="${esc(widget.category)}" data-search="${esc(`${widget.title} ${widget.blurb}`.toLowerCase())}">
      <div class="v-gal-preview${widget.category === "layout" ? " is-short" : ""}" aria-hidden="true" inert>${drawn
        ? `<div class="v-gal-stage" data-size="${esc(widget.defaultSize)}" style="--pw:${widget.previewWidth || PREVIEW_WIDTH[widget.defaultSize] || 620}px">${drawn}</div>`
        : `<p class="v-gal-empty">${esc(empty)}</p>`}
      </div>
      <div class="v-gal-text">
        <h3>${esc(widget.title)}</h3>
        <p>${esc(widget.blurb)}</p>
      </div>
      <div class="v-gal-act">${action}</div>
    </li>`;
}

/** @param {import("./registry.js").Widget} widget */
function defaults(widget) {
  return Object.fromEntries(Object.entries(widget.settings || {}).map(([name, spec]) => [name, spec.default]));
}

/** Fits each preview's stage to its frame. @param {HTMLElement} sheet */
function fitPreviews(sheet) {
  sheet.querySelectorAll(".v-gal-preview").forEach((frame) => {
    const stage = /** @type {HTMLElement|null} */ (frame.querySelector(".v-gal-stage"));
    if (!stage) return;
    const natural = Number.parseFloat(stage.style.getPropertyValue("--pw")) || 620;
    // Whole widget in view: fit the frame's width and height, then center it.
    const room = frame.clientHeight - PREVIEW_INSET * 2;
    const scale = Math.min(1, (frame.clientWidth - PREVIEW_INSET * 2) / natural, room / Math.max(1, stage.offsetHeight));
    stage.style.setProperty("--scale", scale.toFixed(4));
    stage.style.setProperty("--top", `${Math.round((frame.clientHeight - stage.offsetHeight * scale) / 2)}px`);
  });
}

/**
 * @param {{
 *   layout: import("./layout.js").Layout,
 *   ctx: import("./registry.js").OverviewContext,
 *   onAdd: (id: string) => boolean,
 * }} options
 */
export function openGallery(options) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // New to this Overview first, then another copy of a placed one, layout
  // tools after those, and widgets already placed (that cannot repeat) last.
  const placed = (w) => options.layout.items.some((item) => item.id === w.id);
  const rank = (w) => (placed(w) && !w.repeatable ? 3 : w.category === "layout" ? 2 : placed(w) ? 1 : 0);
  const widgets = Object.values(WIDGETS)
    .map((w, index) => ({ w, index }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.index - b.index)
    .map(({ w }) => w);
  const categories = Object.keys(CATEGORY_NAMES).filter((key) => widgets.some((w) => w.category === key));
  const dialog = document.createElement("dialog");
  dialog.className = "v-gal";
  dialog.setAttribute("aria-labelledby", "v-gal-title");
  dialog.innerHTML = `
    <div class="v-gal-sheet">
      <header class="v-gal-head">
        <h2 id="v-gal-title">Add a widget</h2>
        <button class="v-icon-btn v-gal-close" type="button" data-gal-close aria-label="Close">${ICON_CLOSE}</button>
      </header>
      <label class="v-gal-search">${ICON_SEARCH}<span class="v-sr">Search widgets</span><input type="search" placeholder="Search widgets" autocomplete="off" data-gal-search></label>
      <div class="v-gal-cats" role="group" aria-label="Category">
        <button class="v-runs-chip" type="button" aria-pressed="true" data-gal-cat="">All</button>
        ${categories.map((key) => `<button class="v-runs-chip" type="button" aria-pressed="false" data-gal-cat="${esc(key)}">${esc(CATEGORY_NAMES[key])}</button>`).join("")}
      </div>
      <p class="v-gal-note">Previews use your own climbs.</p>
      <ul class="v-gal-list">${widgets.map((w) => tileHtml(w, options.layout, options.ctx)).join("")}</ul>
      <p class="v-gal-none" hidden>No widget matches that.</p>
    </div>`;
  document.body.appendChild(dialog);

  let category = "";
  const filter = () => {
    const query = /** @type {HTMLInputElement} */ (dialog.querySelector("[data-gal-search]")).value.trim().toLowerCase();
    let shown = 0;
    dialog.querySelectorAll(".v-gal-tile").forEach((tile) => {
      const el = /** @type {HTMLElement} */ (tile);
      const match = (!category || el.dataset.category === category) && (!query || (el.dataset.search || "").includes(query));
      el.hidden = !match;
      if (match) shown += 1;
    });
    /** @type {HTMLElement} */ (dialog.querySelector(".v-gal-none")).hidden = shown > 0;
    fitPreviews(dialog);
  };
  const close = () => {
    if (dialog.open) dialog.close();
  };
  const onResize = () => fitPreviews(dialog);

  dialog.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target === dialog || target.closest("[data-gal-close]")) {
      close();
      return;
    }
    const cat = target.closest("[data-gal-cat]");
    if (cat) {
      category = cat.getAttribute("data-gal-cat") || "";
      dialog.querySelectorAll("[data-gal-cat]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip === cat)));
      filter();
      return;
    }
    const add = target.closest("[data-gal-add]");
    if (add && options.onAdd(add.getAttribute("data-gal-add") || "")) close();
  });
  dialog.addEventListener("input", filter);
  dialog.addEventListener("close", () => {
    window.removeEventListener("resize", onResize);
    dialog.remove();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  });
  window.addEventListener("resize", onResize);
  dialog.showModal();
  fitPreviews(dialog);
  return dialog;
}
