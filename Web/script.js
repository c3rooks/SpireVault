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
import * as HistoryStore from "/lib/history-store.js?v=8";
import * as InviteAPI from "/lib/invites.js?v=4";
import * as HighlightsAPI from "/lib/highlights.js?v=1";
import * as CoopLobbies from "/lib/coop-lobbies.js?v=19";
import { isCoopSandboxEnabled, openCoopSandboxPanel } from "/lib/coop-sandbox.js?v=4";
import * as PartyRoom from "/lib/party-room.js?v=2";
import * as AscInfo from "/lib/ascension-info.js?v=1";
import * as CharInfo from "/lib/character-info.js?v=1";
import * as RelicInfo from "/lib/relic-info.js?v=1";
import * as OverlayEngine from "/lib/overlay-engine.js?v=1";

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
const VAULT_BUILD = "v179-2026-05-19-localhost-boot-fast";

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
    let bar = document.getElementById("vault-dev-boot-banner");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "vault-dev-boot-banner";
      bar.setAttribute("role", "status");
      Object.assign(bar.style, {
        position: "fixed",
        top: "0",
        left: "0",
        right: "0",
        zIndex: "99999",
        padding: "6px 12px",
        font: "600 12px/1.3 ui-monospace, monospace",
        color: "#fff",
        background: "#b91c1c",
        textAlign: "center",
        pointerEvents: "none",
      });
      document.body.prepend(bar);
    }
    bar.textContent = `BOOT: ${step}`;
  } catch { /* never block boot */ }
}

// Feature flag — set to `true` only on local dev when iterating on the
// Run Companion Overlay. Production stays false until the feature is
// genuinely ready, so users never see a half-baked tab in their nav.
const OVERLAY_NAV_VISIBLE = false;

// ─────────────────────────────────────────────────────────────────────
//  Co-op Lobby Beta — kill switch + per-user opt-in.
//
//  The Co-op tab now ships two presentations of the same live
//  matchmaking state:
//
//    • Classic Co-op — the legacy roster surface. Status pills + the
//      Players Looking Now feed. Friendly default for existing users.
//    • Co-op Lobby Beta — the new command bar + Open Run Lobbies
//      board + Best Matches + right rail. Opt-in.
//
//  Both share the exact same backend (presence, lobbies, invites,
//  pair state). A Classic user can see, invite, and pair with a Beta
//  user — there is no separate matchmaking pool. The toggle is
//  purely a client-side presentation flip.
//
//  ENABLE_COOP_LOBBY_BETA is the build-level kill switch. When
//  `false`, the toggle is hidden and every client renders Classic
//  Co-op regardless of saved preference. Flip it back to `true`
//  to expose the toggle again — no other code changes needed.
//
//  Per-user opt-in is stored in localStorage under
//  `spirevault.coopLobbyBeta` and reflected as a `<body>` class so
//  CSS can swap surfaces without re-rendering JS.
// ─────────────────────────────────────────────────────────────────────
const ENABLE_COOP_LOBBY_BETA = true;
const COOP_LOBBY_BETA_KEY    = "spirevault.coopLobbyBeta";

function isCoopLobbyBetaEnabled() {
  if (!ENABLE_COOP_LOBBY_BETA) return false;
  try {
    return localStorage.getItem(COOP_LOBBY_BETA_KEY) === "on";
  } catch {
    return false;
  }
}

function setCoopLobbyBetaEnabled(on) {
  try { localStorage.setItem(COOP_LOBBY_BETA_KEY, on ? "on" : "off"); }
  catch { /* private mode → silently ignore; flag becomes session-only */ }
  applyCoopLobbyBetaClass();
  renderCoopBetaHeaderControls();
  try { renderCoopDiscoveryBanner(); } catch {}
  try { if (window.RunCoach?.renderBetaTab) window.RunCoach.renderBetaTab(); } catch {}
  if (on && isCoopSandboxEnabled()) {
    try {
      CoopLobbies.ensureCoopSandboxMounted({
        api: API_BASE,
        session,
        deps: { toast: (msg) => { if (msg) toast(msg); } },
      });
    } catch { /* non-fatal */ }
  }
}

function applyCoopLobbyBetaClass() {
  const on = isCoopLobbyBetaEnabled();
  const cls = document.body?.classList;
  if (!cls) return;
  cls.toggle("coop-lobby-beta-on",  on);
  cls.toggle("coop-lobby-beta-off", !on);
  // Surface the kill switch state too, so any UI that hides the
  // toggle when the feature is killed can do so with a single CSS
  // selector instead of duplicating the JS check.
  cls.toggle("coop-lobby-beta-killed", !ENABLE_COOP_LOBBY_BETA);
}
window.__VAULT_COOP_BETA__ = {
  isEnabled: isCoopLobbyBetaEnabled,
  setEnabled: setCoopLobbyBetaEnabled,
  killSwitch: () => ENABLE_COOP_LOBBY_BETA,
};
// Stamp the body class as early as possible so the first paint
// already renders the correct surface (no Classic→Beta flicker on
// reload). `document.body` may not exist yet at this point in the
// script; defer one tick if so.
if (document.body) applyCoopLobbyBetaClass();
else document.addEventListener("DOMContentLoaded", applyCoopLobbyBetaClass, { once: true });

/**
 * Paint the small "Co-op Lobby Beta" badge + "Switch to Classic"
 * link (when beta is on), or the "Try the Co-op Lobby Beta" banner
 * (when beta is off). Both surfaces are injected into the Co-op tab
 * slim header so they sit alongside the page title, with no impact
 * on the surrounding layout.
 *
 * Idempotent — safe to call multiple times. Re-renders on every
 * toggle and on Co-op tab activation.
 */
function renderCoopBetaHeaderControls() {
  const $slim = document.querySelector('[data-tab="coop"] .coop-head-slim');
  if (!$slim) return;
  const titleBox = $slim.firstElementChild;
  if (!titleBox) return;

  // 1) Inline beta badge in the title row (only when beta is ON).
  let $badge = titleBox.querySelector(".coop-beta-badge");
  if (isCoopLobbyBetaEnabled() && ENABLE_COOP_LOBBY_BETA) {
    if (!$badge) {
      $badge = document.createElement("span");
      $badge.className = "coop-beta-badge";
      $badge.title = "You're trying the new Co-op Lobby experience. Switch back anytime from the link below.";
      $badge.textContent = "Co-op Lobby Beta";
      const $h2 = titleBox.querySelector("h2");
      if ($h2) $h2.appendChild($badge);
    }
  } else if ($badge) {
    $badge.remove();
  }

  // Local dev: prominent Dev Sandbox chip (localhost / 127.0.0.1:8788 only).
  let $devChip = titleBox.querySelector(".coop-beta-dev-sandbox");
  if (isCoopLobbyBetaEnabled() && isCoopSandboxEnabled()) {
    if (!$devChip) {
      $devChip = document.createElement("button");
      $devChip.type = "button";
      $devChip.className = "coop-beta-dev-sandbox";
      $devChip.textContent = "Dev Sandbox";
      $devChip.title = "Open the local co-op test harness (seed lobbies, switch personas)";
      $devChip.addEventListener("click", (ev) => {
        ev.preventDefault();
        try {
          CoopLobbies.ensureCoopSandboxMounted({
            api: API_BASE,
            session,
            deps: { toast: (msg) => { if (msg) toast(msg); } },
          });
          openCoopSandboxPanel({
            api: API_BASE,
            session,
            deps: { toast: (msg) => { if (msg) toast(msg); } },
          });
        } catch { /* ignore */ }
      });
      const $h2 = titleBox.querySelector("h2");
      if ($h2) $h2.appendChild($devChip);
    }
  } else if ($devChip) {
    $devChip.remove();
  }

  // 2) Below the subtitle, a single subtle action line:
  //    • Beta on:  "You're using the new Co-op Lobby Beta. Switch back to Classic Co-op"
  //    • Beta off: "Try the new Co-op Lobby Beta"
  //    • Killed:   nothing rendered.
  let $row = titleBox.querySelector(".coop-beta-action-row");
  if (!ENABLE_COOP_LOBBY_BETA) {
    if ($row) $row.remove();
    return;
  }
  if (!$row) {
    $row = document.createElement("p");
    $row.className = "coop-beta-action-row";
    titleBox.appendChild($row);
  }
  if (isCoopLobbyBetaEnabled()) {
    $row.innerHTML =
      '<span class="coop-beta-action-text">You\u2019re using the Co-op Lobby Beta.</span> ' +
      '<button type="button" class="coop-link-btn coop-beta-switch" data-coop-beta="off">Switch back to Classic Co-op</button>';
  } else {
    $row.innerHTML =
      '<span class="coop-beta-action-text">Classic Co-op.</span> ' +
      '<button type="button" class="coop-link-btn coop-beta-switch" data-coop-beta="on">Try the Co-op Lobby Beta</button>';
  }
}

// Single delegated click handler for both switch buttons. Bound once.
document.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest("[data-coop-beta]") : null;
  if (!btn) return;
  ev.preventDefault();
  setCoopLobbyBetaEnabled(btn.dataset.coopBeta === "on");
});

// ─────────────────────────────────────────────────────────────────────
//  Co-op Lobby Beta — first-run discovery banner.
//
//  Surfaced inside the Co-op tab so existing signed-in users see the
//  new toggle the next time they land on Co-op. Shown when:
//    • kill switch is ON (ENABLE_COOP_LOBBY_BETA)
//    • user is still in Classic mode
//    • dismiss flag in localStorage hasn't been set yet
//
//  This is purely an in-app announcement — no backend, no email, no
//  push. Once dismissed (either by clicking Try the Beta or Not now),
//  the flag persists per-browser and the banner stays hidden.
// ─────────────────────────────────────────────────────────────────────
const COOP_LOBBY_BETA_DISCOVERY_KEY = "spirevault.coopLobbyBeta.discoveryDismissed";

function isCoopBetaDiscoveryDismissed() {
  try { return localStorage.getItem(COOP_LOBBY_BETA_DISCOVERY_KEY) === "1"; }
  catch { return false; }
}

function dismissCoopBetaDiscovery() {
  try { localStorage.setItem(COOP_LOBBY_BETA_DISCOVERY_KEY, "1"); }
  catch { /* private mode → banner just won't return this session */ }
  renderCoopDiscoveryBanner();
}

function renderCoopDiscoveryBanner() {
  const $banner = document.getElementById("coop-discovery-banner");
  if (!$banner) return;
  const shouldShow =
    ENABLE_COOP_LOBBY_BETA &&
    !isCoopLobbyBetaEnabled() &&
    !isCoopBetaDiscoveryDismissed();
  $banner.hidden = !shouldShow;
}

// Delegated handler for the banner's two buttons + the × close.
document.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest("[data-coop-discovery]") : null;
  if (!btn) return;
  ev.preventDefault();
  const action = btn.dataset.coopDiscovery;
  if (action === "try") {
    // Flip into Beta and remember — the toggle is now in the slim
    // header so users can return to Classic at any time without
    // seeing this banner again.
    setCoopLobbyBetaEnabled(true);
    dismissCoopBetaDiscovery();
  } else if (action === "dismiss") {
    dismissCoopBetaDiscovery();
  }
});
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
 * banner shows "A newer version of Spire Vault is available —
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
      <strong>A newer version of Spire Vault is available.</strong>
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
    const MANIFEST_VERSION = 3;
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
  // Form (2) → form (1): keep class prefix, concatenate the rest.
  if (baseParts.length >= 3) {
    const collapsed = baseParts[0] + "_" + baseParts.slice(1).join("") + plusSuffix;
    if (assetLabels.cards[collapsed]) return assetLabels.cards[collapsed];
  }
  // Form (3) → form (1): concatenate everything, then look for any class
  // prefix that owns this name. Catches `perfected_strike`, `body_slam`,
  // `pommel_strike`, `shrug_it_off`, etc.
  if (baseParts.length >= 2) {
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
const CLASS_PREFIXES = new Set([
  "ironclad", "silent", "defect", "regent", "necrobinder",
  "watcher", "colorless", "curse", "status",
]);

function cardImageSrc(id) {
  let slug = cardSlug(id);
  if (!slug) return null;
  if (assetManifest.cards.has(slug)) return `${ASSET_BASE}/cards/${slug}.webp`;
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
      if (assetManifest.cards.has(swapped)) return `${ASSET_BASE}/cards/${swapped}.webp`;
      // Also try the collapsed-name variant of the swap, e.g.
      // `feel_no_pain_ironclad` → `ironclad_feelnopain`.
      const swappedCollapsed = last + "_" + baseParts.slice(0, -1).join("") + plusSuffix;
      if (assetManifest.cards.has(swappedCollapsed)) return `${ASSET_BASE}/cards/${swappedCollapsed}.webp`;
    }
  }

  // 3+ baseparts → has a class prefix; concatenate the rest of the name:
  //   `ironclad_pommel_strike` → `ironclad_pommelstrike`.
  if (baseParts.length >= 3) {
    const collapsed = baseParts[0] + "_" + baseParts.slice(1).join("") + plusSuffix;
    if (assetManifest.cards.has(collapsed)) return `${ASSET_BASE}/cards/${collapsed}.webp`;
  }
  // 2 baseparts → bare snake-case name without a class prefix. Concatenate
  // everything and look for any `<class>_<concatenated>` asset. Catches
  // `perfected_strike`, `body_slam`, `pommel_strike`, `shrug_it_off`, etc.
  if (baseParts.length >= 2) {
    const concatenated = baseParts.join("") + plusSuffix;
    if (assetManifest.cards.has(concatenated)) return `${ASSET_BASE}/cards/${concatenated}.webp`;
    for (const c of assetManifest.cards) {
      if (c.endsWith(`_${concatenated}`)) return `${ASSET_BASE}/cards/${c}.webp`;
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
        if (c.endsWith(`_${blended}`) || c === blended) return `${ASSET_BASE}/cards/${c}.webp`;
      }
    }
  }
  // Single-word legacy fallback: `inflame` → `ironclad_inflame`.
  for (const c of assetManifest.cards) {
    if (c === slug || c.endsWith(`_${slug}`)) return `${ASSET_BASE}/cards/${c}.webp`;
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
 *  the Cloudflare edge cache. We re-exported the asset multiple
 *  times (transparency fix → AI hero polish → canonical wiki art),
 *  but a stuck `_redirects` rule kept redirecting `?v=4` back to
 *  `?v=3`, so the new bytes never reached users. Rather than fight
 *  the cache, we ship the canonical art under a brand-new filename
 *  that has no edge-cache history. Future re-exports rotate this
 *  filename, not just a query string. Other bosses use a single
 *  stable filename because their art is fixed. */
const ARCHITECT_ASSET_BASENAME = "architect-wiki";

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
let pendingInviteToID = null; // who the modal is targeting
let pollFeedTimer       = null;
let feedVisible         = 20; // windowed: how many rows currently in Beta feed
let classicFeedVisible  = 20; // windowed: how many rows in Classic feed
const FEED_PAGE         = 20;
// Free-text "find anyone" filter for the Players Looking Now feed —
// applies to both the Beta `#feed` and Classic `#classic-feed`. Matches
// across persona name, Discord handle, status text, and the ascension
// number a user might type ("8" matches anyone with A8 in their copy).
let feedSearchQuery     = "";
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
//   5. Cookie says definitive 401 → wipe localStorage (token genuinely dead).
//   6. No cookie + no localStorage → guest.
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
      setStatus("offline", "Browsing as guest");
    } else if (isLocalDevHost()) {
      setStatus("online", "Ready (local)");
    }

    let tab = "overview";
    try {
      const last = localStorage.getItem(STORAGE_LAST_TAB);
      if (session && last && new Set(KNOWN_TABS).has(last)) tab = last;
    } catch { /* private mode */ }
    switchTab(tab);
    paintInitialTabShell();
    if (!session) {
      try { wireGuestCoop(); } catch { /* panel may not exist yet */ }
    }
  } catch (e) {
    console.error("[Vault] bootShellFirstPaint failed", e);
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
      const j = await r.json();
      const sid = j?.steamID || "";
      const sidOk =
        /^\d{17}$/.test(sid) ||
        (isCoopSandboxEnabled() && /^local-[a-z0-9_-]+$/i.test(sid));
      if (j && sidOk) {
        const sameSteam = !!session && session.steamID === j.steamID;
        const hasRealBearer = !!session?.sessionToken && session.sessionToken !== "__cookie__";
        if (sameSteam && hasRealBearer) {
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
      }
    } else if (r.status === 401) {
      session = null;
      sessionCookieVerified = false;
      sessionCookieMissing = false;
      try { localStorage.removeItem(STORAGE_SESSION); } catch {}
      if (isLocalDevHost()) {
        try {
          bootShellCommitted = false;
          bootShellFirstPaint();
        } catch { /* ignore */ }
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
    try { setStatus("offline", "Browsing as guest"); } catch {}
  } else if (isLocalDevHost() && sessionCookieVerified) {
    try { setStatus("online", "Ready (local)"); } catch {}
  }
}

try {
  if (!session) setStatus("offline", "Browsing as guest");
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
      "Open The Vault in Safari, Chrome, or Firefox " +
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
      $text.textContent = `${head} · ${activeNow} online · ${looking} looking`;
    }
  } catch {
    $text.textContent = "Live count momentarily unavailable.";
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
        setStatus("offline", "Browsing as guest — sign in for co-op");
        return;
      }
      if (!sessionCookieVerified) {
        session = null;
        try { localStorage.removeItem(STORAGE_SESSION); } catch {}
        setStatus("offline", "Sign in to continue");
        try { wireGuestCoop(); } catch {}
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
      // Guests still need Settings (folder linking, import/export, prefs)
      // even without Steam — when we removed the standalone sidebar row
      // in v0.9 we replaced it with a footer Settings link inside the
      // me-pill profile popover, but that popover is gated on a Steam
      // session. So the guest pill exposes a tiny "Settings" link inline
      // alongside the sign-in CTA so save-data plumbing never gets
      // hidden behind auth.
      $mePill.innerHTML = `
        <button class="btn-primary me-pill-signin" type="button" data-action="signin-cta">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z"/></svg>
          <span>Sign in with Steam</span>
        </button>
        <p class="me-pill-guest-note">Optional — only needed for the co-op feed.</p>
        <button class="me-pill-guest-settings" type="button" data-action="open-settings-guest" title="Open Settings">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
          <span>Settings</span>
        </button>`;
    }
    const $mobileSign = document.getElementById("me-pill-name-mobile");
    if ($mobileSign) $mobileSign.textContent = "Guest";
    setStatus("offline", "Browsing as guest");
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

  // Tab navigation — sidebar buttons + content panels.
  // Default tab is now "overview" so a fresh visitor lands on stats, not
  // co-op (which would force the auth wall they came here to avoid).
  document.querySelectorAll(".nav-row").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  // Paint the "NEW" pill on the News button before we route to the
  // user's last tab — that way even if they're going straight to
  // Recent Runs, they see the pill on the sidebar immediately.
  refreshNewsBadge();
  // Paint the Co-op Lobby Beta badge / Switch-to-Classic link in the
  // Co-op slim header *before* we route. The Co-op panel is hidden
  // for non-Co-op tabs anyway but the markup needs to be correct so a
  // tab switch later doesn't briefly flash the wrong state. Same
  // deal for the first-run discovery banner.
  try { applyCoopLobbyBetaClass(); renderCoopBetaHeaderControls(); renderCoopDiscoveryBanner(); } catch {}
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
    if (path === "/overlay") initialTab = "overlay";
    else if (partyMatch) initialTab = "coop";
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

  // Wire the Co-op tab. Authenticated path is the normal experience;
  // guest path swaps in a sign-in prompt + read-only roster.
  if (session) {
    wireCoopForm();
    // Mount the new run-lobby module. This is what drives the four-section
    // co-op page (Status / Active Session / Open Lobbies / Recommended).
    // The legacy roster `#feed` keeps rendering via `renderFeed()` below;
    // the new module owns everything above it on the Co-op tab.
    // Co-op lobby module mounts lazily on first Co-op tab visit (ensureCoopLobbiesMounted).
    try {
      if (window.__VAULT_PARTY_ID) {
        PartyRoom.mountPartyRoom({
          api: API_BASE,
          session,
          deps: { toast: (msg) => { if (msg) toast(msg); } },
        }, window.__VAULT_PARTY_ID);
      }
    } catch (err) {
      console.warn("party room mount failed", err);
    }
    // Refresh button. Debounced to once per ~5 s so a frustrated panic-clicker
    // can't blast our server quotas. The button visually "ticks" each press
    // even when the request is throttled, so it still feels responsive.
    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      let lastRefreshAt = 0;
      refreshBtn.addEventListener("click", () => {
        const now = Date.now();
        refreshBtn.classList.remove("is-flash");
        void refreshBtn.offsetWidth;
        refreshBtn.classList.add("is-flash");
        if (now - lastRefreshAt < 5000) return;
        lastRefreshAt = now;
        void pullFeed();
        void pullInbox();
      });
    }
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
  } else {
    wireGuestCoop();
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

  // Invite modal scaffolding (auth-only — guests don't see invites)
  if (session) {
    wireInviteModal();
  }
  // Share modal works for everyone (export single run image / markdown).
  wireShareModal();
  // Run-detail modal: click any row → full deck + relics + per-floor
  // pick history. Filter chips and search input on the Recent Runs
  // page are wired together so a chip click re-renders the run list
  // immediately while preserving caret position in the search box.
  wireRunDetailModal();
  wireRunFilters();
  wireCompareUI();

  // Load asset manifest in parallel with the message catalog. Both are
  // best-effort: failures degrade gracefully (no card art / no preset
  // notes) without blocking the rest of the boot sequence.
  void loadAssetManifest();

  const runBootSlowPath = async () => {
  vaultDevBootStep("slow");

  // Load preset message catalog (auth-only — only signed-in users send invites).
  if (session) {
    try {
      await promiseWithTimeout(
        InviteAPI.loadMessageCatalog(API_BASE),
        5000,
        "loadMessageCatalog"
      );
      populateInviteOptions();
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
  if (cached?.runs?.length) {
    parsedRuns = cached.runs.map(reviveRun);
    isDemoMode = false;
    // Signed-in: kick a cloud refresh anyway so any newer runs from
    // another device get unioned in (merge-by-id is safe).
    if (session?.steamID) needCloudHydrate = true;
  } else if (hasLinkedSaves) {
    // Folder is linked but cache is empty — show empty for one frame,
    // the auto-reload below will populate it.
    parsedRuns = [];
    isDemoMode = false;
  } else if (session?.steamID) {
    // Signed-in fresh device. Show a skeleton, NOT demo data, until
    // cloud download resolves.
    parsedRuns = [];
    isDemoMode = false;
    showBootSkeleton();
    needCloudHydrate = true;
  } else {
    // True guest, no local cache, no folder, no Steam — demo time.
    try {
      const { getDemoRuns } = await import("./lib/demo-runs.js");
      parsedRuns = getDemoRuns();
      isDemoMode = true;
    } catch {
      parsedRuns = [];
      isDemoMode = false;
    }
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
        // If the user is signed in and we still have no data,
        // re-render so the empty-state CTA shows ("Drop your save
        // folder to start syncing"). NEVER load demo for an authed
        // user — their dashboard would lie about their stats.
        if (parsedRuns.length === 0 && session?.steamID) {
          renderActiveTab();
        }
      })
      .catch(async () => {
        // Cloud unreachable. Don't synthesize demo — the user's
        // network blipped, they'll see a normal empty state.
        hideBootSkeleton();
        if (parsedRuns.length === 0) renderActiveTab();
      });
  }


  // Silent auto-reload from disk. If the user previously picked their
  // save folder (directory handle) or a single history.json (file
  // handle) AND the browser already granted read access for this
  // origin, we can quietly re-read with no extra click. The fingerprint
  // check inside autoReload short-circuits if nothing on disk changed,
  // so this is cheap on a no-op visit and only re-parses when STS2
  // actually wrote new `.run` files since last ingest.
  void autoReloadHistoryIfPermitted({ silent: true });
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
    heartbeatTimer  = setInterval(() => pushNow(true), HEARTBEAT_MS);

    // Watchdog: forces a heartbeat if the primary scheduler stalled.
    heartbeatWatchdog = setInterval(() => {
      const since = Date.now() - lastSuccessfulHeartbeatAt;
      if (since > HEARTBEAT_MS * 1.5) {
        console.info(`heartbeat watchdog firing (${Math.round(since / 1000)}s since last success)`);
        pushNow(true);
      }
    }, 60_000);

    await bootPullInitial();
  } else {
    // Guests still see the live presence count update on the Co-op tab.
    void refreshGuestRoster();
    setInterval(refreshGuestRoster, POLL_FEED_MS);
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
    } else {
      void refreshGuestRoster();
    }
    if (activeTab === "highlights") pullHighlights();
    void autoReloadHistoryIfPermitted({ silent: true });
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
    } else {
      void refreshGuestRoster();
    }
    void autoReloadHistoryIfPermitted({ silent: true });
  });

  // Auth-only: tell the server we're going away so the roster decays.
  // Guests aren't on the roster, so nothing to clean up.
  if (session) {
    window.addEventListener("beforeunload", () => {
      try {
        // Beacon goes through the same-origin proxy so the
        // first-party `vault_session` cookie ships automatically.
        // Cross-origin sendBeacon to vault-coop.* would NOT include
        // the cookie (third-party) and the worker would reject as
        // unauthenticated, defeating the unload signal.
        const blob = new Blob([], { type: "text/plain" });
        navigator.sendBeacon && navigator.sendBeacon(`${API_BASE}/presence`, blob);
      } catch {}
    });
  }
  }; // end runBootSlowPath

  if (isLocalDevHost()) {
    const startSlow = () => {
      void runBootSlowPath()
        .catch((err) => {
          console.error("[Vault] boot slow path failed", err);
          if (session) setStatus("trouble", "Trouble starting — try refreshing");
          try { paintInitialTabShell(); } catch {}
        })
        .finally(finishBootGuards);
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(startSlow, { timeout: 2000 });
    } else {
      setTimeout(startSlow, 0);
    }
    return;
  }

  try {
    await runBootSlowPath();
  } catch (err) {
    console.error("[Vault] boot failed", err);
    if (session) setStatus("trouble", "Trouble starting — try refreshing");
    try { paintInitialTabShell(); } catch {}
  } finally {
    finishBootGuards();
  }
  } catch (err) {
    console.error("[Vault] boot failed", err);
    if (session) setStatus("trouble", "Trouble starting — try refreshing");
    try { paintInitialTabShell(); } catch {}
    finishBootGuards();
  }
}

// =========================================================================
// Guest co-op tab — read-only roster + sign-in CTA
// =========================================================================
//
// Without a session we can't write to /presence, but the GET endpoint is
// public (cached at the edge). Show signed-in users a live "X players
// signed up · Y looking for co-op" line so the value is concrete: "if
// you sign in too, those are the people you'd be matchmaking with."
function wireGuestCoop() {
  const $body = document.querySelector('.tab-panel[data-tab="coop"] .panel-body');
  if (!$body) return;
  $body.innerHTML = `
    <div class="guest-coop">
      <div class="guest-coop-card">
        <h2>Find a co-op partner for Slay the Spire 2</h2>
        <p class="muted">Sign in with Steam to appear on the live feed and send a canned invite to anyone else looking right now. <strong>Stats and run history don't require sign-in</strong> — only the co-op feed does.</p>
        <p class="guest-coop-count" id="guest-coop-count">Checking who's around…</p>
        <button class="btn-primary btn-block" type="button" data-action="signin-cta">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z"/></svg>
          <span>Sign in with Steam</span>
        </button>
        <details class="guest-coop-explainer">
          <summary>What signing in actually does</summary>
          <ul>
            <li>Verifies you own the Steam account you claim, via Steam OpenID. Standard, no password ever leaves Steam.</li>
            <li>Mints a 30-day session. You stay signed in across visits.</li>
            <li>Posts your persona name + avatar to the public feed so others can find you. Sign out to drop your row.</li>
            <li>Lets you send and receive canned co-op invites between sessions. Free-form text isn't allowed — invites are picked from a fixed list to prevent spam.</li>
          </ul>
        </details>
      </div>
      <div class="guest-coop-roster" id="guest-coop-roster" hidden>
        <h3>Currently signed up</h3>
        <div class="guest-coop-roster-list" id="guest-coop-roster-list"></div>
      </div>
    </div>`;
}

async function refreshGuestRoster() {
  const $count   = document.getElementById("guest-coop-count");
  const $rosterWrap = document.getElementById("guest-coop-roster");
  const $list    = document.getElementById("guest-coop-roster-list");
  const $headCount   = document.getElementById("online-count");
  const $headSummary = document.getElementById("online-summary");
  if (!$count && !$headSummary) return;
  try {
    const list = await fetchFeed();
    if (!list || list.length === 0) {
      if ($count) $count.textContent = "Nobody signed up yet — be the first.";
      if ($headSummary) $headSummary.textContent = "No one signed up yet.";
      if ($headCount) $headCount.textContent = "0";
      if ($rosterWrap) $rosterWrap.hidden = true;
      return;
    }
    const looking = list.filter((p) => p.status === "looking").length;
    const inGame  = list.filter((p) => p.inSTS2).length;
    const total   = list.length;
    const head    = total === 1 ? "1 player signed up" : `${total} players signed up`;
    if ($count) {
      $count.innerHTML = `<span class="dot dot-pulse" aria-hidden="true"></span>${head} · ${looking} looking · ${inGame} in STS2 right now`;
    }
    if ($headSummary) {
      $headSummary.textContent = `${head} · ${looking} looking · ${inGame} in STS2`;
    }
    if ($headCount) {
      $headCount.textContent = String(total);
    }
    if ($rosterWrap && $list) {
      $rosterWrap.hidden = total === 0;
      // Guest view: list rows come back sanitized (anonId / status /
      // inSTS2 only). Render anonymous placeholders with status pills
      // so the social proof ("someone IS in STS2 right now") lands
      // without leaking Steam handles or avatars. Clicking a row does
      // nothing for guests; we only enable invite actions after
      // sign-in. A sticky footer row prompts sign-in to reveal
      // identities and send invites.
      const rowsHtml = list.slice(0, 12).map((p, i) => `
        <div class="guest-roster-row guest-roster-row--anon">
          <div class="avatar avatar-anon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="8" r="4"/>
              <path d="M4 21v-1a8 8 0 0 1 16 0v1"/>
            </svg>
          </div>
          <div class="guest-roster-meta">
            <strong>Anonymous player ${i + 1}</strong>
            <span class="muted small">${guestStatusLabel(p)}</span>
          </div>
          ${p.inSTS2 ? '<span class="pill ember">In STS2</span>' : ''}
        </div>`).join("");
      const moreHidden = total > 12 ? `<p class="muted small guest-roster-more">…and ${total - 12} more</p>` : "";
      const signinCta = `
        <div class="guest-roster-cta">
          <div>
            <strong>Steam handles hidden while you're signed out.</strong>
            <span class="muted small">Sign in with Steam to see who's here and send invites.</span>
          </div>
          <button class="btn-primary sm" type="button" data-action="signin-cta">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z"/></svg>
            Sign in with Steam
          </button>
        </div>`;
      $list.innerHTML = rowsHtml + moreHidden + signinCta;
    }
  } catch {
    if ($count) $count.textContent = "Live count momentarily unavailable.";
    if ($headSummary) $headSummary.textContent = "Live count momentarily unavailable.";
  }
}

function guestStatusLabel(p) {
  const STATUS_DISPLAY = {
    looking: "Looking for Co-op", solo: "In a Run", paired: "In Co-op", afk: "Away",
    inRun: "In a Run", inCoop: "In Co-op",
  };
  const label = STATUS_DISPLAY[p.status] || "Signed up";
  if (p.inSTS2) return "In Slay the Spire 2 · " + (p.status === "looking" ? "looking for co-op" : label.toLowerCase());
  return label;
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
  });
  document.querySelectorAll(".nav-row").forEach((b) => {
    const isActive = b.dataset.tab === tab;
    b.classList.toggle("is-active", isActive);
    if (isActive) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
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
  if (tab === "coop") {
    if (session) ensureCoopLobbiesMounted();
    try { CoopLobbies.setCoopTabActive?.(); } catch {}
    try { renderCoopBetaHeaderControls(); } catch {}
    try { renderCoopDiscoveryBanner(); } catch {}
    if (isCoopSandboxEnabled()) {
      try {
        CoopLobbies.ensureCoopSandboxMounted({
          api: API_BASE,
          session,
          deps: { toast: (msg) => { if (msg) toast(msg); } },
        });
      } catch { /* non-fatal */ }
    }
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
const LATEST_NEWS_POST_ID = "post-006-2026-05-10-desktop-cloud-parity";
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
    const real = COMPANIONS.filter((c) => !c.isRandom);
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

function renderCompanion() {
  const slots = document.querySelectorAll(".companion-slot");
  if (!slots.length) return;

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
  const sceneHtml = `
    <div class="scene scene-${speakerIsClimber ? "climber-speaks" : "boss-speaks"}"
         style="--scene-color:${climber.color};--scene-bubble-color:${bubbleColor};--scene-boss-color:${bossColor}">
      <button class="scene-figure scene-figure-climber" type="button"
              data-action="companion-toggle"
              aria-label="Change companion. Current: ${esc(climber.label)}${setting.isRandom ? " (rolled randomly)" : ""}"
              title="Change companion (currently ${esc(climber.label)})">
        <span class="scene-shadow" aria-hidden="true"></span>
        ${climberSrc
          ? `<img class="scene-art${climber.facesLeft ? " scene-art-flip" : ""}" src="${esc(climberSrc)}" alt="${esc(climber.label)}" draggable="false">`
          : `<span class="scene-glyph">${esc(climber.label[0])}</span>`}
      </button>

      <div class="scene-figure scene-figure-boss"
           aria-label="${esc(boss.label)}" title="${esc(boss.label)}">
        <span class="scene-shadow" aria-hidden="true"></span>
        ${bossSrc
          ? `<img class="scene-art scene-art-boss" src="${esc(bossSrc)}"${bossSrcset ? ` srcset="${esc(bossSrcset)}"` : ""} alt="${esc(boss.label)}" draggable="false">`
          : `<span class="scene-glyph">${esc(boss.label[0])}</span>`}
      </div>

      <button class="scene-bubble scene-bubble-${speakerIsClimber ? "climber" : "boss"}"
              type="button" data-action="scene-reroll"
              aria-label="New line. Tap for another."
              title="Tap for a new line">
        <span class="scene-bubble-text">${esc(quote.text)}</span>
        <span class="scene-bubble-tail" aria-hidden="true"></span>
      </button>
    </div>`;

  const pickerHtml = `
    <div class="companion-picker" hidden role="listbox" aria-label="Pick companion">
      ${COMPANIONS.map((opt) => {
        const src = opt.isRandom ? "" : (characterImageSrc(opt.id) || "");
        const isActive = opt.id === setting.id;
        const glyph = opt.isRandom
          ? `<span class="companion-option-glyph" aria-hidden="true">⚂</span>`
          : (src
              ? `<img src="${esc(src)}" alt="" draggable="false">`
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

  slots.forEach((slot) => {
    slot.innerHTML = sceneHtml + pickerHtml;
  });
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
  if (TABS_WITH_DATA.includes(activeTab)) {
    renderStatsTab(activeTab);
  } else if (activeTab === "coop") {
    // Co-op view is reactive on its own pulls; just make sure feed shows once.
    // Guests don't have inbox/feed elements (the panel body is replaced
    // with a guest CTA), so skip the auth-only renderers.
    if (!session) return;
    if (lastFeed.length) renderFeed(lastFeed);
    renderInbox(lastInbox);
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

/** Linked-folder pill suppressed in v109 per user request — the panel-
 *  head was getting too noisy. Auto-refresh from the saved folder
 *  still runs silently in the background; the Refresh button on the
 *  toolbar is the only surface that needs to be there. */
function renderLinkedPill() {
  document.querySelectorAll("[data-linked-pill]").forEach((el) => {
    el.hidden = true;
    el.innerHTML = "";
  });
}

/** Cloud-sync status pill. Surfaces what the user CANNOT otherwise
 *  see: that their uploaded run history is synced to their Steam
 *  account, when the last sync happened, and how many runs are in
 *  the cloud copy. Without this surface, "did it actually save?"
 *  has no observable answer — and that's why users keep asking
 *  whether they need to re-pick their save files.
 *
 *  Three states:
 *   - signed-in + has runs in memory + uploaded recently → green dot
 *     "Synced N runs · just now / 2m ago"
 *   - signed-in + has runs but never uploaded → amber dot
 *     "Local only · Sign in to sync" (rare; we auto-upload after
 *     ingest)
 *   - signed-out → hidden (no cloud account to sync with)
 *
 *  Updated by:
 *    - boot (after IDB load)
 *    - every CloudRuns.upload success
 *    - every hydrateFromCloudIfAvailable
 *    - timer every 30 s so the "X ago" string stays fresh */
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

function renderSyncPill() {
  const slots = document.querySelectorAll("[data-sync-pill]");
  if (!slots.length) return;
  // Sync pill suppressed in v109 per user request — they don't want
  // it cluttering the panel-head. Cloud sync still runs in the
  // background (recordCloudSync, CloudRuns.upload). Users who really
  // want a manual cloud refresh can use the toolbar Refresh button.
  slots.forEach((el) => { el.hidden = true; el.innerHTML = ""; });
  return;
  // eslint-disable-next-line no-unreachable
  const signedIn = !!session?.steamID;
  const hasData = parsedRuns.length > 0 && !isDemoMode;
  if (!signedIn || !hasData) {
    slots.forEach((el) => { el.hidden = true; el.innerHTML = ""; });
    return;
  }
  const count = lastCloudSyncCount || parsedRuns.length;
  // Stuck-state pill: signed-in but only 1 run — overwhelmingly means
  // the user has not successfully linked their SlayTheSpire2 folder yet.
  // Show a clear "Set up history" CTA instead of a green "Synced" pill
  // that hides the real problem.
  const stuck = count <= 1;
  const ago = lastCloudSyncAt ? relativeAgoLabel(lastCloudSyncAt) : "syncing…";
  slots.forEach((el) => {
    el.hidden = false;
    if (stuck) {
      el.innerHTML = `
        <span class="sync-pill-dot sync-pill-dot--warn" aria-hidden="true"></span>
        <span class="sync-pill-text">
          <strong>${count} run synced</strong>
          <span class="sync-pill-ago">&middot; link your save folder</span>
        </span>
        <button class="sync-pill-refresh" type="button" data-action="link-saves" title="Pick your SlayTheSpire2 folder so we can import all your runs">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Link folder</span>
        </button>`;
    } else {
      el.innerHTML = `
        <span class="sync-pill-dot" aria-hidden="true"></span>
        <span class="sync-pill-text">
          <strong>Synced ${count} run${count === 1 ? "" : "s"}</strong>
          <span class="sync-pill-ago">&middot; ${esc(ago)}</span>
        </span>
        <button class="sync-pill-refresh" type="button" data-action="refresh-cloud" title="Pull the latest history from your Steam account">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Refresh</span>
        </button>`;
    }
  });

  document.querySelectorAll('[data-action="link-saves"]').forEach((btn) => {
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", () => { void scanForHistory(); });
  });

  // Wire the refresh button — it manually triggers a cloud merge.
  // Helps users who want to verify "is my latest run synced?".
  document.querySelectorAll('[data-action="refresh-cloud"]').forEach((btn) => {
    if (btn.dataset.wired === "1") return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        // Re-scan the linked save folder first (if any) so the cloud
        // merge has fresh local data to upload. Without this step,
        // Refresh would always claim "Already up to date" even when the
        // user just played 50 new runs that hadn't been re-ingested.
        try {
          const dirHandle = await HistoryStore.loadDirectoryHandle();
          if (dirHandle) {
            const files = await collectFilesFromDirectoryHandle(dirHandle);
            if (files && files.length > 0) {
              await ingestHistoryFiles(files, { silent: true });
            }
          }
        } catch (e) {
          console.warn("[Vault] refresh: rescan failed", e);
        }
        const res = await hydrateFromCloudIfAvailable();
        const localCount = parsedRuns.length;
        if (res?.changed) {
          toast(`Synced ${res.count} run${res.count === 1 ? "" : "s"} from your Steam account.`);
        } else if (localCount <= 1) {
          // Sync says "no new runs", but local stats are still empty.
          // Tell the user the truth: nothing to sync because no history
          // has been imported yet. This was the misleading
          // "Already up to date" toast that hid a stuck import.
          toast("No history found yet. Click Import and pick your SlayTheSpire2 folder, or drag it onto the page.", { duration: 9000 });
        } else {
          toast(`Up to date — ${localCount} run${localCount === 1 ? "" : "s"} synced.`);
        }
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// Update the relative time string every 30s so "1m ago" doesn't
// stay stuck while the user is staring at the toolbar.
setInterval(() => {
  if (lastCloudSyncAt) renderSyncPill();
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

let coopLobbiesMounted = false;
function ensureCoopLobbiesMounted() {
  if (coopLobbiesMounted || !session) return;
  coopLobbiesMounted = true;
  try {
    CoopLobbies.mountCoopLobbies({
      api: API_BASE,
      session,
      deps: {
        toast: (msg) => { if (msg) toast(msg); },
        openInviteModal: (sid, name) => openInviteModal(sid, name),
        onAuthFailure: () => {
          const giveUp = recordAuthFailureAndShouldGiveUp();
          if (giveUp) clearSessionAndReload();
        },
        onStateRefresh: () => {
          void pullFeed();
          void pullInbox();
        },
      },
    });
  } catch (err) {
    coopLobbiesMounted = false;
    console.warn("coop lobbies mount failed", err);
  }
}

function wireCoopForm() {
  document.querySelectorAll('input[name="status"]').forEach((el) =>
    el.addEventListener("change", () => {
      // Manual user change → reset auto-AFK timer so we don't
      // immediately flip them back to AFK on the next idle window.
      lastUserActivityAt = Date.now();
      userExplicitStatusAt = Date.now();
      // Any explicit choice (including a manual AFK pick) cancels
      // the auto-AFK restore. Without this, picking AFK by hand
      // would be silently flipped back to Looking the next time
      // the user touched the mouse.
      autoAfkActiveSince = 0;
      // Mirror selection into the Classic surface so flipping
      // status in the Beta UI immediately updates Classic and
      // vice-versa.
      setRadio("classic-status", el.value);
      schedulePush();
    })
  );
  // Classic Co-op radios route through the same handler chain so
  // both surfaces share one source of truth. We reflect into the
  // beta radio first so anything still listening on
  // `input[name="status"]` keeps working unchanged.
  document.querySelectorAll('input[name="classic-status"]').forEach((el) =>
    el.addEventListener("change", () => {
      lastUserActivityAt = Date.now();
      userExplicitStatusAt = Date.now();
      autoAfkActiveSince = 0;
      const betaRadio = document.querySelector(`input[name="status"][value="${el.value}"]`);
      if (betaRadio) betaRadio.checked = true;
      schedulePush();
    })
  );

  const $betaDiscord = document.getElementById("me-discord");
  if ($betaDiscord) $betaDiscord.addEventListener("input", schedulePush);
  // Classic Discord input lives directly on the page (it isn't
  // gated behind a modal like the Beta one), so we mirror its value
  // into the Beta input and trigger the same push pipeline. The
  // Beta input is what readMyForm() reads, so this keeps a single
  // upload path even though there are two visible inputs.
  const $classicDiscord = document.getElementById("classic-me-discord");
  if ($classicDiscord) {
    $classicDiscord.addEventListener("input", () => {
      if ($betaDiscord) $betaDiscord.value = $classicDiscord.value;
      schedulePush();
    });
  }

  // Restore last status from local draft FIRST so the radio shows
  // immediately, then pull the authoritative copy from the server
  // (the user might have set "afk" on desktop and just opened
  // mobile — the server has the truth, localStorage doesn't).
  const draft = readDraft();
  setRadio("status", draft.status ?? "looking");
  if ($betaDiscord) $betaDiscord.value = draft.discordHandle ?? "";
  if ($classicDiscord) $classicDiscord.value = draft.discordHandle ?? "";

  // Pull our own row from the roster on mount and use it to
  // override the local draft if it's fresher. This is what makes
  // status follow the user across devices: set "afk" anywhere,
  // see "afk" everywhere.
  void hydrateMyStatusFromServer();
}

/** Pull the signed-in user's own presence row from the server and
 *  reflect it in the form. Skipped for guests. Non-blocking — if it
 *  fails, the local draft stays. */
/**
 * Reverse mapping for the legacy roster's status values. The new UI
 * radios use the v2 enum (`looking`/`solo`/`paired`/`afk`), so we
 * translate the legacy value before hitting `setRadio`.
 */
function mapStatusFromLegacy(s) {
  switch (s) {
    case "inRun":  return "solo";
    case "inCoop": return "paired";
    default:       return s || "looking";
  }
}

async function hydrateMyStatusFromServer() {
  if (!session?.steamID) return;
  try {
    const list = await fetchFeed();
    const me = (list || []).find((p) => p.steamID === session.steamID);
    if (!me) return;
    if (me.status && me.status !== "none") {
      setRadio("status", mapStatusFromLegacy(me.status));
    }
    if (me.discordHandle) {
      const $d = document.getElementById("me-discord");
      if ($d && !$d.value) $d.value = me.discordHandle;
      const $cd = document.getElementById("classic-me-discord");
      if ($cd && !$cd.value) $cd.value = me.discordHandle;
    }
    saveDraft({ status: mapStatusFromLegacy(me.status), discordHandle: me.discordHandle });
  } catch { /* offline at boot is fine */ }
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
/**
 * Map the new v2 status values back to the legacy `/presence` enum so
 * the existing roster keeps showing the right pill while the new
 * `/coop/presence` endpoint is the source of truth.
 *
 *   v2 "looking"   → legacy "looking"
 *   v2 "solo"      → legacy "inRun"
 *   v2 "paired"    → legacy "inCoop"
 *   v2 "afk"       → legacy "afk"
 *   v2 "offline"   → legacy "afk" (never explicitly chosen)
 */
function mapStatusToLegacy(s) {
  switch (s) {
    case "solo":    return "inRun";
    case "paired":  return "inCoop";
    case "offline": return "afk";
    default:        return s || "looking";
  }
}

function readMyForm() {
  const raw = (document.querySelector('input[name="status"]:checked') || {}).value || "looking";
  const status = mapStatusToLegacy(raw);
  const discordHandle = (document.getElementById("me-discord")?.value || "").trim();

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
    if (!session) setStatus("offline", "Browsing as guest");
    return;
  }
  if (!session) {
    setStatus("offline", "Browsing as guest");
    return;
  }
  if (!sessionCookieVerified) {
    setStatus("offline", "Sign in to continue");
    return;
  }
  setStatus("trouble", "Trouble reaching server, retrying…");
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
  if (activeTab === "coop" && session) {
    try {
      renderClassicCoopMirror([], [], { inGame: 0, looking: 0, activeNow: 0 });
    } catch (e) { console.warn("early coop mirror paint failed", e); }
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
    setStatus("trouble", "Trouble reaching server, retrying…");
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

/**
 * Auto-AFK + status-accuracy guard.
 *
 * Two real problems we're solving:
 *
 *   A) Stale status: a user clicked "Looking for co-op" 6 hours ago,
 *      walked away from their machine, and is still on the roster as
 *      "looking" while their Discord goes silent. Other players ping
 *      them, get nothing back, churn. We auto-flip to "afk" after 15
 *      minutes of true tab inactivity (no mouse, no keyboard, tab
 *      not focused).
 *
 *   B) Auto-flip clobbering an explicit choice: if the user *just*
 *      manually set "looking" 2 minutes ago and switched to a
 *      different tab to read STS2 strategy, we don't want to flip
 *      them to "afk" the moment they tab away. So `userExplicitStatusAt`
 *      records when they last manually changed; auto-AFK only fires
 *      after the explicit choice is at least IDLE_GRACE_MS old.
 *
 * `inSTS2` is server-derived from the Steam Web API — accuracy on
 * "is this player actually in the game right now" is enforced
 * upstream, not by the client. Nothing here can lie about that.
 */
const IDLE_AFK_AFTER_MS   = 15 * 60_000; // 15 min no activity on page → auto-away
const HIDDEN_AFK_AFTER_MS = 10 * 60_000; // 10 min tab hidden continuously → auto-away
const IDLE_GRACE_MS       = 5  * 60_000; // 5 min after manual choice, no auto-flip
let lastUserActivityAt    = Date.now();
let userExplicitStatusAt  = Date.now();
// Timestamp the auto-AFK loop stamped on the LAST automatic flip
// to "afk". Used to distinguish "user manually picked AFK" (leave
// alone) from "we flipped them automatically and now they're back
// at the keyboard" (restore to Looking so the roster doesn't keep
// showing them grey). Cleared the moment we restore them or the
// user changes status by hand.
let autoAfkActiveSince    = 0;
// Timer started when the page is hidden; fires after HIDDEN_AFK_AFTER_MS
// to flip the user to "away" even if the tab stays open in background.
let hiddenAfkTimer        = null;

function flipToAutoAway(trigger) {
  if (!session?.steamID) return;
  const current = (document.querySelector('input[name="status"]:checked') || {}).value;
  if (!current || current === "afk") return;
  const sinceExplicit = Date.now() - userExplicitStatusAt;
  if (sinceExplicit < IDLE_GRACE_MS) return;
  setRadio("status", "afk");
  saveDraft({ ...readDraft(), status: "afk" });
  schedulePush(0);
  // Dispatch change event so coop-lobbies.js v2 savePresence also fires.
  // Must happen BEFORE setting autoAfkActiveSince so the wireCoopForm
  // listener's reset of autoAfkActiveSince=0 happens first.
  document.querySelector('#status-pills input[name="status"][value="afk"]')
    ?.dispatchEvent(new Event("change", { bubbles: true }));
  autoAfkActiveSince = Date.now();
  sendBeacon("auto-afk-flipped", `from=${current} trigger=${trigger}`);
}

function maybeClearAutoAfkOnActivity() {
  if (!autoAfkActiveSince) return;
  if (!session?.steamID) { autoAfkActiveSince = 0; return; }
  const current = (document.querySelector('input[name="status"]:checked') || {}).value;
  // If they manually moved off AFK already, just drop the flag.
  if (current !== "afk") { autoAfkActiveSince = 0; return; }
  // Restore quietly — the status pill flips back to Looking, the
  // next heartbeat pushes it server-side, and the roster shows
  // them live again without a "you were AFK" toast spamming.
  autoAfkActiveSince = 0;
  setRadio("status", "looking");
  saveDraft({ ...readDraft(), status: "looking" });
  schedulePush(0);
  // Dispatch change event so coop-lobbies.js v2 savePresence also fires.
  document.querySelector('#status-pills input[name="status"][value="looking"]')
    ?.dispatchEvent(new Event("change", { bubbles: true }));
  sendBeacon("auto-afk-restored", "trigger=activity");
}

["mousemove", "mousedown", "keydown", "touchstart", "scroll"].forEach((ev) => {
  window.addEventListener(ev, () => {
    lastUserActivityAt = Date.now();
    // Cheap fast-path — most ticks see autoAfkActiveSince === 0
    // and bail immediately.
    if (autoAfkActiveSince) maybeClearAutoAfkOnActivity();
  }, { passive: true });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    // Tab came back — cancel the hidden-AFK timer and restore if auto-away.
    clearTimeout(hiddenAfkTimer);
    hiddenAfkTimer = null;
    lastUserActivityAt = Date.now();
    if (autoAfkActiveSince) maybeClearAutoAfkOnActivity();
  } else {
    // Tab hidden — start the 10-min background-AFK timer.
    clearTimeout(hiddenAfkTimer);
    hiddenAfkTimer = setTimeout(() => flipToAutoAway("hidden"), HIDDEN_AFK_AFTER_MS);
  }
});

// Flip to away immediately when the user closes the tab or navigates away.
window.addEventListener("pagehide", () => {
  if (!session?.steamID) return;
  const current = (document.querySelector('input[name="status"]:checked') || {}).value;
  if (!current || current === "afk") return;
  // sendBeacon with a Blob so the Worker receives application/json (a plain
  // DOMString defaults to text/plain which the Worker won't parse as JSON).
  const payload = JSON.stringify({ ...readDraft(), status: "afk" });
  navigator.sendBeacon?.(`${API_BASE}/presence`, new Blob([payload], { type: "application/json" }));
  // Also update the Co-op v2 presence (same-origin → vault_session cookie
  // ships automatically, Worker accepts it without an explicit header).
  navigator.sendBeacon?.(`${API_BASE}/coop/presence`,
    new Blob([JSON.stringify({ status: "afk" })], { type: "application/json" })
  );
});

setInterval(() => {
  if (!session?.steamID) return;
  const idleMs = Date.now() - lastUserActivityAt;
  const sinceExplicit = Date.now() - userExplicitStatusAt;
  if (idleMs < IDLE_AFK_AFTER_MS) return;
  if (sinceExplicit < IDLE_GRACE_MS) return;
  const current = (document.querySelector('input[name="status"]:checked') || {}).value;
  if (!current || current === "afk") return;
  // Flip to away; the heartbeat will push it server-side.
  flipToAutoAway(`idle ${Math.round(idleMs / 1000)}s`);
}, 60_000);

async function pushNow(silent) {
  if (!session?.steamID) return;
  const body = readMyForm();
  saveDraft(body);
  // Reflect the new status in the bottom profile dock immediately so
  // the user gets visible feedback that their status switch landed,
  // even before the server round-trip completes.
  renderProfileDock();
  refreshProfilePopoverIfOpen();
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
      setStatus("trouble", "Trouble reaching server, retrying…");
      return;
    }
    if (resp.ok) {
      resetAuthFailures();
      lastSuccessfulHeartbeatAt = Date.now();
      // Honor server-side status override (e.g., Worker detects Steam offline
      // or inSTS2 change and sends back forceStatus to keep client in sync).
      try {
        const data = await resp.json();
        if (data?.forceStatus) {
          const v2 = mapStatusFromLegacy(data.forceStatus);
          if (v2 !== readDraft().status) {
            setRadio("status", v2);
            saveDraft({ ...readDraft(), status: v2 });
            autoAfkActiveSince = v2 === "afk" ? Date.now() : 0;
          }
        }
      } catch { /* response may have no body */ }
    }
    setStatus(resp.ok ? "online" : "trouble", resp.ok ? "Live on the feed" : "Trouble reaching server");
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    console.warn(timedOut ? "presence push timed out" : "presence push error", e);
    setStatus("trouble", timedOut ? "Trouble reaching server, retrying…" : "Trouble reaching server");
  } finally {
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
    if (activeTab === "coop") renderFeed(list);
    updateCoopBadge();
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
    if (activeTab === "coop") renderInbox(lastInbox);
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
    if (row) show(row);
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
  const charName = r.character ? capitalize(r.character) : "Unknown";
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
    <header class="run-preview-head" style="--char-color:${theme.color}">
      <div class="run-preview-name">
        <strong>${esc(charName)}</strong>
        ${Number.isFinite(r.ascension) && r.ascension > 0 ? `<span class="run-preview-asc">A${r.ascension}</span>` : ""}
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
  const ascLabel = `Ascension ${run.ascension ?? 0}`;
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
          ${isDaily ? "" : `<span class="h-hero-asc">${esc(ascLabel)}</span>`}
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
        <img class="h-author-avatar" alt="" src="${esc(h.authorAvatar || "/assets/vault-mark.svg")}" />
        <div class="h-author-meta">
          <strong>${esc(h.authorPersona || "Steam User")}</strong>
          <span class="muted small">${esc(ago)}</span>
        </div>
      </header>

      ${h.caption ? `<blockquote class="h-caption">${esc(h.caption)}</blockquote>` : ""}

      <dl class="h-stat-grid">
        ${isDaily
          ? `<div class="h-stat">
              <dt class="h-stat-label">Mode</dt>
              <dd class="h-stat-num h-stat-num-sm">Daily</dd>
            </div>`
          : `<div class="h-stat">
              <dt class="h-stat-label">Ascension</dt>
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
        <img class="h-comment-avatar" alt="" src="${esc(c.authorAvatar || "/assets/vault-mark.svg")}" />
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
    necrobinder: "Necrobinder", defect: "Defect",
  };
  const k = String(c).toLowerCase();
  return map[k] || c;
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
function wireNewsTabs() {
  const $detail = document.getElementById("news-detail");
  const $list   = document.getElementById("news-list");
  if (!$detail || !$list) return;

  const posts = Array.from($detail.querySelectorAll(".news-post[data-news-id]"));
  if (posts.length === 0) return;

  if (!window.__newsTabsWired) {
    window.__newsTabsWired = true;

    // Paint the left rail once. We deliberately preserve DOM order
    // (newest first because that's how the article markup is
    // ordered in index.html). Each tile has aria-pressed so screen
    // readers get the active state.
    const items = posts.map((p) => {
      const id = p.getAttribute("data-news-id") || "";
      const eyebrow = p.getAttribute("data-news-eyebrow") || "";
      const title = (p.querySelector(".news-post-title")?.textContent || "Untitled").trim();
      const tagsRaw = p.getAttribute("data-news-tags") || "";
      const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 2);
      return `
        <li>
          <button type="button" class="news-list-item" data-news-id="${esc(id)}" aria-pressed="false">
            <span class="news-list-eyebrow">${esc(eyebrow)}</span>
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
  sendBeacon("signout-clear", "scope=kept-history handles=kept");

  clearSessionAndReload();
}

// =========================================================================
// Co-op feed renderer
// =========================================================================
function renderFeed(list) {
  const me = list.find((p) => p.steamID === session.steamID);
  // Surface "Currently paired with @X" inside the user's me-card.
  // Reflects server pair state on every feed refresh, so the banner
  // appears within ~one poll cycle of acceptance and disappears the
  // moment either side ends the pair (or the 4h TTL elapses).
  renderMyPairStatus(me);
  // Bottom-of-sidebar popover and status pill need the same fresh
  // pair state so "In a co-op session with @X" stays in sync with
  // what the Co-op tab shows. Cheap re-render — both calls early-out
  // if the relevant DOM nodes don't exist yet.
  renderProfileDock();
  refreshProfilePopoverIfOpen();

  ensureFeedSearchUI();

  const others = list.filter((p) => p.steamID !== session.steamID);
  const inGame = others.filter((p) => p.inSTS2).length;
  const looking = others.filter((p) => p.status === "looking").length;
  const activeNow = others.filter((p) => isActiveNow(p)).length;

  // Beta-side count + summary. Both are guarded because the Beta UI
  // no longer renders an inline summary <p> (the slim header is the
  // page subtitle in Beta), but #online-count still exists in the
  // Players Looking Now section header.
  const $bCount = document.getElementById("online-count");
  if ($bCount) $bCount.textContent = String(others.length);
  const $bSummary = document.getElementById("online-summary");
  if ($bSummary) {
    $bSummary.textContent = others.length === 0
      ? "No one else has signed up yet. Be the first."
      : `${others.length} signed-up player${others.length === 1 ? "" : "s"} · ` +
        `${activeNow} online · ${looking} looking · ${inGame} in STS2`;
  }

  const $feed = document.getElementById("feed");
  if ($feed && others.length === 0) {
    // Empty state on the Co-op tab. The feed doubles as the "Players
    // Looking Now" list inside the new lobby UI, so the copy is
    // worded around the lobby flow rather than the legacy roster.
    $feed.innerHTML = `
      <div class="feed-empty">
        <p><strong>No other players looking right now.</strong></p>
        <p class="feed-empty-sub">Post a Run so people can join you.</p>
      </div>`;
    // Classic surface still needs its own empty-state copy + count
    // even if Beta took the early return.
    renderClassicCoopMirror(list, others, { inGame, looking, activeNow });
    return;
  }
  if (!$feed) {
    // No Beta feed in the DOM (shouldn't happen, but be defensive).
    renderClassicCoopMirror(list, others, { inGame, looking, activeNow });
    return;
  }

  // Apply the "find anyone" search BEFORE the sort so the visible
  // slice is stable. Empty query is a no-op.
  const filteredOthers = feedSearchQuery
    ? others.filter((p) => feedMatchesText(p, feedSearchQuery))
    : others;

  // Sort with freshness as the dominant factor. Persistent presence means
  // the roster includes everyone who's ever signed in, so a 3-day-old
  // "looking" entry should not outrank someone who heartbeated 30 seconds
  // ago. The freshness bucket is worth far more than any status flag.
  filteredOthers.sort((a, b) => rank(b) - rank(a));
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
    if (p.status === "inRun" || p.status === "solo") n += 10;
    return n;
  }

  const feedSlice = filteredOthers.slice(0, feedVisible);
  const feedRemaining = filteredOthers.length - feedSlice.length;
  let feedHtml = "";
  if (feedSearchQuery) {
    if (filteredOthers.length === 0) {
      feedHtml += `
        <div class="feed-empty">
          <p><strong>No players match &ldquo;${esc(feedSearchQuery)}&rdquo;.</strong></p>
          <p class="feed-empty-sub">Try a different name, Discord handle, or ascension.</p>
          <p><button class="btn-ghost btn-sm" type="button" id="feed-clear-search">Clear search</button></p>
        </div>`;
    } else {
      feedHtml += `<p class="coop-filter-stats">Showing ${feedSlice.length} of ${filteredOthers.length} matching &ldquo;${esc(feedSearchQuery)}&rdquo; · ${others.length} total</p>`;
    }
  }
  feedHtml += feedSlice.map(renderRow).join("");
  if (feedRemaining > 0) {
    feedHtml += `<div class="coop-load-more"><button class="coop-load-more-btn" id="feed-load-more">Show ${Math.min(FEED_PAGE, feedRemaining)} more <span class="coop-load-more-count">(${feedRemaining} left)</span></button></div>`;
  }
  $feed.innerHTML = feedHtml;
  wireFeedActions($feed);
  document.getElementById("feed-load-more")?.addEventListener("click", () => {
    feedVisible += FEED_PAGE;
    renderFeed(list);
  });
  document.getElementById("feed-clear-search")?.addEventListener("click", () => {
    feedSearchQuery = "";
    const $s = document.getElementById("feed-search-input");
    if ($s) $s.value = "";
    renderFeed(list);
  });
  // Classic surface uses the exact same filtered+sorted others so
  // both lists stay in sync (and search affects Classic too).
  renderClassicCoopMirror(list, filteredOthers, { inGame, looking, activeNow });
}

/**
 * Mount the "Find a player" search input above #feed once. Idempotent —
 * the second call bails out. Lives inside the existing
 * .coop-section-head--toggleable block so it inherits the same row
 * layout the toggle button already uses.
 */
function ensureFeedSearchUI() {
  if (document.getElementById("feed-search-bar")) return;
  const $title = document.getElementById("coop-feed-title");
  if (!$title) return;
  const header = $title.closest(".coop-section-head, .coop-section-head--toggleable, header") || $title.parentElement;
  if (!header || header.dataset.feedSearchWired === "1") return;
  header.dataset.feedSearchWired = "1";
  const wrap = document.createElement("div");
  wrap.id = "feed-search-bar";
  wrap.className = "coop-search coop-search--feed";
  wrap.innerHTML = `
    <svg class="coop-search-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.6"/>
      <path d="M10.5 10.5 L13.5 13.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>
    <input
      id="feed-search-input"
      type="search"
      class="coop-search-input"
      placeholder="Find a player (name, Discord, A8…)"
      autocomplete="off"
      spellcheck="false"
      aria-label="Search players looking now"
    />`;
  // Insert after the heading paragraph so the toggle button stays on the right.
  const $sub = document.getElementById("coop-feed-sub");
  ($sub?.parentElement || header).appendChild(wrap);
  const $input = wrap.querySelector("#feed-search-input");
  if ($input) {
    let t = null;
    $input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        feedSearchQuery = String($input.value || "").trim();
        feedVisible = FEED_PAGE;
        classicFeedVisible = FEED_PAGE;
        if (lastFeed && lastFeed.length) renderFeed(lastFeed);
      }, 120);
    });
  }
}

/**
 * Free-text matcher for the Players Looking Now feed. Tokenized; every
 * token must hit something in the haystack (persona / Discord / status
 * label / ascension digit / paired partner name).
 */
function feedMatchesText(row, query) {
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const partner = row?.paired?.partnerPersona || "";
  const statusText = {
    looking: "looking for co-op",
    solo: "in a run solo", inRun: "in a run solo",
    paired: "in co-op paired", inCoop: "in co-op paired",
    afk: "away afk",
  }[row?.status || "looking"] || "";
  const haystack = [
    row?.personaName,
    row?.discordHandle,
    row?.note,
    statusText,
    row?.inSTS2 ? "in sts2 in game" : "",
    partner ? `paired with ${partner}` : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

/**
 * Wire the per-row "Copy Discord" and "Invite to play" buttons. Pulled
 * into a helper so both the Beta `#feed` and the Classic `#classic-feed`
 * containers can share the exact same interaction without duplicating
 * the listeners or accidentally drifting.
 */
function wireFeedActions(root) {
  if (!root) return;
  root.querySelectorAll("button[data-act='discord']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const handle = btn.dataset.handle ?? "";
      navigator.clipboard?.writeText(handle).catch(() => {});
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy Discord"), 1500);
    });
  });
  root.querySelectorAll("button[data-act='invite']").forEach((btn) => {
    btn.addEventListener("click", () => openInviteModal(btn.dataset.id, btn.dataset.name));
  });
}

/**
 * Paint the Classic Co-op surface from the same `list` + `others`
 * already computed by renderFeed. The Classic DOM uses suffixed IDs
 * (#classic-online-summary, #classic-online-count, #classic-feed,
 * #classic-last-updated) so it can sit in the same panel as the Beta
 * surface without ID collisions.
 *
 * `summary.{inGame,looking,activeNow}` are passed in so we don't
 * recompute them — keeps the mirror an O(rows) DOM write only.
 *
 * Idempotent and DOM-safe: every node lookup is guarded so the
 * mirror is a no-op if any classic-side element happens to be
 * missing (e.g., during a partial render or a future markup tweak).
 */
function renderClassicCoopMirror(list, others, summary) {
  const $sub = document.getElementById("classic-online-summary");
  if ($sub) {
    const total = (list || []).length;
    if (total === 0) {
      $sub.textContent = "Loading…";
    } else {
      $sub.textContent =
        `${total} signed-up player${total === 1 ? "" : "s"} · ` +
        `${summary.activeNow} online · ${summary.looking} looking · ` +
        `${summary.inGame} in STS2`;
    }
  }
  const $count = document.getElementById("classic-online-count");
  if ($count) $count.textContent = String((others || []).length);

  const $feed = document.getElementById("classic-feed");
  if ($feed) {
    if ((others || []).length === 0) {
      // Classic uses the original "be the first" copy so it reads
      // like the pre-lobby Co-op page rather than the Beta wording.
      $feed.innerHTML = `<div class="feed-empty"><p>You're on the feed. Be the first someone bumps into.</p></div>`;
    } else {
      const classicSlice = others.slice(0, classicFeedVisible);
      const classicRemaining = others.length - classicSlice.length;
      let classicHtml = classicSlice.map(renderRow).join("");
      if (classicRemaining > 0) {
        classicHtml += `<div class="coop-load-more"><button class="coop-load-more-btn" id="classic-feed-load-more">Show ${Math.min(FEED_PAGE, classicRemaining)} more <span class="coop-load-more-count">(${classicRemaining} left)</span></button></div>`;
      }
      $feed.innerHTML = classicHtml;
      wireFeedActions($feed);
      document.getElementById("classic-feed-load-more")?.addEventListener("click", () => {
        classicFeedVisible += FEED_PAGE;
        renderFeed(lastFeed);
      });
    }
  }

  // Reflect the user's current status into the Classic radios on
  // every poll so the segment stays correct even if the user changes
  // status from the profile popover or another tab.
  const me = (list || []).find((p) => p.steamID === session?.steamID);
  const myStatus = mapStatusFromLegacy(me?.status || "");
  document
    .querySelectorAll('#classic-status-pills input[name="classic-status"]')
    .forEach((r) => { r.checked = r.value === myStatus; });
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
  const tagClass = { looking: "ok", solo: "gold", paired: "ember", afk: "mute",
                     inRun: "gold", inCoop: "ember" }[status] ?? "mute";
  const tagLabel = { looking: "Looking for Co-op", solo: "In a Run", paired: "In Co-op", afk: "Away",
                     inRun: "In a Run", inCoop: "In Co-op" }[status] ?? status;

  // Steam avatar — server-stamped, but defense-in-depth scrub.
  const safeAvatar = (() => {
    try {
      const u = new URL(p.avatarURL ?? "");
      if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
    } catch {}
    return "/assets/vault-mark.svg";
  })();

  const sid = /^\d{17}$/.test(p.steamID) ? p.steamID : "";
  // Use the steamcommunity.com web URL universally — never the
  // `steam://` deep link. The deep link is a Windows-client-only
  // protocol; on iOS Safari it triggers a hard "Safari cannot
  // open the page because the address is invalid" dialog (the
  // iOS Steam app does not register `steam://url/SteamIDPage/`).
  // The web URL works on every browser AND, when the user has
  // the Steam mobile app installed, iOS / Android automatically
  // open it inside that app via Universal Links / App Links — so
  // we get the "open in Steam client" UX on mobile for free
  // without breaking the page for everyone else.
  const steamProfileWeb = sid ? `https://steamcommunity.com/profiles/${sid}` : "#";

  const persona = p.personaName || "Steam User";
  const lastActive = formatRelativeActive(p.updatedAt);
  const freshness = activeFreshnessClass(p.updatedAt);
  // "Playing with @X" pill. Server-derived; populated when a mutually
  // accepted invite has linked this row's user to a partner. Gives
  // social proof on the feed ("these two are co-oping right now")
  // without exposing anything beyond the partner's persona.
  const pairedPartner = (p.paired && p.paired.partnerPersona) ? p.paired.partnerPersona : "";
  const isPairedWithMe = !!(p.paired && session?.steamID && p.paired.partnerID === session.steamID);

  return `
    <article class="row ${status}${pairedPartner ? " row--paired" : ""}" data-sid="${esc(sid)}">
      <img class="avatar" alt="" src="${esc(safeAvatar)}" />
      <div class="meta">
        <div class="meta-line">
          <span class="name">${esc(persona)}</span>
          <span class="tag ${tagClass}">${esc(tagLabel)}</span>
          ${p.inSTS2 ? `<span class="tag live">In STS2</span>` : ""}
          ${pairedPartner ? `<span class="tag paired" title="${isPairedWithMe ? "You're co-oping with this player right now." : "Currently playing with " + esc(pairedPartner)}">${isPairedWithMe ? "Co-op &mdash; with you" : "Co-op &mdash; w/ " + esc(pairedPartner)}</span>` : ""}
          ${lastActive ? `<span class="last-active is-${freshness}" title="Last heartbeat ${esc(p.updatedAt ?? "")}">${esc(lastActive)}</span>` : ""}
        </div>
        <p class="row-hint muted">${pairedPartner && !isPairedWithMe ? "Already in a co-op pairing." : "Send them an invite to play."}</p>
      </div>
      <div class="actions">
        <button class="btn-primary sm" data-act="invite" data-id="${esc(sid)}" data-name="${esc(persona)}"${pairedPartner && !isPairedWithMe ? " disabled" : ""}>${pairedPartner && !isPairedWithMe ? "Busy" : "Invite to play"}</button>
        <a class="action-link" target="_blank" rel="noopener" href="${esc(steamProfileWeb)}" title="Open Steam profile">Steam profile</a>
        ${p.discordHandle ? `<button class="action-link" data-act="discord" data-handle="${esc(p.discordHandle)}">Copy Discord</button>` : ""}
      </div>
    </article>`;
}

/**
 * Render or hide the "Currently paired with @X" banner inside the user's
 * own me-card. Lifecycle:
 *
 *   - The user accepts an invite (or has theirs accepted) → server writes
 *     the pair → next /presence/roster fetch returns `me.paired` → we
 *     surface the banner with an "End co-op" button.
 *
 *   - User clicks End co-op → DELETE /api/pair → both sides clear → next
 *     roster fetch comes back without the pair → banner unmounts.
 *
 *   - 4-hour TTL also clears the pair server-side without action; the
 *     banner just disappears on the following poll.
 */
function renderMyPairStatus(me) {
  const $card = document.querySelector(".me-card");
  if (!$card) return;
  let $banner = document.getElementById("me-pair-banner");
  const partner = me?.paired?.partnerPersona;
  const partnerSid = me?.paired?.partnerID;

  if (!partner) {
    if ($banner) $banner.remove();
    return;
  }

  if (!$banner) {
    $banner = document.createElement("div");
    $banner.id = "me-pair-banner";
    $banner.className = "me-pair-banner";
    // Insert at the top of the me-card so it's the first thing the
    // user sees when their pair is live.
    $card.insertBefore($banner, $card.firstChild);
  }

  const sinceLabel = me.paired.since
    ? formatRelativeActive(me.paired.since).replace(" ago", "").replace("just now", "just now")
    : "";
  $banner.innerHTML = `
    <span class="me-pair-icon" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    </span>
    <span class="me-pair-text">
      <strong>Co-oping with ${esc(partner)}</strong>
      ${sinceLabel ? `<span class="me-pair-since muted">paired ${esc(sinceLabel === "just now" ? "just now" : sinceLabel + " ago")}</span>` : ""}
    </span>
    <button type="button" class="btn-ghost sm" data-action="end-coop" data-partner="${esc(partner)}" data-partner-sid="${esc(partnerSid || "")}">End co-op</button>`;

  $banner.querySelector('[data-action="end-coop"]').addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const r = await fetch(`${API_BASE}/pair`, {
        method: "DELETE",
        credentials: "include",
        headers: { authorization: `Bearer ${session?.sessionToken ?? "__cookie__"}` },
      });
      if (!r.ok) {
        toast(`Couldn't end co-op (${r.status}). Please try again.`);
        btn.disabled = false;
        return;
      }
      sendBeacon("pair-ended", `partner=${partnerSid || "unknown"}`);
      // Optimistically clear the banner; the next pullFeed() will
      // confirm by returning a roster entry without `paired`.
      $banner?.remove();
      toast(`Ended co-op with ${partner}.`);
      // Refresh feed so the partner's row also drops its pill.
      void pullFeed?.();
    } catch (err) {
      toast(`Couldn't end co-op: ${String(err?.message ?? err)}`);
      btn.disabled = false;
    }
  });
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
    renderGlobalInviteBanner([]);
    return;
  }
  $inbox.hidden = false;
  $list.innerHTML = pending.map(renderInboxRow).join("");

  $list.querySelectorAll("button[data-invite-act]").forEach((btn) => {
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
      await pullInbox();
    });
  });

  // Mirror pending invites into the global banner so users on Overview,
  // Characters, etc. see incoming requests without navigating to Co-op.
  renderGlobalInviteBanner(pending);
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
      return "/assets/vault-mark.svg";
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
  // Always use the web profile URL — works on every browser AND
  // auto-deep-links into the Steam mobile app via Universal Links.
  // Earlier this rendered `steam://url/SteamIDPage/<sid>` which on
  // iOS Safari fired "the address is invalid" and stranded the
  // user mid-flow.
  const steamProfileWeb = `https://steamcommunity.com/profiles/${esc(sid)}`;
  // The Steam client `run` deep-link only resolves on desktops with
  // the Steam client installed (Windows / macOS / Linux). On
  // mobile, STS2 isn't available anyway, so we hide the button
  // entirely instead of showing one that errors out.
  const launchSTS = `steam://run/${STS2_APP_ID}`;
  const desktopLikely = isDesktopLikelyToHandleSteamClient();

  if (invite.status === "accepted") {
    // Brief "accepted — here are the deep-links" state.
    return `
      <div class="invite-card invite-accepted">
        <img class="avatar" alt="" src="${esc(safeAvatar)}" />
        <div class="invite-meta">
          <strong>You accepted ${esc(invite.fromPersona)}'s invite</strong>
          <p class="muted small">Add them on Steam${desktopLikely ? ", then launch STS2 from this browser" : ""}.</p>
        </div>
        <div class="invite-actions">
          <a class="btn-primary sm" target="_blank" rel="noopener" href="${steamProfileWeb}" title="Open Steam profile">Open Steam profile</a>
          ${desktopLikely ? `<a class="btn-ghost sm" href="${launchSTS}" title="Launch Slay the Spire 2 via Steam">Launch STS2</a>` : ""}
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
  const r = await InviteAPI.sendInvite(API_BASE, session.sessionToken, pendingInviteToID, messageId);
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
    if (hasFiles(e) && isDropOverlayAllowedHere()) e.preventDefault();
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
    if (items && items.length > 0) {
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind !== "file") continue;
        const entry = it.webkitGetAsEntry?.();
        if (entry) entries.push(entry);
      }
      if (entries.some((en) => en.isDirectory)) {
        void collectFilesFromEntries(entries).then((files) => {
          if (files.length === 0) {
            toast("No .run or .json files found in that folder.");
            return;
          }
          void ingestHistoryFiles(files);
        });
        return;
      }
    }
    // Plain file(s) drop — pass them all to the multi-file ingest.
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
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
function rememberLinkedFolderName(name) {
  try {
    if (name) localStorage.setItem(STORAGE_LINKED_NAME, name);
    else localStorage.removeItem(STORAGE_LINKED_NAME);
  } catch { /* private mode */ }
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

function scanForHistory() {
  console.info("[Vault import] scanForHistory invoked, ua=", navigator.userAgent);
  // CRITICAL: this function MUST run synchronously up to the `.click()`
  // on the hidden input. Safari only honors picker-opening clicks that
  // are inside the same JS task as the user's gesture. Any `await` here
  // (e.g. checking for a saved handle, querying permissions) consumes
  // the user gesture and Safari silently refuses to open the picker.
  // The silent re-read of saved handles still happens on page boot via
  // autoReloadHistoryIfPermitted() — this entry point is just for the
  // explicit Import button.
  if (typeof window.showDirectoryPicker === "function") {
    sendBeacon("ingest-picker-opened", "directory");
    console.info("[Vault import] using showDirectoryPicker (Chromium)");
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
async function scanForHistoryViaDirectoryPicker() {
  // Platform-appropriate path → clipboard so the user can paste into
  // the OS picker (which is its own modal we cannot decorate) instead
  // of hand-navigating to a hidden directory. Best-effort; never
  // blocks. The toast that follows tells them WHAT to do with the
  // pasted path AND reminds them the next click is "Select" — the
  // most common failure mode is "I pasted, I'm at the folder, now
  // what?". A platform-aware copy makes Windows paste-into-address-
  // bar, macOS Cmd+Shift+G, and Linux file-manager flows all clear.
  const platform = detectPlatform();
  let copiedPath = null;
  try {
    if (navigator.clipboard?.writeText) {
      if (platform === "mac") copiedPath = HISTORY_PATH_MAC;
      else if (platform === "windows") copiedPath = HISTORY_PATH_WIN;
      else if (platform === "linux") copiedPath = HISTORY_PATH_LINUX;
      if (copiedPath) await navigator.clipboard.writeText(copiedPath);
    }
  } catch { /* ignore */ }
  if (copiedPath) {
    if (platform === "mac") {
      // The Chrome showDirectoryPicker button literally says "Select"
      // (not "Open"). Earlier copy said Open and confused users who
      // were already at SlayTheSpire2 and didn't know to click Select.
      toast(
        `Path copied. In the picker → press ⌘⇧G → paste → Enter. You'll see SlayTheSpire2 with subfolders (steam, logs, etc.). Click the blue Select button — we walk into steam/<id>/profile1/saves/history automatically.`,
        { duration: 14000 }
      );
    } else if (platform === "windows") {
      toast(
        "Path copied. In the picker → click the address bar at the top → paste → Enter. You'll see SlayTheSpire2. Click the Select Folder button — we walk every subfolder automatically.",
        { duration: 14000 }
      );
    } else {
      toast(
        "Path copied. Press Ctrl+L in the picker → paste → Enter. You'll see SlayTheSpire2. Click the Select button — we walk every subfolder automatically.",
        { duration: 14000 }
      );
    }
  }

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
    if (e?.name !== "AbortError") {
      console.warn("directory picker failed", e);
      toast("Couldn't open the folder picker. Try Import as a fallback.");
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
      await dirHandle.requestPermission({ mode: "read" });
    }
  } catch (e) {
    console.warn("requestPermission on directory failed", e);
  }
  try {
    rememberLinkedFolderName(dirHandle.name || "STS2 saves");
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
        await pickedHandles[0].requestPermission({ mode: "read" });
      }
    } catch (e) { console.warn("requestPermission on file failed", e); }
    try { localStorage.removeItem(STORAGE_DIR_FP); } catch { /* private mode */ }
    lastDirectoryFingerprint = "";
    rememberLinkedFolderName(pickedHandles[0].name || "history.json");
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
  let hasDir = null;
  let hasFile = null;
  try {
    hasDir = await HistoryStore.loadDirectoryHandle();
  } catch { /* ignore */ }
  try {
    hasFile = await HistoryStore.loadHandle();
  } catch { /* ignore */ }
  if (!hasDir && !hasFile) {
    toast("Nothing linked yet. Use Find my STS2 saves or Import first.");
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

// How often the auto-refresh loop re-checks linked saves (folder or
// history.json) for new runs. 30s balances "feels live" vs. disk churn.
// Was 60s — bumped down because users completing a run want their stats
// refreshed *fast*, not "in the next minute".
const HISTORY_REREAD_INTERVAL_MS = 30_000;
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
    publishAutoRefreshState({ phase: "off" });
    return;
  }
  // Snapshot the linked target name so the pill can display it.
  publishAutoRefreshState({ linkedTarget: getLinkedFolderName() || "" });
  wireAutoRefreshUI();
  if (historyRereadTimer) return;
  historyRereadTimer = setInterval(() => {
    void autoReloadHistoryIfPermitted({ silent: true });
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
async function ingestHistoryFiles(files, { silent = false } = {}) {
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
  sendBeacon("ingest-files-chosen", `count=${plausible.length}`);

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
  const committed = await commitParsedRuns(runs, plausible[0]?.name || "save", { silent, fileCount: plausible.length });

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
async function commitParsedRuns(runs, sourceName, { silent, fileCount = 1 }) {
  // Diff against the previously loaded set so a silent auto-refresh that
  // pulls in new runs from disk can speak up *just enough* — a single
  // "X new run(s) detected" toast — without spamming the user with reads
  // that found nothing new. Demo data is excluded from the diff so the
  // first real ingest doesn't surface "47 new runs!" — we suppress new-
  // count reporting on the demo→real transition.
  const wasDemo = isDemoMode;
  const previousIds = wasDemo ? new Set() : new Set(parsedRuns.map((r) => r.id));
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
  sendBeacon(
    "ingest-runs-committed",
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
    toast(`Loaded ${completedRuns.length} run${completedRuns.length === 1 ? "" : "s"} from your save.`);
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
  } else {
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
  // Milestone notifications. We compare the current parsedRuns set
  // against locally persisted "what we've already celebrated" data
  // and surface a celebratory toast for anything new. Suppressed for
  // demo data so a brand-new visitor doesn't get fake congrats.
  if (!wasDemo && !silent) {
    try { evaluateMilestones(); } catch (e) { console.warn("milestones failed", e); }
  } else if (!wasDemo) {
    // Silent auto-refresh path — still evaluate, since a new run can
    // arrive in the background. The toast is the user-facing signal
    // that something cool happened even when their data view didn't
    // visibly change.
    try { evaluateMilestones(); } catch (e) { console.warn("milestones failed", e); }
  }
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
  if (!wasDemo && newWins.length > 0 && newWins.length <= 3 && hadPriorRuns) {
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
    if (!blob || !Array.isArray(blob.runs) || blob.runs.length === 0) {
      return { changed: false, count: parsedRuns.length };
    }

    const cloudRevived = blob.runs.map((r) => reviveRun(r));
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
        // Pick the newer `endedAt` to win — same id but a later
        // end-time means the run was re-finalized (extra floors before
        // game-over, etc.) so prefer the freshly-observed copy.
        const aT = existing.endedAt?.getTime?.() || 0;
        const bT = r.endedAt?.getTime?.() || 0;
        if (bT > aT) { byId.set(r.id, r); cloudOverrides += 1; }
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

    // Re-upload so cloud catches up to any local-only runs we just
    // unioned in. Idempotent via CloudRuns' fingerprint memo — if the
    // merged set matches what cloud already had, this is a no-op.
    try { CloudRuns.upload(merged); } catch { /* fire-and-forget */ }

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
    return { changed: false, count: parsedRuns.length };
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

  function fingerprintForRuns(runs) {
    if (!Array.isArray(runs) || runs.length === 0) return "0:";
    let latest = 0;
    for (const r of runs) {
      const t = r?.endedAt?.getTime?.() ?? 0;
      if (t > latest) latest = t;
    }
    return `${runs.length}:${latest}`;
  }

  // Marshal the rich in-memory run shape down to the lean wire format
  // documented in Backend/src/runs.ts. Strips Date objects (→ ISO),
  // drops fields the server doesn't need, and trims arrays to
  // sanitization-friendly bounds.
  function toWire(r) {
    return {
      id: String(r.id || ""),
      character: String(r.character || ""),
      ascension: Number(r.ascension) || 0,
      floorReached: Number(r.floorReached) || 0,
      won: r.won === true,
      playTimeSeconds: Number(r.playTimeSeconds) || 0,
      endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : new Date().toISOString(),
      startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : undefined,
      seed: r.seed ? String(r.seed) : undefined,
      killedBy: r.killedBy ? String(r.killedBy) : undefined,
      relics: Array.isArray(r.relics) ? r.relics.slice(0, 64).map(String) : [],
      deckAtEnd: Array.isArray(r.deckAtEnd) ? r.deckAtEnd.slice(0, 256).map(String) : [],
      cardChoices: Array.isArray(r.cardChoices)
        ? r.cardChoices.slice(0, 60).map((c) => ({
            floor: Number(c?.floor) || 0,
            picked: c?.picked ? String(c.picked) : undefined,
            skipped: Array.isArray(c?.skipped) ? c.skipped.slice(0, 8).map(String) : [],
          }))
        : undefined,
      neowBonus: r.neowBonus ? String(r.neowBonus) : undefined,
    };
  }

  /** Fire-and-forget upload of the current local run set to the cloud.
   *  Skipped when not signed in, when there's nothing to upload, or
   *  when an upload is already inflight for the same fingerprint. */
  async function upload(runs) {
    if (!session || !session.steamID) return;
    const fp = fingerprintForRuns(runs);
    if (fp === lastUploadFingerprint) return;
    if (inflightUpload) return;

    const body = JSON.stringify({ runs: runs.map(toWire) });
    inflightUpload = (async () => {
      try {
        const r = await fetch("/api/runs", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-vault-source": "web",
            authorization: `Bearer ${session.sessionToken || "__cookie__"}`,
          },
          body,
        });
        if (r.ok) {
          lastUploadFingerprint = fp;
          const j = await r.json().catch(() => ({}));
          sendBeacon("cloud-runs-uploaded",
            `count=${j.count || 0} added=${j.added || 0} truncated=${j.truncated ? 1 : 0}`);
          recordCloudSync(j.count || runs.length);
        } else {
          sendBeacon("cloud-runs-upload-failed", `status=${r.status}`);
          // Surface persistence failures so the user knows their
          // history isn't being saved to their Steam account. The
          // previous silent-fail let users assume sync was working
          // when it wasn't, then they'd lose progress on the next
          // device. Now they see it and can intervene (re-sign-in,
          // check connection, etc.).
          if (r.status === 401 || r.status === 403) {
            toast("Couldn't save to your Steam account — your session expired. Please sign in again.");
          } else if (r.status >= 500) {
            toast(`Couldn't save to your Steam account (server ${r.status}). We'll retry automatically.`);
          } else if (r.status >= 400) {
            toast(`Couldn't save to your Steam account (${r.status}). Please refresh and try again.`);
          }
        }
      } catch (e) {
        sendBeacon("cloud-runs-upload-error", String(e?.message || e).slice(0, 80));
      } finally {
        inflightUpload = null;
      }
    })();
  }

  /** Pull the cloud copy. Returns { runs, count, updatedAt } or null
   *  on auth/network failure. The runs come back as wire-format objects
   *  (ISO date strings, no Date instances) — caller should revive
   *  them via reviveRun() before mixing with parsedRuns. */
  async function download() {
    if (!session || !session.steamID) return null;
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
        return null;
      }
      const j = await r.json();
      return j;
    } catch (e) {
      sendBeacon("cloud-runs-download-error", String(e?.message || e).slice(0, 80));
      return null;
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
    } catch { /* best effort */ }
  }

  /** Reset upload memoization. Call after a sign-in event so the next
   *  upload fires for the now-bound Steam ID even if the run set is
   *  identical to what was last uploaded under the previous identity. */
  function resetFingerprint() {
    lastUploadFingerprint = "";
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
  // While the boot skeleton is up, leave it alone. The hydrate
  // promise will trigger a re-render once cloud responds.
  if (bootSkeletonActive && tab === "overview") return;
  if (parsedRuns.length === 0) {
    $body.innerHTML = renderEmptyState();
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
          if (res?.changed && res.count > 0) {
            toast(`Restored ${res.count} run${res.count === 1 ? "" : "s"} from your Steam account.`);
            // hydrateFromCloudIfAvailable already triggered renderActiveTab.
          } else if (res?.count === 0) {
            toast("Your Steam account has no runs synced yet — drop your save folder once to start.");
          } else {
            toast("Couldn't reach the cloud. Check your connection and try again.");
          }
        } catch (e) {
          toast(`Restore failed: ${String(e?.message || e).slice(0, 80)}`);
          btn.innerHTML = original;
          btn.disabled = false;
        }
      });
    });
    return;
  }
  const report = Stats.summarize(parsedRuns);
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
    case "overview":   $body.innerHTML = prefix + renderOverview(report);     break;
    case "characters": $body.innerHTML = prefix + renderCharactersTab(report); break;
    case "ascensions": $body.innerHTML = prefix + renderAscensionsTab(report); break;
    case "relics":     $body.innerHTML = prefix + renderRelicsTab(report);     break;
    case "cards":      $body.innerHTML = prefix + renderCards(report);         break;
    case "runs":       $body.innerHTML = prefix + renderRecentRuns(parsedRuns); break;
  }
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
        $body.querySelectorAll(".relic-card.is-active").forEach((c) => c.classList.remove("is-active"));
        return;
      }
      const report = Stats.summarize(parsedRuns);
      const bucket = (report.byRelic || []).find((b) => b.key === key) || null;
      slot.innerHTML = renderRelicDetail(key, bucket);
      $body.querySelectorAll(".relic-card.is-active").forEach((c) => c.classList.remove("is-active"));
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
        $body.querySelectorAll(".char-card.is-active").forEach((c) => c.classList.remove("is-active"));
        return;
      }
      const report = Stats.summarize(parsedRuns);
      const bucket = (report.byCharacter || []).find((b) => b.key === key) || null;
      slot.innerHTML = renderCharacterDetail(key, bucket);
      $body.querySelectorAll(".char-card.is-active").forEach((c) => c.classList.remove("is-active"));
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
  // Update Overview sub-text
  if (tab === "overview") {
    document.getElementById("overview-sub").textContent =
      `${report.totalRuns} run${report.totalRuns === 1 ? "" : "s"} · ${(report.overallWinrate * 100).toFixed(0)}% win rate`;
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
        <span class="demo-strip-text">Connect Steam or drop your STS2 save folder to see your own runs &mdash; sign in once and your history follows you to mobile.</span>
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
  const mod = await import("./lib/sts2-run-parser.js");
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
  const charLabel = run.character ? capitalize(run.character) : "Unknown character";
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

function renderEmptyState() {
  const platform = detectPlatform();
  const hasDirPicker = typeof window.showDirectoryPicker === "function";

  // Platform-specific path callout. The path constant points at the
  // SlayTheSpire2/ parent on each OS; the directory walker recurses
  // into steam/<your-id>/profile1/saves/history/, so the user never
  // has to know their numeric Steam ID.
  let pathBlock = "";
  if (platform === "mac") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Your STS2 save folder on macOS</span>
        <code class="path-value">${esc(HISTORY_PATH_MAC)}</code>
        <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="mac" title="Copy path. Paste with Cmd+Shift+G inside the picker.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        After the picker opens, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>, paste, and hit Enter. Your <code>.run</code> files are inside <code>${esc(HISTORY_PATH_MAC_FULL)}</code> — pick any ancestor and we walk into <code>history/</code> for you.
      </p>`;
  } else if (platform === "windows") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Your STS2 save folder on Windows</span>
        <code class="path-value">${esc(HISTORY_PATH_WIN)}</code>
        <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="win" title="Copy path. Paste it into File Explorer's address bar.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        Paste this path into File Explorer's address bar. Your <code>.run</code> files are in <code>${esc(HISTORY_PATH_WIN_FULL)}</code> — pick the <code>SlayTheSpire2</code> parent and we walk into <code>history\\</code> for you.
      </p>`;
  } else if (platform === "linux") {
    pathBlock = `
      <div class="empty-state-path">
        <span class="path-label">Your STS2 save folder on Linux</span>
        <code class="path-value">${esc(HISTORY_PATH_LINUX)}</code>
        <button class="btn-ghost btn-sm" data-action="copy-path" data-path-key="linux" title="Copy path. Paste it into your file manager.">Copy path</button>
      </div>
      <p class="empty-state-tip muted">
        Your <code>.run</code> files are inside <code>${esc(HISTORY_PATH_LINUX_FULL)}</code> — pick any ancestor and we walk into <code>history/</code> for you.
      </p>`;
  }

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
  const headlineHtml = isSignedIn
    ? `<h2>Restore your runs from Steam</h2>
       <p>You're signed in as <strong>${esc(session?.personaName || "Steam User")}</strong>. If you've already uploaded run history on another device, click <strong>Restore my runs from Steam</strong> below and we'll pull your cloud copy now. If this is your first device, point us at your STS2 save folder once and we'll sync it to your Steam account &mdash; <strong>you only do this once.</strong></p>`
    : `<h2>See your STS2 stats — no sign-in required</h2>
       <p>Slay the Spire 2 saves one <code>.run</code> file per game. Point us at your STS2 save folder (or drag it in) and we'll read every run on disk to build your stats. Nothing uploads &mdash; everything stays in your browser. <strong>Sign in with Steam once</strong> to keep your history forever and sync it across devices.</p>`;

  return `
    <div class="empty-state${isSignedIn ? " empty-state--authed" : ""}">
      <div class="empty-state-icon">📂</div>
      ${headlineHtml}
      <div class="empty-state-actions">
        ${cloudRestoreCTA}
        ${primaryCTA}
        ${!isSignedIn ? '<button class="btn-ghost" type="button" data-action="signin-cta"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="margin-right:6px"><path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z"/></svg>Sign in with Steam</button>' : ""}
      </div>
      <p class="empty-state-tip">
        Or drag your STS2 <strong>save folder</strong> (or any <code>.run</code> files) anywhere on this page to load them now.
      </p>
      ${pathBlock}
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
          <li>On Chrome / Edge / Brave / Arc, picking the folder once enables silent auto-refresh on every later visit. The "Linked: <em>folder</em>" pill in the header confirms it.</li>
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
  const oneDay = 24 * 60 * 60 * 1000;
  let thisWeek = 0;
  let prevWeek = 0;
  for (const r of runs) {
    const t = r.endedAt ? r.endedAt.getTime() : (r.startedAt ? r.startedAt.getTime() : 0);
    if (!t) continue;
    const ageDays = (now - t) / oneDay;
    if (ageDays >= 0 && ageDays < 7) thisWeek += 1;
    else if (ageDays >= 7 && ageDays < 14) prevWeek += 1;
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
      <div class="kpi-card" role="listitem" data-tone="${last10Tone}">
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
          ? `One loss &mdash; reset and re-roll`
          : `${streak.count} in a row &mdash; reset and re-roll`)
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
        ? `Set on <strong>${esc(capitalize(longestDetail.character))}</strong>${longestDetail.ascension != null ? ` at A${longestDetail.ascension}` : ""}`
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
    ? `<strong>${esc(capitalize(pb.character || "Unknown"))}</strong>${Number.isFinite(pb.ascension) ? ` at A${pb.ascension}` : ""}${pb.won ? ` &middot; Victory` : ""}`
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
    ? `<strong>${esc(capitalize(fastest.character || "Unknown"))}</strong>${Number.isFinite(fastest.ascension) ? ` at A${fastest.ascension}` : ""}`
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

  return `
    <div class="kpi-strip" role="list" aria-label="At-a-glance KPIs">
      ${recentFormCard}
      ${streakCard}
      ${longestCard}
      ${pbCard}
      ${fastestCard}
      ${cadenceCard}
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

  const phone = isPhoneViewport();
  const w = phone ? 480 : 760;
  const h = 72;
  const padL = phone ? 24 : 30, padR = 6, padT = 4, padB = phone ? 18 : 16;
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
    <text class="axis-label" x="${padL - 4}" y="${yFor(tv) + 3}" text-anchor="end">${Math.round(tv * 100)}%</text>`);
  }
  const gridStr = grid.join("");
  const lifeClamp = Math.min(lifetime, yCeil);
  const baseline = `<line class="baseline" x1="${padL}" x2="${padL + innerW}" y1="${yFor(lifeClamp)}" y2="${yFor(lifeClamp)}"></line>
    <text class="axis-label" x="${padL + innerW}" y="${yFor(lifeClamp) - 2}" text-anchor="end">avg ${(lifetime * 100).toFixed(0)}%</text>`;
  const axis = `
    <line class="axis-line" x1="${padL}" x2="${padL + innerW}" y1="${padT + innerH}" y2="${padT + innerH}"></line>
    <text class="axis-label" x="${padL}" y="${h - 4}">Run #1</text>
    <text class="axis-label" x="${padL + innerW}" y="${h - 4}" text-anchor="end">Run #${sorted.length}</text>`;
  const lineColor = "var(--accent, #ffa05c)";
  const lastPt = points[points.length - 1];

  return `
    <div class="chart-panel">
      <div class="chart-panel-head">
        <div>
          <h3 class="chart-panel-title">Winrate trend</h3>
          <p class="chart-panel-sub">Trailing ${window}-run win rate across your history. Dashed line: lifetime average.</p>
        </div>
      </div>
      <div class="chart-svg-wrap chart-svg-wrap--winrate" style="aspect-ratio: ${w} / ${h};">
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Rolling win rate over time">
        ${gridStr}
        ${baseline}
        <path class="series-fill" d="${dArea}" fill="${lineColor}"></path>
        <path class="series-line" d="${dLine}" stroke="${lineColor}"></path>
        <circle class="series-pt" cx="${xFor(points.length - 1).toFixed(1)}" cy="${yFor(lastPt.wr).toFixed(1)}" r="2.5" fill="${lineColor}"></circle>
        ${axis}
      </svg>
      </div>
    </div>`;
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

  const phone = isPhoneViewport();
  const w = phone ? 480 : 760;
  const h = phone ? 96 : 88;
  const padL = phone ? 22 : 28, padR = 8, padT = 6, padB = phone ? 30 : 26;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const barGap = 2;
  const barW = Math.max(2, (innerW - (series.length - 1) * barGap) / series.length);

  const yFor = (v) => padT + (1 - v / maxCount) * innerH;

  const labelStep = Math.max(1, Math.ceil(series.length / 12));
  const tiltLabels = series.length > 8;

  const bars = series.map((b, i) => {
    const x = padL + i * (barW + barGap);
    const cx = x + barW / 2;
    const total = b.wins + b.losses;
    const yTop = yFor(total);
    const heightTotal = (padT + innerH) - yTop;
    const winsHeight = total > 0 ? heightTotal * (b.wins / total) : 0;
    const lossHeight = heightTotal - winsHeight;
    const showLabel = i % labelStep === 0 || i === series.length - 1;
    const lab = `${b.floor}${binSize > 1 ? `–${b.floor + binSize - 1}` : ""}`;
    const yLab = h - (tiltLabels ? 4 : 6);
    const labSvg = showLabel
      ? (tiltLabels
        ? `<text class="bar-label" transform="rotate(-52 ${cx.toFixed(2)} ${yLab})" x="${cx.toFixed(2)}" y="${yLab}" text-anchor="end">${esc(lab)}</text>`
        : `<text class="bar-label" x="${cx.toFixed(2)}" y="${yLab}" text-anchor="middle">${esc(lab)}</text>`)
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

  // Legend chips
  const legend = `
    <div class="chart-panel-chips" aria-hidden="true">
      <span class="chart-chip" style="border-color: rgba(95,224,154,0.5); color: #6fe091; background: rgba(95,224,154,0.12); cursor: default;">Victories</span>
      <span class="chart-chip" style="border-color: rgba(255,107,107,0.5); color: #ff8888; background: rgba(255,107,107,0.12); cursor: default;">Defeats</span>
    </div>`;

  return `
    <div class="chart-panel">
      <div class="chart-panel-head">
        <div>
          <h3 class="chart-panel-title">Where you end up</h3>
          <p class="chart-panel-sub">Floors where runs end (wins green, losses red). Hover a bar for exact counts.</p>
        </div>
        ${legend}
      </div>
      <div class="chart-svg-wrap chart-svg-wrap--hist" style="aspect-ratio: ${w} / ${h};">
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Floor outcome histogram">
        ${bars}
      </svg>
      </div>
    </div>`;
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
  const ascNums = parsedRuns.map((r) => Number(r.ascension)).filter((n) => Number.isFinite(n));
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
              Best: <strong style="color:${charTheme(bestChar.key).color}">${esc(capitalize(bestChar.key))}</strong>
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
  const charCards = renderCharCards(report.byCharacter, { expandable: false });

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

  return `
    ${kpiStrip}
    ${heroPanel}
    ${secTitle("Trends", "bars")}
    <div class="chart-row">
      ${winrateChart}
      ${deathChart}
    </div>
    ${secTitle("Per character", "people")}
    ${charCards}
    ${secTitle("Top relics", "sparkles", "gold")}
    ${renderRelicCards(report.byRelic.slice(0, 6))}`;
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

function renderSettingsTab() {
  const $body = document.getElementById("settings-body");
  if (!$body) return;

  const linkedName = getLinkedFolderName();
  const isLinked = !!linkedName;
  const runCount = parsedRuns.length;
  const isAuthed = !!session?.sessionToken;
  const personaName = session?.personaName || "";
  const avatarUrl = session?.avatar || "";
  const steamID = session?.steamID || "";
  const lastSyncCount = lastCloudSyncCount;
  const lastSyncAt = lastCloudSyncAt ? formatRelativeActive(lastCloudSyncAt) : "";

  $body.innerHTML = `
    <div class="settings-grid">
      <!-- ───────── Save Data card ───────── -->
      <section class="settings-card">
        <header class="settings-card-head">
          <h3>Save data</h3>
          <p class="settings-card-sub">
            ${isLinked
              ? `Linked to <strong>${esc(linkedName)}</strong>. Auto-refreshing every 60s.`
              : "Link your STS2 save folder to see your runs."}
          </p>
        </header>

        <div class="settings-status-row">
          <div class="settings-status-cell">
            <span class="settings-stat-label">Runs loaded</span>
            <span class="settings-stat-value">${runCount.toLocaleString()}</span>
          </div>
          ${isAuthed && lastSyncCount != null ? `
            <div class="settings-status-cell">
              <span class="settings-stat-label">Cloud sync</span>
              <span class="settings-stat-value">${lastSyncCount.toLocaleString()} run${lastSyncCount === 1 ? "" : "s"}</span>
              ${lastSyncAt ? `<span class="settings-stat-foot">${esc(lastSyncAt)}</span>` : ""}
            </div>
          ` : ""}
          ${isLinked ? `
            <div class="settings-status-cell settings-status-cell--ok">
              <span class="settings-stat-label">Auto refresh</span>
              <span class="settings-stat-value">On</span>
              <span class="settings-stat-foot">Reading folder every 60 seconds</span>
            </div>
          ` : `
            <div class="settings-status-cell settings-status-cell--warn">
              <span class="settings-stat-label">Auto refresh</span>
              <span class="settings-stat-value">Off</span>
              <span class="settings-stat-foot">Link a folder to enable</span>
            </div>
          `}
        </div>

        <div class="settings-action-row">
          <button class="btn-primary" type="button" data-action="upload">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21V9"/><polyline points="7 14 12 9 17 14"/><path d="M5 3h14"/></svg>
            <span>${isLinked ? "Re-pick folder" : "Link save folder"}</span>
          </button>
          <button class="btn-ghost" type="button" data-action="reload-saves" ${!isLinked ? "disabled" : ""}>
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
              : "Signed out. Sign in with Steam to enable cross-device sync, the co-op feed, and community highlights."}
          </p>
        </header>

        ${isAuthed ? `
          <div class="settings-account-row">
            ${avatarUrl ? `<img class="settings-avatar" src="${esc(avatarUrl)}" alt="" />` : `<div class="settings-avatar settings-avatar--placeholder">?</div>`}
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
        </div>
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

  // Wire the settings-only data-actions that don't share handlers with
  // the legacy toolbar. Refresh / Import / Disconnect already pick up
  // the global delegated handlers via their data-action attributes.
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
  try { await HistoryStore.clearHistory({ allScopes: false }); } catch (e) { console.warn(e); }
  try { await HistoryStore.clearDirectoryHandle(); } catch {}
  try { await HistoryStore.clearHandle(); } catch {}
  try { localStorage.removeItem("vault.web.linkedFolderName"); } catch {}
  parsedRuns = [];
  currentRun = null;
  lastDirectoryFingerprint = "";
  lastIngestedMTime = 0;
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
        const wr = (c.winrate * 100).toFixed(1);
        const lossCount = c.runs - c.wins;
        const dataAttrs = expandable
          ? `data-action="char-expand" data-char-key="${esc(c.key)}"`
          : `data-action="goto-tab" data-tab="characters"`;
        return `
          <div class="${cardClass}" style="--char-color:${theme.color}"
               role="button" tabindex="0"
               ${dataAttrs}
               aria-label="${esc(capitalize(c.key))}: ${wr}% winrate over ${c.runs} runs.${expandable ? " Tap to view details." : ""}">
            <div class="char-card-head">
              <div class="char-card-icon">${charPortraitOrIcon(c.key, theme)}</div>
              <span class="char-card-runs">${c.runs} runs</span>
            </div>
            <div class="char-card-name">${esc(capitalize(c.key))}</div>
            <div class="char-card-record">${c.wins} win${c.wins === 1 ? "" : "s"} &middot; ${lossCount} loss${lossCount === 1 ? "" : "es"}</div>
            <div class="char-card-wr">
              <strong class="char-card-pct">${wr}%</strong>
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
// milestone is keyed; once awarded, it's stored in localStorage so we
// don't repeat it. Designed to be quiet — milestones only fire on
// commitParsedRuns (a real ingest), never on idle re-renders, and
// each one fires at most once.
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
function awardMilestone(key, payload) {
  const set = readAwarded();
  if (set.has(key)) return false;
  set.add(key);
  writeAwarded(set);
  showMilestoneToast(payload.title, payload.body, payload.icon);
  // Fire-and-forget analytics ping so we know which milestones land.
  try { sendBeacon("milestone", `key=${encodeURIComponent(key)}`); } catch {}
  vaultGtagEvent("milestone_award", {
    milestone_key: key,
    milestone_title: String(payload.title || "").slice(0, 80),
  });
  return true;
}

/** Compute and award any milestones the user has crossed. Idempotent
 *  — already-awarded keys are skipped via the awarded-set check inside
 *  `awardMilestone`. Cheap to run on every commitParsedRuns. */
function evaluateMilestones() {
  if (!Array.isArray(parsedRuns) || parsedRuns.length === 0) return;
  const total = parsedRuns.length;
  const wins = parsedRuns.filter((r) => r.won).length;
  const longestWinStreak = computeLongestWinStreak(parsedRuns);

  // Run-count tiers
  if (total >= 1)   awardMilestone("runs.1",   { title: "First run logged",      body: "Welcome to The Vault. Your run history is now tracked.", icon: "🎉" });
  if (total >= 10)  awardMilestone("runs.10",  { title: "10 runs",                body: "You're warmed up. Keep climbing.", icon: "📈" });
  if (total >= 25)  awardMilestone("runs.25",  { title: "25 runs logged",         body: "Patterns starting to show. Check the Cards tab.", icon: "🃏" });
  if (total >= 50)  awardMilestone("runs.50",  { title: "50 runs",                body: "Half a hundred climbs. Your stats are getting trustworthy.", icon: "🏔️" });
  if (total >= 100) awardMilestone("runs.100", { title: "100 runs!",              body: "You've officially put time into the Spire.", icon: "💯" });
  if (total >= 250) awardMilestone("runs.250", { title: "250 runs",               body: "Veteran territory. Time to share a Highlight?", icon: "⚔️" });
  if (total >= 500) awardMilestone("runs.500", { title: "500 runs",               body: "Five hundred climbs. The Spire knows your name.", icon: "👑" });

  // Win-count tiers
  if (wins >= 1)  awardMilestone("wins.1",  { title: "First victory!",       body: "You beat the Spire. Open this run from Recent Runs and share it.", icon: "🏆" });
  if (wins >= 5)  awardMilestone("wins.5",  { title: "5 victories",          body: "Reliable climbing. Higher ascensions await.", icon: "⭐" });
  if (wins >= 10) awardMilestone("wins.10", { title: "10 victories",         body: "Double-digit wins. Try the Ascensions tab to push harder.", icon: "🌟" });
  if (wins >= 25) awardMilestone("wins.25", { title: "25 victories",         body: "Quarter-century. Your build crafting is on point.", icon: "💎" });
  if (wins >= 50) awardMilestone("wins.50", { title: "50 victories",         body: "Half a hundred wins. Genuinely impressive.", icon: "👑" });

  // Streaks
  if (longestWinStreak >= 3)  awardMilestone("streak.3",  { title: "3-win streak",  body: "Three in a row. The Spire trembles.", icon: "🔥" });
  if (longestWinStreak >= 5)  awardMilestone("streak.5",  { title: "5-win streak",  body: "Five consecutive wins. You found something.", icon: "🔥" });
  if (longestWinStreak >= 10) awardMilestone("streak.10", { title: "10-win streak!", body: "Ten in a row. That's not luck — that's mastery.", icon: "🔥" });

  // Per-character first clears
  const winsByChar = new Map();
  for (const r of parsedRuns) {
    if (!r.won || !r.character) continue;
    const k = String(r.character).toLowerCase();
    winsByChar.set(k, (winsByChar.get(k) || 0) + 1);
  }
  for (const [character, n] of winsByChar) {
    if (n >= 1) {
      awardMilestone(`char.first-clear.${character}`, {
        title: `First ${capitalize(character)} clear`,
        body: `You beat the Spire as ${capitalize(character)} for the first time. Every character clear unlocks a new flavor of mastery.`,
        icon: "✨",
      });
    }
  }

  // First daily run shared
  const anyDaily = parsedRuns.some((r) => String(r.gameMode || "").toLowerCase() === "daily");
  if (anyDaily) {
    awardMilestone("daily.first", {
      title: "Daily climber",
      body: "First daily run logged. Daily seeds appear with a special badge in Highlights.",
      icon: "🌅",
    });
  }
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
    { id: "watcher",     label: "Watcher",     color: "#c084fc" },
    { id: "regent",      label: "Regent",      color: "#fbbf24" },
    { id: "necrobinder", label: "Necrobinder", color: "#a78bfa" },
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
  const ascStr = run.ascension > 0 ? ` · A${run.ascension}` : "";
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
      <div class="victory-progress" role="progressbar" aria-label="Auto-closes in 7 seconds" aria-valuenow="100">
        <div class="victory-progress-fill"></div>
      </div>
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

  // Slightly longer auto-close because the card is non-blocking now —
  // user can keep scrolling stats behind it. 7s is plenty.
  const timer = setTimeout(dismiss, 7000);

  document.getElementById("victory-dismiss")?.addEventListener("click", () => { clearTimeout(timer); dismiss(); });

  overlay.addEventListener("click", (e) => { if (e.target === overlay) { clearTimeout(timer); dismiss(); } });

  const onKey = (e) => { if (e.key === "Escape") { clearTimeout(timer); dismiss(); document.removeEventListener("keydown", onKey); } };
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
    : `<p class="muted small">You haven't played ${esc(capitalize(charKey))} yet.</p>`;

  if (!info) {
    return `
      <div class="char-detail" data-char-detail="${esc(charKey)}">
        <div class="char-detail-head">
          <h3 class="char-detail-name">${esc(capitalize(charKey))}</h3>
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
            <span class="char-detail-difficulty" title="Difficulty">${stars(info.difficulty)}</span>
          </div>
        </div>
        <button class="char-detail-close" type="button" data-action="char-collapse" aria-label="Close detail panel">&times;</button>
      </div>

      ${personal}

      <div class="char-detail-section">
        <h4 class="char-detail-section-title">Playstyle</h4>
        <p class="char-detail-summary">${esc(info.summary)}</p>
        <div class="char-detail-meters">
          ${meterRow("Aggression", info.playstyle.aggression)}
          ${meterRow("Complexity", info.playstyle.complexity)}
        </div>
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

function renderCharactersTab(report) {
  return `
    ${secTitle("Winrate by character", "people")}
    ${renderCharCards(report.byCharacter, { expandable: true })}
    <div id="char-detail-slot" class="char-detail-slot"></div>`;
}

/** Bar chart matching the desktop app's "Per ascension" panel.
 *  Each bar shows total runs (height proportional to max) with the wins
 *  portion painted in green from the bottom up. */
function renderAscensionsTab(report) {
  // STS2 Early Access caps the live ascension ladder at A9 ("combined
  // challenges stack"). A bucket above A9 should only appear if Mega
  // Crit has shipped a new level — pre-A9 noise from old demo data
  // gets filtered here so the screen never claims A18 exists in a
  // game that doesn't have it. If a future patch raises the cap, the
  // bucket renders cleanly via UNKNOWN_TIER without code changes.
  const STS2_ASC_CAP = 9;
  const allBuckets = report.byAscension
    .slice()
    .sort((a, b) => parseAsc(a.key) - parseAsc(b.key));
  const buckets = allBuckets.filter((b) => parseAsc(b.key) <= STS2_ASC_CAP);
  const hiddenAbove = allBuckets.length - buckets.length;
  if (!buckets.length) {
    return `<p class="muted">No ascension data yet.</p>`;
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

  // Tier legend — condenses the 10+ ascension levels into five honest
  // difficulty bands. Kept above the detailed breakdown so the reader
  // knows what "A4" means before they see their 5.6% winrate at A4.
  const tierLegend = `
    <div class="asc-tier-legend" aria-label="Ascension tiers">
      ${AscInfo.ASCENSION_TIERS.filter((t) => t.band[0] < 10).map((t) => {
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
        const tint = b.winrate >= 0.10 ? "var(--win)" : "var(--accent)";
        const ascLevel = parseAsc(b.key);
        const info = AscInfo.modifierFor(ascLevel);
        const modBadge = info.modifier
          ? `<span class="asc-mod-badge">${esc(info.modifier)}</span>`
          : `<span class="asc-mod-badge asc-mod-badge-plain">${esc(info.tier.label)}</span>`;
        const divider = i === buckets.length - 1 ? "" : " has-divider";
        return `
          <details class="asc-detail-row${divider}" data-asc="${esc(String(ascLevel))}">
            <summary class="asc-detail-summary">
              <span class="asc-detail-key" style="--tier-accent:${info.tier.accent}">${esc(b.key)}</span>
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
    ${secTitle("Per ascension", "bars")}
    ${newLevelsHint}
    ${barChart}
    ${secTitle("Difficulty tiers", "sparkles")}
    ${tierLegend}
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
      <strong>Tap any relic for details.</strong>
    </p>
    ${renderRelicCards(buckets, { expandable: true })}
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
        const tone = winrateTone(b);
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
function renderRelicDetail(relicKey, bucket) {
  const info = RelicInfo.relicInfoFor(relicKey);
  const art = relicImageSrc(relicKey);
  const wr = bucket ? (bucket.winrate * 100).toFixed(1) : "—";
  const tone = bucket ? winrateTone(bucket) : "accent";
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

/** Pick a color tone using the Wilson lower-bound (95% confidence) so a
 *  3-trial 67% relic doesn't look as confident as a 30-trial 67% relic.
 *  - lb >= 0.5  → "win"     (we're 95% confident this beats a coin flip)
 *  - lb >= 0.15 → "gold"    (confidently above a typical baseline)
 *  - else       → "accent"  (small-sample / below baseline)
 *  Falls back to raw winrate when an old engine output is missing `lb`. */
function winrateTone(b) {
  const lb = typeof b?.lb === "number" ? b.lb : (b?.winrate ?? 0);
  if (lb >= 0.5) return "win";
  if (lb >= 0.15) return "gold";
  return "accent";
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
      <div class="card-list-panel">
        ${report.topPickedCards.map((b) => {
          const wr = (b.winrate * 100).toFixed(1);
          const wrCls = winrateTone(b);
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
      <p class="muted">No card-pick data in your history yet.</p>`;

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
let runFilters = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_RUN_FILTERS);
    if (raw) {
      const j = JSON.parse(raw);
      return {
        character: j.character || "all",      // all | ironclad | silent | ...
        outcome: j.outcome || "all",          // all | wins | losses
        ascensionTier: j.ascensionTier || "all", // all | low | mid | high
        search: j.search || "",
      };
    }
  } catch {}
  return { character: "all", outcome: "all", ascensionTier: "all", search: "" };
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
// logic both treat A10 as the maximum. Kept local to the filter
// renderer instead of imported from `coop-lobbies.js` so the Recent
// Runs view never picks up a circular dependency on co-op code.
const STS2_MAX_ASCENSION = 10;

function applyRunFilters(runs) {
  const q = (runFilters.search || "").toLowerCase().trim();
  return runs.filter((r) => {
    if (runFilters.character !== "all" && r.character !== runFilters.character) return false;
    if (runFilters.outcome === "wins" && !r.won) return false;
    if (runFilters.outcome === "losses" && r.won) return false;
    if (runFilters.ascensionTier !== "all") {
      // Clamp legacy / out-of-range ascensions into the STS2 ladder so
      // a stray A20 save from a STS1-leftover importer still buckets
      // cleanly into the top tier instead of vanishing from results.
      const raw = Number.isFinite(r.ascension) ? r.ascension : -1;
      const a = raw < 0 ? -1 : Math.min(STS2_MAX_ASCENSION, raw);
      if (runFilters.ascensionTier === "a0"   && !(a === 0))             return false;
      if (runFilters.ascensionTier === "low"  && !(a >= 1 && a <= 4))    return false;
      if (runFilters.ascensionTier === "mid"  && !(a >= 5 && a <= 8))    return false;
      if (runFilters.ascensionTier === "high" && !(a >= 9 && a <= STS2_MAX_ASCENSION)) return false;
    }
    if (q) {
      const hay = [r.character, r.seed, r.sourceFile, r.won ? "victory win" : "defeat loss"]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const RUN_FILTER_CHARACTERS = ["ironclad", "silent", "defect", "regent", "necrobinder"];
// STS2 ascension buckets: A0 is the default "any character can pick it"
// entry point so it stands alone; A1–A4 covers the early climb;
// A5–A8 the mid climb; A9–A10 is the high-asc bucket where the meta
// sharpens. A11+ is impossible in STS2 — the clamp in applyRunFilters
// folds any rogue legacy save into the top bucket.
const RUN_FILTER_TIERS = [
  { id: "all",  label: "All Asc" },
  { id: "a0",   label: "A0"      },
  { id: "low",  label: "A1–A4"   },
  { id: "mid",  label: "A5–A8"   },
  { id: "high", label: "A9–A10"  },
];
const RUN_FILTER_OUTCOMES = [
  { id: "all",    label: "All" },
  { id: "wins",   label: "Wins" },
  { id: "losses", label: "Losses" },
];

function renderRunFilters(allRuns, filteredCount) {
  // Per-character chips only show characters the user has actually
  // played, plus "All". Avoids listing Necrobinder if you've never
  // touched them, which would just be visual noise.
  const playedChars = new Set(allRuns.map((r) => r.character).filter(Boolean));
  const charsToShow = RUN_FILTER_CHARACTERS.filter((c) => playedChars.has(c));
  const charChips = [
    `<button class="chart-chip" type="button" data-filter-kind="character" data-filter-value="all" aria-pressed="${runFilters.character === "all"}">All</button>`,
    ...charsToShow.map((c) => {
      const theme = charTheme(c);
      return `<button class="chart-chip" type="button" data-char data-filter-kind="character" data-filter-value="${esc(c)}" aria-pressed="${runFilters.character === c}" style="--char-color:${theme.color}">${esc(capitalize(c))}</button>`;
    }),
  ].join("");

  const outcomeChips = RUN_FILTER_OUTCOMES.map((o) => `
    <button class="chart-chip" type="button" data-filter-kind="outcome" data-filter-value="${esc(o.id)}" aria-pressed="${runFilters.outcome === o.id}">${esc(o.label)}</button>
  `).join("");

  const tierChips = RUN_FILTER_TIERS.map((t) => `
    <button class="chart-chip" type="button" data-filter-kind="ascensionTier" data-filter-value="${esc(t.id)}" aria-pressed="${runFilters.ascensionTier === t.id}">${esc(t.label)}</button>
  `).join("");

  const isFiltered = runFilters.character !== "all" || runFilters.outcome !== "all" || runFilters.ascensionTier !== "all" || (runFilters.search || "").trim() !== "";
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
        ${outcomeChips}
      </div>
      <div class="run-filter-group">
        <span class="run-filter-label">Ascension</span>
        ${tierChips}
      </div>
      <div class="run-filter-group">
        <span class="run-filter-label">Character</span>
        ${charChips}
      </div>
      <label class="run-filter-search" aria-label="Search runs">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="search" placeholder="Search seed, character, win/loss…" value="${esc(runFilters.search || "")}" data-filter-kind="search" />
      </label>
      ${compareToggle}
      <p class="run-filter-summary">${summary}</p>
    </div>`;
}

function renderRecentRuns(runs) {
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
      <strong>Tap any run</strong> to see your full Act timeline — every combat, elite, shop, and rest you walked through, with the floor where the run ended marked.
    </p>
    <div class="run-list">
      ${slice.map((r) => {
        const theme = charTheme(r.character);
        const charName = r.character ? capitalize(r.character) : "Unknown";
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
                  ${Number.isFinite(r.ascension) ? `<span class="pill pill-gold">A${r.ascension}</span>` : ""}
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
function setStatus(state, label) {
  const $dot = document.getElementById("status-dot");
  const $lbl = document.getElementById("status-label");
  if ($dot) $dot.dataset.state = state;
  if ($lbl) $lbl.textContent = label;
  // Mirror to the mobile-only account row so phone users see the same
  // connection status indicator the desktop sidebar shows.
  const $dotM = document.getElementById("status-dot-mobile");
  const $lblM = document.getElementById("status-label-mobile");
  if ($dotM) $dotM.dataset.state = state;
  if ($lblM) $lblM.textContent = label;
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

const PROFILE_STATUS_LABELS = {
  looking: "Looking for Co-op",
  solo:    "In a Run",   paired: "In Co-op",   afk: "Away",
  inRun:   "In a Run",   inCoop: "In Co-op",
};

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

/**
 * Effective status for the bottom-of-sidebar pill. When the server has
 * confirmed a pair, this overrides whatever the user typed into the
 * status form — staying out of sync with the verified pair state would
 * be misleading. Otherwise we honor the user's drafted choice.
 */
function getEffectiveStatus() {
  if (getMyPairFromFeed()) return "paired";
  const draft = readDraft();
  return draft.status || "looking";
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

  $pill.hidden = false;
  if ($pillBtn) {
    $pillBtn.disabled = false;
    $pillBtn.classList.add("is-actionable");
  }

  const status = getEffectiveStatus();
  $pill.dataset.status = status;
  $pill.textContent = PROFILE_STATUS_LABELS[status] || status;

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
    || "/assets/vault-mark.svg";
  const handle = `Steam · ${persona}`;

  const pair = getMyPairFromFeed();
  const effectiveStatus = getEffectiveStatus();
  const inbox = (lastInbox || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const outbox = (lastOutbox || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const pending = inbox.filter((i) => i.status === "pending");
  const sentPending = outbox.filter((i) => i.status === "pending").length;

  // Server enforces "in co-op" while paired, so the segmented control
  // visually locks rather than fights the server. We still show the
  // pressed pill — just block presses on the others.
  const statusLocked = !!pair;
  const segOrder = ["looking", "solo", "paired", "afk"];
  const segShort = { looking: "Looking", solo: "In a Run", paired: "In Co-op", afk: "Away" };
  const segHtml = segOrder.map((k) => {
    const pressed = effectiveStatus === k;
    return `<button type="button"
                    role="radio"
                    aria-pressed="${pressed}"
                    aria-checked="${pressed}"
                    data-pop-action="set-status"
                    data-status="${k}"
                    ${statusLocked && !pressed ? "tabindex=\"-1\" aria-disabled=\"true\"" : ""}
            >${esc(segShort[k])}</button>`;
  }).join("");

  el.innerHTML = `
    <div class="profile-pop-head">
      <img class="profile-pop-avatar" alt="" src="${esc(avatar)}" />
      <div class="profile-pop-id">
        <strong>${esc(persona)}</strong>
        <span class="muted">${esc(handle)}</span>
      </div>
      <button class="profile-pop-close" type="button" data-pop-action="close" aria-label="Close">&times;</button>
    </div>

    <section class="profile-pop-section" data-pop-section="status">
      <header class="profile-pop-section-head">
        <span>Status</span>
      </header>
      <div class="profile-pop-status-seg" role="radiogroup" aria-label="Status" data-locked="${statusLocked}">
        ${segHtml}
      </div>
      ${statusLocked ? `<p class="profile-pop-status-lock">Auto-set while you're in a co-op pairing.</p>` : ""}
    </section>

    <section class="profile-pop-section" data-pop-section="party">
      <header class="profile-pop-section-head">
        <span class="profile-pop-section-dot ${pair ? "is-live" : ""}" aria-hidden="true"></span>
        <span>Co-op Pairing</span>
      </header>
      ${renderProfilePopoverPair(pair)}
    </section>

    <section class="profile-pop-section" data-pop-section="invites-in">
      <header class="profile-pop-section-head">
        <span class="profile-pop-section-dot ${pending.length ? "is-hot" : ""}" aria-hidden="true"></span>
        <span>Invites received${renderSectionCount(pending.length)}</span>
      </header>
      ${inbox.length
        ? `<ul class="profile-pop-list">${inbox.map(renderProfilePopoverInboxRow).join("")}</ul>`
        : `<p class="profile-pop-empty">No invites yet.</p>`}
    </section>

    <section class="profile-pop-section" data-pop-section="invites-out">
      <header class="profile-pop-section-head">
        <span class="profile-pop-section-dot ${sentPending ? "is-hot" : ""}" aria-hidden="true"></span>
        <span>Invites sent${renderSectionCount(outbox.length)}</span>
      </header>
      ${outbox.length
        ? `<ul class="profile-pop-list">${outbox.map(renderProfilePopoverOutboxRow).join("")}</ul>`
        : `<p class="profile-pop-empty">No outgoing invites.</p>`}
    </section>

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
      <img class="profile-pop-pair-avatar" alt="" src="${esc(partner.partnerAvatar || "/assets/vault-mark.svg")}" />
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
    return "/assets/vault-mark.svg";
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
    return "/assets/vault-mark.svg";
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
      if (action === "set-status") {
        // Segmented control: pressed pill is the active status.
        // No-op when locked (server enforces "in co-op" while paired).
        const seg = node.closest(".profile-pop-status-seg");
        if (seg && seg.dataset.locked === "true") return;
        const next = node.dataset.status;
        if (!next) return;
        const draft = readDraft();
        if (draft.status === next) return;
        draft.status = next;
        saveDraft(draft);
        try { setRadio("status", next); } catch {}
        // Optimistic visual update before the round-trip lands.
        seg?.querySelectorAll("[data-pop-action='set-status']").forEach((btn) => {
          const pressed = btn.dataset.status === next;
          btn.setAttribute("aria-pressed", String(pressed));
          btn.setAttribute("aria-checked", String(pressed));
        });
        renderProfileDock();
        void pushNow(false);
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

  // Segmented status pills are wired through the generic
  // [data-pop-action="set-status"] handler above; nothing else
  // to bind here.
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

function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
  // The Classic Co-op surface mirrors the same status set under a
  // separate radio group (name="classic-status") so it can coexist
  // with the Beta radios in the same panel. Keep them in lockstep
  // so flipping status from either surface is reflected everywhere.
  if (name === "status") {
    const classic = document.querySelector(`input[name="classic-status"][value="${value}"]`);
    if (classic) classic.checked = true;
  }
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
      (isCoopSandboxEnabled() && /^local-[a-z0-9_-]+$/i.test(sid));
    if (j && sidOk && j.sessionToken) return j;
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
    const charName = r.character ? capitalize(r.character) : "Unknown";
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
              ${Number.isFinite(r.ascension) ? `<span class="pill pill-gold">A${r.ascension}</span>` : ""}
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
  const theme = charTheme(r.character);
  const charName = r.character ? capitalize(r.character) : "Unknown";
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
          ${Number.isFinite(r.ascension) ? `<span class="pill pill-gold">A${r.ascension}</span>` : ""}
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
  const summarize = (nodes) => {
    const counts = {};
    nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
    const order = ["combat", "elite", "shop", "rest", "event", "chest", "boss"];
    return order
      .filter((k) => counts[k])
      .map((k) => `${counts[k]} ${nodeLabel(k).toLowerCase()}${counts[k] > 1 ? "s" : ""}`)
      .join(" · ");
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
        <span class="run-detail-section-count">${path.reduce((n, a) => n + (a.nodes?.length || 0), 0)} nodes</span>
      </div>
      <p class="run-detail-section-sub muted small">
        The actual sequence of rooms you walked through, taken from your <code>.run</code> file. We don't show
        the unvisited branches because the save data only records nodes you visited.
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
// Recent Runs filters
// =========================================================================
function wireRunFilters() {
  document.addEventListener("click", (e) => {
    const chip = e.target.closest('[data-filter-kind]');
    if (chip && chip.tagName === "BUTTON") {
      const kind = chip.dataset.filterKind;
      const value = chip.dataset.filterValue;
      if (kind && value && (kind === "character" || kind === "outcome" || kind === "ascensionTier")) {
        runFilters[kind] = value;
        persistRunFilters();
        if (activeTab === "runs") renderStatsTab("runs");
      }
      return;
    }
    const clear = e.target.closest('[data-action="clear-filters"]');
    if (clear) {
      e.preventDefault();
      runFilters = { character: "all", outcome: "all", ascensionTier: "all", search: "" };
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
  // First draw with whatever's already cached (typically nothing on the
  // first share of a session). Then async-load the character portrait,
  // every relic icon, and the highlighted card art in parallel and
  // re-draw with the images embedded once they're ready, so the canvas
  // updates from the text-only fallback to the polished art version.
  drawShareCard(run);
  void preloadAndRedrawShareCard(run);
  $modal.hidden = false;
  document.body.style.overflow = "hidden";
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
  const charName = run.character ? capitalize(run.character) : "Unknown";
  const outcome  = run.won === true ? "✅ **VICTORY**" : "💀 **DEFEAT**";
  const asc      = Number.isFinite(run.ascension) ? `A${run.ascension}` : "?";
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
  const charName = run.character ? capitalize(run.character) : "Unknown";
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
    pillX += drawPill(ctx, pillX, pillY, `ASCENSION ${ascDisplay}`, "#d4af37", true) + 8;
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
  const brandTagText  = "The Vault · run tracker for Slay the Spire 2";
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
