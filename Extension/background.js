// SpireVault Sync: service worker.
//
// A read-only bridge between the Slay the Spire 2 save folder and an open
// SpireVault tab. The page asks "anything new?"; this lists the save folder,
// reads the run files the page does not hold yet and hands their text back.
// It keeps no account data, holds no sign-in, runs no remote code and never
// writes to disk. The rules for what may be read live in lib/paths.js.

import { PROTOCOL, POPUP_TYPES, parsePageRequest, isAllowedOrigin } from "./lib/messages.js";
import { syncOnce, setPastedFolder, forgetFolders } from "./lib/sync.js";

const manifest = chrome.runtime.getManifest();
/** The SpireVault origins, exactly as the manifest lists them for the bridge. */
const APP_PATTERNS = manifest.content_scripts[0].matches;
const APP_HOME = "https://app.spirevault.app/";

const STORE_LAST_SYNC = "lastSync.v1";
const STORE_FILE_ACCESS = "fileAccess.v1";
const SESSION_INJECTED = "bridgeInjected";
const SESSION_SETTINGS_OPENED = "settingsOpenedAt";
/** A page may ask for the settings page again only after this long. */
const SETTINGS_REOPEN_MS = 5_000;
/** Sync requests wait in line (two tabs asking at once is normal); more than this is not SpireVault. */
const MAX_WAITING_SYNCS = 4;

/** Player's files are read through here and nowhere else. Folders answer with Chromium's listing page. */
async function readUrl(url) {
  if (typeof url !== "string" || !url.startsWith("file:///")) return { ok: false };
  try {
    const res = await fetch(url);
    return { ok: true, text: await res.text() };
  } catch {
    // Missing folder, or "Allow access to file URLs" is off.
    return { ok: false };
  }
}

const store = {
  get: async (key) => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

async function deps() {
  const { os } = await chrome.runtime.getPlatformInfo();
  return { readUrl, store, os };
}

function hasFileAccess() {
  return chrome.extension.isAllowedFileSchemeAccess();
}

/** What a page is told: that the extension is here, and whether it may read files. */
async function status() {
  const [fileAccess, platform] = await Promise.all([hasFileAccess(), chrome.runtime.getPlatformInfo()]);
  return { ok: true, protocol: PROTOCOL, version: manifest.version, fileAccess, os: platform.os };
}

/** What the popup shows on top of that: the last sync, and the folder it read. */
async function popupStatus() {
  const [base, lastSync] = await Promise.all([status(), store.get(STORE_LAST_SYNC)]);
  return { ...base, lastSync: lastSync && typeof lastSync === "object" ? lastSync : null };
}

/** Opens this extension's own page in the browser's extension settings, where the file switch is. */
async function openSettings() {
  const session = await chrome.storage.session.get(SESSION_SETTINGS_OPENED);
  if (Date.now() - (session[SESSION_SETTINGS_OPENED] || 0) < SETTINGS_REOPEN_MS) return { ok: true };
  await chrome.storage.session.set({ [SESSION_SETTINGS_OPENED]: Date.now() });
  await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  return { ok: true };
}

async function appTabs() {
  try { return await chrome.tabs.query({ url: APP_PATTERNS }); }
  catch { return []; }
}

/** Brings the player's SpireVault tab to the front. Returns false when none is open. */
async function focusAppTab() {
  const tabs = await appTabs();
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab || tab.id == null) return false;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  return true;
}

async function openApp() {
  if (!(await focusAppTab())) await chrome.tabs.create({ url: APP_HOME });
  return { ok: true };
}

async function handlePageRequest(request) {
  if (request.type === "status") return status();
  if (request.type === "open-settings") return openSettings();
  if (!(await hasFileAccess())) return { ok: false, reason: "no-file-access" };
  if (request.type === "set-folder") {
    const result = await setPastedFolder(await deps(), request.path);
    return result.ok ? { ok: true } : result;
  }
  if (request.type === "forget-folder") return forgetFolders(await deps());
  return inLine(async () => {
    const result = await syncOnce(await deps(), request);
    if (!result.ok) return result;
    // The folder's path (it holds the computer's user name) stays in the extension, for the popup.
    const { folder, ...forPage } = result;
    await store.set(STORE_LAST_SYNC, { at: Date.now(), runFiles: result.runFiles, folder });
    return forPage;
  });
}

let syncLine = Promise.resolve();
let waitingSyncs = 0;

/** Runs sync jobs one after another, so a burst of requests cannot read the folder many times at once. */
function inLine(job) {
  if (waitingSyncs >= MAX_WAITING_SYNCS) return Promise.resolve({ ok: false, reason: "busy" });
  waitingSyncs += 1;
  const result = syncLine.then(job).finally(() => { waitingSyncs -= 1; });
  syncLine = result.catch(() => {});
  return result;
}

/** Who sent this: a SpireVault tab's top frame, this extension's own popup, or nobody we answer. */
function senderKind(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return "";
  // The extension's own pages: the toolbar popup (also when someone opens it in a tab).
  if (typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""))) return "popup";
  if (!sender.tab || sender.frameId !== 0) return "";
  const origin = sender.origin || (() => { try { return new URL(sender.url || "").origin; } catch { return ""; } })();
  return isAllowedOrigin(origin, APP_PATTERNS) ? "page" : "";
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const kind = senderKind(sender);
  if (!kind) return false;
  let work;
  if (kind === "popup") {
    const type = message && typeof message === "object" ? message.type : "";
    if (!POPUP_TYPES.includes(type)) return false;
    work = type === "status" ? popupStatus() : type === "open-app" ? openApp() : openSettings();
  } else {
    const request = parsePageRequest(message);
    work = request ? handlePageRequest(request) : Promise.resolve({ ok: false, reason: "bad-request" });
  }
  work.then(sendResponse, () => sendResponse({ ok: false, reason: "failed" }));
  return true;
});

// ── Keeping open tabs connected ───────────────────────────────────────────
//
// A tab that was open before the extension was added (or before it was
// restarted by the file switch) has no bridge in it, and Chrome does not add
// one by itself. Put it there once per start, so setup never needs a reload.

async function injectIntoOpenTabs() {
  for (const tab of await appTabs()) {
    if (tab.id == null) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch {
      // A tab that is still loading or was just closed: its own load adds the bridge.
    }
  }
}

async function onWorkerStart() {
  const session = await chrome.storage.session.get(SESSION_INJECTED);
  if (session[SESSION_INJECTED]) return;
  await chrome.storage.session.set({ [SESSION_INJECTED]: true });
  await injectIntoOpenTabs();
  // Turning on "Allow access to file URLs" restarts the extension. When that
  // is what just happened, take the player back to SpireVault: setup is done.
  const fileAccess = await hasFileAccess();
  const before = await store.get(STORE_FILE_ACCESS);
  await store.set(STORE_FILE_ACCESS, fileAccess);
  if (fileAccess && before === false) await focusAppTab();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  await store.set(STORE_FILE_ACCESS, await hasFileAccess());
  // Fresh from the store: go back to the SpireVault tab that sent the player
  // here, or open one. A folder loaded by hand for development opens nothing.
  const self = await chrome.management.getSelf();
  if (self.installType === "development") return;
  await openApp();
});

onWorkerStart().catch(() => { /* a failed start-up pass is retried on the next start */ });
