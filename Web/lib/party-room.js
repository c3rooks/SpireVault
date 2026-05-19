// party-room.js — web Party Room at /party/:partyId

import { isSandboxSteamId } from "./coop-sandbox.js?v=4";

const STATUS_LABELS = {
  joined: "Joined",
  ready: "Ready",
  character_select: "Character Select",
  in_game: "In Game",
  left: "Left",
};

const HOST_STEPS = [
  "Open STS2 Multiplayer.",
  "Choose Host.",
  "Pick Standard, Daily, or Custom.",
  "Choose your character.",
  "Click Invite.",
  "Add/invite party members through Steam if needed.",
  "Mark In Game when the run starts.",
];

const JOINER_STEPS = [
  "Add the host on Steam if needed.",
  "Open STS2 Multiplayer.",
  "Choose Join.",
  "If the host does not appear, wait for them to reach character select and click Refresh.",
  "Accept the Steam/game invite.",
  "Mark In Game once you join.",
];

let bootCtx = null;
let partyId = null;
let pollTimer = null;

export function mountPartyRoom(ctx, id) {
  bootCtx = ctx;
  partyId = id;
  const $surface = document.getElementById("coop-party-surface");
  const $workspace = document.querySelector(".coop-workspace");
  const $bar = document.querySelector(".coop-bar");
  if ($surface) $surface.hidden = false;
  if ($workspace) $workspace.hidden = true;
  if ($bar) $bar.hidden = true;
  void refreshParty();
  schedulePoll();
}

export function unmountPartyRoom() {
  clearTimeout(pollTimer);
  const $surface = document.getElementById("coop-party-surface");
  const $workspace = document.querySelector(".coop-workspace");
  const $bar = document.querySelector(".coop-bar");
  if ($surface) $surface.hidden = true;
  if ($workspace) $workspace.hidden = false;
  if ($bar) $bar.hidden = false;
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
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
    },
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const resp = await fetch(url, init);
  let data;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    return { ok: false, message: data?.message || `HTTP ${resp.status}` };
  }
  return { ok: true, ...data };
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    void refreshParty().finally(schedulePoll);
  }, 12_000);
}

async function refreshParty() {
  const r = await jsonFetch(`/coop/parties/${partyId}`);
  if (!r.ok) {
    renderPartyError(r.message || "Party Room not found.");
    return;
  }
  renderParty(r.party);
}

function renderPartyError(msg) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  $root.innerHTML = `
    <div class="coop-empty-card">
      <h4 class="coop-empty-title">Party Room unavailable</h4>
      <p class="coop-empty-body">${esc(msg)}</p>
      <a class="btn-primary btn-sm" href="/coop">Back to Co-op</a>
    </div>`;
}

function memberStatusLabel(m) {
  const map = {
    joined: "Waiting",
    ready: "Ready",
    character_select: "Character Select",
    in_game: "In Game",
    left: "Left",
  };
  return map[m.status] || STATUS_LABELS[m.status] || m.status;
}

function renderPartySlots(party) {
  const cap = party.lobbySize || 4;
  const active = party.members.filter((m) => m.status !== "left");
  const slots = [];
  for (let i = 0; i < cap; i++) {
    const m = active[i];
    if (m) {
      const role = m.steamId === party.hostSteamId ? "Host" : memberStatusLabel(m);
      slots.push(`<li class="coop-party-slot"><strong>${esc(m.personaName || "Player")}</strong> — ${esc(role)}</li>`);
    } else {
      slots.push(`<li class="coop-party-slot coop-party-slot--empty">Empty Seat</li>`);
    }
  }
  return `<ul class="coop-party-slots">${slots.join("")}</ul>`;
}

function renderParty(party) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  const me = bootCtx?.session?.steamId;
  const isHost = party.hostSteamId === me;
  const myMember = party.members.find((m) => m.steamId === me);
  const activeMembers = party.members.filter((m) => m.status !== "left");
  const steps = isHost ? HOST_STEPS : JOINER_STEPS;
  const stepsHtml = steps.map((s, i) => `<li>${i + 1}. ${esc(s)}</li>`).join("");

  const memberHtml = activeMembers.map((m) => {
    const isMe = m.steamId === me;
    const sandbox = isSandboxSteamId(m.steamId);
    return `
      <article class="coop-party-member${isMe ? " coop-party-member--me" : ""}">
        <img class="avatar" src="${esc(m.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-party-member-meta">
          <strong>${esc(m.personaName || "Steam user")}${isMe ? " (you)" : ""}</strong>
          <span class="coop-badge">${esc(memberStatusLabel(m))}</span>
        </div>
        <button type="button" class="btn-ghost btn-xs" data-party-action="copy-steam" data-sid="${esc(m.steamId)}" data-sandbox="${sandbox ? "1" : "0"}">Copy Steam Profile</button>
      </article>`;
  }).join("");

  $root.innerHTML = `
    <header class="coop-party-head">
      <div>
        <span class="eyebrow">Party Room</span>
        <h2 class="coop-party-title">You&rsquo;re in the party</h2>
        <p class="coop-party-sub">SpireVault found the party. STS2 still uses Steam for the actual invite.</p>
      </div>
      <a class="btn-ghost btn-sm" href="/coop">Back to Co-op</a>
    </header>
    <div class="coop-party-grid">
      <section class="coop-party-panel coop-party-panel--steps">
        <h3 class="coop-party-panel-title">${isHost ? "Host the game in STS2" : "Join through Steam"}</h3>
        <ol class="coop-party-checklist">${stepsHtml}</ol>
        <p class="coop-party-help muted small">If STS2 says &ldquo;No friends currently playing multiplayer,&rdquo; add the host on Steam first. Then refresh after the host reaches character select.</p>
      </section>
      <section class="coop-party-panel">
        <h3 class="coop-party-panel-title">Party slots</h3>
        ${renderPartySlots(party)}
        <h3 class="coop-party-panel-title" style="margin-top:14px">Members</h3>
        <div class="coop-party-members">${memberHtml}</div>
        ${myMember ? `
        <div class="coop-party-status-row" role="group" aria-label="Your status">
          <button type="button" class="btn-ghost btn-sm" data-party-status="ready">I&rsquo;m Ready</button>
          <button type="button" class="btn-ghost btn-sm" data-party-status="character_select">I&rsquo;m on Character Select</button>
          <button type="button" class="btn-ghost btn-sm" data-party-status="joined">I&rsquo;m Waiting for Invite</button>
          <button type="button" class="btn-ghost btn-sm" data-party-status="in_game">I&rsquo;m In Game</button>
          <button type="button" class="btn-ghost btn-sm" data-party-action="leave">Leave Party</button>
        </div>` : ""}
        ${isHost ? `<button type="button" class="btn-ghost btn-sm coop-party-end" data-party-action="end">End Party</button>` : ""}
      </section>
    </div>`;

  wirePartyActions(party, isHost);
}

function wirePartyActions(party, isHost) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  $root.querySelectorAll("[data-party-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const r = await jsonFetch(`/coop/parties/${party.partyId}/status`, {
        body: { status: btn.dataset.partyStatus },
      });
      if (!r.ok) bootCtx.deps?.toast?.(r.message || "Couldn't update status.");
      else await refreshParty();
    });
  });
  $root.querySelector("[data-party-action='leave']")?.addEventListener("click", async () => {
    const r = await jsonFetch(`/coop/parties/${party.partyId}/leave`, { body: {} });
    if (!r.ok) bootCtx.deps?.toast?.(r.message || "Couldn't leave.");
    else window.location.assign("/coop");
  });
  $root.querySelector("[data-party-action='end']")?.addEventListener("click", async () => {
    if (!isHost) return;
    const r = await jsonFetch(`/coop/parties/${party.partyId}/end`, { body: {} });
    if (!r.ok) bootCtx.deps?.toast?.(r.message || "Couldn't end party.");
    else window.location.assign("/coop");
  });
  $root.querySelectorAll("[data-party-action='copy-steam']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.sandbox === "1") {
        bootCtx.deps?.toast?.("Sandbox user — no real Steam profile.");
        try { await navigator.clipboard.writeText("Sandbox persona — use Dev Sandbox to switch users."); } catch {}
        return;
      }
      const url = steamProfileUrl(btn.dataset.sid);
      try { await navigator.clipboard.writeText(url); } catch {}
      bootCtx.deps?.toast?.("Steam profile link copied.");
    });
  });
}

function steamProfileUrl(steamId) {
  return `https://steamcommunity.com/profiles/${steamId}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
