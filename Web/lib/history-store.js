// history-store.js
// =========================================================================
// IndexedDB-backed persistence for the user's uploaded `history.json`.
// We keep one record at key "current" — uploads overwrite, no version history.
//
// Why IndexedDB and not localStorage?
//   `history.json` for an active player can blow past 5 MB in a hurry; that's
//   right at the localStorage ceiling on most browsers. IndexedDB is the only
//   cross-browser story for "blob of arbitrary JSON, read once on boot".
// =========================================================================

const DB_NAME = "vault-web";
const DB_VERSION = 2;
const STORE = "history";
const HANDLES_STORE = "handles";
const KEY = "current";
const HANDLE_KEY = "history-file";
/** Saved `FileSystemDirectoryHandle` from showDirectoryPicker — enables silent re-scan. */
const HANDLE_KEY_DIR = "history-directory";

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onerror = () => reject(r.error);
    r.onupgradeneeded = (event) => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
      if (event.oldVersion < 2 && !db.objectStoreNames.contains(HANDLES_STORE)) {
        db.createObjectStore(HANDLES_STORE);
      }
    };
    r.onsuccess = () => resolve(r.result);
  });
}

export async function saveHistory(record) {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, KEY);
    // `oncomplete` is the only signal that data is durably committed.
    // `onerror` and `onabort` both indicate the write was rolled back
    // (quota exceeded, low storage, browser killed the txn, …) so
    // we surface them as rejected promises and the caller can warn
    // the user instead of pretending the save succeeded.
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error || new Error("saveHistory tx errored"));
    tx.onabort    = () => rej(tx.error || new Error("saveHistory tx aborted"));
  });
  db.close();
}

export async function loadHistory() {
  const db = await open();
  const value = await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return value;
}

export async function clearHistory() {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

// =========================================================================
// FileSystemAccess handle persistence (Chromium browsers only)
//
// When the user picks history.json via showOpenFilePicker(), we stash the
// returned FileSystemFileHandle. When they pick a save folder via
// showDirectoryPicker(), we store the FileSystemDirectoryHandle instead.
// Only one anchor is active at a time (folder import clears the file key
// and vice versa). On future visits we can re-read with queryPermission
// / requestPermission instead of forcing a new picker every time.
//
// Handles are structured-cloneable across IndexedDB. They survive page
// reloads, but the *permission* attached to them is per-origin and may
// return to "prompt" until the user grants again.
// =========================================================================

export async function saveHandle(handle) {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readwrite");
    const store = tx.objectStore(HANDLES_STORE);
    store.put(handle, HANDLE_KEY);
    store.delete(HANDLE_KEY_DIR);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error || new Error("saveHandle tx errored"));
    tx.onabort    = () => rej(tx.error || new Error("saveHandle tx aborted"));
  });
  db.close();
}

export async function loadHandle() {
  const db = await open();
  const value = await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readonly");
    const req = tx.objectStore(HANDLES_STORE).get(HANDLE_KEY);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return value;
}

export async function clearHandle() {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readwrite");
    tx.objectStore(HANDLES_STORE).delete(HANDLE_KEY);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

export async function saveDirectoryHandle(handle) {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readwrite");
    const store = tx.objectStore(HANDLES_STORE);
    store.put(handle, HANDLE_KEY_DIR);
    store.delete(HANDLE_KEY);
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error || new Error("saveDirectoryHandle tx errored"));
    tx.onabort    = () => rej(tx.error || new Error("saveDirectoryHandle tx aborted"));
  });
  db.close();
}

export async function loadDirectoryHandle() {
  const db = await open();
  const value = await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readonly");
    const req = tx.objectStore(HANDLES_STORE).get(HANDLE_KEY_DIR);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
  db.close();
  return value;
}

export async function clearDirectoryHandle() {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readwrite");
    tx.objectStore(HANDLES_STORE).delete(HANDLE_KEY_DIR);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}

/**
 * Browser feature detection for File System Access API.
 * Returns true on Chromium browsers (Chrome, Edge, Brave, Opera, Arc),
 * false on Safari and Firefox.
 */
export function supportsFSA() {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}
