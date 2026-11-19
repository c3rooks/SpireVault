// Where Slay the Spire 2 keeps its saves, and the only places this extension
// is allowed to read. Everything here is pure (no chrome.*, no fetch).
//
//   <root>/steam/<17-digit Steam ID>/profile<N>/saves/history/<name>.run
//   <root>/steam/<17-digit Steam ID>/modded/profile<N>/saves/history/<name>.run
//
// <root> is the game's own folder, always named SlayTheSpire2:
//   macOS    /Users/<you>/Library/Application Support/SlayTheSpire2/
//   Windows  C:\Users\<you>\AppData\Roaming\SlayTheSpire2\
//   Linux    /home/<you>/.local/share/SlayTheSpire2/
// Only the macOS path is confirmed on a real machine (see README.md).

export const GAME_FOLDER = "SlayTheSpire2";
export const STEAM_ID = /^\d{17}$/;
export const PROFILE_DIR = /^profile\d{1,3}$/;
export const MODDED_DIR = "modded";
/** A finished run. "<name>.run.backup" does not match and is never read. */
export const RUN_FILE = /^[^\/\\]{1,200}\.run$/;
/** A run file's place below the account folder, as the page and the extension both name it. */
export const RUN_KEY = /^(?:modded\/)?profile\d{1,3}\/saves\/history\/[^\/\\]{1,200}\.run$/;

/** Folders under /Users, /home or C:\Users that are never a player's home. */
const NOT_A_HOME = new Set([
  "shared", "guest", "public", "default", "default user", "all users", "defaultapppool", "lost+found",
]);

/** @param {string} name */
export function isHomeCandidate(name) {
  return typeof name === "string" && name.length > 0 && !name.startsWith(".") && !NOT_A_HOME.has(name.toLowerCase());
}

/** One path segment as it appears in a file: URL. */
function seg(name) {
  return encodeURIComponent(name);
}

/**
 * The folder that lists the computer's user folders, per system.
 * @param {"mac"|"win"|"linux"|string} os chrome.runtime.getPlatformInfo().os
 * @returns {string[]} file: URLs ending in "/"
 */
export function homeParents(os) {
  if (os === "mac") return ["file:///Users/"];
  if (os === "win") return ["file:///C:/Users/"];
  if (os === "linux" || os === "cros") return ["file:///home/"];
  return [];
}

/**
 * Every place the game folder could be for one user folder.
 * @param {string} os
 * @param {string} homeUrl file: URL of the user's home, ending in "/"
 * @returns {string[]} file: URLs of candidate roots, ending in "/"
 */
export function rootCandidates(os, homeUrl) {
  if (os === "mac") {
    return [`${homeUrl}Library/${seg("Application Support")}/${GAME_FOLDER}/`];
  }
  if (os === "win") {
    return [`${homeUrl}AppData/Roaming/${GAME_FOLDER}/`];
  }
  if (os === "linux" || os === "cros") {
    return [
      `${homeUrl}.local/share/${GAME_FOLDER}/`,
      // Steam installed as a Flatpak keeps its own home.
      `${homeUrl}.var/app/com.valvesoftware.Steam/.local/share/${GAME_FOLDER}/`,
    ];
  }
  return [];
}

/** @param {string} rootUrl @param {string} steamId */
export function accountUrl(rootUrl, steamId) {
  return `${rootUrl}steam/${steamId}/`;
}

/** The history folder for a profile key such as "profile1" or "modded/profile2". */
export function historyUrl(accountDirUrl, profileKey) {
  return `${accountDirUrl}${profileKey}/saves/history/`;
}

/** @param {string} accountDirUrl @param {string} key a RUN_KEY */
export function runFileUrl(accountDirUrl, key) {
  if (!RUN_KEY.test(key)) return null;
  const parts = key.split("/");
  const name = parts.pop();
  return `${accountDirUrl}${parts.join("/")}/${seg(name)}`;
}

/**
 * True when `url` is a root this extension may use: a file: URL that ends in
 * the game's own folder. Nothing outside a folder named SlayTheSpire2 is ever
 * read, whatever a page asks for.
 */
export function isGameRootUrl(url) {
  if (typeof url !== "string" || url.length > 2048) return false;
  if (!url.startsWith("file:///") || !url.endsWith(`/${GAME_FOLDER}/`)) return false;
  let decoded;
  try { decoded = decodeURIComponent(url.slice("file://".length)); } catch { return false; }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return false;
  return !decoded.split("/").some(isDotSegment);
}

/** "." and "..", and their look-alikes on Windows, which drops trailing dots and spaces. */
function isDotSegment(part) {
  return /^[. ]+$/.test(part);
}

/**
 * Turns a path a player pasted into the root's file: URL. Accepts the game
 * folder or anything inside it, with either kind of slash, and cuts the path
 * back to the SlayTheSpire2 folder.
 *   C:\Users\me\AppData\Roaming\SlayTheSpire2\steam\7656…  →  file:///C:/Users/me/AppData/Roaming/SlayTheSpire2/
 *   /home/me/.local/share/SlayTheSpire2                     →  file:///home/me/.local/share/SlayTheSpire2/
 * A path that starts with "~" or "%APPDATA%" has no home in it, so it cannot
 * be resolved here: returns { needsHome: true, tail } and the caller tries
 * each user folder.
 * @param {string} input
 * @returns {{ rootUrl: string } | { needsHome: true, tail: string[] } | null}
 */
export function parsePastedPath(input) {
  if (typeof input !== "string") return null;
  let text = input.trim().replace(/^["']|["']$/g, "");
  if (text.length === 0 || text.length > 1024) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  if (/^file:\/\//i.test(text)) {
    try { text = decodeURIComponent(text.replace(/^file:\/\/\/?/i, "/")); } catch { return null; }
    if (/^\/[A-Za-z]:/.test(text)) text = text.slice(1);
  }
  const parts = text.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.some(isDotSegment)) return null;
  try { parts.forEach(encodeURIComponent); } catch { return null; }
  const at = parts.findIndex((part) => part.toLowerCase() === GAME_FOLDER.toLowerCase());
  if (at < 0) return null;
  const kept = parts.slice(0, at);
  const first = kept[0] || "";
  if (first === "~" || /^%appdata%$/i.test(first) || /^\$home$/i.test(first)) {
    const tail = /^%appdata%$/i.test(first) ? ["AppData", "Roaming", ...kept.slice(1)] : kept.slice(1);
    return { needsHome: true, tail };
  }
  const isDrive = /^[A-Za-z]:$/.test(first);
  const isAbsolute = isDrive || /^[\\/]/.test(text);
  if (!isAbsolute) return null;
  const head = isDrive ? `file:///${first.toUpperCase()}/` : "file:///";
  const rest = (isDrive ? kept.slice(1) : kept).map(seg).join("/");
  const rootUrl = `${head}${rest}${rest ? "/" : ""}${GAME_FOLDER}/`;
  return isGameRootUrl(rootUrl) ? { rootUrl } : null;
}

/** The root for a pasted "~/…" or "%APPDATA%\…" path under one user folder. */
export function rootFromHome(homeUrl, tail) {
  const rest = tail.map(seg).join("/");
  const rootUrl = `${homeUrl}${rest}${rest ? "/" : ""}${GAME_FOLDER}/`;
  return isGameRootUrl(rootUrl) ? rootUrl : null;
}

/** A root as a path people recognize, for status text: no file://, spaces restored. */
export function describeRoot(rootUrl) {
  if (!isGameRootUrl(rootUrl)) return "";
  let path;
  try { path = decodeURIComponent(rootUrl.slice("file://".length)); } catch { return ""; }
  if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1).replace(/\//g, "\\").replace(/\\$/, "");
  return path.replace(/\/$/, "");
}
