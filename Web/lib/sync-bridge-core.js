// SpireVault Sync, page side: the parts with no DOM and no timers, so they
// can be checked in Node (scripts/verify-sync-bridge.mjs).
//
// The browser extension (Extension/ in the repo) reads the save folder and
// hands over the run files this page does not hold yet. This file decides
// what "does not hold yet" means and how new runs join the ones on screen.

/** Tags on window messages; must match Extension/lib/messages.js. */
export const FROM_PAGE = "spirevault-page";
export const FROM_EXTENSION = "spirevault-sync";
export const PROTOCOL = 1;

/** A run file's place below the account folder; must match RUN_KEY in Extension/lib/paths.js. */
const RUN_KEY = /^(?:modded\/)?profile\d{1,3}\/saves\/history\/[^\/\\]{1,200}\.run$/;
const MAX_KNOWN_ENTRIES = 20_000;

/**
 * @typedef {Record<string, [number, number]>} Known file key → [size, modified time]: the files this browser has already taken in
 * @typedef {{ key: string, name: string, size: number, mtime: number, text: string }} SyncedFile
 * @typedef {{ id?: string, inProgress?: boolean, startedAt?: Date | null }} RunLike
 */

/**
 * The runs to commit after a sync: the new ones plus everything already
 * loaded. The app's import replaces the whole set with what it is given
 * (right for a folder pick, which reads every file), and a sync brings only
 * the new files, so the loaded runs have to ride along.
 *
 * The run in progress, if one is on screen, stays unless one of the new runs
 * is that same run finished, or started after it.
 *
 * @template {RunLike} R
 * @param {R[]} fresh runs parsed from the files just handed over
 * @param {{ loaded: R[], live: R | null }} current what the page shows now (loaded: finished runs, never the sample set)
 * @returns {R[]}
 */
export function mergeWithLoaded(fresh, { loaded, live }) {
  const freshIds = new Set();
  for (const run of fresh) if (run?.id) freshIds.add(run.id);
  const merged = [...fresh];
  for (const run of loaded || []) {
    if (run?.id && !freshIds.has(run.id)) merged.push(run);
  }
  if (live && !fresh.some((run) => run?.inProgress) && !isSuperseded(live, fresh)) merged.push(live);
  return merged;
}

/** True when a new finished run is the live run itself, or began after it did. */
function isSuperseded(live, fresh) {
  const liveStart = live.startedAt?.getTime?.() ?? 0;
  return fresh.some((run) => {
    if (!run || run.inProgress) return false;
    if (live.id && run.id === live.id) return true;
    return liveStart > 0 && (run.startedAt?.getTime?.() ?? 0) > liveStart;
  });
}

/**
 * The record of taken-in files after one answer from the extension.
 * Returns a new object; `known` is not changed.
 * @param {Known} known
 * @param {{ files?: Array<{key: string, size: number, mtime: number}>, skipped?: Array<{key: string, size: number, mtime: number}>, gone?: string[] }} answer
 * @returns {Known}
 */
export function updateKnown(known, answer) {
  /** @type {Known} */
  const next = { ...known };
  for (const file of [...(answer.files || []), ...(answer.skipped || [])]) {
    if (isRunKey(file?.key) && Number.isSafeInteger(file.size) && Number.isSafeInteger(file.mtime)) {
      next[file.key] = [file.size, file.mtime];
    }
  }
  for (const key of answer.gone || []) delete next[key];
  return next;
}

export function isRunKey(key) {
  return typeof key === "string" && RUN_KEY.test(key);
}

/**
 * True when the stored record must be thrown away and the folder read in full:
 * it is from another epoch, or the page now holds fewer runs than when it was
 * written. Fewer runs means some were lost since (a save that did not land,
 * another tab writing an older copy), so the record lists files this browser
 * no longer has.
 * @param {unknown} stored the parsed localStorage value: { epoch, count, files }
 * @param {{ epoch: number, runCount: number }} now
 */
export function isRecordStale(stored, { epoch, runCount }) {
  if (!stored || typeof stored !== "object" || stored.epoch !== epoch) return true;
  return Number.isFinite(stored.count) && runCount < stored.count;
}

/** A stored record read back from localStorage: only well-formed entries survive. */
export function parseKnown(text) {
  /** @type {Known} */
  const known = {};
  let raw;
  try { raw = JSON.parse(text || "{}"); } catch { return known; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return known;
  let count = 0;
  for (const [key, pair] of Object.entries(raw)) {
    if (count >= MAX_KNOWN_ENTRIES) break;
    if (!isRunKey(key) || !Array.isArray(pair) || pair.length !== 2) continue;
    if (!Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]) || pair[0] < 0 || pair[1] < 0) continue;
    known[key] = [pair[0], pair[1]];
    count += 1;
  }
  return known;
}

/**
 * The files of an answer that are worth parsing: well-formed entries whose
 * text is JSON. A file caught half-written is not JSON yet; it is recorded as
 * seen like the rest, and comes back when its size or time changes.
 * @param {unknown} files
 * @returns {SyncedFile[]}
 */
export function readableFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => {
    if (!file || !isRunKey(file.key) || typeof file.text !== "string" || typeof file.name !== "string") return false;
    if (!file.name.endsWith(".run") || /[\/\\]/.test(file.name)) return false;
    try { JSON.parse(file.text); return true; } catch { return false; }
  });
}

/**
 * True in a desktop Chromium browser (Chrome, Edge, Brave, Arc, Opera): the
 * only place the extension can run. Phones, tablets, Safari and Firefox keep
 * the manual import.
 * @param {{ userAgent?: string, userAgentData?: { mobile?: boolean, brands?: Array<{ brand: string }> }, maxTouchPoints?: number }} nav
 */
export function isSupportedBrowser(nav) {
  const ua = String(nav?.userAgent || "");
  const data = nav?.userAgentData;
  if (data && Array.isArray(data.brands)) {
    if (data.mobile) return false;
    return data.brands.some((entry) => /chromium/i.test(String(entry?.brand)));
  }
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return false;
  if (/Firefox\/|FxiOS/i.test(ua)) return false;
  return /Chrome\/\d+/.test(ua);
}

/** "edge" in Microsoft Edge, otherwise "chrome" (Brave, Arc and Opera install from the Chrome store). */
export function storeFor(nav) {
  const brands = nav?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some((entry) => /Microsoft Edge/i.test(String(entry?.brand)))) return "edge";
  return /\bEdg\//.test(String(nav?.userAgent || "")) ? "edge" : "chrome";
}

/** "just now", "2 min ago", "3 h ago", "2 days ago". */
export function agoLabel(at, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function runsLabel(count) {
  return `${count} run${count === 1 ? "" : "s"}`;
}

/** A sync that has not answered for this long no longer counts as live. */
export const LIVE_FOR_MS = 10 * 60_000;

/**
 * What the runs status line says while sync is working, or null to leave the
 * line to the app ("Saves read 3d ago").
 * @param {{ phase: string, lastOkAt: number }} state
 * @param {{ count: number, now?: number }} view
 * @returns {{ live: boolean, stale: boolean, main: string, sub: string } | null}
 */
export function statusLine(state, { count, now = Date.now() }) {
  if (state.phase !== "connected" || !state.lastOkAt) return null;
  if (now - state.lastOkAt > LIVE_FOR_MS) return null;
  return { live: true, stale: false, main: `Synced ${agoLabel(state.lastOkAt, now)}`, sub: runsLabel(count) };
}

/**
 * When the next automatic pull of the Steam copy is due.
 * @param {{ lastAt: number, failures: number }} pull
 * @param {{ everyMs: number, maxMs: number }} pace
 */
export function nextPullAt(pull, { everyMs, maxMs }) {
  const backoff = Math.min(maxMs, everyMs * 2 ** Math.min(pull.failures, 6));
  return pull.lastAt + backoff;
}
