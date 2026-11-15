// Co-op Play — the Co-op tab. One button: tap Play, get matched with whoever
// else tapped it, add each other on Steam, play STS2 together.
//
// This module owns the state machine (idle → searching → matched → in game),
// polling, and the click handlers. Markup lives in coop-play-view.js, push /
// sound alerts in coop-play-alerts.js, matching rules on the server in
// Backend/src/coop-play-core.ts. The server is the source of truth: every
// action returns the full view, and the card is re-rendered from it.

import * as View from "/lib/coop-play-view.js?v=1";
import * as Alerts from "/lib/coop-play-alerts.js?v=1";

const PREFS_KEY = "vault.coop.play.v1";
const POLL_MS = Object.freeze({
  idle: 20_000,
  searching: 5_000,
  searchingHidden: 20_000,
  matched: 5_000,
  matchedHidden: 20_000,
  in_game: 60_000,
});
const STEAM_ID = /^\d{17}$/;

/**
 * @typedef {Object} CoopPlayDeps
 * @property {string} api                 API base ("/api")
 * @property {{ sessionToken?: string, steamID?: string, personaName?: string, avatarURL?: string } | null} session
 * @property {(msg: string) => void} toast
 * @property {(name: string, params?: object) => void} [track]
 * @property {() => void} [gotoCoop]      switch the app to the Co-op tab
 * @property {(view: object | null) => void} [onChange]
 * @property {() => void} [onAuthFailure]
 * @property {string | null} [partyId]    from a /party/<id> deep link
 */

/** @type {{ root: HTMLElement, float: HTMLElement, deps: CoopPlayDeps } | null} */
let ctx = null;
let view = null;
let loadError = "";
let busy = false;
let tabVisible = false;
let endedParty = false;
let pollTimer = 0;
let clockTimer = 0;
let lastHtml = "";
let lastFloatHtml = "";
/** @type {{ supported: boolean, on: boolean, reason?: string }} */
let push = { supported: false, on: false };

// MARK: - Prefs

function readPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    const branch = raw.branch === "beta" ? "beta" : "stable";
    const valid = View.CLIMBERS.some((c) => c.id === raw.character && (!c.beta || branch === "beta"));
    return { character: valid ? raw.character : undefined, branch };
  } catch {
    return { character: undefined, branch: "stable" };
  }
}

function writePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: the choice lasts for this page only */
  }
}

let prefs = readPrefs();

// MARK: - Networking

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any }>}
 */
async function api(path, opts = {}) {
  if (!ctx) return { ok: false, status: 0, data: null };
  const token = ctx.deps.session?.sessionToken;
  const init = {
    method: opts.method || (opts.body === undefined ? "GET" : "POST"),
    cache: "no-store",
    credentials: "include",
    headers: {
      authorization: token ? `Bearer ${token}` : "Bearer __cookie__",
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };
  try {
    const resp = await fetch(`${ctx.deps.api}${path}`, init);
    const data = await resp.json().catch(() => null);
    return { ok: resp.ok && data?.ok !== false, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: "network", message: String(err?.message || err) } };
  }
}

function track(name, params) {
  try {
    ctx?.deps.track?.(name, params);
  } catch {
    /* analytics never breaks the page */
  }
}

/** Adopt a server answer, fire "you've been matched" alerts on the edge. */
function adopt(resp) {
  if (resp.status === 401) {
    loadError = "Your Steam sign-in expired. Sign in again to play co-op.";
    view = null;
    ctx?.deps.onAuthFailure?.();
    return;
  }
  if (resp.status === 429) {
    ctx?.deps.toast("Easy there. Give it a few seconds and try again.");
    return;
  }
  if (!resp.ok || !resp.data) {
    if (!view) loadError = "We couldn't reach the co-op server. Check your connection and try again.";
    return;
  }
  const before = view?.state;
  const { ok: _ok, pushOn, ...next } = resp.data;
  if (typeof pushOn === "boolean") push = { ...push, on: pushOn };
  view = next;
  loadError = "";
  if (ctx?.deps.partyId && !endedParty) {
    endedParty = view.match?.matchId !== ctx.deps.partyId;
    ctx.deps.partyId = null;
  }
  if (before === "searching" && view.state === "matched") onMatched();
  if (view.state !== "idle") endedParty = false;
  ctx?.deps.onChange?.(view);
}

function onMatched() {
  const others = (view.match?.members || []).filter((m) => !m.isYou).map((m) => m.name);
  const text = others.length ? `${others.join(", ")} ${others.length === 1 ? "is" : "are"} ready to climb.` : "Your party is ready.";
  Alerts.chime();
  Alerts.notifyMatched(text);
  if (document.visibilityState !== "visible") Alerts.flashTitle("Party found!");
  if (!tabVisible) ctx?.deps.toast(`Party found: ${text}`);
  track("coop_matched", { party_size: view.match?.members?.length ?? 0 });
}

async function refresh() {
  if (!ctx?.deps.session) return;
  adopt(await api("/coop/play"));
  render();
  schedule();
}

function schedule() {
  window.clearTimeout(pollTimer);
  pollTimer = 0;
  if (!ctx?.deps.session) return;
  const hidden = document.visibilityState !== "visible";
  const state = view?.state ?? "idle";
  let delay = 0;
  if (state === "searching") delay = hidden ? POLL_MS.searchingHidden : POLL_MS.searching;
  else if (state === "matched") delay = hidden ? POLL_MS.matchedHidden : POLL_MS.matched;
  else if (state === "in_game") delay = POLL_MS.in_game;
  else if (tabVisible && !hidden) delay = POLL_MS.idle;
  if (delay > 0) pollTimer = window.setTimeout(refresh, delay);
}

// MARK: - Rendering

function cardHtml() {
  if (loadError && !view) return View.errorHtml(loadError);
  if (!view) return View.loadingHtml();
  // Timers are written as 0:00 here and kept current by tickClock(), so the
  // markup only changes when the state does and polls don't redraw the card.
  const s = ctx?.deps.session;
  const me = { sid: s?.steamID, name: s?.personaName || "You", avatar: s?.avatarURL };
  const stable = { view, me, prefs, push, busy, now: view.ticket?.createdAt ?? 0 };
  if (view.state === "searching") return View.searchingHtml(stable);
  if (view.state === "matched") return View.partyHtml(stable);
  if (view.state === "in_game") return View.inGameHtml(stable);
  if (endedParty) return View.endedHtml();
  return View.idleHtml(stable);
}

function render() {
  if (!ctx) return;
  const html = `<section class="cp" data-cp-state="${View.esc(view?.state ?? "loading")}" aria-labelledby="cp-title">${cardHtml()}</section>`;
  if (html !== lastHtml) {
    const focusKey = document.activeElement?.closest?.(".cp")
      ? document.activeElement.getAttribute("data-cp") || document.activeElement.getAttribute("data-cp-pick")
      : null;
    ctx.root.innerHTML = html;
    lastHtml = html;
    if (focusKey !== null) {
      const again = ctx.root.querySelector(`[data-cp="${CSS.escape(focusKey)}"], [data-cp-pick="${CSS.escape(focusKey)}"]`);
      if (again instanceof HTMLElement) again.focus({ preventScroll: true });
    }
  }
  renderFloat();
  tickClock();
}

function renderFloat() {
  if (!ctx) return;
  const show = !tabVisible && (view?.state === "searching" || view?.state === "matched");
  const html = show ? View.floatHtml(view, view.ticket?.createdAt ?? 0) : "";
  if (html !== lastFloatHtml) {
    ctx.float.innerHTML = html;
    ctx.float.hidden = !html;
    lastFloatHtml = html;
    paintTimers();
  }
}

/** Writes the current wait into every visible timer (card and pill). */
function paintTimers() {
  const since = view?.state === "searching" ? view.ticket?.createdAt : 0;
  if (!since) return;
  const text = View.formatWait(Date.now() - since);
  for (const el of document.querySelectorAll("[data-cp-timer]")) el.textContent = text;
}

/** Keeps the timers current once a second while searching. */
function tickClock() {
  window.clearInterval(clockTimer);
  clockTimer = 0;
  if (view?.state !== "searching" || !ctx) return;
  paintTimers();
  clockTimer = window.setInterval(paintTimers, 1000);
}

// MARK: - Actions

async function run(fn) {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } finally {
    busy = false;
    render();
    schedule();
  }
}

function play() {
  Alerts.unlockSound();
  track("coop_play_tap", { branch: prefs.branch, character: prefs.character || "any", push: push.on });
  return run(async () => {
    adopt(await api("/coop/play", { method: "POST", body: { character: prefs.character, branch: prefs.branch, push: push.on } }));
  });
}

function cancel() {
  track("coop_cancel");
  return run(async () => adopt(await api("/coop/play", { method: "DELETE" })));
}

function act(action) {
  return run(async () => adopt(await api("/coop/play/action", { method: "POST", body: { action } })));
}

function addOnSteam(sid) {
  if (STEAM_ID.test(sid)) {
    window.location.href = `steam://friends/add/${sid}`;
  } else {
    ctx?.deps.toast("That's a sandbox player with no real Steam profile.");
  }
  track("coop_steam_add");
  return act("steam_add");
}

async function togglePing(on) {
  if (!ctx) return;
  const result = on ? await Alerts.enablePush(api, prefs.branch) : await Alerts.disablePush(api);
  if (on && !result.ok) {
    ctx.deps.toast(result.message || "Couldn't turn pings on.");
    push = { ...push, on: false };
  } else {
    push = { ...push, on };
    if (on) ctx.deps.toast("Pings are on. We'll tell you when someone's looking or you're matched.");
  }
  track("coop_ping_toggle", { on: push.on });
  lastHtml = "";
  render();
}

function onClick(ev) {
  const el = ev.target instanceof Element ? ev.target.closest("[data-cp], [data-cp-pick], [data-cp-branch]") : null;
  if (!el || !ctx) return;

  if (el.hasAttribute("data-cp-pick")) {
    prefs = { ...prefs, character: el.getAttribute("data-cp-pick") || undefined };
    writePrefs(prefs);
    render();
    return;
  }
  if (el.hasAttribute("data-cp-branch")) {
    const branch = el.getAttribute("data-cp-branch") === "beta" ? "beta" : "stable";
    const keepHero = View.CLIMBERS.some((c) => c.id === prefs.character && (!c.beta || branch === "beta"));
    prefs = { branch, character: keepHero ? prefs.character : undefined };
    writePrefs(prefs);
    render();
    return;
  }

  const action = el.getAttribute("data-cp");
  if (action === "ping") return; // handled on "change"
  if (action === "launch") {
    track("coop_launch");
    return; // the steam:// link opens STS2 itself
  }
  ev.preventDefault();
  switch (action) {
    case "play":
      void play();
      break;
    case "cancel":
      void cancel();
      break;
    case "ping-on":
      void togglePing(true);
      break;
    case "steam-add":
      void addOnSteam(el.getAttribute("data-sid") || "");
      break;
    case "hosting":
      void act("hosting");
      break;
    case "in-game":
      track("coop_in_game");
      void act("in_game");
      break;
    case "leave":
      void act("leave");
      break;
    case "dismiss-ended":
      endedParty = false;
      try {
        if (/^\/party\//.test(location.pathname)) history.replaceState(null, "", "/coop");
      } catch {
        /* cosmetic */
      }
      render();
      break;
    case "retry":
      loadError = "";
      render();
      void refresh();
      break;
    case "goto":
      ctx.deps.gotoCoop?.();
      break;
    default:
      break;
  }
}

function onChange(ev) {
  const el = ev.target;
  if (el instanceof HTMLInputElement && el.getAttribute("data-cp") === "ping") void togglePing(el.checked);
}

function onVisibility() {
  if (document.visibilityState === "visible") {
    Alerts.stopTitleFlash();
    void refresh();
  } else {
    schedule();
  }
}

/** Without pings, leaving the page takes you out of line instead of leaving a ghost. */
function onPageHide() {
  if (view?.state !== "searching" || push.on || !ctx) return;
  try {
    navigator.sendBeacon(`${ctx.deps.api}/coop/play/cancel`);
  } catch {
    /* the server drops silent tickets after 90 s anyway */
  }
}

// MARK: - Public API

/**
 * Mount into the Co-op tab. Safe to call more than once.
 * @param {HTMLElement} root
 * @param {CoopPlayDeps} deps
 */
export function mountCoopPlay(root, deps) {
  if (ctx) {
    ctx.deps = { ...ctx.deps, ...deps };
    void refresh();
    return;
  }
  const float = document.createElement("div");
  float.className = "cp-float-wrap";
  float.hidden = true;
  float.setAttribute("role", "status");
  document.body.appendChild(float);
  ctx = { root, float, deps: { ...deps } };
  const support = Alerts.pushSupport();
  push = { supported: support.supported, on: false, reason: support.reason };
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  float.addEventListener("click", onClick);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  render();
  void refresh();
}

/** Tell the module whether the Co-op tab is on screen (drives idle polling and the pill). */
export function setCoopTabVisible(on) {
  const was = tabVisible;
  tabVisible = Boolean(on);
  if (!ctx) return;
  if (tabVisible && !was) void refresh();
  else {
    renderFloat();
    schedule();
  }
}

/** The current server view (or null before the first answer). */
export function getView() {
  return view;
}

/** Players waiting on your branch, for the Co-op nav badge (0 while you're busy). */
export function badgeCount() {
  if (!view || view.state !== "idle") return 0;
  return view.lookingByBranch?.[prefs.branch] ?? 0;
}
