// history-store.js
// =========================================================================
// IndexedDB-backed persistence for the user's uploaded `history.json`.
//
// Storage keys
// ------------
// Guests:     "current"
// Signed-in:  "current:<steamID>"
//
// Per-Steam-ID keying ensures a shared browser (kiosk, public PC, family
// machine) never leaks one user's run history to the next person who
// signs in with a different account. Guests still use the legacy key so
// drag-and-drop without a login keeps working.
//
// The active key is set at boot via `setActiveSteamID(id)`. If no Steam
// ID is set, all reads/writes fall through to the legacy `"current"`
// key. Migration: on first signed-in read, if the per-Steam-ID record
// is empty AND the legacy `"current"` record has data, we copy the
// legacy record forward (without deleting it — preserves the legacy
// path for the same browser used in guest mode again later).
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
const LEGACY_KEY = "current";
const HANDLE_KEY = "history-file";
/** Saved `FileSystemDirectoryHandle` from showDirectoryPicker — enables silent re-scan. */
const HANDLE_KEY_DIR = "history-directory";

let activeSteamID = null;

/** Set the Steam ID used to scope history reads/writes. Call after
 *  successful sign-in (or with `null` on sign-out). Idempotent. */
export function setActiveSteamID(steamID) {
  activeSteamID = steamID && /^\d{17}$/.test(steamID) ? steamID : null;
}

/** Resolve the IDB key for the active scope. */
function activeHistoryKey() {
  return activeSteamID ? `${LEGACY_KEY}:${activeSteamID}` : LEGACY_KEY;
}

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
  const key = activeHistoryKey();
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record, key);
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
  const key = activeHistoryKey();
  const db = await open();
  const value = await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
  db.close();
  if (!activeSteamID) return value;
  // Signed-in path: prefer the richer record across scoped+legacy. This
  // fixes the "stuck at 1 run" class where an old scoped snapshot exists
  // but the user later imported a much larger set under legacy scope.
  const legacy = await new Promise((res) => {
    open().then((db2) => {
      const tx2 = db2.transaction(STORE, "readonly");
      const req2 = tx2.objectStore(STORE).get(LEGACY_KEY);
      req2.onsuccess = () => { res(req2.result ?? null); db2.close(); };
      req2.onerror = () => { res(null); try { db2.close(); } catch {} };
    }).catch(() => res(null));
  });

  const scopedRuns = Array.isArray(value?.runs) ? value.runs.length : 0;
  const legacyRuns = Array.isArray(legacy?.runs) ? legacy.runs.length : 0;
  if (!value) return legacy;
  if (legacyRuns > scopedRuns) return legacy;
  return value;
}

/** Clear the history record under the **active scope**. Defaults to
 *  the active scope (Steam-keyed when signed in, legacy otherwise).
 *  Pass `{ allScopes: true }` to wipe every history record (used on
 *  sign-out so a shared browser cannot leak one user's runs to the
 *  next signed-in user). */
export async function clearHistory(opts = {}) {
  const db = await open();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (opts.allScopes) {
      // Wipe every record in the store — both the legacy "current"
      // and any "current:<steamID>" entries from prior sessions.
      const req = store.openCursor();
      req.onsuccess = (ev) => {
        const cur = ev.target.result;
        if (cur) { cur.delete(); cur.continue(); }
      };
      req.onerror = () => rej(req.error);
    } else {
      store.delete(activeHistoryKey());
    }
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
