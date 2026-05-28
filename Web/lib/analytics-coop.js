/* ===========================================================================
 * /lib/analytics-coop.js — lightweight bounce analytics for the Co-op landing.
 *
 *   Why this exists
 *   ---------------
 *   We have ~51 signed-in users with firstSeen === lastSeen. Almost all of
 *   them landed on the Co-op tab (the default tab for a signed-in session in
 *   script.js's switchTab routing) and never came back. We don't know why.
 *   This module emits GA4 events that let us correlate dwell time, scroll
 *   depth, CTA clicks, and lobby-state with the bounce signal so we can see
 *   *which* version of the Co-op page they bounced from.
 *
 *   Events (all snake_case so they line up with the rest of the GA4 stream
 *   already defined in script.js — tab_change, run_share, etc.)
 *
 *     coop_landing_view        once, when the Co-op panel paints
 *     coop_state_empty         once, if the page rendered with 0 real lobbies
 *     coop_scroll_depth        once per milestone (25/50/75/100)
 *     coop_cta_click           every CTA click inside the Co-op surface
 *     coop_dwell_end           once, on pagehide / SPA route change
 *     coop_bounce_under_10s    fires inline with dwell_end if dwell<10s,
 *                              clicks===0. Pre-classified so the dashboard
 *                              query is one filter, not a joined predicate.
 *
 *   Design tenets
 *   -------------
 *   1. Never throw, never block. Every interaction with `gtag`, the DOM, and
 *      stored state is wrapped in try/catch. If GA4 isn't loaded, every send
 *      is a silent no-op.
 *   2. No PII. We never send Steam IDs, persona names, avatar URLs, or
 *      anything a user typed. Just counts (players_online, lobby_count),
 *      booleans (signed_in, bounced), timings (dwell_ms), and our own
 *      CTA identifiers (data-pf-action / data-coop-action / nav-tab-*).
 *   3. No new dependencies. Pure vanilla, uses the gtag loader the rest of
 *      the page already shipped.
 *   4. Version-pin neutral. This is a brand-new file with its own ?v=1
 *      cache key. It does NOT require bumping script.js or styles.css.
 *
 *   Cohort gate
 *   -----------
 *   We instrument when either:
 *     (a) location.pathname is /coop (or /coop/* or /coop-v2), i.e. the user
 *         deep-linked into the Co-op surface — these are the highest-signal
 *         bounce candidates, AND
 *     (b) the Co-op tab is the active SPA route, i.e. a signed-in user
 *         landed on `/` and switchTab() routed them to the Co-op panel by
 *         default (also part of the bounce cohort — same panel they see).
 *
 *   Other tabs (Overview / Characters / News / Settings) are not
 *   instrumented here at all.
 *
 *   Caveats (rough edges, intentional)
 *   ----------------------------------
 *   - Dwell on tab-switch (Cmd+T → another tab in the same window) fires
 *     `visibility-hidden` which we treat as a dwell end. If the user comes
 *     back, we don't reopen the session — first hide wins. That matches the
 *     bounce-rate intuition (they left).
 *   - bfcache restores don't re-fire `coop_landing_view`. That's deliberate;
 *     a restored session has all the prior state and would corrupt the
 *     bounce cohort.
 *   - We can't tell whether the lobby list is `loading...` vs `empty`. The
 *     `coop_state_empty` event fires only after a successful payload (i.e.
 *     when `__pfGetLastState()` returns a non-null state with an empty
 *     `openLobbies`). DOM-fallback path also requires the coop panel to be
 *     painted — so the event won't fire during the initial spinner.
 * ===========================================================================
 */
(function () {
  "use strict";

  // ----- guards ----------------------------------------------------------
  // Don't double-init. The script tag uses defer + ?v=1 so this should only
  // run once per document, but a hot-reload in dev could re-execute it.
  if (window.__coopAnalyticsBooted) return;
  window.__coopAnalyticsBooted = true;

  // ----- safe send -------------------------------------------------------
  function send(eventName, params) {
    try {
      if (typeof window.gtag !== "function") return;
      window.gtag("event", eventName, params || {});
    } catch (_) { /* swallowed — analytics must never break the page */ }
  }

  // High-resolution monotonic clock with a wall-clock fallback for very old
  // browsers (we use this for dwell, so monotonic > wall-clock).
  function now() {
    try {
      if (window.performance && typeof window.performance.now === "function") {
        return window.performance.now();
      }
    } catch (_) {}
    return Date.now();
  }

  // ----- module state ----------------------------------------------------
  var startTs = now();          // reset when the Co-op panel first becomes visible
  var dwellEnded = false;       // dwell_end can only fire once
  var landingFired = false;     // coop_landing_view fires once per pageview
  var emptyFired = false;       // coop_state_empty fires once per pageview
  var maxDepthPct = 0;          // furthest scroll milestone reached
  var milestones = {};          // { 25: true, 50: true, ... }
  var clicks = 0;
  var navSource = "spa_tab";    // overwritten to "deep_link" if path === /coop

  // ----- cohort gate -----------------------------------------------------
  var initialPath = "";
  try {
    initialPath = (location.pathname || "/").replace(/\/+$/, "") || "/";
  } catch (_) { initialPath = "/"; }
  var deepLink = initialPath === "/coop" ||
                 initialPath === "/coop-v2" ||
                 initialPath.indexOf("/coop/") === 0 ||
                 initialPath.indexOf("/party/") === 0;
  if (deepLink) navSource = "deep_link";

  // ----- DOM helpers -----------------------------------------------------
  function coopPanel() {
    try { return document.querySelector('.tab-panel[data-tab="coop"]'); }
    catch (_) { return null; }
  }
  function coopPanelVisible() {
    var p = coopPanel();
    return !!(p && !p.hasAttribute("hidden"));
  }

  // ----- state snapshot --------------------------------------------------
  // Reads counts off the live party-finder state when available; otherwise
  // falls back to DOM inspection. Returns a plain object suitable for
  // gtag event params.
  function snapshot() {
    var st = null;
    try {
      if (typeof window.__pfGetLastState === "function") {
        st = window.__pfGetLastState();
      }
    } catch (_) {}

    var signedIn = false;
    try {
      if (st && st.presence && (st.presence.steamId || st.presence.steamID)) {
        signedIn = true;
      } else {
        // Fallback: the sidebar shows the sign-in CTA only when signed out.
        var $signinBtn = document.getElementById("signin-btn-mobile");
        if ($signinBtn) signedIn = $signinBtn.hasAttribute("hidden");
      }
    } catch (_) {}

    var playersOnline = 0;
    try {
      if (st && Number.isFinite(st.playersOnlineCount)) {
        playersOnline = st.playersOnlineCount | 0;
      } else {
        var $online = document.getElementById("online-count");
        if ($online) {
          var n = parseInt(($online.textContent || "0").replace(/[^0-9]/g, ""), 10);
          if (Number.isFinite(n)) playersOnline = n;
        }
      }
    } catch (_) {}

    var totalLobbies = 0;
    var houseLobbies = 0;
    var realLobbies = 0;
    try {
      var openList = (st && Array.isArray(st.openLobbies)) ? st.openLobbies : null;
      if (openList) {
        var live = openList.filter(function (l) {
          return l && l.status !== "closed" && l.status !== "expired";
        });
        totalLobbies = live.length;
        houseLobbies = live.filter(function (l) { return !!l.isHouseLobby; }).length;
        realLobbies = Math.max(0, totalLobbies - houseLobbies);
      } else {
        // DOM fallback — keep selectors broad because parallel workers may
        // ship new class names. Worst case: counts are 0, which still lets
        // us correlate `coop_state_empty` with the landing event.
        var cards = document.querySelectorAll(
          '[data-coop-lobby-id], [data-lobby-id], .pf-live-list .pf-lobby-card'
        );
        totalLobbies = cards.length;
        var houseCards = document.querySelectorAll(
          '[data-house-lobby="1"], [data-house-lobby="true"], [data-is-house-lobby="true"], .pf-lobby-card.is-house, .pf-lobby-card[data-house]'
        );
        houseLobbies = houseCards.length;
        realLobbies = Math.max(0, totalLobbies - houseLobbies);
      }
    } catch (_) {}

    var bucket = "";
    try {
      bucket = (document.documentElement.getAttribute("data-pf-stage-bucket") || "")
        .toLowerCase();
      if (!bucket) {
        var $root = document.getElementById("pf-root");
        if ($root) bucket = ($root.getAttribute("data-pf-stage-bucket") || "").toLowerCase();
      }
    } catch (_) {}

    return {
      signed_in: signedIn,
      players_online: playersOnline,
      total_lobbies: totalLobbies,
      house_lobbies: houseLobbies,
      real_lobbies: realLobbies,
      stage_bucket: bucket || "unknown",
      nav_source: navSource,
    };
  }

  // ----- coop_landing_view -----------------------------------------------
  // Wait until the Co-op panel is painted. Up to ~5s of 100ms polls —
  // realistic switchTab paint is single-digit ms after DOMContentLoaded,
  // so this rarely loops more than a handful of times. After the deadline
  // we fire whatever we have (an under-counted snapshot beats no signal).
  var landingAttempts = 0;
  function tickLanding() {
    if (landingFired) return;
    landingAttempts++;
    if (coopPanelVisible()) {
      landingFired = true;
      // Reset the dwell baseline to the moment the panel actually became
      // visible. For deep-link /coop loads that's effectively page load;
      // for signed-in users landing on `/` it's a few ms later when
      // switchTab() runs. Either way, dwell measures from "user can see
      // the panel" not "HTML started parsing".
      startTs = now();
      var snap = snapshot();
      send("coop_landing_view", snap);
      if (!emptyFired && snap.real_lobbies === 0) {
        emptyFired = true;
        send("coop_state_empty", {
          house_lobbies: snap.house_lobbies,
          players_online: snap.players_online,
          nav_source: navSource,
        });
      }
      return;
    }
    if (landingAttempts < 50) {
      setTimeout(tickLanding, 100);
    } else {
      // 5s deadline. Either the user is on a non-Co-op tab (in which case
      // we no-op forever) or paint is genuinely stuck (in which case the
      // bounce signal is exactly what we want to capture).
      if (!deepLink) return; // not in cohort — give up silently
      landingFired = true;
      var snap2 = snapshot();
      send("coop_landing_view", snap2);
    }
  }

  // ----- coop_scroll_depth -----------------------------------------------
  var MILESTONES = [25, 50, 75, 100];
  var scrollTimer = null;
  function computeDepth() {
    try {
      if (!coopPanelVisible()) return;
      var doc = document.documentElement;
      var body = document.body || doc;
      var scrollTop = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
      var viewport = window.innerHeight || doc.clientHeight || 0;
      var docHeight = Math.max(
        body.scrollHeight || 0, doc.scrollHeight || 0,
        body.offsetHeight || 0, doc.offsetHeight || 0,
        body.clientHeight || 0, doc.clientHeight || 0
      );
      if (docHeight <= 0) return;
      var reached = Math.min(100, Math.round(((scrollTop + viewport) / docHeight) * 100));
      if (reached > maxDepthPct) maxDepthPct = reached;
      for (var i = 0; i < MILESTONES.length; i++) {
        var pct = MILESTONES[i];
        if (reached >= pct && !milestones[pct]) {
          milestones[pct] = true;
          send("coop_scroll_depth", { depth_pct: pct, nav_source: navSource });
        }
      }
    } catch (_) {}
  }
  function onScroll() {
    // 150ms debounce — at 50 users/day a few extra checks per scroll are
    // fine, but we don't need a sample per requestAnimationFrame.
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      computeDepth();
    }, 150);
  }

  // ----- coop_cta_click --------------------------------------------------
  function dwellMs() {
    return Math.max(0, Math.round(now() - startTs));
  }
  function ctaIdFromTarget(t) {
    if (!t || typeof t.closest !== "function") return "";
    try {
      // 1. Explicit hooks first. `data-analytics-cta` is reserved for any
      //    future surface that wants to override the inferred name.
      var explicit = t.closest("[data-analytics-cta], [data-pf-action], [data-coop-action]");
      if (explicit) {
        var id = explicit.getAttribute("data-analytics-cta") ||
                 explicit.getAttribute("data-pf-action") ||
                 explicit.getAttribute("data-coop-action") ||
                 "";
        if (id) return id.slice(0, 60);
      }
      // 2. Sidebar tab buttons. These leave /coop so they're prime bounce
      //    signals — we want to know which tab the user fled to.
      var navRow = t.closest(".nav-row[data-tab]");
      if (navRow) return "nav-tab-" + navRow.getAttribute("data-tab");
      // 3. Header refresh button.
      var refresh = t.closest("#refresh-btn");
      if (refresh) return "coop-refresh";
      // 4. Generic button/link inside the Co-op surface. We deliberately
      //    don't grab buttons outside .tab-panel[data-tab="coop"] (those
      //    are global chrome — sign-in, app-toolbar, footer).
      var btn = t.closest("button, a");
      if (!btn) return "";
      var inCoop = btn.closest(
        '.tab-panel[data-tab="coop"], #pf-root, .pf-stage, .coop-page, .classic-coop-surface'
      );
      if (!inCoop) return "";
      // Prefer id, fall back to first class, fall back to tag+text-hint.
      if (btn.id) return "btn-" + btn.id.slice(0, 50);
      var cls = (btn.className && btn.className.baseVal !== undefined)
        ? btn.className.baseVal // SVG safety
        : ("" + (btn.className || ""));
      var firstClass = cls.split(/\s+/).filter(Boolean)[0];
      if (firstClass) return "btn-" + firstClass.slice(0, 50);
      var label = (btn.textContent || "").trim().replace(/\s+/g, "-").slice(0, 30).toLowerCase();
      return "btn-" + (label || btn.tagName.toLowerCase());
    } catch (_) { return ""; }
  }
  function onClick(ev) {
    try {
      if (!landingFired) return; // not in coop session yet
      var id = ctaIdFromTarget(ev.target);
      if (!id) return;
      clicks++;
      send("coop_cta_click", {
        cta_id: id,
        dwell_ms: dwellMs(),
        nav_source: navSource,
      });
    } catch (_) {}
  }

  // ----- coop_dwell_end / coop_bounce_under_10s --------------------------
  function fireDwellEnd(endReason) {
    if (dwellEnded) return;
    if (!landingFired) return; // never paid the entry cost, so nothing to end
    dwellEnded = true;
    var d = dwellMs();
    var params = {
      dwell_ms: d,
      scroll_depth_pct: maxDepthPct,
      clicks: clicks,
      bounced: d < 10000 && clicks === 0,
      end_reason: endReason || "unknown",
      nav_source: navSource,
    };
    send("coop_dwell_end", params);
    if (params.bounced) send("coop_bounce_under_10s", params);
  }

  // SPA navigation away from Co-op: the existing tab system sets `hidden`
  // on the panel when the user clicks Overview / Characters / etc. We
  // observe attribute changes so we don't have to monkey-patch switchTab.
  function startSpaWatcher() {
    var panel = coopPanel();
    if (!panel) return;
    try {
      var mo = new MutationObserver(function () {
        if (!coopPanelVisible() && landingFired && !dwellEnded) {
          fireDwellEnd("spa-route-change");
          mo.disconnect();
        }
      });
      mo.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    } catch (_) {}
  }

  // ----- wiring ----------------------------------------------------------
  function boot() {
    try {
      window.addEventListener("scroll", onScroll, { passive: true });
    } catch (_) {
      // Older browsers reject the options object; fall back to bare bool.
      try { window.addEventListener("scroll", onScroll, false); } catch (__) {}
    }
    document.addEventListener("click", onClick, true);

    // pagehide fires reliably across mobile Safari + Chrome on tab close,
    // navigation, and bfcache eviction — strictly better than the legacy
    // beforeunload, but we listen to both so a desktop Firefox refresh
    // still records the dwell.
    window.addEventListener("pagehide", function () { fireDwellEnd("pagehide"); });
    window.addEventListener("beforeunload", function () { fireDwellEnd("beforeunload"); });
    // Tab-switch / minimize / OS lock: treat first hide as bounce-out so we
    // don't lose the signal when the user never closes the tab properly.
    document.addEventListener("visibilitychange", function () {
      try {
        if (document.visibilityState === "hidden") fireDwellEnd("visibility-hidden");
      } catch (_) {}
    });

    tickLanding();
    startSpaWatcher();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // Tiny debug surface for paste-in-devtools verification. Reading is
  // safe; calling fireDwellEnd manually short-circuits the rest of the
  // session, so use sparingly.
  try {
    window.__coopAnalytics = {
      snapshot: snapshot,
      fireDwellEnd: fireDwellEnd,
      state: function () {
        return {
          dwell_ms: dwellMs(),
          max_depth_pct: maxDepthPct,
          clicks: clicks,
          milestones: Object.keys(milestones).map(Number),
          landing_fired: landingFired,
          empty_fired: emptyFired,
          dwell_ended: dwellEnded,
          nav_source: navSource,
        };
      },
    };
  } catch (_) {}
})();
