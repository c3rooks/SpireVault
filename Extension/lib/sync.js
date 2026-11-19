// Finds the save folder, lists the run files and reads the new ones.
//
// No chrome.* here: the service worker passes in how to read a URL and where
// to remember the folder, so the same code runs against a pretend disk in the
// tests. Reading is all this does; nothing is ever written to the player's
// files, and nothing outside a SlayTheSpire2 folder is ever opened except the
// one list of user folders needed to find it.

import { parseDirectoryListing, looksLikeDirectoryListing } from "./listing.js";
import {
  STEAM_ID, PROFILE_DIR, MODDED_DIR, RUN_FILE,
  homeParents, rootCandidates, accountUrl, historyUrl, runFileUrl,
  isHomeCandidate, isGameRootUrl, parsePastedPath, rootFromHome, describeRoot,
} from "./paths.js";
import { diffRunFiles, takeBatch, MAX_FILE_BYTES } from "./diff.js";

/** How many files are read at once. */
const READ_CONCURRENCY = 8;
/** Profiles are profile1..3 today; a wild folder cannot make the walk unbounded. */
const MAX_PROFILES = 24;
/** User folders tried when looking for the game folder. */
const MAX_HOMES = 40;
/** Batches tried in one answer when the files at the front cannot be read. */
const MAX_BATCH_TRIES = 25;

export const STORE_ROOT = "root.v1";
export const STORE_PASTED = "pastedRoot.v1";

/**
 * @typedef {{ ok: true, text: string } | { ok: false }} ReadResult
 * @typedef {(url: string) => Promise<ReadResult>} ReadUrl reads a file: URL as text; folders answer with Chromium's listing page
 * @typedef {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void>, remove: (key: string) => Promise<void> }} Store
 * @typedef {{ readUrl: ReadUrl, store: Store, os: string }} Deps
 */

/** @param {ReadUrl} readUrl @param {string} dirUrl @returns {Promise<import("./listing.js").ListingEntry[] | null>} null when the folder cannot be read */
async function listDir(readUrl, dirUrl) {
  if (!dirUrl.endsWith("/")) return null;
  const res = await readUrl(dirUrl);
  if (!res.ok || !looksLikeDirectoryListing(res.text)) return null;
  return parseDirectoryListing(res.text);
}

/** The account folder to read under `rootUrl`: the signed-in one, or the most recently used when nobody is signed in. */
async function findAccount(readUrl, rootUrl, steamId) {
  if (steamId) {
    const listing = await listDir(readUrl, accountUrl(rootUrl, steamId));
    return listing ? steamId : null;
  }
  const accounts = await listDir(readUrl, `${rootUrl}steam/`);
  if (!accounts) return null;
  const newest = accounts
    .filter((entry) => entry.isDir && STEAM_ID.test(entry.name))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest ? newest.name : null;
}

/** Every user folder on this computer, as file: URLs ending in "/". */
async function listHomes(readUrl, os) {
  const homes = [];
  for (const parent of homeParents(os)) {
    const entries = await listDir(readUrl, parent);
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.isDir && isHomeCandidate(entry.name)) homes.push(`${parent}${encodeURIComponent(entry.name)}/`);
    }
  }
  return homes.slice(0, MAX_HOMES);
}

/**
 * Finds the game folder and the account inside it.
 * Order: the folder that worked last time, a folder the player pasted, then
 * the standard place under each user folder.
 * @param {Deps} deps
 * @param {string} steamId "" when nobody is signed in
 * @returns {Promise<{ ok: true, rootUrl: string, steamId: string } | { ok: false, reason: "no-save-folder" | "no-account-folder" }>}
 */
export async function locateSaves(deps, steamId) {
  const { readUrl, store, os } = deps;
  /** @type {string[]} */
  const roots = [];
  const remembered = await store.get(STORE_ROOT);
  if (isGameRootUrl(remembered)) roots.push(remembered);
  const pasted = await store.get(STORE_PASTED);
  if (isGameRootUrl(pasted) && !roots.includes(pasted)) roots.push(pasted);

  let sawGameFolder = false;
  const tryRoot = async (rootUrl) => {
    const account = await findAccount(readUrl, rootUrl, steamId);
    if (account) return account;
    if (!sawGameFolder && await listDir(readUrl, rootUrl)) sawGameFolder = true;
    return null;
  };

  for (const rootUrl of roots) {
    const account = await tryRoot(rootUrl);
    if (account) return { ok: true, rootUrl, steamId: account };
  }
  for (const homeUrl of await listHomes(readUrl, os)) {
    for (const rootUrl of rootCandidates(os, homeUrl)) {
      if (roots.includes(rootUrl)) continue;
      const account = await tryRoot(rootUrl);
      if (account) {
        await store.set(STORE_ROOT, rootUrl);
        return { ok: true, rootUrl, steamId: account };
      }
    }
  }
  return { ok: false, reason: sawGameFolder ? "no-account-folder" : "no-save-folder" };
}

/**
 * Every finished run on disk for one account: all profiles, plus the separate
 * save set the game uses while any mod is on.
 * @param {ReadUrl} readUrl
 * @param {string} accountDirUrl
 * @returns {Promise<{ files: import("./diff.js").RunFileInfo[], profiles: string[] }>}
 */
export async function listRunFiles(readUrl, accountDirUrl) {
  /** @type {string[]} */
  const profileKeys = [];
  const top = await listDir(readUrl, accountDirUrl) || [];
  for (const entry of top) {
    if (entry.isDir && PROFILE_DIR.test(entry.name)) profileKeys.push(entry.name);
  }
  if (top.some((entry) => entry.isDir && entry.name === MODDED_DIR)) {
    const modded = await listDir(readUrl, `${accountDirUrl}${MODDED_DIR}/`) || [];
    for (const entry of modded) {
      if (entry.isDir && PROFILE_DIR.test(entry.name)) profileKeys.push(`${MODDED_DIR}/${entry.name}`);
    }
  }
  /** @type {import("./diff.js").RunFileInfo[]} */
  const files = [];
  /** @type {string[]} */
  const profiles = [];
  for (const profileKey of profileKeys.slice(0, MAX_PROFILES)) {
    const history = await listDir(readUrl, historyUrl(accountDirUrl, profileKey));
    if (!history) continue;
    profiles.push(profileKey);
    for (const entry of history) {
      if (entry.isDir || !RUN_FILE.test(entry.name)) continue;
      files.push({ key: `${profileKey}/saves/history/${entry.name}`, size: entry.size, mtime: entry.mtime });
    }
  }
  return { files, profiles };
}

/** Reads `batch` a few files at a time. A file that cannot be read, or grew past the cap, is left out and retried next time. */
async function readBatch(readUrl, accountDirUrl, batch) {
  /** @type {{ key: string, name: string, size: number, mtime: number, text: string }[]} */
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const file = batch[next];
      next += 1;
      const url = runFileUrl(accountDirUrl, file.key);
      if (!url) continue;
      const res = await readUrl(url);
      if (!res.ok || res.text.length === 0 || res.text.length > MAX_FILE_BYTES) continue;
      out.push({ key: file.key, name: file.key.slice(file.key.lastIndexOf("/") + 1), size: file.size, mtime: file.mtime, text: res.text });
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, batch.length) }, worker));
  const order = new Map(batch.map((file, index) => [file.key, index]));
  return out.sort((a, b) => order.get(a.key) - order.get(b.key));
}

/**
 * One answer to the page's "anything new?": the run files it does not hold yet.
 * @param {Deps} deps
 * @param {{ steamId: string, known: import("./diff.js").Known }} request
 */
export async function syncOnce(deps, request) {
  const located = await locateSaves(deps, request.steamId);
  if (!located.ok) return { ok: false, reason: located.reason };
  const accountDirUrl = accountUrl(located.rootUrl, located.steamId);
  const { files: listed, profiles } = await listRunFiles(deps.readUrl, accountDirUrl);
  const { changed, tooBig, gone } = diffRunFiles(listed, request.known);
  // Files that cannot be read are left for a later pass; move on to the next ones rather than answer empty.
  let files = [];
  let offered = 0;
  for (let attempt = 0; attempt < MAX_BATCH_TRIES && files.length === 0 && offered < changed.length; attempt += 1) {
    const { batch } = takeBatch(changed.slice(offered));
    files = await readBatch(deps.readUrl, accountDirUrl, batch);
    offered += batch.length;
  }
  // Only a history folder that was listed just now can say a file is gone. A
  // listing that failed says nothing, and must not make the page read everything again.
  const listedProfiles = new Set(profiles);
  return {
    ok: true,
    steamId: located.steamId,
    folder: describeRoot(located.rootUrl),
    runFiles: listed.length,
    profiles,
    files,
    // Recorded by the page as seen, so they are not asked for again every minute.
    skipped: tooBig.map((file) => ({ key: file.key, size: file.size, mtime: file.mtime })),
    gone: gone.filter((key) => listedProfiles.has(key.slice(0, key.indexOf("/saves/")))),
    hasMore: offered < changed.length,
  };
}

/**
 * Remembers a save folder the player pasted, if it really holds the game's saves.
 * @param {Deps} deps
 * @param {string} path
 * @returns {Promise<{ ok: true, folder: string } | { ok: false, reason: "bad-path" | "no-save-folder" }>}
 */
export async function setPastedFolder(deps, path) {
  const parsed = parsePastedPath(path);
  if (!parsed) return { ok: false, reason: "bad-path" };
  /** @type {string[]} */
  let candidates = [];
  if ("rootUrl" in parsed) {
    candidates = [parsed.rootUrl];
  } else {
    for (const homeUrl of await listHomes(deps.readUrl, deps.os)) {
      const rootUrl = rootFromHome(homeUrl, parsed.tail);
      if (rootUrl) candidates.push(rootUrl);
    }
  }
  for (const rootUrl of candidates) {
    if (await listDir(deps.readUrl, `${rootUrl}steam/`)) {
      await deps.store.set(STORE_PASTED, rootUrl);
      return { ok: true, folder: describeRoot(rootUrl) };
    }
  }
  return { ok: false, reason: "no-save-folder" };
}

/** Forgets both the pasted folder and the one found automatically. */
export async function forgetFolders(deps) {
  await deps.store.remove(STORE_PASTED);
  await deps.store.remove(STORE_ROOT);
  return { ok: true };
}
