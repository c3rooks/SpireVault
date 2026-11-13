// Shared HTML helpers for the new UI modules.

const ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/**
 * Escapes a value for safe interpolation into HTML text or a quoted attribute.
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/**
 * Rounds to a fixed number of decimals and trims float noise.
 * @param {number} value
 * @param {number} [decimals]
 * @returns {string}
 */
export function fixed(value, decimals = 1) {
  return Number.isFinite(value) ? value.toFixed(decimals) : "0";
}

/**
 * Clamps a number into [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
