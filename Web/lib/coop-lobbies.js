// coop-lobbies.js — v11 (Co-op Lobby Beta surface)
// =========================================================================
// Drives the Co-op Lobby Beta surface:
//   A. Compact command bar with 3 stats + CTAs (Post a Run, Quick Match,
//      Run Preferences).
//   B. 2-col workspace:
//        main: Invites/requests · Open Run Lobbies · Best Matches
//        side: Your Status · Current Activity · How it works (collapsed)
//   C. Players Looking Now feed below the workspace (secondary surface,
//      also visible in Classic Co-op).
//
// User-facing wording is the only canonical vocabulary:
//   Post a Run         — primary CTA
//   Open Run Lobbies   — the board users browse + join
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

const GAME_CONFIG = Object.freeze({
  game: "Slay the Spire 2",
  maxAscension: 10,
});

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

// Client-side filter / sort / density state (no backend involvement)
const CARDS_PAGE = 12;
let lobbyFilters = { goal: "", asc: "", voice: "" };
let lobbySort = "best";
let lobbyCompact = (() => { try { return localStorage.getItem("coop_compact") === "1"; } catch { return false; } })();
let lobbiesVisible = CARDS_PAGE;
let recsVisible = CARDS_PAGE;

// =========================================================================
// Public API
// =========================================================================
export function mountCoopLobbies(ctx) {
  bootCtx = ctx;
  if (isMounted) return;
  isMounted = true;
  wireDelegatedClicks();
  wireModalCloseHandlers();
  wireIntentForm();
  wireLobbyForm();
  wireQuickMatchModal();
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
}

export function setCoopTabActive() {
  void refreshState({ force: true });
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
    decline_cooldown: "You declined this player recently — give it a bit.",
    network: "Network error. Check your connection.",
  };
  return map[code] || code.replaceAll("_", " ");
}

async function refreshState({ force = false } = {}) {
  if (!bootCtx?.session?.steamID) return;
  const r = await jsonFetch("/coop/state");
  if (!r.ok) {
    if (r.status === 401) bootCtx.deps?.onAuthFailure?.();
    return;
  }
  lastState = r;
  render(lastState);
  bootCtx.deps?.onStateRefresh?.(lastState);
}

async function sendHeartbeat() {
  if (!bootCtx?.session?.steamID) return;
  const r = await jsonFetch("/coop/heartbeat", { body: {} });
  if (!r.ok && r.status === 401) bootCtx.deps?.onAuthFailure?.();
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
  return ({ looking: "Looking", solo: "In solo run", paired: "Paired", afk: "AFK", offline: "Offline" })[s] || "Looking";
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
  reflectFormFromPresence(state.presence);
  renderBarStats(state);
  renderSideStatusCard(state);
  renderActivityCard(state);
  renderInvites(state);
  renderLobbies(state);
  renderRecommendations(state);

  const $count = document.getElementById("online-count");
  if ($count) $count.textContent = String(state.activePlayerFeed?.length || 0);
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
function renderBarStats(state) {
  const lobbies = state.openLobbies || [];
  const feed = state.activePlayerFeed || [];
  const lookingCount = feed.filter((p) => p.status === "looking").length;
  const activeCount = feed.length;

  setBarStat("coop-stat-lobbies", lobbies.length, { highlightOnNonZero: true });
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
      if ($txt) $txt.textContent = stale ? "Stale" : "Live";
    }
  }

  const $intent = document.getElementById("coop-strip-intent");
  if (!$intent) return;
  if (!p) {
    $intent.innerHTML = "";
    return;
  }
  const rows = [];
  rows.push(intentRow("Goal", goalLabel(p.goal || "any"), !p.goal));
  rows.push(intentRow("Asc", ascensionLabel(p.ascensionMin, p.ascensionMax), p.ascensionMin == null && p.ascensionMax == null));
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
// Sidebar · Current activity card — always painted (idle / paired /
// hosting / joined / incoming-invite). Lives inside #coop-active-state.
// =========================================================================
function renderActivityCard(state) {
  const $section = document.getElementById("coop-active-state");
  if (!$section) return;

  const me = state.presence;
  const session = state.session;
  const lobby = state.lobby;
  const incoming = state.incomingInvites || [];
  const incomingJoinReqs = state.incomingJoinRequests || [];
  const outgoingInvites = state.outgoingInvites || [];
  const outgoingJoinReqs = (state.outgoingJoinRequests || []).filter((r) => r.status === "pending");

  // 1) Paired (active pairing) — highest priority
  if (session && session.status === "active") {
    const partnerSid = (session.playerSteamIds || []).find((sid) => sid !== me?.steamId);
    const partner = (state.activePlayerFeed || []).find((p) => p.steamId === partnerSid);
    const name = partner?.personaName || "your co-op partner";
    const discord = partner?.discordHandle || "";
    $section.innerHTML = `
      <article class="coop-active-card coop-active-card--paired">
        <div class="coop-active-meta">
          <span class="coop-active-eyebrow">Active pairing</span>
          <h3 class="coop-active-title">Paired with ${esc(name)}</h3>
          <p class="coop-active-sub">Send the Steam invite from their profile. Steam handles the actual co-op invite.</p>
        </div>
        <div class="coop-active-actions">
          ${partnerSid ? `<a class="btn-primary btn-xs" target="_blank" rel="noopener" href="${esc(steamProfileUrl(partnerSid))}">Steam profile</a>` : ""}
          ${discord ? `<button class="btn-ghost btn-xs" data-coop-action="copy" data-value="${esc(discord)}">Copy Discord</button>` : ""}
          <button class="btn-ghost btn-xs" data-coop-action="end-session" data-id="${esc(session.sessionId)}">End Pairing</button>
        </div>
      </article>`;
    return;
  }

  // 2) Hosting a posted run
  if (lobby && lobby.hostSteamId === me?.steamId && lobby.status !== "closed") {
    const memberCount = lobby.memberSteamIds?.length || 1;
    const pendCount = incomingJoinReqs.length;
    $section.innerHTML = `
      <article class="coop-active-card coop-active-card--hosting">
        <div class="coop-active-meta">
          <span class="coop-active-eyebrow">You&rsquo;re hosting</span>
          <h3 class="coop-active-title">${esc(lobby.title)}</h3>
          <p class="coop-active-sub">${memberCount}/2 · ${
            pendCount > 0
              ? `<strong>${pendCount}</strong> pending request${pendCount === 1 ? "" : "s"}`
              : "Waiting for players to request to join."
          }</p>
        </div>
        <div class="coop-active-actions">
          ${pendCount > 0 ? `<button class="btn-primary btn-xs" data-coop-action="scroll-invites">Review requests</button>` : ""}
          <button class="btn-ghost btn-xs" data-coop-action="open-edit-lobby" data-id="${esc(lobby.lobbyId)}">Edit</button>
          <button class="btn-ghost btn-xs" data-coop-action="close-lobby" data-id="${esc(lobby.lobbyId)}">Close</button>
        </div>
      </article>`;
    return;
  }

  // 3) In someone else's posted run (member but not host, no pairing yet)
  if (lobby && lobby.hostSteamId !== me?.steamId && lobby.status !== "closed") {
    $section.innerHTML = `
      <article class="coop-active-card coop-active-card--joined">
        <div class="coop-active-meta">
          <span class="coop-active-eyebrow">You joined</span>
          <h3 class="coop-active-title">${esc(lobby.title)}</h3>
          <p class="coop-active-sub">Hosted by ${esc(lobby.hostPersonaName || "Steam user")}. Wait for the host to confirm.</p>
        </div>
        <div class="coop-active-actions">
          <a class="btn-ghost btn-xs" target="_blank" rel="noopener" href="${esc(steamProfileUrl(lobby.hostSteamId))}">Steam profile</a>
        </div>
      </article>`;
    return;
  }

  // 4) Incoming invites pending
  if (incoming.length > 0) {
    $section.innerHTML = `
      <article class="coop-active-card coop-active-card--joined">
        <div class="coop-active-meta">
          <span class="coop-active-eyebrow">Invites waiting</span>
          <h3 class="coop-active-title">${incoming.length} player${incoming.length === 1 ? "" : "s"} want${incoming.length === 1 ? "s" : ""} to co-op</h3>
          <p class="coop-active-sub">Respond before they expire — see Invites &amp; requests above.</p>
        </div>
        <div class="coop-active-actions">
          <button class="btn-primary btn-xs" data-coop-action="scroll-invites">View invites</button>
        </div>
      </article>`;
    return;
  }

  // 5) Outgoing invite / join request pending
  if (outgoingInvites.length > 0 || outgoingJoinReqs.length > 0) {
    const count = outgoingInvites.length + outgoingJoinReqs.length;
    $section.innerHTML = `
      <article class="coop-active-card coop-active-card--joined">
        <div class="coop-active-meta">
          <span class="coop-active-eyebrow">Waiting on others</span>
          <h3 class="coop-active-title">${count} pending invite${count === 1 ? "" : "s"} out</h3>
          <p class="coop-active-sub">You&rsquo;ll see a response here as soon as they reply.</p>
        </div>
        <div class="coop-active-actions">
          <button class="btn-ghost btn-xs" data-coop-action="scroll-invites">View</button>
        </div>
      </article>`;
    return;
  }

  // 6) Idle — default state
  $section.innerHTML = `
    <article class="coop-active-card coop-active-card--idle">
      <div class="coop-active-meta">
        <span class="coop-active-eyebrow">Ready</span>
        <h3 class="coop-active-title">Ready to find a run</h3>
        <p class="coop-active-sub">Post a run lobby, quick match, or browse open lobbies on the left.</p>
      </div>
      <div class="coop-active-actions">
        <button class="btn-primary btn-xs" data-coop-action="open-create-lobby">+ Post a Run</button>
        <button class="btn-ghost btn-xs" data-coop-action="quick-match">⚡ Quick Match</button>
      </div>
    </article>`;
}

// =========================================================================
// Invites & requests section (main column, above lobbies when active)
// =========================================================================
function renderInvites(state) {
  const $section = document.getElementById("coop-invites-section");
  const $list = document.getElementById("coop-invites-list");
  const $count = document.getElementById("coop-invites-count");
  if (!$section || !$list || !$count) return;
  const incoming = state.incomingInvites || [];
  const outgoing = state.outgoingInvites || [];
  const incomingJoinReqs = state.incomingJoinRequests || [];
  const outgoingJoinReqs = (state.outgoingJoinRequests || []).filter((r) => r.status === "pending");

  const total = incoming.length + outgoing.length + incomingJoinReqs.length + outgoingJoinReqs.length;
  $count.textContent = String(total);
  if (total === 0) {
    $section.hidden = true;
    $list.innerHTML = "";
    return;
  }
  $section.hidden = false;
  const cards = [
    ...incoming.map(renderIncomingInvite),
    ...incomingJoinReqs.map(renderIncomingJoinReq),
    ...outgoing.map(renderOutgoingInvite),
    ...outgoingJoinReqs.map(renderOutgoingJoinReq),
  ];
  $list.innerHTML = cards.join("");
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
        <span class="coop-invite-kind">Invite</span>
      </div>
      <p class="coop-invite-msg">${esc(presetMessage(i.messagePreset) || "Want to co-op?")}</p>
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-sm" data-coop-action="accept-invite" data-id="${esc(i.inviteId)}">Accept</button>
        <button class="btn-ghost btn-sm" data-coop-action="decline-invite" data-id="${esc(i.inviteId)}">Decline</button>
        <a class="btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(steamProfileUrl(i.fromSteamId))}">Steam profile</a>
      </div>
    </article>`;
}
function renderIncomingJoinReq(r) {
  return `
    <article class="coop-invite-card coop-invite-card--joinreq">
      <div class="coop-invite-card-head">
        <img class="avatar" src="${esc(r.fromAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-invite-meta">
          <strong>${esc(r.fromPersonaName || "Steam user")}</strong>
          <span class="coop-invite-expiry">wants to join your lobby · <span data-expires="${esc(r.expiresAt)}">${esc(formatCountdown(r.expiresAt))}</span></span>
        </div>
        <span class="coop-invite-kind">Join request</span>
      </div>
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-sm" data-coop-action="accept-join" data-lobby="${esc(r.lobbyId)}" data-from="${esc(r.fromSteamId)}">Accept</button>
        <button class="btn-ghost btn-sm" data-coop-action="decline-join" data-lobby="${esc(r.lobbyId)}" data-from="${esc(r.fromSteamId)}">Decline</button>
        <a class="btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(steamProfileUrl(r.fromSteamId))}">Steam profile</a>
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
function renderOutgoingJoinReq(r) {
  return `
    <article class="coop-invite-card coop-invite-card--outgoing">
      <div class="coop-invite-card-head">
        <div class="coop-invite-meta">
          <strong>Request sent</strong>
          <span class="coop-invite-expiry">waiting on host · expires in <span data-expires="${esc(r.expiresAt)}">${esc(formatCountdown(r.expiresAt))}</span></span>
        </div>
        <span class="coop-invite-kind">Sent</span>
      </div>
      <div class="coop-lobby-actions">
        <button class="btn-ghost btn-sm" data-coop-action="cancel-join" data-lobby="${esc(r.lobbyId)}">Cancel</button>
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
// Open Runs (posted runs that other players can request to join)
// =========================================================================
function renderLobbies(state) {
  const $list = document.getElementById("coop-lobbies-list");
  const $count = document.getElementById("coop-lobbies-count");
  if (!$list || !$count) return;

  const allLobbies = state.openLobbies || [];
  $count.textContent = String(allLobbies.length);

  if (allLobbies.length === 0) {
    $list.innerHTML = renderEmptyLobbies();
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
    $list.innerHTML = `
      <div class="coop-empty-card coop-empty-card--compact coop-empty-card--inline">
        <div class="coop-empty-card-text">
          <h4 class="coop-empty-title">No lobbies match your filters</h4>
          <p class="coop-empty-body">Try adjusting the goal, ascension, or voice filters above.</p>
        </div>
        <button class="btn-ghost btn-sm" type="button" id="coop-clear-filters">Clear filters</button>
      </div>`;
    document.getElementById("coop-clear-filters")?.addEventListener("click", clearLobbyFilters);
    return;
  }

  const slice = filtered.slice(0, lobbiesVisible);
  const remaining = filtered.length - slice.length;
  let html = "";
  if (filtered.length < allLobbies.length) {
    html += `<p class="coop-filter-stats">Showing ${Math.min(slice.length, filtered.length)} of ${filtered.length} matching (${allLobbies.length} total)</p>`;
  }
  html += slice.map((l) => renderLobbyCard(l, mySid, pendingByLobby, state, lobbyCompact)).join("");
  if (remaining > 0) {
    html += `<div class="coop-load-more"><button class="coop-load-more-btn" id="coop-load-more-lobbies">Show ${Math.min(CARDS_PAGE, remaining)} more <span class="coop-load-more-count">(${remaining} left)</span></button></div>`;
  }
  $list.innerHTML = html;
  if (lobbyCompact) $list.classList.add("is-compact");
  else $list.classList.remove("is-compact");
  document.getElementById("coop-load-more-lobbies")?.addEventListener("click", () => {
    lobbiesVisible += CARDS_PAGE;
    renderLobbies(lastState);
  });
}

function renderEmptyLobbies() {
  // Polished empty board. Lives INSIDE the Open Run Lobbies board
  // card so it inherits the panel's width and feels like part of a
  // real matchmaking surface, not a separate placeholder. Must not
  // wrap a single word per line at any desktop width.
  return `
    <div class="coop-empty-card coop-empty-card--openruns">
      <div class="coop-empty-card-text">
        <h4 class="coop-empty-title">No open run lobbies yet</h4>
        <p class="coop-empty-body">Post the first run lobby so players can request to join, then pair up and add each other on Steam.</p>
        <div class="coop-empty-actions">
          <button class="btn-primary btn-sm" type="button" data-coop-action="open-create-lobby">+ Post a Run</button>
          <button class="btn-ghost btn-sm" type="button" data-coop-action="quick-match">⚡ Quick Match</button>
        </div>
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
    const g = lobby.goal || "any";
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
  return true;
}

function clearLobbyFilters() {
  lobbyFilters = { goal: "", asc: "", voice: "" };
  lobbiesVisible = CARDS_PAGE;
  syncChipUI();
  renderLobbies(lastState);
}

function renderLobbyCard(lobby, mySid, pendingByLobby, state, compact = false) {
  const isMine = lobby.hostSteamId === mySid;
  const isMember = (lobby.memberSteamIds || []).includes(mySid);
  const pendingReq = pendingByLobby.get(lobby.lobbyId);
  const isFull = (lobby.memberSteamIds?.length || 0) >= 2 || lobby.status === "full";
  const isPaired = !!(state.session && state.session.status === "active");
  const cardClass = [
    "coop-lobby-card",
    isMine ? "coop-lobby-card--mine" : "",
    isPaired ? "coop-lobby-card--paired" : "",
    compact ? "coop-lobby-card--compact" : "",
  ].filter(Boolean).join(" ");
  const statusBadge = `
    <span class="coop-badge coop-badge--status-${esc(lobby.status)}">${esc(prettyStatus(lobby.status))}</span>`;
  const badges = [
    `<span class="coop-badge coop-badge--goal">${esc(goalLabel(lobby.goal))}</span>`,
    `<span class="coop-badge coop-badge--asc">${esc(ascensionLabel(lobby.ascensionMin, lobby.ascensionMax))}</span>`,
    lobby.voicePreference ? `<span class="coop-badge coop-badge--voice">${esc(voiceLabel(lobby.voicePreference))}</span>` : "",
    `<span class="coop-badge coop-badge--players">${(lobby.memberSteamIds?.length || 0)}/2</span>`,
    lobby.discordHandle ? `<span class="coop-badge coop-badge--discord">Discord</span>` : "",
  ].filter(Boolean).join("");

  let action = "";
  if (isMine) {
    action = `
      <button class="btn-ghost btn-sm" data-coop-action="open-edit-lobby" data-id="${esc(lobby.lobbyId)}">Edit</button>
      <button class="btn-ghost btn-sm" data-coop-action="close-lobby" data-id="${esc(lobby.lobbyId)}">Close</button>`;
  } else if (isMember) {
    action = `<span class="coop-badge coop-badge--players">You&rsquo;re in</span>`;
  } else if (isPaired) {
    action = `<span class="coop-badge">Paired</span>`;
  } else if (pendingReq) {
    action = `<button class="btn-ghost btn-sm" data-coop-action="cancel-join" data-lobby="${esc(lobby.lobbyId)}">Cancel request</button>`;
  } else if (isFull) {
    action = `<button class="btn-ghost btn-sm" disabled>Full</button>`;
  } else {
    action = `<button class="btn-primary btn-sm" data-coop-action="request-join" data-id="${esc(lobby.lobbyId)}">Request join</button>`;
  }

  return `
    <article class="${cardClass}" data-lobby-id="${esc(lobby.lobbyId)}">
      <div class="coop-lobby-card-head">
        <img class="avatar" src="${esc(lobby.hostAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-lobby-card-title">
          <h4>${esc(lobby.title)}</h4>
          <span class="coop-lobby-host">Hosted by <strong>${esc(lobby.hostPersonaName || "Steam user")}</strong></span>
        </div>
        <div class="coop-lobby-card-meta">${statusBadge}</div>
      </div>
      <div class="coop-badge-row">${badges}</div>
      ${lobby.note ? `<p class="coop-lobby-note">&ldquo;${esc(lobby.note)}&rdquo;</p>` : ""}
      <div class="coop-lobby-foot">
        <span class="coop-lobby-time" data-since="${esc(lobby.updatedAt)}">${esc(formatRelative(lobby.updatedAt))}</span>
        <div class="coop-lobby-actions">
          ${action}
          <a class="btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(steamProfileUrl(lobby.hostSteamId))}">Steam</a>
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
function renderRecommendations(state) {
  const $list = document.getElementById("coop-recs-list");
  const $count = document.getElementById("coop-recs-count");
  if (!$list || !$count) return;
  const recs = state.recommendedMatches || [];
  $count.textContent = String(recs.length);
  if (recs.length === 0) {
    $list.innerHTML = `
      <div class="coop-empty-card coop-empty-card--compact coop-empty-card--inline">
        <div class="coop-empty-card-text">
          <h4 class="coop-empty-title">No best matches yet</h4>
          <p class="coop-empty-body">Set your Run Preferences or post a run so players can find you.</p>
        </div>
        <div class="coop-empty-actions">
          <button class="btn-ghost btn-sm" type="button" data-coop-action="open-intent">Run Preferences</button>
        </div>
      </div>`;
    return;
  }
  const slice = recs.slice(0, recsVisible);
  const remaining = recs.length - slice.length;
  let html = slice.map(renderRecCard).join("");
  if (remaining > 0) {
    html += `<div class="coop-load-more"><button class="coop-load-more-btn" id="coop-load-more-recs">Show ${Math.min(CARDS_PAGE, remaining)} more <span class="coop-load-more-count">(${remaining} left)</span></button></div>`;
  }
  $list.innerHTML = html;
  document.getElementById("coop-load-more-recs")?.addEventListener("click", () => {
    recsVisible += CARDS_PAGE;
    renderRecommendations(lastState);
  });
}

function renderRecCard(rec) {
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
    rec.voicePreference ? `<span class="coop-badge coop-badge--voice">${esc(voiceLabel(rec.voicePreference))}</span>` : "",
    rec.hasDiscord ? `<span class="coop-badge coop-badge--discord">Discord</span>` : "",
  ].filter(Boolean).join("");
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
      ${rec.note ? `<p class="coop-lobby-note">&ldquo;${esc(rec.note)}&rdquo;</p>` : ""}
      <div class="coop-lobby-actions">
        <button class="btn-primary btn-sm" data-coop-action="invite-rec" data-id="${esc(rec.steamId)}" data-name="${esc(rec.personaName)}">Invite</button>
        <a class="btn-ghost btn-sm" target="_blank" rel="noopener" href="${esc(steamProfileUrl(rec.steamId))}">Steam</a>
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
    <div class="coop-filter-row">
      <div class="coop-chip-group" id="coop-chips-goal" role="group" aria-label="Filter by goal">
        <button type="button" class="coop-chip is-active" data-coop-filter="goal" data-value="">All</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="any">Any run</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="casual">Casual</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="climb">Climb</button>
        <button type="button" class="coop-chip" data-coop-filter="goal" data-value="high">High Asc</button>
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
    <div class="coop-filter-actions">
      <div class="coop-sort-pills" id="coop-sort-pills">
        <button type="button" class="coop-sort-pill is-active" data-coop-sort="best">Best</button>
        <button type="button" class="coop-sort-pill" data-coop-sort="newest">New</button>
        <button type="button" class="coop-sort-pill" data-coop-sort="asc-level">Asc ↑</button>
      </div>
      <button type="button" class="coop-density-toggle${lobbyCompact ? " is-compact" : ""}" id="coop-density-toggle" title="Toggle compact view" aria-label="Toggle compact view" aria-pressed="${lobbyCompact}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect y="1" width="14" height="2" rx="1" fill="currentColor"/>
          <rect y="6" width="14" height="2" rx="1" fill="currentColor"/>
          <rect y="11" width="14" height="2" rx="1" fill="currentColor"/>
        </svg>
      </button>
    </div>`;

  // Inject between the board header and the list
  const $header = $section.querySelector(".coop-board-head");
  const $list = document.getElementById("coop-lobbies-list");
  if ($header && $list) $section.insertBefore(bar, $list);
  else $section.prepend(bar);

  // Chip clicks (includes Clear button)
  bar.addEventListener("click", (e) => {
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
      renderLobbies(lastState);
      return;
    }
    // Sort pills
    const pill = e.target.closest("[data-coop-sort]");
    if (pill) {
      lobbySort = pill.dataset.coopSort;
      lobbiesVisible = CARDS_PAGE;
      syncSortUI();
      renderLobbies(lastState);
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
      renderLobbies(lastState);
    }
  });
}

function syncChipUI() {
  ["goal", "asc", "voice"].forEach((dim) => {
    document.querySelectorAll(`[data-coop-filter="${dim}"]`).forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.value === lobbyFilters[dim]);
    });
  });
  const hasActive = lobbyFilters.goal !== "" || lobbyFilters.asc !== "" || lobbyFilters.voice !== "";
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
  const anyOpen = ["coop-modal-intent", "coop-modal-lobby", "coop-modal-quickmatch", "invite-modal"]
    .some((mid) => mid !== id && !document.getElementById(mid)?.hidden);
  if (!anyOpen) document.body.style.overflow = "";
  // Clear transient form errors.
  const $err = $m.querySelector(".coop-form-error");
  if ($err) { $err.hidden = true; $err.textContent = ""; }
}
function showFormError(modalId, msg) {
  const $err = document.getElementById(modalId)?.querySelector(".coop-form-error");
  if (!$err) return;
  $err.textContent = msg;
  $err.hidden = false;
}

function closeAllCoopModals() {
  ["coop-modal-intent", "coop-modal-lobby", "coop-modal-quickmatch"].forEach((id) => {
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
    ["coop-modal-intent", "coop-modal-lobby", "coop-modal-quickmatch"].forEach((id) => {
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
  }
  document.getElementById("coop-modal-lobby-title").textContent = "Post a Run";
  document.getElementById("coop-lobby-save").textContent = "Post Run";
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
  }
  document.getElementById("coop-modal-lobby-title").textContent = "Edit Posted Run";
  document.getElementById("coop-lobby-save").textContent = "Save changes";
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
    const body = {
      title,
      goal: String(fd.get("goal") || "any"),
      ascensionMin: ascMin,
      ascensionMax: ascMax,
      voicePreference: String(fd.get("voicePreference") || "") || undefined,
      discordHandle: String(fd.get("discordHandle") || "").trim() || undefined,
      note: String(fd.get("note") || "").trim() || undefined,
    };
    setBusy($btn, true);
    const r = editingLobbyId
      ? await jsonFetch(`/coop/lobbies/${editingLobbyId}`, { method: "PATCH", body })
      : await jsonFetch("/coop/lobbies", { body });
    setBusy($btn, false);
    if (!r.ok) { showFormError("coop-modal-lobby", r.message || "Could not save your posted run."); return; }
    bootCtx.deps?.toast?.(editingLobbyId ? "Posted run updated." : "Run posted.");
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
  const title = String(fd.get("title") || "").trim() || "Your posted run";
  const goal = String(fd.get("goal") || "any");
  const voice = String(fd.get("voicePreference") || "");
  const ascMin = parseIntOrUndef(String(fd.get("ascensionMin") || ""));
  const ascMax = parseIntOrUndef(String(fd.get("ascensionMax") || ""));
  const note = String(fd.get("note") || "").trim();
  const discord = String(fd.get("discordHandle") || "").trim();
  const me = lastState?.presence;
  const avatar = me?.avatarUrl || "/assets/vault-mark.svg";
  const persona = me?.personaName || "you";
  const badges = [
    `<span class="coop-badge coop-badge--status-open">Open</span>`,
    `<span class="coop-badge coop-badge--goal">${esc(goalLabel(goal))}</span>`,
    `<span class="coop-badge coop-badge--asc">${esc(ascensionLabel(ascMin, ascMax))}</span>`,
    voice ? `<span class="coop-badge coop-badge--voice">${esc(voiceLabel(voice))}</span>` : "",
    `<span class="coop-badge coop-badge--players">1/2</span>`,
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
    <div class="coop-badge-row">${badges}</div>
    ${note ? `<p class="coop-lobby-note">&ldquo;${esc(note)}&rdquo;</p>` : ""}`;
}

// ── Quick Match confirmation modal ───────────────────────────────────
let pendingQuickMatchSid = null;

function openQuickMatchModal() {
  const recs = lastState?.recommendedMatches || [];
  const top = recs[0];
  const $body = document.getElementById("coop-quickmatch-body");
  const $sub = document.getElementById("coop-quickmatch-sub");
  const $send = document.getElementById("coop-quickmatch-send");
  const $err = document.getElementById("coop-quickmatch-error");
  if (!$body || !$sub || !$send) return;
  $err.hidden = true; $err.textContent = "";
  if (!top) {
    pendingQuickMatchSid = null;
    $sub.textContent = "No compatible players are looking right now.";
    $body.innerHTML = `
      <div class="coop-quickmatch-empty">
        <h4 class="coop-empty-title">No match found yet</h4>
        <p class="coop-empty-body">No one compatible is looking right now. Post a Run so players can join you, or update your Run Preferences.</p>
        <div class="coop-empty-actions" style="margin-top:10px;">
          <button class="btn-primary btn-sm" type="button" data-coop-action="open-create-lobby">+ Post a Run</button>
          <button class="btn-ghost btn-sm" type="button" data-coop-action="open-intent">Run Preferences</button>
        </div>
      </div>`;
    $send.hidden = true;
  } else {
    pendingQuickMatchSid = top.steamId;
    $sub.textContent = `SpireVault found ${top.personaName} as your best available match.`;
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
        ${top.note ? `<p class="coop-lobby-note">&ldquo;${esc(top.note)}&rdquo;</p>` : ""}
      </article>`;
    $send.hidden = false;
  }
  openModal("coop-modal-quickmatch", { focus: false });
}

function wireQuickMatchModal() {
  const $send = document.getElementById("coop-quickmatch-send");
  if (!$send) return;
  $send.addEventListener("click", async () => {
    if (!pendingQuickMatchSid) return;
    if ($send.classList.contains("is-busy")) return;
    setBusy($send, true);
    const me = lastState?.presence;
    const target = (lastState?.recommendedMatches || []).find((r) => r.steamId === pendingQuickMatchSid);
    const preset = pickInviteMessagePreset(me, target);
    const r = await jsonFetch("/coop/invites", {
      body: { toSteamId: pendingQuickMatchSid, messagePreset: preset },
    });
    setBusy($send, false);
    if (!r.ok) {
      const $err = document.getElementById("coop-quickmatch-error");
      if ($err) { $err.textContent = r.message || "Couldn't send invite."; $err.hidden = false; }
      return;
    }
    bootCtx.deps?.toast?.(`Invite sent to ${target?.personaName || "your match"}.`);
    pendingQuickMatchSid = null;
    closeModal("coop-modal-quickmatch");
    await refreshState({ force: true });
  });
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
      case "open-intent": closeAllCoopModals(); openIntentModal(); return;
      case "open-create-lobby": closeAllCoopModals(); openCreateLobbyModal(); return;
      case "open-edit-lobby": closeAllCoopModals(); openEditLobbyModal(btn.dataset.id); return;
      case "quick-match": closeAllCoopModals(); openQuickMatchModal(); return;
      case "go-afk": setRadioAndFire("status", "afk"); void savePresence({ silent: false }); return;
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
      case "invite-rec": {
        const sid = btn.dataset.id;
        const name = btn.dataset.name || "player";
        if (typeof bootCtx.deps?.openInviteModal === "function") {
          bootCtx.deps.openInviteModal(sid, name);
        } else {
          await doAction(key, btn, () => jsonFetch("/coop/invites", { body: { toSteamId: sid, messagePreset: "coop_any" } }), `Invite sent to ${name}.`);
        }
        return;
      }
      case "end-session":
        await doAction(key, btn, () => jsonFetch(`/coop/sessions/${btn.dataset.id}/end`, { body: {} }), "Pairing ended.");
        return;
      case "close-lobby":
        await doAction(key, btn, () => jsonFetch(`/coop/lobbies/${btn.dataset.id}/close`, { body: {} }), "Posted run closed.");
        return;
      case "request-join":
        await doAction(key, btn, () => jsonFetch(`/coop/lobbies/${btn.dataset.id}/request`, { body: {} }), "Request sent.");
        return;
      case "cancel-join":
        await doAction(key, btn, () => jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/cancel-request`, { body: {} }), "Request cancelled.");
        return;
      case "accept-join":
        await doAction(key, btn, () => jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/accept`, { body: { fromSteamId: btn.dataset.from } }), "Paired!");
        return;
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
