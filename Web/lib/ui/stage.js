// The Stage: the header diorama, drawn as layered, themeable scenery that
// doubles as a data display. Styles: styles/src/components/stage.css.
//
//   the tower      → a painted spire: its door lights once you have finished a
//                    run, a window per ascension up to your highest (A1–A10),
//                    and the brazier on its tip becomes a beacon at A10
//   torches        → the last ten runs, oldest on the left: a won run burns,
//                    a lost one stands cold with a thread of smoke. Where the
//                    header has open ground they march across it toward the
//                    tower, the newest nearest it, leading off from the title
//                    so the row joins the two; otherwise they stand under the
//                    title. Hover names the run and a click opens
//                    it; on a touch screen the row opens the Runs tab
//   the duel       → the climber and the boss, squared off on the ledge
//
// The duel reuses renderCompanion()'s state (which climber, which boss, which
// line) and its click handlers; only the markup is ours. The figures are the
// game's sprites re-inked for this stage by scripts/build-stage-sprites.mjs.

import { esc } from "./html.js?v=1";
import { STAGE_ACTOR_ART } from "./stage-actors.js?v=1";
import { STAGE_PROPS } from "./stage-props.js?v=1";
import { dealScene, peekScene, preloadScene, sceneFarHtml, sceneMidHtml, sceneTints } from "./stage-scenes.js?v=1";

const DEFAULT_ASCENSION_CAP = 10;
/** Hard ceiling on the ascension cap a save can claim, so a corrupt save
 *  cannot stretch the tower's levels into nonsense. */
const MAX_ASCENSION_CAP = 20;
const MAX_TORCHES = 10;

/** @type {WeakMap<Element, string>} markup last written to each backdrop */
const painted = new WeakMap();

/** @param {number} n  a fraction @returns {string} the same as a CSS percentage */
const pct = (n) => `${(n * 100).toFixed(2)}%`;

/**
 * The ascension each of the tower's ten windows stands for, bottom to top:
 * A1–A10 on the standard cap of 10; on a larger cap the windows share the
 * levels out evenly, so the top window is always the cap.
 * @param {number} index  0 = the lowest window
 * @param {number} cap
 */
function windowLevel(index, cap) {
  return Math.max(1, Math.round(((index + 1) * cap) / STAGE_PROPS.tower.windows.length));
}

/**
 * @param {number} hiLevel  highest ascension reached, -1 when none
 * @param {number} cap      top ascension level
 * @returns {string}
 */
function spireHtml(hiLevel, cap) {
  const tower = STAGE_PROPS.tower;
  const flame = STAGE_PROPS.flame;
  const count = tower.windows.length;
  const lit = tower.windows.map((_, i) => hiLevel >= windowLevel(i, cap));
  const peak = lit.lastIndexOf(true);
  const windows = tower.windows
    .map((y, i) => `<span class="v-spire-win${lit[i] ? " is-lit" : ""}${i === peak ? " is-peak" : ""}" style="top:${pct(y)}"></span>`)
    .join("");
  const door = hiLevel >= 0 ? `<span class="v-spire-door"></span>` : "";
  const beacon =
    hiLevel >= cap
      ? `<span class="v-spire-beacon"><span class="v-spire-beacon-glow"></span><img class="v-spire-beacon-flame" src="${flame.src}" width="${flame.width}" height="${flame.height}" alt="" decoding="async"></span>`
      : "";
  const label =
    hiLevel >= cap
      ? `The tower is lit to its beacon: ascension ${hiLevel} of ${cap}, your highest reached.`
      : hiLevel >= 0
        ? `The tower is lit to ascension ${hiLevel} of ${cap}, your highest reached.`
        : "The tower is dark. Finish a run to light its door.";
  const geometry = [
    `--spire-aspect:${(tower.width / tower.height).toFixed(4)}`,
    `--door-x:${pct(tower.door.x)}`, `--door-y:${pct(tower.door.y)}`, `--door-w:${pct(tower.door.w)}`, `--door-h:${pct(tower.door.h)}`,
    `--win-x:${pct(tower.window.x)}`, `--win-w:${pct(tower.window.w)}`, `--win-h:${pct(tower.window.h)}`,
    `--brazier-x:${pct(tower.brazier.x)}`, `--brazier-y:${pct(tower.brazier.y)}`, `--brazier-w:${pct(tower.brazier.w)}`,
  ].join(";");
  return `
    <div class="v-spire" role="img" aria-label="${esc(label)}" title="${esc(label)}" style="${geometry}" data-windows="${count}">
      <img class="v-spire-art" src="${tower.src}" width="${tower.width}" height="${tower.height}" alt="" decoding="async">
      ${door}${windows}${beacon}
    </div>`;
}

/**
 * The spire's marker: a caption under the tower's foot, on the ledge, that
 * says what the lit windows count, in the words Overview uses for the same
 * number. It lives in the near layer, so the figures never cover it.
 * @param {number} hiLevel
 * @returns {string}
 */
function spireCaptionHtml(hiLevel) {
  if (hiLevel < 0) return "";
  return `<span class="v-stage-cap v-spire-cap" aria-hidden="true">Highest <b>A${hiLevel}</b></span>`;
}

/**
 * The torches' marker, a caption centred under the row: how many runs it
 * covers and how many were won. The won count carries the same painted flame
 * the won runs' torches burn with, so the lit torches read as that number.
 * @param {number} runCount  torches drawn, at least 1
 * @param {number} wins
 * @returns {string}
 */
function torchCaptionHtml(runCount, wins) {
  const flame = STAGE_PROPS.flame;
  const mark = wins > 0 ? `<img class="v-stage-cap-flame" src="${flame.src}" width="${flame.width}" height="${flame.height}" alt="" decoding="async">` : "";
  const text = runCount === 1 ? `Last run ${mark}<b>${wins === 1 ? "won" : "lost"}</b>` : `Last ${runCount} runs ${mark}<b>${wins} won</b>`;
  return `<span class="v-stage-cap" aria-hidden="true">${text}</span>`;
}

/**
 * @typedef {{ won: boolean, id?: string | number, label?: string, floor?: number, date?: string }} StageRun
 */

/**
 * One torch: a painted standing torch, burning when the run was won, cold and
 * smoking when it was lost. Hovering it rewrites the plate under the row (the
 * "Last 10 runs" caption) to name that run; a click opens it.
 * @param {StageRun} run @param {number} index @param {boolean} newest
 */
function torchHtml(run, index, newest) {
  const torch = STAGE_PROPS.torch;
  const flame = STAGE_PROPS.flame;
  const where = [Number.isFinite(run.floor) ? `floor ${run.floor}` : "", run.date || ""].filter(Boolean).join(" · ");
  const plate = [
    newest ? "<b class=\"v-torch-new\">Newest</b>" : "",
    esc(run.label || `Run ${index + 1}`),
    `<b class="${run.won ? "is-won" : "is-lost"}">${run.won ? "Victory" : "Defeat"}</b>`,
    where ? esc(where) : "",
  ].filter(Boolean).join(" ");
  const top = run.won
    ? `<span class="v-torch-glow"></span><img class="v-torch-flame" src="${flame.src}" width="${flame.width}" height="${flame.height}" alt="" decoding="async">`
    : `<span class="v-torch-smoke" aria-hidden="true"><i></i><i></i><i></i></span>`;
  const id = run.id !== undefined && run.id !== null && run.id !== "" ? ` data-run-id="${esc(String(run.id))}"` : "";
  return `
        <span class="v-torch ${run.won ? "is-won" : "is-lost"}${newest ? " is-newest" : ""}" style="--d:${index}"${id}>
          ${top}<img class="v-torch-post" src="${torch.src}" width="${torch.width}" height="${torch.height}" alt="" decoding="async">
          <span class="v-stage-cap v-torch-tip">${plate}</span>
        </span>`;
}

/**
 * @param {ReadonlyArray<StageRun>} recent  oldest → newest
 * @returns {string}
 */
function torchesHtml(recent) {
  const runs = recent.slice(-MAX_TORCHES);
  if (runs.length === 0) return "";
  const wins = runs.filter((run) => run.won).length;
  const noun = runs.length === 1 ? "run" : "runs";
  const label = `Last ${runs.length} ${noun}: ${wins} won, ${runs.length - wins} lost. Open your runs.`;
  return `
    <div class="v-torches" style="--torch-count:${runs.length};--flame-base:${STAGE_PROPS.torch.flameBase};--torch-aspect:${(STAGE_PROPS.torch.width / STAGE_PROPS.torch.height).toFixed(4)}">
      <button class="v-torch-row" type="button" data-stage-runs aria-label="${esc(label)}">${runs.map((run, i) => torchHtml(run, i, i === runs.length - 1)).join("")}</button>
      ${torchCaptionHtml(runs.length, wins)}
    </div>`;
}

/**
 * @typedef {Object} StageModel
 * @property {number} hiLevel   highest ascension reached, -1 when none
 * @property {number} [cap]     top ascension level (defaults to 10)
 * @property {ReadonlyArray<{ won: boolean, label?: string }>} [recent]  last runs, oldest → newest
 * @property {string} [scene]   scenery id (stage-scenes.js) for every stage; by default each stage
 *                              is dealt its own, a new one each time its tab is shown
 */

/**
 * Builds the scenery markup for one stage.
 * @param {StageModel} model
 * @param {string | null} [sceneId]  the scene to draw; null draws the data on the plain sky
 * @returns {string}
 */
export function stageBackdropHtml(model, sceneId = null) {
  const hiLevel = Number.isFinite(model.hiLevel)
    ? Math.min(MAX_ASCENSION_CAP, Math.max(-1, Math.floor(model.hiLevel)))
    : -1;
  const cap = Math.min(MAX_ASCENSION_CAP, Math.max(DEFAULT_ASCENSION_CAP, Math.floor(model.cap || 0), hiLevel));
  const scene = model.scene || sceneId;
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
 *   glows   the figure's own lights, alive on the art: x, y as fractions of
 *           its box, r a fraction of its width; a flame flickers, eyes and
 *           cores breathe. Placed on the built art (stage-actors.js), so they
 *           move if the art is redrawn.
 */
const glow = (x, y, r, color, pulse = "breathe") => Object.freeze({ x, y, r, color, pulse });
const ACTOR_STAGING = Object.freeze({
  ironclad: Object.freeze({
    height: 0.52,
    headX: 0.57,
    seat: Object.freeze({ left: -0.04, top: 0.5, width: 0.6, height: 0.44 }),
    glows: Object.freeze([glow(0.53, 0.165, 0.08, "#ff3a2a")]),
  }),
  silent: Object.freeze({
    height: 0.56,
    headX: 0.3,
    seat: Object.freeze({ left: 0.34, top: 0.5, width: 0.64, height: 0.43 }),
    glows: Object.freeze([glow(0.255, 0.215, 0.075, "#f2ff5a")]),
  }),
  defect: Object.freeze({
    height: 0.48,
    headX: 0.42,
    glows: Object.freeze([glow(0.415, 0.115, 0.09, "#6fe6ff"), glow(0.42, 0.43, 0.1, "#4fd8ff")]),
  }),
  regent: Object.freeze({ height: 0.58, headX: 0.56, glows: Object.freeze([glow(0.555, 0.37, 0.07, "#ffe04a")]) }),
  necrobinder: Object.freeze({
    height: 0.55,
    headX: 0.27,
    seat: Object.freeze({ left: 0.02, top: 0.58, width: 0.62, height: 0.34 }),
    glows: Object.freeze([glow(0.33, 0.19, 0.07, "#4aa8ff")]),
  }),
  fool: Object.freeze({ height: 0.5, headX: 0.55, glows: Object.freeze([glow(0.565, 0.185, 0.09, "#b8ff5a")]) }),
  architect: Object.freeze({
    height: 0.67,
    headX: 0.66,
    footY: 0.922,
    glows: Object.freeze([glow(0.12, 0.215, 0.13, "#5cb8ff", "flicker")]),
  }),
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
  const headX = typeof staging.headX === "number" ? staging.headX : 0.5;
  return { height: String(staging.height), aspect: aspect.toFixed(4), headX: headX.toFixed(2) };
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
    html: `${shadow}${seat}${image}${art ? glowsHtml(staging.glows) : ""}`,
  };
}

/** How long one beat of a figure's glow lasts, by how it moves. */
const GLOW_PACE = Object.freeze({ breathe: 3.4, flicker: 1.7 });

/**
 * A figure's own lights, in one layer over the art that breathes and lifts
 * with it (components/stage.css). None for art without glows.
 * @param {ReadonlyArray<{ x: number, y: number, r: number, color: string, pulse: string }> | undefined} glows
 */
function glowsHtml(glows) {
  if (!glows || glows.length === 0) return "";
  const spans = glows
    .map((g, index) => {
      const pulse = g.pulse === "flicker" ? "flicker" : "breathe";
      const delay = (-index * 0.9).toFixed(1);
      return `<span class="v-actor-glow" data-pulse="${pulse}" style="--x:${percent(g.x)};--y:${percent(g.y)};--r:${g.r};--c:${esc(g.color)};--t:${GLOW_PACE[pulse]}s;--d:${delay}s"></span>`;
    })
    .join("");
  return `<span class="v-actor-glows" aria-hidden="true">${spans}</span>`;
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
/**
 * Below this the tower stops reading as a tower; leave it out instead.
 * Wider layouts set it as a height (the old vector tower's 46px width at its
 * 120:230 shape), turned into a width through the painting's own, slimmer
 * proportions: the same tower is narrower, not smaller. Phones keep the old
 * 46px: squeezed narrower there, the slim tower stays tall enough to change
 * where the speech balloon fits from one line to the next, and a re-roll
 * must never change the header's height.
 */
const SPIRE_MIN_H_PX = 88;
const SPIRE_MIN_W_PHONE_PX = 46;
function spireMinWidth() {
  return window.matchMedia(PHONE_LAYOUT).matches
    ? SPIRE_MIN_W_PHONE_PX
    : Math.round((SPIRE_MIN_H_PX * STAGE_PROPS.tower.width) / STAGE_PROPS.tower.height);
}
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
    ...[...head.querySelectorAll(".v-torch-row, .v-torches > .v-stage-cap")].map(drawnRect).filter(Boolean),
  ];
  const leftLimit = blockers
    .filter((r) => r.bottom > tower.top && r.top < tower.bottom)
    .reduce((limit, r) => Math.max(limit, r.right + AIR_PX), -Infinity);
  if (leftLimit <= tower.left) return;
  const room = tower.right - leftLimit;
  if (room < spireMinWidth()) {
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
 * Air kept between the toolbar row and the balloon's top: enough that the
 * balloon reads as the fight's, not as one more control beside Import.
 */
const CEILING_AIR_PX = 9;

/**
 * The lowest point the toolbar row reaches, plus that air: the balloon stays
 * under it. Tabs that draw no toolbar here use the header's own top edge.
 * @param {HTMLElement} head
 */
function ceilingOf(head) {
  const row = [...head.querySelectorAll(".app-toolbar, .app-toolbar-empty, .panel-head-toprow > *")]
    .map(drawnRect)
    .filter(Boolean);
  const top = head.getBoundingClientRect().top;
  return row.reduce((low, r) => Math.max(low, r.bottom), top) + CEILING_AIR_PX;
}

/** @type {Map<string, number>} steadyExtra() answers, by what they depend on */
const steadyKept = new Map();
const STEADY_KEPT_MAX = 64;
/** Header properties a fit writes that steadyExtra() does not read. */
const STEADY_IGNORED_PROPS = new Set(["--bubble-left", "--bubble-w", "--bubble-bottom", "--tail-x", "--stage-extra", ...DUEL_SIZE_PROPS]);

/**
 * Everything steadyExtra() reads, as one string: the header's width and the
 * window's, the look, theme and fonts, the header's classes and inline
 * properties as the fit has set them so far (spire width, torch march), the
 * toolbar, the title block, the tower and torches, the line it reserves
 * for, the climbers it sizes and the boss. Not the climber standing there
 * now (each one in the pool is sized in turn) nor the line said now.
 * @param {HTMLElement} head
 * @param {HTMLElement} duel
 * @param {HTMLElement} climberEl
 * @param {HTMLElement} bossEl
 * @param {number} width
 * @returns {string}
 */
function steadyInputs(head, duel, climberEl, bossEl, width) {
  const root = document.documentElement;
  const props = [];
  for (let i = 0; i < head.style.length; i += 1) {
    const prop = head.style[i];
    if (!STEADY_IGNORED_PROPS.has(prop)) props.push(`${prop}:${head.style.getPropertyValue(prop)}`);
  }
  const stage = head.querySelector(".panel-head-stage");
  const slot = head.querySelector(".companion-slot");
  const parts = [
    Math.round(width),
    window.innerWidth,
    window.innerHeight,
    root.className,
    root.getAttribute("data-ui"),
    root.getAttribute("data-theme"),
    root.getAttribute("data-steam"),
    document.fonts ? document.fonts.status : "",
    [...head.classList].filter((name) => name !== "v-stage--bubble-fit" && name !== "v-stage-off").join(" "),
    props.sort().join(";"),
    duel.dataset.longestLine || "",
    duel.dataset.climberPool || "",
    ["--boss-h", "--boss-aspect", "--boss-foot"].map((prop) => duel.style.getPropertyValue(prop)).join(","),
    // A rolled climber is sized from the pool, head and all; a chosen one
    // stands as it is.
    duel.dataset.climberPool ? "" : climberEl.dataset.headX || "",
    bossEl.dataset.headX || "",
    stage && slot ? stage.outerHTML.replace(slot.outerHTML, "") : stage ? stage.outerHTML : "",
  ];
  head.querySelectorAll(":scope > :not(.v-stage-bg):not(.panel-head-stage)").forEach((el) => parts.push(el.outerHTML));
  head.querySelectorAll(".v-stage-bg .v-spire, .v-stage-bg .v-spire-beacon, .v-stage-bg .v-spire-cap, .v-stage-bg .v-torches").forEach((el) => {
    parts.push(el.outerHTML);
  });
  return parts.join("\n");
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
 * Writes --bubble-left / --bubble-w / --bubble-bottom / --tail-x on the
 * balloon's slot (.v-duel-gap) and --stage-extra on the header;
 * components/stage.css lays the balloon out from them.
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
  // --stage-extra raises the header's min-height, but a title block taller
  // than that minimum (a long subtitle, the "climbers active" line on a
  // phone) already holds the header open: the first `slack` pixels of extra
  // would grow nothing, and the balloon would sit that much higher than
  // planned, into the toolbar or over the subtitle. Measured with the extra
  // at zero (fitStage sets it), and added to whatever growth the balloon
  // asks for.
  const slack = Math.max(0, headBox.height - (parseFloat(pad.minHeight) || 0));
  const scenery = () => [
    ...textRects(head, TITLE_TEXT),
    ...[...head.querySelectorAll(".v-torch-row, .v-torches > .v-stage-cap, .v-spire, .v-spire-beacon, .v-spire-cap")]
      .map(drawnRect)
      .filter(Boolean),
  ];

  head.classList.add("v-stage--bubble-fit");
  // Each trial below writes the balloon's slot and reads the balloon back.
  // The slot's own inline properties re-style only the slot and the balloon;
  // the same write on the header would re-style every element in it (the
  // scene, its life, the figures) before each read, which made a fit cost a
  // fifth of a second on a laptop and over a second on a phone.
  /** @param {number} left @param {number} width */
  const lay = (left, width) => {
    slotEl.style.setProperty("--bubble-left", `${(left - headBox.left).toFixed(1)}px`);
    slotEl.style.setProperty("--bubble-w", `${Math.ceil(width)}px`);
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
    const actualHeadX = climberEl.dataset.headX;
    textEl.textContent = longest;
    let worst = 0;
    for (const id of pool.length ? pool : [null]) {
      if (id) {
        const size = climberSizing(id);
        [["--climber-h", size.height], ["--climber-aspect", size.aspect]].forEach(([prop, value]) => {
          duel.style.setProperty(prop, value);
          head.style.setProperty(prop, value);
        });
        // Each climber's own head, where the balloon's tail would point.
        climberEl.dataset.headX = size.headX;
      }
      for (const bossSpeaks of [false, true]) {
        const option = placeFor(bossSpeaks, 0);
        worst = Math.max(worst, option ? option.extra : 0);
      }
    }
    textEl.textContent = actual;
    if (actualHeadX === undefined) delete climberEl.dataset.headX;
    else climberEl.dataset.headX = actualHeadX;
    saved.forEach(([prop, onDuel, onHead]) => {
      if (onDuel) duel.style.setProperty(prop, onDuel);
      else duel.style.removeProperty(prop);
      if (onHead) head.style.setProperty(prop, onHead);
      else head.style.removeProperty(prop);
    });
    return worst;
  };
  /**
   * steadyExtra() with its answer kept: it sizes every climber the roll can
   * pick, and each one re-styles the whole header, so it is the bulk of a
   * fit. Its answer does not depend on who stands there now or on the line
   * now in the balloon, so a re-roll, a new line or a tab opened again at
   * the same width reuses it.
   */
  const steadyExtraKept = () => {
    const key = steadyInputs(head, duel, climberEl, bossEl, headBox.width);
    const kept = steadyKept.get(key);
    if (kept !== undefined) return kept;
    const worst = steadyExtra();
    steadyKept.set(key, worst);
    if (steadyKept.size > STEADY_KEPT_MAX) steadyKept.delete(steadyKept.keys().next().value);
    return worst;
  };

  const bossSpeaks = duel.classList.contains("v-duel--boss-speaks");
  let reserved = steadyExtraKept();
  let best = placeFor(bossSpeaks, reserved);
  if ((!best || best.extra > reserved) && drawnRect(head.querySelector(".v-spire"))) {
    // The spire shows the player's ascension progress, so it gives way only
    // when the line fits nowhere else, or when keeping it would make the
    // header markedly taller (a phone, where the height is the page).
    const grownWith = best ? Math.max(best.extra, reserved) : Infinity;
    head.classList.add("v-stage--no-spire");
    const reservedWithout = steadyExtraKept();
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
  slotEl.style.setProperty("--bubble-bottom", `${(headBox.bottom - best.bottom).toFixed(1)}px`);
  slotEl.style.setProperty("--tail-x", `${best.tail.toFixed(1)}px`);
  const growth = Math.max(best.extra, reserved);
  head.style.setProperty("--stage-extra", `${growth > 0 ? Math.ceil(growth + slack) : 0}px`);
  return balloonBox(bubble, slotEl);
}

/** What a fit writes: inline properties (header or balloon slot) and classes. */
const FIT_OUTPUT_PROPS = Object.freeze([
  "--spire-fit-w", "--torch-step-fit", "--torches-left", "--bubble-left", "--bubble-w", "--bubble-bottom", "--tail-x",
]);
const FIT_OUTPUT_CLASSES = Object.freeze(["v-stage--no-spire", "v-stage--no-spire-cap", "v-stage--bubble-fit", "v-stage--march"]);
const FIT_IGNORED_PROPS = new Set([...FIT_OUTPUT_PROPS, "--stage-extra"]);
/** @type {WeakMap<HTMLElement, string>} what each header looked like at its last fit */
const fitInputsOf = new WeakMap();

/**
 * An element's inline style without what the fit itself writes, in a fixed
 * order (a fit removes and restores properties, which can reorder them).
 * @param {HTMLElement} el
 */
function inlineInputs(el) {
  const out = [];
  for (let i = 0; i < el.style.length; i += 1) {
    const prop = el.style[i];
    if (!FIT_IGNORED_PROPS.has(prop)) out.push(`${prop}:${el.style.getPropertyValue(prop)}`);
  }
  return out.sort().join(";");
}

/**
 * Everything a fit of this header reads, as one string: its width and the
 * window's, the look, theme and fonts, and the markup of what stands in it
 * (toolbar, title block, figures, balloon text, tower, torches) minus what
 * the last fit wrote. The scene and its life are left out: they never block
 * anything, and a new scene is dealt each time a tab opens.
 * @param {HTMLElement} head
 * @param {number} width
 * @returns {string}
 */
function fitInputs(head, width) {
  const root = document.documentElement;
  const slot = head.querySelector(".v-duel-gap");
  const slotStyle = slot ? slot.getAttribute("style") : null;
  const parts = [
    Math.round(width),
    window.innerWidth,
    window.innerHeight,
    root.className,
    root.getAttribute("data-ui"),
    root.getAttribute("data-theme"),
    root.getAttribute("data-steam"),
    document.fonts ? document.fonts.status : "",
    // .v-stage-off only pauses the scene while it is scrolled away.
    [...head.classList].filter((name) => !FIT_OUTPUT_CLASSES.includes(name) && name !== "v-stage-off").join(" "),
    inlineInputs(head),
  ];
  head.querySelectorAll(":scope > :not(.v-stage-bg)").forEach((el) => {
    let html = el.outerHTML;
    if (slotStyle) html = html.replace(` style="${slotStyle.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`, "");
    parts.push(html);
  });
  head.querySelectorAll(".v-stage-bg .v-spire, .v-stage-bg .v-spire-beacon, .v-stage-bg .v-spire-cap, .v-stage-bg .v-torches").forEach((el) => {
    parts.push(el.outerHTML);
  });
  return parts.join("\n");
}

/**
 * Lays out the scenery and the balloon of one stage header around what is
 * actually on it: this width, this climber, this tab's subtitle, this line.
 * Measured, not guessed, so it holds for every combination;
 * scripts/verify-stage-geometry.mjs checks the result.
 *
 * A fit measures the header dozens of times, so it is skipped when nothing
 * it depends on has changed since the last one (fitInputs): the page asks
 * for a fit several times while it boots, and again each time a tab is
 * shown, usually with the header exactly as it was.
 * @param {HTMLElement} head
 */
function fitStage(head) {
  // A hidden tab has no layout. Its last fit stays as it was; the resize
  // observer fits it again when it is shown, if anything changed meanwhile.
  const width = head.getBoundingClientRect().width;
  if (width === 0) return;
  const inputs = fitInputs(head, width);
  if (fitInputsOf.get(head) === inputs) return;
  const slot = head.querySelector(".v-duel-gap");
  FIT_OUTPUT_PROPS.forEach((prop) => {
    head.style.removeProperty(prop);
    if (slot instanceof HTMLElement) slot.style.removeProperty(prop);
  });
  // Explicitly none (not removed): stage.css reserves a typical amount until
  // the first fit, and the fit must measure from zero.
  head.style.setProperty("--stage-extra", "0px");
  head.classList.remove(...FIT_OUTPUT_CLASSES);
  fitSpire(head);
  fitTorches(head);
  const line = fitBalloon(head);
  // Last word: the balloon and the tower (with its A10 beacon) never touch.
  const tower = [head.querySelector(".v-spire"), head.querySelector(".v-spire-beacon")].map(drawnRect).filter(Boolean);
  if (line && tower.some((part) => crowds(line, part))) head.classList.add("v-stage--no-spire");
  fitSpireCaption(head);
  fitInputsOf.set(head, inputs);
}

/** Air kept between the tower's caption and the torches' row and caption. */
const SPIRE_CAP_AIR_PX = 8;

/**
 * The marching row's spacing (one torch per step; stage.css draws a torch
 * 1.75 steps tall). Below the least there is not room to march and the
 * torches stay under the title; above the most they would outgrow the
 * figures.
 */
const MARCH_STEP_MIN_PX = 28;
const MARCH_STEP_MAX_PX = 40;
/** How far above the ground a torch reaches, flame included, in steps. */
const TORCH_REACH_STEPS = 2.3;
/** Ground kept between the row and the tower's foot, and after the title text. */
const MARCH_TOWER_GAP_PX = 28;
const MARCH_TEXT_GAP_PX = 40;
/**
 * The least extra ground the marching row leaves before the tower (on top
 * of MARCH_TOWER_GAP_PX) when the title side is short, so it still reads as
 * leading off toward the title rather than huddling at the tower's door.
 * Never more than the ground there is: the title keeps its own gap.
 */
const MARCH_LEAD_MIN_PX = 26;

/**
 * On a wide header the torches leave the title block and march across the
 * open ground toward the tower (or, when the tower is left out, the
 * climber), the newest nearest it, as large as the ground allows. The row
 * stands centred in that ground, so the header balances: hugging the tower,
 * it left the title's side bare and piled everything on the right. Where
 * they would not fit at a readable size, they stay under the title. Run
 * after fitSpire, so the row is measured from where the tower now stands.
 * Writes --torch-step-fit and --torches-left; components/stage.css lays the
 * row out from them.
 * @param {HTMLElement} head
 */
function fitTorches(head) {
  const torches = head.querySelector(".v-torches");
  const row = drawnRect(head.querySelector(".v-torch-row"));
  if (!(torches instanceof HTMLElement) || !row || window.matchMedia(PHONE_LAYOUT).matches) return;
  const frame = torches.offsetParent;
  const stop = drawnRect(head.querySelector(".v-spire")) || drawnRect(head.querySelector(".v-actor--climber .v-actor-art"));
  if (!(frame instanceof HTMLElement) || !stop) return;
  const count = Math.max(1, Number(torches.style.getPropertyValue("--torch-count")) || MAX_TORCHES);
  const ground = row.bottom;
  const reachTop = ground - MARCH_STEP_MAX_PX * TORCH_REACH_STEPS;
  const headBox = head.getBoundingClientRect();
  const start = textRects(head, TITLE_TEXT)
    .filter((r) => r.bottom > reachTop && r.top < ground)
    .reduce((edge, r) => Math.max(edge, r.right + MARCH_TEXT_GAP_PX), headBox.left + parseFloat(getComputedStyle(head).paddingLeft));
  // The tower's caption is centred under it and can reach further left than
  // its foot; the row's own caption must not run into it.
  const spireCap = drawnRect(head.querySelector(".v-spire-cap"));
  const end = Math.min(stop.left - MARCH_TOWER_GAP_PX, spireCap ? spireCap.left - SPIRE_CAP_AIR_PX * 2 : Infinity);
  const step = Math.min(MARCH_STEP_MAX_PX, Math.floor((end - start) / count));
  if (step < MARCH_STEP_MIN_PX) return;
  // Centred between the title text and the tower: the ground left over is
  // shared so the bare ground on both sides matches (start and end already
  // keep different minimum gaps, so half their difference moves it back).
  const spare = Math.max(0, end - start - step * count);
  const centred = (spare + MARCH_TEXT_GAP_PX - MARCH_TOWER_GAP_PX) / 2;
  const lead = Math.min(spare, Math.max(MARCH_LEAD_MIN_PX, centred));
  head.classList.add("v-stage--march");
  head.style.setProperty("--torch-step-fit", `${step}px`);
  head.style.setProperty("--torches-left", `${(end - step * count - lead - frame.getBoundingClientRect().left).toFixed(1)}px`);
}

/**
 * The tower's caption sits centred under it, on the same line as the
 * torches' caption. Where the tower stands close to the torches (a phone),
 * the caption would run into them: then only the caption goes, the tower
 * stays.
 * @param {HTMLElement} head
 */
function fitSpireCaption(head) {
  const caption = drawnRect(head.querySelector(".v-spire-cap"));
  if (!caption) return;
  const torches = [...head.querySelectorAll(".v-torch-row, .v-torches > .v-stage-cap")].map(drawnRect).filter(Boolean);
  const left = torches.reduce((edge, r) => Math.max(edge, r.right), -Infinity);
  if (caption.left < left + SPIRE_CAP_AIR_PX) head.classList.add("v-stage--no-spire-cap");
}

/** @type {Set<HTMLElement> | null} headers waiting for the fit at the end of this task */
let fitsDue = null;

/**
 * Re-fits every visible stage header, once, at the end of the current task.
 * Opening a tab paints its stage and then redraws its duel, and each asks
 * for a fit: fitting at the first ask measured the header around the old
 * climber, only to do it all again a moment later. A microtask still runs
 * before the browser draws, so the header is never seen unfitted.
 * @param {ParentNode} [root]
 */
export function fitStages(root = document) {
  if (!fitsDue) {
    fitsDue = new Set();
    queueMicrotask(() => {
      const heads = fitsDue;
      fitsDue = null;
      heads.forEach((head) => {
        if (head.isConnected) fitStage(head);
      });
    });
  }
  root.querySelectorAll(".panel-head.v-has-stage").forEach((head) => {
    if (head instanceof HTMLElement) fitsDue.add(head);
  });
}

/** Width each header was last fitted at; a fit may change only its height. */
const fittedWidth = new WeakMap();

// ---- Scenes: one per stage, a new one each time its tab is shown --------------

/** @type {WeakMap<Element, string>} the scene dealt to each backdrop */
const sceneOf = new WeakMap();
/** The tab last opened; opening a different one deals its stage a scene. */
let openTab = null;
/** @type {StageModel | null} the model last painted, to repaint one stage on its own */
let lastModel = null;
/** The inline tints a scene puts on its backdrop. */
const TINT_PROPS = Object.freeze(["--scene-deep", "--scene-haze", "--scene-accent", "--scene-veil", "--scene-mist"]);

/**
 * Fades the scene in once its picture has arrived (the header's own sky
 * shows until then), and starts fetching the scene the next tab will get.
 * @param {Element} backdrop
 */
function revealScene(backdrop) {
  const image = backdrop.querySelector(".v-scene-img");
  if (!(image instanceof HTMLImageElement)) return;
  const show = () => {
    image.classList.add("is-in");
    const idle = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 400));
    idle(() => preloadScene(peekScene()));
  };
  if (image.complete) {
    // Settled already (from cache): drawn, or broken before we could listen.
    if (image.naturalWidth > 0) show();
    else image.classList.add("is-missing");
    return;
  }
  image.addEventListener("load", show, { once: true });
  // A missing picture leaves the sky, the data and the figures as they are.
  image.addEventListener("error", () => image.classList.add("is-missing"), { once: true });
}

/**
 * Paints one backdrop from the model with the scene dealt to it.
 * @param {Element} backdrop
 * @param {StageModel} model
 */
function paintBackdrop(backdrop, model) {
  const scene = model.scene || sceneOf.get(backdrop) || null;
  const html = stageBackdropHtml(model, scene);
  // The 60-second background refresh calls this with unchanged data;
  // rewriting identical markup would restart every flame animation.
  if (painted.get(backdrop) === html) return;
  backdrop.innerHTML = html;
  painted.set(backdrop, html);
  if (backdrop instanceof HTMLElement) {
    if (scene) backdrop.dataset.scene = scene;
    else delete backdrop.dataset.scene;
    TINT_PROPS.forEach((prop) => backdrop.style.removeProperty(prop));
    Object.entries(sceneTints(scene)).forEach(([prop, value]) => backdrop.style.setProperty(prop, value));
  }
  revealScene(backdrop);
}

/**
 * Opening a tab deals its stage a new scene. script.js announces every tab
 * switch with a `spirevault:tab` event (before the panels swap), so this
 * needs no layout. Re-selecting the open tab changes nothing.
 * @param {Event} event
 */
function onTabOpened(event) {
  const tab = event instanceof CustomEvent && event.detail ? event.detail.tab : null;
  if (typeof tab !== "string" || tab === openTab) return;
  openTab = tab;
  if (!lastModel || lastModel.scene) return;
  const backdrop = document.querySelector(`.tab-panel[data-tab="${CSS.escape(tab)}"] > .panel-head > .v-stage-bg`);
  if (!backdrop) return;
  sceneOf.set(backdrop, dealScene());
  paintBackdrop(backdrop, lastModel);
}
if (typeof window !== "undefined") window.addEventListener("spirevault:tab", onTabOpened);

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
          // Hidden (0) fits nothing; shown again, fitStage re-fits only if
          // something the fit reads changed while the tab was away.
          if (width > 0) fitStage(head);
        });
      })
    : null;

/**
 * Pauses a header's scene while it is scrolled out of view (.v-stage-off;
 * components/stage.css). A running animation costs a style pass on every
 * frame the page draws, so on a phone the header's hundred-odd loops made
 * every frame of scrolling the tab below it slow, long after the header
 * itself had gone off the top.
 */
const stageOffscreenObserver =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          // A hidden tab reports no intersection too; it never draws anyway.
          entry.target.classList.toggle("v-stage-off", !entry.isIntersecting && entry.boundingClientRect.height > 0);
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
    // The stats tabs' markup already carries the class (index.html), so the
    // page paints with the stage's layout before this module arrives.
    head.classList.add("v-has-stage");
    head.prepend(backdrop);
    if (stageResizeObserver) stageResizeObserver.observe(head, { box: "border-box" });
    if (stageOffscreenObserver) stageOffscreenObserver.observe(head);
  });
  // The display face changes the title's width once it arrives.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => fitStages()).catch(() => {});
  }
}

/**
 * Repaints every mounted stage from the same data, each in its own scene. A
 * stage on screen that has no scene yet (the tab the page opened on) is
 * dealt one now; the others are dealt one when their tab is opened.
 * @param {StageModel} model
 */
export function renderStage(model) {
  lastModel = model;
  document.querySelectorAll(".v-stage-bg").forEach((backdrop) => {
    const panel = backdrop.closest(".tab-panel");
    const onScreen = panel instanceof HTMLElement && !panel.hidden;
    if (onScreen && !model.scene && !sceneOf.has(backdrop)) {
      sceneOf.set(backdrop, dealScene());
      if (panel.dataset.tab) openTab = panel.dataset.tab;
    }
    paintBackdrop(backdrop, model);
    // The tower's width follows its painting's proportions; the header sizes
    // the tower (and centres its caption) from this.
    backdrop.closest(".panel-head")?.style.setProperty("--spire-aspect", (STAGE_PROPS.tower.width / STAGE_PROPS.tower.height).toFixed(4));
  });
  fitStages();
}
