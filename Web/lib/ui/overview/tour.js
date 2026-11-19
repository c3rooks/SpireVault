// The first-visit tour of the customizable Overview (new look). Loaded on
// demand by index.js. Each step dims the page, rings one control in gold
// and explains it in a card with Back, Next and Skip; the tour opens Arrange
// mode itself after the first step, so the player sees the real controls.
// Esc skips, the arrow keys step, Tab stays inside the card.
//
// It touches nothing on <html> (a root change re-fits every stage header):
// the overlay is one element appended to <body>.


const TOUR_ID = "v-tour";
const HOLE_PAD = 8;
const CARD_GAP = 14;
const EDGE = 12;
const FIND_TIMEOUT_MS = 2500;
const SETTLE_MS = 380;

/**
 * @typedef {{ target: string, title: string, text: string, arrange?: boolean, next?: string }} TourStep
 */

/** @type {ReadonlyArray<TourStep>} */
export const STEPS = Object.freeze([
  {
    target: '.v-ov:not([data-arrange]) [data-action="ov-arrange"]',
    title: "Make the Overview yours",
    text: "Arrange lets you move, resize, add and remove the widgets on this page. Here's how it works, in five quick steps.",
    next: "Show me",
  },
  {
    target: '.v-ov[data-arrange] .v-w-grip',
    title: "Move a widget",
    text: "Grab a widget by its grip and drop it where you want it. With a keyboard: focus the grip, press Space, then use the arrow keys.",
    arrange: true,
  },
  {
    target: '.v-ov[data-arrange] .v-w-sizes',
    title: "Pick a size",
    text: "S, M, L and W set how much of the row a widget takes: a quarter, a third, half or all of it.",
    arrange: true,
  },
  {
    target: '.v-ov[data-arrange] .v-w-remove',
    title: "Remove what you don't need",
    text: "× takes a widget off the page, and Undo brings it back. Widgets with a gear have settings, like which number a stat tile shows.",
    arrange: true,
  },
  {
    target: '.v-ov[data-arrange] [data-arr="add"]',
    title: "Add widgets",
    text: "The gallery has your climb calendar, the gauntlet, the play clock, the picks that win and more. Every preview uses your own climbs.",
    arrange: true,
  },
  {
    target: '.v-ov[data-arrange] [data-arr="done"]',
    title: "Done when you are",
    text: "Your layout saves on this device as you go. Press Done whenever you want to see it.",
    arrange: true,
    next: "Got it",
  },
]);

/** @returns {boolean} */
function reducedMotion() {
  try {
    if (document.documentElement.classList.contains("prefer-reduced-motion")) return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** @param {string} selector @returns {Promise<HTMLElement|null>} */
function waitFor(selector) {
  const started = performance.now();
  return new Promise((resolve) => {
    const look = () => {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement && el.getClientRects().length > 0) resolve(el);
      else if (performance.now() - started > FIND_TIMEOUT_MS) resolve(null);
      else requestAnimationFrame(look);
    };
    look();
  });
}

/**
 * @param {{
 *   fromStep?: number,
 *   openArrange: () => Promise<void>,
 *   isArranging: () => boolean,
 *   onClose: (how: "done" | "skip", step: number) => void,
 * }} deps
 */
export function runTour(deps) {
  document.getElementById(TOUR_ID)?.remove();
  const root = document.createElement("div");
  root.id = TOUR_ID;
  root.className = `v-tour${reducedMotion() ? " is-still" : ""}`;
  root.innerHTML = `
    <div class="v-tour-hole" aria-hidden="true"></div>
    <section class="v-tour-card" role="dialog" aria-modal="true" aria-labelledby="v-tour-title" aria-describedby="v-tour-text">
      <p class="v-tour-count"></p>
      <h2 class="v-tour-title" id="v-tour-title"></h2>
      <p class="v-tour-text" id="v-tour-text"></p>
      <div class="v-tour-foot">
        <button class="v-tour-skip" type="button" data-tour="skip">Skip tour</button>
        <span class="v-tour-dots" aria-hidden="true">${STEPS.map(() => "<i></i>").join("")}</span>
        <button class="v-btn" type="button" data-tour="back">Back</button>
        <button class="v-btn v-btn--primary" type="button" data-tour="next">Next</button>
      </div>
    </section>`;
  document.body.appendChild(root);
  const hole = /** @type {HTMLElement} */ (root.querySelector(".v-tour-hole"));
  const card = /** @type {HTMLElement} */ (root.querySelector(".v-tour-card"));
  let index = Math.min(Math.max(0, deps.fromStep || 0), STEPS.length - 1);
  /** @type {HTMLElement|null} */
  let target = null;
  let frame = 0;
  let busy = false;

  function place() {
    frame = 0;
    if (!target || !target.isConnected) return;
    const r = target.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    Object.assign(hole.style, {
      width: `${r.width + HOLE_PAD * 2}px`,
      height: `${r.height + HOLE_PAD * 2}px`,
      transform: `translate(${r.left - HOLE_PAD}px, ${r.top - HOLE_PAD}px)`,
    });
    const width = Math.min(card.offsetWidth, vw - EDGE * 2);
    const height = card.offsetHeight;
    const below = r.bottom + HOLE_PAD + CARD_GAP;
    const above = r.top - HOLE_PAD - CARD_GAP - height;
    const top = below + height <= vh - EDGE || above < EDGE ? Math.min(below, vh - EDGE - height) : above;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - width / 2), vw - EDGE - width);
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(EDGE, top))}px)`;
  }
  const placeSoon = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };

  /** @param {"done" | "skip"} how */
  function close(how) {
    window.removeEventListener("scroll", placeSoon, true);
    window.removeEventListener("resize", placeSoon);
    document.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(frame);
    root.remove();
    deps.onClose(how, index);
  }

  /** @param {number} next */
  async function show(next) {
    if (busy) return;
    busy = true;
    root.classList.add("is-moving");
    const step = STEPS[next];
    if (step.arrange && !deps.isArranging()) await deps.openArrange();
    const found = await waitFor(step.target);
    if (!found) {
      busy = false;
      close("skip");
      return;
    }
    index = next;
    target = found;
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    /** @type {HTMLElement} */ (root.querySelector(".v-tour-count")).textContent = `Step ${index + 1} of ${STEPS.length}`;
    /** @type {HTMLElement} */ (root.querySelector(".v-tour-title")).textContent = step.title;
    /** @type {HTMLElement} */ (root.querySelector(".v-tour-text")).textContent = step.text;
    const nextBtn = /** @type {HTMLButtonElement} */ (root.querySelector('[data-tour="next"]'));
    nextBtn.textContent = step.next || "Next";
    // Step 1 is the Arrange button itself, which is gone once Arrange is open.
    /** @type {HTMLButtonElement} */ (root.querySelector('[data-tour="back"]')).hidden = index <= 1;
    root.querySelectorAll(".v-tour-dots i").forEach((dot, i) => dot.classList.toggle("is-on", i === index));
    place();
    window.setTimeout(() => {
      place();
      root.classList.remove("is-moving");
      busy = false;
      nextBtn.focus({ preventScroll: true });
    }, reducedMotion() ? 0 : SETTLE_MS);
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close("skip");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (index === STEPS.length - 1) close("done");
      else void show(index + 1);
    } else if (event.key === "ArrowLeft" && index > 1) {
      event.preventDefault();
      void show(index - 1);
    } else if (event.key === "Tab") {
      const buttons = [...card.querySelectorAll("button:not([hidden])")];
      const at = buttons.indexOf(/** @type {Element} */ (document.activeElement));
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      const next = buttons[(at + step + buttons.length) % buttons.length];
      if (next instanceof HTMLElement) next.focus();
    }
  }

  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-tour]") : null;
    if (!button) return;
    const action = button.getAttribute("data-tour");
    if (action === "skip") close("skip");
    else if (action === "back" && index > 1) void show(index - 1);
    else if (action === "next") {
      if (index === STEPS.length - 1) close("done");
      else void show(index + 1);
    }
  });
  window.addEventListener("scroll", placeSoon, true);
  window.addEventListener("resize", placeSoon);
  document.addEventListener("keydown", onKey, true);
  void show(index);
  return root;
}

