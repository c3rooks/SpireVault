// What lives in each painted scene beyond its lights, shafts, air and mist
// (those are in stage-scene-list.js). Drawn by stage-life.js, moved by
// components/stage-life.css.
//
// Positions are fractions of the picture (x 0 left, y 0 top), measured on a
// 5% grid over each scene, so they stay on the painting however the header
// crops it. Sizes (size, r, w) are fractions of the picture's width; heights
// and falls (h, fall, rise, drop) fractions of its height.
//
// What shows where: a wide desktop header shows about the band from y 0.40
// to y 0.86 across the whole width (the left third under the title's veil);
// a phone shows the whole height but only the right half or so (x from about
// 0.55). Each scene keeps something alive in both.
//
// Running life (loops on its own):
//   cast    light a source throws onto the walls: beat fire | candle |
//           lantern | slow; swing (deg) sways it about a pivot (0–1 of its
//           height) like a hanging lantern's light
//   ripple  glinting streaks on water in a box
//   glint   four-point sparkles flashing at points (gold, glass, crystal, ice)
//   drip    drops swelling at [x, y, fall] and falling; splash rings the water
//   flow    bands of light running down a fall in a box
//   chain   glows along a path lit one after another (lava running, a wave
//           of light through crystal)
//   drift   painted clouds drifting through a box (dir -1 drifts left)
//   float   a painted thing floating in place
//   smoke   puffs rising from a source
//   swarm   specks darting about a box (bees)
//   sweep   a broad band crossing a box: dark | light | gust
// Events (one plays every few seconds in the scene on screen):
//   flyer   something crossing from → to (a crow, a flock, bats, a wisp)
//   fall    leaves falling from a stretch of canopy [x0, x1, y]
//   meteor  a falling star from → to
//   flash   lightning over x, y: the sky flares, a bolt cracks down
//   dim     a draught dips the light round a cluster of flames
//   flare   a fire flares up: its light swells and sparks fly (sparks: count)
//   sweep with event: true plays once instead of looping
// near: big soft motes in front of the room (colour, count), for depth.

/**
 * @typedef {Object} LifeItem
 * @property {string} kind
 * @property {boolean} [event]
 * @property {number} [x] @property {number} [y] @property {number} [w] @property {number} [h]
 * @property {ReadonlyArray<number>} [box]  [left, top, right, bottom]
 * @property {ReadonlyArray<ReadonlyArray<number>>} [points]
 * @property {ReadonlyArray<number>} [from] @property {ReadonlyArray<number>} [to]
 * @property {string} [color] @property {string} [sprite] @property {string} [beat] @property {string} [mode]
 * @property {number} [size] @property {number} [r] @property {number} [count] @property {number} [pace]
 * @property {number} [strength] @property {number} [opacity] @property {number} [swing] @property {number} [pivot]
 * @property {number} [fall] @property {number} [rise] @property {number} [drop] @property {number} [drift]
 * @property {number} [band] @property {number} [spread] @property {number} [dir] @property {number} [bolt] @property {number} [sparks]
 * @property {boolean} [splash] @property {boolean} [wave] @property {boolean | number} [flap] @property {boolean} [flip]
 * @typedef {{ items: ReadonlyArray<LifeItem>, near?: { color: string, count: number } }} SceneLife
 */

/** @type {Readonly<Record<string, SceneLife>>} */
export const STAGE_LIFE = Object.freeze({
  // Moonlight on a wet marble floor; gilt that catches it; now and then a
  // cloud crosses the moon and the hall darkens, or the windows brighten.
  glory: {
    items: [
      { kind: "ripple", box: [0.27, 0.76, 0.66, 0.9], color: "#bff2ff", strength: 0.6 },
      { kind: "ripple", box: [0.64, 0.77, 1, 0.9], color: "#a6e4ff", strength: 0.42 },
      { kind: "cast", x: 0.46, y: 0.8, w: 0.32, h: 0.2, color: "#9fe6ff", beat: "slow", strength: 0.5 },
      {
        kind: "glint",
        color: "#fff0b8",
        size: 0.016,
        points: [[0.6, 0.165], [0.81, 0.13], [0.97, 0.12], [0.6, 0.64], [0.82, 0.62], [0.975, 0.63], [0.41, 0.38], [0.43, 0.33], [0.395, 0.47], [0.31, 0.22], [0.55, 0.2], [0.74, 0.18], [0.3, 0.57], [0.47, 0.6]],
      },
      { kind: "sweep", event: true, box: [0, 0, 1, 1], mode: "dark", color: "#030a26", band: 0.55, pace: 9, strength: 0.55 },
      { kind: "sweep", event: true, box: [0.58, 0, 1, 0.72], mode: "light", color: "#d6f8ff", band: 0.22, pace: 5, strength: 0.4 },
      { kind: "flyer", sprite: "bat", from: [0.3, 0.6], to: [0.74, 0.5], count: 2, size: 0.015, flap: 0.2, pace: 5 },
    ],
    near: { color: "#bff4ff", count: 5 },
  },
  // Honey runs down the falls and drips from the comb; bees work the air.
  hive: {
    items: [
      { kind: "flow", box: [0.33, 0.43, 0.48, 0.75], color: "#fff2a0", pace: 3.6, strength: 0.5 },
      { kind: "cast", x: 0.47, y: 0.52, w: 0.34, h: 0.55, color: "#ffb52e", beat: "slow", strength: 0.42 },
      {
        kind: "drip",
        color: "#ffc23a",
        size: 0.0048,
        pace: 6.5,
        splash: true,
        points: [[0.43, 0.43, 0.37], [0.528, 0.41, 0.39], [0.69, 0.34, 0.46], [0.708, 0.36, 0.44], [0.918, 0.5, 0.3], [0.315, 0.2, 0.6]],
      },
      { kind: "glint", color: "#fff6c0", size: 0.01, points: [[0.43, 0.4], [0.69, 0.3], [0.918, 0.46], [0.6, 0.12], [0.45, 0.2], [0.56, 0.3], [0.38, 0.55]] },
      { kind: "swarm", box: [0.35, 0.28, 0.98, 0.72], count: 12, color: "#ffd23a" },
      { kind: "sweep", event: true, box: [0.28, 0, 1, 0.62], mode: "light", color: "#ffd24a", band: 0.3, pace: 5, strength: 0.4 },
    ],
    near: { color: "#ffc53d", count: 5 },
  },
  // Candlelight warms the shelves and the brass; a draught passes and every
  // flame dips; stars fall past the dome.
  study: {
    items: [
      { kind: "cast", x: 0.225, y: 0.4, w: 0.17, h: 0.5, color: "#ffb257", beat: "candle", strength: 0.72 },
      { kind: "cast", x: 0.32, y: 0.52, w: 0.15, h: 0.45, color: "#ffb257", beat: "candle", strength: 0.72 },
      { kind: "cast", x: 0.57, y: 0.52, w: 0.11, h: 0.36, color: "#ffb257", beat: "candle", strength: 0.55 },
      { kind: "cast", x: 0.505, y: 0.62, w: 0.1, h: 0.3, color: "#ffb257", beat: "candle", strength: 0.5 },
      { kind: "glint", color: "#ffe6a0", size: 0.011, points: [[0.42, 0.22], [0.48, 0.3], [0.355, 0.32], [0.505, 0.2], [0.6, 0.36], [0.63, 0.52], [0.44, 0.6], [0.4, 0.45]] },
      { kind: "meteor", from: [0.68, 0.08], to: [0.86, 0.22], color: "#e8f0ff" },
      { kind: "meteor", from: [0.66, 0.385], to: [0.8, 0.43], color: "#e8f0ff" },
      { kind: "dim", x: 0.36, y: 0.47, w: 0.46, h: 0.72, color: "#0c0618", strength: 0.6 },
    ],
    near: { color: "#ffd27a", count: 4 },
  },
  // Sun on the steps, the lilies sparkling; leaves come down and crows cross
  // the far canopy.
  overgrowth: {
    items: [
      { kind: "cast", x: 0.5, y: 0.62, w: 0.22, h: 0.32, color: "#e8ff9a", beat: "slow", strength: 0.38 },
      { kind: "glint", color: "#eafff4", size: 0.012, points: [[0.36, 0.66], [0.385, 0.48], [0.6, 0.665], [0.625, 0.445], [0.565, 0.47], [0.065, 0.785], [0.975, 0.92], [0.53, 0.72]] },
      { kind: "fall", sprite: "leaf-green", from: [0.42, 0.78, 0.02], drop: 0.75, drift: 0.06, size: 0.009, count: 4, pace: 8 },
      { kind: "fall", sprite: "leaf-green", from: [0.8, 0.98, 0.02], drop: 0.78, drift: -0.05, size: 0.009, count: 3, pace: 8 },
      { kind: "flyer", sprite: "crow", from: [1.03, 0.4], to: [0.55, 0.3], count: 3, size: 0.016, pace: 9 },
      { kind: "flyer", sprite: "crow", from: [0.8, 0.52], to: [0.28, 0.45], count: 3, size: 0.017, pace: 8 },
    ],
    near: { color: "#d6ff8a", count: 5 },
  },
  // Lanterns throw green light on the stone; the water moves under them and
  // drips ring it; bats leave the arches.
  underdocks: {
    items: [
      { kind: "cast", x: 0.36, y: 0.3, w: 0.18, h: 0.55, color: "#7dff9a", beat: "lantern", strength: 0.5 },
      { kind: "cast", x: 0.34, y: 0.43, w: 0.06, h: 0.2, color: "#7dff9a", beat: "lantern", strength: 0.5 },
      { kind: "cast", x: 0.444, y: 0.46, w: 0.06, h: 0.2, color: "#7dff9a", beat: "lantern", strength: 0.5 },
      { kind: "cast", x: 0.51, y: 0.52, w: 0.05, h: 0.16, color: "#7dff9a", beat: "lantern", strength: 0.5 },
      { kind: "cast", x: 0.552, y: 0.43, w: 0.05, h: 0.16, color: "#7dff9a", beat: "lantern", strength: 0.45 },
      { kind: "ripple", box: [0.27, 0.62, 0.64, 0.79], color: "#a6ffc8", strength: 0.6 },
      { kind: "ripple", box: [0.62, 0.6, 1, 0.78], color: "#cdbcff", strength: 0.35 },
      { kind: "drip", color: "#c6ffdc", size: 0.0035, pace: 5.5, splash: true, points: [[0.47, 0.52, 0.17], [0.585, 0.5, 0.2], [0.8, 0.3, 0.46]] },
      { kind: "flyer", sprite: "bat", from: [0.28, 0.6], to: [0.74, 0.47], count: 4, size: 0.015, flap: 0.22, pace: 6 },
      { kind: "flyer", sprite: "bat", from: [0.98, 0.3], to: [0.6, 0.12], count: 3, size: 0.014, flap: 0.22, pace: 5 },
      { kind: "dim", x: 0.36, y: 0.32, w: 0.22, h: 0.45, color: "#06020e", strength: 0.5 },
    ],
    near: { color: "#8dffb0", count: 4 },
  },
  // The fire throws its light over the stones and sends smoke up; clouds
  // cross the mountains; stars fall; a leaf comes down from the tree.
  campfire: {
    items: [
      { kind: "cast", x: 0.395, y: 0.66, w: 0.44, h: 0.78, color: "#ff8a3a", beat: "fire", strength: 0.55 },
      { kind: "cast", x: 0.395, y: 0.72, w: 0.19, h: 0.3, color: "#ffc070", beat: "fire", strength: 0.5 },
      { kind: "smoke", x: 0.395, y: 0.63, w: 0.035, rise: 0.5, color: "#9aa6c8", count: 6, pace: 8, strength: 0.35 },
      { kind: "flare", x: 0.395, y: 0.7, w: 0.42, h: 0.72, color: "#ffa040", sparks: 14, strength: 0.9 },
      { kind: "dim", x: 0.395, y: 0.66, w: 0.4, h: 0.7, color: "#05060f", strength: 0.4 },
      { kind: "drift", sprite: "cloud-night", box: [0.5, 0.3, 1, 0.5], size: 0.18, count: 3, pace: 160, opacity: 0.6 },
      { kind: "meteor", from: [0.7, 0.05], to: [0.88, 0.17], color: "#fff4e0" },
      { kind: "meteor", from: [0.62, 0.3], to: [0.75, 0.36], color: "#fff4e0" },
      { kind: "flyer", sprite: "crow", from: [1.03, 0.42], to: [0.6, 0.34], count: 2, size: 0.015, pace: 8 },
      { kind: "fall", sprite: "leaf-red", from: [0.12, 0.45, 0.04], drop: 0.75, drift: 0.08, size: 0.011, count: 4, pace: 8 },
    ],
    near: { color: "#ffb15a", count: 4 },
  },
  // The lanterns sway and their light swings over the wares; bottles, coins
  // and brass catch it; the tent's cloth breathes.
  merchant: {
    items: [
      { kind: "cast", x: 0.445, y: 0.43, w: 0.15, h: 0.46, color: "#ffbe5a", beat: "lantern", strength: 0.7, swing: 3, pivot: 0.12 },
      { kind: "cast", x: 0.497, y: 0.4, w: 0.18, h: 0.52, color: "#ffbe5a", beat: "lantern", strength: 0.7, swing: 2.4, pivot: 0.12 },
      { kind: "cast", x: 0.59, y: 0.44, w: 0.13, h: 0.42, color: "#ffbe5a", beat: "lantern", strength: 0.65, swing: 3.4, pivot: 0.07 },
      {
        kind: "glint",
        color: "#fff2c8",
        size: 0.013,
        points: [[0.418, 0.42], [0.44, 0.44], [0.458, 0.41], [0.477, 0.44], [0.492, 0.41], [0.452, 0.47], [0.295, 0.62], [0.32, 0.6], [0.505, 0.52], [0.47, 0.58], [0.6, 0.66], [0.545, 0.66]],
      },
      { kind: "sweep", box: [0.56, 0.04, 1, 0.82], mode: "light", color: "#ffb3c8", band: 0.18, pace: 11, strength: 0.24 },
      { kind: "dim", x: 0.5, y: 0.36, w: 0.42, h: 0.72, color: "#14040e", strength: 0.45 },
      { kind: "sweep", event: true, box: [0.3, 0.3, 0.75, 0.82], mode: "light", color: "#ffe2b0", band: 0.14, pace: 2.6, strength: 0.6 },
    ],
    near: { color: "#ffd27a", count: 4 },
  },
  // Light wells up through the crystals and sparkles on their faces; drops
  // fall from the points above and ring the lake.
  crystal: {
    items: [
      { kind: "chain", color: "#ff9ae6", r: 0.035, pace: 5, spread: 0.5, points: [[0.3, 0.55], [0.34, 0.45], [0.38, 0.33], [0.41, 0.22], [0.45, 0.14], [0.48, 0.28], [0.52, 0.4], [0.56, 0.5]] },
      {
        kind: "glint",
        color: "#fff0ff",
        size: 0.013,
        points: [[0.395, 0.12], [0.43, 0.25], [0.335, 0.4], [0.47, 0.36], [0.52, 0.44], [0.555, 0.5], [0.27, 0.6], [0.615, 0.15], [0.655, 0.08], [0.93, 0.18], [0.72, 0.52], [0.86, 0.44], [0.6, 0.6], [0.45, 0.55]],
      },
      { kind: "ripple", box: [0.28, 0.62, 0.62, 0.78], color: "#ffc2f0", strength: 0.55 },
      { kind: "drip", color: "#ffd0f6", size: 0.004, pace: 7, splash: true, points: [[0.505, 0.07, 0.6], [0.335, 0.12, 0.52], [0.925, 0.18, 0.6]] },
      { kind: "sweep", event: true, box: [0.25, 0, 0.75, 0.75], mode: "light", color: "#ffb0f0", band: 0.2, pace: 3.5, strength: 0.45 },
      { kind: "flare", x: 0.47, y: 0.5, w: 0.32, h: 0.62, color: "#ffc8f4", sparks: 14, strength: 0.9 },
    ],
    near: { color: "#ffc2f0", count: 5 },
  },
  // The aurora brightens along its curtains; ice glints; clouds cross the
  // peaks; a gust drives spindrift over the snow; a star falls.
  aurora: {
    items: [
      { kind: "chain", color: "#5dffb8", r: 0.06, pace: 8, spread: 0.6, points: [[0.36, 0.18], [0.42, 0.1], [0.5, 0.06], [0.58, 0.12], [0.66, 0.22], [0.74, 0.1], [0.84, 0.06]] },
      { kind: "glint", color: "#e8ffff", size: 0.012, points: [[0.5, 0.1], [0.515, 0.28], [0.55, 0.42], [0.48, 0.5], [0.53, 0.6], [0.37, 0.62], [0.68, 0.45], [0.86, 0.42], [0.72, 0.62]] },
      { kind: "flow", box: [0.5, 0.38, 0.56, 0.62], color: "#e8ffff", pace: 6, strength: 0.35 },
      { kind: "drift", sprite: "cloud-night", box: [0.55, 0.34, 1, 0.56], size: 0.2, count: 2, pace: 170, opacity: 0.45 },
      { kind: "sweep", event: true, box: [0, 0.66, 1, 0.86], mode: "gust", color: "#e8f8ff", band: 0.35, pace: 3.2, strength: 0.6 },
      { kind: "meteor", from: [0.72, 0.04], to: [0.92, 0.16], color: "#e8fff8" },
      { kind: "sweep", event: true, box: [0.2, 0.3, 1, 0.66], mode: "light", color: "#7dffc8", band: 0.3, pace: 6, strength: 0.4 },
    ],
    near: { color: "#c8fff0", count: 5 },
  },
  // Lava runs down from the crater and pops as it goes; ash rolls over;
  // lightning cracks in the plume and lights the wastes.
  embers: {
    items: [
      {
        kind: "chain",
        color: "#ffb040",
        r: 0.016,
        pace: 5,
        spread: 0.8,
        points: [[0.4, 0.26], [0.405, 0.32], [0.42, 0.38], [0.44, 0.44], [0.445, 0.5], [0.46, 0.55], [0.49, 0.6], [0.52, 0.64], [0.55, 0.67], [0.585, 0.68], [0.62, 0.65], [0.66, 0.61], [0.7, 0.6]],
      },
      { kind: "chain", color: "#ffa030", r: 0.013, pace: 6, spread: 0.8, points: [[0.5, 0.5], [0.54, 0.53], [0.58, 0.55], [0.62, 0.55], [0.66, 0.57], [0.7, 0.58], [0.74, 0.585]] },
      { kind: "glint", color: "#ffd070", size: 0.01, points: [[0.47, 0.58], [0.55, 0.66], [0.63, 0.64], [0.6, 0.55], [0.45, 0.5], [0.69, 0.6]] },
      { kind: "cast", x: 0.55, y: 0.64, w: 0.45, h: 0.35, color: "#ff6a2a", beat: "slow", strength: 0.45 },
      { kind: "smoke", x: 0.39, y: 0.2, w: 0.06, rise: 0.2, color: "#5a2a2a", count: 5, pace: 10, strength: 0.4 },
      { kind: "drift", sprite: "cloud-ash", box: [0.45, 0, 1, 0.32], size: 0.22, count: 2, pace: 150, opacity: 0.7 },
      { kind: "drift", sprite: "cloud-ash", box: [0.5, 0.36, 1, 0.52], size: 0.15, count: 2, pace: 130, opacity: 0.45 },
      { kind: "flash", x: 0.62, y: 0.14, color: "#ffc890", bolt: 0.38, strength: 0.9 },
      { kind: "flash", x: 0.71, y: 0.12, color: "#ffc890", bolt: 0.4, strength: 0.85 },
      { kind: "flare", x: 0.55, y: 0.67, w: 0.2, h: 0.3, color: "#ff8a30", sparks: 10, strength: 0.7 },
    ],
    near: { color: "#ffb05a", count: 5 },
  },
  // Clouds drift at three depths; islets bob among the ruins; crows cross;
  // a cloud's shadow passes over the floor.
  clouds: {
    items: [
      { kind: "drift", sprite: "cloud-pink", box: [0.3, 0.38, 1, 0.55], size: 0.12, count: 3, pace: 240, opacity: 0.7 },
      { kind: "drift", sprite: "cloud-pink", box: [0.25, 0.5, 1, 0.7], size: 0.2, count: 3, pace: 150, opacity: 0.85 },
      { kind: "drift", sprite: "cloud-pink", box: [0, 0.62, 1, 0.8], size: 0.3, count: 2, pace: 100, opacity: 0.9 },
      { kind: "float", sprite: "islet", x: 0.92, y: 0.44, size: 0.045, pace: 8 },
      { kind: "float", sprite: "islet", x: 0.56, y: 0.31, size: 0.028, pace: 9 },
      { kind: "flyer", sprite: "crow", from: [0.8, 0.63], to: [0.28, 0.52], count: 4, size: 0.015, pace: 10 },
      { kind: "flyer", sprite: "crow", from: [0.6, 0.3], to: [1.03, 0.2], count: 3, size: 0.014, pace: 8 },
      { kind: "sweep", event: true, box: [0, 0.55, 1, 0.92], mode: "dark", color: "#2a1840", band: 0.4, pace: 8, strength: 0.45 },
    ],
    near: { color: "#ffe2b8", count: 4 },
  },
  // Green candlelight on bone; a draught dips it; wisps rise from the
  // tombs; bats leave the vault.
  crypt: {
    items: [
      { kind: "cast", x: 0.29, y: 0.55, w: 0.12, h: 0.35, color: "#7dff9a", beat: "candle", strength: 0.55 },
      { kind: "cast", x: 0.36, y: 0.46, w: 0.1, h: 0.3, color: "#7dff9a", beat: "candle", strength: 0.55 },
      { kind: "cast", x: 0.38, y: 0.66, w: 0.12, h: 0.25, color: "#7dff9a", beat: "candle", strength: 0.55 },
      { kind: "cast", x: 0.48, y: 0.55, w: 0.14, h: 0.3, color: "#7dff9a", beat: "candle", strength: 0.55 },
      { kind: "cast", x: 0.6, y: 0.57, w: 0.08, h: 0.2, color: "#7dff9a", beat: "candle", strength: 0.5 },
      { kind: "flyer", sprite: "wisp", from: [0.44, 0.7], to: [0.49, 0.42], size: 0.014, pace: 6, wave: true, flip: false },
      { kind: "flyer", sprite: "wisp", from: [0.62, 0.78], to: [0.68, 0.48], size: 0.013, pace: 7, wave: true, flip: false },
      { kind: "flyer", sprite: "bat", from: [0.3, 0.56], to: [0.75, 0.45], count: 3, size: 0.015, flap: 0.2, pace: 6 },
      { kind: "dim", x: 0.42, y: 0.55, w: 0.45, h: 0.55, color: "#020a08", strength: 0.55 },
    ],
    near: { color: "#a8ffc8", count: 5 },
  },
});
