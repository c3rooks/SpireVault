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
import { pickScene, sceneFarHtml, sceneMidHtml } from "./stage-scenes.js?v=1";

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
 * The spire's marker: a chip beside the tower's foot that says what the lit
 * windows count, in the words Overview uses for the same number. It lives in
 * the near layer, so the figures in front of the tower never cover it.
 * @param {number} hiLevel
 * @returns {string}
 */
function spireCaptionHtml(hiLevel) {
  if (hiLevel < 0) return "";
  return `<span class="v-stage-cap v-spire-cap" aria-hidden="true">Highest <b>A${hiLevel}</b></span>`;
}

/**
 * The torches' marker: how many runs the row covers and how many were won.
 * @param {number} runCount  torches drawn, at least 1
 * @param {number} wins
 * @returns {string}
 */
function torchCaptionHtml(runCount, wins) {
  const text = runCount === 1 ? `Last run <b>${wins === 1 ? "won" : "lost"}</b>` : `Last ${runCount} runs <b>${wins} won</b>`;
  return `<span class="v-stage-cap" aria-hidden="true">${text}</span>`;
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
      ${torchCaptionHtml(runs.length, wins)}
    </div>`;
}

/**
 * @typedef {Object} StageModel
 * @property {number} hiLevel   highest ascension reached, -1 when none
 * @property {number} [cap]     top ascension level (defaults to 10)
 * @property {ReadonlyArray<{ won: boolean, label?: string }>} [recent]  last runs, oldest → newest
 * @property {string} [scene]   scenery id (stage-scenes.js); defaults to this page load's random pick
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
  const scene = model.scene || pickScene();
  return `
    <div class="v-stage-layer v-stage-far">
      ${sceneFarHtml(scene)}
      ${spireHtml(hiLevel, cap)}
    </div>
    <div class="v-stage-layer v-stage-mid" aria-hidden="true">
      ${sceneMidHtml(scene)}
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
 *   headX   where the head is across the figure's box, 0 (left) to 1: the
 *           speech balloon's tail points there
 *   seat    for seated poses: the stone the climber rests on, as fractions of
 *           the figure's own box (the art is cropped tight, so y = 1 is the
 *           ground). Drawn behind the figure.
 *   footY   where the feet are down the figure's box, 0 (top) to 1 (bottom
 *           edge, the default). Only for art whose lowest point is not a
 *           foot: the Architect's staff tip hangs below his boots, so placing
 *           the art's bottom edge on the ground left him standing higher than
 *           the climber. The feet go on the shared ground line; whatever
 *           hangs lower is planted just in front of it.
 */
const ACTOR_STAGING = Object.freeze({
  ironclad: Object.freeze({ height: 0.52, headX: 0.57, seat: Object.freeze({ left: -0.04, top: 0.5, width: 0.6, height: 0.44 }) }),
  silent: Object.freeze({ height: 0.54, headX: 0.47, seat: Object.freeze({ left: 0.02, top: 0.52, width: 0.62, height: 0.4 }) }),
  defect: Object.freeze({ height: 0.48, headX: 0.43 }),
  regent: Object.freeze({ height: 0.58, headX: 0.7 }),
  necrobinder: Object.freeze({ height: 0.55, headX: 0.37, seat: Object.freeze({ left: -0.02, top: 0.56, width: 0.66, height: 0.36 }) }),
  fool: Object.freeze({ height: 0.5, headX: 0.55 }),
  architect: Object.freeze({ height: 0.67, headX: 0.66, footY: 0.922 }),
});
const FALLBACK_STAGING = Object.freeze({
  climber: Object.freeze({ height: 0.52, headX: 0.5 }),
  boss: Object.freeze({ height: 0.67, headX: 0.5 }),
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

/** The figure-size properties duelHtml() writes for the climber. */
const DUEL_SIZE_PROPS = Object.freeze(["--climber-h", "--climber-aspect"]);

/**
 * The two numbers CSS sizes a climber from, for any climber id.
 * @param {string} id
 * @returns {{ height: string, aspect: string }}
 */
function climberSizing(id) {
  const art = actorArt(id);
  const staging = Object.prototype.hasOwnProperty.call(ACTOR_STAGING, id) ? ACTOR_STAGING[id] : FALLBACK_STAGING.climber;
  const aspect = art ? art.width / art.height : FALLBACK_ASPECT;
  return { height: String(staging.height), aspect: aspect.toFixed(4) };
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
  const headX = typeof staging.headX === "number" ? staging.headX : 0.5;
  const footY = typeof staging.footY === "number" ? staging.footY : 1;
  return {
    height: staging.height,
    aspect: aspect.toFixed(4),
    headX: headX.toFixed(2),
    footY: footY.toFixed(3),
    html: `${shadow}${seat}${image}`,
  };
}

/**
 * @typedef {Object} DuelModel
 * @property {DuelActor & { ariaLabel: string, hint: string }} climber
 * @property {DuelActor} boss
 * @property {{ who: "climber" | "boss", text: string }} quote
 * @property {string} [longestLine]  the longest line this pairing can say;
 *   the header reserves room for it so a re-roll never changes its height
 * @property {ReadonlyArray<string>} [climberPool]  when the climber is rolled
 *   at random, every id the roll can pick (the header reserves for all)
 */

/**
 * The climber and the boss facing each other across a short gap, with the
 * speaker's line in a balloon above them (placed by fitStages()). Both
 * figures are buttons and answer the pointer the same way: the climber opens
 * the character picker, the boss says a line (`boss-speak`). The other
 * `data-action` hooks are the ones renderCompanion() has always used.
 * @param {DuelModel} model
 * @returns {string}
 */
export function duelHtml(model) {
  const climber = actorParts(model.climber, "climber");
  const boss = actorParts(model.boss, "boss");
  const speaker = model.quote.who === "climber" ? "climber" : "boss";
  const speakerLabel = speaker === "climber" ? model.climber.label : model.boss.label;
  const sizing = `--climber-h:${climber.height};--climber-aspect:${climber.aspect};--boss-h:${boss.height};--boss-aspect:${boss.aspect};--boss-foot:${boss.footY}`;
  return `
    <div class="v-duel v-duel--${speaker}-speaks" style="${sizing}"${model.longestLine ? ` data-longest-line="${esc(model.longestLine)}"` : ""}${model.climberPool && model.climberPool.length ? ` data-climber-pool="${esc(model.climberPool.join(" "))}"` : ""}>
      <button class="v-actor v-actor--climber" type="button" data-action="companion-toggle" data-head-x="${climber.headX}"
              aria-label="${esc(model.climber.ariaLabel)}" title="${esc(model.climber.hint)}">
        ${climber.html}
      </button>
      <button class="v-actor v-actor--boss" type="button" data-action="boss-speak" data-head-x="${boss.headX}" data-foot-y="${boss.footY}"
              aria-label="${esc(`${model.boss.label}. Tap for a line.`)}" title="${esc(`${model.boss.label}: tap for a line`)}">
        ${boss.html}
      </button>
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
const DUEL_GEOMETRY_PROPS = Object.freeze(["--climber-h", "--climber-aspect", "--boss-h", "--boss-aspect", "--boss-foot"]);

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

/** Air between the speaker's head and the tip of the balloon's tail. */
const TAIL_AIR_PX = 10;
/** Air kept above the other figure's head when the balloon spans it too. */
const HEAD_AIR_PX = 8;
/** Where the tail sits from the balloon's near end, when there is room. */
const TAIL_INSET_PX = 28;
/** The tail never sits closer than this to either end (the rounded corner). */
const TAIL_EDGE_PX = 18;
/** Widest balloon, and its share of a narrow header. */
const BUBBLE_MAX_PX = 360;
const BUBBLE_MAX_SHARE = 0.62;
/**
 * Header height the spire is worth on a phone, where the height is the page.
 * On wider screens it always stays unless the line fits nowhere else.
 */
const SPIRE_WORTH_PX = 32;
const PHONE_LAYOUT = "(max-width: 880px)";

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
 * Viewport x of a figure's head, from the head position duelHtml() wrote.
 * @param {HTMLElement} actor
 * @param {DOMRect} box
 */
function headX(actor, box) {
  const share = Number(actor.dataset.headX);
  return box.left + box.width * (share > 0 && share < 1 ? share : 0.5);
}

/**
 * The open stretch of the balloon's row around `x`: from the nearest blocker
 * on the left to the nearest on the right. Null when `x` itself is covered.
 * @param {number} x
 * @param {DOMRect[]} blockers
 * @param {number} minLeft
 * @param {number} maxRight
 * @returns {{ left: number, right: number } | null}
 */
function openSpan(x, blockers, minLeft, maxRight) {
  let left = minLeft;
  let right = maxRight;
  for (const r of blockers) {
    if (r.left - AIR_PX < x && r.right + AIR_PX > x) return null;
    // Half a pixel past the air, so rounding never puts the balloon within
    // AIR_PX of a blocker by the final crowds() check.
    if (r.right <= x) left = Math.max(left, r.right + AIR_PX + 0.5);
    else right = Math.min(right, r.left - AIR_PX - 0.5);
  }
  return right > left ? { left, right } : null;
}

/**
 * The lowest point the toolbar row reaches: the balloon stays under it.
 * Tabs that draw no toolbar here use the header's own top edge.
 * @param {HTMLElement} head
 */
function ceilingOf(head) {
  const row = [...head.querySelectorAll(".app-toolbar, .app-toolbar-empty, .panel-head-toprow > *")]
    .map(drawnRect)
    .filter(Boolean);
  const top = head.getBoundingClientRect().top;
  return row.reduce((low, r) => Math.max(low, r.bottom), top) + AIR_PX / 2;
}

/**
 * Places the speech balloon above the speaker's head, its tail pointing down
 * at them, on every screen size.
 *
 * It sits either just over the speaker (when that keeps it clear of the
 * other figure) or high enough to clear both heads, whichever needs less
 * room; it never covers the title, the torches, the spire or a figure. The
 * toolbar is the ceiling: when the line does not fit under it the header
 * grows, and since the figures stand on the ground (anchored to the header's
 * bottom) they and the balloon move down together.
 *
 * The growth is sized for the LONGEST line this pairing can say (the duel
 * carries it as data-longest-line), whoever says it, so the header is one
 * height at a given width: tapping for a new line never makes the page jump.
 *
 * Writes --bubble-left / --bubble-w / --bubble-bottom / --tail-x and
 * --stage-extra; components/stage.css lays the balloon out from them.
 * @param {HTMLElement} head
 * @returns {{ left: number, right: number, top: number, bottom: number } | null}
 *   where the balloon now is, for the final tower check
 */
function fitBalloon(head) {
  const duel = head.querySelector(".v-duel");
  const bubble = head.querySelector(".v-bubble");
  const textEl = head.querySelector(".v-bubble-text");
  const slotEl = head.querySelector(".v-duel-gap");
  const climberEl = head.querySelector(".v-actor--climber");
  const bossEl = head.querySelector(".v-actor--boss");
  if (!(duel instanceof HTMLElement) || !(bubble instanceof HTMLElement) || !slotEl || !textEl) return null;
  if (!(climberEl instanceof HTMLElement) || !(bossEl instanceof HTMLElement)) return null;
  if (!drawnRect(climberEl) || !drawnRect(bossEl)) return null;

  const headBox = head.getBoundingClientRect();
  const pad = getComputedStyle(head);
  const minLeft = headBox.left + parseFloat(pad.paddingLeft);
  const maxRight = headBox.right - parseFloat(pad.paddingRight);
  const cap = Math.min(BUBBLE_MAX_PX, (maxRight - minLeft) * BUBBLE_MAX_SHARE);
  const ceiling = ceilingOf(head);
  const scenery = () => [
    ...textRects(head, TITLE_TEXT),
    ...[...head.querySelectorAll(".v-torches svg, .v-torches .v-stage-cap, .v-spire, .v-spire-cap")]
      .map(drawnRect)
      .filter(Boolean),
  ];

  head.classList.add("v-stage--bubble-fit");
  /** @param {number} left @param {number} width */
  const lay = (left, width) => {
    head.style.setProperty("--bubble-left", `${(left - headBox.left).toFixed(1)}px`);
    head.style.setProperty("--bubble-w", `${Math.ceil(width)}px`);
  };

  /**
   * The best placement of the text now in the balloon, said by one side.
   * @param {boolean} bossSpeaks
   * @param {number} reserved  growth already committed (free to use)
   */
  const placeFor = (bossSpeaks, reserved) => {
    const climber = drawnRect(climberEl);
    const boss = drawnRect(bossEl);
    if (!climber || !boss) return null;
    const speaker = bossSpeaks ? boss : climber;
    const other = bossSpeaks ? climber : boss;
    const anchor = headX(bossSpeaks ? bossEl : climberEl, speaker);
    /** @param {number} bottom @param {DOMRect[]} blockers */
    const tryAt = (bottom, blockers) => {
      // Anything reaching up to within half the air of the balloon's bottom
      // edge is in its way too: sitting on a spire tip is still touching.
      const span = openSpan(anchor, blockers.filter((r) => r.top - AIR_PX / 2 < bottom), minLeft, maxRight);
      if (!span || span.right - span.left < BUBBLE_MIN_W_PX) return null;
      const room = Math.min(cap, span.right - span.left);
      lay(span.left, room);
      // Layout width, not the drawn box: the balloon scales in from 70% when
      // a line appears. +1 because offsetWidth rounds, and a pixel short
      // re-wraps.
      const width = Math.min(room, bubble.offsetWidth + 1);
      const height = bubble.offsetHeight;
      const wanted = bossSpeaks ? anchor + TAIL_INSET_PX - width : anchor - TAIL_INSET_PX;
      const left = Math.min(Math.max(wanted, span.left), span.right - width);
      const tail = Math.min(Math.max(anchor - left, TAIL_EDGE_PX), width - TAIL_EDGE_PX);
      return { bottom, left, width, height, tail, extra: Math.max(0, ceiling - (bottom - height)) };
    };
    const blockers = scenery();
    const near = tryAt(speaker.top - TAIL_AIR_PX, [...blockers, other]);
    const over = tryAt(Math.min(speaker.top - TAIL_AIR_PX, other.top - HEAD_AIR_PX), blockers);
    // Least growth beyond what is reserved; then fewer wrapped lines; then
    // the one nearer the speaker.
    const growth = (o) => Math.max(o.extra, reserved);
    const options = [near, over].filter(Boolean);
    options.sort((a, b) => growth(a) - growth(b) || a.height - b.height || b.bottom - a.bottom);
    return options[0] || null;
  };
  /**
   * Growth the longest line needs, whichever side says it — and, when the
   * climber is rolled at random (data-climber-pool), whichever climber is
   * standing there: each is sized in place for a moment and measured, so a
   * re-roll that brings a wider or shorter figure cannot change the height.
   */
  const steadyExtra = () => {
    const longest = duel.dataset.longestLine;
    if (!longest) return 0;
    const pool = (duel.dataset.climberPool || "").split(" ").filter(Boolean);
    const saved = DUEL_SIZE_PROPS.map((prop) => [prop, duel.style.getPropertyValue(prop), head.style.getPropertyValue(prop)]);
    const actual = textEl.textContent;
    textEl.textContent = longest;
    let worst = 0;
    for (const id of pool.length ? pool : [null]) {
      if (id) {
        const size = climberSizing(id);
        [["--climber-h", size.height], ["--climber-aspect", size.aspect]].forEach(([prop, value]) => {
          duel.style.setProperty(prop, value);
          head.style.setProperty(prop, value);
        });
      }
      for (const bossSpeaks of [false, true]) {
        const option = placeFor(bossSpeaks, 0);
        worst = Math.max(worst, option ? option.extra : 0);
      }
    }
    textEl.textContent = actual;
    saved.forEach(([prop, onDuel, onHead]) => {
      if (onDuel) duel.style.setProperty(prop, onDuel);
      else duel.style.removeProperty(prop);
      if (onHead) head.style.setProperty(prop, onHead);
      else head.style.removeProperty(prop);
    });
    return worst;
  };

  const bossSpeaks = duel.classList.contains("v-duel--boss-speaks");
  let reserved = steadyExtra();
  let best = placeFor(bossSpeaks, reserved);
  if ((!best || best.extra > reserved) && drawnRect(head.querySelector(".v-spire"))) {
    // The spire shows the player's ascension progress, so it gives way only
    // when the line fits nowhere else, or when keeping it would make the
    // header markedly taller (a phone, where the height is the page).
    const grownWith = best ? Math.max(best.extra, reserved) : Infinity;
    head.classList.add("v-stage--no-spire");
    const reservedWithout = steadyExtra();
    const without = placeFor(bossSpeaks, reservedWithout);
    const grownWithout = without ? Math.max(without.extra, reservedWithout) : Infinity;
    const worth = window.matchMedia(PHONE_LAYOUT).matches ? SPIRE_WORTH_PX : Infinity;
    if (without && (!best || grownWith - grownWithout >= worth)) {
      best = without;
      reserved = reservedWithout;
    } else {
      head.classList.remove("v-stage--no-spire");
    }
  }
  if (!best) {
    // Nothing fits anywhere (a header narrower than any phone): fall back to
    // the CSS placement rather than guess.
    head.classList.remove("v-stage--bubble-fit");
    return null;
  }
  lay(best.left, best.width);
  head.style.setProperty("--bubble-bottom", `${(headBox.bottom - best.bottom).toFixed(1)}px`);
  head.style.setProperty("--tail-x", `${best.tail.toFixed(1)}px`);
  head.style.setProperty("--stage-extra", `${Math.ceil(Math.max(best.extra, reserved))}px`);
  return balloonBox(bubble, slotEl);
}

/**
 * Lays out the scenery and the balloon of one stage header around what is
 * actually on it: this width, this climber, this tab's subtitle, this line.
 * Measured, not guessed, so it holds for every combination;
 * scripts/verify-stage-geometry.mjs checks the result.
 * @param {HTMLElement} head
 */
function fitStage(head) {
  ["--spire-fit-w", "--bubble-left", "--bubble-w", "--bubble-bottom", "--tail-x"].forEach((prop) =>
    head.style.removeProperty(prop)
  );
  // Explicitly none (not removed): stage.css reserves a typical amount until
  // the first fit, and the fit must measure from zero.
  head.style.setProperty("--stage-extra", "0px");
  head.classList.remove("v-stage--no-spire", "v-stage--bubble-fit");
  // A hidden tab has no layout; it is fitted when it is shown.
  if (head.getBoundingClientRect().width === 0) return;
  fitSpire(head);
  const line = fitBalloon(head);
  // Last word: the balloon and the tower never touch.
  const tower = drawnRect(head.querySelector(".v-spire"));
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
 *
 * It watches the border box: on wide screens the gutters absorb every extra
 * pixel, so the content box stops changing while the figures (placed from
 * the right edge) keep moving.
 */
const stageResizeObserver =
  typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        entries.forEach((entry) => {
          const head = entry.target;
          if (!(head instanceof HTMLElement)) return;
          const box = entry.borderBoxSize && entry.borderBoxSize[0];
          const width = Math.round(box ? box.inlineSize : head.getBoundingClientRect().width);
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
    if (stageResizeObserver) stageResizeObserver.observe(head, { box: "border-box" });
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
    if (backdrop instanceof HTMLElement) backdrop.dataset.scene = model.scene || pickScene();
  });
  fitStages();
}
