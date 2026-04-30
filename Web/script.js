// The Vault — Web companion (signed-in app shell)
// =========================================================================
// Pure ES module, no build step. Talks to the Worker the macOS app does.
//
// Top-level state machine:
//   - no localStorage session     → render hero, sign-in CTA only
//   - session present             → render full sidebar+tab app shell
//
// Tabs in the shell are 1:1 with macOS app sidebar sections:
//   Overview / Characters / Ascensions / Top Relics / Cards / Recent Runs
//   (all powered by an uploaded `history.json` parsed client-side)
// plus
//   Co-op (presence + canned-message invite system + Steam deep-links)
// =========================================================================

import * as Stats from "/lib/stats-engine.js?v=4";
import * as HistoryStore from "/lib/history-store.js?v=4";
import * as InviteAPI from "/lib/invites.js?v=4";

// ─── Constants ─────────────────────────────────────────────────────────
const SERVER_URL  = "https://vault-coop.coreycrooks.workers.dev";
const RETURN_URL  = `${window.location.origin}/auth.html`;
const STS2_APP_ID = "2868840";
const STORAGE_SESSION       = "vault.web.session";
const STORAGE_DRAFT         = "vault.web.presence.draft";
const STORAGE_LAST_TAB      = "vault.web.last-tab";
// Poll cadences are tuned to keep us well under Cloudflare KV's free-tier
// daily quotas (1k writes/day, 1k list ops/day, 100k reads/day). A single
// pair of active browsers used to burn the list-op quota in hours; new
// roster-style storage on the server eliminated lists entirely, but we
// also slowed these down because there's no UX win in 12-second polls.
const POLL_FEED_MS          = 30_000;  // was 12_000
const POLL_INBOX_MS         = 30_000;  // was 10_000
const HEARTBEAT_MS          = 180_000; // was 90_000

const TABS_WITH_DATA = ["overview", "characters", "ascensions", "relics", "cards", "runs"];

// ─── Module state ──────────────────────────────────────────────────────
const session = readSession();
let parsedRuns = [];          // current normalized history runs (in memory)
let lastFeed   = [];          // last feed snapshot
let lastInbox  = [];          // last inbox snapshot
let activeTab  = "overview";  // which tab panel is showing
let pendingInviteToID = null; // who the modal is targeting
let pollFeedTimer  = null;
let pollInboxTimer = null;
let heartbeatTimer = null;
let pushTimer      = null;

// IDs of pending invites we've already announced to the user. Lets us tell
// "this invite just landed for the first time" from "we've been polling and
// it's been there for two minutes." We only fire the loud notification path
// once per id; subsequent polls leave the inbox banner alone.
const ANNOUNCED_INVITE_IDS = new Set();
const BASE_TAB_TITLE = "The Vault · Web";
let HAS_PROMPTED_NOTIFICATION = false; // ask permission lazily, once

// ─── Boot ──────────────────────────────────────────────────────────────
if (session) {
  bootSignedIn();
} else {
  bootSignedOut();
}

// =========================================================================
// SIGNED-OUT
// =========================================================================
function bootSignedOut() {
  document.getElementById("signin-btn").addEventListener("click", () => {
    const nonce = randomNonce();
    sessionStorage.setItem("vault.auth.nonce", nonce);
    const u = new URL(`${SERVER_URL}/auth/steam/start`);
    u.searchParams.set("return", RETURN_URL);
    u.searchParams.set("nonce", nonce);
    window.location.assign(u.toString());
  });
  void refreshPublicCount();
  setInterval(refreshPublicCount, POLL_FEED_MS);
}

async function refreshPublicCount() {
  const $text = document.getElementById("presence-text");
  if (!$text) return;
  try {
    const list = await fetchFeed();
    if (list.length === 0) {
      $text.textContent = "No one online right now. Be the first.";
    } else {
      const looking = list.filter((p) => p.status === "looking").length;
      $text.textContent =
        list.length === 1
          ? "1 player online right now"
          : `${list.length} players online · ${looking} looking for co-op`;
    }
  } catch {
    $text.textContent = "Live count momentarily unavailable.";
  }
}

// =========================================================================
// SIGNED-IN: shell setup
// =========================================================================
async function bootSignedIn() {
  document.getElementById("topbar-public").hidden = true;
  document.getElementById("main-public").hidden = true;
  document.getElementById("app-shell").hidden = false;

  // Header / footer of the sidebar
  document.getElementById("me-pill-name").textContent = session.personaName;
  if (session.avatarURL) {
    document.getElementById("me-pill-avatar").src = session.avatarURL;
    document.getElementById("me-avatar").src = session.avatarURL;
  }
  document.getElementById("me-persona").textContent = session.personaName;
  document.getElementById("me-tier").textContent =
    "Signed in with Steam · " + session.steamID.slice(0,4) + "…" + session.steamID.slice(-4);
  setStatus("connecting", "Connecting…");

  // Tab navigation — sidebar buttons + content panels
  document.querySelectorAll(".nav-row").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  switchTab(localStorage.getItem(STORAGE_LAST_TAB) || "coop");

  // Co-op form wiring
  wireCoopForm();
  // Refresh button. Debounced to once per ~5 s so a frustrated panic-clicker
  // can't blast our server quotas. The button visually "ticks" each press
  // even when the request is throttled, so it still feels responsive.
  const refreshBtn = document.getElementById("refresh-btn");
  let lastRefreshAt = 0;
  refreshBtn.addEventListener("click", () => {
    const now = Date.now();
    refreshBtn.classList.remove("is-flash");
    void refreshBtn.offsetWidth; // restart the CSS transition
    refreshBtn.classList.add("is-flash");
    if (now - lastRefreshAt < 5000) return;
    lastRefreshAt = now;
    void pullFeed();
    void pullInbox();
  });
  document.getElementById("signout-btn").addEventListener("click", () => void signOut());

  // Drag-drop history.json
  wireDropOverlay();
  document.querySelectorAll('[data-action="upload"]').forEach((btn) => {
    btn.addEventListener("click", triggerFilePicker);
  });
  document.getElementById("history-file-input").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) void ingestHistoryFile(file);
    e.target.value = ""; // allow re-selecting same file
  });

  // Invite modal scaffolding
  wireInviteModal();

  // Load preset message catalog (used by both the Note <select> and the modal)
  try {
    await InviteAPI.loadMessageCatalog(SERVER_URL);
    populateInviteOptions();
  } catch (e) {
    console.warn("could not load invite messages", e);
  }

  // Try to restore a previously uploaded history
  try {
    const cached = await HistoryStore.loadHistory();
    if (cached?.runs?.length) {
      parsedRuns = cached.runs.map(reviveRun);
      renderActiveTab();
    } else {
      renderActiveTab(); // shows empty states for stat tabs
    }
  } catch (e) {
    console.warn("could not load cached history", e);
    renderActiveTab();
  }

  // Push presence + start polling
  schedulePush(0);
  pollFeedTimer  = setInterval(pullFeed,  POLL_FEED_MS);
  pollInboxTimer = setInterval(pullInbox, POLL_INBOX_MS);
  heartbeatTimer = setInterval(() => pushNow(true), HEARTBEAT_MS);
  await Promise.all([pullFeed(), pullInbox()]);

  window.addEventListener("beforeunload", () => {
    try {
      const blob = new Blob([], { type: "text/plain" });
      navigator.sendBeacon && navigator.sendBeacon(`${SERVER_URL}/presence`, blob);
    } catch {}
  });
}

// =========================================================================
// Tabs
// =========================================================================
function switchTab(tab) {
  if (!tab) tab = "coop";
  activeTab = tab;
  localStorage.setItem(STORAGE_LAST_TAB, tab);
  document.querySelectorAll(".nav-row").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.tab !== tab;
  });
  renderActiveTab();
}

function renderActiveTab() {
  if (TABS_WITH_DATA.includes(activeTab)) {
    renderStatsTab(activeTab);
  } else if (activeTab === "coop") {
    // Co-op view is reactive on its own pulls; just make sure feed shows once.
    if (lastFeed.length) renderFeed(lastFeed);
    renderInbox(lastInbox);
  }
}

// =========================================================================
// Co-op form (your status card)
// =========================================================================
function wireCoopForm() {
  document.querySelectorAll('input[name="status"]').forEach((el) =>
    el.addEventListener("change", schedulePush)
  );
  document.getElementById("me-discord").addEventListener("input", schedulePush);

  // Restore last draft (status pill + discord handle).
  const draft = readDraft();
  setRadio("status", draft.status ?? "looking");
  document.getElementById("me-discord").value = draft.discordHandle ?? "";
}

/**
 * Read the only two things on the user's status card that actually go to the
 * server: their status pill and an optional Discord handle.
 *
 * The previous "Note (preset)" dropdown was a passive broadcast that nobody's
 * mental model expected — looked like a message-send surface but didn't
 * actually message anyone. Removed entirely. The real send path is the
 * Invite-to-play modal on each player row in the feed.
 */
function readMyForm() {
  const status = (document.querySelector('input[name="status"]:checked') || {}).value || "looking";
  const discordHandle = (document.getElementById("me-discord").value || "").trim();

  return {
    status,
    discordHandle: discordHandle || undefined,
    stats: undefined,
  };
}

function schedulePush(delay = 600) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow(false), delay);
}

async function pushNow(silent) {
  const body = readMyForm();
  saveDraft(body);
  if (!silent) showPushingPill(true);
  try {
    const resp = await fetch(`${SERVER_URL}/presence`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.sessionToken}`,
      },
      body: JSON.stringify({
        status: body.status,
        discordHandle: body.discordHandle,
      }),
    });
    if (resp.status === 401) {
      localStorage.removeItem(STORAGE_SESSION);
      window.location.reload();
      return;
    }
    setStatus(resp.ok ? "online" : "trouble", resp.ok ? "Live on the feed" : "Trouble reaching server");
  } catch (e) {
    console.warn("presence push error", e);
    setStatus("trouble", "Trouble reaching server");
  } finally {
    if (!silent) setTimeout(() => showPushingPill(false), 400);
  }
}

async function pullFeed() {
  try {
    const list = await fetchFeed();
    lastFeed = list;
    if (activeTab === "coop") renderFeed(list);
    updateCoopBadge();
    document.getElementById("last-updated").textContent =
      "Last updated " + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn("feed fetch failed", e);
  }
}

async function pullInbox() {
  try {
    const r = await InviteAPI.fetchInbox(SERVER_URL, session.sessionToken);
    if (!r.ok) return;
    const previousInbox = lastInbox;
    lastInbox = r.invites ?? [];
    if (activeTab === "coop") renderInbox(lastInbox);
    updateCoopBadge();
    updateTabTitle();
    announceNewInvites(previousInbox, lastInbox);
  } catch (e) {
    console.warn("inbox fetch failed", e);
  }
}

/**
 * Mirror the pending-invite count into the document.title so the user can see
 * "(1) The Vault · Web" in the OS tab/window list even when the tab is in
 * the background. Cheap and effective.
 */
function updateTabTitle() {
  const pending = lastInbox.filter((i) => i.status === "pending").length;
  document.title = pending > 0 ? `(${pending}) ${BASE_TAB_TITLE}` : BASE_TAB_TITLE;
}

/**
 * Loud-arrival path. The first time we see a given pending invite id we:
 *   1. Flash the inbox banner with a gold pulse so it's impossible to miss.
 *   2. Fire a real OS-level Notification if the user has granted permission.
 *      We ask for permission lazily — only on the FIRST inbound invite, never
 *      on page load — because asking up front gets you "Block, never ask
 *      again" 99% of the time.
 *   3. Toast in-page as a fallback.
 *
 * Subsequent polls of the same invite are silent. Declining or accepting an
 * invite removes it from `lastInbox`, which removes its id from
 * `ANNOUNCED_INVITE_IDS` — meaning if a player re-invites you later (after
 * the per-pair 60 s dedupe window), it announces again like new.
 */
function announceNewInvites(prev, curr) {
  const prevIds = new Set(prev.map((i) => i.id));
  const newPending = curr.filter(
    (i) => i.status === "pending" && !ANNOUNCED_INVITE_IDS.has(i.id) && !prevIds.has(i.id)
  );
  if (newPending.length === 0) {
    // Garbage-collect the announce set so removed invites can re-announce.
    const live = new Set(curr.map((i) => i.id));
    for (const id of ANNOUNCED_INVITE_IDS) if (!live.has(id)) ANNOUNCED_INVITE_IDS.delete(id);
    return;
  }

  for (const inv of newPending) ANNOUNCED_INVITE_IDS.add(inv.id);

  // 1. Flash the inbox banner.
  const $inbox = document.getElementById("inbox");
  if ($inbox) {
    $inbox.classList.remove("is-flash");
    void $inbox.offsetWidth; // restart the CSS keyframes
    $inbox.classList.add("is-flash");
  }

  // 2. Try the OS-level popup. Permission state machine:
  //    - "granted":  fire it.
  //    - "default":  ask once. If they grant, fire it for the next one.
  //    - "denied":   skip silently; the in-page banner is the fallback.
  if (typeof Notification !== "undefined") {
    if (Notification.permission === "granted") {
      fireOSNotification(newPending[0]);
    } else if (Notification.permission === "default" && !HAS_PROMPTED_NOTIFICATION) {
      HAS_PROMPTED_NOTIFICATION = true;
      Notification.requestPermission().then((p) => {
        if (p === "granted") fireOSNotification(newPending[0]);
      }).catch(() => {});
    }
  }

  // 3. Always toast in-page; the banner highlight + toast together carry the
  //    message even when the OS notification is blocked.
  const first = newPending[0];
  const who = first.fromPersona || "Someone";
  toast(
    newPending.length === 1
      ? `${who} wants to play. Open Co-op to accept or decline.`
      : `${newPending.length} new invites. Open Co-op to respond.`
  );
}

function fireOSNotification(invite) {
  try {
    const text = InviteAPI.getMessageText(invite.messageId) ?? "Wants to play.";
    new Notification(`${invite.fromPersona || "Someone"} wants to play`, {
      body: text,
      icon: invite.fromAvatar || "/assets/vault-mark.svg",
      tag: `spirevault-invite-${invite.id}`, // coalesces if multiple arrive
    });
  } catch { /* notification API quirks vary; never fail the poll */ }
}

async function fetchFeed() {
  const r = await fetch(`${SERVER_URL}/presence`, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

function updateCoopBadge() {
  const others = lastFeed.filter((p) => p.steamID !== session.steamID);
  const inboxCount = lastInbox.filter((i) => i.status === "pending").length;
  const $badge = document.getElementById("nav-coop-count");
  // Show the most useful number — pending invites win because they're personal.
  if (inboxCount > 0) {
    $badge.textContent = inboxCount;
    $badge.hidden = false;
    $badge.classList.add("is-urgent");
  } else if (others.length > 0) {
    $badge.textContent = others.length;
    $badge.hidden = false;
    $badge.classList.remove("is-urgent");
  } else {
    $badge.hidden = true;
  }
}

async function signOut() {
  try {
    await fetch(`${SERVER_URL}/presence`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
  } catch {}
  localStorage.removeItem(STORAGE_SESSION);
  localStorage.removeItem(STORAGE_DRAFT);
  // Keep cached history.json — that's the user's data, sign-out shouldn't nuke it.
  window.location.replace("/");
}

// =========================================================================
// Co-op feed renderer
// =========================================================================
function renderFeed(list) {
  const others = list.filter((p) => p.steamID !== session.steamID);
  const inGame = others.filter((p) => p.inSTS2).length;
  const looking = others.filter((p) => p.status === "looking").length;

  document.getElementById("online-count").textContent = String(others.length);
  document.getElementById("online-summary").textContent =
    others.length === 0
      ? "No one else online right now. Hang around, heartbeats land every 30 seconds."
      : `${others.length} other player${others.length === 1 ? "" : "s"} online · ` +
        `${looking} looking · ${inGame} in Slay the Spire 2`;

  const $feed = document.getElementById("feed");
  if (others.length === 0) {
    $feed.innerHTML = `<div class="feed-empty"><p>You're online. Be the first someone bumps into.</p></div>`;
    return;
  }

  // Sort: looking + in-game first, then looking, then others.
  others.sort((a, b) => rank(b) - rank(a));
  function rank(p) {
    let n = 0;
    if (p.status === "looking") n += 100;
    if (p.inSTS2) n += 50;
    if (p.status === "inRun") n += 10;
    return n;
  }

  $feed.innerHTML = others.map(renderRow).join("");
  // Wire actions
  $feed.querySelectorAll("button[data-act='discord']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const handle = btn.dataset.handle ?? "";
      navigator.clipboard?.writeText(handle).catch(() => {});
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy Discord"), 1500);
    });
  });
  $feed.querySelectorAll("button[data-act='invite']").forEach((btn) => {
    btn.addEventListener("click", () => openInviteModal(btn.dataset.id, btn.dataset.name));
  });
}

function renderRow(p) {
  const status = p.status ?? "looking";
  const tagClass = { looking: "ok", inRun: "gold", inCoop: "ember", afk: "mute" }[status];
  const tagLabel = { looking: "Looking", inRun: "Solo run", inCoop: "In co-op", afk: "AFK" }[status];

  // Steam avatar — server-stamped, but defense-in-depth scrub.
  const safeAvatar = (() => {
    try {
      const u = new URL(p.avatarURL ?? "");
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {}
    return "/assets/vault-mark.svg";
  })();

  const sid = /^\d{17}$/.test(p.steamID) ? p.steamID : "";
  const steamProfileWeb = sid ? `https://steamcommunity.com/profiles/${sid}` : "#";
  const steamProfileDeep = sid ? `steam://url/SteamIDPage/${sid}` : "#";

  const persona = p.personaName || "Steam User";

  return `
    <article class="row ${status}" data-sid="${esc(sid)}">
      <img class="avatar" alt="" src="${esc(safeAvatar)}" />
      <div class="meta">
        <div class="meta-line">
          <span class="name">${esc(persona)}</span>
          <span class="tag ${tagClass}">${tagLabel}</span>
          ${p.inSTS2 ? `<span class="tag live">In STS2</span>` : ""}
        </div>
        <p class="row-hint muted">Send them an invite to play.</p>
      </div>
      <div class="actions">
        <button class="btn-primary sm" data-act="invite" data-id="${esc(sid)}" data-name="${esc(persona)}">Invite to play</button>
        <a class="action-link" target="_blank" rel="noopener" href="${esc(steamProfileWeb)}" title="Open Steam profile in browser">Profile</a>
        <a class="action-link" href="${esc(steamProfileDeep)}" title="Open in Steam client">Steam</a>
        ${p.discordHandle ? `<button class="action-link" data-act="discord" data-handle="${esc(p.discordHandle)}">Copy Discord</button>` : ""}
      </div>
    </article>`;
}

// =========================================================================
// Inbox (incoming invites)
// =========================================================================
function renderInbox(invites) {
  const $inbox = document.getElementById("inbox");
  const $list  = document.getElementById("inbox-list");
  const pending = (invites ?? []).filter((i) => i.status === "pending" || i.status === "accepted");
  document.getElementById("inbox-count").textContent = String(pending.filter(i => i.status === "pending").length);
  if (!pending.length) {
    $inbox.hidden = true;
    return;
  }
  $inbox.hidden = false;
  $list.innerHTML = pending.map(renderInboxRow).join("");

  $list.querySelectorAll("button[data-invite-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.inviteAct;
      btn.disabled = true;
      const r = await InviteAPI.respondToInvite(SERVER_URL, session.sessionToken, id, action);
      btn.disabled = false;
      if (!r.ok) {
        toast(`Couldn't ${action}: ${r.error ?? "unknown error"}`);
        return;
      }
      await pullInbox();
    });
  });
}

function renderInboxRow(invite) {
  const safeAvatar = (() => {
    try {
      const u = new URL(invite.fromAvatar ?? "");
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {}
    return "/assets/vault-mark.svg";
  })();
  const messageText = InviteAPI.getMessageText(invite.messageId) ?? "Wants to play.";
  const sid = invite.fromID;
  const steamDeep = `steam://url/SteamIDPage/${esc(sid)}`;
  const launchSTS = `steam://run/${STS2_APP_ID}`;

  if (invite.status === "accepted") {
    // Brief "accepted — here are the deep-links" state.
    return `
      <div class="invite-card invite-accepted">
        <img class="avatar" alt="" src="${esc(safeAvatar)}" />
        <div class="invite-meta">
          <strong>You accepted ${esc(invite.fromPersona)}'s invite</strong>
          <p class="muted small">Add them on Steam, then launch STS2 from this browser.</p>
        </div>
        <div class="invite-actions">
          <a class="btn-primary sm" href="${steamDeep}" title="Open in Steam client">Open Steam profile</a>
          <a class="btn-ghost sm" href="${launchSTS}" title="Launch Slay the Spire 2 via Steam">Launch STS2</a>
        </div>
      </div>`;
  }

  return `
    <div class="invite-card">
      <img class="avatar" alt="" src="${esc(safeAvatar)}" />
      <div class="invite-meta">
        <strong>${esc(invite.fromPersona)}</strong>
        <p class="invite-msg">"${esc(messageText)}"</p>
      </div>
      <div class="invite-actions">
        <button class="btn-primary sm" data-invite-act="accept" data-id="${esc(invite.id)}">Accept</button>
        <button class="btn-ghost sm"   data-invite-act="decline" data-id="${esc(invite.id)}">Decline</button>
      </div>
    </div>`;
}

// =========================================================================
// Invite modal (outgoing)
// =========================================================================
function wireInviteModal() {
  document.getElementById("invite-modal-close").addEventListener("click", closeInviteModal);
  document.getElementById("invite-modal").addEventListener("click", (e) => {
    if (e.target.id === "invite-modal") closeInviteModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("invite-modal").hidden) closeInviteModal();
  });
}

function populateInviteOptions() {
  const $opts = document.getElementById("invite-options");
  const catalog = InviteAPI.getMessageCatalog();
  $opts.innerHTML = "";
  for (const [id, text] of Object.entries(catalog)) {
    const btn = document.createElement("button");
    btn.className = "invite-option";
    btn.dataset.messageId = id;
    btn.textContent = text;
    btn.addEventListener("click", () => sendInviteFromModal(id));
    $opts.appendChild(btn);
  }
}

function openInviteModal(toID, persona) {
  if (!/^\d{17}$/.test(toID)) return;
  pendingInviteToID = toID;
  document.getElementById("invite-modal-sub").textContent =
    `Send to ${persona}. They can accept or decline. No free text, just preset messages.`;
  const $modal = document.getElementById("invite-modal");
  $modal.hidden = false;
  document.body.style.overflow = "hidden";
  // focus the first option
  setTimeout(() => $modal.querySelector(".invite-option")?.focus(), 30);
}

function closeInviteModal() {
  document.getElementById("invite-modal").hidden = true;
  document.body.style.overflow = "";
  pendingInviteToID = null;
}

async function sendInviteFromModal(messageId) {
  if (!pendingInviteToID) return closeInviteModal();
  const r = await InviteAPI.sendInvite(SERVER_URL, session.sessionToken, pendingInviteToID, messageId);
  closeInviteModal();
  if (!r.ok) {
    if (r.error === "recipient_offline") {
      toast("That player just went offline.");
    } else {
      toast(`Couldn't send invite: ${r.error}`);
    }
    return;
  }
  toast("Invite sent. They'll see it pop up in their inbox.");
}

// =========================================================================
// History.json upload
// =========================================================================
function wireDropOverlay() {
  const $ov = document.getElementById("drop-overlay");
  let dragDepth = 0;

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $ov.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $ov.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $ov.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (file) void ingestHistoryFile(file);
  });

  function hasFiles(e) {
    const items = e.dataTransfer?.types ?? [];
    return Array.from(items).includes("Files");
  }
}

function triggerFilePicker() {
  document.getElementById("history-file-input").click();
}

async function ingestHistoryFile(file) {
  if (file.size > 50 * 1024 * 1024) {
    toast("That file is huge (>50 MB). Are you sure it's history.json?");
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch {
    toast("Couldn't read that file.");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast("That file isn't valid JSON.");
    return;
  }
  const result = Stats.extractRuns(parsed);
  if (!result.ok) {
    toast(result.error);
    return;
  }
  if (result.runs.length === 0) {
    toast("File parsed, but it had zero runs in it.");
    return;
  }
  parsedRuns = result.runs;
  // Persist (serialized form — Date objects round-trip via ISO)
  await HistoryStore.saveHistory({
    savedAt: new Date().toISOString(),
    sourceFilename: file.name,
    runs: result.runs.map(serializeRun),
  });
  toast(`Loaded ${result.runs.length} run${result.runs.length === 1 ? "" : "s"}.`);
  // If user is on a stat tab, re-render. Otherwise hop them to Overview.
  if (TABS_WITH_DATA.includes(activeTab)) {
    renderStatsTab(activeTab);
  } else {
    switchTab("overview");
  }
}

function serializeRun(r) {
  return {
    ...r,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    endedAt:   r.endedAt   ? r.endedAt.toISOString()   : null,
  };
}

function reviveRun(r) {
  return {
    ...r,
    startedAt: r.startedAt ? new Date(r.startedAt) : null,
    endedAt:   r.endedAt   ? new Date(r.endedAt)   : null,
  };
}

// =========================================================================
// Stats tab renderers
// =========================================================================
function renderStatsTab(tab) {
  const $body = document.getElementById(`${tab}-body`);
  if (!$body) return;
  if (parsedRuns.length === 0) {
    $body.innerHTML = renderEmptyState();
    $body.querySelector("[data-action='upload']")?.addEventListener("click", triggerFilePicker);
    return;
  }
  const report = Stats.summarize(parsedRuns);
  switch (tab) {
    case "overview":   $body.innerHTML = renderOverview(report);   break;
    case "characters": $body.innerHTML = renderBucketTable(report.byCharacter, { keyLabel: "Character", capitalize: true }); break;
    case "ascensions": $body.innerHTML = renderBucketTable(report.byAscension, { keyLabel: "Ascension" }); break;
    case "relics":     $body.innerHTML = renderBucketTable(report.byRelic,     { keyLabel: "Relic", showPickedRate: true }); break;
    case "cards":      $body.innerHTML = renderCards(report);     break;
    case "runs":       $body.innerHTML = renderRecentRuns(parsedRuns); break;
  }
  // Update Overview sub-text
  if (tab === "overview") {
    document.getElementById("overview-sub").textContent =
      `${report.totalRuns} run${report.totalRuns === 1 ? "" : "s"} · ${(report.overallWinrate * 100).toFixed(0)}% win rate`;
  }
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <div class="empty-state-icon">📂</div>
      <h2>Drop your <code>history.json</code></h2>
      <p>The Vault keeps your run history in <code>history.json</code>. Drag it anywhere on this page, or click below.</p>
      <button class="btn-primary" data-action="upload">↑ Choose history.json</button>
      <details class="empty-state-hints">
        <summary>Where is <code>history.json</code>?</summary>
        <ul>
          <li><strong>macOS:</strong> <code>~/Library/Application Support/AscensionCompanion/vault/history.json</code></li>
          <li><strong>Windows:</strong> Run the macOS app once to generate it (a Windows scanner is on the roadmap).</li>
          <li>Stays on your device. We persist it in IndexedDB locally — never uploaded.</li>
        </ul>
      </details>
    </div>`;
}

function renderOverview(report) {
  const stat = (label, value, sub) => `
    <div class="stat-card">
      <span class="stat-label">${esc(label)}</span>
      <strong class="stat-value">${esc(value)}</strong>
      ${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ""}
    </div>`;
  const topChar = report.byCharacter[0];
  const topAsc  = report.byAscension.slice().sort((a, b) => parseAsc(b.key) - parseAsc(a.key))[0];

  return `
    <div class="stat-grid">
      ${stat("Total runs",  String(report.totalRuns))}
      ${stat("Wins",        String(report.totalWins))}
      ${stat("Win rate",    `${(report.overallWinrate * 100).toFixed(1)}%`)}
      ${stat("Top character", topChar ? capitalize(topChar.key) : "—", topChar ? `${topChar.runs} runs · ${(topChar.winrate * 100).toFixed(0)}%` : "")}
      ${stat("Highest ascension", topAsc ? topAsc.key : "—", topAsc ? `${topAsc.runs} runs · ${(topAsc.winrate * 100).toFixed(0)}%` : "")}
    </div>
    <h3 class="section-title">Win rate by character</h3>
    ${renderBucketTable(report.byCharacter, { keyLabel: "Character", capitalize: true })}
    <h3 class="section-title">Top relics</h3>
    ${renderBucketTable(report.byRelic.slice(0, 6), { keyLabel: "Relic", showPickedRate: true })}`;
}

function renderBucketTable(buckets, opts = {}) {
  if (!buckets || !buckets.length) {
    return `<p class="muted">No data in your history yet.</p>`;
  }
  const formatKey = (k) => {
    if (opts.capitalize) return capitalize(k);
    return k;
  };
  const headerExtra = opts.showPickedRate ? `<th class="num">Seen</th>` : "";
  return `
    <table class="bucket-table">
      <thead><tr>
        <th>${esc(opts.keyLabel ?? "Key")}</th>
        <th class="num">Runs</th>
        <th class="num">Wins</th>
        <th class="num">Win rate</th>
        ${headerExtra}
      </tr></thead>
      <tbody>
        ${buckets.map((b) => {
          const wr = (b.winrate * 100).toFixed(0);
          const wrCell = `
            <td class="num">
              <div class="winrate-bar">
                <span class="winrate-fill" style="width:${Math.min(100, b.winrate * 100)}%"></span>
                <span class="winrate-num">${wr}%</span>
              </div>
            </td>`;
          const seenCell = opts.showPickedRate
            ? `<td class="num">${((b.pickedRate ?? 0) * 100).toFixed(0)}%</td>`
            : "";
          return `<tr>
            <td>${esc(formatKey(b.key))}</td>
            <td class="num">${b.runs}</td>
            <td class="num">${b.wins}</td>
            ${wrCell}
            ${seenCell}
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

function renderCards(report) {
  return `
    <div class="cards-split">
      <div>
        <h3 class="section-title">Most picked</h3>
        ${renderBucketTable(report.topPickedCards, { keyLabel: "Card" })}
      </div>
      <div>
        <h3 class="section-title">Most skipped</h3>
        ${renderSkippedTable(report.topSkippedCards)}
      </div>
    </div>`;
}

function renderSkippedTable(buckets) {
  if (!buckets?.length) return `<p class="muted">No skip data yet.</p>`;
  return `
    <table class="bucket-table">
      <thead><tr>
        <th>Card</th>
        <th class="num">Offered</th>
        <th class="num">Picked</th>
        <th class="num">Pick rate</th>
      </tr></thead>
      <tbody>
        ${buckets.map((b) => `
          <tr>
            <td>${esc(b.key)}</td>
            <td class="num">${b.runs}</td>
            <td class="num">${b.wins}</td>
            <td class="num">${((b.pickedRate ?? 0) * 100).toFixed(0)}%</td>
          </tr>
        `).join("")}
      </tbody>
    </table>`;
}

function renderRecentRuns(runs) {
  const sorted = runs.slice().sort((a, b) => {
    const at = a.endedAt?.getTime() ?? 0;
    const bt = b.endedAt?.getTime() ?? 0;
    return bt - at;
  });
  const slice = sorted.slice(0, 50);
  if (!slice.length) return `<p class="muted">No runs.</p>`;
  return `
    <table class="bucket-table">
      <thead><tr>
        <th>When</th>
        <th>Character</th>
        <th class="num">Asc</th>
        <th>Result</th>
        <th class="num">Floor</th>
        <th class="num">Time</th>
      </tr></thead>
      <tbody>
        ${slice.map((r) => `
          <tr>
            <td>${esc(formatDate(r.endedAt))}</td>
            <td>${esc(capitalize(r.character) ?? "—")}</td>
            <td class="num">${r.ascension ?? "—"}</td>
            <td>${r.won ? `<span class="tag ok">Win</span>` : `<span class="tag mute">Loss</span>`}</td>
            <td class="num">${r.floorReached ?? "—"}</td>
            <td class="num">${formatPlayTime(r.playTimeSeconds)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>`;
}

function formatDate(d) {
  if (!d) return "—";
  return d.toLocaleString();
}

function formatPlayTime(s) {
  if (!s || s < 0) return "—";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h ${rem}m`;
}

function parseAsc(key) {
  const n = Number((key ?? "").replace(/^A/, ""));
  return Number.isFinite(n) ? n : -1;
}

// =========================================================================
// UI helpers
// =========================================================================
function setStatus(state, label) {
  const $dot = document.getElementById("status-dot");
  const $lbl = document.getElementById("status-label");
  $dot.dataset.state = state;
  $lbl.textContent = label;
}

function showPushingPill(visible) {
  const pill = document.getElementById("me-pushing-pill");
  if (visible) { pill.hidden = false; pill.textContent = "Sending…"; }
  else { pill.hidden = false; pill.textContent = "Saved"; }
  if (!visible) setTimeout(() => (pill.hidden = true), 800);
}

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function toast(msg) {
  let $t = document.getElementById("toast");
  if (!$t) {
    $t = document.createElement("div");
    $t.id = "toast";
    $t.className = "toast";
    document.body.appendChild($t);
  }
  $t.textContent = msg;
  $t.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $t.classList.remove("is-visible"), 3000);
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// =========================================================================
// Storage helpers
// =========================================================================
function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_SESSION);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j && /^\d{17}$/.test(j.steamID || "") && j.sessionToken) return j;
    return null;
  } catch { return null; }
}
function readDraft() {
  try { return JSON.parse(localStorage.getItem(STORAGE_DRAFT) ?? "{}"); }
  catch { return {}; }
}
function saveDraft(body) {
  try { localStorage.setItem(STORAGE_DRAFT, JSON.stringify(body)); } catch {}
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
