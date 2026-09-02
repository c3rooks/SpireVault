// party-finder.js — Co-op Lobby Beta · party-finder UX reset
// =========================================================================
// Owns the Co-op Lobby Beta surface as four zones:
//   1. Header (badges injected into the panel-head title)
//   2. Run Preferences / Find Me a Group panel
//   3. Best Party for You decision card
//   4. Live Parties list
//
// Plus the Host a Room 3-step modal, the Details modal, the Run
// Preferences modal, and inline no-match handling. Talks to the
// existing /coop/* endpoints only — no new wire shapes.
//
// Domain lock: Ironclad / Silent / Defect / Necrobinder / Regent / Any.
// Ascension is capped at 10 (Slay the Spire 2 max).
// =========================================================================

import { isSandboxSteamId, isCoopSandboxEnabled } from "./coop-sandbox.js?v=13";
import { encodeStart, presetToPlanned, decodeStart, formatCountdown, startSortKey } from "./party-finder-startsoon.js?v=1";
var PFH = window.PFH;

// ── Domain constants ─────────────────────────────────────────────────
const PF_CHARACTERS = Object.freeze([
  { id: "ironclad", label: "Ironclad" },
  { id: "silent", label: "Silent" },
  { id: "defect", label: "Defect" },
  { id: "necrobinder", label: "Necrobinder" },
  { id: "regent", label: "Regent" },
]);
const PF_CHAR_IDS = new Set(PF_CHARACTERS.map((c) => c.id));

const ASC_BUCKETS = Object.freeze([
  { id: "any", label: "Any level", min: 0, max: 10 },
  { id: "a0-3", label: "A0-A3", min: 0, max: 3 },
  { id: "a4-7", label: "A4-A7", min: 4, max: 7 },
  { id: "a8-10", label: "A8-A10", min: 8, max: 10 },
  { id: "a10", label: "A10", min: 10, max: 10 },
]);

const BRANCHES = Object.freeze([
  { id: "beta", label: "Beta branch" },
  { id: "main", label: "Main branch" },
  { id: "both", label: "Main or Beta OK" },
]);

const VOICE_PRESETS_UI = Object.freeze([
  { id: "none", label: "No voice needed" },
  { id: "any", label: "Voice flexible" },
  { id: "lfg1", label: "LFG 1" },
  { id: "lfg2", label: "LFG 2" },
  { id: "lfg3", label: "LFG 3" },
  { id: "lfg4", label: "LFG 4" },
  { id: "lfg5", label: "LFG 5" },
  { id: "lfg6", label: "LFG 6" },
  { id: "custom", label: "Custom" },
]);

// Mic tiers. Three distinct stances:
//   yes      → host wants voice on (chatty / strategy talk)
//   optional → host doesn't care; bring it or not
//   no       → host wants a quiet run (no mic, deliberate silence)
// The original copy collapsed the bottom two into near-synonyms
// ("No mic okay" vs "No mic needed"), which read identical to most
// players. Each label now starts with a different word and conveys a
// different posture.
const MIC_OPTIONS = Object.freeze([
  { id: "yes", label: "Mic preferred" },
  { id: "optional", label: "Mic optional" },
  { id: "no", label: "Quiet — no mic" },
]);

const MODES = Object.freeze([
  { id: "standard", label: "Standard" },
  { id: "daily", label: "Daily" },
  { id: "custom", label: "Custom" },
]);

const GOALS = Object.freeze([
  { id: "any", label: "Any" },
  { id: "heart", label: "Heart" },
  { id: "daily", label: "Daily" },
  { id: "learning", label: "Learning" },
  { id: "casual", label: "Chill climb" },
]);

const LOBBY_SIZES = [2, 3, 4];

const LS_BRANCH_BY_LOBBY = "pf.branchByLobby";
const LS_VOICE_BY_LOBBY = "pf.voiceByLobby";
const LS_MY_PREFS = "pf.myPrefs";
const LS_SCENARIO = "pf.devScenarioOverride";

// ── Module state ─────────────────────────────────────────────────────
let bootCtx = null;
let lastState = null;
let pollTimer = null;
let isMounted = false;
let hostModalStep = 1;
let pendingFindMeFocus = false;
let detailsLobbyId = null;
// Planned-start presets. "" means "no time set" (the room sits open as
// long as it needs to). "full" means "starts the moment we fill". The
// concrete-duration presets resolve to an ISO timestamp at submit time.
const START_PRESETS = Object.freeze([
  { id: "",     label: "No rush" },
  { id: "now",  label: "Right now" },
  { id: "15m",  label: "In 15 min" },
  { id: "30m",  label: "In 30 min" },
  { id: "1h",   label: "In 1 hour" },
  { id: "full", label: "When full" },
]);

const hostForm = {
  title: "",
  mode: "standard",
  goal: "heart",
  ascensionBucket: "a8-10",
  branch: "beta",
  // Default "Open to any" so the host doesn't accidentally lock out
  // joiners who'd be a perfect fit on a different class. The previous
  // "ironclad" default was the largest single source of "no one is
  // joining my room" reports — every Beta host who skipped the chip
  // step was inadvertently telling the matcher "Ironclad only". Match
  // coop-lobbies.js's "" default so the two surfaces behave the same.
  hostCharacter: "",
  openCharacterPreference: "",
  lobbySize: 4,
  voice: "lfg1",
  voiceCustom: "",
  mic: "yes",
  note: "",
  plannedStart: "",
};

// ── Public API (called from coop-lobbies shim) ───────────────────────
export function mountPartyFinder(ctx) {
  bootCtx = ctx;
  if (isMounted) { void refreshState({ force: true }); return; }
  isMounted = true;
  ensureCssLoaded();
  ensureBetaRoot();
  ensureModalsMounted();
  wireDelegatedClicks();
  injectHeaderBadges();
  applyHelperLineVisibility();
  void refreshState({ force: true });
  schedulePoll();
  document.addEventListener("visibilitychange", onVisibilityChange);
  augmentSandboxScenariosWhenReady();
}

export function setActiveTab() {
  ensureBetaRoot();
  ensureModalsMounted();
  injectHeaderBadges();
  applyHelperLineVisibility();
  void refreshState({ force: true });
}

export function getLastState() { return lastState; }

// ── CSS injection ────────────────────────────────────────────────────
function ensureCssLoaded() {
  if (!document.getElementById("pf-stylesheet")) {
    const link = document.createElement("link");
    link.id = "pf-stylesheet";
    link.rel = "stylesheet";
    link.href = "/lib/party-finder.css?v=5";
    document.head.appendChild(link);
  }
  // House lobby identity (VAULT TEAM pill, themed art tiles, A0/A10
  // palette split, "OPEN" pill, disclosure copy). Lives in a separate
  // file so the v198 surface keeps an unchanged primary stylesheet
  // and the House-only rules can be revved independently if we need
  // a quick visual rollback.
  if (!document.getElementById("pf-house-stylesheet")) {
    const houseLink = document.createElement("link");
    houseLink.id = "pf-house-stylesheet";
    houseLink.rel = "stylesheet";
    houseLink.href = "/lib/party-finder-house.css?v=1";
    document.head.appendChild(houseLink);
  }
}

// ── Scaffolding ──────────────────────────────────────────────────────
function ensureBetaRoot() {
  if (document.getElementById("pf-root")) return;
  const $page = document.getElementById("coop-page-root");
  if (!$page) return;
  const wrap = document.createElement("section");
  wrap.id = "pf-root";
  wrap.setAttribute("data-coop-mode", "beta");
  wrap.innerHTML = `
    <section class="pf-prefs" id="pf-prefs" aria-labelledby="pf-prefs-title">
      <header class="pf-prefs-head">
        <h3 id="pf-prefs-title">What do you want to play?</h3>
        <p class="pf-prefs-sub">We&rsquo;ll highlight rooms that match this.</p>
      </header>
      <ul class="pf-prefs-chips" id="pf-prefs-chips" aria-label="Your run preferences"></ul>
      <div class="pf-prefs-actions">
        <button type="button" class="pf-btn pf-btn--primary" data-pf-action="find-me">Find Me a Group</button>
        <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="open-prefs">Change Preferences</button>
      </div>
      <div class="pf-prefs-nomatch" id="pf-prefs-nomatch" hidden></div>
    </section>
    <section class="pf-best" id="pf-best" aria-labelledby="pf-best-title">
      <div class="pf-section-head"><h3 id="pf-best-title">Best party for you</h3></div>
      <div id="pf-best-card"></div>
    </section>
    <section class="pf-live" id="pf-live" aria-labelledby="pf-live-title">
      <div class="pf-section-head">
        <div>
          <h3 id="pf-live-title">Open rooms <span class="pf-count" id="pf-live-count">0</span></h3>
          <p class="pf-section-sub">Open STS2 co-op rooms hosted by the community.</p>
        </div>
        <div class="pf-section-actions">
          <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="toggle-room-alert" id="pf-room-alert-btn" title="Get a notification the moment someone opens a room">🔔 Alert me</button>
          <button type="button" class="pf-btn pf-btn--primary" data-pf-action="open-host">+ Host a Room</button>
        </div>
      </div>
      <div class="pf-live-list" id="pf-live-list"></div>
    </section>`;
  const $classic = document.getElementById("classic-coop-surface");
  if ($classic && $classic.parentElement === $page) {
    $page.insertBefore(wrap, $classic.nextSibling);
  } else {
    $page.appendChild(wrap);
  }
}

function ensureModalsMounted() {
  if (document.getElementById("pf-modal-host")) return;
  const host = document.createElement("div");
  host.innerHTML = `
    <div class="pf-modal-backdrop" id="pf-modal-host" hidden role="dialog" aria-modal="true" aria-labelledby="pf-modal-host-title">
      <div class="pf-modal pf-modal--wide">
        <header class="pf-modal-head">
          <div>
            <h3 id="pf-modal-host-title">Host a Room</h3>
            <p>Tell players what you&rsquo;re running so the right people can join.</p>
          </div>
          <button type="button" class="pf-modal-close" data-pf-modal-close aria-label="Close">×</button>
        </header>
        <div class="pf-stepper" id="pf-host-stepper"></div>
        <div class="pf-modal-body" id="pf-host-body"></div>
        <div class="pf-form-error" id="pf-host-error" role="alert" hidden></div>
        <div class="pf-modal-actions" id="pf-host-actions"></div>
      </div>
    </div>
    <div class="pf-modal-backdrop" id="pf-modal-details" hidden role="dialog" aria-modal="true" aria-labelledby="pf-modal-details-title">
      <div class="pf-modal pf-modal--wide">
        <header class="pf-modal-head">
          <div>
            <span class="pf-eyebrow">Room details</span>
            <h3 id="pf-modal-details-title">Room</h3>
          </div>
          <button type="button" class="pf-modal-close" data-pf-modal-close aria-label="Close">×</button>
        </header>
        <div class="pf-modal-body" id="pf-details-body"></div>
        <div class="pf-modal-actions" id="pf-details-actions"></div>
      </div>
    </div>
    <div class="pf-modal-backdrop" id="pf-modal-prefs" hidden role="dialog" aria-modal="true" aria-labelledby="pf-modal-prefs-title">
      <div class="pf-modal">
        <header class="pf-modal-head">
          <div>
            <h3 id="pf-modal-prefs-title">Run Preferences</h3>
            <p>What kind of run are you looking to play?</p>
          </div>
          <button type="button" class="pf-modal-close" data-pf-modal-close aria-label="Close">×</button>
        </header>
        <div class="pf-modal-body" id="pf-prefs-body"></div>
        <div class="pf-form-error" id="pf-prefs-error" role="alert" hidden></div>
        <div class="pf-modal-actions">
          <button type="button" class="pf-btn pf-btn--ghost" data-pf-modal-close>Cancel</button>
          <button type="button" class="pf-btn pf-btn--primary" data-pf-action="save-prefs">Save Preferences</button>
        </div>
      </div>
    </div>`;
  while (host.firstChild) document.body.appendChild(host.firstChild);
}

function injectHeaderBadges() {
  const $h2 = document.getElementById("tab-coop-title");
  if (!$h2 || !document.body.classList.contains("coop-lobby-beta-on")) return;
  // Update the page title + subtitle in place. The legacy "Find a co-op run"
  // / "Post a run, quick match, …" copy lives in index.html — we rewrite the
  // text nodes here so we don't have to ship an index.html change. script.js
  // owns the Beta badge + Dev Sandbox chip + "Switch back to Classic Co-op"
  // link, so we leave those alone and only inject the helper line.
  for (const n of Array.from($h2.childNodes)) {
    if (n.nodeType === 3) { n.textContent = "Find a co-op party"; break; }
  }
  if (![...$h2.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
    $h2.insertBefore(document.createTextNode("Find a co-op party"), $h2.firstChild);
  }
  const $sub = document.querySelector('.panel-sub[data-coop-mode="beta"]');
  if ($sub) $sub.textContent = "Choose what you want to play. SpireVault shows rooms that fit, then walks everyone into STS2.";
  let $help = document.querySelector('.pf-helper-line[data-coop-mode="beta"]');
  if (!$help && $sub?.parentElement) {
    $help = document.createElement("p");
    $help.className = "pf-helper-line";
    $help.setAttribute("data-coop-mode", "beta");
    $help.textContent = "Discord handles voice. Steam handles the invite. SpireVault keeps the party organized.";
    $sub.parentElement.insertBefore($help, $sub.nextSibling);
  }
}

function applyHelperLineVisibility() {
  document.querySelectorAll('.pf-helper-line[data-coop-mode="beta"]').forEach((el) => {
    el.classList.toggle("pf-visible", document.body.classList.contains("coop-lobby-beta-on"));
  });
}

// ── Networking ───────────────────────────────────────────────────────
function authHeaders() {
  const token = bootCtx?.session?.sessionToken;
  return token ? { authorization: `Bearer ${token}` } : { authorization: "Bearer __cookie__" };
}

async function jsonFetch(path, opts = {}) {
  const url = `${bootCtx.api}${path}`;
  const init = {
    cache: "no-store",
    credentials: "include",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(opts.headers || {}),
    },
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  let resp;
  try { resp = await fetch(url, init); }
  catch (err) { return { ok: false, status: 0, message: String(err?.message || err) }; }
  let data; try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    // Prefer the backend's human-written message when present — it is
    // almost always clearer than what we can synthesize from the raw
    // error code. Fall back to humanizeError on the code, then to a
    // generic HTTP fallback. Also surface `code` so callers can react
    // to specific failure modes (e.g. add a Refresh affordance).
    const code = data?.error || `HTTP ${resp.status}`;
    const backendMsg = (data && typeof data.message === "string") ? data.message.trim() : "";
    const message = backendMsg || humanizeError(code);
    return { ok: false, status: resp.status, code, message };
  }
  return { ok: true, status: resp.status, ...data };
}

function humanizeError(code) {
  if (!code) return "Something went wrong.";
  const m = {
    rate_limited: "You're moving too fast. Try again.",
    already_in_lobby: "You already have a room open. Close it first.",
    lobby_full: "That room just filled up.",
    lobby_not_found: "That room is gone.",
    lobby_closed: "That room is closed.",
    lobby_expired: "That room expired.",
    lobby_exists: "You already have an active room. Close it before hosting another.",
    character_claimed: "That character is already claimed.",
    invalid_character: "Pick a valid character.",
    invalid_title: "Add a short title so players know what you're running.",
    invalid_goal: "Pick a valid run goal.",
    invalid_body: "Something didn't look right. Try again.",
    // State-conflict codes from /coop/lobbies and friends. These used
    // to render as the raw words "in party" / "in session" because of
    // the underscore-to-space fallback below — confusing nonsense to
    // a player who thinks they aren't in one.
    in_party: "You're already in a party. Refresh the page or leave your current party, then try again.",
    in_session: "You're already in a co-op session. Finish or leave it, then try again.",
    they_in_party: "That player is already in a party.",
    // Auth / session
    unauthorized: "Sign in to Steam to continue.",
    forbidden: "You don't have permission for that.",
  };
  return m[code] || String(code).replaceAll("_", " ");
}

async function refreshState({ force = false } = {}) {
  if (!bootCtx?.session?.steamID) return;
  const r = await jsonFetch("/coop/state");
  if (!r.ok) { if (r.status === 401) bootCtx.deps?.onAuthFailure?.(); return; }
  lastState = r;
  render(lastState);
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const ms = document.visibilityState === "hidden" ? 60_000 : 15_000;
  pollTimer = setTimeout(async () => { await refreshState(); schedulePoll(); }, ms);
}

function onVisibilityChange() {
  schedulePoll();
  if (document.visibilityState === "visible") void refreshState({ force: true });
}

// ── Helpers ──────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// =========================================================================
// Mutate-in-place reconciliation helpers (v202+ poll-jank fix)
// -------------------------------------------------------------------------
// Mirror of the helper that lives in coop-lobbies.js so this file doesn't
// have to take a new cross-module import (keeps the ?v= cache pin
// independent). When a poll lands with unchanged data the lobby cards
// keep their exact DOM nodes — no reflow, no jump, decorations from
// party-finder-scene.js / -reputation-rt.js / -daily-rt.js stay intact.
// =========================================================================
function pfReconcileChildren($list, blocks) {
  if (!$list) return;
  const prev = new Map();
  for (const child of Array.from($list.children)) {
    if (child.nodeType !== 1) continue;
    const key = child.getAttribute("data-block-key");
    if (key) prev.set(key, child);
  }
  const wantedKeys = new Set(blocks.map((b) => b.key));
  for (const [key, node] of prev) {
    if (!wantedKeys.has(key)) node.remove();
  }
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    let node = prev.get(b.key);
    const fp = b.fp == null ? "" : String(b.fp);
    if (!node) {
      const tmp = document.createElement("div");
      tmp.innerHTML = b.render();
      node = tmp.firstElementChild;
      if (!node) continue;
      node.setAttribute("data-block-key", b.key);
      node.setAttribute("data-block-fp", fp);
    } else if (node.getAttribute("data-block-fp") !== fp) {
      const tmp = document.createElement("div");
      tmp.innerHTML = b.render();
      const fresh = tmp.firstElementChild;
      if (fresh) {
        const keepAttrs = new Set(["data-block-key", "data-block-fp"]);
        for (const a of Array.from(node.attributes)) {
          if (!keepAttrs.has(a.name) && !fresh.hasAttribute(a.name)) {
            node.removeAttribute(a.name);
          }
        }
        for (const a of Array.from(fresh.attributes)) {
          if (keepAttrs.has(a.name)) continue;
          if (node.getAttribute(a.name) !== a.value) node.setAttribute(a.name, a.value);
        }
        node.innerHTML = fresh.innerHTML;
      }
      node.setAttribute("data-block-fp", fp);
    }
    const expected = $list.children[i];
    if (expected !== node) {
      $list.insertBefore(node, expected || null);
    }
  }
}

function pfFpOf(obj) {
  try { return JSON.stringify(obj); } catch { return ""; }
}

/** Project a lobby down to the fields that drive a Live Party row /
 *  Best Party card. Fingerprint everything else as a separate "ctx"
 *  bag (mySid, prefs, isBest). */
function pfLobbyCardFields(l) {
  return {
    id: l.lobbyId,
    t: l.title,
    h: l.hostSteamId,
    hn: l.hostPersonaName,
    ha: l.hostAvatarUrl,
    st: l.status,
    g: l.goal,
    am: l.ascensionMin,
    aM: l.ascensionMax,
    v: l.voicePreference,
    vp: l.voicePreset,
    mo: l.mode,
    sz: l.lobbySize,
    pc: l.preferredCharacters || [],
    me: Array.isArray(l.acceptedMemberSteamIds) ? l.acceptedMemberSteamIds
      : l.hostSteamId ? [l.hostSteamId] : [],
    no: l.note,
    pa: l.partyId,
    br: l.branch || l.branchAccept,
    ua: l.updatedAt,
    // Seat-slot strip repaints when anyone joins/leaves — persona +
    // avatar per member, hydrated server-side onto openLobbies.
    mp: (l.memberProfiles || []).map((m) => `${m.personaName || ""}|${m.avatarUrl || ""}`),
  };
}

function normalizeCharacterId(v) {
  const id = String(v || "").trim().toLowerCase();
  return PF_CHAR_IDS.has(id) ? id : "";
}
function characterLabel(id) { return PF_CHARACTERS.find((c) => c.id === normalizeCharacterId(id))?.label || ""; }
function characterAssetSrc(id) {
  const slug = normalizeCharacterId(id);
  return slug ? `/assets/sts2/characters/${slug}-v2.webp` : "";
}

function lobbyMembers(lobby) {
  if (!lobby) return [];
  const a = lobby.acceptedMemberSteamIds;
  if (Array.isArray(a) && a.length > 0) return a;
  return lobby.hostSteamId ? [lobby.hostSteamId] : [];
}
function lobbySizeOf(l) { const n = l?.lobbySize; return n === 2 || n === 3 || n === 4 ? n : 4; }
function openSeatsOf(l) { return Math.max(0, lobbySizeOf(l) - lobbyMembers(l).length); }

function hostCharacterOf(l) {
  const ids = (l?.preferredCharacters || []).map(normalizeCharacterId).filter(Boolean);
  return ids[0] || "";
}
function myPreferredCharacter(s) {
  const ids = (s?.presence?.preferredCharacters || []).map(normalizeCharacterId).filter(Boolean);
  return ids[0] || "";
}
function ascensionBucketLabel(min, max) {
  if (min == null && max == null) return "Any level";
  const lo = Math.max(0, min ?? 0);
  const hi = Math.min(10, max ?? 10);
  if (lo === 10 && hi === 10) return "A10";
  if (lo === 0 && hi === 10) return "Any level";
  if (lo === 0 && hi === 3) return "A0-A3";
  if (lo === 4 && hi === 7) return "A4-A7";
  if (lo === 8 && hi === 10) return "A8-A10";
  if (lo === hi) return `A${lo}`;
  return `A${lo}-A${hi}`;
}
function ascensionBucketId(min, max) {
  if (min == null && max == null) return "any";
  const lo = Math.max(0, min ?? 0);
  const hi = Math.min(10, max ?? 10);
  if (lo === 10 && hi === 10) return "a10";
  if (lo === 0 && hi === 3) return "a0-3";
  if (lo === 4 && hi === 7) return "a4-7";
  if (lo === 8 && hi === 10) return "a8-10";
  return "any";
}
function ascensionRange(id) {
  const b = ASC_BUCKETS.find((x) => x.id === id);
  return b ? { min: b.min, max: b.max } : { min: 0, max: 10 };
}

function goalLabel(g) {
  const m = { any: "Any run", casual: "Chill climb", climb: "Climb", high: "High Ascension",
    a20: "Heart Attempt", heart: "Heart Attempt", learning: "Learning", daily: "Daily" };
  return m[g] || "Any run";
}
// Whether a room reads as newcomer-friendly. Derived ONLY from honest,
// host-set signals — never fabricated: the host explicitly chose a
// teaching/learning goal, OR the ascension ceiling is A0–A3 (the bands
// new players actually climb). This is the "you won't get judged here"
// signal a nervous first-timer scans for.
function lobbyWelcomesNewcomers(l) {
  if (!l) return false;
  const g = String(l.goal || "").toLowerCase();
  if (g === "learning" || g === "teaching") return true;
  const max = l.ascensionMax;
  if (typeof max === "number" && max >= 0 && max <= 3) return true;
  return false;
}
function newcomerBadgeHtml(l) {
  if (!lobbyWelcomesNewcomers(l)) return "";
  const leaf = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.52-4.48 10-10 10Z"/>'
    + '<path d="M2 21c0-3 1.85-5.36 5.08-6"/></svg>';
  return ' <span class="pf-newcomer-badge" title="New players are welcome in this room">'
    + leaf + '<span>Welcomes newcomers</span></span>';
}
function modeLabel(l) {
  return { standard: "Standard", daily: "Daily", custom: "Custom" }[l?.mode || "standard"] || "Standard";
}
function micLabel(v) {
  if (v === "yes") return "Mic preferred";
  if (v === "no") return "Quiet — no mic";
  if (v === "optional") return "Mic optional";
  return "Mic optional";
}
function voiceLabelOf(l) {
  const local = readVoiceOverride(l?.lobbyId);
  if (local) return local;
  const url = l?.voiceChannelUrl;
  const preset = l?.voicePreset || "any";
  if (preset === "none") return "No voice needed";
  if (preset === "any") return "Voice flexible";
  if (preset === "lfg1") return "LFG 1";
  if (preset === "lfg_duo3") return "LFG 3";
  if (preset === "custom" && url) return url;
  return "Voice flexible";
}
function voiceIsNone(l) { return l?.voicePreset === "none" || /no voice/i.test(voiceLabelOf(l) || ""); }

function readBranchOverride(id) {
  if (!id) return "";
  try {
    const raw = localStorage.getItem(LS_BRANCH_BY_LOBBY);
    const map = raw ? JSON.parse(raw) : {};
    return BRANCHES.find((b) => b.id === map[id])?.label || "";
  } catch { return ""; }
}
function writeBranchOverride(id, branchId) {
  if (!id || !branchId) return;
  try {
    const raw = localStorage.getItem(LS_BRANCH_BY_LOBBY);
    const map = raw ? JSON.parse(raw) : {};
    map[id] = branchId;
    localStorage.setItem(LS_BRANCH_BY_LOBBY, JSON.stringify(map));
  } catch {}
}
function readVoiceOverride(id) {
  if (!id) return "";
  try {
    const raw = localStorage.getItem(LS_VOICE_BY_LOBBY);
    const map = raw ? JSON.parse(raw) : {};
    return map[id] || "";
  } catch { return ""; }
}
function writeVoiceOverride(id, label) {
  if (!id || !label) return;
  try {
    const raw = localStorage.getItem(LS_VOICE_BY_LOBBY);
    const map = raw ? JSON.parse(raw) : {};
    map[id] = label;
    localStorage.setItem(LS_VOICE_BY_LOBBY, JSON.stringify(map));
  } catch {}
}
function branchLabelOf(l) {
  const local = readBranchOverride(l?.lobbyId);
  if (local) return local;
  const hay = `${l?.title || ""} ${l?.note || ""}`.toLowerCase();
  if (/main or beta|beta or main/.test(hay)) return "Main or Beta OK";
  if (/beta branch|on beta\b/.test(hay)) return "Beta branch";
  if (/main branch|on main\b/.test(hay)) return "Main branch";
  if (isSandboxSteamId(l?.hostSteamId)) {
    let h = 0;
    const s = String(l?.lobbyId || "");
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return ["Beta branch", "Main or Beta OK", "Main branch"][Math.abs(h) % 3];
  }
  return "Main or Beta OK";
}
function readMyPrefsExt() {
  try { const r = localStorage.getItem(LS_MY_PREFS); if (r) return JSON.parse(r); } catch {}
  return { branch: "beta" };
}
function writeMyPrefsExt(p) {
  try { localStorage.setItem(LS_MY_PREFS, JSON.stringify(p || {})); } catch {}
}

function hostStatusLabel(s, sid) {
  const row = (s?.activePlayerFeed || []).find((p) => p.steamId === sid);
  if (!row) return "active now";
  if (row.status === "afk") return "idle";
  return "active now";
}

// ── House lobby helpers ────────────────────────────────────────────────
//
// SpireVault House lobbies are operator-seeded ambient rooms (see
// Backend/src/coop-house-lobbies.ts). They use a synthetic Steam ID
// in the reserved range 76561190000000000+ and surface a `isHouseLobby`
// flag on every lobby record. Treat them visually as a separate concept
// from real player-hosted rooms — the disclosure copy "Ambient open
// room — first player to join takes it over" is non-negotiable.
function isHouseLobby(l) {
  return !!(l && l.isHouseLobby === true);
}
function houseSlugOf(l) {
  return (l && typeof l.houseSlug === "string") ? l.houseSlug : "";
}
function houseTheme(l) {
  const slug = houseSlugOf(l);
  if (slug === "house-a10-heart" || /a10/i.test(l?.title || "") || /heart/i.test(l?.title || "")) {
    return {
      key: "a10-heart",
      eyebrow: "High ascension · Heart hunters",
      flavor: "Bring your favorite hero — Heart attempts running.",
      stamp: "Heart Hunters",
      tint: "ember",
    };
  }
  return {
    key: "a0-casual",
    eyebrow: "Casual climb · all welcome",
    flavor: "Drop in for a chill A0 run. New to co-op? Start here.",
    stamp: "Casual Climb",
    tint: "azure",
  };
}
// "VAULT TEAM" pill markup — replaces the LevelBadge rep slot on House
// lobby cards. Synthetic Steam IDs would otherwise render as "Lv 1
// Initiate," which is dishonest about who's behind the room.
function houseVaultTeamPillHtml() {
  return `<span class="pf-house-pill" data-pf-house-pill="vault-team" title="Operator-seeded room (SpireVault Team)"><span class="pf-house-pill-shield" aria-hidden="true">✦</span><span class="pf-house-pill-label">VAULT TEAM</span></span>`;
}
// Disclosure subtitle. Shown once per House row directly under the
// host strip so visitors understand the room is ambient and joining
// it makes them the host.
const HOUSE_DISCLOSURE_TEXT = "Ambient open room — first player to join takes it over.";

function characterFit(l, s) {
  const my = myPreferredCharacter(s);
  const h = hostCharacterOf(l);
  if (!my) return { tone: "neutral", label: "Flexible characters" };
  if (h && h === my) return { tone: "bad", label: `${characterLabel(my)} taken` };
  return { tone: "good", label: `${characterLabel(my)} available` };
}
function ascensionFit(l, s) {
  const myLo = s?.presence?.ascensionMin ?? 0;
  const myHi = s?.presence?.ascensionMax ?? 10;
  const lo = l?.ascensionMin ?? 0; const hi = l?.ascensionMax ?? 10;
  return myLo <= hi && lo <= myHi;
}
function branchFit(l, s) {
  const myBranch = (s?.__pfPrefs)?.branch || "beta";
  const room = branchLabelOf(l);
  if (room === "Main or Beta OK") return true;
  if (myBranch === "beta" && /beta/i.test(room)) return true;
  if (myBranch === "main" && /main\b/i.test(room) && !/beta/i.test(room)) return true;
  if (myBranch === "both") return true;
  return false;
}
function voiceFit(l, s) {
  const v = s?.presence?.voicePreference;
  if (!v) return true;
  if (v === "no") return voiceIsNone(l);
  return !voiceIsNone(l);
}
function goalFit(l, s) {
  const my = s?.presence?.goal; const room = l?.goal || "any";
  if (!my || my === "any" || room === "any") return true;
  return my === room || (my === "heart" && room === "a20") || (my === "a20" && room === "heart");
}
function fitScore(l, s) {
  let n = 0;
  const cf = characterFit(l, s);
  if (cf.tone === "good") n += 3;
  if (cf.tone === "neutral") n += 1;
  if (ascensionFit(l, s)) n += 3;
  if (branchFit(l, s)) n += 2;
  if (voiceFit(l, s)) n += 1;
  if (goalFit(l, s)) n += 1;
  if (openSeatsOf(l) <= 0) n -= 2;
  if (cf.tone === "bad") n -= 3;
  return n;
}

function visibleOpenLobbies(state) {
  const list = (state.openLobbies || []).filter((l) => l.status === "open" || l.status === "full");
  const mySid = state.presence?.steamId;
  const my = state.lobby;
  if (my && my.hostSteamId === mySid && my.status !== "closed" && my.status !== "expired"
      && !list.some((l) => l.lobbyId === my.lobbyId)) {
    return [my, ...list];
  }
  return list;
}

function pickBestLobby(state, visible) {
  if (!visible || visible.length === 0) return null;
  const me = state.presence;
  const ranked = visible
    .filter((l) => l.hostSteamId !== me?.steamId)
    .filter((l) => openSeatsOf(l) > 0)
    .filter((l) => characterFit(l, state).tone !== "bad")
    .sort((a, b) => fitScore(b, state) - fitScore(a, state));
  return ranked[0] || null;
}

function findLobby(id) {
  if (!lastState) return null;
  if (lastState.lobby?.lobbyId === id) return lastState.lobby;
  return (lastState.openLobbies || []).find((l) => l.lobbyId === id) || null;
}

// ── Sandbox scenario override applied at render-time ─────────────────
function readScenarioOverride() { try { return localStorage.getItem(LS_SCENARIO) || ""; } catch { return ""; } }
function applyScenarioOverride(state) {
  const o = readScenarioOverride();
  if (!o || !state) return state;
  const next = { ...state, openLobbies: (state.openLobbies || []).map((l) => ({ ...l })) };
  if (o === "no-voice") next.openLobbies.forEach((l) => { l.voicePreset = "none"; l.voicePreference = "no"; });
  else if (o === "mismatch") {
    const my = myPreferredCharacter(state) || "ironclad";
    if (next.openLobbies[0]) next.openLobbies[0].preferredCharacters = [my];
  } else if (o === "expired") next.openLobbies = [];
  else if (o === "host-closed") next.lobby = null;
  return next;
}

// ── Render ───────────────────────────────────────────────────────────
// v196 — three-stage page gate. Matches the bucket used by
// party-finder-scene.js (stored on document.documentElement) so every
// surface agrees on what the page should show right now.
//
//   a = 0 open lobbies → minimal page. Hero only. Nothing below.
//   b = 1-2            → simple "Open rooms" list. No toolbar, no
//                        "Best party for you" wrapper.
//   c = 3+             → full UI. Best party + filter sheet.
function pfStageBucket(state) {
  // Trust scene.js's resolver when present so the rules stay in
  // lockstep. Falls back to a local count when scene.js boots after
  // party-finder.js (rare but possible cold-paint race).
  try {
    if (typeof window.__pfStageBucket === "function") {
      return window.__pfStageBucket(state || {});
    }
  } catch (_) {}
  const list = (state?.openLobbies || []).filter(
    (l) => l && l.status !== "closed" && l.status !== "expired"
  );
  if (list.length === 0) return "a";
  if (list.length <= 2) return "b";
  return "c";
}

function applyStageRootBucket(bucket) {
  try {
    const $root = document.getElementById("pf-root");
    if ($root && $root.getAttribute("data-pf-stage-bucket") !== bucket) {
      $root.setAttribute("data-pf-stage-bucket", bucket);
    }
    const html = document.documentElement;
    if (html.getAttribute("data-pf-stage-bucket") !== bucket) {
      html.setAttribute("data-pf-stage-bucket", bucket);
    }
  } catch (_) {}
}

function render(rawState) {
  if (!rawState) return;
  const state = applyScenarioOverride(rawState);
  state.__pfPrefs = readMyPrefsExt();

  const $root = document.getElementById("pf-root");
  if (!$root) return;
  injectHeaderBadges();
  applyHelperLineVisibility();

  // Active party → walk into Party Hub. One-shot per partyId so a stray
  // poll doesn't yank a user out of mid-task.
  const party = state.party?.status === "active" ? state.party : null;
  if (party?.partyId && !sessionStorage.getItem(`pf.partyRedirected.${party.partyId}`)) {
    sessionStorage.setItem(`pf.partyRedirected.${party.partyId}`, "1");
    window.location.assign(`/party/${party.partyId}`);
    return;
  }

  const bucket = pfStageBucket(state);
  applyStageRootBucket(bucket);

  // Stages A and B suppress the run-preferences chip strip and the
  // "Best party for you" wrapper. Both are noise when there's nothing
  // (or barely anything) to recommend. Stage C runs the full render.
  if (bucket === "c") {
    renderPrefsPanel(state);
  }
  const visible = visibleOpenLobbies(state);
  const best = pickBestLobby(state, visible);
  if (bucket === "c") {
    renderBestParty(state, best);
  } else {
    // Stage A/B: clear the best card so a stale render from a prior
    // bucket can't ghost into the new layout. We also wipe the
    // mount fingerprint so the next Stage-C render re-writes.
    const $bestCard = document.getElementById("pf-best-card");
    if ($bestCard) {
      const stageEmptyFp = `best-stage-${bucket}-empty`;
      if ($bestCard.getAttribute("data-mount-fp") !== stageEmptyFp) {
        $bestCard.innerHTML = "";
        $bestCard.setAttribute("data-mount-fp", stageEmptyFp);
      }
    }
  }
  // Stage A: don't render the Live Parties list at all. The hero +
  // Showtime strip own the whole page. CSS hides the surrounding
  // section by reading [data-pf-stage-bucket="a"] on #pf-root.
  if (bucket === "a") {
    const $list = document.getElementById("pf-live-list");
    const $count = document.getElementById("pf-live-count");
    if ($list) pfReconcileChildren($list, []);
    if ($count && $count.textContent !== "0") $count.textContent = "0";
  } else {
    renderLiveParties(state, visible, best);
  }
  applyRoomDeepLink();
  consumePendingRoomIntent();
  syncRoomAlertBtn();
  if (pendingFindMeFocus) {
    pendingFindMeFocus = false;
    if (best) focusBestCard(best);
    else showInlineNoMatch();
  }
}

function renderPrefsPanel(state) {
  const $chips = document.getElementById("pf-prefs-chips");
  if (!$chips) return;
  const p = state.presence || {};
  const myChar = myPreferredCharacter(state);
  const myPrefs = state.__pfPrefs || readMyPrefsExt();
  const myBranch = myPrefs.branch || "beta";
  const voiceTxt = p.voicePreference === "yes" ? "Voice preferred"
    : p.voicePreference === "no" ? "No voice"
    : p.voicePreference === "optional" ? "Voice optional" : "Voice flexible";
  // Fingerprint-guard the chip strip — five tiny chips, but innerHTML
  // here used to fire every poll cycle. Now it only writes when one of
  // the user's preference inputs actually changes.
  const chipsFp = pfFpOf({
    c: myChar,
    a: [p.ascensionMin, p.ascensionMax],
    v: voiceTxt,
    b: myBranch,
    g: p.goal || "any",
  });
  if ($chips.getAttribute("data-mount-fp") !== chipsFp) {
    const chips = [
      chipWithCharHtml(myChar),
      chipHtml("Ascension", ascensionBucketLabel(p.ascensionMin, p.ascensionMax)),
      chipHtml("Voice", voiceTxt),
      chipHtml("Branch", BRANCHES.find((b) => b.id === myBranch)?.label || "Main or Beta OK"),
      chipHtml("Goal", goalLabel(p.goal || "any")),
    ];
    $chips.innerHTML = chips.join("");
    $chips.setAttribute("data-mount-fp", chipsFp);
  }
  const $nm = document.getElementById("pf-prefs-nomatch");
  if ($nm) $nm.hidden = true;
}
function chipHtml(k, v) {
  return `<li class="pf-pref-chip"><span class="pf-pref-chip-key">${esc(k)}</span><span>${esc(v)}</span></li>`;
}
function chipWithCharHtml(charId) {
  const slug = normalizeCharacterId(charId);
  const label = slug ? characterLabel(slug) : "Open to any";
  const img = slug ? `<img class="pf-pref-chip-img" src="${esc(characterAssetSrc(slug))}" alt=""/>` : "";
  return `<li class="pf-pref-chip">${img}<span class="pf-pref-chip-key">Character</span><span>${esc(label)}</span></li>`;
}

function renderBestParty(state, best) {
  const $card = document.getElementById("pf-best-card");
  if (!$card) return;
  if (!best) {
    const emptyFp = "best:none";
    if ($card.getAttribute("data-mount-fp") === emptyFp) return;
    $card.setAttribute("data-mount-fp", emptyFp);
    $card.innerHTML = `
      <article class="pf-best-card pf-best-card--empty">
        <div class="pf-best-meta">
          <div class="pf-empty-art" aria-hidden="true">⚔</div>
          <span class="pf-eyebrow">No fit yet</span>
          <h3 class="pf-best-title">No matching party yet</h3>
          <p class="pf-section-sub">Start your own or loosen your preferences.</p>
          <div class="pf-best-actions-empty">
            <button type="button" class="pf-btn pf-btn--primary pf-btn--lg" data-pf-action="open-host">Host a Room</button>
            <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="open-prefs">Change Preferences</button>
            <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="browse-live">Browse all rooms</button>
          </div>
        </div>
      </article>`;
    return;
  }
  // Same-best-lobby-across-polls is the common case once a user has a
  // good match. Fingerprint it and skip the swap when nothing changed.
  // Keeping the same DOM node means the LevelBadge popover trigger,
  // host run strip, and match score ring stay attached — the user
  // never sees the "Best Party for you" card flicker on every poll.
  const myPrefs = state.__pfPrefs || readMyPrefsExt();
  const bestFp = pfFpOf({
    pref: {
      g: state.presence?.goal,
      am: state.presence?.ascensionMin,
      aM: state.presence?.ascensionMax,
      v: state.presence?.voicePreference,
      pc: (state.presence?.preferredCharacters || []),
      br: myPrefs?.branch || "",
    },
    me: state.presence?.steamId || "",
    l: pfLobbyCardFields(best),
    sess: state.session?.status === "active" ? state.session.sessionId : null,
    party: state.party?.partyId ? { id: state.party.partyId, st: state.party.status } : null,
  });
  if ($card.getAttribute("data-mount-fp") === bestFp) return;
  $card.setAttribute("data-mount-fp", bestFp);
  const score = fitScore(best, state);
  const isGreat = score >= 8;
  const isGood = score >= 5;
  const fitClass = isGreat ? "pf-fit-pill--great" : isGood ? "pf-fit-pill--good" : "pf-fit-pill--mismatch";
  const fitLabel = isGreat ? "Great fit" : isGood ? "Good fit" : "Possible fit";
  const reasons = buildWhyV2(best, state);
  const cap = lobbySizeOf(best);
  const filled = lobbyMembers(best).length;
  const open = openSeatsOf(best);
  const hostChar = hostCharacterOf(best);
  const hostArt = hostChar ? characterAssetSrc(hostChar) : "";
  const idle = hostStatusLabel(state, best.hostSteamId) === "idle";
  const slotsHtml = renderSlotStrip(best, state);
  const mySid = state.presence?.steamId;
  const isMine = best.hostSteamId === mySid;
  const charBad = characterFit(best, state).tone === "bad";
  const stampLabel = isGreat ? "Best Fit" : isGood ? "Good Fit" : "Pick";
  const dotBg = idle ? "var(--pf-muted)" : "var(--pf-ok)";
  // House identity treatment for the Best Party card. The hero art
  // becomes the SpireVault crest (no character portrait to fall back
  // on for a synthetic host), the host strip carries the VAULT TEAM
  // pill instead of a fake Lv1 Initiate badge, and the disclosure
  // copy sits directly under the host line so visitors know joining
  // makes them the host.
  const isHouse = isHouseLobby(best);
  const theme = isHouse ? houseTheme(best) : null;
  const repPill = isHouse
    ? houseVaultTeamPillHtml()
    : `<span class="pf-rep-slot pf-rep-slot--inline-coop" data-pf-rep-slot data-host-steam-id="${esc(best.hostSteamId || "")}"></span>`;
  const houseDisclosure = isHouse
    ? `<p class="pf-house-disclosure">${esc(HOUSE_DISCLOSURE_TEXT)}</p>`
    : "";
  const hostStatusText = isHouse ? "always open" : hostStatusLabel(state, best.hostSteamId);
  const hostStrong = isHouse ? "SpireVault House" : (best.hostPersonaName || "Host");
  const hostImg = isHouse ? "/assets/vault-mark.svg" : (best.hostAvatarUrl || "/assets/vault-mark.svg");
  const artInner = isHouse
    ? `<div class="pf-best-art-house" data-pf-house-art="${esc(theme?.key || "")}">
         <img class="pf-best-art-crest" src="/assets/vault-mark.svg" alt="" />
         <span class="pf-best-art-eyebrow">${esc(theme?.eyebrow || "")}</span>
       </div>`
    : `${hostArt ? `<img class="pf-best-art-img" src="${esc(hostArt)}" alt="" />` : ""}
       <div class="pf-best-art-veil"></div>`;
  const artStampLabel = isHouse ? (theme?.stamp || "Vault Team") : stampLabel;
  const artCharName = isHouse
    ? ""
    : (hostChar ? `<span class="pf-best-art-charname">${esc(characterLabel(hostChar))}</span>` : "");
  const cardClass = ["pf-best-card",
    isHouse ? "pf-best-card--house" : "",
    isHouse && theme ? `pf-best-card--house-${theme.key}` : "",
  ].filter(Boolean).join(" ");
  $card.innerHTML = `
    <article class="${cardClass}" data-lobby-id="${esc(best.lobbyId)}"${isHouse ? ` data-pf-house-row="1" data-pf-house-slug="${esc(theme?.key || "")}"` : ""}>
      <div class="pf-best-art">
        ${artInner}
        <span class="pf-best-art-stamp"><span class="pf-dot" style="width:7px;height:7px;border-radius:999px;background:${dotBg};"></span>${esc(artStampLabel)}</span>
        ${artCharName}
      </div>
      <div class="pf-best-meta">
        <div class="pf-best-titlerow">
          <h3 class="pf-best-title">${esc(best.title || "Co-op room")}</h3>
          <span class="pf-fit-pill ${fitClass}">${esc(fitLabel)}</span>
        </div>
        <div class="pf-attrs-row">
          ${branchPillHtml(best)}
          ${modePillHtml(best)}
          ${ascensionPillHtml(best)}
          ${goalPillHtml(best)}
          ${voicePillHtml(best)}
          ${micPillHtml(best.voicePreference)}
        </div>
        <div class="pf-host-line">
          <img src="${esc(hostImg)}" class="${isHouse ? "pf-host-line-img--house" : ""}" alt="" />
          <strong>${esc(hostStrong)}</strong>
          ${repPill}
          <span class="pf-muted">${isHouse ? "" : "is hosting · "}${esc(hostStatusText)}</span>
        </div>
        ${houseDisclosure}
        ${slotsHtml}
        <div class="pf-seats"><strong>${filled} of ${cap} filled</strong> · ${open} open ${open === 1 ? "seat" : "seats"}</div>
        <div class="pf-why">
          <span class="pf-why-title">Why it fits</span>
          <div class="pf-why-grid">${reasons.map(whyItemHtml).join("")}</div>
        </div>
      </div>
      <div class="pf-best-actions">
        ${bestJoinBtnHtml(best, state, { isMine, open, charBad })}
        <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="details" data-lobby-id="${esc(best.lobbyId)}">Details</button>
        <p class="pf-best-footnote">Party Hub opens automatically after you join.</p>
      </div>
    </article>`;
}

function chipFor(fit) {
  return fit.tone === "good"
    ? `<span class="pf-attrs-fit">${esc(fit.label)}</span>`
    : fit.tone === "neutral"
      ? `<span class="pf-attrs-fit pf-attrs-fit--neutral">${esc(fit.label)}</span>`
      : `<span class="pf-attrs-fit pf-attrs-fit--bad">Mismatch: ${esc(fit.label)}</span>`;
}

function buildWhy(l, s) {
  const out = [];
  const cf = characterFit(l, s);
  out.push({ text: cf.label, bad: cf.tone === "bad", warn: cf.tone === "neutral" });
  out.push({ text: branchLabelOf(l), bad: !branchFit(l, s) });
  out.push({ text: ascensionBucketLabel(l.ascensionMin, l.ascensionMax), bad: !ascensionFit(l, s) });
  out.push({ text: voiceLabelOf(l), bad: !voiceFit(l, s) });
  out.push({ text: `${openSeatsOf(l)} open seats`, bad: openSeatsOf(l) === 0 });
  return out;
}
const buildWhyV2 = buildWhy;

function whyItemHtml(r) {
  const cls = r.bad ? "pf-why-item pf-why-item--bad" : r.warn ? "pf-why-item pf-why-item--warn" : "pf-why-item";
  const ico = r.bad ? "\u00d7" : "\u2713";
  return `<div class="${cls}"><span class="pf-why-item-ico">${ico}</span><span>${esc(r.text)}</span></div>`;
}

function bestJoinBtnHtml(best, state, _opts) {
  return joinButtonHtml(best, state, { primary: true, big: true, pulse: true, heroLabel: true });
}

function renderPartyLine(l) {
  const cap = lobbySizeOf(l);
  const members = lobbyMembers(l);
  const hostChar = hostCharacterOf(l);
  const openPref = (l.preferredCharacters || []).slice(1).map(normalizeCharacterId).filter(Boolean);
  const slots = [];
  slots.push(`<li><span class="pf-slot-bullet"></span><strong>${esc(l.hostPersonaName || "Host")}</strong>&nbsp;<small>— ${esc(hostChar ? characterLabel(hostChar) : "Any")} — Host</small></li>`);
  for (let i = 1; i < cap; i++) {
    if (i < members.length) slots.push(`<li><span class="pf-slot-bullet"></span><strong>Joined</strong>&nbsp;<small>— Any</small></li>`);
    else {
      const pref = openPref[i - 1];
      slots.push(`<li class="pf-slot-open"><span class="pf-slot-bullet"></span><strong>Open</strong>&nbsp;<small>— ${esc(pref ? characterLabel(pref) : "Any")}</small></li>`);
    }
  }
  return `<div class="pf-party-line"><span class="pf-party-line-label">Party</span><ul class="pf-party-slots">${slots.join("")}</ul></div>`;
}

function joinButtonHtml(l, state, opts = {}) {
  const mySid = state.presence?.steamId;
  const isMine = l.hostSteamId === mySid;
  const open = openSeatsOf(l);
  const fit = characterFit(l, state);
  const sz = opts.big ? "pf-btn--lg" : "";
  if (isMine) return `<button type="button" class="pf-btn pf-btn--ghost ${sz}" data-pf-action="manage-room" data-lobby-id="${esc(l.lobbyId)}">Manage Your Room</button>`;
  if (open <= 0) return `<button type="button" class="pf-btn pf-btn--ghost ${sz}" disabled>Full</button>`;
  if (fit.tone === "bad") return `<button type="button" class="pf-btn pf-btn--ghost ${sz}" data-pf-action="details" data-lobby-id="${esc(l.lobbyId)}" title="${esc(fit.label)}">Character taken</button>`;
  const cls = opts.primary ? "pf-btn--primary" : "pf-btn--ghost";
  return `<button type="button" class="pf-btn ${cls} ${sz}" data-pf-action="join-room" data-lobby-id="${esc(l.lobbyId)}">Join Room</button>`;
}

function renderLiveParties(state, visible, best) {
  const $list = document.getElementById("pf-live-list");
  const $count = document.getElementById("pf-live-count");
  if (!$list || !$count) return;
  if ($count.textContent !== String(visible.length)) {
    $count.textContent = String(visible.length);
  }
  maybeFireRoomAlert(visible.filter((l) => !isHouseLobby(l)).length);

  if (visible.length === 0) {
    // The "No live parties yet" stub is enhanced into the cold-start
    // pitch by party-finder-empty-rt.js. Reconcile against a single
    // block so we keep the same #pf-live-empty node across polls — the
    // empty-rt MutationObserver then only fires once, not every cycle.
    pfReconcileChildren($list, [{
      key: "live-empty",
      fp: "live-empty",
      render: () => `
        <div class="pf-empty" id="pf-live-empty">
          <h4>No live parties yet</h4>
          <p>Start one or use Discord while you wait.</p>
          <div class="pf-empty-actions">
            <button type="button" class="pf-btn pf-btn--primary" data-pf-action="open-host">Host a Room</button>
            <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="refresh">Refresh</button>
            <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="open-prefs">Change Preferences</button>
          </div>
          <ul class="pf-empty-list"><li>your run goal</li><li>voice room</li><li>character preference</li><li>open seats</li></ul>
        </div>`,
    }]);
    return;
  }

  // Composite sort: start-time bucket → fit score → freshness.
  //
  //   Bucket 0 — starting now (≤15 min from kickoff, or full + when-full)
  //   Bucket 1 — starting in 15–60 min
  //   Bucket 2 — everything else (no time set, hours out, expired)
  //
  // Inside a bucket the existing fit + recency logic still applies, so
  // an imperfect-fit room never leapfrogs a perfect-fit unless its
  // urgency tier is genuinely higher. This is the discoverability win
  // for "starting soon": a player wanting to play *right now* sees the
  // imminent rooms first without us having to add a noisy filter UI.
  const nowMs = Date.now();
  const sorted = [...visible].sort((a, b) => {
    const aBucket = startSoonBucket(a, nowMs);
    const bBucket = startSoonBucket(b, nowMs);
    if (aBucket !== bBucket) return aBucket - bBucket;
    return fitScore(b, state) - fitScore(a, state) ||
      (Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  });
  // Pagination — at 100 / 1000 / 10000 lobbies the list otherwise
  // becomes a wall and the runtime tick has to walk every row every
  // second. Cap visible rows at PAGE_SIZE; expose a "Show more" footer
  // that bumps the page count by one. The first page always includes
  // bucket-0 rooms (starting now) so urgency stays above the fold.
  const PAGE_SIZE = 25;
  const page = Math.max(1, livePartiesPage || 1);
  const cap = PAGE_SIZE * page;
  const shownLobbies = sorted.slice(0, cap);
  const remaining = sorted.length - shownLobbies.length;

  // Reconcile each row by lobbyId. The expensive part — innerHTML on
  // ~25 rows + scene.js's body MutationObserver firing on each row's
  // replacement — only runs for rows whose fingerprint actually moved.
  // In steady state (lobby data identical across polls) this is zero
  // DOM ops.
  const mySid = state.presence?.steamId || "";
  const myPrefs = state.__pfPrefs || readMyPrefsExt();
  const ctx = {
    sid: mySid,
    pref: {
      g: state.presence?.goal,
      am: state.presence?.ascensionMin,
      aM: state.presence?.ascensionMax,
      v: state.presence?.voicePreference,
      pc: (state.presence?.preferredCharacters || []),
      br: myPrefs?.branch || "",
    },
  };
  const blocks = [];
  for (const l of shownLobbies) {
    blocks.push({
      key: `pf-row:${l.lobbyId}`,
      fp: pfFpOf({
        ctx,
        l: pfLobbyCardFields(l),
        isBest: best?.lobbyId === l.lobbyId ? 1 : 0,
      }),
      render: () => renderLiveRow(l, state, best),
    });
  }
  if (remaining > 0) {
    const moreCount = Math.min(PAGE_SIZE, remaining);
    blocks.push({
      key: "pf-live-more",
      fp: `more:${moreCount}:${remaining}`,
      render: () => `
        <div class="pf-live-more">
          <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="live-more">Show ${moreCount} more (${remaining} hidden)</button>
        </div>`,
    });
  }
  pfReconcileChildren($list, blocks);
}

// Pagination cursor for Live Parties. Bumped one page at a time by
// the "live-more" action; reset to 1 on prefs change so a new filter
// never inherits a stale deep-page cursor.
let livePartiesPage = 1;

// ── "Alert me when a room opens" ─────────────────────────────────────
// The dead-lobby loop in miniature: someone opens the tab, sees no
// rooms, closes it, and thirty minutes later somebody ELSE hosts into
// an empty board. This one-shot alert bridges that gap — arm it, walk
// away, and the next REAL room (House rooms don't count; they're
// always there) fires one OS notification + toast, then disarms.
const ROOM_ALERT_KEY = "sv.pf.roomAlert";
let pfPrevRealRoomCount = null;

function roomAlertArmed() {
  try { return localStorage.getItem(ROOM_ALERT_KEY) === "1"; } catch { return false; }
}
function setRoomAlertArmed(on) {
  try {
    if (on) localStorage.setItem(ROOM_ALERT_KEY, "1");
    else localStorage.removeItem(ROOM_ALERT_KEY);
  } catch {}
  syncRoomAlertBtn();
}
function syncRoomAlertBtn() {
  const b = document.getElementById("pf-room-alert-btn");
  if (!b) return;
  const on = roomAlertArmed();
  b.textContent = on ? "🔔 Alert armed" : "🔔 Alert me";
  b.classList.toggle("is-active", on);
  b.title = on
    ? "Armed — you'll get one notification when the next room opens"
    : "Get a notification the moment someone opens a room";
}
function maybeFireRoomAlert(realRoomCount) {
  const prev = pfPrevRealRoomCount;
  pfPrevRealRoomCount = realRoomCount;
  if (prev === null || prev > 0 || realRoomCount <= 0) return;
  if (!roomAlertArmed()) return;
  setRoomAlertArmed(false); // one-shot: fire once, disarm
  const msg = "A co-op room just opened — grab a seat!";
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification("SpireVault", { body: msg, icon: "/assets/vault-mark.svg" });
      n.onclick = () => { try { window.focus(); } catch {} };
    }
  } catch {}
  bootCtx?.deps?.toast?.(msg);
}

// ── Post-sign-in room handoff ────────────────────────────────────────
// A signed-out guest who clicks Join on the public room browser stores
// the room id here before the Steam OpenID round-trip (the redirect
// does not preserve query params). First state paint after sign-in
// scrolls to and highlights that room so the guest lands exactly where
// they were headed — the Roblox promise: browse free, sign in only at
// the moment of play, lose nothing in between.
const PENDING_ROOM_KEY = "sv.coop.pendingRoom";
function consumePendingRoomIntent() {
  let id = null;
  try { id = sessionStorage.getItem(PENDING_ROOM_KEY); } catch {}
  if (!id) return;
  const inState =
    (lastState?.openLobbies || []).some((l) => l.lobbyId === id) ||
    lastState?.lobby?.lobbyId === id;
  if (lastState && !inState) {
    // Room closed/filled while they were signing in — drop the intent
    // so it doesn't ambush them on a later visit.
    try { sessionStorage.removeItem(PENDING_ROOM_KEY); } catch {}
    bootCtx?.deps?.toast?.("That room just closed — here are the live ones.");
    return;
  }
  const c = document.querySelector(`#pf-live-list [data-lobby-id="${id}"], #pf-best-card [data-lobby-id="${id}"]`);
  if (!c) return; // not painted yet — retry on the next render pass
  try { sessionStorage.removeItem(PENDING_ROOM_KEY); } catch {}
  c.scrollIntoView({ behavior: "smooth", block: "center" });
  c.classList.add("pf-live-row--highlight");
  bootCtx?.deps?.toast?.("Here's the room you picked — take a seat.");
}

// Helper: which urgency bucket does this lobby belong to right now?
// Used by renderLiveParties() to bump imminent rooms to the top.
function startSoonBucket(lobby, nowMs) {
  const d = decodeStart(lobby && lobby.note);
  if (d.plannedAt) {
    const ms = d.plannedAt.getTime() - nowMs;
    if (ms <= 15 * 60 * 1000 && ms > -5 * 60 * 1000) return 0;
    if (ms > 0 && ms <= 60 * 60 * 1000) return 1;
    return 2;
  }
  if (d.isWhenFull) {
    const filled = Array.isArray(lobby.partyMembers) ? lobby.partyMembers.length : 1;
    if (filled >= (lobby.lobbySize || 4)) return 0;
    return 2;
  }
  return 2;
}

// ── Roblox-style seat slots ──────────────────────────────────────────
// The single biggest "is this place alive?" signal on a game card is
// SEEING the people already inside it. Filled seats render the actual
// member avatars (host gets a crown); empty seats render as inviting
// dashed "+ Open" slots that are themselves the join affordance when
// the viewer can actually take one.
function renderSeatStrip(l, { joinable } = {}) {
  const cap = lobbySizeOf(l);
  const isHouse = isHouseLobby(l);
  const profiles = Array.isArray(l.memberProfiles) && l.memberProfiles.length > 0
    ? l.memberProfiles.slice(0, cap)
    : [{ personaName: l.hostPersonaName, avatarUrl: l.hostAvatarUrl, isHost: true }];
  const seats = [];
  for (const m of profiles) {
    const name = m.personaName || (m.isHost ? "Host" : "Climber");
    const avatar = isHouse && m.isHost
      ? "/assets/vault-mark.svg"
      : (m.avatarUrl || "/assets/vault-mark.svg");
    seats.push(`
      <span class="pf-seat pf-seat--filled${m.isHost ? " pf-seat--host" : ""}" title="${esc(name)}${m.isHost ? " (host)" : ""}">
        <img src="${esc(avatar)}" alt="" loading="lazy" />
        ${m.isHost ? '<span class="pf-seat-crown" aria-hidden="true">👑</span>' : ""}
        <span class="pf-seat-name">${esc(name)}</span>
      </span>`);
  }
  const emptyCount = Math.max(0, cap - profiles.length);
  for (let i = 0; i < emptyCount; i++) {
    if (joinable) {
      seats.push(`
        <button type="button" class="pf-seat pf-seat--open" data-pf-action="join-room" data-lobby-id="${esc(l.lobbyId)}" title="Take this seat">
          <span class="pf-seat-plus" aria-hidden="true">+</span>
          <span class="pf-seat-name">Open</span>
        </button>`);
    } else {
      seats.push(`
        <span class="pf-seat pf-seat--open pf-seat--static">
          <span class="pf-seat-plus" aria-hidden="true">+</span>
          <span class="pf-seat-name">Open</span>
        </span>`);
    }
  }
  return `<div class="pf-seat-strip" aria-label="${profiles.length} of ${cap} seats filled">${seats.join("")}</div>`;
}

function renderLiveRow(l, state, best) {
  const mySid = state.presence?.steamId;
  const isMine = l.hostSteamId === mySid;
  const isBest = best?.lobbyId === l.lobbyId;
  const open = openSeatsOf(l);
  const filled = lobbyMembers(l).length;
  const cap = lobbySizeOf(l);
  const isFull = open <= 0;
  const fit = characterFit(l, state);
  const mismatch = fit.tone === "bad";
  const isHouse = isHouseLobby(l);
  const theme = isHouse ? houseTheme(l) : null;
  const seatsText = isFull
    ? `<span class="pf-seats pf-seats--full"><strong>${filled} of ${cap} filled</strong> · 0 open seats · Full</span>`
    : `<span class="pf-seats"><strong>${filled} of ${cap} filled</strong> · ${open} open seats</span>`;
  const cls = ["pf-live-row",
    isMine ? "pf-live-row--mine" : "",
    isBest ? "pf-live-row--highlight" : "",
    mismatch ? "pf-live-row--mismatch" : "",
    isFull ? "pf-live-row--full" : "",
    isHouse ? "pf-live-row--house" : "",
    isHouse && theme ? `pf-live-row--house-${theme.key}` : "",
  ].filter(Boolean).join(" ");
  // House lobbies replace the LevelBadge rep slot with a "VAULT TEAM"
  // pill so visitors don't see the synthetic Steam ID render as a
  // dishonest Lv1 Initiate badge. We also drop the data-host-steam-id
  // attribute on the rep slot so party-finder-reputation-rt.js skips
  // the fetch entirely (synthetic IDs return null reputation anyway).
  const repPill = isHouse
    ? houseVaultTeamPillHtml()
    : `<span class="pf-rep-slot" data-pf-rep-slot data-host-steam-id="${esc(l.hostSteamId || "")}"></span>`;
  // House lobbies declare their nature in plain copy. Keeps the
  // disclosure visible on every row — the renewer extends/recreates
  // them every 15 minutes so any "this isn't a real player" surprise
  // happens at the card, not in the lobby they just joined.
  const houseDisclosure = isHouse
    ? `<p class="pf-house-disclosure">${esc(HOUSE_DISCLOSURE_TEXT)}</p>`
    : "";
  // House rooms have no real heartbeat — the synthetic host never
  // updates `lastHeartbeatAt`. Render "always open" instead of the
  // legacy "active Nm ago" stamp so the row reads as eternal-open
  // rather than abandoned. The enrich pass in party-finder-globals.js
  // respects [data-pf-house-row] and skips its "active Nm ago" rewrite.
  const statusText = isHouse ? "always open" : hostStatusLabel(state, l.hostSteamId);
  const dotIdle = !isHouse && hostStatusLabel(state, l.hostSteamId) === "idle";
  const hostStrong = isHouse ? "SpireVault House" : (l.hostPersonaName || "Host");
  const dataHouseAttrs = isHouse
    ? ` data-pf-house-row="1" data-pf-house-slug="${esc(theme?.key || "")}"`
    : "";
  return `
    <article class="${cls}" data-lobby-id="${esc(l.lobbyId)}" data-host-steam-id="${esc(l.hostSteamId || "")}"${dataHouseAttrs}>
      <div class="pf-live-meta">
        <div class="pf-live-titlerow">
          <h4 class="pf-live-title">${esc(l.title || "Co-op room")}${isMine ? ' <span class="pf-fit-pill pf-fit-pill--good">Your Room</span>' : ""}${newcomerBadgeHtml(l)}</h4>
        </div>
        <div class="pf-host-strip" data-pf-host-strip>
          <img src="${esc(isHouse ? "/assets/vault-mark.svg" : (l.hostAvatarUrl || "/assets/vault-mark.svg"))}" class="${isHouse ? "pf-host-strip-img pf-host-strip-img--house" : ""}" alt="" />
          <strong>${esc(hostStrong)}</strong>
          ${repPill}
          <span class="pf-dot${dotIdle ? " pf-dot--idle" : ""}${isHouse ? " pf-dot--house" : ""}"></span>
          <span class="${isHouse ? "pf-host-status pf-host-status--house" : ""}">${esc(statusText)}</span>
        </div>
        ${houseDisclosure}
        <div class="pf-attrs">
          <span>${esc(branchLabelOf(l))}</span>
          <span class="pf-sep">·</span>
          <span>${esc(modeLabel(l))}</span>
          <span class="pf-sep">·</span>
          <span>${esc(ascensionBucketLabel(l.ascensionMin, l.ascensionMax))}</span>
          <span class="pf-sep">·</span>
          <span>${esc(goalLabel(l.goal))}</span>
        </div>
        <div class="pf-attrs">
          <span>Voice: <strong>${esc(voiceLabelOf(l))}</strong></span>
          <span class="pf-sep">·</span>
          <span>${esc(micLabel(l.voicePreference))}</span>
          <span class="pf-sep">·</span>
          ${chipFor(fit)}
        </div>
        ${renderPartyLine(l)}
        ${renderSeatStrip(l, { joinable: !isMine && !isFull && !mismatch })}
        ${seatsText}
      </div>
      <div class="pf-live-actions">
        ${joinButtonHtml(l, state, { primary: true })}
        <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="details" data-lobby-id="${esc(l.lobbyId)}">Details</button>
        ${isMine ? `<button type="button" class="pf-btn pf-btn--ghost pf-btn--danger" data-pf-action="close-room" data-lobby-id="${esc(l.lobbyId)}">Close Room</button>` : ""}
      </div>
    </article>`;
}

function applyRoomDeepLink() {
  try {
    const id = new URLSearchParams(window.location.search).get("room");
    if (!id) return;
    const c = document.querySelector(`#pf-live-list [data-lobby-id="${id}"], #pf-best-card [data-lobby-id="${id}"]`);
    if (!c) return;
    c.scrollIntoView({ behavior: "smooth", block: "center" });
    c.classList.add("pf-live-row--highlight");
  } catch {}
}

function focusBestCard(best) {
  const c = document.querySelector(`#pf-best-card [data-lobby-id="${best.lobbyId}"]`);
  if (c) {
    c.scrollIntoView({ behavior: "smooth", block: "center" });
    c.classList.add("pf-live-row--highlight");
    setTimeout(() => c.classList.remove("pf-live-row--highlight"), 2400);
  }
}

function showInlineNoMatch() {
  const $nm = document.getElementById("pf-prefs-nomatch");
  if (!$nm) return;
  $nm.hidden = false;
  $nm.innerHTML = `
    <h4>No matching room yet. Host one or loosen your preferences.</h4>
    <div class="pf-prefs-nomatch-actions">
      <button type="button" class="pf-btn pf-btn--primary" data-pf-action="open-host">Host a Room</button>
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="open-prefs">Change Preferences</button>
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="browse-live">Browse all parties</button>
    </div>`;
}

// ── Host modal ───────────────────────────────────────────────────────
function openHostModal() {
  hostModalStep = 1;
  const me = lastState?.presence;
  const myPrefs = readMyPrefsExt();
  if (me) {
    if (me.preferredCharacters?.[0]) hostForm.hostCharacter = normalizeCharacterId(me.preferredCharacters[0]) || hostForm.hostCharacter;
    if (me.goal && ["heart","daily","learning","casual","any"].includes(me.goal)) hostForm.goal = me.goal;
    hostForm.ascensionBucket = ascensionBucketId(me.ascensionMin, me.ascensionMax);
    if (me.voicePreference === "no") hostForm.mic = "no";
    else if (me.voicePreference === "optional") hostForm.mic = "optional";
    else hostForm.mic = "yes";
  }
  hostForm.branch = myPrefs.branch || "beta";
  if (!hostForm.title) hostForm.title = suggestedTitle();
  renderHostStep();
  showModal("pf-modal-host");
}

function suggestedTitle() {
  const g = GOALS.find((x) => x.id === hostForm.goal)?.label || "Heart";
  const a = ASC_BUCKETS.find((x) => x.id === hostForm.ascensionBucket)?.label || "A8-A10";
  return `${a} ${g}`;
}

function renderHostStep() {
  const $body = document.getElementById("pf-host-body");
  const $actions = document.getElementById("pf-host-actions");
  const $stepper = document.getElementById("pf-host-stepper");
  const $err = document.getElementById("pf-host-error");
  if (!$body || !$actions || !$stepper) return;
  $err.hidden = true; $err.textContent = "";
  $stepper.innerHTML = ["Run", "Party", "Review"].map((label, i) => {
    const n = i + 1;
    const cls = ["pf-step", n === hostModalStep ? "pf-step--active" : "", n < hostModalStep ? "pf-step--done" : ""].filter(Boolean).join(" ");
    return `<span class="${cls}"><span class="pf-step-num">${n}</span>${esc(label)}</span>`;
  }).join("");

  if (hostModalStep === 1) {
    $body.innerHTML = `
      <div class="pf-field"><label class="pf-field-label" for="pf-host-title">Room title</label>
        <input id="pf-host-title" type="text" maxlength="80" value="${esc(hostForm.title)}" placeholder='e.g. "A10 Heart Attempt"' /></div>
      <div class="pf-field"><span class="pf-field-label">Mode</span>
        <div class="pf-chiprow" data-pf-radio="mode">${MODES.map((m) => chipBtn(m.id, m.label, m.id === hostForm.mode)).join("")}</div></div>
      <div class="pf-field"><span class="pf-field-label">Goal <span class="pf-field-hint">“Learning” adds a welcoming “newcomers” badge</span></span>
        <div class="pf-chiprow" data-pf-radio="goal">${GOALS.map((g) => chipBtn(g.id, g.label, g.id === hostForm.goal)).join("")}</div></div>
      <div class="pf-field"><span class="pf-field-label">Ascension</span>
        <div class="pf-chiprow" data-pf-radio="ascensionBucket">${ASC_BUCKETS.map((a) => chipBtn(a.id, a.label, a.id === hostForm.ascensionBucket)).join("")}</div></div>
      <div class="pf-field"><span class="pf-field-label">Branch</span>
        <div class="pf-chiprow" data-pf-radio="branch">${BRANCHES.map((b) => chipBtn(b.id, b.label, b.id === hostForm.branch)).join("")}</div></div>
      <div class="pf-field"><span class="pf-field-label">Planned start <span class="pf-field-hint">other players see a live countdown</span></span>
        <div class="pf-chiprow" data-pf-radio="plannedStart">${START_PRESETS.map((p) => chipBtn(p.id, p.label, p.id === hostForm.plannedStart)).join("")}</div></div>`;
    $actions.innerHTML = `
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-modal-close>Cancel</button>
      <button type="button" class="pf-btn pf-btn--primary" data-pf-action="host-next">Next: Party</button>`;
  } else if (hostModalStep === 2) {
    $body.innerHTML = `
      <div class="pf-field"><span class="pf-field-label">Host character</span>
        <div class="pf-char-grid" data-pf-radio="hostCharacter">
          <button type="button" class="pf-char-btn ${hostForm.hostCharacter === "" ? "is-active" : ""}" data-value=""><span class="pf-char-btn-any">Any</span><span>Open to any</span></button>
          ${PF_CHARACTERS.map((c) => `<button type="button" class="pf-char-btn ${c.id === hostForm.hostCharacter ? "is-active" : ""}" data-value="${c.id}"><img src="${esc(characterAssetSrc(c.id))}" alt=""/><span>${esc(c.label)}</span></button>`).join("")}
        </div></div>
      <div class="pf-field"><span class="pf-field-label">Open character preference</span>
        <div class="pf-chiprow" data-pf-radio="openCharacterPreference">
          ${chipBtn("", "Any character welcome", hostForm.openCharacterPreference === "")}
          ${PF_CHARACTERS.map((c) => chipBtn(c.id, `${c.label} preferred`, hostForm.openCharacterPreference === c.id)).join("")}
        </div></div>
      <div class="pf-field"><span class="pf-field-label">Party size</span>
        <div class="pf-chiprow" data-pf-radio="lobbySize">${LOBBY_SIZES.map((n) => chipBtn(String(n), String(n), hostForm.lobbySize === n)).join("")}</div></div>
      <div class="pf-field"><span class="pf-field-label">Voice</span>
        <div class="pf-chiprow" data-pf-radio="voice">${VOICE_PRESETS_UI.map((v) => chipBtn(v.id, v.label, v.id === hostForm.voice)).join("")}</div>
        ${hostForm.voice === "custom" ? `<input id="pf-host-voice-custom" type="text" maxlength="60" placeholder="Discord link or channel name" value="${esc(hostForm.voiceCustom)}" />` : ""}</div>
      <div class="pf-field"><span class="pf-field-label">Mic</span>
        <div class="pf-chiprow" data-pf-radio="mic">${MIC_OPTIONS.map((m) => chipBtn(m.id, m.label, m.id === hostForm.mic)).join("")}</div></div>
      ${(() => {
        // Length budget: server caps note at 160. When a planned start
        // is set the [start=ISO]-prefix consumes 28 + a separator
        // space = 29 chars, leaving 131 for the user. We compute the
        // dynamic max here and surface a counter so the user can see
        // exactly how many characters they have left and we never
        // silently truncate.
        const reservedForPrefix = hostForm.plannedStart && hostForm.plannedStart !== "" && hostForm.plannedStart !== "none" ? 29 : 0;
        const noteMax = 160 - reservedForPrefix;
        const used = String(hostForm.note || "").length;
        const remaining = noteMax - used;
        const counterTone = remaining < 0 ? "danger" : remaining <= 12 ? "warn" : "ok";
        return `<div class="pf-field"><label class="pf-field-label" for="pf-host-note">Note (optional, <span class="pf-note-counter" data-pf-note-counter data-tone="${counterTone}">${remaining} left</span>)</label>
        <input id="pf-host-note" type="text" maxlength="${noteMax}" value="${esc(hostForm.note)}" placeholder='"Trying to get a clean Heart run."' /></div>`;
      })()}`;
    $actions.innerHTML = `
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="host-back">Back</button>
      <div style="flex:1"></div>
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-modal-close>Cancel</button>
      <button type="button" class="pf-btn pf-btn--primary" data-pf-action="host-next">Next: Review</button>`;
  } else {
    const p = buildHostPreview();
    $body.innerHTML = `
      <div class="pf-host-preview">
        <span class="pf-eyebrow">Your room</span>
        <h4>${esc(p.title)}</h4>
        <div class="pf-host-preview-attrs">
          <span>${esc(p.branch)}</span><span class="pf-sep">·</span>
          <span>${esc(p.mode)}</span><span class="pf-sep">·</span>
          <span>${esc(p.ascension)}</span><span class="pf-sep">·</span>
          <span>${esc(p.goal)}</span>
        </div>
        <div class="pf-host-preview-attrs">
          <span>Voice: <strong>${esc(p.voice)}</strong></span><span class="pf-sep">·</span><span>${esc(p.mic)}</span>
        </div>
        <div class="pf-host-preview-sub">Characters: Host on ${esc(p.hostChar)} · ${esc(p.charLine)}</div>
        <div class="pf-host-preview-sub">Planned start: <strong>${esc(p.plannedStart)}</strong></div>
        <div class="pf-host-preview-sub">1 of ${hostForm.lobbySize} filled · ${hostForm.lobbySize - 1} open seats</div>
        ${p.note ? `<p class="pf-host-preview-sub">&ldquo;${esc(p.note)}&rdquo;</p>` : ""}
      </div>`;
    $actions.innerHTML = `
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-action="host-back">Back</button>
      <div style="flex:1"></div>
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-modal-close>Cancel</button>
      <button type="button" class="pf-btn pf-btn--primary" data-pf-action="host-submit">Host Room</button>`;
  }
}

function chipBtn(value, label, active) {
  return `<button type="button" class="pf-chip-btn ${active ? "is-active" : ""}" data-value="${esc(String(value))}">${esc(label)}</button>`;
}

function buildHostPreview() {
  const voice = hostForm.voice === "custom"
    ? (hostForm.voiceCustom || "Custom")
    : VOICE_PRESETS_UI.find((v) => v.id === hostForm.voice)?.label || "Voice flexible";
  return {
    title: hostForm.title || suggestedTitle(),
    branch: BRANCHES.find((b) => b.id === hostForm.branch)?.label || "Beta branch",
    mode: MODES.find((m) => m.id === hostForm.mode)?.label || "Standard",
    goal: GOALS.find((g) => g.id === hostForm.goal)?.label || "Heart",
    ascension: ASC_BUCKETS.find((a) => a.id === hostForm.ascensionBucket)?.label || "Any level",
    voice,
    mic: MIC_OPTIONS.find((m) => m.id === hostForm.mic)?.label || "Mic optional",
    hostChar: hostForm.hostCharacter ? characterLabel(hostForm.hostCharacter) : "Any",
    charLine: hostForm.openCharacterPreference ? `${characterLabel(hostForm.openCharacterPreference)} preferred` : "Any character welcome",
    note: hostForm.note,
    plannedStart: START_PRESETS.find((p) => p.id === hostForm.plannedStart)?.label || "No rush",
  };
}

function captureHostStep1() {
  const $t = document.getElementById("pf-host-title");
  if ($t) hostForm.title = $t.value.trim();
}
function captureHostStep2() {
  const $n = document.getElementById("pf-host-note");
  if ($n) hostForm.note = $n.value.trim();
  const $v = document.getElementById("pf-host-voice-custom");
  if ($v) hostForm.voiceCustom = $v.value.trim();
}

async function submitHost() {
  const $err = document.getElementById("pf-host-error");
  $err.hidden = true; $err.textContent = "";
  if (!hostForm.title) { $err.textContent = "Add a short title so players know what you're running."; $err.hidden = false; return; }
  const asc = ascensionRange(hostForm.ascensionBucket);
  const goalServer = ["heart","daily","learning","casual","any"].includes(hostForm.goal) ? hostForm.goal : "any";
  const voicePref = hostForm.mic === "yes" ? "yes" : hostForm.mic === "no" ? "no" : "optional";
  const voicePreset = hostForm.voice === "none" ? "none"
    : hostForm.voice === "any" ? "any"
    : hostForm.voice === "lfg1" ? "lfg1"
    : hostForm.voice === "lfg3" ? "lfg_duo3" : "custom";
  const voiceLabel = hostForm.voice === "custom"
    ? (hostForm.voiceCustom || "")
    : (VOICE_PRESETS_UI.find((v) => v.id === hostForm.voice)?.label || "");
  // Encode the planned-start preset onto the note field as a bracketed
  // prefix. The backend's sanitizeText() keeps [ ] = : - T Z intact so
  // this round-trips cleanly without any schema change. Other clients
  // decode the prefix and render the countdown badge / GO moment.
  const planned = hostForm.plannedStart ? presetToPlanned(hostForm.plannedStart) : null;
  const encodedNote = encodeStart(hostForm.note, planned);
  const body = {
    title: hostForm.title,
    mode: hostForm.mode,
    goal: goalServer,
    lobbySize: hostForm.lobbySize,
    ascensionMin: asc.min,
    ascensionMax: asc.max,
    voicePreference: voicePref,
    voicePreset,
    voiceChannelUrl: voiceLabel || undefined,
    preferredCharacters: hostForm.hostCharacter ? [hostForm.hostCharacter] : [],
    note: encodedNote || undefined,
  };
  const $btn = document.querySelector('[data-pf-action="host-submit"]');
  if ($btn) { $btn.disabled = true; $btn.textContent = "Hosting…"; }
  // v196 — kick off the matchmaker card-flip in parallel with the POST.
  // The third card reveals the host's chosen character (or a generic
  // sparkle if they left the field on "Open to any"). Animation
  // duration is ~1500ms which usually overlaps the network round-trip,
  // so the user reads the reveal as the cause of the room becoming
  // real. Reduced-motion users get a 200ms fade instead. The
  // animation promise is fired-and-merged with the network promise
  // so we don't double-await and stall the UI when the server is
  // fast.
  let matchmakerPromise = Promise.resolve();
  try {
    const matchmaker = window.__pfMatchmaker;
    if (matchmaker && typeof matchmaker.run === "function") {
      const heroSlug = normalizeCharacterId(hostForm.hostCharacter);
      const heroImage = heroSlug ? characterAssetSrc(heroSlug) : "/assets/vault-mark.svg";
      const heroLabel = heroSlug ? characterLabel(heroSlug) : "Your room";
      matchmakerPromise = matchmaker.run({
        reason: "host",
        heroImage,
        heroLabel,
        caption: "Dealing your room\u2026",
      });
    }
  } catch (_) { /* never block submit on animation */ }
  const r = await jsonFetch("/coop/lobbies", { body });
  if ($btn) { $btn.disabled = false; $btn.textContent = "Host Room"; }
  if (!r.ok) {
    // For state-conflict errors (already in a party / session / room),
    // surface a one-tap "Refresh now" so the user can resync without
    // hunting through the rest of the UI. We render with innerHTML so
    // the action button is clickable; the message itself comes from
    // jsonFetch (backend human text preferred, humanizeError fallback).
    const stateCodes = ["in_party", "in_session", "lobby_exists", "already_in_lobby"];
    const msg = r.message || "Could not host your room.";
    if (r.code && stateCodes.indexOf(r.code) !== -1) {
      $err.innerHTML =
        '<span class="pf-form-error-text">' + msg.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])) + '</span>' +
        ' <button type="button" class="pf-form-error-action" data-pf-action="host-refresh-state">Refresh now</button>';
    } else {
      $err.textContent = msg;
    }
    $err.hidden = false;
    return;
  }
  const newId = r.lobby?.lobbyId || r.lobbyId;
  if (newId) {
    writeBranchOverride(newId, hostForm.branch);
    if (voiceLabel) writeVoiceOverride(newId, voiceLabel);
  }
  writeMyPrefsExt({ branch: hostForm.branch });
  // Let the matchmaker animation breathe before the room exists in the
  // UI. If the POST returned in <1500ms (the typical case), we wait
  // for the cards to finish flipping; if it took longer, this is a
  // no-op (Promise already resolved).
  try { await matchmakerPromise; } catch (_) {}
  bootCtx?.deps?.toast?.("Room hosted.");
  hideModal("pf-modal-host");
  hostForm.title = "";
  hostForm.plannedStart = "";
  await refreshState({ force: true });
}

// ── Details modal ────────────────────────────────────────────────────
function openDetailsModal(lobbyId) {
  detailsLobbyId = lobbyId;
  const l = findLobby(lobbyId);
  if (!l) { bootCtx?.deps?.toast?.("Room not found."); return; }
  const s = lastState;
  const $body = document.getElementById("pf-details-body");
  const $actions = document.getElementById("pf-details-actions");
  const $title = document.getElementById("pf-modal-details-title");
  if (!$body || !$actions) return;
  $title.textContent = l.title || "Room";
  const fit = characterFit(l, s);
  const fitClass = fit.tone === "good" ? "pf-fit-pill--great" : fit.tone === "neutral" ? "pf-fit-pill--good" : "pf-fit-pill--mismatch";
  const reasons = buildWhy(l, s);
  const filled = lobbyMembers(l).length;
  const cap = lobbySizeOf(l);
  const open = openSeatsOf(l);
  const voice = voiceLabelOf(l);
  $body.innerHTML = `
    <span class="pf-fit-pill ${fitClass}">${esc(fit.tone === "good" ? "Great fit" : fit.tone === "neutral" ? "Good fit" : "Possible fit")}</span>
    <div class="pf-why"><span class="pf-why-title">Fit for you</span>
      <ul class="pf-why-list">${reasons.map((r) => `<li class="${r.bad ? "pf-why-bad" : ""}">${esc(r.text)}</li>`).join("")}</ul></div>
    <div class="pf-details-grid">
      <div class="pf-details-row"><span class="pf-details-key">Host</span><span class="pf-details-val">${esc(l.hostPersonaName || "Host")} <span class="pf-rep-slot pf-rep-slot--inline-coop" data-pf-rep-slot data-host-steam-id="${esc(l.hostSteamId || "")}"></span></span></div>
      <div class="pf-details-row"><span class="pf-details-key">Branch</span><span class="pf-details-val">${esc(branchLabelOf(l))}</span></div>
      <div class="pf-details-row"><span class="pf-details-key">Mode</span><span class="pf-details-val">${esc(modeLabel(l))}</span></div>
      <div class="pf-details-row"><span class="pf-details-key">Ascension</span><span class="pf-details-val">${esc(ascensionBucketLabel(l.ascensionMin, l.ascensionMax))}</span></div>
      <div class="pf-details-row"><span class="pf-details-key">Goal</span><span class="pf-details-val">${esc(goalLabel(l.goal))}</span></div>
      <div class="pf-details-row"><span class="pf-details-key">Voice</span><span class="pf-details-val">${esc(voiceIsNone(l) ? "Voice not required" : voice)}</span></div>
      <div class="pf-details-row"><span class="pf-details-key">Mic</span><span class="pf-details-val">${esc(micLabel(l.voicePreference))}</span></div>
      <div class="pf-details-row"><span class="pf-details-key">Seats</span><span class="pf-details-val">${filled} of ${cap} filled · ${open} open seats</span></div>
    </div>
    ${renderPartyLine(l)}
    ${(() => {
      // Surface planned start in the Details modal so the joiner can
      // decide if they have time. Strip the [start=...] prefix from
      // the visible note so it doesn't leak into "Note:" text.
      const ds = decodeStart(l.note);
      const startBits = [];
      if (ds.plannedAt) {
        const fmt = formatCountdown(ds.plannedAt, new Date());
        if (fmt.tier !== "gone") startBits.push(`<div class="pf-details-row"><span class="pf-details-key">Starts</span><span class="pf-details-val">${esc(fmt.text)} (${esc(ds.plannedAt.toLocaleString())})</span></div>`);
      } else if (ds.isWhenFull) {
        startBits.push(`<div class="pf-details-row"><span class="pf-details-key">Starts</span><span class="pf-details-val">The moment we fill</span></div>`);
      }
      const noteBit = ds.cleanNote ? `<p class="pf-section-sub">Note: &ldquo;${esc(ds.cleanNote)}&rdquo;</p>` : "";
      return startBits.join("") + noteBit;
    })()}
    <div class="pf-howto"><strong>How joining works</strong>
      <ol>
        <li>Join this SpireVault room.</li>
        <li>Join ${esc(voiceIsNone(l) ? "Discord" : voice)} voice in Discord.</li>
        <li>Add the host on Steam if needed.</li>
        <li>Open STS2 Multiplayer.</li>
        <li>Join or refresh when the host reaches character select.</li>
      </ol></div>`;
  $actions.innerHTML = `
    <button type="button" class="pf-btn pf-btn--ghost" data-pf-modal-close>Close</button>
    <div style="flex:1"></div>
    ${joinButtonHtml(l, s, { primary: true })}`;
  showModal("pf-modal-details");
}

// ── Run Preferences modal ────────────────────────────────────────────
function openPrefsModal() {
  const $body = document.getElementById("pf-prefs-body");
  if (!$body) return;
  const me = lastState?.presence || {};
  const myPrefs = readMyPrefsExt();
  const myChar = myPreferredCharacter(lastState || {});
  const ascId = ascensionBucketId(me.ascensionMin, me.ascensionMax);
  const branch = myPrefs.branch || "beta";
  const voice = me.voicePreference || "optional";
  const goal = me.goal || "any";
  $body.innerHTML = `
    <div class="pf-field"><span class="pf-field-label">Character</span>
      <div class="pf-char-grid" data-pf-radio="pf-prefs-character">
        <button type="button" class="pf-char-btn ${!myChar ? "is-active" : ""}" data-value=""><span class="pf-char-btn-any">Any</span><span>Open to any</span></button>
        ${PF_CHARACTERS.map((c) => `<button type="button" class="pf-char-btn ${c.id === myChar ? "is-active" : ""}" data-value="${c.id}"><img src="${esc(characterAssetSrc(c.id))}" alt=""/><span>${esc(c.label)}</span></button>`).join("")}
      </div></div>
    <div class="pf-field"><span class="pf-field-label">Ascension</span>
      <div class="pf-chiprow" data-pf-radio="pf-prefs-asc">${ASC_BUCKETS.map((a) => chipBtn(a.id, a.label, a.id === ascId)).join("")}</div></div>
    <div class="pf-field"><span class="pf-field-label">Voice</span>
      <div class="pf-chiprow" data-pf-radio="pf-prefs-voice">
        ${chipBtn("yes", "Voice preferred", voice === "yes")}
        ${chipBtn("optional", "Voice optional", voice === "optional")}
        ${chipBtn("no", "No voice", voice === "no")}
      </div></div>
    <div class="pf-field"><span class="pf-field-label">Branch</span>
      <div class="pf-chiprow" data-pf-radio="pf-prefs-branch">${BRANCHES.map((b) => chipBtn(b.id, b.label, b.id === branch)).join("")}</div></div>
    <div class="pf-field"><span class="pf-field-label">Goal</span>
      <div class="pf-chiprow" data-pf-radio="pf-prefs-goal">${GOALS.map((g) => chipBtn(g.id, g.label, g.id === goal)).join("")}</div></div>`;
  showModal("pf-modal-prefs");
}

async function savePrefsFromModal() {
  const get = (name) => document.querySelector(`[data-pf-radio="${name}"] .pf-chip-btn.is-active, [data-pf-radio="${name}"] .pf-char-btn.is-active`)?.dataset?.value;
  const myChar = get("pf-prefs-character");
  const ascId = get("pf-prefs-asc") || "any";
  const voice = get("pf-prefs-voice") || "optional";
  const branch = get("pf-prefs-branch") || "beta";
  const goal = get("pf-prefs-goal") || "any";
  const asc = ascensionRange(ascId);
  const body = {
    status: lastState?.presence?.status || "looking",
    goal,
    ascensionMin: asc.min,
    ascensionMax: asc.max,
    voicePreference: voice,
    preferredCharacters: myChar ? [myChar] : [],
  };
  const r = await jsonFetch("/coop/presence", { body });
  if (!r.ok) {
    const $err = document.getElementById("pf-prefs-error");
    if ($err) { $err.textContent = r.message || "Could not save your preferences."; $err.hidden = false; }
    return;
  }
  writeMyPrefsExt({ branch });
  bootCtx?.deps?.toast?.("Preferences saved.");
  hideModal("pf-modal-prefs");
  // Reset Live Parties pagination — a new filter shouldn't inherit a
  // stale deep-page cursor from the old filter set.
  livePartiesPage = 1;
  await refreshState({ force: true });
}

// ── Join action ──────────────────────────────────────────────────────
async function doJoinRoom(id) {
  const l = findLobby(id);
  if (!l) { bootCtx?.deps?.toast?.("Room not found."); return; }
  const my = myPreferredCharacter(lastState || {});
  const hostChar = hostCharacterOf(l);
  const claimed = new Set([hostChar].filter(Boolean));
  let pick = my && !claimed.has(my) ? my : "";
  if (!pick) for (const c of PF_CHARACTERS) if (!claimed.has(c.id)) { pick = c.id; break; }
  if (!pick) { bootCtx?.deps?.toast?.("No character left to claim."); return; }
  const approval = l.approvalRequired === true;
  const path = approval ? `/coop/lobbies/${id}/request` : `/coop/lobbies/${id}/join-seat`;
  const r = await jsonFetch(path, { body: { selectedCharacter: pick } });
  if (!r.ok) { bootCtx?.deps?.toast?.(r.message || "Couldn't join this room."); return; }
  if (approval) { bootCtx?.deps?.toast?.("Seat requested."); await refreshState({ force: true }); return; }
  bootCtx?.deps?.toast?.("You're in — opening Party Hub.");
  const pid = r.partyId || r.party?.partyId;
  if (pid) window.location.assign(`/party/${pid}`);
  else await refreshState({ force: true });
}

// ── Modal helpers + delegated clicks ─────────────────────────────────
function showModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = false;
  document.body.style.overflow = "hidden";
}
function hideModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.hidden = true;
  const any = ["pf-modal-host", "pf-modal-details", "pf-modal-prefs"].some((x) => x !== id && !document.getElementById(x)?.hidden);
  if (!any) document.body.style.overflow = "";
}

// CSS.escape wrapper that falls back to a minimal manual escape on
// browsers without CSS.escape. Lobby IDs are server-generated and
// shouldn't contain CSS-meta chars, but the proxy targets a DOM
// rendered by coop-lobbies.js that we don't own — so we treat the id
// as untrusted at the selector boundary.
function cssEscapeId(id) {
  const s = String(id == null ? "" : id);
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/["\\]/g, "\\$&");
}

// Proxy a party-finder.js click to a coop-lobbies.js delegated handler
// by synthesizing a click on the matching button. Polls for the button
// because both surfaces mount independently and party-finder.js can
// paint its UI before coop-lobbies.js completes its first /coop/state
// poll. Without the wait, a fast user click on a cold page lands on
// the giveUp branch and looks like a dead button — the exact symptom
// reported as "Manage Your Room does nothing."
//
// Timing: 8 attempts × 200ms = 1.6s total wait. coop-lobbies.js fires
// its first refreshState synchronously inside mountCoopLobbies; on a
// warm connection it completes well under 500ms.
function proxyToCoopLobbiesButton({ action, lobbyId, selectors, fallback, giveUpMessage }) {
  const maxAttempts = 8;
  const intervalMs = 200;
  let attempt = 0;
  const tick = () => {
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        btn.click();
        return;
      }
    }
    attempt += 1;
    if (attempt < maxAttempts) {
      setTimeout(tick, intervalMs);
      return;
    }
    // Last-resort fallback (e.g. close-room's #coop-lobby-close modal
    // button which lives in the DOM as soon as the edit modal markup
    // is parsed, regardless of state).
    if (typeof fallback === "function") {
      try {
        if (fallback() === true) return;
      } catch (err) {
        console.warn(`pf-proxy ${action} fallback threw`, err);
      }
    }
    try {
      if (typeof window !== "undefined" && typeof window.toast === "function") {
        window.toast(giveUpMessage);
      }
    } catch { /* no-op */ }
    console.warn(`pf-proxy ${action} could not find handler for lobby ${lobbyId} after ${maxAttempts * intervalMs}ms`);
  };
  tick();
}

function wireDelegatedClicks() {
  document.addEventListener("click", async (e) => {
    const close = e.target.closest?.("[data-pf-modal-close]");
    if (close) {
      const b = close.closest(".pf-modal-backdrop");
      if (b?.id) hideModal(b.id);
      return;
    }
    if (e.target.classList?.contains?.("pf-modal-backdrop")) { hideModal(e.target.id); return; }
    // Radio chip selection inside modals.
    const chip = e.target.closest?.("[data-pf-radio] .pf-chip-btn, [data-pf-radio] .pf-char-btn");
    if (chip) {
      const group = chip.closest("[data-pf-radio]");
      group.querySelectorAll(".is-active").forEach((el) => el.classList.remove("is-active"));
      chip.classList.add("is-active");
      const name = group.dataset.pfRadio;
      const value = chip.dataset.value;
      if (Object.prototype.hasOwnProperty.call(hostForm, name)) {
        if (name === "lobbySize") hostForm.lobbySize = Number(value) || 4;
        else hostForm[name] = value;
        if (name === "voice") renderHostStep();
      }
      return;
    }
    const btn = e.target.closest("[data-pf-action]");
    if (!btn) return;
    const action = btn.dataset.pfAction;
    switch (action) {
      case "open-host": openHostModal(); return;
      case "open-prefs": openPrefsModal(); return;
      case "save-prefs": void savePrefsFromModal(); return;
      case "find-me": {
        pendingFindMeFocus = true;
        await refreshState({ force: true });
        const visible = visibleOpenLobbies(lastState || {});
        const best = pickBestLobby(lastState || {}, visible);
        if (!best) showInlineNoMatch();
        return;
      }
      case "browse-live": document.getElementById("pf-live")?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
      case "details": openDetailsModal(btn.dataset.lobbyId); return;
      case "join-room": void doJoinRoom(btn.dataset.lobbyId); return;
      case "close-room": {
        // Delegate to coop-lobbies.js's close-lobby handler. See the
        // manage-room case below for the polling rationale; the same
        // cold-paint race applies to close.
        const lobbyId = btn.dataset.lobbyId || "";
        if (!lobbyId) return;
        proxyToCoopLobbiesButton({
          action: "close-room",
          lobbyId,
          // Two selectors to try, in priority order. coop-lobbies.js
          // renders an inline Close button on its hosting primary card
          // (case "hosting_lobby" — data-coop-action="close-lobby"
          // with data-id). The edit modal also has a permanent Close
          // Room button (#coop-lobby-close) that we have to stamp
          // with data-id when used as the fallback path.
          selectors: [`[data-coop-action="close-lobby"][data-id="${cssEscapeId(lobbyId)}"]`],
          fallback: () => {
            const $modal = document.getElementById("coop-lobby-close");
            if ($modal) {
              $modal.dataset.id = lobbyId;
              $modal.click();
              return true;
            }
            return false;
          },
          giveUpMessage: "Couldn't find the close action — refresh and try again.",
        });
        return;
      }
      case "manage-room": {
        // The party-finder.js prototype shipped without its own
        // edit-lobby flow; the original handler was a scrollIntoView
        // placeholder that the user nicknamed "Manage Your Room does
        // nothing." coop-lobbies.js owns the real `openEditLobbyModal`
        // and exposes it via `[data-coop-action="open-edit-lobby"]`
        // event delegation. Delegate by synthesizing a click on that
        // button.
        //
        // Cold-paint race: both party-finder.js AND coop-lobbies.js
        // mount on /tab=coop and each runs its own `/coop/state` poll.
        // If a user clicks Manage before coop-lobbies.js's first poll
        // resolves, `document.querySelector` returns null and the
        // synchronous fallback used to fire — landing on the
        // "Manage Your Room does nothing" report. The poller below
        // waits up to ~1.6s for the button to appear, then gives up
        // gracefully. coop-lobbies.js's first refreshState fires
        // synchronously at mount time so in practice the button is
        // present within one network round-trip.
        const lobbyId = btn.dataset.lobbyId || "";
        if (!lobbyId) return;
        proxyToCoopLobbiesButton({
          action: "manage-room",
          lobbyId,
          selectors: [`[data-coop-action="open-edit-lobby"][data-id="${cssEscapeId(lobbyId)}"]`],
          fallback: null,
          giveUpMessage: "Couldn't open room editor — refresh and try again.",
        });
        return;
      }
      case "refresh": void refreshState({ force: true }); return;
      case "net-retry": void refreshState({ force: true }); return;
      case "toggle-room-alert": {
        if (roomAlertArmed()) {
          setRoomAlertArmed(false);
          bootCtx?.deps?.toast?.("Room alerts off.");
          return;
        }
        const arm = () => {
          setRoomAlertArmed(true);
          bootCtx?.deps?.toast?.("Armed — you'll get one alert when the next room opens.");
        };
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "default") {
            // Arm regardless of the user's permission answer — a denied
            // permission still gets the in-app toast on the next poll.
            void Notification.requestPermission().then(arm, arm);
            return;
          }
        } catch {}
        arm();
        return;
      }
      case "live-more": {
        livePartiesPage = (livePartiesPage || 1) + 1;
        if (lastState) renderLiveParties(lastState, visibleOpenLobbies(lastState), pickBestLobby(lastState, visibleOpenLobbies(lastState)));
        return;
      }
      case "host-next":
        if (hostModalStep === 1) captureHostStep1();
        if (hostModalStep === 2) captureHostStep2();
        if (hostModalStep < 3) hostModalStep += 1;
        renderHostStep();
        return;
      case "host-back":
        if (hostModalStep === 2) captureHostStep2();
        if (hostModalStep > 1) hostModalStep -= 1;
        renderHostStep();
        return;
      case "host-submit": void submitHost(); return;
      case "lock-in": {
        // Host-only action — fast-forwards a planned start so the
        // room hits the GO countdown immediately. Re-encodes the
        // [start=...] prefix on the existing lobby note (preserving
        // any user note text) and PATCHes /coop/lobbies/:id. The
        // backend's PATCH already accepts host-only note updates so
        // this needs no backend change.
        const lobbyId = btn.dataset.lobbyId;
        if (!lobbyId) return;
        const lb = findLobby(lobbyId);
        if (!lb) return;
        if (!confirm("Lock the room in and launch in 30 seconds? Your party will see the countdown.")) return;
        const cleanNote = decodeStart(lb.note).cleanNote;
        const newNote = encodeStart(cleanNote, new Date(Date.now() + 30 * 1000));
        btn.disabled = true;
        const prev = btn.textContent; btn.textContent = "Locking…";
        const r = await jsonFetch(`/coop/lobbies/${encodeURIComponent(lobbyId)}`, {
          method: "PATCH",
          body: { note: newNote },
        });
        btn.disabled = false; btn.textContent = prev;
        if (!r.ok) {
          bootCtx?.deps?.toast?.(r.message || "Could not lock the room.");
          return;
        }
        bootCtx?.deps?.toast?.("Locked in. Launching in 30 seconds.");
        await refreshState({ force: true });
        return;
      }
      case "host-refresh-state": {
        // Triggered from the inline "Refresh now" button rendered in
        // the host error block when the backend says we're already in
        // a party/session/lobby. Pull fresh state, then either close
        // the modal (if state confirms we already have a room) or
        // clear the error so the user can submit again cleanly.
        const $err = document.getElementById("pf-host-error");
        const $b = btn;
        if ($b) { $b.disabled = true; $b.textContent = "Refreshing…"; }
        await refreshState({ force: true });
        if ($err) { $err.hidden = true; $err.innerHTML = ""; }
        if ($b) { $b.disabled = false; $b.textContent = "Refresh now"; }
        return;
      }
      default: return;
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "pf-host-title") hostForm.title = e.target.value;
    if (e.target.id === "pf-host-note") {
      hostForm.note = e.target.value;
      // Live counter for the budget. Re-rendering the whole step on
      // every keystroke would steal focus, so update only the counter.
      const counter = document.querySelector("[data-pf-note-counter]");
      if (counter) {
        const reserved = hostForm.plannedStart && hostForm.plannedStart !== "" && hostForm.plannedStart !== "none" ? 29 : 0;
        const remaining = (160 - reserved) - hostForm.note.length;
        counter.textContent = `${remaining} left`;
        counter.dataset.tone = remaining < 0 ? "danger" : remaining <= 12 ? "warn" : "ok";
      }
    }
    if (e.target.id === "pf-host-voice-custom") hostForm.voiceCustom = e.target.value;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["pf-modal-host", "pf-modal-details", "pf-modal-prefs"].forEach((id) => {
      const m = document.getElementById(id);
      if (m && !m.hidden) hideModal(id);
    });
  });
}

// ── Dev Sandbox scenario buttons (rewrite the row) ───────────────────
function augmentSandboxScenariosWhenReady() {
  if (!isCoopSandboxEnabled()) return;
  const observer = new MutationObserver(() => {
    const wrap = document.querySelector(".coop-sandbox-scenarios");
    if (!wrap || wrap.dataset.pfAugmented === "1") return;
    wrap.dataset.pfAugmented = "1";
    wrap.classList.add("pf-sandbox-scenarios");
    wrap.innerHTML = [
      ["A", "Empty", ""],
      ["B", "Good matches", ""],
      ["B", "Mismatch", "mismatch"],
      ["F", "Full room", ""],
      ["E", "Joined party", ""],
      ["B", "No voice party", "no-voice"],
      ["C", "Host view", ""],
      ["C", "Host closed", "host-closed"],
      ["B", "Expired", "expired"],
    ].map(([id, label, override]) =>
      `<button type="button" class="btn-ghost btn-xs" data-sandbox-scenario="${id}" data-pf-override="${override}">${esc(label)}</button>`
    ).join("");
    wrap.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        try { localStorage.setItem(LS_SCENARIO, btn.dataset.pfOverride || ""); } catch {}
        setTimeout(() => void refreshState({ force: true }), 600);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
