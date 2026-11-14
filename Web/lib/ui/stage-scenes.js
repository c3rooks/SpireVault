// The Stage's scenery: one of several inked locales behind the duel, picked
// at random on every page load (and kept for that load, so switching tabs
// does not reshuffle it).
//
// Only the scenery changes. The spire (ascension progress), the torches
// (last ten runs), the ledge and the captions are data and stay the same in
// every scene. Each scene is drawn in the theme's own stage colours, tinted
// toward the scene's mood in components/stage-scenes.css, so all themes
// still work.
//
// Markup only; pure functions, no DOM access except the one storage read in
// pickScene().

/** Every scene, in no particular order. */
export const SCENES = Object.freeze(["ruins", "grove", "docks", "hive", "glory", "storm"]);

/**
 * Pins a scene instead of rolling one (tests, screenshots, or a future
 * setting). Any other value, or none, means random.
 */
export const SCENE_STORAGE_KEY = "vault.web.stage-scene";

let sceneForThisLoad = null;

/**
 * The scene for this page load: the pinned one if storage names a real
 * scene, otherwise a random one, rolled once.
 * @returns {string}
 */
export function pickScene() {
  if (sceneForThisLoad) return sceneForThisLoad;
  let pinned = null;
  try {
    pinned = window.localStorage.getItem(SCENE_STORAGE_KEY);
  } catch {
    pinned = null; // storage blocked (private mode): random is fine
  }
  sceneForThisLoad = SCENES.includes(pinned) ? pinned : SCENES[Math.floor(Math.random() * SCENES.length)];
  return sceneForThisLoad;
}

// ---- Silhouette builders (viewBox 0 0 1200 120, ground at y = 120) ------------

/**
 * A deterministic sequence in [0, 1), so a scene's skyline is the same every
 * time it is drawn.
 * @param {number} seed
 */
function sequence(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** @param {number} n */
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Jagged peaks (mountains, cliffs).
 * @param {number} seed @param {number} base  @param {number} rise  @param {number} step
 */
function ridge(seed, base, rise, step) {
  const next = sequence(seed);
  let d = `M0 120 V${base}`;
  for (let x = 0; x < 1200; x += step) {
    const peak = base - rise * (0.35 + next() * 0.65);
    d += ` L${r1(x + step * (0.3 + next() * 0.4))} ${r1(peak)} L${r1(x + step)} ${r1(base - rise * next() * 0.3)}`;
  }
  return `${d} V120 Z`;
}

/**
 * Rounded crowns (tree canopies, hive domes).
 * @param {number} seed @param {number} base @param {number} rise @param {number} step
 */
function canopy(seed, base, rise, step) {
  const next = sequence(seed);
  let d = `M0 120 V${base}`;
  let x = 0;
  while (x < 1200) {
    const w = step * (0.7 + next() * 0.6);
    const top = base - rise * (0.45 + next() * 0.55);
    d += ` Q${r1(x)} ${r1(top)} ${r1(x + w / 2)} ${r1(top)} Q${r1(x + w)} ${r1(top)} ${r1(x + w)} ${base}`;
    x += w;
  }
  return `${d} V120 Z`;
}

/**
 * Pointed treetops (a pine line).
 * @param {number} seed @param {number} base @param {number} rise @param {number} step
 */
function pines(seed, base, rise, step) {
  const next = sequence(seed);
  let d = `M0 120 V${base}`;
  for (let x = 0; x < 1200; x += step) {
    const h = rise * (0.5 + next() * 0.5);
    d += ` L${r1(x + step * 0.5)} ${r1(base - h)} L${r1(x + step)} ${base}`;
  }
  return `${d} V120 Z`;
}

/**
 * Rooftops: blocks of varying height, with the odd chimney or spire.
 * @param {number} seed @param {number} base @param {number} rise @param {number} step
 * @param {"chimney" | "spire"} accent
 */
function skyline(seed, base, rise, step, accent) {
  const next = sequence(seed);
  let d = `M0 120 V${base}`;
  let x = 0;
  while (x < 1200) {
    const w = step * (0.6 + next() * 0.8);
    const top = r1(base - rise * (0.3 + next() * 0.7));
    d += ` V${top}`;
    if (next() < 0.45) {
      const ax = r1(x + w * (0.25 + next() * 0.5));
      if (accent === "spire") {
        d += ` H${r1(ax - 5)} L${ax} ${r1(top - rise * (0.5 + next() * 0.6))} L${r1(ax + 5)} ${top}`;
      } else {
        d += ` H${ax} V${r1(top - 10 - next() * 8)} H${r1(ax + 9)} V${top}`;
      }
    }
    d += ` H${r1(x + w)}`;
    x += w;
  }
  return `${d} V${base} V120 Z`;
}

/** Far silhouettes per scene: [back path, front path]. Built once. */
const FAR = Object.freeze({
  ruins: [
    "M0 120 V52 L90 20 L170 58 L260 8 L350 62 L450 26 L540 70 L640 18 L730 64 L830 30 L920 72 L1010 12 L1100 56 L1200 34 V120 Z",
    "M0 120 V84 L60 58 L130 90 L210 50 L300 96 L380 66 L470 104 L560 74 L650 106 L760 60 L850 98 L940 54 L1030 92 L1110 66 L1200 88 V120 Z",
  ],
  grove: [pines(11, 78, 38, 34), canopy(12, 98, 40, 70)],
  docks: [skyline(21, 74, 40, 46, "chimney"), ridge(22, 104, 10, 60)],
  hive: [canopy(31, 66, 52, 120), canopy(32, 98, 30, 64)],
  glory: [skyline(41, 70, 36, 40, "spire"), canopy(42, 100, 18, 90)],
  storm: [ridge(51, 64, 32, 90), ridge(52, 94, 26, 55)],
});

// ---- Set pieces -----------------------------------------------------------------

/**
 * The big shape behind the boss and a small prop out in the open, per scene.
 * viewBoxes are each piece's own; CSS sizes them by height.
 */
const PIECES = Object.freeze({
  ruins: {
    back: `<svg class="v-scene-back" viewBox="0 0 90 110"><path d="M8 110 V46 Q45 -8 82 46 V110 H67 V54 Q45 22 23 54 V110 Z"/></svg>`,
    prop: `<svg class="v-scene-prop" viewBox="0 0 34 100"><path d="M8 100 V16 H4 V6 H30 V16 H26 V100 Z"/></svg>`,
  },
  grove: {
    back: `<svg class="v-scene-back" viewBox="0 0 170 200">
      <path class="v-scene-shade" d="M12 92 Q4 54 40 40 Q48 8 86 12 Q122 0 140 30 Q170 40 162 76 Q170 104 138 112 Q112 126 86 112 Q58 126 36 112 Q8 112 12 92 Z"/>
      <path d="M70 200 Q74 160 72 120 Q60 100 46 96 Q66 96 76 108 Q80 90 74 70 Q88 88 86 110 Q98 96 116 92 Q100 104 94 124 Q92 162 100 200 Z"/>
      <path class="v-scene-line" d="M48 104 Q50 130 44 150 M132 108 Q128 128 134 146 M108 112 Q110 126 106 136"/>
    </svg>`,
    prop: `<svg class="v-scene-prop" viewBox="0 0 60 40"><path d="M2 40 Q4 18 22 14 Q30 2 42 10 Q58 10 58 26 Q60 40 52 40 Z"/></svg>`,
  },
  docks: {
    // A dock lamp on a bracket, hanging out past the boss's back, and a
    // mooring post with its rope.
    back: `<svg class="v-scene-back" viewBox="0 0 120 200">
      <path d="M40 200 V34 Q40 22 52 22 H100 V30 H54 Q50 30 50 36 V200 Z M30 200 V188 H60 V200 Z"/>
      <path class="v-scene-line" d="M96 30 V44"/>
      <path class="v-scene-lamp" d="M88 44 H104 L108 52 V72 L104 78 H88 L84 72 V52 Z"/>
      <path d="M86 44 H106 L102 38 H90 Z"/>
    </svg>`,
    prop: `<svg class="v-scene-prop" viewBox="0 0 70 50"><path d="M20 50 V14 Q20 6 30 6 Q40 6 40 14 V50 Z"/><path class="v-scene-line" d="M22 26 Q46 30 66 46 M22 32 Q44 38 60 50"/></svg>`,
  },
  hive: {
    back: `<svg class="v-scene-back" viewBox="0 0 120 200">
      <path d="M22 200 Q10 120 30 60 Q44 14 62 10 Q82 14 94 60 Q112 120 100 200 Z"/>
      <path class="v-scene-cells" d="M48 64 l8 -5 l8 5 v9 l-8 5 l-8 -5 Z M64 92 l8 -5 l8 5 v9 l-8 5 l-8 -5 Z M40 100 l8 -5 l8 5 v9 l-8 5 l-8 -5 Z M54 130 l8 -5 l8 5 v9 l-8 5 l-8 -5 Z M70 160 l8 -5 l8 5 v9 l-8 5 l-8 -5 Z M38 164 l8 -5 l8 5 v9 l-8 5 l-8 -5 Z"/>
    </svg>`,
    prop: `<svg class="v-scene-prop" viewBox="0 0 60 44"><path d="M4 44 Q2 18 30 8 Q58 18 56 44 Z"/><path class="v-scene-cells" d="M24 26 l6 -4 l6 4 v7 l-6 4 l-6 -4 Z"/></svg>`,
  },
  glory: {
    back: `<svg class="v-scene-back" viewBox="0 0 150 200">
      <path d="M30 200 V20 H36 V200 Z M110 200 V36 H116 V200 Z"/>
      <path class="v-scene-flag" d="M36 24 H82 L72 40 L82 56 H36 Z M116 40 H150 L142 54 L150 68 H116 Z"/>
      <path class="v-scene-line" d="M33 20 L33 8 M113 36 L113 24"/>
      <circle class="v-scene-flag" cx="33" cy="8" r="5"/>
      <circle class="v-scene-flag" cx="113" cy="24" r="5"/>
    </svg>`,
    prop: `<svg class="v-scene-prop" viewBox="0 0 44 70"><path d="M4 70 V58 H40 V70 Z M10 58 V48 H34 V58 Z M16 48 V18 Q22 4 28 18 V48 Z"/></svg>`,
  },
  storm: {
    back: `<svg class="v-scene-back" viewBox="0 0 90 180">
      <path d="M12 180 L18 30 L44 8 L74 26 L80 180 Z"/>
      <path class="v-scene-line" d="M30 50 L40 74 L32 96 M58 120 L50 146"/>
      <path class="v-scene-rune" d="M44 104 L52 116 L44 128 L36 116 Z"/>
    </svg>`,
    prop: `<svg class="v-scene-prop" viewBox="0 0 40 80"><path d="M16 80 V20 H24 V80 Z M4 22 L34 12 L36 22 L6 32 Z"/></svg>`,
  },
});

/**
 * The scene's far layer: celestial body, ambient particles, far silhouettes.
 * The spire is added by the caller between this and the mid layer.
 * @param {string} scene
 */
export function sceneFarHtml(scene) {
  const id = SCENES.includes(scene) ? scene : "ruins";
  const [back, front] = FAR[id];
  return `
      <span class="v-stage-stars" aria-hidden="true"></span>
      <span class="v-stage-moon" aria-hidden="true"></span>
      <svg class="v-stage-hills" viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">
        <path class="v-hills-back" d="${back}"/>
        <path d="${front}"/>
      </svg>`;
}

/**
 * The scene's mid layer: the set piece behind the boss and the prop in the
 * open, plus the weather/ambient overlay that drifts in front of them.
 * @param {string} scene
 */
export function sceneMidHtml(scene) {
  const id = SCENES.includes(scene) ? scene : "ruins";
  const { back, prop } = PIECES[id];
  return `${back}${prop}<span class="v-scene-weather" aria-hidden="true"></span>`;
}
