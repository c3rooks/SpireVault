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

import * as Stats from "/lib/stats-engine.js?v=8";
import * as Filters from "/lib/stat-filters.js?v=2";
import * as HistoryStore from "/lib/history-store.js?v=9";
import * as InviteAPI from "/lib/invites.js?v=4";
import * as HighlightsAPI from "/lib/highlights.js?v=1";
import * as AscInfo from "/lib/ascension-info.js?v=3";
import * as RunDates from "/lib/run-dates.js?v=1";
import * as CharInfo from "/lib/character-info.js?v=3";
import * as RelicInfo from "/lib/relic-info.js?v=4";
import * as OverlayEngine from "/lib/overlay-engine.js?v=1";
import * as SyncBridge from "/lib/sync-bridge.js?v=1";
import * as CloudWire from "/lib/cloud-run-wire.js?v=2";
// Co-op is one-tap Play (lib/coop-play.js). The Play module is loaded on demand, for signed-in players only: it draws
// the inked climbers from /lib/ui/, and signed-out visitors (classic look by
// default) must not download any of the new UI.
/** @type {typeof import("/lib/coop-play.js") | null} */
let CoopPlay = null;
/** @type {Promise<unknown> | null} */
let coopPlayLoading = null;
function loadCoopPlay() {
  if (!coopPlayLoading) {
    coopPlayLoading = import("/lib/coop-play.js?v=11").then((mod) => { CoopPlay = mod; return mod; });
  }
  return coopPlayLoading;
}

// ─── Constants ─────────────────────────────────────────────────────────
//
// Two backend surfaces, and we use them deliberately:
//
//   SERVER_URL  → direct hit on the worker. Used for things that don't
//                 need a session cookie or where same-origin doesn't
//                 matter: the OpenID redirect URL (which has to be the
//                 worker's own origin so it owns its callback), the
//                 anonymous /auth/diag funnel beacon, and public GET
//                 reads of /presence.
//
//   API_BASE    → same-origin proxy at app.spirevault.app/api/*.
//                 Pages Functions in `Web/functions/api/` forward these
//                 requests into the worker, translating the
//                 first-party `vault_session` cookie into the worker's
//                 `Authorization: Bearer ...` header on the way through.
//                 Use this for ALL authenticated calls, so:
//                   - Cookie-only sessions (rehydrated on iOS Safari
//                     after ITP wiped localStorage) actually carry their
//                     credential.
//                   - Bearer-only sessions (legacy desktop, native app)
//                     keep working because the proxy passes through any
//                     Authorization header verbatim.
//                 The proxy treats `Bearer __cookie__` as "use the
//                 cookie instead", which is what cookie-rehydrated
//                 frontend code stamps when it doesn't know the real
//                 token (HttpOnly).
const SERVER_URL  = "https://vault-coop.coreycrooks.workers.dev";
const API_BASE    = "/api";
/** Connection line under the account card when the server cannot be reached.
 *  The rail is short, so the "it keeps retrying" detail lives in the tooltip. */
const STATUS_TROUBLE_REACHING = Object.freeze([
  "Trouble reaching server",
  "Retrying on its own. Stats from your saves keep working; co-op needs the server.",
]);
const RETURN_URL  = `${window.location.origin}/auth.html`;
const STS2_APP_ID = "2868840";

/**
 * Build stamp — incremented on each deploy that needs a verifiable
 * cache-bust. Surfaces in three places so we can answer "is the user
 * on the new build?" without DevTools:
 *
 *   1. console.info on boot ("[Vault] build vXX")
 *   2. <meta name="vault-build" content="vXX"> appended at boot
 *   3. window.__VAULT_BUILD__ for quick console-paste verification
 *
 * If a user reports stale UI, ask them to paste `window.__VAULT_BUILD__`
 * in the console. If it doesn't match the latest deploy, they're
 * on an old client — instruct hard refresh. If it DOES match, the
 * bug is real and we can stop chasing cache ghosts.
 */
const VAULT_BUILD = "v263-2026-11-19-arrange-your-overview";

/** True on wrangler pages dev / local loopback — not production hostnames. */
function isLocalDevHost() {
  try {
    const h = window.location.hostname;
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h.endsWith(".localhost")
    ) {
      return true;
    }
    return (
      window.location.protocol === "http:" &&
      (window.location.port === "8788" ||
        window.location.port === "8080" ||
        window.location.port === "3000")
    );
  } catch {
    return false;
  }
}

function vaultDevBootStep(step) {
  if (!isLocalDevHost()) return;
  try {
    document.getElementById("vault-dev-boot-banner")?.remove();
  } catch { /* never block boot */ }
}

// Feature flag — set to `true` only on local dev when iterating on the
// Run Companion Overlay. Production stays false until the feature is
// genuinely ready, so users never see a half-baked tab in their nav.
const OVERLAY_NAV_VISIBLE = false;

console.info(`[Vault] build ${VAULT_BUILD}`);
window.__VAULT_BUILD__ = VAULT_BUILD;
try {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "vault-build");
  meta.setAttribute("content", VAULT_BUILD);
  document.head.appendChild(meta);
} catch { /* never fail boot on a meta-tag write */ }

/**
 * Soft auto-update: detect when the loaded JS bundle is older than
 * the latest deployed build and surface a non-blocking banner with
 * a Reload button.
 *
 * The bug this solves: even with `Cache-Control: no-store` on
 * /script.js, browsers can serve from in-tab MEMORY cache (Safari
 * is especially aggressive about this). A user who opened the tab
 * before a deploy would keep running the old code forever, no
 * matter how many times they hit Cmd+R, until they fully quit the
 * browser. That's the "private mode shows new, normal doesn't" bug
 * we kept chasing.
 *
 * Detection: on tab visibility-change, fetch /index.html (no-store,
 * always fresh) and read the `<script src="/script.js?v=NN">`
 * version string. If the LIVE version is higher than ours, we're
 * stale.
 *
 * UX: the previous version force-reloaded the tab. That worked but
 * was hostile — anyone in the middle of typing an invite, scrolling
 * a long run, or signing into Steam would lose their place. The new
 * banner shows "A newer version of SpireVault is available —
 * Reload" with a button. The user reloads when they're ready.
 *
 * Forward-fix-only: catches future deploys for users who have THIS
 * code loaded. Users on builds older than this one still need ONE
 * manual hard-refresh.
 */
function vaultBuildNumber(s) {
  const m = (s || "").match(/^v(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

let updateCheckInflight = false;
let updateBannerShown   = false;

// SessionStorage keys for the update-banner state machine.
//
// vault.update.reloadedForVersion — set when the user clicks "Reload now".
//   If a subsequent checkForUpdate() still sees liveVersion > myVersion
//   for the SAME liveVersion that we just reloaded for, we know the
//   browser/CDN cache is wedged on stale script.js bytes — clicking
//   Reload again won't help. We surface a one-time "hard refresh
//   needed" hint instead of looping the same banner forever.
//
// vault.update.dismissed — set when the user clicks the × on a banner.
//   Suppresses re-show for that exact liveVersion in the same tab.
const SS_RELOADED_FOR = "vault.update.reloadedForVersion";
const SS_DISMISSED    = "vault.update.dismissed";

function isUpdateCheckSuppressed() {
  if (typeof IS_DESKTOP_HOST !== "undefined" && IS_DESKTOP_HOST) return true;
  try {
    const h = window.location.hostname;
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h.endsWith(".localhost")
    ) {
      return true;
    }
  } catch { /* ignore */ }
  try {
    if (typeof import.meta !== "undefined" && import.meta.env?.DEV) return true;
  } catch { /* ignore */ }
  return false;
}

async function checkForUpdate() {
  if (updateCheckInflight || updateBannerShown) return;
  // Local dev and desktop builds: HTML/script version pins drift during
  // iteration and the banner becomes a false positive on every tab focus.
  if (isUpdateCheckSuppressed()) return;
  updateCheckInflight = true;
  try {
    const r = await fetch("/", {
      method: "GET",
      cache: "no-store",
      credentials: "include",
    });
    if (!r.ok) return;
    const html = await r.text();
    const match = html.match(/script\.js\?v=(\d+)/);
    if (!match) return;
    const liveVersion = parseInt(match[1], 10);
    const myVersion   = vaultBuildNumber(VAULT_BUILD);

    // We're current — clear the loop-guard flag if it's set, so a
    // future genuine deploy can show its banner normally.
    if (liveVersion <= myVersion) {
      try { sessionStorage.removeItem(SS_RELOADED_FOR); } catch {}
      return;
    }

    // Loop-break. If the user already clicked "Reload now" for this
    // exact liveVersion and the post-reload page is STILL on the old
    // myVersion, the browser/CDN is serving stale script.js bytes
    // and a JS-driven reload can't fix it. Show the hard-refresh
    // hint exactly once instead of nagging with the same banner
    // every visibilitychange.
    let reloadedFor = 0;
    try {
      reloadedFor = parseInt(
        sessionStorage.getItem(SS_RELOADED_FOR) || "0",
        10
      );
    } catch {}
    if (reloadedFor === liveVersion) {
      console.warn(
        `[Vault] update banner suppressed — already reloaded for v${liveVersion}, browser cache still serving v${myVersion}. Showing hard-refresh hint.`
      );
      showHardRefreshHint(liveVersion, myVersion);
      return;
    }

    console.info(
      `[Vault] new build available (live v${liveVersion} > running v${myVersion}); banner shown`
    );
    showUpdateBanner(liveVersion);
  } catch { /* offline, network blip — try again next visibilitychange */ }
  finally { updateCheckInflight = false; }
}

/** Render the "newer version available" banner. Sticks at the top
 *  of #app-content above the global invite banner. Two actions:
 *  Reload (immediate `location.reload()`) and a tiny dismiss `×`
 *  (sessionStorage so we don't keep nagging in the same tab — the
 *  next tab open will show it again because a stale tab IS the
 *  reason a stuck user reaches this code path). */
function showUpdateBanner(liveVersion) {
  if (updateBannerShown) return;
  // Honor a per-tab dismiss before marking shown — otherwise a
  // dismissed banner blocks future genuine deploy notifications.
  try {
    if (sessionStorage.getItem(SS_DISMISSED) === String(liveVersion)) {
      updateBannerShown = true;
      return;
    }
  } catch {}
  updateBannerShown = true;

  const host = document.getElementById("app-content");
  if (!host) return;
  const bar = document.createElement("div");
  bar.id = "vault-update-banner";
  bar.className = "vault-update-banner";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-live", "polite");
  bar.innerHTML = `
    <span class="vault-update-banner-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/></svg>
    </span>
    <span class="vault-update-banner-text">
      <strong>A newer version of SpireVault is available.</strong>
      Reload to pick up the latest fixes &mdash; your sign-in and stats stay intact.
    </span>
    <button type="button" class="vault-update-banner-reload" data-action="vault-update-reload">
      Reload now
    </button>
    <button type="button" class="vault-update-banner-close" aria-label="Dismiss" data-action="vault-update-dismiss">&times;</button>`;
  host.insertBefore(bar, host.firstChild);

  const $reload = bar.querySelector('[data-action="vault-update-reload"]');
  $reload.addEventListener("click", async () => {
    sendBeacon("update-banner-reload", `from=${VAULT_BUILD} to=v${liveVersion}`);
    // Loop-guard: remember that we attempted a reload for this
    // exact liveVersion. If the post-reload boot still sees the
    // same liveVersion as newer than its myVersion, checkForUpdate
    // will know the cache is wedged and surface a hard-refresh
    // hint instead of looping the banner forever.
    try { sessionStorage.setItem(SS_RELOADED_FOR, String(liveVersion)); } catch {}
    // Disable the button so the user can't queue 5 reloads while
    // we're warming the cache.
    $reload.disabled = true;
    $reload.textContent = "Reloading…";
    // Best-effort: warm the browser HTTP cache for the new
    // script.js + HTML before the navigation. cache:"reload"
    // bypasses the HTTP cache and updates it. Without this, a
    // simple location.reload() can re-use the same stale
    // script.js bytes that triggered the banner in the first
    // place, putting the user in an "I keep clicking reload but
    // nothing changes" loop.
    try {
      await Promise.allSettled([
        fetch(`/script.js?v=${liveVersion}`, { cache: "reload" }),
        fetch("/", { cache: "reload" }),
      ]);
    } catch {}
    // Cache-busted navigation. Adding a unique query string
    // forces the browser to treat this as a fresh URL it has no
    // cache entry for, so the HTML must be re-fetched. The fresh
    // HTML references /script.js?v={liveVersion}, which we just
    // warmed in cache.
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("__v", String(liveVersion));
      window.location.replace(u.toString());
    } catch {
      window.location.reload();
    }
  });
  bar.querySelector('[data-action="vault-update-dismiss"]').addEventListener("click", () => {
    try { sessionStorage.setItem(SS_DISMISSED, String(liveVersion)); } catch {}
    bar.remove();
    sendBeacon("update-banner-dismissed", `from=${VAULT_BUILD} to=v${liveVersion}`);
  });
}

/** Render a one-time "your reload didn't pick up the new code, hard
 *  refresh is needed" hint. Called from checkForUpdate() when we
 *  detect that the user has already attempted to Reload-now for the
 *  current liveVersion and the post-reload boot is STILL on the old
 *  myVersion — meaning some cache layer (browser, CDN, service
 *  worker) is wedged on stale bytes that JS can't dislodge. Shows
 *  the platform-appropriate keyboard shortcut and clears the
 *  loop-guard on dismiss so the next genuine deploy can show its
 *  banner normally. */
function showHardRefreshHint(liveVersion, myVersion) {
  if (updateBannerShown) return;
  // Per-tab dismissal — if they dismissed the hint already, don't
  // re-show it on every visibility change or poll.
  try {
    if (sessionStorage.getItem(SS_DISMISSED) === `hint:${liveVersion}`) {
      updateBannerShown = true;
      return;
    }
  } catch {}
  updateBannerShown = true;

  const host = document.getElementById("app-content");
  if (!host) return;
  const bar = document.createElement("div");
  bar.id = "vault-update-banner";
  bar.className = "vault-update-banner vault-update-banner--stuck";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-live", "polite");
  const ua = (navigator.userAgent || "");
  const platform = (navigator.platform || "");
  const isMac = /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X|iPhone|iPad/.test(ua);
  const shortcut = isMac ? "Cmd + Shift + R" : "Ctrl + F5";
  bar.innerHTML = `
    <span class="vault-update-banner-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </span>
    <span class="vault-update-banner-text">
      <strong>Reload didn't pick up the latest version.</strong>
      Press <kbd class="vault-update-banner-kbd">${shortcut}</kbd> to force a hard refresh — your sign-in and stats stay intact.
    </span>
    <button type="button" class="vault-update-banner-close" aria-label="Dismiss" data-action="vault-update-dismiss">&times;</button>`;
  host.insertBefore(bar, host.firstChild);

  bar.querySelector('[data-action="vault-update-dismiss"]').addEventListener("click", () => {
    try {
      sessionStorage.setItem(SS_DISMISSED, `hint:${liveVersion}`);
      // Clear the reloadedFor flag so a future genuine deploy can
      // show its normal "Reload now" banner without first having
      // to clear this hint.
      sessionStorage.removeItem(SS_RELOADED_FOR);
    } catch {}
    bar.remove();
    sendBeacon("update-banner-hint-dismissed", `from=${VAULT_BUILD} stuckOn=v${liveVersion}`);
  });

  sendBeacon(
    "update-banner-hint-shown",
    `from=${VAULT_BUILD} myVersion=v${myVersion} liveVersion=v${liveVersion}`
  );
}

// Check once at boot (after a small delay so we don't compete with
// the rest of boot for the network), and again every time the tab
// becomes visible (foregrounded). This catches users who leave the
// tab open across deploys without forcing extra polling traffic.
setTimeout(() => { void checkForUpdate(); }, 4_000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkForUpdate();
});
const STORAGE_SESSION       = "vault.web.session";
/** The last Steam account signed in on this device. If that sign-in lapses
 *  (expired session, rejected token), its saved runs stay on screen instead
 *  of the sample data; a deliberate sign-out removes it, so a shared
 *  computer shows nobody's runs. */
const STORAGE_HISTORY_OWNER = "vault.web.history.owner";
const STORAGE_DRAFT         = "vault.web.presence.draft";
const STORAGE_LAST_TAB      = "vault.web.last-tab";
// `.v2` suffix is a deliberate cache-bust of the localStorage key.
// Earlier builds shipped without a "Random" option, so the first
// release defaulted everyone to a fixed character (e.g. "defect")
// the moment they touched the picker — and that value then stuck
// around forever, making the diorama feel broken ("why is it
// always Defect?"). Bumping the key resets every existing visitor
// back to the new Random default; anyone who genuinely wanted a
// fixed climber can re-pick it in two clicks.
const STORAGE_COMPANION     = "vault.web.companion.v2";
const STORAGE_OVERLAY_STATE = "vault.web.overlay.v1";
/** Last fingerprint of the linked save-folder file list — skips redundant full re-parsing when nothing changed.
 *  Suffix is bumped whenever the parser changes shape (new fields, new
 *  schema tolerance) so the next auto-refresh forces a re-parse with
 *  the new parser instead of trusting a cached "nothing changed" verdict
 *  that was made before the fix existed. */
const STORAGE_DIR_FP        = "vault.web.history.dir-fp.v2";
/** Display name of the linked save folder ("SlayTheSpire2", "history", …) — survives reloads so the "Linked" pill paints instantly. */
const STORAGE_LINKED_NAME   = "vault.web.history.linked-name";
// "1" when the linked folder/file came with a handle the browser lets us
// re-read (showDirectoryPicker / showOpenFilePicker). A folder chosen
// through the plain folder <input> (Safari, Firefox, and Chrome's fallback)
// leaves only its name: it can be imported again, not refreshed.
const STORAGE_LINKED_LIVE   = "vault.web.history.linked-live";
/** Epoch-ms of the last successful disk read (any source: folder picker,
 *  drag-drop, single-file picker, auto-refresh tick). Used by the
 *  Safari/Firefox "Refresh from disk?" nudge to decide if it's been
 *  long enough since the last import to be worth nagging the user.
 *  Skipped on Chromium because auto-refresh handles freshness there. */
const STORAGE_LAST_IMPORT_AT = "vault.web.history.last-import-at";
/** Epoch-ms of the last time we showed the no-FSA refresh nudge so we
 *  don't spam it on every visibility flicker. */
/** "granted" once navigator.storage.persist() succeeded on this
 *  origin, so we can skip re-asking on every boot. */
const STORAGE_DURABLE_FLAG   = "vault.web.storage.durable";
/** Lightweight localStorage mirror of the last successful IDB save.
 *  If IndexedDB hiccups on boot, this lets us show "you had N runs"
 *  and aggressively pull from cloud instead of looking empty. */
const STORAGE_LOCAL_BACKUP   = "vault.web.history.backup.v1";
/** Last time the user closed/hid the tab — powers "since you were here". */
const STORAGE_LAST_VISIT_AT    = "vault.web.lastVisitAt";
const STORAGE_LAST_VISIT_RUNS  = "vault.web.lastVisitRunCount";

/**
 * Ask the browser to mark this origin's storage as durable ("persistent"
 * in the Storage Standard sense). Without this, IndexedDB — where every
 * imported run lives — is *best-effort* storage: Chrome may evict it
 * under disk pressure and Safari's ITP may wipe it after 7 days of not
 * visiting. That eviction is exactly the "I had to re-upload my saves"
 * report we never want to hear again.
 *
 * Chromium auto-grants this silently for engaged/installed origins (no
 * prompt); Firefox may show a permission prompt; Safari grants based on
 * its own heuristics. All failure modes are non-fatal — cloud sync and
 * the linked folder handle remain the backstops — so this is strictly
 * fire-and-forget hardening, called only after we actually have real
 * run data worth protecting.
 */
async function ensureDurableStorage() {
  try {
    if (localStorage.getItem(STORAGE_DURABLE_FLAG) === "granted") return true;
  } catch { /* private mode — still worth attempting persist() below */ }
  try {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") return false;
    if (typeof navigator.storage.persisted === "function" && await navigator.storage.persisted()) {
      try { localStorage.setItem(STORAGE_DURABLE_FLAG, "granted"); } catch { /* ok */ }
      return true;
    }
    const granted = await navigator.storage.persist();
    if (granted) {
      try { localStorage.setItem(STORAGE_DURABLE_FLAG, "granted"); } catch { /* ok */ }
      sendBeacon("storage-durable-granted", "");
    }
    return granted;
  } catch {
    return false;
  }
}

/** Mirror run count to localStorage so a cold boot with an empty IDB
 *  read still knows the user had data and can cloud-restore instead of
 *  showing the import wall again. */
function persistLocalBackup(runCount) {
  if (!Number.isFinite(runCount) || runCount <= 0) return;
  try {
    localStorage.setItem(STORAGE_LOCAL_BACKUP, JSON.stringify({
      count: runCount,
      savedAt: Date.now(),
      steamID: session?.steamID || null,
    }));
  } catch { /* private mode */ }
}

/** When IDB is empty on boot, try disk handle then cloud before painting
 *  an empty dashboard. This is the "never make me re-import" path. */
async function bootRestoreFromDiskOrCloud(hasLinkedSaves, sess) {
  if (hasLinkedSaves) {
    await autoReloadHistoryIfPermitted({
      silent: true,
      allowPermissionPrompt: false,
      bypassFingerprint: true,
    });
  }
  if (parsedRuns.length === 0 && sess?.steamID) {
    await hydrateFromCloudIfAvailable();
  }
  if (parsedRuns.length > 0) {
    void ensureDurableStorage();
    persistLocalBackup(parsedRuns.length);
  }
}

function stampLastVisit() {
  if (isDemoMode || parsedRuns.length === 0) return;
  try {
    localStorage.setItem(STORAGE_LAST_VISIT_AT, String(Date.now()));
    localStorage.setItem(STORAGE_LAST_VISIT_RUNS, String(parsedRuns.length));
  } catch { /* ok */ }
}

function wireLastVisitTracking() {
  if (window.__vaultLastVisitWired) return;
  window.__vaultLastVisitWired = true;
  const go = () => stampLastVisit();
  window.addEventListener("pagehide", go);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") go();
  });
}

/**
 * What changed since this browser last saw the app: runs that ended after
 * the last visit, else how many more runs there are than last session.
 * Nothing in sample data. Read by the classic strip below and by the new
 * look's "Since your last visit" widget, so both count the same.
 * @returns {{ newRuns: number, sinceSession: number, demo: boolean }}
 */
function lastVisitNews(sortedByDate) {
  if (isDemoMode || !sortedByDate?.length) return { newRuns: 0, sinceSession: 0, demo: isDemoMode };
  let lastVisit = 0;
  let lastCount = 0;
  try {
    lastVisit = Number(localStorage.getItem(STORAGE_LAST_VISIT_AT)) || 0;
    lastCount = Number(localStorage.getItem(STORAGE_LAST_VISIT_RUNS)) || 0;
  } catch { /* ok */ }
  const newRuns = lastVisit > 0
    ? sortedByDate.filter((r) => r.endedAt && r.endedAt.getTime() > lastVisit).length
    : 0;
  const sinceSession = newRuns === 0 && lastCount > 0 && sortedByDate.length > lastCount
    ? sortedByDate.length - lastCount
    : 0;
  return { newRuns, sinceSession, demo: false };
}

/** "Since you were last here" — only when something actually changed.
 *  Quiet "Saved on this device · N runs ready" was repeating the crest
 *  and teaching nothing. */
function renderSinceLastVisitStrip(sortedByDate) {
  const { newRuns, sinceSession } = lastVisitNews(sortedByDate);
  if (newRuns > 0) {
    return `
      <div class="since-visit-strip since-visit-strip--new">
        <strong>${newRuns} new run${newRuns === 1 ? "" : "s"} since your last visit.</strong>
      </div>`;
  }
  if (sinceSession > 0) {
    return `
      <div class="since-visit-strip since-visit-strip--new">
        <strong>+${sinceSession} run${sinceSession === 1 ? "" : "s"} since last session.</strong>
      </div>`;
  }
  return "";
}

const WEEK_MS = 7 * 86_400_000;

/**
 * How long ago a run happened, in ms: from when it ended, else when it
 * started; Infinity when undated. Never negative: a run stamped in the future
 * (another device's clock running ahead) counts as just now, the way the Runs
 * list files it under Today. Every "this week" number goes through this, so
 * the Overview's "Your week" strip and its This week card count the same runs.
 * @param {{ endedAt?: Date|null, startedAt?: Date|null }} run
 * @param {number} now  epoch ms
 * @returns {number}
 */
function runAgeMs(run, now) {
  const t = run.endedAt ? run.endedAt.getTime() : (run.startedAt ? run.startedAt.getTime() : 0);
  if (!t) return Infinity;
  return Math.max(0, now - t);
}

/** In-app weekly digest v0 until the mailer ships. */
function renderWeeklyDigestStrip(sortedByDate) {
  if (isDemoMode || !sortedByDate?.length) return "";
  const now = Date.now();
  const weekRuns = sortedByDate.filter((r) => runAgeMs(r, now) < WEEK_MS);
  if (weekRuns.length === 0) return "";
  const wins = weekRuns.filter((r) => r.won).length;
  const losses = weekRuns.length - wins;
  const best = weekRuns.filter((r) => r.won && isLadderRun(r)).sort((a, b) => (b.ascension || 0) - (a.ascension || 0))[0];
  const bestLine = best
    ? ` · best win A${best.ascension || 0} ${best.character ? prettifyCharacterName(best.character) : ""}`
    : "";
  return `
    <div class="weekly-digest-strip">
      <strong>Your week:</strong>
      <span>${weekRuns.length} run${weekRuns.length === 1 ? "" : "s"} · ${wins}W · ${losses}L${bestLine}</span>
    </div>`;
}

async function fetchCommunityStatsCached() {
  try {
    const cached = sessionStorage.getItem("vault.web.community-pulse");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - (parsed.fetchedAt || 0) < 10 * 60_000) return parsed.data;
    }
  } catch { /* ok */ }
  try {
    const r = await fetch(`${API_BASE}/stats/community`, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const data = await r.json();
    try {
      sessionStorage.setItem(
        "vault.web.community-pulse",
        JSON.stringify({ fetchedAt: Date.now(), data })
      );
    } catch { /* ok */ }
    return data;
  } catch {
    return null;
  }
}

// Companion options for the Overview page's animated persona picker.
// Declared up here (not next to renderCompanion()) because boot() runs
// immediately on module load and calls renderCompanion() before the
// physical location of its own declaration — a module-scope `const`
// defined further down would hit a Temporal Dead Zone at call time.
const COMPANIONS = [
  // "random" is a meta-option: each render rolls a fresh climber from
  // the five real characters. Anyone who picks it is opting *into*
  // per-refresh variety rather than a fixed avatar.
  //
  // `facesLeft` flag: in the diorama, the climber lives in the LEFT
  // grid column and the Architect lives in the RIGHT column. For the
  // scene to read as "two characters facing each other," every
  // climber sprite needs to be facing right. The MegaCrit source art
  // for some characters (Silent, Necrobinder, Regent, Ironclad) is
  // painted facing left — those get a `transform: scaleX(-1)` via
  // the .scene-art-flip class so they look at the Architect instead
  // of away from him. Defect's sprite is already painted facing
  // right (legs and torso angled right) so it stays unflipped.
  { id: "random",     label: "Random",     blurb: "Surprise me.",            color: "#ffa05c", isRandom: true },
  { id: "ironclad",   label: "Ironclad",   blurb: "Tempered steel.",         color: "#e94560", facesLeft: true },
  { id: "silent",     label: "Silent",     blurb: "Poisons and shadows.",    color: "#6dd97c", facesLeft: true },
  // Defect's source art (the blue plush bear, hands forward) is painted
  // with its body angled to its OWN right — which means in the diorama
  // (climber on left of the boss) the bear ends up facing AWAY from the
  // Architect. Flip it so the duel reads correctly: both figures square
  // off across the painted floor instead of staring in opposite directions.
  { id: "defect",     label: "Defect",     blurb: "Orbs and algorithms.",    color: "#4dc8ff", facesLeft: true },
  { id: "regent",     label: "Regent",     blurb: "Crown and consequence.",  color: "#d4af37", facesLeft: true },
  { id: "necrobinder",label: "Necrobinder",blurb: "Bone, blood, and will.",  color: "#9b83ff", facesLeft: true },
  // The Fool, the STS2 public-beta character (v0.113.0). The blurb is Mega
  // Crit's own patch-note line. His art is the game's own rest-site art
  // (characters/fool-v2.webp; the new look inks it as stage/fool-ink-v1),
  // painted facing right — already toward the Architect, so no flip.
  // A full member of the roster everywhere (picker, Random, Characters),
  // whether or not this player has a Fool run yet.
  { id: "fool",       label: "The Fool",   blurb: "A silly musician who wields a bow!", color: "#f27ec0" },
];

// Last quote speaker, used to avoid streaks where one side talks
// repeatedly (which reads as "Architect dominates every line").
let lastQuoteSpeaker = null;

// Cached diorama state. Invalidated when the user picks a different
// companion, taps the speech bubble for a manual re-roll, or switches
// among stats tabs (Overview / Characters / …) so each tab feels like a
// fresh moment — new line always; climber re-rolls when the picker is set
// to Random. Without *some* cache, every renderCompanion() during the same
// tab would reshuffle; we only null the cache at those explicit moments.
let companionScene = null;

/** Best-effort guess at whether the current device is a desktop
 *  with the Steam client probably installed and registered for
 *  `steam://` URLs. Used to gate the "Launch STS2" deep-link
 *  button so iOS / Android visitors don't get hit with Safari's
 *  hard "address is invalid" error dialog. False negatives
 *  (desktop browsers reporting a touch UA) are the safer side to
 *  err on — they just don't see a button that wouldn't have
 *  worked anyway. STS2 is desktop-only so we never miss a real
 *  use case on mobile. */
function isDesktopLikelyToHandleSteamClient() {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/iphone|ipad|ipod|android|mobile/.test(ua)) return false;
  // Touch-first devices (iPad with desktop UA, Surface, etc.) are
  // less likely to have the Steam client. Treat any coarse-pointer
  // primary input as "probably mobile-ish."
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return false;
  return true;
}

// Antagonist pool. Every boss has art shipped under
// /assets/sts2/bosses/<slug>.webp, but only entries flagged
// `colored: true` are actually rolled into the diorama right now
// — the others are grayscale silhouettes (that's how the wiki
// publishes them while STS2 is in early access) and they looked
// bad against the painted scene. As we get full-color art for
// the rest, flip their `colored` flag to true and they'll
// automatically join the random pool.
//
// Per-boss `lines` arrays carry short in-character taunts. Lines
// tagged `only:` are scoped to a specific climber — a Defect-
// flavored Architect line won't fire when Ironclad is on the
// field.
const BOSSES = [
  {
    id: "architect", label: "The Architect", colored: true, color: "#6db6d9",
    lines: [
      { text: "Cursed to fight forever, aren't you?" },
      { text: "Not even an introduction?" },
      { text: "I pity you. Kill..." },
      { text: "What are you after?" },
      { text: "You cannot change the past with anger." },
      { text: "Annoying wretch! BE GONE!!" },
      { only: "ironclad",    text: "Return to the bottom, Ironclad." },
      { only: "regent",      text: "The loud fool returns?" },
      { only: "regent",      text: "I'll teach you some manners!" },
      { only: "necrobinder", text: "Vengeance is it? No thank you." },
      { only: "silent",      text: "Vengeance is it? No thank you." },
      { only: "defect",      text: "Repair you? Make me." },
      { only: "defect",      text: "You're back? Didn't I dismantle you?" },
    ],
  },
  {
    id: "vantom", label: "Vantom",
    lines: [
      { text: "The void hungers." },
      { text: "Step closer. I insist." },
      { text: "All paths end in me." },
      { text: "Your soul has weight." },
    ],
  },
  {
    id: "the_kin", label: "The Kin",
    lines: [
      { text: "We are many." },
      { text: "One of us. One of us." },
      { text: "You will join the chorus." },
      { text: "Bind your fate to ours." },
    ],
  },
  {
    id: "soul_fysh", label: "Soul Fysh",
    lines: [
      { text: "Bloop." },
      { text: "Glub. Glub. Glub." },
      { text: "Tide takes everything." },
      { text: "Drown in starlight." },
    ],
  },
  {
    id: "kaiser_crab", label: "Kaiser Crab",
    lines: [
      { text: "MY tide pool." },
      { text: "Snip. Snip." },
      { text: "Shell out, climber." },
      { text: "I rule this floor." },
    ],
  },
  {
    id: "knowledge_demon", label: "Knowledge Demon",
    lines: [
      { text: "I know your deck." },
      { text: "I read every move." },
      { text: "Your draw is predictable." },
      { text: "Knowledge is leverage." },
    ],
  },
  {
    id: "lagavulin_matriarch", label: "Lagavulin Matriarch",
    lines: [
      { text: "Sleep was sweet." },
      { text: "You woke me, climber." },
      { text: "Now you'll regret it." },
      { text: "Old debts come due." },
    ],
  },
  {
    id: "doormaker", label: "Doormaker",
    lines: [
      { text: "Every door leads here." },
      { text: "Mind the threshold." },
      { text: "I built this hallway." },
      { text: "No exits today." },
    ],
  },
  {
    // Replaced Doormaker as the main-branch Act 3 boss option in
    // v0.107.1 (June 19, 2026). Doormaker's entry stays above so
    // older runs in history still get a taunt line.
    id: "aeonglass", label: "Aeonglass",
    lines: [
      { text: "Time wears thin here." },
      { text: "Everything withers, eventually." },
      { text: "You've spent enough turns." },
      { text: "The hourglass does not refill." },
    ],
  },
  {
    id: "test_subject", label: "Test Subject",
    lines: [
      { text: "Subject 0042. Live trial." },
      { text: "The experiment continues." },
      { text: "Adaptation observed." },
      { text: "I am the control group." },
    ],
  },
  {
    id: "waterfall_giant", label: "Waterfall Giant",
    lines: [
      { text: "I AM the river." },
      { text: "Wash over you." },
      { text: "Stone splits eventually." },
      { text: "Pebbles like you, all the same." },
    ],
  },
];

// Lore-flavored chatter. Climber lines have an `only:` slug for
// character-specific bravado; lines without `only:` work for any
// climber. Tone rules:
//   - In-universe references only (Neow, the Heart, Ascensions,
//     real STS2 cards/relics).
//   - Short, declarative, not cryptic. Anyone who's never played
//     STS2 should be able to read a line without needing context.
//     Aim for 18–48 characters per line.
//   - No fourth-wall jokes. Reads like an in-game taunt, not an
//     internet comment.
// Boss lines live on each entry in BOSSES so they stay scoped to
// the figure that's actually on screen.
const CLIMBER_LINES = [
  // ─── Character-agnostic ───
  { text: "Up we go." },
  { text: "One more floor." },
  { text: "Bring it." },
  { text: "I've seen worse." },
  { text: "I've trained for this." },
  { text: "Block first. Strike harder." },
  { text: "Show me the boss." },
  { text: "Three acts. Easy." },
  { text: "My deck is ready." },
  { text: "The Spire bleeds today." },
  { text: "Heart, I'm coming for you." },
  { text: "Neow's blessing was enough." },
  { text: "Ascension 9 or nothing." },

  // ─── Ironclad ───
  { only: "ironclad", text: "Anger. Steel. Repeat." },
  { only: "ironclad", text: "Burning Blood keeps me going." },
  { only: "ironclad", text: "Strength I trust." },
  { only: "ironclad", text: "Bash first. Talk never." },
  { only: "ironclad", text: "Block, anger, kill." },

  // ─── Silent ───
  { only: "silent", text: "From the shadows." },
  { only: "silent", text: "Silent. Deadly. Done." },
  { only: "silent", text: "Daggers first." },
  { only: "silent", text: "Poisons stack. So do bodies." },
  { only: "silent", text: "Catalyst on full poison. Watch." },

  // ─── Defect ───
  { only: "defect", text: "Channel. Defend. Destroy." },
  { only: "defect", text: "Three orbs. One plan." },
  { only: "defect", text: "Compute the kill." },
  { only: "defect", text: "Lightning prefers your face." },
  { only: "defect", text: "Frost and Focus. That's all." },

  // ─── Regent ───
  { only: "regent", text: "Bow to the deck." },
  { only: "regent", text: "My court awaits." },
  { only: "regent", text: "The crown is heavy. So is my hammer." },
  { only: "regent", text: "Kneel or fall. Either works." },

  // ─── Necrobinder ───
  { only: "necrobinder", text: "Bones remember." },
  { only: "necrobinder", text: "Death is a setback." },
  { only: "necrobinder", text: "I bound them. They bind back." },
  { only: "necrobinder", text: "The grave has a deck list." },
];
// Poll cadences are tuned to keep us well under Cloudflare KV's free-tier
// daily quotas (1k writes/day, 1k list ops/day, 100k reads/day). A single
// pair of active browsers used to burn the list-op quota in hours; new
// roster-style storage on the server eliminated lists entirely, but we
// also slowed these down because there's no UX win in 12-second polls.
const POLL_FEED_MS          = 30_000;  // was 12_000
const POLL_INBOX_MS         = 30_000;  // was 10_000
const HEARTBEAT_MS          = 180_000; // was 90_000
// The Worker stores nothing for a second heartbeat inside a minute, so one
// is not sent (see pushNow).
const PRESENCE_PUSH_MIN_GAP_MS = 60_000;

const TABS_WITH_DATA = ["overview", "characters", "ascensions", "relics", "cards", "runs"];
const KNOWN_TABS = ["overview", "characters", "ascensions", "relics", "cards", "runs", "coop", "news", "highlights", "settings", "overlay", "beta"];

// Where the desktop app keeps history.json on each platform. These are
// declared at the top of the module because boot code (switchTab → empty
// state) runs synchronously and pulls them in BEFORE any function-scope
// declaration further down in the file would be reached. Hoisting them
// up here avoids a Temporal Dead Zone ReferenceError on cold load that
// would otherwise wipe out the entire boot path (and silently kill
// IndexedDB persistence, presence heartbeats, and the live feed).
// Where Slay the Spire 2 actually writes per-run save files. One JSON
// `.run` file per game, named `<unix_timestamp>.run`. STS2's full path
// embeds your numeric Steam user ID, which we don't need — pointing the
// directory picker at the parent `SlayTheSpire2/` folder works because
// our walker recurses to find every `.run` file underneath, regardless
// of which Steam profile id is in there.
//
// VERIFIED (May 2026, STS2 build v0.104.x, schema_version 9):
//
//   macOS:    ~/Library/Application Support/SlayTheSpire2/steam/<id>/profile1/saves/history/
//   Windows:  %APPDATA%\SlayTheSpire2\steam\<id>\profile1\saves\history\
//   Linux:    ~/.local/share/SlayTheSpire2/steam/<id>/profile1/saves/history/
//
// IMPORTANT — common confusion: Steam Library → right-click STS2 →
// "Browse local files" opens the GAME INSTALL folder
// (Steam/steamapps/common/Slay the Spire 2/), which is a different
// folder entirely with no save data. Saves live in the application-
// support / AppData paths above.
//
// We expose BOTH a "parent" path (for one-click pasting + walking the
// tree) AND the full deep `history/` path (so the user can verify
// they're looking at the right place). The directory walker recurses
// through any depth, so users can pick the parent OR the deepest
// `history/` folder and we read every `.run` file regardless.
//
// The legacy `history.json` rollup path
// (`~/Library/Application Support/AscensionCompanion/vault/`) was
// what the macOS Vault CLI wrote. Still accepted by the parser, but
// no longer surfaced in the UI because almost nobody has it.
const HISTORY_PATH_MAC = "~/Library/Application Support/SlayTheSpire2";
const HISTORY_PATH_WIN = "%APPDATA%\\SlayTheSpire2";
const HISTORY_PATH_LINUX = "~/.local/share/SlayTheSpire2";
/** Full deep paths to the actual `.run` files. Shown as a hint so the
 *  user knows what shape the inside of the picked folder should have. */
const HISTORY_PATH_MAC_FULL   = "~/Library/Application Support/SlayTheSpire2/steam/<your-steam-id>/profile1/saves/history/";
const HISTORY_PATH_WIN_FULL   = "%APPDATA%\\SlayTheSpire2\\steam\\<your-steam-id>\\profile1\\saves\\history\\";
const HISTORY_PATH_LINUX_FULL = "~/.local/share/SlayTheSpire2/steam/<your-steam-id>/profile1/saves/history/";

// ─── STS2 asset library ────────────────────────────────────────────────
// Card / relic / character art lives under /assets/sts2/ as optimized
// webp (15 MB total, generated by scripts/build_sts2_assets.py from the
// iOS Ascension Companion's xcassets). The manifest is fetched once at
// boot so we can cheaply check "does this slug have art?" without 404
// roundtrips. If the manifest fails to load we silently fall back to
// the previous text-only / SVG-only renderers — assets are an enhancement,
// not a hard dependency.
const ASSET_BASE = "/assets/sts2";
let assetManifest = { cards: new Set(), relics: new Set(), characters: new Set(), potions: new Set(), bosses: new Set() };
// Friendly display names: { cards: { slug: "Blood Wall" }, relics: { ... } }
// Sourced from the iOS Companion's GameDatabase by extract_sts2_labels.py.
// The manifest tells us *what art exists*; the labels tell us *how to
// spell things in the UI*. Without labels we'd show "Bloodwall" instead
// of "Blood Wall" because the asset slug is concatenated.
let assetLabels = { cards: {}, relics: {}, bosses: {} };
let assetManifestLoaded = false;

async function loadAssetManifest() {
  if (assetManifestLoaded) return;
  try {
    // Fetch both side-by-side; labels are best-effort (missing labels
    // gracefully fall back to prettifyId on the slug).
    // Cache-bust the manifest fetch on each schema bump. Without
    // this, returning visitors get stuck on a `force-cache` copy
    // that's missing newly-shipped assets (the `architect` boss
    // entry was the bug that made the boss render as a fallback
    // glyph for an entire deploy cycle). Bump MANIFEST_VERSION
    // whenever the contents of manifest.json change.
    //
    // v3 (2026-05-09): added STS2 v0.105.0 content — three new Neow
    // relics (Kaleidoscope, Fishing Rod, Silken Tress) and the new
    // Act 3 boss Aeonglass. Labels-only (no art shipped yet); the
    // resolver falls back to the 2-letter glyph until we ship icons.
    // v5 (2026-11-13): STS2 beta v0.113.0 labels — My Shinies, Dingy
    // Dagger, Mighty Weapon/Shield, and the seven new event relics
    // (Wuppy, Obsidian Vice, Thumbscrew, Tormentous Collar, Mighty
    // Wings, Bath Towel, Bath Robes). Labels-only, no art.
    // v6 (2026-11-13): The Fool's cards and every other v0.113.0 card and
    // relic, names and art, pulled from the game itself
    // (scripts/sync-sts2-labels.mjs, build-card-faces.mjs, build-relic-icons.mjs),
    // plus The Fool's character art.
    const MANIFEST_VERSION = 6;
    const [manRes, labRes] = await Promise.all([
      fetch(`${ASSET_BASE}/manifest.json?v=${MANIFEST_VERSION}`, { cache: "force-cache" }),
      fetch(`${ASSET_BASE}/labels.json?v=${MANIFEST_VERSION}`,   { cache: "force-cache" }).catch(() => null),
    ]);
    if (!manRes.ok) throw new Error(`manifest ${manRes.status}`);
    const j = await manRes.json();
    assetManifest = {
      cards:      new Set(j.cards      || []),
      relics:     new Set(j.relics     || []),
      characters: new Set(j.characters || []),
      potions:    new Set(j.potions    || []),
      bosses:     new Set(j.bosses     || []),
    };
    if (labRes && labRes.ok) {
      const lj = await labRes.json();
      assetLabels = {
        cards:  lj.cards  || {},
        relics: lj.relics || {},
        // Bosses landed in labels.json with the v0.105.0 patch —
        // older snapshots predate the field, so default to {} and
        // let lookups fall through to prettifyId(slug).
        bosses: lj.bosses || {},
      };
    }
    assetManifestLoaded = true;
    console.info(`[Vault] assets ready: ${assetManifest.cards.size} cards, ${assetManifest.relics.size} relics, ${assetManifest.characters.size} characters · ${Object.keys(assetLabels.cards).length} card labels, ${Object.keys(assetLabels.relics).length} relic labels`);
    // Companion was rendered during boot before the manifest finished
    // loading, which means characterImageSrc() returned null and the
    // diorama showed letter-glyph fallbacks instead of the full-body
    // character art. Re-render now that the manifest is populated so
    // first paint shows the real PNGs without requiring user action.
    if (typeof renderCompanion === "function") {
      try { renderCompanion(); } catch (e) { console.warn("companion re-render after manifest failed", e); }
    }
    if (parsedRuns.length > 0 && TABS_WITH_DATA.includes(activeTab) && activeTab !== "coop") {
      try { renderStatsTab(activeTab); } catch (e) { console.warn("[Vault] re-render after manifest failed", e); }
    }
  } catch (e) {
    console.warn("[Vault] asset manifest unavailable, using text fallback", e);
  }
}

/** Look up a friendly display name. Tries the exact slug first, then
 *  several permutations because run-data IDs come in three flavors:
 *    1. concatenated with class prefix:  `ironclad_perfectedstrike`
 *    2. snake-case with class prefix:    `ironclad_perfected_strike`
 *    3. bare snake-case (legacy STS1):   `perfected_strike` / `inflame`
 *  Asset library slugs always use form (1), so we normalize toward that.
 *  Falls back to prettifyId so callers can stay one-liners. */
function cardLabel(id) {
  const slug = cardSlug(id);
  if (assetLabels.cards[slug]) return assetLabels.cards[slug];
  const parts = slug.split("_");
  const isPlus = parts[parts.length - 1] === "plus";
  const baseParts = isPlus ? parts.slice(0, -1) : parts;
  const plusSuffix = isPlus ? "_plus" : "";
  // `.run` files name each character's basics `<card>_<class>` (STRIKE_FOOL)
  // while labels use `<class>_<card>` (fool_strike): the swap cardImageSrc
  // already does. Without it every Strike read "Strike Fool".
  const lastPart = baseParts[baseParts.length - 1];
  if (baseParts.length >= 2 && CLASS_PREFIXES.has(lastPart)) {
    const swapped = lastPart + "_" + baseParts.slice(0, -1).join("") + plusSuffix;
    if (assetLabels.cards[swapped]) return assetLabels.cards[swapped];
  }
  // Form (2) → form (1): keep class prefix, concatenate the rest.
  if (baseParts.length >= 3) {
    const collapsed = baseParts[0] + "_" + baseParts.slice(1).join("") + plusSuffix;
    if (assetLabels.cards[collapsed]) return assetLabels.cards[collapsed];
  }
  // Form (3) → form (1): concatenate everything, then look for any class
  // prefix that owns this name. Catches `perfected_strike`, `body_slam`,
  // `pommel_strike`, `shrug_it_off`, etc. — and one-word ids too
  // (`begone` → regent_begone "BEGONE!", `abundance` → "Neow's
  // Abundance"), the same scan cardImageSrc does for the art.
  if (baseParts.length >= 1) {
    const concatenated = baseParts.join("") + plusSuffix;
    if (assetLabels.cards[concatenated]) return assetLabels.cards[concatenated];
    for (const k in assetLabels.cards) {
      if (k.endsWith(`_${concatenated}`)) return assetLabels.cards[k];
    }
  }
  return prettifyId(id);
}

function relicLabel(id) {
  const raw = String(id || "").trim().toLowerCase();
  if (assetLabels.relics[raw]) return assetLabels.relics[raw];
  const concat = raw.replace(/_/g, "");
  if (assetLabels.relics[concat]) return assetLabels.relics[concat];
  return prettifyId(id);
}

/** Resolve a boss/`killedBy` slug to a human display name. Same shape
 *  as relicLabel — exact match wins, underscore-stripped form is the
 *  fallback before prettifyId guesses from the slug. Used by the
 *  Recent Runs hover preview and the run-detail modal so we render
 *  "Aeonglass" instead of "aeonglass" or worse, "Aeon Glass". */
function bossLabel(id) {
  const raw = String(id || "").trim().toLowerCase();
  if (!raw) return "";
  if (assetLabels.bosses[raw]) return assetLabels.bosses[raw];
  const concat = raw.replace(/_/g, "");
  if (assetLabels.bosses[concat]) return assetLabels.bosses[concat];
  return prettifyId(id);
}

/** Normalize a card ID from a run record into the slug used by the
 *  optimized asset library. STS2 emits IDs like `ironclad_strike` and
 *  upgraded variants like `ironclad_whirlwind+1`; the asset slugs are
 *  `ironclad_strike` and `ironclad_whirlwind_plus`. We strip whitespace,
 *  lowercase, and convert any `+<digits?>` upgrade suffix into `_plus`. */
function cardSlug(id) {
  return String(id || "").trim().toLowerCase().replace(/\+\d*$/, "_plus");
}

/** Returns a URL string for the card image, or null if we don't have art
 *  for that slug (caller should render its text fallback).
 *
 *  The asset library uses the form `<class>_<concatname>` for cards
 *  (e.g. `ironclad_ashenstrike`, NOT `ironclad_ashen_strike`) — the
 *  iOS xcassets concatenated multi-word card names. STS2's history.json
 *  emits the same shape, so the common case is a direct hit. We add
 *  fallbacks for legacy / mod / test data that might use snake_case
 *  variants. */
// Set of class-prefix tokens used by the asset library. Used by the slug-
// swap fallback below: when the input slug ends with a class name (e.g.
// `strike_ironclad`, the order STS2's `.run` files use) we know to try
// the swapped form (`ironclad_strike`, the order the asset library uses).
// STS2's roster only — there is no Watcher in this game (Regent and
// Necrobinder replaced her; the run parser maps stray `watcher` character
// values from mods/legacy data to Regent). A watcher token here could
// never resolve to art anyway: the asset library ships no watcher_* files.
const CLASS_PREFIXES = new Set([
  "ironclad", "silent", "defect", "regent", "necrobinder",
  "fool", // The Fool, STS2 public beta (v0.113.0)
  "colorless", "curse", "status",
]);

/** Bumped whenever the card images are redrawn in place
 *  (scripts/build-card-faces.mjs --redraw). Their file names do not change
 *  and /assets/* is cached for a year; a new query string is a new cache
 *  entry, so this is what delivers the redrawn images to returning visitors.
 *  v2 (2026-11-14): every shipped face redrawn from the installed game
 *  (v0.113.0), so the cards say what they do now. */
const CARD_ART_VERSION = 2;
const cardArtUrl = (slug) => `${ASSET_BASE}/cards/${slug}.webp?v=${CARD_ART_VERSION}`;

function cardImageSrc(id) {
  let slug = cardSlug(id);
  if (!slug) return null;
  if (assetManifest.cards.has(slug)) return cardArtUrl(slug);
  const parts = slug.split("_");
  const isPlus = parts[parts.length - 1] === "plus";
  const baseParts = isPlus ? parts.slice(0, -1) : parts;
  const plusSuffix = isPlus ? "_plus" : "";

  // Slug-order swap: STS2's `.run` files emit the most common cards as
  // `<action>_<class>` (e.g. `strike_ironclad`, `defend_silent`) but the
  // asset manifest uses `<class>_<action>` (`ironclad_strike`,
  // `silent_defend`). Detect a trailing class token and try the swap
  // before any other fallback. This restores art on the most-played
  // cards in the entire game (every starting deck's strikes and defends).
  if (baseParts.length >= 2) {
    const last = baseParts[baseParts.length - 1];
    if (CLASS_PREFIXES.has(last)) {
      const swapped = last + "_" + baseParts.slice(0, -1).join("_") + plusSuffix;
      if (assetManifest.cards.has(swapped)) return cardArtUrl(swapped);
      // Also try the collapsed-name variant of the swap, e.g.
      // `feel_no_pain_ironclad` → `ironclad_feelnopain`.
      const swappedCollapsed = last + "_" + baseParts.slice(0, -1).join("") + plusSuffix;
      if (assetManifest.cards.has(swappedCollapsed)) return cardArtUrl(swappedCollapsed);
    }
  }

  // 3+ baseparts → has a class prefix; concatenate the rest of the name:
  //   `ironclad_pommel_strike` → `ironclad_pommelstrike`.
  if (baseParts.length >= 3) {
    const collapsed = baseParts[0] + "_" + baseParts.slice(1).join("") + plusSuffix;
    if (assetManifest.cards.has(collapsed)) return cardArtUrl(collapsed);
  }
  // 2 baseparts → bare snake-case name without a class prefix. Concatenate
  // everything and look for any `<class>_<concatenated>` asset. Catches
  // `perfected_strike`, `body_slam`, `pommel_strike`, `shrug_it_off`, etc.
  if (baseParts.length >= 2) {
    const concatenated = baseParts.join("") + plusSuffix;
    if (assetManifest.cards.has(concatenated)) return cardArtUrl(concatenated);
    for (const c of assetManifest.cards) {
      if (c.endsWith(`_${concatenated}`)) return cardArtUrl(c);
    }
  }
  // Last-resort partial match: scan for an asset that ends with the slug
  // joined with one or zero underscores. Handles cases where the manifest
  // has `ironclad_one_twopunch` (one underscore preserved, rest collapsed)
  // for the unupgraded base while the upgraded form is `ironclad_onetwopunch_plus`.
  if (baseParts.length >= 2) {
    for (let split = 1; split < baseParts.length; split++) {
      const head = baseParts.slice(0, split).join("");
      const tail = baseParts.slice(split).join("");
      const blended = head + "_" + tail + plusSuffix;
      for (const c of assetManifest.cards) {
        if (c.endsWith(`_${blended}`) || c === blended) return cardArtUrl(c);
      }
    }
  }
  // Single-word legacy fallback: `inflame` → `ironclad_inflame`.
  for (const c of assetManifest.cards) {
    if (c === slug || c.endsWith(`_${slug}`)) return cardArtUrl(c);
  }
  return null;
}

// Hand-curated relic id aliases. STS2 `.run` files emit some relic ids
// without the leading article (`CHOSEN_CHEESE`) while the asset library
// concatenates the full in-game name (`thechosencheese`). The naive
// underscore-strip fallback below catches most of these, but loses on
// any relic whose canonical asset name starts with `the` or `a` and
// whose `.run` id strips that article. We list those explicitly.
//
// To extend: drop a console.warn when an asset fails to resolve, look
// at the slug it tried, then add an entry mapping that slug to the
// concatenated asset filename (without the .webp extension) we already
// ship under Web/assets/sts2/relics/.
const RELIC_SLUG_ALIASES = Object.freeze({
  // Daily-run / event relics that emit without the `THE_` article.
  chosen_cheese: "thechosencheese",
  chosencheese: "thechosencheese",
  // Common "the_*" relics whose id form may drop the article.
  boot: "theboot",
  courier: "thecourier",
  abacus: "theabacus",
  specimen: "thespecimen",
});

function relicImageSrc(id) {
  const slug = String(id || "").trim().toLowerCase();
  if (!slug) return null;
  if (assetManifest.relics.has(slug)) return `${ASSET_BASE}/relics/${slug}.webp`;
  // Hand-curated alias — wins over generic fallbacks because it knows
  // the exact asset name we ship.
  const aliased = RELIC_SLUG_ALIASES[slug];
  if (aliased && assetManifest.relics.has(aliased)) {
    return `${ASSET_BASE}/relics/${aliased}.webp`;
  }
  // Most relic asset slugs are concatenated (`artofwar`, `bagofmarbles`)
  // even though STS1-era code often emitted snake_case (`art_of_war`).
  // Try the underscore-stripped form as a fallback.
  const concat = slug.replace(/_/g, "");
  if (assetManifest.relics.has(concat)) return `${ASSET_BASE}/relics/${concat}.webp`;
  // The article-prepended form: `chosen_cheese` → `thechosencheese`.
  // We already cover the explicit case in the alias map but keep the
  // generic form for future relics nobody's added there yet.
  const articled = "the" + concat;
  if (assetManifest.relics.has(articled)) return `${ASSET_BASE}/relics/${articled}.webp`;
  // Some manifest entries collapse only the trailing words and keep one
  // leading underscore — e.g. `self_formingclay` (manifest) for input
  // `self_forming_clay`. Try every "first-N joined, rest concatenated"
  // variant; the manifest is small enough that this is essentially free.
  const parts = slug.split("_");
  if (parts.length >= 3) {
    for (let split = 1; split < parts.length; split++) {
      const variant = parts.slice(0, split).join("_") + "_" + parts.slice(split).join("");
      if (assetManifest.relics.has(variant)) return `${ASSET_BASE}/relics/${variant}.webp`;
    }
  }
  return null;
}

/** Character sprite filenames are versioned to allow cache-busting
 *  the long-immutable CDN copy when we re-process the art. The v2
 *  set normalizes every character to the same fill ratio (~85% of a
 *  512x512 canvas, anchored bottom-center), so Regent and Defect
 *  visually occupy the same space in the diorama instead of Regent
 *  rendering at half the size. Bump this when we re-export. */
const CHARACTER_ASSET_VERSION = "v2";

function characterImageSrc(name) {
  const slug = String(name || "").trim().toLowerCase();
  if (!slug || !assetManifest.characters.has(slug)) return null;
  return `${ASSET_BASE}/characters/${slug}-${CHARACTER_ASSET_VERSION}.webp`;
}

/** Architect asset path.
 *
 *  History: the original filename `architect.webp` got poisoned at
 *  the Cloudflare edge cache. We re-exported under `architect-wiki`,
 *  then shipped a sharper crystal-v4 cut for the Overview diorama
 *  (new basename so the immutable CDN can't serve the soft old bytes).
 *  Other bosses use a single stable filename because their art is fixed. */
const ARCHITECT_ASSET_BASENAME = "architect-crystal-v4";

function bossImageSrc(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;
  // The Architect is shipped as a fixed asset on every build, so
  // resolve him without consulting the manifest. This protects the
  // diorama from the "stale `force-cache` manifest serves an old
  // bosses list" race that previously made the boss render as a
  // letter glyph fallback.
  if (s === "architect") {
    return `${ASSET_BASE}/bosses/${ARCHITECT_ASSET_BASENAME}.webp`;
  }
  if (!assetManifest.bosses.has(s)) return null;
  return `${ASSET_BASE}/bosses/${s}.webp`;
}

/** Returns a `srcset` attribute value (1x + 2x retina) for bosses that
 *  ship a high-res companion file. Currently only the Architect — the
 *  rest of the bosses live behind the manifest in a single resolution.
 *  Falls back to an empty string if there's no @2x variant; callers
 *  should treat empty as "use plain `src` only". */
function bossImageSrcset(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (s === "architect") {
    return `${ASSET_BASE}/bosses/${ARCHITECT_ASSET_BASENAME}.webp 1x, ${ASSET_BASE}/bosses/${ARCHITECT_ASSET_BASENAME}@2x.webp 2x`;
  }
  return "";
}

// ─── Module state ──────────────────────────────────────────────────────
//
// `session` starts from localStorage (synchronous, fast, works for desktop
// and any browser that hasn't been ITP-evicted). If localStorage is empty
// the boot path *also* tries the first-party HttpOnly cookie via
// `/api/_session` — that's our ITP-resistant fallback for iOS Safari, which
// silently wipes localStorage after 7 days of no interaction.
//
// This is `let` rather than `const` purely because of the rehydration step;
// every other site in the file still treats it as the single source of
// truth for "is there a logged-in user right now."
let session = readSession();

/** Tabs that need a Steam account. A signed-out visitor sees a sign-in
 *  screen in their place (.tab-lock in index.html, whose data-steam-lock
 *  attributes must name the same tabs; verify-ui-next checks that). */
const STEAM_LOCKED_TABS = Object.freeze(["coop", "highlights", "beta"]);

/**
 * @param {string} tab
 * @returns {boolean} true when this tab is closed to the current visitor
 */
function isTabLocked(tab) {
  return !session?.steamID && STEAM_LOCKED_TABS.includes(tab);
}

/** "Co-op, Highlights and Beta", from the sidebar's own labels. */
/**
 * The note under a guest's "Sign in with Steam" button. Once their own runs
 * are loaded it says where those runs live (this browser only) and that
 * signing in backs them up, so a new browser or a wiped one gets them back;
 * before that it says what signing in unlocks.
 */
function guestNoteText() {
  if (HistoryStore.loadedFromFallback()) return "You were signed out. Sign in again to keep your runs syncing.";
  if (parsedRuns.length > 0 && !isDemoMode) return "Saved in this browser only. Sign in to back up your runs.";
  return `Optional. Unlocks ${steamLockedTabNames()}.`;
}

/** Rewrites the guest note after runs load or an import lands. */
function refreshGuestNote() {
  const $note = document.querySelector(".me-pill-guest-note");
  if ($note) $note.textContent = guestNoteText();
}

function steamLockedTabNames() {
  const names = STEAM_LOCKED_TABS.map((tab) => {
    const $label = document.querySelector(`.nav-row[data-tab="${tab}"] .nav-label`);
    // U+2011, a hyphen that does not break: "Co-" / "op" across two lines
    // is what the narrow sign-in card did with the plain one.
    return ($label?.textContent || tab).trim().replace(/-/g, "\u2011");
  });
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");
}

/**
 * Mirrors the sign-in state onto <html data-steam> ("in" | "out"), which is
 * what CSS locks the Steam-only tabs from, and onto their sidebar rows (the
 * class is what the new look's phone nav watches). The boot script in
 * index.html sets a first guess from storage before the first paint; this is
 * the truth. Call it whenever `session` is assigned.
 */
function syncSteamLock() {
  const isSignedOut = !session?.steamID;
  document.documentElement.setAttribute("data-steam", isSignedOut ? "out" : "in");
  document.querySelectorAll(".nav-row[data-steam-lock]").forEach(($row) => {
    $row.classList.toggle("is-locked", isSignedOut);
  });
}
syncSteamLock();
// Set during `/api/_session` rehydration. When localStorage still has a
// blob but the HttpOnly cookie is dead (common on Safari after ITP), API
// calls 401 or hang — surface a re-auth banner instead of a blank shell.
let sessionCookieVerified = false;
let sessionCookieMissing = false;
let parsedRuns = [];          // current normalized history runs (in memory)
// Live "you're currently in an STS2 game" snapshot. Populated by
// commitParsedRuns when an ingest discovers a save file with run shape
// but no explicit `win` field — that's how STS2 represents the
// in-progress save state on disk. Held as a single record (the
// chronologically newest in-progress one if multiple ever arrive)
// rather than a list because there is logically only one active run
// per save profile. Reset to null when entering demo mode, when the
// user signs out, or when the next ingest finds no in-progress run
// (because the player just finished or abandoned). Never persisted to
// IDB or the cloud — it represents *right now*, not history.
let currentRun = null;
let currentRunCollapsed = false;
try {
  currentRunCollapsed = localStorage.getItem("vault.web.currentRunCollapsed") === "1";
} catch { /* private mode */ }
let lastFeed   = [];          // last feed snapshot
let lastInbox  = [];          // last inbox snapshot
let lastOutbox = [];          // last outbox snapshot (invites we've sent)
let lastHighlights = [];      // last community highlights snapshot
let activeTab  = "overview";  // which tab panel is showing
// Detect whether we're embedded inside the macOS desktop app.
// The native WKWebView appends `?desktop=1` and (optionally) injects a
// `window.__VAULT_DESKTOP__ = true` flag via WKUserScript. Either signal
// flips us into "desktop host" mode where we hide marketing chrome
// (download CTAs, mobile-only rows, "open in app" pitches, footer links
// that would navigate the WebView away) and mark <html> with the
// `is-desktop-host` class so styles can adapt without runtime JS.
const IS_DESKTOP_HOST = (() => {
  try {
    if (typeof window !== "undefined" && window.__VAULT_DESKTOP__) return true;
    const qs = new URLSearchParams(window.location.search);
    return qs.get("desktop") === "1";
  } catch { return false; }
})();
if (IS_DESKTOP_HOST) {
  try { document.documentElement.classList.add("is-desktop-host"); } catch {}
}

// =========================================================================
// New UI ("next") — the Inked Codex redesign, see lib/ui/index.js.
// -------------------------------------------------------------------------
// The inline boot script in index.html decides the layout generation before
// first paint and tags <html data-ui>. This only reads that decision.
//
// The module graph is fetched ONLY for next, so the classic layout never
// downloads or parses it and cannot be broken by it.
//
// It is loaded with a promise, NOT a top-level `await`. Top-level await is
// a parse error in engines that predate it (Safari < 15, Chrome < 89), and
// a parse error takes the whole module down for every visitor — including
// classic ones who would never execute that line. It would also delay the
// early `window.SpireVault` stub below, which the macOS shell depends on.
//
// While the module is in flight, `UI` is null. Renders that need it call
// `deferUntilUIReady()` and re-run once it arrives; nothing paints the
// classic markup under the new stylesheet in the meantime.
//
// If the load fails, the visitor gets the classic layout for this page
// view only (`?ui=classic-once` is not persisted), so a network blip does
// not silently opt them out; the next visit tries the new UI again.
//
// Everything next-specific below is gated on `UI` being non-null.
// =========================================================================
const IS_UI_NEXT = (() => {
  try { return document.documentElement.dataset.ui === "next"; }
  catch { return false; }
})();
/** Tabs whose header is a Stage (the diorama). */
const STAGE_TABS = Object.freeze(["overview", "characters", "ascensions", "relics", "cards"]);
let UI = null;
/** Set for one page load after the new UI failed to load, so the retry
 *  below happens once per tab session, never in a loop. */
const UI_RETRY_KEY = "vault.web.ui.retry";
const uiReady = IS_UI_NEXT
  ? import("/lib/ui/index.js?v=22")
      .then((mod) => {
        mod.bootUI({
          stageTabs: STAGE_TABS,
          track: (name, params) => vaultGtagEvent(name, params),
        });
        UI = mod;
        // The Overview's Arrange mode borrows this file's data and toasts.
        mod.Overview.initOverview({
          context: () => overviewContext(Stats.summarize(parsedRuns)),
          body: () => document.getElementById("overview-body"),
          afterRender: (el) => mod.Motion.afterRender(el),
          rerender: () => renderActiveTab(),
          toast: (message) => toast(message),
          track: (name, params) => vaultGtagEvent(name, params),
        });
        try { sessionStorage.removeItem(UI_RETRY_KEY); } catch { /* private mode */ }
      })
      .catch((e) => {
        // A module fetch cut short poisons this page's module map: Safari
        // reloaded mid-load (pull to refresh straight after opening) failed
        // 3 times in 5 and dropped to classic. A fresh page load clears it,
        // so try once more before falling back.
        let retried = true;
        try {
          retried = sessionStorage.getItem(UI_RETRY_KEY) === "1";
          sessionStorage.setItem(UI_RETRY_KEY, "1");
        } catch { /* no session storage: fall back straight away */ }
        if (!retried) {
          console.warn("[Vault] new UI failed to load; reloading once", e);
          window.location.reload();
          return new Promise(() => {});
        }
        console.warn("[Vault] new UI failed to load; showing the classic layout for this visit", e);
        const url = new URL(window.location.href);
        url.searchParams.set("ui", "classic-once");
        window.location.replace(url.toString());
        // The page is navigating away; never let dependants resume.
        return new Promise(() => {});
      })
  : null;

/**
 * New UI only. True while lib/ui is still loading, in which case `rerender`
 * is queued to run when it arrives and the caller should return without
 * painting. Always false for the classic layout.
 */
function deferUntilUIReady(rerender) {
  if (!IS_UI_NEXT || UI) return false;
  uiReady.then(rerender);
  return true;
}

// =========================================================================
// Look switch: the new look or the classic layout
// -------------------------------------------------------------------------
// The new look is the default for everyone (DEFAULT_UI_* in index.html, since
// 2026-11-15). A person switches this device to the classic layout, or back,
// from the palette button beside the logo (or in the desktop apps' toolbar),
// the phone's More sheet, Settings, the Beta tab or the news post; a one-time
// notice (lib/ui/look-notice.js) points first-time visitors at the palette
// button. The choice is stored under the key the boot script reads before
// first paint, and the page reloads once, on the same tab, into that layout.
// =========================================================================
/** Must match the boot script in index.html. */
const STORAGE_UI_VARIANT = "vault.web.ui";
/** The news post that explains the new look; "What's new" links open it. */
const UI_BETA_NEWS_POST_ID = "015";
const UI_BETA_PITCH =
  "SpireVault's new look: every tab redrawn, a header that shows your climb, and themes that switch instantly. " +
  "Your runs, stats and co\u2011op are the same in both looks, and you can switch any time.";
const UI_BETA_ON_NOTE =
  "You're on the new look. If something looks off, tell me. " +
  "The classic look is one click away, and so is coming back.";
const UI_BETA_DEVICE_NOTE = "Only changes this device. The page reloads once.";
const UI_BETA_UNSUPPORTED = "This browser is too old for the new look. Update it and this switch will work.";
const UI_BETA_OVERLAY_NOTE = "The overlay window always uses the classic look. Switch from the main SpireVault window.";

/** The same capability gate the boot script applies: cascade layers + color-mix(). */
function canRunNextUI() {
  try {
    return typeof CSSLayerBlockRule !== "undefined" &&
      !!(window.CSS && CSS.supports && CSS.supports("color", "color-mix(in srgb, red, blue)"));
  } catch {
    return false;
  }
}

/** True in the pop-out overlay window, which always uses the classic layout
 *  (the boot script in index.html forces it). */
function isOverlayWindow() {
  try { return new URLSearchParams(window.location.search).get("overlay") === "1"; }
  catch { return false; }
}

/**
 * Switches this device between the classic layout ("classic") and the new
 * look ("next"), then reloads into it on the same tab, so the switch feels
 * like the page changing its clothes rather than going somewhere else.
 * @param {string} variant
 * @param {string} source  where the request came from, for analytics
 * @returns {boolean} false when the request cannot be honoured
 */
function setUiVariant(variant, source) {
  const want = String(variant || "").toLowerCase();
  if (want !== "next" && want !== "classic") return false;
  if (want === (IS_UI_NEXT ? "next" : "classic")) return true;
  if (want === "next" && !canRunNextUI()) {
    toast(UI_BETA_UNSUPPORTED);
    return false;
  }
  if (want === "next" && isOverlayWindow()) {
    // Reloading here would store the choice and still come back classic.
    toast(UI_BETA_OVERLAY_NOTE);
    return false;
  }
  try { vaultGtagEvent("ui_variant_set", { ui_variant: want, source: String(source || "unknown") }); } catch {}
  try { localStorage.setItem(STORAGE_UI_VARIANT, want); } catch { /* private mode: ?ui= below still applies */ }
  const url = new URL(window.location.href);
  url.searchParams.set("ui", want);
  if (want === "next" && url.pathname === "/overlay") url.pathname = "/";
  window.location.replace(url.toString());
  return true;
}

/** Settings card for people on the classic layout. (On the new look the
 *  Appearance card carries the way back.) */
function renderUiBetaSettingsCard() {
  if (IS_UI_NEXT) return "";
  const isCapable = canRunNextUI();
  return `
      <section class="settings-card" data-ui-beta-card>
        <header class="settings-card-head">
          <h3>New look</h3>
          <p class="settings-card-sub">${esc(UI_BETA_PITCH)}</p>
        </header>
        <div class="settings-action-row">
          <button class="btn-primary" type="button" data-action="ui-set" data-ui="next" data-source="settings"${isCapable ? "" : " disabled"}>
            <span>Switch to the new look</span>
          </button>
          <button class="btn-ghost" type="button" data-action="ui-open-news">
            <span>What's new</span>
          </button>
        </div>
        <p class="muted small">${esc(isCapable ? UI_BETA_DEVICE_NOTE : UI_BETA_UNSUPPORTED)}</p>
      </section>`;
}

/** Beta-tab card: opt in from classic, opt out from the new look. */
function renderUiBetaTabCard() {
  const isCapable = canRunNextUI();
  const action = IS_UI_NEXT
    ? `<button class="btn-ghost" type="button" data-action="ui-set" data-ui="classic" data-source="beta-tab">Switch to the classic look</button>`
    : `<button class="btn-primary" type="button" data-action="ui-set" data-ui="next" data-source="beta-tab"${isCapable ? "" : " disabled"}>Switch to the new look</button>`;
  const note = IS_UI_NEXT ? "" : `<p class="beta-hint">${esc(isCapable ? UI_BETA_DEVICE_NOTE : UI_BETA_UNSUPPORTED)}</p>`;
  return `
        <section class="beta-card" data-ui-beta-card style="grid-column: 1 / -1">
          <header class="beta-card-head">
            <h4>${IS_UI_NEXT ? "Look: new" : "Look: classic"}</h4>
            <p class="beta-card-sub">${esc(IS_UI_NEXT ? UI_BETA_ON_NOTE : UI_BETA_PITCH)}</p>
          </header>
          <div class="beta-launch">
            ${action}
            <button class="btn-ghost" type="button" data-action="ui-open-news">What's new</button>
          </div>
          ${note}
        </section>`;
}

/**
 * Keeps the new-look card at the top of the Beta tab. The tab's body is
 * owned and re-rendered by run-coach.js (a frozen surface we do not edit),
 * so the card is re-inserted whenever that render replaces the grid.
 */
function mountUiBetaTabCard() {
  const $body = document.getElementById("beta-body");
  if (!$body || $body.dataset.uiBetaMounted === "1") return;
  $body.dataset.uiBetaMounted = "1";
  const ensureCard = () => {
    if (!$body.querySelector(".beta-grid")) {
      // run-coach.js did not render (blocked or failed): the card still
      // needs somewhere to live.
      if ($body.childElementCount > 0) return;
      $body.innerHTML = `<div class="beta-grid"></div>`;
    }
    const $grid = $body.querySelector(".beta-grid");
    if ($grid.querySelector("[data-ui-beta-card]")) return;
    $grid.insertAdjacentHTML("afterbegin", renderUiBetaTabCard());
  };
  ensureCard();
  new MutationObserver(ensureCard).observe($body, { childList: true });
}

/**
 * Static switch buttons (the ones written into the news post) cannot know
 * which layout is showing. Disable the one that would be a no-op and say so.
 */
function syncUiSwitchButtons() {
  const current = IS_UI_NEXT ? "next" : "classic";
  const isCapable = canRunNextUI();
  document.querySelectorAll('[data-action="ui-set"][data-active-label]').forEach(($btn) => {
    const target = $btn.getAttribute("data-ui");
    if (target === current) {
      $btn.disabled = true;
      $btn.textContent = $btn.getAttribute("data-active-label") || $btn.textContent;
    } else if (target === "next" && !isCapable) {
      $btn.disabled = true;
      $btn.title = UI_BETA_UNSUPPORTED;
    }
  });
}

/**
 * The always-visible switches in the classic chrome (beside the logo, and the
 * last chip of the phone tab strip) ship `hidden` in index.html. Show them
 * only where one click would really land in the new look: not in the new
 * look itself, not in a browser too old for it, not in the overlay window.
 */
function revealChromeUiSwitches() {
  if (IS_UI_NEXT || !canRunNextUI() || isOverlayWindow()) return;
  document.querySelectorAll("[data-ui-chrome-switch]").forEach(($btn) => {
    $btn.hidden = false;
  });
  // The desktop apps hide this sidebar (and with it the switch beside the
  // logo) under their own native one, so the panel toolbars carry the switch.
  if (!document.documentElement.classList.contains("is-desktop-host")) return;
  document.querySelectorAll(".app-toolbar-right").forEach(($toolbar) => {
    if ($toolbar.querySelector("[data-ui-toolbar-switch]")) return;
    $toolbar.insertAdjacentHTML(
      "afterbegin",
      `<button class="btn-ghost btn-icon-text" type="button" data-action="ui-set" data-ui="next" data-source="desktop-toolbar" data-ui-toolbar-switch title="Switch to the new look">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.2 5.2 0 0 0 21 9.2C21 5.7 17 3 12 3z"/></svg>
        <span>New look</span>
      </button>`,
    );
  });
}

document.addEventListener("click", (event) => {
  const $target = event.target instanceof Element ? event.target : null;
  if (!$target) return;
  const $switch = $target.closest('[data-action="ui-set"]');
  if ($switch) {
    event.preventDefault();
    setUiVariant($switch.getAttribute("data-ui"), $switch.getAttribute("data-source") || "unknown");
    return;
  }
  if ($target.closest('[data-action="ui-open-news"]')) {
    event.preventDefault();
    switchTab("news");
    selectNewsPost(UI_BETA_NEWS_POST_ID, { updateHash: true });
  }
});
syncUiSwitchButtons();
revealChromeUiSwitches();

// =========================================================================
// Native host bridge — early stub
// -------------------------------------------------------------------------
// Define `window.SpireVault` *immediately* so the macOS desktop app can
// call `switchTab(...)` even while the rest of this 13k-line module is
// still parsing. Before this hoist, every sidebar click on a cold
// launch would race against a 4-second polling user-script in the
// WebView coordinator: if module parse took longer than the polling
// window — or if any line below threw before the SpireVault setup
// near the bottom of this file — the bridge stayed permanently
// unreachable and the user saw "only Overview works, every other tab
// does nothing." (See VaultApp/App/WebHostView.swift's retry loop.)
//
// The contract the desktop side relies on:
//   • `switchTab(tab)` returns truthy iff the call was either executed
//     immediately (full impl already loaded) OR queued for replay
//     (early stub).
//   • `startSignIn()` returns truthy iff the OpenID flow either started
//     or was queued.
//   • `onTabChange(cb)` registers a listener (via the existing
//     `spirevault:tab` CustomEvent) and returns an unsubscribe.
//   • `activeTab()` returns the currently-rendered tab string.
//
// The full implementation near the end of this file replaces these
// stubs and drains the buffered work. From the host's POV the call
// "always works"; the queueing is invisible.
// =========================================================================
const __VAULT_HOST_QUEUE = {
  tab: null,        // most recent host-requested tab; null if none
  signIn: false,    // a host-requested sign-in is queued
};
try {
  if (typeof window !== "undefined") {
    window.SpireVault = {
      version: 2,
      isDesktopHost: () => IS_DESKTOP_HOST,
      knownTabs: () => [],
      activeTab: () => "overview", // best-effort until full impl loads
      switchTab: (tab) => {
        const want = String(tab || "").toLowerCase();
        if (!want) return false;
        // Buffer the latest request; the full impl drains this on boot.
        __VAULT_HOST_QUEUE.tab = want;
        return true;
      },
      onTabChange: (cb) => {
        // Wire the real listener immediately — `spirevault:tab` events
        // can only fire after switchTab runs (which itself only happens
        // post-boot), so deferring this would be pointless complexity.
        if (typeof cb !== "function") return () => {};
        const handler = (ev) => { try { cb(ev?.detail?.tab); } catch {} };
        window.addEventListener("spirevault:tab", handler);
        return () => window.removeEventListener("spirevault:tab", handler);
      },
      ingestDesktopRuns: () => {
        // The desktop's `pendingRunsJSON` cache holds the host-side
        // payload until ready, so we don't need to buffer here.
        return false;
      },
      startSignIn: () => {
        __VAULT_HOST_QUEUE.signIn = true;
        return true;
      },
      seedSession: () => false,
      __isStub: true,
    };
  }
} catch { /* non-browser env (test runner, SSR snapshot) */ }
let pollFeedTimer       = null;
let pollInboxTimer      = null;
let pollOutboxTimer     = null;
let pollHighlightsTimer = null;
let heartbeatTimer      = null;
let heartbeatWatchdog   = null;
let pushTimer           = null;

// Wall-clock timestamp of the last successful presence push. The watchdog
// uses this to detect "the setInterval fired but the request failed" or
// "the setInterval hasn't fired in a long time because the OS suspended us"
// and force a heartbeat without waiting for the next scheduled tick.
let lastSuccessfulHeartbeatAt = 0;
// True while a presence push is on the wire (see pushNow).
let presencePushInFlight = false;

// IDs of pending invites we've already announced to the user. Lets us tell
// "this invite just landed for the first time" from "we've been polling and
// it's been there for two minutes." We only fire the loud notification path
// once per id; subsequent polls leave the inbox banner alone.
const ANNOUNCED_INVITE_IDS = new Set();
// Brand is ONE word — "SpireVault", never "Spire Vault" (owner call,
// 2026-08-23). After boot the tab reads "<page> · SpireVault", the way
// a browser tab or window list names an app's page; the static <title>
// in index.html keeps the longer line for link previews and search.
const BASE_TAB_TITLE = "SpireVault";
/** What each tab is called in the browser tab, matching the sidebar. */
const TAB_TITLES = {
  overview: "Overview",
  characters: "Characters",
  ascensions: "Ascensions",
  relics: "Top Relics",
  cards: "Cards",
  runs: "Recent Runs",
  coop: "Co-op",
  highlights: "Highlights",
  news: "News",
  beta: "Beta",
};
let HAS_PROMPTED_NOTIFICATION = false; // ask permission lazily, once

// 401 tolerance. A single 401 used to vaporize the user's session and reload
// the page, which meant any transient blip on the backend (KV consistency
// window, momentary worker error, network corruption) silently signed users
// out. Now we count consecutive 401s from authenticated requests and only
// give up when we've seen 8 in a row inside a wide window — high enough
// that real users with intermittent connectivity, browsers throttling
// background tabs, or a Cloudflare colo blip won't get evicted. The
// previous 3-in-5-minutes threshold was producing measurable phantom
// logouts in production logs (ingest-runs-uploaded for users who had
// "no session" 30 seconds later). Real "your token is dead" events
// trigger the cookie-clear path on the server side and force a clean
// reload anyway, so the client fail-counter is now defense in depth.
const AUTH_FAIL_THRESHOLD = 8;
const AUTH_FAIL_WINDOW_MS = 30 * 60_000; // 30 min window
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
  // Reload into guest mode (no session) — user keeps seeing their stats,
  // they just lose the co-op tab privileges. Much less jarring than the
  // old hero-wall reload.
  window.location.replace("/");
}

// True only while the parsed runs in memory came from `getDemoRuns()` —
// flips to false the moment a real history.json is ingested. Renderers
// read this flag to overlay the "Sample data" banner.
let isDemoMode = false;

// ─── Boot ──────────────────────────────────────────────────────────────
//
// Single boot path now. The signed-out wall is gone — every visitor lands
// on the full app shell with stats already populated (their cached
// history.json if they've been here before, or curated demo data
// otherwise). Steam sign-in is reserved for the Co-op tab as the only
// auth-gated feature.
//
// Why: the single biggest conversion cost was forcing strangers to grant
// Steam OAuth before they could see what the tool even does. With demo
// data on the landing, value is visible in <1 second and Steam becomes
// an opt-in once they've decided they like the tool.
//
// Cookie rehydration runs BEFORE boot() so that an ITP-wiped localStorage
// doesn't briefly flash the guest UI before swapping to signed-in.
//
// CRITICAL: we ALWAYS attempt cookie rehydration, even when localStorage
// already has a session blob. Reason: localStorage can have a stale token
// (worker session: KV row expired, was revoked, the user switched Steam
// IDs in another tab, etc.) while the cookie has a fresh one. Trusting
// localStorage blindly led to "every API call 401s, 3 fails later you're
// logged out, repeat forever" — that's the production bug users keep
// hitting that looks like "I keep having to sign in".
//
// Resolution priority:
//   1. Cookie says auth'd + matches localStorage Steam ID → use localStorage
//      (preserves the real bearer in `sessionToken` for legacy direct-worker
//      callers).
//   2. Cookie says auth'd + DIFFERENT Steam ID → cookie wins, replace
//      localStorage (account switch in another tab).
//   3. Cookie says auth'd + localStorage empty → cookie hydrates from scratch.
//   4. Cookie says transient (503) → keep whatever localStorage has, retry
//      on next page load. This is the case our resilience fix unblocked.
//   5. No cookie (401 no_cookie) + localStorage holds a real bearer → POST
//      it back to /api/_session to set the cookie again: keep the session
//      on 200, wipe it on 401 invalid_session, keep it if unreachable.
//   6. Cookie says expired (401 expired) → wipe localStorage (token
//      genuinely dead). Same for no cookie + a cookie-only session.
//   7. No cookie + no localStorage → guest.
let bootShellCommitted = false;

/** First paint in under 100ms on localhost — never wait for /api/_session or IDB. */
function bootShellFirstPaint() {
  if (bootShellCommitted) return;
  bootShellCommitted = true;
  vaultDevBootStep("shell");
  try {
    const $publicTopbar = document.getElementById("topbar-public");
    const $publicMain = document.getElementById("main-public");
    if ($publicTopbar) $publicTopbar.hidden = true;
    if ($publicMain) $publicMain.hidden = true;
    const $shell = document.getElementById("app-shell");
    if ($shell) $shell.hidden = false;

    if (!session) {
      setGuestStatus();
    } else if (isLocalDevHost()) {
      setStatus("online", "Ready (local)");
    }

    // A ?tab= deep link wins (switching looks reloads with it), so this early
    // paint does not wipe it from the URL before boot reads it.
    let tab = "overview";
    try {
      const known = new Set(KNOWN_TABS);
      const linked = new URLSearchParams(window.location.search).get("tab");
      const last = localStorage.getItem(STORAGE_LAST_TAB);
      if (linked && known.has(linked)) tab = linked;
      else if (session && last && known.has(last)) tab = last;
    } catch { /* private mode */ }
    switchTab(tab);
    paintInitialTabShell();
  } catch (e) {
    console.error("[Vault] bootShellFirstPaint failed", e);
  }
}

/** How long the boot waits for a cookie restore before keeping the
 *  session as it is and trying again on the next visit. */
const SESSION_RESTORE_TIMEOUT_MS = 2800;

/**
 * @param {object | null} s a session record
 * @returns {boolean} true when it holds the worker bearer itself, not the
 *   `__cookie__` stand-in a cookie-only session carries
 */
function holdsRealBearer(s) {
  const token = s?.sessionToken;
  return typeof token === "string" && token !== "__cookie__" && /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

/**
 * @param {Response} r an error response from /api/_session
 * @returns {Promise<string>} its `error` code ("no_cookie", "expired", ...), or "" when the body has none
 */
async function sessionErrorCode(r) {
  try {
    const j = await r.json();
    return typeof j?.error === "string" ? j.error : "";
  } catch {
    return "";
  }
}

/**
 * Makes a profile from /api/_session the signed-in session. Same Steam ID
 * and a real bearer here: keep the bearer and refresh name and avatar.
 * Otherwise (a new browser, or another account signed in elsewhere) the
 * cookie's account wins and the session runs on the cookie.
 *
 * @param {object | null} j the profile JSON
 * @returns {boolean} false when it is not a usable profile
 */
function adoptSessionProfile(j) {
  const sid = j?.steamID || "";
  const sidOk =
    /^\d{17}$/.test(sid) ||
    (isLocalDevHost() && /^local-[a-z0-9_-]+$/i.test(sid));
  if (!j || !sidOk) return false;
  const sameSteam = !!session && session.steamID === j.steamID;
  if (sameSteam && holdsRealBearer(session)) {
    session = {
      ...session,
      personaName: j.personaName || session.personaName,
      avatarURL: j.avatarURL || session.avatarURL,
      viaCookie: true,
    };
  } else {
    session = {
      steamID: j.steamID,
      personaName: j.personaName || "Steam User",
      avatarURL: j.avatarURL || undefined,
      sessionToken: "__cookie__",
      signedInAt: new Date().toISOString(),
      viaCookie: true,
    };
  }
  try {
    localStorage.setItem(STORAGE_SESSION, JSON.stringify(session));
  } catch { /* private mode */ }
  syncSteamLock();
  return true;
}

/**
 * The cookie is gone but this browser still holds the bearer: POST it to
 * /api/_session, which checks it with the worker and sets the cookie again.
 *
 * @param {string} token the stored bearer
 * @returns {Promise<"restored" | "invalid" | "unreachable">} "invalid" only
 *   when the worker says the bearer is dead; anything else keeps the session
 */
async function restoreSessionCookie(token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SESSION_RESTORE_TIMEOUT_MS);
  try {
    const r = await fetch("/api/_session", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: ctrl.signal,
    });
    if (r.ok) return adoptSessionProfile(await r.json()) ? "restored" : "unreachable";
    if (r.status === 401) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(t);
  }
}

async function rehydrateSessionFromCookie() {
  const hadLocalSession = !!session;
  const timeoutMs = isLocalDevHost() ? 500 : 2800;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch("/api/_session", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) {
      sessionCookieVerified = true;
      sessionCookieMissing = false;
      adoptSessionProfile(await r.json());
    } else if (r.status === 401) {
      // `no_cookie`: the cookie is gone (it aged out, or cookies were
      // cleared) but this browser may still hold the bearer itself; send
      // it back so the server sets the cookie again. The session is only
      // dropped when the server says the bearer is dead (`expired` from
      // the cookie check, `invalid_session` from the restore) or when
      // there is no bearer here to restore from (a cookie-only session,
      // whose stand-in token cannot work without the cookie).
      const code = await sessionErrorCode(r);
      const restore = code === "no_cookie" && holdsRealBearer(session)
        ? await restoreSessionCookie(session.sessionToken)
        : "none";
      if (restore === "restored") {
        sessionCookieVerified = true;
        sessionCookieMissing = false;
      } else if (restore === "unreachable") {
        console.info("[Vault] session cookie restore unreachable, retaining local session");
        sessionCookieMissing = true;
      } else {
        session = null;
        syncSteamLock();
        sessionCookieVerified = false;
        sessionCookieMissing = false;
        try { localStorage.removeItem(STORAGE_SESSION); } catch {}
        if (isLocalDevHost()) {
          try {
            bootShellCommitted = false;
            bootShellFirstPaint();
          } catch { /* ignore */ }
        }
      }
    } else if (r.status === 503) {
      console.info("[Vault] /api/_session transient, retaining local session");
      if (hadLocalSession && session) sessionCookieMissing = true;
    } else if (hadLocalSession && session) {
      sessionCookieMissing = true;
    }
  } catch {
    if (session) sessionCookieMissing = true;
  }
  if (!session) {
    try { setGuestStatus(); } catch {}
  } else if (isLocalDevHost() && sessionCookieVerified) {
    try { setStatus("online", "Ready (local)"); } catch {}
  }
}

try {
  if (!session) setGuestStatus();
  else if (isLocalDevHost()) setStatus("online", "Ready (local)");
} catch { /* DOM not ready */ }

if (isLocalDevHost()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => bootShellFirstPaint(), { once: true });
  } else {
    queueMicrotask(() => bootShellFirstPaint());
  }
}

(async () => {
  if (isLocalDevHost()) {
    void rehydrateSessionFromCookie().then(() => {
      vaultDevBootStep("session");
      boot();
    });
    return;
  }
  await rehydrateSessionFromCookie();
  boot();
})();

// =========================================================================
// Sign-in click handler. Used by every "Sign in with Steam" CTA in the
// app shell (Co-op tab, signed-out hero block, full-screen in-app browser
// overlay, mobile bottom action). Single source of truth so the nonce
// generation + sessionStorage smoke-test stays in one place.
// =========================================================================
function startSteamSignIn() {
  // Beacon: user tapped a sign-in CTA. Paired with successful-callback
  // accounting on the backend, we can now tell "no one clicked sign-in"
  // apart from "people clicked sign-in but the redirect or callback
  // failed" — and on mobile specifically, from "people never saw the
  // button at all." That distinction is what would have surfaced the
  // mobile-missing-CTA bug before launch instead of during.
  sendBeacon("signin-cta-clicked", `w=${window.innerWidth} ua=${navigator.userAgent.slice(0, 80)}`);
  const nonce = randomNonce();
  sessionStorage.setItem("vault.auth.nonce", nonce);
  // Smoke test: write+read sessionStorage and beacon if it's broken.
  // In-app browsers (Reddit, FB, IG, etc) sometimes silently stub
  // sessionStorage to a no-op, so the user clicks "Sign in", we set
  // the nonce, and Steam's redirect arrives with no nonce in storage
  // → fail("nonce-missing"). If we can detect that BEFORE leaving the
  // page we can warn instead of round-tripping for nothing.
  const echo = sessionStorage.getItem("vault.auth.nonce");
  if (echo !== nonce) {
    maybeBeaconDiagnostic("storage-broken-pre-redirect", `ua=${navigator.userAgent}`);
    alert(
      "Your browser blocked sign-in storage. " +
      "Open SpireVault in Safari, Chrome, or Firefox " +
      "and try again from there."
    );
    return;
  }
  // Route Steam sign-in through the same-origin /api/* Pages proxy so
  // the worker that mints the session matches the worker that /me will
  // later validate against. In production both are the same prod
  // worker; in dev/preview the Pages function proxies to whichever
  // worker `WORKER_ORIGIN_OVERRIDE` points at (e.g. the preview
  // worker). Hitting SERVER_URL directly would always go to prod and
  // mint a token the preview worker doesn't know about → infinite
  // sign-in loop in the dev env.
  const u = new URL(`${window.location.origin}/api/auth/steam/start`);
  u.searchParams.set("return", RETURN_URL);
  u.searchParams.set("nonce", nonce);
  window.location.assign(u.toString());
}

// =========================================================================
// Desktop-host action bridge.
// -------------------------------------------------------------------------
// When the page is embedded in the macOS desktop app's WKWebView, the
// panel toolbar's data-ops buttons (Refresh / Import / Export menu) need
// to reach native macOS surfaces — NSOpenPanel for the save folder,
// NSSavePanel for exports, VaultCore for re-parsing. The browser
// equivalents (showDirectoryPicker / blob downloads) work in a real
// browser tab but can't reach STS2's privileged save folder from inside
// a WKWebView.
//
// We add a capture-phase document listener so we run *before* the normal
// bubble-phase handlers wired by `wireToolbar` etc. If the click landed
// on a target action and we're in desktop-host mode, we close the export
// menu (so the user gets the same visual feedback as the cloud), post
// the action to the native `vaultHost` bridge, and stopImmediatePropagation
// so the bubble handler doesn't also try to download a blob.
//
// This is what removes the duplicated native top-toolbar that v0.9.2
// painted above the WebView: the embedded toolbar IS the toolbar now,
// and every button it shows actually does the right thing on desktop.
// =========================================================================
function attachDesktopHostActionBridge() {
  if (!IS_DESKTOP_HOST) return;

  // Map data-action → native enum case (must match WebHostAction.rawValue
  // in VaultApp/App/WebHostView.swift exactly).
  const ACTION_MAP = {
    "reload-saves": "rescan",
    "upload":       "pickSaves",
    "export-csv":   "exportCSV",
    "export-json":  "exportJSON",
  };

  const postNativeAction = (action) => {
    try {
      window.webkit?.messageHandlers?.vaultHost?.postMessage({
        kind: "action", action: action,
      });
    } catch (e) {
      console.warn("[VaultHost] action bridge failed", action, e);
    }
  };

  // Re-label the "Import" toolbar button to "Link saves" in desktop
  // mode — its underlying behavior is now choosing the save folder
  // via NSOpenPanel, not picking individual files. Tooltip is updated
  // too so the affordance reads correctly to a hovering user. We also
  // relabel any companion-slot CTA copy on next render via the regular
  // template path; this just covers buttons already in the DOM at boot.
  document.querySelectorAll('[data-action="upload"]').forEach((btn) => {
    const labelEl = btn.querySelector("span:not(.btn-icon)") || btn;
    if (labelEl && /^(Import|Pick(\s|$))/i.test(labelEl.textContent || "")) {
      labelEl.textContent = "Link saves";
    }
    btn.setAttribute("title", "Choose your Slay the Spire 2 save folder");
  });

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    // Walk the data-action map and pick the first one that matches.
    // closest() returns null for non-matches so this is cheap even
    // for clicks far away from any action button.
    for (const [attrVal, nativeName] of Object.entries(ACTION_MAP)) {
      const hit = target.closest(`[data-action="${attrVal}"]`);
      if (!hit) continue;

      // Close the export dropdown if the click was inside one — same
      // behavior the bubble-phase handler would produce, just done
      // here so we don't leave an open menu after stopImmediate.
      const wrap = hit.closest("[data-export-wrap]");
      if (wrap) {
        const menu = wrap.querySelector(".app-toolbar-export-menu");
        const toggle = wrap.querySelector('[data-action="toggle-export"]');
        if (menu) menu.hidden = true;
        wrap.dataset.open = "false";
        toggle?.setAttribute("aria-expanded", "false");
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      postNativeAction(nativeName);
      return;
    }
  }, /* useCapture */ true);
}

/**
 * Look at navigator.userAgent for the most common in-app webviews known to
 * break Steam OpenID sign-in (sessionStorage stripped across redirect, or
 * the OAuth tab opens in a different process and can't see the token).
 *
 * Returns the friendly app name we should show in the warning banner, or
 * `null` for "this looks like a normal browser".
 *
 * Why a UA sniff is OK here: this is purely a UX hint. The auth flow still
 * works the same way regardless of what we display. False-positives just
 * tell a user "open in Safari" when they didn't have to; false-negatives
 * leave the user with the same broken-but-explained experience they had
 * before this banner existed.
 */
function detectInAppBrowser() {
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/redditapp|reddit-android|redditios/.test(ua)) return "Reddit";
  if (/twitter|twitterandroid/.test(ua)) return "X";
  if (/(fb_iab|fban|fbav|fbios)/.test(ua)) return "Facebook";
  if (/instagram/.test(ua)) return "Instagram";
  if (/threads/.test(ua)) return "Threads";
  if (/discord/.test(ua)) return "Discord";
  if (/snapchat/.test(ua)) return "Snapchat";
  if (/tiktok|musical_ly|bytedance/.test(ua)) return "TikTok";
  if (/linkedinapp/.test(ua)) return "LinkedIn";
  if (/line\//.test(ua)) return "LINE";
  if (/wv\)/.test(ua) && /android/.test(ua)) return "Android in-app";
  return null;
}

function detectInAppBrowserAndWarn() {
  const name = detectInAppBrowser();
  if (!name) return;
  // Fire-and-forget beacon so the operator dashboard sees the share of
  // mobile traffic that's hitting an in-app browser. This is the single
  // strongest signal for "you have lots of views but few sign-ups".
  maybeBeaconDiagnostic("inapp-browser-detected", `app=${name}`);

  // If the user has dismissed this overlay before in the current tab,
  // respect that — they might be browsing stats and not trying to sign in.
  if (sessionStorage.getItem("vault.inapp.dismissed") === "1") return;

  // Build a full-screen modal overlay. Stats are still browseable behind
  // it (the user can dismiss), but the sign-in path gets short-circuited
  // until they switch browsers. Much more visible than the old small
  // banner buried in the dead signed-out hero.
  const overlay = document.createElement("div");
  overlay.className = "inapp-overlay";
  overlay.innerHTML = `
    <div class="inapp-overlay-card" role="dialog" aria-modal="true" aria-labelledby="inapp-overlay-title">
      <h2 id="inapp-overlay-title">Heads up — you're in ${escapeHtml(name)}'s in-app browser</h2>
      <p>${escapeHtml(name)} opens links in a webview that <strong>blocks Steam sign-in storage</strong>. Your sign-in will silently fail without telling you why. This is a known issue across Reddit, X, Facebook, Instagram, Threads, Discord, Snapchat, TikTok, and LinkedIn.</p>
      <p>Tap the share or menu button in ${escapeHtml(name)} and choose <strong>Open in Safari</strong> (iOS) or <strong>Open in Chrome</strong> (Android). Stats in this tab work fine without sign-in — sign-in is only required for the co-op feed.</p>
      <div class="inapp-overlay-actions">
        <button class="btn-primary" type="button" data-action="copy-link">Copy link to open elsewhere</button>
        <button class="btn-ghost" type="button" data-action="dismiss-overlay">Continue browsing as guest</button>
      </div>
      <button class="inapp-overlay-dismiss" type="button" data-action="dismiss-overlay">Dismiss for this session</button>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('[data-action="copy-link"]').addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      const btn = overlay.querySelector('[data-action="copy-link"]');
      const orig = btn.textContent;
      btn.textContent = "Copied — paste in Safari/Chrome";
      setTimeout(() => (btn.textContent = orig), 2500);
    } catch {
      // No clipboard (rare in webviews) — show the URL for manual copy.
      const a = document.createElement("a");
      a.href = window.location.href;
      a.textContent = window.location.href;
      a.style.color = "#ffa05c";
      a.style.wordBreak = "break-all";
      overlay.querySelector("p:last-of-type").appendChild(document.createElement("br"));
      overlay.querySelector("p:last-of-type").appendChild(a);
    }
  });
  overlay.querySelectorAll('[data-action="dismiss-overlay"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      sessionStorage.setItem("vault.inapp.dismissed", "1");
      overlay.remove();
    });
  });
}

/**
 * One-shot beacon helper. Tries to send a tiny JSON event to the Worker's
 * `/auth/diag` endpoint without ever blocking the user. Idempotent across
 * a session — we don't want to spam the same event on every page load.
 */
function maybeBeaconDiagnostic(reason, detail) {
  try {
    const seenKey = "vault.diag.sent." + reason;
    if (sessionStorage.getItem(seenKey)) return;
    sessionStorage.setItem(seenKey, "1");
    sendBeacon(reason, detail);
  } catch { /* never let diagnostics break sign-in */ }
}

/**
 * Send a beacon event WITHOUT per-session dedupe. Use for events where we
 * want a count per occurrence (e.g. every file picker open, every ingest
 * commit), not just the first per session. Same backend endpoint, same
 * fire-and-forget guarantees.
 *
 * Why this matters: the bug that hid the wrong-save-path issue for weeks
 * was the lack of any signal between "user opened picker" and "user got
 * stats." These beacons are the signal — they let the admin dashboard
 * show ingest-funnel breakdown the same way it shows auth-funnel
 * breakdown today, so the next "everyone bouncing silently" gets
 * surfaced within a day instead of three weeks.
 */
function sendBeacon(reason, detail) {
  try {
    const payload = JSON.stringify({
      reason,
      detail: String(detail || "").slice(0, 280),
    });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(`${SERVER_URL}/auth/diag`, blob);
    } else {
      fetch(`${SERVER_URL}/auth/diag`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  } catch { /* never let beacons break user flow */ }
}

/**
 * Fire a Google Analytics 4 custom event through the gtag loader
 * defined in `index.html`. Safe to call before gtag has finished
 * loading — `gtag()` itself proxies through `dataLayer.push` until
 * the loader replaces the stub. Wrapped in try/catch + a stub-check
 * because GA must NEVER break the app: ad-blocked browsers, strict
 * tracking-protection settings (Brave / Firefox / Safari ITP) and
 * users with `Do Not Track` will sometimes have window.gtag missing
 * or replaced with a no-op shim.
 *
 * @param {string} name  GA4 event name (snake_case, ≤40 chars)
 * @param {object} [params]  Event parameters; values are coerced to
 *                           strings/numbers per the GA4 schema. PII
 *                           must NOT be included — we only ship
 *                           ids, counts, and short labels.
 */
function vaultGtagEvent(name, params) {
  try {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", String(name).slice(0, 40), params || {});
  } catch { /* analytics is best-effort, never user-facing */ }
}

/**
 * Community pulse — the "you're not climbing alone" line on the
 * Overview hero. Pulls anonymous aggregate counts (this week / all
 * time) from /api/stats/community, which the worker computes from its
 * existing daily-seen markers and caches for 10 minutes.
 *
 * Deliberately quiet failure: the element stays hidden unless we get
 * a believable number back. A dashboard that says "0 climbers" or
 * errors out would do the opposite of making the place feel alive.
 */
/**
 * The toolbar's community line is shown whole or not at all: where the row
 * is too narrow for all of it (the saves pill takes the room on a laptop),
 * cut to "3 climbe…" it read as broken. Re-checked whenever the row resizes.
 * @param {HTMLElement} $line
 */
function watchToolbarPulseFit($line) {
  const fit = () => {
    $line.classList.remove("is-clipped");
    $line.classList.toggle("is-clipped", $line.scrollWidth > $line.clientWidth + 1);
  };
  fit();
  if ($line.dataset.fitWatched || typeof ResizeObserver !== "function" || !$line.parentElement) return;
  $line.dataset.fitWatched = "1";
  new ResizeObserver(fit).observe($line.parentElement);
}

/**
 * The live count line, worded exactly as on spirevault.app (Site/script.js):
 * everyone who has signed in (the server's user records) and how many of the
 * co-op roster Steam shows in Slay the Spire 2 right now.
 * @param {number} total @param {number} inGame
 */
function communityCountLine(total, inGame) {
  if (inGame > 0) return `${total} signed up · ${inGame} currently in Slay the Spire 2`;
  return `${total} ${total === 1 ? "player" : "players"} signed up`;
}

/** How many on the co-op roster Steam shows in STS2 now (0 when unknown). */
async function fetchInGameNow() {
  try {
    const r = await fetch(`${API_BASE}/presence`, { headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) return 0;
    const roster = await r.json();
    return Array.isArray(roster) ? roster.filter((p) => p && p.inSTS2).length : 0;
  } catch {
    return 0;
  }
}

async function loadCommunityPulse() {
  const $pulse = document.getElementById("community-pulse");
  if (!$pulse) return;
  let pulse = null;
  try {
    const cached = sessionStorage.getItem("vault.web.community-pulse");
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Date.now() - (parsed.fetchedAt || 0) < 10 * 60_000) pulse = parsed.data;
    }
  } catch { /* ok */ }
  if (!pulse) {
    try {
      const r = await fetch(`${API_BASE}/stats/community`, { headers: { accept: "application/json" } });
      if (!r.ok) return;
      pulse = await r.json();
      try {
        sessionStorage.setItem(
          "vault.web.community-pulse",
          JSON.stringify({ fetchedAt: Date.now(), data: pulse })
        );
      } catch { /* ok */ }
    } catch {
      return;
    }
  }
  const total = Number(pulse?.totalClimbers) || 0;
  // Need at least a couple of climbers for the line to feel true and
  // warm rather than sad. Below that, stay hidden.
  if (total < 2) return;
  // Plain words, no trailing full stop (no other header line has one) and no
  // ⚔ glyph: Figtree has none, and the fallback drew a thin stray "x".
  // Same words and sources as spirevault.app's live line.
  const parts = [communityCountLine(total, await fetchInGameNow())];
  // The new look shows it in Overview's toolbar row, which keeps one height,
  // so the line arriving late moves nothing and Overview's stage stands as
  // high as the other tabs'. Classic keeps it under the subtitle.
  const $toolbarPulse = document.getElementById("toolbar-pulse");
  const $line = document.documentElement.dataset.ui === "next" && $toolbarPulse ? $toolbarPulse : $pulse;
  $line.textContent = parts.join(" · ");
  $line.hidden = false;
  if ($line === $toolbarPulse) watchToolbarPulseFit($line);
  // The line arrives after the header was laid out, and in classic it makes
  // the title block taller: lay the stage out again, or on a phone the
  // speech balloon ends up over the subtitle. (A stage only re-fits on its
  // own when its width changes.)
  if (UI) UI.Stage.fitStages();
}

async function refreshPublicCount() {
  const $text = document.getElementById("presence-text");
  if (!$text) return;
  try {
    const stats = await fetchCommunityStatsCached();
    if (!stats) throw new Error("no stats");
    const total = Number(stats.totalClimbers) || 0;
    $text.textContent = total === 0
      ? "Nobody signed up yet. Be the first."
      : communityCountLine(total, await fetchInGameNow());
  } catch {
    $text.textContent = "Community stats momentarily unavailable.";
  }
}

// =========================================================================
// Unified boot path — runs for both signed-in and guest visitors.
// Stats UI is universal; only the Co-op tab differs based on session.
// =========================================================================
async function boot() {
  vaultDevBootStep("boot");
  let markedConnecting = false;
  const finishBootGuards = () => {
    clearTimeout(bootWatchdog);
    clearConnectingIfStuck(markedConnecting);
    vaultDevBootStep("ready");
  };
  const bootWatchdog = setTimeout(() => {
    try {
      const $dot = document.getElementById("status-dot");
      if ($dot?.dataset.state !== "connecting") return;
      if (!session) {
        setGuestStatus();
        return;
      }
      if (!sessionCookieVerified) {
        session = null;
        syncSteamLock();
        try { localStorage.removeItem(STORAGE_SESSION); } catch {}
        setStatus("expired", "Sign in to continue");
        markSessionExpiredOnCard();
        return;
      }
      clearConnectingIfStuck(true);
    } catch {}
  }, 3000);
  try {
  // Always show the app shell. The signed-out hero is gone; the only thing
  // a visitor sees is the real product — pre-populated with demo data
  // until they drop their own history.json.
  const $publicTopbar = document.getElementById("topbar-public");
  const $publicMain = document.getElementById("main-public");
  if ($publicTopbar) $publicTopbar.hidden = true;
  if ($publicMain) $publicMain.hidden = true;
  document.getElementById("app-shell").hidden = false;

  // Detect in-app browsers EARLY so the full-screen warning can intercept
  // sign-in before the user gets to a broken Steam round-trip. Stats
  // browsing still works fine — only the auth flow is affected.
  detectInAppBrowserAndWarn();

  if (session) {
    // Header / footer of the sidebar — both desktop pill and the mobile
    // mirror need the persona, avatar, and Steam tier.
    document.getElementById("me-pill-name").textContent = session.personaName;
    const $mePillNameMobile = document.getElementById("me-pill-name-mobile");
    if ($mePillNameMobile) $mePillNameMobile.textContent = session.personaName;
    if (session.avatarURL) {
      document.getElementById("me-pill-avatar").src = session.avatarURL;
      const $meAvatar = document.getElementById("me-avatar");
      if ($meAvatar) $meAvatar.src = session.avatarURL;
      const $mobileAvatar = document.getElementById("me-pill-avatar-mobile");
      if ($mobileAvatar) $mobileAvatar.src = session.avatarURL;
      // Classic surface mirror — same avatar as the Beta sidebar
      // status card, painted into the legacy .me-card.
      const $classicAvatar = document.getElementById("classic-me-avatar");
      if ($classicAvatar) $classicAvatar.src = session.avatarURL;
    }
    const $mePersona = document.getElementById("me-persona");
    if ($mePersona) $mePersona.textContent = session.personaName;
    const $classicPersona = document.getElementById("classic-me-persona");
    if ($classicPersona) $classicPersona.textContent = session.personaName;
    const $meTier = document.getElementById("me-tier");
    const tierText = "Signed in with Steam · " + session.steamID.slice(0,4) + "…" + session.steamID.slice(-4);
    if ($meTier) $meTier.textContent = tierText;
    const $classicTier = document.getElementById("classic-me-tier");
    if ($classicTier) $classicTier.textContent = tierText;
    if (isLocalDevHost()) {
      setStatus("online", "Ready (local)");
    } else {
      setStatus("connecting", "Connecting…");
      markedConnecting = true;
    }
    // Paint the profile dock at boot so the user sees their status pill
    // immediately, before the first heartbeat round-trip lands.
    renderProfileDock();
    // Kick presence immediately — boot still has slow awaits (invite
    // catalog, IDB history) before the main heartbeat block; without this
    // the footer can sit on "Connecting…" for seconds or forever if IDB hangs.
    if (!isLocalDevHost() || sessionCookieVerified) schedulePush(0);
    if (sessionCookieMissing) showSessionExpiredBanner();
  } else {
    // Guest sidebar pill: invite to sign in instead of the persona block.
    const $mePill = document.getElementById("me-pill");
    if ($mePill) {
      $mePill.classList.add("me-pill-guest");
      // For a guest the card is only a holder for its own buttons: no
      // "Open profile menu" tooltip over Sign in, no menu semantics, and no
      // extra Tab stop that does nothing.
      $mePill.removeAttribute("title");
      ["aria-haspopup", "aria-expanded", "aria-controls"].forEach((name) => $mePill.removeAttribute(name));
      $mePill.tabIndex = -1;
      $mePill.setAttribute("role", "group");
      $mePill.setAttribute("aria-label", "Sign in");
      // Guests still need Settings (folder linking, import/export, prefs)
      // even without Steam — when we removed the standalone sidebar row
      // in v0.9 we replaced it with a footer Settings link inside the
      // me-pill profile popover, but that popover is gated on a Steam
      // session. So the guest pill exposes a tiny "Settings" link inline
      // alongside the sign-in CTA so save-data plumbing never gets
      // hidden behind auth.
      $mePill.innerHTML = `
        <button class="btn-primary me-pill-signin" type="button" data-action="signin-cta">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-9.96 9.04l5.35 2.21a2.83 2.83 0 0 1 1.6-.49l2.39-3.46v-.05a3.78 3.78 0 1 1 3.78 3.78h-.09l-3.4 2.43a2.84 2.84 0 0 1-5.62.6L2.3 14.5A10 10 0 1 0 12 2Zm-4.73 15.17-1.23-.51a2.13 2.13 0 1 0 1.17-2.9l1.27.52a1.57 1.57 0 1 1-1.2 2.9Zm10.04-7.72a2.52 2.52 0 1 0-2.52 2.52 2.52 2.52 0 0 0 2.52-2.52Zm-4.4 0a1.89 1.89 0 1 1 1.89 1.89 1.89 1.89 0 0 1-1.9-1.89Z"/></svg>
          <span>Sign in with Steam</span>
        </button>
        <p class="me-pill-guest-note">${esc(guestNoteText())}</p>
        <button class="me-pill-guest-settings" type="button" data-action="open-settings-guest" title="Open Settings">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          <span>Settings</span>
        </button>`;
    }
    const $mobileSign = document.getElementById("me-pill-name-mobile");
    if ($mobileSign) $mobileSign.textContent = "Guest";
    setGuestStatus();
  }

  // Mobile-only account-row action slot. The desktop sidebar footer has
  // plenty of room for distinct persona + status + sign-out elements;
  // the mobile strip only has one action slot, and it has to do the
  // right thing per session state:
  //   - Guest: show "Sign in with Steam" (hydrated by the document-
  //     level [data-action=signin-cta] handler wired below, so tapping
  //     it actually starts OpenID instead of silently failing)
  //   - Signed-in: show "Sign out" (handler wired inside the session
  //     branch further down)
  // This is THE mobile bug: previously the row always rendered a
  // "Sign out" button whose handler was session-gated, so a guest had
  // a visible but dead button AND no sign-in affordance on the default
  // (Overview) tab.
  const $mobileSignout = document.getElementById("signout-btn-mobile");
  const $mobileSignin  = document.getElementById("signin-btn-mobile");
  if (session) {
    if ($mobileSignout) $mobileSignout.hidden = false;
    if ($mobileSignin)  $mobileSignin.hidden  = true;
  } else {
    if ($mobileSignout) $mobileSignout.hidden = true;
    if ($mobileSignin)  $mobileSignin.hidden  = false;
  }
  // The same row carries the way to Settings on classic phones and tablets.
  mountClassicSettingsButton(!session);

  // Tab navigation — sidebar buttons + content panels.
  // Default tab is now "overview" so a fresh visitor lands on stats, not
  // co-op (which would force the auth wall they came here to avoid).
  document.querySelectorAll(".nav-row").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  // Keep the mobile tab strip's edge-fade affordance in sync with its
  // scroll position so the "back" tabs never look unreachable.
  setupNavStripEdges();
  // Paint the "NEW" pill on the News button before we route to the
  // user's last tab — that way even if they're going straight to
  // Recent Runs, they see the pill on the sidebar immediately.
  refreshNewsBadge();
  // (The sidebar game-data freshness badge that briefly rendered here was
  // removed by owner decision on 2026-08-23 — version strings don't belong
  // in consumer chrome. lib/game-sync.js remains the machine-checked source
  // of truth for the sync claim; the deploy guard still enforces it.)
  // Honor deep links from both query and path:
  //   - /?tab=<id>
  //   - /overlay
  // Restrict to known tabs so typos can't land on empty panels.
  let initialTab = null;
  try {
    const qsTab = new URLSearchParams(window.location.search).get("tab");
    const known = new Set(KNOWN_TABS);
    const path = (window.location.pathname || "/").replace(/\/+$/, "") || "/";
    if (path === "/coop-v2") {
      try {
        history.replaceState(null, "", "/coop" + (window.location.search || ""));
      } catch {}
    }
    const partyMatch = path.match(/^\/party\/([0-9a-f]{32})$/i);
    if (partyMatch) window.__VAULT_PARTY_ID = partyMatch[1];
    // A shared co-op link (/coop?branch=beta) carries the sharer's game
    // version, so the friend who opens it lands in the same line. Kept until
    // the Play card reads it (lib/coop-play.js, same key), which may be after
    // a Steam sign-in.
    if (path === "/coop") {
      const invitedBranch = new URLSearchParams(window.location.search).get("branch");
      if (invitedBranch === "stable" || invitedBranch === "beta") {
        try { localStorage.setItem("vault.coop.invite.v1", invitedBranch); } catch { /* storage blocked: Play opens on the saved version */ }
      }
    }
    if (path === "/overlay") initialTab = "overlay";
    else if (path === "/coop" || partyMatch) initialTab = "coop";
    else if (qsTab && known.has(qsTab)) initialTab = qsTab;
  } catch {}
  const lastTab = localStorage.getItem(STORAGE_LAST_TAB);
  // The macOS desktop app drives this page's tab via the SpireVault
  // bridge. If the user clicked a sidebar row *before* the page fully
  // booted (a real cold-launch scenario — module parse can take a beat
  // on slower Macs), the early SpireVault stub buffered that intent in
  // `__VAULT_HOST_QUEUE.tab`. Replay it here so their last click wins
  // over the host-supplied URL `?tab=` and localStorage's last-tab.
  // Without this read, the user clicks Characters during boot and the
  // page deterministically lands on Overview anyway.
  let hostQueuedTab = null;
  try {
    if (typeof __VAULT_HOST_QUEUE !== "undefined" &&
        __VAULT_HOST_QUEUE.tab &&
        new Set(KNOWN_TABS).has(__VAULT_HOST_QUEUE.tab)) {
      hostQueuedTab = __VAULT_HOST_QUEUE.tab;
      __VAULT_HOST_QUEUE.tab = null;
    }
  } catch {}
  // First-time visitors with no real session land on overview by default.
  // Returning signed-in users go back to whichever tab they last used.
  // Host queue > query-param > last-tab > default. The host queue
  // ranks highest because a fresh native sidebar click is more recent
  // intent than the URL the host opened the WebView with.
  switchTab(hostQueuedTab || initialTab || lastTab || (session ? "coop" : "overview"));
  // Never leave #app-content empty while slow boot awaits (IDB, cloud) run.
  paintInitialTabShell();

  // Wire the "notify me when this ships" forms inside news posts —
  // the markup is static and ships in index.html, but the click
  // handler needs the runtime serverURL + IS_DESKTOP_HOST flag, so
  // it lives here. Idempotent and cheap to call.
  try { wireNotifyForms(); } catch (e) { console.warn("notify wire failed", e); }
  // If the deep-link also carries a hash (e.g. `?tab=news#news-001`),
  // scroll to that anchor after the panel paints. Tiny rAF delay so the
  // tab-panel is actually visible when scrollIntoView fires.
  if (initialTab && window.location.hash) {
    requestAnimationFrame(() => {
      const target = document.querySelector(window.location.hash);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  // Deep-link to a specific run via `?run=<id>`. Cold-boot opens the
  // detail modal as soon as the in-memory parsedRuns set contains it.
  // Late ingest is also handled — see the openDeepLinkedRunIfPresent
  // call inside commitParsedRuns.
  try { openDeepLinkedRunIfPresent(); } catch (e) { console.warn("deeplink boot failed", e); }

  // Signed in: co-op Play and the sign-out buttons. Signed out, the Co-op
  // tab shows its Steam sign-in screen and nothing is wired.
  if (session) {
    // Co-op Play mounts at boot so someone waiting in line keeps their place
    // (and sees the "Looking" pill) whichever tab they reload on. A
    // /party/<id> link is handed to it as partyId.
    ensureCoopPlayMounted();
    // Reveal the desktop sidebar's "Sign out" button now that we've
    // confirmed there's an authenticated session. The HTML defaults
    // it to `hidden` so guests never see it (and never accidentally
    // tap the misleading dead button).
    const $signout = document.getElementById("signout-btn");
    if ($signout) {
      $signout.hidden = false;
      $signout.addEventListener("click", () => void signOut());
    }
    const $mobileSignout = document.getElementById("signout-btn-mobile");
    if ($mobileSignout) {
      $mobileSignout.addEventListener("click", () => void signOut());
    }
  }
  // Every "Sign in with Steam" CTA across the page funnels here. Event
  // delegation so dynamically-rendered guest CTAs all work.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="signin-cta"]');
    if (!btn) return;
    e.preventDefault();
    startSteamSignIn();
  });

  // Guest-mode "Settings" link inside the me-pill — see renderMePill
  // for the markup. Lives outside the popover (which is gated on a
  // Steam session) so first-time visitors who land in guest mode can
  // still link a save folder, import history, and toggle prefs.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="open-settings-guest"]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    switchTab("settings");
  });

  // Companion avatar — see renderCompanion() for details. Wired once
  // on boot; the actual render happens when Overview becomes active.
  wireCompanion();
  renderCompanion();

  // In desktop-host mode, intercept the per-panel toolbar buttons
  // (Refresh / Import / Export → CSV/JSON) and route them through the
  // `vaultHost` JS bridge to native AppState. Without this shim the
  // web's "Import" button would open a browser file picker that
  // can't recurse into the user's STS2 save folder, and "Export"
  // would dump a file to ~/Downloads with no overwrite confirmation.
  // With it, every visible toolbar button matches the cloud UI but
  // runs the macOS surface (NSOpenPanel / NSSavePanel / VaultCore
  // parser). The native top-toolbar that used to sit above this view
  // is gone — there's no duplicate row anymore.
  attachDesktopHostActionBridge();

  // Drag-drop history.json
  wireDropOverlay();
  applyPrefs();
  wireRunRowPreview();
  wireHighlightsControls();
  wireKeyboardShortcuts();
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
  // CRITICAL FIX (v93): the Import / Pick-saves buttons used to open a
  // flat <input type="file"> picker that can't recurse into folders.
  // STS2 stores `.run` files at `<saves>/steam/<steam-id>/profile1/saves/history/`
  // — five levels deep — so a flat picker forces the user to navigate
  // five clicks on their own and then shift-select dozens of files.
  // Most users gave up at the second click. We now route every "Import"
  // button through the same smart entry-point as "Find my STS2 saves":
  // showDirectoryPicker on Chromium (recursive walk, one click), with
  // graceful fallback to multi-file picker on Safari/Firefox.
  document.querySelectorAll('[data-action="upload"]').forEach((btn) => {
    btn.addEventListener("click", () => void scanForHistory());
  });
  document.querySelectorAll('[data-action="reload-saves"]').forEach((btn) => {
    btn.addEventListener("click", () => void reloadSavedHistoryInteractive());
  });
  // Disconnect lives inside the dynamically-rendered Linked pill so it
  // can't be wired by direct selector — delegate at the document level.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="disconnect-saves"]');
    if (!btn) return;
    e.preventDefault();
    void disconnectLinkedSaves();
  });
  // Export-all popover: each stats banner has its own `[data-export-wrap]`.
  // Delegate with closest() so the correct menu opens per toolbar instance.
  document.addEventListener("click", (e) => {
    const wrapHit = e.target.closest("[data-export-wrap]");
    const toggle = e.target.closest('[data-action="toggle-export"]');
    const exportJson = e.target.closest('[data-action="export-json"]');
    const exportCsv = e.target.closest('[data-action="export-csv"]');
    if (wrapHit) {
      const menu = wrapHit.querySelector(".app-toolbar-export-menu");
      if (toggle && menu) {
        e.preventDefault();
        if (menu.hidden) {
          document.querySelectorAll("[data-export-wrap]").forEach((w) => {
            if (w === wrapHit) return;
            const m = w.querySelector(".app-toolbar-export-menu");
            const t = w.querySelector('[data-action="toggle-export"]');
            if (m && !m.hidden) {
              m.hidden = true;
              w.dataset.open = "false";
              t?.setAttribute("aria-expanded", "false");
            }
          });
        }
        const open = menu.hidden;
        menu.hidden = !open;
        wrapHit.dataset.open = String(open);
        toggle.setAttribute("aria-expanded", String(open));
        return;
      }
      if (exportJson && menu) {
        exportAllRuns("json");
        menu.hidden = true;
        wrapHit.dataset.open = "false";
        wrapHit.querySelector('[data-action="toggle-export"]')?.setAttribute("aria-expanded", "false");
        return;
      }
      if (exportCsv && menu) {
        exportAllRuns("csv");
        menu.hidden = true;
        wrapHit.dataset.open = "false";
        wrapHit.querySelector('[data-action="toggle-export"]')?.setAttribute("aria-expanded", "false");
        return;
      }
    }
    // Outside every export wrap — close all open menus (hidden tabs may
    // still carry stale [data-open="true"] from a prior interaction).
    document.querySelectorAll("[data-export-wrap]").forEach((wrap) => {
      const menu = wrap.querySelector(".app-toolbar-export-menu");
      if (!menu || menu.hidden) return;
      if (wrap.contains(e.target)) return;
      menu.hidden = true;
      wrap.dataset.open = "false";
      wrap.querySelector('[data-action="toggle-export"]')?.setAttribute("aria-expanded", "false");
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document.querySelectorAll("[data-export-wrap]").forEach((wrap) => {
      const menu = wrap.querySelector(".app-toolbar-export-menu");
      if (!menu || menu.hidden) return;
      menu.hidden = true;
      wrap.dataset.open = "false";
      wrap.querySelector('[data-action="toggle-export"]')?.setAttribute("aria-expanded", "false");
    });
  });
  document.getElementById("history-file-input").addEventListener("change", (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      void ingestHistoryFiles(files);
    }
    e.target.value = ""; // allow re-selecting same file
  });
  // Folder picker (webkitdirectory) — cross-browser way to scoop up
  // every `.run` file in the user's SlayTheSpire2 folder in ONE
  // click. The browser hands us a flat FileList of every nested file,
  // and our ingest filters to plausible extensions. This is the
  // SAFARI / FIREFOX path to a one-click import; Chromium uses
  // showDirectoryPicker (faster, supports persistent re-read) but
  // webkitdirectory works on Safari and Firefox where showDirectoryPicker
  // is unavailable. v94 made this the primary fallback because users
  // were stuck multi-selecting hundreds of `.run` files manually.
  const $folderInput = document.getElementById("history-folder-input");
  if ($folderInput) {
    $folderInput.addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        sendBeacon("ingest-folder-input-picked", `count=${files.length}`);
        // Remember the folder display name so the "Linked" pill paints.
        // Pull it from the first file's webkitRelativePath which has the
        // form `<folder-name>/<...>/file.run`.
        try {
          const rel = files[0]?.webkitRelativePath || "";
          const root = rel.split("/")[0] || "";
          if (root) rememberLinkedFolderName(root);
        } catch {}
        void ingestHistoryFiles(files);
      }
      e.target.value = "";
    });
  }

  // Share modal works for everyone (export single run image / markdown).
  wireShareModal();
  // Run-detail modal: click any row → full deck + relics + per-floor
  // pick history. Filter chips and search input on the Recent Runs
  // page are wired together so a chip click re-renders the run list
  // immediately while preserving caret position in the search box.
  wireRunDetailModal();
  wireRunFilters();
  wireStatFilters();
  wireCompareUI();

  // Load asset manifest in parallel with the message catalog. Both are
  // best-effort: failures degrade gracefully (no card art / no preset
  // notes) without blocking the rest of the boot sequence.
  void loadAssetManifest();

  const runBootSlowPath = async () => {
  vaultDevBootStep("slow");

  // Preset message catalog: turns an incoming invite's messageId into text
  // for the global invite banner (signed-in only).
  if (session) {
    try {
      await promiseWithTimeout(
        InviteAPI.loadMessageCatalog(API_BASE),
        5000,
        "loadMessageCatalog"
      );
    } catch (e) {
      console.warn("could not load invite messages", e);
    }
  }

  // Scope IndexedDB by Steam ID for signed-in users. This is what
  // prevents "shared browser → next signed-in user inherits previous
  // user's runs". Guests still use the legacy unscoped key. Must run
  // BEFORE the loadHistory() call below so the read picks the right
  // scope from the very first IDB roundtrip.
  HistoryStore.setActiveSteamID(session?.steamID || null);
  // Signed in: this account is now the device's owner. Signed out: if the
  // last account's sign-in lapsed, its runs still load (history-store.js).
  if (session?.steamID) {
    try { localStorage.setItem(STORAGE_HISTORY_OWNER, session.steamID); } catch { /* private mode */ }
  }
  HistoryStore.setFallbackSteamID(session?.steamID ? null : readHistoryOwner());

  // Restore the last-known cloud sync timestamp so the toolbar pill
  // can show "Synced N runs · 2m ago" the moment the page renders,
  // before any new fetch resolves.
  loadCloudSyncFromStorage();

  // Private/Incognito detection: surface a clear notice that
  // sign-in won't persist. Without this, users testing in private
  // windows kept asking "why does it keep logging me out?" when the
  // real answer was "private mode wipes cookies on close — that's
  // by design, not our bug". The detection runs storage-quota probes
  // because every browser fingerprints private differently.
  void detectPrivateMode().then((isPrivate) => {
    if (isPrivate) {
      showPrivateModeNotice();
      sendBeacon("private-mode-detected", `ua=${navigator.userAgent.slice(0, 80)}`);
    }
  });

  // Try to restore a previously uploaded history. We render whatever's in
  // IndexedDB FIRST so the UI lights up instantly with last-known stats,
  // then optionally re-pull from disk a few moments later if the user has
  // a saved file handle. If nothing's cached AND there's no linked save
  // folder, fall through to demo data so the dashboard isn't empty on
  // first visit. (We deliberately keep demo OFF when a folder is linked
  // even if cached IDB returned empty — the auto-reload below will fill
  // it in within a few hundred ms, and showing demo numbers in the
  // intermediate frame is the bug the screenshot caught.)
  let hasLinkedSaves = false;
  try {
    hasLinkedSaves = !!(await promiseWithTimeout(
      HistoryStore.loadDirectoryHandle(), 8000, "loadDirectoryHandle"
    )) || !!(await promiseWithTimeout(
      HistoryStore.loadHandle(), 8000, "loadHandle"
    ));
  } catch (e) {
    console.warn("loadDirectoryHandle/loadHandle failed at boot", e);
  }
  if (hasLinkedSaves) {
    try { localStorage.setItem(STORAGE_LINKED_LIVE, "1"); } catch { /* private mode */ }
  }

  // Decide what to render at first paint based on the four-way matrix
  // of (signed-in?) × (IDB has data?) × (folder linked?) × (cloud may
  // have data?). The single rule we enforce: signed-in users with no
  // local data must NEVER see demo data. They see a skeleton until
  // cloud download resolves; only after cloud returns empty do we
  // optionally fall back to demo. This is the "mobile shows dummy
  // data" bug class.
  let cached = null;
  try {
    cached = await promiseWithTimeout(HistoryStore.loadHistory(), 8000, "loadHistory");
  } catch (e) {
    console.warn("could not load cached history", e);
  }

  let needCloudHydrate = false;
  let bootRestoreAttempted = false;
  if (cached?.runs?.length) {
    parsedRuns = cached.runs.map(reviveRun);
    isDemoMode = false;
    void ensureDurableStorage();
    persistLocalBackup(parsedRuns.length);
    if (session?.steamID) needCloudHydrate = true;
  } else {
    let shouldTryRestore = hasLinkedSaves || !!session?.steamID;
    if (!shouldTryRestore) {
      try {
        const backup = JSON.parse(localStorage.getItem(STORAGE_LOCAL_BACKUP) || "null");
        shouldTryRestore = !!(backup?.count > 0);
      } catch { /* ok */ }
    }
    if (shouldTryRestore) {
      showBootSkeleton();
      bootRestoreAttempted = true;
      await bootRestoreFromDiskOrCloud(hasLinkedSaves, session);
      hideBootSkeleton();
    }
    if (parsedRuns.length > 0) {
      isDemoMode = false;
      if (session?.steamID) needCloudHydrate = true;
    } else if (session?.steamID) {
      parsedRuns = [];
      isDemoMode = false;
    } else if (hasLinkedSaves) {
      parsedRuns = [];
      isDemoMode = false;
    } else {
      try {
        const { getDemoRuns } = await import("./lib/demo-runs.js?v=2");
        parsedRuns = getDemoRuns();
        isDemoMode = true;
      } catch {
        parsedRuns = [];
        isDemoMode = false;
      }
    }
  }
  if (!session) {
    setGuestStatus();
    refreshGuestNote();
  }
  // Demo data and boot-from-cache never carry a live in-progress
  // record; only a fresh disk read can produce one. Make sure no
  // stale ghost from a prior session leaks through.
  currentRun = null;

  renderActiveTab();
  // Initial paint of the "new run" sidebar dot — silent if no runs
  // are loaded yet, lights up if the cached/cloud data already
  // includes runs the user hasn't seen since their last visit.
  refreshRunsBadge();

  // SpireVault Sync: pulls the Steam copy again by itself (tab shown, every
  // few minutes), and takes new runs from the browser extension when it is
  // installed (lib/sync-bridge.js).
  SyncBridge.start({
    getSteamId: () => session?.steamID || "",
    isSignedIn: () => Boolean(session?.steamID),
    runCount: () => (isDemoMode ? 0 : parsedRuns.length),
    ingest: (files) => ingestHistoryFiles(files, { silent: true, merge: true }),
    pullCloud: () => hydrateFromCloudIfAvailable(),
    toast,
    onChange: () => { renderSyncPill(); renderToolbarEmptyPill(); },
    isDesktopHost: IS_DESKTOP_HOST,
  });

  // Cross-device sync. Two paths feed this same call:
  //   - boot with a cached IDB record: union any cloud-only runs in
  //   - boot fresh-device-signed-in: pull the cloud copy verbatim
  // The merge logic in hydrateFromCloudIfAvailable handles both.
  //
  // CRITICAL DATA-SOURCE-PRIORITY RULE (per product spec):
  //
  //   1. Authenticated Steam user data from server (cloud)
  //   2. Local IDB cache of that same user's data
  //   3. Empty state (signed-in user with no uploaded history)
  //   4. Demo data — ONLY for signed-out marketing/preview mode
  //
  // Demo data MUST NOT override real data. Signed-in users with an
  // empty cloud get the empty state, not synthetic 73-run dashboards
  // that look like their stats. This was the regression that made
  // users say "the app keeps showing dummy data over my account".
  //
  // The previous code path here used to call
  // `fallbackToDemoIfStillEmpty()` for signed-in users with empty
  // cloud. That violated the rule above. Removed.
  if (needCloudHydrate) {
    void hydrateFromCloudIfAvailable()
      .then(async () => {
        hideBootSkeleton();
        if (parsedRuns.length > 0) persistLocalBackup(parsedRuns.length);
        if (parsedRuns.length === 0 && session?.steamID) {
          renderActiveTab();
        } else if (parsedRuns.length > 0) {
          renderActiveTab();
        }
      })
      .catch(async () => {
        hideBootSkeleton();
        if (parsedRuns.length === 0) renderActiveTab();
      });
  }

  // Probe linked folder permission so paused-permission banner shows
  // even when IDB already had runs (user shouldn't think they must re-import).
  if (hasLinkedSaves && !bootRestoreAttempted) {
    void autoReloadHistoryIfPermitted({ silent: true });
  } else if (hasLinkedSaves && parsedRuns.length === 0) {
    void autoReloadHistoryIfPermitted({ silent: true });
  }

  wireLastVisitTracking();

  // One silent disk read when we already have cached runs — picks up
  // anything STS2 wrote since last visit without waiting for the interval.
  if (hasLinkedSaves && parsedRuns.length > 0) {
    void autoReloadHistoryIfPermitted({ silent: true });
  }
  // Background loop: every 60s, silently re-scan the linked folder or
  // re-read history.json when STS2 writes new runs.
  startHistoryAutoRefresh();

  // Authenticated-only: push presence and start polling. Guests can see
  // the public roster (read-only) but don't write to it themselves —
  // that requires Steam verification.
  if (session) {
    schedulePush(0);
    pollFeedTimer   = setInterval(pullFeed,   POLL_FEED_MS);
    pollInboxTimer  = setInterval(pullInbox,  POLL_INBOX_MS);
    pollOutboxTimer = setInterval(pullOutbox, POLL_INBOX_MS);
    // The scheduled heartbeat and its watchdog rest while the tab is hidden,
    // like the feed and inbox polls: a tab nobody is looking at is not
    // activity, and the visibilitychange listener below sends one the moment
    // it comes back into view.
    const isTabHidden = () => document.visibilityState === "hidden";
    heartbeatTimer  = setInterval(() => {
      if (!isTabHidden()) pushNow(true);
    }, HEARTBEAT_MS);

    // Watchdog: forces a heartbeat if the primary scheduler stalled.
    heartbeatWatchdog = setInterval(() => {
      if (isTabHidden()) return;
      const since = Date.now() - lastSuccessfulHeartbeatAt;
      if (since > HEARTBEAT_MS * 1.5) {
        console.info(`heartbeat watchdog firing (${Math.round(since / 1000)}s since last success)`);
        pushNow(true);
      }
    }, 60_000);

    await bootPullInitial();
  }

  // Fetch the public community-highlights feed once on boot so the
  // tab paints instantly when the user clicks it. Auth optional —
  // guests get the same posts, just without `viewerReactions`.
  pullHighlights();
  // Start the background poll regardless of which tab is currently
  // active. The "new highlight" red dot in the sidebar fires from
  // refreshHighlightsBadge() inside pullHighlights(), so without
  // continuous polling a user sitting on Recent Runs would never
  // light the notification when a friend posts. Cost is one fetch
  // per HIGHLIGHTS_POLL_MS (30s) — trivial.
  startHighlightsPolling();
  // Now that we're polling continuously, also wire the news master/
  // detail UI so its rail is ready the moment a user clicks into
  // the News tab. Idempotent.
  wireNewsTabs();
  // Community pulse on the Overview hero — fire-and-forget, hidden on
  // any failure. Deferred a beat so it never competes with first paint.
  setTimeout(() => { void loadCommunityPulse(); }, 1200);
  // Wire the share-modal "Share to community" affordance even before
  // the modal is opened — keeps event listeners idempotent and the
  // boot sequence simpler.
  wireShareToCommunity();
  // One global Esc + outside-click dismisser for any open reaction
  // popover. Idempotent — repeat calls bail early via the
  // window-level `__hightlightsGlobalWired` flag.
  wireHighlightsGlobalDismissal();
  // Hover/focus tooltip preview for highlight relics + cards. Single
  // global element, delegated listeners — adding/removing cards as
  // the feed re-renders never requires new bindings.
  wireHighlightsTooltip();
  // Top-of-tab refresh button.
  const $hRefresh = document.getElementById("highlights-refresh");
  if ($hRefresh && !$hRefresh.dataset.wired) {
    $hRefresh.dataset.wired = "1";
    $hRefresh.addEventListener("click", () => {
      lastHighlights = [];
      const $feed = document.getElementById("highlights-feed");
      if ($feed) $feed.setAttribute("aria-busy", "true");
      pullHighlights();
    });
  }

  // When the tab regains focus after being hidden, force an immediate
  // refresh. For signed-in users that's a heartbeat + feed pull; for
  // guests it's just a stats reload from disk if a saved file handle
  // exists. Either way, returning from STS2 should snap stats fresh.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (session) {
      pushNow(true);
      pullFeed();
      pullInbox();
      pullOutbox();
    }
    if (activeTab === "highlights") pullHighlights();
    // Coming back from another window (almost certainly STS2): force a
    // full re-read by bypassing the fingerprint cache. The cache exists
    // to keep the background loop cheap, not to filter user-driven
    // refreshes — alt-tabbing back IS a "tell me what's new" signal.
    void autoReloadHistoryIfPermitted({ silent: true, bypassFingerprint: true });
  });

  // Phone-breakpoint re-render. Charts emit a different viewBox on
  // phone vs desktop (smaller w + bigger axis text) so we re-render
  // the active stats tab whenever the breakpoint flips. Also fires
  // when the user rotates a phone landscape→portrait. We deliberately
  // *only* react to the boundary crossing, not every resize, so the
  // chart doesn't redraw mid-drag on desktop window resize.
  try {
    const mq = window.matchMedia("(max-width: 720px)");
    const onMq = () => {
      if (TABS_WITH_DATA.includes(activeTab)) renderStatsTab(activeTab);
    };
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", onMq);
    else if (typeof mq.addListener === "function") mq.addListener(onMq);
  } catch { /* matchMedia not available — chart still works at one size */ }

  // bfcache restores (back/forward navigation) don't fire visibilitychange
  // on every browser. pageshow with persisted=true is the catch-all.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    if (session) {
      pushNow(true);
      pullFeed();
      pullInbox();
      pullOutbox();
    }
    // Same "fresh window, fresh read" reasoning as visibilitychange.
    void autoReloadHistoryIfPermitted({ silent: true, bypassFingerprint: true });
  });

  // Nothing is sent when the page goes away. Players stay on the roster
  // until they sign out, so there is nothing for the server to clean up;
  // the empty beacon this used to send to /presence only made the Worker
  // answer 500 once per page load.
  }; // end runBootSlowPath

  if (isLocalDevHost()) {
    const startSlow = () => {
      void runBootSlowPath()
        .catch((err) => {
          console.error("[Vault] boot slow path failed", err);
          if (session) setStatus("trouble", "Trouble starting\u00a0— try refreshing");
          try { paintInitialTabShell(); } catch {}
        })
        .finally(finishBootGuards);
    };
    // Let the shell paint, then load straight away. Waiting for an idle
    // moment (up to 2s on a busy dev machine) showed "Find my STS2 saves"
    // over runs that were already saved, which invited a needless re-pick.
    // The timeout covers a background tab, where frames never come.
    let slowStarted = false;
    const startOnce = () => {
      if (slowStarted) return;
      slowStarted = true;
      startSlow();
    };
    requestAnimationFrame(() => setTimeout(startOnce, 0));
    setTimeout(startOnce, 100);
    return;
  }

  try {
    await runBootSlowPath();
  } catch (err) {
    console.error("[Vault] boot failed", err);
    if (session) setStatus("trouble", "Trouble starting\u00a0— try refreshing");
    try { paintInitialTabShell(); } catch {}
  } finally {
    finishBootGuards();
  }
  } catch (err) {
    console.error("[Vault] boot failed", err);
    if (session) setStatus("trouble", "Trouble starting\u00a0— try refreshing");
    try { paintInitialTabShell(); } catch {}
    finishBootGuards();
  }
}


function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// =========================================================================
// Tabs
// =========================================================================
function syncTabUrl(tab) {
  try {
    const u = new URL(window.location.href);
    if (tab === "overlay") {
      u.pathname = "/overlay";
      u.searchParams.delete("tab");
      u.hash = "";
    } else {
      if (u.pathname === "/overlay") u.pathname = "/";
      if (tab === "overview") u.searchParams.delete("tab");
      else u.searchParams.set("tab", tab);
      if (tab !== "news") u.hash = "";
    }
    history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
  } catch {
    // URL sync is nice-to-have only; never block tab rendering on it.
  }
}

// D04b: the mobile nav is a horizontal scroll strip. A static right-only
// edge fade made tabs scrolled off the LEFT (e.g. "Overview" — the way
// "back") read as nonexistent; a beta tester landed on a right-side tab
// and felt "locked in without an option to go back." We mirror the real
// scroll state into data attributes so CSS fades exactly the edge(s) that
// still hide tabs — there's always a visible "more this way" affordance.
function updateNavStripEdges() {
  const strip = document.querySelector(".sidebar-nav");
  if (!strip) return;
  const overflowing = strip.scrollWidth > strip.clientWidth + 1;
  const max = strip.scrollWidth - strip.clientWidth;
  strip.dataset.edgeLeft = overflowing && strip.scrollLeft > 1 ? "1" : "0";
  strip.dataset.edgeRight = overflowing && strip.scrollLeft < max - 1 ? "1" : "0";
}
let __navEdgeRaf = 0;
function setupNavStripEdges() {
  const strip = document.querySelector(".sidebar-nav");
  if (!strip || strip.dataset.edgeWired === "1") return;
  strip.dataset.edgeWired = "1";
  const onScroll = () => {
    if (__navEdgeRaf) return;
    __navEdgeRaf = requestAnimationFrame(() => {
      __navEdgeRaf = 0;
      updateNavStripEdges();
    });
  };
  strip.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  updateNavStripEdges();
}

// Classic phones and tablets (≤880px) hide the sidebar footer, and with it the
// account card that opens Settings on desktop, so nothing on screen led there.
// A gear goes before Sign in / Sign out in the mobile account row instead.
// Built here, classic only, so the new look's row stays exactly as it is.
/** @param {boolean} isGuest  a guest's status line gives way on small phones (styles.css) */
function mountClassicSettingsButton(isGuest) {
  if (IS_UI_NEXT) return;
  const $row = document.querySelector(".mobile-account-row");
  const $slot = document.getElementById("mobile-account-action");
  if (!$row || !$slot || document.getElementById("mobile-settings-btn")) return;
  $slot.insertAdjacentHTML(
    "afterbegin",
    `<button class="mobile-settings-btn" id="mobile-settings-btn" type="button" aria-label="Settings"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg><span>Settings</span></button>`,
  );
  $row.classList.toggle("is-guest", isGuest);
  document.getElementById("mobile-settings-btn")?.addEventListener("click", () => switchTab("settings"));
  const $settings = document.querySelector('.tab-panel[data-tab="settings"]');
  markClassicSettingsButton($settings && !$settings.hidden ? "settings" : "");
}

/** Lights the gear while Settings shows, like the active tab chip. */
function markClassicSettingsButton(tab) {
  const $gear = document.getElementById("mobile-settings-btn");
  if (!$gear) return;
  const isHere = tab === "settings";
  $gear.classList.toggle("is-here", isHere);
  if (isHere) $gear.setAttribute("aria-current", "page");
  else $gear.removeAttribute("aria-current");
}

function switchTab(tab) {
  if (!tab) tab = "coop";
  // Overlay is hidden in production. Redirect any deep-link to overview.
  if (tab === "overlay" && !OVERLAY_NAV_VISIBLE) tab = "overview";
  // Force-hide every floating hover surface BEFORE we hide/show panels.
  // Production bug: a stuck highlights tooltip would bleed onto the
  // next tab because no pointerout fired when the anchor's parent
  // panel got `hidden`-toggled out from under it. These calls are
  // cheap idempotent no-ops when the surfaces are already hidden.
  try { forceHideHighlightsTooltip(); } catch {}
  try { forceHideRunRowPreview(); } catch {}
  try { closeAllReactionPopovers(); } catch {}
  // Leaving Recent Runs cancels Compare mode. Selection is in-memory
  // only and the dangling state would just confuse the user when
  // they came back later. The toggle is one click to re-enter.
  if (tab !== "runs" && compareMode) {
    try { setCompareMode(false); } catch {}
  }
  activeTab = tab;
  localStorage.setItem(STORAGE_LAST_TAB, tab);
  syncTabUrl(tab);
  updateTabTitle();
  // Notify any embedding host (the macOS WKWebView listens for this
  // via window.SpireVault.onTabChange) so its native sidebar can keep
  // its highlight in sync when the user clicks an in-page link.
  try {
    window.dispatchEvent(new CustomEvent("spirevault:tab", { detail: { tab } }));
  } catch {}
  // GA4 tab-aware page_view. We suppressed the auto-pageview in
  // index.html so the tab name lands as the page title in real-time.
  // page_location is set explicitly because gtag would otherwise
  // capture the URL at script-load time (before the user's last
  // tab was restored).
  vaultGtagEvent("page_view", {
    page_title: `Vault · ${tab}`,
    page_location: typeof window !== "undefined" ? window.location.href : "",
    page_path: `/?tab=${tab}`,
    tab,
    ui_variant: IS_UI_NEXT ? "next" : "classic",
  });
  document.querySelectorAll(".nav-row").forEach((b) => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle("is-active", isActive);
    if (isActive) {
      b.setAttribute("aria-current", "page");
      // D04: on the mobile horizontal nav strip the active tab could sit
      // off-screen (e.g. "Co-op" past the right edge with no affordance).
      // Scroll it into view, centered, scrolling only the strip — never
      // the page — and only when the strip actually overflows.
      const strip = b.closest(".sidebar-nav");
      if (strip && strip.scrollWidth > strip.clientWidth + 1) {
        const stripRect = strip.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        const delta = (bRect.left - stripRect.left) - (strip.clientWidth - bRect.width) / 2;
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        strip.scrollBy({ left: delta, behavior: reduce ? "auto" : "smooth" });
      }
    } else {
      b.removeAttribute("aria-current");
    }
  });
  // Settings has no rail row: it opens from the account card, so that card
  // carries the "you are here" mark while Settings is showing.
  document.getElementById("me-pill")?.classList.toggle("is-here", tab === "settings");
  // On a classic phone or tablet the account card is hidden; the gear in the
  // account row (mountClassicSettingsButton) carries the mark instead.
  markClassicSettingsButton(tab);
  // Refresh the edge-fade state after the active-tab auto-scroll settles.
  // The scroll listener covers smooth scrolling, but this catches the
  // no-overflow / instant cases too.
  try { updateNavStripEdges(); } catch {}
  document.querySelectorAll(".tab-panel").forEach((p) => {
    const visible = p.dataset.tab === tab;
    p.hidden = !visible;
    p.classList.remove("is-entering");
    if (visible) {
      // Trigger the entrance keyframe by re-adding the class on the
      // next frame so the browser actually sees a transition.
      requestAnimationFrame(() => p.classList.add("is-entering"));
    }
  });
  // Each stats tab has its own `.companion-slot` in the panel-head.
  // Invalidate the cached scene so this navigation gets a fresh
  // quote (and a new climber roll when Random is selected).
  const TABS_WITH_DIORAMA = new Set(["overview", "characters", "ascensions", "relics", "cards"]);
  if (TABS_WITH_DIORAMA.has(tab)) {
    companionScene = null;
    renderCompanion();
  }
  // Mark the latest news post as read once the user lands on the
  // News tab. Persists per-browser so the green "NEW" pill on the
  // sidebar doesn't keep nagging on every reload after they've
  // already scrolled the post.
  if (tab === "news") markLatestNewsRead();
  // Same idea for community highlights: opening the tab counts as
  // "seen" for every highlight currently in the feed. The sidebar
  // dot clears immediately and won't reappear until something
  // newer than what we just showed lands on the next poll.
  if (tab === "highlights") markHighlightsSeen();
  // Recent Runs: clear the unseen-dot AND opportunistically refresh
  // from disk. Two reasons we do this on tab entry rather than only
  // in the 60s background loop:
  //   1) The click on the nav row is an active *user gesture*, which
  //      is what `requestPermission()` needs to prompt for File
  //      System Access. The background loop runs without one and
  //      can only do silent refreshes.
  //   2) Users routinely come straight from STS2 to this tab to see
  //      the run they just finished. Waiting up to 60s for the next
  //      tick feels broken even though it's working as designed.
  // The promise is fire-and-forget — `commitParsedRuns` will rerender
  // the active tab if anything new lands.
  if (tab === "runs") {
    markRunsSeen();
    void autoReloadHistoryIfPermitted({
      silent: true,
      allowPermissionPrompt: true,
    });
  }
  // Co-op slim header carries the beta badge / Classic-switch link.
  // Repaint on every tab activation so a switch from Settings →
  // Co-op shows the most recent toggle state without waiting on a
  // separate re-render path. The discovery banner is painted from
  // the same hook so a user who hasn't visited Co-op yet sees it
  // the first time they land here after this deploy.
  //
  // Not while Co-op is locked (signed out): the panel shows its sign-in
  // screen, and booting the lobby runtimes under it made the daily-challenge
  // tile find the hidden lobby markup and fetch /coop/daily-challenge again
  // on every DOM change (each theme switch, for one).
  if (tab === "coop" && !isTabLocked("coop") && session) ensureCoopPlayMounted();
  // Idle polling and the "Looking 0:42" pill depend on which tab is showing.
  try { CoopPlay?.setCoopTabVisible(tab === "coop"); } catch { /* not mounted yet */ }
  // New UI: a tab entry arms the entrance animation for the render below.
  // Background refreshes re-render without arming, so nothing replays.
  if (UI) {
    UI.Motion.arm();
    UI.hideChartTip();
  }
  try { renderActiveTab(); } catch (e) {
    console.warn("renderActiveTab failed", e);
    try { paintInitialTabShell(); } catch {}
  }
}

/**
 * Latest news post id. Bump this string every time we publish a new
 * post (and the post HTML lands in `index.html`). The sidebar shows
 * a green "NEW" pill on the News tab whenever the user's stored
 * "last-read" id is older than this value, so a returning visitor
 * gets a clear signal that a fresh post is up there.
 *
 * Why a string and not a number: post ids are likely to grow into
 * dated slugs ("2026-05-12-windows-build") rather than monotonic
 * integers. Plain string-equality is what we need — "is the last
 * thing I read still the latest thing published?" — without forcing
 * a chronological compare that could go wrong on a typo.
 */
const LATEST_NEWS_POST_ID = "post-016-2026-11-19-arrange-your-overview";
const STORAGE_NEWS_LAST_READ = "vault.web.news.lastRead";

/** Show the "NEW" pill on the sidebar News button when the user
 *  hasn't yet visited the latest post. Called at boot and on every
 *  switchTab() pass through (cheap — single localStorage read). */
function refreshNewsBadge() {
  const $badge = document.getElementById("nav-news-count");
  if (!$badge) return;
  let lastRead = "";
  try { lastRead = localStorage.getItem(STORAGE_NEWS_LAST_READ) || ""; } catch {}
  const isUnread = lastRead !== LATEST_NEWS_POST_ID;
  $badge.hidden = !isUnread;
}

/** Persist that the user has seen the current latest post, so the
 *  pill stops appearing in this browser until a new post is published. */
function markLatestNewsRead() {
  try { localStorage.setItem(STORAGE_NEWS_LAST_READ, LATEST_NEWS_POST_ID); } catch {}
  const $badge = document.getElementById("nav-news-count");
  if ($badge) $badge.hidden = true;
}

// =========================================================================
// Companion avatar — overview-only
//
// A small, idle-animated character portrait between the title and the
// Import button. Click to open a picker popover with the five STS2
// playable characters. Selection persists to localStorage under
// vault.web.companion so it survives refreshes. Pure cosmetic — nothing
// about stats, co-op, or uploads depends on this value.
//
// The feature is deliberately low-blast-radius:
//   - Lives in one DOM node (#companion-slot) that's empty until we
//     render it, so a render failure can only hide the companion, not
//     break the Overview tab.
//   - Uses the same character assets already bundled for the Overview
//     and Characters cards, so no new asset pipeline.
//   - Picker is a lightweight popover (no modal), closes on outside
//     click; defeat-click on a picked option only updates this state,
//     never touches session / parsedRuns / presence.
// =========================================================================
/** Return the user's stored persona setting (one of COMPANIONS),
 *  defaulting to the random meta-option. The meta-option is a
 *  *setting*, not a character — when it's selected the actual avatar
 *  shown by the diorama is rolled per-render. */
function getCompanionSetting() {
  const stored = localStorage.getItem(STORAGE_COMPANION);
  return COMPANIONS.find((c) => c.id === stored) || COMPANIONS[0];
}

/** Resolve the setting into the *concrete* climber to render right
 *  now. If the user's setting is "Random", roll one of the five real
 *  characters. Otherwise return the picked one. Splitting this from
 *  setting-storage keeps the random roll deterministic-per-render
 *  rather than re-rolling on every observer. */
function rollClimberFor(setting) {
  if (setting.isRandom) {
    const real = randomClimberPool();
    return real[Math.floor(Math.random() * real.length)];
  }
  return setting;
}

/** Pick a random boss from the *colored* subset of the pool. Right
 *  now this is just the Architect — every other boss is shipped as
 *  a grayscale silhouette and the user explicitly said only show
 *  full-color art. As more colored boss art lands, flip their
 *  `colored: true` flag in BOSSES and they auto-join this pool. */
function rollBoss() {
  const pool = BOSSES.filter((b) => b.colored);
  if (pool.length === 0) return BOSSES[0];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Pick a quote for one of the two figures. Random side, then random
 *  line from the appropriate pool. Both pools filter `only:` tags
 *  against the active climber so a Defect-only line never comes out
 *  of an Ironclad's mouth (and an Architect Defect-taunt only fires
 *  when Defect is on the field facing the Architect). */
function rollQuote(climber, boss) {
  // Keep randomness but prevent same-side streaks. This gives a
  // true back-and-forth feel between climber and boss lines.
  const speakerIsClimber =
    lastQuoteSpeaker === "climber" ? false :
    lastQuoteSpeaker === "boss" ? true :
    Math.random() < 0.5;
  if (speakerIsClimber) {
    const pool = CLIMBER_LINES.filter((q) => !q.only || q.only === climber.id);
    const line = pool[Math.floor(Math.random() * pool.length)];
    lastQuoteSpeaker = "climber";
    return { who: "climber", text: line.text };
  }
  const pool = boss.lines.filter((q) => !q.only || q.only === climber.id);
  const line = pool[Math.floor(Math.random() * pool.length)];
  lastQuoteSpeaker = "boss";
  return { who: "boss", text: line.text };
}

/** The longest line either side can say with any of these climbers facing
 *  this boss. The new look's header reserves room for it, so a re-roll
 *  never changes its height. */
function longestQuoteFor(climbers, boss) {
  const ids = new Set(climbers.map((c) => c.id));
  const said = (q) => !q.only || ids.has(q.only);
  const pool = [...CLIMBER_LINES.filter(said), ...(boss.lines || []).filter(said)];
  return pool.reduce((longest, q) => (q.text.length > longest.length ? q.text : longest), "");
}

/** The climbers "Random" rolls from: every real character. */
function randomClimberPool() {
  return COMPANIONS.filter((c) => !c.isRandom);
}

function setCompanion(id) {
  if (!COMPANIONS.find((c) => c.id === id)) return;
  localStorage.setItem(STORAGE_COMPANION, id);
  // The user picked a different character — invalidate the cached
  // roll so the next render reflects the new setting (and re-rolls
  // the climber if they switched into Random).
  companionScene = null;
  lastQuoteSpeaker = null;
  renderCompanion();
}

/** Roll a fresh climber+boss+quote and stash it in companionScene.
 *  Called on first paint, after picker/bubble actions, and whenever
 *  switchTab() clears the cache entering a stats tab. */
function rollCompanionScene() {
  const setting = getCompanionSetting();
  const climber = rollClimberFor(setting);
  const boss    = rollBoss();
  const quote   = rollQuote(climber, boss);
  companionScene = { setting, climber, boss, quote };
  return companionScene;
}

// ---- Classic diorama: aim the speech balloon's tail at the speaker -------
// The balloon is centred over the speaker's grid column, but the tail sat
// a fixed 32px in from one end, so it pointed 40-60px off the head.

/** Where each classic sprite's head sits across its art, 0 (left edge) to
 *  1, as painted, before any mirroring. Read off characters/*-v2.webp and
 *  bosses/architect-crystal-v4.webp; a sprite not listed uses the middle. */
const CLASSIC_HEAD_SHARE = Object.freeze({
  ironclad: 0.48,
  silent: 0.47,
  defect: 0.54,
  regent: 0.42,
  necrobinder: 0.54,
  fool: 0.53,
  architect: 0.64,
});
/** Half the tail's outer triangle (its 11px side borders in styles.css). */
const CLASSIC_TAIL_HALF_PX = 11;
/** The tail stays on the balloon's straight bottom edge, clear of its 24px corners. */
const CLASSIC_TAIL_EDGE_PX = 18;
/** Re-aims tails when a header shows (hidden tabs measure 0) or resizes. */
let classicSceneWatcher = null;

/**
 * Head position across a classic sprite as drawn.
 * @param {string} id  character or boss id
 * @param {boolean} mirrored  true for climbers drawn with .scene-art-flip
 * @returns {string} 0-1, two decimals, for a data attribute
 */
function classicHeadShare(id, mirrored) {
  const share = Object.prototype.hasOwnProperty.call(CLASSIC_HEAD_SHARE, id) ? CLASSIC_HEAD_SHARE[id] : 0.5;
  return (mirrored ? 1 - share : share).toFixed(2);
}

/**
 * The drawn picture inside an object-fit: contain <img> (centred across),
 * in the image box's own coordinates. Before the file loads, the whole box.
 * @param {HTMLImageElement} img
 * @returns {{ left: number, width: number }}
 */
function containedArtSpan(img) {
  const boxW = img.clientWidth;
  const boxH = img.clientHeight;
  if (!img.naturalWidth || !img.naturalHeight || !boxW || !boxH) return { left: 0, width: boxW };
  const width = img.naturalWidth * Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
  return { left: (boxW - width) / 2, width };
}

/**
 * Left edge of `el` inside `ancestor` from layout offsets, so the bob and
 * pop animations (transforms) do not move the answer. Null if `ancestor`
 * is not on the offset chain.
 * @param {HTMLElement} el
 * @param {HTMLElement} ancestor
 * @returns {number | null}
 */
function offsetLeftWithin(el, ancestor) {
  let x = 0;
  let node = el;
  while (node && node !== ancestor) {
    x += node.offsetLeft;
    node = node.offsetParent;
  }
  return node === ancestor ? x : null;
}

/**
 * Sets --tail-x on one classic scene's balloon so its tail points at the
 * speaker's head, kept on the balloon's straight bottom edge.
 * @param {HTMLElement} scene
 */
function aimClassicBubbleTail(scene) {
  const bubble = scene.querySelector(".scene-bubble");
  if (!bubble || !bubble.clientWidth) return; // hidden tab: the watcher aims it once it shows
  const speakerSel = bubble.classList.contains("scene-bubble-boss") ? ".scene-figure-boss .scene-art" : ".scene-figure-climber .scene-art";
  const speaker = scene.querySelector(speakerSel);
  if (!(speaker instanceof HTMLImageElement)) return;
  if (!speaker.complete) speaker.addEventListener("load", () => aimClassicBubbleTail(scene), { once: true });
  const artLeft = offsetLeftWithin(speaker, scene);
  const bubbleLeft = offsetLeftWithin(bubble, scene);
  if (artLeft === null || bubbleLeft === null) return;
  const art = containedArtSpan(speaker);
  const share = Number(speaker.dataset.headX);
  const headX = artLeft + art.left + art.width * (share > 0 && share < 1 ? share : 0.5);
  const tailLeft = headX - (bubbleLeft + bubble.clientLeft) - CLASSIC_TAIL_HALF_PX;
  const maxLeft = bubble.clientWidth - CLASSIC_TAIL_EDGE_PX - 2 * CLASSIC_TAIL_HALF_PX;
  bubble.style.setProperty("--tail-x", `${Math.round(Math.min(Math.max(tailLeft, CLASSIC_TAIL_EDGE_PX), maxLeft))}px`);
}

/** Aims every classic balloon now and again whenever a header or balloon resizes. */
function aimClassicBubbleTails() {
  document.querySelectorAll(".companion-slot .scene").forEach((scene) => aimClassicBubbleTail(scene));
  if (typeof ResizeObserver !== "function") return;
  if (!classicSceneWatcher) {
    classicSceneWatcher = new ResizeObserver((entries) => {
      const scenes = new Set(entries.map((entry) => entry.target.closest(".companion-slot")?.querySelector(".scene")).filter(Boolean));
      scenes.forEach((scene) => aimClassicBubbleTail(scene));
    });
  }
  // Each render replaces the balloons; start over so removed ones are let go.
  classicSceneWatcher.disconnect();
  document.querySelectorAll(".companion-slot").forEach((slot) => {
    classicSceneWatcher.observe(slot);
    const bubble = slot.querySelector(".scene-bubble");
    if (bubble) classicSceneWatcher.observe(bubble);
  });
}

function renderCompanion() {
  const slots = document.querySelectorAll(".companion-slot");
  if (!slots.length) return;
  // New UI: the duel is drawn by lib/ui/stage.js with re-inked sprites, so
  // wait for that module instead of flashing the classic art first.
  if (deferUntilUIReady(renderCompanion)) return;

  // Use the cached scene if we have one; otherwise roll once. Cache is
  // cleared on tab changes (stats tabs), companion picker, and bubble tap.
  const scene = companionScene || rollCompanionScene();
  const { setting, climber, boss, quote } = scene;
  const climberSrc = characterImageSrc(climber.id) || "";
  const bossSrc    = bossImageSrc(boss.id) || "";
  const bossSrcset = bossImageSrcset(boss.id);
  const speakerIsClimber = quote.who === "climber";
  const bossColor = boss.color || "#6db6d9";
  const bubbleColor = speakerIsClimber ? climber.color : bossColor;

  // Build the diorama+picker markup once and write it into every
  // `.companion-slot` on the page. Multiple stats tabs each have
  // their own slot in the panel-head; they share one cached scene
  // until the user changes tabs (new roll) or uses the picker /
  // bubble.
  //
  // The picker is rendered into every slot (class-based selectors
  // only, no id) so clicking the climber on any tab opens that
  // tab's picker rather than trying to reach across to a hidden
  // panel's picker.
  const climberHint = `Change companion (currently ${climber.label})`;
  const climberAria = `Change companion. Current: ${climber.label}${setting.isRandom ? " (rolled randomly)" : ""}`;
  const sceneHtml = UI ? UI.Stage.duelHtml({
    climber: { id: climber.id, label: climber.label, fallbackSrc: climberSrc, ariaLabel: climberAria, hint: climberHint },
    boss: { id: boss.id, label: boss.label, fallbackSrc: bossSrc, fallbackSrcset: bossSrcset },
    quote,
    longestLine: longestQuoteFor(setting.isRandom ? randomClimberPool() : [climber], boss),
    climberPool: setting.isRandom ? randomClimberPool().map((c) => c.id) : undefined,
  }) : `
    <div class="scene scene-${speakerIsClimber ? "climber-speaks" : "boss-speaks"}"
         style="--scene-color:${climber.color};--scene-bubble-color:${bubbleColor};--scene-boss-color:${bossColor}">
      <button class="scene-figure scene-figure-climber" type="button"
              data-action="companion-toggle"
              aria-label="${esc(climberAria)}"
              title="${esc(climberHint)}">
        <span class="scene-shadow" aria-hidden="true"></span>
        ${climberSrc
          ? `<img class="scene-art${climber.facesLeft ? " scene-art-flip" : ""}" src="${esc(climberSrc)}" alt="${esc(climber.label)}" draggable="false" data-head-x="${classicHeadShare(climber.id, !!climber.facesLeft)}">`
          : `<span class="scene-glyph">${esc(climber.label[0])}</span>`}
      </button>

      <div class="scene-figure scene-figure-boss"
           aria-label="${esc(boss.label)}" title="${esc(boss.label)}">
        <span class="scene-shadow" aria-hidden="true"></span>
        ${bossSrc
          ? `<img class="scene-art scene-art-boss" src="${esc(bossSrc)}"${bossSrcset ? ` srcset="${esc(bossSrcset)}"` : ""} alt="${esc(boss.label)}" draggable="false" data-head-x="${classicHeadShare(boss.id, false)}">`
          : `<span class="scene-glyph">${esc(boss.label[0])}</span>`}
      </div>

      <button class="scene-bubble scene-bubble-${speakerIsClimber ? "climber" : "boss"}"
              type="button" data-action="scene-reroll"
              aria-label="New line. Tap for another."
              title="Tap for a new line">
        <span class="scene-bubble-text">${esc(glueLastTwoWords(quote.text))}</span>
        <span class="scene-bubble-tail" aria-hidden="true"></span>
      </button>
    </div>`;

  const pickerHtml = `
    <div class="companion-picker" hidden role="listbox" aria-label="Pick companion">
      ${COMPANIONS.map((opt) => {
        const inked = UI && !opt.isRandom ? UI.Stage.actorArt(opt.id) : null;
        const src = opt.isRandom ? "" : (inked ? inked.src : (characterImageSrc(opt.id) || ""));
        const isActive = opt.id === setting.id;
        const glyph = opt.isRandom
          ? `<span class="companion-option-glyph" aria-hidden="true">⚂</span>`
          : (src
              // Low priority: the picker is closed at boot, and these must
              // not hold up the header's painting. They still load (a
              // Random roll on the next tab stands one of them up).
              ? `<img src="${esc(src)}" alt="" draggable="false" fetchpriority="low">`
              : `<span class="companion-option-glyph">${esc(opt.label[0])}</span>`);
        return `
          <button class="companion-option${isActive ? " is-active" : ""}" type="button"
                  role="option" aria-selected="${isActive}"
                  data-action="companion-pick" data-companion-id="${esc(opt.id)}"
                  style="--companion-color:${opt.color}"
                  title="${esc(opt.label)}">
            ${glyph}
            <span class="companion-option-name">${esc(opt.label)}</span>
          </button>`;
      }).join("")}
    </div>`;

  // Re-rendering replaces the focused control (the speech bubble after a
  // re-roll, a picker option after a pick). Put focus back so a keyboard
  // user is not dropped to the top of the page.
  const $focused = document.activeElement instanceof Element ? document.activeElement : null;
  const $focusedSlot = $focused ? $focused.closest(".companion-slot") : null;
  const focusedAction = $focusedSlot ? ($focused.closest("[data-action]")?.getAttribute("data-action") || "") : "";

  slots.forEach((slot) => {
    slot.innerHTML = sceneHtml + pickerHtml;
  });
  // New UI: the scenery (spire, moon) is laid out around the climber's real
  // width, which lives on the duel; hand it up to each stage header.
  if (UI) UI.Stage.syncDuelGeometry();
  else aimClassicBubbleTails();

  if ($focusedSlot && focusedAction) {
    // The picker closes on render, so a picked option hands focus to the climber.
    const nextAction = focusedAction === "companion-pick" ? "companion-toggle" : focusedAction;
    const $again = $focusedSlot.querySelector(`[data-action="${cssEscape(nextAction)}"]`);
    if ($again) $again.focus({ preventScroll: true });
  }
}

function wireCompanion() {
  // Helper: every action below scopes itself to the *clicked* slot
  // because each stats tab now has its own `.companion-slot` with
  // its own picker. Reaching for the global picker by id would
  // either find the wrong one (id duplication) or open one inside
  // a hidden tab where it's invisible to the user.
  const slotOf = (el) => el && el.closest(".companion-slot");

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest('[data-action="companion-toggle"]');
    if (toggle) {
      e.preventDefault();
      const slot = slotOf(toggle);
      const $picker = slot && slot.querySelector(".companion-picker");
      if ($picker) $picker.hidden = !$picker.hidden;
      return;
    }
    const pick = e.target.closest('[data-action="companion-pick"]');
    if (pick) {
      e.preventDefault();
      setCompanion(pick.dataset.companionId);
      return;
    }
    // Tapping the bubble re-rolls the diorama state — invalidate
    // the cached scene so renderCompanion() generates a fresh
    // climber + boss + line. No localStorage write, no page refresh.
    // (If the user's setting is a fixed character, rollClimberFor
    //  returns that character every time, so only the line/boss
    //  change. If they're on Random, the climber rotates too.)
    const reroll = e.target.closest('[data-action="scene-reroll"]');
    if (reroll) {
      e.preventDefault();
      companionScene = null;
      renderCompanion();
      return;
    }
    // New look: the boss is a button too. Tapping him makes him say a
    // line. Same figures, only the line changes: rollQuote() alternates
    // speakers, so naming the climber as the last one gives the boss the
    // next line.
    const bossSpeak = e.target.closest('[data-action="boss-speak"]');
    if (bossSpeak) {
      e.preventDefault();
      if (companionScene) {
        lastQuoteSpeaker = "climber";
        companionScene = { ...companionScene, quote: rollQuote(companionScene.climber, companionScene.boss) };
      }
      renderCompanion();
      return;
    }
    // Outside click — close every open picker (cheap; there are at
    // most 5 in the DOM).
    if (!slotOf(e.target)) {
      document
        .querySelectorAll(".companion-picker:not([hidden])")
        .forEach(($p) => { $p.hidden = true; });
    }
  });
  // Esc closes any open picker without losing keyboard focus context.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    document
      .querySelectorAll(".companion-picker:not([hidden])")
      .forEach(($p) => { $p.hidden = true; });
  });
}

function renderActiveTab() {
  // Toolbar status pills, painted in priority order so the user
  // always sees the most useful signal:
  //   - linked-folder pill: a save folder is wired for auto-refresh
  //   - sync pill:          signed-in + cloud-synced run count + age
  //   - sample-data pill:   showing demo data, no real saves linked
  renderLinkedPill();
  renderSyncPill();
  renderToolbarEmptyPill();
  // A Steam-only tab shows its sign-in screen (CSS); render nothing under it.
  if (isTabLocked(activeTab)) return;
  if (TABS_WITH_DATA.includes(activeTab)) {
    renderStatsTab(activeTab);
  } else if (activeTab === "coop") {
    // Co-op Play renders itself from its own polls (lib/coop-play.js).
  } else if (activeTab === "highlights") {
    // Foreground polling is already running from boot — just paint
    // the cached feed now and force a fresh pull so the moment the
    // user opens this tab they see the absolute latest.
    renderHighlightsFeed(lastHighlights);
    pullHighlights();
  } else if (activeTab === "news") {
    // Defer to the news master/detail wiring — picks the active
    // post from the URL hash and paints the rail. Idempotent so
    // it's safe to call on every tab entry.
    try { wireNewsTabs(); } catch {}
  } else if (activeTab === "overlay") {
    renderOverlayTab();
  } else if (activeTab === "beta") {
    if (window.RunCoach?.renderBetaTab) window.RunCoach.renderBetaTab();
    mountUiBetaTabCard();
  } else if (activeTab === "settings") {
    renderSettingsTab();
  }
  // Highlights polling now runs continuously regardless of tab so
  // the sidebar's red "new highlights" notification badge fires for
  // every signed-in user the moment a new community post lands —
  // not just when they happen to be looking at the Highlights tab.
}

/** Paints the amber "Showing sample data — link your STS2 saves to see
 *  your runs" pill in the toolbar's left slot. Visible only when there
 *  is no linked folder AND we're showing demo data. The Linked pill
 *  takes precedence: if a save folder is wired up, this pill stays
 *  hidden so we don't flash both. */
function renderToolbarEmptyPill() {
  let dismissed = false;
  try { dismissed = localStorage.getItem("vault.web.demoBannerDismissed") === "1"; } catch {}
  document.querySelectorAll("[data-toolbar-empty]").forEach(($pill) => {
    const linked = !!getLinkedFolderName();
    const hasRealData = !isDemoMode && parsedRuns.length > 0;
    $pill.hidden = linked || !isDemoMode || hasRealData || dismissed;
  });
}

/** Linked-folder pill — quiet. Run count already lives in the crest /
 *  hero; repeating "434 runs · Saved on this device" next to the title
 *  was noise. Only surface when a folder is linked (and never the count). */
function renderLinkedPill() {
  const linkedName = getLinkedFolderName();
  const hasData = !isDemoMode && parsedRuns.length > 0;
  document.querySelectorAll("[data-linked-pill]").forEach((el) => {
    if (!hasData || !linkedName) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    // Permission-paused state is handled by the global auto-refresh
    // banner — this pill just confirms the folder link, quietly.
    if (autoRefreshState.phase === "paused-permission" || autoRefreshState.phase === "error") {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = true; // suppress by default — crest + hero own the numbers
    el.innerHTML = "";
  });
}

/** Cloud-sync bookkeeping: when the runs last went to (or came from) the
 *  player's Steam copy. Read by the runs status in the toolbar
 *  (renderSyncPill below). */
let lastCloudSyncAt = 0;
let lastCloudSyncCount = 0;

function recordCloudSync(count) {
  lastCloudSyncAt = Date.now();
  lastCloudSyncCount = count || 0;
  try { localStorage.setItem("vault.web.lastCloudSync",
    JSON.stringify({ at: lastCloudSyncAt, count: lastCloudSyncCount }));
  } catch {}
  renderSyncPill();
}

function loadCloudSyncFromStorage() {
  try {
    const raw = localStorage.getItem("vault.web.lastCloudSync");
    if (!raw) return;
    const j = JSON.parse(raw);
    if (Number.isFinite(j?.at)) lastCloudSyncAt = j.at;
    if (Number.isFinite(j?.count)) lastCloudSyncCount = j.count;
  } catch { /* ignore */ }
}

function relativeAgoLabel(ts) {
  if (!ts) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** A day without reading the saves turns the runs status amber. */
const RUNS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The save folder to point the picker at on this computer, or "". */
function savePathForPlatform() {
  const platform = detectPlatform();
  if (platform === "mac") return HISTORY_PATH_MAC;
  if (platform === "windows") return HISTORY_PATH_WIN;
  if (platform === "linux") return HISTORY_PATH_LINUX;
  return "";
}

/** When this browser last read the save folder (ms), or 0 if it never has. */
function savesLastReadAt() {
  try { return Number(localStorage.getItem(STORAGE_LAST_IMPORT_AT)) || 0; }
  catch { return 0; /* private mode */ }
}

/** Why the Cards tab has nothing to show, when the reason is known: the
 *  runs on screen came from the Steam copy and that copy holds no card
 *  picks for them. True of every copy written before 2026-11-18, until the
 *  browser that reads the save folder opens the app again and refills it.
 *  "" otherwise, and the view says its plain "no data yet". */
function cardPicksMissingNote() {
  if (isDemoMode || parsedRuns.length === 0 || parsedRuns.some(CloudWire.hasCardPicks)) return "";
  if (savesLastReadAt() || !lastCloudSyncAt) return "";
  return "Card picks for these runs haven't synced yet. "
    + "Open SpireVault once on the computer where you read your saves and they'll appear here.";
}

/** What the runs status says right now, or null when it should hide
 *  (sample data has its own pill). */
function runsStatus() {
  if (isDemoMode || parsedRuns.length === 0) return null;
  // SpireVault Sync is reading the save folder for this tab: say so.
  const synced = SyncBridge.runsStatus({ count: parsedRuns.length });
  if (synced) return synced;
  const readAt = savesLastReadAt();
  const newest = newestRunEndedAt();
  const newestLabel = newest
    ? `newest run ${new Date(newest).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "";
  if (autoRefreshState.phase === "ok" || autoRefreshState.phase === "running") {
    return { live: true, stale: false, main: "Live from your saves", sub: newestLabel };
  }
  if (readAt) {
    return {
      stale: Date.now() - readAt > RUNS_STALE_AFTER_MS,
      main: `Saves read ${relativeAgoLabel(readAt)}`,
      sub: newestLabel,
    };
  }
  if (lastCloudSyncAt) {
    return { stale: true, main: "From your Steam copy", sub: "not read from your saves here yet" };
  }
  return { stale: true, main: "Saves not read here yet", sub: newestLabel };
}

/** Runs status, in the toolbar's left slot on Overview (both looks): where
 *  the runs on screen came from and how old they are, so a stale page shows
 *  before anyone trusts its numbers. One quiet line and no button, because
 *  Refresh sits beside it. It replaced the v109 "Synced N runs" pill (removed
 *  as clutter) on 2026-11-15, after a player couldn't tell his runs were
 *  days old. Updated by renderActiveTab, recordCloudSync,
 *  publishAutoRefreshState and a 30 s timer. */
function renderSyncPill() {
  const slots = document.querySelectorAll("[data-sync-pill]");
  if (!slots.length) return;
  const status = runsStatus();
  if (!status) {
    slots.forEach((el) => { el.hidden = true; el.innerHTML = ""; });
    return;
  }
  const path = savePathForPlatform();
  const detail = status.sub ? ` · ${status.sub}` : "";
  const title = `${status.main}${detail}. Refresh reads your save folder again${path ? ` (${path})` : ""}.`;
  const html = `
      <span class="sync-pill-dot" aria-hidden="true"></span>
      <span class="sync-pill-text"><strong>${esc(status.main)}</strong>${status.sub ? `<span class="sync-pill-ago">&middot; ${esc(status.sub)}</span>` : ""}</span>`;
  slots.forEach((el) => {
    el.hidden = false;
    el.classList.toggle("is-live", Boolean(status.live));
    el.classList.toggle("is-stale", status.stale);
    el.title = title;
    if (el.innerHTML !== html) el.innerHTML = html;
  });
}

// Update the relative time string every 30s so "1m ago" doesn't
// stay stuck while the user is staring at the toolbar.
setInterval(() => {
  renderSyncPill();
}, 30_000);

/**
 * Best-effort Private/Incognito detection.
 *
 * Every browser fingerprints private mode slightly differently;
 * there is no single API. We use the storage-quota probe — in
 * private mode browsers cap origin storage to ~120MB or refuse to
 * report a quota at all. Combined with a localStorage write probe
 * (Safari throws SecurityError in private mode on some versions),
 * this catches Safari, Chrome, Firefox, and Edge private windows
 * with high accuracy and no false positives on regular profiles
 * that happen to be near quota.
 */
async function detectPrivateMode() {
  try {
    // Probe 1: localStorage write/read. In Safari Private (some
    // versions) the write throws QuotaExceededError immediately.
    const k = "__vault_private_probe__";
    try {
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
    } catch {
      return true;
    }
    // Probe 2: storage quota. Private mode tends to report tiny
    // (<200MB) quotas or refuses entirely.
    if (navigator.storage && typeof navigator.storage.estimate === "function") {
      const est = await navigator.storage.estimate();
      const quota = est?.quota || 0;
      // Normal browsers report >1GB quota on most origins; private
      // mode caps tightly. The 200MB threshold is conservative —
      // Chrome incognito reports ~120MB, Safari private ~100MB.
      if (quota > 0 && quota < 200 * 1024 * 1024) return true;
    }
    return false;
  } catch {
    return false;
  }
}

let privateModeNoticeShown = false;
function showPrivateModeNotice() {
  if (privateModeNoticeShown) return;
  privateModeNoticeShown = true;
  // Don't pester users who explicitly chose private mode — show
  // once per tab, dismissible. Sticks at the top of #app-content
  // above the global invite banner. We deliberately do NOT block
  // any features — private-mode sign-in still works, just won't
  // persist after the window closes.
  const $host = document.getElementById("app-content");
  if (!$host) return;
  const div = document.createElement("div");
  div.className = "private-mode-notice";
  div.setAttribute("role", "status");
  div.innerHTML = `
    <span class="private-mode-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    </span>
    <span class="private-mode-text">
      <strong>Private window detected.</strong>
      Steam sign-in won't persist after you close this window, and your linked save folder won't be remembered next visit. Open in a regular browser window for the full experience.
    </span>
    <button type="button" class="private-mode-close" aria-label="Dismiss">&times;</button>`;
  $host.insertBefore(div, $host.firstChild);
  div.querySelector(".private-mode-close").addEventListener("click", () => {
    div.remove();
  });
}

// =========================================================================
// Co-op form (your status card)
// =========================================================================

let coopPlayMounted = false;
/** What co-op Play is handed while only the sample runs are loaded. */
const COOP_NO_RUNS = Object.freeze([]);
/** Mount one-tap co-op Play (signed-in only). Idempotent. */
function ensureCoopPlayMounted() {
  if (coopPlayMounted || !session) return;
  const root = document.getElementById("coop-play-root");
  if (!root) return;
  coopPlayMounted = true;
  loadCoopPlay().then(() => {
    CoopPlay.mountCoopPlay(root, {
      api: API_BASE,
      session,
      toast: (msg) => { if (msg) toast(msg); },
      track: vaultGtagEvent,
      gotoCoop: () => switchTab("coop"),
      onChange: () => { try { updateCoopBadge(); } catch { /* badge is cosmetic */ } },
      onAuthFailure: () => {
        const giveUp = recordAuthFailureAndShouldGiveUp();
        if (giveUp) clearSessionAndReload();
      },
      partyId: window.__VAULT_PARTY_ID || null,
      // "Your co-op climbs" reads the player's own runs, never the sample set.
      runs: () => (isDemoMode ? COOP_NO_RUNS : parsedRuns),
      // Who Steam shows in STS2 right now, for the sign in the room's sky.
      roster: () => lastFeed,
      // The panel's Refresh and Import buttons are the app's own.
      refreshSaves: () => void reloadSavedHistoryInteractive(),
      importSaves: () => void scanForHistory(),
    });
    CoopPlay.setCoopTabVisible(activeTab === "coop");
  }).catch((err) => {
    coopPlayMounted = false;
    coopPlayLoading = null;
    console.warn("coop play failed to load", err);
  });
}

/**
 * What the presence heartbeat sends. The old co-op roster's status form is
 * gone, so the status is always "looking" (the Worker overrides it from the
 * Steam Web API while you are in STS2). Co-op state lives in the Play queue.
 */
function readMyForm() {
  return { status: "looking", discordHandle: undefined, stats: undefined };
}

function schedulePush(delay = 600) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow(false), delay);
}

const PUSH_TIMEOUT_MS = 8_000;

/** Race any promise against a timeout — used for IDB reads at boot so a
 *  hung IndexedDB open can't block the UI forever. */
function promiseWithTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fetchWithTimeout(url, init = {}, ms = PUSH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function clearConnectingIfStuck(wasConnecting) {
  const $dot = document.getElementById("status-dot");
  if ($dot?.dataset.state !== "connecting") return;
  if (!wasConnecting) {
    if (!session) setGuestStatus();
    return;
  }
  if (!session) {
    setGuestStatus();
    return;
  }
  if (!sessionCookieVerified) {
    setStatus("expired", "Sign in to continue");
    markSessionExpiredOnCard();
    return;
  }
  setStatus("trouble", ...STATUS_TROUBLE_REACHING);
}

/** Paint stats/co-op shells before IDB + cloud hydrate finish so
 *  #app-content is never an empty panel during boot. */
function paintInitialTabShell() {
  if (TABS_WITH_DATA.includes(activeTab)) {
    if (session?.steamID && parsedRuns.length === 0 && activeTab === "overview") {
      showBootSkeleton();
    } else if (parsedRuns.length === 0) {
      try { renderStatsTab(activeTab); } catch (e) { console.warn("early stats tab paint failed", e); }
    }
  }
}

async function bootPullInitial() {
  try {
    await promiseWithTimeout(
      Promise.all([pullFeed(), pullInbox(), pullOutbox()]),
      PUSH_TIMEOUT_MS,
      "bootPullInitial"
    );
  } catch (e) {
    console.warn("initial feed/inbox pull timed out or failed", e);
    setStatus("trouble", ...STATUS_TROUBLE_REACHING);
  }
}

let sessionExpiredBannerShown = false;
function showSessionExpiredBanner() {
  if (sessionExpiredBannerShown) return;
  sessionExpiredBannerShown = true;
  const $host = document.getElementById("app-content");
  if (!$host) return;
  const isLocalDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const personaSlug = (session?.personaName || "c3rooks")
    .replace(/[^\w-]+/g, "")
    .toLowerCase() || "c3rooks";
  const devLoginHref = isLocalDev
    ? `/api/_dev-login?as=${encodeURIComponent(personaSlug)}`
    : null;
  const div = document.createElement("div");
  div.className = "private-mode-notice session-expired-notice";
  div.setAttribute("role", "alert");
  div.innerHTML = `
    <span class="private-mode-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    </span>
    <span class="private-mode-text">
      <strong>Session expired — sign in again.</strong>
      Your browser lost the sign-in cookie; co-op and cloud sync won't work until you re-authenticate.
      ${devLoginHref
        ? `<a class="session-expired-link" href="${esc(devLoginHref)}">Dev sign-in</a>`
        : `<button type="button" class="session-expired-link" data-action="signin-cta">Sign in with Steam</button>`}
    </span>
    <button type="button" class="private-mode-close" aria-label="Dismiss">&times;</button>`;
  $host.insertBefore(div, $host.firstChild);
  div.querySelector(".private-mode-close")?.addEventListener("click", () => div.remove());
}

async function pushNow(silent) {
  if (!session?.steamID) return;
  const body = readMyForm();
  // Reflect the new status in the bottom profile dock immediately so
  // the user gets visible feedback that their status switch landed,
  // even before the server round-trip completes.
  renderProfileDock();
  refreshProfilePopoverIfOpen();
  // One page load asks for a push from several places inside a second (early
  // boot, the slow boot path, the tab coming into view) and every push sends
  // the same body, so one that is on the wire or landed moments ago answers
  // for all of them. Each extra one cost the Worker up to four KV writes out
  // of about 1,000 a day shared by every player.
  if (presencePushInFlight) return;
  if (Date.now() - lastSuccessfulHeartbeatAt < PRESENCE_PUSH_MIN_GAP_MS) return;
  presencePushInFlight = true;
  if (!silent) showPushingPill(true);
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/presence`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.sessionToken}`,
      },
      body: JSON.stringify({
        status: body.status,
        discordHandle: body.discordHandle,
      }),
    }, PUSH_TIMEOUT_MS);
    if (resp.status === 401) {
      sessionCookieMissing = true;
      showSessionExpiredBanner();
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
      setStatus("trouble", ...STATUS_TROUBLE_REACHING);
      return;
    }
    if (resp.ok) {
      resetAuthFailures();
      lastSuccessfulHeartbeatAt = Date.now();
    }
    if (resp.ok) setStatus("online", "Live on the feed");
    else setStatus("trouble", ...STATUS_TROUBLE_REACHING);
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    console.warn(timedOut ? "presence push timed out" : "presence push error", e);
    setStatus("trouble", ...STATUS_TROUBLE_REACHING);
  } finally {
    presencePushInFlight = false;
    if (!silent) setTimeout(() => showPushingPill(false), 400);
  }
}

async function pullFeed() {
  // Pause background polling while the tab is hidden — the
  // visibilitychange listener already triggers a fresh fetch the
  // moment the tab regains focus, so we don't need to keep hammering
  // /presence/roster while no one is looking. At 8 k signed-in users
  // and a 30 s cadence, gating on visibility drops roster traffic by
  // ~60 % during typical browsing.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  try {
    const list = await fetchFeed();
    lastFeed = list;
    updateCoopBadge();
    CoopPlay?.refreshRoster?.();
    const stamp = "Last updated " + new Date().toLocaleTimeString();
    const $lu = document.getElementById("last-updated");
    if ($lu) $lu.textContent = stamp;
    const $cLu = document.getElementById("classic-last-updated");
    if ($cLu) $cLu.textContent = stamp;
  } catch (e) {
    console.warn("feed fetch failed", e);
  }
}

async function pullInbox() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  try {
    const r = await InviteAPI.fetchInbox(API_BASE, session.sessionToken);
    if (!r.ok) return;
    const previousInbox = lastInbox;
    lastInbox = r.invites ?? [];
    // Always refresh the global banner — it's not coupled to the
    // Co-op tab. A user on Overview should see "X wants to play"
    // appear at the top of the page the moment the invite arrives.
    renderGlobalInviteBanner(
      lastInbox.filter((i) => i.status === "pending")
    );
    updateCoopBadge();
    updateTabTitle();
    announceNewInvites(previousInbox, lastInbox);
    renderProfileDock();
    // If the popover is open, refresh its contents in place so the
    // user sees new invites land or accepted ones flip without
    // having to close and re-open the panel.
    refreshProfilePopoverIfOpen();
  } catch (e) {
    console.warn("inbox fetch failed", e);
  }
}

async function pullOutbox() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  try {
    const r = await InviteAPI.fetchOutbox(API_BASE, session.sessionToken);
    if (!r.ok) return;
    lastOutbox = r.invites ?? [];
    refreshProfilePopoverIfOpen();
  } catch (e) {
    console.warn("outbox fetch failed", e);
  }
}

// =========================================================================
// Community highlights — feed, reactions, comments
// =========================================================================
//
// Polling cadence is conservative: 30s while the tab is foregrounded,
// nothing while backgrounded. Reactions and posts call pullHighlights()
// after a successful write so the feed never lags behind the user's
// own actions.
const HIGHLIGHTS_POLL_MS = 30_000;

/** Fetch the global feed. Auth is optional — guests see the same posts,
 *  just without the "you reacted" indicator. */
async function pullHighlights() {
  // Signed-out visitors cannot open Highlights: no feed, no badge, no fetch.
  if (isTabLocked("highlights")) return;
  try {
    const token = session?.sessionToken ?? null;
    const r = await HighlightsAPI.fetchFeed(API_BASE, token);
    if (!r.ok) return;
    lastHighlights = r.items ?? [];
    refreshHighlightsBadge();
    if (activeTab === "highlights") {
      renderHighlightsFeed(lastHighlights);
      // The user is *currently* looking at the feed, so clear the
      // sidebar's red dot the moment any new items finish loading
      // — no point flagging unread items the user is staring at.
      markHighlightsSeen();
    }
  } catch (e) {
    console.warn("highlights fetch failed", e);
  }
}

// -------------------------------------------------------------------------
// Hover-preview tooltip — community highlight relics & cards
//
// One global tooltip element (#h-tooltip) is positioned next to the
// hovered thumbnail. We deliberately use pointerenter/pointerleave on
// document body (delegated) so adding/removing cards in the feed
// doesn't require re-binding listeners.
//
// The tooltip pulls everything it needs from `data-tip-*` attributes
// the renderer sets directly on each thumbnail. The renderer is the
// only place that knows what each thumbnail represents — by
// communicating through data attributes the tooltip code stays a
// pure presentation layer.
//
// Touch devices: pointerenter fires on first tap, pointerleave on tap
// elsewhere. We also listen for `scroll` and `wheel` to dismiss on
// scroll because the tooltip's anchor would otherwise drift.
// Reduced-motion: no entrance animation; the CSS handles that.
// -------------------------------------------------------------------------
let hTooltipHideTimer = null;

// =========================================================================
// Recent Runs row hover preview
//
// On hover (and focus), pop a rich preview card next to a run row showing
// the most useful at-a-glance info: relic count, deck size, killed-by, top
// relics art strip. Lets the user triage 30+ runs without opening the
// modal. Uses the same positionTooltip() helper as the highlights tooltip
// so behavior is consistent.
// =========================================================================
// Module-level state mirrors the highlights-tooltip approach so we can
// force-hide from outside the closure on tab switch / re-render / blur.
let runPreviewAnchor = null;
let runPreviewHideTimer = null;

function forceHideRunRowPreview() {
  const $el = document.getElementById("run-row-preview");
  if ($el) $el.hidden = true;
  if (runPreviewHideTimer) {
    clearTimeout(runPreviewHideTimer);
    runPreviewHideTimer = null;
  }
  runPreviewAnchor = null;
}

/**
 * True when the element holds focus the browser would draw a focus ring for
 * (keyboard, not a tap or click). Browsers without `:focus-visible` throw on
 * the selector; there, any focus counts, which is how this behaved before.
 * @param {Element} el
 * @returns {boolean}
 */
function isKeyboardFocus(el) {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

function wireRunRowPreview() {
  if (window.__runPreviewWired) return;
  window.__runPreviewWired = true;

  // Lazily create the preview element — keeps index.html clean.
  function ensurePreviewEl() {
    let $el = document.getElementById("run-row-preview");
    if ($el) return $el;
    $el = document.createElement("div");
    $el.id = "run-row-preview";
    $el.className = "run-preview";
    $el.hidden = true;
    document.body.appendChild($el);
    return $el;
  }

  function show(row) {
    const id = row?.dataset?.runId;
    if (!id) return;
    const r = parsedRuns.find((x) => String(x.id) === String(id));
    if (!r) return;
    const $el = ensurePreviewEl();
    $el.innerHTML = renderRunRowPreview(r);
    $el.hidden = false;
    runPreviewAnchor = row;
    positionTooltip($el, row);
    if (runPreviewHideTimer) { clearTimeout(runPreviewHideTimer); runPreviewHideTimer = null; }
  }
  function hide() {
    const $el = document.getElementById("run-row-preview");
    if (!$el) return;
    if (runPreviewHideTimer) clearTimeout(runPreviewHideTimer);
    runPreviewHideTimer = setTimeout(() => {
      $el.hidden = true;
      runPreviewAnchor = null;
    }, 80);
  }

  document.body.addEventListener("pointerover", (e) => {
    // A finger cannot hover. On a touch screen this card opened on the tap
    // that opens the run, never got its pointerout, and stayed on top of the
    // run-detail dialog.
    if (e.pointerType === "touch") return;
    const row = e.target instanceof Element ? e.target.closest('[data-run-preview="1"]') : null;
    if (!row) return;
    show(row);
  });
  document.body.addEventListener("pointerout", (e) => {
    const row = e.target instanceof Element ? e.target.closest('[data-run-preview="1"]') : null;
    if (!row) return;
    const related = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (related && row.contains(related)) return;
    hide();
  });
  // Pointermove watchdog — same defense as the highlights tooltip. If
  // the cursor isn't over a run row anymore (cursor moved to whitespace,
  // anchor was unmounted by an auto-refresh, etc.), force-hide.
  document.addEventListener("pointermove", (e) => {
    const $el = document.getElementById("run-row-preview");
    if (!$el || $el.hidden) return;
    const under = e.target instanceof Element ? e.target.closest('[data-run-preview="1"]') : null;
    if (!under) {
      forceHideRunRowPreview();
      return;
    }
    if (runPreviewAnchor && !document.contains(runPreviewAnchor)) {
      show(under);
    }
  });
  document.body.addEventListener("focusin", (e) => {
    const row = e.target instanceof Element ? e.target.closest('[data-run-preview="1"]') : null;
    // Keyboard focus only: a tap or click focuses the row too, and that is
    // not someone asking for a preview. Asked of the element that took focus
    // (the row, or a button inside it), so tabbing along a row keeps the card.
    if (row && isKeyboardFocus(e.target)) show(row);
  });
  document.body.addEventListener("focusout", (e) => {
    const row = e.target instanceof Element ? e.target.closest('[data-run-preview="1"]') : null;
    if (row) hide();
  });
  ["scroll", "wheel", "resize"].forEach((evt) => {
    window.addEventListener(evt, () => forceHideRunRowPreview(), { passive: true });
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") forceHideRunRowPreview();
  });
  window.addEventListener("blur", () => forceHideRunRowPreview());
}

/** Build the inner HTML of the hover preview card for a run. Pure
 *  function so the test target stays predictable; reused by both
 *  pointerover and focusin. Showcases the data the user most cares
 *  about when deciding whether to open the run modal. */
function renderRunRowPreview(r) {
  const charName = r.character ? prettifyCharacterName(r.character) : "Unknown";
  const theme = charTheme(r.character);
  const relicArr = Array.isArray(r.relics) ? r.relics : [];
  const deckArr = Array.isArray(r.deckAtEnd) ? r.deckAtEnd : [];
  const won = r.won === true;
  const abandoned = r.wasAbandoned === true;
  const result = won ? "Victory" : abandoned ? "Abandoned" : "Defeat";
  const resultClass = won ? "is-win" : abandoned ? "is-abandon" : "is-loss";
  const dur = formatPlayTimeStrict(r.playTimeSeconds);
  const killedBy = !won && !abandoned && r.killedBy ? bossLabel(r.killedBy) : "";
  // Top 6 relic icons. We render the first six; if there are more,
  // show a `+N` chip on the right so the count is honest.
  const topRelics = relicArr.slice(0, 6).map((id) => {
    const src = relicImageSrc(id);
    const name = prettifyId(id);
    return `
      <li class="run-preview-relic" title="${esc(name)}">
        ${src
          ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="run-preview-fallback" style="display:none">${esc(name.slice(0,2))}</span>`
          : `<span class="run-preview-fallback">${esc(name.slice(0,2))}</span>`}
      </li>`;
  }).join("");
  const moreRelics = Math.max(0, relicArr.length - 6);

  return `
    <header class="run-preview-head" style="--char-color:${theme.color}"${UI ? ` data-char="${esc(String(r.character || "").toLowerCase())}"` : ""}>
      <div class="run-preview-name">
        <strong>${esc(charName)}</strong>
        ${!isLadderRun(r) ? `<span class="run-preview-asc">${esc(runAscText(r))}</span>` : Number.isFinite(r.ascension) && r.ascension > 0 ? `<span class="run-preview-asc">A${r.ascension}</span>` : ""}
      </div>
      <span class="run-preview-result ${resultClass}">${result}</span>
    </header>
    <dl class="run-preview-stats">
      <div><dt>Floor</dt><dd>${Number.isFinite(r.floorReached) ? r.floorReached : "—"}</dd></div>
      <div><dt>Relics</dt><dd>${relicArr.length}</dd></div>
      <div><dt>Deck</dt><dd>${deckArr.length}</dd></div>
      <div><dt>Time</dt><dd>${esc(dur || "—")}</dd></div>
    </dl>
    ${topRelics ? `
      <div class="run-preview-relics">
        <ul>${topRelics}</ul>
        ${moreRelics > 0 ? `<span class="run-preview-more">+${moreRelics}</span>` : ""}
      </div>` : ""}
    ${killedBy ? `<p class="run-preview-killed">Killed by <strong>${esc(killedBy)}</strong></p>` : ""}
    <p class="run-preview-hint muted small">Click row to open · Shift-click to copy link</p>
  `;
}

// Module-level anchor tracking lets `forceHideHighlightsTooltip()` (called
// from switchTab and feed re-renders) yank the tooltip down even when the
// pointer hasn't moved off a now-removed card. Without this, a background
// poll that swaps the card under the cursor leaves the tooltip stuck open
// — and switching tabs while it's stuck made it bleed onto other pages.
let hTooltipAnchor = null;

function forceHideHighlightsTooltip() {
  const $tip = document.getElementById("h-tooltip");
  if ($tip) $tip.hidden = true;
  if (hTooltipHideTimer) {
    clearTimeout(hTooltipHideTimer);
    hTooltipHideTimer = null;
  }
  hTooltipAnchor = null;
}

function wireHighlightsTooltip() {
  if (window.__hTooltipWired) return;
  window.__hTooltipWired = true;
  const $tip = document.getElementById("h-tooltip");
  if (!$tip) return;

  const showFor = (el) => {
    const kind = el.getAttribute("data-tip-kind") || "";
    const name = el.getAttribute("data-tip-name") || "";
    const art = el.getAttribute("data-tip-art") || "";
    const cls = el.getAttribute("data-tip-class") || "";
    const upgraded = el.getAttribute("data-tip-upgraded") === "1";
    const $art = document.getElementById("h-tooltip-art");
    const $name = document.getElementById("h-tooltip-name");
    const $sub = document.getElementById("h-tooltip-sub");
    if (!$art || !$name || !$sub) return;
    if (art) {
      $art.src = art;
      $art.hidden = false;
    } else {
      $art.removeAttribute("src");
      $art.hidden = true;
    }
    $name.textContent = name;
    // Sub-line: `Card · Ironclad +1` / `Card · Silent` / `Relic`. The
    // upgraded chip is appended only when the card slug ended with the
    // `_plus` / `+1` suffix.
    if (kind === "card") {
      const parts = ["Card"];
      if (cls) parts.push(cls);
      if (upgraded) parts.push("+1");
      $sub.textContent = parts.join(" · ");
    } else if (kind === "relic") {
      $sub.textContent = "Relic";
    } else {
      $sub.textContent = "";
    }
    $tip.dataset.kind = kind;
    $tip.hidden = false;
    hTooltipAnchor = el;
    positionTooltip($tip, el);
    if (hTooltipHideTimer) {
      clearTimeout(hTooltipHideTimer);
      hTooltipHideTimer = null;
    }
  };

  const hide = () => {
    if (hTooltipHideTimer) clearTimeout(hTooltipHideTimer);
    // Tiny grace period — without it, moving from one thumbnail to
    // an adjacent one flickers the tooltip off and on for one frame.
    hTooltipHideTimer = setTimeout(() => {
      $tip.hidden = true;
      hTooltipAnchor = null;
    }, 60);
  };

  // pointerover/pointerout (rather than pointerenter/pointerleave)
  // because they bubble — required for delegation. The closest()
  // check filters down to actual `.h-tip` descendants.
  document.body.addEventListener("pointerover", (e) => {
    const target = e.target instanceof Element ? e.target.closest(".h-tip") : null;
    if (!target) return;
    showFor(target);
  });
  document.body.addEventListener("pointerout", (e) => {
    const target = e.target instanceof Element ? e.target.closest(".h-tip") : null;
    if (!target) return;
    // Don't hide if pointer entered a child of the same target.
    const related = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (related && target.contains(related)) return;
    hide();
  });
  // Watchdog: every pointer move on the document re-checks whether the
  // pointer is still over a `.h-tip`. Production showed two failure
  // modes the pointerout handler couldn't catch:
  //   1) Anchor removed from the DOM (background feed poll re-rendered
  //      cards while hovered) — pointerout never fires for a detached
  //      element, so the tooltip used to wedge open.
  //   2) Cursor exits via the document edge — some browsers don't fire
  //      pointerout reliably when the pointer leaves the viewport.
  // This handler is deliberately *not* throttled: it's a single
  // closest() lookup, cheaper than a `requestAnimationFrame` would be.
  document.addEventListener("pointermove", (e) => {
    if ($tip.hidden) return;
    const under = e.target instanceof Element ? e.target.closest(".h-tip") : null;
    if (!under) {
      forceHideHighlightsTooltip();
      return;
    }
    // If the anchor element was removed (re-render under the cursor),
    // re-anchor to whatever's under the pointer now.
    if (hTooltipAnchor && !document.contains(hTooltipAnchor)) {
      showFor(under);
    }
  });
  // Keyboard nav: focus a thumbnail to see the tooltip; blur dismisses.
  document.body.addEventListener("focusin", (e) => {
    const target = e.target instanceof Element ? e.target.closest(".h-tip") : null;
    if (!target) return;
    showFor(target);
  });
  document.body.addEventListener("focusout", (e) => {
    const target = e.target instanceof Element ? e.target.closest(".h-tip") : null;
    if (!target) return;
    hide();
  });
  // Click-to-blur on tooltip-able thumbnails. Production bug: clicking
  // a relic/card thumbnail (which is `tabindex="0"` for keyboard a11y)
  // would land focus on it, and the orange-ring `:focus-visible` style
  // would persist after the cursor moved off — looking exactly like
  // a stuck hover. Solution: actively blur whatever a click landed on
  // inside a `.h-tip`. Keyboard navigation still works (Tab + Enter)
  // because keydown→focus paths don't go through this handler.
  document.body.addEventListener("click", (e) => {
    const tip = e.target instanceof Element ? e.target.closest(".h-tip") : null;
    if (!tip) return;
    if (typeof tip.blur === "function") tip.blur();
    forceHideHighlightsTooltip();
  });
  // Touch-device safety net: a tap activates `:hover` on iOS/Safari
  // and never clears it until the user taps elsewhere. We force-hide
  // the floating tooltip on every touchend so a tapped relic doesn't
  // leave its preview wedged open at an old position. The CSS hover
  // gate (@media hover:hover) handles the lift/glow side; this
  // handles the JS-driven preview side.
  document.body.addEventListener("touchend", () => {
    forceHideHighlightsTooltip();
  }, { passive: true });
  // Dismiss on scroll/wheel/resize so the tooltip never drifts away
  // from its anchor element.
  ["scroll", "wheel", "resize"].forEach((evt) => {
    window.addEventListener(evt, () => { forceHideHighlightsTooltip(); }, { passive: true });
  });
  // Esc dismisses.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") forceHideHighlightsTooltip();
  });
  // Window blur (alt-tab, system app switch, etc.) — no pointer events
  // fire while the tab is in the background, so a stuck tooltip would
  // outlive the user's intent. Nuke on blur to be safe.
  window.addEventListener("blur", () => forceHideHighlightsTooltip());
}

function positionTooltip($tip, anchor) {
  const rect = anchor.getBoundingClientRect();
  // Render hidden first to measure, then place.
  $tip.style.left = "0px";
  $tip.style.top = "0px";
  const tipRect = $tip.getBoundingClientRect();
  const margin = 10;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  // Default placement: right of the anchor, vertically centered.
  let left = rect.right + margin;
  let top = rect.top + rect.height / 2 - tipRect.height / 2;
  // Flip horizontally if it would overflow the right edge.
  if (left + tipRect.width + margin > viewportW) {
    left = rect.left - tipRect.width - margin;
  }
  // If still out of bounds (very narrow viewport), fall back to
  // below-the-anchor placement so the tooltip stays on-screen.
  if (left < margin) {
    left = Math.max(margin, Math.min(viewportW - tipRect.width - margin, rect.left));
    top = rect.bottom + margin;
    // If below would clip the bottom, place above instead.
    if (top + tipRect.height + margin > viewportH) {
      top = rect.top - tipRect.height - margin;
    }
  }
  // Vertical clamp.
  if (top < margin) top = margin;
  if (top + tipRect.height + margin > viewportH) {
    top = viewportH - tipRect.height - margin;
  }
  $tip.style.left = `${Math.round(left)}px`;
  $tip.style.top = `${Math.round(top)}px`;
}

// -------------------------------------------------------------------------
// "New runs" sidebar dot
//
// Lights the red dot on the Recent Runs nav row when STS2 has written
// a run that finished after the timestamp of the last time the user
// opened that tab. Persisted across reloads via localStorage, so a
// fresh page-load in the middle of a play session still highlights
// the run that just landed.
//
// Unlike the Highlights dot (which excludes self-authored items), the
// Runs dot specifically signals *your own* fresh runs — that's the
// whole point. STS2 writes the run; we want to scream about it.
// -------------------------------------------------------------------------
const STORAGE_RUNS_LAST_SEEN_AT = "vault.web.runs.lastSeenAt";

function newestRunEndedAt() {
  let max = 0;
  for (const r of parsedRuns || []) {
    const t = r?.endedAt?.getTime?.() ?? 0;
    if (t > max) max = t;
  }
  return max;
}

function refreshRunsBadge() {
  const $badge = document.getElementById("nav-runs-count");
  if (!$badge) return;
  // Demo data should not light the badge — there's nothing real for
  // the user to "see". Once a live import lands, isDemoMode flips
  // and the next refreshRunsBadge() call will start tracking real
  // run timestamps.
  if (isDemoMode || !Array.isArray(parsedRuns) || parsedRuns.length === 0) {
    $badge.hidden = true;
    return;
  }
  let lastSeen = 0;
  try { lastSeen = Number(localStorage.getItem(STORAGE_RUNS_LAST_SEEN_AT)) || 0; } catch {}
  const newestAt = newestRunEndedAt();
  $badge.hidden = !(newestAt > lastSeen);
}

function markRunsSeen() {
  if (!Array.isArray(parsedRuns) || parsedRuns.length === 0) return;
  const newest = newestRunEndedAt();
  try { localStorage.setItem(STORAGE_RUNS_LAST_SEEN_AT, String(newest)); } catch {}
  const $badge = document.getElementById("nav-runs-count");
  if ($badge) $badge.hidden = true;
}

// -------------------------------------------------------------------------
// "New highlights" sidebar dot
//
// Red dot on the Highlights nav row when at least one highlight authored
// by someone *other than you* is newer than the timestamp of the last
// time you opened the tab. Persists across reloads via localStorage so
// closing the page doesn't reset the unread state.
//
// Why "from others" only: posts you make yourself shouldn't trigger your
// own unread badge. Otherwise refreshing the feed right after sharing
// would always nag you.
// -------------------------------------------------------------------------
const STORAGE_HIGHLIGHTS_LAST_SEEN = "vault.web.highlights.lastSeenAt";

function newestOtherAuthoredAt(items) {
  const me = session?.steamID;
  let max = 0;
  for (const h of items || []) {
    if (h.authorID && me && h.authorID === me) continue;
    const t = Date.parse(h.createdAt) || 0;
    if (t > max) max = t;
  }
  return max;
}

function refreshHighlightsBadge() {
  const $badge = document.getElementById("nav-highlights-count");
  if (!$badge) return;
  if (!Array.isArray(lastHighlights) || lastHighlights.length === 0) {
    $badge.hidden = true;
    return;
  }
  let lastSeen = 0;
  try { lastSeen = Number(localStorage.getItem(STORAGE_HIGHLIGHTS_LAST_SEEN)) || 0; } catch {}
  const newestAt = newestOtherAuthoredAt(lastHighlights);
  $badge.hidden = !(newestAt > lastSeen);
}

function markHighlightsSeen() {
  if (!Array.isArray(lastHighlights) || lastHighlights.length === 0) return;
  // Use the absolute newest createdAt (across all authors) so any future
  // poll that brings in a newer post — by anyone — will re-light the
  // badge cleanly. The "from others" rule is applied at *display* time
  // by refreshHighlightsBadge().
  let newest = 0;
  for (const h of lastHighlights) {
    const t = Date.parse(h.createdAt) || 0;
    if (t > newest) newest = t;
  }
  try { localStorage.setItem(STORAGE_HIGHLIGHTS_LAST_SEEN, String(newest)); } catch {}
  const $badge = document.getElementById("nav-highlights-count");
  if ($badge) $badge.hidden = true;
}

function startHighlightsPolling() {
  if (pollHighlightsTimer) return;
  pollHighlightsTimer = setInterval(pullHighlights, HIGHLIGHTS_POLL_MS);
}
function stopHighlightsPolling() {
  if (pollHighlightsTimer) {
    clearInterval(pollHighlightsTimer);
    pollHighlightsTimer = null;
  }
}

/** Render the whole feed into #highlights-feed. Idempotent — called
 *  on every poll tick + every modify-success.
 *
 *  Renders three states: loading (initial blank), empty (no posts),
 *  populated (feed). Reactions and comment threads are wired via a
 *  single delegated click handler on the feed container — see
 *  wireHighlightsFeedDelegation. */
// -------------------------------------------------------------------------
// Highlights filter + sort
//
// Filter chips: All / Mine / This week / Featured.
// Sort dropdown: Newest / Most reactions / Most comments / Highest floor.
//
// State lives in localStorage so a returning visitor lands on the same
// view they had configured. The full server payload is kept in
// `lastHighlights` and we re-derive the visible slice on every render
// so filter/sort never goes stale relative to the cached payload.
// -------------------------------------------------------------------------
const HIGHLIGHTS_FILTER_KEY = "vault.web.highlights.filter";
const HIGHLIGHTS_SORT_KEY = "vault.web.highlights.sort";

function getHighlightsFilter() {
  try { return localStorage.getItem(HIGHLIGHTS_FILTER_KEY) || "all"; } catch { return "all"; }
}
function setHighlightsFilter(v) {
  try { localStorage.setItem(HIGHLIGHTS_FILTER_KEY, v); } catch {}
}
function getHighlightsSort() {
  try { return localStorage.getItem(HIGHLIGHTS_SORT_KEY) || "recent"; } catch { return "recent"; }
}
function setHighlightsSort(v) {
  try { localStorage.setItem(HIGHLIGHTS_SORT_KEY, v); } catch {}
}

/** Apply the user's current filter + sort to the cached server
 *  payload. Pure: doesn't mutate the original array. */
function filterAndSortHighlights(items) {
  if (!Array.isArray(items)) return [];
  const filter = getHighlightsFilter();
  const sort = getHighlightsSort();
  const myID = session?.steamID || "";
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const filtered = items.filter((h) => {
    if (filter === "mine") return myID && String(h.authorID) === String(myID);
    if (filter === "week") return Number(h.createdAt) >= weekAgo;
    if (filter === "featured") {
      const total = Object.values(h.reactions || {}).reduce((s, n) => s + (Number(n) || 0), 0);
      return total >= 5;
    }
    return true;
  });

  const sorted = filtered.slice();
  if (sort === "reactions") {
    sorted.sort((a, b) => {
      const ra = Object.values(a.reactions || {}).reduce((s, n) => s + (Number(n) || 0), 0);
      const rb = Object.values(b.reactions || {}).reduce((s, n) => s + (Number(n) || 0), 0);
      return rb - ra || (b.createdAt || 0) - (a.createdAt || 0);
    });
  } else if (sort === "comments") {
    sorted.sort((a, b) => {
      const ca = Number(a.commentCount || 0);
      const cb = Number(b.commentCount || 0);
      return cb - ca || (b.createdAt || 0) - (a.createdAt || 0);
    });
  } else if (sort === "floor") {
    sorted.sort((a, b) => {
      const fa = Number(a.run?.floorReached || 0);
      const fb = Number(b.run?.floorReached || 0);
      return fb - fa || (b.createdAt || 0) - (a.createdAt || 0);
    });
  } else {
    sorted.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  return sorted;
}

/** One-time wiring for the highlights filter chips + sort select.
 *  Called from boot(). The controls live in the panel-head defined in
 *  index.html so they're always present even before the first render. */
function wireHighlightsControls() {
  document.querySelectorAll(".h-filter-chip[data-h-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setHighlightsFilter(btn.getAttribute("data-h-filter") || "all");
      renderHighlightsFeed(lastHighlights);
    });
  });
  const $sort = document.getElementById("h-sort-select");
  if ($sort) {
    $sort.value = getHighlightsSort();
    $sort.addEventListener("change", () => {
      setHighlightsSort($sort.value || "recent");
      renderHighlightsFeed(lastHighlights);
    });
  }
}

/** Reflect the current filter/sort state in the controls' visual state.
 *  Called every render so a programmatic state change is always
 *  visible in the chip pressed state. */
function syncHighlightsControlsUI() {
  const filter = getHighlightsFilter();
  document.querySelectorAll(".h-filter-chip[data-h-filter]").forEach((btn) => {
    const matches = (btn.getAttribute("data-h-filter") || "all") === filter;
    btn.classList.toggle("is-active", matches);
    btn.setAttribute("aria-pressed", matches ? "true" : "false");
  });
  const $sort = document.getElementById("h-sort-select");
  if ($sort && $sort.value !== getHighlightsSort()) {
    $sort.value = getHighlightsSort();
  }
}

function renderHighlightsFeed(items) {
  const $feed = document.getElementById("highlights-feed");
  if (!$feed) return;
  $feed.setAttribute("aria-busy", "false");
  // Re-rendering the feed unmounts every `.h-tip` anchor; without an
  // explicit hide here, a tooltip that was visible at render time
  // would persist forever (its anchor is gone, no pointerout fires).
  try { forceHideHighlightsTooltip(); } catch {}
  // Keep the full payload as the source of truth so re-renders triggered
  // by filter/sort changes always have everything to work with.
  if (Array.isArray(items)) lastHighlights = items;
  syncHighlightsControlsUI();

  const visible = filterAndSortHighlights(lastHighlights);

  if (!Array.isArray(lastHighlights) || lastHighlights.length === 0) {
    $feed.innerHTML = `
      <div class="highlights-empty">
        <p><strong>No highlights yet.</strong></p>
        <p class="muted">Finish a run you're proud of, open it from Recent Runs, click <em>Share</em>, and post it to the community.</p>
      </div>`;
    return;
  }

  if (visible.length === 0) {
    const filter = getHighlightsFilter();
    const emptyCopy = filter === "mine"
      ? "You haven't shared a highlight yet. Open a run from Recent Runs and hit <em>Share</em>."
      : filter === "week"
        ? "Nothing new in the last 7 days. Try <em>All</em> to see the full feed."
        : filter === "featured"
          ? "No featured highlights yet — those are runs with 5+ reactions."
          : "No highlights match this view.";
    $feed.innerHTML = `
      <div class="highlights-empty">
        <p><strong>Nothing here.</strong></p>
        <p class="muted">${emptyCopy}</p>
      </div>`;
    return;
  }

  $feed.innerHTML = visible.map(renderHighlightCard).join("");
  wireHighlightsFeedDelegation($feed);
  // Deep-link spotlight: when the URL hash is `#h-<id>` on first
  // render of the feed, scroll that card into view and pulse a
  // spotlight glow. We do this once per `#h-` hash; subsequent
  // re-renders (background poll updates) shouldn't keep yanking
  // the user back to that card.
  spotlightDeepLinkedHighlight($feed);
}

let _lastSpotlightHash = "";
function spotlightDeepLinkedHighlight($feed) {
  const hash = (window.location.hash || "").replace(/^#/, "");
  if (!hash || !hash.startsWith("h-")) return;
  if (hash === _lastSpotlightHash) return;
  _lastSpotlightHash = hash;
  // rAF gives the browser a moment to lay out the freshly-injected
  // article before we scroll. Without it, smooth scroll occasionally
  // overshoots because the layout pass landed mid-flight.
  requestAnimationFrame(() => {
    const $card = document.getElementById(hash);
    if (!$card) return;
    $card.scrollIntoView({ behavior: "smooth", block: "start" });
    $card.classList.add("is-spotlighted");
    setTimeout(() => $card.classList.remove("is-spotlighted"), 2200);
  });
}

/** One feed card. The whole card is a single static HTML render — no
 *  per-card listeners. Reactions live behind a popover trigger so the
 *  card foot stays calm; chips appear inline only for emojis with at
 *  least one reaction. Comments box renders its own form. No delete
 *  button — once shared, a highlight is a community artifact. */
function renderHighlightCard(h) {
  const run = h.run || {};
  const characterKey = String(run.character || "").toLowerCase();
  const characterLabel = prettifyCharacterName(run.character);
  const ago = formatRelativeActive(h.createdAt);
  const isAuthed = !!session?.sessionToken;
  const viewerSet = new Set(h.viewerReactions || []);
  const heroArt = characterImageSrc(run.character);
  // Derive a result label that's honest about what happened. Three cases:
  //   1. won           → Victory
  //   2. wasAbandoned  → Abandoned (player quit; not the same as a loss)
  //   3. otherwise     → Defeat
  let resultLabel, resultClass;
  if (run.won) { resultLabel = "Victory"; resultClass = "is-win"; }
  else if (run.wasAbandoned) { resultLabel = "Abandoned"; resultClass = "is-abandoned"; }
  else { resultLabel = "Defeat"; resultClass = "is-loss"; }
  const ascLabel = `${Stats.offLadderMode(run.gameMode) === "blitz" ? "Blitz Ascension" : "Ascension"} ${run.ascension ?? 0}`;
  // Daily-run detection: trust the `gameMode` field if present.
  // Fallback: highlights shared before we wired the field through can
  // still be rescued by checking the user-supplied caption for the
  // word "daily" (case-insensitive). The fallback ONLY applies when
  // the server returned no game_mode at all, so it can't mis-tag a
  // standard run whose author happened to mention dailies in passing.
  const explicitMode = typeof run.gameMode === "string" ? run.gameMode.toLowerCase() : "";
  const captionStr = typeof h.caption === "string" ? h.caption.toLowerCase() : "";
  const captionImpliesDaily = !explicitMode && /\bdaily\b/.test(captionStr);
  const gameMode = explicitMode || (captionImpliesDaily ? "daily" : "");
  const isDaily = gameMode === "daily";
  const isCustom = gameMode === "custom" || gameMode === "trial";
  const offLadder = Stats.offLadderMode(gameMode); // "blitz" | "dread" | "" (STS2 beta modes)
  const startDate = run.startedAt ? new Date(run.startedAt) : null;
  const dailyDateLabel = startDate && !Number.isNaN(startDate.getTime())
    ? startDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  const floorLabel = run.won
    ? `Cleared on Floor ${run.floorReached ?? 0}`
    : run.wasAbandoned
      ? `Abandoned on Floor ${run.floorReached ?? 0}`
      : `Fell on Floor ${run.floorReached ?? 0}`;
  const runTime = formatHighlightDuration(run.playTimeSeconds);
  const killedBy = !run.won && !run.wasAbandoned && run.killedBy
    ? bossLabel(run.killedBy)
    : null;
  const totalReactions = Object.values(h.reactions || {})
    .reduce((s, n) => s + (Number(n) || 0), 0);
  const featured = totalReactions >= 5;
  // Modifiers: pretty-printed snake_case to Title Case. Cap at 4 chips
  // visible to keep the hero card from running riot.
  const modifierChips = Array.isArray(run.modifiers) && run.modifiers.length > 0
    ? run.modifiers.slice(0, 4).map((m) => prettifyId(m))
    : [];

  // Relics + cards: render the FULL set the server returned. The
  // backend already caps each at 12, so there's no risk of an
  // unbounded strip blowing out the card. We deliberately avoid the
  // earlier "+N more" truncation — the user's whole point of sharing
  // a run is that someone wants to see what was in it.
  //
  // Each tile renders the image when our local manifest knows about
  // it; otherwise (or on a 404) we show a tiny text fallback. The
  // hidden fallback span is a sibling of the <img>, swapped in via
  // a minimal onerror handler — keeps the markup safe (no caller-
  // supplied strings interpolated into JS).
  // Relic tiles. Each carries the data attributes the global hover-
  // tooltip handler reads to position a floating preview card showing
  // the full relic art at a readable size — replaces the OS-native
  // `title` tooltip which was both slow to appear and visually ugly.
  // We KEEP `title` as a graceful fallback for users with reduced
  // motion / keyboard nav and as a screen-reader hint.
  const relicItems = (run.relics || []).map((id) => {
    const src = relicImageSrc(id);
    const name = prettifyId(id);
    return `
      <li class="h-relic h-tip" tabindex="0"
          data-tip-kind="relic"
          data-tip-name="${esc(name)}"
          data-tip-art="${esc(src || "")}"
          aria-label="${esc(name)}"
          title="${esc(name)}">
        ${src
          ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">
             <span class="h-icon-fallback" style="display:none">${esc(name)}</span>`
          : `<span class="h-icon-fallback">${esc(name)}</span>`}
      </li>`;
  }).join("");

  const cardItems = (run.deckHighlights || []).map((id) => {
    const src = cardImageSrc(id);
    const name = prettifyId(id);
    // The card class prefix is the most informative metadata we can
    // surface without shipping a description manifest. Strip the slug
    // back to its class token (`ironclad_strike` → `Ironclad`) and
    // expose it as an extra hover-tooltip line.
    const slugClass = String(id || "").split("_")[0] || "";
    const classLabel = CLASS_PREFIXES.has(slugClass) ? prettifyId(slugClass) : "";
    const upgraded = String(id || "").endsWith("+1") || String(id || "").endsWith("_plus");
    return `
      <li class="h-card h-tip" tabindex="0"
          data-tip-kind="card"
          data-tip-name="${esc(name)}"
          data-tip-class="${esc(classLabel)}"
          data-tip-upgraded="${upgraded ? "1" : "0"}"
          data-tip-art="${esc(src || "")}"
          aria-label="${esc(name)}"
          title="${esc(name)}">
        ${src
          ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">
             <span class="h-icon-fallback" style="display:none">${esc(name)}</span>`
          : `<span class="h-icon-fallback">${esc(name)}</span>`}
      </li>`;
  }).join("");

  // Inline chips: one per emoji that has at least one reaction.
  // Clicking a chip toggles the user's reaction with that emoji
  // (server treats it the same as picking from the popover).
  const summaryChips = HighlightsAPI.ALLOWED_REACTIONS
    .map((emoji) => {
      const count = h.reactions?.[emoji] ?? 0;
      if (count <= 0) return "";
      const pressed = viewerSet.has(emoji);
      return `
        <li>
          <button
            class="h-reaction-chip ${pressed ? "is-on" : ""}"
            type="button"
            data-h-action="react"
            data-h-id="${esc(h.id)}"
            data-emoji="${esc(emoji)}"
            aria-pressed="${pressed ? "true" : "false"}"
            aria-label="${pressed ? "Remove" : "Add"} reaction ${esc(emoji)}, currently ${count}"
            ${!isAuthed ? "disabled title='Sign in to react'" : ""}>
            <span class="h-reaction-emoji">${emoji}</span>
            <span class="h-reaction-count">${count}</span>
          </button>
        </li>`;
    })
    .filter(Boolean)
    .join("");

  // Popover: full curated set. Each option marks "is-on" if the user
  // has already reacted with it so they can see + remove via the
  // popover too.
  const popoverItems = HighlightsAPI.ALLOWED_REACTIONS
    .map((emoji) => {
      const pressed = viewerSet.has(emoji);
      return `
        <button
          class="h-react-popover-item ${pressed ? "is-on" : ""}"
          type="button"
          role="menuitem"
          data-h-action="react"
          data-h-id="${esc(h.id)}"
          data-emoji="${esc(emoji)}"
          aria-pressed="${pressed ? "true" : "false"}"
          ${!isAuthed ? "disabled title='Sign in to react'" : ""}>
          ${emoji}
        </button>`;
    })
    .join("");

  const commentTeaser = h.commentCount > 0
    ? `${h.commentCount} comment${h.commentCount === 1 ? "" : "s"}`
    : "Comment";

  // Hero banner: character art bleeds across the whole card top, with
  // a graphic-novel feel — character key colors as gradient, big result
  // label, mode-aware sub-headline.
  //
  // Daily / custom runs get a dedicated badge above the character name
  // so the user immediately sees "this isn't a standard run" at a
  // glance. The badge uses the run's startedAt date because that's the
  // canonical "Daily Run for [date]" anchor in STS2 — endedAt could
  // bleed into the next day for a long session, which would be wrong.
  let heroBadge = "";
  if (isDaily) {
    heroBadge = `<span class="h-mode-badge h-mode-daily" title="Daily challenge run">
      <span class="h-mode-icon" aria-hidden="true">★</span>
      <span>Daily Run${dailyDateLabel ? ` · ${esc(dailyDateLabel)}` : ""}</span>
    </span>`;
  } else if (isCustom) {
    heroBadge = `<span class="h-mode-badge h-mode-custom" title="Custom / trial run">
      <span class="h-mode-icon" aria-hidden="true">⚙︎</span>
      <span>${esc(prettifyId(gameMode))}</span>
    </span>`;
  } else if (offLadder) {
    // Beta-branch modes (v0.113.0); reuses the custom badge styling.
    const modeName = offLadder === "blitz" ? "Blitz" : "Dread";
    heroBadge = `<span class="h-mode-badge h-mode-custom h-mode-${offLadder}" title="${modeName} run">
      <span class="h-mode-icon" aria-hidden="true">${offLadder === "blitz" ? "⚡︎" : "☠︎"}</span>
      <span>${modeName}</span>
    </span>`;
  }
  const modifiersLine = modifierChips.length > 0
    ? `<ul class="h-modifier-strip" aria-label="Run modifiers">
        ${modifierChips.map((m) => `<li class="h-modifier-chip">${esc(m)}</li>`).join("")}
      </ul>`
    : "";
  const heroBlock = `
    <div class="h-hero" data-character="${esc(characterKey)}" data-result="${run.won ? "win" : run.wasAbandoned ? "abandoned" : "loss"}" data-mode="${esc(gameMode)}">
      ${heroArt
        ? `<img class="h-hero-art" src="${esc(heroArt)}" alt="" loading="lazy" />`
        : ""}
      <div class="h-hero-tint" aria-hidden="true"></div>
      <div class="h-hero-text">
        <div class="h-hero-row1">
          <span class="h-hero-result ${resultClass}">${esc(resultLabel)}</span>
          ${heroBadge}
          ${featured ? `<span class="h-hero-featured" title="Lots of reactions">★ Featured</span>` : ""}
        </div>
        <h3 class="h-hero-character">
          ${esc(characterLabel)}
          ${isDaily || offLadder === "dread" ? "" : `<span class="h-hero-asc">${esc(ascLabel)}</span>`}
        </h3>
        <p class="h-hero-meta">
          <span>${esc(floorLabel)}</span>
          <span class="h-hero-sep" aria-hidden="true">•</span>
          <span>${esc(runTime)}</span>
          ${killedBy ? `
            <span class="h-hero-sep" aria-hidden="true">•</span>
            <span class="h-hero-killer">Killed by ${esc(killedBy)}</span>
          ` : ""}
        </p>
        ${modifiersLine}
      </div>
    </div>`;

  return `
    <article class="h-card-root" id="h-${esc(h.id)}" data-h-id="${esc(h.id)}" data-h-author="${esc(h.authorID)}" data-character="${esc(characterKey)}">
      ${heroBlock}

      <header class="h-card-head">
        <img class="h-author-avatar" alt="" src="${esc(h.authorAvatar || "/assets/brand/crest-avatar-128-v1.png")}" />
        <div class="h-author-meta">
          <strong>${esc(h.authorPersona || "Steam User")}</strong>
          <span class="muted small">${esc(ago)}</span>
        </div>
      </header>

      ${h.caption ? `<blockquote class="h-caption">${esc(h.caption)}</blockquote>` : ""}

      <dl class="h-stat-grid">
        ${isDaily || offLadder === "dread"
          ? `<div class="h-stat">
              <dt class="h-stat-label">Mode</dt>
              <dd class="h-stat-num h-stat-num-sm">${isDaily ? "Daily" : "Dread"}</dd>
            </div>`
          : `<div class="h-stat">
              <dt class="h-stat-label">${offLadder === "blitz" ? "Blitz ascension" : "Ascension"}</dt>
              <dd class="h-stat-num">A${run.ascension ?? 0}</dd>
            </div>`}
        <div class="h-stat">
          <dt class="h-stat-label">${run.won ? "Cleared at floor" : run.wasAbandoned ? "Quit on floor" : "Final floor"}</dt>
          <dd class="h-stat-num">${run.floorReached ?? 0}</dd>
        </div>
        <div class="h-stat">
          <dt class="h-stat-label">Run time</dt>
          <dd class="h-stat-num">${esc(runTime)}</dd>
        </div>
        ${killedBy ? `
          <div class="h-stat">
            <dt class="h-stat-label">Killed by</dt>
            <dd class="h-stat-num h-stat-num-sm">${esc(killedBy)}</dd>
          </div>
        ` : ""}
        ${run.seed ? `
          <div class="h-stat" title="Slay the Spire 2 run seed">
            <dt class="h-stat-label">Seed</dt>
            <dd class="h-stat-num h-stat-num-sm h-stat-mono">${esc(String(run.seed).slice(0, 12))}</dd>
          </div>
        ` : ""}
      </dl>

      ${(run.relics?.length || 0) > 0 ? `
        <div class="h-row">
          <h4 class="h-row-title">
            <span>Relics</span>
            <span class="h-row-count">${run.relics.length}</span>
          </h4>
          <ul class="h-icon-strip h-icon-strip-relics">${relicItems}</ul>
        </div>
      ` : ""}

      ${(run.deckHighlights?.length || 0) > 0 ? `
        <div class="h-row">
          <h4 class="h-row-title">
            <span>Deck highlights</span>
            <span class="h-row-count">${run.deckHighlights.length}</span>
          </h4>
          <ul class="h-icon-strip h-icon-strip-cards">${cardItems}</ul>
        </div>
      ` : ""}

      <footer class="h-card-foot">
        <div class="h-react-block" data-h-react-block>
          ${summaryChips ? `<ul class="h-reaction-summary" role="group" aria-label="Reactions">${summaryChips}</ul>` : ""}
          <div class="h-react-trigger-wrap">
            <button
              class="h-react-trigger"
              type="button"
              data-h-action="open-react-menu"
              data-h-id="${esc(h.id)}"
              aria-haspopup="menu"
              aria-expanded="false"
              ${!isAuthed ? "disabled title='Sign in to react'" : ""}>
              <span class="h-react-trigger-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9"/>
                  <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                  <line x1="9" y1="9" x2="9.01" y2="9"/>
                  <line x1="15" y1="9" x2="15.01" y2="9"/>
                </svg>
              </span>
              <span>React</span>
            </button>
            <div class="h-react-popover" data-h-react-popover role="menu" aria-label="Choose a reaction" hidden>
              ${popoverItems}
            </div>
          </div>
        </div>
        <button class="h-comments-toggle" type="button" data-h-action="toggle-comments" data-h-id="${esc(h.id)}" aria-expanded="false">
          <span aria-hidden="true">💬</span>
          <span>${esc(commentTeaser)}</span>
        </button>
        <button class="h-link-copy" type="button" data-h-action="copy-link" data-h-id="${esc(h.id)}" title="Copy a direct link to this highlight" aria-label="Copy link to this highlight">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 1 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 1 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <span>Link</span>
        </button>
      </footer>

      <section class="h-comments" data-h-comments="${esc(h.id)}" hidden>
        <ol class="h-comments-list" data-h-comments-list="${esc(h.id)}">
          <li class="muted small">Loading comments…</li>
        </ol>
        ${isAuthed ? `
          <form class="h-comment-form" data-h-action="comment" data-h-id="${esc(h.id)}">
            <textarea
              class="h-comment-input"
              maxlength="280"
              rows="2"
              placeholder="Add a comment…"
              aria-label="Add a comment"
              required></textarea>
            <div class="h-comment-actions">
              <span class="muted small h-comment-count">0 / 280</span>
              <button class="btn-primary sm" type="submit">Post</button>
            </div>
          </form>
        ` : `
          <p class="muted small">Sign in with Steam to comment.</p>
        `}
      </section>
    </article>`;
}

/** Single delegated click + submit handler for the whole feed. Avoids
 *  re-binding listeners on every render — the feed re-renders frequently
 *  (every 30s + after every modify) and per-button binds would leak. */
function wireHighlightsFeedDelegation($feed) {
  if ($feed.dataset.wired === "1") return;
  $feed.dataset.wired = "1";
  $feed.addEventListener("click", onHighlightsClick);
  $feed.addEventListener("submit", onHighlightsSubmit);
  $feed.addEventListener("input", onHighlightsInput);
}

async function onHighlightsClick(ev) {
  const btn = ev.target.closest("[data-h-action]");
  if (!btn) {
    // Click landed outside any actionable target — close any open
    // reaction popover, since a click anywhere on the feed that
    // misses the popover should dismiss it (matches OS popover UX).
    closeAllReactionPopovers();
    return;
  }
  const action = btn.dataset.hAction;
  const id = btn.dataset.hId;
  if (!id) return;

  if (action === "react") {
    if (!session?.sessionToken) {
      toast("Sign in with Steam to react.");
      return;
    }
    const emoji = btn.dataset.emoji;
    if (!emoji) return;
    // Optimistic flip on whichever surface was clicked (chip or
    // popover item). The authoritative re-render below will replace
    // the whole card so everything reconciles in one pass.
    const wasPressed = btn.getAttribute("aria-pressed") === "true";
    btn.setAttribute("aria-pressed", wasPressed ? "false" : "true");
    btn.classList.toggle("is-on", !wasPressed);
    closeAllReactionPopovers();
    const r = await HighlightsAPI.toggleReaction(API_BASE, session.sessionToken, id, emoji);
    if (!r.ok) {
      btn.setAttribute("aria-pressed", wasPressed ? "true" : "false");
      btn.classList.toggle("is-on", wasPressed);
      toast(r.error === "rate_limited" ? "Slow down a bit." : "Reaction failed.");
      return;
    }
    if (r.highlight) updateHighlightInPlace(r.highlight);
    vaultGtagEvent("highlight_react", {
      // Direction tells us if reactions are being added or removed.
      // We compute it from the optimistic flip the user just did so
      // it's cheap and accurate.
      direction: wasPressed ? "remove" : "add",
      emoji: String(emoji).slice(0, 8),
    });
  } else if (action === "open-react-menu") {
    if (!session?.sessionToken) {
      toast("Sign in with Steam to react.");
      return;
    }
    const $card = btn.closest(".h-card-root");
    const $pop = $card?.querySelector("[data-h-react-popover]");
    if (!$pop) return;
    const opening = $pop.hasAttribute("hidden");
    closeAllReactionPopovers();
    if (opening) {
      $pop.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
      // Pop the first option into focus for keyboard users.
      const $first = $pop.querySelector("[data-h-action='react']:not([disabled])");
      if ($first) $first.focus();
    }
  } else if (action === "toggle-comments") {
    const $section = $feed_findCommentsSection(id);
    if (!$section) return;
    const wasHidden = $section.hidden;
    $section.hidden = !wasHidden;
    if (wasHidden) {
      btn.setAttribute("aria-expanded", "true");
      await loadCommentsInto(id);
    } else {
      btn.setAttribute("aria-expanded", "false");
    }
  } else if (action === "delete-comment") {
    const cid = btn.dataset.cid;
    if (!cid) return;
    if (!confirm("Delete this comment?")) return;
    const r = await HighlightsAPI.deleteComment(API_BASE, session.sessionToken, id, cid);
    if (!r.ok) {
      toast("Couldn't delete that comment.");
      return;
    }
    await loadCommentsInto(id);
    pullHighlights();
  } else if (action === "copy-link") {
    // Build a shareable URL pointing at this exact highlight. The
    // hash form (`#h-<id>`) makes it dead simple to handle on the
    // landing side: scrollIntoView + spotlight pulse once the feed
    // has rendered.
    const u = new URL(window.location.href);
    u.searchParams.set("tab", "highlights");
    u.hash = `h-${id}`;
    const url = u.toString();
    try {
      await navigator.clipboard.writeText(url);
      toast("Highlight link copied.");
    } catch {
      toast(url);
    }
    btn.classList.add("is-flashed");
    const label = btn.querySelector("span:not([aria-hidden])");
    const prev = label ? label.textContent : "";
    if (label) label.textContent = "Copied!";
    setTimeout(() => {
      btn.classList.remove("is-flashed");
      if (label) label.textContent = prev;
    }, 1400);
  }
}

/** Close every reaction popover currently open. Called on outside
 *  click, on Esc, and right before opening a new one so only one
 *  popover is ever visible. */
function closeAllReactionPopovers() {
  document.querySelectorAll("[data-h-react-popover]").forEach(($pop) => {
    if (!$pop.hasAttribute("hidden")) $pop.setAttribute("hidden", "");
  });
  document.querySelectorAll(".h-react-trigger[aria-expanded='true']").forEach(($trig) => {
    $trig.setAttribute("aria-expanded", "false");
  });
}

async function onHighlightsSubmit(ev) {
  const form = ev.target.closest("form[data-h-action='comment']");
  if (!form) return;
  ev.preventDefault();
  const id = form.dataset.hId;
  const $ta = form.querySelector(".h-comment-input");
  if (!id || !$ta) return;
  const text = ($ta.value || "").trim();
  if (!text) return;
  if (!session?.sessionToken) {
    toast("Sign in with Steam to comment.");
    return;
  }
  const $btn = form.querySelector("button[type='submit']");
  if ($btn) $btn.disabled = true;
  const r = await HighlightsAPI.postComment(API_BASE, session.sessionToken, id, text);
  if ($btn) $btn.disabled = false;
  if (!r.ok) {
    toast(r.error === "rate_limited" ? "Slow down — give it a moment." : "Couldn't post that.");
    return;
  }
  $ta.value = "";
  const $count = form.querySelector(".h-comment-count");
  if ($count) $count.textContent = "0 / 280";
  await loadCommentsInto(id);
  if (r.highlight) updateHighlightInPlace(r.highlight);
}

function onHighlightsInput(ev) {
  const $ta = ev.target.closest(".h-comment-input");
  if (!$ta) return;
  const form = $ta.closest("form");
  const $count = form?.querySelector(".h-comment-count");
  if ($count) $count.textContent = `${($ta.value || "").length} / 280`;
}

function $feed_findCommentsSection(id) {
  return document.querySelector(`[data-h-comments="${cssEscapeId(id)}"]`);
}

function cssEscapeId(s) {
  // Hex IDs are always safe selectors (only [0-9a-f]) but route through
  // CSS.escape if the function exists for future-proofing.
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s;
}

async function loadCommentsInto(id) {
  const $list = document.querySelector(`[data-h-comments-list="${cssEscapeId(id)}"]`);
  if (!$list) return;
  $list.innerHTML = `<li class="muted small">Loading comments…</li>`;
  const r = await HighlightsAPI.fetchComments(API_BASE, id);
  if (!r.ok) {
    $list.innerHTML = `<li class="muted small">Couldn't load comments.</li>`;
    return;
  }
  const comments = r.comments || [];
  if (comments.length === 0) {
    $list.innerHTML = `<li class="muted small">No comments yet.</li>`;
    return;
  }
  // Comment authors can remove their own posts. We deliberately do
  // *not* surface deletion for highlight authors moderating other
  // users' comments — the product call here is "no destructive
  // affordances against other people's words". The server still
  // permits highlight-author moderation if a future client wants
  // it, but the public web doesn't expose it.
  const me = session?.steamID;
  $list.innerHTML = comments.map((c) => {
    const isOwn = me && me === c.authorID;
    return `
      <li class="h-comment">
        <img class="h-comment-avatar" alt="" src="${esc(c.authorAvatar || "/assets/brand/crest-avatar-128-v1.png")}" />
        <div class="h-comment-body">
          <div class="h-comment-meta">
            <strong>${esc(c.authorPersona || "Steam User")}</strong>
            <span class="muted small">${esc(formatRelativeActive(c.createdAt))}</span>
            ${isOwn ? `
              <button class="h-comment-delete" type="button"
                data-h-action="delete-comment"
                data-h-id="${esc(id)}"
                data-cid="${esc(c.id)}"
                aria-label="Delete your comment"
                title="Delete">×</button>
            ` : ""}
          </div>
          <p class="h-comment-text">${esc(c.text)}</p>
        </div>
      </li>`;
  }).join("");
}

/** Replace just the one card's data in `lastHighlights` and re-render
 *  in place, without disturbing scroll position or the user's typed
 *  comment drafts in other cards. */
function updateHighlightInPlace(highlight) {
  const idx = lastHighlights.findIndex((h) => h.id === highlight.id);
  if (idx === -1) return;
  // Preserve the comments visibility state across re-render — the
  // delegation handler reads it from the DOM, so we just need to
  // copy the hidden flag back after replacing the card markup.
  const prevSection = $feed_findCommentsSection(highlight.id);
  const prevWasOpen = prevSection && !prevSection.hidden;
  lastHighlights[idx] = highlight;
  const $oldCard = document.querySelector(`.h-card-root[data-h-id="${cssEscapeId(highlight.id)}"]`);
  if (!$oldCard) return;
  // The replaceWith() below detaches every `.h-tip` anchor inside this
  // card. If a tooltip was open against one of them, no pointerout
  // fires for the now-detached node — force-hide so it doesn't wedge.
  try { forceHideHighlightsTooltip(); } catch {}
  const tmp = document.createElement("div");
  tmp.innerHTML = renderHighlightCard(highlight);
  const $newCard = tmp.firstElementChild;
  if (!$newCard) return;
  $oldCard.replaceWith($newCard);
  if (prevWasOpen) {
    const $section = $feed_findCommentsSection(highlight.id);
    if ($section) {
      $section.hidden = false;
      const $toggle = $newCard.querySelector(`[data-h-action="toggle-comments"]`);
      if ($toggle) $toggle.setAttribute("aria-expanded", "true");
      // Re-fetch so the count + thread stay in sync.
      loadCommentsInto(highlight.id);
    }
  }
}

/** Wire global dismissal handlers for the reaction popover. Called once
 *  during boot. The card-internal `onHighlightsClick` already dismisses
 *  on intra-feed clicks; this covers Esc and clicks anywhere else on
 *  the page. */
function wireHighlightsGlobalDismissal() {
  if (window.__hightlightsGlobalWired) return;
  window.__hightlightsGlobalWired = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeAllReactionPopovers();
  });
  document.addEventListener("click", (ev) => {
    // Ignore clicks that landed on the trigger itself (it already
    // toggles), the popover, or anything inside it. Anywhere else
    // on the document → close.
    if (!ev.target.closest("[data-h-react-popover], .h-react-trigger")) {
      closeAllReactionPopovers();
    }
  }, { capture: true });
}

// NOTE: prettifyId already exists later in the file (line ~7685) as
// part of the stats engine. Highlights uses that one — we just provide
// the two helpers that don't already live elsewhere.
function prettifyCharacterName(c) {
  if (!c) return "Unknown";
  const map = {
    ironclad: "Ironclad", silent: "Silent", regent: "Regent",
    necrobinder: "Necrobinder", defect: "Defect", fool: "The Fool",
  };
  const k = String(c).toLowerCase();
  return map[k] || c;
}

// ---- STS2 beta content (v0.113.0) -----------------------------------------
// The Fool is a beta-branch character (art: the game's rest-site art); Blitz and Dread are
// beta game modes whose `ascension` is not a standard-ladder level (Blitz
// has its own 5-level ladder, Dread forces every modifier on). Main-branch
// histories contain none of these, so each helper below is a no-op for
// them and their layouts stay exactly as before.

/** False for Blitz and Dread runs, whose ascension is off the standard ladder. */
function isLadderRun(run) {
  return !Stats.offLadderMode(run?.gameMode);
}

/** "A7" for a standard run, "Blitz A2" / "Dread" for the beta modes, "" when unknown. */
function runAscText(run) {
  const mode = Stats.offLadderMode(run?.gameMode);
  const level = Number.isFinite(run?.ascension) ? run.ascension : null;
  if (mode === "dread") return "Dread";
  if (mode === "blitz") return level === null ? "Blitz" : `Blitz A${level}`;
  return level === null ? "" : `A${level}`;
}

/** Ascension pill on a run row: the same gold "A7" as always for standard
 *  runs, a "Blitz A2" / "Dread" tag for the beta modes. */
function runAscPillHtml(run) {
  const text = runAscText(run);
  if (!text) return "";
  const title = isLadderRun(run) ? "" : ` title="${esc(text)} run, not counted on the Ascension ladder"`;
  return `<span class="pill pill-gold"${title}>${esc(text)}</span>`;
}

function formatHighlightDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** Build the highlight payload from a parsed run. The server re-sanitizes
 *  every field so this is just the client's "best effort to send only
 *  what's interesting." */
function buildHighlightPayload(run, caption) {
  // ISO-string conversion: Date objects don't survive JSON.stringify
  // cleanly across all browsers (some libraries strip them). Convert
  // to ISO 8601 explicitly so the wire format is predictable. The
  // backend re-validates with new Date() so any garbage is rejected.
  const endedAtIso = run.endedAt instanceof Date
    ? run.endedAt.toISOString()
    : (run.endedAt ?? new Date().toISOString());
  const startedAtIso = run.startedAt instanceof Date
    ? run.startedAt.toISOString()
    : (run.startedAt ?? null);
  return {
    caption: caption || undefined,
    run: {
      character: run.character ?? "",
      ascension: run.ascension ?? 0,
      floorReached: run.floorReached ?? 0,
      won: run.won === true,
      playTimeSeconds: run.playTimeSeconds ?? 0,
      endedAt: endedAtIso,
      // New fields surface daily-run / abandoned / mode-specific UX.
      // Backend strips on save when missing — clients on older builds
      // continue to render fine.
      startedAt: startedAtIso || undefined,
      gameMode: typeof run.gameMode === "string" ? run.gameMode : undefined,
      wasAbandoned: run.wasAbandoned === true ? true : undefined,
      seed: typeof run.seed === "string" ? run.seed : undefined,
      modifiers: Array.isArray(run.modifiers) && run.modifiers.length > 0 ? run.modifiers.slice(0, 8) : undefined,
      killedBy: run.killedBy,
      relics: (run.relics || []).slice(0, 12),
      deckHighlights: highlightCards(run).slice(0, 12),
      neowBonus: run.neowBonus,
    },
  };
}

// =========================================================================
// News tab — master/detail
//
// The News panel ships with one <article class="news-post"> per article
// in chronological order (newest first) directly in index.html so each
// post is fully editable in any text editor. This function:
//
//   1. Generates the left-rail list of clickable article tiles by
//      walking those <article> elements at boot.
//   2. Wires click delegation: a click on a tile activates its post
//      and hides the others, plus updates the URL hash so the
//      selection survives a refresh and is shareable.
//   3. Reads the URL hash on load (`#news-002`) and activates the
//      matching post; otherwise defaults to the newest one.
//
// Idempotent — repeat calls bail via `window.__newsTabsWired`. Safe
// to invoke from boot, from `renderActiveTab()` on every News tab
// entry, and from a hashchange listener.
// =========================================================================
/**
 * A one-line string with its last two words joined by a no-break space, so a
 * classic speech balloon never ends on one word ("…coming for / you.",
 * "Not even an / introduction?"). With `text-wrap: balance` on the balloon
 * the two lines then split evenly ("Not even / an introduction?").
 * @param {string} text
 * @param {number} [maxWord] a longer last "word" (a URL, a path) keeps its break
 * @returns {string}
 */
function glueLastTwoWords(text, maxWord = 20) {
  const t = String(text ?? "");
  const cut = t.lastIndexOf(" ");
  if (cut <= 0 || t.length - cut - 1 > maxWord) return t;
  return `${t.slice(0, cut)}\u00a0${t.slice(cut + 1)}`;
}

/**
 * Joins a block's last two words with a no-break space, so its last line
 * never holds one word alone ("everyone.", "SpireVault”."). Works across
 * inline tags (`the <b>Settings</b> tab`); text inside code and buttons is left
 * as is (a button's label is one control, and tests read it exactly).
 * Idempotent: a block whose last break is already a no-break space is
 * skipped.
 * @param {Element} block
 * @param {number} [maxWord] a longer last "word" (a URL, a path) keeps its break
 */
function keepLastWordsTogether(block, maxWord = 20) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("code, pre, kbd, svg, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
  const isBreak = (ch) => /\s/.test(ch) && ch !== "\u00a0";
  let wordLen = 0;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const text = nodes[i].nodeValue || "";
    for (let j = text.length - 1; j >= 0; j--) {
      const ch = text[j];
      if (ch === "\u00a0") return;
      if (!isBreak(ch)) { wordLen++; continue; }
      if (wordLen === 0) continue; // trailing white space
      if (wordLen > maxWord) return;
      let k = j;
      while (k > 0 && isBreak(text[k - 1])) k--;
      // Is there a word before this break at all?
      const before = nodes.slice(0, i).map((n) => n.nodeValue || "").join("") + text.slice(0, k);
      if (!/\S/.test(before)) return;
      nodes[i].nodeValue = text.slice(0, k) + "\u00a0" + text.slice(j + 1);
      // White space that ended the previous text node would still allow a
      // break just before the no-break space.
      for (let p = i - 1; k === 0 && p >= 0; p--) {
        const prev = nodes[p].nodeValue || "";
        const trimmed = prev.replace(/[^\S\u00a0]+$/, "");
        nodes[p].nodeValue = trimmed;
        if (trimmed.length) break;
      }
      return;
    }
  }
}

/** How far from a block's end a hyphen is kept whole (about the last three words). */
const HYPHEN_TAIL_CHARS = 30;

/**
 * Keeps the hyphenated words near a block's end whole ("sign-in", "lock-in",
 * "beta-patch"). Once keepLastWordsTogether has glued the last two words, a
 * hyphen there is often the only break left near the end, and the browser
 * takes it ("sign- / in stay put"). A WORD JOINER (U+2060, invisible, in no
 * font's way) after each such hyphen removes that break. Text inside code is
 * left as is. Idempotent.
 * @param {Element} block
 */
function keepTailHyphensWhole(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest("code, pre, kbd, svg, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(/** @type {Text} */ (walker.currentNode));
  let after = 0; // characters between the current position and the block's end
  for (let i = nodes.length - 1; i >= 0 && after <= HYPHEN_TAIL_CHARS; i--) {
    const text = nodes[i].nodeValue || "";
    let out = "";
    for (let j = text.length - 1; j >= 0; j--) {
      const ch = text[j];
      const joinable = ch === "-" && after <= HYPHEN_TAIL_CHARS && /\p{L}/u.test(text[j - 1] || "") && /\p{L}/u.test(text[j + 1] || "");
      out = (joinable ? "-\u2060" : ch) + out;
      after++;
    }
    nodes[i].nodeValue = out;
  }
}

function wireNewsTabs() {
  const $detail = document.getElementById("news-detail");
  const $list   = document.getElementById("news-list");
  if (!$detail || !$list) return;

  const posts = Array.from($detail.querySelectorAll(".news-post[data-news-id]"));
  if (posts.length === 0) return;

  if (!window.__newsTabsWired) {
    window.__newsTabsWired = true;

    // No paragraph, list item or heading in a post ends on one word alone,
    // at any width, in either look (the rail's titles are read after this).
    posts.forEach((post) => {
      post.querySelectorAll("p, li, h3, h4, figcaption").forEach((block) => {
        keepLastWordsTogether(block);
        keepTailHyphensWhole(block);
      });
    });

    // Paint the left rail once. We deliberately preserve DOM order
    // (newest first because that's how the article markup is
    // ordered in index.html). Each tile has aria-pressed so screen
    // readers get the active state.
    // "Game update · November 13, 2026": the date never breaks inside, so
    // a narrow list wraps after the "·", not between "13," and "2026".
    const newsEyebrowHtml = (eyebrow) => {
      const cut = eyebrow.lastIndexOf(" · ");
      if (cut < 0) return esc(eyebrow);
      return `${esc(eyebrow.slice(0, cut + 3))}<span class="news-list-date">${esc(eyebrow.slice(cut + 3))}</span>`;
    };
    const items = posts.map((p) => {
      const id = p.getAttribute("data-news-id") || "";
      const eyebrow = p.getAttribute("data-news-eyebrow") || "";
      const title = (p.querySelector(".news-post-title")?.textContent || "Untitled").trim();
      const tagsRaw = p.getAttribute("data-news-tags") || "";
      const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 2);
      return `
        <li>
          <button type="button" class="news-list-item" data-news-id="${esc(id)}" aria-pressed="false">
            <span class="news-list-eyebrow">${newsEyebrowHtml(eyebrow)}</span>
            <span class="news-list-title">${esc(title)}</span>
            ${tags.length ? `<span class="news-list-tags">${tags.map((t) => `<span class="news-list-tag">${esc(t)}</span>`).join("")}</span>` : ""}
          </button>
        </li>`;
    }).join("");
    $list.innerHTML = `<ol class="news-list-ol">${items}</ol>`;

    // Click delegation on the rail.
    $list.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest("[data-news-id]") : null;
      if (!btn) return;
      const id = btn.getAttribute("data-news-id");
      if (id) selectNewsPost(id, { updateHash: true });
    });

    // Hashchange so paste-link / browser-back navigations land on
    // the right post. We listen at the window level (not inside
    // the panel) because the hash can change while the user is on
    // *any* tab.
    window.addEventListener("hashchange", () => {
      if (activeTab !== "news") return;
      const m = (window.location.hash || "").match(/^#news-(\w+)/);
      if (m) selectNewsPost(m[1], { updateHash: false });
    });
  }

  // Pick the post to activate: URL hash wins, otherwise the newest
  // (first DOM child in the detail).
  const m = (window.location.hash || "").match(/^#news-(\w+)/);
  const initialId = m ? m[1] : (posts[0].getAttribute("data-news-id") || "");
  if (initialId) selectNewsPost(initialId, { updateHash: false });
}

function selectNewsPost(id, { updateHash } = { updateHash: true }) {
  const $detail = document.getElementById("news-detail");
  const $list = document.getElementById("news-list");
  if (!$detail) return;
  const target = $detail.querySelector(`.news-post[data-news-id="${cssEscape(String(id))}"]`);
  if (!target) return;

  // Show only the matching post.
  $detail.querySelectorAll(".news-post").forEach((p) => {
    p.hidden = (p !== target);
  });
  // Reflect the active state in the rail.
  if ($list) {
    $list.querySelectorAll(".news-list-item").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.getAttribute("data-news-id") === id ? "true" : "false");
    });
  }
  // Persist via URL hash so reload / share / browser back all DTRT.
  if (updateHash) {
    try { history.replaceState(null, "", `${window.location.pathname}${window.location.search}#news-${id}`); } catch {}
  }
  // Scroll the WHOLE PAGE to the top, not just the article into view.
  //
  // Why: .panel-head ("News & updates") is position:sticky; top:0 and
  // is roughly 77px tall. If we use scrollIntoView({block:"start"})
  // on the article, the article's top lines up with viewport y=0 —
  // but the sticky panel-head paints OVER it, so the banner and
  // article header are hidden behind the title bar and the user
  // sees the body content as if the article started mid-paragraph.
  //
  // Scrolling the document to absolute top instead means panel-head,
  // sticky rail, and article header all sit in their natural
  // positions and the user sees a clean "fresh article" view.
  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 0);
  }
  // Belt-and-braces banner load. Safari sometimes skips fetching <img>
  // children of an element that was display:none on first paint and
  // only gets shown later, even with loading="eager". Force the fetch
  // by re-assigning the same src in a microtask once the article is
  // visible. Cheap, idempotent, no-op if the image is already loaded.
  try {
    const $img = target.querySelector(".news-post-banner img");
    if ($img) {
      const src = $img.getAttribute("src") || "";
      if (src && (!$img.complete || $img.naturalWidth === 0)) {
        // Reassign to retrigger the load. Identical URL means the
        // browser will use the cached bytes if it has them, or fetch
        // them if it doesn't — both outcomes are what we want.
        $img.removeAttribute("loading");
        $img.setAttribute("decoding", "async");
        $img.src = src;
      }
    }
  } catch {}
  // GA4 — which articles do people actually read?
  try { vaultGtagEvent("news_post_view", { news_id: id }); } catch {}
}

/** Wire the share-modal's "Share to community" button + caption count.
 *  Idempotent — safe to call multiple times. */
function wireShareToCommunity() {
  const $btn = document.getElementById("share-to-community");
  const $cap = document.getElementById("share-community-caption");
  const $cnt = document.getElementById("share-community-caption-count");
  const $status = document.getElementById("share-community-status");
  const $view = document.getElementById("share-community-view");
  if ($btn && !$btn.dataset.wired) {
    $btn.dataset.wired = "1";
    $btn.addEventListener("click", async () => {
      if (!session?.sessionToken) {
        setShareCommunityStatus("Sign in with Steam first to share.", "warn");
        return;
      }
      if (!currentShareRun) {
        setShareCommunityStatus("No run loaded.", "warn");
        return;
      }
      $btn.disabled = true;
      const caption = ($cap?.value || "").trim();
      const payload = buildHighlightPayload(currentShareRun, caption);
      const r = await HighlightsAPI.shareRun(API_BASE, session.sessionToken, payload);
      $btn.disabled = false;
      if (!r.ok) {
        if (r.error === "rate_limited") {
          setShareCommunityStatus("You can share again in a few minutes.", "warn");
        } else {
          setShareCommunityStatus("Couldn't share — try again in a moment.", "warn");
        }
        return;
      }
      setShareCommunityStatus("Shared! It's live on the Community feed.", "ok");
      if ($cap) $cap.value = "";
      if ($cnt) $cnt.textContent = "0 / 280";
      // Bring the new highlight into the cached feed at the head so a
      // tab switch shows it instantly.
      if (r.highlight) {
        lastHighlights = [r.highlight, ...lastHighlights.filter((h) => h.id !== r.highlight.id)];
      }
      // Background re-fetch to pick up server-canonical state.
      pullHighlights();
    });
  }
  if ($cap && !$cap.dataset.wired) {
    $cap.dataset.wired = "1";
    $cap.addEventListener("input", () => {
      if ($cnt) $cnt.textContent = `${($cap.value || "").length} / 280`;
    });
  }
  if ($view && !$view.dataset.wired) {
    $view.dataset.wired = "1";
    $view.addEventListener("click", (ev) => {
      ev.preventDefault();
      switchTab("highlights");
      closeShareModal();
    });
  }
}

function setShareCommunityStatus(msg, kind) {
  const $status = document.getElementById("share-community-status");
  if (!$status) return;
  $status.textContent = msg;
  $status.classList.remove("is-ok", "is-warn");
  if (kind === "ok") $status.classList.add("is-ok");
  if (kind === "warn") $status.classList.add("is-warn");
  $status.hidden = !msg;
}

/**
 * Name the browser tab after the page you are on ("Overview · SpireVault"),
 * with the pending-invite count in front ("(1) Co-op · SpireVault") so it
 * shows in the OS tab/window list even when the tab is in the background.
 */
function updateTabTitle() {
  const pending = lastInbox.filter((i) => i.status === "pending").length;
  const page = TAB_TITLES[activeTab];
  const title = page ? `${page} · ${BASE_TAB_TITLE}` : BASE_TAB_TITLE;
  document.title = pending > 0 ? `(${pending}) ${title}` : title;
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
      icon: invite.fromAvatar || "/assets/brand/crest-avatar-128-v1.png",
      tag: `spirevault-invite-${invite.id}`, // coalesces if multiple arrive
    });
  } catch { /* notification API quirks vary; never fail the poll */ }
}

/**
 * Auto-routed feed fetch:
 *   - Authed users → `/presence/roster`   (full Steam identity, for invites)
 *   - Guests       → `/presence`          (anonymized: anonId / status only)
 *
 * The server enforces the privacy boundary — guests hitting
 * `/presence/roster` get a 401. This routing just picks the right
 * URL up front so we don't surface a spurious 401 to a guest who
 * doesn't need identity fields anyway.
 *
 * Callers get back rows that are either:
 *   PresenceEntry     { steamID, personaName, avatarURL, status, ... }     — authed
 *   PublicPresenceEntry { anonId, status, inSTS2, updatedAt, note:"" }     — guest
 *
 * Renderers detect the shape via presence of `steamID` vs. `anonId`.
 */
async function fetchFeed() {
  const authed = !!(session && session.sessionToken);
  const url = authed ? `${API_BASE}/presence/roster` : `${API_BASE}/presence`;
  const r = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    headers: authed
      ? { authorization: `Bearer ${session.sessionToken}` }
      : {},
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

function updateCoopBadge() {
  const inboxCount = lastInbox.filter((i) => i.status === "pending").length;
  const $badge = document.getElementById("nav-coop-count");
  // Show the most useful number — pending invites win because they're personal.
  if (inboxCount > 0) {
    $badge.textContent = inboxCount;
    $badge.hidden = false;
    $badge.classList.add("is-urgent");
  } else if ((CoopPlay?.badgeCount() ?? 0) > 0) {
    // Players waiting in the co-op Play queue on your game branch.
    $badge.textContent = CoopPlay.badgeCount();
    $badge.hidden = false;
    $badge.classList.remove("is-urgent");
  } else {
    $badge.hidden = true;
  }
}

/** Unsubscribes this browser from co-op pings, if it ever subscribed. */
async function dropCoopPushSubscription() {
  const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
  const sub = await reg?.pushManager?.getSubscription();
  await sub?.unsubscribe();
}

/** This browser's co-op push endpoint (null if it never turned pings on). */
async function coopPushEndpoint() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
    const sub = await reg?.pushManager?.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** The longest sign-out waits for the co-op clean-up before moving on. */
const COOP_SIGNOUT_WAIT_MS = 4000;

async function signOut() {
  // Co-op Play goes first, while the session can still authorize it. Left
  // alone, the push subscription outlives the sign-out and this browser keeps
  // getting pings. One call tells the Worker which device is leaving: it
  // forgets that device, and only if no other device (a phone, say) can
  // still ping the player does it take them out of line and out of a party
  // that hasn't started. A search the phone is watching survives signing out
  // of the laptop. `keepalive` lets the request finish even if the wait
  // below runs out and the page reloads first.
  const coopAuth = { authorization: `Bearer ${session.sessionToken || "__cookie__"}` };
  const coopCleanup = (async () => {
    const endpoint = await coopPushEndpoint();
    await Promise.allSettled([
      fetch(`${API_BASE}/coop/play/signout`, {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { ...coopAuth, "content-type": "application/json" },
        body: JSON.stringify(endpoint ? { endpoint } : {}),
      }),
      dropCoopPushSubscription(),
    ]);
  })();
  // Bounded, so a slow worker or push service can't hold the sign-out up.
  await Promise.race([coopCleanup, new Promise((resolve) => setTimeout(resolve, COOP_SIGNOUT_WAIT_MS))]);

  // Three teardown calls in parallel — none of them block sign-out, so
  // wrapping them in Promise.allSettled means a single failure (worker
  // down, cookie endpoint 500'd) doesn't strand the user signed-in:
  //
  //   1. DELETE /presence  → drop them from the public roster
  //   2. DELETE /api/_session → clear the first-party cookie AND tell
  //      the worker to invalidate the session token KV row, so a stolen
  //      bearer can't be replayed even within its 30-day TTL.
  //   3. (in clearSessionAndReload below) wipe localStorage + reload.
  await Promise.allSettled([
    fetch(`${API_BASE}/presence`, {
      method: "DELETE",
      credentials: "include",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    }),
    fetch("/api/_session", {
      method: "DELETE",
      credentials: "include",
    }),
  ]);
  localStorage.removeItem(STORAGE_DRAFT);

  // Keep locally imported history AND the saved save-folder handle on
  // this device when signing out. The handle is a per-device permission
  // for the user's local SlayTheSpire2 folder — wiping it on sign-out
  // forced users into a fresh manual folder pick on every sign-in,
  // which felt completely broken. The handle is not Steam-account
  // sensitive (it points at a folder on this machine), and IDB run data
  // is already scoped per Steam ID for shared-browser privacy.
  HistoryStore.setActiveSteamID(null);
  // Signing out on purpose forgets this device's owner: the next signed-out
  // visit shows nobody's runs (a lapsed sign-in keeps them, see boot).
  try { localStorage.removeItem(STORAGE_HISTORY_OWNER); } catch { /* private mode */ }
  HistoryStore.setFallbackSteamID(null);
  sendBeacon("signout-clear", "scope=kept-history handles=kept");

  clearSessionAndReload();
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

// =========================================================================
// Global invite banner (persistent, all tabs)
// -------------------------------------------------------------------------
// Lives above every tab panel (prepended into #app-content on first
// render). Surfaces pending invites with inline Accept / Decline / Open
// Steam profile so the user never has to hop to the Co-op tab to
// respond. Dismissible per-invite-id via sessionStorage so closing the
// banner doesn't mean missing the invite — it just removes it from
// this view while the Co-op tab still shows it.
// =========================================================================

const GLOBAL_INVITE_DISMISSED_KEY = "vault.invites.dismissed";

function getDismissedInviteIds() {
  try {
    const raw = sessionStorage.getItem(GLOBAL_INVITE_DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch { return new Set(); }
}

function dismissInviteLocally(id) {
  const s = getDismissedInviteIds();
  s.add(id);
  try { sessionStorage.setItem(GLOBAL_INVITE_DISMISSED_KEY, JSON.stringify([...s])); } catch {}
}

function ensureGlobalInviteBanner() {
  let $b = document.getElementById("global-invite-banner");
  if ($b) return $b;
  $b = document.createElement("div");
  $b.id = "global-invite-banner";
  $b.className = "global-invite-banner";
  $b.hidden = true;
  $b.setAttribute("role", "region");
  $b.setAttribute("aria-label", "Pending co-op invites");
  const host = document.getElementById("app-content");
  if (host) host.insertBefore($b, host.firstChild);
  else document.body.insertBefore($b, document.body.firstChild);
  return $b;
}

function renderGlobalInviteBanner(pending) {
  const $b = ensureGlobalInviteBanner();
  const dismissed = getDismissedInviteIds();
  const visible = (pending || []).filter((i) => i.status === "pending" && !dismissed.has(i.id));
  if (!visible.length) {
    $b.hidden = true;
    $b.innerHTML = "";
    return;
  }
  $b.hidden = false;

  const desktopLikely = isDesktopLikelyToHandleSteamClient();
  const launchSTS = `steam://run/${STS2_APP_ID}`;

  $b.innerHTML = visible.map((inv) => {
    const safeAvatar = (() => {
      try {
        const u = new URL(inv.fromAvatar ?? "");
        if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
      } catch {}
      return "/assets/brand/crest-avatar-128-v1.png";
    })();
    const messageText = InviteAPI.getMessageText(inv.messageId) ?? "Wants to play.";
    const sid = inv.fromID;
    const steamProfileWeb = `https://steamcommunity.com/profiles/${esc(sid)}`;
    return `
      <div class="global-invite-row" data-invite-id="${esc(inv.id)}">
        <img class="global-invite-avatar" alt="" src="${esc(safeAvatar)}" />
        <div class="global-invite-text">
          <strong><span class="global-invite-eyebrow">Co-op invite</span> ${esc(inv.fromPersona || "Someone")} wants to play</strong>
          <span class="global-invite-msg">"${esc(messageText)}"</span>
        </div>
        <div class="global-invite-actions">
          <button class="btn-primary sm" type="button" data-invite-act="accept" data-id="${esc(inv.id)}">Accept</button>
          <button class="btn-ghost sm"   type="button" data-invite-act="decline" data-id="${esc(inv.id)}">Decline</button>
          <a class="btn-ghost sm" target="_blank" rel="noopener" href="${steamProfileWeb}" title="Open ${esc(inv.fromPersona || "this player")}'s Steam profile">Open Steam profile</a>
          ${desktopLikely ? `<a class="btn-ghost sm" href="${launchSTS}" title="Launch Slay the Spire 2">Launch STS2</a>` : ""}
        </div>
        <button class="global-invite-close" type="button" data-invite-dismiss="${esc(inv.id)}" aria-label="Dismiss (keeps the invite in Co-op)">&times;</button>
      </div>`;
  }).join("");

  // Wire buttons. Accept/decline go through the same API as the
  // Co-op tab; dismissing only hides the banner row (invite stays
  // in the inbox until explicitly accepted/declined).
  $b.querySelectorAll("button[data-invite-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.inviteAct;
      btn.disabled = true;
      const r = await InviteAPI.respondToInvite(API_BASE, session.sessionToken, id, action);
      btn.disabled = false;
      if (!r.ok) {
        toast(`Couldn't ${action}: ${r.error ?? "unknown error"}`);
        return;
      }
      if (action === "accept") {
        toast(`Accepted. Opening Steam profile…`);
        // Surface Steam profile automatically — the user accepted,
        // the obvious next step is to add them as a friend.
        const row = btn.closest(".global-invite-row");
        const link = row?.querySelector('a[href^="https://steamcommunity.com"]');
        try { link?.click(); } catch {}
      }
      await pullInbox();
    });
  });
  $b.querySelectorAll("button[data-invite-dismiss]").forEach((btn) => {
    btn.addEventListener("click", () => {
      dismissInviteLocally(btn.dataset.inviteDismiss);
      // Re-render with the dismissed id filtered out.
      renderGlobalInviteBanner(lastInbox.filter((i) => i.status === "pending"));
    });
  });
}

// =========================================================================
// History.json upload
// =========================================================================
// Tabs where dragging in a save folder makes contextual sense. On the
// community tabs (highlights / co-op / news) the user is consuming
// content rather than importing data, so a fullscreen "Drop your STS2
// save folder here" overlay is just confusing — hide it entirely on
// those tabs and silently ignore drops, so the page never grabs files
// the user dragged onto it by accident while reading.
const DROP_OVERLAY_ALLOWED_TABS = new Set([
  "overview", "characters", "ascensions", "relics", "cards", "runs", "settings", "overlay",
]);
function isDropOverlayAllowedHere() {
  return DROP_OVERLAY_ALLOWED_TABS.has(activeTab);
}

function wireDropOverlay() {
  const $ov = document.getElementById("drop-overlay");
  let dragDepth = 0;

  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    if (!isDropOverlayAllowedHere()) return;
    dragDepth++;
    $ov.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    // v200 fix (Solo_mag, Windows): we MUST preventDefault on every
    // file-bearing dragover regardless of the active tab. The previous
    // gating on isDropOverlayAllowedHere() meant that if the user
    // happened to be on a non-allow-listed tab (or a future tab we
    // forget to add to the set), the browser handled the drop natively
    // and the user saw "drag-drop is broken — nothing happens". The
    // tab-gating now only governs whether we show the overlay UI and
    // ingest; the drop handler below still swallows the file on
    // non-allowed tabs with a toast instead of navigating away.
    if (!hasFiles(e)) return;
    e.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $ov.hidden = true;
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    // On non-stat tabs (highlights, co-op, news) silently swallow the
    // drop without ingesting — prevents accidental imports while
    // browsing community content. Still preventDefault so the browser
    // doesn't navigate away to display the dropped file.
    if (!isDropOverlayAllowedHere()) {
      e.preventDefault();
      dragDepth = 0;
      $ov.hidden = true;
      toast("Switch to Recent Runs to import save files.");
      return;
    }
    e.preventDefault();
    dragDepth = 0;
    $ov.hidden = true;
    // Two paths:
    //   1. Folder drop — DataTransferItem.webkitGetAsEntry() returns a
    //      directory entry we recursively walk to find every `.run` file
    //      buried under `profile1/saves/history/`. Works in Chromium + WebKit.
    //   2. File drop — bare files, single or multi. Goes straight to ingest.
    // We try (1) first if any item is a directory; otherwise fall through
    // to (2) so a single dropped `history.json` still works one-click.
    const items = e.dataTransfer?.items;
    const files = e.dataTransfer?.files;
    // Diagnostic: Windows drops from system-attributed folders can
    // produce items where webkitGetAsEntry() returns null. Log enough
    // to triage future "drag-drop did nothing" reports.
    console.info(
      "[Vault import] drop fired:",
      `items=${items?.length || 0}`,
      `files=${files?.length || 0}`
    );
    if (items && items.length > 0) {
      const entries = [];
      let nullEntries = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind !== "file") continue;
        const entry = it.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
        else nullEntries++;
      }
      if (entries.some((en) => en.isDirectory)) {
        sendBeacon("ingest-drop-folder", `entries=${entries.length}`);
        void collectFilesFromEntries(entries).then((files) => {
          if (files.length === 0) {
            toast("No .run or .json files found in that folder. Open it and drag the inner history/ folder instead, or use the Pick files button.", { duration: 10000 });
            return;
          }
          void ingestHistoryFiles(files);
        });
        return;
      }
      // v200 fix (Solo_mag, Windows): if every webkitGetAsEntry()
      // returned null (Chromium on Windows occasionally does this for
      // items sourced from system-attributed folders) AND dataTransfer
      // .files is also empty, surface a recoverable diagnostic instead
      // of silently dying. We still try the .files fallback below first
      // in case the browser populated one and not the other.
      if (nullEntries > 0 && entries.length === 0 && (!files || files.length === 0)) {
        console.warn("[Vault import] drop: all webkitGetAsEntry() returned null and dataTransfer.files is empty", { nullEntries });
        sendBeacon("ingest-drop-null-entries", `nullEntries=${nullEntries}`);
        toast("The browser couldn't read that folder via drag-drop. Click 'Find my STS2 saves' (Windows) or 'Pick files' to import via the file picker instead.", { duration: 12000 });
        return;
      }
    }
    // Plain file(s) drop — pass them all to the multi-file ingest.
    // Note: for Chromium folder drops, dataTransfer.files is typically
    // empty (folders surface only via items[].webkitGetAsEntry()), so
    // this branch primarily catches plain file drops or browser quirks
    // where files arrived without item entries.
    if (files && files.length > 0) {
      sendBeacon("ingest-drop-files", `count=${files.length}`);
      void ingestHistoryFiles(files);
    }
  });

  function hasFiles(e) {
    const items = e.dataTransfer?.types ?? [];
    return Array.from(items).includes("Files");
  }
}

/**
 * Recursively walk a list of `FileSystemEntry` objects (returned by
 * `DataTransferItem.webkitGetAsEntry`) and yield every regular file
 * inside, filtered to plausible STS2 save extensions.
 *
 * Used by the drag-drop overlay so a user can drop their entire STS2
 * save folder (`Slay the Spire 2/`, `runs/`, or `profile1/saves/history/`)
 * and we'll pick up every `.run` file regardless of how deep it sits.
 *
 * The entire walk uses async iteration over the legacy webkit FileSystem
 * API because that's the only API browsers expose for synchronous-style
 * folder reads after a drop. It works in Chromium, WebKit (Safari), and
 * Firefox (which implements it for compatibility).
 */
async function collectFilesFromEntries(entries) {
  const out = [];
  const allowedExt = /\.(run|json|save)$/i;
  // Cap the walk so a malicious or accidental drop of `~/` doesn't
  // pull in 500k files. STS2 save folders top out around 1k runs even
  // for the most prolific players.
  const MAX_FILES = 5000;

  async function walk(entry) {
    if (out.length >= MAX_FILES) return;
    if (!entry) return;
    if (entry.isFile) {
      if (!allowedExt.test(entry.name || "")) return;
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (file) {
        // Stash the relative path on the File object so error messages
        // can say "profile1/saves/history/123.run" instead of "123.run".
        try { file.webkitRelativePath = entry.fullPath || file.name; } catch {}
        out.push(file);
      }
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns chunks of up to ~100 entries; loop until empty.
      while (true) {
        const chunk = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!chunk || chunk.length === 0) break;
        for (const child of chunk) {
          await walk(child);
          if (out.length >= MAX_FILES) return;
        }
      }
    }
  }

  for (const entry of entries) {
    await walk(entry);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function triggerFilePicker() {
  // Force-clear so re-selecting the same file fires `change`. Browsers
  // suppress the event when the value didn't appear to change, which
  // otherwise breaks the "I picked the wrong file, let me try again" flow.
  const $input = document.getElementById("history-file-input");
  if ($input) $input.value = "";
  $input?.click();
  sendBeacon("ingest-picker-opened", "input-fallback");
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

/** Stable fingerprint of a `.run` tree so the background loop skips work when nothing changed. */
function fingerprintFromFiles(files) {
  return Array.from(files || [])
    .map((f) => `${f.webkitRelativePath || f.name}:${f.size}:${f.lastModified}`)
    .sort()
    .join("\n");
}

let lastDirectoryFingerprint = "";
try {
  lastDirectoryFingerprint = localStorage.getItem(STORAGE_DIR_FP) || "";
} catch { /* private mode */ }

// Last seen file.lastModified for the saved single-file FSA handle
// (legacy `history.json` rollup path). Skips redundant re-reads when
// the file is unchanged. Folder-mode imports use lastDirectoryFingerprint.
let lastIngestedMTime = 0;

function persistDirectoryFingerprint(fp) {
  lastDirectoryFingerprint = fp;
  try { localStorage.setItem(STORAGE_DIR_FP, fp); } catch { /* private mode */ }
}

/** Persist the linked folder's display name so the "Linked" status pill
 *  in the panel-head can render synchronously without waiting for an
 *  IndexedDB round-trip. Called whenever a directory is picked / cleared. */
function rememberLinkedFolderName(name, { live = false } = {}) {
  try {
    if (name) localStorage.setItem(STORAGE_LINKED_NAME, name);
    else localStorage.removeItem(STORAGE_LINKED_NAME);
    if (name && live) localStorage.setItem(STORAGE_LINKED_LIVE, "1");
    else localStorage.removeItem(STORAGE_LINKED_LIVE);
  } catch { /* private mode */ }
}
/** True when the linked saves can be re-read without asking the user to
 *  pick them again (see STORAGE_LINKED_LIVE). */
function isLinkedFolderLive() {
  try { return localStorage.getItem(STORAGE_LINKED_LIVE) === "1"; }
  catch { return false; }
}
function getLinkedFolderName() {
  try { return localStorage.getItem(STORAGE_LINKED_NAME) || ""; }
  catch { return ""; }
}

/** Drop the persistent link entirely (handle + fingerprint + cached
 *  display name). Used by the "Disconnect" control in the panel-head
 *  when the user wants to point at a different save folder. */
async function disconnectLinkedSaves() {
  try { await HistoryStore.clearDirectoryHandle(); } catch (e) { console.warn("clearDirectoryHandle failed", e); }
  try { await HistoryStore.clearHandle(); }          catch (e) { console.warn("clearHandle failed", e); }
  try { localStorage.removeItem(STORAGE_DIR_FP); }   catch { /* private mode */ }
  rememberLinkedFolderName("");
  lastDirectoryFingerprint = "";
  lastIngestedMTime = 0;
  toast("Disconnected. Stats stay loaded; pick a folder again to re-enable auto-refresh.");
  try { renderActiveTab(); } catch { /* defensive */ }
}

// v201 rough-edge #3 (`?desktop=1` triple-fire):
// Multiple panel headers in index.html share `data-action="upload"`,
// and the dynamic empty-state / demo-banner re-renders each wire their
// own click handler on the freshly rendered buttons. When the desktop
// host bridge (or any future delegated handler) doesn't swallow the
// click, the same logical Import gesture can wind up calling
// scanForHistory() multiple times back-to-back. The native flow is
// idempotent (the second .click() just races the picker that's already
// opening), but the console fills with "[Vault import] scanForHistory
// invoked" repeats and bug reports get noisy. A short module-level
// debounce window keeps a single user gesture from doing real work
// more than once. The window is intentionally short (well under any
// legitimate retry) so the user can still re-click within a second or
// two if the first picker open was clearly missed.
let scanInFlight = false;

function scanForHistory() {
  if (scanInFlight) {
    console.info("[Vault import] scanForHistory debounced (already in flight)");
    return;
  }
  scanInFlight = true;
  setTimeout(() => { scanInFlight = false; }, 1500);

  console.info("[Vault import] scanForHistory invoked, ua=", navigator.userAgent);
  // CRITICAL: this function MUST run synchronously up to the `.click()`
  // on the hidden input. Safari only honors picker-opening clicks that
  // are inside the same JS task as the user's gesture. Any `await` here
  // (e.g. checking for a saved handle, querying permissions) consumes
  // the user gesture and Safari silently refuses to open the picker.
  // The silent re-read of saved handles still happens on page boot via
  // autoReloadHistoryIfPermitted() — this entry point is just for the
  // explicit Import button.
  const platform = detectPlatform();
  // WINDOWS QUIRK (fixed in v200, reported by Solo_mag on v0.9.9):
  // Chromium's File System Access API enforces a "well-known directory"
  // blocklist via FileSystemAccessPermissionContextImpl. %APPDATA%
  // (base::DIR_ROAMING_APP_DATA) is registered with kBlockAllChildren,
  // and STS2 saves its runs at %APPDATA%\SlayTheSpire2\…. So when a
  // Windows user picks that folder via showDirectoryPicker(), Chrome
  // pops its stock modal "Can't open this folder because it contains
  // system files" and the call rejects with AbortError — leaving the
  // user staring at a scary OS dialog with no way forward. The legacy
  // <input type="file" webkitdirectory> path goes through Chromium's
  // FileSelectHelper which has NO blocklist, so it can read the saves
  // folder cleanly. We lose the FileSystemDirectoryHandle (no silent
  // re-read on next visit) but Windows users never had a working
  // picker to begin with, so this is +∞× over the previous experience.
  if (platform === "windows") {
    sendBeacon("ingest-picker-opened", "webkitdirectory-windows-blocklist");
    console.info(
      "[Vault import] platform=windows → using webkitdirectory (skips Chromium's %APPDATA% blocklist)"
    );
    void copySavePathHint();
    triggerFolderPicker();
    return;
  }
  // macOS HAS THE SAME BLOCKLIST PROBLEM as Windows (reported live with a
  // screenshot on 2026-08-23): STS2 saves under ~/Library/Application
  // Support/…, and Chromium registers ~/Library (base::DIR_APP_DATA) with
  // kBlockAllChildren. showDirectoryPicker() therefore CANNOT grant the
  // save folder — Chrome pops "Can't open this folder because it contains
  // system files" and rejects, a hard dead-end on the app's single most
  // important flow. The webkitdirectory <input> goes through
  // FileSelectHelper (no blocklist) and opens a native NSOpenPanel where
  // ⌘⇧G paste works. Same trade as Windows: we lose the persistent handle
  // (silent re-reads), but macOS Chrome users never got that far anyway —
  // the pick itself was blocked.
  if (platform === "mac") {
    sendBeacon("ingest-picker-opened", "webkitdirectory-mac-blocklist");
    console.info(
      "[Vault import] platform=mac → using webkitdirectory (skips Chromium's ~/Library blocklist)"
    );
    void copySavePathHint();
    triggerFolderPicker();
    return;
  }
  if (typeof window.showDirectoryPicker === "function") {
    sendBeacon("ingest-picker-opened", "directory");
    console.info("[Vault import] using showDirectoryPicker (Chromium, non-Windows)");
    void scanForHistoryViaDirectoryPicker();
    return;
  }
  // FALLBACK: <input type="file" webkitdirectory>. Works on Safari and
  // Firefox. The browser opens its native folder picker, hands us a flat
  // FileList of every nested file. We filter to .run/.json/.save in the
  // change handler.
  sendBeacon("ingest-picker-opened", "webkitdirectory");
  console.info("[Vault import] using webkitdirectory fallback");
  triggerFolderPicker();
}

/** Click the hidden folder input so the browser opens its native
 *  directory picker. Same UX as showDirectoryPicker on Chromium —
 *  the user picks one folder, we receive every file inside. */
function triggerFolderPicker() {
  const $input = document.getElementById("history-folder-input");
  if (!$input) {
    // No folder input on the page (very old cached HTML). DO NOT fall
    // through to the flat single-file picker — that's exactly the
    // 1-run-import bug class. Force a hard reload so the user picks up
    // the latest HTML, then they can try again.
    console.error("[Vault import] history-folder-input missing — reloading page");
    toast("Updating to latest version… retrying import after reload.", { duration: 5000 });
    setTimeout(() => { try { window.location.reload(); } catch {} }, 1200);
    return;
  }
  console.info("[Vault import] clicking history-folder-input (webkitdirectory)");
  $input.value = "";
  $input.click();
}

/**
 * Modern directory-pick flow. Opens the OS folder picker, the user
 * navigates to (or pastes) their STS2 save folder, we recursively
 * read every `.run` file, then ingest them all in one shot.
 *
 * On subsequent visits we re-read the same folder silently (handle
 * permission was granted previously), so a returning user sees fresh
 * stats with zero clicks after they've played a few more runs.
 */
/**
 * Platform-appropriate save path → clipboard, plus a toast telling the
 * user exactly what to do inside the OS picker (which is a native modal
 * we cannot decorate). Best-effort; never blocks or throws.
 *
 * Shared by BOTH picker paths — the File System Access flow and the
 * webkitdirectory fallback — because the guidance is identical: the
 * native macOS NSOpenPanel honors ⌘⇧G paste exactly like Chrome's FSA
 * picker does, and Windows/Linux file dialogs all have a pasteable
 * location bar.
 */
async function copySavePathHint({ lead = "" } = {}) {
  const platform = detectPlatform();
  const path = savePathForPlatform();
  const prefix = lead ? `${lead} ` : "";
  if (!path) {
    if (lead) toast(lead, { duration: 9000 });
    return;
  }
  let copied = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(path);
      copied = true;
    } catch { /* clipboard blocked: the toast spells the path out instead */ }
  }
  const where = copied ? "Path copied." : `Your saves are in ${path}.`;
  const paste = copied ? "paste" : "type that path";
  // The macOS picker's button says "Select" (not "Open"); Windows says
  // "Select Folder". The walker finds steam/<id>/profile1/saves/history
  // inside whichever level is picked.
  let steps;
  if (platform === "mac") {
    steps = `In the picker press ⌘⇧G, ${paste}, press Enter, then click Select. SpireVault finds the runs inside.`;
  } else if (platform === "windows") {
    steps = `In the picker click the address bar, ${paste}, press Enter, then click Select Folder. SpireVault finds the runs inside.`;
  } else {
    steps = `In the picker press Ctrl+L, ${paste}, press Enter, then click Select. SpireVault finds the runs inside.`;
  }
  toast(`${prefix}${where} ${steps}`, { duration: 14000 });
}

async function scanForHistoryViaDirectoryPicker() {
  const platform = detectPlatform();
  await copySavePathHint();

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({
      mode: "read",
      // `id` opts the picker into Chrome's per-id "remember last
      // location" feature so a returning user lands on the folder
      // they picked last time, even when the saved handle was
      // wiped (e.g. after a clear-site-data).
      id: "sts2-saves",
      startIn: "documents",
    });
  } catch (e) {
    // AbortError is fired both when the user cancels AND when Chromium's
    // "Can't open this folder because it contains system files" modal is
    // dismissed (the latter triggered by the File System Access blocklist
    // on %APPDATA% etc.). We can't distinguish them from the error alone,
    // so we always surface a recovery toast with the drag-drop hint —
    // the worst case for a legit cancel is a single dismissable nudge,
    // which is far better than the pre-v200 "scary OS modal + silent
    // dead-end" experience reported by Solo_mag on v0.9.9.
    if (e?.name === "AbortError") {
      console.info("[Vault import] showDirectoryPicker aborted (cancel or system-files block)", e);
      sendBeacon("ingest-picker-abort", `platform=${platform}`);
      const where =
        platform === "windows" ? HISTORY_PATH_WIN_FULL
        : platform === "linux" ? HISTORY_PATH_LINUX_FULL
        : HISTORY_PATH_MAC_FULL;
      toast(
        `Picker was canceled or blocked by the browser. If you saw "Can't open this folder because it contains system files", drag the SlayTheSpire2 folder onto this page instead — it bypasses that block. Your saves: ${where}`,
        { duration: 14000 }
      );
    } else {
      console.warn("directory picker failed", e);
      sendBeacon("ingest-picker-error", `platform=${platform} name=${e?.name || "Error"}`);
      toast("Couldn't open the folder picker. Drag your SlayTheSpire2 folder onto this page instead, or click Pick files as a fallback.", { duration: 12000 });
    }
    return;
  }

  // Persist the handle FIRST — before the (possibly slow) recursive
  // walk and parse. This way, even if scanning crashes mid-flight or
  // the user closes the tab during ingest, the next visit can still
  // re-read silently. Without this, a single failed ingest meant
  // forever re-prompting the user with the picker.
  try {
    await HistoryStore.saveDirectoryHandle(dirHandle);
  } catch (e) {
    console.warn("saveDirectoryHandle (early) failed", e);
  }

  // Upgrade to PERSISTENT permission while we still hold the user
  // gesture from showDirectoryPicker. Chrome 122+ shows a 3-way
  // prompt with "Allow on every visit" — granting that is what
  // makes auto-refresh work on subsequent tab loads. Without this
  // call, queryPermission returns "prompt" forever after a reload.
  try {
    if (typeof dirHandle.requestPermission === "function") {
      await tipAllowEveryVisit(dirHandle);
      await dirHandle.requestPermission({ mode: "read" });
    }
  } catch (e) {
    console.warn("requestPermission on directory failed", e);
  }
  try {
    rememberLinkedFolderName(dirHandle.name || "STS2 saves", { live: true });
  } catch { /* private mode */ }

  // Walk the directory recursively, collect every `.run` (or .json) file.
  toast("Scanning folder…");
  const files = await collectFilesFromDirectoryHandle(dirHandle);
  if (files.length === 0) {
    // Specific diagnostic — the previous "didn't find anything" toast
    // didn't tell the user where to look next. Three real cases:
    //   1. Wrong folder (Steam install dir, not save dir) — the most
    //      common failure. Surface the exact deep path they should
    //      have ended up in.
    //   2. Right folder, but no runs played yet — common for first-
    //      time STS2 buyers visiting our site.
    //   3. Picked a parent and the walker hit its 8-deep cap — very
    //      rare, but the diagnostic should still help.
    const platform = detectPlatform();
    const where =
      platform === "windows" ? HISTORY_PATH_WIN_FULL
      : platform === "linux" ? HISTORY_PATH_LINUX_FULL
      : HISTORY_PATH_MAC_FULL;
    sendBeacon("ingest-empty-folder", `picked=${dirHandle.name || ""} platform=${platform}`);
    // Friendlier diagnosis. The two real failure modes:
    //   1. User picked the right parent BUT haven't played any STS2 runs
    //      yet — most common for first-time visitors who just installed
    //      the game. Tell them to play one run and come back.
    //   2. User picked a wrong folder (Steam install dir, Cluely, etc.).
    //      Surface the EXACT deep path so they know where to navigate.
    // For macOS specifically: also nudge them to drill down into
    // `steam/<your-id>/profile1/saves/history/` because the parent
    // SlayTheSpire2/ has no `.run` files at the top level.
    const drillHint = platform === "mac"
      ? "STS2 buries them at steam/<your-id>/profile1/saves/history/ inside that folder. Try drilling into 'steam' first."
      : platform === "windows"
        ? "STS2 stores them under steam\\<your-id>\\profile1\\saves\\history\\."
        : "STS2 stores them under steam/<your-id>/profile1/saves/history/.";
    toast(
      `No .run files in "${dirHandle.name || "that folder"}". ${drillHint} Or drag the whole SlayTheSpire2 folder from Finder onto this page — that always works.`,
      { duration: 14000 }
    );
    return;
  }
  const ok = await ingestHistoryFiles(files);
  if (!ok) return;
  persistDirectoryFingerprint(fingerprintFromFiles(files));
  // Re-render headers so the "Linked" pill shows up immediately.
  try { renderActiveTab(); } catch { /* defensive */ }
}

/**
 * Recursive walk over a `FileSystemDirectoryHandle`. Pulled from the
 * directory-picker path so the periodic auto-refresh loop can re-walk
 * the same folder later without prompting the user again.
 */
async function collectFilesFromDirectoryHandle(dirHandle) {
  const out = [];
  // Same safety cap as the drag-drop walker. Caps an accidental drop
  // of the entire user home dir from filling memory with millions of
  // unrelated files.
  const MAX_FILES = 5000;
  const allowedExt = /\.(run|json|save)$/i;

  async function walk(handle, prefix, depth) {
    if (out.length >= MAX_FILES) return;
    if (depth > 8) return; // sanity: STS2 saves are at most 4 deep
    for await (const [name, entry] of handle.entries()) {
      if (out.length >= MAX_FILES) break;
      if (entry.kind === "file") {
        if (!allowedExt.test(name)) continue;
        try {
          const file = await entry.getFile();
          // Path label so error messages reference where in the tree
          // a bad file came from.
          try { file.webkitRelativePath = `${prefix}${name}`; } catch {}
          out.push(file);
        } catch (e) {
          console.warn("[Vault] could not read", name, e);
        }
      } else if (entry.kind === "directory") {
        // Skip Steam's `cloud/` subfolder which holds dummy backup
        // copies that aren't real runs.
        if (name === "cloud" || name === "screenshots") continue;
        await walk(entry, `${prefix}${name}/`, depth + 1);
      }
    }
  }
  await walk(dirHandle, "", 0);
  return out;
}

/**
 * Multi-file picker fallback for browsers that don't support
 * showDirectoryPicker (Safari, Firefox).
 */
async function scanForHistoryViaFilePicker() {
  let pickedHandles;
  try {
    pickedHandles = await window.showOpenFilePicker({
      types: [
        { description: "STS2 run save", accept: { "application/json": [".run", ".json", ".save"] } },
      ],
      multiple: true,
      excludeAcceptAllOption: false,
      id: "sts2-saves",
      startIn: "documents",
    });
  } catch (e) {
    if (e?.name !== "AbortError") {
      console.warn("file picker failed", e);
      toast("Couldn't open the file picker. Try Import as a fallback.");
    }
    return;
  }

  // Save the FIRST file handle eagerly + upgrade to persistent
  // permission while we still own the user gesture. Mirrors what we
  // do in the directory-picker path; without this the file-handle
  // path quietly degrades to "import every time, no auto refresh".
  if (pickedHandles.length === 1) {
    try { await HistoryStore.saveHandle(pickedHandles[0]); }
    catch (e) { console.warn("saveHandle (early) failed", e); }
    try {
      if (typeof pickedHandles[0].requestPermission === "function") {
        await tipAllowEveryVisit(pickedHandles[0]);
        await pickedHandles[0].requestPermission({ mode: "read" });
      }
    } catch (e) { console.warn("requestPermission on file failed", e); }
    try { localStorage.removeItem(STORAGE_DIR_FP); } catch { /* private mode */ }
    lastDirectoryFingerprint = "";
    rememberLinkedFolderName(pickedHandles[0].name || "history.json", { live: true });
  }

  const files = [];
  for (const h of pickedHandles) {
    try { files.push(await h.getFile()); } catch (e) { console.warn("getFile failed", e); }
  }
  if (files.length === 0) return;
  const ok = await ingestHistoryFiles(files);
  if (ok) {
    try { renderActiveTab(); } catch { /* defensive */ }
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
async function autoReloadHistoryIfPermitted({
  silent = false,
  allowPermissionPrompt = false,
  bypassFingerprint = false,
} = {}) {
  let dirHandle = null;
  try {
    dirHandle = await HistoryStore.loadDirectoryHandle();
  } catch (e) {
    console.warn("autoReloadHistoryIfPermitted: loadDirectoryHandle failed", e);
  }
  if (dirHandle) {
    return autoReloadHistoryFromDirectory(dirHandle, { silent, allowPermissionPrompt, bypassFingerprint });
  }
  return autoReloadHistoryFromFileHandle({ silent, allowPermissionPrompt });
}

async function autoReloadHistoryFromDirectory(dirHandle, { silent, allowPermissionPrompt, bypassFingerprint }) {
  publishAutoRefreshState({
    phase: "running",
    lastCheckedAt: Date.now(),
    linkedTarget: dirHandle.name || getLinkedFolderName() || "",
  });
  let perm = "prompt";
  try {
    perm = await dirHandle.queryPermission({ mode: "read" });
  } catch (e) {
    console.warn("autoReloadHistoryFromDirectory: queryPermission failed", e);
    publishAutoRefreshState({ phase: "error" });
    return false;
  }
  if (perm !== "granted") {
    if (!allowPermissionPrompt) {
      // The browser dropped the grant. Surface this to the user — it's
      // the single most common reason auto-refresh "stops working".
      publishAutoRefreshState({ phase: "paused-permission" });
      return false;
    }
    try {
      tipAllowEveryVisit();
      perm = await dirHandle.requestPermission({ mode: "read" });
    } catch (e) {
      console.warn("autoReloadHistoryFromDirectory: requestPermission failed", e);
      publishAutoRefreshState({ phase: "paused-permission" });
      return false;
    }
    if (perm !== "granted") {
      publishAutoRefreshState({ phase: "paused-permission" });
      return false;
    }
  }

  let files;
  try {
    files = await collectFilesFromDirectoryHandle(dirHandle);
  } catch (e) {
    console.warn("autoReloadHistoryFromDirectory: collect failed", e);
    publishAutoRefreshState({ phase: "error" });
    return false;
  }
  if (files.length === 0) {
    publishAutoRefreshState({ phase: "ok", lastSuccessAt: Date.now(), lastNewCount: 0 });
    return false;
  }

  const fp = fingerprintFromFiles(files);
  if (silent && !bypassFingerprint && lastDirectoryFingerprint && fp === lastDirectoryFingerprint) {
    // No change since the last successful pass — still a healthy
    // outcome, just nothing new on disk. Mark the state as "ok" so
    // the pill ticks the timestamp forward.
    publishAutoRefreshState({ phase: "ok", lastSuccessAt: Date.now(), lastNewCount: 0 });
    return false;
  }

  const beforeIds = new Set(parsedRuns.map((r) => r.id));
  const ok = await ingestHistoryFiles(files, { silent });
  if (ok) {
    persistDirectoryFingerprint(fp);
    const newCount = parsedRuns.filter((r) => !beforeIds.has(r.id)).length;
    publishAutoRefreshState({ phase: "ok", lastSuccessAt: Date.now(), lastNewCount: newCount });
    if (silent && newCount > 0) {
      // Quiet but visible confirmation that the silent loop did
      // something useful. The Recent Runs nav badge is already
      // pulsing for the unread state; this is the toast layer so
      // users on other tabs see it too.
      toast(`${newCount} new run${newCount === 1 ? "" : "s"} auto-loaded.`);
      vaultGtagEvent("auto_refresh_picked_up", { runs: newCount });
    }
  } else {
    publishAutoRefreshState({ phase: "error" });
  }
  return ok;
}

async function autoReloadHistoryFromFileHandle({ silent, allowPermissionPrompt }) {
  if (!HistoryStore.supportsFSA()) {
    publishAutoRefreshState({ phase: "off" });
    return false;
  }
  let handle;
  try {
    handle = await HistoryStore.loadHandle();
  } catch (e) {
    console.warn("autoReloadHistoryFromFileHandle: loadHandle failed", e);
    publishAutoRefreshState({ phase: "error" });
    return false;
  }
  if (!handle) {
    // No file handle and no directory handle — there's literally
    // nothing for the loop to read. Publish "off" so the pill stays
    // hidden instead of claiming "auto-refresh on" while doing nothing.
    publishAutoRefreshState({ phase: "off" });
    return false;
  }

  publishAutoRefreshState({
    phase: "running",
    lastCheckedAt: Date.now(),
    linkedTarget: handle.name || "history.json",
  });

  let perm = "prompt";
  try {
    perm = await handle.queryPermission({ mode: "read" });
  } catch (e) {
    console.warn("autoReloadHistoryFromFileHandle: queryPermission failed", e);
    publishAutoRefreshState({ phase: "error" });
    return false;
  }
  if (perm !== "granted") {
    if (!allowPermissionPrompt) {
      publishAutoRefreshState({ phase: "paused-permission" });
      return false;
    }
    try {
      tipAllowEveryVisit();
      perm = await handle.requestPermission({ mode: "read" });
    } catch (e) {
      console.warn("autoReloadHistoryFromFileHandle: requestPermission failed", e);
      publishAutoRefreshState({ phase: "paused-permission" });
      return false;
    }
    if (perm !== "granted") {
      publishAutoRefreshState({ phase: "paused-permission" });
      return false;
    }
  }

  let file;
  try {
    file = await handle.getFile();
  } catch (e) {
    console.warn("autoReloadHistoryFromFileHandle: getFile failed", e);
    publishAutoRefreshState({ phase: "error" });
    return false;
  }
  const mtime = file.lastModified || 0;
  if (silent && !allowPermissionPrompt && mtime > 0 && mtime === lastIngestedMTime) {
    publishAutoRefreshState({ phase: "ok", lastSuccessAt: Date.now(), lastNewCount: 0 });
    return false;
  }
  const beforeIds = new Set(parsedRuns.map((r) => r.id));
  const ok = await ingestHistoryFile(file, { silent });
  if (ok) {
    lastIngestedMTime = mtime;
    const newCount = parsedRuns.filter((r) => !beforeIds.has(r.id)).length;
    publishAutoRefreshState({ phase: "ok", lastSuccessAt: Date.now(), lastNewCount: newCount });
    if (silent && newCount > 0) {
      toast(`${newCount} new run${newCount === 1 ? "" : "s"} auto-loaded.`);
      vaultGtagEvent("auto_refresh_picked_up", { runs: newCount });
    }
  } else {
    publishAutoRefreshState({ phase: "error" });
  }
  return ok;
}

/**
 * Header "Refresh" control: re-read the linked save folder or rollup file,
 * prompting for permission if the tab never got a persistent grant.
 */
async function reloadSavedHistoryInteractive() {
  // With SpireVault Sync connected, Refresh reads the whole save folder again
  // through it: no folder picker.
  if (SyncBridge.isConnected()) {
    void SyncBridge.syncNow({ announce: true });
    return;
  }
  // Safari and Firefox never keep a way back into the folder. Decide before
  // any await: Safari only opens a picker inside the click's own task.
  if (!HistoryStore.supportsFSA()) {
    repickSaveFolder();
    return;
  }
  let hasDir = null;
  let hasFile = null;
  try {
    hasDir = await HistoryStore.loadDirectoryHandle();
  } catch { /* ignore */ }
  try {
    hasFile = await HistoryStore.loadHandle();
  } catch { /* ignore */ }
  if (!hasDir && !hasFile) {
    repickSaveFolder();
    return;
  }
  const before = new Set(parsedRuns.map((r) => r.id));
  const ok = await autoReloadHistoryIfPermitted({
    silent: true,
    allowPermissionPrompt: true,
    bypassFingerprint: true,
  });
  if (!ok) {
    toast("Could not read your saves. Grant access if the browser asks, or pick the folder again.");
    return;
  }
  let newRuns = 0;
  for (const r of parsedRuns) {
    if (!before.has(r.id)) newRuns += 1;
  }
  if (newRuns === 0 && !isDemoMode) {
    toast("Already up to date.");
  }
}

/**
 * Refresh with no saved way into the save folder: say why the picker is
 * opening, copy the folder's path, and open it. Mac and Windows Chrome
 * always land here (Chromium blocks ~/Library and %APPDATA% from lasting
 * access, so those reads go through a one-time folder pick), and so do
 * Safari and Firefox. Synchronous up to the picker on purpose.
 */
/** True where the browser can keep a link to the save folder and re-read
 *  it by itself: Chromium on Linux and ChromeOS. On a Mac or Windows the
 *  folder sits under ~/Library or AppData, which Chromium will not hand a
 *  lasting folder link for, so the app reads it with a one-off folder pick
 *  and every batch of new runs needs another. Safari and Firefox have no
 *  folder access at all. */
function canKeepSaveFolder() {
  const platform = detectPlatform();
  return platform !== "mac" && platform !== "windows" && typeof window.showDirectoryPicker === "function";
}

function repickSaveFolder() {
  if (canKeepSaveFolder()) {
    // Chromium on Linux and ChromeOS keeps a handle: the Import flow links
    // the folder so it refreshes by itself from then on.
    scanForHistory();
    return;
  }
  const lead = getLinkedFolderName()
    ? "Your browser can't re-read the save folder by itself, so pick it again."
    : "This browser hasn't read your save folder yet, so pick it to add your newest runs.";
  void copySavePathHint({ lead });
  triggerFolderPicker();
}

// How often the auto-refresh loop re-checks linked saves (folder or
// history.json) for new runs. 30s balances "feels live" vs. disk churn.
// Was 60s — bumped down because users completing a run want their stats
// refreshed *fast*, not "in the next minute".
// How often the background loop re-reads the linked save folder (or
// rollup file) for new runs while the user is mid-session in STS2.
//
// Was 60s → 30s → now 8s. A user with a 2-win streak in Silent A3
// alt-tabbed back to the browser and his fresh victory was nowhere on
// the Overview — he had to manually re-pick the folder. With STS2
// fsync'ing the new `.run` file the moment a run ends, an 8s poll
// drops the worst-case lag from "Continue" in-game to "live on the
// page" to a single heartbeat.
//
// Cost: the FSA walk + fingerprint compare is local disk and a few
// hundred stat() calls — measured <12ms on the same Mac running STS2
// — so 8s vs 30s is no measurable battery hit. Safari/Firefox don't
// run this loop at all (no FSA), so the change is Chromium-only.
const HISTORY_REREAD_INTERVAL_MS = 8_000;
let historyRereadTimer = null;

/**
 * Auto-refresh state.
 *
 * Why we surface this to the UI: in production users were seeing stale
 * stats for hours because the `setInterval` loop *was* firing — but the
 * browser had silently downgraded the FSA permission from "granted"
 * back to "prompt" between sessions, so every silent attempt no-op'd
 * with no user-visible signal. From the user's POV, "auto-refresh is
 * broken" is indistinguishable from "auto-refresh isn't running".
 *
 * Phases:
 *   - "off"               :  user is on Safari/Firefox (no FSA), or no
 *                            handle linked yet — auto-refresh genuinely
 *                            cannot run.
 *   - "ok"                :  last attempt succeeded (or saw nothing new).
 *   - "paused-permission" :  handle exists but browser dropped the
 *                            permission. One click resumes.
 *   - "running"           :  currently checking the linked source.
 *   - "error"             :  last attempt threw — usually a transient
 *                            disk read error.
 *
 * `lastSuccessAt` is the user-meaningful timestamp ("last checked X
 * ago"). `lastNewCount` is the number of new runs the most recent
 * successful refresh discovered — used by the toast notification.
 */
let autoRefreshState = {
  phase: "off",
  lastCheckedAt: 0,
  lastSuccessAt: 0,
  lastNewCount: 0,
  linkedTarget: "",
};
const autoRefreshSubscribers = new Set();
function publishAutoRefreshState(patch) {
  const prevPhase = autoRefreshState.phase;
  Object.assign(autoRefreshState, patch);
  // If the auto-refresh recovered (paused/error → ok), clear the
  // session dismiss so a future failure shows the banner again. The
  // banner is "tell me once" per problem occurrence, not "tell me once
  // per session" — that would be too quiet.
  if ((prevPhase === "paused-permission" || prevPhase === "error") &&
      (autoRefreshState.phase === "ok" || autoRefreshState.phase === "running")) {
    window.__autoRefreshBannerDismissed = false;
  }
  refreshAutoRefreshPill();
  renderSyncPill();
  // The in-tab pill ONLY renders on Recent Runs. When the browser
  // silently drops the FSA permission grant (common on Chromium after
  // restart / sleep), a user on Overview has zero signal that the
  // auto-refresh has stopped working — they reach for the manual
  // Import button because nothing on the page suggests anything is
  // broken. The global banner is the always-visible hook for
  // paused/error states regardless of which tab is active.
  try { refreshAutoRefreshGlobalBanner(); } catch (e) { console.warn("auto-refresh global banner failed", e); }
  for (const fn of autoRefreshSubscribers) {
    try { fn(autoRefreshState); } catch (e) { console.warn("auto-refresh subscriber threw", e); }
  }
}

/** Render (or update) the always-visible global banner. Idempotent —
 *  safe to call on every state change. The banner is injected once into
 *  `<body>` and persists across tab switches so the user sees a clear
 *  "Auto-refresh paused — Resume" prompt from any view. */
function refreshAutoRefreshGlobalBanner() {
  const s = autoRefreshState;
  const visible = s.phase === "paused-permission" || s.phase === "error";

  let $banner = document.getElementById("auto-refresh-global-banner");
  if (!visible) {
    if ($banner) $banner.remove();
    return;
  }
  if (!$banner) {
    $banner = document.createElement("div");
    $banner.id = "auto-refresh-global-banner";
    document.body.appendChild($banner);
  }
  const target = s.linkedTarget ? esc(s.linkedTarget) : "your linked save folder";
  if (s.phase === "paused-permission") {
    $banner.className = "auto-refresh-global-banner is-paused";
    $banner.innerHTML = `
      <span class="auto-refresh-global-dot" aria-hidden="true"></span>
      <div class="auto-refresh-global-text">
        <strong>Auto-refresh paused</strong>
        <span>The browser dropped access to ${target}. One click reconnects — no need to re-pick the folder.</span>
      </div>
      <button class="btn-primary auto-refresh-global-cta" type="button" data-action="resume-auto-refresh">Resume auto-refresh</button>
      <button class="auto-refresh-global-close" type="button" data-action="dismiss-auto-refresh-banner" aria-label="Dismiss until next state change">×</button>`;
  } else {
    $banner.className = "auto-refresh-global-banner is-error";
    $banner.innerHTML = `
      <span class="auto-refresh-global-dot" aria-hidden="true"></span>
      <div class="auto-refresh-global-text">
        <strong>Auto-refresh hit a snag</strong>
        <span>Last check ${esc(relativeAgo(s.lastCheckedAt))} — will retry automatically. Click Retry to push it now.</span>
      </div>
      <button class="btn-primary auto-refresh-global-cta" type="button" data-action="resume-auto-refresh">Retry now</button>
      <button class="auto-refresh-global-close" type="button" data-action="dismiss-auto-refresh-banner" aria-label="Dismiss until next state change">×</button>`;
  }
  // Honor a session-scoped dismiss flag so users who don't want the
  // banner right now aren't nagged on every state ping. Cleared on
  // page reload (we want a fresh check to surface a real problem).
  if (window.__autoRefreshBannerDismissed) $banner.classList.add("is-hidden");
}

/** Re-paint the auto-refresh status pill that lives above the Recent
 *  Runs list. We re-render JUST the pill (not the whole panel) so the
 *  UI doesn't visibly thrash every 30s when the timer ticks. */
function refreshAutoRefreshPill() {
  const $pill = document.getElementById("auto-refresh-pill");
  if (!$pill) return;
  $pill.outerHTML = renderAutoRefreshPill();
}

/** Format "Xs ago" / "Xm ago" / "Xh ago" relative timestamp. */
function relativeAgo(ts) {
  if (!ts) return "never";
  const dt = Math.max(0, Date.now() - ts);
  if (dt < 5_000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  return `${Math.round(dt / 3_600_000)}h ago`;
}

/** Build the auto-refresh status pill HTML. Phase-aware: green dot
 *  when active, orange when paused (with a one-click Resume button),
 *  hidden when there's no FSA / nothing linked. */
function renderAutoRefreshPill() {
  const s = autoRefreshState;
  if (s.phase === "off") {
    // Nothing to show — this is the "Safari / no handle" state. The
    // empty-state hero already explains how to import in that case.
    return `<div id="auto-refresh-pill" class="auto-refresh-pill is-off" hidden></div>`;
  }
  if (s.phase === "paused-permission") {
    const target = s.linkedTarget ? esc(s.linkedTarget) : "your linked folder";
    return `
      <div id="auto-refresh-pill" class="auto-refresh-pill is-paused" role="status">
        <span class="auto-refresh-dot"></span>
        <div class="auto-refresh-text">
          <strong>Auto-refresh paused</strong>
          <span class="auto-refresh-sub">The browser revoked access to ${target}. One click resumes.</span>
        </div>
        <button class="btn-primary auto-refresh-resume" type="button" data-action="resume-auto-refresh">Resume</button>
      </div>`;
  }
  if (s.phase === "error") {
    return `
      <div id="auto-refresh-pill" class="auto-refresh-pill is-error" role="status">
        <span class="auto-refresh-dot"></span>
        <div class="auto-refresh-text">
          <strong>Auto-refresh hit a snag</strong>
          <span class="auto-refresh-sub">Last checked ${esc(relativeAgo(s.lastCheckedAt))} — will retry.</span>
        </div>
        <button class="btn-ghost auto-refresh-retry" type="button" data-action="resume-auto-refresh">Retry now</button>
      </div>`;
  }
  // Default: "ok" / "running" — quiet green status pill.
  const ts = s.lastSuccessAt || s.lastCheckedAt;
  const label = s.phase === "running" ? "Checking now…" : `Last checked ${esc(relativeAgo(ts))}`;
  return `
    <div id="auto-refresh-pill" class="auto-refresh-pill is-ok" role="status">
      <span class="auto-refresh-dot"></span>
      <div class="auto-refresh-text">
        <strong>Auto-refresh on</strong>
        <span class="auto-refresh-sub">${label}${s.linkedTarget ? ` · ${esc(s.linkedTarget)}` : ""}</span>
      </div>
    </div>`;
}

/** Refresh just the relative-time text inside the pill so it updates
 *  even when no auto-refresh fires (e.g. the user is staring at the
 *  Recent Runs tab between ticks). Cheap — single DOM write per
 *  10-second interval. */
setInterval(() => {
  const $pill = document.getElementById("auto-refresh-pill");
  if (!$pill || $pill.hidden) return;
  if (autoRefreshState.phase !== "ok" && autoRefreshState.phase !== "running") return;
  refreshAutoRefreshPill();
}, 10_000);

/** Wire the one-click Resume button (event-delegated so re-renders
 *  don't lose it) and a global activation listener that opportunistically
 *  re-requests permission whenever the user interacts and the state is
 *  paused. Browsers honor `requestPermission` only inside a user
 *  activation gesture — this is the smallest possible "ask once, ask
 *  cheaply" UX. */
function wireAutoRefreshUI() {
  if (window.__autoRefreshUIWired) return;
  window.__autoRefreshUIWired = true;

  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('[data-action="resume-auto-refresh"]')) return;
    e.preventDefault();
    void resumeAutoRefresh({ fromButton: true });
  });

  // Dismiss button on the global banner — hides for the rest of the
  // session. A new state transition (e.g. paused → ok → paused again)
  // rebuilds the banner from scratch via refreshAutoRefreshGlobalBanner
  // and we deliberately re-show it because that's a fresh problem.
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('[data-action="dismiss-auto-refresh-banner"]')) return;
    e.preventDefault();
    window.__autoRefreshBannerDismissed = true;
    document.getElementById("auto-refresh-global-banner")?.remove();
  });

  // Opportunistic: any pointerdown / keydown counts as a user gesture,
  // so when we know we're paused-permission we silently piggyback on
  // the next interaction to ask for the grant. Browsers explicitly
  // allow requestPermission inside the same task as a user activation.
  // We DON'T attach this until the state is paused so we don't pay the
  // listener cost in the happy path.
  let oneShotArmed = false;
  function tryArm() {
    if (autoRefreshState.phase !== "paused-permission") return;
    if (oneShotArmed) return;
    oneShotArmed = true;
    const handler = (e) => {
      // Don't burn the gesture on the Resume button itself — the click
      // handler above will run with its own gesture chain.
      if (e.target instanceof Element && e.target.closest('[data-action="resume-auto-refresh"]')) {
        return;
      }
      document.removeEventListener("pointerdown", handler, true);
      document.removeEventListener("keydown", handler, true);
      oneShotArmed = false;
      void resumeAutoRefresh({ fromButton: false });
    };
    document.addEventListener("pointerdown", handler, true);
    document.addEventListener("keydown", handler, true);
  }
  // Re-evaluate every state change via the subscriber list.
  autoRefreshSubscribers.add(tryArm);
  tryArm();
}

/** Re-request permission inside a user gesture and run a single
 *  refresh cycle. On success we transition the state to "ok" and
 *  toast; on failure we stay paused. */
async function resumeAutoRefresh({ fromButton } = {}) {
  publishAutoRefreshState({ phase: "running", lastCheckedAt: Date.now() });
  const ok = await autoReloadHistoryIfPermitted({
    silent: true,
    allowPermissionPrompt: true,
    bypassFingerprint: true,
  });
  if (ok) {
    publishAutoRefreshState({ phase: "ok", lastSuccessAt: Date.now() });
    if (fromButton) toast("Auto-refresh resumed.");
  } else {
    publishAutoRefreshState({ phase: "paused-permission", lastCheckedAt: Date.now() });
    if (fromButton) toast("Couldn't access your save folder — pick it again from the Overview tab.");
  }
}

/** Start the periodic background auto-refresh loop. Runs on Chromium-class
 *  browsers (File System Access API); on Safari / Firefox this is a no-op
 *  and the user has to click Import to pull in new runs after playing.
 *
 *  Triggered events:
 *   - setInterval every HISTORY_REREAD_INTERVAL_MS
 *   - visibilitychange → visible (so a fresh session of STS2 in the
 *     background, alt-tab back, sees fresh stats immediately)
 *   - pageshow with persisted=true (back/forward cache restore)
 */
function startHistoryAutoRefresh() {
  const canFSA =
    HistoryStore.supportsFSA() || typeof window.showDirectoryPicker === "function";
  if (!canFSA) {
    // Safari / Firefox: no File System Access API → we cannot poll the
    // disk between user gestures. The toolbar's freshness line says how
    // old the saves are and Refresh re-picks the folder with its path
    // copied; a floating "Fresh runs may be on disk" banner used to pop
    // up on every focus as well, and players read it as nagging.
    publishAutoRefreshState({ phase: "off" });
    return;
  }
  // Snapshot the linked target name so the pill can display it.
  publishAutoRefreshState({ linkedTarget: getLinkedFolderName() || "" });
  wireAutoRefreshUI();
  if (historyRereadTimer) return;
  historyRereadTimer = setInterval(() => {
    // Bypass the fingerprint cache when we don't currently have an
    // in-progress run on screen. This catches the race window where
    // STS2 momentarily deletes `current_run.save` (e.g. mid run-end
    // rename into `history/<ts>.run`) and our last commit nulled out
    // `currentRun`. Without bypass, the directory fingerprint can lock
    // us into "no live run" until something else changes on disk —
    // which for a player mid-fight can be a long time.
    void autoReloadHistoryIfPermitted({
      silent: true,
      bypassFingerprint: !currentRun,
    });
  }, HISTORY_REREAD_INTERVAL_MS);
}

/**
 * Parse a single user-provided file into a list of normalized runs.
 *
 * Accepts both:
 *   - The legacy `history.json` rollup The Vault macOS CLI writes.
 *   - A raw STS2 `.run` save file (one run, written by Slay the Spire 2
 *     itself into `…/profile1/saves/history/<unix>.run`).
 *
 * Returns `{ ok: true, runs: [...] }` on success, or
 * `{ ok: false, error: "..." }` on a parsing problem. Never throws.
 *
 * Used by both single-file and multi-file ingest so the validation +
 * decoding logic lives in exactly one place.
 */
async function parseOneFile(file) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "Browser handed us an invalid file object." };
  }
  if (file.size === 0) {
    return { ok: false, error: `${file.name || "File"} is empty (0 bytes).` };
  }
  // STS2 `.run` files are typically <100 KB. The rollup history.json can
  // grow into the megabytes for prolific players. 50 MB is generous for
  // both and protects us from somebody accidentally dropping a video.
  if (file.size > 50 * 1024 * 1024) {
    return { ok: false, error: `${file.name || "File"} is huge (>50 MB).` };
  }

  let text;
  try {
    text = await file.text();
  } catch (e) {
    return { ok: false, error: `Couldn't read ${file.name || "file"}: ${e?.message || ""}` };
  }
  if (!text || !text.trim()) {
    return { ok: false, error: `${file.name || "File"} is empty.` };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${file.name || "File"} isn't valid JSON: ${e?.message || ""}` };
  }

  return await Stats.extractRuns(parsed);
}

/**
 * Ingest one or more save files. The new primary entry point — accepts
 * any combination of `.run` files and rollup `history.json` files.
 *
 * Why this matters: STS2 writes one `.run` file per game. Until now the
 * web app only accepted the consolidated rollup that the macOS CLI
 * produces, which silently locked out every Windows / Linux / iOS user
 * and every Mac user who hadn't installed the desktop app first. This
 * function now accepts the raw save format directly so anyone can drop
 * their STS2 save folder and see their stats.
 */
async function ingestHistoryFiles(files, { silent = false, merge = false } = {}) {
  const list = Array.from(files || []).filter((f) => f && typeof f.size === "number");
  if (list.length === 0) {
    sendBeacon("ingest-files-empty", silent ? "silent" : "interactive");
    if (!silent) toast("No files to read.");
    return false;
  }

  // Filter to plausible JSON / .run files. Saves a wasted pass on
  // anything that obviously isn't ours (e.g. a stray .DS_Store that
  // came along with a folder drop).
  const plausible = list.filter((f) => {
    const name = (f.name || "").toLowerCase();
    return name.endsWith(".json") || name.endsWith(".run") || name.endsWith(".save");
  });
  if (plausible.length === 0) {
    sendBeacon("ingest-no-plausible", `chosen=${list.length}`);
    if (!silent) toast(`None of those ${list.length} file(s) look like STS2 saves (.run or history.json).`);
    return false;
  }
  // Split interactive vs. auto-refresh into separate reason codes.
  //
  // The daily KV counters behind the admin import funnel key on the reason
  // only — `detail` is stored on sampled event rows, not aggregated. So while
  // `silent=1` in a detail string is readable one row at a time, it is
  // invisible to the funnel, and background auto-refresh ingests would show up
  // as import attempts nobody made. That inflates the later stages above the
  // earlier ones and produces conversion rates over 100%.
  sendBeacon(
    silent ? "ingest-files-chosen-auto" : "ingest-files-chosen",
    `count=${plausible.length}`
  );

  console.info(`[Vault] ingest start: ${plausible.length} file(s)${list.length > plausible.length ? ` (filtered ${list.length - plausible.length} non-save file(s))` : ""}`);
  if (!silent) {
    if (plausible.length === 1) {
      toast(`Reading ${plausible[0].name}…`);
    } else {
      toast(`Reading ${plausible.length} save files…`);
    }
  }

  // Parse every file in parallel. A bad file in the middle of a folder
  // shouldn't blow up the rest of the import — log and keep going.
  const results = await Promise.all(plausible.map((f) => parseOneFile(f)));

  // Tally: collect every run that came out, dedupe by id (so dropping
  // both the rollup and the raw `.run` folder doesn't double-count),
  // remember the first error to surface if we got zero runs total.
  const seenIds = new Set();
  const runs = [];
  let firstError = null;
  let okFiles = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r?.ok) {
      if (!firstError) firstError = r?.error || `Couldn't parse ${plausible[i].name}.`;
      continue;
    }
    okFiles += 1;
    for (const run of r.runs) {
      if (!run?.id || seenIds.has(run.id)) continue;
      seenIds.add(run.id);
      runs.push(run);
    }
  }

  if (runs.length === 0) {
    console.error("[Vault] ingest produced zero runs", { firstError, results });
    sendBeacon("ingest-runs-zero", `files=${plausible.length} firstError=${(firstError || "none").slice(0, 60)}`);
    if (!silent) {
      if (firstError) {
        toast(firstError);
      } else {
        toast(`Read ${plausible.length} file(s) but found zero runs. Wrong files?`);
      }
    }
    return false;
  }

  // Partial-failure visibility. Previously we silently dropped failed
  // files and reported only the success count, which means a future
  // game update breaking 5/100 files would silently truncate stats and
  // the user would never know. Now we surface a follow-up toast AND
  // beacon the partial-failure rate so we can spot a trend in the wild.
  const failedFiles = plausible.length - okFiles;
  if (failedFiles > 0) {
    sendBeacon("ingest-partial-failure", `failed=${failedFiles}/${plausible.length} firstError=${(firstError || "").slice(0, 60)}`);
    if (!silent) {
      // Delay so the "Loaded N runs" toast posts first; both stay visible
      // because the toaster stacks.
      setTimeout(() => {
        toast(`${failedFiles} of ${plausible.length} files failed to parse${firstError ? ` (${(firstError).slice(0, 80)})` : ""}.`);
      }, 1200);
    }
  }

  console.info(`[Vault] loaded ${runs.length} unique run(s) from ${okFiles}/${plausible.length} file(s)`);
  // SpireVault Sync hands over only the files that are new on disk, and the
  // commit below replaces the whole run set: the loaded runs ride along.
  const runsToCommit = merge
    ? SyncBridge.mergeWithLoaded(runs, { loaded: isDemoMode ? [] : parsedRuns, live: currentRun })
    : runs;
  const committed = await commitParsedRuns(runsToCommit, plausible[0]?.name || "save", { silent, fileCount: plausible.length, stayOnTab: merge });

  // Quality check: if a user picked a folder and we got back a tiny
  // number of runs, they almost certainly picked a wrong subfolder
  // (e.g. `default/` or the parent `SlayTheSpire2/` containing only
  // settings.save files). The healthy STS2 player has dozens to
  // hundreds of `.run` files. Surface a recovery banner so they don't
  // silently sit on garbage stats. Skip this for silent auto-refresh
  // and for single-file imports (someone consciously picked one run).
  if (!silent && plausible.length >= 1 && runs.length > 0 && runs.length < 5) {
    setTimeout(() => maybeShowImportRecoveryBanner(runs.length), 600);
  }

  return committed;
}

/**
 * Show a sticky recovery banner when an interactive import comes back
 * with suspiciously few runs. The banner has two real escape hatches:
 *   1. A direct "Pick again" button that opens the folder picker.
 *   2. A "Drop your folder here" zone wired to the global drag-drop.
 * The user can dismiss if they really do only have a handful of runs.
 */
function maybeShowImportRecoveryBanner(runCount) {
  // De-dupe: don't stack banners if the user re-imports.
  document.getElementById("import-recovery-banner")?.remove();

  const host = document.getElementById("app-content");
  if (!host) return;

  const bar = document.createElement("div");
  bar.id = "import-recovery-banner";
  bar.className = "import-recovery-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = `
    <div class="import-recovery-banner-inner">
      <span class="import-recovery-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
      </span>
      <div class="import-recovery-text">
        <strong>That doesn't look right &mdash; we only found ${runCount} run${runCount === 1 ? "" : "s"}.</strong>
        Most STS2 players have dozens or hundreds. You probably picked a wrong folder. The right one is
        <code>SlayTheSpire2</code> (the whole folder, not a subfolder). Easiest fix: drag it from Finder onto this page.
      </div>
      <div class="import-recovery-actions">
        <button class="btn-primary sm" type="button" data-action="recover-pick-again">Pick again</button>
        <button class="btn-ghost sm" type="button" data-action="recover-dismiss" aria-label="Dismiss">&times;</button>
      </div>
    </div>`;
  host.insertBefore(bar, host.firstChild);

  bar.querySelector('[data-action="recover-pick-again"]').addEventListener("click", () => {
    bar.remove();
    sendBeacon("import-recovery-pick-again", `from-count=${runCount}`);
    void scanForHistory();
  });
  bar.querySelector('[data-action="recover-dismiss"]').addEventListener("click", () => {
    bar.remove();
    sendBeacon("import-recovery-dismissed", `from-count=${runCount}`);
  });
}

/**
 * Single-file convenience wrapper. Existing call sites (drag-drop one
 * file, file-input change handler with single selection, FSA auto-reload
 * loop) still hand us a single File; route through the multi path so
 * there's only one place that mutates `parsedRuns`.
 */
async function ingestHistoryFile(file, { silent = false } = {}) {
  return ingestHistoryFiles([file], { silent });
}

/**
 * Final stage: take a list of fully-parsed run records and commit them
 * to in-memory state, persistent storage, and re-render whichever tab
 * is showing. Pulled into its own function so both single- and multi-
 * file ingest paths funnel through identical state management.
 */
async function commitParsedRuns(runs, sourceName, { silent, fileCount = 1, stayOnTab = false }) {
  // Diff against the previously loaded set so a silent auto-refresh that
  // pulls in new runs from disk can speak up *just enough* — a single
  // "X new run(s) detected" toast — without spamming the user with reads
  // that found nothing new. Demo data is excluded from the diff so the
  // first real ingest doesn't surface "47 new runs!" — we suppress new-
  // count reporting on the demo→real transition.
  const wasDemo = isDemoMode;
  /** The runs loaded before this ingest (none when they were the sample set). */
  const priorRuns = wasDemo ? [] : parsedRuns;
  const previousIds = new Set(priorRuns.map((r) => r.id));
  const newCount = runs.filter((r) => !previousIds.has(r.id)).length;

  // Schema-bump self-healing: when a fresh re-parse of a run we
  // already had drops a previously-known field to `null` (because
  // STS2 shipped a schema change we don't fully handle yet), fall
  // back to the last good value we have for that run id rather than
  // overwriting good data with "Unknown" / null. Without this, an
  // auto-refresh on Chrome that re-reads the disk would silently
  // demote a correctly-rendered Silent run into a generic "Unknown"
  // row the moment STS2 changed the on-disk format. The IDB cache
  // and any cloud-synced data are the source of truth for fields
  // the new parser couldn't recover.
  if (!wasDemo && parsedRuns.length > 0) {
    const previousById = new Map(parsedRuns.map((r) => [r.id, r]));
    let healedCount = 0;
    for (let i = 0; i < runs.length; i++) {
      const fresh = runs[i];
      if (!fresh || !fresh.id) continue;
      const prev = previousById.get(fresh.id);
      if (!prev) continue;
      // Only retain previous-known fields when the fresh parse
      // dropped them. Never overwrite a fresh value with a stale
      // one — the new parse is otherwise authoritative.
      let healed = false;
      if (!fresh.character && prev.character) { fresh.character = prev.character; healed = true; }
      if (fresh.ascension == null && prev.ascension != null) { fresh.ascension = prev.ascension; healed = true; }
      if (!fresh.seed && prev.seed) { fresh.seed = prev.seed; healed = true; }
      if (!fresh.killedBy && prev.killedBy) { fresh.killedBy = prev.killedBy; healed = true; }
      if ((!fresh.relics || fresh.relics.length === 0) && Array.isArray(prev.relics) && prev.relics.length > 0) {
        fresh.relics = prev.relics; healed = true;
      }
      if ((!fresh.deckAtEnd || fresh.deckAtEnd.length === 0) && Array.isArray(prev.deckAtEnd) && prev.deckAtEnd.length > 0) {
        fresh.deckAtEnd = prev.deckAtEnd; healed = true;
      }
      if (healed) healedCount += 1;
    }
    if (healedCount > 0) {
      console.info(`[Vault] healed ${healedCount} run(s) with last-known fields after a partial re-parse`);
      sendBeacon("ingest-self-heal", `count=${healedCount}/${runs.length}`);
    }
  }

  // Sort newest-first so Recent Runs always renders chronologically right
  // out of the box, regardless of whether the source was a single rollup
  // (which already arrives in order) or a folder of `.run` files (which
  // arrives in `Promise.all` resolution order).
  runs.sort((a, b) => {
    const ta = a.endedAt?.getTime?.() ?? 0;
    const tb = b.endedAt?.getTime?.() ?? 0;
    return tb - ta;
  });

  // Split the in-progress save state out of the persisted run list so
  // it never pollutes lifetime stats (winrate, totals, character
  // breakdowns) while still being available as the live "current
  // run" overview card. The newest in-progress record wins if STS2
  // ever writes more than one (e.g. a stale partial in addition to
  // the live one). Completed runs flow on through unchanged.
  const completedRuns = [];
  let liveRun = null;
  for (const r of runs) {
    if (r?.inProgress) {
      const rTime = r.startedAt?.getTime?.() ?? 0;
      const liveTime = liveRun?.startedAt?.getTime?.() ?? -1;
      if (!liveRun || rTime > liveTime) liveRun = r;
    } else {
      completedRuns.push(r);
    }
  }
  currentRun = liveRun;
  parsedRuns = completedRuns;
  // Recompute the new-run delta against the completed set only — an
  // in-progress save isn't a "new run" in the user-facing sense, and
  // surfacing it in the "N new runs from disk" toast would feel wrong
  // (the count wouldn't match what showed up in the stats).
  const newCompletedCount = completedRuns.filter((r) => !previousIds.has(r.id)).length;
  const newWins = completedRuns.filter((r) => !previousIds.has(r.id) && r.won === true);
  // Real data has arrived — flip out of demo mode so the banner disappears.
  isDemoMode = false;
  // Co-op Play shows numbers from these runs; redraw them now rather than on its next poll.
  try { CoopPlay?.refreshClimbs(); } catch { /* not loaded, or signed out */ }

  // Stamp "last successful disk read" so the Safari/Firefox nudge
  // (the only refresh signal available on no-FSA browsers) knows when
  // it's been long enough to bother the user with a re-import CTA.
  try { localStorage.setItem(STORAGE_LAST_IMPORT_AT, String(Date.now())); }
  catch { /* private mode */ }

  // Beacon the successful import. This is THE event the path bug should
  // have been caught by — without it, "user saw stats" had zero signal
  // distinct from "user opened the page" in our analytics. detail
  // includes run count and unique-schema-version count so the admin
  // dashboard can show ingest health (success volume, schema drift).
  const schemaSet = new Set();
  for (const r of runs) {
    if (r?.schemaVersion != null) schemaSet.add(r.schemaVersion);
  }
  const schemaList = [...schemaSet].sort().join(",");
  // Separate reason for background refreshes — see the note on
  // `ingest-files-chosen` above. `silent=` stays in the detail so a single
  // event row is still self-describing.
  sendBeacon(
    silent ? "ingest-runs-committed-auto" : "ingest-runs-committed",
    `runs=${completedRuns.length} files=${fileCount} schemas=${schemaList || "none"} live=${liveRun ? 1 : 0} silent=${silent ? 1 : 0}`
  );

  // Independent unknown-schema beacon. Fires once per commit if any run
  // is on a schema we haven't tested. We dropped the user-facing
  // "newer build" warning (the parser is forgiving enough that the
  // user shouldn't have to think about schema versions) but keep the
  // beacon so we still get an admin-side signal when a new STS2 build
  // is landing in users' saves and prioritize a parser update.
  loadKnownSchemas().then((known) => {
    const unknown = [...schemaSet].filter((v) => !known.has(v));
    if (unknown.length > 0) {
      sendBeacon("ingest-unknown-schema", `versions=${unknown.join(",")} affected=${runs.filter(r => unknown.includes(r.schemaVersion)).length}`);
    }
  }).catch(() => { /* non-fatal */ });

  // Persist. We swallow IDB errors so a flaky storage layer never blocks
  // the in-memory render — the user still sees their stats this session.
  // We persist completed runs only so an in-progress save (which is
  // ephemeral by definition) never resurrects from cache on a later
  // boot as a phantom "current run" the player has long since
  // finished.
  try {
    await HistoryStore.saveHistory({
      savedAt: new Date().toISOString(),
      sourceFilename: sourceName,
      runs: completedRuns.map(serializeRun),
    });
    // Runs are on disk in IndexedDB — now pin that storage as durable
    // so the browser can't evict it under disk pressure (the one
    // scenario where a user would otherwise have to re-import).
    void ensureDurableStorage();
    persistLocalBackup(completedRuns.length);
  } catch (e) {
    console.error("[Vault] saveHistory to IndexedDB failed (continuing in-memory)", e);
    if (!silent) toast("Loaded runs but couldn't cache them locally. Stats will work this visit.");
  }

  // Cross-device sync: fire-and-forget upload to the Steam-ID-keyed
  // cloud copy so this user's other devices (mobile app, second browser)
  // pick up the new runs on next boot. No-op for guests. Internal
  // memoization prevents identical bodies from being re-uploaded on
  // an auto-refresh that turned up no new runs. In-progress runs are
  // local-only — they describe a *live* state, not history, so no
  // cross-device value in syncing them.
  CloudRuns.upload(completedRuns);

  if (silent) {
    // Suppress the "N new runs" toast when transitioning from demo to
    // real data — the diff would always say "everything is new" and
    // that's noise, not signal.
    if (newCompletedCount > 0 && !wasDemo) {
      toast(`${newCompletedCount} new run${newCompletedCount === 1 ? "" : "s"} from disk.`);
    }
  } else if (wasDemo) {
    // First real import replaces demo data — this is the one moment to
    // tell the user their data is now permanent on this device.
    toast(session
      ? `Loaded ${completedRuns.length} run${completedRuns.length === 1 ? "" : "s"}. You're set — next visit opens straight to your stats.`
      : `Loaded ${completedRuns.length} run${completedRuns.length === 1 ? "" : "s"}. They're saved in this browser; sign in with Steam to back them up.`,
      { duration: session ? 3000 : 7000 });
    if (!session) refreshGuestNote();
  } else if (fileCount > 1) {
    toast(`Loaded ${completedRuns.length} run${completedRuns.length === 1 ? "" : "s"} from ${fileCount} files.`);
  } else {
    toast(`Loaded ${completedRuns.length} run${completedRuns.length === 1 ? "" : "s"}.`);
  }

  // Force-render so the empty state vanishes and stats appear, no matter
  // which stat tab is active. If the user was on a non-stat tab (co-op),
  // hop them to Overview so they actually see the result of their click.
  if (TABS_WITH_DATA.includes(activeTab)) {
    renderStatsTab(activeTab);
  } else if (!stayOnTab) {
    switchTab("overview");
  }
  // Update the sidebar's "new run" red dot. If the user is currently
  // *on* the Recent Runs tab, the dot stays cleared because the act
  // of being on the tab counts as having seen everything.
  if (activeTab === "runs") {
    markRunsSeen();
  } else {
    refreshRunsBadge();
  }
  // Late deep-link resolution: if the URL points at `?run=<id>` and
  // we now have that run in memory (because it just ingested), open
  // its modal. Idempotent if already open — won't flicker.
  try { openDeepLinkedRunIfPresent(); } catch (e) { console.warn("deeplink open failed", e); }
  // Victory celebration overlay — fires when 1–3 new wins land (covers a
  // fresh run completing mid-session or a quick back-to-back). Skipped
  // for demo data and bulk first-time imports.
  //
  // Gate is on *new wins*, not total new runs: a user who plays 4 games
  // since last refresh (3 losses + 1 win) absolutely still wants their
  // win celebrated. The "bulk first import" carve-out is now based on
  // whether they had any prior runs at all — if they did, this is an
  // incremental refresh and we celebrate; if they didn't, we assume the
  // 50-run dump from their save folder is onboarding and stay quiet.
  const hadPriorRuns = parsedRuns.length > newCompletedCount;
  const celebratingVictory = !wasDemo && newWins.length > 0 && newWins.length <= 3 && hadPriorRuns;
  // Milestone notifications: only what this ingest newly reached, and
  // only when real runs were already loaded. A first import (the sample
  // set counts as nothing) or a re-import into an empty browser records
  // them quietly, and so does a win the victory overlay is already
  // celebrating ("First victory!" over "VICTORY" was one card too many).
  // Background auto-refreshes count: a run finished while the tab sat
  // open still deserves its card.
  try {
    evaluateMilestones(priorRuns, { celebrate: priorRuns.length > 0 && !celebratingVictory });
  } catch (e) { console.warn("milestones failed", e); }
  if (celebratingVictory) {
    const streak = currentStreak(parsedRuns);
    const streakCount = streak.kind === "win" ? streak.count : 1;
    try { showVictoryCelebration(newWins[0], streakCount); } catch (e) { console.warn("victory celebration failed", e); }
  }
  // Analytics: fire one ingest_complete event per real ingest. Demo
  // data is excluded because it would inflate counts. We tag silent
  // (background-poll) vs interactive (button-press) ingests so the
  // funnel can show "auto-refresh works" separately from "user
  // pressed Refresh" engagement.
  if (!wasDemo) {
    vaultGtagEvent("ingest_complete", {
      run_count: completedRuns.length,
      new_count: newCompletedCount,
      file_count: fileCount,
      source: silent ? "auto_refresh" : "interactive",
      live_run: liveRun ? 1 : 0,
    });
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

/** When this browser last sent its runs up only to give the Steam copy the
 *  detail it lacked: card picks, rooms, abandoned runs
 *  (hydrateFromCloudIfAvailable). */
const STORAGE_DETAIL_REFILL_AT = "vault.web.cloud.detail-refill-at";
/** One such upload a day at most. It is needed once per player, but a
 *  server that cannot store the detail (an older Worker, after a rollback)
 *  would leave the same gap on every visit, and every upload is a write
 *  against the Worker's daily allowance, shared by all players. */
const DETAIL_REFILL_EVERY_MS = 24 * 60 * 60 * 1000;

function isDetailRefillDue() {
  try {
    const last = Number(localStorage.getItem(STORAGE_DETAIL_REFILL_AT)) || 0;
    return Date.now() - last > DETAIL_REFILL_EVERY_MS;
  } catch { return true; /* private mode: no record, so nothing to hold it back */ }
}

function noteDetailRefill() {
  try { localStorage.setItem(STORAGE_DETAIL_REFILL_AT, String(Date.now())); }
  catch { /* private mode */ }
}

/** Boot-time + sign-in cloud rehydration.
 *
 *  Pulls the user's cloud-copy run set and **unions** it with whatever's
 *  already in memory, deduping by `run.id` and keeping the newer record
 *  per id. This protects three real edge cases that the previous
 *  "replace if cloud is bigger" path got wrong:
 *
 *    1. Phone has 5 fresh local runs not yet uploaded; cloud has 50
 *       runs from web. Old code: cloud overwrites, the 5 phone runs
 *       are lost. New code: result is 55 unique runs.
 *    2. Web uploaded once, then user trimmed runs locally on web.
 *       Cloud has the larger original set; the user expects local
 *       state to win — the merge keeps newer-by-`endedAt` per-id.
 *    3. Stale cloud snapshot + larger fresh local set: merge prefers
 *       newer end-times so freshness wins over cardinality.
 *
 *  Persists the merged result to IndexedDB (keyed under the active
 *  Steam ID) and re-uploads so cloud catches up to local additions on
 *  the next push. Re-renders the active tab if anything changed.
 *
 *  Returns `{ changed, count }` for the caller. Safe to call multiple
 *  times — boot, sign-in transition, and visibility-change all funnel
 *  through this single entry point.
 */
async function hydrateFromCloudIfAvailable() {
  try {
    const blob = await CloudRuns.download();
    // Unreadable is not empty: say so, so no caller tells the player their
    // Steam copy has no runs when the server was only out of reach.
    if (blob?.ok === false) {
      return { changed: false, count: parsedRuns.length, failed: true, status: blob.status };
    }
    const cloudRevived = Array.isArray(blob?.runs)
      ? blob.runs.map((r) => reviveRun(CloudWire.fromWire(r)))
      : [];
    // The cloud copy only grows when an import happens while signed in, so
    // runs imported as a guest (or while sign-in was failing) never reached
    // it: one owner's copy stopped three months and 140 runs behind the save
    // folder. And every copy written before 2026-11-18 holds no card picks,
    // so a phone or second browser showed an empty Cards tab. Send what this
    // device holds that the copy lacks (a run, or a run's card picks, rooms
    // and abandoned flag); the server merges by run id.
    const localRuns = isDemoMode ? [] : parsedRuns;
    if (blob && Array.isArray(blob.runs)) {
      const hasNewRuns = CloudWire.hasRunsCopyLacks(localRuns, cloudRevived);
      if (hasNewRuns || (CloudWire.hasDetailCopyLacks(localRuns, cloudRevived) && isDetailRefillDue())) {
        if (!hasNewRuns) noteDetailRefill();
        CloudRuns.upload(localRuns);
      }
    }
    if (cloudRevived.length === 0) {
      return { changed: false, count: parsedRuns.length };
    }

    // Demo data is never merged — it's synthetic and would pollute the
    // user's actual run set. The first real ingest path (manual import
    // or cloud hydrate) replaces the demo wholesale.
    const baseLocal = isDemoMode ? [] : parsedRuns;
    const wasDemo = isDemoMode;

    const byId = new Map();
    for (const r of baseLocal) {
      if (r && r.id) byId.set(r.id, r);
    }
    let cloudOnly = 0;
    let cloudOverrides = 0;
    for (const r of cloudRevived) {
      if (!r || !r.id) continue;
      const existing = byId.get(r.id);
      if (!existing) {
        byId.set(r.id, r);
        cloudOnly += 1;
      } else {
        // A later `endedAt` wins — same id but a later end-time means the
        // run was re-finalized (extra floors before game-over, etc.). At
        // the same end-time the copy holding the run's card picks wins, so
        // a device that loaded the old thin copy takes the full one. Either
        // way, card picks and the rest of a run's detail are never traded
        // away for a record that lacks them (CloudWire.bestOf).
        const kept = CloudWire.bestOf(existing, r);
        if (kept !== existing) {
          byId.set(r.id, kept);
          cloudOverrides += 1;
        }
      }
    }

    const merged = [...byId.values()].sort(
      (a, b) => (b.endedAt?.getTime?.() || 0) - (a.endedAt?.getTime?.() || 0)
    );

    // Bail out if nothing changed (cold boot with cloud == local, or
    // pure no-op refresh) — avoids a useless re-render flicker.
    const changed = wasDemo
      || merged.length !== baseLocal.length
      || cloudOverrides > 0;
    if (!changed) {
      return { changed: false, count: merged.length };
    }

    parsedRuns = merged;
    isDemoMode = false;
    sendBeacon(
      "cloud-runs-hydrated",
      `count=${merged.length} cloud_only=${cloudOnly} overrides=${cloudOverrides} was_demo=${wasDemo ? 1 : 0}`
    );
    recordCloudSync(merged.length);

    // Persist to IndexedDB so the next cold load is instant.
    try {
      await HistoryStore.saveHistory({
        savedAt: new Date().toISOString(),
        sourceFilename: "cloud-sync",
        runs: merged.map(serializeRun),
      });
    } catch { /* IDB failure is non-fatal; we still have it in memory */ }

    // No second upload here: `merged` is this device's runs plus the
    // cloud's, and whatever the device had that the cloud lacked went up
    // above. (An upload of `merged` used to follow; with the upload memo
    // empty at boot it re-sent the whole library whenever another device
    // had added a run.)

    if (wasDemo) {
      toast(`Loaded ${merged.length} run${merged.length === 1 ? "" : "s"} from your Steam account.`);
    } else if (cloudOnly > 0) {
      toast(`Synced ${cloudOnly} run${cloudOnly === 1 ? "" : "s"} from your other device.`);
    }
    renderActiveTab();
    // Cloud-merged runs from another device are by definition newer-
    // than-anything-local for that id, so light the sidebar dot if
    // the user isn't already on the Recent Runs tab.
    if (activeTab === "runs") markRunsSeen();
    else refreshRunsBadge();
    return { changed: true, count: merged.length };
  } catch (e) {
    console.warn("[Vault] cloud rehydrate failed", e);
    return { changed: false, count: parsedRuns.length, failed: true, status: 0 };
  }
}

// =========================================================================
// Cross-device run sync (Steam-ID keyed cloud copy of run history).
//
// Web client uploads its full local run set to /api/runs after every
// successful import + on every auto-refresh that finds new runs.
// Mobile (iOS) reads the SAME endpoint to populate its history view.
//
// Storage on the server: keyed by Steam ID, deduped by run id, capped at
// 2,000 runs. The full sanitization + merge logic lives in
// Backend/src/runs.ts; this client-side module is purely a thin upload
// layer that fires-and-forgets after the user has data worth saving.
//
// Privacy: only signed-in users sync. Guests stay 100% local. The user
// can clear the cloud copy at any time with HistoryStore.clearCloud().
// =========================================================================
const CloudRuns = (() => {
  // Track the last upload signature so a no-op refresh (auto-poll, no
  // new runs) doesn't spam the backend with identical bodies. Using
  // "count + most-recent endedAt" as a cheap fingerprint — every time
  // the user finishes a new run, both will change.
  let lastUploadFingerprint = "";
  let inflightUpload = null;
  // The one run set still waiting to go up: handed in while another upload
  // was in flight, or kept after an attempt the server or the network
  // failed. Sets handed in meanwhile merge into it by run id rather than
  // replace it: an import carries only what it read (one file, say), and
  // the server's POST only adds runs, so the union loses nothing.
  let pendingRuns = null;
  // Back-off after a failed attempt: 30 s, 2 min, then 10 min. After the
  // last one the timer stops, but the set stays pending and goes up when
  // the browser comes back online, the tab is shown again, or the next
  // import calls upload().
  const RETRY_DELAYS_MS = Object.freeze([30_000, 2 * 60_000, 10 * 60_000]);
  let retryAttempt = 0;
  let retryTimer = 0;
  // A failed save tells the player once; the save that finally lands says so.
  let failureAnnounced = false;
  // What the Steam copy is known to hold (CloudWire.indexOfCopy), from the
  // last download and every upload since. Uploads send only what it lacks.
  // null until the copy has been read in this visit: then everything goes up.
  /** @type {import("/lib/cloud-run-wire.js").CopyIndex | null} */
  let copyIndex = null;
  // Whose copy that index describes. Another account's copy is another
  // copy: its index is ignored until this account's has been read.
  let copyIndexOwner = "";
  // Workers KV takes one write a second to the same key, and every upload
  // request re-writes the player's one key.
  const CHUNK_GAP_MS = 1200;

  function fingerprintForRuns(runs) {
    if (!Array.isArray(runs) || runs.length === 0) return "0:";
    let latest = 0;
    for (const r of runs) {
      const t = r?.endedAt?.getTime?.() ?? 0;
      if (t > latest) latest = t;
    }
    return `${runs.length}:${latest}`;
  }

  // The wire format lives in lib/cloud-run-wire.js (toWire / fromWire), next
  // to the checks that keep card picks and the rest of a run's detail in it.

  /** Fire-and-forget upload of the current local run set to the cloud.
   *  Skipped when not signed in or when the cloud already has this set.
   *  While an upload is in flight or a retry is waiting, the set takes
   *  the pending slot instead and goes up with that. */
  function upload(runs) {
    if (!session || !session.steamID || !Array.isArray(runs)) return;
    if (fingerprintForRuns(runs) === lastUploadFingerprint) return;
    pendingRuns = mergeRunSets(pendingRuns, runs);
    if (inflightUpload || retryTimer) return;
    flushPending();
  }

  /** Union of two run sets by id; for the same id the later `endedAt`
   *  wins, as on the server. A null set is empty. */
  function mergeRunSets(older, newer) {
    if (!older || older.length === 0) return newer;
    const byId = new Map();
    const unnamed = [];
    for (const r of [...older, ...newer]) {
      if (!r?.id) { unnamed.push(r); continue; }
      const kept = byId.get(r.id);
      const keptAt = kept?.endedAt?.getTime?.() ?? 0;
      const runAt = r.endedAt?.getTime?.() ?? 0;
      if (!kept || runAt >= keptAt) byId.set(r.id, r);
    }
    return [...byId.values(), ...unnamed];
  }

  /** Sends the pending set now, unless one is already on its way. */
  function flushPending() {
    if (inflightUpload || !pendingRuns) return;
    clearRetryTimer();
    if (!session || !session.steamID) {
      pendingRuns = null;
      return;
    }
    const runs = pendingRuns;
    pendingRuns = null;
    const fp = fingerprintForRuns(runs);
    if (fp === lastUploadFingerprint) return;
    inflightUpload = sendRuns(runs, fp).then(
      (landed) => {
        inflightUpload = null;
        // A set handed in during the flight goes up now. After a failure
        // it waits for the retry timer or the next online / tab-shown.
        if (landed) flushPending();
      },
      (e) => {
        inflightUpload = null;
        console.warn("[Vault] cloud upload failed", e);
      },
    );
  }

  /** One POST of `runs`; schedules a retry when the failure is the
   *  server's or the network's, so it can pass on its own.
   *  @returns {Promise<boolean>} true when the cloud took the set */
  async function sendRuns(runs, fp) {
    // Only what the copy lacks. The server re-writes the whole copy on every
    // upload, so a request that adds nothing is skipped outright, and a
    // large library goes up a few hundred runs at a time, one request after
    // another (the server's merge is read-then-write, never two at once).
    // One account from first request to last: the requests are seconds
    // apart, and a sign-out or another sign-in in between must not send
    // this account's runs under the next one's name.
    const owner = session.steamID;
    const token = session.sessionToken || "__cookie__";
    const toSend = CloudWire.runsToSend(runs, copyIndexOwner === owner ? copyIndex : null);
    if (toSend.length === 0) {
      lastUploadFingerprint = fp;
      retryAttempt = 0;
      return true;
    }
    let status = 0;
    try {
      let stored = 0;
      let added = 0;
      let wasTruncated = false;
      let hasAllLanded = true;
      const chunks = CloudWire.inChunks(toSend, CloudWire.UPLOAD_CHUNK_RUNS);
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, CHUNK_GAP_MS));
        if (session?.steamID !== owner) {
          // Signed out or switched account mid-upload: the rest is not
          // this session's to send. Nothing to retry, nothing to announce.
          pendingRuns = null;
          retryAttempt = 0;
          return false;
        }
        status = 0; // a request that never answers must not inherit the last chunk's 200
        const r = await fetch("/api/runs", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-vault-source": "web",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ runs: chunk.map(CloudWire.toWire) }),
        });
        status = r.status;
        if (!r.ok) { hasAllLanded = false; break; }
        const j = await r.json().catch(() => ({}));
        stored = j.count || stored;
        added += j.added || 0;
        wasTruncated = wasTruncated || j.truncated === true;
        // A later failure retries only the chunks that did not land.
        if (copyIndexOwner === owner) copyIndex = CloudWire.indexAfterSend(copyIndex, chunk);
      }
      if (hasAllLanded) {
        lastUploadFingerprint = fp;
        retryAttempt = 0;
        sendBeacon("cloud-runs-uploaded",
          `count=${stored} added=${added} sent=${toSend.length} truncated=${wasTruncated ? 1 : 0}`);
        recordCloudSync(stored || runs.length);
        if (failureAnnounced) toast("Your runs are saved to your Steam account now.");
        failureAnnounced = false;
        return true;
      }
      sendBeacon("cloud-runs-upload-failed", `status=${status}${retryAttempt ? ` retry=${retryAttempt}` : ""}`);
    } catch (e) {
      sendBeacon("cloud-runs-upload-error", String(e?.message || e).slice(0, 80));
    }
    const isRetryable = status === 0 || status === 408 || status === 429 || status >= 500;
    if (isRetryable) {
      // Back into the slot, alongside any set handed in during the flight.
      pendingRuns = mergeRunSets(runs, pendingRuns || []);
      scheduleRetry();
    } else {
      // Retrying cannot fix these; the player has to act first.
      pendingRuns = null;
      retryAttempt = 0;
    }
    announceFailure(status);
    return false;
  }

  /** Surface persistence failures so the user knows their history isn't
   *  being saved to their Steam account. The old silent fail let players
   *  assume sync was working, then lose progress on the next device. */
  function announceFailure(status) {
    if (status === 401 || status === 403) {
      toast("Couldn't save to your Steam account — your session expired. Please sign in again.");
      return;
    }
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      toast(`Couldn't save to your Steam account (${status}). Please refresh and try again.`);
      return;
    }
    if (failureAnnounced) return;
    failureAnnounced = true;
    toast(status
      ? `Couldn't save to your Steam account (server ${status}). We'll retry automatically.`
      : "Couldn't reach your Steam account. We'll retry automatically.");
  }

  function scheduleRetry() {
    clearRetryTimer();
    if (retryAttempt >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[retryAttempt];
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      flushPending();
    }, delay);
  }

  function clearRetryTimer() {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = 0;
  }

  // Coming back online or to the tab is the likeliest moment a failed save
  // can land, so try then instead of waiting out the back-off.
  window.addEventListener("online", flushPending);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushPending();
  });

  /** Pull the cloud copy. Returns { runs, count, updatedAt }, null when
   *  not signed in, or { ok: false, status } when the copy couldn't be
   *  read (status 0 for a network failure) — which says nothing about
   *  whether runs are there, so callers must not report "no runs". The
   *  runs come back as wire-format objects (ISO date strings, no Date
   *  instances) — caller should revive them via reviveRun() before
   *  mixing with parsedRuns. */
  async function download() {
    if (!session || !session.steamID) return null;
    const owner = session.steamID;
    try {
      const r = await fetch("/api/runs", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${session.sessionToken || "__cookie__"}`,
        },
      });
      if (!r.ok) {
        sendBeacon("cloud-runs-download-failed", `status=${r.status}`);
        return { ok: false, status: r.status };
      }
      const copy = await r.json();
      if (Array.isArray(copy?.runs)) {
        copyIndex = CloudWire.indexOfCopy(copy.runs);
        copyIndexOwner = owner;
      }
      return copy;
    } catch (e) {
      sendBeacon("cloud-runs-download-error", String(e?.message || e).slice(0, 80));
      return { ok: false, status: 0 };
    }
  }

  /** Clear the cloud copy. Idempotent. Surfaces as 200 even if the
   *  KV key was already absent. */
  async function clearCloud() {
    if (!session || !session.steamID) return;
    try {
      await fetch("/api/runs", {
        method: "DELETE",
        credentials: "include",
        cache: "no-store",
        headers: {
          authorization: `Bearer ${session.sessionToken || "__cookie__"}`,
        },
      });
      lastUploadFingerprint = "";
      copyIndex = null;
      copyIndexOwner = "";
    } catch { /* best effort */ }
  }

  /** Reset upload memoization. Call after a sign-in event so the next
   *  upload fires for the now-bound Steam ID even if the run set is
   *  identical to what was last uploaded under the previous identity. */
  function resetFingerprint() {
    lastUploadFingerprint = "";
    retryAttempt = 0;
    copyIndex = null;
    copyIndexOwner = "";
  }

  return { upload, download, clearCloud, resetFingerprint };
})();

// =========================================================================
// Export — bulk (all runs) + single-run share are split. This block handles
// the bulk path (JSON / CSV downloads). Per-run share image lives further
// down next to its modal.
// =========================================================================

/** Trigger a browser download for arbitrary text content with the given
 *  filename. We build a one-shot Blob URL and revoke it on next tick to
 *  avoid leaking object URLs across long sessions. */
function downloadTextFile(filename, content, mime = "application/octet-stream") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build a YYYY-MM-DD stamp for default export filenames. */
function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** CSV-safe escape: quote anything with comma / quote / newline,
 *  and double up internal quotes per RFC 4180. */
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Export all loaded runs in the requested format.
 *
 *  JSON: one self-contained file with metadata, suitable for re-import or
 *  for sharing a full backup. We re-serialize through serializeRun so dates
 *  are ISO strings (round-trippable).
 *
 *  CSV: flat tabular dump of the headline fields per row. Skips the deck
 *  and per-card pick lists — those don't fit cleanly in CSV and most users
 *  asking for CSV want spreadsheet-friendly summary stats. */
function exportAllRuns(format) {
  if (parsedRuns.length === 0) {
    toast("Drop your STS2 save folder first — nothing to export yet.");
    return;
  }
  const stamp = todayStamp();
  if (format === "json") {
    const payload = {
      exportedAt: new Date().toISOString(),
      tool: "SpireVault Web",
      version: 1,
      runCount: parsedRuns.length,
      runs: parsedRuns.map(serializeRun),
    };
    downloadTextFile(`spirevault-runs-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json");
    toast(`Exported ${parsedRuns.length} run${parsedRuns.length === 1 ? "" : "s"} to JSON.`);
    return;
  }
  if (format === "csv") {
    const headers = [
      "id", "character", "ascension", "outcome", "floorReached",
      "playTimeSeconds", "playTime", "startedAt", "endedAt",
      "deckSize", "relicCount", "seed",
    ];
    const lines = [headers.join(",")];
    for (const r of parsedRuns) {
      const playTime = r.playTimeSeconds != null
        ? `${Math.floor(r.playTimeSeconds / 60)}:${String(r.playTimeSeconds % 60).padStart(2, "0")}`
        : "";
      const row = [
        r.id ?? "",
        r.character?.toString?.() ?? "",
        r.ascension ?? "",
        r.won === true ? "win" : r.won === false ? "loss" : "",
        r.floorReached ?? "",
        r.playTimeSeconds ?? "",
        playTime,
        r.startedAt ? r.startedAt.toISOString() : "",
        r.endedAt   ? r.endedAt.toISOString()   : "",
        Array.isArray(r.deckAtEnd) ? r.deckAtEnd.length : 0,
        Array.isArray(r.relics)    ? r.relics.length    : 0,
        r.seed ?? "",
      ].map(csvEscape).join(",");
      lines.push(row);
    }
    downloadTextFile(`spirevault-runs-${stamp}.csv`, lines.join("\r\n"), "text/csv;charset=utf-8");
    toast(`Exported ${parsedRuns.length} run${parsedRuns.length === 1 ? "" : "s"} to CSV.`);
    return;
  }
}

// =========================================================================
// Stats tab renderers
// =========================================================================
/** Tracks whether the boot-time skeleton is currently showing. We
 *  render it when a signed-in user lands on a fresh device with no
 *  IDB cache yet — so the cloud download has a moment to come back
 *  without the UI flashing demo numbers in the meantime. */
let bootSkeletonActive = false;

/** Render the skeleton placeholder into the Overview body. Cheap —
 *  pure HTML with CSS shimmer, no SVG. Stays up until cloud hydrate
 *  resolves and `hideBootSkeleton()` clears the flag. */
function showBootSkeleton() {
  bootSkeletonActive = true;
  const $body = document.getElementById("overview-body");
  if (!$body) return;
  $body.innerHTML = `
    <div class="kpi-skeleton" aria-hidden="true">
      ${Array(6).fill(0).map(() => `
        <div class="skeleton-card">
          <div class="skeleton-bar is-label"></div>
          <div class="skeleton-bar is-value"></div>
          <div class="skeleton-bar is-sub"></div>
        </div>
      `).join("")}
    </div>
    <div class="skeleton-hero" aria-hidden="true"></div>
    <p class="chart-empty" role="status">Syncing your runs from your Steam account&hellip;</p>`;
}

function hideBootSkeleton() {
  if (!bootSkeletonActive) return;
  bootSkeletonActive = false;
  // Re-render whatever tab is active so the skeleton is replaced with
  // either real data, the empty state, or demo data depending on what
  // landed in `parsedRuns`.
  try { renderActiveTab(); } catch { /* defensive */ }
}

function renderStatsTab(tab) {
  const $body = document.getElementById(`${tab}-body`);
  if (!$body) return;
  if (deferUntilUIReady(() => renderActiveTab())) return;
  // While the boot skeleton is up, leave it alone. The hydrate
  // promise will trigger a re-render once cloud responds.
  if (bootSkeletonActive && tab === "overview") return;
  // Arranging the Overview: hold refreshes until Done, which draws it again.
  if (tab === "overview" && UI && UI.Overview.isArranging()) return;
  if (parsedRuns.length === 0) {
    $body.innerHTML = renderEmptyState();
    if (UI) {
      // No runs yet: the stage stays up, with a dark spire and no torches.
      UI.Stage.renderStage({ hiLevel: -1, recent: [] });
      UI.Motion.afterRender($body);
    }
    $body.querySelectorAll("[data-action='scan']").forEach((btn) => {
      btn.addEventListener("click", () => void scanForHistory());
    });
    // v93: route upload through scanForHistory so we get the recursive
    // directory picker on Chromium instead of a flat file-only picker
    // that can't see into STS2's nested `steam/<id>/profile1/saves/history/`.
    $body.querySelectorAll("[data-action='upload']").forEach((btn) => {
      btn.addEventListener("click", () => void scanForHistory());
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
    // v201 rough-edge #1 + #2: alt-paths panel (with paste-the-path
    // field) lives below the platform-default callout. Wire its
    // controls — same scope as the empty state, scoped to $body so
    // it doesn't leak handlers onto a future re-render of a
    // different stats tab.
    wireAltPathsPanel($body);
    // "Restore my runs from Steam" — manual cloud-pull for signed-in
    // users on a fresh device or after IDB was wiped. Same network
    // path as the boot-time auto-hydrate, just user-triggered with
    // visible feedback so they know it's working (or know it failed).
    $body.querySelectorAll('[data-action="restore-from-cloud"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = "Pulling…";
        try {
          const res = await hydrateFromCloudIfAvailable();
          if (res?.failed) {
            toast("Couldn't reach your Steam copy right now. Your runs aren't gone.");
          } else if (res?.changed && res.count > 0) {
            toast(`Restored ${res.count} run${res.count === 1 ? "" : "s"} from your Steam account.`);
            // hydrateFromCloudIfAvailable already triggered renderActiveTab.
          } else if (res?.count === 0) {
            toast("Your Steam account has no runs synced yet — drop your save folder once to start.");
          } else {
            toast("Everything in your Steam copy is already here.");
          }
        } catch (e) {
          toast(`Restore failed: ${String(e?.message || e).slice(0, 80)}`);
        } finally {
          // A restore that changed nothing leaves this button on screen,
          // so it must not stay stuck on "Pulling…".
          btn.innerHTML = original;
          btn.disabled = false;
        }
      });
    });
    return;
  }
  const report = Stats.summarize(parsedRuns);
  // Paint the per-tab header crest (stat plaques / portrait rail /
  // climb track / reliquary shelf / card fan) from the same report.
  renderHeadCrests(report);
  // The compact "Sample data" strip only ships above the OVERVIEW tab
  // body when isDemoMode is true. Other tabs would just stack a
  // duplicate banner above their own content; the global toolbar's
  // amber pill carries the same "showing sample data" signal on every
  // tab, so the user always knows what they're looking at without the
  // banner dominating every fold.
  // Demo banner: only on overview, only in demo mode, AND only if the
  // user hasn't dismissed it for this browser. Lets people who already
  // know it's sample data hide the orange strip permanently.
  let demoBannerDismissed = false;
  try { demoBannerDismissed = localStorage.getItem("vault.web.demoBannerDismissed") === "1"; } catch {}
  const banner = isDemoMode && tab === "overview" && !demoBannerDismissed ? renderDemoBanner() : "";
  // Current-run card — only on the Overview tab, only when an
  // in-progress save was discovered on the latest disk read. The
  // panel sits where the old "schema version" notice used to live so
  // that fold of the page still reads as "anything happening live
  // right now?", but it's now an always-actionable status block
  // instead of a passive warning the user couldn't do anything with.
  // Suppressed in demo mode (no real save folder, so no live game).
  const liveCard = (!isDemoMode && tab === "overview" && currentRun) ? renderCurrentRunCard(currentRun) : "";
  const prefix = banner + liveCard;
  switch (tab) {
    case "overview":   $body.innerHTML = prefix + (UI ? renderOverviewNext(report) : renderOverview(report)); break;
    case "characters": $body.innerHTML = prefix + (UI ? renderCharactersTabNext(report) : renderCharactersTab(report)); break;
    case "ascensions": $body.innerHTML = prefix + (UI ? renderAscensionsTabNext() : renderAscensionsTab(report)); if (UI) wireAscensionSpire($body); break;
    case "relics":     $body.innerHTML = prefix + (UI ? renderRelicsNext(report) : renderRelicsTab(report)); break;
    case "cards":      $body.innerHTML = prefix + (UI ? renderCardsNext(report) : renderCards(report)); break;
    case "runs":       $body.innerHTML = prefix + renderRecentRuns(parsedRuns); break;
  }
  if (UI) UI.Motion.afterRender($body);
  else if (tab === "overview") fitClassicCharts($body);
  // First time on the customizable Overview: the step-by-step tour.
  if (UI && tab === "overview") UI.Overview.maybeStartTour();
  // Demo banner CTAs route to the existing scan/upload flow.
  if (isDemoMode) {
    $body.querySelectorAll('[data-action="scan"]').forEach((btn) => {
      btn.addEventListener("click", () => void scanForHistory());
    });
    // v93: see above — upload now uses the recursive directory picker.
    $body.querySelectorAll('[data-action="upload"]').forEach((btn) => {
      btn.addEventListener("click", () => void scanForHistory());
    });
    // Dismiss-X on the demo banner. Persists per-browser so the user
    // doesn't keep seeing the orange strip if they already understand
    // what it means.
    $body.querySelectorAll('[data-action="dismiss-demo-banner"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        try { localStorage.setItem("vault.web.demoBannerDismissed", "1"); } catch {}
        const banner = btn.closest(".demo-banner");
        if (banner) banner.remove();
        // Also hide the toolbar pill so the user gets full silence.
        document.querySelectorAll("[data-toolbar-empty]").forEach((p) => { p.hidden = true; });
      });
    });
    // Copy-path button on each platform panel — copies the
    // platform's STS2 save path to the clipboard with a brief
    // "Copied" confirmation.
    $body.querySelectorAll('[data-action="copy-path"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.pathKey || "mac";
        const path =
          key === "win"   ? HISTORY_PATH_WIN
          : key === "linux" ? HISTORY_PATH_LINUX
          :                   HISTORY_PATH_MAC;
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
    // Platform tab switcher — click a tab to swap the visible panel.
    // All three panels are pre-rendered, just hidden; the switch is
    // a pure DOM toggle so it feels instant.
    $body.querySelectorAll('[data-action="ingest-platform-switch"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.platformKey;
        if (!target) return;
        const root = btn.closest(".demo-strip-help-body");
        if (!root) return;
        root.querySelectorAll(".ingest-platform-tab").forEach((t) => {
          const active = t.dataset.platformKey === target;
          t.classList.toggle("is-active", active);
          t.setAttribute("aria-selected", active ? "true" : "false");
        });
        root.querySelectorAll(".ingest-platform-panel").forEach((p) => {
          p.hidden = p.dataset.platformPanel !== target;
        });
        sendBeacon("ingest-platform-tab-clicked", `target=${target}`);
      });
    });
  }
  // Current-run card collapse toggle. The card is a <details> at heart
  // but rendered as bespoke markup so the chevron and pill styling
  // match the rest of the overview hero. We persist the open/closed
  // bit per-browser so a user who collapsed it once doesn't have to
  // collapse again on every auto-refresh repaint.
  $body.querySelectorAll('[data-action="toggle-current-run"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".current-run-card");
      if (!card) return;
      const open = card.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      currentRunCollapsed = !open;
      try {
        localStorage.setItem("vault.web.currentRunCollapsed", currentRunCollapsed ? "1" : "0");
      } catch { /* private mode */ }
    });
  });
  // Delegated handler for any element marked with data-action="goto-tab".
  // Lets character cards, side stat tiles, and any future "click here to
  // see more" affordance route to a sibling tab without per-card wiring.
  $body.querySelectorAll('[data-action="goto-tab"]').forEach((el) => {
    el.addEventListener("click", () => {
      const next = el.dataset.tab;
      if (next) switchTab(next);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const next = el.dataset.tab;
        if (next) switchTab(next);
      }
    });
  });
  // Relic drill-down expand / collapse (Top Relics tab only).
  // Same UX pattern as the character drill-down: click opens a
  // detail panel below the grid, click again or close button
  // collapses, click another card swaps to that relic.
  $body.querySelectorAll('[data-action="relic-expand"]').forEach((el) => {
    const open = () => {
      const key = el.dataset.relicKey;
      if (!key) return;
      const slot = document.getElementById("relic-detail-slot");
      if (!slot) return;
      const isOpenSame = slot.querySelector(`[data-relic-detail="${CSS.escape(key)}"]`);
      if (isOpenSame) {
        slot.innerHTML = "";
        $body.querySelectorAll('[data-action="relic-expand"].is-active').forEach((c) => c.classList.remove("is-active"));
        return;
      }
      const report = Stats.summarize(parsedRuns);
      const bucket = (report.byRelic || []).find((b) => b.key === key) || null;
      slot.innerHTML = renderRelicDetail(key, bucket, report.overallWinrate);
      $body.querySelectorAll('[data-action="relic-expand"].is-active').forEach((c) => c.classList.remove("is-active"));
      el.classList.add("is-active");
      slot.querySelectorAll('[data-action="relic-collapse"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          slot.innerHTML = "";
          el.classList.remove("is-active");
        });
      });
      slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  // Character drill-down expand / collapse (Characters tab only).
  // Clicking a character card opens a detail panel below the grid;
  // clicking the same card again, the close button, or another card
  // routes to the new selection.
  $body.querySelectorAll('[data-action="char-expand"]').forEach((el) => {
    const open = () => {
      const key = el.dataset.charKey;
      if (!key) return;
      const slot = document.getElementById("char-detail-slot");
      if (!slot) return;
      const isOpenSame = slot.querySelector(`[data-char-detail="${CSS.escape(key)}"]`);
      if (isOpenSame) {
        slot.innerHTML = "";
        $body.querySelectorAll(".char-card.is-active, .v-cb.is-active").forEach((c) => c.classList.remove("is-active"));
        return;
      }
      const report = Stats.summarize(parsedRuns);
      const bucket = (report.byCharacter || []).find((b) => b.key === key) || null;
      slot.innerHTML = renderCharacterDetail(key, bucket);
      $body.querySelectorAll(".char-card.is-active, .v-cb.is-active").forEach((c) => c.classList.remove("is-active"));
      el.classList.add("is-active");
      // Wire the close button inside the freshly-rendered detail.
      slot.querySelectorAll('[data-action="char-collapse"]').forEach((btn) => {
        btn.addEventListener("click", () => {
          slot.innerHTML = "";
          el.classList.remove("is-active");
        });
      });
      // Smoothly bring the detail into view.
      slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
  // Update Overview sub-text — don't restate total runs (crest + hero own that).
  if (tab === "overview") {
    const $sub = document.getElementById("overview-sub");
    if ($sub) {
      // Short enough for one line in the stage's title column: a second line
      // would make Overview's header taller than the other tabs'.
      $sub.textContent = `${(report.overallWinrate * 100).toFixed(0)}% win rate · your form and streaks below`;
    }
  }
}

// =========================================================================
// Header crests — v209 redesign
// -------------------------------------------------------------------------
// Each themed stats tab gets a DIFFERENT header composition instead of the
// old identical title-left / diorama-right banner:
//
//   overview    → "War table":       four engraved stat plaques, centered.
//   characters  → "Hall of heroes":  five arched portrait frames with
//                                    per-character win-rate bars.
//   ascensions  → "The climb":       A0→A10 tick track lit to the highest
//                                    level reached, peak numeral beside it.
//   relics      → "Reliquary":       top-3 relics by honest win rate on a
//                                    glowing shelf.
//   cards       → "The hand":        the five most-picked cards fanned
//                                    like a hand of cards.
//
// Pure paint from the same `report` renderStatsTab already computed —
// no extra passes over parsedRuns beyond one cheap streak fold.
// =========================================================================
const CREST_ROSTER = ["ironclad", "silent", "defect", "regent", "necrobinder", "fool"];

function renderHeadCrests(report) {
  const crest = (name) => document.querySelector(`.head-crest[data-crest="${name}"]`);

  // Highest ascension reached — shared by the overview plaques and the
  // ascensions climb track.
  const highestAsc = (report.byAscension || [])
    .slice()
    .sort((a, b) => parseAsc(b.key) - parseAsc(a.key))
    .find((b) => b.runs > 0) || null;
  const hiLevel = highestAsc ? parseAsc(highestAsc.key) : -1;

  // New UI: the stage itself carries this data on every stats tab — spire
  // windows lit to the highest ascension, torches for the last ten runs —
  // so the Overview plaques (which repeated numbers shown again below)
  // are dropped. The Auto theme follows the most-played character.
  if (UI) {
    UI.Stage.renderStage(buildStageModel(hiLevel));
    UI.Theme.setAutoCharacter(mostPlayedCharacterKey(report));
  }

  // ---- Overview: war-table stat plaques --------------------------------
  const $ov = crest("overview");
  if ($ov && UI) {
    $ov.innerHTML = "";
  } else if ($ov) {
    const chrono = parsedRuns
      .slice()
      .sort((a, b) => (a.endedAt ? a.endedAt.getTime() : 0) - (b.endedAt ? b.endedAt.getTime() : 0));
    let bestStreak = 0;
    let cur = 0;
    for (const r of chrono) {
      cur = r.won ? cur + 1 : 0;
      if (cur > bestStreak) bestStreak = cur;
    }
    const plaques = [
      { v: `${(report.overallWinrate * 100).toFixed(0)}%`, l: "Win rate" },
      { v: bestStreak > 0 ? `${bestStreak}W` : "—", l: "Best streak" },
      { v: hiLevel >= 0 ? `A${hiLevel}` : "—", l: "Highest asc" },
    ];
    $ov.innerHTML = `
      <div class="crest-plaques">
        ${plaques.map((p) => `
          <div class="crest-plaque">
            <span class="crest-plaque-value">${esc(p.v)}</span>
            <span class="crest-plaque-label">${esc(p.l)}</span>
          </div>`).join("")}
      </div>`;
  }

  // ---- Characters: hall-of-heroes portrait rail ------------------------
  const $ch = crest("characters");
  if ($ch) {
    $ch.innerHTML = `
      <div class="crest-heroes">
        ${CREST_ROSTER.map((key) => {
          const b = (report.byCharacter || []).find((x) => x.key === key) || null;
          const theme = charTheme(key);
          const src = characterImageSrc(key);
          const wr = b && b.runs > 0 ? Math.round(b.winrate * 100) : null;
          const art = src
            ? `<img src="${src}" alt="" loading="lazy" decoding="async" />`
            : charIcon(theme.icon);
          return `
            <div class="crest-hero${b ? "" : " is-unplayed"}" style="--hero-color:${theme.color}" title="${esc(prettifyCharacterName(key))}${b ? ` — ${b.wins}W / ${b.runs - b.wins}L` : " — no runs yet"}">
              <div class="crest-hero-frame">${art}</div>
              <span class="crest-hero-name">${esc(prettifyCharacterName(key))}</span>
              <span class="crest-hero-bar"><i style="width:${wr ?? 0}%"></i></span>
              <span class="crest-hero-wr">${wr === null ? "—" : `${wr}%`}</span>
            </div>`;
        }).join("")}
      </div>`;
  }

  // ---- Ascensions: the climb track --------------------------------------
  const $as = crest("ascensions");
  if ($as) {
    // A10 is the current Early Access ceiling (see lib/ascension-info.js);
    // if Mega Crit raises it, the track stretches to whatever was reached.
    const cap = Math.max(10, hiLevel);
    const ticks = Array.from({ length: cap + 1 }, (_, i) => {
      const h = 10 + (i / cap) * 22;
      const lit = i <= hiLevel;
      const peak = i === hiLevel;
      return `<span class="crest-tick${lit ? " is-lit" : ""}${peak ? " is-peak" : ""}" style="height:${h.toFixed(1)}px"></span>`;
    }).join("");
    const note = highestAsc
      ? `${highestAsc.wins}W · ${highestAsc.runs - highestAsc.wins}L at the top`
      : "the climb starts at A0";
    $as.innerHTML = `
      <div class="crest-climb">
        <div class="crest-climb-peak">
          <span class="crest-climb-num">${hiLevel >= 0 ? `A${hiLevel}` : "A0"}</span>
          <span class="crest-climb-cap">highest reached</span>
        </div>
        <div class="crest-climb-rail" role="img" aria-label="Ascension progress: ${hiLevel >= 0 ? hiLevel : 0} of ${cap}">${ticks}</div>
        <span class="crest-climb-note">${esc(note)}</span>
      </div>`;
  }

  // ---- Relics: reliquary shelf ------------------------------------------
  const $re = crest("relics");
  if ($re) {
    const top = (report.byRelic || []).slice(0, 3);
    $re.innerHTML = top.length === 0 ? "" : `
      <div class="crest-shelf">
        ${top.map((b, i) => {
          const src = relicImageSrc(b.key);
          const art = src ? `<img src="${src}" alt="" loading="lazy" decoding="async" />` : "";
          return `
            <div class="crest-relic${i === 0 ? " is-first" : ""}" title="${esc(relicLabel(b.key))} — ${b.wins}W / ${b.runs - b.wins}L">
              <div class="crest-relic-orb">${art}</div>
              <span class="crest-relic-name">${esc(relicLabel(b.key))}</span>
              <span class="crest-relic-wr">${(b.winrate * 100).toFixed(0)}% win</span>
            </div>`;
        }).join("")}
      </div>`;
  }

  // ---- Cards: the hand ----------------------------------------------------
  const $ca = crest("cards");
  if ($ca) {
    const top = (report.topPickedCards || [])
      .filter((b) => cardImageSrc(b.key))
      .slice(0, 5);
    const n = top.length;
    $ca.innerHTML = n === 0 ? "" : `
      <div class="crest-fan" role="img" aria-label="Your five most-picked cards">
        ${top.map((b, i) => {
          const rot = (i - (n - 1) / 2) * 8;
          const lift = Math.abs(i - (n - 1) / 2) * 7;
          return `
            <div class="crest-fan-card" style="transform: rotate(${rot.toFixed(1)}deg) translateY(${lift.toFixed(1)}px)" title="${esc(cardLabel(b.key))} — picked ${b.runs}×">
              <img src="${cardImageSrc(b.key)}" alt="${esc(cardLabel(b.key))}" loading="lazy" decoding="async" />
            </div>`;
        }).join("")}
      </div>`;
  }
}

/**
 * Compact "Sample data" strip shown above the Overview body when
 * isDemoMode is true. The previous version was a 250px-tall card that
 * we rendered above EVERY stats tab body — it stole the fold on every
 * single navigation. The new design is:
 *   - A thin one-line strip with the eyebrow + a one-sentence pitch +
 *     the two primary CTAs (Find folder / Pick files), only on Overview.
 *   - The amber status pill in the global toolbar carries the same
 *     "showing sample data" signal on every tab so the user always
 *     knows what they're looking at.
 *   - The platform path block, deep-path hint, Steam Library warning,
 *     and FAQ list move behind a "Where are my saves?" `<details>` so
 *     they're one click away when needed and zero pixels otherwise.
 */
function renderDemoBanner() {
  const hasDirPicker = typeof window.showDirectoryPicker === "function";
  const primaryCTAs = hasDirPicker
    ? `<button class="btn-primary" data-action="scan">Find my STS2 saves</button>
       <button class="btn-ghost" data-action="upload">Pick files</button>`
    : `<button class="btn-primary" data-action="upload">Pick STS2 save files</button>`;

  const detected = detectPlatform();
  const detectedKey = detected === "windows" ? "win" : detected === "linux" ? "linux" : "mac";

  // Platform-specific instructions live in this single source of
  // truth. The UI renders all three as tabs (with the user's
  // detected platform pre-selected) so a Mac user prepping a
  // Windows friend can flip to the Windows tab without having to
  // be on Windows.
  const platforms = {
    win: {
      label: "Windows",
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z"/></svg>',
      path: HISTORY_PATH_WIN,
      fullPath: HISTORY_PATH_WIN_FULL,
      manager: "File Explorer",
      pickerSteps: [
        "Click <strong>Find my STS2 saves</strong> below (we copy the path to your clipboard).",
        "In the File Explorer dialog, click the <strong>address bar at the top</strong>, paste the path, hit <strong>Enter</strong>.",
        "Click <strong>Select Folder</strong> with <code>SlayTheSpire2</code> showing in the breadcrumb.",
      ],
      browserNote: "Works in Chrome, Edge, Brave, Firefox, and the Steam in-app browser. (Edge auto-remembers the folder so future sessions skip the picker.)",
    },
    mac: {
      label: "macOS",
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.4 1.7c0 1.3-.5 2.6-1.4 3.5-.9 1-2.5 1.7-3.7 1.6-.2-1.3.5-2.6 1.3-3.5.9-1 2.5-1.7 3.8-1.6zM20 17.4c-.6 1.3-.9 1.9-1.6 3-1 1.6-2.5 3.6-4.4 3.6-1.6 0-2.1-1-4.3-1-2.2 0-2.7 1-4.3 1-1.9 0-3.3-1.8-4.4-3.4-2.9-4.5-3.2-9.7-1.4-12.5C1 6 3 4.6 5 4.6c2 0 3.3 1.1 4.9 1.1 1.6 0 2.6-1.1 5-1.1 1.7 0 3.6.9 4.9 2.5-4.3 2.4-3.6 8.6 0 10.3z"/></svg>',
      path: HISTORY_PATH_MAC,
      fullPath: HISTORY_PATH_MAC_FULL,
      manager: "Finder",
      pickerSteps: [
        "Click <strong>Find my STS2 saves</strong> below (we copy the path to your clipboard).",
        "In the picker, press <strong>⌘⇧G</strong> (Cmd+Shift+G), paste, hit <strong>Enter</strong>.",
        "Click <strong>Select</strong> &mdash; you'll see <code>default</code>, <code>steam</code>, <code>logs</code> etc. inside. That's the right folder.",
      ],
      browserNote: "Works in Chrome, Edge, Brave, Arc, Safari (drag-drop only), and Firefox.",
    },
    linux: {
      label: "Linux / Deck",
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1.7 0 3 1.3 3 3 0 .8-.3 1.5-.7 2 1.5.7 2.7 2.5 2.7 4.5 0 .9-.2 1.7-.6 2.4 1.5.7 2.6 2.3 2.6 4.1 0 .5-.1 1-.2 1.5-.4 1.6-1.6 2.5-2.8 2.5-.6 0-1.3-.2-1.8-.6-.5.4-1.4.6-2.2.6h-.4c-.8 0-1.7-.2-2.2-.6-.5.4-1.2.6-1.8.6-1.2 0-2.4-.9-2.8-2.5-.1-.5-.2-1-.2-1.5 0-1.8 1.1-3.4 2.6-4.1-.4-.7-.6-1.5-.6-2.4 0-2 1.2-3.8 2.7-4.5-.4-.5-.7-1.2-.7-2 0-1.7 1.3-3 3-3z"/></svg>',
      path: HISTORY_PATH_LINUX,
      fullPath: HISTORY_PATH_LINUX_FULL,
      manager: "your file manager",
      pickerSteps: [
        "Click <strong>Find my STS2 saves</strong> below (we copy the path to your clipboard).",
        "In the file picker, press <strong>Ctrl+L</strong> (or click the path bar), paste, hit <strong>Enter</strong>.",
        "Click <strong>Select</strong> with <code>SlayTheSpire2</code> highlighted.",
      ],
      browserNote: "Works in Chrome, Edge, Firefox. On Steam Deck the desktop-mode browser handles it cleanly.",
    },
  };

  // Renders one panel per platform — the JS toggles between them
  // when the user clicks a tab. Pre-rendering all three keeps the
  // tab swap zero-latency (no fetch, no re-render).
  const platformPanel = (key) => {
    const p = platforms[key];
    return `
      <div class="ingest-platform-panel" data-platform-panel="${key}" ${key === detectedKey ? "" : "hidden"}>
        <div class="ingest-method ingest-method--primary">
          <div class="ingest-method-num">1</div>
          <div class="ingest-method-body">
            <strong class="ingest-method-title">Easiest: drag &amp; drop</strong>
            <p class="ingest-method-text">
              Open ${esc(p.manager)} at the path below, then <strong>drag the <code>SlayTheSpire2</code> folder</strong> directly onto this page. We walk it for <code>.run</code> files automatically. Works on every browser, no permission prompt.
            </p>
            <div class="demo-banner-path">
              <span class="path-label">Your STS2 save folder on ${esc(p.label)}</span>
              <code class="path-value">${esc(p.path)}</code>
              <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="${key}" title="Copy this path">Copy path</button>
            </div>
          </div>
        </div>

        <div class="ingest-method">
          <div class="ingest-method-num">2</div>
          <div class="ingest-method-body">
            <strong class="ingest-method-title">Or use the picker</strong>
            <ol class="ingest-steps">
              ${p.pickerSteps.map((s) => `<li>${s}</li>`).join("")}
            </ol>
            <p class="ingest-tip muted small">
              ${esc(p.browserNote)} The actual <code>.run</code> files live at
              <code>${esc(p.fullPath)}</code> &mdash; but you can pick any ancestor and we'll find them.
            </p>
          </div>
        </div>
      </div>`;
  };

  return `
    <div class="demo-banner is-compact" role="region" aria-label="Sample data notice">
      <button class="demo-banner-dismiss" type="button" data-action="dismiss-demo-banner" aria-label="Dismiss sample data notice" title="Hide this notice">&times;</button>
      <div class="demo-strip-row">
        <span class="demo-strip-eyebrow">Sample data</span>
        <span class="demo-strip-text">Demo preview. Point us at your STS2 save folder once &mdash; stats load in under a minute and stay saved on this device. No re&#8209;import next&nbsp;visit.</span>
        <div class="demo-strip-actions">${primaryCTAs}</div>
      </div>
      <details class="demo-strip-help">
        <summary>Where are my saves?</summary>
        <div class="demo-strip-help-body">

          <div class="ingest-platform-tabs" role="tablist" aria-label="Choose your operating system">
            ${["win", "mac", "linux"].map((k) => `
              <button type="button"
                      class="ingest-platform-tab${k === detectedKey ? " is-active" : ""}"
                      role="tab"
                      aria-selected="${k === detectedKey ? "true" : "false"}"
                      data-action="ingest-platform-switch"
                      data-platform-key="${k}">
                <span class="ingest-platform-tab-icon" aria-hidden="true">${platforms[k].icon}</span>
                <span>${esc(platforms[k].label)}</span>
                ${k === detectedKey ? '<span class="ingest-platform-tab-badge">Detected</span>' : ""}
              </button>
            `).join("")}
          </div>

          ${["win", "mac", "linux"].map((k) => platformPanel(k)).join("")}

          <div class="hints-warning">
            <strong>⚠ Don't pick "Browse Local Files" from Steam.</strong>
            That opens the game's <em>install</em> folder (the .app / .exe). Your saves live in a separate location, listed above.
          </div>

          <details class="demo-banner-hints">
            <summary>Other paths / troubleshooting</summary>
            <div class="hints-body">
              <ul class="hints-list">
                <li><strong>Steam Cloud fallback (Mac):</strong> if the macOS path above is empty, try <code>~/Library/Application Support/Steam/userdata/&lt;your-id&gt;/2868840/remote/</code>.</li>
                <li><strong>Steam Cloud fallback (Windows):</strong> <code>%PROGRAMFILES(X86)%\\Steam\\userdata\\&lt;your-id&gt;\\2868840\\remote\\</code> if the standard path is empty.</li>
                <li>On Chrome / Edge / Brave / Arc, the picker remembers your folder for next time &mdash; look for the green <em>Linked:</em> pill in the toolbar to confirm.</li>
                <li>Inside <code>history/</code> you'll see files named like <code>1735689420.run</code> &mdash; one per game. Pick any ancestor folder and we walk in.</li>
                <li><strong>Will I have to do this again?</strong> No &mdash; this is a one-time setup. Imported runs are stored permanently in this browser, and if you sign in with Steam they're also synced to the cloud, so they follow you to any device.</li>
              </ul>
            </div>
          </details>
        </div>
      </details>
    </div>`;
}

// Lazy-load the canonical KNOWN_SCHEMA_VERSIONS set from the parser.
// Used by the analytics beacon in commitParsedRuns to count runs on
// schema versions we haven't explicitly tested yet — that signal is
// still useful internally (lets us notice when a new STS2 build is
// landing in users' saves so we can prioritize a parser update),
// even though the matching user-facing "newer build" warning has
// been removed in favor of the live current-run card. Parser loads
// itself on-demand the first time .run files are ingested, so the
// import is essentially free here.
let cachedKnownSchemas = null;
async function loadKnownSchemas() {
  if (cachedKnownSchemas) return cachedKnownSchemas;
  const mod = await import("./lib/sts2-run-parser.js?v=3");
  cachedKnownSchemas = mod.KNOWN_SCHEMA_VERSIONS || new Set();
  return cachedKnownSchemas;
}
loadKnownSchemas().catch(() => { /* non-fatal */ });

/**
 * Live "you're currently in a game" card. Rendered above the overview
 * stats whenever the latest disk read surfaced a save file with run
 * shape but no completion (`win` field absent). Sits where the old
 * schema-version warning used to live, so the user's eye lands in
 * the same place — but instead of an apology about untested
 * versions, that fold of the page is now an actionable status block:
 * what character, what ascension, what floor, current HP and gold,
 * deck and relic counts, and a one-click expand to see the full
 * deck and relic list while still in-game.
 *
 * Renders as a single self-contained DOM block so the toggle handler
 * (`data-action="toggle-current-run"`) can flip a class on the root
 * element without touching anything else. Persistence of the
 * collapsed state lives in `currentRunCollapsed` (localStorage), so
 * a user who collapsed the card stays collapsed across auto-refresh
 * repaints.
 */
function renderCurrentRunCard(run) {
  if (!run) return "";
  const charKey = String(run.character || "").toLowerCase();
  const theme = charTheme(charKey);
  const charLabel = run.character ? prettifyCharacterName(run.character) : "Unknown character";
  const portrait = charPortraitOrIcon(charKey, theme);
  const asc = run.ascension != null ? `A${run.ascension}` : "—";
  const floor = run.floorReached || 0;
  const hpStr = (run.currentHp != null && run.maxHp != null)
    ? `${run.currentHp}/${run.maxHp}`
    : (run.currentHp != null ? String(run.currentHp) : "—");
  const hpPct = (run.currentHp != null && run.maxHp > 0)
    ? Math.max(0, Math.min(100, (run.currentHp / run.maxHp) * 100))
    : null;
  const hpTone = hpPct == null ? "" : (hpPct >= 60 ? "tone-win" : hpPct >= 30 ? "tone-warn" : "tone-loss");
  const gold = run.currentGold != null ? String(run.currentGold) : "—";
  const deckCount = Array.isArray(run.deckAtEnd) ? run.deckAtEnd.length : 0;
  const relicCount = Array.isArray(run.relics) ? run.relics.length : 0;
  // Time-since-start, computed from the run's start_time. Helpful for
  // "is this actually live or am I looking at yesterday's stuck save?"
  const ageMin = run.startedAt ? Math.max(0, Math.round((Date.now() - run.startedAt.getTime()) / 60000)) : null;
  const ageLabel = ageMin == null ? "" : ageMin < 1 ? "just started" : ageMin < 60 ? `${ageMin} min in` : `${(ageMin / 60).toFixed(1)} hr in`;
  const room = run.currentRoomType ? capitalize(run.currentRoomType) : null;
  // Game mode badge: surface anything other than the default
  // "standard" so a Daily / Trial / Custom run gets called out next
  // to the live status. STS2 currently ships "standard", "daily",
  // "custom", "trial".
  const modeKey = String(run.gameMode || "").toLowerCase();
  const modeLabel = modeKey && modeKey !== "standard" ? `${capitalize(modeKey)} run` : "Run";
  // Daily-modifier chips. Each modifier id was already stripped of
  // the "MODIFIER." prefix and lowercased by the parser; we
  // prettify here for display ("DOUBLE_TIME" → "Double Time").
  const modifierChips = (run.modifiers || []).slice(0, 6).map((m) => {
    const pretty = String(m).split("_").map((w) => w ? w[0].toUpperCase() + w.slice(1) : "").join(" ");
    return `<span class="cr-modifier-chip">${esc(pretty)}</span>`;
  }).join("");

  // Relic icons — show up to 8 in the collapsed pill row, render the
  // full list inside the expanded panel. Use the same image lookup
  // that the run-detail modal uses so we get the actual game art
  // when an asset exists and a clean glyph fallback when it doesn't.
  const relicChips = (run.relics || []).slice(0, 8).map((r) => {
    const src = relicImageSrc(r);
    const label = esc(relicLabel(r));
    if (src) {
      return `<span class="cr-relic-chip" title="${label}"><img src="${src}" alt="${label}" loading="lazy" decoding="async" /></span>`;
    }
    const initials = esc(label.split(/\s+/).map((w) => w[0] || "").join("").slice(0, 2).toUpperCase() || "?");
    return `<span class="cr-relic-chip cr-relic-chip-glyph" title="${label}">${initials}</span>`;
  }).join("");
  const relicMore = (run.relics?.length || 0) > 8 ? `<span class="cr-relic-more">+${run.relics.length - 8}</span>` : "";

  // Expanded body: full relic + deck breakdown. Deck is grouped by
  // card id with a count badge so a 4× Strike doesn't fill the whole
  // panel. Sorted by count desc so the most-impactful cards (the
  // ones the player has collected multiples of intentionally) sit at
  // the top.
  const relicListExpanded = (run.relics || []).map((r) => {
    const src = relicImageSrc(r);
    const label = esc(relicLabel(r));
    return `
      <li class="cr-relic-row">
        ${src ? `<img class="cr-relic-row-art" src="${src}" alt="" loading="lazy" decoding="async" />` : `<span class="cr-relic-row-art cr-relic-row-art-glyph" aria-hidden="true">${esc((relicLabel(r)[0] || "?").toUpperCase())}</span>`}
        <span class="cr-relic-row-name">${label}</span>
      </li>`;
  }).join("");

  const deckTally = new Map();
  for (const c of (run.deckAtEnd || [])) {
    deckTally.set(c, (deckTally.get(c) || 0) + 1);
  }
  const deckGrouped = [...deckTally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const deckListExpanded = deckGrouped.map(([id, n]) => {
    const src = cardImageSrc(id);
    const label = esc(cardLabel(id));
    return `
      <li class="cr-card-row">
        ${src ? `<img class="cr-card-row-art" src="${src}" alt="" loading="lazy" decoding="async" />` : `<span class="cr-card-row-art cr-card-row-art-glyph" aria-hidden="true"></span>`}
        <span class="cr-card-row-name">${label}</span>
        ${n > 1 ? `<span class="cr-card-row-count">×${n}</span>` : ""}
      </li>`;
  }).join("");

  const isOpen = !currentRunCollapsed;
  return `
    <section class="current-run-card${isOpen ? " is-open" : ""}" role="region" aria-label="Current run in progress" style="--cr-accent:${theme.color};">
      <button class="current-run-head" type="button" data-action="toggle-current-run" aria-expanded="${isOpen ? "true" : "false"}">
        <span class="cr-pulse" aria-hidden="true"><span class="cr-pulse-dot"></span></span>
        <span class="cr-portrait">${portrait}</span>
        <span class="cr-headline">
          <span class="cr-eyebrow">${esc(modeLabel)} in progress · ${esc(ageLabel || "live")}</span>
          <span class="cr-title">
            <strong>${esc(charLabel)}</strong>
            <span class="cr-asc">${esc(asc)}</span>
            <span class="cr-sep">·</span>
            <span class="cr-floor">Floor ${floor || "—"}</span>
            ${room ? `<span class="cr-room">${esc(room)}</span>` : ""}
            ${modifierChips}
          </span>
        </span>
        <span class="cr-stats">
          <span class="cr-stat ${hpTone}">
            <span class="cr-stat-label">HP</span>
            <span class="cr-stat-value">${esc(hpStr)}</span>
          </span>
          <span class="cr-stat">
            <span class="cr-stat-label">Gold</span>
            <span class="cr-stat-value">${esc(gold)}</span>
          </span>
          <span class="cr-stat">
            <span class="cr-stat-label">Deck</span>
            <span class="cr-stat-value">${deckCount}</span>
          </span>
          <span class="cr-stat">
            <span class="cr-stat-label">Relics</span>
            <span class="cr-stat-value">${relicCount}</span>
          </span>
        </span>
        <span class="cr-caret" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>
      <div class="current-run-body">
        ${hpPct != null ? `
          <div class="cr-hp-bar" aria-hidden="true">
            <span class="cr-hp-fill ${hpTone}" style="width:${hpPct.toFixed(1)}%"></span>
          </div>
        ` : ""}
        ${relicChips ? `
          <div class="cr-relic-row-wrap">
            <span class="cr-section-label">Relics</span>
            <span class="cr-relic-chip-row">${relicChips}${relicMore}</span>
          </div>
        ` : ""}
        <div class="cr-expanded-grid">
          <div class="cr-expanded-col">
            <h4 class="cr-section-heading">Relics (${relicCount})</h4>
            ${relicListExpanded ? `<ul class="cr-relic-list">${relicListExpanded}</ul>` : `<p class="cr-empty muted small">No relics yet.</p>`}
          </div>
          <div class="cr-expanded-col">
            <h4 class="cr-section-heading">Current deck (${deckCount})</h4>
            ${deckListExpanded ? `<ul class="cr-card-list">${deckListExpanded}</ul>` : `<p class="cr-empty muted small">No cards in deck yet.</p>`}
          </div>
        </div>
        <p class="cr-foot muted small">
          Live snapshot from your STS2 save. Refreshes whenever the auto-refresh loop re-reads the folder, or you press Refresh above.
        </p>
      </div>
    </section>`;
}

/**
 * v201 rough-edge #1 — non-standard STS2 paths.
 *
 * The default `%APPDATA%\SlayTheSpire2\…` hint covers a vanilla Steam
 * install on the system drive, but plenty of players have STS2 in a
 * secondary Steam library (D:/E:/F:), a portable install, or a
 * non-default save location set by mods / Documents redirection. The
 * verify worker on v200 flagged that we silently let those users
 * stare at a path that doesn't resolve.
 *
 * We can't enumerate the filesystem from the browser — that's a hard
 * security boundary — so the answer is to present the most common
 * alternates as copy-able candidates and to coach the user toward the
 * drag-drop path (which works regardless of where STS2 actually lives
 * on disk). Each entry below is rendered once with a Copy button.
 */
const ALT_SAVE_PATHS_WIN = [
  { label: "Steam library on D:",       path: "D:\\Steam\\steamapps\\common\\SlayTheSpire2\\saves\\history" },
  { label: "Steam library on E:",       path: "E:\\SteamLibrary\\steamapps\\common\\SlayTheSpire2\\saves\\history" },
  { label: "Default Program Files",     path: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\SlayTheSpire2\\saves\\history" },
  { label: "Documents (mod-redirected)", path: "%USERPROFILE%\\Documents\\My Games\\SlayTheSpire2\\saves\\history" },
];
const ALT_SAVE_PATHS_MAC = [
  { label: "Steam install dir",   path: "~/Library/Application Support/Steam/steamapps/common/SlayTheSpire2/saves/history" },
  { label: "iCloud / Documents",  path: "~/Documents/SlayTheSpire2/saves/history" },
  { label: "Custom Steam library", path: "/Volumes/<your-disk>/SteamLibrary/steamapps/common/SlayTheSpire2/saves/history" },
];
const ALT_SAVE_PATHS_LINUX = [
  { label: "Steam library (HOME)", path: "~/.steam/steam/steamapps/common/SlayTheSpire2/saves/history" },
  { label: "Proton compatdata",    path: "~/.steam/steam/steamapps/compatdata/2868840/pfx/drive_c/users/steamuser/AppData/Roaming/SlayTheSpire2/steam/<id>/profile1/saves/history" },
  { label: "Custom SteamLibrary",  path: "/mnt/games/SteamLibrary/steamapps/common/SlayTheSpire2/saves/history" },
];

/**
 * Lightweight format check for the paste-the-path field. Returns true
 * for things that *look* like a filesystem path on any of the three
 * platforms we ship for. Intentionally permissive — false positives
 * are cheap (the user just sees the personalized instructions for a
 * malformed string), false negatives stop a legit power-user dead.
 */
function looksLikeSavePath(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 3 || t.length > 1024) return false;
  return (
    /^[A-Za-z]:[\\/]/.test(t) ||           // C:\ or D:/ etc.
    /^%[A-Z_]+%[\\/]/.test(t) ||           // %APPDATA%\ or %USERPROFILE%\
    /^~[\\/]/.test(t) ||                   // ~/ or ~\
    /^\//.test(t)                          // /home/... or /Volumes/...
  );
}

/** Pick the most likely platform for a pasted path so the personalized
 *  instructions we render below it actually match the user's OS. */
function platformOfPath(s) {
  const t = String(s || "").trim();
  if (/^[A-Za-z]:[\\/]/.test(t) || /^%[A-Z_]+%/.test(t)) return "windows";
  if (/^~\/Library\//.test(t) || /^\/Volumes\//.test(t)) return "mac";
  if (/^~\/\.steam\//.test(t) || /^\/(home|mnt|opt|media)\//.test(t)) return "linux";
  return null;
}

/**
 * Build the markup for the "My saves are somewhere else" disclosure.
 * Renders a `<details>` so it stays collapsed by default — the hint
 * UI is supplementary; the primary path callout + CTAs stay visible.
 * Inside we list 3–4 alternate paths per platform, then a paste field
 * with honest copy about what the browser can and can't do with it.
 */
function renderAltPathsPanel(platform) {
  const list = platform === "mac"
    ? ALT_SAVE_PATHS_MAC
    : platform === "linux"
      ? ALT_SAVE_PATHS_LINUX
      : ALT_SAVE_PATHS_WIN;
  const altRows = list.map((p) => `
    <li class="alt-paths-row">
      <span class="alt-paths-row-label">${esc(p.label)}</span>
      <code class="alt-paths-row-path">${esc(p.path)}</code>
      <button class="btn-ghost btn-sm" type="button" data-action="copy-alt-path" data-path="${esc(p.path)}" title="Copy this path to the clipboard">Copy</button>
    </li>`).join("");
  // TODO(v0.9.10 desktop release): in the Tauri wrapper we can drop
  // the "browser can't read your filesystem" honesty caveat — register
  // tauri-plugin-fs with an explicit scope of `**/SlayTheSpire2/**`,
  // detect `window.__TAURI__` here, and call `readDir(path, …)` to
  // actually walk the user-supplied folder. That requires Cargo.toml
  // + tauri.conf.json edits and cutting a new .exe release, so we
  // ship the web-only UX nudge today and queue the desktop bridge as
  // a follow-up.
  return `
    <details class="alt-paths-panel" data-alt-paths-panel>
      <summary class="alt-paths-summary">
        <span class="alt-paths-summary-icon" aria-hidden="true">📁</span>
        <span>My saves are somewhere else</span>
        <span class="alt-paths-summary-hint">(portable Steam, secondary library, custom path)</span>
      </summary>
      <div class="alt-paths-body">
        <p class="alt-paths-lede muted small">
          STS2 can live on any drive Steam knows about. Here are the four most common spots — copy whichever matches your install, then paste it into the picker's address bar.
        </p>
        <ul class="alt-paths-list">
          ${altRows}
        </ul>
        <div class="alt-paths-divider" aria-hidden="true">
          <span>or paste your custom path</span>
        </div>
        <div class="alt-paths-paste">
          <label class="alt-paths-paste-label" for="alt-paths-paste-input">
            Your STS2 save folder
          </label>
          <div class="alt-paths-paste-row">
            <input
              id="alt-paths-paste-input"
              class="alt-paths-paste-input"
              type="text"
              spellcheck="false"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              placeholder="e.g. F:\\Games\\SlayTheSpire2\\saves\\history"
              data-alt-paths-input
            />
            <button class="btn-primary btn-sm" type="button" data-action="alt-paths-use" disabled>Use this path</button>
          </div>
          <p class="alt-paths-honest muted small">
            <strong>Heads-up:</strong> browsers can't read arbitrary paths from a text field — that's a security boundary we can't cross from the web. We use what you paste to <em>personalize the next step</em>: we copy it to your clipboard, then you paste it into the file picker's address bar (Ctrl+L on Windows / Cmd+Shift+G on macOS) to jump there in one move instead of clicking through folders.
          </p>
          <div class="alt-paths-personalized" data-alt-paths-personalized hidden></div>
        </div>
      </div>
    </details>`;
}

/**
 * Wire the alt-paths disclosure (copy buttons + paste field).
 *
 * Called from any surface that embeds the panel (currently the
 * stats-tab empty state). Idempotent: querying inside `root` means
 * re-renders of a sibling region don't double-wire these controls.
 *
 * The paste field never actually reads the user's filesystem — it
 * just lights up a personalized "Step 1: copy this / Step 2: paste
 * into picker" panel and copies the literal text to the clipboard
 * so the OS picker dialog opens at (or near) the right folder. The
 * honest copy in the markup is deliberate; previous one-click
 * "Open in Explorer" affordances confused users into thinking we
 * could actually access their disk from the web.
 */
function wireAltPathsPanel(root) {
  if (!root) return;
  root.querySelectorAll('[data-action="copy-alt-path"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const path = btn.dataset.path || "";
      if (!path) return;
      try {
        await navigator.clipboard.writeText(path);
        const original = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
        setTimeout(() => {
          btn.textContent = original;
          btn.classList.remove("is-copied");
        }, 1500);
        sendBeacon("import-alt-path-copied", `path=${path.slice(0, 60)}`);
      } catch {
        toast("Couldn't copy. Select the path and copy manually.");
      }
    });
  });

  const input = root.querySelector("[data-alt-paths-input]");
  const useBtn = root.querySelector('[data-action="alt-paths-use"]');
  const personalized = root.querySelector("[data-alt-paths-personalized]");
  if (input && useBtn && personalized) {
    const refreshBtnState = () => {
      useBtn.disabled = !looksLikeSavePath(input.value);
    };
    input.addEventListener("input", refreshBtnState);
    input.addEventListener("paste", () => setTimeout(refreshBtnState, 0));
    refreshBtnState();

    useBtn.addEventListener("click", async () => {
      const raw = (input.value || "").trim();
      if (!looksLikeSavePath(raw)) {
        toast("That doesn't look like a save path. Expected something like C:\\… or /Volumes/…");
        return;
      }
      const pathPlatform = platformOfPath(raw) || detectPlatform();
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(raw);
          copied = true;
        }
      } catch { /* clipboard denied — fall through */ }
      const pickerHint = pathPlatform === "windows"
        ? "Click the address bar at the top of File Explorer, paste the path, hit <kbd>Enter</kbd>."
        : pathPlatform === "mac"
          ? "Press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> inside the picker, paste, hit <kbd>Enter</kbd>."
          : "Press <kbd>Ctrl</kbd>+<kbd>L</kbd> inside the picker, paste, hit <kbd>Enter</kbd>.";
      personalized.hidden = false;
      personalized.innerHTML = `
        <div class="alt-paths-personalized-card">
          <strong class="alt-paths-personalized-title">${copied ? "✓ Copied to clipboard" : "Your path"}</strong>
          <code class="alt-paths-personalized-path">${esc(raw)}</code>
          <ol class="alt-paths-personalized-steps">
            <li><strong>Click <em>Find my STS2 saves</em> or <em>Pick files</em></strong> above to open the file picker.</li>
            <li>${pickerHint}</li>
            <li>Click <strong>Select Folder</strong> when you see <code>SlayTheSpire2</code> (or <code>history</code>) in the breadcrumb — we walk every subfolder for <code>.run</code> files.</li>
          </ol>
          <p class="alt-paths-personalized-foot muted small">
            Reminder: this is a UX nudge — we don't read your filesystem from the browser. The picker still has to open and you click <em>Select</em>. ${copied ? "" : "(Clipboard copy was blocked by the browser — select the path above and copy manually.)"}
          </p>
        </div>`;
      sendBeacon("import-paste-path-used", `platform=${pathPlatform} copied=${copied}`);
    });
  }
}

// ---- No-runs empty state in the new UI (lib/ui/views-empty.js) -------------
// Same CTAs, paths, alt-path panel and data-action hooks as the classic
// markup below, so renderStatsTab's wiring (scan, upload, copy, alt paths,
// restore, sign-in) serves both. The sequence keeps ids unique when more
// than one tab body holds an empty state.
let nextEmptyStateSeq = 0;

function renderEmptyStateNext() {
  const platform = detectPlatform();
  let backupCount = 0;
  try {
    const backup = JSON.parse(localStorage.getItem(STORAGE_LOCAL_BACKUP) || "null");
    if (backup?.count > 0) backupCount = backup.count;
  } catch { /* storage unavailable: no hint */ }
  nextEmptyStateSeq += 1;
  return UI.EmptyView.emptyStateHtml({
    uid: String(nextEmptyStateSeq),
    platform: platform === "mac" || platform === "windows" || platform === "linux" ? platform : "other",
    hasDirPicker: typeof window.showDirectoryPicker === "function",
    canKeepFolder: canKeepSaveFolder(),
    signedIn: !!session?.steamID,
    personaName: session?.personaName || "Steam User",
    backupCount,
    paths: {
      mac: { folder: HISTORY_PATH_MAC, full: HISTORY_PATH_MAC_FULL },
      windows: { folder: HISTORY_PATH_WIN, full: HISTORY_PATH_WIN_FULL },
      linux: { folder: HISTORY_PATH_LINUX, full: HISTORY_PATH_LINUX_FULL },
    },
    altPaths: platform === "mac" ? ALT_SAVE_PATHS_MAC : platform === "linux" ? ALT_SAVE_PATHS_LINUX : ALT_SAVE_PATHS_WIN,
  });
}

function renderEmptyState() {
  if (UI?.EmptyView) return renderEmptyStateNext();
  const platform = detectPlatform();
  const hasDirPicker = typeof window.showDirectoryPicker === "function";

  // Platform-specific path callout. The path constant points at the
  // SlayTheSpire2/ parent on each OS; the directory walker recurses
  // into steam/<your-id>/profile1/saves/history/, so the user never
  // has to know their numeric Steam ID.
  // v201: surface the FULL deep path (down to history/) as the primary
  // copy target. The verify worker on v200 flagged that the previous
  // hint only showed the SlayTheSpire2/ parent, leaving the user to
  // guess at the nested steam/<id>/profile1/saves/history layout. We
  // now show the literal full path with a <your-steam-id> placeholder
  // so the user understands what to replace. The clipboard receives
  // the same literal so when they paste into the OS picker they land
  // close enough to the right spot to navigate the last step manually.
  // (The drag-drop nudge below this block is the zero-effort path.)
  let pathBlock = "";
  if (platform === "mac") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Your STS2 save folder on macOS</span>
        <code class="path-value">${esc(HISTORY_PATH_MAC_FULL)}</code>
        <button class="btn-ghost btn-sm" type="button" data-action="copy-alt-path" data-path="${esc(HISTORY_PATH_MAC_FULL)}" title="Copy path. Paste with Cmd+Shift+G inside the picker.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        After the picker opens, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>, paste, and hit Enter. Replace <code>&lt;your-steam-id&gt;</code> with your numeric Steam ID, or pick any ancestor and we walk into <code>history/</code> for you.
      </p>`;
  } else if (platform === "windows") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Your STS2 save folder on Windows</span>
        <code class="path-value">${esc(HISTORY_PATH_WIN_FULL)}</code>
        <button class="btn-ghost btn-sm" type="button" data-action="copy-alt-path" data-path="${esc(HISTORY_PATH_WIN_FULL)}" title="Copy path. Paste it into File Explorer's address bar.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        Paste into File Explorer's address bar. Replace <code>&lt;your-steam-id&gt;</code> with your numeric Steam ID, or pick the <code>SlayTheSpire2</code> parent and we walk into <code>history\\</code> for you.
      </p>`;
  } else if (platform === "linux") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Your STS2 save folder on Linux</span>
        <code class="path-value">${esc(HISTORY_PATH_LINUX_FULL)}</code>
        <button class="btn-ghost btn-sm" type="button" data-action="copy-alt-path" data-path="${esc(HISTORY_PATH_LINUX_FULL)}" title="Copy path. Paste it into your file manager.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        Pick any ancestor and we walk into <code>history/</code> for you.
      </p>`;
  }

  // v201 rough-edge #1: layered hint UI. The primary default path
  // (above) covers the vanilla Steam install. This middle nudge is
  // the universal escape hatch — drag-drop works from any path on
  // any drive on any browser, no permission prompt, so it's the
  // safest fallback we can offer to the long tail of users with
  // portable / secondary-library installs.
  const dragNudge = `
    <p class="empty-state-drag-nudge" role="note">
      <span class="drag-nudge-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><polyline points="19 12 12 19 5 12"/></svg>
      </span>
      On a different drive or portable install?
      <strong class="drag-nudge-strong">Drag the <code>SlayTheSpire2</code> folder onto this page</strong>
      — works from any path, no permission prompt.
    </p>`;

  const altPathsPanel = renderAltPathsPanel(platform);

  // Two CTAs: the smart one (folder picker) for Chromium, and the
  // multi-file picker as a universal fallback. Drag-drop a folder is
  // also supported via the overlay.
  const primaryCTA = hasDirPicker
    ? `<button class="btn-primary" data-action="scan">Find my STS2 saves</button>
       <button class="btn-ghost" data-action="upload">Pick files instead</button>`
    : `<button class="btn-primary" data-action="upload">Pick STS2 save files</button>`;

  // Context-aware copy + cloud-restore CTA for signed-in users.
  //
  // The user pain point we're solving: every fresh device or
  // browser session, signed-in users were being asked to re-pick
  // their save folder, even though their runs are already synced
  // to their Steam account in the cloud. The cloud-restore path
  // existed but was invisible — the boot's auto-hydrate runs in
  // the background and either succeeds (you see your runs) or
  // silently fails (you see the empty state and assume you have
  // to start over). Now we surface a manual "Restore my runs from
  // Steam" button on the empty state for signed-in users so the
  // cloud copy is one click away even when auto-hydrate hiccups.
  const isSignedIn = !!session?.steamID;
  const cloudRestoreCTA = isSignedIn
    ? `<button class="btn-primary" type="button" data-action="restore-from-cloud">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:6px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/></svg>
         Restore my runs from Steam
       </button>`
    : "";
  let backupHint = "";
  if (parsedRuns.length === 0) {
    try {
      const backup = JSON.parse(localStorage.getItem(STORAGE_LOCAL_BACKUP) || "null");
      if (backup?.count > 0) {
        backupHint = `<p class="empty-state-backup-hint muted">We had <strong>${backup.count}</strong> runs saved on this device before — try <strong>Restore from Steam</strong> or reconnect your save folder. You shouldn't need to start over.</p>`;
      }
    } catch { /* ok */ }
  }
  const headlineHtml = isSignedIn
    ? `<h2>Restore your runs from Steam</h2>
       <p>You're signed in as <strong>${esc(session?.personaName || "Steam User")}</strong>. If you've already uploaded run history on another device, click <strong>Restore my runs from Steam</strong> below and we'll pull your cloud copy now. If this is your first device, point us at your STS2 save folder and we'll sync it to your Steam account${canKeepSaveFolder() ? " &mdash; <strong>you only do this once.</strong>" : ". New runs come in with <strong>Refresh</strong> and one more pick of the same folder."}</p>`
    : `<h2>See your STS2 stats — no sign-in required</h2>
       <p>Slay the Spire 2 saves one <code>.run</code> file per game. Point us at your STS2 save folder (or drag it in) and we'll read every run on disk to build your stats. Nothing uploads &mdash; everything stays in your browser. <strong>Sign in with Steam once</strong> to keep your history forever and sync it across devices.</p>`;

  return `
    <div class="empty-state${isSignedIn ? " empty-state--authed" : ""}">
      <div class="empty-state-icon">📂</div>
      ${headlineHtml}
      ${backupHint}
      <div class="empty-state-actions">
        ${cloudRestoreCTA}
        ${primaryCTA}
        ${!isSignedIn ? '<button class="btn-ghost" type="button" data-action="signin-cta"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="margin-right:6px"><path d="M12 2a10 10 0 0 0-9.96 9.04l5.35 2.21a2.83 2.83 0 0 1 1.6-.49l2.39-3.46v-.05a3.78 3.78 0 1 1 3.78 3.78h-.09l-3.4 2.43a2.84 2.84 0 0 1-5.62.6L2.3 14.5A10 10 0 1 0 12 2Zm-4.73 15.17-1.23-.51a2.13 2.13 0 1 0 1.17-2.9l1.27.52a1.57 1.57 0 1 1-1.2 2.9Zm10.04-7.72a2.52 2.52 0 1 0-2.52 2.52 2.52 2.52 0 0 0 2.52-2.52Zm-4.4 0a1.89 1.89 0 1 1 1.89 1.89 1.89 1.89 0 0 1-1.9-1.89Z"/></svg>Sign in with Steam</button>' : ""}
      </div>
      <p class="empty-state-tip">
        Or drag your STS2 <strong>save folder</strong> (or any <code>.run</code> files) anywhere on this page to load them now.
      </p>
      ${pathBlock}
      ${dragNudge}
      ${altPathsPanel}
      <div class="empty-state-warning">
        <strong>⚠ Don't use Steam Library → "Browse local files"</strong> — that opens the game's <em>install</em> folder (the .app / .exe), not your saves. Saves live in the path above.
      </div>
      <details class="empty-state-hints">
        <summary>I still can't find them</summary>
        <ul>
          <li><strong>macOS:</strong> <code>${esc(HISTORY_PATH_MAC_FULL)}</code></li>
          <li><strong>Windows:</strong> <code>${esc(HISTORY_PATH_WIN_FULL)}</code></li>
          <li><strong>Linux / Steam Deck:</strong> <code>${esc(HISTORY_PATH_LINUX_FULL)}</code></li>
          <li><strong>Steam Cloud fallback (Mac):</strong> if the path above is empty, try <code>~/Library/Application Support/Steam/userdata/&lt;your-id&gt;/2868840/remote/</code>.</li>
          <li>Inside the <code>history/</code> folder you'll see files named like <code>1735689420.run</code> — one per game. Pick the <code>SlayTheSpire2</code> parent and we walk in; or pick the <code>history/</code> folder directly. Either works.</li>
          <li>${canKeepSaveFolder()
            ? `Picking the folder once enables silent auto-refresh on every later visit. The "Linked: <em>folder</em>" pill in the header confirms it.`
            : `Your runs stay in this browser. Browsers can't keep access to this folder on ${detectPlatform() === "mac" ? "a Mac" : "Windows"}, so after new runs press <strong>Refresh</strong> and pick it again; the path is copied for you.`}</li>
          <li>Already have a <code>history.json</code> rollup from the macOS Vault CLI? That still works — just drop it in.</li>
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
  regent:      { color: "#d4af37", icon: "crown"  },
  necrobinder: { color: "#b27dff", icon: "skull"  },
  fool:        { color: "#f27ec0", icon: "note"   }, // STS2 public beta (v0.113.0)
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
    note:   '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  };
  return `<svg class="char-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${map[key] || map.shield}</svg>`;
}

/** Returns an <img> with the character's actual portrait when we have
 *  art for that slug, otherwise falls back to the abstract SVG glyph.
 *  The image and SVG share the same containing slot dimensions, so
 *  layouts don't shift between assetless boots and asset-loaded ones. */
function charPortraitOrIcon(name, theme) {
  const src = characterImageSrc(name);
  if (src) {
    return `<img class="char-portrait" src="${src}" alt="${esc(capitalize(name || ""))}" loading="lazy" decoding="async" />`;
  }
  return charIcon(theme?.icon || "shield");
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

// =========================================================================
// KPI strip + analytics charts (Overview)
// -------------------------------------------------------------------------
// New value-prop layer added in v49. The Overview previously answered
// only "what's my lifetime winrate?". The KPI strip answers six more
// questions every session: am I on a streak, what's my last-10 form,
// have I been playing this week, what's my personal-best floor, my
// best-ever streak, and my fastest win? The two charts that follow
// (rolling winrate over time + floor-death histogram) answer "am I
// improving" and "where do I die" respectively.
//
// Pure functions of `parsedRuns`. Cheap (O(n) once) and side-effect
// free, so they re-run on every render without a dirty cache.
// =========================================================================

/** Sort runs newest → oldest. Some parsers return runs in different
 *  orders depending on FS iteration; sort defensively so streaks /
 *  recent form are deterministic. */
function runsByDateDesc(runs) {
  return runs.slice().sort((a, b) => {
    const ta = a.endedAt ? a.endedAt.getTime() : (a.startedAt ? a.startedAt.getTime() : 0);
    const tb = b.endedAt ? b.endedAt.getTime() : (b.startedAt ? b.startedAt.getTime() : 0);
    return tb - ta;
  });
}

/** Current streak = number of consecutive most-recent runs with the same
 *  outcome. Returns { kind: "win"|"loss"|"none", count: number }. */
function currentStreak(runs) {
  const sorted = runsByDateDesc(runs);
  if (!sorted.length) return { kind: "none", count: 0 };
  const kind = sorted[0].won ? "win" : "loss";
  let count = 0;
  for (const r of sorted) {
    if ((r.won === true) === (kind === "win")) count += 1;
    else break;
  }
  return { kind, count };
}

/** Longest win streak ever. Walks chronologically and tracks max,
 *  remembering the run that *completed* the streak so we can show the
 *  user a date + character on the KPI card. Returns
 *  `{ count, endedAt, character, ascension }` (endedAt is a Date or null). */
function longestWinStreakDetails(runs) {
  const sorted = runs.slice().sort((a, b) => {
    const ta = a.endedAt ? a.endedAt.getTime() : 0;
    const tb = b.endedAt ? b.endedAt.getTime() : 0;
    return ta - tb;
  });
  let max = 0;
  let cur = 0;
  let bestEndIdx = -1;
  let curEndIdx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    const r = sorted[i];
    if (r.won) {
      cur += 1;
      curEndIdx = i;
      if (cur > max) { max = cur; bestEndIdx = curEndIdx; }
    } else {
      cur = 0;
      curEndIdx = -1;
    }
  }
  if (bestEndIdx < 0) return { count: 0, endedAt: null, character: null, ascension: null };
  const ender = sorted[bestEndIdx];
  return {
    count: max,
    endedAt: ender.endedAt || null,
    character: ender.character || null,
    ascension: Number.isFinite(ender.ascension) ? ender.ascension : null,
    gameMode: ender.gameMode || null,
  };
}

/** Backwards-compatible thin wrapper if anything still imports the
 *  old name. */
function longestWinStreak(runs) {
  return longestWinStreakDetails(runs).count;
}

/** Short human date used inside KPI sub-copy. `Mar 14, 2026`. */
function formatShortDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Returns the run with the highest floor reached. Ties broken by win
 *  status (wins beat losses), then by ascension level. */
function pbFloorRun(runs) {
  let best = null;
  for (const r of runs) {
    if (!Number.isFinite(r.floorReached)) continue;
    if (!best
      || r.floorReached > best.floorReached
      || (r.floorReached === best.floorReached && r.won && !best.won)
      || (r.floorReached === best.floorReached && r.won === best.won && (r.ascension ?? 0) > (best.ascension ?? 0))
    ) best = r;
  }
  return best;
}

/** Fastest win across the dataset (smallest playTimeSeconds among wins). */
function fastestWinRun(runs) {
  let best = null;
  for (const r of runs) {
    if (!r.won || !Number.isFinite(r.playTimeSeconds) || r.playTimeSeconds <= 0) continue;
    if (!best || r.playTimeSeconds < best.playTimeSeconds) best = r;
  }
  return best;
}

/** Run counts in the rolling 7-day window vs. the previous 7-day window.
 *  Used to render the "This week" delta. */
function weeklyCadence(runs) {
  const now = Date.now();
  let thisWeek = 0;
  let prevWeek = 0;
  for (const r of runs) {
    const age = runAgeMs(r, now);
    if (age < WEEK_MS) thisWeek += 1;
    else if (age < 2 * WEEK_MS) prevWeek += 1;
  }
  return { thisWeek, prevWeek, delta: thisWeek - prevWeek };
}

/** Tiny SVG sparkline path (last N runs as W/L points → a normalized
 *  cumulative winrate line). Returns an inline <svg>. */
function sparklineLastN(runs, n = 10) {
  const last = runsByDateDesc(runs).slice(0, n).reverse();
  if (last.length < 2) return "";
  const w = 56;
  const h = 22;
  const stepX = w / (last.length - 1);
  let cumWins = 0;
  const pts = last.map((r, i) => {
    cumWins += r.won ? 1 : 0;
    const wr = cumWins / (i + 1);
    const x = i * stepX;
    const y = h - (wr * h);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0].toFixed(1)} ${p[1].toFixed(1)}` : `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`)).join(" ");
  const lastPt = pts[pts.length - 1];
  return `<svg class="kpi-card-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path d="${d}"></path>
    <circle class="pt" cx="${lastPt[0].toFixed(1)}" cy="${lastPt[1].toFixed(1)}" r="2"></circle>
  </svg>`;
}

function renderKPIStrip(runs) {
  const total = runs.length;
  if (total === 0) return "";

  // ── Card 1: Recent form ────────────────────────────────────────────
  // Headline value is a percentage (`30%`) so the user sees instantly
  // whether they're winning or losing recent runs. Sub-copy compares
  // against lifetime average with a signed delta and a green/red glyph.
  const sortedRecent = runsByDateDesc(runs);
  const last10 = sortedRecent.slice(0, 10);
  const last10Wins = last10.filter((r) => r.won).length;
  const last10Pct = last10.length ? Math.round((last10Wins / last10.length) * 100) : 0;
  const lifetimeWins = runs.filter((r) => r.won).length;
  const lifetimePct = Math.round((lifetimeWins / total) * 100);
  const last10Tone = last10Pct >= lifetimePct + 1 ? "win"
    : (last10Pct + 5 < lifetimePct ? "loss" : "accent");
  const trend = last10Pct - lifetimePct;
  const trendGlyph = trend > 0 ? "▲" : trend < 0 ? "▼" : "●";
  const trendClass = trend > 0 ? "is-up" : trend < 0 ? "is-down" : "is-flat";
  const recentFormSub = total < 11
    ? `${last10Wins}W &ndash; ${last10.length - last10Wins}L &middot; need 11+ runs for trend`
    : trend > 0
      ? `${last10Wins}W &ndash; ${last10.length - last10Wins}L &middot; <strong>+${Math.abs(trend)}</strong> vs. lifetime`
      : trend < 0
        ? `${last10Wins}W &ndash; ${last10.length - last10Wins}L &middot; <strong>&minus;${Math.abs(trend)}</strong> vs. lifetime`
        : `${last10Wins}W &ndash; ${last10.length - last10Wins}L &middot; on par with lifetime`;
  const recentFormCard = `
      <div class="kpi-card kpi-card--spark" role="listitem" data-tone="${last10Tone}">
        <span class="kpi-card-label">${SEC_ICONS.bolt} Recent form</span>
        <span class="kpi-card-value">
          <span class="kpi-trend ${trendClass}" aria-hidden="true">${trendGlyph}</span>${last10Pct}<span class="kpi-unit">%</span>
        </span>
        <span class="kpi-card-sub">${recentFormSub}</span>
        ${sparklineLastN(runs, 10)}
      </div>`;

  // ── Card 2: Active streak ──────────────────────────────────────────
  // Direction is encoded in:
  //   - the card label (`Win streak` vs `Loss streak`)
  //   - the card tone (green border + green value vs red)
  //   - the sub-copy ("3 in a row...")
  // …so the value itself is just the count. The previous "4L" suffix
  // looked like a line-noise artifact next to a 24px number; dropping
  // it makes the headline number breathe.
  const streak = currentStreak(runs);
  const streakTone = streak.kind === "win" ? "win" : (streak.kind === "loss" ? "loss" : "accent");
  const longestDetail = longestWinStreakDetails(runs);
  const longest = longestDetail.count;
  const streakLabel = streak.kind === "win"
    ? `${SEC_ICONS.sparkles} Win streak`
    : streak.kind === "loss"
      ? `${SEC_ICONS.bolt} Loss streak`
      : `${SEC_ICONS.sparkles} Active streak`;
  const streakValue = streak.kind === "none" ? `0` : `${streak.count}`;
  const streakSub = streak.kind === "win"
    ? (streak.count === 1
        ? `One win &mdash; keep the momentum`
        : longest > streak.count
          ? `${streak.count} in a row &middot; PB <strong>${longest}</strong>`
          : `${streak.count} in a row &mdash; new personal best`)
    : streak.kind === "loss"
      ? (streak.count === 1
          ? `One loss &mdash; reset and re&#8209;roll`
          : `${streak.count} in a row &mdash; reset and re&#8209;roll`)
      : `No active streak yet &mdash; play a run`;
  const streakCard = `
      <div class="kpi-card" role="listitem" data-tone="${streakTone}">
        <span class="kpi-card-label">${streakLabel}</span>
        <span class="kpi-card-value">${streakValue}</span>
        <span class="kpi-card-sub">${streakSub}</span>
      </div>`;

  // ── Card 3: Longest win streak ─────────────────────────────────────
  // Sub-copy keeps the *most interesting* fact only — the character
  // who set the record. Date is dropped to stop the line wrapping
  // into three lines on narrow cards. Lifetime context lives on the
  // dedicated Characters tab.
  const longestSub = longest > 0
    ? (longestDetail.character
        ? `Set on <strong>${esc(prettifyCharacterName(longestDetail.character))}</strong>${ascAtPhrase(longestDetail.ascension, longestDetail.gameMode)}`
        : `Set across your run history`)
    : `Win two in a row to start one`;
  const longestCard = `
      <div class="kpi-card" role="listitem" data-tone="gold">
        <span class="kpi-card-label">${SEC_ICONS.bars} Longest win streak</span>
        <span class="kpi-card-value">${longest}<span class="kpi-unit">${longest === 1 ? "win" : "wins"}</span></span>
        <span class="kpi-card-sub">${longestSub}</span>
      </div>`;

  // ── Card 4: Best floor ─────────────────────────────────────────────
  // Drop the redundant "Floor" prefix from the value — the LABEL
  // already says "Best floor", so showing it twice was visual stutter.
  // Just the number now, with character + ascension as sub-copy.
  const pb = pbFloorRun(runs);
  const pbValue = pb ? `${pb.floorReached}` : "&mdash;";
  const pbSub = pb
    ? `<strong>${esc(prettifyCharacterName(pb.character || "Unknown"))}</strong>${ascAtPhrase(pb.ascension, pb.gameMode)}${pb.won ? ` &middot; Victory` : ""}`
    : `Play one run to set this`;
  const pbCard = `
      <div class="kpi-card" role="listitem" data-tone="accent">
        <span class="kpi-card-label">${SEC_ICONS.bars} Best floor</span>
        <span class="kpi-card-value">${pbValue}</span>
        <span class="kpi-card-sub">${pbSub}</span>
      </div>`;

  // ── Card 5: Fastest victory ────────────────────────────────────────
  const fastest = fastestWinRun(runs);
  const fastestValue = fastest
    ? formatPlayTimeStrict(fastest.playTimeSeconds) || `${Math.round(fastest.playTimeSeconds / 60)}m`
    : "—";
  const fastestSub = fastest
    ? `<strong>${esc(prettifyCharacterName(fastest.character || "Unknown"))}</strong>${ascAtPhrase(fastest.ascension, fastest.gameMode)}`
    : `No victories yet`;
  const fastestCard = `
      <div class="kpi-card" role="listitem" data-tone="win">
        <span class="kpi-card-label">${SEC_ICONS.clock} Fastest victory</span>
        <span class="kpi-card-value">${esc(fastestValue)}</span>
        <span class="kpi-card-sub">${fastestSub}</span>
      </div>`;

  // ── Card 6: Runs this week ─────────────────────────────────────────
  const cadence = weeklyCadence(runs);
  const cadenceTone = cadence.delta > 0 ? "win"
    : cadence.delta < 0 ? "loss"
      : "accent";
  const cadenceSub = cadence.prevWeek === 0 && cadence.thisWeek > 0
    ? `Back at it after a quiet stretch`
    : cadence.delta > 0
      ? `<strong>+${cadence.delta}</strong> vs. last week`
      : cadence.delta < 0
        ? `<strong>${cadence.delta}</strong> vs. last week`
        : `Same pace as last week`;
  const cadenceCard = `
      <div class="kpi-card" role="listitem" data-tone="${cadenceTone}">
        <span class="kpi-card-label">${SEC_ICONS.clock} Runs this week</span>
        <span class="kpi-card-value">${cadence.thisWeek}<span class="kpi-unit">${cadence.thisWeek === 1 ? "run" : "runs"}</span></span>
        <span class="kpi-card-sub">${cadenceSub}</span>
      </div>`;

  // The wrapper is a size container: the strip's own width picks six
  // columns or three (styles.css .kpi-strip-wrap), never 5 + 1.
  return `
    <div class="kpi-strip-wrap">
      <div class="kpi-strip" role="list" aria-label="At-a-glance KPIs">
        ${recentFormCard}
        ${streakCard}
        ${longestCard}
        ${pbCard}
        ${fastestCard}
        ${cadenceCard}
      </div>
    </div>`;
}

/** True when the active viewport is phone-sized. Used by chart
 *  renderers to emit a tighter viewBox so the same SVG is legible at
 *  ~360px wide instead of scaling 10px text down to ~5px. Cached per
 *  call rather than module-scope so a resize → re-render picks up the
 *  new state without a stale flag. */
function isPhoneViewport() {
  if (typeof window === "undefined") return false;
  try { return window.matchMedia("(max-width: 720px)").matches; }
  catch { return (window.innerWidth || 0) <= 720; }
}

/**
 * Rolling-10 winrate line over chronological run index. The Y-axis is
 * 0–100% winrate of the trailing 10-run window. Helps the user see
 * *trends* — am I getting better, plateauing, or sliding back? — that
 * no lifetime average can show. Pure SVG, no dependency.
 */
function renderWinrateChart(runs) {
  const sorted = runs.slice().sort((a, b) => {
    const ta = a.endedAt ? a.endedAt.getTime() : 0;
    const tb = b.endedAt ? b.endedAt.getTime() : 0;
    return ta - tb;
  });
  if (sorted.length < 5) {
    return `
      <div class="chart-panel">
        <div class="chart-panel-head">
          <h3 class="chart-panel-title">Winrate trend</h3>
        </div>
        <p class="chart-empty">Play at least 5 runs to see your rolling winrate over time.</p>
      </div>`;
  }
  const window = Math.min(10, Math.max(3, Math.floor(sorted.length / 4)));
  const points = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = Math.max(0, i - window + 1);
    const slice = sorted.slice(start, i + 1);
    const wins = slice.filter((r) => r.won).length;
    points.push({ idx: i, wr: wins / slice.length, won: !!sorted[i].won });
  }
  const lifetime = sorted.filter((r) => r.won).length / sorted.length;
  const model = Object.freeze({ points, lifetime, runCount: sorted.length });
  classicChartModels = Object.freeze({ ...classicChartModels, winrate: model });

  return `
    <div class="chart-panel">
      <div class="chart-panel-head">
        <div>
          <h3 class="chart-panel-title">Winrate trend</h3>
          <p class="chart-panel-sub">Trailing ${window}-run win rate across your history. Dashed line: lifetime&nbsp;average.</p>
        </div>
      </div>
      <div class="chart-svg-wrap chart-svg-wrap--fit chart-svg-wrap--winrate" data-classic-chart="winrate">
        ${winrateChartSvg(model, CLASSIC_CHART_GUESS_W, CLASSIC_CHART_MIN_H)}
      </div>
    </div>`;
}

/**
 * The winrate trend's SVG at `w` x `h` CSS pixels (one SVG unit = 1px),
 * so its labels render at their CSS size. fitClassicCharts() redraws it
 * whenever its box changes size.
 * @param {{ points: { wr: number }[], lifetime: number, runCount: number }} model
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function winrateChartSvg(model, w, h) {
  const { points, lifetime, runCount } = model;
  // Room for "100%" at the phone's 12px labels, and for the run labels below.
  const padL = isPhoneViewport() ? 38 : 36, padR = 8, padT = 10, padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const maxRolling = Math.max(...points.map((p) => p.wr), 0.001);
  /** Zoom Y axis so low winrates don't leave ~75% empty chart above the line. */
  const yCeil = Math.min(1, Math.max(0.11, lifetime * 1.35, maxRolling * 1.22, 0.22));
  const yFor = (v) => {
    const vv = Math.min(Math.max(v, 0), yCeil);
    return padT + (1 - vv / yCeil) * innerH;
  };
  const xFor = (i) => padL + i * stepX;

  const dLine = points.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)} ${yFor(p.wr).toFixed(1)}`).join(" ");
  const dArea = `${dLine} L${xFor(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L${xFor(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const tickN = 4;
  const grid = [];
  for (let i = 0; i <= tickN; i += 1) {
    const tv = (i / tickN) * yCeil;
    grid.push(`
    <line class="grid-line" x1="${padL}" x2="${padL + innerW}" y1="${yFor(tv)}" y2="${yFor(tv)}"></line>
    <text class="axis-label" x="${padL - 6}" y="${yFor(tv) + 4}" text-anchor="end">${Math.round(tv * 100)}%</text>`);
  }
  const gridStr = grid.join("");
  const lifeClamp = Math.min(lifetime, yCeil);
  const baseline = `<line class="baseline" x1="${padL}" x2="${padL + innerW}" y1="${yFor(lifeClamp)}" y2="${yFor(lifeClamp)}"></line>
    <text class="axis-label" x="${padL + innerW}" y="${yFor(lifeClamp) - 4}" text-anchor="end">avg ${(lifetime * 100).toFixed(0)}%</text>`;
  const axis = `
    <line class="axis-line" x1="${padL}" x2="${padL + innerW}" y1="${padT + innerH}" y2="${padT + innerH}"></line>
    <text class="axis-label" x="${padL}" y="${h - 5}">Run #1</text>
    <text class="axis-label" x="${padL + innerW}" y="${h - 5}" text-anchor="end">Run #${runCount}</text>`;
  const lineColor = "var(--accent, #ffa05c)";
  const lastPt = points[points.length - 1];

  return `
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Rolling win rate over time">
        ${gridStr}
        ${baseline}
        <path class="series-fill" d="${dArea}" fill="${lineColor}"></path>
        <path class="series-line" d="${dLine}" stroke="${lineColor}"></path>
        <circle class="series-pt" cx="${xFor(points.length - 1).toFixed(1)}" cy="${yFor(lastPt.wr).toFixed(1)}" r="2.5" fill="${lineColor}"></circle>
        ${axis}
      </svg>`;
}

/**
 * Floor distribution histogram. One bar per "floor reached" value; each
 * bar is split into the wins fraction (green, bottom) and the losses
 * fraction (red, top). Helps the user see *where they die most* at a
 * glance — usually a tall red bar at floor 17 (Act 2 boss) or 34 (Act 3
 * boss). Bins tightly when run count > 60 to keep the chart readable.
 */
function renderDeathHistogram(runs) {
  const floors = runs
    .filter((r) => Number.isFinite(r.floorReached) && r.floorReached > 0)
    .map((r) => ({ floor: r.floorReached, won: !!r.won }));
  if (floors.length < 5) {
    return `
      <div class="chart-panel">
        <div class="chart-panel-head">
          <h3 class="chart-panel-title">Where you end up</h3>
        </div>
        <p class="chart-empty">Play at least 5 runs to see your floor distribution.</p>
      </div>`;
  }
  const maxFloor = Math.max(...floors.map((f) => f.floor));
  const minFloor = Math.min(...floors.map((f) => f.floor));
  // Bin if needed. Keep ~30 bars max so chart stays readable.
  const span = maxFloor - minFloor + 1;
  const binSize = Math.max(1, Math.ceil(span / 30));
  const bins = new Map();
  for (const f of floors) {
    const key = Math.floor((f.floor - minFloor) / binSize) * binSize + minFloor;
    const bin = bins.get(key) || { floor: key, wins: 0, losses: 0 };
    if (f.won) bin.wins += 1; else bin.losses += 1;
    bins.set(key, bin);
  }
  const series = [...bins.values()].sort((a, b) => a.floor - b.floor);
  const maxCount = Math.max(...series.map((b) => b.wins + b.losses), 1);
  const model = Object.freeze({ series, binSize, maxCount });
  classicChartModels = Object.freeze({ ...classicChartModels, hist: model });

  // Legend chips
  const legend = `
    <div class="chart-panel-chips" aria-hidden="true">
      <span class="chart-chip" style="border-color: rgba(95,224,154,0.5); color: #6fe091; background: rgba(95,224,154,0.12); cursor: default;">Victories</span>
      <span class="chart-chip" style="border-color: rgba(255,107,107,0.5); color: #ff8888; background: rgba(255,107,107,0.12); cursor: default;">Defeats</span>
    </div>`;
  // The exact counts live in each bar's tooltip, which only a pointer that
  // can hover ever shows, so phones and tablets are not told to hover.
  const hoverHint = canHoverPointer() ? " Hover a bar for exact&nbsp;counts." : "";

  return `
    <div class="chart-panel">
      <div class="chart-panel-head">
        <div>
          <h3 class="chart-panel-title">Where you end up</h3>
          <p class="chart-panel-sub">Floors where runs end (wins green, losses&nbsp;red).${hoverHint}</p>
        </div>
        ${legend}
      </div>
      <div class="chart-svg-wrap chart-svg-wrap--fit chart-svg-wrap--hist" data-classic-chart="hist">
        ${histChartSvg(model, CLASSIC_CHART_GUESS_W, CLASSIC_CHART_MIN_H)}
      </div>
    </div>`;
}

/** True when the main pointer can hover (a mouse or trackpad). */
function canHoverPointer() {
  try { return window.matchMedia("(hover: hover)").matches; }
  catch { return true; }
}

/** Space one floor label needs along the axis at the 11-12px label size:
 *  a floor number ("51"), or a binned range ("12–13"), plus a gap. */
const HIST_LABEL_SLOT_PX = 26;
const HIST_RANGE_LABEL_SLOT_PX = 44;

/**
 * The floor histogram's SVG at `w` x `h` CSS pixels (one SVG unit = 1px).
 * Floor labels run level, as many as fit: every `step`-th bar, always
 * ending on the highest floor.
 * @param {{ series: { floor: number, wins: number, losses: number }[], binSize: number, maxCount: number }} model
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function histChartSvg(model, w, h) {
  const { series, binSize, maxCount } = model;
  const padL = 10, padR = 10, padT = 8, padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const barGap = 2;
  const barW = Math.max(2, (innerW - (series.length - 1) * barGap) / series.length);

  const yFor = (v) => padT + (1 - v / maxCount) * innerH;

  const slot = binSize > 1 ? HIST_RANGE_LABEL_SLOT_PX : HIST_LABEL_SLOT_PX;
  const step = Math.max(1, Math.ceil(slot / (barW + barGap)));
  const last = series.length - 1;
  const labelled = new Set();
  for (let i = 0; i <= last; i += step) labelled.add(i);
  const lastLabelled = Math.floor(last / step) * step;
  if (lastLabelled !== last) {
    // End on the highest floor: add it if there is room, else it replaces
    // the label just before it.
    if (last - lastLabelled < Math.ceil(step / 2)) labelled.delete(lastLabelled);
    labelled.add(last);
  }

  const bars = series.map((b, i) => {
    const x = padL + i * (barW + barGap);
    const cx = x + barW / 2;
    const total = b.wins + b.losses;
    const yTop = yFor(total);
    const heightTotal = (padT + innerH) - yTop;
    const winsHeight = total > 0 ? heightTotal * (b.wins / total) : 0;
    const lossHeight = heightTotal - winsHeight;
    const lab = `${b.floor}${binSize > 1 ? `–${b.floor + binSize - 1}` : ""}`;
    const labSvg = labelled.has(i)
      ? `<text class="bar-label" x="${cx.toFixed(2)}" y="${h - 5}" text-anchor="middle">${esc(lab)}</text>`
      : "";
    return `
      <g>
        <rect class="bar-bg" x="${x.toFixed(1)}" y="${padT}" width="${barW.toFixed(1)}" height="${innerH}" rx="1.5"></rect>
        <rect class="bar-loss" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${lossHeight.toFixed(1)}" rx="1.5"></rect>
        <rect class="bar-win"  x="${x.toFixed(1)}" y="${(yTop + lossHeight).toFixed(1)}" width="${barW.toFixed(1)}" height="${winsHeight.toFixed(1)}" rx="1.5"></rect>
        ${labSvg}
        <title>${binSize > 1 ? `Floors ${b.floor}–${b.floor + binSize - 1}` : `Floor ${b.floor}`}: ${b.wins}W / ${b.losses}L</title>
      </g>`;
  }).join("");

  return `
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Floor outcome histogram">
        ${bars}
      </svg>`;
}

// ---- Classic Overview charts drawn at their box's own size ---------------
// A fixed viewBox scaled into a ~540px card (or a ~310px phone) shrank the
// axis text to 5-8px. Each chart is drawn once at a guessed size into the
// HTML string, then redrawn at its box's measured size (one SVG unit = one
// CSS pixel) right after it is inserted and whenever the box resizes.

/** Plot height (CSS px, the wrap's min-height in styles.css) and the width
 *  guessed for the first draw, before the box can be measured. */
const CLASSIC_CHART_MIN_H = 132;
const CLASSIC_CHART_GUESS_W = 520;
/** The data each classic chart was last built from, for redraws. */
let classicChartModels = Object.freeze({});
/** Redraws a chart whose box changes size (a hidden tab measures 0). */
let classicChartWatcher = null;

/**
 * Redraws one classic chart at its box's size, unless already drawn so.
 * @param {HTMLElement} wrap  a [data-classic-chart] element
 */
function fitClassicChart(wrap) {
  const w = Math.round(wrap.clientWidth);
  const h = Math.round(wrap.clientHeight);
  if (w <= 0 || h <= 0 || wrap.dataset.drawn === `${w}x${h}`) return;
  const kind = wrap.dataset.classicChart;
  const model = classicChartModels[kind];
  const draw = kind === "winrate" ? winrateChartSvg : kind === "hist" ? histChartSvg : null;
  if (!model || !draw) return;
  wrap.innerHTML = draw(model, w, h);
  wrap.dataset.drawn = `${w}x${h}`;
}

/**
 * Fits every classic chart in `root` now, and again whenever one resizes.
 * @param {ParentNode} root
 */
function fitClassicCharts(root) {
  const wraps = [...root.querySelectorAll("[data-classic-chart]")];
  wraps.forEach((wrap) => fitClassicChart(wrap));
  if (typeof ResizeObserver !== "function") return;
  if (!classicChartWatcher) {
    classicChartWatcher = new ResizeObserver((entries) => entries.forEach((entry) => fitClassicChart(entry.target)));
  }
  // The Overview body is rebuilt on every render; let go of the old wraps.
  classicChartWatcher.disconnect();
  wraps.forEach((wrap) => classicChartWatcher.observe(wrap));
}

/** Mini sparkline of the last N runs, ordered oldest → newest from
 *  left to right. Two visual layers in one SVG:
 *    1. A thin rolling-winrate line so the user sees trajectory.
 *    2. Outcome dots (green = win, red = loss, grey = abandoned)
 *       so individual data points are visible alongside the trend.
 *  Pure SVG — no animation — keeps it cheap to render alongside the
 *  rest of the overview hero panel. */
function renderRecentFormSparkline(runs) {
  if (!Array.isArray(runs) || runs.length < 2) return "";
  const W = 200, H = 38, PAD = 4;
  const usableW = W - PAD * 2;
  const usableH = H - PAD * 2;
  // Rolling winrate over a window of up to 5 runs centered on each
  // index. Using a centered window means the line can't lag the
  // most recent run dramatically.
  const window = 5;
  const wrSeries = runs.map((_, i) => {
    const start = Math.max(0, i - Math.floor(window / 2));
    const end = Math.min(runs.length, i + Math.ceil(window / 2));
    const slice = runs.slice(start, end);
    if (slice.length === 0) return 0;
    const wins = slice.filter((r) => r.won).length;
    return wins / slice.length;
  });
  const stepX = runs.length === 1 ? 0 : usableW / (runs.length - 1);
  const polylinePts = wrSeries.map((wr, i) => {
    const x = PAD + i * stepX;
    const y = PAD + (1 - wr) * usableH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const dots = runs.map((r, i) => {
    const x = PAD + i * stepX;
    const cls = r.won ? "spark-dot is-win" : r.wasAbandoned ? "spark-dot is-abandon" : "spark-dot is-loss";
    const y = r.won ? PAD + 4 : PAD + usableH - 4;
    return `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4"/>`;
  }).join("");
  return `
    <svg class="recent-form-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Recent run trend over the last ${runs.length} runs">
      <polyline class="spark-trend" points="${polylinePts}" fill="none" />
      ${dots}
    </svg>
  `;
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

  // Side stats: Highest ascension reached, recent form (last 10 runs),
  // and avg ascension played. Cheap to compute, high information density,
  // and they fill the right side of the hero so the panel doesn't look
  // half-empty on widescreens.
  const highestAsc = report.byAscension
    .slice()
    .sort((a, b) => parseAsc(b.key) - parseAsc(a.key))
    .find((b) => b.runs > 0);
  // "Recent form" wants the chronologically latest 10 runs, not whatever
  // order extractRuns happens to return. Sort defensively here so Mac users
  // and Windows-export users see the same thing.
  const sortedByDate = parsedRuns
    .slice()
    .sort((a, b) => {
      const ta = a.endedAt ? a.endedAt.getTime() : 0;
      const tb = b.endedAt ? b.endedAt.getTime() : 0;
      return tb - ta;
    });
  const recent10 = sortedByDate.slice(0, 10);
  const recentWins = recent10.filter((r) => r.won).length;
  const recentForm = recent10.length > 0 ? `${recentWins}W · ${recent10.length - recentWins}L` : "no runs yet";
  // Last-20 sparkline: oldest-to-newest dots so the eye reads left-
  // to-right as time. Each dot is colored by outcome; a thin
  // rolling-average line over the same 20 runs shows whether form
  // is trending up or down. Built once here and inlined into the
  // Recent Form tile below.
  const last20 = sortedByDate.slice(0, 20).reverse();
  const sparkline = renderRecentFormSparkline(last20);
  const ascNums = parsedRuns.filter(isLadderRun).map((r) => Number(r.ascension)).filter((n) => Number.isFinite(n));
  const avgAsc = ascNums.length > 0 ? (ascNums.reduce((a, b) => a + b, 0) / ascNums.length).toFixed(1) : "—";

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
              Best: <strong style="color:${charTheme(bestChar.key).color}">${esc(prettifyCharacterName(bestChar.key))}</strong>
              <span class="muted"> · ${(bestChar.winrate * 100).toFixed(1)}% over ${bestChar.runs} run${bestChar.runs === 1 ? "" : "s"}</span>
            </span>
          </div>
        ` : ""}
      </div>
      <div class="hero-side">
        <div class="hero-side-tile" data-action="goto-tab" data-tab="ascensions" title="Open Ascensions">
          <div class="hero-side-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4 4 5-7 5 7 4-4-1 11H4L3 8z"/></svg>
          </div>
          <div class="hero-side-meta">
            <span class="hero-side-label">Highest Ascension</span>
            <span class="hero-side-value">${highestAsc ? esc(highestAsc.key) : "—"}${highestAsc ? ` <span class="hero-side-sub">· ${highestAsc.runs} run${highestAsc.runs === 1 ? "" : "s"}</span>` : ""}</span>
          </div>
        </div>
        <div class="hero-side-tile ${recentWins >= recent10.length / 2 ? "tone-win" : "tone-accent"}">
          <div class="hero-side-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17l6-6 4 4 7-9 1.5 1L13 18l-4-4-4.5 5z"/></svg>
          </div>
          <div class="hero-side-meta">
            <span class="hero-side-label">Recent Form</span>
            <span class="hero-side-value">${esc(recentForm)} <span class="hero-side-sub">· last ${recent10.length}</span></span>
            ${sparkline}
          </div>
        </div>
        <div class="hero-side-tile" data-action="goto-tab" data-tab="ascensions" title="Open Ascensions">
          <div class="hero-side-icon">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 20h4V10H4zm6 0h4V4h-4zm6 0h4v-7h-4z"/></svg>
          </div>
          <div class="hero-side-meta">
            <span class="hero-side-label">Avg Ascension</span>
            <span class="hero-side-value">A${avgAsc}</span>
          </div>
        </div>
      </div>
    </div>`;

  // Per-character cards. The desktop app shows these as colored tiles with
  // an icon, run count badge, big winrate %, and a thin progress bar. We
  // mirror that layout exactly so the web reads as the same product.
  // Delegates to renderCharCards so Overview and the dedicated Characters
  // tab pick up the same character-portrait art treatment.
  // The whole roster, as on the Characters tab and the new look: an
  // unplayed character (The Fool, for most players) shows "No runs yet".
  // Filtered by the section's own mode / ascension controls, with each
  // climber's current win streak.
  const chars = characterSection(report);
  const charLabel = Filters.characterFilterLabel(chars.filter);
  const charCards = renderCharCards(rosterBuckets(chars.report.byCharacter), {
    expandable: false,
    streaks: chars.streaks,
    streakScope: charLabel,
    emptyText: charLabel ? "No runs" : "No runs yet",
  });
  const charFilters = renderClassicCharacterFilters(chars.filter, chars.runs.length);

  // KPI strip + analytics charts (added in v49). Reasoned about as
  // "answers to the questions a player asks every session": am I on a
  // streak, am I getting better, where do I die, what's my PB, when
  // did I last play. The strip gives a 6-card snapshot above the hero
  // donut; the two charts unpack trend (winrate over time) and habit
  // (floor distribution by outcome). All three render from
  // `parsedRuns` directly so they live in the same data lifecycle.
  const kpiStrip = renderKPIStrip(parsedRuns);
  const winrateChart = renderWinrateChart(parsedRuns);
  const deathChart = renderDeathHistogram(parsedRuns);
  // Overlay inline card pulled from production. The full Overlay
  // experience is gated behind the OVERLAY_NAV_VISIBLE flag below.

  const sinceStrip = renderSinceLastVisitStrip(sortedByDate);
  const weekStrip = renderWeeklyDigestStrip(sortedByDate);

  return `
    ${sinceStrip}
    ${weekStrip}
    ${kpiStrip}
    ${heroPanel}
    ${secTitle("Trends", "bars")}
    <div class="chart-row">
      ${winrateChart}
      ${deathChart}
    </div>
    ${secTitle("Per character", "people")}
    ${charFilters}
    ${charCards}
    ${secTitle("Top relics", "sparkles", "gold")}
    ${classicToneKeyHtml(report.overallWinrate, { belowTone: "muted" })}
    ${renderRelicCards(report.byRelic.slice(0, 6), { baseline: report.overallWinrate })}`;
}

// =========================================================================
// Overview — new UI
// -------------------------------------------------------------------------
// The Overview is a layout of widgets (lib/ui/overview/registry.js). Each
// widget builds its model from one context per render, made here from the
// same report and the same helpers the classic Overview uses (currentStreak,
// pbFloorRun, weeklyCadence, …), so the two layouts cannot disagree about a
// number.
//
// The KPI wording is restated here rather than shared with
// renderKPIStrip() on purpose: the classic renderer stays untouched until
// it is deleted, and then this is the only copy.
// =========================================================================
const NEXT_STAGE_TORCH_RUNS = 10;
const NEXT_RECENT_FORM_RUNS = 10;
const NEXT_MAX_FLOOR_BINS = 30;
const NEXT_MIN_CHART_RUNS = 5;

/** Key of the character with the most runs, or null. Drives the Auto theme. */
function mostPlayedCharacterKey(report) {
  const top = (report.byCharacter || []).slice().sort((a, b) => b.runs - a.runs)[0];
  return top && top.runs > 0 ? String(top.key).toLowerCase() : null;
}

/** Stage data: the spire is lit to `hiLevel`, torches are the last ten runs. */
function buildStageModel(hiLevel) {
  const recent = runsByDateDesc(parsedRuns)
    .slice(0, NEXT_STAGE_TORCH_RUNS)
    .reverse()
    .map((r) => ({
      won: !!r.won,
      id: r.id,
      label: `${prettifyCharacterName(r.character || "Unknown")}${runAscText(r) ? ` ${runAscText(r)}` : ""}`,
      floor: Number.isFinite(r.floorReached) ? r.floorReached : undefined,
      date: stageRunDate(r.endedAt || r.startedAt),
    }));
  return { hiLevel, recent };
}

/** "Nov 12": the short date the torches' plate shows for a run. */
function stageRunDate(when) {
  const d = when ? new Date(when) : null;
  return d && Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
}

// The header's torches (new look): with a precise pointer, a click on a torch
// opens that run; anywhere else on the row (or a tap on a touch screen, where
// a torch is too small to aim at) opens the Runs tab.
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest("[data-stage-runs]")) return;
  const torch = target.closest(".v-torch[data-run-id]");
  const precise = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (torch && precise) {
    const run = parsedRuns.find((r) => String(r.id) === torch.getAttribute("data-run-id"));
    if (run) {
      openRunDetailModal(run);
      return;
    }
  }
  switchTab("runs");
});

function nextRecentFormCard(runs) {
  const last = runsByDateDesc(runs).slice(0, NEXT_RECENT_FORM_RUNS);
  const wins = last.filter((r) => r.won).length;
  const losses = last.length - wins;
  const pct = last.length ? Math.round((wins / last.length) * 100) : 0;
  const lifetimePct = Math.round((runs.filter((r) => r.won).length / runs.length) * 100);
  const trend = pct - lifetimePct;
  const record = `${wins}W&ndash;${losses}L`;
  const textHtml = runs.length <= NEXT_RECENT_FORM_RUNS
    ? `${record} &middot; need 11+ runs for a trend`
    : trend > 0
      ? `${record} &middot; <strong>+${trend}</strong> vs. lifetime`
      : trend < 0
        ? `${record} &middot; <strong>&minus;${Math.abs(trend)}</strong> vs. lifetime`
        : `${record} &middot; on par with lifetime`;
  const tone = pct >= lifetimePct + 1 ? "win" : (pct + 5 < lifetimePct ? "loss" : "accent");
  // The same series the classic card's sparkline draws: win rate so far
  // across these runs, oldest → newest.
  const oldestFirst = last.slice().reverse();
  const spark = oldestFirst.map((_, i) => oldestFirst.slice(0, i + 1).filter((r) => r.won).length / (i + 1));
  return {
    title: "Recent form",
    tone,
    icon: "bolt",
    value: String(pct),
    unit: "%",
    textHtml,
    trend: trend > 0 ? "up" : trend < 0 ? "down" : "flat",
    spark,
  };
}

function nextStreakCards(runs) {
  const streak = currentStreak(runs);
  const longest = longestWinStreakDetails(runs);
  const activeText = streak.kind === "win"
    ? (streak.count === 1
        ? "One win &mdash; keep the momentum"
        : longest.count > streak.count
          ? `${streak.count} in a row &middot; best is <strong>${longest.count}</strong>`
          : `${streak.count} in a row &mdash; a new personal best`)
    : streak.kind === "loss"
      ? (streak.count === 1 ? "One loss &mdash; reset and re&#8209;roll" : `${streak.count} in a row &mdash; reset and re&#8209;roll`)
      : "No active streak yet &mdash; play a run";
  const active = {
    title: streak.kind === "win" ? "Win streak" : streak.kind === "loss" ? "Loss streak" : "Active streak",
    tone: streak.kind === "win" ? "win" : streak.kind === "loss" ? "loss" : "accent",
    icon: "flame",
    value: String(streak.kind === "none" ? 0 : streak.count),
    textHtml: activeText,
  };
  const best = {
    title: "Best streak",
    tone: "gold",
    icon: "crown",
    value: String(longest.count),
    unit: longest.count === 1 ? "win" : "wins",
    textHtml: longest.count > 0
      ? (longest.character
          ? `Set on <strong>${esc(prettifyCharacterName(longest.character))}</strong>${ascAtPhrase(longest.ascension, longest.gameMode)}`
          : "Set across your run history")
      : "Win two in a row to start one",
  };
  return [active, best];
}

function nextRecordCards(runs) {
  const pb = pbFloorRun(runs);
  const fastest = fastestWinRun(runs);
  const cadence = weeklyCadence(runs);
  const bestFloor = {
    title: "Best floor",
    tone: "violet",
    icon: "stairs",
    value: pb ? String(pb.floorReached) : "&mdash;",
    textHtml: pb
      ? `<strong>${esc(prettifyCharacterName(pb.character || "Unknown"))}</strong>${ascAtPhrase(pb.ascension, pb.gameMode)}${pb.won ? " &middot; Victory" : ""}`
      : "Play one run to set this",
  };
  const fastestWin = {
    title: "Fastest win",
    tone: "info",
    icon: "clock",
    value: fastest
      ? esc(formatPlayTimeStrict(fastest.playTimeSeconds) || `${Math.round(fastest.playTimeSeconds / 60)}m`)
      : "&mdash;",
    textHtml: fastest
      ? `<strong>${esc(prettifyCharacterName(fastest.character || "Unknown"))}</strong>${ascAtPhrase(fastest.ascension, fastest.gameMode)}`
      : "No victories yet",
  };
  const thisWeek = {
    title: "This week",
    tone: cadence.delta > 0 ? "win" : cadence.delta < 0 ? "loss" : "accent",
    icon: "calendar",
    value: String(cadence.thisWeek),
    unit: cadence.thisWeek === 1 ? "run" : "runs",
    textHtml: cadence.prevWeek === 0 && cadence.thisWeek > 0
      ? "Back at it after a quiet stretch"
      : cadence.delta > 0
        ? `<strong>+${cadence.delta}</strong> vs. last week`
        : cadence.delta < 0
          ? `<strong>&minus;${Math.abs(cadence.delta)}</strong> vs. last week`
          : "Same pace as last week",
  };
  return [bestFloor, fastestWin, thisWeek];
}

/** Trailing win rate per run, oldest → newest. Null below the chart minimum. */
function buildTrendData(runs) {
  const sorted = runsByDateDesc(runs).slice().reverse();
  if (sorted.length < NEXT_MIN_CHART_RUNS) return null;
  const windowSize = Math.min(10, Math.max(3, Math.floor(sorted.length / 4)));
  const values = sorted.map((_, i) => {
    const slice = sorted.slice(Math.max(0, i - windowSize + 1), i + 1);
    return slice.filter((r) => r.won).length / slice.length;
  });
  const lifetime = sorted.filter((r) => r.won).length / sorted.length;
  return { values, lifetime, windowSize };
}

/**
 * Wins and losses by the floor a run ended on. Unlike the classic chart the
 * axis is continuous — floors where no run ended get an empty bin — so the
 * distance between two bars means the distance between two floors.
 */
function buildFloorData(runs) {
  const ended = runs.filter((r) => Number.isFinite(r.floorReached) && r.floorReached > 0);
  if (ended.length < NEXT_MIN_CHART_RUNS) return null;
  const floors = ended.map((r) => r.floorReached);
  const minFloor = Math.min(...floors);
  const maxFloor = Math.max(...floors);
  const binSize = Math.max(1, Math.ceil((maxFloor - minFloor + 1) / NEXT_MAX_FLOOR_BINS));
  const binCount = Math.floor((maxFloor - minFloor) / binSize) + 1;
  const bins = Array.from({ length: binCount }, (_, i) => {
    const start = minFloor + i * binSize;
    const inBin = ended.filter((r) => r.floorReached >= start && r.floorReached < start + binSize);
    const wins = inBin.filter((r) => r.won).length;
    return {
      label: binSize > 1 ? `${start}–${start + binSize - 1}` : `${start}`,
      wins,
      losses: inBin.length - wins,
    };
  });
  return { bins };
}

/** One banner per roster character, then any other characters in the data.
 *  `streaks`: current win streak per character (Filters.winStreaksByCharacter). */
function buildCharacterRows(report, streaks = new Map()) {
  const byKey = new Map((report.byCharacter || []).map((b) => [String(b.key).toLowerCase(), b]));
  const extras = [...byKey.keys()].filter((key) => !CREST_ROSTER.includes(key));
  return [...CREST_ROSTER, ...extras].map((key) => {
    const bucket = byKey.get(key) || null;
    const inked = UI ? UI.Stage.actorArt(key) : null;
    return {
      key,
      label: prettifyCharacterName(key),
      runs: bucket ? bucket.runs : 0,
      wins: bucket ? bucket.wins : 0,
      winratePct: bucket ? bucket.winrate * 100 : 0,
      // Same re-inked figure as the header duel, so one character is not
      // drawn two different ways on one screen.
      portraitSrc: inked ? inked.src : characterImageSrc(key),
      isPortraitInked: !!inked,
      iconHtml: charIcon(charTheme(key).icon),
      streak: shownStreak(streaks, key),
    };
  });
}

/**
 * What the Overview widgets may use from this file (lib/ui/overview/registry.js
 * OverviewHelpers). A function, not a constant, so a render during boot can
 * never meet it uninitialized.
 */
function overviewHelpers() {
  return {
    kpiCards: (runs) => [nextRecentFormCard(runs), ...nextStreakCards(runs), ...nextRecordCards(runs)],
    characterRows: buildCharacterRows,
    trendData: buildTrendData,
    floorData: buildFloorData,
    visitNews: lastVisitNews,
    // The same "this week" as the hand's This week card (runAgeMs).
    weekRuns: (byDateDesc, now) => byDateDesc.filter((r) => runAgeMs(r, now) < WEEK_MS),
    characterName: prettifyCharacterName,
    ascensionLevel: parseAsc,
    isLadderRun,
    relicLabel,
    relicImageSrc,
    cardLabel,
    cardImageSrc,
    // The By character widget: rows under the section's mode and ascension
    // filter, with each climber's win streak (the stats-filters work).
    characterPanel: (report) => {
      const chars = characterSection(report);
      return {
        characters: buildCharacterRows(chars.report, chars.streaks),
        characterFilter: buildCharacterFilterModel(chars.filter, chars.runs.length),
      };
    },
  };
}

/** One render's worth of data for the Overview widgets. */
function overviewContext(report) {
  return { now: Date.now(), runs: parsedRuns, byDateDesc: runsByDateDesc(parsedRuns), report, h: overviewHelpers() };
}

/** The player's own Overview layout (the default until they arrange it). */
function renderOverviewNext(report) {
  return UI.Overview.renderOverview(UI.Overview.loadLayout(), overviewContext(report));
}

const OVERLAY_TAGS = ["damage", "block", "scaling", "draw", "energy", "exhaust", "poison", "orbs", "stance", "strength", "defensive", "unknown"];
const OVERLAY_DECISIONS = [
  { key: "cardReward", label: "Card reward" },
  { key: "pathChoice", label: "Path choice" },
  { key: "shop", label: "Shop" },
  { key: "restSite", label: "Rest site" },
  { key: "upgrade", label: "Upgrade" },
  { key: "remove", label: "Remove" },
  { key: "bossRelic", label: "Boss relic" },
  { key: "potionUse", label: "Potion use" },
  { key: "coopCoordination", label: "Co-op coordination" },
];
const OVERLAY_REMINDERS = [
  { key: "need_damage", label: "Need damage" },
  { key: "need_block", label: "Need block" },
  { key: "need_scaling", label: "Need scaling" },
  { key: "need_draw", label: "Need draw" },
  { key: "need_energy", label: "Need energy" },
  { key: "save_potion", label: "Save potion" },
  { key: "avoid_elite", label: "Avoid elite" },
  { key: "take_elite", label: "Take elite" },
  { key: "look_for_removal", label: "Look for removal" },
  { key: "upgrade_priority", label: "Upgrade priority" },
];

function defaultOverlayState() {
  return {
    enabled: true,
    mode: "compact",
    // Compact mode renders most cards collapsed by default so the panel
    // stays out of the way during play. The user can expand any section.
    collapsed: { settings: true, helper: true, advisor: false },
    status: {
      character: "ironclad",
      act: 1,
      floor: 1,
      ascension: 0,
      goal: "",
      boss: "",
      pathRisk: "medium",
    },
    tags: [],
    decisions: {},
    notes: "",
    reminders: [],
    prefs: {
      alwaysOnTop: false,
      transparency: 92,
      fontSize: "medium",
      position: "top-right",
      privacyReminder: true,
    },
    // Optional AI-assist provider settings. Manual-only by default. The key
    // never leaves the user's browser unless they click Analyze. We only
    // store provider/model/key here; we do NOT keep sent screenshots.
    provider: {
      name: "openai",
      model: "gpt-4o-mini",
      apiKey: "",
      acceptedDisclosure: false,
      lastAnalyzedAt: 0,
      lastResult: null,
    },
  };
}

function loadOverlayState() {
  const fallback = defaultOverlayState();
  try {
    const raw = localStorage.getItem(STORAGE_OVERLAY_STATE);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      status: { ...fallback.status, ...(parsed.status || {}) },
      prefs: { ...fallback.prefs, ...(parsed.prefs || {}) },
      collapsed: { ...fallback.collapsed, ...(parsed.collapsed || {}) },
      provider: { ...fallback.provider, ...(parsed.provider || {}) },
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
      decisions: parsed.decisions && typeof parsed.decisions === "object" ? parsed.decisions : {},
    };
  } catch {
    return fallback;
  }
}

function saveOverlayState(state) {
  try { localStorage.setItem(STORAGE_OVERLAY_STATE, JSON.stringify(state)); } catch {}
}

function setOverlayPathValue(state, path, value) {
  const parts = path.split(".");
  let node = state;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!node[k] || typeof node[k] !== "object") node[k] = {};
    node = node[k];
  }
  node[parts[parts.length - 1]] = value;
}

function isOverlayProductionPreview() {
  return window.location.hostname === "app.spirevault.app";
}

// Rate limit for the optional AI screenshot analyze button. Manual button,
// not a polling loop, but we still cap to one call every 10 seconds so an
// accidental double-click can't burn the user's API tokens.
const OVERLAY_ANALYZE_COOLDOWN_MS = 10_000;

function overlayCompactClass(s) {
  if (s.mode === "compact") return "overlay-mode-compact";
  if (s.mode === "minimal") return "overlay-mode-minimal";
  return "overlay-mode-full";
}

function renderRecommendationCardHtml(rec, source) {
  const sourceLabel = source === "ai-screenshot" ? "Screenshot assist" : "Local advisor";
  const conf = rec.confidence || "low";
  const why = (rec.why || []).map((w) => `<li>${esc(w)}</li>`).join("");
  const assumptions = (rec.assumptions || []).map((a) => `<li>${esc(a)}</li>`).join("");
  return `
    <article class="overlay-card overlay-rec-card overlay-rec-${esc(conf)}" data-overlay-section="advisor">
      <header class="overlay-rec-head">
        <div>
          <span class="overlay-rec-eyebrow">Best next action <span class="overlay-source-pill">${esc(sourceLabel)}</span></span>
          <h4 class="overlay-rec-title">${esc(rec.action || "—")}</h4>
        </div>
        <span class="overlay-rec-confidence" data-conf="${esc(conf)}">${esc(conf)} confidence</span>
      </header>
      ${why ? `<ul class="overlay-rec-why">${why}</ul>` : ""}
      ${assumptions ? `<details class="overlay-rec-assumptions"><summary>Assumptions</summary><ul>${assumptions}</ul></details>` : ""}
      <p class="overlay-rec-foot muted">Support, not a verdict. The advisor never reads game memory or automates play.</p>
    </article>
  `;
}

// =========================================================================
// Settings tab
// =========================================================================
//
// Centralizes save-data plumbing (link / refresh / disconnect / clear),
// account state, and user preferences in one place. Born out of the
// header-action consolidation: Import/Export/Refresh used to live in
// every panel-head, which made every tab feel like a control surface
// when most tabs are content surfaces. Now those buttons exist in two
// places: Overview (the actual control deck) and here (the canonical
// home for "I want to manage my data").
//
// The whole panel is rebuilt every time `renderSettingsTab()` runs —
// not virtual-DOM — because state transitions are infrequent and a
// rebuild is the simplest way to keep the displayed permission /
// linked-folder / cloud-sync status consistent with reality.
// =========================================================================

/**
 * Settings → Appearance (new UI only). The swatches are rendered by the
 * theme engine and their clicks are handled by its delegated listener, so
 * nothing needs wiring here.
 */
function renderAppearanceCard() {
  return `
      <section class="settings-card v-appearance">
        <header class="settings-card-head">
          <h3>Appearance</h3>
          <p class="settings-card-sub">Pick the look and a theme. Both are saved on this device.</p>
        </header>
        ${UI.Theme.lookSwitchHtml("settings")}
        ${UI.Theme.themeSwatchesHtml()}
        <div class="v-appearance-foot">
          <span>Press <kbd>T</kbd> anywhere to cycle themes.</span>
          <span class="v-appearance-links">
            <button class="v-link" type="button" data-action="ui-open-news">What's new</button>
          </span>
        </div>
      </section>`;
}

/** Settings → Account picture when Steam gave none: the crest, as in the sidebar. */
const SETTINGS_AVATAR_FALLBACK = "/assets/brand/crest-avatar-128-v1.png";

/** True on a phone or tablet with no mouse: keyboard shortcuts mean nothing
 *  there, so Settings leaves the shortcut list out (both looks). The same
 *  test as the CSS that hides "Press T" (settings.css, hover: none). */
function isTouchOnly() {
  try { return window.matchMedia("(hover: none)").matches; }
  catch { return false; }
}

function renderSettingsTab() {
  const $body = document.getElementById("settings-body");
  if (!$body) return;
  if (deferUntilUIReady(() => renderActiveTab())) return;

  const linkedName = getLinkedFolderName();
  const isLinked = !!linkedName;
  const runCount = parsedRuns.length;
  const isAuthed = !!session?.sessionToken;
  const personaName = session?.personaName || "";
  // The session keeps the picture as avatarURL (the sidebar reads it there);
  // `avatar` was never set, so this card showed "?" for everyone. No picture
  // falls back to the crest, the same as the sidebar.
  const avatarUrl = session?.avatarURL || SETTINGS_AVATAR_FALLBACK;
  const steamID = session?.steamID || "";
  const lastSyncCount = lastCloudSyncCount;
  const lastSyncAt = lastCloudSyncAt ? formatRelativeActive(lastCloudSyncAt) : "";

  $body.innerHTML = `
    <div class="settings-grid">
      ${UI ? renderAppearanceCard() : renderUiBetaSettingsCard()}
      <!-- ───────── Save Data card ───────── -->
      <section class="settings-card">
        <header class="settings-card-head">
          <h3>Save data</h3>
          <p class="settings-card-sub">
            ${isLinked && isLinkedFolderLive()
              ? `Linked to <strong>${esc(linkedName)}</strong>. New runs load by themselves.`
              : isLinked
                ? `Imported from <strong>${esc(linkedName)}</strong>. To pick up new runs, press Refresh and choose the folder again.`
                : "Link your STS2 save folder to see your runs."}
          </p>
        </header>

        <div class="settings-status-row">
          <div class="settings-status-cell">
            <span class="settings-stat-label">Runs loaded</span>
            <span class="settings-stat-value">${runCount.toLocaleString()} run${runCount === 1 ? "" : "s"}</span>
          </div>
          ${isAuthed && lastSyncCount != null ? `
            <div class="settings-status-cell">
              <span class="settings-stat-label">Cloud sync</span>
              <span class="settings-stat-value">${lastSyncCount.toLocaleString()} run${lastSyncCount === 1 ? "" : "s"}</span>
              ${lastSyncAt ? `<span class="settings-stat-foot">${esc(lastSyncAt)}</span>` : ""}
            </div>
          ` : ""}
          ${isLinked && isLinkedFolderLive() ? `
            <div class="settings-status-cell settings-status-cell--ok">
              <span class="settings-stat-label">Auto refresh</span>
              <span class="settings-stat-value">On</span>
              <span class="settings-stat-foot">Checks the folder every ${Math.round(HISTORY_REREAD_INTERVAL_MS / 1000)} seconds</span>
            </div>
          ` : `
            <div class="settings-status-cell settings-status-cell--warn">
              <span class="settings-stat-label">Auto refresh</span>
              <span class="settings-stat-value">Off</span>
              <span class="settings-stat-foot">${canKeepSaveFolder() ? "Link a folder to enable" : "After a run, press Refresh now and pick the folder"}</span>
            </div>
          `}
        </div>

        <div class="settings-action-row">
          <button class="btn-primary" type="button" data-action="upload">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21V9"/><polyline points="7 14 12 9 17 14"/><path d="M5 3h14"/></svg>
            <span>${isLinked ? "Re-pick folder" : "Link save folder"}</span>
          </button>
          <!-- Always enabled: with no kept folder, reloadSavedHistoryInteractive()
               explains and opens the picker, the same as the toolbar Refresh,
               which is what the Auto refresh tile above tells people to press. -->
          <button class="btn-ghost" type="button" data-action="reload-saves">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/></svg>
            <span>Refresh now</span>
          </button>
          <button class="btn-ghost" type="button" data-action="settings-export-json" ${runCount === 0 ? "disabled" : ""}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 10 12 15 17 10"/><path d="M5 21h14"/></svg>
            <span>Export JSON</span>
          </button>
          <button class="btn-ghost" type="button" data-action="settings-export-csv" ${runCount === 0 ? "disabled" : ""}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>Export CSV</span>
          </button>
        </div>

        ${isLinked ? `
          <div class="settings-danger-row">
            <button class="btn-link-danger" type="button" data-action="disconnect-saves">
              Disconnect this folder
            </button>
          </div>
        ` : ""}
      </section>

      <!-- ───────── Account card ───────── -->
      <section class="settings-card">
        <header class="settings-card-head">
          <h3>Account</h3>
          <p class="settings-card-sub">
            ${isAuthed
              ? "Signed in with Steam. Your runs sync across devices."
              : "Signed out. Sign in with Steam to enable cross-device sync, the co\u2011op feed, community highlights and beta features."}
          </p>
        </header>

        ${isAuthed ? `
          <div class="settings-account-row">
            <img class="settings-avatar" src="${esc(avatarUrl)}" alt="" />
            <div class="settings-account-meta">
              <strong>${esc(personaName || "Steam User")}</strong>
              ${steamID ? `<span class="muted small">SteamID ${esc(steamID)}</span>` : ""}
            </div>
            <button class="btn-ghost sm" type="button" data-action="settings-sign-out">Sign out</button>
          </div>
        ` : `
          <div class="settings-action-row">
            <button class="btn-primary" type="button" data-action="settings-sign-in">Sign in with Steam</button>
          </div>
        `}
      </section>

      <!-- ───────── Preferences card ───────── -->
      <section class="settings-card">
        <header class="settings-card-head">
          <h3>Preferences</h3>
          <p class="settings-card-sub">Tweak how the app behaves. Stored locally — not on the server.</p>
        </header>

        <div class="settings-pref-list">
          <label class="settings-pref">
            <span>
              <strong>Auto-open new run</strong>
              <span class="muted small">When STS2 writes a new run, pop the detail modal automatically.</span>
            </span>
            <input class="settings-toggle" type="checkbox" data-pref-key="autoOpenNewRun" ${getPref("autoOpenNewRun") ? "checked" : ""}>
          </label>
          <label class="settings-pref">
            <span>
              <strong>Reduced motion</strong>
              <span class="muted small">Disable hover lifts, popover animations, and tooltip fades.</span>
            </span>
            <input class="settings-toggle" type="checkbox" data-pref-key="reducedMotion" ${getPref("reducedMotion") ? "checked" : ""}>
          </label>
          <label class="settings-pref">
            <span>
              <strong>Compact stat tiles</strong>
              <span class="muted small">Tighter density for character + relic + card grids.</span>
            </span>
            <input class="settings-toggle" type="checkbox" data-pref-key="compactDensity" ${getPref("compactDensity") ? "checked" : ""}>
          </label>
        </div>

        ${isTouchOnly() ? "" : `
        <div class="settings-shortcut-block">
          <h4>Keyboard shortcuts</h4>
          <ul class="settings-shortcut-list">
            <li><kbd>1</kbd>–<kbd>9</kbd> <span>jump to a sidebar tab</span></li>
            <li><kbd>/</kbd> <span>focus the run search</span></li>
            <li><kbd>R</kbd> <span>refresh now</span></li>
            <li><kbd>I</kbd> <span>import a save folder</span></li>
            <li><kbd>?</kbd> <span>open keyboard help overlay</span></li>
            <li><kbd>Esc</kbd> <span>close any modal or popover</span></li>
          </ul>
        </div>`}
      </section>

      <!-- ───────── Danger / advanced card ───────── -->
      <section class="settings-card settings-card--danger">
        <header class="settings-card-head">
          <h3>Reset</h3>
          <p class="settings-card-sub">
            Wipe your locally cached run history. Won't touch the actual <code>.run</code> files on disk.
          </p>
        </header>
        <div class="settings-action-row">
          <button class="btn-link-danger" type="button" data-action="settings-clear-local" ${runCount === 0 ? "disabled" : ""}>
            Clear local cache (${runCount.toLocaleString()} run${runCount === 1 ? "" : "s"})
          </button>
        </div>
      </section>

      <!-- ───────── About card ───────── -->
      <section class="settings-card settings-card--about">
        <header class="settings-card-head">
          <h3>About</h3>
        </header>
        <dl class="settings-about-list">
          <div><dt>Build</dt><dd><code>${esc(VAULT_BUILD)}</code></dd></div>
          <div><dt>Engine</dt><dd>JS · Cloudflare Workers</dd></div>
          <div><dt>Source</dt><dd><a href="https://github.com/c3rooks/SpireVault" target="_blank" rel="noopener">github.com/c3rooks/SpireVault</a></dd></div>
        </dl>
      </section>
    </div>
  `;

  // Wire this card's buttons. Disconnect is delegated at the document
  // level; Re-pick folder and Refresh now are not (the toolbar's copies
  // are wired once at boot, before this card exists), so they did nothing
  // here until wired per render. The desktop host's capture-phase bridge
  // still intercepts both first.
  $body.querySelectorAll('[data-action="upload"]').forEach((b) => {
    b.addEventListener("click", () => void scanForHistory());
  });
  $body.querySelectorAll('[data-action="reload-saves"]').forEach((b) => {
    b.addEventListener("click", () => void reloadSavedHistoryInteractive());
  });
  $body.querySelectorAll('[data-action="settings-export-json"]').forEach((b) => {
    b.addEventListener("click", () => exportAllRuns("json"));
  });
  $body.querySelectorAll('[data-action="settings-export-csv"]').forEach((b) => {
    b.addEventListener("click", () => exportAllRuns("csv"));
  });
  $body.querySelectorAll('[data-action="settings-sign-out"]').forEach((b) => {
    b.addEventListener("click", () => void signOut());
  });
  $body.querySelectorAll('[data-action="settings-sign-in"]').forEach((b) => {
    b.addEventListener("click", () => startSteamSignIn());
  });
  $body.querySelectorAll('[data-action="settings-clear-local"]').forEach((b) => {
    b.addEventListener("click", () => void clearLocalCacheConfirmed());
  });
  $body.querySelectorAll('[data-pref-key]').forEach((box) => {
    box.addEventListener("change", (e) => {
      const key = e.target.getAttribute("data-pref-key");
      setPref(key, e.target.checked === true);
      applyPrefs();
    });
  });
}

/** Confirm-and-clear flow for the danger button. We don't surface a
 *  modal — a confirm() is plenty for what amounts to a localStorage
 *  reset. Wipes IDB cache + in-memory parsedRuns + linked-folder
 *  metadata; leaves the actual `.run` files on disk untouched. */
async function clearLocalCacheConfirmed() {
  const ok = window.confirm(
    "Clear your locally cached run history?\n\n" +
    "This wipes the cached parse and disconnects any linked save folder. " +
    "Your actual STS2 save files are NOT touched. " +
    "You can re-link the folder anytime to repopulate."
  );
  if (!ok) return;
  try { await HistoryStore.clearHistory({ allScopes: false, includeFallback: true }); } catch (e) { console.warn(e); }
  try { await HistoryStore.clearDirectoryHandle(); } catch {}
  try { await HistoryStore.clearHandle(); } catch {}
  try { localStorage.removeItem("vault.web.linkedFolderName"); } catch {}
  parsedRuns = [];
  currentRun = null;
  // Nothing is showing now — not real runs, not the sample set.
  isDemoMode = false;
  lastDirectoryFingerprint = "";
  lastIngestedMTime = 0;
  // "Disconnects any linked save folder" covers SpireVault Sync too: it stays
  // off until the player turns it back on, or the runs would be back in a minute.
  SyncBridge.pause();
  toast("Local cache cleared.");
  renderActiveTab();
}

// -------------------------------------------------------------------------
// User preferences (Settings tab toggles)
//
// localStorage-backed, queried by getPref/setPref. applyPrefs() is the
// single point that converts pref state into observable behavior so we
// never have a place where a toggle was stored but ignored.
// -------------------------------------------------------------------------
const PREFS_KEY = "vault.web.prefs.v1";

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function writePrefs(obj) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(obj)); } catch {}
}
function getPref(key) {
  const prefs = readPrefs();
  return prefs[key] === true;
}
function setPref(key, value) {
  const prefs = readPrefs();
  prefs[key] = value === true;
  writePrefs(prefs);
}
function applyPrefs() {
  const root = document.documentElement;
  if (!root) return;
  // Reduced-motion override is a class on <html> picked up by CSS rules
  // (we already gate animations with `prefers-reduced-motion`; this
  // class lets the user force the same path even on a system that
  // reports motion enabled).
  root.classList.toggle("prefer-reduced-motion", getPref("reducedMotion"));
  root.classList.toggle("prefer-compact-density", getPref("compactDensity"));
}

function renderOverlayTab() {
  const $body = document.getElementById("overlay-body");
  if (!$body) return;
  const s = loadOverlayState();
  const previewTag = isOverlayProductionPreview() ? `<span class="overlay-kicker">Preview · Beta</span>` : `<span class="overlay-kicker">Local preview</span>`;
  const selectedTagSet = new Set(s.tags);
  const selectedReminderSet = new Set(s.reminders);
  const charOptions = COMPANIONS.filter((c) => !c.isRandom);

  // Compute the local recommendation up front. Cheap, deterministic,
  // and always available even without an API key. The AI screenshot
  // assist (when invoked) replaces this with its result.
  const localRec = OverlayEngine.recommendNextAction(s);
  const showResult = s.provider?.lastResult || localRec;
  const showSource = s.provider?.lastResult ? "ai-screenshot" : "local";

  const lastAnalyzedLabel = s.provider?.lastAnalyzedAt
    ? `Last screenshot analyzed ${formatRelative(s.provider.lastAnalyzedAt)}`
    : "No screenshot analyzed in this session.";

  const collapsedStatus    = !!s.collapsed?.status;
  const collapsedTags      = !!s.collapsed?.tags;
  const collapsedDecisions = !!s.collapsed?.decisions;
  const collapsedNotes     = !!s.collapsed?.notes;
  const collapsedReminders = !!s.collapsed?.reminders;
  const collapsedHelper    = s.collapsed?.helper !== false;
  const collapsedSettings  = s.collapsed?.settings !== false;
  const collapsedAdvisor   = !!s.collapsed?.advisor;
  const collapsedAi        = s.collapsed?.ai !== false;

  $body.innerHTML = `
    <section class="overlay-hero-card ${overlayCompactClass(s)}">
      <div>
        <h3>Run Companion Overlay ${previewTag}</h3>
        <p>Decision support while you play. Local-first, manual analyze only, never reads game memory.</p>
      </div>
      <div class="overlay-hero-actions">
        <button class="btn-ghost ${s.mode === "compact" ? "is-on" : ""}" type="button" data-overlay-mode="compact">Compact</button>
        <button class="btn-ghost ${s.mode === "full" ? "is-on" : ""}" type="button" data-overlay-mode="full">Full</button>
        <button class="btn-ghost ${s.mode === "minimal" ? "is-on" : ""}" type="button" data-overlay-mode="minimal">Minimal HUD</button>
      </div>
    </section>

    ${renderOverlayCollapsibleHeader("advisor", "Advisor", collapsedAdvisor)}
    <div class="overlay-section-body" data-section-body="advisor" ${collapsedAdvisor ? "hidden" : ""}>
      ${renderRecommendationCardHtml(showResult, showSource)}
    </div>

    ${renderOverlayCollapsibleHeader("ai", "Screenshot assist (optional)", collapsedAi)}
    <div class="overlay-section-body" data-section-body="ai" ${collapsedAi ? "hidden" : ""}>
      <article class="overlay-card overlay-ai-card">
        <p class="overlay-ai-lede">Manual analyze only. The advisor will only call your provider when you click <strong>Analyze screenshot</strong>. SpireVault never streams your screen and never auto-uploads images.</p>
        ${s.provider?.acceptedDisclosure ? "" : `
          <div class="overlay-ai-consent">
            <p>Before enabling: a screenshot you choose will be POSTed directly from your browser to your selected provider using your API key. SpireVault never sees the image or the key.</p>
            <button class="btn-primary" type="button" data-overlay-action="ai-accept">I understand, enable manual screenshot assist</button>
          </div>
        `}
        <div class="overlay-form-grid ${s.provider?.acceptedDisclosure ? "" : "is-disabled"}">
          <label>Provider
            <select data-overlay-field="provider.name">
              <option value="openai"${(s.provider?.name || "openai") === "openai" ? " selected" : ""}>OpenAI (vision)</option>
            </select>
          </label>
          <label>Model
            <input type="text" value="${esc(s.provider?.model || "gpt-4o-mini")}" data-overlay-field="provider.model" placeholder="gpt-4o-mini" />
          </label>
          <label>API key (stored locally on this device only)
            <input type="password" autocomplete="off" spellcheck="false" value="${esc(s.provider?.apiKey || "")}" data-overlay-field="provider.apiKey" placeholder="sk-..." />
          </label>
        </div>
        <div class="overlay-ai-actions">
          <button class="btn-primary" type="button" data-overlay-action="ai-analyze" ${s.provider?.acceptedDisclosure ? "" : "disabled"}>Analyze screenshot</button>
          <input type="file" accept="image/png,image/jpeg,image/webp" data-overlay-screenshot hidden />
          <button class="btn-ghost" type="button" data-overlay-action="ai-clear" ${s.provider?.lastResult ? "" : "disabled"}>Clear last AI result</button>
          <span class="overlay-ai-status muted small" data-overlay-ai-status>${esc(lastAnalyzedLabel)}</span>
        </div>
        <p class="muted small">Manual-only. Rate-limited to one call every 10 seconds.</p>
      </article>
    </div>

    <section class="overlay-grid">
      <article class="overlay-card" data-overlay-section="status">
        ${renderOverlayCardHead("status", "Run status", collapsedStatus)}
        <div class="overlay-section-body" data-section-body="status" ${collapsedStatus ? "hidden" : ""}>
          <div class="overlay-form-grid">
            <label>Character
              <select data-overlay-field="status.character">${charOptions.map((c) => `<option value="${esc(c.id)}"${s.status.character === c.id ? " selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
            </label>
            <label>Act <input type="number" min="1" max="3" value="${Number(s.status.act) || 1}" data-overlay-field="status.act" /></label>
            <label>Floor <input type="number" min="0" max="99" value="${Number(s.status.floor) || 1}" data-overlay-field="status.floor" /></label>
            <label>Ascension <input type="number" min="0" max="9" value="${Number(s.status.ascension) || 0}" data-overlay-field="status.ascension" /></label>
            <label>Current goal <input type="text" value="${esc(s.status.goal || "")}" placeholder="Example: survive act 2 elite" data-overlay-field="status.goal" /></label>
            <label>Current boss <input type="text" value="${esc(s.status.boss || "")}" placeholder="Example: The Architect" data-overlay-field="status.boss" /></label>
            <label>Current path risk
              <select data-overlay-field="status.pathRisk">
                ${["low", "medium", "high"].map((r) => `<option value="${r}"${s.status.pathRisk === r ? " selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}
              </select>
            </label>
          </div>
        </div>
      </article>

      <article class="overlay-card" data-overlay-section="tags">
        ${renderOverlayCardHead("tags", "Deck direction", collapsedTags)}
        <div class="overlay-section-body" data-section-body="tags" ${collapsedTags ? "hidden" : ""}>
          <div class="overlay-chip-row">
            ${OVERLAY_TAGS.map((tag) => `<button type="button" class="overlay-chip${selectedTagSet.has(tag) ? " is-on" : ""}" data-overlay-tag="${tag}">${esc(tag)}</button>`).join("")}
          </div>
        </div>
      </article>

      <article class="overlay-card" data-overlay-section="decisions">
        ${renderOverlayCardHead("decisions", "Next decision", collapsedDecisions)}
        <div class="overlay-section-body" data-section-body="decisions" ${collapsedDecisions ? "hidden" : ""}>
          <div class="overlay-check-grid">
            ${OVERLAY_DECISIONS.map((d) => `<label><input type="checkbox" data-overlay-decision="${d.key}"${s.decisions[d.key] ? " checked" : ""} /> ${esc(d.label)}</label>`).join("")}
          </div>
        </div>
      </article>

      <article class="overlay-card" data-overlay-section="notes">
        ${renderOverlayCardHead("notes", "Notes", collapsedNotes)}
        <div class="overlay-section-body" data-section-body="notes" ${collapsedNotes ? "hidden" : ""}>
          <textarea rows="5" data-overlay-field="notes" placeholder="Remember to remove Strike. Need AoE before Act 2. Save potion for elite.">${esc(s.notes || "")}</textarea>
        </div>
      </article>

      <article class="overlay-card" data-overlay-section="reminders">
        ${renderOverlayCardHead("reminders", "Reminders", collapsedReminders)}
        <div class="overlay-section-body" data-section-body="reminders" ${collapsedReminders ? "hidden" : ""}>
          <div class="overlay-chip-row">
            ${OVERLAY_REMINDERS.map((r) => `<button type="button" class="overlay-chip${selectedReminderSet.has(r.key) ? " is-on" : ""}" data-overlay-reminder="${r.key}">${esc(r.label)}</button>`).join("")}
          </div>
        </div>
      </article>

      <article class="overlay-card overlay-privacy">
        <h4>Privacy model</h4>
        <p>Overlay data stays local. SpireVault does not modify the game, inject code, read memory, or upload your private run history.</p>
        <div class="overlay-pill-row">
          <span class="mini-pill">Manual analyze only</span>
          <span class="mini-pill">Local-first</span>
          <span class="mini-pill">No game modification</span>
        </div>
      </article>
    </section>

    <section class="overlay-grid overlay-grid--two">
      <article class="overlay-card" data-overlay-section="helper">
        ${renderOverlayCardHead("helper", "Decision helper", collapsedHelper)}
        <div class="overlay-section-body" data-section-body="helper" ${collapsedHelper ? "hidden" : ""}>
          <ul class="overlay-helper-list">
            <li><strong>Card reward:</strong> immediate problem solved? boss matchup improved? relic fit? deck consistency preserved?</li>
            <li><strong>Pathing:</strong> elite count, rest sites, shop timing, current strength, pivot room.</li>
            <li><strong>Shop:</strong> remove vs potion vs relic vs card, and whether to save gold.</li>
            <li><strong>Co-op:</strong> what partner needs, who takes risk, align before elite/boss.</li>
          </ul>
        </div>
      </article>
      <article class="overlay-card" data-overlay-section="settings">
        ${renderOverlayCardHead("settings", "Overlay settings", collapsedSettings)}
        <div class="overlay-section-body" data-section-body="settings" ${collapsedSettings ? "hidden" : ""}>
          <div class="overlay-form-grid">
            <label><input type="checkbox" data-overlay-field="enabled"${s.enabled ? " checked" : ""} /> Enable overlay feature</label>
            <label>Default mode
              <select data-overlay-field="mode">
                ${["full", "compact", "minimal"].map((m) => `<option value="${m}"${s.mode === m ? " selected" : ""}>${m === "minimal" ? "Minimal HUD" : `${m[0].toUpperCase() + m.slice(1)} panel`}</option>`).join("")}
              </select>
            </label>
            <label><input type="checkbox" data-overlay-field="prefs.alwaysOnTop"${s.prefs.alwaysOnTop ? " checked" : ""} /> Always on top <span class="muted">(native app only / planned)</span></label>
            <label>Transparency ${Number(s.prefs.transparency) || 92}%
              <input type="range" min="55" max="100" value="${Number(s.prefs.transparency) || 92}" data-overlay-field="prefs.transparency" />
            </label>
            <label>Font size
              <select data-overlay-field="prefs.fontSize">
                ${["small", "medium", "large"].map((f) => `<option value="${f}"${s.prefs.fontSize === f ? " selected" : ""}>${f[0].toUpperCase() + f.slice(1)}</option>`).join("")}
              </select>
            </label>
            <label>Position
              <select data-overlay-field="prefs.position">
                ${["top-right", "top-left", "bottom-right", "bottom-left", "custom"].map((p) => `<option value="${p}"${s.prefs.position === p ? " selected" : ""}>${p}</option>`).join("")}
              </select>
            </label>
            <label><input type="checkbox" data-overlay-field="prefs.privacyReminder"${s.prefs.privacyReminder ? " checked" : ""} /> Privacy reminder enabled</label>
          </div>
        </div>
      </article>
    </section>
  `;

  // Mode toggles.
  $body.querySelectorAll("[data-overlay-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      s.mode = btn.dataset.overlayMode || "compact";
      saveOverlayState(s);
      renderOverlayTab();
    });
  });

  // Tag/reminder/decision/field handlers.
  $body.querySelectorAll("[data-overlay-tag]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.overlayTag;
      if (!key) return;
      s.tags = s.tags.includes(key) ? s.tags.filter((t) => t !== key) : [...s.tags, key];
      saveOverlayState(s);
      renderOverlayTab();
    });
  });
  $body.querySelectorAll("[data-overlay-reminder]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.overlayReminder;
      if (!key) return;
      s.reminders = s.reminders.includes(key) ? s.reminders.filter((r) => r !== key) : [...s.reminders, key];
      saveOverlayState(s);
      renderOverlayTab();
    });
  });
  $body.querySelectorAll("[data-overlay-decision]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.overlayDecision;
      if (!key) return;
      s.decisions[key] = !!input.checked;
      saveOverlayState(s);
      // Rerender so the recommendation card updates immediately. We
      // intentionally don't rerender on every keystroke for text inputs.
      renderOverlayTab();
    });
  });
  $body.querySelectorAll("[data-overlay-field]").forEach((input) => {
    const save = () => {
      const key = input.dataset.overlayField;
      if (!key) return;
      let value = input.value;
      if (input.type === "checkbox") value = !!input.checked;
      else if (input.type === "number" || input.type === "range") value = Number(input.value);
      setOverlayPathValue(s, key, value);
      saveOverlayState(s);
    };
    input.addEventListener("input", save);
    input.addEventListener("change", () => {
      save();
      renderOverlayTab();
    });
  });

  // Collapsible section toggles.
  $body.querySelectorAll("[data-overlay-collapse]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sec = btn.dataset.overlayCollapse;
      if (!sec) return;
      s.collapsed = s.collapsed || {};
      s.collapsed[sec] = !s.collapsed[sec];
      saveOverlayState(s);
      renderOverlayTab();
    });
  });

  // AI assist actions.
  $body.querySelectorAll("[data-overlay-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.overlayAction;
      if (action === "ai-accept") {
        s.provider = { ...(s.provider || {}), acceptedDisclosure: true };
        saveOverlayState(s);
        renderOverlayTab();
      } else if (action === "ai-clear") {
        s.provider = { ...(s.provider || {}), lastResult: null, lastAnalyzedAt: 0 };
        saveOverlayState(s);
        renderOverlayTab();
      } else if (action === "ai-analyze") {
        const $picker = $body.querySelector("[data-overlay-screenshot]");
        if ($picker) $picker.click();
      }
    });
  });

  // Wire the hidden file picker that drives the analyze flow.
  const $picker = $body.querySelector("[data-overlay-screenshot]");
  if ($picker) {
    $picker.addEventListener("change", () => {
      const file = $picker.files && $picker.files[0];
      if (!file) return;
      void runOverlayAnalyze(file);
      $picker.value = "";
    });
  }
}

function renderOverlayCollapsibleHeader(section, label, collapsed) {
  return `
    <button type="button" class="overlay-section-header${collapsed ? " is-collapsed" : ""}" data-overlay-collapse="${esc(section)}" aria-expanded="${collapsed ? "false" : "true"}">
      <span>${esc(label)}</span>
      <span class="overlay-section-caret" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
    </button>
  `;
}

function renderOverlayCardHead(section, label, collapsed) {
  return `
    <button type="button" class="overlay-card-head${collapsed ? " is-collapsed" : ""}" data-overlay-collapse="${esc(section)}" aria-expanded="${collapsed ? "false" : "true"}">
      <h4>${esc(label)}</h4>
      <span class="overlay-section-caret" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>
    </button>
  `;
}

// =========================================================================
// Optional AI screenshot assist.
//
// Manual-only. Triggered by the user clicking "Analyze screenshot" and
// picking an image file. We POST directly from the browser to the user's
// chosen provider (OpenAI today). SpireVault servers never see the image
// or the API key. We rate-limit to one call every 10 seconds and
// validate the response strictly before rendering.
// =========================================================================
async function runOverlayAnalyze(file) {
  const s = loadOverlayState();
  if (!s.provider?.acceptedDisclosure) {
    toast("Enable manual screenshot assist first.");
    return;
  }
  const apiKey = (s.provider?.apiKey || "").trim();
  if (!apiKey) {
    toast("Add your API key in the Screenshot assist card.");
    return;
  }
  const since = Date.now() - (s.provider?.lastAnalyzedAt || 0);
  if (s.provider?.lastAnalyzedAt && since < OVERLAY_ANALYZE_COOLDOWN_MS) {
    const wait = Math.ceil((OVERLAY_ANALYZE_COOLDOWN_MS - since) / 1000);
    toast(`Slow down — wait ${wait}s before analyzing again.`);
    return;
  }
  if (!file || file.size > 6 * 1024 * 1024) {
    toast("Pick a screenshot under 6 MB (PNG/JPEG/WebP).");
    return;
  }
  const $status = document.querySelector("[data-overlay-ai-status]");
  if ($status) $status.textContent = "Analyzing screenshot…";

  try {
    const dataUrl = await readFileAsDataURL(file);
    const { system, user } = OverlayEngine.buildVisionPrompt(s);
    const provider = (s.provider?.name || "openai").toLowerCase();

    let parsed = null;
    if (provider === "openai") {
      parsed = await callOpenAIVision(apiKey, s.provider.model || "gpt-4o-mini", system, user, dataUrl);
    } else {
      throw new Error("Unsupported provider");
    }

    const valid = OverlayEngine.validateVisionResponse(parsed);
    if (!valid) {
      toast("Provider returned an unreadable response. Try again.");
      if ($status) $status.textContent = "Last analyze failed (unreadable response).";
      return;
    }
    s.provider = {
      ...(s.provider || {}),
      lastAnalyzedAt: Date.now(),
      lastResult: valid,
    };
    saveOverlayState(s);
    renderOverlayTab();
    toast("Screenshot analyzed.");
  } catch (err) {
    console.warn("[Overlay] analyze failed", err);
    toast("Screenshot analyze failed. Check your API key and try again.");
    if ($status) $status.textContent = "Last analyze failed.";
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

async function callOpenAIVision(apiKey, model, system, user, dataUrl) {
  const body = {
    model: model || "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 400,
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`openai_${r.status}_${text.slice(0, 120)}`);
  }
  const json = await r.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

function formatRelative(ts) {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
  return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
}

/** Render the per-character grid card. Shared between Overview and the
 *  dedicated Characters tab so both surfaces feel like one product. Each
 *  card is keyboard-focusable and routes to the Characters tab on click,
 *  so the cards behave like the desktop app's clickable tiles. */
/** Render the character grid. `opts.expandable` controls whether
 *  clicking a card opens an inline detail panel (used on the
 *  Characters tab) or routes to the Characters tab (used on
 *  Overview).
 *
 *  When `expandable` is true we surface an explicit "View details"
 *  footer with a chevron — without it the card looked like static
 *  data and users didn't realize they could tap it. The footer also
 *  plays a subtle hover/active animation so the affordance is
 *  reinforced on pointer devices. */
function renderCharCards(buckets, opts = {}) {
  const expandable = !!opts.expandable;
  // Overview passes each climber's current win streak; the Characters tab does not.
  const streaks = opts.streaks || new Map();
  // The filter the streak counts within ("Standard A10"), named in its tooltip.
  const streakScope = opts.streakScope ? ` (${opts.streakScope})` : "";
  const emptyText = opts.emptyText || "No runs yet";
  if (!buckets || !buckets.length) {
    return `<p class="muted">No character data yet.</p>`;
  }
  const hint = expandable
    ? `<div class="char-card-cta">
         <span>View details</span>
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>
       </div>`
    : "";
  const cardClass = expandable ? "char-card is-clickable" : "char-card";
  return `
    <div class="char-grid">
      ${buckets.map((c) => {
        const theme = charTheme(c.key);
        const played = c.runs > 0;
        const wr = (c.winrate * 100).toFixed(1);
        const lossCount = c.runs - c.wins;
        const dataAttrs = expandable
          ? `data-action="char-expand" data-char-key="${esc(c.key)}"`
          : `data-action="goto-tab" data-tab="characters"`;
        const name = prettifyCharacterName(c.key);
        const streak = shownStreak(streaks, c.key);
        const streakPill = streak > 0
          ? `<span class="char-card-streak" title="${esc(name)}: ${streak} wins in a row${esc(streakScope)}" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" fill="currentColor" d="M12.6 1.6c.5 3.5 3.5 5.4 5 8.3 1.5 2.9 1.4 6.5-.9 8.9a7 7 0 0 1-11.3-2c-1-2.7-.2-5.6 1.9-7.6.1 1.9.9 3.2 2.1 3.8-.6-4.5.6-8.4 3.2-11.4zM12.2 12.4c-1 1.3-1.9 2.5-1.9 4.1a2.3 2.3 0 0 0 4.6.1c0-1.6-1.2-2.8-2.7-4.2z"/></svg><strong>${streak}</strong> in a row</span>`
          : "";
        const spokenStreak = streak > 0 ? ` ${streak} wins in a row${esc(streakScope)}.` : "";
        return `
          <div class="${cardClass}${played ? "" : " is-unplayed"}" style="--char-color:${theme.color}"
               role="button" tabindex="0"
               ${dataAttrs}
               aria-label="${esc(name)}: ${played ? `${wr}% winrate over ${c.runs} runs.${spokenStreak}` : `${esc(emptyText.toLowerCase())}.`}${expandable ? " Tap to view details." : ""}">
            <div class="char-card-head">
              <div class="char-card-icon">${charPortraitOrIcon(c.key, theme)}</div>
              ${streakPill}
              <span class="char-card-runs">${c.runs} runs</span>
            </div>
            <div class="char-card-name">${esc(name)}</div>
            <div class="char-card-record">${played ? `${c.wins} win${c.wins === 1 ? "" : "s"} &middot; ${lossCount} loss${lossCount === 1 ? "" : "es"}` : esc(emptyText)}</div>
            <div class="char-card-wr">
              <strong class="char-card-pct">${played ? `${wr}%` : "&mdash;"}</strong>
              <span class="char-card-pct-label">Winrate</span>
            </div>
            <div class="char-card-bar"><span style="width:${Math.min(100, c.winrate * 100)}%"></span></div>
            ${hint}
          </div>`;
      }).join("")}
    </div>`;
}

// =========================================================================
// Milestone toasts
//
// Celebrate meaningful thresholds in a player's run history. Each
// milestone is keyed; once reached, it's stored in localStorage so we
// don't repeat it. Designed to be quiet — milestones only fire on
// commitParsedRuns (a real ingest), never on idle re-renders, each one
// fires at most once, and one ingest shows one card at most.
//
// Catalog: first run, first win, run-count tiers (10/25/50/100/250/500),
// win-count tiers (5/10/25/50), longest streak (3/5/10), first daily,
// first character clear (Ironclad/Silent/etc.).
// =========================================================================
const MILESTONES_KEY = "vault.web.milestones.awarded.v1";

function readAwarded() {
  try { return new Set(JSON.parse(localStorage.getItem(MILESTONES_KEY) || "[]")); }
  catch { return new Set(); }
}
function writeAwarded(set) {
  try { localStorage.setItem(MILESTONES_KEY, JSON.stringify([...set])); } catch {}
}
/** Every milestone, least to most notable: when one ingest crosses
 *  several, the card shows the last of them in this list. `reached`
 *  reads the numbers from milestoneMetrics(). */
const MILESTONE_CATALOG = [
  { key: "runs.1",      reached: (m) => m.total >= 1,    title: "First run logged", body: "Welcome to SpireVault. Your run history is now tracked.", icon: "🎉" },
  { key: "runs.10",     reached: (m) => m.total >= 10,   title: "10 runs",          body: "You're warmed up. Keep climbing.", icon: "📈" },
  { key: "daily.first", reached: (m) => m.anyDaily,      title: "Daily climber",    body: "First daily run logged. Daily seeds appear with a special badge in Highlights.", icon: "🌅" },
  { key: "runs.25",     reached: (m) => m.total >= 25,   title: "25 runs logged",   body: "Patterns starting to show. Check the Cards tab.", icon: "🃏" },
  { key: "runs.50",     reached: (m) => m.total >= 50,   title: "50 runs",          body: "Half a hundred climbs. Your stats are getting trustworthy.", icon: "🏔️" },
  { key: "char.first-clear", perCharacter: true },
  { key: "wins.1",      reached: (m) => m.wins >= 1,     title: "First victory!",   body: "You beat the Spire. Open this run from Recent Runs and share it.", icon: "🏆" },
  { key: "wins.5",      reached: (m) => m.wins >= 5,     title: "5 victories",      body: "Reliable climbing. Higher ascensions await.", icon: "⭐" },
  { key: "streak.3",    reached: (m) => m.streak >= 3,   title: "3-win streak",     body: "Three in a row. The Spire trembles.", icon: "🔥" },
  { key: "runs.100",    reached: (m) => m.total >= 100,  title: "100 runs!",        body: "You've officially put time into the Spire.", icon: "💯" },
  { key: "wins.10",     reached: (m) => m.wins >= 10,    title: "10 victories",     body: "Double-digit wins. Try the Ascensions tab to push harder.", icon: "🌟" },
  { key: "streak.5",    reached: (m) => m.streak >= 5,   title: "5-win streak",     body: "Five consecutive wins. You found something.", icon: "🔥" },
  { key: "runs.250",    reached: (m) => m.total >= 250,  title: "250 runs",         body: "Veteran territory. Time to share a Highlight?", icon: "⚔️" },
  { key: "wins.25",     reached: (m) => m.wins >= 25,    title: "25 victories",     body: "Quarter-century. Your build crafting is on point.", icon: "💎" },
  { key: "runs.500",    reached: (m) => m.total >= 500,  title: "500 runs",         body: "Five hundred climbs. The Spire knows your name.", icon: "👑" },
  { key: "streak.10",   reached: (m) => m.streak >= 10,  title: "10-win streak!",   body: "Ten in a row. That's not luck — that's mastery.", icon: "🔥" },
  { key: "wins.50",     reached: (m) => m.wins >= 50,    title: "50 victories",     body: "Half a hundred wins. Genuinely impressive.", icon: "👑" },
];

/** The numbers milestones are judged on, for one set of runs. */
function milestoneMetrics(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const clearedCharacters = new Set();
  for (const r of list) {
    if (r.won && r.character) clearedCharacters.add(String(r.character).toLowerCase());
  }
  return {
    total: list.length,
    wins: list.filter((r) => r.won).length,
    streak: computeLongestWinStreak(list),
    anyDaily: list.some((r) => String(r.gameMode || "").toLowerCase() === "daily"),
    clearedCharacters,
  };
}

/** Every milestone a set of runs has reached, in catalog order. */
function reachedMilestones(runs) {
  const m = milestoneMetrics(runs);
  const out = [];
  for (const entry of MILESTONE_CATALOG) {
    if (!entry.perCharacter) {
      if (entry.reached(m)) out.push(entry);
      continue;
    }
    for (const character of m.clearedCharacters) {
      const name = prettifyCharacterName(character);
      out.push({
        key: `char.first-clear.${character}`,
        title: `First ${name} clear`,
        body: `You beat the Spire as ${name} for the first time. Every character clear unlocks a new flavor of mastery.`,
        icon: "✨",
      });
    }
  }
  return out;
}

/** Celebrate what this ingest newly reached: one card at most, the most
 *  notable. `priorRuns` is the set loaded before the ingest. Without
 *  `celebrate` (a first import, a re-import into an empty browser) the
 *  milestones are recorded quietly: a player importing 140 old runs got
 *  a dozen stacked cards over the whole page, one per milestone they
 *  passed long ago. Everything reached is recorded either way, so it
 *  never replays later. */
function evaluateMilestones(priorRuns, { celebrate = false } = {}) {
  if (!Array.isArray(parsedRuns) || parsedRuns.length === 0) return;
  const before = new Set(reachedMilestones(priorRuns).map((m) => m.key));
  const now = reachedMilestones(parsedRuns);
  const awarded = readAwarded();
  const fresh = now.filter((m) => !before.has(m.key) && !awarded.has(m.key));
  const next = new Set([...awarded, ...now.map((m) => m.key)]);
  if (next.size !== awarded.size) writeAwarded(next);
  if (!celebrate || fresh.length === 0) return;
  const best = fresh[fresh.length - 1];
  showMilestoneToast(best.title, best.body, best.icon);
  try { sendBeacon("milestone", `key=${encodeURIComponent(best.key)}`); } catch {}
  vaultGtagEvent("milestone_award", {
    milestone_key: best.key,
    milestone_title: String(best.title || "").slice(0, 80),
  });
}

/** Walk runs in chronological order (oldest → newest) and return the
 *  longest run of consecutive wins. Defeats and abandons reset the
 *  counter. Stable on out-of-order disk reads because we sort first. */
function computeLongestWinStreak(runs) {
  if (!Array.isArray(runs)) return 0;
  const sorted = runs.slice().sort((a, b) => {
    const ta = a.endedAt instanceof Date ? a.endedAt.getTime() : Number(a.endedAt) || 0;
    const tb = b.endedAt instanceof Date ? b.endedAt.getTime() : Number(b.endedAt) || 0;
    return ta - tb;
  });
  let best = 0, run = 0;
  for (const r of sorted) {
    if (r.won) { run += 1; if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

/** Render a milestone toast — visually distinct from the standard
 *  toast used for "Reaction failed" etc. Stays on screen longer
 *  (5s) and animates in with a small bounce so it actually
 *  registers as a celebration. Stacks if multiple fire in one
 *  evaluation pass. */
function showMilestoneToast(title, body, icon) {
  let $stack = document.getElementById("milestone-stack");
  if (!$stack) {
    $stack = document.createElement("div");
    $stack.id = "milestone-stack";
    $stack.className = "milestone-stack";
    document.body.appendChild($stack);
  }
  // One card at a time: a newer milestone replaces the one showing.
  $stack.replaceChildren();
  const $card = document.createElement("div");
  $card.className = "milestone-card";
  $card.setAttribute("role", "status");
  $card.setAttribute("aria-live", "polite");
  $card.innerHTML = `
    <span class="milestone-icon" aria-hidden="true">${icon || "✨"}</span>
    <div class="milestone-text">
      <strong class="milestone-title">${esc(title)}</strong>
      <span class="milestone-body">${esc(body)}</span>
    </div>
    <button class="milestone-close" type="button" aria-label="Dismiss">&times;</button>
  `;
  $stack.appendChild($card);
  const dismiss = () => {
    $card.classList.add("is-leaving");
    setTimeout(() => $card.remove(), 260);
  };
  $card.querySelector(".milestone-close").addEventListener("click", dismiss);
  setTimeout(dismiss, 5400);
}

// =========================================================================
// Victory Celebration Overlay
// =========================================================================
const CHAR_META = (() => {
  const map = {};
  for (const c of [
    { id: "ironclad",    label: "Ironclad",    color: "#e94560" },
    { id: "silent",      label: "Silent",      color: "#6dd97c" },
    { id: "defect",      label: "Defect",      color: "#4dc8ff" },
    { id: "regent",      label: "Regent",      color: "#fbbf24" },
    { id: "necrobinder", label: "Necrobinder", color: "#a78bfa" },
    { id: "fool",        label: "The Fool",    color: "#f27ec0" }, // STS2 public beta
  ]) map[c.id] = c;
  return map;
})();

function showVictoryCelebration(run, streakCount) {
  // The old overlay slapped a 75 % dark backdrop over the entire app and
  // trapped a small confetti canvas inside it. Stats updated behind a
  // black wall and the celebration felt like a "you have a new email"
  // modal instead of "you just won an STS2 run". This version is
  // unboxed: confetti rains over the live page, a brief character-tinted
  // edge flash gives the moment a punch, and the card sits as a toast
  // near the bottom so the user can still see their new run appearing
  // on the Overview stats behind it.
  document.getElementById("victory-overlay")?.remove();

  const meta = CHAR_META[run.character] || { label: capitalize(run.character || "Unknown"), color: "#d4af37" };
  const ascStr = !isLadderRun(run) ? ` · ${runAscText(run)}` : run.ascension > 0 ? ` · A${run.ascension}` : "";
  const floorStr = run.floorReached ? `Floor ${run.floorReached}` : "";
  const streakHtml = streakCount >= 2 ? `
    <div class="victory-streak">
      <span class="victory-streak-flame" aria-hidden="true">🔥</span>
      <span class="victory-streak-num">${streakCount}</span>
      <span class="victory-streak-label">in a row</span>
    </div>` : "";

  const overlay = document.createElement("div");
  overlay.id = "victory-overlay";
  // No `aria-modal` — the page content is still readable behind the
  // celebration on purpose. The card is still a `dialog` so screen
  // readers announce it, but focus is NOT trapped and the rest of the
  // app stays interactive (Refresh / Import / tab nav all work).
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Victory");
  overlay.style.setProperty("--char-color", meta.color);
  // Note: no `.victory-progress` element anymore. The bar implied an
  // auto-dismiss countdown — but a real user reported a finished run
  // disappearing before they got to read it, and asked us to keep the
  // card up until they explicitly click Continue. The confetti and
  // trophy still fade after CELEBRATION_DECOR_MS via the CSS
  // `.victory-decor-faded` class, so the moment still feels punchy
  // without trapping the user inside a perpetual overlay.
  overlay.innerHTML = `
    <div class="victory-flash" aria-hidden="true"></div>
    <div class="victory-confetti-canvas" aria-hidden="true"></div>
    <div class="victory-card" role="document">
      <div class="victory-trophy" aria-hidden="true">🏆</div>
      <div class="victory-eyebrow">Victory</div>
      <h2 class="victory-title">${esc(meta.label)}${esc(ascStr)}</h2>
      ${floorStr ? `<p class="victory-floor">${esc(floorStr)}</p>` : ""}
      ${streakHtml}
      <button type="button" class="victory-dismiss" id="victory-dismiss">Continue</button>
    </div>`;
  document.body.appendChild(overlay);

  spawnConfetti(overlay.querySelector(".victory-confetti-canvas"), meta.color);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    overlay.classList.add("victory-exit");
    overlay.addEventListener("animationend", () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 450);
  };

  // Decor fade timer — fires once, cannot be cancelled by the user.
  // After this, the confetti, flash, and trophy quietly fade out so
  // the screen stops looking like a parade. The CARD itself stays put
  // until the user clicks Continue / Esc / outside.
  //
  // Rationale: previously the whole overlay auto-dismissed after 7s
  // and a user reading their run details would lose the card before
  // they finished. Splitting the timer (decor → 7s, card → user) keeps
  // the celebratory burst while respecting their pace.
  const CELEBRATION_DECOR_MS = 7000;
  setTimeout(() => {
    if (!dismissed) overlay.classList.add("victory-decor-faded");
  }, CELEBRATION_DECOR_MS);

  document.getElementById("victory-dismiss")?.addEventListener("click", dismiss);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });

  const onKey = (e) => { if (e.key === "Escape") { dismiss(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);

  setTimeout(() => document.getElementById("victory-dismiss")?.focus({ preventScroll: true }), 100);
}

function spawnConfetti(canvas, accentColor) {
  if (!canvas) return;
  const COLORS = [accentColor || "#d4af37", "#ff6b1a", "#7b61ff", "#6dd97c", "#ff4f4f", "#61c4d9", "#fff8e7", "#d4af37"];
  // Denser drop (~2.2× pieces) and wider stagger so the rain feels
  // continuous for the full 7-second window. Each piece picks its own
  // velocity, drift, rotation, and shape so the eye doesn't lock onto
  // a repeating pattern.
  const COUNT = 140;
  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement("div");
    el.className = "victory-confetti-piece";
    const left  = -2 + Math.random() * 104;
    const delay = Math.random() * 3.4;
    const dur   = 2.6 + Math.random() * 3.4;
    const w     = 5 + Math.random() * 11;
    const h     = w * (0.4 + Math.random() * 1.2);
    const rot   = -540 + Math.random() * 1080;
    const drift = -90 + Math.random() * 180;
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const shape = Math.random();
    const radius = shape > 0.7 ? "50%" : (shape > 0.4 ? "2px" : "1px");
    el.style.cssText = `left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;width:${w}px;height:${h}px;background:${color};border-radius:${radius};--rot:${rot}deg;--drift:${drift}px;`;
    canvas.appendChild(el);
  }
}

// =========================================================================
// Keyboard shortcuts
//
//   1–9 / 0    → jump to a sidebar tab in nav order
//   /          → focus a search-shaped input on the current page
//   r          → refresh save history
//   i          → import (pick a save folder)
//   ?          → toggle the keyboard-shortcut help overlay
//   esc        → close any open modal / popover / overlay
//
// All shortcuts are suppressed while the user is typing in an input,
// textarea, or contenteditable element so they don't fight content
// editing. The help overlay itself is rendered lazily on first use.
// =========================================================================
function wireKeyboardShortcuts() {
  if (window.__keyboardShortcutsWired) return;
  window.__keyboardShortcutsWired = true;

  const isTypingTarget = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return false;
  };

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    // The "?" key on most US keyboards lands as Shift+/. We let "?"
    // through even from text inputs because it's an explicit help
    // request, but suppress everything else when typing.
    const isQuestion = e.key === "?" || (e.key === "/" && e.shiftKey);
    if (isTypingTarget(target) && !isQuestion) {
      // Allow Esc out of inputs (closes overlays without forcing blur first).
      if (e.key !== "Escape") return;
    }

    // Escape closes the topmost dismissible UI.
    if (e.key === "Escape") {
      const $kbd = document.getElementById("kbd-help");
      if ($kbd && !$kbd.hidden) { $kbd.hidden = true; e.preventDefault(); return; }
      const $modal = document.getElementById("run-detail-modal");
      if ($modal && !$modal.hidden) { closeRunDetailModal(); e.preventDefault(); return; }
      // Other modals (share, etc.) close themselves via their own Esc handlers.
      return;
    }

    if (isQuestion) {
      e.preventDefault();
      toggleKbdHelp();
      return;
    }

    // Slash → focus the first visible search-style input on the page.
    if (e.key === "/") {
      const $search = findFocusableSearchInput();
      if ($search) {
        e.preventDefault();
        $search.focus();
        try { $search.select(); } catch {}
      }
      return;
    }

    // Number keys → tab navigation. We use whatever order the sidebar
    // currently presents (which mirrors `KNOWN_TABS` minus Overlay).
    if (/^[0-9]$/.test(e.key)) {
      const idx = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
      const $rows = Array.from(document.querySelectorAll(".nav-row"))
        .filter(($b) => !$b.hidden && $b.offsetParent !== null);
      const $row = $rows[idx];
      if ($row && $row.dataset.tab) {
        e.preventDefault();
        switchTab($row.dataset.tab);
      }
      return;
    }

    // R refreshes save history (linked-folder reload).
    if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      void reloadSavedHistoryInteractive();
      return;
    }

    // I imports / re-picks a save folder.
    if (e.key === "i" || e.key === "I") {
      e.preventDefault();
      void scanForHistory();
      return;
    }
  });
}

/** Find the most plausible search-style input on the current view. We
 *  fall back through a few selectors because different tabs have
 *  different inputs (and Recent Runs may not have a search at all). */
function findFocusableSearchInput() {
  const candidates = [
    'input[type="search"]:not([disabled])',
    'input[placeholder*="search" i]:not([disabled])',
    'input[name*="search" i]:not([disabled])',
    '#run-search',
    '#highlight-search',
  ];
  for (const sel of candidates) {
    const $el = document.querySelector(sel);
    if ($el && $el.offsetParent !== null) return $el;
  }
  return null;
}

/** Lazily mount and toggle the keyboard-shortcut help overlay. The
 *  markup lives in JS so we don't have a dormant element in HTML
 *  cluttering the document tree until it's needed. */
function toggleKbdHelp() {
  let $kbd = document.getElementById("kbd-help");
  if (!$kbd) {
    $kbd = document.createElement("div");
    $kbd.id = "kbd-help";
    $kbd.className = "kbd-help";
    $kbd.setAttribute("role", "dialog");
    $kbd.setAttribute("aria-modal", "true");
    $kbd.setAttribute("aria-labelledby", "kbd-help-title");
    $kbd.hidden = true;
    $kbd.innerHTML = `
      <div class="kbd-help-backdrop" data-kbd-action="close"></div>
      <div class="kbd-help-card">
        <header class="kbd-help-head">
          <h3 id="kbd-help-title">Keyboard shortcuts</h3>
          <button class="kbd-help-close" type="button" data-kbd-action="close" aria-label="Close">&times;</button>
        </header>
        <div class="kbd-help-body">
          <section>
            <h4>Navigation</h4>
            <ul>
              <li><span><kbd>1</kbd>–<kbd>9</kbd></span><em>jump to a sidebar tab</em></li>
              <li><span><kbd>0</kbd></span><em>last sidebar tab</em></li>
              <li><span><kbd>Esc</kbd></span><em>close any modal or overlay</em></li>
            </ul>
          </section>
          <section>
            <h4>Save data</h4>
            <ul>
              <li><span><kbd>R</kbd></span><em>refresh from disk</em></li>
              <li><span><kbd>I</kbd></span><em>import or re-pick a folder</em></li>
            </ul>
          </section>
          <section>
            <h4>Search &amp; help</h4>
            <ul>
              <li><span><kbd>/</kbd></span><em>focus the search field</em></li>
              <li><span><kbd>?</kbd></span><em>toggle this help</em></li>
            </ul>
          </section>
        </div>
      </div>
    `;
    document.body.appendChild($kbd);
    $kbd.addEventListener("click", (e) => {
      if (e.target.closest('[data-kbd-action="close"]')) {
        $kbd.hidden = true;
      }
    });
  }
  $kbd.hidden = !$kbd.hidden;
}

/** Inline character drill-down — shown below the grid on the
 *  Characters tab when a card is selected. Pulls from `CharInfo`
 *  for hand-written copy and from the per-character bucket for
 *  the user's personal stats. */
function renderCharacterDetail(charKey, bucket) {
  if (UI) return renderCharacterDetailNext(charKey, bucket);
  const info = CharInfo.characterInfoFor(charKey);
  const theme = charTheme(charKey);
  const personal = bucket
    ? `<div class="char-detail-stats">
         <div class="char-detail-stat">
           <span class="char-detail-stat-label">Your runs</span>
           <strong class="char-detail-stat-value">${bucket.runs}</strong>
         </div>
         <div class="char-detail-stat">
           <span class="char-detail-stat-label">Wins</span>
           <strong class="char-detail-stat-value" style="color:var(--win)">${bucket.wins}</strong>
         </div>
         <div class="char-detail-stat">
           <span class="char-detail-stat-label">Losses</span>
           <strong class="char-detail-stat-value" style="color:var(--loss)">${bucket.runs - bucket.wins}</strong>
         </div>
         <div class="char-detail-stat">
           <span class="char-detail-stat-label">Win rate</span>
           <strong class="char-detail-stat-value" style="color:${theme.color}">${(bucket.winrate * 100).toFixed(1)}%</strong>
         </div>
       </div>`
    : `<p class="muted small">You haven't played ${esc(prettifyCharacterName(charKey))} yet.</p>`;

  if (!info) {
    return `
      <div class="char-detail" data-char-detail="${esc(charKey)}">
        <div class="char-detail-head">
          <h3 class="char-detail-name">${esc(prettifyCharacterName(charKey))}</h3>
          <button class="char-detail-close" type="button" data-action="char-collapse" aria-label="Close">&times;</button>
        </div>
        ${personal}
      </div>`;
  }

  const stars = (n) => "&#9733;".repeat(n) + "&#9734;".repeat(Math.max(0, 5 - n));
  const meterRow = (label, val) => `
    <div class="char-detail-meter">
      <span class="char-detail-meter-label">${esc(label)}</span>
      <div class="char-detail-meter-bar">
        <span style="width:${val * 20}%; background:${theme.color}"></span>
      </div>
      <span class="char-detail-meter-val">${val}/5</span>
    </div>`;

  const tipsHtml = info.tips.map((t) => `<li>${esc(t)}</li>`).join("");
  const archetypeChips = info.archetypes
    .map((a) => `<span class="char-detail-chip" style="--chip-color:${theme.color}">${esc(a)}</span>`)
    .join("");
  const mechanicCards = info.mechanics
    .map((m) => `
      <div class="char-detail-mech">
        <strong class="char-detail-mech-title">${esc(m.title)}</strong>
        <p class="char-detail-mech-text">${esc(m.detail)}</p>
      </div>`)
    .join("");

  return `
    <div class="char-detail" data-char-detail="${esc(charKey)}" style="--char-color:${theme.color}">
      <div class="char-detail-head">
        <div class="char-detail-portrait">${charPortraitOrIcon(charKey, theme)}</div>
        <div class="char-detail-titles">
          <h3 class="char-detail-name">${esc(info.name)}</h3>
          <p class="char-detail-tagline">${esc(info.tagline)}</p>
          <div class="char-detail-meta">
            <span class="char-detail-role">${esc(info.role)}</span>
            ${info.difficulty > 0 ? `<span class="char-detail-difficulty" title="Difficulty">${stars(info.difficulty)}</span>` : ""}
          </div>
        </div>
        <button class="char-detail-close" type="button" data-action="char-collapse" aria-label="Close detail panel">&times;</button>
      </div>

      ${personal}

      <div class="char-detail-section">
        <h4 class="char-detail-section-title">Playstyle</h4>
        <p class="char-detail-summary">${esc(info.summary)}</p>
        ${info.playstyle.aggression > 0 || info.playstyle.complexity > 0 ? `<div class="char-detail-meters">
          ${meterRow("Aggression", info.playstyle.aggression)}
          ${meterRow("Complexity", info.playstyle.complexity)}
        </div>` : ""}
      </div>

      <div class="char-detail-section">
        <h4 class="char-detail-section-title">Archetypes</h4>
        <div class="char-detail-chips">${archetypeChips}</div>
      </div>

      <div class="char-detail-section">
        <h4 class="char-detail-section-title">Core mechanics</h4>
        <div class="char-detail-mech-grid">${mechanicCards}</div>
      </div>

      <div class="char-detail-section">
        <h4 class="char-detail-section-title">Climbing tips</h4>
        <ul class="char-detail-tips">${tipsHtml}</ul>
      </div>
    </div>`;
}

/** Every roster climber's bucket (a zero bucket when unplayed), then any
 *  other character in the data. */
function rosterBuckets(byCharacter) {
  const byKey = new Map((byCharacter || []).map((b) => [String(b.key).toLowerCase(), b]));
  const extras = [...byKey.keys()].filter((key) => !CREST_ROSTER.includes(key));
  return [...CREST_ROSTER, ...extras].map((key) => byKey.get(key) || { key, runs: 0, wins: 0, winrate: 0 });
}

function renderCharactersTab(report) {
  return `
    ${secTitle("Winrate by character", "people")}
    ${renderCharCards(rosterBuckets(report.byCharacter), { expandable: true })}
    <div id="char-detail-slot" class="char-detail-slot"></div>`;
}

/** New look: one banner per roster character (played or not) from the
 *  shared Overview rows, plus the codex role and difficulty. data-char-key
 *  keeps the bucket's own key so the shared char-expand handler finds it. */
function buildCharactersTabModel(report) {
  const bucketKeys = new Map((report.byCharacter || []).map((b) => [String(b.key).toLowerCase(), String(b.key)]));
  return {
    characters: buildCharacterRows(report).map((row) => {
      const info = CharInfo.characterInfoFor(row.key);
      return {
        ...row,
        actionKey: bucketKeys.get(row.key) || row.key,
        role: info ? info.role : "",
        difficulty: info ? info.difficulty : 0,
      };
    }),
  };
}

function renderCharactersTabNext(report) {
  return UI.CharactersView.charactersHtml(buildCharactersTabModel(report));
}

/** New look: the drill-down as a codex page (record, meter, accordions). */
function renderCharacterDetailNext(charKey, bucket) {
  const key = String(charKey || "").toLowerCase();
  const inked = UI.Stage.actorArt(key);
  return UI.CharactersView.characterCodexHtml({
    key,
    detailKey: String(charKey || ""),
    label: prettifyCharacterName(key),
    portraitSrc: inked ? inked.src : characterImageSrc(key),
    isPortraitInked: !!inked,
    iconHtml: charIcon(charTheme(key).icon),
    record: bucket ? { runs: bucket.runs, wins: bucket.wins, winratePct: bucket.winrate * 100 } : null,
    info: CharInfo.characterInfoFor(key),
  });
}

/** Classic "Detailed breakdown" bar colour per winrateTone() band against
 *  the player's overall win rate, as the relic and card panels colour
 *  theirs, so a 17% level no longer looks as green as a 71% one. */
const ASC_BAR_TINT = Object.freeze({ win: "var(--win)", gold: "var(--gold)", accent: "var(--accent)" });

/** z for a 95% interval, as lib/stats-engine.js uses. */
const WILSON_Z_95 = 1.96;

/**
 * Wilson lower bound (95%) of a win rate: the sum lib/stats-engine.js
 * gives relic and card buckets as `lb`. Ascension buckets come without
 * one, so winrateTone() painted every above-average level green, "proven",
 * and the colour key would have said so of a 5-run level. Copied because
 * that module does not export it.
 * @param {number} wins
 * @param {number} runs
 * @returns {number} 0..1
 */
function winRateLowerBound(wins, runs) {
  if (runs <= 0) return 0;
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const p = wins / runs;
  const center = p + z2 / (2 * runs);
  const margin = WILSON_Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * runs)) / runs);
  return Math.max(0, (center - margin) / (1 + z2 / runs));
}

/** Bar chart matching the desktop app's "Per ascension" panel.
 *  Each bar shows total runs (height proportional to max) with the wins
 *  portion painted in green from the bottom up. */
function renderAscensionsTab(report) {
  // STS2 Early Access caps the live ascension ladder at A10 (the level
  // that adds a second boss at the end of Act 3). A bucket above A10
  // should only appear if Mega Crit has shipped a new level — stale
  // A11–A18 noise from old STS1-modeled demo data gets filtered here so
  // the screen never claims a level the game doesn't have. If a future
  // patch raises the cap, the bucket renders cleanly via UNKNOWN_TIER
  // without code changes.
  const STS2_ASC_CAP = 10;
  // The tab follows its climber / ladder filter (spireSection). Unfiltered,
  // these are exactly report.byAscension's buckets.
  const { filter, runs } = spireSection();
  const isBlitz = filter.ladder === "blitz";
  const filtersHtml = renderClassicSpireFilters(filter, runs.length);
  const allBuckets = Filters.ascensionBuckets(runs, filter.ladder);
  const buckets = isBlitz ? allBuckets : allBuckets.filter((b) => parseAsc(b.key) <= STS2_ASC_CAP);
  const hiddenAbove = allBuckets.length - buckets.length;
  if (!buckets.length) {
    return `${filtersHtml}<p class="muted">No ascension data yet.</p>`;
  }
  const maxRuns = Math.max(...buckets.map((b) => b.runs), 1);
  const barChart = `
    <div class="asc-chart-panel">
      <div class="asc-chart">
        ${buckets.map((b) => {
          const totalH = Math.max(8, (b.runs / maxRuns) * 120);
          const winsH = b.runs > 0 ? totalH * (b.wins / b.runs) : 0;
          const wrPct = (b.winrate * 100).toFixed(1);
          return `
            <div class="asc-bar-col">
              <div class="asc-bar-stack">
                <div class="asc-bar-bg"></div>
                <div class="asc-bar-total" style="height:${totalH}px"></div>
                <div class="asc-bar-wins" style="height:${winsH}px"></div>
                <div class="asc-bar-tooltip">
                  <strong>${wrPct}%</strong> · ${b.wins}w / ${b.runs}r
                </div>
              </div>
              <span class="asc-bar-label">${esc(b.key)}</span>
            </div>`;
        }).join("")}
      </div>
    </div>`;

  // Blitz (STS2 beta) is its own ladder: no tiers, and no modifiers this
  // app can describe, so the chart stands alone with a note.
  if (isBlitz) {
    return `
    ${filtersHtml}
    ${secTitle("Blitz ladder", "bars")}
    ${barChart}
    <p class="muted small stat-filters-note">Blitz has its own ascension levels, shared by every character, so these runs never count toward your standard climb. SpireVault does not describe Blitz modifiers yet; the in-game level select lists them.</p>`;
  }

  // Tier legend — condenses the 10+ ascension levels into five honest
  // difficulty bands. Kept above the detailed breakdown so the reader
  // knows what "A4" means before they see their 5.6% winrate at A4.
  const tierLegend = `
    <div class="asc-tier-legend" aria-label="Ascension tiers">
      ${AscInfo.ASCENSION_TIERS.filter((t) => t.band[0] <= STS2_ASC_CAP).map((t) => {
        const range = t.band[0] === t.band[1] ? `A${t.band[0]}` : `A${t.band[0]}–A${t.band[1]}`;
        return `
          <div class="asc-tier-pill" style="--tier-accent:${t.accent}">
            <span class="asc-tier-label">${esc(t.label)}</span>
            <span class="asc-tier-range">${esc(range)}</span>
          </div>`;
      }).join("")}
    </div>`;

  // Detailed breakdown. Each row shows the level number, in-game modifier
  // (with Early-Access caveat), their personal bar + stats, plus a chevron
  // that animates open to reveal the tier blurb. The expand-on-click keeps
  // the page dense by default for power users but learnable for newcomers.
  const detailRows = `
    <div class="asc-detail-panel">
      ${buckets.map((b, i) => {
        const wr = (b.winrate * 100).toFixed(1);
        const tint = ASC_BAR_TINT[winrateTone({ ...b, lb: winRateLowerBound(b.wins, b.runs) }, report.overallWinrate)];
        const ascLevel = parseAsc(b.key);
        const info = AscInfo.modifierFor(ascLevel);
        const modBadge = info.modifier
          ? `<span class="asc-mod-badge" title="${esc(info.modifier)}">${esc(info.modifier)}</span>`
          : `<span class="asc-mod-badge asc-mod-badge-plain">${esc(info.tier.label)}</span>`;
        const divider = i === buckets.length - 1 ? "" : " has-divider";
        // The level is drawn in plain ink now (its tier colour clashed with the
        // win-rate key), so the tier is named on hover instead.
        const band = info.tier.band;
        const tierTip = band ? `${info.tier.label} (${band[0] === band[1] ? `A${band[0]}` : `A${band[0]}–A${band[1]}`})` : info.tier.label;
        return `
          <details class="asc-detail-row${divider}" data-asc="${esc(String(ascLevel))}">
            <summary class="asc-detail-summary">
              <span class="asc-detail-key" style="--tier-accent:${info.tier.accent}" title="${esc(tierTip)}">${esc(b.key)}</span>
              ${modBadge}
              <div class="asc-detail-bar"><span style="width:${Math.min(100, b.winrate*100)}%; background:${tint}"></span></div>
              <span class="asc-detail-pct">${wr}%</span>
              <span class="asc-detail-record">${b.wins}w / ${b.runs}r</span>
              <span class="asc-detail-chevron" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </span>
            </summary>
            <div class="asc-detail-body">
              <div class="asc-detail-title">${esc(info.title)}</div>
              <p class="asc-detail-text">${esc(info.detail)}</p>
              <p class="asc-detail-note">
                Slay the Spire 2 is in Early Access — modifiers can shift between patches. Confirm live details on the in-game level-select screen.
              </p>
            </div>
          </details>`;
      }).join("")}
    </div>`;

  // Only surface the "newer levels detected" hint if the user actually
  // has runs above the EA cap — keeps the UI quiet for the 99% case
  // where this never fires, but transparent if Mega Crit ever extends
  // the ladder and the user's saves are ahead of our hardcoded cap.
  const newLevelsHint = hiddenAbove > 0
    ? `<p class="muted small" style="margin: -6px 0 14px;">
         <strong>${hiddenAbove}</strong> additional level${hiddenAbove === 1 ? "" : "s"} detected above the Early Access cap of A${STS2_ASC_CAP}. Hidden until we update this view.
       </p>`
    : "";

  return `
    ${filtersHtml}
    ${secTitle("Per ascension", "bars")}
    ${newLevelsHint}
    ${barChart}
    ${secTitle("Difficulty tiers", "sparkles")}
    ${tierLegend}
    ${secTitle("Detailed breakdown", "list")}
    ${classicToneKeyHtml(report.overallWinrate)}
    ${detailRows}`;
}

/** Highest ascension the new-look spire draws (same Early Access cap as
 *  renderAscensionsTab: levels above it are counted, not drawn). */
const NEXT_ASC_CAP = 10;

/** Blitz levels the new-look spire always draws: the patch notes give Blitz
 *  five levels of its own. A higher level in someone's saves adds storeys. */
const NEXT_BLITZ_TOP = 5;

/** One spire storey's numbers. @param {{ runs: number, wins: number }|undefined} bucket */
function storeyStats(bucket) {
  const runs = bucket ? bucket.runs : 0;
  const wins = bucket ? bucket.wins : 0;
  return { runs, wins, winratePct: runs > 0 ? (wins / runs) * 100 : 0 };
}

/** New look: every level A0 → top (played or not) for the chosen climber
 *  and ladder, plus each tier's combined record (standard ladder only). */
function buildAscensionsModel() {
  const { filter, runs } = spireSection();
  const isBlitz = filter.ladder === "blitz";
  const buckets = Filters.ascensionBuckets(runs, filter.ladder);
  const byLevel = new Map(buckets.map((b) => [b.level, b]));
  const top = isBlitz ? Math.max(NEXT_BLITZ_TOP, ...buckets.map((b) => b.level)) : NEXT_ASC_CAP;
  const levels = Array.from({ length: top + 1 }, (_, level) => {
    const stats = storeyStats(byLevel.get(level));
    if (isBlitz) {
      return { level, tierKey: "blitz", tierLabel: "Blitz", ...stats, title: `Blitz A${level}`, modifier: null, detail: "" };
    }
    const info = AscInfo.modifierFor(level);
    return {
      level,
      tierKey: info.tier.key,
      tierLabel: info.tier.label,
      ...stats,
      title: info.title,
      modifier: info.modifier,
      detail: info.detail,
    };
  });
  const tiers = isBlitz ? [] : AscInfo.ASCENSION_TIERS.filter((t) => t.band[0] <= NEXT_ASC_CAP).map((t) => {
    const inBand = levels.filter((l) => l.level >= t.band[0] && l.level <= t.band[1]);
    return {
      key: t.key,
      label: t.label,
      range: t.band[0] === t.band[1] ? `A${t.band[0]}` : `A${t.band[0]}–A${t.band[1]}`,
      blurb: t.blurb,
      runs: inBand.reduce((sum, l) => sum + l.runs, 0),
      wins: inBand.reduce((sum, l) => sum + l.wins, 0),
    };
  });
  const played = levels.filter((l) => l.runs > 0);
  const options = spireFilterOptions(filter);
  return {
    levels,
    tiers,
    cap: NEXT_ASC_CAP,
    hiddenAbove: isBlitz ? 0 : buckets.filter((b) => b.level > NEXT_ASC_CAP).length,
    peak: played.length > 0 ? played[played.length - 1].level : null,
    ladder: filter.ladder,
    climber: filter.character === "all" ? "" : prettifyCharacterName(filter.character),
    record: {
      runs: buckets.reduce((sum, b) => sum + b.runs, 0),
      wins: buckets.reduce((sum, b) => sum + b.wins, 0),
    },
    filter: {
      climbers: options.climbers,
      ladders: options.ladders,
      label: spireFilterLabel(filter),
      shownRuns: runs.length,
      totalRuns: filter.character === "all" ? null : Filters.filterRuns(parsedRuns, { mode: filter.ladder }).length,
    },
  };
}

function renderAscensionsTabNext() {
  return UI.AscensionsView.ascensionsHtml(buildAscensionsModel());
}

/** Spire storeys open their row in the breakdown and bring it into view. */
function wireAscensionSpire($body) {
  $body.querySelectorAll("[data-asc-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = $body.querySelector(`details[data-asc="${CSS.escape(btn.dataset.ascJump || "")}"]`);
      if (!row) return;
      row.open = true;
      row.classList.remove("is-flash");
      void row.offsetWidth;
      row.classList.add("is-flash");
      row.scrollIntoView({ behavior: UI.Motion.reduced() ? "auto" : "smooth", block: "center" });
      row.querySelector("summary")?.focus({ preventScroll: true });
    });
  });
}

// ---- Top Relics in the new UI (lib/ui/views-relics.js) ---------------------
// Same buckets, filter, ranking and Wilson tone as the classic tab below;
// only the markup differs. Fewer than NEXT_LOW_SAMPLE_RUNS runs is flagged,
// matching the classic "small sample" pill.
const NEXT_RELIC_MIN_RUNS = 3;
const NEXT_LOW_SAMPLE_RUNS = 10;

function renderRelicsNext(report) {
  const relics = report.byRelic
    .filter((b) => b.runs >= NEXT_RELIC_MIN_RUNS)
    .map((b) => ({
      key: b.key,
      label: relicLabel(b.key),
      src: relicImageSrc(b.key),
      runs: b.runs,
      wins: b.wins,
      winratePct: b.winrate * 100,
      tone: winrateTone(b, report.overallWinrate),
      rarity: RelicInfo.relicInfoFor(b.key)?.rarity || null,
    }));
  return UI.RelicsView.relicsTabHtml({
    relics,
    minRuns: NEXT_RELIC_MIN_RUNS,
    lowSampleRuns: NEXT_LOW_SAMPLE_RUNS,
    baselinePct: report.overallWinrate * 100,
  });
}

/** @param {string} relicKey @param {object|null} bucket @param {number} baseline overall win rate, 0..1 */
function renderRelicDetailNext(relicKey, bucket, baseline) {
  const info = RelicInfo.relicInfoFor(relicKey);
  return UI.RelicsView.relicDetailHtml({
    key: relicKey,
    label: relicLabel(relicKey),
    src: relicImageSrc(relicKey),
    rarity: info?.rarity || null,
    info: info ? { effect: info.effect, tip: info.tip, synergy: info.synergy || [] } : null,
    record: bucket
      ? { runs: bucket.runs, wins: bucket.wins, winratePct: bucket.winrate * 100, tone: winrateTone(bucket, baseline) }
      : null,
    lowSampleRuns: NEXT_LOW_SAMPLE_RUNS,
  });
}

/** Top Relics — 2-column card grid matching the desktop app's RelicCard.
 *  Gold sparkle in a circle, name, "X seen" + "Yw" pills, big colored % on
 *  the right. Suppresses one-run flukes by filtering to runs >= 3. */
function renderRelicsTab(report) {
  const buckets = report.byRelic.filter((b) => b.runs >= 3);
  if (!buckets.length) {
    return `
      ${secTitle("Top relics by win rate", "sparkles", "gold")}
      <p class="muted">Not enough data yet — pick a relic at least 3 times to see a win rate here.</p>`;
  }
  // The order is the Wilson lower bound (stats-engine.js relicBuckets): the
  // tab subtitle says "weighted by runs" (81.8% above 83.3% is on purpose),
  // so the note says why instead of saying it again (same as the new look).
  return `
    ${secTitle("Top relics by win rate", "sparkles", "gold")}
    <p class="muted small" style="margin: -6px 0 14px;">
      A relic you've had in only a few runs counts for less, so one lucky run can't top the list.
      It needs 3+ runs to show. <strong>Tap any relic for&nbsp;details.</strong>
    </p>
    ${classicToneKeyHtml(report.overallWinrate, { belowTone: "muted" })}
    ${renderRelicCards(buckets, { expandable: true, baseline: report.overallWinrate })}
    <div id="relic-detail-slot" class="relic-detail-slot"></div>`;
}

/** `opts.expandable`: when true, each card opens an inline detail
 *  panel below the grid (Top Relics tab). When false, the cards are
 *  static (Overview tab). */
function renderRelicCards(buckets, opts = {}) {
  if (!buckets || !buckets.length) return `<p class="muted">No relic data yet.</p>`;
  const expandable = !!opts.expandable;
  const ctaHint = expandable
    ? `<div class="relic-card-cta" aria-hidden="true">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
       </div>`
    : "";
  return `
    <div class="relic-grid">
      ${buckets.map((b) => {
        const wr = (b.winrate * 100).toFixed(1);
        const tone = winrateTone(b, opts.baseline);
        const isLowSample = b.runs < 10;
        const art = relicImageSrc(b.key);
        const icon = art
          ? `<div class="relic-card-icon relic-card-icon-art"><img src="${art}" alt="${esc(relicLabel(b.key))}" loading="lazy" decoding="async" /></div>`
          : `<div class="relic-card-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l1.5 5L18.5 8 14 11l1.5 5L12 13l-3.5 3L10 11 5.5 8l5-1.5z"/></svg></div>`;
        const seenPill = isLowSample
          ? `<span class="pill pill-muted pill-small-sample" title="Small sample — winrate is uncertain at this run count">${b.runs} seen</span>`
          : `<span class="pill pill-muted">${b.runs} seen</span>`;
        const dataAttrs = expandable
          ? `role="button" tabindex="0" data-action="relic-expand" data-relic-key="${esc(b.key)}"`
          : "";
        const cardClass = expandable ? "relic-card is-clickable" : "relic-card";
        return `
          <div class="${cardClass}" ${dataAttrs} aria-label="${esc(relicLabel(b.key))}: ${wr}% winrate over ${b.runs} runs.${expandable ? " Tap for details." : ""}">
            ${icon}
            <div class="relic-card-meta">
              <div class="relic-card-name">${esc(relicLabel(b.key))}</div>
              <div class="relic-card-pills">
                ${seenPill}
                <span class="pill pill-win">${b.wins}w</span>
              </div>
            </div>
            <div class="relic-card-pct relic-card-pct-${tone}">
              <strong>${wr}%</strong>
              <span>WINRATE</span>
            </div>
            ${ctaHint}
          </div>`;
      }).join("")}
    </div>`;
}

/** Inline relic drill-down panel. Same UX pattern as the character
 *  drill-down on the Characters tab. Pulls hand-written copy from
 *  RelicInfo for the in-game effect + when-to-pick advice; pulls
 *  the user's personal numbers from the bucket. */
function renderRelicDetail(relicKey, bucket, baseline) {
  if (UI) return renderRelicDetailNext(relicKey, bucket, baseline);
  const info = RelicInfo.relicInfoFor(relicKey);
  const art = relicImageSrc(relicKey);
  const wr = bucket ? (bucket.winrate * 100).toFixed(1) : "—";
  const tone = bucket ? winrateTone(bucket, baseline) : "accent";
  const lossCount = bucket ? bucket.runs - bucket.wins : 0;
  const tier = info?.rarity || "unknown";
  const tierColor = RelicInfo.RARITY_COLORS[tier] || "#8a7cb8";

  const personal = bucket
    ? `<div class="relic-detail-stats">
         <div class="relic-detail-stat">
           <span class="relic-detail-stat-label">Picked</span>
           <strong class="relic-detail-stat-value">${bucket.runs}</strong>
           <span class="relic-detail-stat-sub">runs</span>
         </div>
         <div class="relic-detail-stat">
           <span class="relic-detail-stat-label">Wins</span>
           <strong class="relic-detail-stat-value" style="color:var(--win)">${bucket.wins}</strong>
         </div>
         <div class="relic-detail-stat">
           <span class="relic-detail-stat-label">Losses</span>
           <strong class="relic-detail-stat-value" style="color:var(--loss)">${lossCount}</strong>
         </div>
         <div class="relic-detail-stat">
           <span class="relic-detail-stat-label">Win rate</span>
           <strong class="relic-detail-stat-value relic-detail-stat-value-${tone}">${wr}%</strong>
         </div>
       </div>`
    : `<p class="muted small">You haven't picked this relic yet.</p>`;

  if (!info) {
    // No hand-written copy — show user's personal stats only and
    // honestly tell them we don't ship description copy for this
    // relic. Better than fabricating an in-game effect.
    return `
      <div class="relic-detail" data-relic-detail="${esc(relicKey)}">
        <div class="relic-detail-head">
          ${art ? `<img class="relic-detail-portrait" src="${art}" alt="${esc(relicLabel(relicKey))}">` : `<div class="relic-detail-portrait" aria-hidden="true">⚡</div>`}
          <div class="relic-detail-titles">
            <h3 class="relic-detail-name">${esc(relicLabel(relicKey))}</h3>
            <p class="relic-detail-tagline muted small">In-game effect copy not yet on file. Personal stats below.</p>
          </div>
          <button class="relic-detail-close" type="button" data-action="relic-collapse" aria-label="Close detail">&times;</button>
        </div>
        ${personal}
      </div>`;
  }

  const synergyChips = info.synergy
    .map((s) => `<span class="relic-detail-chip" style="--chip-color:${tierColor}">${esc(s)}</span>`)
    .join("");

  return `
    <div class="relic-detail" data-relic-detail="${esc(relicKey)}" style="--relic-tier-color:${tierColor}">
      <div class="relic-detail-head">
        ${art
          ? `<img class="relic-detail-portrait" src="${art}" alt="${esc(relicLabel(relicKey))}">`
          : `<div class="relic-detail-portrait" aria-hidden="true">⚡</div>`}
        <div class="relic-detail-titles">
          <h3 class="relic-detail-name">${esc(relicLabel(relicKey))}</h3>
          <div class="relic-detail-meta">
            <span class="relic-detail-rarity" style="color:${tierColor}; border-color:${tierColor}">${esc(tier)}</span>
          </div>
        </div>
        <button class="relic-detail-close" type="button" data-action="relic-collapse" aria-label="Close detail">&times;</button>
      </div>

      <div class="relic-detail-section">
        <h4 class="relic-detail-section-title">In-game effect</h4>
        <p class="relic-detail-effect">${esc(info.effect)}</p>
      </div>

      <div class="relic-detail-section">
        <h4 class="relic-detail-section-title">When to pick</h4>
        <p class="relic-detail-tip">${esc(info.tip)}</p>
      </div>

      <div class="relic-detail-section">
        <h4 class="relic-detail-section-title">Pairs with</h4>
        <div class="relic-detail-chips">${synergyChips}</div>
      </div>

      <div class="relic-detail-section">
        <h4 class="relic-detail-section-title">Your record with this relic</h4>
        ${personal}
      </div>
    </div>`;
}

/** Fallback baseline when a caller has no overall win rate: a coin flip. */
const TONE_FALLBACK_BASELINE = 0.5;

/** Colour a relic's or card's win rate by what it says against the player's
 *  own overall win rate (`baseline`, 0..1), so the legend can say it in
 *  words (lib/ui/tone-legend.js):
 *  - "win"    the Wilson lower bound (95%) beats the baseline: proven above
 *             your average, not a lucky streak
 *  - "gold"   the win rate beats the baseline, but not by enough runs to prove it
 *  - "accent" at or below the baseline
 *  It used to be fixed cut-offs (lb ≥ 0.5 / ≥ 0.15), which painted a 47%
 *  card gold under an "Above baseline" legend for a 48% player.
 *  Falls back to raw winrate when an old engine output is missing `lb`. */
function winrateTone(b, baseline) {
  const base = Number.isFinite(baseline) ? baseline : TONE_FALLBACK_BASELINE;
  const rate = b?.winrate ?? 0;
  const lb = typeof b?.lb === "number" ? b.lb : rate;
  if (lb > base) return "win";
  if (rate > base) return "gold";
  return "accent";
}

/** What each winrateTone() colour means: the new look's words
 *  (lib/ui/tone-legend.js TONE_LABELS), copied because classic does not
 *  load lib/ui/. */
const CLASSIC_TONE_LABELS = Object.freeze({
  win: "Proven above your average",
  gold: "Above your average",
  accent: "At or below your average",
});

/**
 * Classic's quiet key for the winrateTone() colours, set above the list
 * they colour. Its swatches take that list's colours (styles.css .tone-key).
 * @param {number} baseline  the player's overall win rate, 0..1
 * @param {{ belowTone?: "accent" | "muted" }} [opts]  "muted" where "at or
 *   below" is drawn grey (relic cards) rather than orange (card rows, bars)
 * @returns {string}
 */
function classicToneKeyHtml(baseline, opts = {}) {
  const base = Number.isFinite(baseline)
    ? `<li class="tone-key-base">Your average: <b>${(baseline * 100).toFixed(1)}%</b></li>`
    : "";
  const below = opts.belowTone === "muted" ? " is-below-muted" : "";
  // The wrapper is the container the key's layout reads (styles.css): one
  // line where all four fit, else two by two, so no chip sits alone.
  return `
    <div class="tone-key-wrap">
      <ul class="tone-key${below}${base ? " has-base" : ""}" aria-label="How to read the colors">
        ${base}
        ${["win", "gold", "accent"].map((tone) => `<li data-tone="${tone}"><i aria-hidden="true"></i>${CLASSIC_TONE_LABELS[tone]}</li>`).join("")}
      </ul>
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

// ---- Cards in the new UI (lib/ui/views-cards.js) ---------------------------
// Same top-picked / top-skipped buckets as the classic tab below.

/** The card's class (ironclad … necrobinder, colorless, curse, status) from
 *  its resolved art filename, else from the id itself; null when unknown. */
function cardClassKey(id, src) {
  const file = src ? src.slice(src.lastIndexOf("/") + 1) : "";
  const fromArt = file.split("_")[0];
  if (CLASS_PREFIXES.has(fromArt)) return fromArt;
  return cardSlug(id).split("_").find((part) => CLASS_PREFIXES.has(part)) || null;
}

/** Pick rate needs to know what was offered. Demo runs and older imports
 *  record only the pick, and the engine then reports every pick rate as
 *  100%, so the view falls back to comparing pick counts. */
function historyHasCardOffers(runs) {
  return runs.some((r) => (r.cardPicks || []).some((p) => Array.isArray(p.offered) && p.offered.length > 0));
}

/** New look: the double-size face for a card image URL, where the new look
 *  shows a card large (lib/ui/card-art-hd.js). The URL itself when there is
 *  no large face, or outside the new look. */
function largeCardImageSrc(src) {
  return UI && UI.CardArt ? UI.CardArt.hdCardSrc(src) : src;
}

function renderCardsNext(report) {
  const hasOffers = historyHasCardOffers(parsedRuns);
  const identity = (b) => {
    const src = cardImageSrc(b.key);
    return { key: b.key, label: cardLabel(b.key), src, srcLarge: largeCardImageSrc(src), classKey: cardClassKey(b.key, src) };
  };
  const picked = (report.topPickedCards || []).map((b) => ({
    ...identity(b),
    picks: b.runs,
    wins: b.wins,
    winratePct: b.winrate * 100,
    pickRatePct: hasOffers ? Math.min(1, b.pickedRate ?? 0) * 100 : null,
    tone: winrateTone(b, report.overallWinrate),
  }));
  const skipped = (report.topSkippedCards || []).map((b) => ({
    ...identity(b),
    offered: b.runs,
    picks: b.wins,
    pickRatePct: (b.pickedRate ?? 0) * 100,
  }));
  return UI.CardsView.cardsTabHtml({
    picked,
    skipped,
    hasOffers,
    lowSampleRuns: NEXT_LOW_SAMPLE_RUNS,
    baselinePct: report.overallWinrate * 100,
    emptyNote: cardPicksMissingNote(),
  });
}

/** Cards tab — mirrors VaultApp/App/DetailView.swift CardsView.
 *  Two icon-row panels: "Most-picked cards" (orange filled-square icon)
 *  and "Most-skipped cards" (red X icon, with explanatory subtitle).
 *  No tables, no progress bars — just the list rows the desktop uses. */
function renderCards(report) {
  // Each row tries to render the actual card art from the asset library;
  // when the slug doesn't exist (e.g. obscure colorless or content we
  // didn't scrape), we fall back to a stylized SVG placeholder so the
  // row still reads cleanly and the column alignment doesn't shift.
  const cardThumb = (id, kind) => {
    const src = cardImageSrc(id);
    if (src) {
      return `<div class="card-row-art card-row-art-${kind}"><img src="${src}" alt="${esc(cardLabel(id))}" loading="lazy" decoding="async" /></div>`;
    }
    const fallback = kind === "skipped"
      ? `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M5 6l6 6M11 6l-6 6" stroke="rgba(0,0,0,0.6)" stroke-width="1.5" stroke-linecap="round"/></svg>`
      : `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="2" width="10" height="12" rx="1.5"/></svg>`;
    return `<div class="card-row-icon card-row-icon-${kind}">${fallback}</div>`;
  };

  const pickedSection = report.topPickedCards?.length
    ? `
      ${secTitle("Most-picked cards", "cards")}
      ${classicToneKeyHtml(report.overallWinrate)}
      <div class="card-list-panel">
        ${report.topPickedCards.map((b) => {
          const wr = (b.winrate * 100).toFixed(1);
          const wrCls = winrateTone(b, report.overallWinrate);
          return `
            <div class="card-row card-row-picked">
              ${cardThumb(b.key, "picked")}
              <span class="card-row-name">${esc(cardLabel(b.key))}</span>
              <span class="card-row-count">${b.runs}x</span>
              <span class="card-row-pct card-row-pct-${wrCls}">${wr}%</span>
            </div>`;
        }).join("")}
      </div>`
    : `
      ${secTitle("Most-picked cards", "cards")}
      <p class="muted">${esc(cardPicksMissingNote() || "No card-pick data in your history yet.")}</p>`;

  const skippedSection = report.topSkippedCards?.length
    ? `
      ${secTitle("Most-skipped cards", "cards", "loss")}
      <p class="muted small" style="margin: -6px 0 14px;">Offered often, picked rarely.</p>
      <div class="card-list-panel">
        ${report.topSkippedCards.map((b) => {
          const pr = ((b.pickedRate ?? 0) * 100).toFixed(1);
          return `
            <div class="card-row card-row-skipped">
              ${cardThumb(b.key, "skipped")}
              <span class="card-row-name">${esc(cardLabel(b.key))}</span>
              <span class="card-row-mono card-row-offered">${b.runs} offered</span>
              <span class="card-row-mono card-row-picked-count">${b.wins} picked</span>
              <span class="card-row-pct card-row-pct-loss">${pr}%</span>
            </div>`;
        }).join("")}
      </div>`
    : "";

  return `${pickedSection}${skippedSection}`;
}

/** Recent Runs — mirrors VaultApp/App/DetailView.swift RunRow.
 *  Each row: 4px character-color stripe, themed character icon in a
 *  rounded square, character name + ascension pill + floor pill, date
 *  underneath, then duration / outcome badge on the right. Hover changes
 *  the border color to the character's color. */
/**
 * Recent Runs filter state. Lives in module scope (re-rendered on
 * every state mutation) so flipping a chip doesn't blow away the
 * surrounding content. Persisted to localStorage so the user's
 * filters survive a refresh — power users tend to settle on
 * "show me only my A10 wins" or similar.
 */
const STORAGE_RUN_FILTERS = "vault.web.runfilters.v1";
/** Ascension chips saved before they matched the Ascensions tab's tiers
 *  (they were A1–A4 "low", A5–A8 "mid", A9–A10 "high"). A saved one maps to
 *  the tier closest to what it asked for, so nobody's filter is dropped;
 *  "mid" keeps its id (now A4–A6, the Ascensions tab's mid climb). */
const LEGACY_RUN_TIER_IDS = Object.freeze({ low: "early", high: "master" });
const EMPTY_RUN_FILTERS = Object.freeze({ character: "all", outcome: "all", ascensionTier: "all", mode: "all", search: "" });
let runFilters = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_RUN_FILTERS);
    if (raw) {
      const j = JSON.parse(raw);
      return {
        character: j.character || "all",      // all | ironclad | silent | ...
        outcome: j.outcome || "all",          // all | wins | losses
        // all | a0 | early | mid | expert | master (RUN_FILTER_TIERS)
        ascensionTier: LEGACY_RUN_TIER_IDS[j.ascensionTier] || j.ascensionTier || "all",
        // all | standard | blitz | dread (STS2 beta modes; Filters.MODE_IDS)
        mode: Filters.MODE_IDS.includes(j.mode) ? j.mode : "all",
        search: j.search || "",
      };
    }
  } catch {}
  return { ...EMPTY_RUN_FILTERS };
})();

function persistRunFilters() {
  try { localStorage.setItem(STORAGE_RUN_FILTERS, JSON.stringify(runFilters)); } catch {}
}

// =========================================================================
// Compare-runs mode
//
// User flow:
//   1. Click "Compare" in the Recent Runs filter bar (or press `c` while
//      the Recent Runs tab is active) → compareMode flips on.
//   2. Each run row sprouts a checkbox; clicking the row now toggles
//      selection rather than opening the run-detail modal.
//   3. A sticky bottom bar appears reading "N runs selected · Compare"
//      with the action button enabled when 2 ≤ N ≤ 3.
//   4. Click Compare → side-by-side modal with stats + relic / card
//      overlap highlighted.
//
// Cap is 3 because beyond 3 columns the modal feels cramped on
// laptop widths and the overlap math (2-of-3 vs 3-of-3) starts
// drifting into "complicated infographic" territory which is the
// exact opposite of the platform's golden-rule UX.
//
// Selection state is kept in-memory only — leaving the Recent Runs
// tab clears it because mid-flow comparison rarely survives a tab
// switch and persisting to localStorage just creates dangling
// references when the run list refreshes.
// =========================================================================
const COMPARE_MAX = 3;
let compareMode = false;
let compareSelected = new Set(); // run ids

function setCompareMode(on) {
  compareMode = !!on;
  if (!compareMode) compareSelected.clear();
  document.body.classList.toggle("compare-mode", compareMode);
  // Re-render the Recent Runs panel so each row picks up its
  // checkbox / no-checkbox state. We also refresh the bottom bar
  // here so dismissing compare mode hides it cleanly.
  try { renderStatsTab("runs"); } catch {}
  refreshCompareBar();
  vaultGtagEvent("compare_mode_toggle", { value: compareMode ? 1 : 0 });
}

function toggleCompareSelection(runId) {
  if (!compareMode) return;
  const id = String(runId);
  if (compareSelected.has(id)) {
    compareSelected.delete(id);
  } else if (compareSelected.size < COMPARE_MAX) {
    compareSelected.add(id);
  } else {
    // Soft cap — flash the bar so the user sees why nothing happened.
    const $bar = document.getElementById("compare-bar");
    if ($bar) {
      $bar.classList.remove("is-shake");
      // Force reflow so the animation re-triggers on a second click.
      void $bar.offsetWidth;
      $bar.classList.add("is-shake");
    }
    return;
  }
  // Toggle the row's visual state without re-rendering the whole list.
  const $row = document.querySelector(`.run-row[data-run-id="${cssEscape(id)}"]`);
  if ($row) $row.classList.toggle("is-compare-selected", compareSelected.has(id));
  refreshCompareBar();
}

function cssEscape(s) {
  // Tiny CSS.escape polyfill scoped to the characters we know we'll
  // emit in run ids ("sts2-<epoch>" or "sts2-<seed>-<rand>"). Lets
  // querySelector keep working on Safari/Firefox where some legacy
  // engines still don't ship CSS.escape.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function refreshCompareBar() {
  const $bar = document.getElementById("compare-bar");
  if (!$bar) return;
  const $count = document.getElementById("compare-bar-count");
  const $go = document.getElementById("compare-bar-go");
  const n = compareSelected.size;
  $bar.hidden = !compareMode;
  if ($count) $count.textContent = n === 1 ? "1 run selected" : `${n} runs selected`;
  if ($go) {
    $go.disabled = n < 2;
    $go.textContent = n >= 2 ? `Compare ${n}` : "Compare";
  }
}

// STS2 ascension ceiling. Slay the Spire 2 caps ascension at A10 (vs
// STS1's A20), so the Recent Runs filter buckets and bucket-membership
// logic both treat A10 as the maximum.
const STS2_MAX_ASCENSION = 10;

/** The Runs tab's game mode as it applies to these runs ("all" when the
 *  saved one has no runs, or the Mode chips are not on screen). */
function runModeNow(runs) {
  return Filters.availableMode(runFilters.mode, runs);
}

/** Ascension tiers are standard-ladder bands: they apply under All and
 *  Standard, and are switched off under Blitz and Dread. */
function runTiersApply(mode) {
  return Filters.ladderOf(mode) === "standard";
}

/** Whether any Runs filter narrows the list. */
function runFiltersActive(runs) {
  const mode = runModeNow(runs);
  return runFilters.character !== "all" || runFilters.outcome !== "all"
    || (runFilters.ascensionTier !== "all" && runTiersApply(mode))
    || mode !== "all" || (runFilters.search || "").trim() !== "";
}

/**
 * @param {Array<object>} runs
 * @param {{ ignoreDate?: boolean }} [options]  ignoreDate: every filter but the
 *   date (the mini calendar's dots and counts)
 */
function applyRunFilters(runs, { ignoreDate = false } = {}) {
  const q = (runFilters.search || "").toLowerCase().trim();
  const mode = runModeNow(runs);
  const dateRange = ignoreDate ? null : activeRunsDate();
  const today = dateRange ? RunDates.dayKey(new Date()) : "";
  return runs.filter((r) => {
    if (dateRange && !RunDates.inRange(runDayKey(r, today), dateRange)) return false;
    if (runFilters.character !== "all" && r.character !== runFilters.character) return false;
    if (runFilters.outcome === "wins" && !r.won) return false;
    if (runFilters.outcome === "losses" && r.won) return false;
    if (mode !== "all" && Filters.runMode(r) !== mode) return false;
    if (runFilters.ascensionTier !== "all" && runTiersApply(mode)) {
      // Blitz/Dread ascensions are not standard-ladder levels (STS2 beta).
      if (!isLadderRun(r)) return false;
      // Clamp legacy / out-of-range ascensions into the STS2 ladder so
      // a stray A20 save from a STS1-leftover importer still buckets
      // cleanly into the top tier instead of vanishing from results.
      const raw = Number.isFinite(r.ascension) ? r.ascension : -1;
      const a = raw < 0 ? -1 : Math.min(STS2_MAX_ASCENSION, raw);
      const tier = RUN_FILTER_TIERS.find((t) => t.id === runFilters.ascensionTier);
      if (tier?.band && !(a >= tier.band[0] && a <= tier.band[1])) return false;
    }
    if (q) {
      const hay = [r.character, Stats.offLadderMode(r.gameMode), r.seed, r.sourceFile, r.won ? "victory win" : "defeat loss"]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// One chip per climber; those without runs render disabled.
const RUN_FILTER_CHARACTERS = ["ironclad", "silent", "defect", "regent", "necrobinder", "fool"];
// Ascension chips: the same tiers as the Ascensions tab (lib/ascension-info.js
// ASCENSION_TIERS: A0 · A1–A3 · A4–A6 · A7–A9 · A10), so "mid climb" is the
// same runs on both tabs. The tier name rides along as the chip's tooltip.
// A11+ is impossible in STS2; the clamp in applyRunFilters folds any rogue
// legacy save into the top tier. Standard keeps the id "a0" so saved filters
// still match.
const RUN_FILTER_TIERS = [
  { id: "all", label: "All Asc" },
  ...AscInfo.ASCENSION_TIERS.map((t) => ({
    id: t.key === "standard" ? "a0" : t.key,
    label: t.band[0] === t.band[1] ? `A${t.band[0]}` : `A${t.band[0]}–A${t.band[1]}`,
    title: t.label,
    band: t.band,
  })),
];
const RUN_FILTER_OUTCOMES = [
  { id: "all",    label: "All" },
  { id: "wins",   label: "Wins" },
  { id: "losses", label: "Losses" },
];

/** Mode chips for the Runs tab (the same choices as By character); empty
 *  when every run is a standard one. */
function runModeOptions(runs) {
  const choices = Filters.modeChoices(runs);
  if (!choices) return [];
  const counts = Filters.modeCounts(runs);
  const mode = runModeNow(runs);
  return choices.map((id) => ({
    value: id,
    label: Filters.MODE_LABELS[id],
    pressed: mode === id,
    title: id === "all" ? `Every run (${runs.length})` : pluralRuns(counts[id], `${Filters.MODE_LABELS[id]} run`),
  }));
}

/** Ascension tier chips; off (All stays) under Blitz and Dread. */
function runTierOptions(mode) {
  const apply = runTiersApply(mode);
  const offTitle = `Ascension tiers are standard-ladder levels; ${Filters.MODE_LABELS[mode]} runs are not on that ladder`;
  return RUN_FILTER_TIERS.map((t) => ({
    ...t,
    pressed: apply ? runFilters.ascensionTier === t.id : t.id === "all",
    disabled: !apply && t.id !== "all",
    title: !apply && t.id !== "all" ? offTitle : t.title,
  }));
}

function renderRunFilters(allRuns, filteredCount) {
  // Every climber gets a chip, so the whole roster (The Fool included) is
  // visible. One you have never played is shown but disabled: a filter that
  // can only return nothing should not be clickable.
  const playedChars = new Set(allRuns.map((r) => r.character).filter(Boolean));
  const charChips = [
    `<button class="chart-chip" type="button" data-filter-kind="character" data-filter-value="all" aria-pressed="${runFilters.character === "all"}">All</button>`,
    ...RUN_FILTER_CHARACTERS.map((c) => {
      const theme = charTheme(c);
      const name = prettifyCharacterName(c);
      const off = playedChars.has(c) ? "" : ` disabled title="No runs as ${esc(name)} yet"`;
      return `<button class="chart-chip" type="button" data-char data-filter-kind="character" data-filter-value="${esc(c)}" aria-pressed="${runFilters.character === c}" style="--char-color:${theme.color}"${off}>${esc(name)}</button>`;
    }),
  ].join("");

  const outcomeChips = RUN_FILTER_OUTCOMES.map((o) => `
    <button class="chart-chip" type="button" data-filter-kind="outcome" data-filter-value="${esc(o.id)}" aria-pressed="${runFilters.outcome === o.id}">${esc(o.label)}</button>
  `).join("");

  const mode = runModeNow(allRuns);
  const modeChips = runModeOptions(allRuns).map((o) => `
    <button class="chart-chip" type="button" data-filter-kind="mode" data-filter-value="${esc(o.value)}" aria-pressed="${o.pressed}" title="${esc(o.title)}">${esc(o.label)}</button>
  `).join("");
  const tierChips = runTierOptions(mode).map((t) => `
    <button class="chart-chip" type="button" data-filter-kind="ascensionTier" data-filter-value="${esc(t.id)}" aria-pressed="${t.pressed}"${t.title ? ` title="${esc(t.title)}"` : ""}${t.disabled ? " disabled" : ""}>${esc(t.label)}</button>
  `).join("");

  const isFiltered = runFiltersActive(allRuns);
  const summary = isFiltered
    ? `Showing <strong>${filteredCount}</strong> of <strong>${allRuns.length}</strong> runs after filters. <button class="run-filter-clear" type="button" data-action="clear-filters">Clear all</button>`
    : `Showing all <strong>${allRuns.length}</strong> runs.`;

  // Compare-mode toggle. We render the button regardless of whether
  // the mode is active so the entry-point is always discoverable;
  // the active state is reflected via aria-pressed and a CSS variant.
  const compareToggle = `
    <button
      class="run-filter-compare"
      type="button"
      data-action="compare-toggle"
      aria-pressed="${compareMode ? "true" : "false"}"
      title="Compare mode (c) — pick 2 or 3 runs and see them side by side">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="7" height="16" rx="1.5"/>
        <rect x="14" y="4" width="7" height="16" rx="1.5"/>
      </svg>
      <span>${compareMode ? "Exit compare" : "Compare"}</span>
    </button>`;

  return `
    <div class="run-filters" role="region" aria-label="Filter runs">
      <div class="run-filter-group">
        <span class="run-filter-label">Outcome</span>
        <span class="run-filter-chips">${outcomeChips}</span>
      </div>
      ${modeChips ? `<div class="run-filter-group">
        <span class="run-filter-label">Mode</span>
        <span class="run-filter-chips">${modeChips}</span>
      </div>` : ""}
      <div class="run-filter-group">
        <span class="run-filter-label">Ascension</span>
        <span class="run-filter-chips">${tierChips}</span>
      </div>
      <div class="run-filter-group">
        <span class="run-filter-label">Character</span>
        <span class="run-filter-chips">${charChips}</span>
      </div>
      <label class="run-filter-search" aria-label="Search runs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" placeholder="Search runs" title="Search by seed, character, win or loss" value="${esc(runFilters.search || "")}" data-filter-kind="search" />
      </label>
      ${compareToggle}
      <p class="run-filter-summary">${summary}</p>
    </div>`;
}

function renderRecentRuns(runs) {
  if (UI) return renderRecentRunsNext(runs);
  const filtered = applyRunFilters(runs);
  const sorted = filtered.slice().sort((a, b) => {
    const at = a.endedAt?.getTime() ?? 0;
    const bt = b.endedAt?.getTime() ?? 0;
    return bt - at;
  });
  const slice = sorted.slice(0, 200);
  const filtersHTML = renderRunFilters(runs, filtered.length);

  if (!slice.length) {
    return `
      ${filtersHTML}
      ${renderAutoRefreshPill()}
      ${secTitle("Recent runs", "clock")}
      <p class="muted">No runs match the current filters. <button class="run-filter-clear" type="button" data-action="clear-filters">Clear filters</button></p>`;
  }
  return `
    ${filtersHTML}
    ${renderAutoRefreshPill()}
    ${secTitle("Recent runs", "clock")}
    <p class="muted small recent-runs-hint">
      <strong>Tap any run</strong> to see your full Act timeline — every combat, elite, shop, and rest you walked through, with the floor where the run ended&nbsp;marked.
    </p>
    <div class="run-list">
      ${slice.map((r) => {
        const theme = charTheme(r.character);
        const charName = r.character ? prettifyCharacterName(r.character) : "Unknown";
        const dateStr = r.endedAt ? formatRunDate(r.endedAt) : (r.startedAt ? formatRunDate(r.startedAt) : "");
        const durStr = formatPlayTimeStrict(r.playTimeSeconds);
        const wonClass = r.won ? "is-victory" : "is-defeat";
        const outcomeText = r.won ? "VICTORY" : "DEFEAT";
        const runId = esc(String(r.id ?? ""));
        const isSelected = compareSelected.has(String(runId));
        return `
          <div class="run-row${isSelected ? " is-compare-selected" : ""}" style="--char-color:${theme.color}" data-run-id="${runId}" tabindex="0" role="${compareMode ? "checkbox" : "button"}" aria-checked="${compareMode ? (isSelected ? "true" : "false") : "false"}" aria-label="${compareMode ? `${isSelected ? "Deselect" : "Select"} run for compare: ` : "Open run details: "}${esc(charName)} ${r.won ? "victory" : "defeat"}${Number.isFinite(r.floorReached) ? ` on floor ${r.floorReached}` : ""}" data-run-preview="${compareMode ? "0" : "1"}">
            ${compareMode ? `
              <div class="run-compare-check" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              </div>` : ""}
            <div class="run-stripe"></div>
            <div class="run-row-body">
              <div class="run-icon">${charPortraitOrIcon(r.character, theme)}</div>
              <div class="run-meta">
                <div class="run-meta-top">
                  <span class="run-name">${esc(charName)}</span>
                  ${runAscPillHtml(r)}
                  ${Number.isFinite(r.floorReached) ? `<span class="pill pill-muted">Floor ${r.floorReached}</span>` : ""}
                </div>
                ${dateStr ? `<span class="run-date">${esc(dateStr)}</span>` : ""}
              </div>
              <div class="run-spacer"></div>
              ${durStr ? `
                <div class="run-duration">
                  <strong>${esc(durStr)}</strong>
                  <span>DURATION</span>
                </div>` : ""}
              <span class="run-outcome ${wonClass}">${outcomeText}</span>
              <button class="run-link-btn" type="button" data-action="copy-row-link" data-run-id="${runId}" title="Copy a direct link to this run" aria-label="Copy link">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 1 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 1 0 7.07 7.07l1.71-1.71"/></svg>
              </button>
              <button class="run-share-btn" type="button" data-action="share-run" data-run-id="${runId}" title="Share this run" aria-label="Share this run">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>
                  <polyline points="16 6 12 2 8 6"/>
                  <line x1="12" y1="2" x2="12" y2="15"/>
                </svg>
                <span>Share</span>
              </button>
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

// ---- Recent Runs, new UI (lib/ui/views-runs.js) ---------------------------
// The new look pages the ledger 20 at a time ("Show more"); classic above
// keeps its single list. The page grows only by the user's click and resets
// when the filters change, so the background refresh never collapses it.
const RUNS_NEXT_PAGE_SIZE = 20;
let runsNextPage = { key: "", limit: RUNS_NEXT_PAGE_SIZE };
let runsNextPagingWired = false;

/** @returns {"win"|"loss"|"abandon"} */
function runResultNext(r) {
  if (r.won === true) return "win";
  return r.wasAbandoned === true ? "abandon" : "loss";
}

/** Character plate art shared by the ledger, run detail and compare. */
function runArtNext(character) {
  const key = String(character || "").toLowerCase();
  const inked = UI && key ? UI.Stage.actorArt(key) : null;
  return {
    charKey: key,
    charName: character ? prettifyCharacterName(character) : "Unknown",
    artSrc: inked ? inked.src : characterImageSrc(key),
    isArtInked: !!inked,
    iconHtml: charIcon(charTheme(key).icon),
  };
}

/** Ledger divider for a run's date: Today, Yesterday, This week, Last week, then the month. */
function runGroupLabelNext(date, now) {
  if (!date) return "Undated";
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 14) return "Last week";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function runsNextFilterKey() {
  const f = runFilters;
  const d = activeRunsDate();
  return [f.character, f.outcome, f.ascensionTier, f.mode, (f.search || "").trim().toLowerCase(), d ? `${d.from}~${d.to}` : ""].join("|");
}

// ---- Recent Runs: "go by date" (new look) ---------------------------------
// The Date chip opens a mini calendar (lib/ui/runs-calendar.js) where a day,
// a range or a quick pick (Today, Last 7 days, This month) narrows the ledger,
// together with the other filters. Not saved with them: it is a place you go,
// and a range kept overnight would hide the next day's runs. Classic has no
// Date control, so the range only applies in the new look.
/** @type {import("/lib/run-dates.js").DayRange|null} */
let runsDateRange = null;
let runsDateWired = false;

/** The range in force: a quick pick is re-read against today, so "Today"
 *  left open past midnight means the new day, as its chip says.
 *  @returns {import("/lib/run-dates.js").DayRange|null} */
function activeRunsDate() {
  if (!UI || !runsDateRange) return null;
  if (!runsDateRange.preset) return runsDateRange;
  return RunDates.presetRange(runsDateRange.preset, RunDates.dayKey(new Date())) || runsDateRange;
}

/** The calendar day a run counts for: the day it ended (or began), never after today. */
function runDayKey(r, today) {
  const key = RunDates.dayKey(r.endedAt || r.startedAt);
  return key && today && key > today ? today : key;
}

/** @param {{ fromKeyboard?: boolean }} [options] */
function openRunsDateCalendar({ fromKeyboard = false } = {}) {
  if (!UI?.RunsCalendar || !Array.isArray(parsedRuns)) return;
  const today = RunDates.dayKey(new Date());
  const base = applyRunFilters(parsedRuns, { ignoreDate: true });
  const keyed = base.map((r) => ({ key: runDayKey(r, today), won: r.won === true }));
  const span = parsedRuns.map((r) => runDayKey(r, today)).filter(Boolean).sort();
  UI.RunsCalendar.openRunsCalendar({
    getAnchor: () => document.querySelector('#runs-body [data-action="runs-date-open"]'),
    range: activeRunsDate(),
    today,
    days: RunDates.countByDay(keyed),
    firstDay: span[0],
    lastDay: span[span.length - 1],
    count: (range) => (range ? keyed.filter((k) => RunDates.inRange(k.key, range)).length : base.length),
    onChange: (range) => {
      runsDateRange = range;
      if (activeTab === "runs") renderStatsTab("runs");
    },
    onClose: (changed) => {
      if (changed && runsDateRange) scrollRunsToFirstDay();
    },
    fromKeyboard,
  });
  vaultGtagEvent("runs_date_open", {});
}

/** After a date is picked, bring its first day of runs into view. */
function scrollRunsToFirstDay() {
  const target = document.querySelector("#runs-body .v-runs-day") || document.querySelector("#runs-body .v-runs-empty");
  if (!(target instanceof HTMLElement)) return;
  // Phones pin the top bar (the rail, sticky); land the day just under it.
  const bar = document.querySelector(".sidebar");
  const barBottom = bar && getComputedStyle(bar).position === "sticky" ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  const top = target.getBoundingClientRect().top;
  if (top >= barBottom && top <= window.innerHeight * 0.6) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches && !document.documentElement.classList.contains("prefer-reduced-motion");
  window.scrollTo({ top: Math.max(0, window.scrollY + top - barBottom - 16), behavior: smooth ? "smooth" : "auto" });
}

function wireRunsDate() {
  if (runsDateWired) return;
  runsDateWired = true;
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action="runs-date-open"], [data-action="runs-date-clear"]') : null;
    if (!btn || !UI) return;
    e.preventDefault();
    if (btn.getAttribute("data-action") === "runs-date-open") {
      // A click from Enter/Space has no pointer (detail 0): land on a day.
      openRunsDateCalendar({ fromKeyboard: e.detail === 0 });
      return;
    }
    runsDateRange = null;
    renderStatsTab("runs");
    const chip = document.querySelector('#runs-body [data-action="runs-date-open"]');
    if (chip instanceof HTMLElement) chip.focus({ preventScroll: true });
  });
}

function wireRunsNextPaging() {
  if (runsNextPagingWired) return;
  runsNextPagingWired = true;
  document.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action="runs-show-more"], [data-action="runs-show-all"]') : null;
    if (!btn || !UI) return;
    e.preventDefault();
    const before = document.querySelectorAll("#runs-body .run-row").length;
    const limit = btn.dataset.action === "runs-show-all" ? Infinity : runsNextPage.limit + RUNS_NEXT_PAGE_SIZE;
    runsNextPage = { key: runsNextPage.key, limit };
    renderStatsTab("runs");
    // The button is gone after the re-render; keyboard focus moves to the
    // first run it revealed.
    const firstNew = document.querySelectorAll("#runs-body .run-row")[before];
    if (firstNew instanceof HTMLElement) firstNew.focus({ preventScroll: true });
  });
}

function renderRecentRunsNext(runs) {
  wireRunsNextPaging();
  wireRunsDate();
  const key = runsNextFilterKey();
  if (runsNextPage.key !== key) runsNextPage = { key, limit: RUNS_NEXT_PAGE_SIZE };
  const sorted = applyRunFilters(runs).slice().sort((a, b) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0));
  const maxFloor = Math.max(1, ...runs.map((r) => (Number.isFinite(r.floorReached) ? r.floorReached : 0)));
  const played = new Set(runs.map((r) => r.character).filter(Boolean));
  const dateRange = activeRunsDate();
  const isFiltered = runFiltersActive(runs) || !!dateRange;
  const now = new Date();
  const today = RunDates.dayKey(now);
  const rows = sorted.slice(0, runsNextPage.limit).map((r) => {
    const id = String(r.id ?? "");
    const date = r.endedAt || r.startedAt;
    const full = date ? formatRunDate(date) : "";
    const day = date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
    const splits = !!day && full.startsWith(day);
    return {
      ...runArtNext(r.character),
      id,
      dateDay: splits ? day : full,
      dateRest: splits ? full.slice(day.length) : "",
      ascension: Number.isFinite(r.ascension) ? r.ascension : null,
      ascLabel: runAscText(r),
      floor: Number.isFinite(r.floorReached) ? r.floorReached : null,
      floorShare: Number.isFinite(r.floorReached) ? Math.min(1, Math.max(0, r.floorReached / maxFloor)) : 0,
      duration: formatPlayTimeStrict(r.playTimeSeconds),
      result: runResultNext(r),
      killedBy: runResultNext(r) === "loss" && r.killedBy ? bossLabel(r.killedBy) : "",
      // With a date picked, each day gets its own divider ("Saturday, Nov 15").
      group: dateRange ? RunDates.dayGroupLabel(runDayKey(r, today), today) : runGroupLabelNext(date, now),
      isSelected: compareSelected.has(id),
    };
  });
  return UI.RunsView.runsHtml({
    filters: { ...runFilters, mode: runModeNow(runs), search: runFilters.search || "" },
    outcomes: RUN_FILTER_OUTCOMES,
    modes: runModeOptions(runs),
    tiers: runTierOptions(runModeNow(runs)),
    characters: RUN_FILTER_CHARACTERS.map((c) => ({ key: c, label: prettifyCharacterName(c), disabled: !played.has(c) })),
    date: {
      isSet: !!dateRange,
      label: RunDates.rangeChipLabel(dateRange, today),
      rangeText: dateRange ? RunDates.formatRange(dateRange, today) : "",
    },
    total: runs.length,
    filteredCount: sorted.length,
    isFiltered,
    compareMode,
    rows,
    pageSize: RUNS_NEXT_PAGE_SIZE,
    autoRefreshHtml: renderAutoRefreshPill(),
  });
}

function formatRunDate(d) {
  if (!d) return "";
  // "Apr 29, 2026 at 3:08 AM" — matches Swift .formatted(date: .abbreviated, time: .shortened)
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

function formatPlayTimeStrict(s) {
  if (!Number.isFinite(s) || s <= 0) return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
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
/** A signed-out visitor's connection line. When the runs on screen belong
 *  to an account whose sign-in lapsed, it asks them to sign in again (orange,
 *  the colour of the action) instead of calling them a guest. */
function setGuestStatus() {
  if (HistoryStore.loadedFromFallback()) setStatus("expired", "Sign in to keep syncing");
  else setStatus("offline", "Browsing as guest");
}

/** @returns {string|null} the last account signed in on this device */
function readHistoryOwner() {
  try { return localStorage.getItem(STORAGE_HISTORY_OWNER); } catch { return null; }
}

/**
 * Chrome and Edge ask how long the site may read the save folder: "Allow
 * this time", "Allow on every visit" or "Don't allow". Only "every visit"
 * lets new runs load by themselves on later visits, so say so while the
 * question is on screen. Once per page view, and only when a question is
 * actually coming (callers that already know access lapsed pass no handle).
 * @param {FileSystemHandle | null} [handle]
 */
async function tipAllowEveryVisit(handle = null) {
  if (tipAllowEveryVisit.shown) return;
  // Already granted (just after picking, Chrome usually grants this visit
  // silently): no question is coming, so no tip.
  try {
    if (handle && typeof handle.queryPermission === "function" && (await handle.queryPermission({ mode: "read" })) === "granted") return;
  } catch { /* ask anyway */ }
  tipAllowEveryVisit.shown = true;
  toast("Your browser is asking how long SpireVault can read your saves. Choose \u201CAllow on every visit\u201D so new runs load by themselves.", { duration: 9000 });
}

/** The account card says the session ended instead of "Steam connected". */
function markSessionExpiredOnCard() {
  const $tier = document.getElementById("me-pill-tier");
  if ($tier) $tier.textContent = "Session expired";
}

/**
 * @param {"online"|"live"|"connecting"|"trouble"|"offline"|"expired"} state
 * @param {string} label  the short line under the account card
 * @param {string} [hint] longer explanation, shown as the tooltip
 */
function setStatus(state, label, hint = "") {
  const $dot = document.getElementById("status-dot");
  const $lbl = document.getElementById("status-label");
  if ($dot) $dot.dataset.state = state;
  if ($lbl) { $lbl.textContent = label; $lbl.title = hint; }
  // Mirror to the mobile-only account row so phone users see the same
  // connection status indicator the desktop sidebar shows.
  const $dotM = document.getElementById("status-dot-mobile");
  const $lblM = document.getElementById("status-label-mobile");
  if ($dotM) {
    // On phones the dot is a badge with no words beside it: give it a name.
    $dotM.dataset.state = state;
    $dotM.setAttribute("role", "img");
    $dotM.setAttribute("aria-label", label);
    $dotM.title = hint || label;
  }
  if ($lblM) { $lblM.textContent = label; $lblM.title = hint; }
}

/** Sync the sidebar profile dock (status pill + invite count badge).
 *  Reads the current draft (looking/inRun/inCoop/afk) and the latest
 *  inbox count so the user always sees their live state at the bottom
 *  of the viewport without having to open Co-op tab first. */
// =========================================================================
// Profile dock + click-to-open popover
// -------------------------------------------------------------------------
// The bottom-of-sidebar pill ("c3rooks · Steam connected") is now a real
// control. Clicking it opens a popover anchored above the footer with:
//
//   • Current co-op pair status     (1:1 today; multi-partner ready)
//   • Pending invites + Accept/Decline inline
//   • Sent invites (outbox) + status + Withdraw on pending ones
//   • Quick status dropdown (Looking / In a solo run / In co-op / AFK)
//   • Sign out
//
// Source-of-truth notes:
//   - `lastFeed` carries the verified pair state under `me.paired`.
//     If the server says we're paired, the pill ALWAYS shows "In co-op"
//     regardless of the user's draft choice — drift between the two
//     lies to the user.
//   - `lastInbox` and `lastOutbox` drive the message lists. They poll
//     every POLL_INBOX_MS and refresh the popover in place via
//     `refreshProfilePopoverIfOpen()` so it never goes stale while open.
// =========================================================================

/**
 * Walk `lastFeed` to find our own roster row and pull its `paired`
 * field. Returns null when the server says we're not in an active
 * pair, OR when the feed hasn't loaded yet (first paint). Callers
 * should treat null as "not paired" — we never assume paired without
 * server confirmation.
 */
function getMyPairFromFeed() {
  if (!session?.steamID) return null;
  const me = (lastFeed || []).find((p) => p.steamID === session.steamID);
  if (!me?.paired?.partnerID) return null;
  return {
    partners: [{
      partnerID: me.paired.partnerID,
      partnerPersona: me.paired.partnerPersona || "your partner",
      partnerAvatar: me.paired.partnerAvatar || null,
    }],
    since: me.paired.since || null,
  };
}

function renderProfileDock() {
  const $pillBtn = document.getElementById("me-pill");
  // The unified status row (#me-pill-status-row) is always visible
  // because it carries the connection-status dot + label
  // ("Live on the feed" / "Connecting…") for guests and members
  // alike. Only the inner status pill + invite count toggle with
  // the session — guests don't have a "Looking / In a run / AFK"
  // status to show, and they have no invites.
  const $pill = document.getElementById("me-pill-status-pill");
  const $inv = document.getElementById("me-pill-invites");
  const $dot = document.getElementById("me-pill-dot");
  if (!$pill || !$inv) return;

  if (!session?.steamID) {
    $pill.hidden = true;
    $inv.hidden = true;
    if ($dot) $dot.hidden = true;
    if ($pillBtn) {
      $pillBtn.disabled = true;
      $pillBtn.classList.remove("is-actionable");
    }
    return;
  }

  // The old roster status ("Looking", "In a Run", "Away") is no longer
  // shown: nothing reads it since co-op became one-tap Play, and a chip
  // saying "Looking" while you are not in the Play queue misled people.
  // Waiting in the queue shows as the Play pill instead (lib/coop-play.js).
  $pill.hidden = true;
  if ($pillBtn) {
    $pillBtn.disabled = false;
    $pillBtn.classList.add("is-actionable");
  }

  const pendingCount = (lastInbox || []).filter((i) => i?.status === "pending").length;
  if (pendingCount > 0) {
    $inv.hidden = false;
    $inv.textContent = `${pendingCount} invite${pendingCount === 1 ? "" : "s"}`;
    if ($dot) { $dot.hidden = false; }
  } else {
    $inv.hidden = true;
    $inv.textContent = "0";
    if ($dot) { $dot.hidden = true; }
  }

  // Wire the pill to open the popover on first render. We deliberately
  // bind once and use a delegated toggle so subsequent renders don't
  // pile up listeners.
  if ($pillBtn && !$pillBtn.dataset.popoverWired) {
    $pillBtn.dataset.popoverWired = "1";
    $pillBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleProfilePopover();
    });
  }
  // Invite count badge: no longer jumps to Co-op tab on its own —
  // it just opens the popover where the user can act on every
  // invite inline. Less navigation, fewer surprises.
  if (!$inv.dataset.wired) {
    $inv.dataset.wired = "1";
    $inv.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openProfilePopover();
    });
  }
}

// ---- Popover ----------------------------------------------------------

let profilePopoverEl = null;
let profilePopoverOpen = false;
let profilePopoverDocClickBound = false;

function ensureProfilePopover() {
  if (profilePopoverEl && document.body.contains(profilePopoverEl)) {
    return profilePopoverEl;
  }
  // Portal to <body> rather than nesting inside .sidebar-footer.
  // The footer creates a `z-index: 2` stacking context, which
  // would trap the popover's z-index underneath the main panel-
  // head (`position: sticky; z-index: 5`) and any overview cards
  // that overflow the 248px sidebar boundary. Rendering at body
  // level + `position: fixed` lets the global z-index actually
  // matter so nothing in the main content area can paint over it.
  const el = document.createElement("div");
  el.id = "profile-popover";
  el.className = "profile-popover";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Profile and invites");
  el.hidden = true;
  document.body.appendChild(el);
  profilePopoverEl = el;
  attachProfilePopoverSwipeToDismiss(el);
  return el;
}

/**
 * On phones the popover renders as a bottom sheet. The visible drag
 * handle hints that swipe-down dismisses it — this is the matching
 * gesture handler. We only act on touch events ≤720px, skip when the
 * popover is mid-scroll (so internal scroll wins), and snap-back if
 * the user releases under the dismiss threshold.
 */
function attachProfilePopoverSwipeToDismiss(el) {
  let startY = null;
  let lastDelta = 0;

  function onStart(ev) {
    if (window.matchMedia && !window.matchMedia("(max-width: 720px)").matches) return;
    if (el.scrollTop > 4) return;
    const t = ev.touches ? ev.touches[0] : ev;
    if (!t) return;
    startY = t.clientY;
    lastDelta = 0;
    el.setAttribute("data-dragging", "1");
  }
  function onMove(ev) {
    if (startY === null) return;
    const t = ev.touches ? ev.touches[0] : ev;
    if (!t) return;
    const delta = t.clientY - startY;
    if (delta < 0) {
      lastDelta = 0;
      el.style.transform = "translateY(0)";
      return;
    }
    lastDelta = delta;
    el.style.transform = `translateY(${delta}px)`;
  }
  function onEnd() {
    if (startY === null) return;
    const sheetHeight = el.offsetHeight || 400;
    const threshold = Math.min(120, sheetHeight * 0.25);
    el.removeAttribute("data-dragging");
    el.style.transform = "";
    if (lastDelta > threshold) closeProfilePopover();
    startY = null;
    lastDelta = 0;
  }

  el.addEventListener("touchstart", onStart, { passive: true });
  el.addEventListener("touchmove", onMove, { passive: true });
  el.addEventListener("touchend", onEnd, { passive: true });
  el.addEventListener("touchcancel", onEnd, { passive: true });
}

// Pin the popover to the trigger pill. We use fixed-positioning
// from the bottom-left of the viewport so its bottom edge sits
// just above the pill and its left edge aligns with the sidebar
// padding. On narrow viewports the bottom-sheet @media rule in
// styles.css takes over and we clear the inline overrides so the
// CSS values win.
function positionProfilePopover() {
  const el = profilePopoverEl;
  if (!el || el.hidden) return;
  const isMobile = typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 720px)").matches;
  if (isMobile) {
    el.style.left = "";
    el.style.right = "";
    el.style.bottom = "";
    el.style.top = "";
    return;
  }
  const $pill = document.getElementById("me-pill");
  if (!$pill) return;
  const r = $pill.getBoundingClientRect();
  // 10px gap above the pill; clamp so the popover never tucks
  // beneath the viewport edge if the pill ever moves off-screen.
  const bottomGap = Math.max(8, window.innerHeight - r.top + 10);
  // Align with the pill's left edge but never closer than 8px to
  // the viewport edge.
  const leftEdge = Math.max(8, r.left);
  el.style.left = `${leftEdge}px`;
  el.style.right = "auto";
  el.style.bottom = `${bottomGap}px`;
  el.style.top = "auto";
}

function openProfilePopover() {
  const el = ensureProfilePopover();
  if (!el) return;
  if (!session?.steamID) return;
  profilePopoverOpen = true;
  el.hidden = false;
  document.getElementById("me-pill")?.setAttribute("aria-expanded", "true");
  renderProfilePopover();
  positionProfilePopover();
  // Defer the document-click handler to the next tick so the click
  // that opened us doesn't immediately count as an outside click.
  if (!profilePopoverDocClickBound) {
    profilePopoverDocClickBound = true;
    setTimeout(() => {
      document.addEventListener("click", onProfilePopoverDocClick, true);
      document.addEventListener("keydown", onProfilePopoverKeydown, true);
    }, 0);
  }
  // Keep the popover anchored to the pill while it's open, even if
  // the user resizes the window or scrolls the underlying page.
  // Scroll uses capture so we catch scrolls inside any ancestor
  // (e.g. the main content scrolling under us).
  window.addEventListener("resize", positionProfilePopover);
  window.addEventListener("scroll", positionProfilePopover, true);
  // Kick a fresh fetch so what's in the popover is current the
  // moment it opens, even if the next poll is 25s away.
  if (session) {
    void pullInbox();
    void pullOutbox();
    void pullFeed();
  }
}

function closeProfilePopover() {
  const el = profilePopoverEl;
  profilePopoverOpen = false;
  if (el) el.hidden = true;
  document.getElementById("me-pill")?.setAttribute("aria-expanded", "false");
  if (profilePopoverDocClickBound) {
    profilePopoverDocClickBound = false;
    document.removeEventListener("click", onProfilePopoverDocClick, true);
    document.removeEventListener("keydown", onProfilePopoverKeydown, true);
  }
  window.removeEventListener("resize", positionProfilePopover);
  window.removeEventListener("scroll", positionProfilePopover, true);
}

function toggleProfilePopover() {
  if (profilePopoverOpen) closeProfilePopover();
  else openProfilePopover();
}

function refreshProfilePopoverIfOpen() {
  if (profilePopoverOpen) renderProfilePopover();
}

function onProfilePopoverDocClick(ev) {
  if (!profilePopoverEl) return;
  if (profilePopoverEl.contains(ev.target)) return;
  // Clicks on the trigger pill are handled by its own listener;
  // skip them here so we don't immediately re-close after re-open.
  const $pillBtn = document.getElementById("me-pill");
  if ($pillBtn && $pillBtn.contains(ev.target)) return;
  closeProfilePopover();
}

function onProfilePopoverKeydown(ev) {
  if (ev.key === "Escape") {
    closeProfilePopover();
    document.getElementById("me-pill")?.focus();
  }
}

/**
 * Tiny helper for the section-head "· N" suffix: renders nothing for
 * 0 (most empty states already say "no invites yet" inline), and a
 * subtly-muted dot-separated count otherwise.
 */
function renderSectionCount(n) {
  if (!n) return "";
  return ` <span class="muted">· ${n}</span>`;
}

function renderProfilePopover() {
  const el = ensureProfilePopover();
  if (!el || !session?.steamID) return;

  const meRow = (lastFeed || []).find((p) => p.steamID === session.steamID);
  const persona = meRow?.personaName
    || document.getElementById("me-pill-name")?.textContent
    || "Your profile";
  const avatar = meRow?.avatarURL
    || document.getElementById("me-pill-avatar")?.getAttribute("src")
    || "/assets/brand/crest-avatar-128-v1.png";
  const handle = "Signed in with Steam";

  const pair = getMyPairFromFeed();
  const inbox = (lastInbox || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const outbox = (lastOutbox || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const pending = inbox.filter((i) => i.status === "pending");
  const sentPending = outbox.filter((i) => i.status === "pending").length;

  el.innerHTML = `
    <div class="profile-pop-head">
      <img class="profile-pop-avatar" alt="" src="${esc(avatar)}" />
      <div class="profile-pop-id">
        <strong>${esc(persona)}</strong>
        <span class="muted">${esc(handle)}</span>
      </div>
      <button class="profile-pop-close" type="button" data-pop-action="close" aria-label="Close">&times;</button>
    </div>

    ${pair ? `<section class="profile-pop-section" data-pop-section="party">
      <header class="profile-pop-section-head">
        <span class="profile-pop-section-dot is-live" aria-hidden="true"></span>
        <span>Co-op Pairing</span>
      </header>
      ${renderProfilePopoverPair(pair)}
    </section>` : ""}

    ${inbox.length ? `<section class="profile-pop-section" data-pop-section="invites-in">
      <header class="profile-pop-section-head">
        <span class="profile-pop-section-dot ${pending.length ? "is-hot" : ""}" aria-hidden="true"></span>
        <span>Invites received${renderSectionCount(pending.length)}</span>
      </header>
      <ul class="profile-pop-list">${inbox.map(renderProfilePopoverInboxRow).join("")}</ul>
    </section>` : ""}

    ${outbox.length ? `<section class="profile-pop-section" data-pop-section="invites-out">
      <header class="profile-pop-section-head">
        <span class="profile-pop-section-dot ${sentPending ? "is-hot" : ""}" aria-hidden="true"></span>
        <span>Invites sent${renderSectionCount(outbox.length)}</span>
      </header>
      <ul class="profile-pop-list">${outbox.map(renderProfilePopoverOutboxRow).join("")}</ul>
    </section>` : ""}

    <footer class="profile-pop-foot">
      <button class="profile-pop-link" type="button" data-pop-action="open-settings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        <span>Settings</span>
      </button>
      <button class="profile-pop-link" type="button" data-pop-action="open-beta">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6.5L3.5 16A2 2 0 005 19h14a2 2 0 001.5-3L15 8.5V2"/><path d="M9 2h6"/></svg>
        <span>Beta features</span>
      </button>
      <button class="profile-pop-link" type="button" data-pop-action="open-coop">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
        <span>Open Co-op</span>
      </button>
      <button class="profile-pop-link profile-pop-link--danger" type="button" data-pop-action="signout">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span>Sign out</span>
      </button>
    </footer>
  `;

  wireProfilePopover(el);
  // Content height changes when invites arrive/clear, so re-anchor
  // the popover so its bottom edge stays parked above the pill.
  if (profilePopoverOpen) positionProfilePopover();
}

function renderProfilePopoverPair(pair) {
  if (!pair) {
    return `<p class="profile-pop-empty">Not in a co-op pairing. Accept or send an invite to pair up.</p>`;
  }
  const partner = pair.partners[0];
  const others = pair.partners.slice(1);
  const sinceRel = pair.since ? formatRelativeActive(pair.since) : "";
  const sinceLabel = sinceRel
    ? sinceRel === "just now" ? "paired just now" : `paired ${sinceRel.replace(/ ago$/, "")} ago`
    : "paired";
  // Steam Chat deep-link: opens the desktop client straight to a
  // chat window with the partner, no friend-add roundtrip needed
  // (works for any user as long as both clients are running).
  // Falls back gracefully if the user isn't on a desktop with the
  // Steam client — the link does nothing and the Steam profile
  // button next to it still works.
  const chatHref = `steam://friends/message/${esc(partner.partnerID)}`;
  const profileHref = `https://steamcommunity.com/profiles/${esc(partner.partnerID)}`;
  return `
    <div class="profile-pop-pair">
      <img class="profile-pop-pair-avatar" alt="" src="${esc(partner.partnerAvatar || "/assets/brand/crest-avatar-128-v1.png")}" />
      <div class="profile-pop-pair-meta">
        <strong>${esc(partner.partnerPersona)}</strong>
        <span class="muted">${esc(sinceLabel)}</span>
      </div>
      <div class="profile-pop-pair-actions">
        <a class="btn-primary sm" href="${chatHref}"
           title="Open Steam Chat with ${esc(partner.partnerPersona)}">Message</a>
        <a class="btn-ghost sm" target="_blank" rel="noopener"
           href="${profileHref}"
           title="Open ${esc(partner.partnerPersona)}'s Steam profile">Profile</a>
        <button class="btn-ghost sm" type="button" data-pop-action="end-coop"
          title="Leave this co-op pairing">End</button>
      </div>
      ${others.length
        ? `<ul class="profile-pop-pair-extra">${others.map((p) =>
            `<li>${esc(p.partnerPersona)}</li>`).join("")}</ul>`
        : ""}
      <p class="profile-pop-pair-hint muted">
        Once you're chatting, share your STS2 lobby link
        (Steam → friend's name → <em>Invite to Game</em>).
      </p>
    </div>`;
}

function renderProfilePopoverInboxRow(invite) {
  const safeAvatar = (() => {
    try {
      const u = new URL(invite.fromAvatar ?? "");
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {}
    return "/assets/brand/crest-avatar-128-v1.png";
  })();
  const messageText = InviteAPI.getMessageText(invite.messageId) ?? "Wants to play.";
  const when = invite.createdAt ? formatRelativeActive(invite.createdAt) : "";
  const persona = invite.fromPersona || "Someone";

  if (invite.status === "pending") {
    return `
      <li class="profile-pop-msg" data-msg-state="pending">
        <img class="profile-pop-msg-avatar" alt="" src="${esc(safeAvatar)}" />
        <div class="profile-pop-msg-body">
          <div class="profile-pop-msg-row">
            <strong>${esc(persona)}</strong>
            ${when ? `<span class="profile-pop-msg-when muted">${esc(when)}</span>` : ""}
          </div>
          <p class="profile-pop-msg-text">"${esc(messageText)}"</p>
          <div class="profile-pop-msg-actions">
            <button class="btn-primary sm" type="button" data-pop-action="invite-respond" data-id="${esc(invite.id)}" data-resp="accept">Accept</button>
            <button class="btn-ghost sm" type="button" data-pop-action="invite-respond" data-id="${esc(invite.id)}" data-resp="decline">Decline</button>
          </div>
        </div>
      </li>`;
  }

  // Past states (accepted, declined, expired). Read-only history so
  // the user can see what happened without scrolling the Co-op tab.
  const stateLabel = ({
    accepted: "Accepted",
    declined: "Declined",
    expired: "Expired",
    withdrawn: "Withdrawn",
  })[invite.status] || invite.status;
  return `
    <li class="profile-pop-msg" data-msg-state="${esc(invite.status)}">
      <img class="profile-pop-msg-avatar" alt="" src="${esc(safeAvatar)}" />
      <div class="profile-pop-msg-body">
        <div class="profile-pop-msg-row">
          <strong>${esc(persona)}</strong>
          <span class="profile-pop-msg-state">${esc(stateLabel)}</span>
          ${when ? `<span class="profile-pop-msg-when muted">${esc(when)}</span>` : ""}
        </div>
        <p class="profile-pop-msg-text">"${esc(messageText)}"</p>
      </div>
    </li>`;
}

function renderProfilePopoverOutboxRow(invite) {
  const safeAvatar = (() => {
    try {
      const u = new URL(invite.toAvatar ?? "");
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {}
    return "/assets/brand/crest-avatar-128-v1.png";
  })();
  const messageText = InviteAPI.getMessageText(invite.messageId) ?? "Wants to play.";
  const when = invite.createdAt ? formatRelativeActive(invite.createdAt) : "";
  const persona = invite.toPersona || "Player";
  const stateLabel = ({
    pending: "Pending",
    accepted: "Accepted",
    declined: "Declined",
    expired: "Expired",
    withdrawn: "Withdrawn",
  })[invite.status] || invite.status;
  const showWithdraw = invite.status === "pending";
  return `
    <li class="profile-pop-msg" data-msg-state="${esc(invite.status)}">
      <img class="profile-pop-msg-avatar" alt="" src="${esc(safeAvatar)}" />
      <div class="profile-pop-msg-body">
        <div class="profile-pop-msg-row">
          <strong>${esc(persona)}</strong>
          <span class="profile-pop-msg-state">${esc(stateLabel)}</span>
          ${when ? `<span class="profile-pop-msg-when muted">${esc(when)}</span>` : ""}
        </div>
        <p class="profile-pop-msg-text">"${esc(messageText)}"</p>
        ${showWithdraw
          ? `<div class="profile-pop-msg-actions">
               <button class="btn-ghost sm" type="button" data-pop-action="invite-withdraw" data-id="${esc(invite.id)}">Withdraw</button>
             </div>`
          : ""}
      </div>
    </li>`;
}

function wireProfilePopover(el) {
  el.querySelectorAll("[data-pop-action]").forEach((node) => {
    if (node.dataset.popWired) return;
    node.dataset.popWired = "1";
    node.addEventListener("click", async (ev) => {
      const action = node.dataset.popAction;
      if (action === "close") {
        closeProfilePopover();
        return;
      }
      if (action === "open-coop") {
        closeProfilePopover();
        switchTab("coop");
        return;
      }
      if (action === "open-settings") {
        closeProfilePopover();
        switchTab("settings");
        return;
      }
      if (action === "open-beta") {
        closeProfilePopover();
        switchTab("beta");
        return;
      }
      if (action === "signout") {
        closeProfilePopover();
        document.getElementById("signout-btn")?.click();
        return;
      }
      if (action === "end-coop") {
        ev.preventDefault();
        node.disabled = true;
        try {
          const r = await fetch(`${API_BASE}/pair`, {
            method: "DELETE",
            credentials: "include",
            headers: { authorization: `Bearer ${session?.sessionToken ?? "__cookie__"}` },
          });
          if (!r.ok) {
            toast(`Couldn't end co-op (${r.status}).`);
            node.disabled = false;
            return;
          }
          toast("Ended co-op.");
          await pullFeed();
          renderProfilePopover();
        } catch (e) {
          toast(`Couldn't end co-op: ${String(e?.message ?? e)}`);
          node.disabled = false;
        }
        return;
      }
      if (action === "invite-respond") {
        const id = node.dataset.id;
        const resp = node.dataset.resp;
        if (!id || !resp) return;
        node.disabled = true;
        try {
          const r = await InviteAPI.respondToInvite(API_BASE, session.sessionToken, id, resp);
          if (!r.ok) {
            toast(`Couldn't ${resp}: ${r.error ?? "unknown error"}`);
            node.disabled = false;
            return;
          }
          if (resp === "accept") toast("Accepted.");
          else toast("Declined.");
          await Promise.all([pullInbox(), pullFeed()]);
          renderProfilePopover();
        } catch (e) {
          toast(`Couldn't ${resp}: ${String(e?.message ?? e)}`);
          node.disabled = false;
        }
        return;
      }
      if (action === "invite-withdraw") {
        const id = node.dataset.id;
        if (!id) return;
        node.disabled = true;
        try {
          const r = await InviteAPI.withdrawInvite(API_BASE, session.sessionToken, id);
          if (!r.ok) {
            toast(`Couldn't withdraw: ${r.error ?? "unknown error"}`);
            node.disabled = false;
            return;
          }
          toast("Invite withdrawn.");
          await pullOutbox();
          renderProfilePopover();
        } catch (e) {
          toast(`Couldn't withdraw: ${String(e?.message ?? e)}`);
          node.disabled = false;
        }
        return;
      }
    });
  });
}

function showPushingPill(visible) {
  // Show the same "Sending…" / "Saved" badge on both the Beta and
  // Classic surfaces' me-cards so the user gets immediate feedback
  // no matter which co-op presentation is active.
  const pills = [
    document.getElementById("me-pushing-pill"),
    document.getElementById("classic-me-pushing-pill"),
  ].filter(Boolean);
  pills.forEach((pill) => {
    pill.hidden = false;
    pill.textContent = visible ? "Sending…" : "Saved";
  });
  if (!visible) setTimeout(() => pills.forEach((p) => { p.hidden = true; }), 800);
}

function toast(msg, opts = {}) {
  let $t = document.getElementById("toast");
  if (!$t) {
    $t = document.createElement("div");
    $t.id = "toast";
    $t.className = "toast";
    document.body.appendChild($t);
  }
  $t.textContent = msg;
  $t.classList.add("is-visible");
  // Long messages (multi-sentence diagnostics) need more dwell time
  // than the default 3s — reading + comprehension + acting on a path
  // takes ~10s for most users. Callers pass `{ duration: 12000 }` for
  // those cases. The default stays 3s so common confirmations don't
  // linger past usefulness.
  const duration = Number.isFinite(opts.duration) && opts.duration > 0 ? opts.duration : 3000;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $t.classList.remove("is-visible"), duration);
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Ascension suffix for stat-card sub-copy. Ascension 0 is the game's
// base difficulty; rendering it as "at A0" reads as odd jargon (D21),
// so spell it out. Absent/non-finite values contribute nothing. Beta
// Blitz/Dread runs (STS2 v0.113.0) are not standard-ladder levels, so
// they read "in Blitz A2" / "in Dread"; standard runs are unchanged.
function ascAtPhrase(a, gameMode) {
  const mode = Stats.offLadderMode(gameMode);
  if (mode === "dread") return " in Dread";
  if (mode === "blitz") return Number.isFinite(a) ? ` in Blitz A${a}` : " in Blitz";
  if (!Number.isFinite(a)) return "";
  return a > 0 ? ` at A${a}` : " at base ascension";
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
    const sid = j?.steamID || "";
    const sidOk =
      /^\d{17}$/.test(sid) ||
      (isLocalDevHost() && /^local-[a-z0-9_-]+$/i.test(sid));
    if (j && sidOk && j.sessionToken) return j;
    return null;
  } catch { return null; }
}
function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// =========================================================================
// Per-run Share modal
// -------------------------------------------------------------------------
// Mirrors the desktop ShareCard: 880x540 polished image, rendered straight
// to a <canvas> (no html2canvas dependency, no async font loading dance),
// plus three exports: Download PNG, Copy Image, Copy Markdown.
//
// We render with the Canvas 2D API directly. That makes us font-stack
// dependent for the heavy text — fine, the system stack we use everywhere
// in the web companion (Inter / Helvetica / Arial) covers every browser
// shipping in the last decade.
// =========================================================================

// =========================================================================
// Run detail modal
// -------------------------------------------------------------------------
// Click any row in Recent Runs (anywhere except the Share icon) to open a
// detailed read-only inspection of that single run: hero (character +
// outcome + KPIs), final deck (with upgrade markers), relics, per-floor
// pick history, and source file. Built on the same backdrop pattern as
// the share modal so dismissal feels consistent.
// =========================================================================

function wireRunDetailModal() {
  const $modal = document.getElementById("run-detail-modal");
  const $close = document.getElementById("run-detail-close");
  if (!$modal || !$close) {
    console.warn("[Vault] run detail modal elements missing — detail UI disabled");
    return;
  }
  $close.addEventListener("click", closeRunDetailModal);
  $modal.addEventListener("click", (e) => {
    if (e.target.id === "run-detail-modal") closeRunDetailModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$modal.hidden) closeRunDetailModal();
  });

  // Row click → open detail. We use document delegation so re-renders
  // (filter chip flips) don't lose the listener, and the share button
  // stops propagation in its own handler so this never fires on Share.
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="share-run"]')) return;
    // Copy-row-link: produces `?tab=runs&run=<id>` URL on the
    // clipboard so the user can paste it back to themselves or a
    // friend. Stops propagation so the row click that would open
    // the modal doesn't also fire.
    const linkBtn = e.target.closest('[data-action="copy-row-link"]');
    if (linkBtn) {
      e.stopPropagation();
      e.preventDefault();
      const id = linkBtn.dataset.runId;
      const run = parsedRuns.find((r) => String(r.id) === String(id));
      if (run) copyRunDeepLink(run, linkBtn);
      return;
    }
    if (e.target.closest('[data-action="open-run"]')) {
      const id = e.target.closest('[data-action="open-run"]').dataset.runId;
      const run = parsedRuns.find((r) => String(r.id) === String(id));
      if (run) openRunDetailModal(run);
      return;
    }
    const row = e.target.closest('.run-row');
    if (!row) return;
    const id = row.dataset.runId;
    // Compare-mode short-circuit: a row click here toggles selection
    // for the compare modal instead of opening the run-detail modal.
    // The share / copy-link buttons still work because they stop
    // propagation in their own handlers above.
    if (compareMode) {
      e.preventDefault();
      toggleCompareSelection(id);
      return;
    }
    const run = parsedRuns.find((r) => String(r.id) === String(id));
    if (run) openRunDetailModal(run);
  });

  // Keyboard: Enter / Space on a focused row also opens it.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = document.activeElement?.closest?.('.run-row');
    if (!row) return;
    e.preventDefault();
    if (compareMode) {
      toggleCompareSelection(row.dataset.runId);
      return;
    }
    const run = parsedRuns.find((r) => String(r.id) === String(row.dataset.runId));
    if (run) openRunDetailModal(run);
  });
}

function openRunDetailModal(run, opts = {}) {
  const $modal = document.getElementById("run-detail-modal");
  const $body  = document.getElementById("run-detail-body");
  if (!$modal || !$body) return;
  // The row preview floats above everything; never leave it over the dialog.
  forceHideRunRowPreview();
  $body.innerHTML = renderRunDetail(run);
  // Wire the in-modal Share button to forward into the existing share
  // canvas flow. Same handler the row Share button uses.
  $body.querySelectorAll('[data-action="share-from-detail"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      closeRunDetailModal();
      openShareModal(run);
    });
  });
  $body.querySelectorAll('[data-action="close-detail"]').forEach((btn) => {
    btn.addEventListener("click", () => closeRunDetailModal());
  });
  // "Copy link" inside the modal — produces a shareable URL anyone
  // can paste into Discord that re-opens the same run on load.
  $body.querySelectorAll('[data-action="copy-run-link"]').forEach((btn) => {
    btn.addEventListener("click", () => copyRunDeepLink(run, btn));
  });
  $modal.hidden = false;
  document.body.style.overflow = "hidden";
  // Reflect the open modal in the URL so deep links + browser back
  // both work. `opts.skipUrl` lets the boot-time deep-link opener
  // skip the round-trip when the URL already points here.
  if (!opts.skipUrl) syncRunUrl(run.id);
}

function closeRunDetailModal(opts = {}) {
  const $modal = document.getElementById("run-detail-modal");
  if (!$modal) return;
  $modal.hidden = true;
  document.body.style.overflow = "";
  if (!opts.skipUrl) syncRunUrl(null);
}

// =========================================================================
// Run compare modal
// =========================================================================
function wireCompareUI() {
  if (window.__compareWired) return;
  window.__compareWired = true;

  // Compare-toggle button (lives in the run-filters bar; re-rendered
  // on every filter change so we listen at the document level rather
  // than binding directly).
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-action="compare-toggle"]') : null;
    if (!t) return;
    e.preventDefault();
    setCompareMode(!compareMode);
  });

  // Bottom bar: Cancel + Compare actions.
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('[data-action="compare-cancel"]')) {
      e.preventDefault();
      setCompareMode(false);
      return;
    }
    if (e.target.closest('[data-action="compare-open"]')) {
      e.preventDefault();
      const ids = Array.from(compareSelected);
      const runs = ids
        .map((id) => parsedRuns.find((r) => String(r.id) === String(id)))
        .filter(Boolean);
      if (runs.length >= 2) openCompareModal(runs);
      return;
    }
  });

  // Modal close (× button + backdrop click + Esc).
  const $modal = document.getElementById("run-compare-modal");
  const $close = document.getElementById("run-compare-close");
  if ($close) $close.addEventListener("click", closeCompareModal);
  if ($modal) {
    $modal.addEventListener("click", (e) => {
      if (e.target === $modal) closeCompareModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($modal && !$modal.hidden) {
      closeCompareModal();
      return;
    }
    // Esc outside the modal but in compare mode = bail out of compare mode.
    if (compareMode) setCompareMode(false);
  });

  // Keyboard shortcut: `c` toggles compare mode while on Recent Runs.
  // Skipped while typing in inputs / textareas / contenteditable so it
  // doesn't fight the user.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "c" && e.key !== "C") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target instanceof Element ? e.target.tagName : "") || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
    // Only meaningful from the Recent Runs tab.
    const activeTab = document.querySelector('.tab-panel:not([hidden])')?.dataset?.tab;
    if (activeTab !== "runs") return;
    e.preventDefault();
    setCompareMode(!compareMode);
  });

  refreshCompareBar();
}

function openCompareModal(runs) {
  const $modal = document.getElementById("run-compare-modal");
  const $body = document.getElementById("run-compare-body");
  if (!$modal || !$body) return;
  $body.innerHTML = renderCompare(runs);
  $modal.hidden = false;
  document.body.style.overflow = "hidden";
  vaultGtagEvent("compare_open", { runs: runs.length });
}

function closeCompareModal() {
  const $modal = document.getElementById("run-compare-modal");
  if (!$modal) return;
  $modal.hidden = true;
  document.body.style.overflow = "";
}

/** Render the side-by-side comparison body. Pure function on the
 *  selected run records — no DOM access. Computes relic and card
 *  intersections so the modal can highlight what every run in the
 *  selection has in common (the "what made these runs work?" view)
 *  vs what's unique to each column. */
function renderCompare(runs) {
  if (!Array.isArray(runs) || runs.length < 2) return "";
  if (UI) return renderCompareNext(runs);

  // Normalize: deck strips upgrade suffix (`+1`) for set membership,
  // but keeps the raw entry for the unique-cards display so we can
  // show "+1 Strike" vs "Strike" as visually distinct picks.
  const relicSets = runs.map((r) => new Set(Array.isArray(r.relics) ? r.relics : []));
  const deckSets = runs.map((r) => {
    const arr = Array.isArray(r.deckAtEnd) ? r.deckAtEnd : [];
    return new Set(arr.map((id) => String(id).split("+")[0]));
  });

  // Intersection: relics / cards present in EVERY selected run.
  const intersect = (sets) => {
    if (!sets.length) return new Set();
    const [first, ...rest] = sets;
    const out = new Set();
    for (const v of first) {
      if (rest.every((s) => s.has(v))) out.add(v);
    }
    return out;
  };
  const sharedRelics = Array.from(intersect(relicSets));
  const sharedCards = Array.from(intersect(deckSets));

  // Per-run column. Stats grid + relics + a "unique cards" preview
  // (cards in this run's deck that no other selected run has).
  const columns = runs.map((r, i) => {
    const theme = charTheme(r.character);
    const charName = r.character ? prettifyCharacterName(r.character) : "Unknown";
    const won = r.won === true;
    const abandoned = r.wasAbandoned === true;
    const result = won ? "Victory" : abandoned ? "Abandoned" : "Defeat";
    const resultClass = won ? "is-win" : abandoned ? "is-abandon" : "is-loss";
    const dur = formatPlayTimeStrict(r.playTimeSeconds) || "—";
    const dateStr = r.endedAt
      ? formatRunDate(r.endedAt)
      : (r.startedAt ? formatRunDate(r.startedAt) : "");
    const relicArr = Array.isArray(r.relics) ? r.relics : [];
    const deckArr = Array.isArray(r.deckAtEnd) ? r.deckAtEnd : [];

    // Unique cards = cards in THIS deck not present in ALL others.
    // We strip upgrade markers when computing uniqueness so "Strike"
    // and "Strike+1" don't both register as "unique".
    const otherDecks = deckSets.filter((_, j) => j !== i);
    const otherUnion = new Set();
    for (const s of otherDecks) for (const v of s) otherUnion.add(v);
    const uniqueDeck = deckArr.filter((id) => {
      const base = String(id).split("+")[0];
      return !otherUnion.has(base);
    }).slice(0, 8);

    const portraitSrc = characterImageSrc(r.character);
    const portrait = portraitSrc
      ? `<img src="${esc(portraitSrc)}" alt="${esc(charName)}" loading="lazy">`
      : `<span class="run-compare-portrait-fallback">${esc(charName.slice(0, 2))}</span>`;

    const relicsHTML = relicArr.slice(0, 8).map((id) => {
      const src = relicImageSrc(id);
      const name = relicLabel(id);
      const isShared = sharedRelics.includes(id);
      return `
        <li class="run-compare-relic${isShared ? " is-shared" : ""}" title="${esc(name)}${isShared ? " · shared with all selected runs" : ""}">
          ${src
            ? `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="run-compare-relic-fb" style="display:none">${esc(name.slice(0, 2))}</span>`
            : `<span class="run-compare-relic-fb">${esc(name.slice(0, 2))}</span>`}
        </li>`;
    }).join("");
    const moreRelics = Math.max(0, relicArr.length - 8);

    const uniqueHTML = uniqueDeck.length
      ? `<ul class="run-compare-cards">${uniqueDeck.map((id) => {
          const upgraded = String(id).includes("+");
          const base = String(id).split("+")[0];
          const src = cardImageSrc(base);
          const name = cardLabel(base);
          return `
            <li class="run-compare-card${upgraded ? " is-upgraded" : ""}" title="${esc(name)}${upgraded ? " (upgraded)" : ""}">
              ${src
                ? `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="run-compare-card-fb" style="display:none">${esc(name.slice(0, 2))}</span>`
                : `<span class="run-compare-card-fb">${esc(name.slice(0, 2))}</span>`}
            </li>`;
        }).join("")}</ul>`
      : `<p class="run-compare-empty">No unique cards — this deck overlaps fully with the others.</p>`;

    const killedBy = !won && !abandoned && r.killedBy ? bossLabel(r.killedBy) : "";

    return `
      <article class="run-compare-col" style="--char-color:${theme.color}" data-result="${won ? "win" : abandoned ? "abandon" : "loss"}">
        <header class="run-compare-col-head">
          <div class="run-compare-portrait">${portrait}</div>
          <div class="run-compare-id">
            <h3 class="run-compare-name">${esc(charName)}</h3>
            <div class="run-compare-meta">
              ${runAscPillHtml(r)}
              <span class="run-compare-result ${resultClass}">${result}</span>
            </div>
            ${dateStr ? `<p class="run-compare-date muted small">${esc(dateStr)}</p>` : ""}
          </div>
        </header>
        <dl class="run-compare-stats">
          <div><dt>Floor</dt><dd>${Number.isFinite(r.floorReached) ? r.floorReached : "—"}</dd></div>
          <div><dt>Time</dt><dd>${esc(dur)}</dd></div>
          <div><dt>Deck</dt><dd>${deckArr.length}</dd></div>
          <div><dt>Relics</dt><dd>${relicArr.length}</dd></div>
        </dl>
        <section class="run-compare-section">
          <h4 class="run-compare-section-title">Relics${moreRelics > 0 ? ` <span class="muted">(top 8 of ${relicArr.length})</span>` : ""}</h4>
          <ul class="run-compare-relics">${relicsHTML || `<li class="run-compare-empty">No relics recorded.</li>`}</ul>
        </section>
        <section class="run-compare-section">
          <h4 class="run-compare-section-title">Unique cards${uniqueDeck.length ? ` <span class="muted">(top ${uniqueDeck.length})</span>` : ""}</h4>
          ${uniqueHTML}
        </section>
        ${killedBy ? `<p class="run-compare-killed">Killed by <strong>${esc(killedBy)}</strong></p>` : ""}
      </article>`;
  }).join("");

  // "Shared by all" panel above the columns. Only renders when the
  // overlap is non-empty; otherwise we'd be eating vertical space
  // showing nothing. The chips reuse the same image lookups so the
  // shared row stays consistent with the per-column thumbnails.
  const sharedHTML = (sharedRelics.length || sharedCards.length) ? `
    <section class="run-compare-shared">
      <header class="run-compare-shared-head">
        <h3>Shared by all ${runs.length} runs</h3>
        <p class="muted small">The relics + cards every selected run had in common.</p>
      </header>
      <div class="run-compare-shared-grid">
        ${sharedRelics.length ? `
          <div class="run-compare-shared-block">
            <h4>${sharedRelics.length} relic${sharedRelics.length === 1 ? "" : "s"}</h4>
            <ul class="run-compare-relics">
              ${sharedRelics.slice(0, 12).map((id) => {
                const src = relicImageSrc(id);
                const name = relicLabel(id);
                return `
                  <li class="run-compare-relic is-shared" title="${esc(name)}">
                    ${src
                      ? `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="run-compare-relic-fb" style="display:none">${esc(name.slice(0, 2))}</span>`
                      : `<span class="run-compare-relic-fb">${esc(name.slice(0, 2))}</span>`}
                  </li>`;
              }).join("")}
            </ul>
          </div>` : ""}
        ${sharedCards.length ? `
          <div class="run-compare-shared-block">
            <h4>${sharedCards.length} card${sharedCards.length === 1 ? "" : "s"}</h4>
            <ul class="run-compare-cards">
              ${sharedCards.slice(0, 16).map((id) => {
                const src = cardImageSrc(id);
                const name = cardLabel(id);
                return `
                  <li class="run-compare-card is-shared" title="${esc(name)}">
                    ${src
                      ? `<img src="${esc(src)}" alt="${esc(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="run-compare-card-fb" style="display:none">${esc(name.slice(0, 2))}</span>`
                      : `<span class="run-compare-card-fb">${esc(name.slice(0, 2))}</span>`}
                  </li>`;
              }).join("")}
            </ul>
          </div>` : ""}
      </div>
    </section>` : `
    <p class="run-compare-no-overlap muted small">No shared relics or cards across these runs — they're meaningfully different builds.</p>`;

  return `
    ${sharedHTML}
    <div class="run-compare-grid run-compare-grid--${runs.length}">${columns}</div>
    <p class="run-compare-foot muted small">Tip: press <kbd>Esc</kbd> to close · <kbd>c</kbd> to toggle compare mode on Recent Runs.</p>`;
}

// ---- Compare, new UI (lib/ui/views-runs.js). Same overlap maths as above. --
const NEXT_COMPARE_RELICS = 8;
const NEXT_COMPARE_CARDS = 8;
const NEXT_SHARED_RELICS = 12;
const NEXT_SHARED_CARDS = 16;

function renderCompareNext(runs) {
  const relicSets = runs.map((r) => new Set(Array.isArray(r.relics) ? r.relics : []));
  const deckSets = runs.map((r) => new Set((Array.isArray(r.deckAtEnd) ? r.deckAtEnd : []).map((id) => String(id).split("+")[0])));
  const inAll = (sets) => [...sets[0]].filter((v) => sets.every((s) => s.has(v)));
  const sharedRelics = inAll(relicSets);
  const sharedCards = inAll(deckSets);
  const columns = runs.map((r, i) => {
    const relics = Array.isArray(r.relics) ? r.relics : [];
    const deck = Array.isArray(r.deckAtEnd) ? r.deckAtEnd : [];
    const others = new Set(deckSets.filter((_, j) => j !== i).flatMap((s) => [...s]));
    const date = r.endedAt || r.startedAt;
    const result = runResultNext(r);
    return {
      ...runArtNext(r.character),
      result,
      ascension: Number.isFinite(r.ascension) ? r.ascension : null,
      ascLabel: runAscText(r),
      date: date ? formatRunDate(date) : "",
      stats: [
        { label: "Floor", value: Number.isFinite(r.floorReached) ? String(r.floorReached) : "—" },
        { label: "Time", value: formatPlayTimeStrict(r.playTimeSeconds) || "—" },
        { label: "Deck", value: String(deck.length) },
        { label: "Relics", value: String(relics.length) },
      ],
      relics: relics.slice(0, NEXT_COMPARE_RELICS).map((id) => ({
        label: relicLabel(id), src: relicImageSrc(id), isShared: sharedRelics.includes(id),
      })),
      relicTotal: relics.length,
      uniqueCards: deck
        .filter((id) => !others.has(String(id).split("+")[0]))
        .slice(0, NEXT_COMPARE_CARDS)
        .map((id) => {
          const base = String(id).split("+")[0];
          return { label: cardLabel(base), src: cardImageSrc(id) || cardImageSrc(base), upgraded: String(id).includes("+") };
        }),
      killedBy: result === "loss" && r.killedBy ? bossLabel(r.killedBy) : "",
    };
  });
  return UI.RunsView.compareHtml({
    columns,
    sharedRelics: sharedRelics.slice(0, NEXT_SHARED_RELICS).map((id) => ({ label: relicLabel(id), src: relicImageSrc(id) })),
    sharedCards: sharedCards.slice(0, NEXT_SHARED_CARDS).map((id) => ({ label: cardLabel(id), src: cardImageSrc(id) })),
    sharedRelicTotal: sharedRelics.length,
    sharedCardTotal: sharedCards.length,
  });
}

/** Set or clear the `?run=…` query param without scrolling or
 *  re-rendering. Used by openRunDetailModal/closeRunDetailModal so
 *  the URL stays a permanent identity for whatever the user is
 *  looking at. */
function syncRunUrl(runId) {
  try {
    const u = new URL(window.location.href);
    if (runId) u.searchParams.set("run", runId);
    else u.searchParams.delete("run");
    history.replaceState(null, "", `${u.pathname}${u.search}${u.hash}`);
  } catch {}
}

/** Build a sharable absolute URL pointing at `?run=<id>` and copy it
 *  to clipboard. Falls back to a small toast with the URL if
 *  clipboard access is denied (browser without permission, http://
 *  on a non-localhost origin, etc). */
async function copyRunDeepLink(run, originBtn) {
  const u = new URL(window.location.href);
  u.searchParams.set("tab", "runs");
  u.searchParams.set("run", run.id);
  u.hash = "";
  const url = u.toString();
  try {
    await navigator.clipboard.writeText(url);
    toast("Run link copied. Paste it anywhere.");
  } catch {
    toast(url);
  }
  // Visual confirmation on the button itself.
  if (originBtn) {
    const prev = originBtn.textContent;
    originBtn.textContent = "Copied!";
    originBtn.classList.add("is-flashed");
    setTimeout(() => {
      originBtn.textContent = prev;
      originBtn.classList.remove("is-flashed");
    }, 1400);
  }
}

/** Boot-time / post-ingest deep-link opener.
 *
 *  If the current URL has `?run=<id>` and that id is known to the
 *  in-memory `parsedRuns` set, open its detail modal automatically.
 *  Two callers feed this:
 *    1) end of `boot()` — handles a cold load with a deep link.
 *    2) end of `commitParsedRuns()` — handles the case where boot
 *       saw the deep link before disk-ingest had populated the run.
 *  Idempotent — the second call is a no-op if the modal is already
 *  open for that id, which is exactly what we want. */
function openDeepLinkedRunIfPresent() {
  let runId = "";
  try { runId = new URL(window.location.href).searchParams.get("run") || ""; } catch {}
  if (!runId) return;
  const $modal = document.getElementById("run-detail-modal");
  // If a modal is already open with the same run, leave it alone.
  if ($modal && !$modal.hidden && $modal.dataset.runId === runId) return;
  const run = parsedRuns.find((r) => r.id === runId);
  if (!run) return;
  openRunDetailModal(run, { skipUrl: true });
  if ($modal) $modal.dataset.runId = runId;
}

function renderRunDetail(r) {
  if (UI) return renderRunDetailNext(r);
  const theme = charTheme(r.character);
  const charName = r.character ? prettifyCharacterName(r.character) : "Unknown";
  const outcomeText = r.won ? "VICTORY" : "DEFEAT";
  const outcomeClass = r.won ? "is-victory" : "is-defeat";
  const dateStr = r.endedAt
    ? formatRunDate(r.endedAt)
    : (r.startedAt ? formatRunDate(r.startedAt) : "—");
  const durStr = formatPlayTime(r.playTimeSeconds);
  const cardCount = Array.isArray(r.deckAtEnd) ? r.deckAtEnd.length : 0;
  const relicCount = Array.isArray(r.relics) ? r.relics.length : 0;
  const pickCount = Array.isArray(r.cardPicks) ? r.cardPicks.length : 0;

  const portrait = (() => {
    const src = characterImageSrc(r.character);
    if (src) return `<img src="${esc(src)}" alt="${esc(charName)}">`;
    return charIcon(theme.icon || "shield");
  })();

  const heroHTML = `
    <div class="run-detail-hero" style="--char-color:${theme.color}">
      <div class="run-detail-portrait">${portrait}</div>
      <div class="run-detail-id">
        <div class="run-detail-name">
          <span>${esc(charName)}</span>
          ${runAscPillHtml(r)}
        </div>
        <div class="run-detail-meta">
          <span>${esc(dateStr)}</span>
          ${r.seed ? `<span>Seed <strong>${esc(r.seed)}</strong></span>` : ""}
          ${r.sourceFile ? `<span>From <strong>${esc(r.sourceFile)}</strong></span>` : ""}
        </div>
      </div>
      <span class="run-detail-outcome ${outcomeClass}">${outcomeText}</span>
    </div>`;

  const statsHTML = `
    <div class="run-detail-stats">
      <div class="run-detail-stat">
        <span class="run-detail-stat-label">Floor reached</span>
        <span class="run-detail-stat-value">${Number.isFinite(r.floorReached) ? `Floor ${r.floorReached}` : "—"}</span>
      </div>
      <div class="run-detail-stat">
        <span class="run-detail-stat-label">Duration</span>
        <span class="run-detail-stat-value">${esc(durStr)}</span>
      </div>
      <div class="run-detail-stat">
        <span class="run-detail-stat-label">Final deck</span>
        <span class="run-detail-stat-value">${cardCount} card${cardCount === 1 ? "" : "s"}</span>
      </div>
      <div class="run-detail-stat">
        <span class="run-detail-stat-label">Relics</span>
        <span class="run-detail-stat-value">${relicCount}</span>
      </div>
      <div class="run-detail-stat">
        <span class="run-detail-stat-label">Choices made</span>
        <span class="run-detail-stat-value">${pickCount}</span>
      </div>
    </div>`;

  // ── Act Timeline ────────────────────────────────────────────────
  // Honest path visualization. Renders the linear sequence of nodes
  // the player visited per act. We DO NOT fabricate the full STS map
  // — the .run file only contains nodes the player actually walked
  // through, not the unvisited branches of the random map. So we
  // show "the road you took", not "the map of the dungeon". The
  // user explicitly asked for this honesty.
  const pathHTML = renderActTimeline(r);

  const relicsHTML = relicCount > 0
    ? `
      <div class="run-detail-section">
        <div class="run-detail-section-head">
          <h3 class="run-detail-section-title">Relics</h3>
          <span class="run-detail-section-count">${relicCount}</span>
        </div>
        <div class="run-detail-grid">
          ${r.relics.map((id) => {
            const src = relicImageSrc(id);
            const label = relicLabel(id);
            return `
              <div class="run-detail-relic" title="${esc(label)}">
                ${src ? `<img src="${esc(src)}" alt="${esc(label)}" loading="lazy" decoding="async">` : `<svg viewBox="0 0 24 24" width="48" height="48" fill="${theme.color}"><path d="M12 1.5l1.5 5L18.5 8 14 11l1.5 5L12 13l-3.5 3L10 11 5.5 8l5-1.5z"/></svg>`}
                <span class="run-detail-relic-name">${esc(label)}</span>
              </div>`;
          }).join("")}
        </div>
      </div>`
    : "";

  const deckHTML = cardCount > 0
    ? `
      <div class="run-detail-section">
        <div class="run-detail-section-head">
          <h3 class="run-detail-section-title">Final deck</h3>
          <span class="run-detail-section-count">${cardCount} cards</span>
        </div>
        <div class="run-detail-grid">
          ${r.deckAtEnd.map((id) => {
            const upgraded = id.includes("+");
            const baseId = upgraded ? id.split("+")[0] : id;
            const src = cardImageSrc(baseId);
            const label = cardLabel(baseId);
            return `
              <div class="run-detail-card${upgraded ? " is-upgraded" : ""}" title="${esc(label)}${upgraded ? " (upgraded)" : ""}">
                ${src ? `<img src="${esc(src)}" alt="${esc(label)}" loading="lazy" decoding="async">` : `<svg viewBox="0 0 16 16" width="48" height="48" fill="${theme.color}"><rect x="3" y="2" width="10" height="12" rx="1.5"/></svg>`}
                <span class="run-detail-card-name">${esc(label)}</span>
              </div>`;
          }).join("")}
        </div>
      </div>`
    : "";

  const picksHTML = pickCount > 0
    ? `
      <div class="run-detail-section">
        <div class="run-detail-section-head">
          <h3 class="run-detail-section-title">Card picks by floor</h3>
          <span class="run-detail-section-count">${pickCount} choice${pickCount === 1 ? "" : "s"}</span>
        </div>
        ${r.cardPicks.slice(0, 60).map((p) => {
          const offered = (p.offered || []).map((c) => cardLabel(c));
          const picked = p.picked ? cardLabel(p.picked) : null;
          const skipped = offered.filter((c) => c !== picked);
          return `
            <div class="run-detail-pickrow">
              <span class="run-detail-pickrow-floor">F${p.floor}</span>
              <div class="run-detail-pickrow-body">
                ${picked ? `<span class="picked">${esc(picked)}</span>` : `<span class="run-detail-empty">Skipped all</span>`}
                ${skipped.length ? ` <span class="run-detail-empty">·</span> <span class="skipped">${skipped.map(esc).join(" · ")}</span>` : ""}
              </div>
            </div>`;
        }).join("")}
      </div>`
    : "";

  const actionsHTML = `
    <div class="run-detail-actions">
      <button class="btn-primary btn-icon-text" type="button" data-action="share-from-detail">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>
          <polyline points="16 6 12 2 8 6"/>
          <line x1="12" y1="2" x2="12" y2="15"/>
        </svg>
        <span>Share this run</span>
      </button>
      <button class="btn-ghost btn-icon-text" type="button" data-action="copy-run-link" title="Copy a direct link to this run">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 1 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 1 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <span>Copy link</span>
      </button>
      <button class="btn-ghost btn-icon-text" type="button" data-action="close-detail">
        Close
      </button>
    </div>`;

  return heroHTML + statsHTML + pathHTML + relicsHTML + deckHTML + picksHTML + actionsHTML;
}

// ---- Run detail, new UI (lib/ui/views-runs.js) -----------------------------
const NEXT_ACT_NAMES = { 1: "The Crawl", 2: "The Climb", 3: "The Final Push" };
const NEXT_ACT_NUMERALS = ["I", "II", "III", "IV", "V", "VI"];
const NEXT_NODE_NAMES = {
  combat: ["Enemy", "enemies"], elite: ["Elite", "elites"], shop: ["Merchant", "merchants"],
  rest: ["Rest", "rests"], event: ["Unknown", "unknowns"], chest: ["Treasure", "treasures"],
  boss: ["Boss", "bosses"], unknown: ["Unknown", "unknowns"],
};
const NEXT_NODE_ORDER = ["combat", "elite", "shop", "rest", "event", "chest", "boss"];
const NEXT_PICKS_MAX = 60;
const NEXT_BASIC_CARDS = new Set(["strike", "defend"]);

/** The road taken, act by act, with the run's end marked on its last room. */
function buildActPathNext(r) {
  const acts = (Array.isArray(r.pathByAct) ? r.pathByAct : []).filter((a) => a && Array.isArray(a.nodes) && a.nodes.length);
  const endMark = r.won === true ? "win" : r.wasAbandoned === true ? "abandon" : "death";
  return acts.map((act, actIndex) => {
    const counts = {};
    act.nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
    const summary = NEXT_NODE_ORDER
      .filter((type) => counts[type])
      .map((type) => `${counts[type]} ${counts[type] === 1 ? NEXT_NODE_NAMES[type][0].toLowerCase() : NEXT_NODE_NAMES[type][1]}`)
      .join(" · ");
    const isLastAct = actIndex === acts.length - 1;
    const actNum = Number(act.act) || actIndex + 1;
    return {
      act: actNum,
      numeral: NEXT_ACT_NUMERALS[actNum - 1] || String(actNum),
      name: NEXT_ACT_NAMES[actNum] || "Beyond",
      summary,
      nodes: act.nodes.map((n, i) => ({
        floor: n.floor,
        type: NEXT_NODE_NAMES[n.type] ? n.type : "unknown",
        typeLabel: (NEXT_NODE_NAMES[n.type] || NEXT_NODE_NAMES.unknown)[0],
        mark: isLastAct && i === act.nodes.length - 1 ? endMark : "",
      })),
    };
  });
}

/** Final deck grouped by card (Strike ×4), interesting cards before the basics. */
function buildDeckNext(deckAtEnd) {
  const groups = new Map();
  (Array.isArray(deckAtEnd) ? deckAtEnd : []).forEach((id) => {
    const raw = String(id);
    const prev = groups.get(raw);
    groups.set(raw, prev ? { ...prev, count: prev.count + 1 } : { raw, count: 1 });
  });
  const isBasic = (raw) => {
    const core = raw.split("+")[0].toLowerCase().split("_").filter((p) => !CLASS_PREFIXES.has(p));
    return core.length === 1 && NEXT_BASIC_CARDS.has(core[0]);
  };
  return [...groups.values()]
    .map((g, order) => ({ ...g, order, basic: isBasic(g.raw) }))
    .sort((a, b) => Number(a.basic) - Number(b.basic) || a.order - b.order)
    .map((g) => {
      const base = g.raw.split("+")[0];
      return {
        label: cardLabel(base),
        src: cardImageSrc(g.raw) || cardImageSrc(base),
        count: g.count,
        upgraded: g.raw.includes("+"),
      };
    });
}

function runFateNext(r) {
  const floor = Number.isFinite(r.floorReached) ? ` on floor ${r.floorReached}` : "";
  if (r.won === true) {
    return Number.isFinite(r.playTimeSeconds) && r.playTimeSeconds > 0
      ? `Conquered the Spire in ${formatPlayTime(r.playTimeSeconds)}`
      : "Conquered the Spire";
  }
  if (r.wasAbandoned === true) return `Abandoned${floor}`;
  return r.killedBy ? `Slain by ${bossLabel(r.killedBy)}${floor}` : `Fell${floor}`;
}

function renderRunDetailNext(r) {
  const deck = Array.isArray(r.deckAtEnd) ? r.deckAtEnd : [];
  const relics = Array.isArray(r.relics) ? r.relics : [];
  const picks = Array.isArray(r.cardPicks) ? r.cardPicks : [];
  const date = r.endedAt || r.startedAt;
  const acts = buildActPathNext(r);
  return UI.RunsView.runDetailHtml({
    ...runArtNext(r.character),
    result: runResultNext(r),
    ascension: Number.isFinite(r.ascension) ? r.ascension : null,
    ascLabel: runAscText(r),
    date: date ? formatRunDate(date) : "Date unknown",
    seed: r.seed ? String(r.seed) : "",
    sourceFile: r.sourceFile ? String(r.sourceFile) : "",
    fate: runFateNext(r),
    stats: [
      { label: "Floor", value: Number.isFinite(r.floorReached) ? String(r.floorReached) : "—" },
      { label: "Time", value: formatPlayTime(r.playTimeSeconds) },
      { label: "Deck", value: String(deck.length) },
      { label: "Relics", value: String(relics.length) },
      { label: "Choices", value: String(picks.length) },
    ],
    acts,
    roomCount: acts.reduce((n, a) => n + a.nodes.length, 0),
    legend: NEXT_NODE_ORDER.map((type) => ({ type, label: NEXT_NODE_NAMES[type][0] })),
    relics: relics.map((id) => ({ label: relicLabel(id), src: relicImageSrc(id) })),
    deck: buildDeckNext(deck),
    deckCount: deck.length,
    picks: picks.slice(0, NEXT_PICKS_MAX).map((p) => {
      const picked = p.picked ? cardLabel(p.picked) : null;
      return {
        floor: p.floor,
        picked,
        skipped: (p.offered || []).map((c) => cardLabel(c)).filter((c) => c !== picked),
      };
    }),
    pickCount: picks.length,
  });
}

/**
 * Render the act-by-act path the player walked.
 *
 * Honest about scope:
 *   - We DO have the linear sequence of nodes visited per act.
 *   - We DO NOT have the unvisited branches of the random map.
 *   - So we render the actual road taken with the in-game STS2 node
 *     icons — no fake DAG branching.
 *
 * UX:
 *   - Each act is a collapsible `<details>` element that opens by
 *     default. Players who finished a long run can fold the early
 *     acts and focus on where they died.
 *   - Bottom legend explains every icon so the row reads at a
 *     glance even if the user has never seen the in-game map.
 *   - Death node highlighted with a red ring; victory with gold.
 *
 * Icons are hand-painted PNG sprites (`/assets/sts2/map-icons/*`)
 * matching the in-game art rather than abstract SVG glyphs.
 */
function renderActTimeline(r) {
  const path = Array.isArray(r.pathByAct) ? r.pathByAct : [];
  if (!path.length || !path.some((a) => a.nodes && a.nodes.length)) {
    return ""; // No path data on this run (older parser, partial save, etc.)
  }
  // STS2 has THREE acts in Early Access. There is no separate
  // "Act 4 / Architect" zone — the Architect is the act 3 boss
  // encounter, not its own area. Anything beyond act 3 (e.g. a
  // future Mega Crit content patch) renders with a generic label
  // until we ship explicit support.
  const actLabel = (n) => {
    if (n === 1) return "Act 1 — The Crawl";
    if (n === 2) return "Act 2 — The Climb";
    if (n === 3) return "Act 3 — The Final Push";
    return `Act ${n}`;
  };
  const nodeLabel = (type) => ({
    combat: "Enemy", elite: "Elite", shop: "Merchant", rest: "Rest",
    event: "Unknown", chest: "Treasure", boss: "Boss", unknown: "Unknown",
  })[type] || "Unknown";

  // Death/victory marker placement
  let deathFloor = null;
  if (!r.won) {
    const lastAct = path[path.length - 1];
    const lastNode = lastAct?.nodes?.[lastAct.nodes.length - 1];
    if (lastNode) deathFloor = lastNode.floor;
  }

  // Per-act node count summary so the closed-state of each <details>
  // tells you what you'd see if you opened it ("12 nodes · 1 elite, 2 rests").
  // "9 enemies · 2 elites · 1 boss": real plurals ("enemys", "bosss" before).
  // No-break spaces keep each count with its noun, and each "·" with the
  // item before it, so a wrapped line never starts with a dot.
  const NODE_PLURAL = { combat: "enemies", elite: "elites", shop: "merchants", rest: "rests", event: "unknowns", chest: "treasures", boss: "bosses" };
  const summarize = (nodes) => {
    const counts = {};
    nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
    const order = ["combat", "elite", "shop", "rest", "event", "chest", "boss"];
    return order
      .filter((k) => counts[k])
      .map((k) => `${counts[k]}\u00a0${counts[k] > 1 ? NODE_PLURAL[k] : nodeLabel(k).toLowerCase()}`)
      .join("\u00a0· ");
  };

  // Legend: every icon used in the timeline, captioned. Renders at
  // the bottom of the map view so a first-time user can decode the
  // strip immediately.
  const legendTypes = [
    { type: "event",  label: "Unknown" },
    { type: "shop",   label: "Merchant" },
    { type: "chest",  label: "Treasure" },
    { type: "rest",   label: "Rest" },
    { type: "combat", label: "Enemy" },
    { type: "elite",  label: "Elite" },
    { type: "boss",   label: "Boss" },
  ];

  return `
    <div class="run-detail-section run-detail-path-section">
      <div class="run-detail-section-head">
        <h3 class="run-detail-section-title">Act timeline — the path you took</h3>
        <span class="run-detail-section-count">${path.reduce((n, a) => n + (a.nodes?.length || 0), 0)}&nbsp;nodes</span>
      </div>
      <p class="run-detail-section-sub muted small">
        The actual sequence of rooms you walked through, taken from your <code>.run</code> file. We don't show
        the unvisited branches because the save data only records nodes you&nbsp;visited.
      </p>
      ${path.map((act, idx) => {
        if (!act.nodes || !act.nodes.length) return "";
        const summary = summarize(act.nodes);
        // EVERY act starts collapsed. Users open whatever they want.
        // The DIED HERE / VICTORY flag chip on the relevant act
        // header tells them where to look without auto-opening it.
        const isFinalAct = idx === path.length - 1;
        const hasDeath = !r.won && isFinalAct;
        const hasVictory = r.won && isFinalAct;
        return `
          <details class="path-act">
            <summary class="path-act-summary">
              <span class="path-act-chevron" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </span>
              <span class="path-act-label">${esc(actLabel(act.act))}</span>
              <span class="path-act-meta">${esc(summary)}</span>
              ${hasDeath ? '<span class="path-act-flag path-act-flag--death">DIED HERE</span>' : ""}
              ${hasVictory ? '<span class="path-act-flag path-act-flag--win">VICTORY</span>' : ""}
            </summary>
            <div class="path-act-strip">
              ${act.nodes.map((n, i) => {
                const isDeath = n.floor === deathFloor;
                const isWin = r.won && i === act.nodes.length - 1 && act === path[path.length - 1];
                const cls = `path-node path-node--${esc(n.type)}${isDeath ? " path-node--death" : ""}${isWin ? " path-node--win" : ""}`;
                return `
                  <div class="${cls}" title="Floor ${n.floor} · ${esc(nodeLabel(n.type))}${isDeath ? " · DIED HERE" : ""}${isWin ? " · VICTORY" : ""}">
                    <span class="path-node-icon" data-node-type="${esc(n.type)}" aria-hidden="true"></span>
                    <span class="path-node-floor">${n.floor}</span>
                  </div>
                  ${i < act.nodes.length - 1 ? '<span class="path-connector" aria-hidden="true"></span>' : ""}`;
              }).join("")}
            </div>
          </details>`;
      }).join("")}

      <div class="path-legend" aria-label="Map icon legend">
        <span class="path-legend-title">Legend</span>
        <div class="path-legend-grid">
          ${legendTypes.map((l) => `
            <div class="path-legend-item">
              <span class="path-node-icon path-legend-icon" data-node-type="${esc(l.type)}" aria-hidden="true"></span>
              <span class="path-legend-label">${esc(l.label)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>`;
}

// =========================================================================
// Section filters
// -------------------------------------------------------------------------
// Overview → By character: game mode (All / Standard / Blitz / Dread) and
// one ascension level. Ascensions: one climber, on the Standard or Blitz
// ladder (the spire, tiers and breakdown all follow). The filter sits on
// the section it changes and nothing else on the page moves with it.
//
// The rules live in lib/stat-filters.js. The saved choice is kept as the
// player made it and cut down to the loaded runs on every render
// (Filters.sanitize*), so a choice the data cannot show (Blitz, after a
// switch to main-branch saves) is never applied unseen. Both looks read
// the same state.
// =========================================================================
const STORAGE_STAT_FILTERS = "vault.web.statfilters.v1";
let statFilters = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_STAT_FILTERS) || "null");
    if (saved && typeof saved === "object") return Object.freeze({ chars: saved.chars ?? null, spire: saved.spire ?? null });
  } catch {}
  return Object.freeze({ chars: null, spire: null });
})();

function persistStatFilters() {
  try { localStorage.setItem(STORAGE_STAT_FILTERS, JSON.stringify(statFilters)); } catch {}
}

/** A character's current win streak, or 0 when it is too short to show. */
function shownStreak(streaks, key) {
  const n = streaks.get(key) || 0;
  return n >= Filters.STREAK_SHOWN_FROM ? n : 0;
}

/** @param {number} n @param {string} noun */
function pluralRuns(n, noun = "run") {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The By character section's filter, runs, per-character report and streaks.
 *  An unfiltered section reuses the page's report. */
function characterSection(report) {
  const filter = Filters.sanitizeCharacterFilter(statFilters.chars, parsedRuns);
  const isFiltered = Filters.characterFilterLabel(filter) !== "";
  const runs = isFiltered ? Filters.filterRuns(parsedRuns, filter) : parsedRuns;
  return {
    filter,
    runs,
    report: isFiltered ? Stats.summarize(runs) : report,
    streaks: Filters.winStreaksByCharacter(runs),
  };
}

/** Mode chips; null when every loaded run is a standard one (no control). */
function characterModeOptions(filter) {
  const choices = Filters.modeChoices(parsedRuns);
  if (!choices) return null;
  const counts = Filters.modeCounts(parsedRuns);
  return choices
    .map((id) => ({
      value: id,
      label: Filters.MODE_LABELS[id],
      pressed: filter.mode === id,
      title: id === "all" ? `Every run (${parsedRuns.length})` : pluralRuns(counts[id], `${Filters.MODE_LABELS[id]} run`),
    }));
}

/** Ascension picker: every level of the mode's ladder that has runs, highest first. */
function characterLevelOptions(filter) {
  if (!Filters.ladderOf(filter.mode)) return [{ value: "", label: "No levels in Dread", selected: true }];
  return [
    { value: "", label: filter.mode === "blitz" ? "All Blitz levels" : "All ascensions", selected: filter.asc === null },
    ...Filters.ascensionLevels(parsedRuns, filter.mode).map((b) => ({
      value: String(b.level),
      label: `A${b.level} · ${pluralRuns(b.runs)}`,
      selected: filter.asc === b.level,
    })),
  ];
}

/** View model for the new look's By character filters. */
function buildCharacterFilterModel(filter, shownRuns) {
  const label = Filters.characterFilterLabel(filter);
  return {
    modes: characterModeOptions(filter),
    levels: characterLevelOptions(filter),
    levelsDisabled: !Filters.ladderOf(filter.mode),
    label,
    // Short on purpose: a banner can be 76px wide, and the summary line
    // above the cards already names the filter.
    emptyText: label ? "No runs" : "No runs yet",
    shownRuns,
    totalRuns: parsedRuns.length,
  };
}

/** The Ascensions section's filter and the runs its spire is built from. */
function spireSection() {
  const filter = Filters.sanitizeSpireFilter(statFilters.spire, parsedRuns);
  return { filter, runs: Filters.filterRuns(parsedRuns, { character: filter.character, mode: filter.ladder }) };
}

/** Climber chips (one per roster character, disabled without runs on the
 *  ladder) and Ladder chips (only when there are Blitz runs). */
function spireFilterOptions(filter) {
  const onLadder = Filters.filterRuns(parsedRuns, { mode: filter.ladder });
  const played = new Set(onLadder.map((r) => r.character).filter(Boolean));
  const ladderName = filter.ladder === "blitz" ? "Blitz " : "";
  const climbers = [
    { value: "all", label: "All", pressed: filter.character === "all" },
    ...RUN_FILTER_CHARACTERS.map((key) => {
      const name = prettifyCharacterName(key);
      const hasRuns = played.has(key);
      return {
        value: key,
        label: name,
        pressed: filter.character === key,
        charKey: key,
        disabled: !hasRuns,
        title: hasRuns ? "" : `No ${ladderName}runs as ${name} yet`,
      };
    }),
  ];
  const blitzRuns = Filters.modeCounts(parsedRuns).blitz;
  const ladders = blitzRuns > 0
    ? [
        { value: "standard", label: "Standard", pressed: filter.ladder === "standard", title: "A0–A10" },
        { value: "blitz", label: "Blitz", pressed: filter.ladder === "blitz", title: pluralRuns(blitzRuns, "Blitz run") },
      ]
    : null;
  return { climbers, ladders };
}

/** "Ironclad", "Blitz", "Ironclad · Blitz", or "" for the default spire. */
function spireFilterLabel(filter) {
  return [filter.character === "all" ? "" : prettifyCharacterName(filter.character), filter.ladder === "blitz" ? "Blitz" : ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Applies a filter control. `data-stat-filter` is "<section>.<key>":
 * chars.mode / chars.asc / chars.clear, spire.character / spire.ladder /
 * spire.clear. Re-renders the open tab and puts focus back on the same
 * control, since the re-render replaced it.
 */
function applyStatFilter(control, value) {
  const [section, key] = String(control.dataset.statFilter || "").split(".");
  let next = null;
  if (section === "chars") {
    const current = Filters.sanitizeCharacterFilter(statFilters.chars, parsedRuns);
    if (key === "clear") next = { ...Filters.DEFAULT_CHARACTER_FILTER };
    else if (key === "mode") next = Filters.withMode(current, value);
    else if (key === "asc") next = { ...current, asc: value === "" ? null : Number(value) };
    if (next) next = Filters.sanitizeCharacterFilter(next, parsedRuns);
  } else if (section === "spire") {
    const current = Filters.sanitizeSpireFilter(statFilters.spire, parsedRuns);
    if (key === "clear") next = { ...Filters.DEFAULT_SPIRE_FILTER };
    else if (key === "character") next = { ...current, character: value };
    else if (key === "ladder") next = { ...current, ladder: value };
    if (next) next = Filters.sanitizeSpireFilter(next, parsedRuns);
  }
  if (!next) return;
  statFilters = Object.freeze({ ...statFilters, [section]: next });
  persistStatFilters();
  if (!TABS_WITH_DATA.includes(activeTab)) return;
  renderStatsTab(activeTab);
  const scope = document.getElementById(`${activeTab}-body`) || document;
  const firstControl = `[data-stat-filter^="${section}."]:not(:disabled)`;
  const sameControl = control.tagName === "SELECT"
    ? `select[data-stat-filter="${section}.${key}"]`
    : `button[data-stat-filter="${section}.${key}"][data-value="${cssEscape(value)}"]`;
  const target = (key === "clear" ? null : scope.querySelector(sameControl)) || scope.querySelector(firstControl);
  if (target) target.focus({ preventScroll: true });
}

// ---- Classic look: the same controls in the Runs tab's filter-bar markup
// (.run-filters / .chart-chip / .h-sort-select), so they pick up classic's
// existing desktop and phone styling.

/** @param {string} filter @param {string} label @param {ReadonlyArray<{ value: string, label: string, pressed: boolean, disabled?: boolean, title?: string, charKey?: string }>} options */
function classicFilterGroup(filter, label, options) {
  const chips = options.map((o) => {
    const char = o.charKey ? ` data-char style="--char-color:${charTheme(o.charKey).color}"` : "";
    const title = o.title ? ` title="${esc(o.title)}"` : "";
    return `<button class="chart-chip" type="button" data-stat-filter="${esc(filter)}" data-value="${esc(o.value)}" aria-pressed="${o.pressed}"${char}${title}${o.disabled ? " disabled" : ""}>${esc(o.label)}</button>`;
  }).join("");
  return `
      <div class="run-filter-group" role="group" aria-label="${esc(label)}">
        <span class="run-filter-label" aria-hidden="true">${esc(label)}</span>
        <span class="run-filter-chips">${chips}</span>
      </div>`;
}

/** @param {string} filter @param {string} label @param {ReadonlyArray<{ value: string, label: string, selected: boolean }>} options @param {boolean} disabled */
function classicFilterSelect(filter, label, options, disabled) {
  const items = options.map((o) => `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`).join("");
  return `
      <label class="run-filter-group stat-filter-select">
        <span class="run-filter-label">${esc(label)}</span>
        <select class="h-sort-select" data-stat-filter="${esc(filter)}"${disabled ? ' disabled title="Dread runs have no ascension level"' : ""}>${items}</select>
      </label>`;
}

/** @param {string} filter @param {string} label @param {number} shown @param {number|null} total */
function classicFilterSummary(filter, label, shown, total) {
  const count = total === null ? pluralRuns(shown) : `${shown} of ${total} runs`;
  return `<p class="run-filter-summary">Showing <strong>${esc(label)}</strong> &middot; ${count}. <button class="run-filter-clear" type="button" data-stat-filter="${esc(filter)}" data-value="">Clear</button></p>`;
}

/** Classic Overview: mode chips (only with Blitz/Dread runs) and the ascension picker. */
function renderClassicCharacterFilters(filter, shownRuns) {
  const model = buildCharacterFilterModel(filter, shownRuns);
  const modes = model.modes ? classicFilterGroup("chars.mode", "Mode", model.modes) : "";
  const summary = model.label ? classicFilterSummary("chars.clear", model.label, model.shownRuns, model.totalRuns) : "";
  // A lone picker (standard runs only, nothing picked) goes without the panel.
  const bare = !model.modes && !model.label ? " is-bare" : "";
  return `
    <div class="run-filters stat-filters stat-filters--chars${bare}" role="region" aria-label="Filter the character cards">
      ${modes}
      ${classicFilterSelect("chars.asc", "Ascension", model.levels, model.levelsDisabled)}
      ${summary}
    </div>`;
}

/** Classic Ascensions: climber chips and, with Blitz runs, the ladder chips. */
function renderClassicSpireFilters(filter, shownRuns) {
  const { climbers, ladders } = spireFilterOptions(filter);
  const label = spireFilterLabel(filter);
  const total = filter.character === "all" ? null : Filters.filterRuns(parsedRuns, { mode: filter.ladder }).length;
  return `
    <div class="run-filters stat-filters stat-filters--spire" role="region" aria-label="Filter the ascension stats">
      ${classicFilterGroup("spire.character", "Climber", climbers)}
      ${ladders ? classicFilterGroup("spire.ladder", "Ladder", ladders) : ""}
      ${label ? classicFilterSummary("spire.clear", label, shownRuns, total) : ""}
    </div>`;
}

function wireStatFilters() {
  document.addEventListener("click", (e) => {
    const button = e.target.closest?.("button[data-stat-filter]");
    if (!button || button.disabled) return;
    e.preventDefault();
    applyStatFilter(button, button.dataset.value || "");
  });
  document.addEventListener("change", (e) => {
    const select = e.target.closest?.("select[data-stat-filter]");
    if (select) applyStatFilter(select, select.value);
  });
}

// =========================================================================
// Recent Runs filters
// =========================================================================
function wireRunFilters() {
  document.addEventListener("click", (e) => {
    const chip = e.target.closest('[data-filter-kind]');
    if (chip && chip.tagName === "BUTTON") {
      const kind = chip.dataset.filterKind;
      const value = chip.dataset.filterValue;
      if (kind && value && (kind === "character" || kind === "outcome" || kind === "ascensionTier" || kind === "mode")) {
        runFilters[kind] = value;
        // Blitz and Dread levels are not standard-ladder tiers.
        if (kind === "mode" && !runTiersApply(value)) runFilters.ascensionTier = "all";
        persistRunFilters();
        if (activeTab === "runs") renderStatsTab("runs");
      }
      return;
    }
    const clear = e.target.closest('[data-action="clear-filters"]');
    if (clear) {
      e.preventDefault();
      runFilters = { ...EMPTY_RUN_FILTERS };
      runsDateRange = null;
      persistRunFilters();
      if (activeTab === "runs") renderStatsTab("runs");
    }
  });

  // Search input is debounced to keep typing snappy without re-renders
  // on every keystroke, but still feels responsive.
  let searchTimer = null;
  document.addEventListener("input", (e) => {
    const input = e.target.closest('input[data-filter-kind="search"]');
    if (!input) return;
    clearTimeout(searchTimer);
    const value = input.value;
    searchTimer = setTimeout(() => {
      runFilters.search = value;
      persistRunFilters();
      if (activeTab === "runs") {
        // Surgical update: only re-render the run list and the summary
        // line, NOT the entire filter strip — so the input keeps focus
        // and the caret position. Falls back to full re-render if the
        // surgical path can't find the elements.
        const $body = document.getElementById("runs-body");
        if (!$body) return;
        // Easiest correct option: full re-render then re-focus the
        // input. Fast enough for the dataset sizes we deal with
        // (~hundreds of runs at most).
        const caret = input.selectionStart;
        renderStatsTab("runs");
        const refocus = document.querySelector('input[data-filter-kind="search"]');
        if (refocus) {
          refocus.focus();
          try { refocus.setSelectionRange(caret, caret); } catch {}
        }
      }
    }, 180);
  });
}

let currentShareRun = null;

function wireShareModal() {
  const $modal  = document.getElementById("share-modal");
  const $close  = document.getElementById("share-modal-close");
  const $dl     = document.getElementById("share-download");
  const $copy   = document.getElementById("share-copy-image");
  const $copyMd = document.getElementById("share-copy-md");

  if (!$modal || !$close || !$dl || !$copy || !$copyMd) {
    console.warn("[Vault] share modal elements missing — share UI disabled");
    return;
  }

  $close.addEventListener("click", closeShareModal);
  $modal.addEventListener("click", (e) => {
    if (e.target.id === "share-modal") closeShareModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$modal.hidden) closeShareModal();
  });

  $dl.addEventListener("click", () => {
    if (!currentShareRun) return;
    const canvas = document.getElementById("share-canvas");
    canvas.toBlob((blob) => {
      if (!blob) {
        setShareHint("Couldn't render the image. Try Copy Markdown instead.", "error");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `spirevault-${shareFilenameSlug(currentShareRun)}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setShareHint("Saved! Drop it into Discord, Reddit, or X.", "success");
    }, "image/png");
  });

  $copy.addEventListener("click", async () => {
    if (!currentShareRun) return;
    const canvas = document.getElementById("share-canvas");
    try {
      // ClipboardItem with PNG only works on Chromium + Safari behind a
      // user gesture, never on Firefox. Fall back to a clear hint there.
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        setShareHint("Your browser can't copy images. Use Download PNG instead.", "error");
        return;
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("toBlob failed");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setShareHint("Image copied. Paste it directly into Discord.", "success");
    } catch (err) {
      console.warn("[Vault] copy image failed", err);
      setShareHint("Couldn't copy. Try Download PNG instead.", "error");
    }
  });

  $copyMd.addEventListener("click", async () => {
    if (!currentShareRun) return;
    const md = buildShareMarkdown(currentShareRun);
    try {
      await navigator.clipboard.writeText(md);
      setShareHint("Markdown copied. Paste in Discord, Reddit, or any chat.", "success");
    } catch {
      // Final fallback: select-and-copy via a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = md;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
      setShareHint("Markdown copied. Paste in Discord, Reddit, or any chat.", "success");
    }
  });

  // Delegated click handler for the per-row Share button. Lives on the
  // document instead of #runs-body so it survives re-renders without
  // having to re-attach.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="share-run"]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.runId;
    const run = parsedRuns.find((r) => String(r.id) === String(id));
    if (run) {
      openShareModal(run);
      vaultGtagEvent("run_share_open", {
        character: String(run.character || "unknown"),
        ascension: Number.isFinite(run.ascension) ? run.ascension : 0,
        won: run.won === true ? 1 : 0,
        floor: Number.isFinite(run.floorReached) ? run.floorReached : 0,
      });
    }
  });
}

function openShareModal(run) {
  currentShareRun = run;
  forceHideRunRowPreview();
  const $modal = document.getElementById("share-modal");
  setShareHint("Drop the image straight into Discord, Reddit, or X.", "");
  // Reset the community-share status so a previous "Shared!" pill
  // doesn't carry over to a new modal open.
  setShareCommunityStatus("", "");
  const $cap = document.getElementById("share-community-caption");
  const $cnt = document.getElementById("share-community-caption-count");
  if ($cap) $cap.value = "";
  if ($cnt) $cnt.textContent = "0 / 280";
  wireShareToCommunity();
  paintShareCard(run);
  $modal.hidden = false;
  document.body.style.overflow = "hidden";
}

/** Paints the share canvas for `run` in the current look.
 *
 *  Classic: first draw with whatever's already cached (typically nothing
 *  on the first share of a session), then async-load the character
 *  portrait, every relic icon, and the highlighted card art in parallel
 *  and re-draw with the images embedded once they're ready.
 *
 *  New look: the card is drawn by lib/ui/share-card.js instead. */
function paintShareCard(run) {
  if (deferUntilUIReady(() => { if (currentShareRun === run) paintShareCard(run); })) return;
  if (UI) {
    void paintShareCardNext(run);
    return;
  }
  drawShareCard(run);
  void preloadAndRedrawShareCard(run);
}

/** The cards worth showing on the new share card: highlightCards' order
 *  (upgrades first), with every Strike and Defend moved to the back. A
 *  `.run` file names the basics per character (STRIKE_FOOL, DEFEND_R…), so
 *  this goes by the card's name rather than a list of ids. */
function showcaseCards(run) {
  const isBasic = (id) => /^(strike|defend)\b/i.test(cardLabel(id));
  const cards = highlightCards(run);
  return [...cards.filter((id) => !isBasic(id)), ...cards.filter(isBasic)];
}

/** What the new share card shows for `run`
 *  (`ShareCardModel` in lib/ui/share-card.js). */
function shareCardModel(run, limits) {
  const facts = [];
  if (isLadderRun(run)) {
    if (Number.isFinite(run.ascension)) {
      // Clamped to the STS2 ceiling, as on the classic card.
      facts.push({ label: "Ascension", value: String(Math.max(0, Math.min(STS2_MAX_ASCENSION, run.ascension))) });
    }
  } else if (runAscText(run)) {
    facts.push({ label: "", value: runAscText(run) });
  }
  if (Number.isFinite(run.floorReached)) facts.push({ label: "Floor", value: String(run.floorReached) });
  const time = formatPlayTimeStrict(run.playTimeSeconds);
  if (time) facts.push({ label: "Time", value: time });
  const date = run.endedAt || run.startedAt;
  if (date) facts.push({ label: "", value: date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) });
  if (run.seed) facts.push({ label: "Seed", value: String(run.seed).slice(0, 14) });

  const relicIds = Array.isArray(run.relics) ? run.relics : [];
  const cardIds = showcaseCards(run);
  return {
    characterKey: String(run.character || "").trim().toLowerCase(),
    characterName: run.character ? prettifyCharacterName(run.character) : "Unknown",
    characterColor: charTheme(run.character).color,
    outcome: run.won === true ? "win" : run.won === false ? "loss" : "unknown",
    facts,
    relics: relicIds.slice(0, limits.relics).map((id) => ({ id, label: relicLabel(id), src: relicImageSrc(id) })),
    relicTotal: relicIds.length,
    // Drawn at about 275px wide: the large faces, where there are any.
    cards: cardIds.slice(0, limits.cards).map((id) => ({ id, label: cardLabel(id), src: largeCardImageSrc(cardImageSrc(id)) })),
    deckSize: Array.isArray(run.deckAtEnd) ? run.deckAtEnd.length : 0,
    cardKinds: cardIds.length,
    roomKey: `${run.seed || ""}|${run.character || ""}|${date ? date.getTime() : ""}`,
  };
}

/** New look: paints the share card with shapes and text straight away,
 *  then again once its art and fonts have loaded. A failed image only
 *  costs that one picture (the card falls back to a letter or a name). If
 *  the new card cannot be drawn at all, the classic one is, so there is
 *  always something to download. */
async function paintShareCardNext(run) {
  try {
    await paintInkedShareCard(run);
  } catch (err) {
    console.warn("[Vault] new share card failed; drawing the classic card", err);
    if (currentShareRun !== run) return;
    drawShareCard(run);
    void preloadAndRedrawShareCard(run);
  }
}

async function paintInkedShareCard(run) {
  const ShareCard = UI.ShareCard;
  const canvas = document.getElementById("share-canvas");
  if (!canvas) return;
  const model = shareCardModel(run, ShareCard.SHARE_CARD_LIMITS);
  const palette = ShareCard.readSharePalette();
  ShareCard.drawShareCard(canvas, model, null, palette);
  const art = ShareCard.shareCardArt(model);
  const [climber, planes, relicImgs, cardImgs] = await Promise.all([
    loadImageCached(art.climber),
    Promise.all(art.planes.map((src) => loadImageCached(src))),
    Promise.all(model.relics.map((relic) => loadImageCached(relic.src))),
    Promise.all(model.cards.map((card) => loadImageCached(card.src))),
    ShareCard.loadShareFonts(),
  ]);
  // Bail if the user closed the modal, or opened another run, mid-load.
  if (currentShareRun !== run) return;
  const relics = new Map();
  model.relics.forEach((relic, i) => { if (relicImgs[i]) relics.set(relic.id, relicImgs[i]); });
  const cards = new Map();
  model.cards.forEach((card, i) => { if (cardImgs[i]) cards.set(card.id, cardImgs[i]); });
  ShareCard.drawShareCard(canvas, model, { climber, planes, relics, cards }, palette);
}

/** Module-scoped image cache so a second share within the same session
 *  paints the rich version instantly instead of re-fetching the WebPs.
 *  Keyed by URL so it survives across runs that share relics/cards. */
const SHARE_IMAGE_CACHE = new Map();

async function loadImageCached(src) {
  if (!src) return null;
  if (SHARE_IMAGE_CACHE.has(src)) return SHARE_IMAGE_CACHE.get(src);
  try {
    const img = await loadImage(src);
    SHARE_IMAGE_CACHE.set(src, img);
    return img;
  } catch {
    SHARE_IMAGE_CACHE.set(src, null);
    return null;
  }
}

/** Preload character portrait + every relic icon + every highlighted
 *  card art in parallel, then redraw the share canvas with the image
 *  maps embedded. Keys are the original ids (relic id, card id) so the
 *  draw routine can look them up in O(1) per row.
 *
 *  Failed loads silently degrade to the text-only fallback for that
 *  individual row (the share canvas as a whole still renders), which
 *  matters because the asset manifest may legitimately not have art
 *  for a brand-new card the user is the first to play. */
async function preloadAndRedrawShareCard(run) {
  const relicIds = (run.relics || []).slice(0, SHARE_RELICS_MAX);
  const cardIds  = highlightCards(run).slice(0, SHARE_CARDS_MAX);

  const [portrait, relicImgs, cardImgs] = await Promise.all([
    loadImageCached(characterImageSrc(run.character)),
    Promise.all(relicIds.map((id) => loadImageCached(relicImageSrc(id)))),
    Promise.all(cardIds.map((id)  => loadImageCached(cardImageSrc(id)))),
  ]);
  // Bail if the user closed the modal mid-load.
  if (currentShareRun !== run) return;

  const relicImages = new Map();
  relicIds.forEach((id, i) => { if (relicImgs[i]) relicImages.set(id, relicImgs[i]); });
  const cardImages = new Map();
  cardIds.forEach((id, i)  => { if (cardImgs[i])  cardImages.set(id,  cardImgs[i]); });

  drawShareCard(run, {
    characterPortrait: portrait,
    relicImages,
    cardImages,
  });
}

/** Max items per column on the share card. Set so 8 image rows + the
 *  "+ N more" overflow line all fit inside the column body without
 *  overlapping the brand footer. */
const SHARE_RELICS_MAX = 8;
const SHARE_CARDS_MAX  = 8;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // safe for same-origin assets
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

function closeShareModal() {
  const $modal = document.getElementById("share-modal");
  if ($modal) $modal.hidden = true;
  document.body.style.overflow = "";
  currentShareRun = null;
}

function setShareHint(text, kind) {
  const $hint = document.getElementById("share-hint");
  if (!$hint) return;
  $hint.textContent = text;
  $hint.classList.remove("is-success", "is-error");
  if (kind === "success") $hint.classList.add("is-success");
  if (kind === "error")   $hint.classList.add("is-error");
}

function shareFilenameSlug(run) {
  const ch = (run.character || "unknown").toLowerCase();
  const asc = Number.isFinite(run.ascension) ? `-a${run.ascension}` : "";
  const out = run.won === true ? "win" : run.won === false ? "loss" : "run";
  return `${ch}${asc}-${out}-${todayStamp()}`;
}

/** Markdown rendering used by Copy as Markdown. Mirrors ShareCard.swift's
 *  markdown so a run shared from the desktop app and from the web look
 *  identical in a Discord embed or Reddit post. */
function buildShareMarkdown(run) {
  const charName = run.character ? prettifyCharacterName(run.character) : "Unknown";
  const outcome  = run.won === true ? "✅ **VICTORY**" : "💀 **DEFEAT**";
  const asc      = runAscText(run) || "?";
  const floor    = Number.isFinite(run.floorReached) ? `f${run.floorReached}` : "?";
  const dur      = formatPlayTimeStrict(run.playTimeSeconds) || "?";
  const relics   = (run.relics || []).slice(0, 6).map((r) => `\`${relicLabel(r)}\``).join(", ");
  const cards    = highlightCards(run).slice(0, 8).map((c) => `\`${cardLabel(c)}\``).join(", ");
  return [
    `${outcome} — **${charName}** · ${asc} · ${floor} · ${dur}`,
    `**Relics (${(run.relics || []).length}):** ${relics || "(none)"}`,
    `**Deck (${(run.deckAtEnd || []).length}):** ${cards || "(none)"}`,
    `_via SpireVault — github.com/c3rooks/SpireVault_`,
  ].join("\n");
}

/** Match ShareCard.swift's highlightCards: upgrades first, then non-basic
 *  cards, then basic strikes/defends. Tailored for "the cards worth
 *  showing off" in a shared image. */
function highlightCards(run) {
  const basic = new Set([
    "strike", "strike_red", "strike_silent", "strike_defect",
    "strike_regent", "strike_necrobinder",
    "defend", "defend_red", "defend_silent", "defend_defect",
    "defend_regent", "defend_necrobinder",
  ]);
  const deck = run.deckAtEnd || [];
  const upgraded = deck.filter((c) => c.includes("+"));
  const nonBasic = deck.filter((c) => !c.includes("+") && !basic.has(c));
  const basicCards = deck.filter((c) => !c.includes("+") && basic.has(c));
  // Dedup, preserving order
  const seen = new Set();
  return [...upgraded, ...nonBasic, ...basicCards].filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/** Canvas 2D rendering of the share card. 880x540 at 2x device pixels for
 *  retina-friendly downloads. Hand-laid out to mirror ShareCard.swift.
 *  Pass `opts.characterPortrait` (an HTMLImageElement) to render the
 *  actual character art inside the corner glyph tile instead of the
 *  initial-letter fallback. */
function drawShareCard(run, opts = {}) {
  const canvas = document.getElementById("share-canvas");
  if (!canvas) return;
  // v50: bumped from 880x540 to 880x620 to fit the new image-rich
  // columns (8 rows × 38px tall thumbs + headers + "+ N more" overflow
  // + footer). The visible aspect ratio in CSS (.share-preview-wrap)
  // is updated in lockstep so the preview never letterboxes.
  const W = 880, H = 620;
  const dpr = 2;
  // Resize the backing store for retina-crisp downloads. We deliberately
  // do NOT set canvas.style.width/height — the stylesheet handles fitting
  // the preview into the modal via width:100% + aspect-ratio:880/540, so
  // overriding it inline would force the canvas to 880px and clip on
  // narrow modals. The downloaded PNG is still 1760x1080 either way
  // because that's the backing-store size, independent of CSS layout.
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const theme = charTheme(run.character);
  const charColor = theme.color;
  const charName = run.character ? prettifyCharacterName(run.character) : "Unknown";
  const isWin = run.won === true;

  // ── Background: solid dark + character-tinted radial in the corner ──
  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, W, H);
  const radial = ctx.createRadialGradient(40, 40, 40, 40, 40, 520);
  radial.addColorStop(0, hexA(charColor, 0.30));
  radial.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, W, H);

  // ── Outer rounded border + character stripe down the left edge ──
  roundRectStroke(ctx, 1, 1, W - 2, H - 2, 18, hexA(charColor, 0.4), 1.5);
  ctx.fillStyle = charColor;
  ctx.fillRect(0, 0, 6, H);

  // Inner padding
  const PAD = 28;

  // ── Header: glyph + title block + outcome badge ──
  const glyphSize = 78;
  const glyphX = PAD;
  const glyphY = PAD;
  // Tinted background tile
  roundRectFill(ctx, glyphX, glyphY, glyphSize, glyphSize, 16, hexA(charColor, 0.18));
  roundRectStroke(ctx, glyphX, glyphY, glyphSize, glyphSize, 16, hexA(charColor, 0.5), 1.5);
  if (opts.characterPortrait) {
    // Clip to the rounded tile, draw the actual portrait as cover.
    ctx.save();
    roundRectPath(ctx, glyphX + 1, glyphY + 1, glyphSize - 2, glyphSize - 2, 15);
    ctx.clip();
    const img = opts.characterPortrait;
    // object-fit: cover algorithm
    const scale = Math.max(glyphSize / img.width, glyphSize / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = glyphX + (glyphSize - dw) / 2;
    const dy = glyphY + (glyphSize - dh) / 2;
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();
  } else {
    // Fallback: first letter of character name in the character color.
    ctx.fillStyle = charColor;
    ctx.font = "bold 40px 'Inter', 'Helvetica Neue', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((charName[0] || "?").toUpperCase(), glyphX + glyphSize / 2, glyphY + glyphSize / 2 + 2);
  }

  // Title and pills
  const titleX = glyphX + glyphSize + 18;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f4f6fa";
  ctx.font = "900 32px 'Inter', 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(charName, titleX, glyphY + 32);

  // Pill row
  const pillY = glyphY + 50;
  let pillX = titleX;
  if (Number.isFinite(run.ascension)) {
    // Clamp to the STS2 ascension ceiling so any rogue legacy save
    // imported with an STS1 value (A11–A20) never renders on a card
    // that gets shared to Discord/Reddit/X.
    const ascDisplay = Math.max(0, Math.min(STS2_MAX_ASCENSION, run.ascension));
    pillX += drawPill(ctx, pillX, pillY, isLadderRun(run) ? `ASCENSION ${ascDisplay}` : runAscText(run).toUpperCase(), "#d4af37", true) + 8;
  }
  if (Number.isFinite(run.floorReached)) {
    pillX += drawPill(ctx, pillX, pillY, `FLOOR ${run.floorReached}`, "#9aa3b2", false) + 8;
  }
  if (Number.isFinite(run.playTimeSeconds) && run.playTimeSeconds > 0) {
    const dur = formatPlayTimeStrict(run.playTimeSeconds);
    pillX += drawPill(ctx, pillX, pillY, dur, "#9aa3b2", false) + 8;
  }
  // Date
  const date = run.endedAt || run.startedAt;
  if (date) {
    const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    ctx.fillStyle = "#6b7280";
    ctx.font = "600 11px 'Inter', sans-serif";
    ctx.fillText(dateStr, pillX, pillY + 14);
  }

  // Outcome badge (top-right)
  const badgeText = isWin ? "VICTORY" : "DEFEAT";
  const badgeColor = isWin ? "#6dd97c" : "#ff5f6d";
  const badgeBright = isWin ? "#8eef9b" : "#ff7c87";
  ctx.font = "900 22px 'Inter', sans-serif";
  const badgeMetrics = ctx.measureText(badgeText);
  const badgeW = badgeMetrics.width + 28;
  const badgeH = 56;
  const badgeX = W - PAD - badgeW;
  const badgeY = glyphY;
  roundRectFill(ctx, badgeX, badgeY, badgeW, badgeH, 10, hexA(badgeColor, 0.20));
  roundRectStroke(ctx, badgeX, badgeY, badgeW, badgeH, 10, hexA(badgeColor, 0.5), 1);
  ctx.fillStyle = badgeBright;
  ctx.textAlign = "center";
  ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 28);
  if (run.seed) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "900 9px 'SF Mono', 'Menlo', monospace";
    const seedTxt = `SEED ${String(run.seed).slice(0, 14)}`;
    ctx.fillText(seedTxt, badgeX + badgeW / 2, badgeY + 46);
  }
  ctx.textAlign = "left";

  // ── Divider ──
  const dividerY = glyphY + glyphSize + 22;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, dividerY);
  ctx.lineTo(W - PAD, dividerY);
  ctx.stroke();

  // ── Two columns: Relics (gold) | Deck (char color) ──
  // v50: each row is now an image+label pair so a viewer can recognize
  // the relic/card at a glance, not just read its name. The image
  // maps are pre-loaded in preloadAndRedrawShareCard (text-only
  // fallback paints first, then the full version overwrites once art
  // lands).
  const colsTop = dividerY + 18;
  const colW = (W - PAD * 2 - 24) / 2;
  drawListColumn(ctx, PAD,                colsTop, colW,
    "RELICS",
    (run.relics || []).slice(0, SHARE_RELICS_MAX),
    (run.relics || []).length,
    "#d4af37", false, relicLabel,
    opts.relicImages || null, /* isCard */ false);
  drawListColumn(ctx, PAD + colW + 24,    colsTop, colW,
    `DECK · ${(run.deckAtEnd || []).length} CARDS`,
    highlightCards(run).slice(0, SHARE_CARDS_MAX),
    highlightCards(run).length,
    charColor, true, cardLabel,
    opts.cardImages || null,  /* isCard */ true);

  // ── Footer ─────────────────────────────────────────────────────
  // This is the sole piece of branding on a card that gets screenshot,
  // reposted to Discord/Reddit/X, and re-compressed a dozen times. It
  // needs to survive a Discord thumbnail at 320px wide and STILL answer
  // the "what tool did you use to make that?" question on first glance.
  //
  // Design choices:
  //   - Filled pill with the SPIREVAULT wordmark in high contrast white
  //     on character-tinted background. Lockup is legible even after
  //     heavy JPEG compression.
  //   - Tagline ("run tracker for STS2") in a dimmed shade so the
  //     wordmark leads the eye.
  //   - Short URL (app.spirevault.app) right-aligned in a monospace
  //     face so it reads as "visit this site" and not as decoration.
  //   - "Made by @c3rooks" mark sits above-right of the URL for
  //     personal attribution without being pushy.
  const footerBarY = H - 56;
  const footerBarH = 36;

  // Divider above the footer for visual separation
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, footerBarY - 8);
  ctx.lineTo(W - PAD, footerBarY - 8);
  ctx.stroke();

  // Branded wordmark pill (character-tinted) — left
  // Names prefixed `brand` to avoid colliding with the header pill row
  // above, which already owns `pillX`/`pillY` in this function's scope.
  // (Duplicate `const pillY` in the same function is a SyntaxError that
  // takes down the whole module.)
  const brandMarkPadX = 14;
  const brandMarkText = "SPIREVAULT";
  const brandTagText  = "Run tracker for Slay the Spire 2";
  ctx.font = "900 13px 'Inter', 'Helvetica Neue', Arial, sans-serif";
  const brandMarkW = ctx.measureText(brandMarkText).width;
  const brandPillH = 26;
  const brandPillY = footerBarY + (footerBarH - brandPillH) / 2;
  const brandPillX = PAD;
  const brandPillW = brandMarkW + brandMarkPadX * 2;

  // Gradient fill so the mark reads as a real product badge, not plain text
  const brandGrad = ctx.createLinearGradient(brandPillX, brandPillY, brandPillX + brandPillW, brandPillY);
  brandGrad.addColorStop(0, hexA(charColor, 0.95));
  brandGrad.addColorStop(1, hexA(charColor, 0.55));
  roundRectFill(ctx, brandPillX, brandPillY, brandPillW, brandPillH, 8, brandGrad);
  roundRectStroke(ctx, brandPillX, brandPillY, brandPillW, brandPillH, 8, hexA(charColor, 0.85), 1.25);

  ctx.fillStyle = "#0b0d12";
  ctx.font = "900 13px 'Inter', 'Helvetica Neue', Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(brandMarkText, brandPillX + brandMarkPadX, brandPillY + brandPillH / 2 + 1);

  // Tagline to the right of the pill
  ctx.fillStyle = "#8a93a6";
  ctx.font = "600 11px 'Inter', 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText(brandTagText, brandPillX + brandPillW + 10, brandPillY + brandPillH / 2 + 1);
  ctx.textBaseline = "alphabetic";

  // Author credit + live URL stacked on the right
  ctx.textAlign = "right";
  ctx.fillStyle = "#9aa3b2";
  ctx.font = "700 10px 'Inter', 'Helvetica Neue', Arial, sans-serif";
  ctx.fillText("Made by @c3rooks", W - PAD, footerBarY + 12);
  ctx.fillStyle = "#d4af37"; // gold — matches the ascension pill hue
  ctx.font = "800 12px 'SF Mono', 'Menlo', monospace";
  ctx.fillText("app.spirevault.app", W - PAD, footerBarY + 30);
  ctx.textAlign = "left";
}

/** Draws an outlined rounded pill with text. Returns the rendered width
 *  so the caller can flow pills horizontally. */
function drawPill(ctx, x, y, text, color, bold) {
  ctx.font = `${bold ? 800 : 700} 10px 'Inter', sans-serif`;
  const w = ctx.measureText(text).width + 16;
  const h = 18;
  roundRectFill(ctx, x, y, w, h, 9, hexA(color, bold ? 0.22 : 0.10));
  roundRectStroke(ctx, x, y, w, h, 9, hexA(color, bold ? 0.55 : 0.35), 1);
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 8, y + h / 2 + 1);
  ctx.textBaseline = "alphabetic";
  return w;
}

/** Renders one of the two list columns on the share card — image-rich
 *  header + image+label rows + "+ N more" overflow line.
 *
 *  v50: switched from text-only bullet rows to actual relic/card art
 *  pulled from the asset library. `images` is a Map<id, HTMLImageElement>
 *  populated by `preloadAndRedrawShareCard`. Rows where the image is
 *  missing fall back to a tinted placeholder tile so the column always
 *  reads as a uniform grid even when the manifest is missing one
 *  brand-new card.
 *
 *  `isCard` switches the thumbnail crop algorithm: relics are square
 *  icons rendered with `cover` to fill the tile, while cards are tall
 *  portraits rendered with a top-biased `cover` so the recognizable
 *  art (which sits in the upper third of the card frame) is what
 *  shows in the 36×36 slot — not the lower half of the card body. */
function drawListColumn(
  ctx, x, y, w,
  header, shown, totalCount,
  accent, accentIsCharColor, labelFn,
  images, isCard
) {
  // Header row: small dot icon + label
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x + 5, y + 6, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#9aa3b2";
  ctx.font = "900 11px 'Inter', sans-serif";
  ctx.fillText(header, x + 16, y + 10);

  // Items — each row is [thumb][gap][label]
  const startY = y + 28;
  const rowH   = 38;     // 32px thumb + 6px gap to next
  const thumb  = 32;
  const gap    = 12;
  const maxItems = Math.min(shown.length, 8);
  const labelX = x + thumb + gap;
  const labelMaxW = w - thumb - gap;
  for (let i = 0; i < maxItems; i++) {
    const id = shown[i];
    const ty = startY + i * rowH;
    // Thumbnail tile — tinted background so a transparent-edged WebP
    // doesn't look like it's floating, and a subtle accent border so
    // the column reads as a deliberate grid.
    roundRectFill(ctx, x, ty, thumb, thumb, 7, hexA(accent, 0.10));
    roundRectStroke(ctx, x, ty, thumb, thumb, 7, hexA(accent, 0.35), 1);
    const img = images && images.get(id);
    if (img) {
      // Clip to the rounded thumb so card / relic art doesn't poke
      // outside the tile, then draw with `cover` semantics. Cards get
      // a top-biased crop because their recognizable art sits in the
      // upper portion of the frame.
      ctx.save();
      roundRectPath(ctx, x + 1, ty + 1, thumb - 2, thumb - 2, 6);
      ctx.clip();
      const iw = img.width, ih = img.height;
      const scale = Math.max(thumb / iw, thumb / ih);
      const dw = iw * scale, dh = ih * scale;
      const dx = x + (thumb - dw) / 2;
      const dy = isCard
        ? ty + (thumb - dh) * 0.18  // top-biased for card portraits
        : ty + (thumb - dh) / 2;
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.restore();
    } else {
      // Fallback: first letter of the friendly name in the column
      // accent — keeps the row visually balanced even when art is
      // unavailable for a brand-new card.
      ctx.fillStyle = accent;
      ctx.font = "900 14px 'Inter', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const fallbackLabel = (labelFn ? labelFn(id) : prettifyId(id));
      ctx.fillText((fallbackLabel[0] || "?").toUpperCase(),
                   x + thumb / 2, ty + thumb / 2 + 1);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }
    // Label text — centered vertically against the thumb.
    ctx.fillStyle = (accentIsCharColor && id.includes("+")) ? "#d4af37" : "#f4f6fa";
    ctx.font = "700 13px 'Inter', sans-serif";
    ctx.textBaseline = "middle";
    const label = (labelFn ? labelFn(id) : prettifyId(id));
    drawTruncated(ctx, label, labelX, ty + thumb / 2 + 1, labelMaxW);
    ctx.textBaseline = "alphabetic";
  }
  if (totalCount > maxItems) {
    const ty = startY + maxItems * rowH;
    ctx.fillStyle = "#6b7280";
    ctx.font = "600 11px 'Inter', sans-serif";
    ctx.fillText(`+ ${totalCount - maxItems} more`, labelX, ty + 12);
  }
}

/** Draws text, ellipsizing if it would overflow `maxWidth`. */
function drawTruncated(ctx, text, x, y, maxWidth) {
  const ELLIPSIS = "...";
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (ctx.measureText(text.slice(0, mid) + ELLIPSIS).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  ctx.fillText(text.slice(0, lo) + ELLIPSIS, x, y);
}

/** Just-the-path version of roundRect, used for ctx.clip() etc. */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

/** Filled rounded rectangle. */
function roundRectFill(ctx, x, y, w, h, r, fillStyle) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/** Stroked rounded rectangle. */
function roundRectStroke(ctx, x, y, w, h, r, strokeStyle, lineWidth) {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Convert "#rrggbb" + alpha 0..1 → "rgba(r,g,b,a)" string. Used to keep
 *  the share card readable on machines whose Canvas2D doesn't support the
 *  CSS color() function. */
function hexA(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// =========================================================================
// Notify-me capture (news posts → POST /notify)
// =========================================================================
// Wires every <form class="news-notify"> on the page to our /notify route
// once at DOM ready. Each form carries its own `data-notify-topic` and
// `data-notify-source` attributes so the backend can later filter "who
// signed up from which surface" without us needing per-form JS.
// Idempotent — safe to call after re-renders, since we mark wired forms
// with a `data-notify-wired` attribute.
function wireNotifyForms() {
  const forms = document.querySelectorAll("form.news-notify:not([data-notify-wired])");
  if (forms.length === 0) return;
  // The /notify endpoint lives on the worker, not on the same-origin
  // /api proxy (the Pages Functions proxy explicitly whitelists routes
  // and we'd rather not have to update it for every tiny capture form).
  // Going direct is fine — /notify handles its own CORS via the
  // global ALLOWED_ORIGINS list in Backend/src/index.ts.
  const serverURL = SERVER_URL;
  forms.forEach((form) => {
    form.setAttribute("data-notify-wired", "1");
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const $email  = form.querySelector('input[name="email"]');
      const $btn    = form.querySelector('button[type="submit"]');
      const $status = form.querySelector('[data-notify-status]');
      const email   = ($email?.value || "").trim();
      const topic   = form.getAttribute("data-notify-topic") || "general";
      const source  = (form.getAttribute("data-notify-source") || "web") +
                      (IS_DESKTOP_HOST ? "+desktop" : "");
      if (!email) return;
      if ($status) {
        $status.hidden = false;
        $status.textContent = "Sending…";
        $status.classList.remove("is-error", "is-success");
      }
      if ($btn) $btn.disabled = true;
      try {
        const url = serverURL.replace(/\/$/, "") + "/notify";
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, topic, source }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) {
          if ($status) {
            $status.classList.add("is-success");
            $status.textContent = data.alreadySubscribed
              ? "You're already on the list — refreshed your timestamp."
              : "Got it. We'll email you the moment the digest is ready.";
          }
          if ($email) $email.value = "";
        } else if (r.status === 429) {
          if ($status) {
            $status.classList.add("is-error");
            $status.textContent = "Too many signups from your network. Try again in an hour.";
          }
        } else if (data?.error === "invalid_email") {
          if ($status) {
            $status.classList.add("is-error");
            $status.textContent = "That doesn't look like a valid email — give it another go.";
          }
        } else {
          if ($status) {
            $status.classList.add("is-error");
            $status.textContent = "Couldn't reach the server. Try again in a minute.";
          }
        }
      } catch (e) {
        if ($status) {
          $status.classList.add("is-error");
          $status.textContent = "Network error — check your connection and try again.";
        }
      } finally {
        if ($btn) $btn.disabled = false;
      }
    });
  });
}

// =========================================================================
// Native host bridge (window.SpireVault) — full implementation
// =========================================================================
// Replaces the early stub at the top of the file with the real impl
// once boot has populated the rest of the module (switchTab, KNOWN_TABS,
// startSteamSignIn, commitParsedRuns, etc.). Drains anything the host
// queued while we were still parsing, then posts a deterministic
// `kind: "ready"` to the native shell so it knows the bridge is live
// without resorting to a polling user-script (the v0.9.x pattern that
// caused "tabs don't work on desktop" — if the polling missed its
// window the bridge stayed permanently unreachable).
//
// Any future host (Windows electron build, iOS WKWebView, …) consumes
// this same surface.
try {
  if (typeof window !== "undefined") {
    const KNOWN = new Set(KNOWN_TABS);
    window.SpireVault = Object.freeze({
      version: 2,
      isDesktopHost: () => IS_DESKTOP_HOST,
      knownTabs: () => Array.from(KNOWN),
      activeTab: () => activeTab,
      switchTab: (tab) => {
        if (!KNOWN.has(String(tab || "").toLowerCase())) return false;
        try { switchTab(String(tab).toLowerCase()); return true; }
        catch (e) { console.warn("[SpireVault] switchTab failed", e); return false; }
      },
      // Hook a callback to be notified whenever the active tab changes.
      // Returns an unsubscribe function. The host uses this to keep
      // its native sidebar selection in sync when the user clicks a
      // link inside the embedded page (e.g. "Open Co-op" from a news
      // post anchor).
      onTabChange: (cb) => {
        if (typeof cb !== "function") return () => {};
        const handler = (ev) => { try { cb(ev?.detail?.tab); } catch {} };
        window.addEventListener("spirevault:tab", handler);
        return () => window.removeEventListener("spirevault:tab", handler);
      },
      // Push the desktop's locally-parsed runs into the embedded web app
      // so it renders the user's actual data instead of the demo set.
      // Accepts an array of run objects in the same shape that
      // `reviveRun()` already understands (Vault canonical schema).
      // The desktop's parser and the web's parser use the same
      // VaultCore-derived shape, so this is effectively a passthrough.
      ingestDesktopRuns: (rawRuns) => {
        try {
          if (!Array.isArray(rawRuns)) return false;
          const revived = rawRuns.map(reviveRun);
          // Fire-and-forget: commitParsedRuns is async but we don't
          // need to block the host on its completion.
          commitParsedRuns(revived, "desktop", { silent: true, fileCount: revived.length });
          return true;
        } catch (e) {
          console.warn("[SpireVault] ingestDesktopRuns failed", e);
          return false;
        }
      },
      // Kick off the Steam OpenID round-trip from inside the
      // WKWebView. The macOS app calls this when the user clicks
      // any native "Sign in with Steam" button (sidebar pill,
      // menu bar, settings) — driving sign-in in-place is the
      // only way the resulting cookie can land in our WKWebView's
      // data store. Returns true on success, false if we couldn't
      // start the flow (no `startSteamSignIn` defined yet).
      startSignIn: () => {
        try {
          if (typeof startSteamSignIn !== "function") return false;
          startSteamSignIn();
          return true;
        } catch (e) {
          console.warn("[SpireVault] startSignIn failed", e);
          return false;
        }
      },
      // Tell the embedded page who's signed in based on what the
      // native app has already established (e.g. via Steam
      // Mobile App or a previously seated session). The page
      // bypasses its own OpenID flow and renders the signed-in
      // state directly. We accept the shape that web's normal
      // sign-in path produces, so all the downstream consumers
      // (Co-op, Highlights post composer, Account menu) light up
      // identically. NOTE: this trusts the host completely — only
      // call from a WKWebView whose data store you control.
      seedSession: (profile) => {
        try {
          if (!profile || typeof profile !== "object") return false;
          if (typeof window.persistAuthFromHost === "function") {
            return !!window.persistAuthFromHost(profile);
          }
          // Older builds didn't expose persistAuthFromHost; fall
          // back to writing localStorage directly so the next
          // `boot()` picks the session up. Best-effort only.
          const blob = JSON.stringify({
            steamID: String(profile.steamID || profile.steamid || ""),
            personaName: String(profile.personaName || profile.persona || "Steam User"),
            avatarURL: profile.avatarURL || profile.avatar || undefined,
            sessionToken: String(profile.sessionToken || profile.session || ""),
            signedInAt: new Date().toISOString(),
          });
          localStorage.setItem("vault.web.session", blob);
          return true;
        } catch (e) {
          console.warn("[SpireVault] seedSession failed", e);
          return false;
        }
      },
      // Layout generation and theme controls for native hosts. The macOS
      // app's Settings screen is native, so the in-page pickers are not
      // reachable there; these let the shell (or Web Inspector) switch.
      // `setTheme` is instant. `setUI` reloads the page.
      ui: () => (IS_UI_NEXT ? "next" : "classic"),
      setUI: (variant) => setUiVariant(variant, "host"),
      themes: () => (UI ? UI.Theme.THEMES.map((t) => t.id) : []),
      theme: () => (UI ? UI.Theme.getThemePreference() : null),
      setTheme: (id) => (UI ? UI.Theme.setTheme(String(id || ""), { source: "host" }) : false),
    });

    // ---- Drain host-side queue ---------------------------------------
    //
    // Cold-launch tab selections are honored by `boot()` itself (it
    // reads `__VAULT_HOST_QUEUE.tab` before deciding the initial
    // panel), so we don't replay tabs here — doing both would cause a
    // visible flicker when boot's switch lands first and the drain
    // runs second. Sign-in is different: the page-side handler runs
    // independently of boot, so any queued click on the native
    // sidebar's "Sign in with Steam" button needs to fire here.
    try {
      if (__VAULT_HOST_QUEUE.signIn) {
        __VAULT_HOST_QUEUE.signIn = false;
        if (typeof startSteamSignIn === "function") {
          try { startSteamSignIn(); } catch (e) {
            console.warn("[SpireVault] queued startSignIn failed", e);
          }
        }
      }
    } catch (e) {
      console.warn("[SpireVault] queue drain failed", e);
    }

    // ---- Notify the native shell -------------------------------------
    //
    // Post `kind: "ready"` directly from the page once the full bridge
    // is live, so the desktop coordinator stops blind-retrying and
    // (more importantly) so an existing web session is mirrored into
    // native `SteamAuth` without forcing the user to re-do the OpenID
    // dance just because they're on a fresh app launch.
    try {
      if (IS_DESKTOP_HOST &&
          window.webkit?.messageHandlers?.vaultHost) {
        window.webkit.messageHandlers.vaultHost.postMessage({
          kind: "ready",
          tab: activeTab,
        });
        // Cross-launch auth sync. The WKWebView shares its data store
        // across native launches (cookies + localStorage live in
        // `WKWebsiteDataStore.default()`), so a user who signed in
        // earlier comes back already authenticated on the page side
        // — but the native sidebar would still show the guest pill
        // because no fresh OpenID round-trip ever fired `kind:"auth"`.
        // Posting it here surfaces "the page knows who you are" to
        // the native shell on every load. The bearer must be a real
        // session token (not the `__cookie__` placeholder) because
        // native API calls bypass the WebView's cookie jar.
        if (session &&
            /^\d{17}$/.test(session.steamID || "") &&
            typeof session.sessionToken === "string" &&
            session.sessionToken &&
            session.sessionToken !== "__cookie__" &&
            session.sessionToken.length >= 16) {
          window.webkit.messageHandlers.vaultHost.postMessage({
            kind: "auth",
            steamid: session.steamID,
            persona: session.personaName || "Steam User",
            avatar: session.avatarURL || "",
            session: session.sessionToken,
          });
        }
      }
    } catch (e) {
      // Non-fatal: native side will retry tab switches on a timer
      // anyway, and a missing auth notify just means the user's
      // sidebar stays in guest mode until they sign in via the pill.
      console.warn("[SpireVault] host ready notify failed", e);
    }
  }
} catch (e) { /* ignore — non-browser env */ }
