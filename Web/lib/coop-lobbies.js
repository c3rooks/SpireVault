// coop-lobbies.js
// =========================================================================
// Co-op run-lobby client. Talks to the Worker's /coop/* endpoints.
// Pure data + simple imperative renderers — the surrounding script.js
// owns global state (session, polling cadence, toasts, beacons).
//
// Exports:
//   - mountCoopLobbies({ api, session, deps }) — boots the module
//   - getLastState() — returns the most recent bundle (for tests)
// =========================================================================

/** @typedef {{
 *   steamId: string, personaName: string, avatarUrl?: string,
 *   status: "looking"|"solo"|"paired"|"afk"|"offline",
 *   note?: string, discordHandle?: string,
 *   ascensionMin?: number, ascensionMax?: number,
 *   goal?: string, voicePreference?: string,
 *   preferredCharacters?: string[],
 *   currentLobbyId?: string, currentSessionId?: string,
 *   lastHeartbeatAt: string, expiresAt: string, updatedAt: string
 * }} CoopPresence */

/** @typedef {{ lobbyId: string, hostSteamId: string, hostPersonaName: string,
 *   hostAvatarUrl?: string, title: string, goal: string,
 *   ascensionMin?: number, ascensionMax?: number, voicePreference?: string,
 *   preferredCharacters?: string[], note?: string, discordHandle?: string,
 *   status: "open"|"pending"|"full"|"expired"|"closed",
 *   memberSteamIds: string[], pendingJoinRequestSteamIds: string[],
 *   createdAt: string, updatedAt: string, expiresAt: string
 * }} RunLobby */

const STATE_POLL_MS = 15_000;
const STATE_POLL_HIDDEN_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const HEARTBEAT_HIDDEN_MS = 5 * 60_000;

let bootCtx = null;
let lastState = null;
let pollTimer = null;
let heartbeatTimer = null;
let isMounted = false;
let isCoopTabActive = true;

/** Boot the module. Idempotent — calling again replaces context. */
export function mountCoopLobbies(ctx) {
  bootCtx = ctx;
  if (isMounted) return;
  isMounted = true;
  bindStatusForm();
  bindGlobalButtons();
  bindLobbyToggle();
  // Kick the first refresh + start the loop
  void refreshState({ force: true });
  scheduleNextPoll();
  scheduleNextHeartbeat();
  document.addEventListener("visibilitychange", onVisibilityChange);
}

export function setCoopTabActive(active) {
  isCoopTabActive = !!active;
  if (active) void refreshState({ force: true });
}

export function getLastState() { return lastState; }

// -------------------------------------------------------------------------
// Networking
// -------------------------------------------------------------------------

function authHeaders() {
  const token = bootCtx?.session?.sessionToken;
  return token
    ? { authorization: `Bearer ${token}` }
    : { authorization: `Bearer __cookie__` };
}

async function jsonFetch(path, opts = {}) {
  const url = `${bootCtx.api}${path}`;
  const init = {
    cache: "no-store",
    credentials: "include",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...authHeaders(),
      ...(opts.headers || {}),
    },
    method: opts.method || (opts.body ? "POST" : "GET"),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    return { ok: false, status: 0, error: "network", message: String(err?.message || err) };
  }
  let data;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    return {
      ok: false,
      status: resp.status,
      error: data?.error || "http_error",
      message: data?.message || `HTTP ${resp.status}`,
    };
  }
  return { ok: true, status: resp.status, ...data };
}

async function refreshState({ force = false } = {}) {
  if (!bootCtx) return;
  if (!bootCtx.session?.steamID) return;
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
  pollTimer = setTimeout(async () => {
    await refreshState();
    scheduleNextPoll();
  }, ms);
}

function scheduleNextHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const ms = document.visibilityState === "hidden" ? HEARTBEAT_HIDDEN_MS : HEARTBEAT_MS;
  heartbeatTimer = setTimeout(async () => {
    await sendHeartbeat();
    scheduleNextHeartbeat();
  }, ms);
}

function onVisibilityChange() {
  scheduleNextPoll();
  scheduleNextHeartbeat();
  if (document.visibilityState === "visible") void refreshState({ force: true });
}

// -------------------------------------------------------------------------
// Form binding (Section 1 — Your Co-op Status)
// -------------------------------------------------------------------------

function readFormState() {
  return {
    status: (document.querySelector('input[name="status"]:checked') || {}).value || "looking",
    goal: document.getElementById("coop-goal")?.value || undefined,
    ascensionMin: parseIntOrUndef(document.getElementById("coop-asc-min")?.value),
    ascensionMax: parseIntOrUndef(document.getElementById("coop-asc-max")?.value),
    voicePreference: document.getElementById("coop-voice")?.value || undefined,
    discordHandle: document.getElementById("me-discord")?.value?.trim() || undefined,
    note: document.getElementById("coop-note")?.value?.trim() || undefined,
  };
}

function parseIntOrUndef(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function bindStatusForm() {
  document.querySelectorAll('#status-pills input[name="status"]').forEach((el) =>
    el.addEventListener("change", () => {
      void savePresence({ silent: true });
    }),
  );
  document.getElementById("coop-save-btn")?.addEventListener("click", () => {
    void savePresence({ silent: false });
  });
  document.getElementById("coop-quick-match-btn")?.addEventListener("click", () => {
    void quickMatch();
  });
  document.getElementById("coop-create-lobby-btn")?.addEventListener("click", () => {
    openCreateLobbyDialog();
  });
}

async function savePresence({ silent }) {
  const body = readFormState();
  const r = await jsonFetch("/coop/presence", { body });
  if (!r.ok) {
    bootCtx.deps?.toast?.(r.message || "Could not save status.");
    return false;
  }
  bootCtx.deps?.toast?.(silent ? null : "Status saved.");
  await refreshState({ force: true });
  return true;
}

// -------------------------------------------------------------------------
// Quick match — picks the top recommended player and sends an invite
// using the most appropriate canned message.
// -------------------------------------------------------------------------
async function quickMatch() {
  if (!lastState) await refreshState({ force: true });
  if (!lastState) return;
  const recs = lastState.recommendedMatches || [];
  if (recs.length === 0) {
    bootCtx.deps?.toast?.("No matches right now — try again in a moment.");
    return;
  }
  const target = recs[0];
  const preset = pickInviteMessagePreset(lastState.presence, target);
  const r = await jsonFetch("/coop/invites", {
    body: { toSteamId: target.steamId, messagePreset: preset },
  });
  if (!r.ok) {
    bootCtx.deps?.toast?.(r.message || "Could not send invite.");
    return;
  }
  bootCtx.deps?.toast?.(`Invite sent to ${target.personaName}.`);
  await refreshState({ force: true });
}

function pickInviteMessagePreset(me, candidate) {
  if (candidate.voicePreference === "yes" || me?.voicePreference === "yes") return "coop_voice";
  const ascHigh = (me?.ascensionMin ?? 0) >= 15 || (candidate?.ascensionMin ?? 0) >= 15;
  if (ascHigh) return "coop_a20";
  if ((me?.ascensionMax ?? 20) <= 5) return "coop_low";
  return "coop_any";
}

// -------------------------------------------------------------------------
// Create-lobby dialog. Uses a transient inline form below the status
// card; no modal so the UX stays linear on mobile.
// -------------------------------------------------------------------------
function openCreateLobbyDialog() {
  const $card = document.getElementById("coop-status-card");
  if (!$card) return;
  let $form = document.getElementById("coop-create-lobby-form");
  if ($form) { $form.querySelector("input")?.focus?.(); return; }

  $form = document.createElement("form");
  $form.id = "coop-create-lobby-form";
  $form.className = "coop-create-lobby-form";
  $form.innerHTML = `
    <h4>Create run lobby</h4>
    <label class="coop-pref-field coop-pref-field--wide">
      <span class="field-label">Title (80 chars max)</span>
      <input type="text" name="title" required maxlength="80" placeholder='e.g. "A20 Heart Attempts"' />
    </label>
    <div class="coop-prefs-grid">
      <label class="coop-pref-field">
        <span class="field-label">Goal</span>
        <select name="goal" required>
          <option value="any">Any run</option>
          <option value="casual">Casual</option>
          <option value="climb">Climb</option>
          <option value="a20">A20</option>
          <option value="heart">Heart attempt</option>
          <option value="teaching">Teaching</option>
          <option value="learning">Learning</option>
          <option value="daily">Daily</option>
          <option value="experimental">Experimental</option>
        </select>
      </label>
      <label class="coop-pref-field">
        <span class="field-label">Ascension min</span>
        <input type="number" name="ascensionMin" min="0" max="20" step="1" />
      </label>
      <label class="coop-pref-field">
        <span class="field-label">Ascension max</span>
        <input type="number" name="ascensionMax" min="0" max="20" step="1" />
      </label>
      <label class="coop-pref-field">
        <span class="field-label">Voice</span>
        <select name="voicePreference">
          <option value="">— no preference —</option>
          <option value="yes">Yes</option>
          <option value="optional">Optional</option>
          <option value="no">No</option>
        </select>
      </label>
      <label class="coop-pref-field coop-pref-field--wide">
        <span class="field-label">Note (160 chars max)</span>
        <input type="text" name="note" maxlength="160" />
      </label>
    </div>
    <div class="coop-status-actions">
      <button type="submit" class="btn-primary">Create lobby</button>
      <button type="button" class="btn-ghost" data-cancel>Cancel</button>
    </div>
  `;
  $card.appendChild($form);
  $form.querySelector("input[name='title']")?.focus?.();
  $form.querySelector("[data-cancel]")?.addEventListener("click", () => $form.remove());

  $form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData($form);
    const body = {
      title: String(fd.get("title") || "").trim(),
      goal: String(fd.get("goal") || "any"),
      ascensionMin: parseIntOrUndef(String(fd.get("ascensionMin") || "")),
      ascensionMax: parseIntOrUndef(String(fd.get("ascensionMax") || "")),
      voicePreference: String(fd.get("voicePreference") || "") || undefined,
      note: String(fd.get("note") || "").trim() || undefined,
    };
    const r = await jsonFetch("/coop/lobbies", { body });
    if (!r.ok) {
      bootCtx.deps?.toast?.(r.message || "Could not create lobby.");
      return;
    }
    bootCtx.deps?.toast?.("Lobby created.");
    $form.remove();
    await refreshState({ force: true });
  });
}

// -------------------------------------------------------------------------
// Global button bindings
// -------------------------------------------------------------------------
function bindGlobalButtons() {
  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    void refreshState({ force: true });
  });
}

function bindLobbyToggle() {
  const $toggle = document.getElementById("coop-feed-toggle");
  const $feed = document.getElementById("feed");
  if (!$toggle || !$feed) return;
  $toggle.addEventListener("click", () => {
    const expanded = $toggle.getAttribute("aria-expanded") !== "false";
    $toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    $feed.hidden = expanded;
    $toggle.textContent = expanded ? "Show" : "Hide";
  });
}

// -------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function formatRelative(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatCountdown(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

function ascensionLabel(min, max) {
  if (min == null && max == null) return "Any ascension";
  if (min != null && max != null) {
    if (min === max) return `A${min}`;
    return `A${min}–A${max}`;
  }
  if (min != null) return `A${min}+`;
  return `Up to A${max}`;
}

function goalLabel(goal) {
  if (!goal) return "";
  return {
    any: "Any",
    casual: "Casual",
    climb: "Climb",
    a20: "A20",
    heart: "Heart",
    teaching: "Teaching",
    learning: "Learning",
    daily: "Daily",
    experimental: "Experimental",
  }[goal] || goal;
}

function voiceLabel(voice) {
  return ({ yes: "Voice yes", no: "No voice", optional: "Voice optional" })[voice] || "";
}

function render(state) {
  if (!state) return;
  reflectFormFromPresence(state.presence);
  renderContext(state);
  renderLobbies(state);
  renderRecommendations(state);
  // Active player feed is delegated to legacy `renderFeed()` in script.js
  // which the boot wiring still calls. We update the count here so users
  // see freshness on every poll.
  const $count = document.getElementById("online-count");
  if ($count) $count.textContent = String(state.activePlayerFeed?.length || 0);
}

function reflectFormFromPresence(p) {
  if (!p) return;
  setRadio("status", p.status);
  setValue("coop-goal", p.goal || "");
  setValue("coop-asc-min", p.ascensionMin ?? "");
  setValue("coop-asc-max", p.ascensionMax ?? "");
  setValue("coop-voice", p.voicePreference || "");
  // Only overwrite text fields when they're empty — avoids stomping a
  // mid-edit value with a stale server copy.
  const $d = document.getElementById("me-discord");
  if ($d && !$d.value) $d.value = p.discordHandle || "";
  const $n = document.getElementById("coop-note");
  if ($n && !$n.value) $n.value = p.note || "";
  const $persona = document.getElementById("me-persona");
  if ($persona && p.personaName) $persona.textContent = p.personaName;
  const $avatar = document.getElementById("me-avatar");
  if ($avatar && p.avatarUrl) $avatar.src = p.avatarUrl;
}

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el && !el.checked) el.checked = true;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (document.activeElement === el) return; // user is editing right now
  el.value = String(value ?? "");
}

// -------------------------------------------------------------------------
// Section 2 renderer — context (session / lobby / invites)
// -------------------------------------------------------------------------
function renderContext(state) {
  const $ctx = document.getElementById("coop-context");
  if (!$ctx) return;
  const parts = [];

  // ── Active session ──
  if (state.session && state.session.status === "active") {
    parts.push(renderSessionCard(state));
  }

  // ── Your lobby (host) ──
  if (state.lobby && state.lobby.hostSteamId === state.presence.steamId && state.lobby.status !== "closed") {
    parts.push(renderHostLobbyCard(state));
  }

  // ── Member of a lobby (not host) ──
  if (state.lobby && state.lobby.hostSteamId !== state.presence.steamId && state.lobby.status !== "closed") {
    parts.push(renderMemberLobbyCard(state));
  }

  // ── Incoming invites ──
  if (state.incomingInvites?.length) {
    parts.push(renderIncomingInvitesCard(state.incomingInvites));
  }

  // ── Outgoing invites ──
  if (state.outgoingInvites?.length) {
    parts.push(renderOutgoingInvitesCard(state.outgoingInvites));
  }

  // ── Outgoing join requests (when I'm not in a lobby but waiting for one) ──
  const myOutgoingJoinReqs = (state.outgoingJoinRequests || []).filter(
    (r) => r.status === "pending",
  );
  if (myOutgoingJoinReqs.length) {
    parts.push(renderOutgoingJoinRequestsCard(myOutgoingJoinReqs));
  }

  if (parts.length === 0) {
    $ctx.hidden = true;
    $ctx.innerHTML = "";
    return;
  }
  $ctx.hidden = false;
  $ctx.innerHTML = parts.join("");
  wireContext($ctx, state);
}

function renderSessionCard(state) {
  const partnerSid = (state.session.playerSteamIds || []).find(
    (sid) => sid !== state.presence.steamId,
  );
  const partner = (state.activePlayerFeed || []).find((p) => p.steamId === partnerSid);
  const partnerName = partner?.personaName || "your partner";
  const partnerAvatar = partner?.avatarUrl || "/assets/vault-mark.svg";
  const profileLink = partnerSid ? `https://steamcommunity.com/profiles/${esc(partnerSid)}` : "#";
  const discord = partner?.discordHandle ? esc(partner.discordHandle) : "";
  return `
    <article class="coop-card coop-card--session">
      <div class="coop-card-head">
        <img class="avatar" src="${esc(partnerAvatar)}" alt="" />
        <div>
          <h4>You&rsquo;re co-oping with ${esc(partnerName)}</h4>
          <p class="muted small">Steam handles the actual game invite. Use the profile link to send it.</p>
        </div>
      </div>
      <div class="coop-card-actions">
        <a class="btn-primary sm" target="_blank" rel="noopener" href="${profileLink}">Open Steam profile</a>
        ${discord ? `<button class="btn-ghost sm" data-act="copy-discord" data-handle="${discord}">Copy Discord</button>` : ""}
        <button class="btn-ghost sm" data-act="end-session" data-session-id="${esc(state.session.sessionId)}">End co-op</button>
      </div>
    </article>`;
}

function renderHostLobbyCard(state) {
  const lobby = state.lobby;
  const joinReqs = state.incomingJoinRequests || [];
  return `
    <article class="coop-card coop-card--lobby">
      <div class="coop-card-head">
        <div class="coop-lobby-title">
          <h4>${esc(lobby.title)}</h4>
          <div class="coop-tag-row">
            <span class="coop-tag">${esc(goalLabel(lobby.goal))}</span>
            <span class="coop-tag">${esc(ascensionLabel(lobby.ascensionMin, lobby.ascensionMax))}</span>
            ${lobby.voicePreference ? `<span class="coop-tag">${esc(voiceLabel(lobby.voicePreference))}</span>` : ""}
            <span class="coop-tag coop-tag--status">${esc(lobby.status)}</span>
            <span class="coop-tag coop-tag--count">${lobby.memberSteamIds.length}/2</span>
          </div>
        </div>
      </div>
      ${lobby.note ? `<p class="coop-lobby-note">${esc(lobby.note)}</p>` : ""}
      <div class="coop-join-reqs">
        <h5>Pending join requests <span class="count-pill">${joinReqs.length}</span></h5>
        ${joinReqs.length === 0
          ? `<p class="muted small">Waiting for a player to request to join…</p>`
          : joinReqs.map((r) => `
            <div class="coop-join-req-row" data-req-from="${esc(r.fromSteamId)}">
              <img class="avatar sm" src="${esc(r.fromAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
              <div class="coop-join-req-meta">
                <strong>${esc(r.fromPersonaName || "Steam User")}</strong>
                <span class="muted small">expires in ${esc(formatCountdown(r.expiresAt))}</span>
              </div>
              <div class="coop-card-actions">
                <button class="btn-primary sm" data-act="accept-join" data-from="${esc(r.fromSteamId)}" data-lobby="${esc(lobby.lobbyId)}">Accept</button>
                <button class="btn-ghost sm" data-act="decline-join" data-from="${esc(r.fromSteamId)}" data-lobby="${esc(lobby.lobbyId)}">Decline</button>
              </div>
            </div>`).join("")}
      </div>
      <div class="coop-card-actions">
        <button class="btn-ghost sm" data-act="edit-lobby" data-lobby="${esc(lobby.lobbyId)}">Edit lobby</button>
        <button class="btn-ghost sm" data-act="close-lobby" data-lobby="${esc(lobby.lobbyId)}">Close lobby</button>
      </div>
    </article>`;
}

function renderMemberLobbyCard(state) {
  const lobby = state.lobby;
  return `
    <article class="coop-card coop-card--lobby">
      <div class="coop-card-head">
        <img class="avatar" src="${esc(lobby.hostAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div>
          <h4>${esc(lobby.title)}</h4>
          <p class="muted small">Hosted by ${esc(lobby.hostPersonaName)} · ${esc(lobby.status)}</p>
        </div>
      </div>
    </article>`;
}

function renderIncomingInvitesCard(invites) {
  return `
    <article class="coop-card coop-card--invites">
      <h4>Invites for you <span class="count-pill">${invites.length}</span></h4>
      ${invites.map((i) => `
        <div class="coop-invite-row">
          <img class="avatar sm" src="${esc(i.fromAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
          <div class="coop-invite-meta">
            <strong>${esc(i.fromPersonaName || "Steam User")}</strong>
            <span class="muted small">${esc(presetMessage(i.messagePreset) || "Want to co-op?")}</span>
            <span class="muted small">expires in ${esc(formatCountdown(i.expiresAt))}</span>
          </div>
          <div class="coop-card-actions">
            <button class="btn-primary sm" data-act="accept-invite" data-invite="${esc(i.inviteId)}">Accept</button>
            <button class="btn-ghost sm" data-act="decline-invite" data-invite="${esc(i.inviteId)}">Decline</button>
          </div>
        </div>`).join("")}
    </article>`;
}

function renderOutgoingInvitesCard(invites) {
  return `
    <article class="coop-card coop-card--invites">
      <h4>Waiting on <span class="count-pill">${invites.length}</span></h4>
      ${invites.map((i) => `
        <div class="coop-invite-row">
          <img class="avatar sm" src="${esc(i.toAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
          <div class="coop-invite-meta">
            <strong>${esc(i.toPersonaName || "Steam User")}</strong>
            <span class="muted small">Waiting · expires in ${esc(formatCountdown(i.expiresAt))}</span>
          </div>
          <div class="coop-card-actions">
            <button class="btn-ghost sm" data-act="cancel-invite" data-invite="${esc(i.inviteId)}">Cancel</button>
          </div>
        </div>`).join("")}
    </article>`;
}

function renderOutgoingJoinRequestsCard(reqs) {
  return `
    <article class="coop-card coop-card--invites">
      <h4>Waiting on lobbies <span class="count-pill">${reqs.length}</span></h4>
      ${reqs.map((r) => `
        <div class="coop-invite-row">
          <div class="coop-invite-meta">
            <strong>Request sent</strong>
            <span class="muted small">expires in ${esc(formatCountdown(r.expiresAt))}</span>
          </div>
          <div class="coop-card-actions">
            <button class="btn-ghost sm" data-act="cancel-join" data-lobby="${esc(r.lobbyId)}">Cancel</button>
          </div>
        </div>`).join("")}
    </article>`;
}

function presetMessage(id) {
  const catalog = {
    coop_any: "Want to co-op? Any ascension.",
    coop_low: "Want to co-op? Low ascension / casual.",
    coop_high: "Want to co-op? A15+.",
    coop_a20: "Want to co-op? A20 only.",
    coop_voice: "Want to co-op with voice chat?",
    coop_quick: "One quick run? ~30 min.",
    coop_daily: "Want to co-op the daily?",
    coop_teach: "Want to co-op? Happy to teach.",
    coop_learn: "Want to co-op? Still learning.",
  };
  return catalog[id];
}

function wireContext(scope, state) {
  scope.querySelectorAll("[data-act='copy-discord']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const handle = btn.dataset.handle || "";
      navigator.clipboard?.writeText(handle).catch(() => {});
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy Discord"), 1500);
    });
  });
  scope.querySelectorAll("[data-act='end-session']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const sid = btn.dataset.sessionId;
      const r = await jsonFetch(`/coop/sessions/${sid}/end`, { body: {} });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      bootCtx.deps?.toast?.("Co-op session ended.");
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='close-lobby']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lobbyId = btn.dataset.lobby;
      const r = await jsonFetch(`/coop/lobbies/${lobbyId}/close`, { body: {} });
      if (!r.ok) { bootCtx.deps?.toast?.(r.message); return; }
      bootCtx.deps?.toast?.("Lobby closed.");
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='edit-lobby']").forEach((btn) => {
    btn.addEventListener("click", () => openEditLobbyDialog(state));
  });
  scope.querySelectorAll("[data-act='accept-join']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(
        `/coop/lobbies/${btn.dataset.lobby}/accept`,
        { body: { fromSteamId: btn.dataset.from } },
      );
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      bootCtx.deps?.toast?.("Paired!");
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='decline-join']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(
        `/coop/lobbies/${btn.dataset.lobby}/decline`,
        { body: { fromSteamId: btn.dataset.from } },
      );
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='cancel-join']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(
        `/coop/lobbies/${btn.dataset.lobby}/cancel-request`,
        { body: {} },
      );
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='accept-invite']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(`/coop/invites/${btn.dataset.invite}/accept`, { body: {} });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      bootCtx.deps?.toast?.("Invite accepted!");
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='decline-invite']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(`/coop/invites/${btn.dataset.invite}/decline`, { body: {} });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      await refreshState({ force: true });
    });
  });
  scope.querySelectorAll("[data-act='cancel-invite']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(`/coop/invites/${btn.dataset.invite}/cancel`, { body: {} });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      await refreshState({ force: true });
    });
  });
}

function openEditLobbyDialog(state) {
  const lobby = state.lobby;
  if (!lobby) return;
  if (document.getElementById("coop-edit-lobby-form")) return;
  const $card = document.getElementById("coop-context");
  if (!$card) return;
  const $form = document.createElement("form");
  $form.id = "coop-edit-lobby-form";
  $form.className = "coop-create-lobby-form";
  $form.innerHTML = `
    <h4>Edit lobby</h4>
    <label class="coop-pref-field coop-pref-field--wide">
      <span class="field-label">Title</span>
      <input type="text" name="title" required maxlength="80" value="${esc(lobby.title)}" />
    </label>
    <div class="coop-prefs-grid">
      <label class="coop-pref-field">
        <span class="field-label">Goal</span>
        <select name="goal">
          ${["any","casual","climb","a20","heart","teaching","learning","daily","experimental"].map(
            (g) => `<option value="${g}"${g === lobby.goal ? " selected" : ""}>${esc(goalLabel(g))}</option>`,
          ).join("")}
        </select>
      </label>
      <label class="coop-pref-field">
        <span class="field-label">Asc min</span>
        <input type="number" name="ascensionMin" min="0" max="20" step="1" value="${esc(lobby.ascensionMin ?? "")}" />
      </label>
      <label class="coop-pref-field">
        <span class="field-label">Asc max</span>
        <input type="number" name="ascensionMax" min="0" max="20" step="1" value="${esc(lobby.ascensionMax ?? "")}" />
      </label>
      <label class="coop-pref-field coop-pref-field--wide">
        <span class="field-label">Note</span>
        <input type="text" name="note" maxlength="160" value="${esc(lobby.note || "")}" />
      </label>
    </div>
    <div class="coop-status-actions">
      <button type="submit" class="btn-primary">Save</button>
      <button type="button" class="btn-ghost" data-cancel>Cancel</button>
    </div>
  `;
  $card.appendChild($form);
  $form.querySelector("[data-cancel]")?.addEventListener("click", () => $form.remove());
  $form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData($form);
    const body = {
      title: String(fd.get("title") || "").trim(),
      goal: String(fd.get("goal") || "any"),
      ascensionMin: parseIntOrUndef(String(fd.get("ascensionMin") || "")),
      ascensionMax: parseIntOrUndef(String(fd.get("ascensionMax") || "")),
      note: String(fd.get("note") || "").trim() || undefined,
    };
    const r = await jsonFetch(`/coop/lobbies/${lobby.lobbyId}`, {
      method: "PATCH",
      body,
    });
    if (!r.ok) { bootCtx.deps?.toast?.(r.message); return; }
    bootCtx.deps?.toast?.("Lobby updated.");
    $form.remove();
    await refreshState({ force: true });
  });
}

// -------------------------------------------------------------------------
// Section 3 — Open run lobbies
// -------------------------------------------------------------------------
function renderLobbies(state) {
  const $list = document.getElementById("coop-lobbies-list");
  const $count = document.getElementById("coop-lobbies-count");
  if (!$list) return;
  const lobbies = state.openLobbies || [];
  $count.textContent = String(lobbies.length);
  if (lobbies.length === 0) {
    $list.innerHTML = `
      <div class="coop-empty">
        <p>No open run lobbies right now. Start one and let others join.</p>
      </div>`;
    return;
  }
  const myOutgoingByLobby = new Map(
    (state.outgoingJoinRequests || [])
      .filter((r) => r.status === "pending")
      .map((r) => [r.lobbyId, r]),
  );
  $list.innerHTML = lobbies.map((l) => renderLobbyCard(l, state, myOutgoingByLobby)).join("");
  wireLobbiesList($list, state);
}

function renderLobbyCard(lobby, state, myOutgoingByLobby) {
  const profileLink = `https://steamcommunity.com/profiles/${esc(lobby.hostSteamId)}`;
  const lastActive = formatRelative(lobby.updatedAt);
  const tagRow = [
    `<span class="coop-tag">${esc(goalLabel(lobby.goal))}</span>`,
    `<span class="coop-tag">${esc(ascensionLabel(lobby.ascensionMin, lobby.ascensionMax))}</span>`,
    lobby.voicePreference ? `<span class="coop-tag">${esc(voiceLabel(lobby.voicePreference))}</span>` : "",
    `<span class="coop-tag coop-tag--count">${lobby.memberSteamIds.length}/2</span>`,
  ].filter(Boolean).join("");
  const pendingReq = myOutgoingByLobby.get(lobby.lobbyId);
  const requestBtn = pendingReq
    ? `<button class="btn-ghost sm" data-act="cancel-join" data-lobby="${esc(lobby.lobbyId)}">Cancel request</button>`
    : `<button class="btn-primary sm" data-act="request-join" data-lobby="${esc(lobby.lobbyId)}">Request to join</button>`;
  return `
    <article class="coop-lobby-card" data-lobby-id="${esc(lobby.lobbyId)}">
      <div class="coop-card-head">
        <img class="avatar" src="${esc(lobby.hostAvatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div class="coop-lobby-title">
          <h4>${esc(lobby.title)}</h4>
          <p class="muted small">${esc(lobby.hostPersonaName)}</p>
          <div class="coop-tag-row">${tagRow}</div>
        </div>
        <div class="coop-lobby-active">
          <span class="muted small">${esc(lastActive)}</span>
        </div>
      </div>
      ${lobby.note ? `<p class="coop-lobby-note">${esc(lobby.note)}</p>` : ""}
      <div class="coop-card-actions">
        ${requestBtn}
        <a class="btn-ghost sm" target="_blank" rel="noopener" href="${profileLink}">Steam profile</a>
        ${lobby.discordHandle ? `<button class="btn-ghost sm" data-act="copy-discord" data-handle="${esc(lobby.discordHandle)}">Copy Discord</button>` : ""}
      </div>
    </article>`;
}

function wireLobbiesList($list, state) {
  $list.querySelectorAll("[data-act='request-join']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/request`, { body: {} });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      bootCtx.deps?.toast?.("Request sent.");
      await refreshState({ force: true });
    });
  });
  $list.querySelectorAll("[data-act='cancel-join']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await jsonFetch(`/coop/lobbies/${btn.dataset.lobby}/cancel-request`, { body: {} });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      await refreshState({ force: true });
    });
  });
  $list.querySelectorAll("[data-act='copy-discord']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const handle = btn.dataset.handle || "";
      navigator.clipboard?.writeText(handle).catch(() => {});
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy Discord"), 1500);
    });
  });
}

// -------------------------------------------------------------------------
// Section 4 — Recommended matches
// -------------------------------------------------------------------------
function renderRecommendations(state) {
  const $list = document.getElementById("coop-recs-list");
  const $count = document.getElementById("coop-recs-count");
  if (!$list) return;
  const recs = state.recommendedMatches || [];
  $count.textContent = String(recs.length);
  if (recs.length === 0) {
    $list.innerHTML = `<div class="coop-empty"><p>No matches yet. Update your preferences and try again.</p></div>`;
    return;
  }
  $list.innerHTML = recs.map(renderRecCard).join("");
  wireRecsList($list);
}

function renderRecCard(rec) {
  const profileLink = `https://steamcommunity.com/profiles/${esc(rec.steamId)}`;
  const labelClass = ({
    "Strong match": "coop-rec-strong",
    "Good match": "coop-rec-good",
    "Different goal": "coop-rec-different",
    "Recently active": "coop-rec-recent",
  })[rec.label] || "coop-rec-recent";
  return `
    <article class="coop-rec-card ${labelClass}">
      <div class="coop-card-head">
        <img class="avatar" src="${esc(rec.avatarUrl || "/assets/vault-mark.svg")}" alt="" />
        <div>
          <h4>${esc(rec.personaName)}</h4>
          <p class="muted small">${esc(rec.label)} · ${esc(formatRelative(rec.lastHeartbeatAt))}</p>
          <div class="coop-tag-row">
            <span class="coop-tag">${esc(goalLabel(rec.goal))}</span>
            <span class="coop-tag">${esc(ascensionLabel(rec.ascensionMin, rec.ascensionMax))}</span>
            ${rec.voicePreference ? `<span class="coop-tag">${esc(voiceLabel(rec.voicePreference))}</span>` : ""}
            ${rec.hasDiscord ? `<span class="coop-tag">Discord</span>` : ""}
          </div>
        </div>
      </div>
      ${rec.note ? `<p class="coop-lobby-note">${esc(rec.note)}</p>` : ""}
      <div class="coop-card-actions">
        <button class="btn-primary sm" data-act="invite" data-to="${esc(rec.steamId)}" data-name="${esc(rec.personaName)}">Invite to play</button>
        <a class="btn-ghost sm" target="_blank" rel="noopener" href="${profileLink}">Steam profile</a>
      </div>
    </article>`;
}

function wireRecsList($list) {
  $list.querySelectorAll("[data-act='invite']").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.to;
      // Try to use the host page's invite-modal flow first; if it isn't
      // wired (legacy fallback), send a default invite directly.
      if (typeof bootCtx.deps?.openInviteModal === "function") {
        bootCtx.deps.openInviteModal(target, btn.dataset.name);
        return;
      }
      btn.disabled = true;
      const r = await jsonFetch("/coop/invites", { body: { toSteamId: target, messagePreset: "coop_any" } });
      if (!r.ok) { btn.disabled = false; bootCtx.deps?.toast?.(r.message); return; }
      bootCtx.deps?.toast?.("Invite sent.");
      await refreshState({ force: true });
    });
  });
}
