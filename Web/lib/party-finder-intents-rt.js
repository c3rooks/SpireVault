/* Scheduled play intents — "I'm free tonight 8-11pm".
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every matchmaking surface in this app requires two people to be looking at
 * it during the same few minutes. Presence expires 5 minutes after a tab
 * closes. At our concurrency, two players who want the same run but arrive 20
 * minutes apart never see each other, and both conclude nobody is here.
 *
 * The existing "start soon" feature is not this: it encodes a planned time in
 * a lobby note and counts down client-side, so it still needs the host to be
 * online with a tab open. An intent is stored server-side and matched against
 * everyone else's schedule whether or not anybody is currently online.
 *
 * DESIGN NOTES
 *
 *  - Presets over pickers. "Tonight", "Tomorrow evening", "This weekend" are
 *    one tap. A datetime-local input is offered as the escape hatch, but
 *    nobody should have to touch it to say "I'm around after dinner".
 *  - Times render in the viewer's local timezone; the wire format is UTC ISO.
 *    Getting this wrong is the classic way a scheduling feature quietly
 *    becomes useless for everyone outside the author's timezone.
 *  - Matches are surfaced from the /coop/state poll the client already runs,
 *    so a match found while the tab is open appears without any extra request.
 *
 * Follows the classic-script -rt pattern used by the sibling modules:
 * no imports, idempotent mount, MutationObserver to survive core re-renders.
 */
(function attachIntentsRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfIntentsRuntime) return;
  window.__pfIntentsRuntime = true;

  var MOUNT_ID = "pf-intents";
  var API = "/api/coop/intents";

  // ---------- small helpers ----------

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getState() {
    try {
      return typeof window.__pfGetLastState === "function"
        ? window.__pfGetLastState()
        : null;
    } catch (_) { return null; }
  }

  function signedIn() {
    var st = getState();
    if (st && st.presence && st.presence.steamId) return true;
    try {
      var sess = window.__VAULT_SESSION__ || {};
      return !!(sess.steamID || sess.steamId);
    } catch (_) { return false; }
  }

  function toastSafe(msg) {
    try { if (window.toast) window.toast(msg); } catch (_) {}
  }

  function ensureCss() {
    if (document.getElementById("pf-intents-css")) return;
    var l = document.createElement("link");
    l.id = "pf-intents-css";
    l.rel = "stylesheet";
    l.href = "/lib/party-finder-intents.css?v=2";
    document.head.appendChild(l);
  }

  // ---------- time formatting ----------

  // All rendering is local-time. The server only ever sees UTC ISO strings.
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function fmtClock(d) {
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? "pm" : "am";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + (m ? ":" + String(m).padStart(2, "0") : "") + ampm;
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  /** "Tonight 8-11pm" / "Sat 2-6pm" / "Mar 4, 8-11pm" */
  function fmtRange(startIso, endIso) {
    var s = new Date(startIso);
    var e = new Date(endIso);
    if (isNaN(s) || isNaN(e)) return "";
    var now = new Date();
    var tomorrow = new Date(now.getTime() + 86400000);

    var dayLabel;
    if (sameDay(s, now)) dayLabel = "Today";
    else if (sameDay(s, tomorrow)) dayLabel = "Tomorrow";
    else if (s.getTime() - now.getTime() < 6 * 86400000) dayLabel = DAY_NAMES[s.getDay()];
    else dayLabel = s.toLocaleDateString(undefined, { month: "short", day: "numeric" });

    return dayLabel + " " + fmtClock(s) + "\u2013" + fmtClock(e);
  }

  /** "in 3h" / "in 25m" / "now" */
  function fmtCountdown(mins) {
    if (mins <= 0) return "now";
    if (mins < 60) return "in " + mins + "m";
    var h = Math.round(mins / 60);
    if (h < 24) return "in " + h + "h";
    return "in " + Math.round(h / 24) + "d";
  }

  // ---------- presets ----------

  /**
   * Presets snap to whole hours in the user's local timezone.
   *
   * "Tonight" means tonight even at 11pm — in that case it rolls to the next
   * evening rather than proposing a window that has already passed, which is
   * the kind of edge case that makes a scheduler feel broken on first use.
   */
  function presetWindows() {
    var now = new Date();

    function at(dayOffset, hour) {
      var d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, 0, 0, 0);
      return d;
    }

    var out = [];

    // Next 3 hours, starting now, rounded to the next half hour.
    var soon = new Date(now);
    soon.setMinutes(now.getMinutes() > 30 ? 60 : 30, 0, 0);
    out.push({
      key: "now",
      label: "Next 3 hours",
      start: soon,
      end: new Date(soon.getTime() + 3 * 3600000),
    });

    // Tonight 8-11pm, rolling to tomorrow once 8pm has passed.
    var tonightOffset = now.getHours() >= 20 ? 1 : 0;
    out.push({
      key: "tonight",
      label: tonightOffset ? "Tomorrow night" : "Tonight",
      start: at(tonightOffset, 20),
      end: at(tonightOffset, 23),
    });

    // Tomorrow evening 6-10pm.
    out.push({
      key: "tomorrow",
      label: "Tomorrow eve",
      start: at(1, 18),
      end: at(1, 22),
    });

    // Next Saturday afternoon.
    var daysToSat = (6 - now.getDay() + 7) % 7 || 7;
    out.push({
      key: "weekend",
      label: "Saturday",
      start: at(daysToSat, 14),
      end: at(daysToSat, 18),
    });

    return out;
  }

  // ---------- rendering ----------

  function renderWindowRow(w) {
    var goal = w.goal && w.goal !== "any" ? w.goal : null;
    var asc = (w.ascensionMin != null || w.ascensionMax != null)
      ? "A" + (w.ascensionMin != null ? w.ascensionMin : 0) +
        (w.ascensionMax != null && w.ascensionMax !== w.ascensionMin ? "\u2013" + w.ascensionMax : "")
      : null;

    return ''
      + '<li class="pf-intent-row" data-intent-window="' + esc(w.id) + '">'
      +   '<div class="pf-intent-when">' + esc(fmtRange(w.startsAt, w.endsAt)) + '</div>'
      +   '<div class="pf-intent-meta">'
      +     (goal ? '<span class="pf-intent-chip">' + esc(goal) + '</span>' : '')
      +     (asc ? '<span class="pf-intent-chip">' + esc(asc) + '</span>' : '')
      +     (w.note ? '<span class="pf-intent-note">' + esc(w.note) + '</span>' : '')
      +   '</div>'
      +   '<button type="button" class="pf-intent-remove" '
      +     'data-pf-action="intent-remove" data-window-id="' + esc(w.id) + '" '
      +     'aria-label="Remove this window">\u00D7</button>'
      + '</li>';
  }

  function renderMatchRow(m) {
    var avatar = m.withAvatarUrl
      ? '<img class="pf-intent-match-avatar" src="' + esc(m.withAvatarUrl) + '" alt="" loading="lazy" decoding="async">'
      : '<span class="pf-intent-match-avatar pf-intent-match-avatar--blank" aria-hidden="true"></span>';

    return ''
      + '<li class="pf-intent-match">'
      +   avatar
      +   '<div class="pf-intent-match-body">'
      +     '<div class="pf-intent-match-name">' + esc(m.withPersonaName) + '</div>'
      +     '<div class="pf-intent-match-when">'
      +       esc(fmtRange(m.overlapStartsAt, m.overlapEndsAt))
      +       ' \u00B7 ' + esc(fmtCountdown(m.startsInMinutes))
      +       ' \u00B7 ' + esc(m.overlapMinutes) + 'm overlap'
      +     '</div>'
      +     (m.withNote ? '<div class="pf-intent-match-note">' + esc(m.withNote) + '</div>' : '')
      +   '</div>'
      +   '<button type="button" class="pf-intent-match-repeat btn-ghost btn-xs"'
      +     ' data-pf-action="intent-repeat-week" data-start="' + esc(m.overlapStartsAt) + '"'
      +     ' data-end="' + esc(m.overlapEndsAt) + '">Same time next week</button>'
      +   '<a class="pf-intent-match-link" target="_blank" rel="noopener"'
      +     ' href="https://steamcommunity.com/profiles/' + esc(m.withSteamId) + '">Steam</a>'
      + '</li>';
  }

  function buildHtml(state) {
    var windows = (state && state.intentWindows) || [];
    var matches = (state && state.intentMatches) || [];
    var scheduled = (state && state.scheduledPlayersCount) || 0;
    var presets = presetWindows();

    var presetBtns = presets.map(function (p) {
      return '<button type="button" class="pf-intent-preset" data-pf-action="intent-add"'
        + ' data-start="' + esc(p.start.toISOString()) + '"'
        + ' data-end="' + esc(p.end.toISOString()) + '">'
        + '<strong>' + esc(p.label) + '</strong>'
        + '<small>' + esc(fmtClock(p.start)) + '\u2013' + esc(fmtClock(p.end)) + '</small>'
        + '</button>';
    }).join("");

    var matchBlock;
    if (matches.length > 0) {
      matchBlock = ''
        + '<div class="pf-intent-matches">'
        +   '<h4 class="pf-intent-subhead">'
        +     matches.length + (matches.length === 1 ? ' player overlaps' : ' players overlap')
        +     ' with your schedule'
        +   '</h4>'
        +   '<ul class="pf-intent-match-list">' + matches.map(renderMatchRow).join("") + '</ul>'
        + '</div>';
    } else if (windows.length > 0) {
      matchBlock = ''
        + '<p class="pf-intent-hint">'
        +   'No overlaps yet. Your window is saved \u2014 you\u2019ll see matches here, and '
        +   'you don\u2019t need to keep this tab open.'
        + '</p>';
    } else {
      matchBlock = '';
    }

    return ''
      + '<section class="pf-intent-card" aria-labelledby="pf-intent-head">'
      +   '<header class="pf-intent-header">'
      +     '<h3 class="pf-intent-title" id="pf-intent-head">When are you free?</h3>'
      +     '<p class="pf-intent-sub">'
      +       'Nobody has to be online at the same time. Save a window and we\u2019ll '
      +       'match it against everyone else\u2019s.'
      +       (scheduled > 0
        ? ' <strong>' + scheduled + '</strong> ' + (scheduled === 1 ? 'player has' : 'players have') + ' upcoming windows.'
        : '')
      +     '</p>'
      +   '</header>'
      +   '<div class="pf-intent-presets">' + presetBtns + '</div>'
      +   '<details class="pf-intent-custom">'
      +     '<summary>Pick exact times</summary>'
      +     '<div class="pf-intent-custom-body">'
      +       '<label>From <input type="datetime-local" data-pf-intent-start></label>'
      +       '<label>To <input type="datetime-local" data-pf-intent-end></label>'
      +       '<label class="pf-intent-note-field">Note '
      +         '<input type="text" maxlength="140" placeholder="A10 Heart, voice optional" data-pf-intent-note>'
      +       '</label>'
      +       '<button type="button" class="pf-intent-custom-save" data-pf-action="intent-add-custom">Save window</button>'
      +     '</div>'
      +   '</details>'
      +   (windows.length > 0
        ? '<ul class="pf-intent-list">' + windows.map(renderWindowRow).join("") + '</ul>'
        : '')
      +   matchBlock
      + '</section>';
  }

  // ---------- api ----------

  function apiCall(method, path, body) {
    var opts = {
      method: method,
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j || j.ok === false) {
          var msg = (j && j.message) || "Couldn't save that window.";
          throw new Error(msg);
        }
        return j;
      });
    });
  }

  /**
   * Push a freshly-returned intent into the cached poll state so the panel
   * re-renders immediately instead of waiting up to a full poll interval.
   * Falls back silently if the state shape isn't what we expect.
   */
  function mergeIntoState(payload) {
    try {
      var st = getState();
      if (!st) return;
      if (payload.intent) st.intentWindows = payload.intent.windows || [];
      if (payload.matches) st.intentMatches = payload.matches;
    } catch (_) {}
  }

  function addWindow(startIso, endIso, extra) {
    if (!signedIn()) {
      toastSafe("Sign in with Steam to save a play window.");
      return;
    }
    var body = { startsAt: startIso, endsAt: endIso };
    if (extra && extra.note) body.note = extra.note;
    apiCall("POST", API, body)
      .then(function (j) {
        mergeIntoState(j);
        render(true);
        var n = (j.matches || []).length;
        toastSafe(n > 0
          ? "Saved. " + n + (n === 1 ? " player overlaps" : " players overlap") + " with that window."
          : "Saved. We'll match you as others schedule.");
        // Ask once, on a real user gesture (this save click). Without
        // this, match notifications can never fire when the tab is
        // backgrounded — the default permission stays "default".
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
          try { Notification.requestPermission().catch(function () {}); } catch (_) {}
        }
      })
      .catch(function (err) { toastSafe(err.message); });
  }

  function removeWindow(id) {
    apiCall("DELETE", API + "/" + encodeURIComponent(id))
      .then(function (j) {
        mergeIntoState(j);
        render(true);
      })
      .catch(function (err) { toastSafe(err.message); });
  }

  // ---------- mount ----------

  /**
   * Mounts above the live lobby list. That placement is deliberate: when the
   * board is empty — the exact moment this feature matters — the schedule is
   * the first thing in view rather than something below a "nobody is here"
   * message the visitor has already bounced off.
   */
  function mountPoint() {
    return document.getElementById("pf-live")
      || document.getElementById("pf-live-list")
      || document.querySelector("[data-coop-surface]")
      || null;
  }

  var lastSignature = "";
  var lastMatchNotifySig = "";

  function maybeNotifyMatches(matches) {
    if (!matches || !matches.length) return;
    var sig = matches.map(function (m) {
      return m.withSteamId + "|" + m.overlapStartsAt;
    }).join(";");
    if (!lastMatchNotifySig) {
      lastMatchNotifySig = sig;
      return;
    }
    if (sig === lastMatchNotifySig) return;
    lastMatchNotifySig = sig;
    var m = matches[0];
    var body = (m.withPersonaName || "Someone") + " overlaps "
      + fmtRange(m.overlapStartsAt, m.overlapEndsAt);
    toastSafe("Schedule match: " + body);
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      try {
        new Notification("Co-op schedule match", {
          body: body,
          icon: m.withAvatarUrl || "/assets/vault-mark.svg",
        });
      } catch (_) {}
    } else if (Notification.permission === "default" && document.hidden) {
      Notification.requestPermission().catch(function () {});
    }
  }

  function shiftWeek(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    d.setDate(d.getDate() + 7);
    return d.toISOString();
  }

  function render(force) {
    var anchor = mountPoint();
    if (!anchor) return;
    if (!signedIn()) return;

    var state = getState();
    var windows = (state && state.intentWindows) || [];
    var matches = (state && state.intentMatches) || [];

    // Re-render only when something a user could notice has changed. The
    // co-op surface polls continuously and blowing away the subtree on every
    // tick would close the <details> panel and drop input focus mid-typing.
    var sig = JSON.stringify([
      windows.map(function (w) { return w.id; }),
      matches.map(function (m) { return m.withSteamId + m.overlapStartsAt; }),
      (state && state.scheduledPlayersCount) || 0,
    ]);
    if (!force && sig === lastSignature && document.getElementById(MOUNT_ID)) return;
    lastSignature = sig;
    maybeNotifyMatches(matches);

    var host = document.getElementById(MOUNT_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = MOUNT_ID;
      anchor.parentNode.insertBefore(host, anchor);
    }
    host.innerHTML = buildHtml(state);
  }

  function readCustom(host) {
    var startEl = host.querySelector("[data-pf-intent-start]");
    var endEl = host.querySelector("[data-pf-intent-end]");
    var noteEl = host.querySelector("[data-pf-intent-note]");
    if (!startEl || !endEl || !startEl.value || !endEl.value) {
      toastSafe("Pick both a start and an end time.");
      return null;
    }
    // datetime-local yields a naive local string; the Date constructor parses
    // it in local time, and toISOString converts to UTC for the wire.
    var s = new Date(startEl.value);
    var e = new Date(endEl.value);
    if (isNaN(s) || isNaN(e)) {
      toastSafe("Those times didn't parse.");
      return null;
    }
    return {
      startsAt: s.toISOString(),
      endsAt: e.toISOString(),
      note: noteEl ? noteEl.value : "",
    };
  }

  function onClick(ev) {
    var t = ev.target;
    if (!(t instanceof Element)) return;

    var preset = t.closest('[data-pf-action="intent-add"]');
    if (preset) {
      ev.preventDefault();
      addWindow(preset.getAttribute("data-start"), preset.getAttribute("data-end"));
      return;
    }

    var custom = t.closest('[data-pf-action="intent-add-custom"]');
    if (custom) {
      ev.preventDefault();
      var host = document.getElementById(MOUNT_ID);
      if (!host) return;
      var vals = readCustom(host);
      if (vals) addWindow(vals.startsAt, vals.endsAt, { note: vals.note });
      return;
    }

    var remove = t.closest('[data-pf-action="intent-remove"]');
    if (remove) {
      ev.preventDefault();
      removeWindow(remove.getAttribute("data-window-id"));
      return;
    }

    var repeat = t.closest('[data-pf-action="intent-repeat-week"]');
    if (repeat) {
      ev.preventDefault();
      var s = shiftWeek(repeat.getAttribute("data-start"));
      var e = shiftWeek(repeat.getAttribute("data-end"));
      if (s && e) addWindow(s, e, { note: "Same time next week" });
    }
  }

  function init() {
    ensureCss();
    render(false);
    document.addEventListener("click", onClick);

    // The co-op surface re-renders on every poll; re-assert our mount when it
    // does. rAF-coalesced for the same reason the sibling runtimes do it — a
    // single poll can produce a burst of micro-mutations.
    //
    // Watch document.body, NOT #pf-live-list: on an empty board the lobby
    // list never mutates, so a user who signs in after this module loaded
    // would wait for the 60s safety interval before the panel appeared —
    // observed in headless testing as a 12s timeout. Body-wide observation
    // catches the session/status strips that every poll does touch, and the
    // rAF coalescing plus the render signature keep it cheap.
    try {
      var target = document.body;
      var pending = false;
      var mo = new MutationObserver(function () {
        if (pending) return;
        pending = true;
        var run = function () {
          pending = false;
          try { render(false); } catch (_) {}
        };
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(run);
        } else {
          setTimeout(run, 16);
        }
      });
      mo.observe(target, { childList: true, subtree: true });
    } catch (_) { /* old browser */ }

    // Safety net for the case where the surface never mutates (e.g. the user
    // has no lobbies and nothing polls the list): keep the countdown labels
    // and "Tonight" preset honest as real time passes.
    setInterval(function () { try { render(true); } catch (_) {} }, 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
