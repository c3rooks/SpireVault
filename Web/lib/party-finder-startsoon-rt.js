// party-finder-startsoon-rt.js — runtime tick driver for "Starting soon".
// =========================================================================
// Classic script (IIFE). Loaded after party-finder-scene.js so it can
// layer on top of the rendered Live Parties rows via MutationObserver.
//
// Responsibilities:
//   1. Inject a countdown badge into every .pf-live-row whose lobby
//      note carries a [start=...] prefix. Idempotent and tick-driven.
//   2. Flash the browser tab title when the user's own active lobby
//      (hosting or member) is ≤ 5 min from kickoff.
//   3. Play an opt-in audio chime at T-60s and T-0.
//   4. Fire an opt-in browser Notification at T-60s and T-0.
//   5. Drive the GO moment — pulse the row, swap the badge into a
//      "GO! Launch Steam now" cue with a launcher CTA.
//
// All state is local to the browser; no backend change. Notifications
// and audio require a one-time user gesture (button labelled "Sound on"
// / "Notify me") so we don't blast random pages with audio.
// =========================================================================

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfStartSoonRtLoaded) return;
  window.__pfStartSoonRtLoaded = true;

  // ── localStorage keys ─────────────────────────────────────────────
  var LS_AUDIO_KEY = "pf.startSoon.audio.v1";
  var LS_NOTIFY_KEY = "pf.startSoon.notify.v1";
  // De-dupe set: lobbyId#milestoneId ("abc#t60", "abc#t0") so we never
  // chime twice for the same milestone if the user reloads or polls.
  var firedMilestones = new Set();

  function readLS(k, fallback) {
    try { var v = localStorage.getItem(k); return v == null ? fallback : v; }
    catch (_) { return fallback; }
  }
  function writeLS(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} }

  // ── Helpers ───────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getApi() { return window.__pfStartSoon || null; }
  function getState() {
    try { return typeof window.__pfGetLastState === "function" ? window.__pfGetLastState() : null; }
    catch (_) { return null; }
  }
  function getSelfSteamId() {
    var st = getState();
    if (st && st.presence && st.presence.steamId) return st.presence.steamId;
    var sess = window.__VAULT_SESSION__ || {};
    return sess.steamID || sess.steamId || sess.steam_id || "";
  }

  function lobbyById(state, id) {
    if (!state || !id || !Array.isArray(state.openLobbies)) return null;
    for (var i = 0; i < state.openLobbies.length; i++) {
      if (state.openLobbies[i] && state.openLobbies[i].lobbyId === id) return state.openLobbies[i];
    }
    return null;
  }

  function lobbyIsFull(lobby) {
    if (!lobby) return false;
    var cap = lobby.lobbySize || 4;
    var filled = Array.isArray(lobby.partyMembers) ? lobby.partyMembers.length : 1;
    return filled >= cap;
  }

  // Is the current user hosting or a member of this lobby?
  function lobbyIsMine(lobby, selfId) {
    if (!lobby || !selfId) return false;
    if (lobby.hostSteamId === selfId) return true;
    var m = Array.isArray(lobby.partyMembers) ? lobby.partyMembers : [];
    for (var i = 0; i < m.length; i++) if (m[i] && m[i].steamId === selfId) return true;
    return false;
  }

  // Resolve a "when full" lobby into an effective target time. We do
  // not start the auto-countdown until the room actually fills, then
  // we kick off a 60-second window.
  function resolveTarget(lobby, api, now) {
    if (!lobby) return null;
    var d = api.decode(lobby.note);
    if (d.plannedAt) return d.plannedAt;
    if (d.isWhenFull && lobbyIsFull(lobby)) {
      // Anchor the auto-countdown deterministically off the lobby's
      // updatedAt or createdAt so every client lands on the same T-0
      // without needing a server-side timer. 60 seconds from "filled".
      // We approximate "filled" via the latest member's joinedAt; if
      // that's unavailable, we fall back to lobby.updatedAt and finally
      // to "now + 60s" (best-effort).
      var anchor = null;
      var members = Array.isArray(lobby.partyMembers) ? lobby.partyMembers : [];
      for (var i = 0; i < members.length; i++) {
        var ja = members[i] && (members[i].joinedAt || members[i].acceptedAt);
        var t = ja ? Date.parse(ja) : NaN;
        if (!isNaN(t) && (anchor == null || t > anchor)) anchor = t;
      }
      if (anchor == null) anchor = Date.parse(lobby.updatedAt || lobby.createdAt || "") || now.getTime();
      return new Date(anchor + 60 * 1000);
    }
    return null;
  }

  // ── Badge DOM (idempotent inject + update) ────────────────────────
  function ensureBadge(row) {
    var b = row.querySelector(".pf-start-badge");
    if (b) return b;
    b = document.createElement("div");
    b.className = "pf-start-badge";
    b.setAttribute("data-pf-start", "1");
    b.innerHTML =
      '<span class="pf-start-badge-icon" aria-hidden="true">\u23F3</span>' +
      '<span class="pf-start-badge-text" data-pf-start-text></span>';
    // Insert right after the title row so it reads top-of-card.
    var anchor = row.querySelector(".pf-attrs") || row.querySelector(".pf-host-strip") || row.firstChild;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(b, anchor);
    else row.appendChild(b);
    return b;
  }
  function removeBadge(row) {
    var b = row.querySelector(".pf-start-badge");
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  function applyBadge(row, fmt) {
    var b = ensureBadge(row);
    var txt = b.querySelector("[data-pf-start-text]");
    if (txt && txt.textContent !== fmt.text) txt.textContent = fmt.text;
    if (b.getAttribute("data-pf-tier") !== fmt.tier) b.setAttribute("data-pf-tier", fmt.tier);
    // Pulse the whole row at the GO moment.
    if (fmt.tier === "now-go") {
      if (!row.classList.contains("pf-live-row--go")) row.classList.add("pf-live-row--go");
    } else if (row.classList.contains("pf-live-row--go")) {
      row.classList.remove("pf-live-row--go");
    }
  }

  // Lock-in pill — only shown for the host's own row when the planned
  // start is still > 30 s away. Lets the host fast-forward to GO from
  // the row itself. Wired via party-finder.js's "lock-in" delegated
  // action so the network call lives where the rest of the host
  // operations live.
  function ensureLockInPill(row, lobby, fmt, isHost) {
    if (!row || !lobby) return;
    var existing = row.querySelector('[data-pf-action="lock-in"]');
    var canLock = isHost && fmt && fmt.deltaMs > 30 * 1000 && /^future-/.test(fmt.tier);
    if (!canLock) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return;
    var pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pf-start-lockin";
    pill.setAttribute("data-pf-action", "lock-in");
    pill.setAttribute("data-lobby-id", lobby.lobbyId);
    pill.title = "Skip the wait — start the GO countdown now.";
    pill.innerHTML = '<span class="pf-start-lockin-icon" aria-hidden="true">\u26A1</span><span>Start now</span>';
    var badge = row.querySelector(".pf-start-badge");
    if (badge && badge.parentNode) badge.parentNode.insertBefore(pill, badge.nextSibling);
    else row.appendChild(pill);
  }

  // ── Tab title flash ───────────────────────────────────────────────
  // Honors prefers-reduced-motion: that media query is the closest
  // thing the platform has to "stop blinking my UI". A constantly-
  // updating tab title is itself a form of motion (and a known
  // migraine trigger), so we silence it for users who opted in.
  var originalTitle = null;
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (_) { return false; }
  }
  function setTabTitle(text) {
    if (reducedMotion()) return;
    if (originalTitle == null) originalTitle = document.title;
    if (document.title !== text) document.title = text;
  }
  function restoreTabTitle() {
    if (originalTitle != null && document.title !== originalTitle) {
      document.title = originalTitle;
    }
  }

  // ── Audio chime (synthesized via WebAudio so we ship zero bytes) ──
  var audioCtx = null;
  function tryUnlockAudio() {
    if (audioCtx) return audioCtx;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    } catch (_) { audioCtx = null; }
    return audioCtx;
  }
  function chime(kind) {
    if (readLS(LS_AUDIO_KEY, "0") !== "1") return;
    var ctx = tryUnlockAudio();
    if (!ctx) return;
    try {
      // Two short blips, ramping up for the "GO" cue.
      var now = ctx.currentTime;
      var freqs = kind === "go" ? [660, 990, 1320] : [660, 990];
      for (var i = 0; i < freqs.length; i++) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freqs[i];
        g.gain.setValueAtTime(0.0001, now + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.18, now + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.18);
        o.connect(g); g.connect(ctx.destination);
        o.start(now + i * 0.12);
        o.stop(now + i * 0.12 + 0.20);
      }
    } catch (_) { /* swallow — audio is best-effort */ }
  }

  // ── Browser notification ──────────────────────────────────────────
  function notify(title, body) {
    if (readLS(LS_NOTIFY_KEY, "0") !== "1") return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      var n = new Notification(String(title || "SpireVault"), {
        body: String(body || ""),
        tag: "pf-startsoon",
        renotify: true,
        silent: false,
      });
      // Auto-dismiss to avoid lingering UI.
      setTimeout(function () { try { n.close(); } catch (_) {} }, 8000);
    } catch (_) { /* swallow */ }
  }

  // Public toggles — invoked by the controls injected below.
  function setAudio(on) {
    writeLS(LS_AUDIO_KEY, on ? "1" : "0");
    if (on) tryUnlockAudio();
    syncControlState();
  }
  function setNotify(on) {
    if (!on) { writeLS(LS_NOTIFY_KEY, "0"); syncControlState(); return; }
    if (typeof Notification === "undefined") { writeLS(LS_NOTIFY_KEY, "0"); syncControlState(); return; }
    if (Notification.permission === "granted") { writeLS(LS_NOTIFY_KEY, "1"); syncControlState(); return; }
    if (Notification.permission === "denied") { writeLS(LS_NOTIFY_KEY, "0"); syncControlState(); return; }
    // Older Safari (< 16) returned the result via callback only. The
    // promise form was added later. Support both so users on stale
    // Safari still get the prompt instead of a silent no-op.
    function applyResult(p) {
      writeLS(LS_NOTIFY_KEY, p === "granted" ? "1" : "0");
      syncControlState();
    }
    try {
      var ret = Notification.requestPermission(applyResult);
      if (ret && typeof ret.then === "function") ret.then(applyResult);
    } catch (_) {
      writeLS(LS_NOTIFY_KEY, "0"); syncControlState();
    }
  }
  window.__pfStartSoonRt = Object.freeze({
    setAudio: setAudio,
    setNotify: setNotify,
    chimeNow: function () { chime("test"); },
  });

  // ── Controls UI: a popover anchored to the Alerts gear in the hero
  // stage CTA row. Replaces the previous floating bar so all
  // notification-ish controls have one obvious owner (the gear) and
  // don't visually fight Quiet match. The popover is rendered lazily
  // when the gear is clicked, and a small dot on the gear lights up
  // when either toggle is active so users see at-a-glance state.
  function ensureControls() {
    if (document.getElementById("pf-alerts-popover")) return;
    var pop = document.createElement("div");
    pop.id = "pf-alerts-popover";
    pop.className = "pf-alerts-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Sound and notification settings");
    pop.hidden = true;
    pop.innerHTML =
      '<div class="pf-alerts-popover-head">' +
        '<strong>Match alerts</strong>' +
        '<small>Heads-up before your run kicks off.</small>' +
      '</div>' +
      '<button type="button" class="pf-alerts-pill" data-pf-action="toggle-audio" aria-pressed="false" title="Play a short chime at T-60s and T-0.">' +
        '<span class="pf-alerts-pill-icon" aria-hidden="true">\uD83D\uDD14</span>' +
        '<span class="pf-alerts-pill-body">' +
          '<span class="pf-alerts-pill-label">Sound chime</span>' +
          '<span class="pf-alerts-pill-hint">At T-60s and T-0.</span>' +
        '</span>' +
        '<span class="pf-alerts-pill-state" data-pf-state>off</span>' +
      '</button>' +
      '<button type="button" class="pf-alerts-pill" data-pf-action="toggle-notify" aria-pressed="false" title="Browser pop-up when your room is about to start.">' +
        '<span class="pf-alerts-pill-icon" aria-hidden="true">\uD83D\uDCAC</span>' +
        '<span class="pf-alerts-pill-body">' +
          '<span class="pf-alerts-pill-label">Browser notification</span>' +
          '<span class="pf-alerts-pill-hint">Even when this tab isn\u2019t focused.</span>' +
        '</span>' +
        '<span class="pf-alerts-pill-state" data-pf-state>off</span>' +
      '</button>';
    document.body.appendChild(pop);
    syncControlState();
  }

  function positionPopover(gear) {
    var pop = document.getElementById("pf-alerts-popover");
    if (!pop || !gear) return;
    var r = gear.getBoundingClientRect();
    var top = r.bottom + window.scrollY + 8;
    // Keep within viewport: if the gear is in the right third, anchor
    // right; otherwise anchor left aligned with the gear.
    var maxLeft = window.innerWidth - 320; // popover width approx
    var left = Math.min(maxLeft - 12, r.left + window.scrollX);
    pop.style.top = top + "px";
    pop.style.left = Math.max(12, left) + "px";
  }

  function openAlertsPopover() {
    ensureControls();
    var pop = document.getElementById("pf-alerts-popover");
    var gear = document.querySelector('[data-pf-action="open-alerts"]');
    if (!pop || !gear) return;
    pop.hidden = false;
    pop.classList.add("is-open");
    gear.setAttribute("aria-expanded", "true");
    positionPopover(gear);
    syncControlState();
  }

  function closeAlertsPopover() {
    var pop = document.getElementById("pf-alerts-popover");
    var gear = document.querySelector('[data-pf-action="open-alerts"]');
    if (pop) { pop.hidden = true; pop.classList.remove("is-open"); }
    if (gear) gear.setAttribute("aria-expanded", "false");
  }

  function syncControlState() {
    var pop = document.getElementById("pf-alerts-popover");
    var gear = document.querySelector('[data-pf-action="open-alerts"]');
    var audioOn = readLS(LS_AUDIO_KEY, "0") === "1";
    var notifyOn = readLS(LS_NOTIFY_KEY, "0") === "1";
    if (pop) {
      var aBtn = pop.querySelector('[data-pf-action="toggle-audio"]');
      var nBtn = pop.querySelector('[data-pf-action="toggle-notify"]');
      if (aBtn) {
        aBtn.setAttribute("aria-pressed", audioOn ? "true" : "false");
        aBtn.classList.toggle("is-on", audioOn);
        var aState = aBtn.querySelector("[data-pf-state]");
        if (aState) aState.textContent = audioOn ? "on" : "off";
      }
      if (nBtn) {
        nBtn.setAttribute("aria-pressed", notifyOn ? "true" : "false");
        nBtn.classList.toggle("is-on", notifyOn);
        var nState = nBtn.querySelector("[data-pf-state]");
        var label = notifyOn ? "on" : (typeof Notification !== "undefined" && Notification.permission === "denied" ? "blocked" : "off");
        if (nState) nState.textContent = label;
      }
    }
    // Indicator dot on the gear so the closed state still hints state.
    if (gear) {
      var dot = gear.querySelector("[data-pf-alerts-dot]");
      if (dot) dot.classList.toggle("is-on", audioOn || notifyOn);
      gear.classList.toggle("is-on", audioOn || notifyOn);
    }
  }

  // Delegated control clicks — capture phase so we don't fight other
  // handlers. Toggles flip via localStorage state and the popover
  // re-syncs immediately so the user sees the change.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest && e.target.closest("[data-pf-action]");
    if (!btn) {
      // Outside-click closes the popover.
      var pop = document.getElementById("pf-alerts-popover");
      if (pop && !pop.hidden && !pop.contains(e.target)) closeAlertsPopover();
      return;
    }
    var act = btn.getAttribute("data-pf-action");
    if (act === "open-alerts") {
      e.stopPropagation();
      var pop2 = document.getElementById("pf-alerts-popover");
      if (pop2 && !pop2.hidden) closeAlertsPopover(); else openAlertsPopover();
    } else if (act === "toggle-audio") {
      e.stopPropagation();
      // Safari requires the AudioContext to be CREATED (or resume()d)
      // SYNCHRONOUSLY inside the user-gesture stack frame, not in a
      // later setTimeout. Unlock here so the test chime below works
      // on first click in Safari + iOS, not just Chrome/Firefox.
      var ctx = tryUnlockAudio();
      if (ctx && ctx.state === "suspended") {
        try { ctx.resume(); } catch (_) {}
      }
      setAudio(readLS(LS_AUDIO_KEY, "0") !== "1");
      if (readLS(LS_AUDIO_KEY, "0") === "1") setTimeout(function () { chime("test"); }, 80);
    } else if (act === "toggle-notify") {
      e.stopPropagation();
      setNotify(readLS(LS_NOTIFY_KEY, "0") !== "1");
    } else {
      // Click on any other action implicitly closes the popover.
      var pop3 = document.getElementById("pf-alerts-popover");
      if (pop3 && !pop3.hidden && !pop3.contains(btn)) closeAlertsPopover();
    }
  }, true);

  // Escape key closes.
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeAlertsPopover();
  });
  // Re-position on resize / scroll while open.
  window.addEventListener("resize", function () {
    var pop = document.getElementById("pf-alerts-popover");
    if (pop && !pop.hidden) {
      var gear = document.querySelector('[data-pf-action="open-alerts"]');
      positionPopover(gear);
    }
  });
  window.addEventListener("scroll", function () {
    var pop = document.getElementById("pf-alerts-popover");
    if (pop && !pop.hidden) {
      var gear = document.querySelector('[data-pf-action="open-alerts"]');
      positionPopover(gear);
    }
  }, { passive: true });

  // ── Tick loop ─────────────────────────────────────────────────────
  function tick() {
    var api = getApi();
    if (!api) return;
    var state = getState();
    var selfId = getSelfSteamId();
    var now = new Date();

    // Inject the alerts bar lazily; the hero stage may not be mounted
    // at first tick.
    ensureControls();

    var rows = document.querySelectorAll(".pf-live-row[data-lobby-id], .pf-best-card[data-lobby-id]");
    var soonestMineDeltaMs = null;
    var soonestMineTitle = "";

    // Make sure each row is observed for viewport visibility. We only
    // tick rows that are on-screen, plus rows owned by "me" (which
    // drive tab title + notifications and must update even when the
    // user has scrolled past). Idempotent — observe() on an already-
    // observed node is a no-op. At 200+ visible rows on a phone this
    // brings the per-tick CPU down by 80%+.
    ensureRowObserver();
    for (var oi = 0; oi < rows.length; oi++) observeRow(rows[oi]);

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = row.getAttribute("data-lobby-id");
      var l = lobbyById(state, id);
      if (!l) { removeBadge(row); continue; }
      // Skip rows that are off-screen UNLESS the row is owned by the
      // current user (those still drive tab-title + audio + notifs).
      var amHostQuick = !!(selfId && l.hostSteamId === selfId);
      var isVisible = row.getAttribute("data-pf-visible") === "1";
      if (!isVisible && !amHostQuick) continue;
      var target = resolveTarget(l, api, now);
      if (!target) {
        // Still show the "Starts when full" friendly hint when the host
        // chose When-full but the room isn't full yet.
        var d = api.decode(l.note);
        if (d.isWhenFull) {
          var b = ensureBadge(row);
          var t = b.querySelector("[data-pf-start-text]");
          if (t && t.textContent !== "Starts the moment we fill") t.textContent = "Starts the moment we fill";
          if (b.getAttribute("data-pf-tier") !== "when-full") b.setAttribute("data-pf-tier", "when-full");
          continue;
        }
        removeBadge(row);
        continue;
      }
      var fmt = api.formatCountdown(target, now);
      if (fmt.tier === "gone") { removeBadge(row); continue; }
      applyBadge(row, fmt);
      // Show the host's "Start now" lock-in pill while there's still
      // time to use it.
      var amHost = !!(selfId && l.hostSteamId === selfId);
      ensureLockInPill(row, l, fmt, amHost);

      // Track the soonest "mine" lobby for tab title + notifications.
      if (lobbyIsMine(l, selfId) && fmt.deltaMs > -30 * 1000) {
        if (soonestMineDeltaMs == null || fmt.deltaMs < soonestMineDeltaMs) {
          soonestMineDeltaMs = fmt.deltaMs;
          soonestMineTitle = l.title || "Co-op room";
        }
      }

      // Milestone notifications — only for "mine".
      if (lobbyIsMine(l, selfId)) {
        // T-60s ± 0.5s window
        if (fmt.deltaMs > 0 && fmt.deltaMs <= 60 * 1000 && fmt.deltaMs > 59 * 1000 - 500) {
          var key60 = id + "#t60";
          if (!firedMilestones.has(key60)) {
            firedMilestones.add(key60);
            chime("warn");
            notify("Co-op room starts in 60 seconds", (l.title || "Co-op room") + " — get into Steam.");
          }
        }
        // T-0 (entering GO window)
        if (fmt.deltaMs <= 10 * 1000 && fmt.deltaMs > -1500) {
          var key0 = id + "#t0";
          if (!firedMilestones.has(key0)) {
            firedMilestones.add(key0);
            chime("go");
            notify("Co-op room is starting now", "Launch Steam to join " + (l.title || "your room") + ".");
            // Also flash the row with a "Launch Steam now" inline CTA.
            ensureLaunchCta(row, l);
          }
        }
      }
    }

    // Tab title flash for ≤5 min, anchored to the soonest "mine" lobby.
    if (soonestMineDeltaMs != null && soonestMineDeltaMs <= 5 * 60 * 1000) {
      var sec = Math.max(0, Math.ceil(soonestMineDeltaMs / 1000));
      var mm = Math.floor(sec / 60);
      var ss = sec % 60;
      var mmss = mm + ":" + (ss < 10 ? "0" + ss : ss);
      var prefix = soonestMineDeltaMs <= 0 ? "\u25B6 GO!" : "\u23F3 " + mmss;
      setTabTitle(prefix + " — " + soonestMineTitle);
    } else {
      restoreTabTitle();
    }
  }

  function ensureLaunchCta(row, lobby) {
    if (!row || row.querySelector(".pf-start-go-cta")) return;
    var cta = document.createElement("div");
    cta.className = "pf-start-go-cta";
    // Primary anchor uses the steam:// protocol handler (instant
    // launch when Steam is installed). The fallback link routes to
    // the Steam Store web page so users without the handler still
    // get somewhere useful instead of a dead click. The fallback
    // surfaces only if the protocol handler did NOT consume the
    // click — we detect the page still has focus 800 ms later and
    // unhide it. This is the standard "deep-link with web fallback"
    // pattern used by Discord, Slack, etc.
    cta.innerHTML =
      '<span class="pf-start-go-cta-text">It\u2019s go time! Launch Steam now to join.</span>' +
      '<a class="pf-start-go-cta-btn" data-pf-launch-primary href="steam://run/3556750" target="_self" rel="noopener">Launch Steam</a>' +
      '<a class="pf-start-go-cta-fallback" data-pf-launch-fallback hidden href="https://store.steampowered.com/app/3556750/" target="_blank" rel="noopener">Don\u2019t have Steam? Open the store \u2192</a>';
    cta.addEventListener("click", function (e) {
      var primary = e.target && e.target.closest && e.target.closest("[data-pf-launch-primary]");
      if (!primary) return;
      // After the deep link, give the OS ~800 ms to consume it. If
      // we still have focus, the protocol handler isn't installed —
      // surface the web fallback so the click had a real outcome.
      var fallback = cta.querySelector("[data-pf-launch-fallback]");
      var startedHidden = !document.hidden;
      setTimeout(function () {
        if (fallback && startedHidden && !document.hidden) fallback.hidden = false;
      }, 800);
    });
    // Drop it right under the row footer so it can't be missed.
    row.appendChild(cta);
  }

  // ── Viewport-only ticking ─────────────────────────────────────────
  // Only walk the rows the user can actually see. This keeps the 1s
  // tick cheap even when a user has paginated to "Show 25 more" five
  // times. Falls back to "always visible" when IntersectionObserver
  // is unavailable (very old Safari) so behavior never regresses.
  var rowVisObserver = null;
  function ensureRowObserver() {
    if (rowVisObserver) return;
    if (typeof IntersectionObserver === "undefined") {
      // Fallback: mark every row visible so the existing logic walks
      // them all. Modern Safari/Chrome/Firefox all support IO.
      var fallbackRows = document.querySelectorAll(".pf-live-row[data-lobby-id], .pf-best-card[data-lobby-id]");
      for (var fi = 0; fi < fallbackRows.length; fi++) fallbackRows[fi].setAttribute("data-pf-visible", "1");
      return;
    }
    rowVisObserver = new IntersectionObserver(function (entries) {
      for (var ei = 0; ei < entries.length; ei++) {
        var en = entries[ei];
        en.target.setAttribute("data-pf-visible", en.isIntersecting ? "1" : "0");
      }
    }, { root: null, rootMargin: "80px 0px", threshold: 0.01 });
  }
  function observeRow(row) {
    if (!row) return;
    // Default rows to visible the moment we see them. The first IO
    // callback runs ~one frame later; until then, "off-screen because
    // we haven't measured yet" would suppress badges incorrectly.
    // Treating un-measured rows as visible matches the typical case
    // (a freshly-rendered row above the fold).
    if (!row.hasAttribute("data-pf-visible")) row.setAttribute("data-pf-visible", "1");
    if (row.getAttribute("data-pf-observed") === "1") return;
    row.setAttribute("data-pf-observed", "1");
    if (!rowVisObserver) return;
    try { rowVisObserver.observe(row); } catch (_) { /* keep default visible */ }
  }

  // ── Bootstrap: tick on a 1s interval, plus on state-poll events. ──
  setInterval(tick, 1000);
  // Run a tick immediately and on visibility return so the user doesn't
  // wait up to 1s for the badge to appear when they re-focus the tab.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
  // Observe Live Parties list mutations so a freshly-rendered row gets
  // its badge applied without waiting for the next interval tick.
  var ml = document.getElementById("pf-live-list");
  function attachObserver() {
    var target = document.getElementById("pf-live-list");
    if (!target || target.__pfStartSoonObserved) return;
    target.__pfStartSoonObserved = true;
    var mo = new MutationObserver(function () { tick(); });
    mo.observe(target, { childList: true, subtree: true });
  }
  attachObserver();
  // The list may not exist yet at script load; try again on next ticks.
  var triesLeft = 30;
  var attachInt = setInterval(function () {
    attachObserver();
    if (document.getElementById("pf-live-list") && document.getElementById("pf-live-list").__pfStartSoonObserved) {
      clearInterval(attachInt);
    }
    if (--triesLeft <= 0) clearInterval(attachInt);
  }, 300);

  // Kick off a first tick on next frame so initial render isn't blank.
  requestAnimationFrame(function () { tick(); });
})();
