// What a SpireVault page may ask the extension, and who may ask. Pure.

import { STEAM_ID } from "./paths.js";
import { sanitizeKnown } from "./diff.js";

/** Bumped when a message changes shape in a way an older page or extension cannot read. */
export const PROTOCOL = 1;

/** Tags on window messages, so the page and the extension only read each other. */
export const FROM_PAGE = "spirevault-page";
export const FROM_EXTENSION = "spirevault-sync";

export const REQUEST_TYPES = Object.freeze(["status", "sync", "open-settings", "set-folder", "forget-folder"]);

/** What an extension page (the toolbar popup) may ask: nothing that reads a file. */
export const POPUP_TYPES = Object.freeze(["status", "open-settings", "open-app"]);

/**
 * @typedef {{ type: "status" }
 *   | { type: "sync", steamId: string, known: Record<string, [number, number]> }
 *   | { type: "open-settings" }
 *   | { type: "set-folder", path: string }
 *   | { type: "forget-folder" }} PageRequest
 */

/**
 * A request from a page, reduced to the fields this extension reads, or null
 * when it is not a valid request. Unknown fields are dropped, never passed on.
 * @param {unknown} message
 * @returns {PageRequest | null}
 */
export function parsePageRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const raw = /** @type {Record<string, unknown>} */ (message);
  const type = raw.type;
  if (typeof type !== "string" || !REQUEST_TYPES.includes(type)) return null;
  if (type === "sync") {
    const steamId = raw.steamId == null ? "" : raw.steamId;
    if (typeof steamId !== "string" || (steamId !== "" && !STEAM_ID.test(steamId))) return null;
    const known = sanitizeKnown(raw.known);
    if (!known) return null;
    return { type, steamId, known };
  }
  if (type === "set-folder") {
    if (typeof raw.path !== "string" || raw.path.length === 0 || raw.path.length > 1024) return null;
    return { type, path: raw.path };
  }
  return /** @type {PageRequest} */ ({ type });
}

/**
 * True when `origin` is one the manifest injects the bridge into. The
 * manifest's content-script patterns are the single list of SpireVault
 * origins: the store build lists https://app.spirevault.app only, the folder
 * in the repo adds http://127.0.0.1 (any port) for local testing.
 * @param {string} origin e.g. "https://app.spirevault.app"
 * @param {string[]} patterns content_scripts[].matches
 */
export function isAllowedOrigin(origin, patterns) {
  if (typeof origin !== "string" || !Array.isArray(patterns)) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  return patterns.some((pattern) => {
    const match = /^(https?):\/\/([^/*:]+)\/\*$/.exec(String(pattern));
    if (!match) return false;
    if (url.protocol !== `${match[1]}:` || url.hostname !== match[2]) return false;
    // A match pattern ignores the port. The real site has none; only the local test origin may.
    return url.protocol === "http:" || url.port === "";
  });
}
