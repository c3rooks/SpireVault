// The Stage's scenery: the painted place the duel happens in.
//
// Every scene is one hand-painted, ink-lined panorama (built by
// scripts/build-stage-scenes.mjs into stage-scene-list.js), with its own
// lights, light shafts and air. Each tab with a stage gets its own scene, and
// a new one every time the tab is opened: scenes are dealt from a shuffled
// deck, so every scene shows once before any shows again. The deck's place
// is remembered across visits, so a refresh carries on where the last visit
// stopped instead of starting over.
//
// The room is alive on its own: the camera eases in and out of the picture,
// its lights breathe or flicker, shafts of light fade and return, mist
// crosses the floor and its air drifts. Each scene also has its own life
// (stage-life.js): firelight on the walls, water, drips, drifting clouds,
// and now and then a crow, a falling star or a flash of lightning. Nothing
// follows the pointer. How it all sits in the header and moves is
// components/stage-scenes.css and components/stage-life.css.
//
// Only the scenery changes. The spire (ascension progress), the torches
// (last ten runs), the ledge and the captions are data and look the same in
// every scene.
//
// Markup only; pure functions apart from the deck's storage and the
// preloader.

import { esc } from "./html.js?v=1";
import { STAGE_SCENES } from "./stage-scene-list.js?v=1";
import { lifeHtml, lifeNearHtml } from "./stage-life.js?v=1";
import { hex, num, pct, round, sequence } from "./stage-num.js?v=1";

/** Every scene id, in list order. */
export const SCENES = Object.freeze(STAGE_SCENES.map((scene) => scene.id));

/**
 * Pins the scenery instead of dealing it (tests, screenshots, or a future
 * setting): a scene id. Any other value, or none, means dealt.
 */
export const SCENE_STORAGE_KEY = "vault.web.stage-scene";

/** Where the deck is kept between visits: its order and the next card. */
const DECK_STORAGE_KEY = "vault.web.stage-deck";

/** `sizes` for the scene picture: the plate is wider than a phone screen
 *  (it covers the header by height there), the full header elsewhere. */
const PLATE_SIZES = "(max-width: 880px) 900px, 100vw";

/** @typedef {import("./stage-scene-list.js").StageScene} StageScene */

/** @type {ReadonlyMap<string, StageScene>} */
const BY_ID = new Map(STAGE_SCENES.map((scene) => [scene.id, scene]));

/**
 * The scene for an id, or null.
 * @param {string | null | undefined} id
 * @returns {StageScene | null}
 */
export function sceneById(id) {
  return (id && BY_ID.get(id)) || null;
}

/** @returns {string | null} */
function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage blocked (private mode): dealing still works per visit
  }
}

/** @param {string} key @param {string} value */
function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: the deck simply restarts next visit.
  }
}

/**
 * A fresh shuffle of every scene (Fisher-Yates). Never starts with `avoid`,
 * so a new round does not repeat the card that ended the last one.
 * @param {string | null} avoid
 * @returns {string[]}
 */
function shuffled(avoid) {
  const order = [...SCENES];
  for (let i = order.length - 1; i > 0; i -= 1) {
    // Math.random() is below 1 by contract; a test stub may not be.
    const j = Math.floor(Math.min(Math.random(), 1 - Number.EPSILON) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (order.length > 1 && order[0] === avoid) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

/**
 * The stored deck, if it still holds exactly today's scenes.
 * @returns {{ order: string[], next: number } | null}
 */
function readDeck() {
  const raw = readStorage(DECK_STORAGE_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw);
    const order = Array.isArray(stored && stored.order) ? stored.order.filter((id) => typeof id === "string") : [];
    const next = Number.isInteger(stored && stored.next) ? stored.next : 0;
    const same = order.length === SCENES.length && SCENES.every((id) => order.includes(id));
    return same ? { order, next: Math.min(order.length, Math.max(0, next)) } : null;
  } catch {
    return null; // not ours or damaged: deal a new deck
  }
}

/** This visit's copy of the deck, for when storage is blocked. */
let deck = null;

/**
 * Deals the next scene: the pinned one when storage pins a real scene,
 * otherwise the next card of the deck (a new shuffle once it runs out, never
 * opening with the card that closed the last one). The deck is re-read on
 * every deal, so two open windows share one deck instead of overwriting it.
 * @returns {string}
 */
export function dealScene() {
  const pin = readStorage(SCENE_STORAGE_KEY);
  if (pin && BY_ID.has(pin)) return pin;
  if (SCENES.length === 0) return "";
  const current = readDeck() || deck || { order: shuffled(null), next: 0 };
  const lastDealt = current.next > 0 ? current.order[current.next - 1] : null;
  const live = current.next >= current.order.length ? { order: shuffled(lastDealt), next: 0 } : current;
  const id = live.order[live.next];
  deck = { order: live.order, next: live.next + 1 };
  writeStorage(DECK_STORAGE_KEY, JSON.stringify(deck));
  return id;
}

/**
 * The scene the next deal will give, without dealing it (for preloading).
 * @returns {string | null}
 */
export function peekScene() {
  const pin = readStorage(SCENE_STORAGE_KEY);
  if (pin && BY_ID.has(pin)) return pin;
  const current = readDeck() || deck;
  if (!current || current.next >= current.order.length) return null;
  return current.order[current.next];
}

/** Scenes already asked for, so each is fetched once. */
const preloaded = new Set();

/**
 * Starts fetching a scene's picture (the same size the header would pick),
 * so opening its tab shows it at once.
 * @param {string | null} id
 */
export function preloadScene(id) {
  const scene = sceneById(id);
  if (!scene || preloaded.has(scene.id) || typeof Image !== "function") return;
  preloaded.add(scene.id);
  const image = new Image();
  image.decoding = "async";
  image.sizes = PLATE_SIZES;
  image.srcset = scene.srcset;
  image.src = scene.src;
}

/**
 * The scene's lights: a soft glow on each light source, moving the way that
 * source does (the moon breathes, a candle flickers, a reflection shimmers,
 * an aurora's curtain sways).
 * @param {StageScene} scene
 */
function lightsHtml(scene) {
  const next = sequence(`${scene.id}:lights`);
  return scene.lights
    .map((light) => {
      const pace = round(light.pulse === "flicker" ? 1.6 + next() * 1.4 : light.pulse === "sway" ? 14 + next() * 8 : 6 + next() * 4);
      const start = round(-next() * pace);
      return `<span class="v-scene-light" data-pulse="${esc(light.pulse)}" style="--x:${pct(num(light.x))};--y:${pct(num(light.y))};--r:${round(num(light.r), 3)};--c:${hex(light.color)};--t:${pace}s;--d:${start}s"></span>`;
    })
    .join("");
}

/**
 * Shafts of light falling from the top of the picture, each fading in and
 * out on its own beat.
 * @param {StageScene} scene
 */
function shaftsHtml(scene) {
  const next = sequence(`${scene.id}:shafts`);
  return scene.shafts
    .map((shaft) => {
      const pace = round(9 + next() * 6);
      const start = round(-next() * pace);
      return `<span class="v-scene-shaft" style="--x:${pct(num(shaft.x))};--w:${pct(num(shaft.w))};--a:${round(num(shaft.angle), 1)}deg;--c:${hex(shaft.color)};--t:${pace}s;--d:${start}s"></span>`;
    })
    .join("");
}

/** The most motes one layer of air may hold, whatever the list asks for. */
const MAX_MOTES = 40;

/**
 * What floats in the scene's air, one layer per kind (embers over a fire and
 * stars in the sky above it), each inside its own box: each mote gets its
 * own place, size, pace and head start.
 * @param {StageScene} scene
 */
function motesHtml(scene) {
  return scene.air
    .map((layer, index) => {
      const [left, top, right, bottom] = layer.box.map((edge) => num(edge));
      const next = sequence(index === 0 ? `${scene.id}:air` : `${scene.id}:air:${index}`);
      const count = Math.max(0, Math.min(MAX_MOTES, Math.floor(num(layer.count))));
      const motes = Array.from({ length: count }, () => {
        const x = round((left + next() * (right - left)) * 100);
        const y = round((top + next() * (bottom - top)) * 100);
        const size = round(2.5 + next() * 3.5, 1);
        const pace = round(6 + next() * 9, 1);
        const start = round(-next() * pace, 1);
        return `<i style="--mx:${x}%;--my:${y}%;--s:${size}px;--t:${pace}s;--d:${start}s"></i>`;
      }).join("");
      return `<span class="v-scene-motes" data-air="${esc(layer.kind)}">${motes}</span>`;
    })
    .join("");
}

/**
 * The scene's far layer: the painted room with its shafts, lights and air,
 * all on one plate so they stay registered to the picture however the
 * header crops it, then mist, then the veil that settles the room behind the
 * title and the toolbar. The spire is added by the caller in front. A null
 * scene draws nothing: the header's own sky shows until a scene is dealt.
 * @param {string | null} id
 */
export function sceneFarHtml(id) {
  const scene = sceneById(id);
  if (!scene) return `<span class="v-scene-veil" aria-hidden="true"></span>`;
  return `
      <span class="v-scene" data-scene-id="${esc(scene.id)}" style="--focus:${num(scene.focus, 1)};--plate-ratio:${round(num(scene.width / scene.height, 3), 3)}" aria-hidden="true">
        <span class="v-scene-plate">
          <img class="v-scene-img" src="${esc(scene.src)}" srcset="${esc(scene.srcset)}" sizes="${PLATE_SIZES}" width="${num(scene.width)}" height="${num(scene.height)}" alt="" decoding="async" draggable="false">
          ${shaftsHtml(scene)}
          ${lightsHtml(scene)}
          ${motesHtml(scene)}
          ${lifeHtml(scene.id, num(scene.width / scene.height, 3))}
        </span>
        <span class="v-scene-mist v-scene-mist--far"></span>
      </span>
      <span class="v-scene-veil" aria-hidden="true"></span>`;
}

/**
 * The scene's mid layer, in front of the room and the spire and behind the
 * figures: low mist over the floor, and the scene's near air.
 * @param {string | null} id
 */
export function sceneMidHtml(id) {
  return sceneById(id) ? `<span class="v-scene-mist v-scene-mist--near" aria-hidden="true"></span>${lifeNearHtml(id)}` : "";
}

/**
 * The room's own colours, for the header to tint its sky and veil with.
 * @param {string | null} id
 * @returns {Readonly<Record<string, string>>}
 */
export function sceneTints(id) {
  const scene = sceneById(id);
  if (!scene) return Object.freeze({});
  return Object.freeze({
    "--scene-deep": hex(scene.deep),
    "--scene-haze": hex(scene.haze),
    "--scene-accent": hex(scene.accent),
    "--scene-veil": `${round(num(scene.veil, 0.14) * 100)}%`,
    "--scene-mist": String(round(Math.min(1.6, Math.max(0, num(scene.mist, 1))))),
  });
}
