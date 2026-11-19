// Where a player's Overview layout is kept: this device's localStorage, under
// its own key (vault.web.prefs.v1 holds booleans only). A layout equal to the
// default is not stored at all, so whoever never arranged keeps following the
// default as it changes. Storage can be missing or throw (private windows,
// blocked site data): the default is used and nothing breaks.

import { sanitize, sameArrangement } from "./layout.js?v=1";
import { CATALOG, defaultLayout } from "./registry.js?v=2";

export const STORAGE_KEY = "vault.web.overview.layout.v1";

/** @returns {import("./layout.js").Layout} the saved layout, cleaned, or the default */
export function loadLayout() {
  let raw = null;
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  return sanitize(raw, CATALOG, defaultLayout());
}

/**
 * @param {import("./layout.js").Layout} layout
 * @returns {boolean} false when this browser would not keep it
 */
export function saveLayout(layout) {
  try {
    if (sameArrangement(layout, defaultLayout())) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    return true;
  } catch {
    return false;
  }
}
