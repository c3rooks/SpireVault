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

/** @param {PointerEvent} event */
function handlePointer(event) {
  const target = event.target instanceof Element ? event.target : null;

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

  // Stage parallax: one custom property drives every layer.
  const stage = target ? target.closest(".v-has-stage") : null;
  if (stage) {
    const box = stage.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width - 0.5;
    /** @type {HTMLElement} */ (stage).style.setProperty("--px", px.toFixed(3));
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
      document.querySelectorAll(".v-has-stage").forEach((stage) => {
        /** @type {HTMLElement} */ (stage).style.setProperty("--px", "0");
      });
    },
    { passive: true }
  );
}
