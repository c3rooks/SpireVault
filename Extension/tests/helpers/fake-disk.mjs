// A pretend disk for the tests: answers file: URLs the way Chromium does for
// an extension, with a generated listing page for folders and the text for
// files. Built from plain objects: { "name": { ...children } } is a folder,
// { "name": "text" } is a file.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Loads a real folder into the plain-object shape. */
export function loadTree(dir) {
  const tree = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    tree[name] = statSync(full).isDirectory() ? loadTree(full) : readFileSync(full, "utf8");
  }
  return tree;
}

const LISTING_HEAD = "<script>function addRow(name, url, isdir, size, size_string, date_modified, date_modified_string) {}\nfunction onHasParentDirectory() {}</script>\n";

function listingPage(node, mtimes, path) {
  const rows = Object.keys(node).sort().map((name) => {
    const child = node[name];
    const isDir = typeof child === "object";
    const size = isDir ? 0 : Buffer.byteLength(child);
    const mtime = mtimes.get(`${path}${name}`) ?? 1_795_000_000;
    return `<script>addRow(${JSON.stringify(name)},${JSON.stringify(encodeURIComponent(name))},${isDir ? 1 : 0},${size},"${size} B",${mtime},"11/19/26, 10:12:34 AM");</script>`;
  });
  return `${LISTING_HEAD}<script>onHasParentDirectory();</script>\n${rows.join("\n")}\n`;
}

/**
 * @param {object} root the whole disk as nested objects; Windows drives are top-level keys such as "C:"
 * @returns {{ readUrl: (url: string) => Promise<{ok: true, text: string} | {ok: false}>, reads: string[], setMtime: (path: string, mtime: number) => void }}
 */
export function fakeDisk(root) {
  const reads = [];
  const mtimes = new Map();
  const readUrl = async (url) => {
    reads.push(url);
    if (!url.startsWith("file:///")) return { ok: false };
    const path = decodeURIComponent(url.slice("file:///".length));
    const parts = path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts) {
      if (typeof node !== "object" || node === null || !Object.prototype.hasOwnProperty.call(node, part)) return { ok: false };
      node = node[part];
    }
    if (url.endsWith("/")) {
      if (typeof node !== "object") return { ok: false };
      return { ok: true, text: listingPage(node, mtimes, `/${parts.join("/")}${parts.length ? "/" : ""}`) };
    }
    return typeof node === "string" ? { ok: true, text: node } : { ok: false };
  };
  return { readUrl, reads, setMtime: (path, mtime) => mtimes.set(path, mtime) };
}

/** In-memory stand-in for chrome.storage.local. */
export function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key),
    set: async (key, value) => { data.set(key, value); },
    remove: async (key) => { data.delete(key); },
  };
}
