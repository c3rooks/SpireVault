// coop-lobbies.js — v23 (Co-op Lobby Beta — character-aware rooms)
// =========================================================================
// Drives the Co-op Lobby Beta surface:
//   A. Compact command bar with 3 stats + CTAs (Host a Room, Quick Match,
//      Run Preferences).
//   B. 2-col workspace:
//        main: Invites/requests · Open Run Lobbies · Best Matches
//        side: Your Status · Current Activity · How it works (collapsed)
//   C. Players Looking Now feed below the workspace (secondary surface,
//      also visible in Classic Co-op).
//
// User-facing wording is the only canonical vocabulary:
//   Host a Room        — primary CTA (modal)
//   Open Rooms         — the board users browse + join
//   Best Matches       — sorted recommendations
//   Run Preferences    — settings modal (NEVER "intent")
//   Pairing            — what you're in after accept (NEVER "session")
//
// SpireVault is built for Slay the Spire 2, so the ascension cap is 10.
// GAME_CONFIG below is the single source of truth; never hard-code "10"
// anywhere else in the renderer.
//
// Backend wire is unchanged: same /coop/* endpoints and same
// CoopStateBundle shape. This module is pure presentation + wording.
// =========================================================================

import {
  mountCoopSandbox,
  ensureCoopSandboxMounted,
  refreshSandboxFromState,
  isCoopSandboxEnabled,
  filterOpenLobbiesForViewer,
  filterRecommendationsForViewer,
  isSandboxSteamId,
} from "./coop-sandbox.js?v=12";
import { decodeStart } from "./party-finder-startsoon.js?v=1";

export { ensureCoopSandboxMounted, isCoopSandboxEnabled } from "./coop-sandbox.js?v=12";

const GAME_CONFIG = Object.freeze({
  game: "Slay the Spire 2",
  maxAscension: 10,
});

const COOP_CHARACTERS = Object.freeze([
  { id: "ironclad", label: "Ironclad" },
  { id: "silent", label: "Silent" },
  { id: "defect", label: "Defect" },
  { id: "regent", label: "Regent" },
  { id: "necrobinder", label: "Necrobinder" },
]);
const COOP_CHARACTER_IDS = new Set(COOP_CHARACTERS.map((c) => c.id));

function normalizeCharacterId(value) {
  const id = String(value || "").trim().toLowerCase();
  return COOP_CHARACTER_IDS.has(id) ? id : "";
}

function characterLabel(id) {
  return COOP_CHARACTERS.find((c) => c.id === normalizeCharacterId(id))?.label || "";
}

function characterAssetSrc(id) {
  const slug = normalizeCharacterId(id);
  return slug ? `/assets/sts2/characters/${slug}-v2.webp` : "";
}

function preferredCharactersOf(entity) {
  return Array.from(new Set(
    (entity?.preferredCharacters || [])
      .map(normalizeCharacterId)
      .filter(Boolean),
  ));
}

function firstPreferredCharacter(entity) {
  return preferredCharactersOf(entity)[0] || "";
}

function preferredCharactersPayload(value) {
  const id = normalizeCharacterId(value);
  return id ? [id] : [];
}

function selectedRadioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || "";
}

function setCharacterRadio(name, value) {
  const id = normalizeCharacterId(value);
  const selector = `input[name="${name}"][value="${id}"]`;
  const el = document.querySelector(selector) || document.querySelector(`input[name="${name}"][value=""]`);
  if (el && !el.checked) el.checked = true;
}

/** Accepted members only — pending seat requests never fill the seat row. */
function lobbyMembers(lobby) {
  if (!lobby) return [];
  const accepted = lobby.acceptedMemberSteamIds;
  if (Array.isArray(accepted) && accepted.length > 0) return accepted;
  const legacy = lobby.memberSteamIds;
  if (Array.isArray(legacy) && legacy.length > 0) return legacy;
  return lobby.hostSteamId ? [lobby.hostSteamId] : [];
}
function lobbySizeOf(lobby) {
  const n = lobby?.lobbySize;
  return n === 2 || n === 3 || n === 4 ? n : 4;
}

function lobbyApprovalRequired(lobby) {
  return lobby?.approvalRequired === true;
}

const VOICE_PRESET_LABELS = {
  none: "No voice",
  any: "Any voice",
  lfg1: "LFG 1",
  lfg_duo3: "LFG Duo 3",
  custom: "Custom link",
};

function voicePresetDisplay(lobby) {
  const preset = lobby?.voicePreset || "any";
  return VOICE_PRESET_LABELS[preset] || preset;
}

const ROOM_JOIN_BASE = "https://spirevault.app/coop?room=";

function buildDiscordLfgPost(lobby) {
  const members = lobbyMembers(lobby);
  const cap = lobbySizeOf(lobby);
  const need = openSeats(lobby);
  const voiceLabel = voicePresetDisplay(lobby);
  const voiceUrl = lobby.voiceChannelUrl ? ` ${lobby.voiceChannelUrl}` : "";
  // Embed Discord's native relative timestamp tag when the host set a
  // planned start. The Discord client renders <t:UNIX:R> as a live
  // "in 14 minutes" inline pill that updates without anyone refreshing
  // the channel — and <t:UNIX:t> shows local time per viewer. This is
  // the cross-platform glue: the post is *better* in Discord than a
  // plain text version could be.
  const startInfo = decodeStart(lobby && lobby.note);
  let startLine = "";
  if (startInfo.plannedAt instanceof Date && !isNaN(startInfo.plannedAt.getTime())) {
    const unix = Math.floor(startInfo.plannedAt.getTime() / 1000);
    startLine = `Starts <t:${unix}:R> (<t:${unix}:t> your time)`;
  } else if (startInfo.isWhenFull) {
    startLine = `Starts the moment we fill — claim a seat fast.`;
  }
  return [
    `STS2 ${lobbyModeLabel(lobby)} · ${goalLabel(lobby.goal)} · ${ascensionLabel(lobby.ascensionMin, lobby.ascensionMax)} · ${members.length}/${cap} · Need +${need}`,
    `Host: ${lobby.hostPersonaName || "Host"}`,
    `Voice: ${voiceLabel}${voiceUrl}`,
    startLine,
    `Join on SpireVault: ${ROOM_JOIN_BASE}${lobby.lobbyId}`,
  ].filter(Boolean).join("\n");
}
function openSeats(lobby) {
  return Math.max(0, lobbySizeOf(lobby) - lobbyMembers(lobby).length);
}

const STATE_POLL_MS = 15_000;
const STATE_POLL_HIDDEN_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_HIDDEN_MS = 5 * 60_000;
const STALE_AFTER_MS = 90_000;

let bootCtx = null;
let lastState = null;
let pollTimer = null;
let heartbeatTimer = null;
let ageTickerTimer = null;
let isMounted = false;
let pendingActions = new Set();

// =========================================================================
// Quick-host module state
// -------------------------------------------------------------------------
// One-click host: skips the full form modal and POSTs /coop/lobbies with
// permissive defaults so the time-to-first-lobby drops from "fill a form"
// to "click one button." All form-aware paths (Advanced disclosure,
// modal-driven "+ Host a Room" buttons) keep working bit-for-bit; this is
// strictly an additional path with its own state-aware label.
// =========================================================================
let quickHostBusy = false;
let quickHostRateLimitUntil = 0;
let quickHostCountdownTimer = null;
let quickHostMountedAt = 0;

/** Wide-open one-click host defaults. Tuned to be the most permissive
 *  permutation the worker accepts without rejecting on validation. The
 *  selected character is intentionally omitted so the host can pick at
 *  Party Hub time; preferredCharacters is left empty (all welcome). */
const QUICK_HOST_DEFAULTS = Object.freeze({
  title: "Open co-op room",
  goal: "any",
  lobbySize: 4,
  ascensionMin: 0,
  ascensionMax: 20,
  voicePreference: "optional",
  voicePreset: "any",
  approvalRequired: false,
  preferredCharacters: [],
  note: "",
  discordHandle: undefined,
});

function quickHostTimeoutMs() { return 8000; }

// Tracks the active session id we last rendered. When this is set
// and the next render reveals the session is gone, we infer the
// partner ended the pairing and surface a one-line toast so the
// activity card doesn't silently flip to Idle. Self-initiated ends
// suppress the toast via `localEndPairingPending`.
let lastKnownActiveSessionId = null;
let localEndPairingPending = false;

// Client-side filter / sort / density state (no backend involvement)
const CARDS_PAGE = 12;
let lobbyFilters = { goal: "", asc: "", voice: "" };
let lobbySort = "best";
let lobbyCompact = (() => { try { return localStorage.getItem("coop_compact") === "1"; } catch { return false; } })();
let lobbiesVisible = CARDS_PAGE;
let recsVisible = CARDS_PAGE;
// Free-text search across lobby title/host/note/discord and across Best
// Matches persona/note. Pure client filter — never hits the network so it
// stays snappy even when capped server payloads land 200+ rows.
let lobbySearchQuery = "";
let recsSearchQuery = "";
let filtersExpanded = false;

const SANDBOX_STEAM_TOAST = "Sandbox user — no real Steam profile.";

function sandboxSteamToast() {
  bootCtx?.deps?.toast?.(SANDBOX_STEAM_TOAST);
}

function lobbyModeLabel(lobby) {
  const m = lobby?.mode || "standard";
  return { standard: "Standard", daily: "Daily", custom: "Custom" }[m] || m;
}

function renderLobbySeatRow(lobby, party) {
  const cap = lobbySizeOf(lobby);
  const members = lobbyMembers(lobby);
  const hostUrl = lobby.hostAvatarUrl || "/assets/vault-mark.svg";
  // Build a steamId -> party-member lookup. The lobby payload only carries
  // steamIds for accepted members; the personaName / avatarUrl that the
  // seat row wants live on the party object. Before this enhancement the
  // host had no way to tell who joined without opening the Party Hub —
  // the row was anonymous filled circles.
  const partyById = new Map();
  if (party?.members?.length) {
    for (const m of party.members) {
      if (m?.steamId) partyById.set(m.steamId, m);
    }
  }
  const renderSeat = (sid, isHost) => {
    if (isHost) {
      return `<span class="coop-seat-slot coop-seat-slot--filled" title="${esc(lobby.hostPersonaName || "Host")}"><img src="${esc(hostUrl)}" alt="" /></span>`;
    }
    const m = partyById.get(sid);
    if (m && (m.avatarUrl || m.personaName)) {
      const title = m.personaName || "Joined";
      const img = m.avatarUrl
        ? `<img src="${esc(m.avatarUrl)}" alt="" />`
        : `<span class="coop-seat-slot-initial" aria-hidden="true">${esc((m.personaName || "?").charAt(0).toUpperCase())}</span>`;
      return `<span class="coop-seat-slot coop-seat-slot--filled coop-seat-slot--guest" title="${esc(title)}">${img}</span>`;
    }
    return '<span class="coop-seat-slot coop-seat-slot--filled coop-seat-slot--guest" aria-label="Filled seat"></span>';
  };
  const slots = [renderSeat(lobby.hostSteamId, true)];
  for (const sid of members.filter((s) => s !== lobby.hostSteamId)) {
    slots.push(renderSeat(sid, false));
  }
  const empty = Math.max(0, cap - members.length);
  for (let i = 0; i < empty; i++) {
    slots.push('<span class="coop-seat-slot coop-seat-slot--empty" aria-hidden="true"></span>');
  }
  const need = openSeats(lobby);
  const joinerNames = members
    .filter((s) => s !== lobby.hostSteamId)
    .map((s) => partyById.get(s)?.personaName)
    .filter(Boolean);
  const withSummary = joinerNames.length
    ? ` · with ${joinerNames.map(esc).join(", ")}`
    : "";
  return `
    <div class="coop-seat-row">
      <div class="coop-seat-slots">${slots.join("")}</div>
      <span class="coop-seat-summary">${members.length}/${cap} seats${need > 0 ? ` · Need +${need}` : ""}${withSummary}</span>
    </div>`;
}

function renderCharacterStrip(chars, opts = {}) {
  const selected = new Set((chars || []).map(normalizeCharacterId).filter(Boolean));
  const occupied = new Set((opts.occupied || []).map(normalizeCharacterId).filter(Boolean));
  const openAny = selected.size === 0;
  const label = opts.label || (openAny ? "Open to any character" : `Host prefers ${Array.from(selected).map(characterLabel).join(", ")}`);
  const tokens = COOP_CHARACTERS.map((c) => {
    const isSelected = selected.has(c.id);
    const isOccupied = occupied.has(c.id);
    const cls = [
      "coop-character-token",
      isSelected ? "is-selected" : "",
      !openAny && !isSelected ? "is-muted" : "",
      isOccupied ? "is-occupied" : "",
    ].filter(Boolean).join(" ");
    const title = isOccupied
      ? `${c.label} already claimed`
      : openAny
        ? `${c.label} available`
        : isSelected
          ? `${c.label} preferred`
          : `${c.label} not preferred`;
    return `
      <span class="${cls}" title="${esc(title)}">
        <img src="${esc(characterAssetSrc(c.id))}" alt="" loading="lazy" />
        <span class="coop-character-token-label">${esc(c.label)}</span>
      </span>`;
  }).join("");
  return `
    <div class="coop-character-strip-wrap">
      <span class="coop-character-strip-label">${esc(label)}</span>
      <div class="coop-character-strip" aria-label="${esc(label)}">${tokens}</div>
    </div>`;
}

function findLobbyById(state, lobbyId) {
  if (state.lobby?.lobbyId === lobbyId) return state.lobby;
  return (state.openLobbies || []).find((l) => l.lobbyId === lobbyId) || null;
}

/**
 * Resolve the dominant co-op UX state for the beta lobby surface.
 * Returns `{ state, data }` where `state` is one of:
 * idle | browsing | requested_seat | hosting_lobby | incoming_request |
 * in_party | in_sts2_lobby | in_run | away
 */
export function resolveCoopUxState(state, mySid) {
  const me = state?.presence;
  const sid = mySid || me?.steamId;
  const party = state?.party?.status === "active" ? state.party : null;
  const lobby =
    state?.lobby && state.lobby.status !== "closed" && state.lobby.status !== "expired"
      ? state.lobby
      : null;
  const session = state?.session?.status === "active" ? state.session : null;
  const incomingJoinReqs = state?.incomingJoinRequests || [];
  const outgoingJoinReqs = (state?.outgoingJoinRequests || []).filter((r) => r.status === "pending");

  if (me?.status === "afk") {
    return { state: "away", data: { presence: me } };
  }

  const partyInGame = party?.members?.some((m) => m.steamId === sid && m.status === "in_game");
  if (me?.status === "solo" || partyInGame) {
    return { state: "in_run", data: { party, presence: me } };
  }

  const partyInSts2 = party?.members?.some((m) => m.steamId === sid && m.status === "character_select");
  if (partyInSts2) {
    return { state: "in_sts2_lobby", data: { party, lobby } };
  }

  if (party) {
    return { state: "in_party", data: { party, lobby } };
  }

  if (lobby && lobby.hostSteamId === sid) {
    if (incomingJoinReqs.length > 0) {
      return { state: "incoming_request", data: { lobby, incomingJoinReqs, session } };
    }
    return { state: "hosting_lobby", data: { lobby, session } };
  }

  if (outgoingJoinReqs.length > 0) {
    const req = outgoingJoinReqs[0];
    return {
      state: "requested_seat",
      data: { request: req, lobby: findLobbyById(state, req.lobbyId), session },
    };
  }

  if (session) {
    const partnerSid = (session.playerSteamIds || []).find((id) => id !== sid);
    const partner = (state.activePlayerFeed || []).find((p) => p.steamId === partnerSid);
    return { state: "browsing", data: { session, partner } };
  }

  return { state: "idle", data: {} };
}

function coopUxFromState(s) {
  return resolveCoopUxState(s, s?.presence?.steamId);
}

function partyStatusLine(party, meSid) {
  const me = party?.members?.find((m) => m.steamId === meSid);
  const st = me?.status || "joined";
  const map = {
    joined: "Waiting for host",
    ready: "Ready",
    character_select: "In STS2 Lobby",
    in_game: "In Run",
    left: "Left",
  };
  return map[st] || st;
}

// =========================================================================
// Public API
// =========================================================================
export function mountCoopLobbies(ctx) {
  bootCtx = ctx;
  if (isMounted) return;
  isMounted = true;
  // Bridge the state-aware quick-host pipeline to party-finder-scene.js
  // so the existing pf-stage "Quick Play" button can drive the same
  // sign-in / reopen / leave-and-host / one-click POST behaviour the
  // v194 orange hero used to. The orange hero DOM is gone in v195 but
  // the underlying logic still lives in this module.
  if (typeof window !== "undefined") {
    window.__coopQuickHost = Object.freeze({
      run: runQuickHost,
      resolveMode: getQuickHostMode,
      getStatus: getQuickHostStatus,
    });
  }
  mountShowtimeStrip();
  wireDelegatedClicks();
  wireModalCloseHandlers();
  wireIntentForm();
  wireLobbyForm();
  wireQuickMatchModal();
  wireCharacterModal();
  wireFeedToggle();
  wireHowToToggle();
  wireFilterBar();
  // The visible status pills also fire savePresence (Looking / AFK toggle).
  document.querySelectorAll('#status-pills input[name="status"]').forEach((el) => {
    el.addEventListener("change", () => void savePresence({ silent: true }));
  });
  void refreshState({ force: true });
  scheduleNextPoll();
  scheduleNextHeartbeat();
  scheduleAgeTicker();
  document.addEventListener("visibilitychange", onVisibilityChange);
  ensureCoopSandboxMounted({
    ...ctx,
    onReseed: () => void refreshState({ force: true }),
  });
}

export function setCoopTabActive() {
  ensureCoopSandboxMounted({
    ...bootCtx,
    onReseed: () => void refreshState({ force: true }),
  });
  void refreshState({ force: true });
}

// =========================================================================
// Showtime / Coach discoverability strip
// =========================================================================
// Four tiles linking out to the standalone Showtime surfaces (/watch,
// /race, /tournaments, /coach). Mounted once at the top of
// #coop-page-root so signed-in users browsing the Co-op tab can find
// the new pages without us having to redesign the side nav. The strip
// is the cold-start liquidity fix for /watch and /race — empty live-run
// + ghost lists go away once players actually share runs, but nobody
// shares unless they know these surfaces exist.
//
// The Companion mod is intentionally NOT advertised here. It is a
// future, optional power-user upgrade (see /companion-mod) and every
// Showtime surface must deliver value to a tier-1 web visitor (no
// download, screenshot + .run drop + Steam OAuth) without it.
//
// Tile config is intentionally co-located here (not pulled from a
// JSON) — four hard-coded entries, no fancy data layer, no I/O.
// =========================================================================
const SHOWTIME_TILES = Object.freeze([
  {
    href: "/watch",
    title: "Replays",
    sub: "Recent shared runs",
    track: "showtime_strip_watch",
    iconPath: "M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z",
  },
  {
    href: "/race",
    title: "Race",
    sub: "Today's daily ghosts",
    track: "showtime_strip_race",
    iconPath: "M5 3v18l7-4 7 4V3H5zm2 2h10v12.4l-5-2.86-5 2.86V5z",
  },
  {
    href: "/tournaments",
    title: "Tournaments",
    sub: "Bracket events",
    track: "showtime_strip_tournaments",
    iconPath: "M7 4h10v2h3v3a4 4 0 01-4 4h-.34A5 5 0 0113 15.9V18h3v3H8v-3h3v-2.1A5 5 0 017.34 13H7a4 4 0 01-4-4V6h4V4zm0 4H5v1a2 2 0 002 2V8zm10 0v3a2 2 0 002-2V8h-2z",
  },
  {
    href: "/coach",
    title: "Coach",
    sub: "Drop a screenshot, get a read",
    track: "showtime_strip_coach",
    iconPath: "M12 3a4 4 0 014 4v1a4 4 0 11-8 0V7a4 4 0 014-4zm-7 18v-1.5a5 5 0 015-5h4a5 5 0 015 5V21H5z",
  },
]);

function buildShowtimeStripMarkup() {
  const tiles = SHOWTIME_TILES.map((t) => {
    const featured = t.featured ? " coop-showtime-tile--featured" : "";
    const badge = t.badge
      ? `<span class="coop-showtime-badge">${t.badge}</span>`
      : "";
    return `
      <a class="coop-showtime-tile${featured}" href="${t.href}" data-coop-showtime="${t.track}">
        <span class="coop-showtime-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="${t.iconPath}"/></svg>
        </span>
        <span class="coop-showtime-text">
          <span class="coop-showtime-title">${t.title}${badge}</span>
          <span class="coop-showtime-sub">${t.sub}</span>
        </span>
        <span class="coop-showtime-arrow" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
        </span>
      </a>`;
  }).join("");
  return `
    <section class="coop-showtime-strip" aria-label="Showtime · Replays, Race, Tournaments, Coach">
      <header class="coop-showtime-head">
        <span class="coop-showtime-eyebrow">SpireVault Showtime</span>
        <span class="coop-showtime-helper">Replays, daily race, brackets, and the AI Coach — all from the browser.</span>
      </header>
      <div class="coop-showtime-grid">
        ${tiles}
      </div>
    </section>`;
}

function mountShowtimeStrip() {
  // Idempotent: bail if it's already in the DOM.
  if (document.getElementById("coop-showtime-strip")) return;
  const $root = document.getElementById("coop-page-root");
  if (!$root) return;
  const wrap = document.createElement("div");
  wrap.id = "coop-showtime-strip";
  wrap.innerHTML = buildShowtimeStripMarkup();
  // Mount as the first child so it sits above the discovery banner,
  // command bar, and the workspace — exactly where the spec asks.
  $root.insertBefore(wrap, $root.firstChild);
  // GA: emit a single click event per tile so we can see which Showtime
  // surface drove the most cross-tab navigation.
  wrap.addEventListener("click", (e) => {
    const tile = e.target instanceof Element ? e.target.closest("[data-coop-showtime]") : null;
    if (!tile) return;
    try {
      if (typeof window.gtag === "function") {
        window.gtag("event", tile.getAttribute("data-coop-showtime"), {
          event_category: "showtime_strip",
        });
      }
    } catch { /* analytics never blocks navigation */ }
  });
}

// =========================================================================
// Quick-host helpers — state-aware "host a room now" pipeline.
// -------------------------------------------------------------------------
// v195 collapsed the duplicate orange hero into the existing pf-stage
// Quick Play button. The DOM hero was deleted (markup, CSS, mount call)
// but the underlying state-aware logic — Sign in to host / Reopen your
// lobby / Leave current party to host / one-click POST /coop/lobbies
// with permissive defaults — is preserved here so party-finder-scene.js
// can drive it via window.__coopQuickHost when the Quick Play button
// resolves to a hosting-shaped UX mode.
// =========================================================================

/** Resolve the current quick-host UX mode from state.
 *  Returns one of: "default" | "signed_out" | "hosting" | "in_other_party". */
function resolveQuickHostMode(state) {
  if (!bootCtx?.session?.steamID) return "signed_out";
  const sid = state?.presence?.steamId || bootCtx.session.steamID;
  const lobby = state?.lobby;
  if (
    lobby &&
    lobby.hostSteamId === sid &&
    lobby.status === "open"
  ) {
    return "hosting";
  }
  const party = state?.party;
  if (party && party.status === "active" && party.hostSteamId && party.hostSteamId !== sid) {
    return "in_other_party";
  }
  return "default";
}

function setQuickHostBusy(busy, labelText) {
  quickHostBusy = !!busy;
  // The orange hero was removed in v195; the Quick Play button in
  // party-finder-scene.js drives its own busy visuals via the public
  // window.__coopQuickHost.onBusyChange hook below. We just stash the
  // label here so the hook payload can mirror it.
  const payload = { busy: !!busy, labelText: labelText || "" };
  try {
    if (typeof window !== "undefined" && typeof window.__coopQuickHostBusyHook === "function") {
      window.__coopQuickHostBusyHook(payload);
    }
  } catch { /* hook never blocks */ }
}

function fireQuickHostTelemetry(name, payload) {
  try {
    if (typeof window === "undefined") return;
    if (typeof window.gtag !== "function") return;
    window.gtag("event", name, { event_category: "coop_quick_host", ...(payload || {}) });
  } catch { /* analytics never blocks the UI */ }
}

function startQuickHostRateLimitCountdown(seconds) {
  quickHostRateLimitUntil = Date.now() + Math.max(1, seconds) * 1000;
  if (quickHostCountdownTimer) clearInterval(quickHostCountdownTimer);
  quickHostCountdownTimer = setInterval(() => {
    if (Date.now() >= quickHostRateLimitUntil) {
      clearInterval(quickHostCountdownTimer);
      quickHostCountdownTimer = null;
      quickHostRateLimitUntil = 0;
    }
    notifyQuickHostBusyHook();
  }, 1000);
  notifyQuickHostBusyHook();
}

/** Push a rate-limit / busy snapshot to scene.js so the Quick Play button
 *  in the pf-stage hero can paint a "Try again in Ns" label without
 *  importing module-private state. Safe no-op when the hook isn't wired. */
function notifyQuickHostBusyHook() {
  try {
    if (typeof window === "undefined") return;
    if (typeof window.__coopQuickHostBusyHook !== "function") return;
    window.__coopQuickHostBusyHook({
      busy: quickHostBusy,
      rateLimitedUntil: quickHostRateLimitUntil,
    });
  } catch { /* hook never blocks */ }
}

/** Public state snapshot for the pf-stage Quick Play button. */
export function getQuickHostStatus() {
  return {
    busy: quickHostBusy,
    rateLimitedUntil: quickHostRateLimitUntil,
    rateLimitedSecondsLeft: quickHostRateLimitUntil > Date.now()
      ? Math.ceil((quickHostRateLimitUntil - Date.now()) / 1000)
      : 0,
  };
}

/** Pure function — resolve the hosting-shaped UX mode for the current
 *  state snapshot. Exposed for party-finder-scene.js so the Quick Play
 *  button can pick the right label and click handler. */
export function getQuickHostMode(state) {
  return resolveQuickHostMode(state || lastState || {});
}

/** Public entry point — runs the same state-aware quick-host pipeline
 *  the deleted orange hero button used to drive (sign-in / scroll-to-
 *  existing-lobby / leave-and-host / one-click POST /coop/lobbies). The
 *  Quick Play button in pf-stage calls this for non-default modes.
 *
 *  Returns a Promise that resolves to a discriminated result so callers
 *  (specifically the v197 one-tap mega CTA in party-finder-scene.js) can
 *  decide whether to fall back to the multi-step Host modal when the
 *  underlying POST fails. The result shape is:
 *    { ok: true,  action: "created",         lobbyId }
 *    { ok: true,  action: "signin_handoff" } (user routed to Steam sign-in)
 *    { ok: true,  action: "hosting_scroll" } (already hosting → highlight)
 *    { ok: false, action: "create_failed",   error, status }
 *    { ok: false, action: "leave_canceled" } (user dismissed confirm)
 *    { ok: false, action: "leave_failed",    error }
 *  Only `create_failed` should trigger the Host-modal fallback in the
 *  scene — the other branches have already navigated the user somewhere
 *  useful or surfaced their own toast. */
export function runQuickHost() {
  return handleQuickHostClick();
}

/** Lightweight modal-style confirm. The existing `window.confirm` is what
 *  every other coop confirm uses, but the spec asks for an on-brand
 *  modal here. Built ad-hoc so we don't have to thread a new HTML
 *  template into index.html for one prompt. */
function quickHostConfirm({ title, body, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const $backdrop = document.createElement("div");
    $backdrop.className = "modal-backdrop coop-modal-backdrop coop-quick-host-confirm-backdrop";
    $backdrop.setAttribute("role", "dialog");
    $backdrop.setAttribute("aria-modal", "true");
    $backdrop.setAttribute("aria-label", title || "Confirm");
    $backdrop.innerHTML = `
      <div class="modal coop-modal coop-quick-host-confirm" role="document">
        <header class="modal-head">
          <h2>${esc(title || "Confirm")}</h2>
        </header>
        <div class="modal-body coop-modal-body">
          <p class="coop-quick-host-confirm-body">${esc(body || "")}</p>
          <div class="coop-form-actions">
            <button type="button" class="btn-primary" data-quick-host-confirm-ok>${esc(confirmLabel || "Confirm")}</button>
            <button type="button" class="btn-ghost" data-quick-host-confirm-cancel>${esc(cancelLabel || "Cancel")}</button>
          </div>
        </div>
      </div>`;
    const cleanup = (result) => {
      document.removeEventListener("keydown", onKey);
      $backdrop.remove();
      // Restore body scroll if no other coop modal is open. Same logic
      // as closeModal — modal-backdrop on the stack means we keep it
      // locked; otherwise unlock.
      const anyOpen = document.querySelectorAll(".modal-backdrop:not([hidden])").length;
      if (!anyOpen) document.body.style.overflow = "";
      resolve(result);
    };
    const onKey = (e) => { if (e.key === "Escape") cleanup(false); };
    $backdrop.addEventListener("click", (e) => {
      if (e.target === $backdrop) { cleanup(false); return; }
      if (e.target.closest("[data-quick-host-confirm-ok]")) { cleanup(true); return; }
      if (e.target.closest("[data-quick-host-confirm-cancel]")) { cleanup(false); return; }
    });
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    document.body.appendChild($backdrop);
    setTimeout(() => $backdrop.querySelector("[data-quick-host-confirm-ok]")?.focus?.(), 30);
  });
}

/** Scroll-and-highlight the user's existing lobby card. Reuses the same
 *  CSS class (`.coop-lobby-card--highlight`) and timeout the URL-based
 *  deep link uses, so the visual feels identical. */
function scrollHighlightMyLobby(lobbyId) {
  if (!lobbyId) return;
  // Defer one frame so any pending re-render finishes first.
  requestAnimationFrame(() => {
    const card = document.querySelector(`[data-lobby-id="${lobbyId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("coop-lobby-card--highlight");
    setTimeout(() => card.classList.remove("coop-lobby-card--highlight"), 3200);
  });
}

async function handleQuickHostClick() {
  fireQuickHostTelemetry("lobby_quick_host_click", {
    mode: resolveQuickHostMode(lastState || {}),
    since_mount_ms: quickHostMountedAt ? Date.now() - quickHostMountedAt : undefined,
  });

  const mode = resolveQuickHostMode(lastState || {});

  if (mode === "signed_out") {
    // Hand off to the global signin-cta delegated handler in script.js.
    // We just synthesize the click since the handler reads the closest
    // `[data-action="signin-cta"]` ancestor.
    try {
      const startFn = typeof window !== "undefined" ? window.startSteamSignIn : null;
      if (typeof startFn === "function") { startFn(); return { ok: true, action: "signin_handoff" }; }
    } catch { /* fall through */ }
    // Fallback: dispatch a synthetic signin-cta click event.
    const synthetic = document.createElement("button");
    synthetic.setAttribute("data-action", "signin-cta");
    synthetic.style.display = "none";
    document.body.appendChild(synthetic);
    synthetic.click();
    synthetic.remove();
    return { ok: true, action: "signin_handoff" };
  }

  if (mode === "hosting") {
    const lobbyId = lastState?.lobby?.lobbyId;
    scrollHighlightMyLobby(lobbyId);
    bootCtx?.deps?.toast?.("Your room is open \u2014 jumping to it.");
    return { ok: true, action: "hosting_scroll", lobbyId };
  }

  if (mode === "in_other_party") {
    const partyId = lastState?.party?.partyId;
    if (!partyId) {
      bootCtx?.deps?.toast?.("Couldn't find the party to leave.");
      return { ok: false, action: "leave_failed", error: "no_party_id" };
    }
    const ok = await quickHostConfirm({
      title: "Leave the current party?",
      body: "You're in another player's party right now. Leaving will drop your seat, then SpireVault opens a brand new room with you as the host.",
      confirmLabel: "Leave and host new room",
      cancelLabel: "Stay in this party",
    });
    if (!ok) return { ok: false, action: "leave_canceled" };
    // Best-effort leave, then create. If leave fails surface its error
    // and don't auto-host (better than ghosting the host).
    setQuickHostBusy(true, "Leaving party\u2026");
    try {
      const leaveResp = await jsonFetch(`/coop/parties/${partyId}/leave`, { body: {} });
      if (!leaveResp.ok) {
        bootCtx?.deps?.toast?.(leaveResp.message || "Couldn't leave the party.");
        return { ok: false, action: "leave_failed", error: leaveResp.error || "leave_http_error" };
      }
    } finally {
      setQuickHostBusy(false);
    }
    await refreshState({ force: true });
    // Fall through to default-mode create flow.
  }

  return await performQuickHostCreate();
}

async function performQuickHostCreate() {
  if (quickHostBusy) return { ok: false, action: "create_failed", error: "busy", status: 0 };
  if (quickHostRateLimitUntil > Date.now()) {
    const secs = Math.ceil((quickHostRateLimitUntil - Date.now()) / 1000);
    bootCtx?.deps?.toast?.(`Hosting too fast \u2014 try again in ${secs}s.`);
    return { ok: false, action: "create_failed", error: "rate_limited", status: 429 };
  }
  const startedAt = Date.now();
  setQuickHostBusy(true, "Creating room\u2026");

  // Race the fetch against an 8s timeout so a stuck worker never wedges
  // the button forever. We rely on jsonFetch returning a structured
  // error on network failure but it doesn't time out by itself.
  let timeoutHandle = null;
  const timeoutP = new Promise((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ ok: false, status: 0, error: "timeout", message: "Couldn't create the room \u2014 try again." }),
      quickHostTimeoutMs(),
    );
  });
  const fetchP = jsonFetch("/coop/lobbies", { body: { ...QUICK_HOST_DEFAULTS } });

  let r;
  try {
    r = await Promise.race([fetchP, timeoutP]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  setQuickHostBusy(false);

  if (!r || !r.ok) {
    const elapsedMs = Date.now() - startedAt;
    const status = r?.status ?? 0;
    const errorCode = r?.error || "unknown";
    fireQuickHostTelemetry("lobby_quick_host_error", {
      error_code: errorCode,
      http_status: status,
      elapsed_ms: elapsedMs,
    });

    if (status === 429) {
      startQuickHostRateLimitCountdown(30);
      bootCtx?.deps?.toast?.("You're hosting too fast \u2014 try again in 30 seconds.");
      return { ok: false, action: "create_failed", error: errorCode, status };
    }
    if (errorCode === "timeout") {
      bootCtx?.deps?.toast?.("Couldn't create the room \u2014 try again.");
      return { ok: false, action: "create_failed", error: errorCode, status };
    }
    if (status === 400 && r.message) {
      // Worker tells us which field failed; surface that directly.
      bootCtx?.deps?.toast?.(r.message);
      return { ok: false, action: "create_failed", error: errorCode, status };
    }
    bootCtx?.deps?.toast?.(r.message || "Couldn't create the room \u2014 try again.");
    return { ok: false, action: "create_failed", error: errorCode, status };
  }

  const elapsedMs = Date.now() - startedAt;
  const lobbyId = r.lobbyId || r.lobby?.lobbyId;
  fireQuickHostTelemetry("lobby_quick_host_success", {
    lobby_id: lobbyId || "",
    elapsed_ms: elapsedMs,
  });
  bootCtx?.deps?.toast?.("Room created \u2014 you're hosting.");
  await refreshState({ force: true });
  // After refresh the new lobby card is rendered; scroll + highlight so
  // the host sees exactly which card is theirs and that joiners can
  // request a seat now.
  scrollHighlightMyLobby(lobbyId || lastState?.lobby?.lobbyId);
  return { ok: true, action: "created", lobbyId: lobbyId || lastState?.lobby?.lobbyId || "" };
}

export function getLastState() { return lastState; }

// =========================================================================
// Networking
// =========================================================================
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
  catch (err) { return { ok: false, status: 0, error: "network", message: String(err?.message || err) }; }
  let data; try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: data?.error || "http_error",
      message: humanizeError(data?.error || data?.message || `HTTP ${resp.status}`),
    };
  }
  return { ok: true, status: resp.status, ...data };
}

function humanizeError(code) {
  if (!code || typeof code !== "string") return "Something went wrong.";
  const map = {
    rate_limited: "You're moving too fast. Try again in a few seconds.",
    already_in_lobby: "You're already in a lobby. Close it before creating another.",
    already_paired: "You're already paired with someone.",
    lobby_full: "That lobby just filled up.",
    lobby_not_found: "That lobby is gone.",
    invite_not_found: "That invite expired or was cancelled.",
    recipient_offline: "That player just went offline.",
    not_authorized: "You can't do that.",
    invalid_input: "Some of those fields aren't valid.",
    invalid_character: "Pick a valid character.",
    character_claimed: "That character is already claimed.",
    decline_cooldown: "You declined this player recently — give it a bit.",
    network: "Network error. Check your connection.",
  };
  return map[code] || code.replaceAll("_", " ");
}

// Consecutive /coop/state failure count. After 2 in a row we mark the
// page as "reconnecting" so the UI can surface a small banner instead
// of pretending everything's fine. Reset on the first success.
let consecutiveStateFailures = 0;

function setNetworkBanner(state) {
  // state: "online" | "reconnecting" | "offline"
  try {
    document.documentElement.dataset.pfNet = state;
    // Lazy-create the banner. One element, one DOM mutation, idempotent.
    let bar = document.getElementById("pf-net-banner");
    if (state === "online") {
      if (bar) bar.hidden = true;
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "pf-net-banner";
      bar.className = "pf-net-banner";
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      // NOTE: the Retry button uses a directly-bound listener instead
      // of a data-action attribute. Earlier builds shipped this with
      // `data-pf-action="net-retry"`, whose handler lived in
      // party-finder.js — fine when party-finder.js mounted on every
      // host, but party-finder.js is now sandbox-only (see
      // coop-sandbox.js#ensureCoopSandboxMounted) so production was
      // left with an inert Retry button on every network blip. The
      // direct listener removes that coupling entirely.
      bar.innerHTML =
        '<span class="pf-net-banner-dot" aria-hidden="true"></span>' +
        '<span class="pf-net-banner-text" data-pf-net-text>Reconnecting&hellip;</span>' +
        '<button type="button" class="pf-net-banner-retry" data-coop-action="net-retry">Retry now</button>';
      bar.querySelector(".pf-net-banner-retry")?.addEventListener("click", () => {
        void refreshState({ force: true });
      });
      // Pin to top of the Co-op tab so it never overlaps modals.
      const host = document.getElementById("coop-lobby-beta-root") || document.body;
      host.insertBefore(bar, host.firstChild);
    }
    bar.hidden = false;
    bar.dataset.tone = state;
    const t = bar.querySelector("[data-pf-net-text]");
    if (t) {
      t.textContent = state === "offline"
        ? "Can't reach the server. Your stats may be stale."
        : "Reconnecting\u2026";
    }
  } catch { /* best-effort */ }
}

async function refreshState({ force = false } = {}) {
  if (!bootCtx?.session?.steamID) return;
  const r = await jsonFetch("/coop/state");
  if (!r.ok) {
    if (r.status === 401) { bootCtx.deps?.onAuthFailure?.(); return; }
    consecutiveStateFailures += 1;
    // First failure: silent (could be a transient blip). Second+:
    // surface "Reconnecting…". Five+: "offline" copy so the user
    // knows their stats may be stale instead of feeling broken.
    if (consecutiveStateFailures >= 5)      setNetworkBanner("offline");
    else if (consecutiveStateFailures >= 2) setNetworkBanner("reconnecting");
    return;
  }
  consecutiveStateFailures = 0;
  setNetworkBanner("online");
  // Compare against the previous snapshot to fire a "Foo joined your
  // room" toast for the host. Until this, the host had to keep
  // watching the seat row to notice somebody arrived — no toast, no
  // audio, no badge. We diff member IDs on the host's own party,
  // de-dup against the previous render, and skip the very first
  // refresh after mount to avoid a spurious "joined" toast for
  // people who were already in the room when the page loaded.
  try {
    const prev = lastState;
    const mySid = bootCtx?.session?.steamID;
    const prevParty = prev?.party;
    const nextParty = r?.party;
    if (
      prev &&
      mySid &&
      nextParty?.status === "active" &&
      nextParty.hostSteamId === mySid &&
      Array.isArray(nextParty.members)
    ) {
      const prevIds = new Set(
        (prevParty?.status === "active" ? prevParty.members : [])
          .filter((m) => m && m.status !== "left")
          .map((m) => m.steamId),
      );
      const arrivals = nextParty.members
        .filter((m) => m && m.status !== "left" && m.steamId !== mySid && !prevIds.has(m.steamId));
      for (const a of arrivals) {
        const name = a.personaName || "A new player";
        bootCtx?.deps?.toast?.(`${name} joined your room.`);
      }
    }
  } catch { /* best-effort */ }
  lastState = r;
  // Honor a server-pushed Beta kill flag the moment we see it. The
  // backend can drop `flags.coopLobbyBetaKill = true` (or
  // `flags.coopLobbyBeta = false`) into any /coop/state response and
  // the next render swaps users back to Classic without a deploy.
  try {
    if (typeof window.__VAULT_COOP_BETA_APPLY_SERVER_FLAG === "function") {
      window.__VAULT_COOP_BETA_APPLY_SERVER_FLAG(r);
    }
  } catch { /* best-effort */ }
  render(lastState);
  bootCtx.deps?.onStateRefresh?.(lastState);
}

async function sendHeartbeat() {
  if (!bootCtx?.session?.steamID) return;
  const r = await jsonFetch("/coop/heartbeat", { body: {} });
  if (!r.ok && r.status === 401) { bootCtx.deps?.onAuthFailure?.(); return; }
  // Honor server-side status override (Steam offline → "afk", entered STS2
  // while "looking" → "solo", left STS2 after auto-solo → "looking").
  if (r.ok && r.forceStatus) {
    const currentStatus = document.querySelector('input[name="status"]:checked')?.value;
    if (r.forceStatus !== currentStatus) {
      setRadioAndFire("status", r.forceStatus);
    }
  }
}

function scheduleNextPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const ms = document.visibilityState === "hidden" ? STATE_POLL_HIDDEN_MS : STATE_POLL_MS;
  pollTimer = setTimeout(async () => { await refreshState(); scheduleNextPoll(); }, ms);
}
function scheduleNextHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const ms = document.visibilityState === "hidden" ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_MS;
  heartbeatTimer = setTimeout(async () => { await sendHeartbeat(); scheduleNextHeartbeat(); }, ms);
}
function scheduleAgeTicker() {
  if (ageTickerTimer) clearInterval(ageTickerTimer);
  // Tick visible "last seen" / "expires in" labels every 20s without
  // hitting the network.
  ageTickerTimer = setInterval(() => {
    if (lastState) renderAgeLabels(lastState);
  }, 20_000);
}
function onVisibilityChange() {
  scheduleNextPoll();
  scheduleNextHeartbeat();
  if (document.visibilityState === "visible") void refreshState({ force: true });
}

// =========================================================================
// Mutate-in-place reconciliation helpers (v202+ poll-jank fix)
// -------------------------------------------------------------------------
// Before this, every state poll (5–15s cadence) called $list.innerHTML =
// renderAll() on the lobby list, the recommendations list, the invites
// list, the primary state card, the activity card, and the side intent
// card. Each innerHTML write detaches/reattaches the entire subtree,
// triggering reflow + repaint of every card AND firing
// party-finder-reputation-rt.js's global body MutationObserver — which
// then ran autoAnnotateProdSurface(document) + scan(document) on every
// poll. The user saw the page "jump" / "feel laggy" every poll cycle
// even when no underlying lobby data changed.
//
// The fix is to mutate in place. For each $list we render to, we now:
//   • Compute an array of "blocks" with stable `key` + content `fp` strings.
//   • Reconcile against existing $list children: skip blocks whose fp
//     matches (zero DOM ops), replace inner HTML in blocks whose fp
//     differs (root <article> stays, only inner subtree reflows),
//     create new blocks not yet in DOM, remove dropped blocks.
//   • Reorder by walking $list.children once.
//
// Net effect: when a poll lands and nothing changed, the lobby cards keep
// their exact DOM nodes — no reflow, no MutationObserver firestorm, no
// jump. Decorations injected by party-finder-scene.js (match score ring,
// host run strip) and party-finder-reputation-rt.js (LevelBadge popover
// trigger) survive intact across polls, eliminating the flash they used
// to do every cycle.
// =========================================================================

/**
 * Apply a list of {key, fp, render} blocks to $list, preserving existing
 * DOM nodes whose fp matches and only swapping inner HTML on the ones
 * that genuinely changed. `key` must be unique per block; `fp` is the
 * fingerprint string that detects "actual" changes.
 *
 * Blocks may also provide `update(node)` instead of `render()` for
 * fully manual mutation paths — used by the invites list where the
 * `data-card-fp` attribute is enough.
 */
function reconcileChildren($list, blocks) {
  if (!$list) return;
  // Index existing children by their data-block-key. Anything without
  // a key (legacy children or external decorations attached to $list)
  // is left untouched in its current position.
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
  // Walk through wanted blocks in order. For each one, ensure the node
  // exists, the fingerprint is current, and the node sits at the right
  // position in $list. We compare positions by index — moving a node
  // only when its current index differs from its target index.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    let node = prev.get(b.key);
    const fp = b.fp == null ? "" : String(b.fp);
    if (!node) {
      // Brand-new block — render into a detached div and lift the
      // first element out. Skips innerHTML on a live $list so we
      // never blow away other children during the create step.
      const tmp = document.createElement("div");
      tmp.innerHTML = b.render();
      node = tmp.firstElementChild;
      if (!node) continue;
      node.setAttribute("data-block-key", b.key);
      node.setAttribute("data-block-fp", fp);
    } else if (node.getAttribute("data-block-fp") !== fp) {
      // Existing node, changed content — mutate this article's
      // attributes + inner subtree without touching the root node
      // identity. Anything outside this article (sibling cards,
      // load-more button, filter stats line) stays put.
      const tmp = document.createElement("div");
      tmp.innerHTML = b.render();
      const fresh = tmp.firstElementChild;
      if (fresh) {
        // Sync the root element's own attributes. We collect the
        // existing attribute names first to avoid mutating while
        // iterating — and we preserve data-block-key + data-block-fp
        // since we re-stamp them below.
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
        // Replace the article's INNER HTML only. The root <article>
        // stays — its identity is what keeps the MutationObservers
        // quiet on unchanged-card polls and what lets us hand
        // stable hooks to external decorators.
        node.innerHTML = fresh.innerHTML;
      }
      node.setAttribute("data-block-fp", fp);
    }
    // Ensure the node sits at position `i`. We compare to the live
    // child list, which already has earlier-positioned blocks in
    // their final spots from prior iterations of this loop.
    const expected = $list.children[i];
    if (expected !== node) {
      $list.insertBefore(node, expected || null);
    }
  }
}

/**
 * Fingerprint-guarded innerHTML write for single-card mounts (primary
 * state card, activity card, side intent card). If the new fingerprint
 * matches the previous one, the function bails out without touching
 * the DOM at all. Otherwise it does the standard innerHTML replacement
 * exactly as before.
 *
 * `state` argument is optional and only used by callers that want to
 * cache derived data on the element itself.
 */
function fpGuardedWrite($mount, fp, htmlBuilder) {
  if (!$mount) return false;
  const fpStr = fp == null ? "" : String(fp);
  if ($mount.getAttribute("data-mount-fp") === fpStr) return false;
  $mount.innerHTML = htmlBuilder();
  $mount.setAttribute("data-mount-fp", fpStr);
  return true;
}

/**
 * Stable JSON fingerprint of an object. Plain JSON.stringify is good
 * enough for our payloads — lobby + presence rows are deterministic
 * order from the backend, so we don't need a deep sort. The cost is
 * a few hundred microseconds per card; the saving is one full subtree
 * reflow per poll, which is orders of magnitude more expensive.
 */
function fpOf(obj) {
  try { return JSON.stringify(obj); } catch { return ""; }
}

// =========================================================================
// Formatters & small utilities
// =========================================================================
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

function formatRelative(iso) {
  if (!iso) return "just now";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "just now";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
function formatCountdown(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}
function ascensionLabel(min, max) {
  if (min == null && max == null) return "Any A";
  // Clamp display to the STS2 cap so legacy data created on the STS1
  // 0..20 range still renders within the right scale here.
  const clamp = (n) => Math.max(0, Math.min(GAME_CONFIG.maxAscension, n));
  if (min != null && max != null) {
    const lo = clamp(min);
    const hi = clamp(max);
    return lo === hi ? `A${lo}` : `A${lo}–A${hi}`;
  }
  if (min != null) return `A${clamp(min)}+`;
  return `≤ A${clamp(max)}`;
}
// Backend values are kept stable for forward compatibility — the legacy
// `a20` goal is still accepted, but every user-facing surface now reads
// "High Ascension" instead.
const GOAL_LABEL = {
  any: "Any run", casual: "Casual", climb: "Climb",
  high: "High Ascension",
  a20: "High Ascension",
  heart: "Heart attempt", teaching: "Teaching", learning: "Learning",
  daily: "Daily", experimental: "Experimental",
};
function goalLabel(g) { return GOAL_LABEL[g] || (g || "Any run"); }
function voiceLabel(v) {
  return ({ yes: "Voice chat", no: "No voice", optional: "Voice optional" })[v] || "";
}
function statusLabel(s) {
  return ({ looking: "Looking for Co-op", solo: "In a Run", paired: "In Co-op", afk: "Away", offline: "Offline",
            inRun: "In a Run", inCoop: "In Co-op" })[s] || "Looking for Co-op";
}
function steamProfileUrl(sid) {
  return `https://steamcommunity.com/profiles/${encodeURIComponent(sid)}`;
}
function isStale(presence) {
  if (!presence?.lastHeartbeatAt) return false;
  return (Date.now() - Date.parse(presence.lastHeartbeatAt)) > STALE_AFTER_MS;
}

// =========================================================================
// Main render
// =========================================================================
function render(state) {
  if (!state) return;
  // Detect partner-initiated end-of-pairing BEFORE we repaint the
  // activity card. If we had an active session on the previous
  // render and the new state has none, the pairing ended. When
  // `localEndPairingPending` is true the user clicked End Pairing
  // themselves and already got "Pairing ended." — suppress the
  // partner-side toast so we never double-notify.
  const newActiveSessionId =
    state.session && state.session.status === "active" ? state.session.sessionId : null;
  if (lastKnownActiveSessionId && !newActiveSessionId) {
    if (!localEndPairingPending) {
      bootCtx?.deps?.toast?.("Your co-op partner ended the pairing.");
    }
    localEndPairingPending = false;
  }
  lastKnownActiveSessionId = newActiveSessionId;

  reflectFormFromPresence(state.presence);
  renderBarStats(state);
  const ux = resolveCoopUxState(state, state.presence?.steamId);
  renderPrimaryState(state, ux);
  applySectionVisibility(state, ux);
  renderSideStatusCard(state);
  renderActivityCard(state, ux);
  renderInvites(state, ux);
  renderLobbies(state, ux);
  renderRecommendations(state, ux);
  refreshSandboxFromState(state);
  applyRoomDeepLink();

  const $count = document.getElementById("online-count");
  if ($count) {
    const total = Number.isFinite(state.playersOnlineCount)
      ? state.playersOnlineCount
      : (state.activePlayerFeed?.length || 0);
    $count.textContent = String(total);
  }
}

function renderAgeLabels(state) {
  // Lightweight tick — refresh "last seen" / "expires in" text without
  // re-rendering the whole DOM.
  document.querySelectorAll("[data-expires]").forEach((el) => {
    el.textContent = formatCountdown(el.dataset.expires);
  });
  document.querySelectorAll("[data-since]").forEach((el) => {
    el.textContent = formatRelative(el.dataset.since);
  });
}

// =========================================================================
// A. Command bar — 3 stats on the top-right
// =========================================================================
function visibleOpenLobbies(state) {
  const mySid = state.presence?.steamId;
  const open = filterOpenLobbiesForViewer(
    (state.openLobbies || []).filter(
      (l) => l.status === "open" || l.status === "full",
    ),
    mySid,
  );
  const myLobby = state.lobby;
  if (
    myLobby &&
    myLobby.hostSteamId === mySid &&
    myLobby.status !== "closed" &&
    myLobby.status !== "expired" &&
    !open.some((l) => l.lobbyId === myLobby.lobbyId)
  ) {
    return [myLobby, ...open];
  }
  return open;
}

function renderBarStats(state) {
  const lobbies = visibleOpenLobbies(state);
  const feed = state.activePlayerFeed || [];
  // Prefer server-provided TRUE totals when present so the bar still
  // reads "8,431 active" even though we cap the feed payload to ~200
  // rows. Falls back to the local list size for backwards compat with
  // older /coop/state bundles.
  const lobbiesTotal = Number.isFinite(state.openLobbiesTotalCount)
    ? state.openLobbiesTotalCount
    : lobbies.length;
  const lookingCount = Number.isFinite(state.lookingNowCount)
    ? state.lookingNowCount
    : feed.filter((p) => p.status === "looking").length;
  const activeCount = Number.isFinite(state.playersOnlineCount)
    ? state.playersOnlineCount
    : feed.length;

  setBarStat("coop-stat-lobbies", lobbiesTotal, { highlightOnNonZero: true });
  setBarStat("coop-stat-looking", lookingCount);
  setBarStat("coop-stat-active", activeCount);
}
function setBarStat(id, n, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(n);
  el.classList.toggle("is-zero", n === 0);
  el.classList.toggle("is-hot", !!opts.highlightOnNonZero && n > 0);
}

// =========================================================================
// Primary UX state panel — one dominant next step (#coop-primary-state)
// =========================================================================
function applySectionVisibility(state, ux) {
  const $recs = document.getElementById("coop-recs-section");
  const hideRecs = new Set([
    "requested_seat",
    "in_party",
    "in_sts2_lobby",
    "in_run",
    "away",
    "incoming_request",
    "hosting_lobby",
  ]).has(ux.state);
  if ($recs) $recs.hidden = hideRecs;

  const $invites = document.getElementById("coop-invites-section");
  if ($invites && ux.state === "in_party") $invites.hidden = true;

  const $feed = document.getElementById("feed");
  const $feedToggle = document.getElementById("coop-feed-toggle");
  if ($feed && $feedToggle && !["idle", "browsing"].includes(ux.state)) {
    $feed.hidden = true;
    $feedToggle.setAttribute("aria-expanded", "false");
    $feedToggle.textContent = "Show all";
  }
}

function applyRoomDeepLink() {
  try {
    const roomId = new URLSearchParams(window.location.search).get("room");
    if (!roomId || !/^[0-9a-f]{32}$/i.test(roomId)) return;
    const card = document.querySelector(`[data-lobby-id="${roomId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("coop-lobby-card--highlight");
    setTimeout(() => card.classList.remove("coop-lobby-card--highlight"), 3200);
  } catch {}
}

function renderPendingJoinReqInline(r, state) {
  const selected = normalizeCharacterId(r.selectedCharacter);
  return `
    <div class="coop-primary-pending-row">
      <img class="avatar" src="${esc(r.fromAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
      <div class="coop-primary-pending-meta">
        <strong>${esc(r.fromPersonaName || "Steam user")}</strong>
        <span class="muted small">Seat request${selected ? ` · ${esc(characterLabel(selected))}` : ""} · expires <span data-expires="${esc(r.expiresAt)}">${esc(formatCountdown(r.expiresAt))}</span></span>
      </div>
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-xs" data-coop-action="accept-join" data-lobby="${esc(r.lobbyId)}" data-from="${esc(r.fromSteamId)}">Accept</button>
        <button class="btn-ghost btn-xs" data-coop-action="decline-join" data-lobby="${esc(r.lobbyId)}" data-from="${esc(r.fromSteamId)}">Decline</button>
      </div>
    </div>`;
}

function renderPrimaryState(state, ux) {
  const $mount = document.getElementById("coop-primary-state");
  if (!$mount) return;
  const meSid = state.presence?.steamId;
  const { data } = ux;

  // Compute the fingerprint once up front and bail out if the rendered
  // card would be byte-for-byte identical to what's already in the
  // mount. Saves the dominant primary-card reflow (avatar, pending
  // requests, character strip, seat row) on every no-op poll.
  const primaryFp = fpOf({
    s: ux.state,
    pres: state.presence ? { st: state.presence.status, sid: state.presence.steamId } : null,
    lob: data.lobby ? lobbyCardFields(data.lobby) : null,
    par: data.party ? {
      id: data.party.partyId,
      st: data.party.status,
      sz: data.party.lobbySize,
      ms: (data.party.members || []).map((m) => ({ s: m.steamId, st: m.status, n: m.personaName })),
    } : null,
    req: data.request ? { id: data.request.requestId, lob: data.request.lobbyId, st: data.request.status } : null,
    sess: data.session ? { id: data.session.sessionId, st: data.session.status } : null,
    pj: (data.incomingJoinReqs || []).map((r) => ({ id: r.requestId, lob: r.lobbyId, exp: r.expiresAt, ch: r.selectedCharacter, fs: r.fromSteamId, fa: r.fromAvatarUrl, fn: r.fromPersonaName })),
    me: meSid || "",
    part: data.partner ? { sid: data.partner.steamId, n: data.partner.personaName } : null,
  });
  if ($mount.getAttribute("data-mount-fp") === primaryFp) return;
  $mount.setAttribute("data-mount-fp", primaryFp);

  switch (ux.state) {
    case "away":
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--away">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">Away</span>
            <h2 class="coop-primary-title">You&rsquo;re marked away</h2>
            <p class="coop-primary-sub">Switch back to Looking when you&rsquo;re ready to find a co-op run.</p>
          </div>
          <div class="coop-primary-actions">
            <button class="btn-primary btn-sm" type="button" data-coop-action="go-looking">Looking for Co-op</button>
          </div>
        </article>`;
      return;

    case "in_run":
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--run">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">In Run</span>
            <h2 class="coop-primary-title">In Run</h2>
            <p class="coop-primary-sub">Seat requests are disabled while you&rsquo;re in a run.</p>
          </div>
        </article>`;
      return;

    case "in_sts2_lobby": {
      const party = data.party;
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--sts2">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">STS2 Lobby</span>
            <h2 class="coop-primary-title">In STS2 Lobby</h2>
            <p class="coop-primary-sub">Pick your character in-game. Open Party Room for the handoff checklist.</p>
          </div>
          <div class="coop-primary-actions">
            <a class="btn-primary btn-sm" href="/party/${esc(party.partyId)}">Open Party Hub</a>
          </div>
        </article>`;
      return;
    }

    case "in_party": {
      const party = data.party;
      const filled = party.members.filter((m) => m.status !== "left").length;
      const cap = party.lobbySize || lobbySizeOf(data.lobby || {});
      const statusLine = partyStatusLine(party, meSid);
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--party">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">Party</span>
            <h2 class="coop-primary-title">You&rsquo;re in the party</h2>
            <p class="coop-primary-sub">${filled}/${cap} seats · ${esc(statusLine)}</p>
          </div>
          <div class="coop-primary-actions">
            <a class="btn-primary btn-sm" href="/party/${esc(party.partyId)}">Open Party Hub</a>
            <button class="btn-ghost btn-sm" type="button" data-coop-action="leave-party" data-id="${esc(party.partyId)}">Leave Party</button>
          </div>
        </article>`;
      return;
    }

    case "requested_seat": {
      const req = data.request;
      const reqLobby = data.lobby;
      const hostName = reqLobby?.hostPersonaName || "the host";
      const title = reqLobby?.title ? esc(reqLobby.title) : "Run lobby";
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--requested">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">Seat requested</span>
            <h2 class="coop-primary-title">Waiting for ${esc(hostName)}</h2>
            <p class="coop-primary-sub">${title} · Your seat request is pending. The host must accept before you can open the Party Room.</p>
          </div>
          <div class="coop-primary-actions">
            <button class="btn-ghost btn-sm" type="button" data-coop-action="cancel-join" data-lobby="${esc(req.lobbyId)}">Cancel Request</button>
            <button class="btn-ghost btn-sm" type="button" data-coop-action="browse-lobbies">Browse Other Lobbies</button>
          </div>
        </article>`;
      return;
    }

    case "hosting_lobby":
    case "incoming_request": {
      const lobby = data.lobby;
      const memberCount = lobbyMembers(lobby).length || 1;
      const cap = lobbySizeOf(lobby);
      const need = openSeats(lobby);
      const pending = data.incomingJoinReqs || [];
      const pendingHtml = pending.length
        ? `<div class="coop-primary-pending">
            <span class="coop-primary-pending-label">Pending seat requests</span>
            ${pending.map((r) => renderPendingJoinReqInline(r, state)).join("")}
          </div>`
        : "";
      const partyBtn = lobby.partyId
        ? `<a class="btn-primary btn-sm" href="/party/${esc(lobby.partyId)}">Open Party Hub</a>`
        : "";
      const discordBtn = `<button type="button" class="btn-ghost btn-sm" data-coop-action="copy-discord-lfg" data-id="${esc(lobby.lobbyId)}">Copy Discord LFG Post</button>`;
      // Visibility indicator. The single most common silent failure prior
      // to the v186 backend fix was: host opens a room, their Steam shows
      // Invisible → server auto-AFKs them → /coop/state filter hides the
      // lobby from every other user → host sits there assuming the world
      // can see them. After the v186 fix, hosting an open lobby pins the
      // user to "looking" on every heartbeat, but we still surface the
      // resolved state here so the host has confirmation, not guesswork.
      // (See Backend/src/coop-engine.ts heartbeatPresence "Priority 0".)
      const presence = state?.presence;
      const status = String(presence?.status || "").toLowerCase();
      const isVisible = status === "looking" || status === "solo";
      const visibilityHtml = isVisible
        ? `<div class="coop-primary-visibility coop-primary-visibility--public" role="status">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="8 12 11 15 16 9"/></svg>
            <span>Visible in Live Parties &mdash; anyone signed in can see and join this room.</span>
          </div>`
        : `<div class="coop-primary-visibility coop-primary-visibility--hidden" role="status">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12" y2="16"/></svg>
            <span>Hidden &mdash; your status is <strong>${esc(status || "unknown")}</strong>. Set yourself to <em>Looking</em> so others can find this room.</span>
          </div>`;
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--hosting">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">Your room is open</span>
            <h2 class="coop-primary-title">${esc(lobby.title)}</h2>
            <p class="coop-primary-sub">${memberCount}/${cap} seats filled · Need +${need}</p>
          </div>
          ${visibilityHtml}
          ${renderLobbySeatRow(lobby, data.party)}
          ${renderCharacterStrip(preferredCharactersOf(lobby))}
          ${pendingHtml}
          <div class="coop-primary-actions">
            ${partyBtn}
            ${discordBtn}
            <button class="btn-ghost btn-sm" type="button" data-coop-action="open-edit-lobby" data-id="${esc(lobby.lobbyId)}">Manage</button>
            <button class="btn-ghost btn-sm" type="button" data-coop-action="close-lobby" data-id="${esc(lobby.lobbyId)}">Close Room</button>
          </div>
        </article>`;
      return;
    }

    case "browsing": {
      const partner = data.partner;
      const name = partner?.personaName || "your co-op partner";
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--paired">
          <div class="coop-primary-meta">
            <span class="coop-primary-eyebrow">Pairing</span>
            <h2 class="coop-primary-title">Paired with ${esc(name)}</h2>
            <p class="coop-primary-sub">Add each other on Steam for STS2, then end the pairing when you&rsquo;re done.</p>
          </div>
          <div class="coop-primary-actions">
            <button class="btn-ghost btn-sm" type="button" data-coop-action="end-session" data-id="${esc(data.session.sessionId)}">End Pairing</button>
          </div>
        </article>`;
      return;
    }

    case "idle":
    default:
      $mount.innerHTML = `
        <article class="coop-primary-card coop-primary-card--idle">
          <div class="coop-primary-meta coop-primary-hero">
            <span class="coop-primary-eyebrow">Find a co-op run</span>
            <h2 class="coop-primary-title">Ready to find a run?</h2>
            <p class="coop-primary-sub">Quick Match, host a room, or browse Open Rooms below.</p>
          </div>
          <div class="coop-primary-actions">
            <button class="btn-primary btn-sm" type="button" data-coop-action="quick-match">Find Me a Group</button>
            <button class="btn-ghost btn-sm" type="button" data-coop-action="open-create-lobby">Host a Room</button>
            <button class="btn-ghost btn-sm" type="button" data-coop-action="browse-lobbies">Browse Lobbies</button>
          </div>
        </article>`;
  }
}

// =========================================================================
// Sidebar · Your status card — live chip + intent rows + hint
// =========================================================================
function renderSideStatusCard(state) {
  const p = state.presence;

  // Live chip (in the side card head)
  const $live = document.getElementById("coop-live-chip");
  if ($live) {
    if (!p) {
      $live.hidden = true;
    } else {
      $live.hidden = false;
      const stale = isStale(p);
      $live.classList.toggle("is-stale", stale);
      const $txt = $live.querySelector("span:last-child");
      const want = stale ? "Stale" : "Live";
      if ($txt && $txt.textContent !== want) $txt.textContent = want;
    }
  }

  const $intent = document.getElementById("coop-strip-intent");
  if (!$intent) return;
  if (!p) {
    if ($intent.childNodes.length > 0) $intent.innerHTML = "";
    $intent.removeAttribute("data-mount-fp");
    return;
  }
  // Single-mount fingerprint guard: skip the innerHTML write whenever
  // none of the user's preference inputs changed.
  const intentFp = fpOf({
    g: p.goal,
    am: p.ascensionMin,
    aM: p.ascensionMax,
    pc: preferredCharactersOf(p),
    v: p.voicePreference,
    d: p.discordHandle,
    n: p.note,
  });
  if ($intent.getAttribute("data-mount-fp") === intentFp) return;
  $intent.setAttribute("data-mount-fp", intentFp);
  const rows = [];
  const preferredCharacter = firstPreferredCharacter(p);
  rows.push(intentRow("Goal", goalLabel(p.goal || "any"), !p.goal));
  rows.push(intentRow("Asc", ascensionLabel(p.ascensionMin, p.ascensionMax), p.ascensionMin == null && p.ascensionMax == null));
  rows.push(intentRow("Character", preferredCharacter ? characterLabel(preferredCharacter) : "Open to any", !preferredCharacter));
  rows.push(intentRow("Voice", voiceLabel(p.voicePreference) || "Any", !p.voicePreference));
  if (p.discordHandle) rows.push(intentRow("Discord", p.discordHandle, false));
  if (p.note) {
    rows.push(`<div class="coop-side-intent-note">&ldquo;${esc(p.note)}&rdquo;</div>`);
  }
  $intent.innerHTML = rows.join("");
}

function intentRow(key, value, isEmpty) {
  return `<div class="coop-side-intent-row">
    <span class="coop-side-intent-key">${esc(key)}</span>
    <span class="coop-side-intent-val${isEmpty ? " is-empty" : ""}">${esc(value)}</span>
  </div>`;
}

function reflectFormFromPresence(p) {
  if (!p) return;
  setRadio("status", p.status);
  setRadio("modal-status", p.status);
  setSelect("coop-goal", p.goal || "");
  setInput("coop-asc-min", p.ascensionMin ?? "");
  setInput("coop-asc-max", p.ascensionMax ?? "");
  setSelect("coop-voice", p.voicePreference || "");
  setCharacterRadio("intentPreferredCharacter", firstPreferredCharacter(p));
  // Only seed text fields when empty (don't stomp mid-edit).
  const $d = document.getElementById("me-discord");
  if ($d && !$d.value) $d.value = p.discordHandle || "";
  const $n = document.getElementById("coop-note");
  if ($n && !$n.value) $n.value = p.note || "";
  const $persona = document.getElementById("me-persona");
  if ($persona && p.personaName) $persona.textContent = p.personaName;
  const $avatar = document.getElementById("me-avatar");
  if ($avatar && p.avatarUrl) $avatar.src = p.avatarUrl;
  const $tier = document.getElementById("me-tier");
  if ($tier) $tier.textContent = p.steamId ? `Steam · ${shortSteamId(p.steamId)}` : "";
}
function shortSteamId(sid) {
  const s = String(sid || "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el && !el.checked) el.checked = true;
}
/**
 * Like setRadio, but also fires a synthetic `change` event so legacy
 * listeners in script.js (auto-AFK timer reset + /presence push) see
 * the update.
 */
function setRadioAndFire(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (!el) return;
  if (!el.checked) el.checked = true;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function setSelect(id, value) {
  const el = document.getElementById(id);
  if (!el || document.activeElement === el) return;
  el.value = String(value ?? "");
}
function setInput(id, value) {
  const el = document.getElementById(id);
  if (!el || document.activeElement === el) return;
  el.value = String(value ?? "");
}

// =========================================================================
// Sidebar · Current activity — compact mirror of primary UX state
// =========================================================================
function renderActivityCard(state, ux) {
  const $section = document.getElementById("coop-active-state");
  if (!$section) return;
  // Activity card only ever varies by ux.state — fingerprint that
  // single dimension and bail when unchanged. Cheap and decisive.
  const activityFp = `act:${ux.state}`;
  if ($section.getAttribute("data-mount-fp") === activityFp) return;
  $section.setAttribute("data-mount-fp", activityFp);

  const labels = {
    idle: { eyebrow: "Idle", title: "Ready to find a run", sub: "Use the panel above to get started." },
    browsing: { eyebrow: "Pairing", title: "Paired", sub: "End pairing when your run is done." },
    requested_seat: { eyebrow: "Requested", title: "Seat requested", sub: "Waiting for the host to accept." },
    hosting_lobby: { eyebrow: "Hosting", title: "Your room is open", sub: "Accept seat requests above." },
    incoming_request: { eyebrow: "Hosting", title: "Seat requests waiting", sub: "Review pending requests above." },
    in_party: { eyebrow: "Party", title: "In party", sub: "Open Party Room for the STS2 handoff." },
    in_sts2_lobby: { eyebrow: "STS2 Lobby", title: "Character select", sub: "Pick your character in-game." },
    in_run: { eyebrow: "In Run", title: "In Run", sub: "Seat requests paused." },
    away: { eyebrow: "Away", title: "Marked away", sub: "Switch to Looking when ready." },
  };
  const copy = labels[ux.state] || labels.idle;
  const mod = {
    in_party: "paired",
    in_sts2_lobby: "paired",
    in_run: "paired",
    hosting_lobby: "hosting",
    incoming_request: "hosting",
    requested_seat: "joined",
    browsing: "paired",
    away: "idle",
    idle: "idle",
  }[ux.state] || "idle";

  $section.innerHTML = `
    <article class="coop-active-card coop-active-card--${mod}">
      <div class="coop-active-meta">
        <span class="coop-active-eyebrow">${esc(copy.eyebrow)}</span>
        <h3 class="coop-active-title">${esc(copy.title)}</h3>
        <p class="coop-active-sub">${copy.sub}</p>
      </div>
    </article>`;
}


// =========================================================================
// Seat Requests panel — legacy co-op invites only (join reqs inline in host card)
// =========================================================================
function renderInvites(state, ux) {
  const $section = document.getElementById("coop-invites-section");
  const $list = document.getElementById("coop-invites-list");
  const $count = document.getElementById("coop-invites-count");
  if (!$section || !$list || !$count) return;
  const incoming = state.incomingInvites || [];
  const outgoing = state.outgoingInvites || [];
  const legacyTotal = incoming.length + outgoing.length;

  if ($count.textContent !== String(legacyTotal)) {
    $count.textContent = String(legacyTotal);
  }
  if (legacyTotal === 0) {
    $section.hidden = true;
    // Reconcile against an empty block list so any stale invite cards
    // are removed without wiping siblings that other code attached.
    reconcileChildren($list, []);
    return;
  }
  $section.hidden = false;
  const blocks = [];
  for (const i of incoming) {
    blocks.push({
      key: `inv-in:${i.inviteId}`,
      fp: fpOf({ k: "in", id: i.inviteId, from: i.fromSteamId, name: i.fromPersonaName, av: i.fromAvatarUrl, exp: i.expiresAt, pre: i.messagePreset }),
      render: () => renderIncomingInvite(i),
    });
  }
  for (const o of outgoing) {
    blocks.push({
      key: `inv-out:${o.inviteId}`,
      fp: fpOf({ k: "out", id: o.inviteId, to: o.toSteamId, name: o.toPersonaName, av: o.toAvatarUrl, exp: o.expiresAt }),
      render: () => renderOutgoingInvite(o),
    });
  }
  reconcileChildren($list, blocks);
}

function renderIncomingInvite(i) {
  return `
    <article class="coop-invite-card coop-invite-card--incoming">
      <div class="coop-invite-card-head">
        <img class="avatar" src="${esc(i.fromAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-invite-meta">
          <strong>${esc(i.fromPersonaName || "Steam user")}</strong>
          <span class="coop-invite-expiry">expires in <span data-expires="${esc(i.expiresAt)}">${esc(formatCountdown(i.expiresAt))}</span></span>
        </div>
        <span class="coop-invite-kind">Co-op</span>
      </div>
      <p class="coop-invite-msg">${esc(presetMessage(i.messagePreset) || "Want to co-op?")}</p>
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-sm" data-coop-action="accept-invite" data-id="${esc(i.inviteId)}">Accept</button>
        <button class="btn-ghost btn-sm" data-coop-action="decline-invite" data-id="${esc(i.inviteId)}">Decline</button>
      </div>
    </article>`;
}
function renderIncomingJoinReq(r, state) {
  const lobbyTitle = findLobbyById(state, r.lobbyId)?.title || "Run lobby";
  return `
    <article class="coop-invite-card coop-invite-card--joinreq">
      <div class="coop-invite-card-head">
        <img class="avatar" src="${esc(r.fromAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-invite-meta">
          <strong>${esc(r.fromPersonaName || "Steam user")} requested a seat</strong>
          <span class="coop-invite-expiry">${esc(lobbyTitle)} · expires in <span data-expires="${esc(r.expiresAt)}">${esc(formatCountdown(r.expiresAt))}</span></span>
        </div>
        <span class="coop-invite-kind">Incoming</span>
      </div>
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-sm" data-coop-action="accept-join" data-lobby="${esc(r.lobbyId)}" data-from="${esc(r.fromSteamId)}">Accept Seat</button>
        <button class="btn-ghost btn-sm" data-coop-action="decline-join" data-lobby="${esc(r.lobbyId)}" data-from="${esc(r.fromSteamId)}">Decline</button>
      </div>
    </article>`;
}
function renderOutgoingInvite(i) {
  return `
    <article class="coop-invite-card coop-invite-card--outgoing">
      <div class="coop-invite-card-head">
        <img class="avatar" src="${esc(i.toAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-invite-meta">
          <strong>${esc(i.toPersonaName || "Steam user")}</strong>
          <span class="coop-invite-expiry">waiting · expires in <span data-expires="${esc(i.expiresAt)}">${esc(formatCountdown(i.expiresAt))}</span></span>
        </div>
        <span class="coop-invite-kind">Sent</span>
      </div>
      <div class="coop-lobby-actions">
        <button class="btn-ghost btn-sm" data-coop-action="cancel-invite" data-id="${esc(i.inviteId)}">Cancel</button>
      </div>
    </article>`;
}
function renderOutgoingJoinReq(r, state) {
  const hostName = findLobbyById(state, r.lobbyId)?.hostPersonaName || "the host";
  return `
    <article class="coop-invite-card coop-invite-card--outgoing">
      <div class="coop-invite-meta">
        <strong>Seat requested</strong>
        <span class="coop-invite-expiry">Waiting for ${esc(hostName)} to accept · expires in <span data-expires="${esc(r.expiresAt)}">${esc(formatCountdown(r.expiresAt))}</span></span>
      </div>
      <div class="coop-lobby-actions">
        <button class="btn-ghost btn-sm" data-coop-action="cancel-join" data-lobby="${esc(r.lobbyId)}">Cancel Request</button>
      </div>
    </article>`;
}

function presetMessage(id) {
  // Backend preset IDs are stable; only the rendered text changes.
  // STS2 ascension cap is 10, so high/low presets reference A0–A10.
  const catalog = {
    coop_any: "Want to co-op? Any ascension.",
    coop_low: "Want to co-op? Casual / low ascension.",
    coop_high: "Want to co-op? High Ascension (A8–A10).",
    coop_a20: "Want to co-op? High Ascension (A10).",
    coop_voice: "Want to co-op with voice chat?",
    coop_quick: "One quick run? ~30 min.",
    coop_daily: "Want to co-op the daily?",
    coop_teach: "Want to co-op? Happy to teach.",
    coop_learn: "Want to co-op? Still learning.",
  };
  return catalog[id];
}

// =========================================================================
// Open Rooms (hosted runs that other players can request to join)
// =========================================================================
function renderLobbies(state, ux) {
  const $list = document.getElementById("coop-lobbies-list");
  const $count = document.getElementById("coop-lobbies-count");
  if (!$list || !$count) return;

  let allLobbies = visibleOpenLobbies(state);
  allLobbies = pinLobbiesForUx(allLobbies, state, ux);
  if ($count.textContent !== String(allLobbies.length)) {
    $count.textContent = String(allLobbies.length);
  }
  const $filterBar = document.getElementById("coop-lobby-filter-bar");
  if ($filterBar) $filterBar.hidden = allLobbies.length === 0;

  // Toggle compact-density class without touching content. Mutates a
  // class on the root only; never wipes children.
  $list.classList.toggle("is-compact", !!lobbyCompact);

  // -------------------------------------------------------------------
  // Three empty-ish branches kept structurally identical so the
  // reconciler can keep cards around when the user toggles filters
  // mid-poll. Each branch returns early with a single-block list so
  // the rest of the list comes out fresh.
  // -------------------------------------------------------------------
  if (allLobbies.length === 0) {
    reconcileChildren($list, [{
      key: "empty:no-lobbies",
      fp: "empty:no-lobbies",
      render: () => renderEmptyLobbies(),
    }]);
    return;
  }

  const mySid = state.presence?.steamId;
  const pendingByLobby = new Map(
    (state.outgoingJoinRequests || [])
      .filter((r) => r.status === "pending")
      .map((r) => [r.lobbyId, r])
  );

  const filtered = allLobbies.filter(lobbyMatchesFilters);
  const me = state.presence;
  if (lobbySort === "best") {
    filtered.sort((a, b) =>
      relevanceScore(b, me) - relevanceScore(a, me) ||
      new Date(b.updatedAt) - new Date(a.updatedAt)
    );
  } else if (lobbySort === "newest") {
    filtered.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } else {
    filtered.sort((a, b) => (a.ascensionMin ?? 0) - (b.ascensionMin ?? 0));
  }

  if (filtered.length === 0) {
    reconcileChildren($list, [{
      key: "empty:no-filter-match",
      fp: "empty:no-filter-match",
      render: () => `
        <div class="coop-empty-card coop-empty-card--compact coop-empty-card--inline">
          <div class="coop-empty-card-text">
            <h4 class="coop-empty-title">No lobbies match your filters</h4>
            <p class="coop-empty-body">Try adjusting the goal, ascension, or voice filters above.</p>
          </div>
          <button class="btn-ghost btn-sm" type="button" id="coop-clear-filters">Clear filters</button>
        </div>`,
    }]);
    document.getElementById("coop-clear-filters")?.addEventListener("click", clearLobbyFilters);
    return;
  }

  const slice = filtered.slice(0, lobbiesVisible);
  const remaining = filtered.length - slice.length;
  // Server may have capped the open-lobbies payload at the top N most
  // relevant hosts; if so, surface the true total so users know what
  // they're browsing.
  const trueTotal = Number.isFinite(state.openLobbiesTotalCount)
    ? state.openLobbiesTotalCount
    : allLobbies.length;
  const capActive = trueTotal > allLobbies.length;

  // Build the block list. Filter stats and load-more are real blocks
  // with their own keys; each lobby card is keyed by lobbyId so the
  // reconciler can match the same lobby across polls and skip the
  // DOM swap entirely when nothing changed.
  const blocks = [];
  if (filtered.length < allLobbies.length || capActive) {
    const matchingFrom = capActive
      ? `${filtered.length} matching from top ${allLobbies.length} (of ${trueTotal} total)`
      : `${filtered.length} of ${allLobbies.length} matching`;
    const statsText = `Showing ${Math.min(slice.length, filtered.length)} · ${matchingFrom}`;
    blocks.push({
      key: "filter-stats",
      fp: statsText,
      render: () => `<p class="coop-filter-stats">${esc(statsText)}</p>`,
    });
  }
  // Cache the active-pairing flag once — saves a property read per card
  // and ensures every card in this render sees the same value.
  const pairedSessionId = state.session && state.session.status === "active"
    ? state.session.sessionId : null;
  for (const l of slice) {
    blocks.push({
      key: `lobby:${l.lobbyId}`,
      // Fingerprint includes every viewer-context bit that affects
      // rendering. If any of these change the card re-renders inner
      // HTML; otherwise the existing DOM node stays untouched (and
      // every external decoration on it — match score ring, host run
      // strip, LevelBadge — stays alive across the poll).
      fp: fpOf({
        c: lobbyCompact ? 1 : 0,
        s: pairedSessionId,
        p: pendingByLobby.get(l.lobbyId)?.requestId || null,
        m: mySid || "",
        // Pick only the lobby fields that drive the card. Avoids
        // false-positive cache misses on bookkeeping fields the
        // backend bumps on every tick (e.g. internal version).
        l: lobbyCardFields(l),
      }),
      render: () => renderLobbyCard(l, mySid, pendingByLobby, state, lobbyCompact),
    });
  }
  if (remaining > 0) {
    const showMoreCount = Math.min(CARDS_PAGE, remaining);
    blocks.push({
      key: "load-more",
      fp: `load-more:${showMoreCount}:${remaining}`,
      render: () => `<div class="coop-load-more"><button class="coop-load-more-btn" id="coop-load-more-lobbies">Show ${showMoreCount} more <span class="coop-load-more-count">(${remaining} left)</span></button></div>`,
    });
  }
  reconcileChildren($list, blocks);
  // The load-more button gets a fresh listener whenever it's first
  // created OR re-created (fp differs). When unchanged across polls
  // the same DOM node persists, so its existing listener does too.
  // This is a no-op in steady state.
  const $loadMore = document.getElementById("coop-load-more-lobbies");
  if ($loadMore && !$loadMore.__coopBound) {
    $loadMore.__coopBound = true;
    $loadMore.addEventListener("click", () => {
      lobbiesVisible += CARDS_PAGE;
      renderLobbies(lastState, resolveCoopUxState(lastState, lastState?.presence?.steamId));
    });
  }
}

/**
 * Project a lobby down to just the fields that affect the rendered
 * card. Used by both the lobbies list and the recommendations list
 * fingerprints. Anything not in this set (server-side bookkeeping,
 * internal version counters, etc.) won't cause a re-render — which is
 * exactly the point: the lobby data is allowed to drift in ways the
 * user can't see without paying for a card swap.
 */
function lobbyCardFields(l) {
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
    vc: l.voiceChannelUrl,
    mo: l.mode,
    sz: l.lobbySize,
    pc: l.preferredCharacters || [],
    me: lobbyMembers(l),
    no: l.note,
    dc: l.discordHandle,
    pa: l.partyId,
    ap: l.approvalRequired,
    ua: l.updatedAt,
  };
}

/** Pin host lobby or requested lobby to the top of Open Run Lobbies. */
function pinLobbiesForUx(lobbies, state, ux) {
  const pinnedId =
    ux.state === "hosting_lobby" || ux.state === "incoming_request"
      ? state.lobby?.lobbyId
      : ux.state === "requested_seat"
        ? ux.data.request?.lobbyId
        : null;
  if (!pinnedId) return lobbies;
  const idx = lobbies.findIndex((l) => l.lobbyId === pinnedId);
  if (idx <= 0) return lobbies;
  const next = [...lobbies];
  const [pinned] = next.splice(idx, 1);
  next.unshift(pinned);
  return next;
}

function renderEmptyLobbies() {
  // Polished empty board. Lives INSIDE the Open Run Lobbies board
  // card so it inherits the panel's width and feels like part of a
  // real matchmaking surface, not a separate placeholder. Must not
  // wrap a single word per line at any desktop width.
  //
  // While-you-wait line is the cold-start liquidity fix: when nobody
  // is hosting an STS2 lobby right now, point users at the three
  // standalone surfaces that DO have something to look at — live
  // runs, daily ghosts, and the AI coach. They're one click away.
  return `
    <div class="coop-empty-card coop-empty-card--openruns">
      <div class="coop-empty-card-text">
        <h4 class="coop-empty-title">No open rooms yet</h4>
        <p class="coop-empty-body">Host the first room so players can Join Seat, then open Party Hub to coordinate on Steam.</p>
        <div class="coop-empty-actions">
          <button class="btn-primary btn-sm" type="button" data-coop-action="open-create-lobby">+ Host a Room</button>
          <button class="btn-ghost btn-sm" type="button" data-coop-action="quick-match">⚡ Quick Match</button>
        </div>
        <p class="coop-empty-while-wait">
          While you wait,
          <a href="/watch" data-coop-showtime="empty_watch">watch a live run</a>,
          <a href="/coach" data-coop-showtime="empty_coach">grade a screenshot with Coach</a>,
          or <a href="/race" data-coop-showtime="empty_race">browse today's race</a>.
        </p>
        <div class="coop-empty-examples">
          <span class="coop-empty-examples-label">Example Run Lobbies</span>
          <div class="coop-empty-examples-row">
            <span class="coop-empty-chip coop-empty-chip-goal">A10 Heart</span>
            <span class="coop-empty-chip">Casual Climb</span>
            <span class="coop-empty-chip coop-empty-chip-learn">Learning Run</span>
            <span class="coop-empty-chip">Daily Run</span>
          </div>
        </div>
      </div>
    </div>`;
}

function relevanceScore(lobby, me) {
  if (!me) return 0;
  let score = 0;
  const myGoal = me.goal || "";
  const lobGoal = lobby.goal || "any";
  if (!myGoal || myGoal === "any" || lobGoal === "any" || myGoal === lobGoal) score += 3;
  const lo1 = me.ascensionMin ?? 0, hi1 = me.ascensionMax ?? GAME_CONFIG.maxAscension;
  const lo2 = lobby.ascensionMin ?? 0, hi2 = lobby.ascensionMax ?? GAME_CONFIG.maxAscension;
  if (lo1 <= hi2 && lo2 <= hi1) score += 2;
  const myVoice = me.voicePreference || "";
  const lobVoice = lobby.voicePreference || "";
  if (!myVoice || !lobVoice || myVoice === lobVoice) score += 1;
  return score;
}

function lobbyMatchesFilters(lobby) {
  const { goal, asc, voice } = lobbyFilters;
  if (goal) {
    // Normalise legacy "a20" → "high" so old lobbies still appear under the High Asc chip.
    const raw = lobby.goal || "any";
    const g = raw === "a20" ? "high" : raw;
    if (g !== goal && g !== "any") return false;
  }
  if (asc) {
    const lo = lobby.ascensionMin ?? 0, hi = lobby.ascensionMax ?? GAME_CONFIG.maxAscension;
    const [flo, fhi] = asc.split("-").map(Number);
    if (hi < flo || lo > fhi) return false;
  }
  if (voice) {
    const v = lobby.voicePreference || "";
    if (v && v !== voice) return false;
  }
  if (lobbySearchQuery) {
    if (!lobbyMatchesText(lobby, lobbySearchQuery)) return false;
  }
  return true;
}

/**
 * Free-text "find anyone" matcher across the fields a user might
 * actually type — title, host name, note, Discord handle, character
 * names, and even bare ascension digits ("8" matches lobbies with
 * A8 in their range). Case-insensitive. Tokenized so "a10 heart"
 * narrows to lobbies that match BOTH tokens.
 */
function lobbyMatchesText(lobby, query) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    lobby.title,
    lobby.hostPersonaName,
    lobby.note,
    lobby.discordHandle,
    lobby.goal,
    goalLabel(lobby.goal),
    ascensionLabel(lobby.ascensionMin, lobby.ascensionMax),
    voiceLabel(lobby.voicePreference),
    ...(lobby.preferredCharacters || []),
    ...(lobby.preferredCharacters || []).map(characterLabel),
  ].filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => {
    if (haystack.includes(t)) return true;
    // Bare ascension digits — "8" should match a lobby whose
    // [ascensionMin..ascensionMax] range covers 8.
    const ascDigit = parseInt(t.replace(/^a/, ""), 10);
    if (Number.isFinite(ascDigit)) {
      const lo = lobby.ascensionMin ?? 0;
      const hi = lobby.ascensionMax ?? GAME_CONFIG.maxAscension;
      if (ascDigit >= lo && ascDigit <= hi) return true;
    }
    return false;
  });
}

function recMatchesText(rec, query) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    rec.personaName,
    rec.note,
    rec.goal,
    goalLabel(rec.goal),
    ascensionLabel(rec.ascensionMin, rec.ascensionMax),
    voiceLabel(rec.voicePreference),
    ...(rec.preferredCharacters || []).map(characterLabel),
    rec.hasDiscord ? "discord" : "",
    rec.label,
  ].filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => {
    if (haystack.includes(t)) return true;
    const ascDigit = parseInt(t.replace(/^a/, ""), 10);
    if (Number.isFinite(ascDigit)) {
      const lo = rec.ascensionMin ?? 0;
      const hi = rec.ascensionMax ?? GAME_CONFIG.maxAscension;
      if (ascDigit >= lo && ascDigit <= hi) return true;
    }
    return false;
  });
}

function clearLobbyFilters() {
  lobbyFilters = { goal: "", asc: "", voice: "" };
  lobbySearchQuery = "";
  lobbiesVisible = CARDS_PAGE;
  const $search = document.getElementById("coop-lobby-search");
  if ($search) $search.value = "";
  syncChipUI();
  renderLobbies(lastState, coopUxFromState(lastState));
}

function renderLobbyCard(lobby, mySid, pendingByLobby, state, compact = false) {
  const isMine = lobby.hostSteamId === mySid;
  const members = lobbyMembers(lobby);
  const isMember = members.includes(mySid);
  const pendingReq = pendingByLobby.get(lobby.lobbyId);
  const seatsOpen = openSeats(lobby);
  const isFull = seatsOpen <= 0 || lobby.status === "full";
  const isPaired = !!(state.session && state.session.status === "active");
  const cap = lobbySizeOf(lobby);
  const cardClass = [
    "coop-lobby-card",
    isMine ? "coop-lobby-card--mine" : "",
    isPaired ? "coop-lobby-card--paired" : "",
    isSandboxSteamId(lobby.hostSteamId) ? "coop-lobby-card--sandbox" : "",
    compact ? "coop-lobby-card--compact" : "",
  ].filter(Boolean).join(" ");
  const statusBadge = `
    <span class="coop-badge coop-badge--status-${esc(lobby.status)}">${esc(prettyStatus(lobby.status))}</span>`;
  const badges = [
    `<span class="coop-badge coop-badge--mode">${esc(lobbyModeLabel(lobby))}</span>`,
    `<span class="coop-badge coop-badge--goal">${esc(goalLabel(lobby.goal))}</span>`,
    `<span class="coop-badge coop-badge--asc">${esc(ascensionLabel(lobby.ascensionMin, lobby.ascensionMax))}</span>`,
    `<span class="coop-badge coop-badge--character">${esc(firstPreferredCharacter(lobby) ? characterLabel(firstPreferredCharacter(lobby)) : "Open to any")}</span>`,
    `<span class="coop-badge coop-badge--voice">${esc(voicePresetDisplay(lobby))}</span>`,
  ].filter(Boolean).join("");

  let action = "";
  if (isMine) {
    const partyBtn = lobby.partyId
      ? `<a class="btn-primary btn-sm" href="/party/${esc(lobby.partyId)}">Party Hub</a>`
      : "";
    action = `
      ${partyBtn}
      <button class="btn-ghost btn-sm" data-coop-action="copy-discord-lfg" data-id="${esc(lobby.lobbyId)}">Copy Discord LFG Post</button>
      <button class="btn-ghost btn-sm" data-coop-action="open-edit-lobby" data-id="${esc(lobby.lobbyId)}">Manage</button>
      <button class="btn-ghost btn-sm" data-coop-action="close-lobby" data-id="${esc(lobby.lobbyId)}">Close Room</button>`;
  } else if (isMember) {
    const partyBtn = lobby.partyId
      ? `<a class="btn-primary btn-sm" href="/party/${esc(lobby.partyId)}">Party Hub</a>`
      : "";
    // Joiners need a one-click leave path on the lobby row itself —
    // before this they could only leave from inside Party Hub. A user
    // who closes the hub tab and lands back on the Co-op feed had no
    // visible way to back out of a lobby they accidentally joined.
    const leaveBtn = lobby.partyId
      ? `<button class="btn-ghost btn-sm" data-coop-action="leave-party" data-id="${esc(lobby.partyId)}">Leave Room</button>`
      : "";
    action = `${partyBtn}${leaveBtn}<span class="coop-badge coop-badge--players">You&rsquo;re in</span>`;
  } else if (isPaired) {
    action = `<span class="coop-badge">Paired</span>`;
  } else if (pendingReq) {
    action = `
      <button class="btn-ghost btn-sm" disabled>Seat Requested</button>
      <button class="btn-ghost btn-sm" data-coop-action="cancel-join" data-lobby="${esc(lobby.lobbyId)}">Cancel</button>`;
  } else if (isFull) {
    action = `<button class="btn-ghost btn-sm" disabled>Full</button>`;
  } else if (lobbyApprovalRequired(lobby)) {
    action = `<button class="btn-primary btn-sm" data-coop-action="request-join" data-id="${esc(lobby.lobbyId)}">Request Seat</button>`;
  } else {
    action = `<button class="btn-primary btn-sm" data-coop-action="join-seat" data-id="${esc(lobby.lobbyId)}">Join Seat</button>`;
  }

  return `
    <article class="${cardClass}" data-lobby-id="${esc(lobby.lobbyId)}">
      <div class="coop-lobby-card-head">
        <img class="avatar" src="${esc(lobby.hostAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-lobby-card-title">
          <h4>${isMine ? `<span class="coop-lobby-pin">Your Room</span> ` : pendingReq ? `<span class="coop-lobby-pin coop-lobby-pin--requested">Requested</span> ` : ""}${esc(lobby.title)}</h4>
          <span class="coop-lobby-host">Hosted by <strong>${esc(lobby.hostPersonaName || "Steam user")}</strong></span>
        </div>
        <div class="coop-lobby-card-meta">${statusBadge}</div>
      </div>
      ${renderLobbySeatRow(lobby, state?.party?.lobbyId === lobby.lobbyId ? state.party : null)}
      ${renderCharacterStrip(preferredCharactersOf(lobby))}
      <div class="coop-badge-row">${badges}</div>
      ${(() => { const n = decodeStart(lobby.note).cleanNote; return n ? `<p class="coop-lobby-note">&ldquo;${esc(n)}&rdquo;</p>` : ""; })()}
      <div class="coop-lobby-foot">
        <span class="coop-lobby-time" data-since="${esc(lobby.updatedAt)}">${esc(formatRelative(lobby.updatedAt))}</span>
        <div class="coop-lobby-actions">
          ${action}
          ${lobby.discordHandle ? `<button class="btn-ghost btn-sm" data-coop-action="copy" data-value="${esc(lobby.discordHandle)}">Copy Discord</button>` : ""}
        </div>
      </div>
    </article>`;
}

function prettyStatus(s) {
  return { open: "Open", pending: "Pending", full: "Full", expired: "Expired", closed: "Closed" }[s] || s;
}

// =========================================================================
// Best Matches (ranked compatible players)
// =========================================================================
function renderRecommendations(state, ux) {
  const $list = document.getElementById("coop-recs-list");
  const $count = document.getElementById("coop-recs-count");
  const $section = document.getElementById("coop-recs-section");
  if (!$list || !$count) return;

  const outgoingPending = (state.outgoingJoinRequests || []).filter((r) => r.status === "pending");
  if ($section?.hidden && outgoingPending.length > 0) {
    return;
  }

  ensureRecsSearchUI();
  const mySid = state.presence?.steamId;
  const allRecs = filterRecommendationsForViewer(
    state.recommendedMatches || [],
    mySid,
  );
  if ($count.textContent !== String(allRecs.length)) {
    $count.textContent = String(allRecs.length);
  }

  const pendingLobbyIds = new Set(outgoingPending.map((r) => r.lobbyId));

  if (outgoingPending.length > 0 && ux.state === "idle") {
    const req = outgoingPending[0];
    const hostName = findLobbyById(state, req.lobbyId)?.hostPersonaName || "the host";
    reconcileChildren($list, [{
      key: "empty:request-pending",
      fp: `req:${req.lobbyId}:${esc(hostName)}`,
      render: () => `
        <div class="coop-empty-card coop-empty-card--compact coop-empty-card--inline">
          <div class="coop-empty-card-text">
            <h4 class="coop-empty-title">Seat request pending</h4>
            <p class="coop-empty-body">Waiting for ${esc(hostName)} to accept. Best matches resume after you cancel or get accepted.</p>
          </div>
          <button class="btn-ghost btn-sm" type="button" data-coop-action="cancel-join" data-lobby="${esc(req.lobbyId)}">Cancel Request</button>
        </div>`,
    }]);
    return;
  }

  if (allRecs.length === 0) {
    reconcileChildren($list, [{
      key: "empty:no-recs",
      fp: "empty:no-recs",
      render: () => `
        <div class="coop-empty-card coop-empty-card--compact coop-empty-card--inline">
          <div class="coop-empty-card-text">
            <h4 class="coop-empty-title">No best matches yet</h4>
            <p class="coop-empty-body">Set your Run Preferences or post a run so players can find you.</p>
          </div>
          <div class="coop-empty-actions">
            <button class="btn-ghost btn-sm" type="button" data-coop-action="open-intent">Run Preferences</button>
          </div>
        </div>`,
    }]);
    return;
  }
  const me = state.presence;
  const recs = allRecs.filter((r) => recMatchesText(r, recsSearchQuery));
  if (recs.length === 0) {
    reconcileChildren($list, [{
      key: "empty:no-search-match",
      fp: `search:${recsSearchQuery}`,
      render: () => `
        <div class="coop-empty-card coop-empty-card--compact coop-empty-card--inline">
          <div class="coop-empty-card-text">
            <h4 class="coop-empty-title">No matches for &ldquo;${esc(recsSearchQuery)}&rdquo;</h4>
            <p class="coop-empty-body">Try a different name, ascension number, or character.</p>
          </div>
          <button class="btn-ghost btn-sm" type="button" id="coop-recs-clear-search">Clear search</button>
        </div>`,
    }]);
    document.getElementById("coop-recs-clear-search")?.addEventListener("click", () => {
      recsSearchQuery = "";
      const $s = document.getElementById("coop-recs-search");
      if ($s) $s.value = "";
      renderRecommendations(lastState, coopUxFromState(lastState));
    });
    return;
  }
  const pendingByLobby = new Map(
    (state.outgoingJoinRequests || [])
      .filter((r) => r.status === "pending")
      .map((r) => [r.lobbyId, r]),
  );
  const matchLobbies = visibleOpenLobbies(state)
    .filter((l) => l.hostSteamId !== mySid && openSeats(l) > 0 && relevanceScore(l, me) >= 2)
    .filter((l) => !pendingLobbyIds.has(l.lobbyId))
    .filter((l) => lobbyMatchesText(l, recsSearchQuery))
    .sort((a, b) => relevanceScore(b, me) - relevanceScore(a, me));
  const useLobbies = matchLobbies.length > 0;
  const items = useLobbies ? matchLobbies : recs;
  const slice = items.slice(0, recsVisible);
  const remaining = items.length - slice.length;

  const blocks = [];
  if (recsSearchQuery) {
    blocks.push({
      key: "rec-stats",
      fp: `srch:${slice.length}:${items.length}:${recsSearchQuery}`,
      render: () => `<p class="coop-filter-stats">Showing ${slice.length} of ${items.length} matching &ldquo;${esc(recsSearchQuery)}&rdquo;</p>`,
    });
  } else if (useLobbies) {
    blocks.push({
      key: "rec-stats",
      fp: "rec-stats:compat",
      render: () => `<p class="coop-filter-stats">Compatible open run lobbies for you</p>`,
    });
  }
  const pairedSessionId = state.session && state.session.status === "active"
    ? state.session.sessionId : null;
  for (const item of slice) {
    if (useLobbies) {
      blocks.push({
        key: `rec-lobby:${item.lobbyId}`,
        fp: fpOf({
          c: 1,
          s: pairedSessionId,
          p: pendingByLobby.get(item.lobbyId)?.requestId || null,
          m: mySid || "",
          l: lobbyCardFields(item),
        }),
        render: () => renderLobbyCard(item, mySid, pendingByLobby, state, true),
      });
    } else {
      blocks.push({
        key: `rec-user:${item.steamId || item.steamID || ""}`,
        fp: fpOf({
          m: mySid || "",
          me: me ? { g: me.goal, am: me.ascensionMin, aM: me.ascensionMax, v: me.voicePreference, pc: preferredCharactersOf(me) } : null,
          r: {
            sid: item.steamId || item.steamID || "",
            n: item.personaName,
            a: item.avatarUrl,
            g: item.goal,
            am: item.ascensionMin,
            aM: item.ascensionMax,
            v: item.voicePreference,
            d: item.hasDiscord,
            no: item.note,
            pc: item.preferredCharacters || [],
            lb: item.label,
            st: item.status,
            hb: item.lastHeartbeatAt,
          },
        }),
        render: () => renderRecCard(item, me),
      });
    }
  }
  if (remaining > 0) {
    const showMoreCount = Math.min(CARDS_PAGE, remaining);
    blocks.push({
      key: "rec-load-more",
      fp: `rec-load-more:${showMoreCount}:${remaining}`,
      render: () => `<div class="coop-load-more"><button class="coop-load-more-btn" id="coop-load-more-recs">Show ${showMoreCount} more <span class="coop-load-more-count">(${remaining} left)</span></button></div>`,
    });
  }
  reconcileChildren($list, blocks);
  const $loadMore = document.getElementById("coop-load-more-recs");
  if ($loadMore && !$loadMore.__coopRecsBound) {
    $loadMore.__coopRecsBound = true;
    $loadMore.addEventListener("click", () => {
      recsVisible += CARDS_PAGE;
      renderRecommendations(lastState, resolveCoopUxState(lastState, lastState?.presence?.steamId));
    });
  }
}

/**
 * Mount a slim search input above the Best Matches list the first
 * time recs render. Idempotent — repeat calls bail out.
 */
function ensureRecsSearchUI() {
  if (document.getElementById("coop-recs-search-bar")) return;
  const $section = document.getElementById("coop-recs-section");
  const $list = document.getElementById("coop-recs-list");
  if (!$section || !$list) return;
  const wrap = document.createElement("div");
  wrap.id = "coop-recs-search-bar";
  wrap.className = "coop-filter-bar coop-filter-bar--compact";
  wrap.innerHTML = `
    <label class="coop-search" for="coop-recs-search">
      <svg class="coop-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.6"/>
        <path d="M10.5 10.5 L13.5 13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <input
        id="coop-recs-search"
        type="search"
        class="coop-search-input"
        placeholder="Search matches (name, Discord, A8…)"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search best matches"
      />
    </label>`;
  $section.insertBefore(wrap, $list);
  const $input = wrap.querySelector("#coop-recs-search");
  if ($input) {
    let t = null;
    $input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        recsSearchQuery = String($input.value || "").trim();
        recsVisible = CARDS_PAGE;
        renderRecommendations(lastState, coopUxFromState(lastState));
      }, 120);
    });
  }
}

/**
 * Build a short, human "why this match" rationale from the rec and the
 * current user's presence. Returns 2–3 concrete reasons separated by
 * `·`, e.g. "Same goal · A8–10 overlap · Voice · Discord". Falls back
 * to a neutral string when no reasons stand out so the UI is always
 * filled.
 */
function rationaleFor(rec, me) {
  if (!rec) return "";
  const reasons = [];
  const myGoal = me?.goal || "";
  const theirGoal = rec.goal || "";
  if (myGoal && theirGoal && (myGoal === theirGoal || myGoal === "any" || theirGoal === "any")) {
    reasons.push(myGoal === "any" || theirGoal === "any" ? "Any goal" : `Same goal · ${goalLabel(theirGoal)}`);
  } else if (theirGoal) {
    reasons.push(goalLabel(theirGoal));
  }
  const myLo = me?.ascensionMin ?? 0, myHi = me?.ascensionMax ?? GAME_CONFIG.maxAscension;
  const tLo = rec.ascensionMin ?? 0, tHi = rec.ascensionMax ?? GAME_CONFIG.maxAscension;
  if (myLo <= tHi && tLo <= myHi) {
    const lo = Math.max(myLo, tLo);
    const hi = Math.min(myHi, tHi);
    reasons.push(lo === hi ? `A${lo} overlap` : `A${lo}–A${hi} overlap`);
  }
  const myVoice = me?.voicePreference;
  const tVoice = rec.voicePreference;
  if (myVoice && tVoice) {
    if (myVoice === tVoice && myVoice === "yes") reasons.push("Voice chat");
    else if (myVoice === tVoice && myVoice === "no") reasons.push("No voice");
    else if (myVoice === "optional" || tVoice === "optional") reasons.push("Voice flexible");
  }
  if (rec.hasDiscord && (myVoice === "yes" || myVoice === "optional")) {
    reasons.push("Discord ready");
  }
  const myChars = new Set(preferredCharactersOf(me));
  const sharedChar = preferredCharactersOf(rec).find((c) => myChars.has(c));
  if (sharedChar) reasons.push(`${characterLabel(sharedChar)} match`);
  if (reasons.length === 0) {
    return statusLabel(rec.status || "looking");
  }
  return reasons.slice(0, 3).join(" · ");
}

function renderRecCard(rec, me) {
  const cls = ({
    "Strong match": "coop-rec-card--strong",
    "Good match": "coop-rec-card--good",
    "Different goal": "coop-rec-card--different",
    "Recently active": "",
  })[rec.label] || "";
  const matchBadgeCls = ({
    "Strong match": "coop-badge--match-strong",
    "Good match": "coop-badge--match-good",
    "Different goal": "coop-badge--match-different",
    "Recently active": "coop-badge--match-recent",
  })[rec.label] || "coop-badge--match-recent";
  const badges = [
    `<span class="coop-badge ${matchBadgeCls}">${esc(rec.label || "Match")}</span>`,
    `<span class="coop-badge coop-badge--goal">${esc(goalLabel(rec.goal))}</span>`,
    `<span class="coop-badge coop-badge--asc">${esc(ascensionLabel(rec.ascensionMin, rec.ascensionMax))}</span>`,
    firstPreferredCharacter(rec) ? `<span class="coop-badge coop-badge--character">${esc(characterLabel(firstPreferredCharacter(rec)))}</span>` : "",
    rec.voicePreference ? `<span class="coop-badge coop-badge--voice">${esc(voiceLabel(rec.voicePreference))}</span>` : "",
    rec.hasDiscord ? `<span class="coop-badge coop-badge--discord">Discord</span>` : "",
  ].filter(Boolean).join("");
  const rationale = rationaleFor(rec, me);
  return `
    <article class="coop-rec-card ${cls}" data-rec-sid="${esc(rec.steamId)}">
      <div class="coop-rec-head">
        <img class="avatar" src="${esc(rec.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div style="min-width:0;flex:1;">
          <h4 class="coop-rec-name">${esc(rec.personaName)}</h4>
          <span class="coop-rec-sub">${esc(statusLabel(rec.status || "looking"))} · <span data-since="${esc(rec.lastHeartbeatAt)}">${esc(formatRelative(rec.lastHeartbeatAt))}</span></span>
        </div>
      </div>
      <div class="coop-badge-row">${badges}</div>
      ${rationale ? `<p class="coop-rec-rationale" title="Why this match"><span class="coop-rec-rationale-key">Match:</span> ${esc(rationale)}</p>` : ""}
      ${(() => { const n = decodeStart(rec.note).cleanNote; return n ? `<p class="coop-lobby-note">&ldquo;${esc(n)}&rdquo;</p>` : ""; })()}
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-sm" data-coop-action="start-run-lobby" data-hint="${esc(rec.personaName)}">Host a Room</button>
      </div>
    </article>`;
}

// =========================================================================
// Filter bar · chipbar + sort pills + density toggle
// =========================================================================
function wireFilterBar() {
  const $section = document.getElementById("coop-lobbies-section");
  if (!$section || document.getElementById("coop-lobby-filter-bar")) return;

  const bar = document.createElement("div");
  bar.className = "coop-filter-bar";
  bar.id = "coop-lobby-filter-bar";
  bar.innerHTML = `
    <label class="coop-search" for="coop-lobby-search">
      <svg class="coop-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.6"/>
        <path d="M10.5 10.5 L13.5 13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <input
        id="coop-lobby-search"
        type="search"
        class="coop-search-input"
        placeholder="Search lobbies (name, Discord, A8, Defect…)"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search open run lobbies"
      />
    </label>
    <div class="coop-filter-actions coop-filter-actions--primary">
      <div class="coop-sort-pills" id="coop-sort-pills">
        <button type="button" class="coop-sort-pill is-active" data-coop-sort="best">Best</button>
        <button type="button" class="coop-sort-pill" data-coop-sort="newest">New</button>
        <button type="button" class="coop-sort-pill" data-coop-sort="asc-level">Asc ↑</button>
      </div>
      <button type="button" class="coop-filter-toggle" id="coop-filter-toggle" aria-expanded="false" aria-controls="coop-filter-chips">Filters</button>
      <button type="button" class="coop-density-toggle${lobbyCompact ? " is-compact" : ""}" id="coop-density-toggle" title="Toggle compact view" aria-label="Toggle compact view" aria-pressed="${lobbyCompact}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect y="1" width="14" height="2" rx="1" fill="currentColor"/>
          <rect y="6" width="14" height="2" rx="1" fill="currentColor"/>
          <rect y="11" width="14" height="2" rx="1" fill="currentColor"/>
        </svg>
      </button>
    </div>
    <div class="coop-filter-row coop-filter-chips" id="coop-filter-chips" hidden>
      <div class="coop-chip-group" id="coop-chips-goal" role="group" aria-label="Filter by goal">
        <button type="button" class="coop-chip is-active" data-coop-filter="goal" data-value="">All</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="any">Any run</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="casual">Casual</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="climb">Climb</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="a20">High Asc</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="heart">Heart</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="daily">Daily</button>
      </div>
      <span class="coop-filter-divider" aria-hidden="true"></span>
      <div class="coop-chip-group" id="coop-chips-asc" role="group" aria-label="Filter by ascension">
        <button type="button" class="coop-chip is-active" data-coop-filter="asc" data-value="">Any A</button>
        <button type="button" class="coop-chip" data-coop-filter="asc" data-value="0-3">A0–3</button>
        <button type="button" class="coop-chip" data-coop-filter="asc" data-value="4-7">A4–7</button>
        <button type="button" class="coop-chip" data-coop-filter="asc" data-value="8-10">A8–10</button>
      </div>
      <span class="coop-filter-divider" aria-hidden="true"></span>
      <div class="coop-chip-group" id="coop-chips-voice" role="group" aria-label="Filter by voice preference">
        <button type="button" class="coop-chip is-active" data-coop-filter="voice" data-value="">Any</button>
        <button type="button" class="coop-chip" data-coop-filter="voice" data-value="yes">Voice</button>
        <button type="button" class="coop-chip" data-coop-filter="voice" data-value="no">No Voice</button>
      </div>
      <button type="button" class="coop-filter-clear" id="coop-filter-clear" hidden>Clear</button>
    </div>
  `;

  // Inject between the board header and the list
  const $header = $section.querySelector(".coop-board-head");
  const $list = document.getElementById("coop-lobbies-list");
  if ($header && $list) $section.insertBefore(bar, $list);
  else $section.prepend(bar);

  // Wire the search input — debounce light so each keystroke doesn't
  // re-render the whole list. A 120 ms debounce feels instant but
  // skips work between fast keystrokes.
  const $search = bar.querySelector("#coop-lobby-search");
  if ($search) {
    let t = null;
    $search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        lobbySearchQuery = String($search.value || "").trim();
        lobbiesVisible = CARDS_PAGE;
        syncChipUI();
        renderLobbies(lastState, coopUxFromState(lastState));
      }, 120);
    });
  }

  // Chip clicks (includes Clear button)
  bar.addEventListener("click", (e) => {
    if (e.target.closest("#coop-filter-toggle")) {
      filtersExpanded = !filtersExpanded;
      const $chips = document.getElementById("coop-filter-chips");
      const $btn = document.getElementById("coop-filter-toggle");
      if ($chips) $chips.hidden = !filtersExpanded;
      if ($btn) {
        $btn.setAttribute("aria-expanded", String(filtersExpanded));
        $btn.classList.toggle("is-active", filtersExpanded);
      }
      return;
    }
    if (e.target.closest("#coop-filter-clear")) {
      clearLobbyFilters();
      return;
    }
    const chip = e.target.closest("[data-coop-filter]");
    if (chip) {
      const dim = chip.dataset.coopFilter;
      lobbyFilters[dim] = chip.dataset.value;
      lobbiesVisible = CARDS_PAGE;
      syncChipUI();
      renderLobbies(lastState, coopUxFromState(lastState));
      return;
    }
    // Sort pills
    const pill = e.target.closest("[data-coop-sort]");
    if (pill) {
      lobbySort = pill.dataset.coopSort;
      lobbiesVisible = CARDS_PAGE;
      syncSortUI();
      renderLobbies(lastState, coopUxFromState(lastState));
      return;
    }
    // Density toggle
    if (e.target.closest("#coop-density-toggle")) {
      lobbyCompact = !lobbyCompact;
      try { localStorage.setItem("coop_compact", lobbyCompact ? "1" : "0"); } catch {}
      const $btn = document.getElementById("coop-density-toggle");
      if ($btn) {
        $btn.classList.toggle("is-compact", lobbyCompact);
        $btn.setAttribute("aria-pressed", String(lobbyCompact));
      }
      renderLobbies(lastState, coopUxFromState(lastState));
    }
  });
}

function syncChipUI() {
  ["goal", "asc", "voice"].forEach((dim) => {
    document.querySelectorAll(`[data-coop-filter="${dim}"]`).forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.value === lobbyFilters[dim]);
    });
  });
  const hasActive =
    lobbyFilters.goal !== "" ||
    lobbyFilters.asc !== "" ||
    lobbyFilters.voice !== "" ||
    lobbySearchQuery !== "";
  const $clear = document.getElementById("coop-filter-clear");
  if ($clear) $clear.hidden = !hasActive;
}

function syncSortUI() {
  document.querySelectorAll("[data-coop-sort]").forEach((pill) => {
    pill.classList.toggle("is-active", pill.dataset.coopSort === lobbySort);
  });
}

// =========================================================================
// Sidebar · How-it-works collapsible
// =========================================================================
function wireHowToToggle() {
  const $toggle = document.getElementById("coop-howto-toggle");
  const $body = document.getElementById("coop-howto-body");
  if (!$toggle || !$body) return;
  $toggle.addEventListener("click", () => {
    const expanded = $toggle.getAttribute("aria-expanded") === "true";
    $toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    $body.hidden = expanded;
  });
}

// =========================================================================
// Modals
// =========================================================================
function openModal(id, opts = {}) {
  const $m = document.getElementById(id);
  if (!$m) return;
  $m.hidden = false;
  document.body.style.overflow = "hidden";
  if (opts.focus !== false) {
    setTimeout(() => {
      const $first = $m.querySelector("input, select, button:not([data-coop-modal-close])");
      $first?.focus?.();
    }, 30);
  }
}
function closeModal(id) {
  const $m = document.getElementById(id);
  if (!$m) return;
  $m.hidden = true;
  // Only release body scroll lock if no other coop modal is open.
  const anyOpen = ["coop-modal-intent", "coop-modal-lobby", "coop-modal-quickmatch", "coop-modal-character", "invite-modal"]
    .some((mid) => mid !== id && !document.getElementById(mid)?.hidden);
  if (!anyOpen) document.body.style.overflow = "";
  // Clear transient form errors.
  const $err = $m.querySelector(".coop-form-error");
  if ($err) { $err.hidden = true; $err.textContent = ""; }
  if (id === "coop-modal-character") pendingCharacterJoin = null;
}
function showFormError(modalId, msg) {
  const $err = document.getElementById(modalId)?.querySelector(".coop-form-error");
  if (!$err) return;
  $err.textContent = msg;
  $err.hidden = false;
}

function closeAllCoopModals() {
  ["coop-modal-intent", "coop-modal-lobby", "coop-modal-quickmatch", "coop-modal-character"].forEach((id) => {
    const $m = document.getElementById(id);
    if ($m && !$m.hidden) closeModal(id);
  });
}

function wireModalCloseHandlers() {
  document.addEventListener("click", (e) => {
    const close = e.target.closest("[data-coop-modal-close]");
    if (close) {
      const modal = close.closest(".modal-backdrop");
      if (modal?.id) closeModal(modal.id);
      return;
    }
    // Click outside the modal contents → close.
    const backdrop = e.target.classList?.contains("coop-modal-backdrop") ? e.target : null;
    if (backdrop && backdrop.id) closeModal(backdrop.id);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    ["coop-modal-intent", "coop-modal-lobby", "coop-modal-quickmatch", "coop-modal-character"].forEach((id) => {
      const $m = document.getElementById(id);
      if ($m && !$m.hidden) closeModal(id);
    });
  });
}

// ── Run Preferences modal ─────────────────────────────────────────────
function openIntentModal() {
  const cur = lastState?.presence?.status || (document.querySelector('input[name="status"]:checked') || {}).value || "looking";
  setRadio("modal-status", cur);
  openModal("coop-modal-intent");
}

function wireIntentForm() {
  const $form = document.getElementById("coop-intent-form");
  if (!$form) return;
  $form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const $btn = document.getElementById("coop-intent-save");
    if ($btn?.classList.contains("is-busy")) return;
    const status = (document.querySelector('input[name="modal-status"]:checked') || {}).value
      || (document.querySelector('input[name="status"]:checked') || {}).value
      || "looking";
    const ascMin = parseIntOrUndef(document.getElementById("coop-asc-min")?.value);
    const ascMax = parseIntOrUndef(document.getElementById("coop-asc-max")?.value);
    if (ascMin != null && ascMax != null && ascMin > ascMax) {
      showFormError("coop-modal-intent", "Ascension min can't be higher than ascension max.");
      return;
    }
    const body = {
      status,
      goal: document.getElementById("coop-goal")?.value || undefined,
      ascensionMin: ascMin,
      ascensionMax: ascMax,
      voicePreference: document.getElementById("coop-voice")?.value || undefined,
      preferredCharacters: preferredCharactersPayload(selectedRadioValue("intentPreferredCharacter")),
      discordHandle: document.getElementById("me-discord")?.value?.trim() || undefined,
      note: document.getElementById("coop-note")?.value?.trim() || undefined,
    };
    setBusy($btn, true);
    const r = await jsonFetch("/coop/presence", { body });
    setBusy($btn, false);
    if (!r.ok) { showFormError("coop-modal-intent", r.message || "Couldn't save your preferences."); return; }
    setRadioAndFire("status", status);
    bootCtx.deps?.toast?.("Preferences saved.");
    closeModal("coop-modal-intent");
    await refreshState({ force: true });
  });
}

// Helper used by visible status pill changes (Looking / AFK / etc.).
async function savePresence({ silent } = {}) {
  const body = {
    status: (document.querySelector('input[name="status"]:checked') || {}).value || "looking",
    goal: document.getElementById("coop-goal")?.value || undefined,
    ascensionMin: parseIntOrUndef(document.getElementById("coop-asc-min")?.value),
    ascensionMax: parseIntOrUndef(document.getElementById("coop-asc-max")?.value),
    voicePreference: document.getElementById("coop-voice")?.value || undefined,
    preferredCharacters: preferredCharactersPayload(selectedRadioValue("intentPreferredCharacter")),
    discordHandle: document.getElementById("me-discord")?.value?.trim() || undefined,
    note: document.getElementById("coop-note")?.value?.trim() || undefined,
  };
  const r = await jsonFetch("/coop/presence", { body });
  if (!r.ok) { bootCtx.deps?.toast?.(r.message); return false; }
  if (!silent) bootCtx.deps?.toast?.("Status saved.");
  await refreshState({ force: true });
  return true;
}

function parseIntOrUndef(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── Create / Edit Run Lobby modal ────────────────────────────────────
let editingLobbyId = null;

function openCreateLobbyModal() {
  editingLobbyId = null;
  const $form = document.getElementById("coop-lobby-form");
  if ($form) $form.reset();
  // Seed sensible defaults from the user's saved Run Preferences.
  const p = lastState?.presence;
  if (p && $form) {
    $form.elements["goal"].value = p.goal || "any";
    $form.elements["voicePreference"].value = p.voicePreference || "";
    if (p.ascensionMin != null) $form.elements["ascensionMin"].value = p.ascensionMin;
    if (p.ascensionMax != null) $form.elements["ascensionMax"].value = p.ascensionMax;
    if (p.discordHandle) $form.elements["discordHandle"].value = p.discordHandle;
    setCharacterRadio("preferredCharacter", firstPreferredCharacter(p));
  }
  document.getElementById("coop-modal-lobby-title").textContent = "Host a Room";
  document.getElementById("coop-lobby-save").textContent = "Host Room";
  // Reset the Close Room button — only the edit path should reveal it.
  const $closeBtnHost = document.getElementById("coop-lobby-close");
  if ($closeBtnHost) {
    $closeBtnHost.hidden = true;
    delete $closeBtnHost.dataset.id;
  }
  renderLobbyPreviewFromForm();
  openModal("coop-modal-lobby");
}

function openEditLobbyModal(lobbyId) {
  const lobby = (lastState?.lobby?.lobbyId === lobbyId) ? lastState.lobby : null;
  if (!lobby) return;
  editingLobbyId = lobbyId;
  const $form = document.getElementById("coop-lobby-form");
  if ($form) {
    $form.reset();
    $form.elements["title"].value = lobby.title || "";
    $form.elements["goal"].value = lobby.goal || "any";
    $form.elements["voicePreference"].value = lobby.voicePreference || "";
    if (lobby.ascensionMin != null) $form.elements["ascensionMin"].value = lobby.ascensionMin;
    if (lobby.ascensionMax != null) $form.elements["ascensionMax"].value = lobby.ascensionMax;
    if (lobby.discordHandle) $form.elements["discordHandle"].value = lobby.discordHandle;
    if (lobby.note) $form.elements["note"].value = lobby.note;
    setCharacterRadio("preferredCharacter", firstPreferredCharacter(lobby));
    if ($form.elements["lobbySize"]) {
      $form.elements["lobbySize"].value = String(lobbySizeOf(lobby));
    }
  }
  document.getElementById("coop-modal-lobby-title").textContent = "Edit Posted Run";
  document.getElementById("coop-lobby-save").textContent = "Save changes";
  // Reveal the in-modal "Close Room" button. The Beta party-finder
  // surface replaces the primary "Your room is open" hosting card
  // (which has its own Close Room button) with its own hero, so a
  // host who clicks Manage from the Beta view had no visible way to
  // close the lobby. Surfacing the destructive action here means
  // every entry-path to the lobby management modal can also exit
  // the lobby. The button uses data-id which we stamp now so the
  // single global delegated handler (case "close-lobby") can route
  // it through the normal /coop/lobbies/:id/close path.
  const $closeBtn = document.getElementById("coop-lobby-close");
  if ($closeBtn) {
    $closeBtn.hidden = false;
    $closeBtn.dataset.id = lobbyId;
  }
  renderLobbyPreviewFromForm();
  openModal("coop-modal-lobby");
}

function wireLobbyForm() {
  const $form = document.getElementById("coop-lobby-form");
  if (!$form) return;
  $form.addEventListener("input", renderLobbyPreviewFromForm);
  $form.addEventListener("change", renderLobbyPreviewFromForm);
  $form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const $btn = document.getElementById("coop-lobby-save");
    if ($btn?.classList.contains("is-busy")) return;
    const fd = new FormData($form);
    const title = String(fd.get("title") || "").trim();
    if (!title) { showFormError("coop-modal-lobby", "Run title is required."); return; }
    const ascMin = parseIntOrUndef(String(fd.get("ascensionMin") || ""));
    const ascMax = parseIntOrUndef(String(fd.get("ascensionMax") || ""));
    if (ascMin != null && ascMax != null && ascMin > ascMax) {
      showFormError("coop-modal-lobby", "Ascension min can't be higher than ascension max.");
      return;
    }
    // STS2 ascension cap. The backend still tolerates 0..20 for legacy
    // records, but we don't let new posts exceed A10 from the UI.
    const overCap = (n) => n != null && n > GAME_CONFIG.maxAscension;
    if (overCap(ascMin) || overCap(ascMax)) {
      showFormError("coop-modal-lobby", `Ascension goes up to A${GAME_CONFIG.maxAscension} in ${GAME_CONFIG.game}.`);
      return;
    }
    const sizeRaw = parseInt(String(fd.get("lobbySize") || "4"), 10);
    const lobbySize = sizeRaw === 2 || sizeRaw === 3 || sizeRaw === 4 ? sizeRaw : 4;
    const body = {
      title,
      goal: String(fd.get("goal") || "any"),
      lobbySize,
      ascensionMin: ascMin,
      ascensionMax: ascMax,
      voicePreference: String(fd.get("voicePreference") || "") || undefined,
      preferredCharacters: preferredCharactersPayload(String(fd.get("preferredCharacter") || "")),
      discordHandle: String(fd.get("discordHandle") || "").trim() || undefined,
      note: String(fd.get("note") || "").trim() || undefined,
    };
    // Legacy "Host a Room" form submission GA event. Paired with
    // lobby_quick_host_success so we can A/B which path actually
    // creates rooms in production. Edit submissions are excluded.
    const isCreate = !editingLobbyId;
    const formStartedAt = Date.now();
    if (isCreate) {
      fireQuickHostTelemetry("lobby_host_form_submit", {
        goal: body.goal,
        lobby_size: body.lobbySize,
        has_voice: body.voicePreference ? 1 : 0,
        has_character: (body.preferredCharacters || []).length > 0 ? 1 : 0,
        has_note: body.note ? 1 : 0,
      });
    }
    setBusy($btn, true);
    const r = editingLobbyId
      ? await jsonFetch(`/coop/lobbies/${editingLobbyId}`, { method: "PATCH", body })
      : await jsonFetch("/coop/lobbies", { body });
    setBusy($btn, false);
    if (!r.ok) {
      if (isCreate) {
        fireQuickHostTelemetry("lobby_host_form_error", {
          error_code: r.error || "unknown",
          http_status: r.status ?? 0,
          elapsed_ms: Date.now() - formStartedAt,
        });
      }
      showFormError("coop-modal-lobby", r.message || "Could not save your room.");
      return;
    }
    if (isCreate) {
      fireQuickHostTelemetry("lobby_host_form_success", {
        lobby_id: r.lobbyId || r.lobby?.lobbyId || "",
        elapsed_ms: Date.now() - formStartedAt,
      });
    }
    bootCtx.deps?.toast?.(editingLobbyId ? "Room updated." : "Room hosted.");
    editingLobbyId = null;
    closeModal("coop-modal-lobby");
    await refreshState({ force: true });
  });
}

function renderLobbyPreviewFromForm() {
  const $form = document.getElementById("coop-lobby-form");
  const $preview = document.getElementById("coop-lobby-preview");
  if (!$form || !$preview) return;
  const fd = new FormData($form);
  const title = String(fd.get("title") || "").trim() || "Your room";
  const goal = String(fd.get("goal") || "any");
  const voice = String(fd.get("voicePreference") || "");
  const ascMin = parseIntOrUndef(String(fd.get("ascensionMin") || ""));
  const ascMax = parseIntOrUndef(String(fd.get("ascensionMax") || ""));
  const note = String(fd.get("note") || "").trim();
  const discord = String(fd.get("discordHandle") || "").trim();
  const preferredCharacter = normalizeCharacterId(String(fd.get("preferredCharacter") || ""));
  const me = lastState?.presence;
  const avatar = me?.avatarUrl || "/assets/vault-mark.svg";
  const persona = me?.personaName || "you";
  const badges = [
    `<span class="coop-badge coop-badge--status-open">Open</span>`,
    `<span class="coop-badge coop-badge--goal">${esc(goalLabel(goal))}</span>`,
    `<span class="coop-badge coop-badge--asc">${esc(ascensionLabel(ascMin, ascMax))}</span>`,
    voice ? `<span class="coop-badge coop-badge--voice">${esc(voiceLabel(voice))}</span>` : "",
    `<span class="coop-badge coop-badge--character">${esc(preferredCharacter ? characterLabel(preferredCharacter) : "Open to any")}</span>`,
    `<span class="coop-badge coop-badge--players">1/${esc(String(fd.get("lobbySize") || "4"))}</span>`,
    discord ? `<span class="coop-badge coop-badge--discord">Discord</span>` : "",
  ].filter(Boolean).join("");
  $preview.innerHTML = `
    <div class="coop-lobby-card-head">
      <img class="avatar" src="${esc(avatar)}" alt="" />
      <div class="coop-lobby-card-title">
        <h4>${esc(title)}</h4>
        <span class="coop-lobby-host">Hosted by <strong>${esc(persona)}</strong></span>
      </div>
    </div>
    ${renderCharacterStrip(preferredCharacter ? [preferredCharacter] : [])}
    <div class="coop-badge-row">${badges}</div>
    ${note ? `<p class="coop-lobby-note">&ldquo;${esc(note)}&rdquo;</p>` : ""}`;
}

// ── Join / Request character picker ─────────────────────────────────
let pendingCharacterJoin = null;

function occupiedCharactersForLobby(lobby) {
  // The host's selected character is stored as the room preference.
  // Party members beyond the host get saved once they enter Party Hub.
  return preferredCharactersOf(lobby);
}

function renderJoinCharacterChoices(lobby) {
  const occupied = new Set(occupiedCharactersForLobby(lobby));
  const firstAvailable = COOP_CHARACTERS.find((c) => !occupied.has(c.id))?.id || COOP_CHARACTERS[0].id;
  return COOP_CHARACTERS.map((c) => {
    const disabled = occupied.has(c.id);
    const checked = c.id === firstAvailable;
    return `
      <label class="coop-character-choice${disabled ? " is-disabled" : ""}" title="${disabled ? `${esc(c.label)} is already claimed by the host` : `Play ${esc(c.label)}`}">
        <input type="radio" name="joinCharacter" value="${esc(c.id)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} />
        <img src="${esc(characterAssetSrc(c.id))}" alt="" />
        <span class="coop-character-name">${esc(c.label)}${disabled ? " claimed" : ""}</span>
      </label>`;
  }).join("");
}

function openJoinCharacterModal(lobbyId, action, triggerBtn) {
  const lobby = findLobbyById(lastState, lobbyId);
  if (!lobby) {
    bootCtx?.deps?.toast?.("Room not found.");
    return;
  }
  pendingCharacterJoin = { lobbyId, action, triggerBtn };
  const $title = document.getElementById("coop-modal-character-title");
  const $sub = document.getElementById("coop-character-modal-sub");
  const $summary = document.getElementById("coop-character-room-summary");
  const $grid = document.getElementById("coop-join-character-grid");
  const $confirm = document.getElementById("coop-character-confirm");
  const preferred = firstPreferredCharacter(lobby);
  const hostLine = preferred
    ? `${lobby.hostPersonaName || "Host"} is playing ${characterLabel(preferred)}. That portrait is greyed out.`
    : `${lobby.hostPersonaName || "Host"} is open to any character.`;
  if ($title) $title.textContent = action === "request-join" ? "Request a seat" : "Join this room";
  if ($sub) $sub.textContent = "Pick the character you plan to play before taking a seat.";
  if ($summary) {
    $summary.innerHTML = `
      <h4 class="coop-character-room-title">${esc(lobby.title || "Run room")}</h4>
      <p class="coop-character-room-meta">${esc(hostLine)} ${esc(ascensionLabel(lobby.ascensionMin, lobby.ascensionMax))} · ${esc(goalLabel(lobby.goal))}</p>`;
  }
  if ($grid) $grid.innerHTML = renderJoinCharacterChoices(lobby);
  if ($confirm) $confirm.textContent = action === "request-join" ? "Request Seat" : "Join Seat";
  const $err = document.getElementById("coop-character-error");
  if ($err) { $err.hidden = true; $err.textContent = ""; }
  openModal("coop-modal-character", { focus: false });
}

function wireCharacterModal() {
  const $form = document.getElementById("coop-character-form");
  if (!$form) return;
  $form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!pendingCharacterJoin) return;
    const selectedCharacter = normalizeCharacterId(selectedRadioValue("joinCharacter"));
    if (!selectedCharacter) {
      showFormError("coop-modal-character", "Pick the character you want to play.");
      return;
    }
    const $btn = document.getElementById("coop-character-confirm");
    if ($btn?.classList.contains("is-busy")) return;
    const { lobbyId, action, triggerBtn } = pendingCharacterJoin;
    const key = `${action}:${lobbyId}:${selectedCharacter}`;
    if (pendingActions.has(key)) return;
    pendingActions.add(key);
    setBusy($btn, true);
    if (triggerBtn && triggerBtn !== $btn) triggerBtn.classList.add("is-busy");
    const endpoint = action === "request-join"
      ? `/coop/lobbies/${lobbyId}/request`
      : `/coop/lobbies/${lobbyId}/join-seat`;
    const r = await jsonFetch(endpoint, { body: { selectedCharacter } });
    setBusy($btn, false);
    if (triggerBtn && triggerBtn !== $btn) triggerBtn.classList.remove("is-busy");
    pendingActions.delete(key);
    if (!r.ok) {
      showFormError("coop-modal-character", r.message || "Couldn't join this room.");
      return;
    }
    closeModal("coop-modal-character");
    pendingCharacterJoin = null;
    if (action === "request-join") {
      bootCtx.deps?.toast?.("Seat request sent.");
      await refreshState({ force: true });
      return;
    }
    bootCtx.deps?.toast?.("You're in — opening Party Hub.");
    const pid = r.partyId || r.party?.partyId;
    if (pid) window.location.assign(`/party/${pid}`);
    else await refreshState({ force: true });
  });
}

// ── Quick Match confirmation modal ───────────────────────────────────
let pendingQuickMatchSid = null;

function openQuickMatchModal() {
  const lobbies = (lastState?.openLobbies || []).filter((l) => l.status === "open" && openSeats(l) > 0);
  const me = lastState?.presence;
  let topLobby = null;
  if (lobbies.length > 0 && me) {
    const scored = [...lobbies].sort((a, b) => relevanceScore(b, me) - relevanceScore(a, me));
    topLobby = scored[0];
  }
  const recs = lastState?.recommendedMatches || [];
  const top = topLobby ? null : recs[0];
  const $body = document.getElementById("coop-quickmatch-body");
  const $sub = document.getElementById("coop-quickmatch-sub");
  const $send = document.getElementById("coop-quickmatch-send");
  const $title = document.getElementById("coop-modal-quickmatch-title");
  const $err = document.getElementById("coop-quickmatch-error");
  if (!$body || !$sub || !$send) return;
  $err.hidden = true; $err.textContent = "";
  $send.onclick = null;
  if (topLobby) {
    pendingQuickMatchSid = null;
    const openJoin = !lobbyApprovalRequired(topLobby);
    if ($title) $title.textContent = openJoin ? "Join this room?" : "Request a seat?";
    $sub.textContent = "SpireVault found a compatible run lobby.";
    const seats = openSeats(topLobby);
    $body.innerHTML = `
      <article class="coop-quickmatch-card">
        <h4 class="coop-rec-name">${esc(topLobby.title)}</h4>
        <p class="coop-lobby-host">Hosted by ${esc(topLobby.hostPersonaName || "Steam user")}</p>
        ${renderCharacterStrip(preferredCharactersOf(topLobby))}
        <div class="coop-badge-row">
          <span class="coop-badge coop-badge--players">${lobbyMembers(topLobby).length}/${lobbySizeOf(topLobby)}</span>
          <span class="coop-badge coop-badge--need">Need +${seats}</span>
        </div>
      </article>`;
    $send.hidden = false;
    $send.textContent = openJoin ? "Choose Character" : "Request Seat";
    $send.onclick = () => {
      closeModal("coop-modal-quickmatch");
      openJoinCharacterModal(topLobby.lobbyId, openJoin ? "join-seat" : "request-join", $send);
    };
    openModal("coop-modal-quickmatch", { focus: false });
    return;
  }

  if (!top) {
    pendingQuickMatchSid = null;
    if ($title) $title.textContent = "No match found yet";
    $sub.textContent = "No compatible run lobbies or players are looking right now.";
    $body.innerHTML = `
      <div class="coop-quickmatch-empty">
        <p class="coop-empty-body">Host a Room so players can request a seat, or update your Run Preferences.</p>
        <div class="coop-empty-actions" style="margin-top:10px;">
          <button class="btn-primary btn-sm" type="button" data-coop-action="open-create-lobby">+ Host a Room</button>
          <button class="btn-ghost btn-sm" type="button" data-coop-action="open-intent">Run Preferences</button>
        </div>
      </div>`;
    $send.hidden = true;
  } else {
    pendingQuickMatchSid = top.steamId;
    if ($title) $title.textContent = "Host a room?";
    $sub.textContent = "SpireVault can help you host a room so compatible players can request a seat.";
    const badges = [
      `<span class="coop-badge coop-badge--match-strong">${esc(top.label || "Match")}</span>`,
      `<span class="coop-badge coop-badge--goal">${esc(goalLabel(top.goal))}</span>`,
      `<span class="coop-badge coop-badge--asc">${esc(ascensionLabel(top.ascensionMin, top.ascensionMax))}</span>`,
      top.voicePreference ? `<span class="coop-badge coop-badge--voice">${esc(voiceLabel(top.voicePreference))}</span>` : "",
    ].filter(Boolean).join("");
    $body.innerHTML = `
      <article class="coop-quickmatch-card">
        <div class="coop-rec-head">
          <img class="avatar" src="${esc(top.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
          <div style="min-width:0;flex:1;">
            <h4 class="coop-rec-name">${esc(top.personaName)}</h4>
            <span class="coop-rec-sub">${esc(statusLabel(top.status || "looking"))} · ${esc(formatRelative(top.lastHeartbeatAt))}</span>
          </div>
        </div>
        <div class="coop-badge-row">${badges}</div>
        ${(() => { const n = decodeStart(top.note).cleanNote; return n ? `<p class="coop-lobby-note">&ldquo;${esc(n)}&rdquo;</p>` : ""; })()}
      </article>`;
    $send.hidden = false;
    $send.textContent = "Host a Room";
    $send.onclick = () => {
      closeModal("coop-modal-quickmatch");
      openCreateLobbyModal();
      bootCtx.deps?.toast?.("Host a room — compatible players can request a seat.");
    };
  }
  openModal("coop-modal-quickmatch", { focus: false });
}

function wireQuickMatchModal() {
  /* Player-match confirm uses inline onclick in openQuickMatchModal. */
}

function pickInviteMessagePreset(me, candidate) {
  if (candidate?.voicePreference === "yes" || me?.voicePreference === "yes") return "coop_voice";
  // STS2 thresholds: "high ascension" means at least A8 (out of 10).
  const ascHigh = (me?.ascensionMin ?? 0) >= 8 || (candidate?.ascensionMin ?? 0) >= 8;
  if (ascHigh) return "coop_high";
  if ((me?.ascensionMax ?? GAME_CONFIG.maxAscension) <= 3) return "coop_low";
  return "coop_any";
}

// =========================================================================
// Delegated click handler — all data-coop-action buttons
// =========================================================================
function wireDelegatedClicks() {
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-coop-action]");
    if (!btn) return;
    const action = btn.dataset.coopAction;

    // Cheap per-button anti-double-submit (network actions only).
    const key = `${action}:${btn.dataset.id || ""}:${btn.dataset.lobby || ""}:${btn.dataset.from || ""}`;

    switch (action) {
      case "quick-host":
        await handleQuickHostClick();
        return;
      case "open-intent": closeAllCoopModals(); openIntentModal(); return;
      case "open-create-lobby": closeAllCoopModals(); openCreateLobbyModal(); return;
      case "open-edit-lobby": closeAllCoopModals(); openEditLobbyModal(btn.dataset.id); return;
      case "quick-match": closeAllCoopModals(); openQuickMatchModal(); return;
      case "go-afk": setRadioAndFire("status", "afk"); void savePresence({ silent: false }); return;
      case "go-looking": setRadioAndFire("status", "looking"); void savePresence({ silent: false }); return;
      case "browse-lobbies": {
        const $board = document.getElementById("coop-lobbies-section");
        $board?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      case "leave-party":
        await doAction(key, btn, () => jsonFetch(`/coop/parties/${btn.dataset.id}/leave`, { body: {} }), "Left the party.");
        return;
      case "scroll-invites": {
        const $inv = document.getElementById("coop-invites-section");
        if ($inv && !$inv.hidden) $inv.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      case "copy": {
        const v = btn.dataset.value || "";
        try { await navigator.clipboard.writeText(v); } catch {}
        const orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = orig; }, 1400);
        return;
      }
      case "start-run-lobby": {
        closeAllCoopModals();
        openCreateLobbyModal();
        const hint = btn.dataset.hint;
        if (hint) bootCtx.deps?.toast?.(`Host a room — ${hint} can request a seat when they see it.`);
        return;
      }
      case "steam-sandbox":
        sandboxSteamToast();
        return;
      case "end-session":
        // Mark this end as locally-initiated so the next render
        // doesn't fire the partner-ended toast on top of our own
        // "Pairing ended." success message.
        localEndPairingPending = true;
        await doAction(key, btn, () => jsonFetch(`/coop/sessions/${btn.dataset.id}/end`, { body: {} }), "Pairing ended.");
        return;
      case "close-lobby": {
        // Confirm before destroying the lobby. Easy to mis-click the red
        // button inside the edit modal otherwise. The native `confirm`
        // dialog is intentional — no custom modal stacking on top of an
        // already-open edit modal.
        const confirmed = window.confirm(
          "Close this room? Any pending join requests will be cancelled and the lobby will be deleted.",
        );
        if (!confirmed) return;
        // Drop the edit modal first if it's the source of the click —
        // refreshState fires inside doAction and will repaint the page
        // against a now-deleted lobby. Closing the modal up front keeps
        // the user from staring at a form for a lobby that no longer
        // exists. Safe to call when the modal isn't open.
        editingLobbyId = null;
        closeModal("coop-modal-lobby");
        await doAction(
          key,
          btn,
          () => jsonFetch(`/coop/lobbies/${btn.dataset.id}/close`, { body: {} }),
          "Room closed.",
        );
        return;
      }
      case "join-seat":
        closeAllCoopModals();
        openJoinCharacterModal(btn.dataset.id, "join-seat", btn);
        return;
      case "copy-discord-lfg": {
        const lobby = findLobbyById(lastState, btn.dataset.id);
        if (!lobby) {
          bootCtx.deps?.toast?.("Room not found.");
          return;
        }
        const text = buildDiscordLfgPost(lobby);
        try { await navigator.clipboard.writeText(text); } catch {}
        // Magic-moment hint — only when the post carries a live
        // Discord timestamp tag (host set a planned start). That's
        // the killer "you can't get this from typing it yourself"
        // moment, and most users will miss it without a nudge.
        const hasLiveTag = /<t:\d+:R>/.test(text);
        bootCtx.deps?.toast?.(
          hasLiveTag
            ? "Discord LFG post copied — it'll live-update in your channel."
            : "Discord LFG post copied."
        );
        return;
      }
      case "request-join":
        closeAllCoopModals();
        openJoinCharacterModal(btn.dataset.id, "request-join", btn);
        return;
      case "cancel-join":
        await doAction(key, btn, () => jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/cancel-request`, { body: {} }), "Request cancelled.");
        return;
      case "accept-join": {
        const acceptKey = key;
        if (pendingActions.has(acceptKey)) return;
        pendingActions.add(acceptKey);
        btn.classList.add("is-busy");
        const r = await jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/accept`, {
          body: { fromSteamId: btn.dataset.from },
        });
        btn.classList.remove("is-busy");
        pendingActions.delete(acceptKey);
        if (!r.ok) {
          bootCtx.deps?.toast?.(r.message || "Couldn't accept seat request.");
          return;
        }
        bootCtx.deps?.toast?.("Seat accepted — opening Party Hub.");
        const pid = r.partyId || r.party?.partyId;
        if (pid) window.location.assign(`/party/${pid}`);
        else await refreshState({ force: true });
        return;
      }
      case "decline-join":
        await doAction(key, btn, () => jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/decline`, { body: { fromSteamId: btn.dataset.from } }), "Request declined.");
        return;
      case "accept-invite":
        await doAction(key, btn, () => jsonFetch(`/coop/invites/${btn.dataset.id}/accept`, { body: {} }), "Invite accepted!");
        return;
      case "decline-invite":
        await doAction(key, btn, () => jsonFetch(`/coop/invites/${btn.dataset.id}/decline`, { body: {} }), "Invite declined.");
        return;
      case "cancel-invite":
        await doAction(key, btn, () => jsonFetch(`/coop/invites/${btn.dataset.id}/cancel`, { body: {} }), "Invite cancelled.");
        return;
      default: return;
    }
  });
}

async function doAction(key, btn, fn, successMsg) {
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  setBusy(btn, true);
  try {
    const r = await fn();
    if (!r.ok) { bootCtx.deps?.toast?.(r.message || "Action failed."); return; }
    if (successMsg) bootCtx.deps?.toast?.(successMsg);
    await refreshState({ force: true });
  } finally {
    setBusy(btn, false);
    pendingActions.delete(key);
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.classList.toggle("is-busy", !!busy);
  btn.disabled = !!busy;
}

// =========================================================================
// Active player feed toggle (legacy roster lives below as long-tail)
// =========================================================================
function wireFeedToggle() {
  const $toggle = document.getElementById("coop-feed-toggle");
  const $feed = document.getElementById("feed");
  if (!$toggle || !$feed) return;
  $toggle.addEventListener("click", () => {
    const expanded = $toggle.getAttribute("aria-expanded") === "true";
    $toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    $feed.hidden = expanded;
    $toggle.textContent = expanded ? "Show all" : "Hide";
  });
}
