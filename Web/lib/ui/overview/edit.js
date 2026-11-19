// Arrange mode for the Overview (new look). Loaded on demand by index.js.
//
// The body is drawn once in arrange form (every widget live but inert under
// its tools); after that, moves, resizes and removals change the DOM in place
// and never re-render it, so nothing replays its entrance or count-up
// (motion.js). Every change goes through layout.js and is saved at once.
//
// Moving: drag a widget by its grip (mouse at once, touch after a 250ms
// press), or focus the grip and use Space, the arrow keys, Space; Escape puts
// it back. Neighbours slide out of the way (FLIP, transforms only). Reduced
// motion: moves are instant.

import { esc } from "../html.js?v=1";
import { overviewHtml } from "../views.js?v=9";
import * as Layout from "./layout.js?v=1";
import { WIDGETS, CATALOG, DEFAULT_ENTRIES, cellHtml } from "./registry.js?v=2";
import { loadLayout, saveLayout } from "./store.js?v=2";

const LONG_PRESS_MS = 250;
const DRAG_START_PX = 4;
const TOUCH_SLOP_PX = 8;
const SCROLL_EDGE_PX = 72;
const SCROLL_MAX_STEP = 18;
const FLIP_MS = 220;
const UNDO_MS = 6000;

const SIZE_NAMES = Object.freeze({ S: "Small, a quarter row", M: "Medium, a third of a row", L: "Large, half a row", W: "Wide, the full row" });

const ICON_GRIP = '<svg viewBox="0 0 12 20" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="4" r="1.9"/><circle cx="9" cy="4" r="1.9"/><circle cx="3" cy="10" r="1.9"/><circle cx="9" cy="10" r="1.9"/><circle cx="3" cy="16" r="1.9"/><circle cx="9" cy="16" r="1.9"/></g></svg>';
const ICON_GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.3 2h3.4l.5 2.6c.6.2 1.2.5 1.7.9l2.5-.9 1.7 2.9-2 1.8c.1.6.1 1.2 0 1.8l2 1.8-1.7 2.9-2.5-.9c-.5.4-1.1.7-1.7.9l-.5 2.6h-3.4l-.5-2.6c-.6-.2-1.2-.5-1.7-.9l-2.5.9-1.7-2.9 2-1.8a5.4 5.4 0 0 1 0-1.8l-2-1.8 1.7-2.9 2.5.9c.5-.4 1.1-.7 1.7-.9zM12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z" transform="translate(0 1)"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';

/** @returns {boolean} */
function reducedMotion() {
  try {
    if (document.documentElement.classList.contains("prefer-reduced-motion")) return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * What the title row says: the widget's name, and its settings as a chip
 * ("Stat tile · Hours played").
 * @param {import("./layout.js").LayoutItem} item
 */
function settingsSummary(item) {
  const widget = WIDGETS[item.id];
  const labels = widget.settingLabels || {};
  return Object.keys(widget.settings || {})
    .filter((name) => name !== widget.nameSetting)
    .map((name) => {
      const value = item.settings[name];
      if (!value) return "";
      const options = labels[name] && labels[name].options;
      return options ? options[value] || value : value;
    })
    .filter(Boolean)
    .join(" · ");
}

/**
 * The name Arrange gives a placed widget: its chosen stat for a stat tile
 * ("Hours played"), else its title.
 * @param {import("./layout.js").LayoutItem} item
 */
function displayName(item) {
  const widget = WIDGETS[item.id];
  const setting = widget.nameSetting;
  const options = setting && widget.settingLabels && widget.settingLabels[setting] && widget.settingLabels[setting].options;
  return (options && options[item.settings[setting]]) || widget.title;
}

/**
 * @param {import("./layout.js").LayoutItem} item
 * @param {number} index
 * @param {number} count
 */
function toolsHtml(item, index, count) {
  const widget = WIDGETS[item.id];
  const name = displayName(item);
  const summary = settingsSummary(item);
  const sizes = widget.sizes.length > 1
    ? `<div class="v-w-sizes" role="radiogroup" aria-label="Size of ${esc(widget.title)}">${widget.sizes
        .map((size) => `<button class="v-w-size" type="button" role="radio" aria-checked="${size === item.size}" data-arr="size" data-size="${size}" title="${esc(SIZE_NAMES[size])}" aria-label="${esc(SIZE_NAMES[size])}">${size}</button>`)
        .join("")}</div>`
    : "";
  const gear = widget.settings
    ? `<button class="v-w-icon" type="button" data-arr="gear" aria-expanded="false" aria-label="Settings for ${esc(widget.title)}" title="Settings">${ICON_GEAR}</button>`
    : "";
  return `
        <div class="v-w-tools">
          <button class="v-w-grip" type="button" data-arr="grip" aria-roledescription="movable widget" aria-describedby="v-arr-help"
                  aria-label="${esc(name)}, ${index + 1} of ${count}">${ICON_GRIP}<span class="v-w-name">${esc(name)}</span>${summary ? `<span class="v-w-filter">${esc(summary)}</span>` : ""}</button>
          ${sizes}${gear}
          <button class="v-w-icon v-w-remove" type="button" data-arr="remove" aria-label="Remove ${esc(widget.title)}" title="Remove">${ICON_CLOSE}</button>
        </div>`;
}

/** @param {string} id */
function needsHtml(id) {
  const widget = WIDGETS[id];
  const text = widget.emptyText || (widget.needs ? `Needs ${widget.needs.toLowerCase()} to show anything.` : "Nothing to show yet.");
  return `<section class="v-panel v-widget-empty"><p class="v-eyebrow">${esc(widget.title)}</p><p class="v-widget-needs">${esc(text)}</p></section>`;
}

/**
 * @param {import("./layout.js").Layout} layout
 * @param {import("./registry.js").OverviewContext} ctx
 */
function arrangeCells(layout, ctx) {
  const plan = Layout.columnPlan(layout.items, CATALOG);
  return layout.items.map((item, index) => ({
    key: esc(item.key),
    id: item.id,
    size: item.size,
    span: plan[index].span,
    pair: plan[index].pair,
    html: cellHtml(item, ctx, 0) || needsHtml(item.id),
    tools: toolsHtml(item, index, layout.items.length),
  }));
}

const BAR_HTML = `
      <div class="v-ov-bar v-arr-head">
        <span class="v-arr-badge">Arranging</span>
        <p class="v-arr-hint" id="v-arr-help">Drag a widget by its grip to move it, or focus the grip and use Space and the arrow keys. Pick a size, or remove what you don't need.</p>
        <button class="v-btn v-arr-tour" type="button" data-arr="tour">Show me how</button>
        <p class="v-sr" aria-live="assertive" data-arr="live"></p>
      </div>`;

const ICON_RESET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4.2h4.2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The sticky foot: actions on the left, Done on the right, the saved line under them. */
const FOOT_HTML = `
      <div class="v-arr-foot" role="toolbar" aria-label="Arrange your Overview">
        <div class="v-arr-toast" data-arr="toast" hidden></div>
        <div class="v-arr-panel">
          <div class="v-arr-actions" data-arr="actions">
            <div class="v-arr-group">
              <button class="v-btn v-btn--paper" type="button" data-arr="add" aria-label="Add widget">${ICON_PLUS}<span>Add<span class="v-arr-more"> widget</span></span></button>
              <button class="v-btn" type="button" data-arr="reset" title="Put back the default Overview">${ICON_RESET}<span>Reset</span></button>
              <button class="v-btn v-arr-clear" type="button" data-arr="clear" title="Take every widget off" aria-label="Clear all">${ICON_CLEAR}<span>Clear<span class="v-arr-more"> all</span></span></button>
            </div>
            <button class="v-btn v-btn--primary v-arr-done" type="button" data-arr="done">Done</button>
          </div>
          <div class="v-arr-actions" data-arr="confirm" hidden>
            <span class="v-arr-ask">Put back the default Overview?</span>
            <div class="v-arr-group">
              <button class="v-btn" type="button" data-arr="reset-no">Keep mine</button>
              <button class="v-btn v-btn--primary" type="button" data-arr="reset-yes">Reset</button>
            </div>
          </div>
          <p class="v-arr-saved" data-arr="saved">Saved on this device</p>
        </div>
      </div>`;

/**
 * @param {import("./index.js").OverviewDeps & { onExit: () => void, pickKey?: string, startTour?: (fromStep: number) => void }} deps
 */
export function enterArrange(deps) {
  const body = deps.body();
  if (!body) {
    deps.onExit();
    return;
  }
  let layout = loadLayout();
  const ctx = deps.context();
  /** @type {AbortController} */
  const live = new AbortController();
  /** @type {{ layout: import("./layout.js").Layout, label: string } | null} */
  let undo = null;
  let undoTimer = 0;
  /** @type {null | ReturnType<typeof beginKeyboardPick>} */
  let picked = null;

  const root = () => /** @type {HTMLElement|null} */ (body.querySelector(".v-ov[data-arrange]"));
  const grid = () => /** @type {HTMLElement|null} */ (body.querySelector(".v-ov[data-arrange] .v-ov-grid"));
  const cells = () => /** @type {HTMLElement[]} */ ([...body.querySelectorAll(".v-ov[data-arrange] .v-ov-grid > .v-w")]);
  const cellFor = (key) => cells().find((cell) => cell.dataset.key === key) || null;

  function draw() {
    body.innerHTML = overviewHtml(arrangeCells(layout, ctx), { arrange: true, barHtml: BAR_HTML, footHtml: FOOT_HTML });
    deps.afterRender(body);
  }

  /** @param {string} message */
  function announce(message) {
    const region = body.querySelector('[data-arr="live"]');
    if (region) region.textContent = message;
  }

  /** @param {import("./layout.js").Layout} next */
  function commit(next) {
    if (next === layout) return false;
    layout = next;
    const ok = saveLayout(layout);
    const saved = body.querySelector('[data-arr="saved"]');
    if (saved) {
      saved.textContent = ok ? "Saved on this device" : "This browser won't keep it";
      saved.classList.toggle("is-trouble", !ok);
    }
    return true;
  }

  /** Spans, pairs, sizes and positions follow the layout after any change. */
  function applyPlan() {
    const plan = Layout.columnPlan(layout.items, CATALOG);
    layout.items.forEach((item, index) => {
      const cell = cellFor(item.key);
      if (!cell) return;
      cell.dataset.size = item.size;
      cell.style.setProperty("--span", String(plan[index].span));
      if (plan[index].pair) cell.dataset.pair = plan[index].pair;
      else delete cell.dataset.pair;
      const grip = cell.querySelector('[data-arr="grip"]');
      if (grip) grip.setAttribute("aria-label", `${displayName(item)}, ${index + 1} of ${layout.items.length}`);
      cell.querySelectorAll('[data-arr="size"]').forEach((chip) => {
        chip.setAttribute("aria-checked", String(chip.getAttribute("data-size") === item.size));
      });
    });
  }

  /**
   * FLIP: let `change` move things, then slide every widget from where it was.
   * @param {() => void} change
   * @param {HTMLElement|null} [skip]  the widget being dragged
   */
  function flip(change, skip = null) {
    if (reducedMotion()) {
      change();
      return;
    }
    const before = new Map(cells().filter((c) => c !== skip).map((c) => [c, c.getBoundingClientRect()]));
    change();
    for (const [cell, was] of before) {
      if (!cell.isConnected) continue;
      const now = cell.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      cell.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: FLIP_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
      );
    }
  }

  /** Reads the order off the page and saves it. @param {HTMLElement} cell */
  function commitDomOrder(cell) {
    const index = cells().indexOf(cell);
    const key = cell.dataset.key || "";
    const item = layout.items.find((it) => it.key === key);
    if (!item || index < 0) return;
    commit(Layout.move(layout, item.key, index, Date.now()));
    applyPlan();
    announce(`${WIDGETS[item.id].title} moved to ${index + 1} of ${layout.items.length}.`);
  }

  // ---- Pointer drag -----------------------------------------------------------

  /**
   * @param {HTMLElement} cell
   * @param {{ x: number, y: number }} start
   */
  function beginDrag(cell, start) {
    const ov = root();
    if (!ov) return null;
    const rect = cell.getBoundingClientRect();
    const ovRect = ov.getBoundingClientRect();
    const slot = document.createElement("div");
    slot.className = "v-w-slot";
    slot.dataset.size = cell.dataset.size || "W";
    if (cell.dataset.pair) slot.dataset.pair = cell.dataset.pair;
    slot.style.setProperty("--span", cell.style.getPropertyValue("--span") || "12");
    slot.style.height = `${rect.height}px`;
    const originNext = cell.nextElementSibling;
    cell.before(slot);
    cell.classList.add("is-lifted");
    Object.assign(cell.style, {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      left: `${rect.left - ovRect.left}px`,
      top: `${rect.top - ovRect.top}px`,
    });
    ov.classList.add("is-dragging");
    return { cell, slot, start, originNext, scrollY: window.scrollY, pointer: { ...start }, frame: 0 };
  }

  /** @param {NonNullable<ReturnType<typeof beginDrag>>} drag */
  function placeSlot(drag) {
    const { x, y } = drag.pointer;
    const others = cells().filter((c) => c !== drag.cell);
    let target = null;
    for (const cell of others) {
      const r = cell.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        target = { cell, r };
        break;
      }
    }
    if (!target) return;
    const wide = target.r.width > (grid()?.getBoundingClientRect().width || 0) * 0.7;
    const after = wide ? y > target.r.top + target.r.height / 2 : x > target.r.left + target.r.width / 2;
    const ref = after ? target.cell.nextElementSibling : target.cell;
    if (ref === drag.slot || (after && target.cell.nextElementSibling === drag.slot) || (!after && target.cell.previousElementSibling === drag.slot)) return;
    flip(() => grid()?.insertBefore(drag.slot, ref), drag.cell);
  }

  /** @param {NonNullable<ReturnType<typeof beginDrag>>} drag */
  function follow(drag) {
    const dx = drag.pointer.x - drag.start.x;
    const dy = drag.pointer.y - drag.start.y + (window.scrollY - drag.scrollY);
    drag.cell.style.transform = `translate(${dx}px, ${dy}px) rotate(-1.2deg) scale(1.02)`;
  }

  /** Scrolls while the pointer rests near the top or bottom edge. @param {NonNullable<ReturnType<typeof beginDrag>>} drag */
  function autoScroll(drag) {
    const foot = body.querySelector(".v-arr-foot");
    const bottomEdge = window.innerHeight - (foot ? foot.getBoundingClientRect().height + 24 : 0);
    const { y } = drag.pointer;
    let step = 0;
    if (y < SCROLL_EDGE_PX) step = -SCROLL_MAX_STEP * (1 - y / SCROLL_EDGE_PX);
    else if (y > bottomEdge - SCROLL_EDGE_PX) step = SCROLL_MAX_STEP * Math.min(1, (y - (bottomEdge - SCROLL_EDGE_PX)) / SCROLL_EDGE_PX);
    if (step !== 0) {
      window.scrollBy(0, step);
      follow(drag);
      placeSlot(drag);
    }
    drag.frame = requestAnimationFrame(() => autoScroll(drag));
  }

  /**
   * @param {NonNullable<ReturnType<typeof beginDrag>>} drag
   * @param {boolean} keep  false puts it back where it started
   */
  function endDrag(drag, keep) {
    cancelAnimationFrame(drag.frame);
    const { cell, slot } = drag;
    root()?.classList.remove("is-dragging");
    const from = cell.getBoundingClientRect();
    if (keep) slot.replaceWith(cell);
    else {
      slot.remove();
      grid()?.insertBefore(cell, drag.originNext);
    }
    cell.classList.remove("is-lifted");
    cell.style.removeProperty("transform");
    ["width", "height", "left", "top"].forEach((prop) => cell.style.removeProperty(prop));
    if (!reducedMotion()) {
      const to = cell.getBoundingClientRect();
      cell.animate(
        [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) rotate(-1.2deg) scale(1.02)` }, { transform: "none" }],
        { duration: FLIP_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
      );
    }
    if (keep) commitDomOrder(cell);
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    const grip = target && target.closest('[data-arr="grip"]');
    if (!grip || event.button !== 0 || picked) return;
    const cell = /** @type {HTMLElement} */ (grip.closest(".v-w"));
    const touch = event.pointerType === "touch";
    const start = { x: event.clientX, y: event.clientY };
    /** @type {ReturnType<typeof beginDrag>} */
    let drag = null;
    let timer = 0;
    const lift = () => {
      drag = beginDrag(cell, start);
      if (drag) {
        follow(drag);
        drag.frame = requestAnimationFrame(() => drag && autoScroll(drag));
        if (touch && navigator.vibrate) navigator.vibrate(8);
      }
    };
    if (touch) timer = window.setTimeout(lift, LONG_PRESS_MS);
    grip.setPointerCapture(event.pointerId);
    const move = (e) => {
      if (!drag) {
        const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (!touch && dist > DRAG_START_PX) lift();
        else if (touch && dist > TOUCH_SLOP_PX) stop(false);
        return;
      }
      e.preventDefault();
      drag.pointer = { x: e.clientX, y: e.clientY };
      follow(drag);
      placeSlot(drag);
    };
    const keyStop = (e) => {
      if (e.key === "Escape") stop(false);
    };
    function stop(keep) {
      window.clearTimeout(timer);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", cancel);
      document.removeEventListener("keydown", keyStop, true);
      if (drag) endDrag(drag, keep);
      drag = null;
    }
    const up = () => stop(true);
    const cancel = () => stop(false);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", cancel);
    document.addEventListener("keydown", keyStop, true);
  }

  // ---- Keyboard pick-up ------------------------------------------------------------

  /** @param {HTMLElement} cell */
  function beginKeyboardPick(cell) {
    cell.classList.add("is-picked");
    const grip = /** @type {HTMLElement} */ (cell.querySelector('[data-arr="grip"]'));
    grip.setAttribute("aria-pressed", "true");
    const origin = cells().indexOf(cell);
    const title = WIDGETS[cell.dataset.w || ""]?.title || "Widget";
    announce(`${title} picked up, ${origin + 1} of ${cells().length}. Arrow keys move it, Space drops it, Escape puts it back.`);
    return { cell, grip, origin, title };
  }

  /** @param {NonNullable<typeof picked>} pick @param {boolean} keep */
  function endKeyboardPick(pick, keep) {
    if (!keep) {
      flip(() => {
        const list = cells().filter((c) => c !== pick.cell);
        grid()?.insertBefore(pick.cell, list[pick.origin] || null);
      });
    }
    pick.cell.classList.remove("is-picked");
    pick.grip.removeAttribute("aria-pressed");
    pick.grip.focus({ preventScroll: true });
    if (keep) commitDomOrder(pick.cell);
    else announce(`${pick.title} put back.`);
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    const grip = target && target.closest('[data-arr="grip"]');
    if (!grip) return;
    const cell = /** @type {HTMLElement} */ (grip.closest(".v-w"));
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (picked && picked.cell === cell) {
        const pick = picked;
        picked = null;
        endKeyboardPick(pick, true);
      } else if (!picked) {
        picked = beginKeyboardPick(cell);
      }
      return;
    }
    if (!picked || picked.cell !== cell) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const pick = picked;
      picked = null;
      endKeyboardPick(pick, false);
      return;
    }
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
    const ahead = event.key === "ArrowDown" || event.key === "ArrowRight";
    if (!back && !ahead) return;
    event.preventDefault();
    const sibling = back ? cell.previousElementSibling : cell.nextElementSibling;
    if (!sibling || !sibling.classList.contains("v-w")) return;
    flip(() => (back ? sibling.before(cell) : sibling.after(cell)));
    grip.focus({ preventScroll: true });
    cell.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    announce(`${picked.title}, ${cells().indexOf(cell) + 1} of ${cells().length}.`);
  }

  // ---- Tools ---------------------------------------------------------------------

  /** @param {HTMLElement} cell @returns {import("./layout.js").LayoutItem|undefined} */
  const itemFor = (cell) => layout.items.find((it) => it.key === cell.dataset.key);

  /** @param {HTMLElement} cell @param {string} size */
  function setSize(cell, size) {
    const item = itemFor(cell);
    if (!item) return;
    if (!commit(Layout.resize(layout, CATALOG, item.key, size, Date.now()))) return;
    flip(applyPlan);
    announce(`${WIDGETS[item.id].title}: ${SIZE_NAMES[size]}.`);
  }

  function hideToast() {
    window.clearTimeout(undoTimer);
    const toast = body.querySelector('[data-arr="toast"]');
    if (toast) toast.hidden = true;
    undo = null;
  }

  /** @param {HTMLElement} cell */
  function removeCell(cell) {
    const item = itemFor(cell);
    if (!item) return;
    const before = layout;
    if (!commit(Layout.remove(layout, item.key, Date.now()))) return;
    const title = WIDGETS[item.id].title;
    const neighbour = /** @type {HTMLElement|null} */ (cell.nextElementSibling || cell.previousElementSibling);
    flip(() => cell.remove());
    applyPlan();
    offerUndo(before, `Removed <b>${esc(title)}</b>`, `${title} is back.`);
    announce(`${title} removed. Undo is in the bar below.`);
    const next = neighbour && neighbour.querySelector('[data-arr="grip"]');
    if (next instanceof HTMLElement) next.focus({ preventScroll: true });
  }

  /**
   * Shows "… · Undo" above the bar for a few seconds.
   * @param {import("./layout.js").Layout} before  what Undo puts back
   * @param {string} html     trusted toast text
   * @param {string} backMsg  what screen readers hear after Undo
   */
  function offerUndo(before, html, backMsg) {
    undo = { layout: before, label: backMsg };
    const toast = body.querySelector('[data-arr="toast"]');
    if (toast) {
      toast.innerHTML = `<span>${html}</span><button class="v-btn" type="button" data-arr="undo">Undo</button>`;
      toast.hidden = false;
    }
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(hideToast, UNDO_MS);
  }

  function undoRemove() {
    if (!undo) return;
    const restored = Layout.sanitize({ ...undo.layout, updatedAt: Date.now() }, CATALOG, null);
    const message = undo.label;
    hideToast();
    commit(restored);
    draw();
    announce(message);
  }

  /** Clear all: every widget off the board, with Undo. */
  function clearBoard() {
    if (layout.items.length === 0) return;
    const before = layout;
    hideToast();
    commit(Layout.sanitize({ v: Layout.LAYOUT_VERSION, updatedAt: Date.now(), items: [] }, CATALOG, null));
    draw();
    offerUndo(before, "Cleared the board", "Your widgets are back.");
    announce("Every widget is off the board. Undo is in the bar below; Add widget starts a new one.");
    const add = body.querySelector('.v-ov-empty [data-arr="add"]');
    if (add instanceof HTMLElement) add.focus({ preventScroll: true });
  }

  /** @param {HTMLElement} cell @param {HTMLElement} gear */
  function toggleSettings(cell, gear) {
    const open = cell.querySelector(".v-w-settings");
    if (open) {
      open.remove();
      gear.setAttribute("aria-expanded", "false");
      return;
    }
    const item = itemFor(cell);
    if (!item) return;
    const widget = WIDGETS[item.id];
    const labels = widget.settingLabels || {};
    const fields = Object.entries(widget.settings || {})
      .map(([name, spec]) => {
        const label = (labels[name] && labels[name].label) || name;
        if (spec.type === "choice") {
          const names = (labels[name] && labels[name].options) || {};
          return `<label class="v-w-field"><span>${esc(label)}</span><select data-setting="${esc(name)}">${spec.options
            .map((value) => `<option value="${esc(value)}"${item.settings[name] === value ? " selected" : ""}>${esc(names[value] || value)}</option>`)
            .join("")}</select></label>`;
        }
        return `<label class="v-w-field"><span>${esc(label)}</span><input type="text" data-setting="${esc(name)}" maxlength="${spec.maxLength}" value="${esc(item.settings[name] || "")}"></label>`;
      })
      .join("");
    gear.setAttribute("aria-expanded", "true");
    gear.insertAdjacentHTML("afterend", `<div class="v-w-settings" role="group" aria-label="${esc(widget.title)} settings">${fields}</div>`);
    const first = cell.querySelector(".v-w-settings select, .v-w-settings input");
    if (first instanceof HTMLElement) first.focus();
  }

  /** @param {HTMLElement} field */
  function changeSetting(field) {
    const cell = /** @type {HTMLElement} */ (field.closest(".v-w"));
    const item = itemFor(cell);
    const name = field.getAttribute("data-setting");
    if (!item || !name) return;
    if (!commit(Layout.configure(layout, CATALOG, item.key, { [name]: /** @type {HTMLInputElement} */ (field).value }, Date.now()))) return;
    const fresh = layout.items.find((it) => it.key === item.key);
    if (!fresh) return;
    const inner = cell.querySelector(".v-w-body");
    if (inner) inner.innerHTML = cellHtml(fresh, ctx, 0) || needsHtml(fresh.id);
    const filter = settingsSummary(fresh);
    const grip = cell.querySelector('[data-arr="grip"]');
    const nameEl = grip && grip.querySelector(".v-w-name");
    if (nameEl) nameEl.textContent = displayName(fresh);
    const chip = grip && grip.querySelector(".v-w-filter");
    if (chip) chip.textContent = filter;
    else if (grip && filter) grip.insertAdjacentHTML("beforeend", `<span class="v-w-filter">${esc(filter)}</span>`);
  }

  async function openGallery() {
    const { openGallery: open } = await import("./gallery.js?v=2");
    open({
      layout,
      ctx,
      onAdd: (id) => {
        const before = layout;
        if (!commit(Layout.add(layout, CATALOG, { id }, { now: Date.now() }))) return false;
        const added = layout.items.find((it) => !before.items.some((old) => old.key === it.key));
        draw();
        const cell = added ? cellFor(added.key) : null;
        if (cell) {
          cell.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
          cell.classList.add("is-new");
          window.setTimeout(() => cell.classList.remove("is-new"), 1600);
          announce(`${WIDGETS[id].title} added, ${layout.items.length} of ${layout.items.length}.`);
        }
        return true;
      },
    });
  }

  function showConfirm(asking) {
    const actions = body.querySelector('[data-arr="actions"]');
    const confirm = body.querySelector('[data-arr="confirm"]');
    if (!(actions instanceof HTMLElement) || !(confirm instanceof HTMLElement)) return;
    actions.hidden = asking;
    confirm.hidden = !asking;
    const focus = body.querySelector(asking ? '[data-arr="reset-no"]' : '[data-arr="reset"]');
    if (focus instanceof HTMLElement) focus.focus();
  }

  function exit() {
    live.abort();
    window.clearTimeout(undoTimer);
    // Done while the gallery is still open closes it too.
    document.querySelectorAll("dialog.v-gal[open]").forEach((dialog) => /** @type {HTMLDialogElement} */ (dialog).close());
    deps.onExit();
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    const control = target && target.closest("[data-arr]");
    if (!control || !body.contains(control)) return;
    const action = control.getAttribute("data-arr");
    const cell = /** @type {HTMLElement|null} */ (control.closest(".v-w"));
    if (action === "size" && cell) setSize(cell, control.getAttribute("data-size") || "");
    else if (action === "remove" && cell) removeCell(cell);
    else if (action === "gear" && cell) toggleSettings(cell, /** @type {HTMLElement} */ (control));
    else if (action === "undo") undoRemove();
    else if (action === "add") void openGallery();
    else if (action === "clear") clearBoard();
    else if (action === "reset") showConfirm(true);
    else if (action === "reset-no") showConfirm(false);
    else if (action === "reset-yes") {
      hideToast();
      commit(Layout.reset(DEFAULT_ENTRIES, CATALOG, Date.now()));
      draw();
      announce("The default Overview is back.");
    } else if (action === "tour" && deps.startTour) deps.startTour(1);
    else if (action === "done") exit();
  }

  draw();
  body.querySelector(".v-arr-panel")?.classList.add("is-rising");
  const signal = live.signal;
  body.addEventListener("click", onClick, { signal });
  body.addEventListener("pointerdown", onPointerDown, { signal });
  body.addEventListener("keydown", onKeyDown, { signal });
  body.addEventListener("change", (event) => {
    if (event.target instanceof HTMLElement && event.target.matches("[data-setting]")) changeSetting(event.target);
  }, { signal });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !picked && !document.querySelector("dialog[open]")) {
      const open = body.querySelector(".v-w-settings");
      if (open) {
        const gear = open.previousElementSibling;
        open.remove();
        if (gear instanceof HTMLElement) {
          gear.setAttribute("aria-expanded", "false");
          gear.focus();
        }
      }
    }
  }, { signal });
  const firstGrip = body.querySelector('[data-arr="grip"]');
  if (deps.pickKey) {
    const cell = cellFor(deps.pickKey);
    if (cell) picked = beginKeyboardPick(cell);
  } else if (firstGrip instanceof HTMLElement) {
    firstGrip.focus({ preventScroll: true });
  }
}
