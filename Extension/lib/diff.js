// Which run files are new since the page last asked. Pure.
//
// The page keeps the record of what it already holds ("known": file key →
// [size, modified time]) next to its own copy of the runs, so the two can
// never disagree: clearing the site's data clears both, and two open tabs
// each get what they are missing. The extension only compares.

import { RUN_KEY } from "./paths.js";

/** One run is about 20 KB. Anything over this is not a run file. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How much one answer to the page may carry. A first read of ~700 runs is about 15 MB, so it takes a few. */
export const MAX_BATCH_BYTES = 6 * 1024 * 1024;
export const MAX_BATCH_FILES = 400;
/** More entries than the game can have; a larger "known" record is not from SpireVault. */
export const MAX_KNOWN_ENTRIES = 20_000;

/**
 * @typedef {{ key: string, size: number, mtime: number }} RunFileInfo
 * @typedef {Record<string, [number, number]>} Known file key → [size, mtime]
 */

/**
 * @param {RunFileInfo[]} listed every run file on disk right now
 * @param {Known} known what the page already holds
 * @returns {{ changed: RunFileInfo[], tooBig: RunFileInfo[], gone: string[] }}
 *   changed: new or modified, oldest first; tooBig: skipped for size; gone: known keys no longer on disk
 */
export function diffRunFiles(listed, known) {
  const record = known && typeof known === "object" ? known : {};
  const onDisk = new Set();
  /** @type {RunFileInfo[]} */
  const changed = [];
  /** @type {RunFileInfo[]} */
  const tooBig = [];
  for (const file of listed) {
    if (!file || !RUN_KEY.test(file.key)) continue;
    onDisk.add(file.key);
    const seen = Object.prototype.hasOwnProperty.call(record, file.key) ? record[file.key] : null;
    if (Array.isArray(seen) && seen[0] === file.size && seen[1] === file.mtime) continue;
    if (file.size > MAX_FILE_BYTES) tooBig.push(file);
    else changed.push(file);
  }
  changed.sort((a, b) => a.mtime - b.mtime || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const gone = Object.keys(record).filter((key) => !onDisk.has(key));
  return { changed, tooBig, gone };
}

/**
 * The first files of `changed` that fit one answer.
 * @param {RunFileInfo[]} changed
 * @returns {{ batch: RunFileInfo[], hasMore: boolean }}
 */
export function takeBatch(changed, { maxBytes = MAX_BATCH_BYTES, maxFiles = MAX_BATCH_FILES } = {}) {
  /** @type {RunFileInfo[]} */
  const batch = [];
  let bytes = 0;
  for (const file of changed) {
    if (batch.length >= maxFiles) break;
    if (batch.length > 0 && bytes + file.size > maxBytes) break;
    batch.push(file);
    bytes += file.size;
  }
  return { batch, hasMore: batch.length < changed.length };
}

/**
 * A "known" record from a page, or null when it is not one. Keys must be run
 * file keys and values [size, mtime] whole numbers.
 * @param {unknown} value
 * @returns {Known | null}
 */
export function sanitizeKnown(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > MAX_KNOWN_ENTRIES) return null;
  /** @type {Known} */
  const clean = {};
  for (const key of keys) {
    const pair = /** @type {Record<string, unknown>} */ (value)[key];
    if (!RUN_KEY.test(key) || !Array.isArray(pair) || pair.length !== 2) return null;
    const [size, mtime] = pair;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtime) || size < 0 || mtime < 0) return null;
    clean[key] = [size, mtime];
  }
  return clean;
}
