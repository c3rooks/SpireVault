// Reads the page Chromium generates when an extension fetches a file:// folder.
//
// Every entry is one script call in that page:
//   addRow("name","url-escaped name",isDir,size,"size text",mtime,"date text");
// The two names are JSON string literals, isDir is 0 or 1, size is bytes and
// mtime is whole seconds. Checked against Chrome 157 and Chromium 151 on macOS
// (docs/sync-extension/phase-0-findings.md).

/** A listing page for a few thousand runs is well under 1 MB; refuse anything absurd. */
export const MAX_LISTING_CHARS = 8 * 1024 * 1024;
/** Steam Cloud caps the game at 10,000 files; twice that covers the .backup twins. */
export const MAX_LISTING_ROWS = 20_000;

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const ROW_SOURCE = `addRow\\((${JSON_STRING}),(${JSON_STRING}),([01]),(\\d{1,15}),(${JSON_STRING}),(\\d{1,15}),(${JSON_STRING})\\);`;

/**
 * @typedef {{ name: string, isDir: boolean, size: number, mtime: number }} ListingEntry
 */

/** A name that stays inside its folder: no separators, no "." or "..", no control characters. */
export function isSafeEntryName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  // "." and "..", and their look-alikes on Windows, which drops trailing dots and spaces.
  if (/^[. ]+$/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\/\\\u0000-\u001f\u007f]/.test(name)) return false;
  // A name with half a surrogate pair cannot be written into a URL.
  try { encodeURIComponent(name); } catch { return false; }
  return true;
}

/**
 * @param {string} html the listing page's text
 * @returns {ListingEntry[]} entries with safe names only, in page order
 */
export function parseDirectoryListing(html) {
  if (typeof html !== "string" || html.length === 0 || html.length > MAX_LISTING_CHARS) return [];
  const rows = new RegExp(ROW_SOURCE, "g");
  /** @type {ListingEntry[]} */
  const entries = [];
  let match;
  while ((match = rows.exec(html)) !== null) {
    if (entries.length >= MAX_LISTING_ROWS) break;
    let name;
    try { name = JSON.parse(match[1]); } catch { continue; }
    if (!isSafeEntryName(name)) continue;
    const size = Number(match[4]);
    const mtime = Number(match[6]);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(mtime)) continue;
    entries.push({ name, isDir: match[3] === "1", size, mtime });
  }
  return entries;
}

/** True when the text is a Chromium folder listing at all (an empty folder has no rows). */
export function looksLikeDirectoryListing(html) {
  return typeof html === "string" && html.includes("addRow") && html.includes("onHasParentDirectory");
}
