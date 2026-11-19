// SpireVault Sync: the bridge inside a SpireVault tab.
//
// Passes messages between the page and the extension's service worker, and
// nothing else. It reads no page content, keeps nothing, and only relays
// window messages that the SpireVault page itself posted to itself (same
// window, same origin, the page's own tag). The service worker checks every
// request again and is the one place that decides what may be read.
(() => {
  "use strict";

  const FROM_PAGE = "spirevault-page";
  const FROM_EXTENSION = "spirevault-sync";
  const PROTOCOL = 1;
  const TYPES = ["status", "sync", "open-settings", "set-folder", "forget-folder"];
  /** These open a tab or change which folder is read: only right after the player clicked or typed. */
  const NEEDS_GESTURE = ["open-settings", "set-folder", "forget-folder"];
  const MAX_ID = 64;
  const FLAG = "__spireVaultSyncBridge";

  if (window.top !== window) return;
  // The service worker adds this script to tabs that were already open. If a
  // live copy is here (the page loaded after the extension did), keep it.
  const existing = globalThis[FLAG];
  if (existing && typeof existing.isAlive === "function" && existing.isAlive()) return;

  const origin = window.location.origin;
  /** Tells this copy apart from one left behind by an earlier start of the extension. */
  const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let isRetired = false;

  /** False once the extension was restarted, updated or removed under this script. */
  function isAlive() {
    try { return !isRetired && Boolean(chrome.runtime && chrome.runtime.id); }
    catch { return false; }
  }

  function post(message) {
    window.postMessage({ ...message, source: FROM_EXTENSION, v: PROTOCOL }, origin);
  }

  function stopListening() {
    isRetired = true;
    window.removeEventListener("message", onMessage);
  }

  /** The extension went away under this copy: stop, and tell the page so it does not wait for answers. */
  function retire() {
    if (isRetired) return;
    stopListening();
    post({ type: "gone" });
  }

  async function ask(request) {
    if (!isAlive()) { retire(); return null; }
    try {
      return await chrome.runtime.sendMessage(request);
    } catch {
      if (!isAlive()) retire();
      return null;
    }
  }

  async function onMessage(event) {
    if (event.source !== window || event.origin !== origin) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    // A newer copy of this script has taken over (the extension restarted): step aside quietly.
    if (data.source === FROM_EXTENSION && data.type === "takeover" && data.instance !== instance) {
      stopListening();
      return;
    }
    if (data.source !== FROM_PAGE) return;
    if (typeof data.id !== "string" || data.id.length === 0 || data.id.length > MAX_ID) return;
    if (typeof data.type !== "string" || !TYPES.includes(data.type)) return;
    if (NEEDS_GESTURE.includes(data.type) && !(navigator.userActivation && navigator.userActivation.isActive)) {
      post({ type: "reply", id: data.id, reply: { ok: false, reason: "needs-click" } });
      return;
    }
    // Only the fields the service worker reads are passed on.
    const request = { type: data.type };
    if (data.type === "sync") {
      request.steamId = data.steamId;
      request.known = data.known;
    } else if (data.type === "set-folder") {
      request.path = data.path;
    }
    const reply = await ask(request);
    // Retired while asking: "gone" has told the page, and a newer copy may be answering.
    if (isRetired) return;
    post({ type: "reply", id: data.id, reply: reply || { ok: false, reason: "no-answer" } });
  }

  globalThis[FLAG] = { isAlive };
  window.addEventListener("message", onMessage);
  post({ type: "takeover", instance });

  // Say hello, so a page that is already open learns the extension arrived
  // (just added, or back after the file switch) without having to ask.
  ask({ type: "status" }).then((reply) => {
    if (reply && !isRetired) post({ type: "hello", reply });
  });
})();
