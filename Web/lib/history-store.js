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
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
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
// FileSystemFileHandle persistence (Chromium browsers only)
//
// When the user picks history.json via showOpenFilePicker(), we stash the
// returned handle here. On future visits we can re-read the same file with
// one click + a permission prompt, instead of forcing the user to navigate
// the file picker every single time.
//
// Handles are structured-cloneable across IndexedDB. They survive page
// reloads, but the *permission* attached to them is per-origin and is
// re-prompted on each session (you can't silently keep file access).
// =========================================================================

export async function saveHandle(handle) {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(HANDLES_STORE, "readwrite");
    tx.objectStore(HANDLES_STORE).put(handle, HANDLE_KEY);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
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

/**
 * Browser feature detection for File System Access API.
 * Returns true on Chromium browsers (Chrome, Edge, Brave, Opera, Arc),
 * false on Safari and Firefox.
 */
export function supportsFSA() {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}
