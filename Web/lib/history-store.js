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
const DB_VERSION = 1;
const STORE = "history";
const KEY = "current";

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onerror = () => reject(r.error);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
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
