// Design-token access from JavaScript.
//
// CSS owns every colour (styles/src/tokens/). This module is the only bridge
// to code that cannot use `var()` directly: SVG strings get `charVar()` (still
// a CSS variable, so it re-colours on theme change for free), and canvas code
// gets resolved values via `resolveColor()` / `charHex()`.

/** The five playable characters, in roster order. */
/** Characters with a colour token (--v-char-<key>). Not all have a theme. */
export const CHARACTER_KEYS = Object.freeze(["ironclad", "silent", "defect", "regent", "necrobinder", "fool"]);

const FALLBACK_VAR = "var(--v-text-2)";

/** @type {Map<string, string>} token → "#rrggbb", cleared on theme change */
let colorCache = new Map();

/**
 * @param {unknown} key
 * @returns {boolean}
 */
export function isCharacterKey(key) {
  return CHARACTER_KEYS.includes(String(key || "").toLowerCase());
}

/**
 * CSS reference for a character's colour. Safe to inline in HTML/SVG.
 * @param {unknown} key
 * @returns {string}
 */
export function charVar(key) {
  const slug = String(key || "").toLowerCase();
  return isCharacterKey(slug) ? `var(--v-char-${slug})` : FALLBACK_VAR;
}

/**
 * @param {string} cssColor  an `rgb()` / `rgba()` string from getComputedStyle
 * @returns {string|null} "#rrggbb"
 */
function rgbToHex(cssColor) {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(cssColor);
  if (!match) return null;
  return `#${match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Resolves a custom property to a concrete "#rrggbb" for the active theme.
 * Canvas APIs cannot read CSS variables, so the share card and confetti go
 * through this. Returns `fallback` when the token is missing or unparseable.
 * @param {string} token     e.g. "--v-char-ironclad"
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveColor(token, fallback = "#888888") {
  const cached = colorCache.get(token);
  if (cached) return cached;
  if (typeof document === "undefined") return fallback;
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${token})`;
  document.documentElement.appendChild(probe);
  const hex = rgbToHex(getComputedStyle(probe).color);
  probe.remove();
  if (!hex) return fallback;
  colorCache = new Map(colorCache).set(token, hex);
  return hex;
}

/**
 * @param {unknown} key
 * @returns {string} "#rrggbb" for the active theme
 */
export function charHex(key) {
  const slug = String(key || "").toLowerCase();
  return isCharacterKey(slug) ? resolveColor(`--v-char-${slug}`) : resolveColor("--v-text-2");
}

/** Drops resolved colours. Called by the theme engine on every switch. */
export function invalidateColorCache() {
  colorCache = new Map();
}
