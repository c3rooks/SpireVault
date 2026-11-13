// The Stage: the header diorama, drawn as layered, themeable scenery that
// doubles as a data display. Styles: styles/src/components/stage.css.
//
//   spire windows  → lit up to the highest ascension reached
//   torches        → the last ten runs, oldest on the left (lit = victory)
//   the duel       → the climber and the boss, squared off on the ledge
//
// The duel reuses renderCompanion()'s state (which climber, which boss, which
// line) and its click handlers; only the markup is ours. The figures are the
// game's sprites re-inked for this stage by scripts/build-stage-sprites.mjs.

import { esc } from "./html.js?v=1";
import { STAGE_ACTOR_ART } from "./stage-actors.js?v=1";

const DEFAULT_ASCENSION_CAP = 10;
/** Hard ceiling on windows drawn. A corrupt save must not be able to ask
 *  for a billion DOM nodes. */
const MAX_ASCENSION_CAP = 20;
const MAX_TORCHES = 10;
const TORCH_SPACING = 22;
const TORCH_VIEW_H = 46;

/** @type {WeakMap<Element, string>} markup last written to each backdrop */
const painted = new WeakMap();

/**
 * Window positions for the standard A0–A10 spire: [y, width] per level,
 * following the three tiers of the tower. Other caps fall back to an even
 * spread (see windowGeometry).
 */
const STANDARD_WINDOWS = Object.freeze([
  [214, 11], [199, 11], [184, 10], [169, 10],
  [134, 9], [122, 9], [110, 8], [98, 8],
  [72, 6], [61, 6], [50, 5],
]);

/**
 * @param {number} level
 * @param {number} cap
 * @returns {{ y: number, width: number }}
 */
function windowGeometry(level, cap) {
  if (cap === DEFAULT_ASCENSION_CAP) {
    const [y, width] = STANDARD_WINDOWS[level];
    return { y, width };
  }
  const t = cap === 0 ? 0 : level / cap;
  return { y: 214 - t * 164, width: 11 - t * 6 };
}

/**
 * @param {number} hiLevel  highest ascension reached, -1 when none
 * @param {number} cap      top ascension level drawn
 * @returns {string}
 */
function spireHtml(hiLevel, cap) {
  const windows = Array.from({ length: cap + 1 }, (_, level) => {
    const { y, width } = windowGeometry(level, cap);
    const classes = ["v-spire-win", level <= hiLevel ? "is-lit" : "", level === hiLevel ? "is-peak" : ""]
      .filter(Boolean)
      .join(" ");
    return `<rect class="${classes}" x="${(60 - width / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="7" rx="2.5"/>`;
  }).join("");
  const label =
    hiLevel >= 0
      ? `The spire is lit to ascension ${hiLevel} of ${cap}, your highest reached.`
      : "The spire is dark. Finish a run to light the first window.";
  return `
    <div class="v-spire" role="img" aria-label="${esc(label)}" title="${esc(label)}">
      <svg class="v-spire-svg" viewBox="0 0 120 230" aria-hidden="true">
        <path class="v-spire-body" d="M30 230 L37 158 L32 158 L32 150 L88 150 L88 158 L83 158 L90 230 Z"/>
        <path class="v-spire-body" d="M40 150 L45 92 L41 92 L41 85 L79 85 L79 92 L75 92 L80 150 Z"/>
        <path class="v-spire-body" d="M48 85 L52 44 L49 44 L49 38 L71 38 L71 44 L68 44 L72 85 Z"/>
        <path class="v-spire-roof" d="M50 38 L60 8 L70 38 Z"/>
        <circle class="v-spire-beacon${hiLevel >= cap ? " is-lit" : ""}" cx="60" cy="8" r="4.5"/>
        ${windows}
      </svg>
    </div>`;
}

/**
 * The spire's caption. It lives on the ledge strip (near layer), under the
 * spire, so the boss standing in front of the tower never covers it.
 * @param {number} hiLevel
 * @returns {string}
 */
function spireCaptionHtml(hiLevel) {
  if (hiLevel < 0) return "";
  return `<span class="v-stage-cap v-spire-cap" aria-hidden="true">spire lit to <strong>A${hiLevel}</strong></span>`;
}

/**
 * @param {ReadonlyArray<{ won: boolean, label?: string }>} recent  oldest → newest
 * @returns {string}
 */
function torchesHtml(recent) {
  const runs = recent.slice(-MAX_TORCHES);
  if (runs.length === 0) return "";
  const wins = runs.filter((run) => run.won).length;
  const width = runs.length * TORCH_SPACING;
  const torches = runs
    .map((run, index) => {
      const x = TORCH_SPACING / 2 + index * TORCH_SPACING;
      const title = `${run.label || `Run ${index + 1}`}: ${run.won ? "victory" : "defeat"}`;
      const top = run.won
        ? `<path class="v-torch-flame" style="--d:${index}" d="M${x} 3q8.5 10 0 19q-8.5 -9 0 -19z"/>`
        : `<circle class="v-torch-ember" cx="${x}" cy="19" r="2.5"/>`;
      return `
        <g>
          <title>${esc(title)}</title>
          <rect class="v-torch-stick" x="${x - 1.5}" y="24" width="3" height="20" rx="1"/>
          <path class="v-torch-cup" d="M${x - 5.5} 22h11l-2.5 5h-6z"/>
          ${top}
        </g>`;
    })
    .join("");
  const noun = runs.length === 1 ? "run" : "runs";
  const label = `Last ${runs.length} ${noun}: ${wins} won, ${runs.length - wins} lost.`;
  return `
    <div class="v-torches" role="img" aria-label="${esc(label)}" style="--torch-count:${runs.length}">
      <svg viewBox="0 0 ${width} ${TORCH_VIEW_H}" aria-hidden="true">${torches}</svg>
      <span class="v-stage-cap">${wins} of your last ${runs.length} torches lit</span>
    </div>`;
}

/**
 * @typedef {Object} StageModel
 * @property {number} hiLevel   highest ascension reached, -1 when none
 * @property {number} [cap]     top ascension level (defaults to 10)
 * @property {ReadonlyArray<{ won: boolean, label?: string }>} [recent]  last runs, oldest → newest
 */

/**
 * Builds the scenery markup for one stage.
 * @param {StageModel} model
 * @returns {string}
 */
export function stageBackdropHtml(model) {
  const hiLevel = Number.isFinite(model.hiLevel)
    ? Math.min(MAX_ASCENSION_CAP, Math.max(-1, Math.floor(model.hiLevel)))
    : -1;
  const cap = Math.min(MAX_ASCENSION_CAP, Math.max(DEFAULT_ASCENSION_CAP, Math.floor(model.cap || 0), hiLevel));
  return `
    <div class="v-stage-layer v-stage-far">
      <span class="v-stage-stars" aria-hidden="true"></span>
      <span class="v-stage-moon" aria-hidden="true"></span>
      <svg class="v-stage-hills" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
        <path class="v-hills-back" d="M0 120 V52 L90 20 L170 58 L260 8 L350 62 L450 26 L540 70 L640 18 L730 64 L830 30 L920 72 L1010 12 L1100 56 L1200 34 V120 Z"/>
        <path d="M0 120 V84 L60 58 L130 90 L210 50 L300 96 L380 66 L470 104 L560 74 L650 106 L760 60 L850 98 L940 54 L1030 92 L1110 66 L1200 88 V120 Z"/>
      </svg>
      ${spireHtml(hiLevel, cap)}
    </div>
    <div class="v-stage-layer v-stage-mid" aria-hidden="true">
      <svg class="v-stage-arch" viewBox="0 0 90 110">
        <path d="M8 110 V46 Q45 -8 82 46 V110 H67 V54 Q45 22 23 54 V110 Z"/>
      </svg>
      <svg class="v-stage-pillar" viewBox="0 0 34 100">
        <path d="M8 100 V16 H4 V6 H30 V16 H26 V100 Z"/>
      </svg>
    </div>
    <div class="v-stage-layer v-stage-near">
      <svg class="v-stage-ledge" viewBox="0 0 1200 44" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 44 V12 L80 8 L190 13 L300 6 L430 12 L560 7 L690 13 L820 6 L950 12 L1080 7 L1200 11 V44 Z"/>
        <path class="v-ledge-edge" d="M0 12 L80 8 L190 13 L300 6 L430 12 L560 7 L690 13 L820 6 L950 12 L1080 7 L1200 11"/>
      </svg>
      ${torchesHtml(model.recent || [])}
      ${spireCaptionHtml(hiLevel)}
    </div>`;
}

// ---- The duel -----------------------------------------------------------------

/**
 * Hand-tuned staging per actor.
 *   height  the figure's height as a fraction of the stage height
 *   seat    for seated poses: the stone the climber rests on, as fractions of
 *           the figure's own box (the art is cropped tight, so y = 1 is the
 *           ground). Drawn behind the figure.
 */
const ACTOR_STAGING = Object.freeze({
  ironclad: Object.freeze({ height: 0.52, seat: Object.freeze({ left: -0.04, top: 0.5, width: 0.6, height: 0.44 }) }),
  silent: Object.freeze({ height: 0.54, seat: Object.freeze({ left: 0.02, top: 0.52, width: 0.62, height: 0.4 }) }),
  defect: Object.freeze({ height: 0.48 }),
  regent: Object.freeze({ height: 0.58 }),
  necrobinder: Object.freeze({ height: 0.55, seat: Object.freeze({ left: -0.02, top: 0.56, width: 0.66, height: 0.36 }) }),
  architect: Object.freeze({ height: 0.67 }),
});
const FALLBACK_STAGING = Object.freeze({
  climber: Object.freeze({ height: 0.52 }),
  boss: Object.freeze({ height: 0.67 }),
});
/** Width ÷ height assumed for a sprite with no inked art (size unknown). */
const FALLBACK_ASPECT = 0.66;
/** The ground shadow reaches this far past the feet on each side. */
const SHADOW_OVERHANG = 0.08;

/**
 * Inked art for an actor, or null when none has been built for it.
 * @param {string} id
 * @returns {import("./stage-actors.js").StageActorArt | null}
 */
export function actorArt(id) {
  return Object.prototype.hasOwnProperty.call(STAGE_ACTOR_ART, id) ? STAGE_ACTOR_ART[id] : null;
}

/** @param {number} value */
function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * @typedef {Object} DuelActor
 * @property {string} id
 * @property {string} label
 * @property {string} [fallbackSrc]     the classic sprite, used when no inked art exists
 * @property {string} [fallbackSrcset]
 */

/**
 * The pieces of one figure: ground shadow, optional seat, art, and the two
 * numbers CSS sizes it from.
 * @param {DuelActor} actor
 * @param {"climber" | "boss"} kind
 */
function actorParts(actor, kind) {
  const art = actorArt(actor.id);
  const staging = Object.prototype.hasOwnProperty.call(ACTOR_STAGING, actor.id) ? ACTOR_STAGING[actor.id] : FALLBACK_STAGING[kind];
  const aspect = art ? art.width / art.height : FALLBACK_ASPECT;
  const left = art ? Math.max(0, art.groundLeft - SHADOW_OVERHANG) : 0.1;
  const right = art ? Math.min(1, art.groundRight + SHADOW_OVERHANG) : 0.9;
  const shadow = `<span class="v-actor-shadow" style="left:${percent(left)};width:${percent(right - left)}" aria-hidden="true"></span>`;
  const seat = staging.seat
    ? `<span class="v-actor-seat" style="left:${percent(staging.seat.left)};top:${percent(staging.seat.top)};width:${percent(staging.seat.width)};height:${percent(staging.seat.height)}" aria-hidden="true"></span>`
    : "";
  let image = `<span class="v-actor-glyph" aria-hidden="true">${esc(actor.label.slice(0, 1))}</span>`;
  if (art) {
    image = `<img class="v-actor-art" src="${esc(art.src)}" width="${art.width}" height="${art.height}" alt="" draggable="false" decoding="async">`;
  } else if (actor.fallbackSrc) {
    const srcset = actor.fallbackSrcset ? ` srcset="${esc(actor.fallbackSrcset)}"` : "";
    image = `<img class="v-actor-art v-actor-art--raw" src="${esc(actor.fallbackSrc)}"${srcset} alt="" draggable="false" decoding="async">`;
  }
  return { height: staging.height, aspect: aspect.toFixed(4), html: `${shadow}${seat}${image}` };
}

/**
 * @typedef {Object} DuelModel
 * @property {DuelActor & { ariaLabel: string, hint: string }} climber
 * @property {DuelActor} boss
 * @property {{ who: "climber" | "boss", text: string }} quote
 */

/**
 * The climber and the boss facing each other across the gap, with the
 * speaker's line in a balloon between them. The `data-action` hooks are the
 * ones renderCompanion() has always used.
 * @param {DuelModel} model
 * @returns {string}
 */
export function duelHtml(model) {
  const climber = actorParts(model.climber, "climber");
  const boss = actorParts(model.boss, "boss");
  const speaker = model.quote.who === "climber" ? "climber" : "boss";
  const speakerLabel = speaker === "climber" ? model.climber.label : model.boss.label;
  const sizing = `--climber-h:${climber.height};--climber-aspect:${climber.aspect};--boss-h:${boss.height};--boss-aspect:${boss.aspect}`;
  return `
    <div class="v-duel v-duel--${speaker}-speaks" style="${sizing}">
      <button class="v-actor v-actor--climber" type="button" data-action="companion-toggle"
              aria-label="${esc(model.climber.ariaLabel)}" title="${esc(model.climber.hint)}">
        ${climber.html}
      </button>
      <div class="v-actor v-actor--boss" role="img" aria-label="${esc(model.boss.label)}" title="${esc(model.boss.label)}">
        ${boss.html}
      </div>
      <div class="v-duel-gap">
        <button class="v-bubble" type="button" data-action="scene-reroll"
                aria-label="${esc(`${speakerLabel} says: ${model.quote.text} Tap for another line.`)}" title="Tap for a new line">
          <span class="v-bubble-text">${esc(model.quote.text)}</span>
          <span class="v-bubble-tail" aria-hidden="true"></span>
        </button>
      </div>
    </div>`;
}

/** Sizing properties duelHtml() writes on `.v-duel` that the scenery needs. */
const DUEL_GEOMETRY_PROPS = Object.freeze(["--climber-h", "--climber-aspect", "--boss-h", "--boss-aspect"]);

/**
 * Copies each duel's figure sizing onto its stage header, so the scenery
 * behind the figures (the spire, the moon) can stand clear of the climber
 * whatever its width — the Defect is almost twice as wide as the Regent.
 * Call after the duel markup is written.
 * @param {ParentNode} [root]
 */
export function syncDuelGeometry(root = document) {
  root.querySelectorAll(".panel-head.v-has-stage").forEach((head) => {
    const duel = head.querySelector(".v-duel");
    if (!(duel instanceof HTMLElement) || !(head instanceof HTMLElement)) return;
    DUEL_GEOMETRY_PROPS.forEach((prop) => {
      const value = duel.style.getPropertyValue(prop);
      if (value) head.style.setProperty(prop, value);
      else head.style.removeProperty(prop);
    });
  });
  fitStages(root);
}

/** Open ground kept between the scenery, the title text and the balloon. */
const AIR_PX = 10;
/** Below this the tower stops reading as a tower; leave it out instead. */
const SPIRE_MIN_W_PX = 46;
/** Narrowest balloon worth drawing; the longest line wraps to three lines. */
const BUBBLE_MIN_W_PX = 120;
const TITLE_TEXT = ".panel-head-stage h2, .panel-head-stage p";

/**
 * The line boxes of the text inside the matching elements, so a short
 * subtitle in a wide block does not count as wide.
 * @param {Element} head
 * @param {string} selector
 * @returns {DOMRect[]}
 */
function textRects(head, selector) {
  return [...head.querySelectorAll(selector)].flatMap((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  });
}

/**
 * @param {Element|null} el
 * @returns {DOMRect|null} its box, or null when it is not drawn
 */
function drawnRect(el) {
  if (!el || getComputedStyle(el).display === "none") return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/**
 * @param {DOMRect} a
 * @param {DOMRect} b
 * @returns {boolean} true when the boxes come within AIR_PX of each other
 */
function crowds(a, b) {
  return a.left < b.right + AIR_PX && a.right > b.left - AIR_PX && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Sizes the spire to the open ground between the title block / torches and
 * the climber: full size when there is room, narrower when there is a
 * little, left out when there is none.
 * @param {HTMLElement} head
 */
function fitSpire(head) {
  const tower = drawnRect(head.querySelector(".v-spire"));
  if (!tower) return;
  const blockers = [
    ...textRects(head, TITLE_TEXT),
    ...[...head.querySelectorAll(".v-torches svg, .v-torches .v-stage-cap")].map(drawnRect).filter(Boolean),
  ];
  const leftLimit = blockers
    .filter((r) => r.bottom > tower.top && r.top < tower.bottom)
    .reduce((limit, r) => Math.max(limit, r.right + AIR_PX), -Infinity);
  if (leftLimit <= tower.left) return;
  const room = tower.right - leftLimit;
  if (room < SPIRE_MIN_W_PX) {
    head.classList.add("v-stage--no-spire");
    return;
  }
  head.style.setProperty("--spire-fit-w", `${Math.floor(room)}px`);
}

/**
 * The balloon's box as laid out, ignoring its pop-in animation: it scales up
 * from 70% when a line appears, and measuring it mid-pop would make it look
 * smaller than it is. Its slot is never animated.
 * @param {HTMLElement} bubble
 * @param {Element} slotEl
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
function balloonBox(bubble, slotEl) {
  // The slot is absolutely positioned, so it is the balloon's offsetParent,
  // and offsetLeft/offsetTop are layout positions that ignore transforms.
  const slot = slotEl.getBoundingClientRect();
  const left = slot.left + bubble.offsetLeft;
  const top = slot.top + bubble.offsetTop;
  return { left, right: left + bubble.offsetWidth, top, bottom: top + bubble.offsetHeight };
}

/**
 * Small screens put the balloon above the boss's head, right-aligned, in the
 * band between the toolbar and the figures. It must stay right of the title
 * text and, if it can, right of the spire. When the line then needs more
 * height than the band has, the spire gives way first, and then the header
 * grows just enough — the line is never covered and never covers anything.
 * (Wider screens put it between the two figures, where none of this applies.)
 * @param {HTMLElement} head
 */
function fitBalloon(head) {
  const bubble = head.querySelector(".v-bubble");
  const slotEl = head.querySelector(".v-duel-gap");
  const boss = drawnRect(head.querySelector(".v-actor--boss"));
  if (!(bubble instanceof HTMLElement)) return;
  // On phones only Overview shows the toolbar; elsewhere the header's own
  // top edge is the ceiling.
  const toolbar = drawnRect(head.querySelector(".app-toolbar"));
  if (!slotEl || !boss) return;
  if (balloonBox(bubble, slotEl).bottom > boss.top + 2) return;
  // The widest the balloon may be here (--bubble-max), measured unconstrained.
  head.classList.add("v-stage--free-bubble");
  const slot = slotEl.getBoundingClientRect();
  head.classList.remove("v-stage--free-bubble");
  const ceiling = (toolbar ? toolbar.bottom : head.getBoundingClientRect().top) + AIR_PX / 2;
  const textRight = textRects(head, TITLE_TEXT).reduce((right, r) => Math.max(right, r.right), -Infinity);
  const textRoom = slot.right - (textRight + AIR_PX);
  const tower = drawnRect(head.querySelector(".v-spire"));
  const towerRoom = tower ? slot.right - (tower.right + AIR_PX) : Infinity;
  /** @param {number} room */
  const place = (room) => {
    const width = Math.max(BUBBLE_MIN_W_PX, Math.floor(Math.min(slot.width, room)));
    head.style.setProperty("--bubble-fit-w", `${width}px`);
    return balloonBox(bubble, slotEl);
  };
  let line = place(Math.min(textRoom, towerRoom));
  if (line.top < ceiling && tower && towerRoom < textRoom) {
    head.classList.add("v-stage--no-spire");
    line = place(textRoom);
  }
  if (line.top < ceiling) {
    head.style.setProperty("--stage-extra", `${Math.ceil(ceiling - line.top)}px`);
  }
}

/**
 * Lays out the scenery and the balloon of one stage header around what is
 * actually on it: this width, this climber, this tab's subtitle, this line.
 * Measured, not guessed, so it holds for every combination;
 * scripts/verify-stage-geometry.mjs checks the result.
 * @param {HTMLElement} head
 */
function fitStage(head) {
  head.style.removeProperty("--spire-fit-w");
  head.style.removeProperty("--bubble-fit-w");
  head.style.removeProperty("--stage-extra");
  head.classList.remove("v-stage--no-spire", "v-stage--free-bubble");
  // A hidden tab has no layout; it is fitted when it is shown.
  if (head.getBoundingClientRect().width === 0) return;
  fitSpire(head);
  fitBalloon(head);
  // Last word: the balloon and the tower never touch.
  const tower = drawnRect(head.querySelector(".v-spire"));
  const bubble = head.querySelector(".v-bubble");
  const slotEl = head.querySelector(".v-duel-gap");
  const line = bubble instanceof HTMLElement && slotEl && bubble.offsetWidth > 0 ? balloonBox(bubble, slotEl) : null;
  if (tower && line && crowds(line, tower)) head.classList.add("v-stage--no-spire");
}

/**
 * Re-fits every visible stage header.
 * @param {ParentNode} [root]
 */
export function fitStages(root = document) {
  root.querySelectorAll(".panel-head.v-has-stage").forEach((head) => {
    if (head instanceof HTMLElement) fitStage(head);
  });
}

/** Width each header was last fitted at; a fit may change only its height. */
const fittedWidth = new WeakMap();

/**
 * Re-fits a header when its width changes, including when its tab is shown.
 * Height changes are ignored: growing the header is one of the fit's own
 * moves, and reacting to it would loop.
 */
const stageResizeObserver =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        entries.forEach((entry) => {
          const head = entry.target;
          if (!(head instanceof HTMLElement)) return;
          const width = Math.round(entry.contentRect.width);
          if (fittedWidth.get(head) === width) return;
          fittedWidth.set(head, width);
          fitStage(head);
        });
      })
    : null;

/**
 * Turns the panel heads of the given tabs into stages. Adds the scenery
 * container once; safe to call repeatedly.
 * @param {ReadonlyArray<string>} tabs
 */
export function ensureStageMounts(tabs) {
  tabs.forEach((tab) => {
    const head = document.querySelector(`.tab-panel[data-tab="${tab}"] > .panel-head`);
    if (!head || head.querySelector(":scope > .v-stage-bg")) return;
    const backdrop = document.createElement("div");
    backdrop.className = "v-stage-bg";
    head.classList.add("v-has-stage");
    head.prepend(backdrop);
    if (stageResizeObserver) stageResizeObserver.observe(head);
  });
  // The display face changes the title's width once it arrives.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => fitStages()).catch(() => {});
  }
}

/**
 * Repaints every mounted stage from the same model.
 * @param {StageModel} model
 */
export function renderStage(model) {
  const html = stageBackdropHtml(model);
  document.querySelectorAll(".v-stage-bg").forEach((backdrop) => {
    // The 60-second background refresh calls this with unchanged data;
    // rewriting identical markup would restart every flame animation.
    if (painted.get(backdrop) === html) return;
    backdrop.innerHTML = html;
    painted.set(backdrop, html);
  });
  fitStages();
}
