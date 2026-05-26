/* Synced Ready-up + auto-advance — frontend runtime.
 *
 * No backend changes. The existing party member status flow already
 * supports `joined` → `ready` → `character_select` → `in_game`, with
 * the engine accepting any of those values on
 *   POST /coop/parties/:id/status
 *
 * This module:
 *   1. Polls the party for the current user every PARTY_POLL_MS.
 *   2. Renders a single "Ready up" pill next to the row's GO countdown
 *      (or under it on narrow viewports). Pressed state when own
 *      status is `ready`. Tap toggles back to `joined`.
 *   3. Shows "X / Y ready" next to the pill.
 *   4. When ALL non-left members are `ready` AND the planned start has
 *      elapsed, posts `status: "in_game"` for the local user. Other
 *      clients do the same independently → everyone auto-advances.
 *
 * The auto-advance is *opt-out* per user by a small localStorage flag
 * (in case someone wants to wait). It's only posted ONCE per party
 * per local user — a `Set` in memory tracks self-advanced partyIds.
 */
(function attachReadyupRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfReadyupRuntime) return;
  window.__pfReadyupRuntime = true;

  var PARTY_POLL_MS = 4 * 1000; // every 4s while a party is open
  var autoAdvancedFor = new Set();
  var lastPartyByLobby = new Map();
  var pollTimers = new Map();
  var chimeFiredFor = new Set(); // partyIds we've already chimed for

  // ─── All-ready chime ─────────────────────────────────────────────────
  // Tiny 3-tone glissando using WebAudio. No external audio assets.
  // Opt-out flag lives in localStorage["pf.readyup.chime.v1"] = "off".
  // Honors prefers-reduced-motion as a proxy for "I don't want surprise
  // audio" alongside the explicit toggle.

  function chimeOptOut() {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return true;
      }
      return window.localStorage.getItem("pf.readyup.chime.v1") === "off";
    } catch (_) { return false; }
  }

  var _audioCtx = null;
  function audioCtx() {
    if (_audioCtx) return _audioCtx;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    } catch (_) {
      _audioCtx = null;
    }
    return _audioCtx;
  }

  function playChime() {
    var ctx = audioCtx();
    if (!ctx) return;
    // Safari sometimes leaves the context suspended; resume in the
    // user-gesture path. The polling tick that calls this is itself
    // bootstrapped by a click somewhere along the way.
    try { if (ctx.state === "suspended") ctx.resume(); } catch (_) {}
    var now = ctx.currentTime;
    // Three-note arpeggio: E5 → G5 → B5. Short, bright, recognisably
    // "everyone's ready" without sounding alarm-clock-aggressive.
    var notes = [659.25, 783.99, 987.77];
    notes.forEach(function (freq, i) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + i * 0.10);
      gain.gain.setValueAtTime(0, now + i * 0.10);
      gain.gain.linearRampToValueAtTime(0.18, now + i * 0.10 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + i * 0.10 + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.10);
      osc.stop(now + i * 0.10 + 0.30);
    });
  }

  function maybeFireAllReadyChime(partyId, total) {
    if (!partyId || total < 2) return;
    if (chimeFiredFor.has(partyId)) return;
    chimeFiredFor.add(partyId);
    if (chimeOptOut()) return;
    try { playChime(); } catch (_) {}
  }
  // Expose so the Alerts gear popover can toggle and test the chime.
  window.__pfReadyupChime = {
    test: function () { try { playChime(); } catch (_) {} },
    isOff: chimeOptOut,
    setOff: function (off) {
      try {
        window.localStorage.setItem("pf.readyup.chime.v1", off ? "off" : "on");
      } catch (_) {}
    },
  };

  function getState() {
    try {
      if (typeof window.__pfGetLastState === "function") {
        return window.__pfGetLastState() || null;
      }
    } catch (_) {}
    return null;
  }

  function getMySteamId() {
    var s = getState();
    return s && s.presence ? s.presence.steamId : null;
  }

  function shouldAutoAdvance() {
    try {
      var pref = window.localStorage.getItem("pf.readyup.autoAdvance.v1");
      return pref !== "off";
    } catch (_) { return true; }
  }

  function jsonFetch(url, init) {
    return fetch(url, Object.assign({ credentials: "include" }, init || {}))
      .then(function (r) {
        if (!r.ok) throw new Error("http_" + r.status);
        return r.json();
      });
  }

  function getParty(partyId) {
    return jsonFetch("/coop/parties/" + encodeURIComponent(partyId), {
      headers: { accept: "application/json" },
    }).then(function (j) { return (j && j.party) || null; }).catch(function () { return null; });
  }

  function postStatus(partyId, status) {
    return jsonFetch("/coop/parties/" + encodeURIComponent(partyId) + "/status", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ status: status }),
    }).then(function (j) { return (j && j.party) || null; }).catch(function () { return null; });
  }

  function parseLobbyStart(lobby) {
    if (!lobby || typeof lobby.note !== "string") return 0;
    var m = /\[start=(\d{4}-\d{2}-\d{2}T[^\]]+)\]/.exec(lobby.note);
    if (!m) return 0;
    var t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : 0;
  }

  function lookupLobby(lobbyId) {
    var s = getState();
    if (!s) return null;
    var all = (s.openLobbies || []).concat(s.myLobby ? [s.myLobby] : []);
    for (var i = 0; i < all.length; i++) {
      if (all[i].lobbyId === lobbyId) return all[i];
    }
    return null;
  }

  function ensurePill(row, partyId) {
    var pill = row.querySelector("[data-pf-readyup-pill]");
    if (pill) return pill;
    var anchor = row.querySelector(".pf-live-actions") || row;
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "pf-readyup-pill";
    pill.setAttribute("data-pf-readyup-pill", "1");
    pill.setAttribute("data-party-id", partyId);
    pill.innerHTML = '<span class="pf-readyup-dot" aria-hidden="true"></span>' +
                     '<span class="pf-readyup-text">Ready up</span>' +
                     '<span class="pf-readyup-count" data-pf-readyup-count></span>';
    pill.addEventListener("click", function () {
      var pid = pill.getAttribute("data-party-id");
      if (!pid) return;
      var mine = getMySteamId();
      if (!mine) return;
      var party = lastPartyByLobby.get(pill.getAttribute("data-lobby-id"));
      var meMember = party && party.members
        ? party.members.find(function (m) { return m.steamId === mine; })
        : null;
      var next = (meMember && meMember.status === "ready") ? "joined" : "ready";
      pill.disabled = true;
      postStatus(pid, next).then(function (p) {
        pill.disabled = false;
        if (p) {
          lastPartyByLobby.set(pill.getAttribute("data-lobby-id"), p);
          paintPill(row, pill, p);
        }
      });
    });
    anchor.appendChild(pill);
    return pill;
  }

  function waitingOnLabel(liveMembers) {
    // The member we're "waiting on" is the one with status != ready/in_game.
    // If multiple, pick the one who joined first (oldest updatedAt) — that's
    // typically the longest-stalling member. If only one not-ready remains,
    // surface their name explicitly.
    var notReady = liveMembers.filter(function (m) {
      return m.status !== "ready" && m.status !== "in_game";
    });
    if (notReady.length === 0) return null;
    if (notReady.length === 1) {
      var name = notReady[0].personaName || "one player";
      return "Waiting on " + name;
    }
    return null;
  }

  function paintPill(row, pill, party) {
    if (!pill || !party) return;
    var mine = getMySteamId();
    var liveMembers = (party.members || []).filter(function (m) { return m.status !== "left"; });
    var ready = liveMembers.filter(function (m) { return m.status === "ready" || m.status === "in_game"; });
    var total = liveMembers.length;
    var meMember = liveMembers.find(function (m) { return m.steamId === mine; });
    var iAmReady = meMember && (meMember.status === "ready" || meMember.status === "in_game");
    pill.classList.toggle("is-ready", !!iAmReady);
    pill.querySelector(".pf-readyup-text").textContent = iAmReady ? "Ready ✓" : "Ready up";
    var countEl = pill.querySelector(".pf-readyup-count");
    var waiting = waitingOnLabel(liveMembers);
    if (total === 0) {
      countEl.textContent = "";
    } else if (ready.length === total) {
      countEl.textContent = ready.length + " / " + total + " ready";
    } else if (waiting && ready.length >= 1) {
      countEl.textContent = waiting;
    } else {
      countEl.textContent = ready.length + " / " + total + " ready";
    }
    if (ready.length === total && total >= 2) {
      countEl.classList.add("is-all");
      maybeFireAllReadyChime(party.partyId, total);
    } else {
      countEl.classList.remove("is-all");
    }
  }

  function maybeAutoAdvance(party, row, pill) {
    if (!party || !shouldAutoAdvance()) return;
    if (autoAdvancedFor.has(party.partyId)) return;
    var mine = getMySteamId();
    if (!mine) return;
    var liveMembers = (party.members || []).filter(function (m) { return m.status !== "left"; });
    if (liveMembers.length < 2) return;
    var allReady = liveMembers.every(function (m) { return m.status === "ready" || m.status === "in_game"; });
    if (!allReady) return;
    var meMember = liveMembers.find(function (m) { return m.steamId === mine; });
    if (!meMember || meMember.status === "in_game") return;
    var lobbyId = row.getAttribute("data-lobby-id");
    var lobby = lookupLobby(lobbyId);
    var startMs = parseLobbyStart(lobby);
    if (startMs > 0 && startMs > Date.now()) return; // wait for planned start
    autoAdvancedFor.add(party.partyId);
    postStatus(party.partyId, "in_game").then(function (p) {
      if (p) {
        lastPartyByLobby.set(lobbyId, p);
        paintPill(row, pill, p);
      }
    });
  }

  function tick(row, partyId) {
    var pill = ensurePill(row, partyId);
    pill.setAttribute("data-lobby-id", row.getAttribute("data-lobby-id") || "");
    getParty(partyId).then(function (party) {
      if (!party) return;
      lastPartyByLobby.set(row.getAttribute("data-lobby-id") || "", party);
      paintPill(row, pill, party);
      maybeAutoAdvance(party, row, pill);
    });
  }

  function attachToRow(row) {
    var partyId = row.getAttribute("data-party-id")
      || (row.querySelector("[data-party-id]") && row.querySelector("[data-party-id]").getAttribute("data-party-id"));
    if (!partyId) return;
    if (pollTimers.has(row)) return;
    tick(row, partyId);
    var id = setInterval(function () {
      if (!document.body.contains(row)) {
        clearInterval(id);
        pollTimers.delete(row);
        return;
      }
      tick(row, partyId);
    }, PARTY_POLL_MS);
    pollTimers.set(row, id);
  }

  function getActiveParty() {
    var s = getState();
    return s && s.party ? s.party : null;
  }

  function scan() {
    // Ready-up applies only to the user's own joined-or-hosting party.
    // Find the party from global state and the matching live-row by
    // lobby id; tag it with data-party-id so attachToRow can pick it up
    // (and subsequent rescans coalesce).
    var party = getActiveParty();
    if (!party || !party.lobbyId) return;
    var row = document.querySelector(
      '.pf-live-row[data-lobby-id="' + String(party.lobbyId).replace(/"/g, '\\"') + '"]',
    );
    if (!row) return;
    if (!row.getAttribute("data-party-id")) {
      row.setAttribute("data-party-id", party.partyId);
    }
    attachToRow(row);
  }

  function start() {
    scan();
    if (typeof MutationObserver === "function") {
      var mo = new MutationObserver(function () { scan(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
