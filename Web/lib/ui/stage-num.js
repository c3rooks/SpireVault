// Small number and colour helpers the stage's scenery modules share
// (stage-scenes.js, stage-life.js). Every value from a generated or
// hand-authored list passes through these before it reaches markup.

/** @param {number} n @param {number} [places] */
export const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** A fraction (0–1) as a CSS percentage. @param {number} fraction */
export const pct = (fraction) => `${round(fraction * 100)}%`;

/** A colour from a list, refused unless it is a plain hex. @param {string} colour */
export const hex = (colour) => (/^#[0-9a-f]{3,8}$/i.test(colour) ? colour : "#ffffff");

/** A number from a list, or the fallback when it is not one. */
export const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/**
 * A deterministic sequence in [0, 1), so a scene's air and life are laid out
 * the same every time they are drawn (re-rendering identical markup must not
 * restart the animations).
 * @param {string} key
 * @returns {() => number}
 */
export function sequence(key) {
  let state = 2166136261;
  for (let i = 0; i < key.length; i += 1) state = Math.imul(state ^ key.charCodeAt(i), 16777619) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
