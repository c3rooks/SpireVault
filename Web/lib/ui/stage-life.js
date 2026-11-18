// The scenes' life: what moves in each painted room beyond its lights,
// shafts, air and mist (stage-scenes.js).
//
// Every scene gets its own (stage-life-list.js): the campfire throws its
// light across the standing stones and sends smoke up; the merchant's
// lanterns swing their light over the wares while coins and bottles catch
// it; honey drips in the hive; lava runs down the wastes; clouds drift
// above the clouds and the floating ruins bob. Now and then something
// happens: a crow crosses, bats leave the arches, a leaf falls, a draught
// dips the candles, lightning cracks over the volcano, a star falls.
//
// Two kinds of life:
//   - running life loops on its own in CSS (components/stage-life.css):
//     cast light, water, glints, drips, flows, drifting clouds, smoke.
//   - events wait, hidden, until the scheduler below plays one: every few
//     seconds it picks one event of the scene on screen and lets it run
//     once. Nothing happens on a hidden tab, in a hidden window, or under
//     reduced motion.
//
// Everything is placed in fractions of the picture and sized from the
// picture's width (--plate-w, set on the plate by stage-scenes.css), so it
// stays registered to the painting however the header crops it. Nothing
// follows the pointer. Markup only, apart from the scheduler.

import { esc } from "./html.js?v=1";
import { reduced } from "./motion.js?v=2";
import { LIFE_SPRITES } from "./stage-life-sprites.js?v=1";
import { STAGE_LIFE } from "./stage-life-list.js?v=1";
import { hex, num, pct, round, sequence } from "./stage-num.js?v=1";

/** @typedef {import("./stage-life-list.js").LifeItem} LifeItem */

/** The most members one item may draw, whatever the list asks for. */
const MAX_MEMBERS = 24;

/** How long the scene on screen waits before its first event, then between events (ms). */
const EVENT_GAP_MS = Object.freeze({ first: [2200, 4200], next: [5500, 12000] });

/** @param {number} n @param {number} lo @param {number} hi */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A count from the list, kept between 0 and MAX_MEMBERS. */
const count = (value, fallback = 1) => clamp(Math.floor(num(value, fallback)), 0, MAX_MEMBERS);

/** Inline box vars: left, top, width, height, as fractions of the picture. */
function boxVars(box) {
  const [l, t, r, b] = (Array.isArray(box) ? box : [0, 0, 1, 1]).map((edge) => clamp(num(edge), 0, 1));
  return `--bl:${pct(l)};--bt:${pct(t)};--bw:${pct(r - l)};--bh:${pct(b - t)};--bwf:${round(r - l, 4)}`;
}

/**
 * One painted sprite, sized by its parent.
 * @param {string} id
 * @param {string} [cls]
 */
function spriteImg(id, cls = "") {
  const sprite = LIFE_SPRITES[id];
  if (!sprite) return "";
  return `<img class="v-life-sprite${cls ? ` ${cls}` : ""}" src="${esc(sprite.src)}" width="${num(sprite.width)}" height="${num(sprite.height)}" alt="" decoding="async" draggable="false">`;
}

/** Height over width of a sprite, for sizing from either side. */
const spriteAspect = (id) => {
  const sprite = LIFE_SPRITES[id];
  return sprite ? round(sprite.height / sprite.width, 4) : 1;
};

// ---- Running life --------------------------------------------------------------

/**
 * Light a source throws onto the walls and floor round it: two soft washes
 * flickering on different beats, so the light never repeats. A swinging
 * lantern's light also sways about the lantern above it.
 * @param {LifeItem} item @param {() => number} next
 */
function castHtml(item, next) {
  const beats = { fire: [0.83, 1.37], candle: [1.9, 2.9], lantern: [3.1, 4.7], slow: [6.2, 9.1] };
  const [a, b] = beats[item.beat] || beats.slow;
  const swing = num(item.swing);
  const sway = swing ? `;--sw:${round(swing, 1)}deg;--py:${round(num(item.pivot, 0.5) * 100)}%;--sd:${round(4.5 + next() * 2.5)}s` : "";
  return `<span class="v-life-cast" data-beat="${esc(item.beat || "slow")}"${swing ? " data-swing" : ""} style="--x:${pct(num(item.x))};--y:${pct(num(item.y))};--cw:${pct(num(item.w, 0.1))};--ch:${pct(num(item.h, 0.2))};--c:${hex(item.color)};--k:${round(num(item.strength, 0.6))}${sway}"><i style="--dur:${a}s;--del:${round(-next() * a)}s"></i><i style="--dur:${b}s;--del:${round(-next() * b)}s"></i></span>`;
}

/** Water: two layers of glinting streaks rocking against each other. */
function rippleHtml(item) {
  return `<span class="v-life-ripple" style="${boxVars(item.box)};--c:${hex(item.color)};--k:${round(num(item.strength, 0.5))}"><i></i><i></i></span>`;
}

/** Glints: four-point sparkles flashing on gold, glass, crystal and ice. */
function glintHtml(item, next) {
  const points = (item.points || []).slice(0, MAX_MEMBERS);
  const size = num(item.size, 0.012);
  return points
    .map(([x, y]) => {
      const pace = round(4.5 + next() * 6);
      return `<i class="v-life-glint" style="--x:${pct(num(x))};--y:${pct(num(y))};--s:${round(size * (0.7 + next() * 0.6), 4)};--c:${hex(item.color)};--dur:${pace}s;--del:${round(-next() * pace)}s"></i>`;
    })
    .join("");
}

/** Drips: a drop swells at its tip, lets go, and rings the water it hits. */
function dripHtml(item, next) {
  const points = (item.points || []).slice(0, MAX_MEMBERS);
  return points
    .map(([x, y, fall]) => {
      const pace = round(num(item.pace, 5) * (0.8 + next() * 0.5));
      return `<span class="v-life-drip"${item.splash ? " data-splash" : ""} style="--x:${pct(num(x))};--y:${pct(num(y))};--fall:${pct(num(fall, 0.3))};--s:${round(num(item.size, 0.004), 4)};--c:${hex(item.color)};--dur:${pace}s;--del:${round(-next() * pace)}s"><span class="v-life-drip-path"><i class="v-life-drop"></i></span><i class="v-life-ring"></i></span>`;
    })
    .join("");
}

/** A flow: bands of light running down falls of honey, water or lava. */
function flowHtml(item) {
  const pace = round(num(item.pace, 4));
  return `<span class="v-life-flow" style="${boxVars(item.box)};--c:${hex(item.color)};--dur:${pace}s;--k:${round(num(item.strength, 0.5))}"><i></i></span>`;
}

/** A chain: glows along a path, lit one after another, so light runs along it. */
function chainHtml(item) {
  const points = (item.points || []).slice(0, MAX_MEMBERS);
  const pace = num(item.pace, 6);
  const step = pace / Math.max(points.length, 1) * num(item.spread, 0.5);
  const glows = points
    .map(([x, y], i) => `<i style="--x:${pct(num(x))};--y:${pct(num(y))};--del:${round(i * step - pace)}s"></i>`)
    .join("");
  return `<span class="v-life-chain" style="--r:${round(num(item.r, 0.02), 4)};--c:${hex(item.color)};--dur:${round(pace)}s">${glows}</span>`;
}

/**
 * Painted clouds drifting through a box, each at its own height, spaced so
 * one is always on its way. The box fades them in and out at its edges.
 * @param {LifeItem} item @param {() => number} next
 */
function driftHtml(item, next) {
  const n = count(item.count, 2);
  const pace = num(item.pace, 120);
  const size = num(item.size, 0.25);
  const [, top, , bottom] = (Array.isArray(item.box) ? item.box : [0, 0, 1, 0.5]).map((edge) => clamp(num(edge), 0, 1));
  const clouds = Array.from({ length: n }, (_, i) => {
    const scale = round(0.75 + next() * 0.5, 2);
    // Each cloud's top edge, somewhere in the upper part of the box.
    const y = top + next() * (bottom - top) * 0.7;
    return `<span class="v-life-drift-mv" style="--s:${round(size * scale, 4)};--sy:${pct(y)};--o:${round(num(item.opacity, 0.8) * (0.8 + next() * 0.2))};--dur:${round(pace / scale)}s;--del:${round(-((i + next() * 0.4) / n) * (pace / scale))}s">${spriteImg(item.sprite)}</span>`;
  }).join("");
  return `<span class="v-life-drift"${num(item.dir, 1) < 0 ? " data-reverse" : ""} style="${boxVars(item.box)}">${clouds}</span>`;
}

/** A painted thing floating in place: rising and settling, tilting a little. */
function floatHtml(item, next) {
  const pace = round(num(item.pace, 7) * (0.85 + next() * 0.3));
  return `<span class="v-life-float" style="--x:${pct(num(item.x))};--y:${pct(num(item.y))};--s:${round(num(item.size, 0.06), 4)};--dur:${pace}s;--del:${round(-next() * pace)}s">${spriteImg(item.sprite)}</span>`;
}

/** Smoke: soft puffs leaving a source, swelling and thinning as they rise. */
function smokeHtml(item, next) {
  const n = count(item.count, 5);
  const pace = num(item.pace, 7);
  const puffs = Array.from({ length: n }, (_, i) => `<span class="v-life-puff" style="--del:${round(-((i + next() * 0.5) / n) * pace)}s;--lean:${round((next() - 0.3) * 60)}%"><i></i></span>`).join("");
  return `<span class="v-life-smoke" style="--x:${pct(num(item.x))};--y:${pct(num(item.y))};--sw:${round(num(item.w, 0.03), 4)};--rise:${round(num(item.rise, 0.3), 4)};--c:${hex(item.color)};--dur:${round(pace)}s;--k:${round(num(item.strength, 0.5))}">${puffs}</span>`;
}

/** A swarm: specks darting about a box (bees in the hive). */
function swarmHtml(item, next) {
  const n = count(item.count, 8);
  const specks = Array.from({ length: n }, () => {
    const pace = round(2.2 + next() * 2.6);
    return `<i data-path="${1 + Math.floor(next() * 3)}" style="--mx:${round(next() * 100)}%;--my:${round(next() * 100)}%;--dur:${pace}s;--del:${round(-next() * pace)}s"></i>`;
  }).join("");
  return `<span class="v-life-swarm" style="${boxVars(item.box)};--c:${hex(item.color)}">${specks}</span>`;
}

/**
 * A sweep: a broad band crossing a box, darkening it (a cloud passing the
 * moon), lighting it (a ripple of light down a curtain) or streaked (a gust
 * of spindrift over snow). Runs on its own unless it is an event.
 * @param {LifeItem} item
 */
function sweepHtml(item) {
  const pace = round(num(item.pace, 12));
  const mode = ["dark", "light", "gust"].includes(item.mode) ? item.mode : "light";
  const body = `<i style="--band:${round(num(item.band, 0.3), 4)}"></i>`;
  const style = `${boxVars(item.box)};--c:${hex(item.color)};--dur:${pace}s;--k:${round(num(item.strength, 0.5))}`;
  if (item.event) return eventShell("sweep", pace * 1000, item.box || [0, 0, 1, 1], style, body, ` data-mode="${mode}"`);
  return `<span class="v-life-sweep" data-mode="${mode}" style="${style}">${body}</span>`;
}

// ---- Events ------------------------------------------------------------------

/**
 * The hidden shell an event waits in until the scheduler plays it. area is
 * where on the picture it plays ([left, top, right, bottom]), so an event
 * the header has cropped away is never chosen.
 * @param {string} kind @param {number} ms how long it runs, all members included
 * @param {ReadonlyArray<number>} area @param {string} style @param {string} body @param {string} [attrs]
 */
function eventShell(kind, ms, area, style, body, attrs = "") {
  const box = area.map((edge) => round(clamp(num(edge), 0, 1), 3)).join(",");
  return `<span class="v-life-ev v-life-${kind}" data-life-event data-life-ms="${Math.round(ms)}" data-life-area="${box}"${attrs} style="${style}">${body}</span>`;
}

/** The box round a path from one point to another, grown by a margin. */
function pathArea([x0, y0], [x1, y1], margin = 0.02) {
  return [Math.min(x0, x1) - margin, Math.min(y0, y1) - margin, Math.max(x0, x1) + margin, Math.max(y0, y1) + margin];
}

/**
 * Something crossing the picture: a crow or a flock of them, bats, a
 * wisp. Members share the path, each a little off it and late.
 * @param {LifeItem} item @param {() => number} next
 */
function flyerHtml(item, next) {
  const [x0, y0] = item.from || [0, 0];
  const [x1, y1] = item.to || [1, 0];
  const n = Math.max(1, count(item.count, 1));
  const pace = num(item.pace, 8);
  const flip = x1 < x0 && item.flip !== false;
  const motion = item.wave ? "wave" : item.flap === false ? "glide" : "flap";
  const members = Array.from({ length: n }, (_, i) => {
    const late = i === 0 ? 0 : round(0.25 + next() * 0.9);
    const scale = round(i === 0 ? 1 : 0.7 + next() * 0.3, 2);
    const off = i === 0 ? [0, 0] : [round((next() - 0.5) * 4.5, 2), round((next() - 0.5) * 3.5, 2)];
    return `<span class="v-life-fly-mv" style="--x:${pct(num(x0))};--y:${pct(num(y0))};--dx:${round(num(x1) - num(x0), 4)};--dy:${round(num(y1) - num(y0), 4)};--s:${round(num(item.size, 0.02) * scale, 4)};--ox:${off[0]};--oy:${off[1]};--del:${late}s;--fl:${round(num(item.flap, 0.42) * (0.85 + next() * 0.3), 2)}s"><span class="v-life-fly-body">${spriteImg(item.sprite)}</span></span>`;
  }).join("");
  const longest = pace + 1.2;
  return eventShell("flyer", longest * 1000, pathArea([num(x0), num(y0)], [num(x1), num(y1)]), `--dur:${round(pace)}s`, members, ` data-motion="${motion}"${flip ? " data-flip" : ""}`);
}

/** Leaves falling from a stretch of canopy, swaying as they go. */
function fallHtml(item, next) {
  const [xa, xb, y] = item.from || [0.4, 0.6, 0];
  const n = Math.max(1, count(item.count, 3));
  const pace = num(item.pace, 7);
  const leaves = Array.from({ length: n }, (_, i) => {
    const x = num(xa) + next() * (num(xb) - num(xa));
    const late = round(i * (0.6 + next() * 1.1));
    return `<span class="v-life-fall-mv" style="--x:${pct(x)};--y:${pct(num(y))};--dx:${round(num(item.drift, 0.06) * (0.6 + next() * 0.8), 4)};--dy:${round(num(item.drop, 0.6) * (0.85 + next() * 0.3), 4)};--s:${round(num(item.size, 0.008) * (0.8 + next() * 0.4), 4)};--del:${late}s;--sd:${round(1.6 + next() * 1.2, 2)}s"><span class="v-life-fall-sway">${spriteImg(item.sprite)}</span></span>`;
  });
  const longest = pace + n * 1.7 + 0.5;
  const drift = num(item.drift, 0.06);
  const area = [Math.min(num(xa), num(xa) + drift), num(y), Math.max(num(xb), num(xb) + drift), num(y) + num(item.drop, 0.6)];
  return eventShell("fall", longest * 1000, area, `--dur:${round(pace)}s`, leaves.join(""));
}

/**
 * A falling star: a streak racing along its path, leaning the way it goes.
 * @param {LifeItem} item @param {number} ratio the picture's width over height
 */
function meteorHtml(item, ratio) {
  const [x0, y0] = item.from || [0.6, 0.1];
  const [x1, y1] = item.to || [0.8, 0.2];
  const dx = num(x1) - num(x0);
  const dy = num(y1) - num(y0);
  const angle = round((Math.atan2(dy, dx * ratio) * 180) / Math.PI, 1);
  const pace = num(item.pace, 1.3);
  const body = `<span class="v-life-meteor-mv" style="--x:${pct(num(x0))};--y:${pct(num(y0))};--dx:${round(dx, 4)};--dy:${round(dy, 4)};--a:${angle}deg"><i></i></span>`;
  return eventShell("meteor", pace * 1000 + 300, pathArea([num(x0), num(y0)], [num(x1), num(y1)], 0), `--c:${hex(item.color)};--dur:${round(pace, 2)}s`, body);
}

/**
 * Lightning: the sky flares twice, lighting the whole room, and a bolt
 * cracks down from the clouds.
 * @param {LifeItem} item
 */
function flashHtml(item) {
  const bolt = item.bolt ? `<span class="v-life-bolt" style="--bh:${round(num(item.bolt, 0.3), 4)};--ba:${spriteAspect("bolt")}">${spriteImg("bolt")}</span>` : "";
  const body = `<i class="v-life-flash-sky"></i>${bolt}`;
  // The flare lights the whole room, so it shows wherever the header is cropped.
  // The sky flares round the middle of the bolt, so the part of the sky the
  // header shows lights up, not only the clouds above it.
  const glowY = num(item.y, 0.1) + num(item.bolt, 0.3) * 0.5;
  return eventShell("flash", 2200, [0, 0, 1, 1], `--x:${pct(num(item.x, 0.5))};--y:${pct(num(item.y, 0.1))};--gy:${pct(glowY)};--c:${hex(item.color)};--k:${round(num(item.strength, 0.8))}`, body);
}

/** A draught: the light round a cluster of flames dips and recovers. */
function dimHtml(item) {
  const body = `<i></i>`;
  const [x, y, w, h] = [num(item.x), num(item.y), num(item.w, 0.3), num(item.h, 0.5)];
  return eventShell("dim", 3200, [x - w / 4, y - h / 4, x + w / 4, y + h / 4], `--x:${pct(num(item.x))};--y:${pct(num(item.y))};--cw:${pct(num(item.w, 0.3))};--ch:${pct(num(item.h, 0.5))};--c:${hex(item.color)};--k:${round(num(item.strength, 0.6))}`, body);
}

/**
 * A flare: a log shifts and the fire flares up, its light swelling over the
 * walls while a burst of sparks flies up and out.
 * @param {LifeItem} item @param {() => number} next
 */
function flareHtml(item, next) {
  const [x, y] = [num(item.x), num(item.y)];
  const sparks = Array.from({ length: Math.max(1, count(item.sparks, 10)) }, () => {
    const pace = round(0.9 + next() * 0.9, 2);
    return `<i style="--dx:${round((next() - 0.5) * 0.05, 4)};--dy:${round(-(0.08 + next() * 0.16), 4)};--sd:${pace}s;--late:${round(next() * 0.35, 2)}s"></i>`;
  }).join("");
  const body = `<i class="v-life-flare-glow"></i><span class="v-life-flare-sparks">${sparks}</span>`;
  const style = `--x:${pct(x)};--y:${pct(y)};--cw:${pct(num(item.w, 0.3))};--ch:${pct(num(item.h, 0.5))};--c:${hex(item.color)};--k:${round(num(item.strength, 0.8))}`;
  return eventShell("flare", 2400, [x - 0.06, y - 0.15, x + 0.06, y + 0.05], style, body);
}

const RENDER = Object.freeze({
  cast: castHtml,
  ripple: rippleHtml,
  glint: glintHtml,
  drip: dripHtml,
  flow: flowHtml,
  chain: chainHtml,
  drift: driftHtml,
  float: floatHtml,
  smoke: smokeHtml,
  swarm: swarmHtml,
  sweep: sweepHtml,
  flyer: flyerHtml,
  fall: fallHtml,
  meteor: (item, _next, ratio) => meteorHtml(item, ratio),
  flash: flashHtml,
  dim: dimHtml,
  flare: flareHtml,
});

/**
 * Everything that lives in a scene, for its plate (in front of its lights
 * and air, behind its mist). An unknown scene, or one with no life, draws
 * nothing.
 * @param {string | null} id
 * @param {number} ratio the picture's width over its height
 */
export function lifeHtml(id, ratio) {
  const life = id ? STAGE_LIFE[id] : null;
  if (!life) return "";
  const next = sequence(`${id}:life`);
  const items = life.items
    .map((item) => (RENDER[item.kind] ? RENDER[item.kind](item, next, num(ratio, 3)) : ""))
    .join("");
  if (life.items.some((item) => item.event || ["flyer", "fall", "meteor", "flash", "dim", "flare"].includes(item.kind))) startEvents();
  return `<span class="v-life" aria-hidden="true">${items}</span>`;
}

/**
 * The scene's near air, in front of the spire and behind the figures: a few
 * large, soft motes out of focus, moving more than the room when the camera
 * eases in, so the room has depth.
 * @param {string | null} id
 */
export function lifeNearHtml(id) {
  const near = id && STAGE_LIFE[id] ? STAGE_LIFE[id].near : null;
  if (!near) return "";
  const next = sequence(`${id}:near`);
  const motes = Array.from({ length: count(near.count, 5) }, () => {
    const pace = round(18 + next() * 16);
    // Kept clear of the title block on the left, where a soft blot would read as a smudge.
    return `<i style="--mx:${round(42 + next() * 54)}%;--my:${round(10 + next() * 62)}%;--s:${round(16 + next() * 30)}px;--dur:${pace}s;--del:${round(-next() * pace)}s"></i>`;
  }).join("");
  return `<span class="v-life-near" style="--c:${hex(near.color)}">${motes}</span>`;
}

// ---- The event scheduler ------------------------------------------------------

let timer = 0;
/** @type {Element | null} the event played last, so the same one is not played twice running */
let lastPlayed = null;

/** @param {ReadonlyArray<number>} range */
const between = ([lo, hi]) => lo + Math.random() * (hi - lo);

/** How long an event rests after playing before it may play again (ms). */
const EVENT_REST_MS = 24000;

/** When each event last played. */
const lastPlayedAt = new WeakMap();

/** How much of an event's area must be on screen for it to be chosen. */
const MIN_AREA_SHOWN = 0.35;

/**
 * The part of the picture the header shows now ([left, top, right, bottom]
 * in fractions of the picture), or null when the plate has no size.
 * @param {Element} plate
 */
function shownArea(plate) {
  const picture = plate.getBoundingClientRect();
  const frame = plate.parentElement ? plate.parentElement.getBoundingClientRect() : picture;
  if (!picture.width || !picture.height) return null;
  return [
    (frame.left - picture.left) / picture.width,
    (frame.top - picture.top) / picture.height,
    (frame.right - picture.left) / picture.width,
    (frame.bottom - picture.top) / picture.height,
  ];
}

/**
 * True when enough of an event's area is inside the shown part.
 * @param {Element} event @param {ReadonlyArray<number>} shown
 */
function isShown(event, shown) {
  const area = String(event.getAttribute("data-life-area") || "0,0,1,1").split(",").map(Number);
  if (area.length !== 4 || area.some((edge) => !Number.isFinite(edge))) return true;
  const [l, t, r, b] = area;
  const w = Math.max(r - l, 0.001);
  const h = Math.max(b - t, 0.001);
  const overlapW = Math.max(0, Math.min(r, shown[2]) - Math.max(l, shown[0]));
  const overlapH = Math.max(0, Math.min(b, shown[3]) - Math.max(t, shown[1]));
  return (overlapW / w) * (overlapH / h) >= MIN_AREA_SHOWN;
}

/** The plates of the stages on screen now. */
function shownPlates() {
  return [...document.querySelectorAll(".tab-panel:not([hidden]) .v-scene-plate")].filter((plate) => plate.getClientRects().length > 0);
}

/**
 * Plays one event in an element: shows it, lets its animation run once,
 * then hides it again. Tests and captures call this directly.
 * @param {Element} event
 */
export function playLifeEvent(event) {
  if (!(event instanceof HTMLElement) || event.classList.contains("is-on")) return;
  event.classList.add("is-on");
  lastPlayedAt.set(event, Date.now());
  window.setTimeout(() => event.classList.remove("is-on"), num(Number(event.dataset.lifeMs), 4000) + 250);
}

/** Picks one idle event in each scene on screen and plays it. */
function playSomething() {
  timer = window.setTimeout(playSomething, between(EVENT_GAP_MS.next));
  if (document.hidden || reduced()) return;
  shownPlates().forEach((plate) => {
    const shown = shownArea(plate);
    // Nothing happens in a room whose painting has not arrived yet.
    if (!shown || !plate.querySelector(".v-scene-img.is-in")) return;
    const now = Date.now();
    const idle = [...plate.querySelectorAll("[data-life-event]:not(.is-on)")].filter(
      (event) => isShown(event, shown) && now - (lastPlayedAt.get(event) || 0) > EVENT_REST_MS,
    );
    const choices = idle.length > 1 ? idle.filter((event) => event !== lastPlayed) : idle;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    if (!pick) return;
    lastPlayed = pick;
    playLifeEvent(pick);
  });
}

/** Starts the scheduler once, the first time a scene with events is drawn. */
function startEvents() {
  if (timer || typeof window === "undefined") return;
  timer = window.setTimeout(playSomething, between(EVENT_GAP_MS.first));
}
