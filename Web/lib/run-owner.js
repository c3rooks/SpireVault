// Which player of a co-op save is you.
//
// A solo save lists one player, with id 1. A co-op save lists every player
// with their platform id (a 17-digit SteamID64 on Steam; the save's
// `platform_type` says which platform), in an order that has nothing to do
// with whose computer wrote the file. Each floor's `player_stats` rows carry
// the same ids as `player_id`. Nothing inside the file marks the local
// player, so the reader needs a hint from outside it, tried in this order:
//
//   1. the Steam ID in the file's own path (…/steam/<id>/profile1/saves/…),
//      which is there when the player gives SlayTheSpire2, steam or the
//      account folder, and not when they give the history folder by itself
//   2. the account whose folder the caller read (SpireVault Sync reads one)
//   3. the signed-in Steam ID
//   4. a vote: the id that is in more of this import's co-op runs than any other
//
// Until 2026-11-22 the reader took the first listed player, so a player who
// joined a friend's game saw the friend's climber, deck and card picks.
//
// No DOM, no storage. Checked by scripts/verify-run-owner.mjs.

/** A player id as a number of 16 to 20 digits after an `id` or `player_id` key. */
const BIG_PLAYER_ID = /("(?:id|player_id)"\s*:\s*)(\d{16,20})(?=\s*[,}\]])/g;
/** A folder named with a SteamID64: every player account's starts 7656119. */
const PATH_OWNER = /(?:^|[\\/])(7656119\d{10})(?=[\\/])/;
/** A vote needs the winner in at least this many co-op runs. */
const MIN_VOTE_RUNS = 2;

/**
 * Save text with its 64-bit player ids quoted, so JSON.parse keeps every
 * digit (a number that long loses its last two or three).
 * @param {string} text
 * @returns {string}
 */
export function keepPlayerIds(text) {
  return typeof text === "string" ? text.replace(BIG_PLAYER_ID, '$1"$2"') : text;
}

/**
 * @param {unknown} value a player id as the save or a hint gives it
 * @returns {string} its digits, or "" when it is not an id
 */
export function idText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Whether two ids name the same player. Exact when both kept their digits;
 * when one went through JSON.parse as a number and lost some, the two are
 * compared the way that number was rounded.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameId(a, b) {
  const left = idText(a);
  const right = idText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const isRounded = (value) => typeof value === "number" && !Number.isSafeInteger(value);
  return (isRounded(a) || isRounded(b)) && Number(left) === Number(right);
}

/** Where each file sat in the folder the player gave, for files that cannot say. */
const notedPaths = new WeakMap();

/**
 * Remembers a file's place in the folder it came from. A file from a dropped
 * folder or a folder handle has no path of its own (a File's
 * `webkitRelativePath` cannot be set), and the path says whose saves they are.
 * @param {object} file
 * @param {string} path "steam/7656…/profile1/saves/history/1.run"
 */
export function notePath(file, path) {
  if (file && typeof file === "object" && path) notedPaths.set(file, String(path));
}

/**
 * @param {any} file
 * @returns {string} the noted path, else the file's own, else its name
 */
export function pathOf(file) {
  if (!file || typeof file !== "object") return "";
  return notedPaths.get(file) || file.webkitRelativePath || file.name || "";
}

/**
 * The Steam ID of the account folder a save file sits in.
 * @param {string} path "SlayTheSpire2/steam/7656…/profile1/saves/history/1.run"
 * @returns {string} the 17 digits, or "" when the path does not say
 */
export function ownerFromPath(path) {
  const match = PATH_OWNER.exec(String(path || ""));
  return match ? match[1] : "";
}

/**
 * @param {any} raw a save as parsed JSON
 * @returns {string[]} the ids of a co-op save's players; none for a solo save
 */
export function coopPlayerIds(raw) {
  const players = Array.isArray(raw?.players) ? raw.players : [];
  if (players.length < 2) return [];
  return players.map((player) => idText(player?.id)).filter(Boolean);
}

/**
 * The player who is in more of an import's co-op saves than anyone else: the
 * one whose saves they are. "" when nobody leads (one co-op save, or always
 * the same friend), because then the saves cannot tell.
 * @param {ReadonlyArray<ReadonlyArray<string>>} coopIdLists each save's `coopPlayerIds`
 * @returns {string}
 */
export function ownerByVote(coopIdLists) {
  const counts = new Map();
  for (const ids of coopIdLists || []) {
    for (const id of new Set(ids || [])) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] < MIN_VOTE_RUNS) return "";
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) return "";
  return ranked[0][0];
}

/**
 * Where the local player sits in a save's player list.
 * @param {ReadonlyArray<any>} players the save's `players`
 * @param {Iterable<string>} [ownerIds] hints, most trusted first
 * @returns {{ index: number, known: boolean }} the first player when no hint
 *   names anyone in the list (`known` false), as the reader always did
 */
export function localSeat(players, ownerIds) {
  if (!Array.isArray(players) || players.length <= 1) return { index: 0, known: true };
  for (const owner of ownerIds || []) {
    if (!owner) continue;
    const index = players.findIndex((player) => sameId(player?.id, owner));
    if (index >= 0) return { index, known: true };
  }
  return { index: 0, known: false };
}

/**
 * The hints for one file, most trusted first, without repeats.
 * @param {{ path?: string, given?: string, signedIn?: string, voted?: string }} sources
 * @returns {string[]}
 */
export function ownerHints({ path = "", given = "", signedIn = "", voted = "" } = {}) {
  const hints = [ownerFromPath(path), idText(given), idText(signedIn), idText(voted)].filter(Boolean);
  return [...new Set(hints)];
}
