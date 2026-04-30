// The Vault — Web companion
// =========================================================================
// Pure ES module, no build step. Talks to the same Worker the macOS app does.
// Lives at https://app.spirevault.app/.
//
// State machine:
//   - localStorage `vault.web.session` not set → show signed-out hero, "Sign
//     in with Steam" kicks off /auth/steam/start with a generated nonce.
//   - localStorage set → show feed + your-status card. Polls every 12s.
//
// Heartbeat: we POST /presence ~every 90s while the tab is open, plus on
// every status/note/discord change (debounced 600ms). Sign-out fires
// DELETE /presence so you disappear from other people's feeds immediately.
// =========================================================================

const SERVER_URL = "https://vault-coop.coreycrooks.workers.dev";
const RETURN_URL = `${window.location.origin}/auth.html`;

const STORAGE_SESSION = "vault.web.session";
const STORAGE_LAST_PRESENCE = "vault.web.presence.draft";

// ─── State ──────────────────────────────────────────────────────────────
const session = readSession();
let pollTimer = null;
let heartbeatTimer = null;
let pushTimer = null;
let lastFetchedFeed = [];

// ─── Routing: choose which view to show ────────────────────────────────
const $signedOut = document.getElementById("signed-out-view");
const $signedIn  = document.getElementById("signed-in-view");
const $authPill  = document.getElementById("auth-state-pill");

if (session) {
  $signedOut.hidden = true;
  $signedIn.hidden  = false;
  $authPill.hidden  = false;
  $authPill.textContent = "Signed in";
  enterSignedInMode();
} else {
  $signedOut.hidden = false;
  $signedIn.hidden  = true;
  enterSignedOutMode();
}

// ─── Signed-out mode ───────────────────────────────────────────────────
function enterSignedOutMode() {
  document.getElementById("signin-btn").addEventListener("click", () => {
    const nonce = randomNonce();
    sessionStorage.setItem("vault.auth.nonce", nonce);
    const u = new URL(`${SERVER_URL}/auth/steam/start`);
    u.searchParams.set("return", RETURN_URL);
    u.searchParams.set("nonce", nonce);
    window.location.assign(u.toString());
  });

  void refreshPublicCount();
  setInterval(refreshPublicCount, 12_000);
}

async function refreshPublicCount() {
  const $text = document.getElementById("presence-text");
  if (!$text) return;
  try {
    const list = await fetchFeed();
    if (list.length === 0) {
      $text.textContent = "No one online right now — be the first.";
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

// ─── Signed-in mode ────────────────────────────────────────────────────
function enterSignedInMode() {
  // Render local user
  document.getElementById("me-persona").textContent = session.personaName;
  if (session.avatarURL) {
    document.getElementById("me-avatar").src = session.avatarURL;
  }
  document.getElementById("me-tier").textContent =
    "Signed in with Steam · " + truncate(session.steamID, 4) + "…" +
    truncate(session.steamID.slice(-4), 4);

  // Restore the user's last draft so a refresh doesn't blank their note.
  const draft = readDraft();
  setRadio("status", draft.status ?? "looking");
  document.getElementById("me-note").value = draft.note ?? "";
  document.getElementById("me-discord").value = draft.discordHandle ?? "";

  // Wire change handlers
  document.querySelectorAll('input[name="status"]').forEach((el) =>
    el.addEventListener("change", schedulePush)
  );
  document.getElementById("me-note").addEventListener("input", schedulePush);
  document.getElementById("me-discord").addEventListener("input", schedulePush);

  document.getElementById("refresh-btn").addEventListener("click", () => {
    void pullFeed();
  });
  document.getElementById("signout-btn").addEventListener("click", () => {
    void signOut();
  });

  // Sign me in to the feed straight away.
  schedulePush(0);
  pullFeed();

  pollTimer      = setInterval(pullFeed,        12_000);
  heartbeatTimer = setInterval(() => pushNow(true), 90_000);

  window.addEventListener("beforeunload", () => {
    // Best-effort. sendBeacon is fire-and-forget; handles tab-close.
    try {
      const blob = new Blob([], { type: "text/plain" });
      navigator.sendBeacon &&
        navigator.sendBeacon(`${SERVER_URL}/presence`, blob);
    } catch {}
  });
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
      body: JSON.stringify(body),
    });
    if (resp.status === 401) {
      // Session expired or revoked — drop the local copy and show signed-out.
      localStorage.removeItem(STORAGE_SESSION);
      window.location.reload();
      return;
    }
    if (!resp.ok) console.warn("presence push failed", resp.status);
  } catch (e) {
    console.warn("presence push error", e);
  } finally {
    if (!silent) setTimeout(() => showPushingPill(false), 400);
  }
}

async function pullFeed() {
  try {
    const list = await fetchFeed();
    lastFetchedFeed = list;
    renderFeed(list);
    document.getElementById("last-updated").textContent =
      "Last updated " + new Date().toLocaleTimeString();
  } catch (e) {
    console.warn("feed fetch failed", e);
  }
}

async function fetchFeed() {
  const r = await fetch(`${SERVER_URL}/presence`, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

async function signOut() {
  // Best-effort delete on the server first so the row disappears for others
  // before we drop our local session.
  try {
    await fetch(`${SERVER_URL}/presence`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
  } catch {}
  localStorage.removeItem(STORAGE_SESSION);
  localStorage.removeItem(STORAGE_LAST_PRESENCE);
  window.location.replace("/");
}

// ─── Render: feed ──────────────────────────────────────────────────────
function renderFeed(list) {
  const others = list.filter((p) => p.steamID !== session.steamID);
  const inGame = others.filter((p) => p.inSTS2).length;
  const looking = others.filter((p) => p.status === "looking").length;

  document.getElementById("online-count").textContent = String(others.length);
  document.getElementById("online-summary").textContent =
    others.length === 0
      ? "No one else online right now. Hang around — heartbeats land every 12 seconds."
      : `${others.length} other player${others.length === 1 ? "" : "s"} online · ` +
        `${looking} looking · ${inGame} in Slay the Spire 2`;

  const $feed = document.getElementById("feed");
  if (others.length === 0) {
    $feed.innerHTML = `
      <div class="feed-empty">
        <p>You're online — be the first someone bumps into.</p>
      </div>`;
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
  $feed.querySelectorAll("button.discord").forEach((btn) => {
    btn.addEventListener("click", () => {
      const handle = btn.dataset.handle ?? "";
      navigator.clipboard?.writeText(handle).catch(() => {});
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Discord"), 1500);
    });
  });
}

function renderRow(p) {
  const status = p.status ?? "looking";
  const stats = p.stats || {};
  const wr =
    stats.totalRuns && stats.wins != null
      ? Math.round((stats.wins / Math.max(1, stats.totalRuns)) * 100) + "% wr"
      : null;
  const statBits = [
    stats.maxAscension != null ? `A${stats.maxAscension} max` : null,
    wr,
    stats.totalRuns != null ? `${stats.totalRuns} runs` : null,
    stats.preferredCharacter ? prettyChar(stats.preferredCharacter) : null,
  ].filter(Boolean);

  const tagClass = {
    looking: "ok",
    inRun: "gold",
    inCoop: "ember",
    afk: "mute",
  }[status];
  const tagLabel = {
    looking: "Looking",
    inRun: "Solo run",
    inCoop: "In co-op",
    afk: "AFK",
  }[status];

  const safe = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // Avatar URL comes from the server's session-profile (which Steam Web API
  // populated) — so this should always be a https://*.steamstatic.com URL.
  // Defense-in-depth: only render if the URL parses and is http(s). A
  // malicious or buggy fork of the Worker can't smuggle a `javascript:` src.
  const safeAvatar = (() => {
    try {
      const u = new URL(p.avatarURL ?? "");
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {}
    return "/assets/vault-mark.svg";
  })();

  // Ensure SteamID is exactly 17 digits before composing URLs against it.
  const sid = /^\d{17}$/.test(p.steamID) ? p.steamID : "";
  const steamProfile = sid ? `https://steamcommunity.com/profiles/${sid}` : "#";
  const friendInvite = sid ? `steam://friends/add/${sid}` : "#";

  return `
    <article class="row ${status}">
      <img class="avatar" alt="" src="${safe(safeAvatar)}" />
      <div class="meta">
        <div class="meta-line">
          <span class="name">${safe(p.personaName || "Steam User")}</span>
          <span class="tag ${tagClass}">${tagLabel}</span>
          ${p.inSTS2 ? `<span class="tag live">In STS2</span>` : ""}
        </div>
        <div class="stats">${statBits.map(safe).join(" · ") || "—"}</div>
        ${p.note ? `<p class="note">${safe(p.note)}</p>` : ""}
      </div>
      <div class="actions">
        <a class="steam" target="_blank" rel="noopener" href="${safe(steamProfile)}">Steam</a>
        ${p.discordHandle
          ? `<button class="discord" data-handle="${safe(p.discordHandle)}">Discord</button>`
          : ""}
        <a class="friend" href="${safe(friendInvite)}">Add friend</a>
      </div>
    </article>`;
}

function prettyChar(c) {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// ─── Form helpers ──────────────────────────────────────────────────────
function readMyForm() {
  const status = (document.querySelector('input[name="status"]:checked') ?? {}).value || "looking";
  const note = (document.getElementById("me-note").value || "").trim();
  const discordHandle = (document.getElementById("me-discord").value || "").trim();

  return {
    status,
    note,
    discordHandle: discordHandle || undefined,
    // Web doesn't have access to local STS2 saves, so no real stats. We
    // intentionally leave `stats` off so we never inflate fake numbers
    // — the server will display nothing in the stats column.
    stats: undefined,
  };
}

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function showPushingPill(visible) {
  const pill = document.getElementById("me-pushing-pill");
  if (visible) { pill.hidden = false; pill.textContent = "Sending…"; }
  else { pill.hidden = false; pill.textContent = "Saved"; }
  if (!visible) setTimeout(() => (pill.hidden = true), 800);
}

// ─── Storage helpers ──────────────────────────────────────────────────
function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_SESSION);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j && /^\d{17}$/.test(j.steamID || "") && j.sessionToken) return j;
    return null;
  } catch {
    return null;
  }
}
function readDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_LAST_PRESENCE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveDraft(body) {
  try {
    localStorage.setItem(STORAGE_LAST_PRESENCE, JSON.stringify(body));
  } catch {}
}

// ─── Misc ──────────────────────────────────────────────────────────────
function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function truncate(s, n) {
  return (s || "").slice(0, n);
}
