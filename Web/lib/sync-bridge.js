// SpireVault Sync, page side.
//
// Two things keep the runs on screen current with no clicks:
//
//   1. The Steam copy. A signed-in tab pulls it again when the tab is shown
//      and every few minutes, so runs uploaded from another device (or by the
//      extension in another browser) appear by themselves.
//   2. The browser extension (Extension/ in the repo). It reads the save
//      folder, which no web page may do, and hands over the run files this
//      browser has not taken in yet. This module asks it on load, when the
//      tab is shown, and on a timer, then gives the files to the app's own
//      import, which parses, draws and uploads them.
//
// script.js calls start() once and reads isConnected() / runsStatus(); the
// hooks are listed in docs/sync-extension/web-hooks.md.

import {
  FROM_PAGE, FROM_EXTENSION, PROTOCOL,
  mergeWithLoaded, updateKnown, parseKnown, readableFiles, isRecordStale,
  isSupportedBrowser, storeFor, statusLine, nextPullAt,
} from "/lib/sync-bridge-core.js?v=1";
import { createView } from "/lib/sync-bridge-view.js?v=1";

export { mergeWithLoaded };

// ── Settings ──────────────────────────────────────────────────────────────

/** The extension's store pages. Empty until it is published; setup is then offered
 *  only where the extension is already installed or with ?sync=1 (for testing). */
const STORE_URLS = Object.freeze({ chrome: "", edge: "" });

const STYLESHEET = "/lib/sync-bridge.css?v=2";

/** How often an open tab asks the extension for new runs. */
const EXT_SYNC_VISIBLE_MS = 45_000;
const EXT_SYNC_HIDDEN_MS = 5 * 60_000;
/** Coming back to the tab asks at once, but not more often than this. */
const EXT_SYNC_MIN_GAP_MS = 5_000;
/** After an import that took nothing in, the same files are not tried again for this long. */
const EXT_SYNC_RETRY_MS = 10 * 60_000;
/** How long the extension gets to answer "are you there?". */
const PROBE_TIMEOUT_MS = 1_500;
/** A first read of a large library is a few answers of several MB each. */
const SYNC_TIMEOUT_MS = 90_000;
const MAX_SYNC_PASSES = 40;
/** Text held from one sync before it is imported; the rest comes with the next pass. */
const MAX_SYNC_CHARS = 100 * 1024 * 1024;

/** The Steam copy: every request is the whole copy, so pulls stay rare. */
const CLOUD_PULL_EVERY_MS = 5 * 60_000;
const CLOUD_PULL_MIN_GAP_MS = 2 * 60_000;
const CLOUD_PULL_MAX_BACKOFF_MS = 30 * 60_000;

const TICK_MS = 5_000;

const STORAGE_KNOWN = "vault.sync.known.v1";
const STORAGE_ANNOUNCED = "vault.sync.announced.v1";
const STORAGE_PREVIEW = "vault.sync.preview.v1";
const STORAGE_PAUSED = "vault.sync.paused.v1";
/** Bump to make every browser read the whole save folder again (after a parser fix, say). */
const SYNC_EPOCH = 1;

// ── State ─────────────────────────────────────────────────────────────────

/**
 * phase: "unknown" (not asked yet) · "unsupported" (phone, Safari, Firefox,
 * desktop app) · "absent" (no extension) · "needs-switch" (file access off) ·
 * "paused" (the player cleared their runs here) · "reading" · "connected" ·
 * "no-folder" · "no-account"
 */
const state = { phase: "unknown", os: "", version: "", lastOkAt: 0 };

/** @type {null | {
 *   getSteamId: () => string, isSignedIn: () => boolean, runCount: () => number,
 *   ingest: (files: File[], from?: { owner: string }) => Promise<boolean>, pullCloud: () => Promise<{ failed?: boolean } | undefined>,
 *   toast: (message: string) => void, onChange: () => void, isDesktopHost: boolean,
 * }} */
let deps = null;
let view = null;
let requestSeq = 0;
/** @type {Map<string, (reply: any) => void>} */
const waiting = new Map();
let lastSyncTryAt = 0;
let retryNotBefore = 0;
/** The sync in flight, and the one more that may wait behind it. */
/** @type {Promise<number> | null} */
let running = null;
/** @type {{ everything: boolean, promise: Promise<number> } | null} */
let followUp = null;
const cloudPull = { lastAt: 0, failures: 0, isRunning: false };

function setPhase(phase) {
  if (state.phase === phase) return;
  state.phase = phase;
  notify();
}

function notify() {
  try { view?.render(); } catch (error) { console.warn("[SpireVault Sync] view failed", error); }
  try { deps?.onChange(); } catch { /* the status line is cosmetic */ }
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; /* private mode */ }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: the next visit reads everything again */ }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* private mode */ }
}

function isPaused() {
  return storageGet(STORAGE_PAUSED) === "1";
}

// ── Talking to the extension ──────────────────────────────────────────────

function ask(type, payload = {}, timeoutMs = SYNC_TIMEOUT_MS) {
  requestSeq += 1;
  const id = `r${requestSeq}-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve(null); }, timeoutMs);
    waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    window.postMessage({ ...payload, source: FROM_PAGE, v: PROTOCOL, id, type }, window.location.origin);
  });
}

/** The extension went away mid-request: nobody will answer what is still waiting. */
function failWaiting() {
  for (const [id, done] of [...waiting]) {
    waiting.delete(id);
    done(null);
  }
}

function onWindowMessage(event) {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data.source !== FROM_EXTENSION) return;
  if (data.type === "reply" && typeof data.id === "string") {
    const done = waiting.get(data.id);
    if (!done) return;
    waiting.delete(data.id);
    done(data.reply && typeof data.reply === "object" ? data.reply : null);
  } else if (data.type === "hello") {
    // The extension just arrived in this tab: added, updated, or back after the file switch.
    applyStatus(data.reply);
    void syncNow();
  } else if (data.type === "gone") {
    // Restarted or removed. A restart says hello again within a second or two.
    failWaiting();
    setTimeout(() => { void probe(); }, PROBE_TIMEOUT_MS);
  }
}

function applyStatus(reply) {
  if (!reply || reply.ok !== true || reply.protocol !== PROTOCOL) return false;
  state.os = typeof reply.os === "string" ? reply.os : "";
  state.version = typeof reply.version === "string" ? reply.version : "";
  if (!reply.fileAccess) setPhase("needs-switch");
  else if (isPaused()) setPhase("paused");
  else if (["unknown", "absent", "needs-switch", "paused"].includes(state.phase)) setPhase("reading");
  return true;
}

/** Asks whether the extension is there. Sets "absent" when nothing answers. */
async function probe() {
  const reply = await ask("status", {}, PROBE_TIMEOUT_MS);
  if (!applyStatus(reply)) setPhase("absent");
  return state.phase;
}

// ── Syncing from the save folder ──────────────────────────────────────────

function knownKey(owner) {
  return `${STORAGE_KNOWN}:${owner || "guest"}`;
}

/**
 * What this tab has taken in, per account. Read from storage once, then kept
 * here: another tab's syncs must not make this one skip files it never got.
 * @type {Map<string, import("/lib/sync-bridge-core.js").Known>}
 */
const knownByOwner = new Map();

/** The files this tab has taken in for `owner`, or nothing when the stored record cannot be trusted. */
function loadKnown(owner, runCount) {
  const held = knownByOwner.get(owner);
  if (held) return held;
  let stored;
  try { stored = JSON.parse(storageGet(knownKey(owner)) || "null"); } catch { stored = null; }
  if (isRecordStale(stored, { epoch: SYNC_EPOCH, runCount })) return {};
  return parseKnown(JSON.stringify(stored.files || {}));
}

function saveKnown(owner, known, runCount) {
  knownByOwner.set(owner, known);
  storageSet(knownKey(owner), JSON.stringify({ epoch: SYNC_EPOCH, count: runCount, files: known }));
}

function forgetKnown() {
  knownByOwner.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`${STORAGE_KNOWN}:`)) localStorage.removeItem(key);
    }
  } catch { /* private mode */ }
}

function canSync() {
  return state.phase === "reading" || state.phase === "connected" || state.phase === "no-folder" || state.phase === "no-account";
}

/** The extension is in but cannot find the saves; only the player can change that, so ask rarely. */
function isWaitingOnPlayer() {
  return state.phase === "no-folder" || state.phase === "no-account";
}

/**
 * Asks the extension for the run files this browser has not taken in, and
 * imports them. One sync runs at a time; one more may wait behind it (a
 * Refresh that arrives mid-sync makes that one a full read).
 * @returns {Promise<number>} how many runs were added, or -1 when the sync could not run
 */
function runSync({ everything = false } = {}) {
  if (!running) {
    running = syncOnce({ everything }).finally(() => { running = null; });
    return running;
  }
  if (!followUp) {
    const next = { everything, promise: Promise.resolve(-1) };
    next.promise = running.then(() => {
      followUp = null;
      return runSync({ everything: next.everything });
    });
    followUp = next;
  } else if (everything) {
    followUp.everything = true;
  }
  return followUp.promise;
}

/** `everything` reads the whole folder again (Refresh). */
async function syncOnce({ everything }) {
  if (!deps || !canSync()) return -1;
  lastSyncTryAt = Date.now();
  try {
    const owner = deps.getSteamId() || "";
    // A page with no runs holds nothing, whatever the record says (cleared data, another account).
    let known = everything || deps.runCount() === 0 ? {} : loadKnown(owner, deps.runCount());
    const collected = [];
    // The account folder the extension read: whose saves these are, which a
    // co-op save does not say for itself (lib/run-owner.js).
    let readFrom = owner;
    let chars = 0;
    for (let pass = 0; pass < MAX_SYNC_PASSES && chars < MAX_SYNC_CHARS; pass += 1) {
      const reply = await ask("sync", { steamId: owner, known });
      if (!reply || reply.reason === "no-answer") { void probe(); return -1; }
      if (reply.ok !== true) { applyFailure(reply.reason); return -1; }
      if (typeof reply.steamId === "string" && reply.steamId) readFrom = reply.steamId;
      const readable = readableFiles(reply.files);
      for (const file of readable) chars += file.text.length;
      collected.push(...readable);
      known = updateKnown(known, reply);
      const delivered = Array.isArray(reply.files) ? reply.files.length : 0;
      if (!reply.hasMore || delivered === 0) break;
    }
    // Signed out or switched account while reading: these files are not this session's.
    if ((deps.getSteamId() || "") !== owner) return -1;
    // Cleared while reading: the player asked for these runs to go.
    if (isPaused()) return -1;
    const before = deps.runCount();
    if (collected.length > 0) {
      const files = collected.map((file) => new File([file.text], file.name, { type: "application/json", lastModified: file.mtime * 1000 }));
      const wasTakenIn = await deps.ingest(files, { owner: readFrom });
      if (!wasTakenIn) {
        // Nothing parsed. Leave the record as it was, so these files are read
        // again later (a newer build may understand them), but not every pass.
        retryNotBefore = Date.now() + EXT_SYNC_RETRY_MS;
        return -1;
      }
    }
    saveKnown(owner, known, deps.runCount());
    retryNotBefore = 0;
    state.lastOkAt = Date.now();
    const wasConnected = state.phase === "connected";
    state.phase = "connected";
    notify();
    if (!wasConnected) announceOnce();
    return Math.max(0, deps.runCount() - before);
  } catch (error) {
    console.warn("[SpireVault Sync] sync failed", error);
    return -1;
  }
}

function applyFailure(reason) {
  if (reason === "no-file-access") setPhase("needs-switch");
  else if (reason === "no-save-folder") setPhase("no-folder");
  else if (reason === "no-account-folder") setPhase("no-account");
  else console.warn("[SpireVault Sync] the extension refused:", reason);
}

/** The first time sync works in this browser, say so once. */
function announceOnce() {
  if (storageGet(STORAGE_ANNOUNCED) === "1" && !view?.isOpen()) return;
  storageSet(STORAGE_ANNOUNCED, "1");
  deps.toast("Auto-sync is on. New runs show up here by themselves.");
}

/** Ask now. With `announce` (Refresh), reads the whole folder again and says what it found. */
export async function syncNow({ announce = false } = {}) {
  const added = await runSync({ everything: announce });
  if (announce && deps) {
    if (added < 0) deps.toast("Couldn't read your saves through SpireVault Sync. Check that the extension is still on.");
    else if (added === 0) deps.toast("Already up to date.");
  }
  return added;
}

/**
 * The player cleared their runs from this browser: stop bringing them back.
 * Stays off until they turn auto-sync on again from the toolbar.
 */
export function pause() {
  forgetKnown();
  // Only where sync was running: a player who adds the extension later has not paused anything.
  if (!canSync()) return;
  storageSet(STORAGE_PAUSED, "1");
  state.lastOkAt = 0;
  setPhase("paused");
}

/** Turns auto-sync back on after pause(). */
export function resume() {
  storageRemove(STORAGE_PAUSED);
  void probe().then(() => syncNow());
}

// ── Pulling the Steam copy ────────────────────────────────────────────────

async function pullCloudIfDue({ minGapMs }) {
  if (!deps || cloudPull.isRunning || !deps.isSignedIn()) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const now = Date.now();
  const dueAt = cloudPull.failures > 0
    ? nextPullAt(cloudPull, { everyMs: CLOUD_PULL_EVERY_MS, maxMs: CLOUD_PULL_MAX_BACKOFF_MS })
    : cloudPull.lastAt + minGapMs;
  if (now < dueAt) return;
  cloudPull.isRunning = true;
  cloudPull.lastAt = now;
  try {
    const result = await deps.pullCloud();
    cloudPull.failures = result?.failed ? cloudPull.failures + 1 : 0;
  } catch {
    cloudPull.failures += 1;
  } finally {
    cloudPull.isRunning = false;
  }
}

// ── Timers ────────────────────────────────────────────────────────────────

function isVisible() {
  return document.visibilityState === "visible";
}

function tick() {
  const now = Date.now();
  const every = isVisible() && !isWaitingOnPlayer() ? EXT_SYNC_VISIBLE_MS : EXT_SYNC_HIDDEN_MS;
  if (canSync() && now >= retryNotBefore && now - lastSyncTryAt >= every) void syncNow();
  if (isVisible()) void pullCloudIfDue({ minGapMs: CLOUD_PULL_EVERY_MS });
}

/** The tab came back to the front: the likeliest moment a game just ended. */
function onShown() {
  if (!isVisible()) return;
  const now = Date.now();
  if (state.phase === "absent" || state.phase === "needs-switch") void probe().then(() => syncNow());
  else if (canSync() && now >= retryNotBefore && now - lastSyncTryAt >= EXT_SYNC_MIN_GAP_MS) void syncNow();
  void pullCloudIfDue({ minGapMs: CLOUD_PULL_MIN_GAP_MS });
}

// ── Public surface ────────────────────────────────────────────────────────

/** True while the extension is reading the save folder for this tab. */
export function isConnected() {
  return state.phase === "connected" || state.phase === "reading";
}

/** The runs status line while sync is live ("Synced 2 min ago · 732 runs"), else null. */
export function runsStatus({ count }) {
  return statusLine(state, { count });
}

/** For checks and debugging: a copy of the current state. */
export function snapshot() {
  return { ...state };
}

function isPreview() {
  try {
    const flag = new URLSearchParams(window.location.search).get("sync");
    if (flag === "1") storageSet(STORAGE_PREVIEW, "1");
    if (flag === "0") storageRemove(STORAGE_PREVIEW);
  } catch { /* an odd URL: no flag */ }
  return storageGet(STORAGE_PREVIEW) === "1";
}

function addStylesheet() {
  if (document.querySelector("link[data-svs-styles]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLESHEET;
  link.setAttribute("data-svs-styles", "");
  document.head.append(link);
}

/**
 * Called once by script.js after the first paint.
 * @param {NonNullable<typeof deps>} options
 */
export function start(options) {
  if (deps) return;
  deps = options;
  // The Steam copy was just read at boot; the first automatic pull waits its turn.
  cloudPull.lastAt = Date.now();
  document.addEventListener("visibilitychange", onShown);
  window.addEventListener("focus", onShown);
  window.addEventListener("online", onShown);
  setInterval(tick, TICK_MS);

  if (options.isDesktopHost || !isSupportedBrowser(navigator)) {
    // Phones, Safari, Firefox and the desktop apps keep the manual import; they still get the Steam copy pulls.
    state.phase = "unsupported";
    return;
  }
  const store = storeFor(navigator);
  const viewOptions = {
    storeUrl: STORE_URLS[store] || STORE_URLS.chrome,
    storeName: store === "edge" ? "Edge Add-ons store" : "Chrome Web Store",
  };
  const isOffered = Boolean(viewOptions.storeUrl) || isPreview();
  window.addEventListener("message", onWindowMessage);
  void probe().then((phase) => {
    // Until the extension is in a store, players who do not have it see nothing new.
    if (phase === "absent" && !isOffered) return;
    mountView(viewOptions);
    void syncNow();
  });
  // An extension added later says hello; make sure the card exists by then.
  window.addEventListener("message", function onHello(event) {
    if (event.source !== window || event.data?.source !== FROM_EXTENSION || event.data?.type !== "hello") return;
    window.removeEventListener("message", onHello);
    mountView(viewOptions);
  });
}

function mountView({ storeUrl, storeName }) {
  if (view) return;
  addStylesheet();
  view = createView({
    getState: () => state,
    runCount: () => deps.runCount(),
    storeUrl,
    storeName,
    actions: {
      openSettings: () => { void ask("open-settings", {}, PROBE_TIMEOUT_MS); },
      setFolder: async (path) => {
        const reply = await ask("set-folder", { path }, SYNC_TIMEOUT_MS);
        if (reply?.ok) { setPhase("reading"); void syncNow(); }
        return { ok: Boolean(reply?.ok), reason: reply?.reason };
      },
      recheck: () => { void probe().then(() => syncNow()); },
      resume,
    },
  });
  view.render();
  // The import screen is redrawn with every tab render; put the offer back when it is.
  const observer = new MutationObserver(() => view.render());
  document.querySelectorAll(".panel-body").forEach((body) => observer.observe(body, { childList: true }));
  // "Synced 2 min ago" in the open card should not stand still.
  setInterval(() => { if (view.isOpen()) view.render(); }, TICK_MS);
}
