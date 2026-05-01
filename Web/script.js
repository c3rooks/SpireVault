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
import * as HistoryStore from "/lib/history-store.js?v=5";
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

// Where the desktop app keeps history.json on each platform. These are
// declared at the top of the module because boot code (switchTab → empty
// state) runs synchronously and pulls them in BEFORE any function-scope
// declaration further down in the file would be reached. Hoisting them
// up here avoids a Temporal Dead Zone ReferenceError on cold load that
// would otherwise wipe out the entire boot path (and silently kill
// IndexedDB persistence, presence heartbeats, and the live feed).
const HISTORY_PATH_MAC = "~/Library/Application Support/AscensionCompanion/vault/history.json";
const HISTORY_PATH_WIN = "%APPDATA%\\AscensionCompanion\\vault\\history.json";
const HISTORY_PATH_LINUX = "~/.local/share/AscensionCompanion/vault/history.json";

// ─── Module state ──────────────────────────────────────────────────────
const session = readSession();
let parsedRuns = [];          // current normalized history runs (in memory)
let lastFeed   = [];          // last feed snapshot
let lastInbox  = [];          // last inbox snapshot
let activeTab  = "overview";  // which tab panel is showing
let pendingInviteToID = null; // who the modal is targeting
let pollFeedTimer       = null;
let pollInboxTimer      = null;
let heartbeatTimer      = null;
let heartbeatWatchdog   = null;
let pushTimer           = null;

// Wall-clock timestamp of the last successful presence push. The watchdog
// uses this to detect "the setInterval fired but the request failed" or
// "the setInterval hasn't fired in a long time because the OS suspended us"
// and force a heartbeat without waiting for the next scheduled tick.
let lastSuccessfulHeartbeatAt = 0;

// IDs of pending invites we've already announced to the user. Lets us tell
// "this invite just landed for the first time" from "we've been polling and
// it's been there for two minutes." We only fire the loud notification path
// once per id; subsequent polls leave the inbox banner alone.
const ANNOUNCED_INVITE_IDS = new Set();
const BASE_TAB_TITLE = "The Vault · Web";
let HAS_PROMPTED_NOTIFICATION = false; // ask permission lazily, once

// 401 tolerance. A single 401 used to vaporize the user's session and reload
// the page, which meant any transient blip on the backend (KV consistency
// window, momentary worker error, network corruption) silently signed users
// out. Now we count consecutive 401s from authenticated requests and only
// give up when we've seen 3 in a row inside a short window. Anything that
// returns 200/2xx/3xx anywhere in between resets the counter.
const AUTH_FAIL_THRESHOLD = 3;
const AUTH_FAIL_WINDOW_MS = 5 * 60_000; // 5 min: outside this window, reset
let consecutiveAuthFails = 0;
let firstAuthFailAt = 0;

/**
 * Should we *actually* sign the user out? Called whenever we see a 401 from
 * an authenticated request. Returns true only if 3 consecutive 401s have
 * been observed within AUTH_FAIL_WINDOW_MS. Otherwise increments the counter
 * and returns false so the caller can keep going.
 */
function recordAuthFailureAndShouldGiveUp() {
  const now = Date.now();
  if (firstAuthFailAt === 0 || now - firstAuthFailAt > AUTH_FAIL_WINDOW_MS) {
    firstAuthFailAt = now;
    consecutiveAuthFails = 1;
    return false;
  }
  consecutiveAuthFails++;
  return consecutiveAuthFails >= AUTH_FAIL_THRESHOLD;
}

function resetAuthFailures() {
  consecutiveAuthFails = 0;
  firstAuthFailAt = 0;
}

/**
 * Final teardown when we're truly sure the session is gone. Pulled out so
 * both the explicit Sign Out button and the 401-storm path call the same
 * code. Does NOT clear the locally cached history.json (that's the user's
 * data; sign-out does not nuke their stats).
 */
function clearSessionAndReload() {
  localStorage.removeItem(STORAGE_SESSION);
  window.location.replace("/");
}

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
      $text.textContent = "Nobody signed up yet. Be the first.";
    } else {
      const looking = list.filter((p) => p.status === "looking").length;
      const activeNow = list.filter((p) => isActiveNow(p)).length;
      const head =
        list.length === 1 ? "1 player signed up" : `${list.length} players signed up`;
      $text.textContent = `${head} · ${activeNow} active now · ${looking} looking`;
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
  // "Find history.json" buttons (sidebar + every empty-state) all route here.
  // On Chromium browsers we use the File System Access API so we can remember
  // the file handle and reload with one click on subsequent visits. On Safari
  // and Firefox we fall back to the standard <input type="file">.
  // "scan" = primary action (Find history.json). "upload" = fallback Import
  // path that always opens the legacy <input type="file"> picker. The
  // distinction matters in the panel headers where we want both options
  // available without sliding into the smarter saved-handle path.
  document.querySelectorAll('[data-action="scan"]').forEach((btn) => {
    btn.addEventListener("click", () => void scanForHistory());
  });
  document.querySelectorAll('[data-action="upload"]').forEach((btn) => {
    btn.addEventListener("click", () => triggerFilePicker());
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

  // Try to restore a previously uploaded history. We render whatever's in
  // IndexedDB FIRST so the UI lights up instantly with last-known stats,
  // then optionally re-pull from disk a few moments later if the user has
  // a saved file handle.
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


  // Silent auto-reload from disk. If the user previously picked their
  // history.json AND the browser remembers granting read access for this
  // origin, we can quietly re-read the file with no user click. This is
  // the closest thing to true "auto-scan" the web platform allows: the
  // first pick is unavoidable (browser security), but every subsequent
  // visit is one transparent disk-read away from being fully fresh.
  //
  // Behavior matrix:
  //   - No handle saved  →  no-op, user has to click "Find history.json"
  //   - Handle + perm "granted"  →  silently re-reads, stats refresh
  //   - Handle + perm "prompt"   →  no-op, the visible "Reload" button
  //                                  in the toolbar handles the gesture
  //   - Handle + perm "denied"   →  no-op, button stays for re-grant
  //
  // Manual file picker is therefore truly the last resort: only on Safari
  // / Firefox (no FSA support) or on a brand-new browser visit where the
  // user has never picked the file from this origin before.
  void autoReloadHistoryIfPermitted();

  // Push presence + start polling
  schedulePush(0);
  pollFeedTimer  = setInterval(pullFeed,  POLL_FEED_MS);
  pollInboxTimer = setInterval(pullInbox, POLL_INBOX_MS);
  heartbeatTimer = setInterval(() => pushNow(true), HEARTBEAT_MS);

  // Watchdog. The setInterval above is the *primary* heartbeat scheduler,
  // but a heartbeat can fail to fire for many reasons that are out of our
  // control: the OS suspended the tab to save memory, the laptop slept and
  // woke up, the network blipped on the actual fetch, the browser threw
  // out our timer entirely. The watchdog runs an independent check every
  // 60 seconds against wall-clock time. If we've gone more than 1.5x the
  // heartbeat interval without a successful push, we force one. This is
  // what makes "tab open but you're elsewhere" *iron-clad*: even if every
  // primary mechanism fails, the watchdog will catch it within a minute.
  heartbeatWatchdog = setInterval(() => {
    const since = Date.now() - lastSuccessfulHeartbeatAt;
    if (since > HEARTBEAT_MS * 1.5) {
      console.info(`heartbeat watchdog firing (${Math.round(since / 1000)}s since last success)`);
      pushNow(true);
    }
  }, 60_000);

  await Promise.all([pullFeed(), pullInbox()]);

  // When the tab regains focus after being hidden (background tab, locked
  // screen, sleeping laptop), browsers throttle setInterval enough that a
  // 180s heartbeat can stretch past the 10min presence TTL. Force an
  // immediate heartbeat + feed refresh on visibility-change so the user
  // pops back onto the feed instantly instead of waiting up to 3 more
  // minutes for the next scheduled heartbeat.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      pushNow(true);
      pullFeed();
      pullInbox();
    }
  });

  // bfcache restores (back/forward navigation) don't fire visibilitychange
  // on every browser. pageshow with persisted=true is the catch-all.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      pushNow(true);
      pullFeed();
      pullInbox();
    }
  });

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
      // Don't immediately nuke the session. Many transient causes (KV blip,
      // network corruption, brief worker hiccup) return 401. Only give up
      // after AUTH_FAIL_THRESHOLD consecutive 401s inside a short window.
      const giveUp = recordAuthFailureAndShouldGiveUp();
      if (giveUp) {
        console.warn("session looks dead after 3 consecutive 401s, signing out");
        clearSessionAndReload();
        return;
      }
      console.warn(`presence 401 (${consecutiveAuthFails}/${AUTH_FAIL_THRESHOLD}), keeping session`);
      setStatus("trouble", "Trouble reaching server, retrying…");
      return;
    }
    if (resp.ok) {
      resetAuthFailures();
      lastSuccessfulHeartbeatAt = Date.now();
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
  localStorage.removeItem(STORAGE_DRAFT);
  // Keep cached history.json. That's the user's data, sign-out shouldn't nuke it.
  clearSessionAndReload();
}

// =========================================================================
// Co-op feed renderer
// =========================================================================
function renderFeed(list) {
  const others = list.filter((p) => p.steamID !== session.steamID);
  const inGame = others.filter((p) => p.inSTS2).length;
  const looking = others.filter((p) => p.status === "looking").length;
  const activeNow = others.filter((p) => isActiveNow(p)).length;

  document.getElementById("online-count").textContent = String(others.length);
  document.getElementById("online-summary").textContent =
    others.length === 0
      ? "No one else has signed up yet. Be the first."
      : `${others.length} signed-up player${others.length === 1 ? "" : "s"} · ` +
        `${activeNow} active now · ${looking} looking · ${inGame} in Slay the Spire 2`;

  const $feed = document.getElementById("feed");
  if (others.length === 0) {
    $feed.innerHTML = `<div class="feed-empty"><p>You're on the feed. Be the first someone bumps into.</p></div>`;
    return;
  }

  // Sort with freshness as the dominant factor. Persistent presence means
  // the roster includes everyone who's ever signed in, so a 3-day-old
  // "looking" entry should not outrank someone who heartbeated 30 seconds
  // ago. The freshness bucket is worth far more than any status flag.
  others.sort((a, b) => rank(b) - rank(a));
  function rank(p) {
    let n = 0;
    const ageS = (Date.now() - Date.parse(p.updatedAt ?? "")) / 1000;
    if (Number.isFinite(ageS)) {
      if (ageS < 5 * 60)        n += 1000; // active now: anchor at the top
      else if (ageS < 30 * 60)  n += 500;  // active in last 30 min
      else if (ageS < 4 * 3600) n += 200;  // active in last few hours
      else if (ageS < 86_400)   n += 50;   // active today
      else                      n -= ageS / 86_400; // older = bigger penalty
    }
    if (p.inSTS2)               n += 80; // currently in the game itself
    if (p.status === "looking") n += 40;
    if (p.status === "inRun")   n += 10;
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

/**
 * "Last active 12 min ago" formatter for feed rows.
 *
 * The presence TTL is generous (4 hours) so the feed shows everyone who's
 * been around recently, not just people heartbeating in this exact second.
 * That means each row needs a freshness badge so the user can tell "this
 * person is online RIGHT NOW" from "this person was looking earlier today
 * and might or might not be reachable."
 *
 * Returns a short relative string. Anything within ~2 minutes is collapsed
 * to "just now" because the heartbeat cadence is 180s and we don't want
 * the badge to flicker between "just now" and "2 min ago."
 */
function formatRelativeActive(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const seconds = Math.max(0, (Date.now() - t) / 1000);
  if (seconds < 120) return "just now";
  if (seconds < 60 * 60) return `${Math.round(seconds / 60)} min ago`;
  const hours = seconds / 3600;
  if (hours < 24) {
    const h = hours < 1.5 ? 1 : Math.round(hours);
    return `${h}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Active-recently classifier. Decides whether the row's freshness badge
 * gets the green "live" treatment or the muted "stale" one. Uses the same
 * thresholds as `formatRelativeActive` so there's no daylight between
 * what the badge shows and what color it shows in.
 */
function activeFreshnessClass(iso) {
  if (!iso) return "stale";
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "stale";
  if (seconds < 5 * 60) return "fresh";
  if (seconds < 30 * 60) return "warm";
  return "stale";
}

/**
 * Is this entry "active right now" by the same threshold the freshness
 * badge uses for its green state? Used by the summary line to count
 * "X active now" out of the full signed-up roster.
 */
function isActiveNow(p) {
  return activeFreshnessClass(p?.updatedAt) === "fresh";
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
  const lastActive = formatRelativeActive(p.updatedAt);
  const freshness = activeFreshnessClass(p.updatedAt);

  return `
    <article class="row ${status}" data-sid="${esc(sid)}">
      <img class="avatar" alt="" src="${esc(safeAvatar)}" />
      <div class="meta">
        <div class="meta-line">
          <span class="name">${esc(persona)}</span>
          <span class="tag ${tagClass}">${tagLabel}</span>
          ${p.inSTS2 ? `<span class="tag live">In STS2</span>` : ""}
          ${lastActive ? `<span class="last-active is-${freshness}" title="Last heartbeat ${esc(p.updatedAt ?? "")}">${esc(lastActive)}</span>` : ""}
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

/**
 * Default locations of `history.json` per platform.
 *
 * macOS — written today by the Ascension Companion / Vault desktop app at:
 *   ~/Library/Application Support/AscensionCompanion/vault/history.json
 *
 * Windows — the Windows desktop app is on the roadmap (not yet shipped).
 * When it ships it will write to `%APPDATA%\AscensionCompanion\vault\
 * history.json`, which Windows expands to
 * `C:\Users\<You>\AppData\Roaming\AscensionCompanion\vault\history.json`.
 * We surface the path now so muscle memory is correct on day one and so
 * Windows users see we haven't ignored them, with copy explaining what
 * they can do today (import a friend's export).
 *
 * Linux — same story as Windows; the Vault desktop app is macOS-only
 * today. We surface the XDG path that the eventual Linux build will use.
 *
 * NOTE: the actual path constants (HISTORY_PATH_MAC / WIN / LINUX) live at
 * the very top of the file. They have to: boot code synchronously hits
 * renderEmptyState, and a `const` declared lower in the file would still
 * be in the Temporal Dead Zone at that moment.
 */

/**
 * "Find history.json" entry point.
 *
 * Browser security forbids true filesystem scanning, so the most this can
 * honestly do is:
 *
 *   1. SILENT RE-READ — if the user previously pointed at a file on this
 *      origin, the browser remembers the FileSystemFileHandle. Try to
 *      requestPermission; on Chromium this often returns "granted" with
 *      no UI at all. If it does, re-read silently and we're done.
 *
 *   2. CLIPBOARD HELPER — if we have to fall back to the picker, copy the
 *      exact macOS path to the clipboard first. The user hits Cmd+Shift+G
 *      inside the picker, pastes, hits Enter, and they're at the right
 *      file with no Finder navigation through hidden ~/Library.
 *
 *   3. SAFARI / FIREFOX — no File System Access API, so silent reload is
 *      impossible. Always falls through to a plain <input type="file">.
 */
async function scanForHistory() {
  if (!HistoryStore.supportsFSA()) {
    triggerFilePicker();
    return;
  }

  // STEP 1 — try the saved handle silently.
  let handle = null;
  try {
    handle = await HistoryStore.loadHandle();
  } catch (e) {
    console.warn("scanForHistory: loadHandle failed", e);
  }
  if (handle) {
    let perm = "prompt";
    try {
      perm = await handle.requestPermission({ mode: "read" });
    } catch (e) {
      console.warn("scanForHistory: requestPermission failed", e);
    }
    if (perm === "granted") {
      let file = null;
      try {
        file = await handle.getFile();
      } catch (e) {
        // File was renamed / deleted / moved since last visit.
        console.warn("saved handle no longer resolves", e);
        await HistoryStore.clearHandle().catch(() => {});
      }
      if (file) {
        const ok = await ingestHistoryFile(file);
        if (ok) toast("Auto-scanned history.json from disk.");
        return;
      }
    }
  }

  // STEP 2 — no usable saved handle. Open the picker exactly once. After
  // this succeeds, every subsequent visit is silent (step 1 covers it).
  //
  // First-time UX shortcut: copy the platform-appropriate default path
  // to the clipboard so the user can paste it inside the picker:
  //   - macOS:   Cmd+Shift+G inside the picker, paste, Enter
  //   - Windows: paste into the File Explorer address bar
  //   - Linux:   varies by file manager; the path itself is still useful
  // If the clipboard write fails (permission, non-secure context, older
  // browser) we just skip it silently — the picker still opens.
  const platform = detectPlatform();
  let copiedPath = null;
  try {
    if (navigator.clipboard?.writeText) {
      if (platform === "mac") copiedPath = HISTORY_PATH_MAC;
      else if (platform === "windows") copiedPath = HISTORY_PATH_WIN;
      else if (platform === "linux") copiedPath = HISTORY_PATH_LINUX;
      if (copiedPath) await navigator.clipboard.writeText(copiedPath);
    }
  } catch {
    copiedPath = null; // not worth blocking the picker
  }
  if (copiedPath) {
    if (platform === "mac") {
      toast("Path copied. In the picker, press Cmd+Shift+G and paste.");
    } else if (platform === "windows") {
      toast("Path copied. Paste it into the picker's address bar.");
    } else {
      toast("Path copied. Paste it into the picker.");
    }
  }

  let picked;
  try {
    [picked] = await window.showOpenFilePicker({
      types: [
        {
          description: "Vault history",
          accept: { "application/json": [".json"] },
        },
      ],
      multiple: false,
      excludeAcceptAllOption: false,
      startIn: "documents",
    });
  } catch (e) {
    if (e?.name !== "AbortError") {
      console.warn("file picker failed", e);
      toast("Couldn't open the file picker. Try Import as a fallback.");
    }
    return;
  }

  let file;
  try {
    file = await picked.getFile();
  } catch {
    toast("Picked the file but couldn't read it. Try again.");
    return;
  }
  const ok = await ingestHistoryFile(file);
  if (ok) {
    try {
      await HistoryStore.saveHandle(picked);
    } catch (e) {
      console.warn("could not persist file handle", e);
    }
  }
}

/**
 * Boot-time auto-reload. Runs immediately after sign-in if a saved handle
 * exists AND the browser already considers read permission granted for
 * this origin/handle. Silent: no toast, no permission prompt, no gesture.
 *
 * If permission is "prompt" (the default for new tabs in Chrome), this is
 * a no-op and the user will need to click the visible "Reload from saved
 * file" toolbar button once to grant — that grant typically lasts the rest
 * of the tab's session.
 *
 * Designed to never throw to the boot path. Any failure is logged and
 * swallowed so a flaky filesystem can't break the rest of the app.
 */
async function autoReloadHistoryIfPermitted() {
  if (!HistoryStore.supportsFSA()) return;
  let handle;
  try {
    handle = await HistoryStore.loadHandle();
  } catch (e) {
    console.warn("autoReloadHistoryIfPermitted: loadHandle failed", e);
    return;
  }
  if (!handle) return;

  // queryPermission is the silent variant; requestPermission would prompt.
  // We want truly invisible auto-reload, so we only proceed on "granted".
  let perm = "prompt";
  try {
    perm = await handle.queryPermission({ mode: "read" });
  } catch (e) {
    console.warn("autoReloadHistoryIfPermitted: queryPermission failed", e);
    return;
  }
  if (perm !== "granted") return;

  let file;
  try {
    file = await handle.getFile();
  } catch (e) {
    // File was renamed, deleted, or moved since last visit.
    console.warn("autoReloadHistoryIfPermitted: getFile failed", e);
    return;
  }
  await ingestHistoryFile(file);
}

async function ingestHistoryFile(file) {
  // Always announce that we got the file. The previous flow relied on a
  // single end-of-pipeline toast, which meant any silent failure (or any
  // sub-3-second fail-too-fast toast) made the picker look totally dead.
  // Now the user sees feedback the moment we begin and the moment we end.
  console.info("[Vault] ingest start", { name: file?.name, size: file?.size, type: file?.type });
  toast(`Reading ${file?.name ?? "history.json"}...`);

  if (!file || typeof file.size !== "number") {
    console.error("[Vault] ingest aborted: invalid file object", file);
    toast("Couldn't read that file. The browser handed us nothing.");
    return false;
  }
  if (file.size === 0) {
    console.error("[Vault] ingest aborted: file is 0 bytes");
    toast("That file is empty (0 bytes). Pick a real history.json.");
    return false;
  }
  if (file.size > 50 * 1024 * 1024) {
    console.error("[Vault] ingest aborted: file too large", file.size);
    toast("That file is huge (>50 MB). Are you sure it's history.json?");
    return false;
  }

  let text;
  try {
    text = await file.text();
  } catch (e) {
    console.error("[Vault] ingest aborted: file.text() failed", e);
    toast("Couldn't read that file. " + (e?.message ?? ""));
    return false;
  }
  if (!text || !text.trim()) {
    console.error("[Vault] ingest aborted: file body is empty/whitespace");
    toast("That file is empty. Pick a real history.json.");
    return false;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error("[Vault] ingest aborted: JSON.parse failed", e, "first 200 chars:", text.slice(0, 200));
    toast("That file isn't valid JSON. " + (e?.message ?? ""));
    return false;
  }

  const result = Stats.extractRuns(parsed);
  if (!result.ok) {
    // Surface what we DID see, so the user (or a tester) can tell whether
    // they accidentally picked a .run file, the wrong export, etc.
    const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 6).join(", ")
      : Array.isArray(parsed) ? "array" : typeof parsed;
    console.error("[Vault] extractRuns rejected file. Top-level keys:", keys, "result:", result);
    toast(`${result.error} Top-level keys: ${keys || "(none)"}.`);
    return false;
  }
  if (result.runs.length === 0) {
    console.error("[Vault] extractRuns returned zero runs.", parsed);
    toast("File parsed, but it had zero runs in it. Wrong file?");
    return false;
  }

  parsedRuns = result.runs;
  console.info(`[Vault] loaded ${result.runs.length} runs`);

  // Persist. We swallow IDB errors so a flaky storage layer never blocks
  // the in-memory render — the user still sees their stats this session.
  try {
    await HistoryStore.saveHistory({
      savedAt: new Date().toISOString(),
      sourceFilename: file.name,
      runs: result.runs.map(serializeRun),
    });
  } catch (e) {
    console.error("[Vault] saveHistory to IndexedDB failed (continuing in-memory)", e);
    toast("Loaded runs but couldn't cache them locally. Stats will work this visit.");
  }

  toast(`Loaded ${result.runs.length} run${result.runs.length === 1 ? "" : "s"}.`);

  // Force-render so the empty state vanishes and stats appear, no matter
  // which stat tab is active. If the user was on a non-stat tab (co-op),
  // hop them to Overview so they actually see the result of their click.
  if (TABS_WITH_DATA.includes(activeTab)) {
    renderStatsTab(activeTab);
  } else {
    switchTab("overview");
  }
  return true;
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
    $body.querySelectorAll("[data-action='scan']").forEach((btn) => {
      btn.addEventListener("click", () => void scanForHistory());
    });
    $body.querySelectorAll("[data-action='upload']").forEach((btn) => {
      btn.addEventListener("click", () => triggerFilePicker());
    });
    $body.querySelectorAll("[data-action='copy-path']").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.pathKey || "mac";
        const path =
          key === "win" ? HISTORY_PATH_WIN
          : key === "linux" ? HISTORY_PATH_LINUX
          : HISTORY_PATH_MAC;
        try {
          await navigator.clipboard.writeText(path);
          const original = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = original), 1500);
        } catch {
          toast("Couldn't copy. Select the path and copy manually.");
        }
      });
    });
    return;
  }
  const report = Stats.summarize(parsedRuns);
  switch (tab) {
    case "overview":   $body.innerHTML = renderOverview(report);     break;
    case "characters": $body.innerHTML = renderCharactersTab(report); break;
    case "ascensions": $body.innerHTML = renderAscensionsTab(report); break;
    case "relics":     $body.innerHTML = renderRelicsTab(report);     break;
    case "cards":      $body.innerHTML = renderCards(report);         break;
    case "runs":       $body.innerHTML = renderRecentRuns(parsedRuns); break;
  }
  // Update Overview sub-text
  if (tab === "overview") {
    document.getElementById("overview-sub").textContent =
      `${report.totalRuns} run${report.totalRuns === 1 ? "" : "s"} · ${(report.overallWinrate * 100).toFixed(0)}% win rate`;
  }
}

function renderEmptyState() {
  const platform = detectPlatform();

  // Platform-specific path callout. Mac users get a clipboard-paste
  // shortcut into the picker; Windows users see where the future Windows
  // desktop app will write the file (and why Import is the path today);
  // Linux users see the XDG path. Unknown platforms get no callout — the
  // hints details still cover them.
  let pathBlock = "";
  if (platform === "mac") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Default macOS location</span>
        <code class="path-value">${esc(HISTORY_PATH_MAC)}</code>
        <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="mac" title="Copy path. Then paste with Cmd+Shift+G inside the picker.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        Tip: clicking <strong>Find history.json</strong> copies the path automatically. In the picker, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> and paste.
      </p>`;
  } else if (platform === "windows") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Windows location</span>
        <code class="path-value">${esc(HISTORY_PATH_WIN)}</code>
        <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="win" title="Copy path. Paste it into File Explorer's address bar.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        <strong>Windows desktop app coming soon.</strong> For now, ask a macOS user to share their <code>history.json</code> and use <strong>Import</strong> below. When the Windows app ships, it'll write to the path above automatically.
      </p>`;
  } else if (platform === "linux") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Linux location</span>
        <code class="path-value">${esc(HISTORY_PATH_LINUX)}</code>
        <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="linux" title="Copy path. Paste it into your file manager.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        <strong>Linux desktop app coming soon.</strong> For now, import a <code>history.json</code> shared from a macOS user.
      </p>`;
  }

  // Windows + Linux users won't have a file to find yet, so the primary
  // CTA changes to Import to match the realistic flow. Mac stays Find.
  const primaryCTA =
    platform === "mac"
      ? `<button class="btn-primary" data-action="scan">Find history.json</button>`
      : `<button class="btn-primary" data-action="upload">Import history.json</button>
         <button class="btn-ghost" data-action="scan">Or browse</button>`;

  return `
    <div class="empty-state">
      <div class="empty-state-icon">📂</div>
      <h2>Connect your <code>history.json</code></h2>
      <p>Browsers can't read your disk without permission, so this is a one-time pick. After that, every visit auto-loads silently — no picker, no clicks.</p>
      <div class="empty-state-actions">
        ${primaryCTA}
      </div>
      <p class="empty-state-tip">
        Or drag <code>history.json</code> anywhere on this page to load it now.
      </p>
      ${pathBlock}
      <details class="empty-state-hints">
        <summary>Where is <code>history.json</code> on each OS?</summary>
        <ul>
          <li><strong>macOS:</strong> <code>${esc(HISTORY_PATH_MAC)}</code> (Cmd+Shift+G in the picker pastes the path).</li>
          <li><strong>Windows:</strong> <code>${esc(HISTORY_PATH_WIN)}</code> (paste into File Explorer's address bar). Windows desktop app on the roadmap.</li>
          <li><strong>Linux:</strong> <code>${esc(HISTORY_PATH_LINUX)}</code>. Linux desktop app on the roadmap.</li>
          <li>Browsers physically forbid filesystem scanning. After one pick, the browser remembers and we silently re-read on every future visit.</li>
          <li><strong>Want true zero-click auto-detect today?</strong> The <a href="https://github.com/c3rooks/SpireVault/releases">macOS desktop app</a> finds the file on launch with no setup.</li>
          <li>Your file stays on your device. Persisted locally; never uploaded.</li>
        </ul>
      </details>
    </div>`;
}

/**
 * Character → theme color. Mirrors the macOS app's per-character accents
 * so the web Overview reads as the same product, not a stripped-down twin.
 * Keys are normalized to lowercase before lookup.
 */
const CHAR_THEME = {
  ironclad:    { color: "#ff5f6d", icon: "shield" },
  silent:      { color: "#6dd97c", icon: "leaf"   },
  defect:      { color: "#5dc1ff", icon: "bolt"   },
  watcher:     { color: "#9b83ff", icon: "eye"    },
  regent:      { color: "#d4af37", icon: "crown"  },
  necrobinder: { color: "#b27dff", icon: "skull"  },
};

function charTheme(name) {
  return CHAR_THEME[String(name || "").toLowerCase()] || { color: "#8a7cb8", icon: "shield" };
}

/** Tiny inline SVG icons keyed off CHAR_THEME.icon. Stroke-based so they
 *  pick up the character color via `currentColor`. */
function charIcon(key) {
  const map = {
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z"/>',
    leaf:   '<path d="M5 19c4-9 9-13 16-14-1 8-5 13-13 16-1 0-2 0-3-2zM5 19l4-4"/>',
    bolt:   '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="currentColor" stroke="none"/>',
    eye:    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    crown:  '<path d="M3 8l4 4 5-7 5 7 4-4-1 11H4L3 8z"/>',
    skull:  '<path d="M12 3a8 8 0 0 0-8 8v3l2 2v4h12v-4l2-2v-3a8 8 0 0 0-8-8z"/><circle cx="9" cy="12" r="1.5" fill="currentColor"/><circle cx="15" cy="12" r="1.5" fill="currentColor"/>',
  };
  return `<svg class="char-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${map[key] || map.shield}</svg>`;
}

/** SVG icons used for section headers. Match the desktop app's SF Symbols. */
const SEC_ICONS = {
  people:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 11a3 3 0 100-6 3 3 0 000 6zm6 0a3 3 0 100-6 3 3 0 000 6zm-9 8a5 5 0 0110 0zm9-1a5 5 0 015-5v6h-5z"/></svg>',
  bars:      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 20h4V10H4zm6 0h4V4h-4zm6 0h4v-7h-4z"/></svg>',
  list:      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z"/></svg>',
  sparkles:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.5 5L18.5 8 14 11l1.5 5L12 13l-3.5 3L10 11 5.5 8l5-1.5zM5 16l.7 2.3L8 19l-2.3.7L5 22l-.7-2.3L2 19l2.3-.7zm14-2l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/></svg>',
  bolt:      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
  cards:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h10a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zm12 4h2a2 2 0 012 2v10a2 2 0 01-2 2h-2z"/></svg>',
  clock:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm.5 5h-1.5v6.4l5.4 3.2.8-1.3-4.7-2.8z"/></svg>',
};

/** Renders a desktop-app-style section header: small accent icon, tracked
 *  uppercase label, and a fading horizontal underline. */
function secTitle(text, icon = "list", tone = "") {
  const cls = tone ? `sec-title ${tone}` : "sec-title";
  return `
    <div class="${cls}">
      <div class="sec-title-row">
        <span class="sec-title-icon">${SEC_ICONS[icon] || SEC_ICONS.list}</span>
        <span class="sec-title-text">${esc(text)}</span>
      </div>
      <div class="sec-title-rule"></div>
    </div>`;
}

function renderOverview(report) {
  const total = report.totalRuns;
  const wins  = report.totalWins;
  const losses = total - wins;
  const wrPct = report.overallWinrate * 100;
  const wrLabel = `${wrPct.toFixed(1)}%`;

  // Best-character callout: highest win rate among characters with at least
  // a few runs (otherwise a 1-run 100% winrate steals the spot).
  const bestChar = report.byCharacter
    .filter((b) => b.runs >= 3)
    .slice()
    .sort((a, b) => b.winrate - a.winrate)[0] || report.byCharacter[0];

  // Donut ring: stroke-based progress on a 60-radius circle.
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, wrPct)) / 100) * circumference;
  const ring = `
    <svg class="hero-ring" viewBox="0 0 160 160" aria-hidden="true">
      <circle cx="80" cy="80" r="${radius}" class="ring-track"/>
      <circle cx="80" cy="80" r="${radius}" class="ring-fill"
              stroke-dasharray="${dash} ${circumference}"
              stroke-linecap="round"
              transform="rotate(-90 80 80)"/>
    </svg>`;

  const heroPanel = `
    <div class="hero-overview">
      <div class="hero-ring-wrap">
        ${ring}
        <div class="hero-ring-text">
          <strong class="ring-pct">${wrLabel}</strong>
          <span class="ring-label">Winrate</span>
        </div>
      </div>
      <div class="hero-numbers">
        <div class="hero-numbers-head">Run history</div>
        <div class="hero-numbers-row">
          <div class="hero-num">
            <strong class="num num-neutral">${total}</strong>
            <span class="num-label">Runs</span>
          </div>
          <div class="hero-num">
            <strong class="num num-win">${wins}</strong>
            <span class="num-label">Wins</span>
          </div>
          <div class="hero-num">
            <strong class="num num-loss">${losses}</strong>
            <span class="num-label">Losses</span>
          </div>
        </div>
        ${bestChar ? `
          <div class="hero-best">
            <span class="hero-best-icon"><svg viewBox="0 0 24 24" fill="#5dc1ff"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg></span>
            <span class="hero-best-text">
              Best: <strong style="color:${charTheme(bestChar.key).color}">${esc(capitalize(bestChar.key))}</strong>
              <span class="muted"> · ${(bestChar.winrate * 100).toFixed(1)}% over ${bestChar.runs} run${bestChar.runs === 1 ? "" : "s"}</span>
            </span>
          </div>
        ` : ""}
      </div>
    </div>`;

  // Per-character cards. The desktop app shows these as colored tiles with
  // an icon, run count badge, big winrate %, and a thin progress bar. We
  // mirror that layout exactly so the web reads as the same product.
  const charCards = report.byCharacter.length === 0
    ? `<p class="muted">No character data yet.</p>`
    : `
    <div class="char-grid">
      ${report.byCharacter.map((c) => {
        const theme = charTheme(c.key);
        const wr = (c.winrate * 100).toFixed(1);
        const lossCount = c.runs - c.wins;
        return `
          <div class="char-card" style="--char-color:${theme.color}">
            <div class="char-card-head">
              <div class="char-card-icon">${charIcon(theme.icon)}</div>
              <span class="char-card-runs">${c.runs} runs</span>
            </div>
            <div class="char-card-name">${esc(capitalize(c.key))}</div>
            <div class="char-card-record">${c.wins} win${c.wins === 1 ? "" : "s"} · ${lossCount} loss${lossCount === 1 ? "" : "es"}</div>
            <div class="char-card-wr">
              <strong class="char-card-pct">${wr}%</strong>
              <span class="char-card-pct-label">Winrate</span>
            </div>
            <div class="char-card-bar"><span style="width:${Math.min(100, c.winrate * 100)}%"></span></div>
          </div>`;
      }).join("")}
    </div>`;

  return `
    ${heroPanel}
    ${secTitle("Per character", "people")}
    ${charCards}
    ${secTitle("Top relics", "sparkles", "gold")}
    ${renderRelicCards(report.byRelic.slice(0, 6))}`;
}

/** Render the per-character grid card. Shared between Overview and the
 *  dedicated Characters tab so both surfaces feel like one product. */
function renderCharCards(buckets) {
  if (!buckets || !buckets.length) {
    return `<p class="muted">No character data yet.</p>`;
  }
  return `
    <div class="char-grid">
      ${buckets.map((c) => {
        const theme = charTheme(c.key);
        const wr = (c.winrate * 100).toFixed(1);
        const lossCount = c.runs - c.wins;
        return `
          <div class="char-card" style="--char-color:${theme.color}">
            <div class="char-card-head">
              <div class="char-card-icon">${charIcon(theme.icon)}</div>
              <span class="char-card-runs">${c.runs} runs</span>
            </div>
            <div class="char-card-name">${esc(capitalize(c.key))}</div>
            <div class="char-card-record">${c.wins} win${c.wins === 1 ? "" : "s"} · ${lossCount} loss${lossCount === 1 ? "" : "es"}</div>
            <div class="char-card-wr">
              <strong class="char-card-pct">${wr}%</strong>
              <span class="char-card-pct-label">Winrate</span>
            </div>
            <div class="char-card-bar"><span style="width:${Math.min(100, c.winrate * 100)}%"></span></div>
          </div>`;
      }).join("")}
    </div>`;
}

function renderCharactersTab(report) {
  return `
    ${secTitle("Winrate by character", "people")}
    ${renderCharCards(report.byCharacter)}`;
}

/** Bar chart matching the desktop app's "Per ascension" panel.
 *  Each bar shows total runs (height proportional to max) with the wins
 *  portion painted in green from the bottom up. */
function renderAscensionsTab(report) {
  const buckets = report.byAscension
    .slice()
    .sort((a, b) => parseAsc(a.key) - parseAsc(b.key));
  if (!buckets.length) {
    return `<p class="muted">No ascension data yet.</p>`;
  }
  const maxRuns = Math.max(...buckets.map((b) => b.runs), 1);
  const barChart = `
    <div class="asc-chart-panel">
      <div class="asc-chart">
        ${buckets.map((b) => {
          const totalH = Math.max(8, (b.runs / maxRuns) * 130);
          const winsH = b.runs > 0 ? totalH * (b.wins / b.runs) : 0;
          return `
            <div class="asc-bar-col" title="${esc(b.key)}: ${b.wins}/${b.runs} (${(b.winrate*100).toFixed(0)}%)">
              <div class="asc-bar-stack">
                <div class="asc-bar-bg"></div>
                <div class="asc-bar-total" style="height:${totalH}px"></div>
                <div class="asc-bar-wins" style="height:${winsH}px"></div>
              </div>
              <span class="asc-bar-label">${esc(b.key)}</span>
            </div>`;
        }).join("")}
      </div>
    </div>`;

  const detailRows = `
    <div class="asc-detail-panel">
      ${buckets.map((b, i) => {
        const wr = (b.winrate * 100).toFixed(1);
        const tint = b.winrate >= 0.10 ? "var(--win)" : "var(--accent)";
        return `
          <div class="asc-detail-row${i === buckets.length - 1 ? "" : " has-divider"}">
            <span class="asc-detail-key">${esc(b.key)}</span>
            <div class="asc-detail-bar"><span style="width:${Math.min(100, b.winrate*100)}%; background:${tint}"></span></div>
            <span class="asc-detail-pct">${wr}%</span>
            <span class="asc-detail-record">${b.wins}w / ${b.runs}r</span>
          </div>`;
      }).join("")}
    </div>`;

  return `
    ${secTitle("Per ascension", "bars")}
    ${barChart}
    ${secTitle("Detailed breakdown", "list")}
    ${detailRows}`;
}

/** Top Relics — 2-column card grid matching the desktop app's RelicCard.
 *  Gold sparkle in a circle, name, "X seen" + "Yw" pills, big colored % on
 *  the right. Suppresses one-run flukes by filtering to runs >= 3. */
function renderRelicsTab(report) {
  const buckets = report.byRelic.filter((b) => b.runs >= 3);
  if (!buckets.length) {
    return `
      ${secTitle("Top relics by winrate", "sparkles", "gold")}
      <p class="muted">Not enough data yet — pick a relic at least 3 times to see a winrate here.</p>`;
  }
  return `
    ${secTitle("Top relics by winrate", "sparkles", "gold")}
    <p class="muted small" style="margin: -6px 0 14px;">
      Sorted by winrate, with a minimum-sample filter applied to suppress one-run flukes.
    </p>
    ${renderRelicCards(buckets)}`;
}

function renderRelicCards(buckets) {
  if (!buckets || !buckets.length) return `<p class="muted">No relic data yet.</p>`;
  return `
    <div class="relic-grid">
      ${buckets.map((b) => {
        const wr = (b.winrate * 100).toFixed(1);
        const tone = b.winrate >= 0.5 ? "win" : "gold";
        return `
          <div class="relic-card">
            <div class="relic-card-icon">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 1.5l1.5 5L18.5 8 14 11l1.5 5L12 13l-3.5 3L10 11 5.5 8l5-1.5z"/>
              </svg>
            </div>
            <div class="relic-card-meta">
              <div class="relic-card-name">${esc(prettifyId(b.key))}</div>
              <div class="relic-card-pills">
                <span class="pill pill-muted">${b.runs} seen</span>
                <span class="pill pill-win">${b.wins}w</span>
              </div>
            </div>
            <div class="relic-card-pct relic-card-pct-${tone}">
              <strong>${wr}%</strong>
              <span>WINRATE</span>
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

/** Title-case-ish prettifier for ids like "sword_of_jade" -> "Sword Of Jade". */
function prettifyId(id) {
  return String(id || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
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

/**
 * Best-effort platform detection. Used only to pick the right path hint
 * in the file picker UX. Wrong answers are harmless — the worst case is
 * a user sees a path they can ignore.
 */
function detectPlatform() {
  const ua = (navigator.userAgent || "").toLowerCase();
  const plat = (navigator.platform || "").toLowerCase();
  if (ua.includes("mac os x") || ua.includes("macintosh") || plat.includes("mac")) {
    return "mac";
  }
  if (ua.includes("windows") || plat.includes("win")) return "windows";
  if (ua.includes("linux") || plat.includes("linux")) return "linux";
  return "other";
}

function isMacUserAgent() {
  return detectPlatform() === "mac";
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
