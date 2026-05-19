// party-room.js — web Party Room at /party/:partyId

const STATUS_LABELS = {
  joined: "Joined",
  ready: "Ready",
  character_select: "Character Select",
  in_game: "In Game",
  left: "Left",
};

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

function renderParty(party) {
  const $root = document.getElementById("coop-party-root");
  if (!$root) return;
  const me = bootCtx?.session?.steamId;
  const isHost = party.hostSteamId === me;
  const myMember = party.members.find((m) => m.steamId === me);
  const activeMembers = party.members.filter((m) => m.status !== "left");

  const checklistHost = `
    <ol class="coop-party-checklist">
      <li>Accept seat requests until your party is ready.</li>
      <li>Share your Steam profile if players need to add you.</li>
      <li>In STS2, open Friends — if the list is empty, add each other on Steam first.</li>
      <li>Send the STS2 co-op invite when everyone marks Ready.</li>
    </ol>`;
  const checklistJoiner = `
    <ol class="coop-party-checklist">
      <li>Add the host on Steam if you are not friends yet.</li>
      <li>Mark <strong>Ready</strong> when you are set to play.</li>
      <li>In STS2, an empty Friends list usually means you still need to add on Steam.</li>
      <li>Accept the host&rsquo;s in-game invite when it arrives.</li>
    </ol>`;

  const memberHtml = activeMembers.map((m) => {
    const isMe = m.steamId === me;
    return `
      <article class="coop-party-member${isMe ? " coop-party-member--me" : ""}">
        <img class="avatar" src="${esc(m.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-party-member-meta">
          <strong>${esc(m.personaName || "Steam user")}${isMe ? " (you)" : ""}</strong>
          <span class="coop-badge">${esc(STATUS_LABELS[m.status] || m.status)}</span>
        </div>
        <button type="button" class="btn-ghost btn-xs" data-party-action="copy-steam" data-sid="${esc(m.steamId)}">Copy Steam Profile</button>
      </article>`;
  }).join("");

  $root.innerHTML = `
    <header class="coop-party-head">
      <div>
        <span class="eyebrow">Party Room</span>
        <h2 class="coop-party-title">${activeMembers.length} / ${party.lobbySize} in party</h2>
        <p class="coop-party-sub">Coordinate here, then hand off in STS2. Steam handles the actual co-op invite.</p>
      </div>
      <a class="btn-ghost btn-sm" href="/coop">Back to Co-op</a>
    </header>
    <div class="coop-party-grid">
      <section class="coop-party-panel">
        <h3 class="coop-party-panel-title">${isHost ? "Host checklist" : "Joiner checklist"}</h3>
        ${isHost ? checklistHost : checklistJoiner}
        <p class="coop-party-help muted small">STS2 friends list empty? Add each other on Steam first.</p>
      </section>
      <section class="coop-party-panel">
        <h3 class="coop-party-panel-title">Party members</h3>
        <div class="coop-party-members">${memberHtml}</div>
        ${myMember ? `
        <div class="coop-party-status-row" role="group" aria-label="Your status">
          <button type="button" class="btn-ghost btn-sm" data-party-status="ready">Ready</button>
          <button type="button" class="btn-ghost btn-sm" data-party-status="character_select">Character Select</button>
          <button type="button" class="btn-ghost btn-sm" data-party-status="in_game">In Game</button>
          <button type="button" class="btn-ghost btn-sm" data-party-action="leave">Leave</button>
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
