// Motion and pointer interaction for the new UI.
//
// The app re-renders tabs with innerHTML, including on a background refresh
// every 60 seconds. Entrance animation therefore cannot be "animate when it
// appears" — the page would dance on every refresh. Instead a tab entry
// *arms* the next render; `afterRender` consumes the arm, marks the panel
// with `data-enter` for one beat, and CSS does the rest. An un-armed render
// paints the final state immediately.
//
// Boot renders the same tab two or three times in quick succession (first
// paint, then again when the asset manifest and the run history arrive). A
// re-render inside the entrance window must neither restart the animation
// nor cut it off, so it *continues* it: the elapsed time is published as
// `--enter-elapsed` and every entrance animation subtracts it from its
// delay, which starts the fresh DOM mid-animation at the right frame.
//
// All listeners are delegated from `document`, so they survive re-renders.

const ENTER_ATTR = "data-enter";
const ENTER_WINDOW_MS = 1800;
const COUNT_DURATION_MS = 1100;
const TILT_MAX_DEG = 9;

/** First paint counts as an entry. */
let armed = true;
let enterTimer = 0;
let enterStart = 0;
/** @type {Element|null} */
let enterRoot = null;
let pointerFrame = 0;
/** @type {Element|null} */
let tiltedEl = null;

/**
 * True when either the OS setting or the in-app "Reduced motion" toggle asks
 * for less motion. Every JS-driven effect checks this; CSS has its own gates.
 * @returns {boolean}
 */
export function reduced() {
  try {
    if (document.documentElement.classList.contains("prefer-reduced-motion")) return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Arms the next render to play its entrance. Call on tab entry. */
export function arm() {
  armed = true;
}

/**
 * @param {number} t  0..1
 * @returns {number}
 */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Tweens a number from zero to the value already in the DOM. The final text
 * is rendered first, so an interrupted animation still leaves it correct.
 * @param {HTMLElement} el  carries data-count (target) and data-decimals
 * @param {number} start  when the entrance began (performance.now clock)
 */
function countUp(el, start) {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target)) return;
  const decimals = Number(el.dataset.decimals || 0);
  const finalText = el.textContent;
  const step = (now) => {
    const progress = Math.min(1, (now - start) / COUNT_DURATION_MS);
    if (progress >= 1 || !el.isConnected) {
      el.textContent = finalText;
      return;
    }
    el.textContent = (target * easeOutCubic(progress)).toFixed(decimals);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Call after a panel body has been rendered.
 * @param {Element|null} root  the element whose innerHTML was just replaced
 */
export function afterRender(root) {
  if (!root) return;
  watchZoomRows(root);
  const now = performance.now();
  const continuing =
    !armed && enterRoot === root && root.hasAttribute(ENTER_ATTR) && now - enterStart < ENTER_WINDOW_MS;
  if (armed) {
    enterStart = now;
    enterRoot = root;
  }
  const play = (armed || continuing) && !reduced();
  armed = false;
  window.clearTimeout(enterTimer);
  if (!play) {
    endEntrance(root);
    return;
  }
  const elapsed = now - enterStart;
  /** @type {HTMLElement} */ (root).style.setProperty("--enter-elapsed", `${Math.round(elapsed)}ms`);
  root.setAttribute(ENTER_ATTR, "");
  root.querySelectorAll("[data-count]").forEach((el) => countUp(/** @type {HTMLElement} */ (el), enterStart));
  enterTimer = window.setTimeout(() => endEntrance(root), ENTER_WINDOW_MS - elapsed);
}

/** @param {Element} root */
function endEntrance(root) {
  root.removeAttribute(ENTER_ATTR);
  /** @type {HTMLElement} */ (root).style.removeProperty("--enter-elapsed");
}

/** @param {Element|null} el */
function clearTilt(el) {
  if (!el) return;
  /** @type {HTMLElement} */ (el).style.removeProperty("--rx");
  /** @type {HTMLElement} */ (el).style.removeProperty("--ry");
}

/** How far off screen a zoomable row starts fetching its large face. */
const ZOOM_PREFETCH_MARGIN = "300px 0px";
/** @type {IntersectionObserver | null} */
let nearObserver = null;
/** @type {Set<Element>} rows being watched, so re-rendered-away ones can be let go */
const watchedRows = new Set();

/** Whether rows grow on hover here (cards.css): a hovering pointer, motion allowed. */
function rowsZoom() {
  if (reduced()) return false;
  try {
    return window.matchMedia("(hover: hover)").matches;
  } catch {
    return false;
  }
}

/**
 * Large faces arrive before anyone hovers. A row's card grows to full size
 * the moment the pointer reaches it, so fetching the large face on that
 * first hover showed the small one blown up, blurry, until the large one
 * landed a beat later. Instead each zoomable row starts its fetch as it
 * comes near the screen (rows in a hidden tab never do): about 30 KB per row
 * someone could actually see. Hovering still sharpens a row the watcher has
 * not reached (handlePointer).
 * @param {Element} root
 */
function watchZoomRows(root) {
  if (typeof IntersectionObserver !== "function" || !rowsZoom()) return;
  if (!nearObserver) {
    nearObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || !nearObserver) return;
          nearObserver.unobserve(entry.target);
          watchedRows.delete(entry.target);
          sharpenArt(entry.target);
        });
      },
      { rootMargin: ZOOM_PREFETCH_MARGIN }
    );
  }
  // The app re-renders with innerHTML: drop rows that are gone.
  watchedRows.forEach((row) => {
    if (row.isConnected) return;
    nearObserver?.unobserve(row);
    watchedRows.delete(row);
  });
  root.querySelectorAll("[data-hd-zoom]").forEach((row) => {
    if (watchedRows.has(row) || !row.querySelector("img[data-hd]")) return;
    watchedRows.add(row);
    nearObserver?.observe(row);
  });
}

/**
 * A thumbnail that grows on hover names its large image in `data-hd`. Load
 * that image and put it in, once its row (`[data-hd-zoom]`) nears the screen
 * or is hovered, whichever comes first; the attribute is removed straight
 * away, so it happens once.
 * @param {Element} host
 */
function sharpenArt(host) {
  host.querySelectorAll("img[data-hd]").forEach((img) => {
    const large = img.getAttribute("data-hd");
    img.removeAttribute("data-hd");
    if (!large) return;
    const loader = new Image();
    // Swap only once it has arrived, so the thumbnail never blanks. If it
    // fails, the small image simply stays.
    loader.onload = () => {
      if (img.isConnected) img.setAttribute("src", large);
    };
    loader.src = large;
  });
}

/** @param {PointerEvent} event */
function handlePointer(event) {
  const target = event.target instanceof Element ? event.target : null;

  const zoomHost = target ? target.closest("[data-hd-zoom]") : null;
  if (zoomHost) sharpenArt(zoomHost);

  // Card tilt: lean toward the pointer.
  const tilt = target ? target.closest("[data-tilt]") : null;
  if (tilt !== tiltedEl) {
    clearTilt(tiltedEl);
    tiltedEl = tilt;
  }
  if (tilt) {
    const box = tilt.getBoundingClientRect();
    const dx = (event.clientX - box.left) / box.width - 0.5;
    const dy = (event.clientY - box.top) / box.height - 0.5;
    /** @type {HTMLElement} */ (tilt).style.setProperty("--ry", `${(dx * 2 * TILT_MAX_DEG).toFixed(2)}deg`);
    /** @type {HTMLElement} */ (tilt).style.setProperty("--rx", `${(-dy * 2 * TILT_MAX_DEG).toFixed(2)}deg`);
  }
}

/**
 * Wires pointer-driven effects once. No-ops on touch-first devices and when
 * motion is reduced.
 */
export function initMotion() {
  let finePointer = false;
  try {
    finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  } catch {
    finePointer = false;
  }
  if (!finePointer) return;

  document.addEventListener(
    "pointermove",
    (event) => {
      if (pointerFrame || reduced()) return;
      pointerFrame = requestAnimationFrame(() => {
        pointerFrame = 0;
        handlePointer(event);
      });
    },
    { passive: true }
  );
  // `pointerleave` does not bubble, so it must be bound to the root element
  // the pointer actually leaves, not to `document`.
  document.documentElement.addEventListener(
    "pointerleave",
    () => {
      clearTilt(tiltedEl);
      tiltedEl = null;
    },
    { passive: true }
  );
}
