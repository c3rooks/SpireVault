// party-room.js — Party Hub (Co-op Lobby Beta · party-finder UX reset)
// =========================================================================
// Owns the focused destination after joining a room.
//
// Layout:
//   • Header (You're in <Host>'s party · subtitle + back link)
//   • Top summary (title, branch, mode, ascension, goal, voice, mic,
//     character fit, seat counts, room state)
//   • Party members list (Mako — Host — Defect — Setting up, …)
//   • Main next action card (always exactly one obvious primary action,
//     with visible state transitions after each click)
//   • Party Status card (per-member + room + voice + branch)
//
// Joiner flow:
//   Join LFG voice → Copy Host Steam → I'm Ready → Waiting for invite →
//   I'm Waiting for Invite → I'm In Game.
//
// Host flow (different view):
//   Your party is live · Copy Discord LFG Post (Discord preview) →
//   I'm Hosting STS2 → I'm on Character Select → I Sent Invites →
//   I'm In Game → Close Party.
//
// No-voice flow skips voice. Closed/Ended states render a polished
// closure card.
// =========================================================================

import { isSandboxSteamId } from "./coop-sandbox.js?v=5";
import { decodeStart } from "./party-finder-startsoon.js?v=1";

const PF_CHARACTERS = Object.freeze([
  { id: "ironclad", label: "Ironclad" },
  { id: "silent", label: "Silent" },
  { id: "defect", label: "Defect" },
  { id: "necrobinder", label: "Necrobinder" },
  { id: "regent", label: "Regent" },
]);
const PF_CHAR_IDS = new Set(PF_CHARACTERS.map((c) => c.id));

const LS_BRANCH_BY_LOBBY = "pf.branchByLobby";
const LS_VOICE_BY_LOBBY = "pf.voiceByLobby";

let bootCtx = null;
let partyId = null;
let pollTimer = null;
let lastParty = null;
let lastLobby = null;
const hostStepState = {};   // partyId → { hosting, charSelect, invitesSent, inGame, copied }
const joinerStepState = {}; // partyId → { joinedVoice, steamCopied, ready, waitingInvite, inGame }

export function mountPartyRoom(ctx, id) {
  bootCtx = ctx;
  partyId = id;
  ensureCssLoaded();
  const $surface = document.getElementById("coop-party-surface");
  const $workspace = document.querySelector(".coop-workspace");
  const $bar = document.querySelector(".coop-bar");
  const $pfRoot = document.getElementById("pf-root");
  if ($surface) $surface.hidden = false;
  if ($workspace) $workspace.hidden = true;
  if ($bar) $bar.hidden = true;
  if ($pfRoot) $pfRoot.hidden = true;
  void refreshParty();
  schedulePoll();
}

export function unmountPartyRoom() {
  clearTimeout(pollTimer);
  const $surface = document.getElementById("coop-party-surface");
  const $workspace = document.querySelector(".coop-workspace");
  const $bar = document.querySelector(".coop-bar");
  const $pfRoot = document.getElementById("pf-root");
  if ($surface) $surface.hidden = true;
  if ($workspace) $workspace.hidden = false;
  if ($bar) $bar.hidden = false;
  if ($pfRoot) $pfRoot.hidden = false;
}

function ensureCssLoaded() {
  if (document.getElementById("pf-stylesheet")) return;
  const link = document.createElement("link");
  link.id = "pf-stylesheet";
  link.rel = "stylesheet";
  link.href = "/lib/party-finder.css?v=3";
  document.head.appendChild(link);
}

function authHeaders() {
  const token = bootCtx?.session?.sessionToken;
  return token ? { authorization: `Bearer ${token}` } : { authorization: "Bearer __cookie__" };
}

async function jsonFetch(path, opts = {}) {
  const url = `${bootCtx.api}${path}`;
  const init = {
    cache: "no-store",
    credentials: "include",
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders() },
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const resp = await fetch(url, init);
  let data; try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) return { ok: false, status: resp.status, message: data?.message || `HTTP ${resp.status}` };
  return { ok: true, ...data };
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { void refreshParty().finally(schedulePoll); }, 12_000);
}

async function refreshParty() {
  const r = await jsonFetch(`/coop/parties/${partyId}`);
  if (!r.ok) {
    if (r.status === 404 || /closed|not found/i.test(r.message || "")) { renderClosed(r.message); return; }
    renderError(r.message || "Could not load Party Hub.");
    return;
  }
  lastParty = r.party;
  // Best-effort lobby lookup so we can show branch, voice preset, etc.
  if (lastParty?.lobbyId) {
    const lr = await jsonFetch("/coop/state");
    if (lr.ok) {
      lastLobby = lr.lobby?.lobbyId === lastParty.lobbyId
        ? lr.lobby
        : (lr.openLobbies || []).find((l) => l.lobbyId === lastParty.lobbyId);
    }
  }
  renderParty(lastParty, lastLobby);
}

// ── Helpers ──────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function normalizeCharacterId(v) {
  const id = String(v || "").trim().toLowerCase();
  return PF_CHAR_IDS.has(id) ? id : "";
}
function characterLabel(id) { return PF_CHARACTERS.find((c) => c.id === normalizeCharacterId(id))?.label || ""; }

function modeLabel(l) {
  return { standard: "Standard", daily: "Daily", custom: "Custom" }[l?.mode || "standard"] || "Standard";
}
function goalLabel(g) {
  const m = { any: "Any run", casual: "Chill climb", climb: "Climb", high: "High Ascension",
    a20: "Heart Attempt", heart: "Heart Attempt", learning: "Learning", daily: "Daily" };
  return m[g] || "Any run";
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
function micLabel(v) {
  if (v === "yes") return "Mic preferred";
  if (v === "no") return "Quiet \u2014 no mic";
  if (v === "optional") return "Mic optional";
  return "Mic optional";
}
function voiceLabelOf(l) {
  if (!l) return "Voice flexible";
  const local = readVoiceOverride(l.lobbyId);
  if (local) return local;
  const url = l.voiceChannelUrl;
  const preset = l.voicePreset || "any";
  if (preset === "none") return "No voice needed";
  if (preset === "any") return "Voice flexible";
  if (preset === "lfg1") return "LFG 1";
  if (preset === "lfg_duo3") return "LFG 3";
  if (preset === "custom" && url) return url;
  return "Voice flexible";
}
function voiceIsNone(l) { return !l || l?.voicePreset === "none" || /no voice/i.test(voiceLabelOf(l)); }
function branchLabelOf(l) {
  if (!l) return "Main or Beta OK";
  const local = readBranchOverride(l.lobbyId);
  if (local) return local;
  const hay = `${l.title || ""} ${l.note || ""}`.toLowerCase();
  if (/main or beta|beta or main/.test(hay)) return "Main or Beta OK";
  if (/beta branch|on beta\b/.test(hay)) return "Beta branch";
  if (/main branch|on main\b/.test(hay)) return "Main branch";
  if (isSandboxSteamId(l.hostSteamId)) {
    let h = 0; const s = String(l.lobbyId || "");
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return ["Beta branch", "Main or Beta OK", "Main branch"][Math.abs(h) % 3];
  }
  return "Main or Beta OK";
}
function readBranchOverride(id) {
  if (!id) return "";
  try {
    const raw = localStorage.getItem(LS_BRANCH_BY_LOBBY);
    const map = raw ? JSON.parse(raw) : {};
    const idMap = { beta: "Beta branch", main: "Main branch", both: "Main or Beta OK" };
    return idMap[map[id]] || "";
  } catch { return ""; }
}
function readVoiceOverride(id) {
  if (!id) return "";
  try {
    const raw = localStorage.getItem(LS_VOICE_BY_LOBBY);
    const map = raw ? JSON.parse(raw) : {};
    return map[id] || "";
  } catch { return ""; }
}

function memberStatusLabel(m) {
  const map = { joined: "Not ready", ready: "Ready", character_select: "On character select", in_game: "In game", left: "Left" };
  return map[m.status] || m.status;
}
function memberStatusTone(m) {
  return { ready: "ready", character_select: "cs", in_game: "ingame" }[m.status] || "";
}

// ── Render ───────────────────────────────────────────────────────────
function renderClosed(msg) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  const body = /closed/i.test(msg || "") ? "Host closed the room." : esc(msg);
  $root.innerHTML = `
    <div class="pf-empty">
      <span class="pf-eyebrow">Party ended</span>
      <h4>This party is no longer active.</h4>
      <p>${body || ""}</p>
      <div class="pf-empty-actions">
        <a class="pf-btn pf-btn--primary" href="/?tab=coop">Back to Co-op</a>
      </div>
    </div>`;
}

function renderError(msg) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  $root.innerHTML = `
    <div class="pf-empty">
      <h4>Party Hub</h4>
      <p>${esc(msg)}</p>
      <div class="pf-empty-actions"><a class="pf-btn pf-btn--primary" href="/?tab=coop">Back to Co-op</a></div>
    </div>`;
}

function renderParty(party, lobby) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  const me = bootCtx?.session?.steamId || bootCtx?.session?.steamID;
  const isHost = party.hostSteamId === me;
  const myMember = party.members.find((m) => m.steamId === me);
  const activeMembers = party.members.filter((m) => m.status !== "left");
  const cap = party.lobbySize || 4;
  const filled = activeMembers.length;
  const open = Math.max(0, cap - filled);
  const readyCount = activeMembers.filter((m) => m.status === "ready" || m.status === "character_select" || m.status === "in_game").length;
  const hostMember = party.members.find((m) => m.steamId === party.hostSteamId);
  const hostChar = normalizeCharacterId(hostMember?.selectedCharacter || lobby?.preferredCharacters?.[0] || "");
  const myChar = normalizeCharacterId(myMember?.selectedCharacter);
  const voice = voiceLabelOf(lobby);
  const branch = branchLabelOf(lobby);
  const noVoice = voiceIsNone(lobby);

  const roomState = computeRoomState(party);

  const headHtml = isHost
    ? `<div>
         <span class="pf-eyebrow">Party Hub</span>
         <h2>Your party is live</h2>
         <p>Share the room, host STS2, and bring players in.</p>
       </div>`
    : `<div>
         <span class="pf-eyebrow">Party Hub</span>
         <h2>You&rsquo;re in ${esc(hostMember?.personaName || "the host")}&rsquo;s party</h2>
         <p>Join voice, add the host on Steam, and get into STS2.</p>
       </div>`;

  $root.innerHTML = `
    <header class="pf-hub-head">
      ${headHtml}
      <a class="pf-btn pf-btn--ghost pf-btn--sm" href="/?tab=coop">Back to Co-op</a>
    </header>
    <section class="pf-hub-summary">
      <h3 class="pf-hub-summary-title">${esc(lobby?.title || "Co-op room")}</h3>
      <div class="pf-hub-summary-attrs">
        <span>${esc(branch)}</span><span class="pf-sep">·</span>
        <span>${esc(modeLabel(lobby))}</span><span class="pf-sep">·</span>
        <span>${esc(ascensionBucketLabel(lobby?.ascensionMin, lobby?.ascensionMax))}</span><span class="pf-sep">·</span>
        <span>${esc(goalLabel(lobby?.goal))}</span>
      </div>
      <div class="pf-hub-summary-attrs">
        <span>Voice: <strong>${esc(voice)}</strong></span><span class="pf-sep">·</span>
        <span>${esc(micLabel(lobby?.voicePreference))}</span><span class="pf-sep">·</span>
        <span>Character fit: <strong>${esc(myChar ? characterLabel(myChar) : (hostChar ? "Flexible" : "Flexible"))}</strong></span>
      </div>
      <div class="pf-hub-summary-status">
        <span><strong>${filled}</strong> of ${cap} filled · ${open} open seats</span>
        <span class="pf-sep">·</span>
        <span>Room: <strong>${esc(roomState.label)}</strong></span>
        <span class="pf-sep">·</span>
        <span class="pf-ready-tally"><strong>${readyCount}</strong> of ${filled} ready</span>
      </div>
    </section>
    <div class="pf-hub">
      <section class="pf-hub-card">
        <h3>Party members</h3>
        <ul class="pf-members-list">
          ${activeMembers.map((m) => renderMember(m, me, party)).join("")}
          ${renderEmptyMemberSlots(open)}
        </ul>
      </section>
      <section class="pf-hub-card pf-hub-next" id="pf-hub-next">
        ${isHost ? renderHostNext(party, lobby) : renderJoinerNext(party, lobby, myMember)}
      </section>
      <section class="pf-hub-card" style="grid-column: 1 / -1;">
        <h3>Party Status</h3>
        <ul class="pf-members-list">
          ${activeMembers.map((m) => renderStatusRow(m, party, me)).join("")}
          ${renderEmptyMemberSlots(open)}
        </ul>
        <div class="pf-hub-summary-status">
          <span>Voice: <strong>${esc(voice)}</strong></span>
          <span class="pf-sep">·</span>
          <span>Branch: <strong>${esc(branch)}</strong></span>
          <span class="pf-sep">·</span>
          <span>Room: <strong>${esc(roomState.label)}</strong></span>
        </div>
      </section>
    </div>`;

  wireActions(party, lobby, isHost);
}

function computeRoomState(party) {
  const active = party.members.filter((m) => m.status !== "left");
  const cap = party.lobbySize || 4;
  if (active.length >= cap && active.every((m) => m.status === "in_game" || m.status === "character_select")) {
    return { label: "In run", id: "in-run" };
  }
  if (active.some((m) => m.status === "character_select")) return { label: "Ready to invite", id: "ready-to-invite" };
  return { label: "Waiting for players", id: "waiting" };
}

function renderMember(m, meSid, party) {
  const isMe = m.steamId === meSid;
  const isHost = m.steamId === party.hostSteamId;
  const role = isHost ? "Host" : (isMe ? "You" : "Joined");
  const character = normalizeCharacterId(m.selectedCharacter);
  return `
    <li class="pf-member-row ${isMe ? "pf-member-row--me" : ""}">
      <img class="pf-member-avatar" src="${esc(m.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
      <div class="pf-member-meta">
        <strong>${esc(m.personaName || "Player")}${isMe ? " (You)" : ""}</strong>
        <small>${esc(role)} · ${esc(character ? characterLabel(character) : "Pick character")}</small>
      </div>
      <span class="pf-member-status pf-member-status--${memberStatusTone(m)}">${esc(memberStatusLabel(m))}</span>
    </li>`;
}

function renderStatusRow(m, party, meSid) {
  const isMe = m.steamId === meSid;
  const isHost = m.steamId === party.hostSteamId;
  const role = isHost ? "Host" : (isMe ? "You" : "Joined");
  const character = normalizeCharacterId(m.selectedCharacter);
  const label = memberStatusLabel(m);
  const checkmark = (m.status === "ready" || m.status === "character_select" || m.status === "in_game") ? " ✓" : "";
  return `
    <li class="pf-member-row ${isMe ? "pf-member-row--me" : ""}">
      <img class="pf-member-avatar" src="${esc(m.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
      <div class="pf-member-meta">
        <strong>${esc(m.personaName || "Player")}</strong>
        <small>${esc(role)} · ${esc(character ? characterLabel(character) : "Any")}</small>
      </div>
      <span class="pf-member-status pf-member-status--${memberStatusTone(m)}">${esc(label)}${checkmark}</span>
    </li>`;
}

function renderEmptyMemberSlots(n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += `
      <li class="pf-member-row">
        <span class="pf-member-avatar" style="background:rgba(255,255,255,0.06);"></span>
        <div class="pf-member-meta"><strong>Open Seat</strong><small>Any</small></div>
        <span class="pf-member-status">Open</span>
      </li>`;
  }
  return out;
}

// ── Joiner next-action card ──────────────────────────────────────────
function renderJoinerNext(party, lobby, myMember) {
  const pid = party.partyId;
  const local = (joinerStepState[pid] ||= {});
  const hostMember = party.members.find((m) => m.steamId === party.hostSteamId);
  const noVoice = voiceIsNone(lobby);
  const voice = voiceLabelOf(lobby);
  const hostState = hostMember?.status || "joined";
  const hostOnCharSelect = hostState === "character_select" || hostState === "in_game";
  const isReady = myMember?.status === "ready" || myMember?.status === "character_select" || myMember?.status === "in_game";
  const isInGame = myMember?.status === "in_game";
  const waitingForInvite = local.waitingInvite && !isInGame;

  // Stage 1: pre-ready (join voice, copy steam, mark ready)
  if (!hostOnCharSelect && !isReady) {
    return `
      <h3>Next</h3>
      <div class="pf-hub-next-title">${noVoice ? "Get ready to join the host" : `Join ${esc(voice)} voice`}</div>
      <p class="pf-hub-next-body">${noVoice ? "Add the host on Steam, then mark yourself ready." : "Hop into the Discord voice room first, then add the host on Steam."}</p>
      <div class="pf-hub-next-actions">
        ${noVoice ? "" : `<button type="button" class="pf-btn ${local.joinedVoice ? "pf-btn--success" : "pf-btn--primary"}" data-pf-hub="join-voice" data-voice="${esc(voice)}" data-voice-url="${esc(lobby?.voiceChannelUrl || "")}">${local.joinedVoice ? `Joined Voice ✓` : `🎧 Open ${esc(voice)} in Discord`}</button>`}
        <button type="button" class="pf-btn ${local.steamCopied ? "pf-btn--success" : "pf-btn--ghost"}" data-pf-hub="copy-steam" data-sid="${esc(party.hostSteamId)}" title="Opens Steam directly to add the host as a friend">${local.steamCopied ? "Added on Steam ✓" : "➕ Add Host on Steam"}</button>
        <button type="button" class="pf-btn pf-btn--primary" data-pf-hub="ready">${isReady ? "Ready ✓" : "I'm Ready"}</button>
      </div>`;
  }

  // Stage 2: ready, waiting for host to reach character select
  if (isReady && !hostOnCharSelect) {
    return `
      <h3>Next</h3>
      <div class="pf-hub-next-title">Waiting for host to reach character select</div>
      <p class="pf-hub-next-body">You&rsquo;re marked ready. The host will move to character select in STS2 when the rest of the party is set.</p>
      <div class="pf-hub-next-actions">
        <button type="button" class="pf-btn pf-btn--ghost" disabled>Ready ✓</button>
        <button type="button" class="pf-btn pf-btn--ghost" data-pf-hub="leave">Leave Party</button>
      </div>`;
  }

  // Stage 3: host is on character select
  if (hostOnCharSelect && !isInGame) {
    return `
      <h3>Next</h3>
      <div class="pf-hub-next-title">${waitingForInvite ? "Watch for the Steam invite or refresh STS2 Join" : "Host is ready. Open STS2 Multiplayer → Join → Refresh if needed"}</div>
      <p class="pf-hub-next-body">${waitingForInvite ? "If you don't see the host yet, refresh the Join list." : "Open STS2 Multiplayer, choose Join, and refresh until the host appears."}</p>
      <div class="pf-hub-next-actions">
        <button type="button" class="pf-btn ${waitingForInvite ? "pf-btn--success" : "pf-btn--primary"}" data-pf-hub="waiting-invite">${waitingForInvite ? "Waiting for invite ✓" : "I'm Waiting for Invite"}</button>
        <button type="button" class="pf-btn pf-btn--primary" data-pf-hub="in-game">I'm In Game</button>
      </div>`;
  }

  // Stage 4: I'm in game
  return `
    <h3>Next</h3>
    <div class="pf-hub-next-title">You&rsquo;re in the run ✓</div>
    <p class="pf-hub-next-body">Have fun. Close Party Hub when you&rsquo;re done.</p>
    <div class="pf-hub-next-actions">
      <button type="button" class="pf-btn pf-btn--ghost" data-pf-hub="leave">Leave Party</button>
    </div>`;
}

// ── Host next-action card ────────────────────────────────────────────
function renderHostNext(party, lobby) {
  const pid = party.partyId;
  const local = (hostStepState[pid] ||= {});
  const myMember = party.members.find((m) => m.steamId === party.hostSteamId);
  const onCS = myMember?.status === "character_select" || local.charSelect;
  const inGame = myMember?.status === "in_game" || local.inGame;
  const noVoice = voiceIsNone(lobby);
  const voice = voiceLabelOf(lobby);
  const branch = branchLabelOf(lobby);
  const filled = party.members.filter((m) => m.status !== "left").length;
  const cap = party.lobbySize || 4;
  const open = Math.max(0, cap - filled);
  const discordPost = buildDiscordLfgPost(party, lobby, voice, branch, filled, cap, open);

  return `
    <h3>Next</h3>
    <div class="pf-hub-next-title">${inGame ? "You&rsquo;re hosting the run" : onCS ? "On character select" : "Bring players in"}</div>
    <p class="pf-hub-next-body">${inGame ? "Run started. Players in your party are syncing." : onCS ? "Players know you&rsquo;re ready. They&rsquo;ll Join → Refresh in STS2." : "Copy the Discord LFG post, host STS2, and walk through character select."}</p>
    <div class="pf-discord-preview" aria-label="Discord LFG post preview">${esc(discordPost)}</div>
    <div class="pf-hub-next-actions">
      <button type="button" class="pf-btn ${local.copied ? "pf-btn--success" : "pf-btn--primary"}" data-pf-hub="copy-discord">${local.copied ? "Discord Post Copied ✓" : "Copy Discord LFG Post"}</button>
      <button type="button" class="pf-btn ${local.hosting ? "pf-btn--success" : "pf-btn--ghost"}" data-pf-hub="host-stage">${local.hosting ? "Hosting STS2 ✓" : "I'm Hosting STS2"}</button>
      <button type="button" class="pf-btn ${onCS ? "pf-btn--success" : "pf-btn--ghost"}" data-pf-hub="char-select">${onCS ? "On character select ✓" : "I'm on Character Select"}</button>
      <button type="button" class="pf-btn ${local.invitesSent ? "pf-btn--success" : "pf-btn--ghost"}" data-pf-hub="invites-sent">${local.invitesSent ? "Invites sent ✓" : "I Sent Invites"}</button>
      <button type="button" class="pf-btn ${inGame ? "pf-btn--success" : "pf-btn--ghost"}" data-pf-hub="in-game">${inGame ? "In game ✓" : "I'm In Game"}</button>
      <button type="button" class="pf-btn pf-btn--warn" data-pf-hub="end-party">Close Party</button>
    </div>`;
}

function buildDiscordLfgPost(party, lobby, voice, branch, filled, cap, open) {
  const title = lobby?.title || "STS2 co-op";
  const goal = goalLabel(lobby?.goal);
  const asc = ascensionBucketLabel(lobby?.ascensionMin, lobby?.ascensionMax);
  const mode = modeLabel(lobby);
  const charLine = (lobby?.preferredCharacters || []).slice(0, 2).map((c) => characterLabel(c)).filter(Boolean).join(" / ");
  const lobbyId = lobby?.lobbyId || party.lobbyId || "";
  // Decode the planned start out of the lobby note. When a host set a
  // concrete time, embed it as a Discord native timestamp tag — the
  // Discord client renders <t:UNIX:R> as "in 14 minutes" inline AND
  // keeps it live-updating without anyone refreshing the channel. This
  // is the bridge piece between SpireVault and Discord LFG: the post
  // is *better* in Discord than a plain text version could ever be.
  const startInfo = decodeStart(lobby?.note);
  let startLine = "";
  if (startInfo.plannedAt instanceof Date && !isNaN(startInfo.plannedAt.getTime())) {
    const unix = Math.floor(startInfo.plannedAt.getTime() / 1000);
    startLine = `Starts <t:${unix}:R> (<t:${unix}:t> your time)`;
  } else if (startInfo.isWhenFull) {
    startLine = "Starts the moment we fill — claim a seat fast.";
  }
  return [
    `Looking for STS2 co-op — ${title}`,
    `${branch} · ${mode} · ${asc} · ${filled} of ${cap} filled · ${open} open seats`,
    `Voice: ${voice}`,
    charLine ? `Characters: ${charLine}` : "",
    startLine,
    "",
    `Join here:`,
    `https://spirevault.app/coop?room=${lobbyId}`,
  ].filter(Boolean).join("\n");
}

// ── Action wiring ────────────────────────────────────────────────────
function wireActions(party, lobby, isHost) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  // Use one delegated click handler scoped to the root.
  $root.addEventListener("click", onHubClick, { once: false });
}

let hubClickWired = false;
function onHubClick(e) {
  const btn = e.target.closest("[data-pf-hub]");
  if (!btn) return;
  const action = btn.dataset.pfHub;
  const party = lastParty;
  if (!party) return;
  const pid = party.partyId;
  switch (action) {
    case "join-voice": {
      const voice = btn.dataset.voice || "";
      const url = btn.dataset.voiceUrl || "";
      const j = (joinerStepState[pid] ||= {});
      j.joinedVoice = true;
      // Real Discord deep-link path with a server-invite fallback so a
      // joiner who isn't yet in the STS2 LFG Discord doesn't hit a dead
      // end. We try, in order:
      //   1. Channel URL the host typed (https://discord.com/channels/<g>/<c>)
      //      converted to a discord:// deep link → drops the user straight
      //      into LFG 1/2/3 if they're in the server.
      //   2. The community LFG server invite (configurable via
      //      window.STS2_DISCORD_INVITE_URL) so first-timers land on
      //      "Accept Invite" before the channel.
      //   3. The raw URL the host typed, whatever that is.
      const deep = (typeof window !== "undefined" && typeof window.discordDeepLink === "function")
        ? window.discordDeepLink(url)
        : url;
      const serverInvite = (typeof window !== "undefined" && window.STS2_DISCORD_INVITE_URL) || "";
      const target = deep || serverInvite || url;
      if (target) {
        try { window.open(target, "_blank", "noopener"); }
        catch { window.location.assign(target); }
        bootCtx?.deps?.toast?.(deep ? `Opening ${voice} in Discord…` : "Opening the STS2 LFG Discord…");
      } else {
        bootCtx?.deps?.toast?.(`Hop into ${voice} in Discord.`);
      }
      renderParty(lastParty, lastLobby);
      return;
    }
    case "copy-steam": {
      const sid = btn.dataset.sid;
      const j = (joinerStepState[pid] ||= {});
      if (isSandboxSteamId(sid)) {
        bootCtx?.deps?.toast?.("Sandbox persona — Dev Sandbox can't add friends on Steam.");
      } else {
        // Open Steam directly to the "Add Friend" dialog for the host. This
        // replaces the old copy-the-URL-then-paste-into-Steam dance with a
        // single click: the Steam client takes over once you confirm the
        // protocol handler.
        const steamUri = `steam://friends/add/${encodeURIComponent(sid)}`;
        const httpFallback = `https://steamcommunity.com/profiles/${encodeURIComponent(sid)}`;
        try {
          // Use a hidden anchor so the steam:// handler triggers and the page
          // doesn't navigate away if the protocol isn't registered.
          const a = document.createElement("a");
          a.href = steamUri;
          a.rel = "noopener";
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch {
          navigator.clipboard?.writeText?.(httpFallback).catch(() => {});
        }
        // Belt-and-suspenders copy so the user has a paste-able URL if the
        // OS lacks a Steam protocol handler.
        navigator.clipboard?.writeText?.(httpFallback).catch(() => {});
        bootCtx?.deps?.toast?.("Opening Steam to add the host…");
      }
      j.steamCopied = true;
      renderParty(lastParty, lastLobby);
      return;
    }
    case "ready": void postStatus("ready"); return;
    case "waiting-invite": {
      const j = (joinerStepState[pid] ||= {});
      j.waitingInvite = true;
      renderParty(lastParty, lastLobby);
      return;
    }
    case "in-game": void postStatus("in_game"); return;
    case "leave": void leaveParty(); return;
    case "copy-discord": {
      const h = (hostStepState[pid] ||= {});
      const text = e.currentTarget?.querySelector?.(".pf-discord-preview")?.textContent || "";
      const preview = document.querySelector(".pf-discord-preview")?.textContent || "";
      navigator.clipboard?.writeText?.(text || preview).catch(() => {});
      h.copied = true;
      // Magic-moment hint — surfaces the *one* thing this post does
      // that a hand-typed Discord LFG message can't: live-update in
      // the channel without anyone refreshing. Only shows when the
      // post actually contains a Discord timestamp tag (i.e. the host
      // set a planned start), since that's the live-updating element.
      const hasLiveTag = /<t:\d+:R>/.test(text || preview);
      const toastMsg = hasLiveTag
        ? "Discord LFG post copied — it'll live-update in your channel."
        : "Discord LFG post copied.";
      bootCtx?.deps?.toast?.(toastMsg);
      renderParty(lastParty, lastLobby);
      return;
    }
    case "host-stage": {
      const h = (hostStepState[pid] ||= {});
      h.hosting = true;
      renderParty(lastParty, lastLobby);
      return;
    }
    case "char-select": {
      const h = (hostStepState[pid] ||= {});
      h.charSelect = true;
      void postStatus("character_select");
      return;
    }
    case "invites-sent": {
      const h = (hostStepState[pid] ||= {});
      h.invitesSent = true;
      renderParty(lastParty, lastLobby);
      return;
    }
    case "end-party": void endParty(); return;
    default: return;
  }
}

async function postStatus(status) {
  const r = await jsonFetch(`/coop/parties/${partyId}/status`, { body: { status } });
  if (!r.ok) bootCtx?.deps?.toast?.(r.message || "Couldn't update status.");
  else await refreshParty();
}
async function leaveParty() {
  const r = await jsonFetch(`/coop/parties/${partyId}/leave`, { body: {} });
  if (!r.ok) bootCtx?.deps?.toast?.(r.message || "Couldn't leave.");
  else window.location.assign("/?tab=coop");
}
async function endParty() {
  const r = await jsonFetch(`/coop/parties/${partyId}/end`, { body: {} });
  if (!r.ok) bootCtx?.deps?.toast?.(r.message || "Couldn't end party.");
  else window.location.assign("/?tab=coop");
}
