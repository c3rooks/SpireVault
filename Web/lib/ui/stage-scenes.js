// The Stage's scenery: the place the duel happens in, picked at random on
// every page load (and kept for that load, so switching tabs does not
// reshuffle it).
//
// Each place is one of the game's own combat rooms (the hall of Glory, the
// Hive, the Overgrowth ruins, the Underdocks, the Architect's study, the
// waterfall grotto), built by scripts/build-stage-backdrops.mjs as up to
// three depth planes: the sky and floor, the distance, and the near wall.
// Most rooms come in several takes, so two loads of the same place can still
// look different.
//
// The room is alive on its own: the distance drifts behind the near wall,
// mist crosses the floor, the room's own lights float in its air, and
// falling water falls. Nothing follows the pointer. How all of that sits in
// the header and moves is components/stage-scenes.css.
//
// Only the scenery changes. The spire (ascension progress), the torches
// (last ten runs), the ledge and the captions are data and stay the same in
// every scene.
//
// Markup only; pure functions, no DOM access except the one storage read in
// pickBackdrop().

import { STAGE_BACKDROPS } from "./stage-backdrops.js?v=1";

/** Every place, in the order the backdrops list them. */
export const SCENES = Object.freeze([...new Set(STAGE_BACKDROPS.map((backdrop) => backdrop.room))]);

/**
 * Pins the scenery instead of rolling it (tests, screenshots, or a future
 * setting): a place ("glory") or one take of it ("glory-b"). Any other
 * value, or none, means random.
 */
export const SCENE_STORAGE_KEY = "vault.web.stage-scene";

/** How many times a plane is laid side by side to span the widest header. */
const PLATE_TILES = 4;

/** Copies that get the falling-water streaks: the two nearest the duel cover
 *  any ordinary screen; the rest are off it, or far out on an ultra-wide. */
const WATER_TILES = 2;

/**
 * What floats in each room's air, and how many. The kind picks the motion in
 * CSS: dust hangs and drifts, spores and spray rise, fireflies wander, drips
 * fall.
 * @type {Readonly<Record<string, { kind: "dust" | "spores" | "fireflies" | "drips" | "spray", count: number }>>}
 */
const AIR = Object.freeze({
  glory: { kind: "dust", count: 12 },
  hive: { kind: "spores", count: 14 },
  overgrowth: { kind: "fireflies", count: 12 },
  underdocks: { kind: "drips", count: 9 },
  study: { kind: "dust", count: 12 },
  falls: { kind: "spray", count: 14 },
});

/** @type {import("./stage-backdrops.js").StageBackdrop | null} */
let backdropForThisLoad = null;

/** @param {string} room */
const takesOf = (room) => STAGE_BACKDROPS.filter((backdrop) => backdrop.room === room);

/** @returns {string | null} */
function readPin() {
  try {
    return window.localStorage.getItem(SCENE_STORAGE_KEY);
  } catch {
    return null; // storage blocked (private mode): random is fine
  }
}

/**
 * The backdrop for this page load: the pinned one if storage names a real
 * place or take, otherwise a random place and a random take of it, rolled
 * once (one Math.random() call, so a seeded run stays reproducible).
 * @returns {import("./stage-backdrops.js").StageBackdrop}
 */
export function pickBackdrop() {
  if (backdropForThisLoad) return backdropForThisLoad;
  const pin = readPin();
  const pinned = pin ? STAGE_BACKDROPS.filter((b) => b.room === pin || `${b.room}-${b.take}` === pin) : [];
  // Math.random() is below 1 by contract; a test stub may not be.
  const roll = Math.min(Math.random(), 1 - Number.EPSILON);
  if (pinned.length > 0) {
    backdropForThisLoad = pinned[Math.floor(roll * pinned.length)];
    return backdropForThisLoad;
  }
  // Every place is equally likely, however many takes it has.
  const scaled = roll * SCENES.length;
  const takes = takesOf(SCENES[Math.floor(scaled)]);
  backdropForThisLoad = takes[Math.floor((scaled % 1) * takes.length)];
  return backdropForThisLoad;
}

/**
 * The place for this page load.
 * @returns {string}
 */
export function pickScene() {
  return pickBackdrop().room;
}

/**
 * The backdrop to draw for a place: this load's take when it is this load's
 * place, otherwise that place's first take.
 * @param {string} scene
 */
function backdropFor(scene) {
  const current = pickBackdrop();
  if (scene === current.room) return current;
  return takesOf(scene)[0] || current;
}

/**
 * A deterministic sequence in [0, 1), so a room's air is laid out the same
 * every time it is drawn (re-rendering identical markup must not restart
 * the animations).
 * @param {string} key
 */
function sequence(key) {
  let state = 2166136261;
  for (let i = 0; i < key.length; i += 1) state = Math.imul(state ^ key.charCodeAt(i), 16777619) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** @param {number} n @param {number} places */
const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** @param {number} fraction */
const percent = (fraction) => `${round(fraction * 100, 2)}%`;

/**
 * Falling water inside one copy of the picture: a streaked strip per fall.
 * @param {ReadonlyArray<ReadonlyArray<number>>} water
 */
function waterHtml(water) {
  return water
    .map(
      ([left, top, width, height]) =>
        `<span class="v-scene-water" style="left:${percent(left)};top:${percent(top)};width:${percent(width)};height:${percent(height)}"></span>`,
    )
    .join("");
}

/**
 * One plane of the room: the image laid right to left from the duel's
 * corner, mirrored every other time so neighbours meet on the same pixels.
 * A plane that drifts gets one more copy past the right edge, so drifting
 * left never uncovers the corner.
 * @param {"base" | "mid" | "front"} plane
 * @param {string} src
 * @param {string} water  falling-water markup, put inside the nearest copies
 */
function stripHtml(plane, src, water = "") {
  const tile = (mirrored, lead, inside) =>
    `<span class="v-scene-plate${mirrored ? " v-scene-plate--mirror" : ""}${lead ? " v-scene-plate--lead" : ""}">${inside}</span>`;
  const tiles = Array.from({ length: PLATE_TILES }, (_, index) => tile(index % 2 === 1, false, index < WATER_TILES ? water : "")).join("");
  const lead = plane === "mid" ? tile(true, true, "") : "";
  return `<span class="v-scene-strip v-scene-strip--${plane}" style="--plate:url('${src}')">${lead}${tiles}</span>`;
}

/**
 * The scene's far layer: the room's planes back to front, with mist between
 * the distance and the near wall, then the veil that settles the room behind
 * the title and the toolbar. The spire is added by the caller in front.
 * @param {string} scene
 */
export function sceneFarHtml(scene) {
  const backdrop = backdropFor(scene);
  const { base, mid, front } = backdrop.planes;
  const ratio = round(backdrop.width / backdrop.height, 3);
  return `
      <span class="v-scene" data-take="${backdrop.room}-${backdrop.take}" style="--plate-ratio:${ratio}" aria-hidden="true">
        ${stripHtml("base", base, waterHtml(backdrop.water || []))}
        ${mid ? stripHtml("mid", mid) : ""}
        <span class="v-scene-mist v-scene-mist--far"></span>
        ${front ? stripHtml("front", front) : ""}
      </span>
      <span class="v-scene-veil" aria-hidden="true"></span>`;
}

/**
 * What floats in the room's air: each mote gets its own place, size, pace
 * and head start.
 * @param {string} room
 */
function motesHtml(room) {
  const air = AIR[room];
  if (!air) return "";
  const next = sequence(room);
  const motes = Array.from({ length: air.count }, () => {
    const x = round(30 + next() * 68); // clear of the title, toward the fight
    const y = round(10 + next() * 66);
    const size = round(3 + next() * 4);
    const pace = round(7 + next() * 8);
    const start = round(-next() * pace);
    return `<i style="--x:${x}%;--y:${y}%;--s:${size}px;--t:${pace}s;--d:${start}s"></i>`;
  }).join("");
  return `<span class="v-scene-motes" data-air="${air.kind}" aria-hidden="true">${motes}</span>`;
}

/**
 * The scene's mid layer: the room's air, in front of the room and the spire
 * and behind the figures: low mist over the floor, and the room's own
 * lights adrift.
 * @param {string} scene
 */
export function sceneMidHtml(scene) {
  const backdrop = backdropFor(scene);
  return `<span class="v-scene-mist v-scene-mist--near" aria-hidden="true"></span>${motesHtml(backdrop.room)}`;
}
