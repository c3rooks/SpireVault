// =====================================================================
// party-finder-scene.js
// ---------------------------------------------------------------------
// Atmospheric layer for the Co-op Lobby Beta. Loaded after
// party-finder-scale.js by coop-sandbox.js.
//
// Three jobs, all done by reading rendered DOM (we never edit
// party-finder.js or party-room.js):
//
//   1. Inject a hero stage at the top of the Co-op tab — parallax Spire
//      silhouettes, drifting embers, big serif title, identity card
//      (player avatar + presence dot), and a relocated activity ticker.
//
//   2. Replace the Party Hub CRM-style PARTY MEMBERS / PARTY STATUS
//      list with a campfire podium scene. Live action buttons from the
//      original .pf-hub-next card are MOVED into the new action bar so
//      every existing click handler keeps working unchanged.
//
//   3. Decorate the Room Details modal with a host nameplate (character
//      art + name) and a 3-step icon flow that replaces the bullet wall.
//
// Loaded as a classic <script> tag, no imports. Reads helpers from
// window.PFH (sealed by party-finder-globals.js) when available and
// falls back to local fallbacks otherwise.
// =====================================================================

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfScene && window.__pfScene.__sealed) return;
  var globalRoot = window;

  // ── style injection (idempotent) ───────────────────────────────────
  function ensureSceneCss() {
    if (document.getElementById("pf-scene-css")) return;
    var l = document.createElement("link");
    l.id = "pf-scene-css";
    l.rel = "stylesheet";
    l.href = "/lib/party-finder-scene.css?v=17";
    document.head.appendChild(l);
  }

  // ── small helpers (mirror party-finder-globals where possible) ─────
  var PFH = globalRoot.PFH || {};
  function esc(s) {
    var str = s == null ? "" : String(s);
    return str
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtCount(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) return "0";
    if (v < 1000) return String(v);
    if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(v / 1000) + "k";
  }
  function normalizeCharId(v) {
    var id = String(v || "").trim().toLowerCase();
    return /^(ironclad|silent|defect|necrobinder|regent)$/.test(id) ? id : "";
  }
  var CHAR_LABEL = {
    ironclad: "Ironclad", silent: "Silent",
    defect: "Defect", necrobinder: "Necrobinder", regent: "Regent",
  };
  function charAsset(id) {
    var slug = normalizeCharId(id);
    return slug ? "/assets/sts2/characters/" + slug + "-v2.webp" : "";
  }

  // Reusable mountain SVG. Three depth layers.
  var MOUNTAINS_SVG =
    '<svg viewBox="0 0 1600 400" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="pfs-far"  d="M0 280 L120 200 L260 250 L380 170 L520 240 L660 180 L820 230 L980 160 L1140 220 L1280 150 L1440 210 L1600 170 L1600 400 L0 400 Z"/>' +
      '<path class="pfs-mid"  d="M0 320 L100 250 L220 290 L340 230 L460 290 L600 240 L740 280 L880 220 L1020 280 L1180 230 L1320 290 L1460 240 L1600 280 L1600 400 L0 400 Z"/>' +
      '<path class="pfs-near" d="M0 360 L80 320 L180 350 L280 310 L400 340 L520 300 L660 330 L800 290 L940 320 L1080 290 L1240 330 L1400 290 L1600 320 L1600 400 L0 400 Z"/>' +
    '</svg>';

  // ════════════════════════════════════════════════════════════════
  // 1) Hero stage on the Co-op tab.
  // ════════════════════════════════════════════════════════════════

  function findCoopRoot() {
    return document.getElementById("pf-root")
      || document.querySelector('[data-pf-root]')
      || document.querySelector('[data-tab-content="coop"]')
      || null;
  }

  function readSession() {
    try {
      var raw = localStorage.getItem("vault.web.session");
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function readState() {
    try {
      return (typeof globalRoot.__pfGetLastState === "function")
        ? globalRoot.__pfGetLastState() : null;
    } catch (_) { return null; }
  }

  // Quiet Mode key — saved per-browser. When on, Quick Play and the
  // Party Hub action bar emphasize "no need to talk" and the voice
  // CTA shifts from primary to secondary. The 7-year-old / first-time
  // / non-English-speaker path. We never disable the host's voice
  // requirement; we just prioritize voice-optional rooms and reword
  // the steps so "I'll just listen" feels like a real path.
  var LS_QUIET = "spirevault.coop.quietMode";
  function readQuiet() {
    try { return localStorage.getItem(LS_QUIET) === "1"; } catch (_) { return false; }
  }
  function writeQuiet(on) {
    try { if (on) localStorage.setItem(LS_QUIET, "1"); else localStorage.removeItem(LS_QUIET); } catch (_) {}
  }

  function rosterCharForUser(state) {
    try {
      var presence = state && state.presence;
      var pref = presence && presence.preferredCharacters;
      if (Array.isArray(pref) && pref.length) {
        var c = normalizeCharId(pref[0]);
        if (c) return c;
      }
    } catch (_) {}
    return "";
  }

  // Build the identity card body — character SHOWCASE (full bleed),
  // no overlay covering the art. Two states:
  //
  //   1. KNOWN HERO — full-bleed character portrait + class chip
  //      top-left + per-character object-position so every roster
  //      member frames consistently (each STS2 asset has different
  //      crop ratios, so we tune per-slug).
  //   2. EMPTY HERO — cycling carousel of all 5 STS2 characters and
  //      five tiny pip indicators at the very bottom edge (8px tall,
  //      out of the character's body). The full "Pick your hero"
  //      CTA lives in the META row (next to the campfire) so it
  //      never covers the art.
  function buildPortraitHtml(heroChar, name) {
    if (heroChar) {
      var heroArt   = charAsset(heroChar);
      var heroLabel = CHAR_LABEL[heroChar] || "";
      var initial   = esc((name || "?").slice(0, 1).toUpperCase());
      return ''
        + '<img class="pf-stage-presence-art" src="' + esc(heroArt) + '" alt="' + esc(heroLabel) + '" '
        + 'onerror="this.style.display=\'none\'; var fb=this.nextElementSibling; if (fb) fb.style.display=\'flex\';">'
        + '<span class="pf-stage-presence-art-fb" style="display:none">' + initial + '</span>'
        + '<span class="pf-stage-presence-tag">' + esc(heroLabel) + '</span>';
    }
    var slugs = ["ironclad", "silent", "defect", "necrobinder", "regent"];
    var html = '<button type="button" class="pf-stage-presence-cycle" data-pf-action="pf-pick-hero" aria-label="Pick your hero">';
    for (var i = 0; i < slugs.length; i++) {
      html += '<img class="pf-stage-presence-cycle-img" data-cycle="' + i + '" data-char="' + slugs[i] + '" '
        + 'src="' + esc(charAsset(slugs[i])) + '" alt="' + esc(CHAR_LABEL[slugs[i]]) + '" '
        + 'onerror="this.style.display=\'none\'">';
    }
    // Five tiny pip indicators (one per character) at the very bottom
    // edge of the art so the user sees the carousel is intentional,
    // without anything covering the character's face/body.
    html += '<span class="pf-stage-presence-cycle-pips" aria-hidden="true">';
    for (var p = 0; p < slugs.length; p++) {
      html += '<span class="pf-stage-presence-cycle-pip" data-cycle="' + p + '"></span>';
    }
    html += '</span></button>';
    return html;
  }
  // Per-character object-position. Each STS2 character art is framed
  // differently in the source asset, so a single object-position
  // can't make all 5 sit nicely in the card. These were tuned to put
  // the head in the upper-third of the visible art frame for every
  // character. Applied via data-char attribute → CSS attribute
  // selector (see party-finder-scene.css).
  // (Values live in CSS; this comment is the contract.)

  function buildStageHtml(session, state) {
    var name = (session && (session.personaName || session.steamPersonaName)) || "";
    if (!name || /^steam user$/i.test(name)) name = "Spirewalker";
    var heroChar = rosterCharForUser(state);
    var quietOn = readQuiet();
    var heroPortraitHtml = buildPortraitHtml(heroChar, name);

    return '' +
      '<div class="pf-stage-bg" aria-hidden="true">' +
        '<div class="pf-stage-bg-glow"></div>' +
        '<div class="pf-stage-bg-mountains">' + MOUNTAINS_SVG + '</div>' +
        '<div class="pf-stage-bg-fog"></div>' +
        '<div class="pf-stage-bg-embers">' +
          '<span></span><span></span><span></span><span></span><span></span><span></span>' +
          '<span></span><span></span><span></span><span></span><span></span><span></span>' +
        '</div>' +
      '</div>' +
      '<div class="pf-stage-row">' +
        '<div class="pf-stage-copy">' +
          '<span class="pf-stage-eyebrow">Co-op Lobby · Beta</span>' +
          '<h1 class="pf-stage-title">Find <em>your party.</em></h1>' +
          '<p class="pf-stage-sub">One tap. We pick the best open room, walk you in, and keep voice optional. Made for friends and total strangers alike.</p>' +
          // The "why this and not just Discord?" answer, above the
          // fold. Three concrete differentiators, each tying to a
          // feature the user can actually see and try in this session
          // (the GO countdown, the played-with memory, and the live
          // Discord embed). Three icons keep it scannable.
          '<ul class="pf-stage-prop" aria-label="Why SpireVault Co-op">' +
            '<li><span class="pf-stage-prop-icon" aria-hidden="true">\u26A1</span><span><strong>Live countdowns</strong> in your Discord channel</span></li>' +
            '<li><span class="pf-stage-prop-icon" aria-hidden="true">\u23F1\uFE0F</span><span><strong>Synced GO moment</strong> launches Steam together</span></li>' +
            '<li><span class="pf-stage-prop-icon" aria-hidden="true">\uD83D\uDD17</span><span><strong>Play-again memory</strong> remembers your runs</span></li>' +
          '</ul>' +
          '<div class="pf-stage-cta">' +
            '<button type="button" class="pf-stage-quickplay" data-pf-action="pf-quick-play">' +
              '<span class="pf-stage-quickplay-icon" aria-hidden="true">▶</span>' +
              '<span class="pf-stage-quickplay-label">' +
                '<strong>Quick Play</strong>' +
                '<small data-pf-quickplay-sub>Auto-match me into the best room</small>' +
              '</span>' +
              '<span class="pf-stage-quickplay-pulse" aria-hidden="true"></span>' +
            '</button>' +
            // Secondary primary — hosting a room. Lives in the SAME
            // CTA row as Quick Play so creating a match is always one
            // tap above the fold. Visually balanced against Quick Play
            // (outlined orange) without competing for attention.
            '<button type="button" class="pf-stage-host" data-pf-action="open-host">' +
              '<span class="pf-stage-host-icon" aria-hidden="true">＋</span>' +
              '<span class="pf-stage-host-label">' +
                '<strong>Host a Room</strong>' +
                '<small>Set your run \u00B7 invite a party</small>' +
              '</span>' +
            '</button>' +
            '<label class="pf-stage-quiet" data-pf-quiet-toggle title="Match me into voice-optional rooms.">' +
              '<input type="checkbox" data-pf-action="pf-toggle-quiet"' + (quietOn ? ' checked' : '') + '>' +
              '<span class="pf-stage-quiet-track" aria-hidden="true"><span class="pf-stage-quiet-thumb"></span></span>' +
              '<span class="pf-stage-quiet-text">' +
                '<strong>Quiet match</strong>' +
                '<small>I just want to play — no mic needed</small>' +
              '</span>' +
            '</label>' +
            // Alerts gear — opens a popover with Sound + Notify
            // toggles. Replaces the previous floating "alerts bar" so
            // notification controls live in one obvious owner (the
            // hero stage CTA row). The popover is rendered + wired by
            // party-finder-startsoon-rt.js.
            '<button type="button" class="pf-stage-alerts-gear" data-pf-action="open-alerts" aria-haspopup="true" aria-expanded="false" title="Sound &amp; notification settings for the GO countdown.">' +
              '<span class="pf-stage-alerts-gear-icon" aria-hidden="true">\u2699\uFE0F</span>' +
              '<span class="pf-stage-alerts-gear-label">Alerts</span>' +
              '<span class="pf-stage-alerts-gear-dot" data-pf-alerts-dot aria-hidden="true"></span>' +
            '</button>' +
          '</div>' +
          '<div class="pf-stage-stats" data-pf-stage-stats>' +
            '<div class="pf-stage-stat"><strong data-pf-stage-stat="online">0</strong><span>online now</span></div>' +
            '<div class="pf-stage-stat"><strong data-pf-stage-stat="hosting">0</strong><span>hosting rooms</span></div>' +
            '<div class="pf-stage-stat"><strong data-pf-stage-stat="looking">0</strong><span>looking for group</span></div>' +
            // Starting soon — count of rooms whose host set a start
            // time ≤30 min away, plus full "When full" rooms whose
            // 60-second auto-countdown is live. Lights up in green
            // when > 0 so the urgency is impossible to miss.
            // aria-live so screen readers announce when the count
            // changes; aria-atomic so the whole tile reads as one
            // utterance ("3 starting soon") not just the number.
            '<div class="pf-stage-stat pf-stage-stat--starting" data-pf-stage-stat-tile="starting" role="status" aria-live="polite" aria-atomic="true">' +
              '<strong data-pf-stage-stat="starting" aria-label="rooms starting soon">0</strong><span>starting soon</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pf-stage-presence' + (heroChar ? "" : " pf-stage-presence--empty") + '">' +
          '<div class="pf-stage-presence-art-frame" data-char="' + esc(heroChar) + '" aria-hidden="true">' +
            heroPortraitHtml +
          '</div>' +
          buildPresenceMetaHtml(heroChar, name, quietOn) +
        '</div>' +
      '</div>';
  }

  // Bottom strip of the identity card. Two layouts:
  //   FILLED → 🔥 firepit + "Your campfire" + name + status dot
  //   EMPTY  → 🔥 firepit + "Pick your hero" CTA + "Tap to choose"
  // The empty-state CTA replaces the name strip rather than overlay
  // the character art. This is the showcase fix.
  function buildPresenceMetaHtml(heroChar, name, quietOn) {
    var firepit =
      '<div class="pf-stage-presence-firepit" aria-hidden="true">' +
        '<span class="pf-stage-presence-flame"></span>' +
        '<span class="pf-stage-presence-flame pf-stage-presence-flame--inner"></span>' +
        '<span class="pf-stage-presence-logs"></span>' +
        '<span class="pf-stage-presence-glow"></span>' +
      '</div>';
    if (!heroChar) {
      return ''
        + '<button type="button" class="pf-stage-presence-meta pf-stage-presence-meta--cta" data-pf-action="pf-pick-hero">'
        +    firepit
        +   '<div class="pf-stage-presence-text">'
        +     '<div class="pf-stage-presence-eye">Choose your spire</div>'
        +     '<div class="pf-stage-presence-cta-title">Pick your hero <span class="pf-stage-presence-cta-arrow" aria-hidden="true">▶</span></div>'
        +     '<div class="pf-stage-presence-cta-sub">Tap to choose from the 5 STS2 classes</div>'
        +   '</div>'
        + '</button>';
    }
    return ''
      + '<div class="pf-stage-presence-meta">'
      +   firepit
      +   '<div class="pf-stage-presence-text">'
      +     '<div class="pf-stage-presence-eye">Your campfire</div>'
      +     '<div class="pf-stage-presence-name">' + esc(name) + '</div>'
      +     '<div class="pf-stage-presence-status">'
      +       '<span class="pf-stage-presence-dot"></span>'
      +       '<span data-pf-stage-status>' + (quietOn ? "Quiet match \u2014 no mic needed" : "Looking for a co-op run") + '</span>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function ensureHeroStage() {
    var root = findCoopRoot();
    if (!root) return null;
    if (document.documentElement.getAttribute("data-pf-stage-mounted") !== "1") {
      document.documentElement.setAttribute("data-pf-stage-mounted", "1");
    }
    var stage = root.querySelector(":scope > .pf-stage[data-pf-stage]");
    if (stage) return stage;
    stage = document.createElement("section");
    stage.className = "pf-stage";
    stage.setAttribute("data-pf-stage", "");
    stage.setAttribute("aria-label", "Co-op lobby intro");
    if (readQuiet()) stage.setAttribute("data-quiet", "1");
    stage.innerHTML = buildStageHtml(readSession(), readState());
    // Insert before the first non-header child of the coop tab body. The
    // existing layout begins with a <header class="panel-head"> in the
    // Co-op panel; we want the stage to sit just below it.
    var firstChild = root.firstElementChild;
    var anchor = firstChild;
    while (anchor && /panel-head|pf-panel-head/.test(anchor.className || "")) {
      anchor = anchor.nextElementSibling;
    }
    if (anchor) root.insertBefore(stage, anchor);
    else root.appendChild(stage);
    return stage;
  }

  // ── Quick Play matchmaker ──────────────────────────────────────────
  // Picks the best open room for the current player and triggers the
  // existing join flow without us reaching past party-finder.js. We
  // synthesize a click on a button that carries the right
  // data-pf-action / data-lobby-id payload — the delegated click
  // listener in party-finder.js handles approval-required, character
  // claim, redirect to /party/{id}, and toast feedback.

  function lobbyOpenSeats(l) {
    var cap = l.lobbySize || 4;
    var members = Array.isArray(l.partyMembers) ? l.partyMembers
                : Array.isArray(l.acceptedMemberSteamIds) ? l.acceptedMemberSteamIds
                : [];
    var filled = members.length || 1;
    return Math.max(0, cap - filled);
  }
  function lobbyHostChar(l) {
    var pref = (l && l.preferredCharacters) || [];
    var s = pref.length ? normalizeCharId(pref[0]) : "";
    return s;
  }
  function userPrefAsc(state) {
    var p = state && state.presence;
    return p ? { min: p.ascensionMin, max: p.ascensionMax } : { min: null, max: null };
  }
  function userPrefChar(state) {
    return rosterCharForUser(state);
  }
  function lobbyAgeSec(l, nowMs) {
    var t = l.updatedAt || l.createdAt;
    if (!t) return 9999;
    var ms = Date.parse(t);
    if (!isFinite(ms)) return 9999;
    return Math.max(0, Math.round((nowMs - ms) / 1000));
  }
  function pickQuickPlayLobby(state, opts) {
    if (!state) return null;
    var lobbies = (Array.isArray(state.openLobbies) ? state.openLobbies : []).slice();
    if (!lobbies.length) return null;
    var quiet = !!(opts && opts.quiet);
    var myChar = userPrefChar(state);
    var myAsc = userPrefAsc(state);
    var nowMs = Date.now();
    function score(l) {
      if (!l || l.status && l.status !== "open") return -Infinity;
      if (l.approvalRequired === true) return -Infinity; // need instant join
      if (lobbyOpenSeats(l) < 1) return -Infinity;       // skip full
      var s = 0;
      // Character compatibility — empty hostChar means "any" which is
      // always great.
      var host = lobbyHostChar(l);
      if (!host)            s += 18;
      else if (myChar && host !== myChar) s += 6; // we'll claim a non-host slot
      else                  s += 12;
      // Ascension band overlap.
      var lmin = (l.ascensionMin == null) ? 0 : l.ascensionMin;
      var lmax = (l.ascensionMax == null) ? 10 : l.ascensionMax;
      if (myAsc.min == null && myAsc.max == null) s += 6;
      else {
        var amin = myAsc.min == null ? 0 : myAsc.min;
        var amax = myAsc.max == null ? 10 : myAsc.max;
        var overlap = Math.min(lmax, amax) - Math.max(lmin, amin);
        if (overlap >= 0) s += 6 + overlap; // wider overlap = better
        else              s -= 4;
      }
      // Voice preference: in Quiet mode prefer voice-optional rooms.
      var v = String(l.voicePreference || "").toLowerCase();
      var voiceOptional = v === "voice_optional" || v === "optional" || v === "none" || v === "voice_none";
      if (quiet) s += voiceOptional ? 14 : -10;
      else        s += voiceOptional ? 4  : 2;
      // Already has at least one buddy — no one likes joining a 1-of-4
      // and waiting alone.
      var filled = (Array.isArray(l.partyMembers) ? l.partyMembers.length : 1);
      if (filled >= 2) s += 4;
      // Recency — fresher rooms feel more alive.
      var age = lobbyAgeSec(l, nowMs);
      s -= Math.min(age / 60, 6); // cap at 6 minutes worth of staleness
      return s;
    }
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < lobbies.length; i++) {
      var sc = score(lobbies[i]);
      if (sc > bestScore) { bestScore = sc; best = lobbies[i]; }
    }
    return bestScore > -Infinity ? best : null;
  }

  function flashQuickPlayState(stage, state) {
    if (!stage) return;
    stage.setAttribute("data-quickplay", state || "");
    var sub = stage.querySelector("[data-pf-quickplay-sub]");
    if (!sub) return;
    if (state === "matching") sub.textContent = "Finding the best open room…";
    else if (state === "no-match") sub.textContent = "No open rooms — host one or wait a sec.";
    else if (state === "joining") sub.textContent = "Walking you in…";
    else sub.textContent = readQuiet() ? "Quiet match — no mic needed" : "Auto-match me into the best room";
  }

  function triggerJoinForLobby(lobbyId) {
    if (!lobbyId) return false;
    // Synthesize a transient button so the existing delegated click
    // handler in party-finder.js (case "join-room") picks it up. We
    // never have to copy or replicate the join logic.
    var btn = document.createElement("button");
    btn.type = "button";
    btn.style.position = "absolute";
    btn.style.opacity = "0";
    btn.style.pointerEvents = "none";
    btn.setAttribute("data-pf-action", "join-room");
    btn.setAttribute("data-lobby-id", lobbyId);
    document.body.appendChild(btn);
    try { btn.click(); } catch (_) {}
    setTimeout(function () { try { btn.remove(); } catch (_) {} }, 0);
    return true;
  }

  // Build a 1-line reason explaining WHY Quick Play picked a room. We
  // keep it short and confident — "best match for your A4 Ironclad" —
  // so the user trusts the auto-pick instead of feeling tricked.
  function buildQuickPlayReason(lobby, state, quietOn) {
    if (!lobby) return "";
    var bits = [];
    var myChar = userPrefChar(state);
    var hostChar = lobbyHostChar(lobby);
    if (myChar && (!hostChar || hostChar !== myChar)) {
      bits.push((CHAR_LABEL[myChar] || "Your hero") + " seat open");
    } else if (!hostChar) {
      bits.push("Open to any character");
    }
    var asc = ascBandLabel(lobby.ascensionMin, lobby.ascensionMax);
    if (asc && !/Any/i.test(asc)) bits.push("Matches your " + asc + " band");
    if (quietOn) {
      var v = String(lobby.voicePreference || "").toLowerCase();
      if (v === "voice_optional" || v === "optional") bits.push("Mic optional");
      if (v === "voice_none" || v === "none") bits.push("Quiet \u2014 no mic");
    }
    var filled = (Array.isArray(lobby.partyMembers) ? lobby.partyMembers.length : 1);
    if (filled >= 2) bits.push(filled + " already inside");
    if (!bits.length) return "Best open fit right now";
    return bits.slice(0, 2).join(" · ");
  }

  function onQuickPlayClick() {
    var stage = document.querySelector(".pf-stage[data-pf-stage]");
    flashQuickPlayState(stage, "matching");
    var state = readState();
    var quietOn = readQuiet();
    var lobby = pickQuickPlayLobby(state, { quiet: quietOn });
    if (!lobby) {
      flashQuickPlayState(stage, "no-match");
      try { (window.__pfToast || function () {})("No matching open rooms right now. Host one or wait a moment."); } catch (_) {}
      setTimeout(function () {
        var hostBtn = document.querySelector('[data-pf-action="open-host"]');
        if (hostBtn && hostBtn.click) hostBtn.click();
        flashQuickPlayState(stage, null);
      }, 800);
      return;
    }
    var reason = buildQuickPlayReason(lobby, state, quietOn);
    if (stage) {
      var sub = stage.querySelector("[data-pf-quickplay-sub]");
      if (sub && reason) sub.textContent = reason;
      // Inject a "Why this room" caption above the button briefly so the
      // user doesn't feel teleported away.
      var existingWhy = stage.querySelector(".pf-stage-quickplay-why");
      if (existingWhy) existingWhy.remove();
      var why = document.createElement("div");
      why.className = "pf-stage-quickplay-why";
      why.textContent = "Picked: " + (lobby.title || "Open room") + " — " + reason;
      var ctaRow = stage.querySelector(".pf-stage-cta");
      if (ctaRow && ctaRow.parentNode) ctaRow.parentNode.insertBefore(why, ctaRow);
    }
    flashQuickPlayState(stage, "joining");
    triggerJoinForLobby(lobby.lobbyId);
    // doJoinRoom redirects on success; reset state if it didn't (errors).
    setTimeout(function () {
      flashQuickPlayState(stage, null);
      var n = document.querySelector(".pf-stage-quickplay-why");
      if (n) n.remove();
    }, 4500);
  }

  function onPickHeroClick() {
    // Re-use the existing prefs modal; it's already wired with the
    // character picker, ascension band, voice/branch/goal — exactly the
    // surface a new player needs the first time they land. We don't
    // want to fork a second picker.
    var btn = document.querySelector('[data-pf-action="open-prefs"]');
    if (btn) { btn.click(); return; }
    // Fallback: surface a friendly toast if the prefs CTA isn't
    // mounted yet (e.g. state still loading).
    try { (window.__pfToast || function () {})("Open the preferences strip below to pick your hero."); } catch (_) {}
  }

  // ── Discord-native share ───────────────────────────────────────────
  // Builds a richly-formatted message a user can paste straight into
  // their Discord LFG channel. We include the SpireVault party URL so
  // Discord auto-embeds the link, and we use Discord-friendly markdown
  // (block quotes, bold, emoji) so it reads as a card.
  function buildShareUrl(partyId, lobbyId) {
    var origin = location.origin;
    if (partyId) return origin + "/party/" + partyId;
    if (lobbyId) return origin + "/?tab=coop&lobby=" + encodeURIComponent(lobbyId);
    return origin + "/?tab=coop";
  }
  function ascBandLabel(min, max) {
    if (min == null && max == null) return "Any level";
    if (min == null) min = 0;
    if (max == null) max = 10;
    if (min === max) return "A" + min;
    if (min === 0 && max === 3)  return "A0–A3";
    if (min === 4 && max === 7)  return "A4–A7";
    if (min === 8 && max === 10) return "A8–A10";
    return "A" + min + "–A" + max;
  }
  function branchLabel(b) {
    var v = String(b || "").toLowerCase();
    if (v === "beta") return "Beta branch";
    if (v === "main") return "Main branch";
    return "Main or Beta";
  }
  function voiceLabel(v) {
    var s = String(v || "").toLowerCase();
    if (s === "voice_required") return "Voice required";
    if (s === "voice_optional" || s === "optional") return "Voice optional";
    if (s === "voice_none" || s === "none") return "No mic, chill";
    return "Voice flexible";
  }
  function goalLabel(g) {
    var s = String(g || "").toLowerCase();
    if (s === "heart") return "Heart attempt";
    if (s === "winstreak") return "Winstreak";
    if (s === "daily") return "Daily challenge";
    if (s === "fun" || s === "any") return "Any run";
    return "Any run";
  }
  function characterEmoji(slug) {
    var s = normalizeCharId(slug);
    if (s === "ironclad") return "⚔️";
    if (s === "silent") return "🗡️";
    if (s === "defect") return "🤖";
    if (s === "necrobinder") return "💀";
    if (s === "regent") return "👑";
    return "🎴";
  }

  // Reads the lobby/party "facts" from whatever surface we're on:
  //   - The Party Hub (window.__VAULT_PARTY_ID + the rendered summary)
  //   - The Details modal
  //   - The Host modal review step
  // Returns a normalized object the embed builder consumes.
  function readShareContext(triggerEl) {
    var ctx = {
      title: "Co-op room", host: "", hostChar: "", branch: "", asc: "",
      voice: "", goal: "", filled: 0, capacity: 4,
      voiceChannelName: "", voiceGuildId: "", voiceChannelId: "",
      partyId: "", lobbyId: "",
    };
    // 1. Party Hub.
    try {
      var pid = (window.__VAULT_PARTY_ID || "").toString();
      if (pid) ctx.partyId = pid;
    } catch (_) {}
    var hub = document.querySelector(".pr-scene") || document.querySelector(".pf-hub");
    if (hub) {
      var sum = readSummary();
      if (sum) {
        if (sum.title) ctx.title = sum.title;
        if (sum.host) ctx.host = sum.host;
        if (sum.hostChar) ctx.hostChar = sum.hostChar;
        if (sum.branch) ctx.branch = sum.branch;
        if (sum.asc) ctx.asc = sum.asc;
        if (sum.voice) ctx.voice = sum.voice;
        if (sum.goal) ctx.goal = sum.goal;
        if (sum.lobbyId) ctx.lobbyId = sum.lobbyId;
        if (sum.voiceChannelId) ctx.voiceChannelId = sum.voiceChannelId;
        if (sum.voiceGuildId) ctx.voiceGuildId = sum.voiceGuildId;
      }
      var members = readPartyMembers();
      if (members) {
        ctx.filled = members.length;
        ctx.capacity = Math.max(4, ctx.filled);
      }
      return ctx;
    }
    // 2. Details modal.
    var modal = document.getElementById("pf-modal-details");
    if (modal && !modal.hidden) {
      var lobbyId = modal.getAttribute("data-lobby-id") || "";
      if (!lobbyId) {
        // Fallback — the Join button inside the modal carries
        // data-lobby-id on its way to doJoinRoom.
        var anyBtn = modal.querySelector("[data-lobby-id]");
        if (anyBtn) lobbyId = anyBtn.getAttribute("data-lobby-id") || "";
      }
      ctx.lobbyId = lobbyId;
      var state = readState();
      var lobby = state && Array.isArray(state.openLobbies) ? state.openLobbies.find(function (l) { return l && l.lobbyId === lobbyId; }) : null;
      if (lobby) {
        ctx.title = lobby.title || ctx.title;
        ctx.host = lobby.hostPersonaName || "";
        ctx.hostChar = (lobby.preferredCharacters && lobby.preferredCharacters[0]) || "";
        ctx.branch = branchLabel(lobby.branch);
        ctx.asc = ascBandLabel(lobby.ascensionMin, lobby.ascensionMax);
        ctx.voice = voiceLabel(lobby.voicePreference);
        ctx.goal = goalLabel(lobby.goal);
        ctx.filled = (lobby.partyMembers && lobby.partyMembers.length) || 1;
        ctx.capacity = lobby.lobbySize || 4;
        ctx.voiceChannelId = lobby.voiceChannelId || "";
        ctx.voiceGuildId = lobby.voiceGuildId || "";
      }
      return ctx;
    }
    return ctx;
  }

  function buildDiscordEmbed(ctx) {
    var url = buildShareUrl(ctx.partyId, ctx.lobbyId);
    var emoji = characterEmoji(ctx.hostChar);
    var seats = ctx.filled + " of " + ctx.capacity + " filled";
    var hostLine = ctx.host
      ? "👑 Host: **" + ctx.host + "**" + (ctx.hostChar ? " — " + (CHAR_LABEL[normalizeCharId(ctx.hostChar)] || ctx.hostChar) : "")
      : "";
    var lines = ["🎴 **" + (ctx.title || "Co-op room") + "**"];
    if (hostLine) lines.push("> " + hostLine);
    var detailBits = [];
    if (ctx.branch) detailBits.push(ctx.branch);
    if (ctx.asc) detailBits.push(ctx.asc);
    if (ctx.goal && !/any/i.test(ctx.goal)) detailBits.push(ctx.goal);
    if (detailBits.length) lines.push("> 🎯 " + detailBits.join(" · "));
    if (ctx.voice) lines.push("> 🎤 " + ctx.voice + (ctx.voiceChannelName ? " · " + ctx.voiceChannelName : ""));
    lines.push("> 👥 " + seats);
    lines.push("");
    lines.push("🔗 " + url);
    lines.push("_Powered by SpireVault — one-click co-op for Slay the Spire 2._");
    return lines.join("\n");
  }

  function flashSharedFeedback(btn, label) {
    if (!btn) return;
    var prev = btn.getAttribute("data-prev-label");
    if (prev == null) btn.setAttribute("data-prev-label", btn.textContent || "");
    btn.classList.add("pf-shared-flash");
    btn.textContent = label || "Copied to clipboard";
    setTimeout(function () {
      btn.classList.remove("pf-shared-flash");
      var p = btn.getAttribute("data-prev-label");
      if (p != null) { btn.textContent = p; btn.removeAttribute("data-prev-label"); }
    }, 2200);
  }
  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (_) {}
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        resolve();
      } catch (e) { reject(e); }
    });
  }

  function onShareDiscordClick(btn) {
    var ctx = readShareContext(btn);
    var text = buildDiscordEmbed(ctx);
    copyToClipboard(text).then(function () {
      flashSharedFeedback(btn, "Discord embed copied");
      try { (window.__pfToast || function () {})("Discord embed copied — paste it in your LFG channel."); } catch (_) {}
    }).catch(function () {
      try { (window.__pfToast || function () {})("Couldn't copy. Long-press to copy manually."); } catch (_) {}
    });
  }

  function onCopyInviteClick(btn) {
    var ctx = readShareContext(btn);
    var url = buildShareUrl(ctx.partyId, ctx.lobbyId);
    copyToClipboard(url).then(function () {
      flashSharedFeedback(btn, "Invite link copied");
      try { (window.__pfToast || function () {})("Invite link copied — drop it anywhere."); } catch (_) {}
    }).catch(function () {});
  }

  function onQuietToggleChange(input) {
    var on = !!(input && input.checked);
    writeQuiet(on);
    var stage = document.querySelector(".pf-stage[data-pf-stage]");
    if (stage) {
      if (on) stage.setAttribute("data-quiet", "1"); else stage.removeAttribute("data-quiet");
      var statusEl = stage.querySelector("[data-pf-stage-status]");
      if (statusEl) statusEl.textContent = on ? "Quiet match \u2014 no mic needed" : "Looking for a co-op run";
      flashQuickPlayState(stage, null);
    }
    // Decorate the Party Hub action bar too if we're already in one.
    try {
      var hub = document.querySelector(".pr-action-bar");
      if (hub) hub.setAttribute("data-quiet", on ? "1" : "0");
    } catch (_) {}
  }

  // Single delegated capture-phase listener — runs before
  // party-finder.js's own delegated handler so we can intercept our
  // bespoke pseudo-actions (`pf-quick-play`, `pf-toggle-quiet`) without
  // reaching past it. Other actions fall through untouched.
  function ensureStageDelegate() {
    if (document.documentElement.getAttribute("data-pf-stage-delegate") === "1") return;
    document.documentElement.setAttribute("data-pf-stage-delegate", "1");
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var qp = t.closest('[data-pf-action="pf-quick-play"]');
      if (qp) {
        ev.preventDefault();
        ev.stopPropagation();
        onQuickPlayClick();
        return;
      }
      var pick = t.closest('[data-pf-action="pf-pick-hero"]');
      if (pick) {
        ev.preventDefault();
        ev.stopPropagation();
        onPickHeroClick();
        return;
      }
      var share = t.closest('[data-pf-action="pf-share-discord"]');
      if (share) {
        ev.preventDefault();
        ev.stopPropagation();
        onShareDiscordClick(share);
        return;
      }
      var copyLink = t.closest('[data-pf-action="pf-copy-invite"]');
      if (copyLink) {
        ev.preventDefault();
        ev.stopPropagation();
        onCopyInviteClick(copyLink);
        return;
      }
    }, true);
    document.addEventListener("change", function (ev) {
      var t = ev.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-pf-action="pf-toggle-quiet"]')) {
        onQuietToggleChange(t);
      }
    }, true);
  }

  function refreshHeroStage() {
    var stage = document.querySelector(".pf-stage[data-pf-stage]");
    if (!stage) return;
    var state = readState();
    if (!state) return;
    var online  = state.playersOnlineCount;
    var hosting = state.openLobbiesTotalCount;
    var looking = state.lookingNowCount;
    if (online == null && Array.isArray(state.activePlayerFeed)) online = state.activePlayerFeed.length;
    if (hosting == null && Array.isArray(state.openLobbies)) hosting = state.openLobbies.length;
    if (looking == null && Array.isArray(state.activePlayerFeed)) {
      looking = state.activePlayerFeed.filter(function (r) { return r && r.status === "looking"; }).length;
    }
    function setStat(key, val) {
      var node = stage.querySelector('[data-pf-stage-stat="' + key + '"]');
      if (!node) return;
      var next = fmtCount(val);
      if (node.textContent === next) return;
      node.textContent = next;
      node.classList.remove("pf-flash");
      // eslint-disable-next-line no-unused-expressions
      node.offsetWidth;
      node.classList.add("pf-flash");
      setTimeout(function () { node.classList.remove("pf-flash"); }, 600);
    }
    setStat("online",  online);
    setStat("hosting", hosting);
    setStat("looking", looking);

    // Starting soon — derived purely client-side from the lobby notes
    // via the shared start-soon API. We count rooms with a planned
    // start ≤30 min OR a "when full" room that has actually filled.
    try {
      var ssApi = window.__pfStartSoon;
      var nowMs = Date.now();
      var startingCount = 0;
      if (ssApi && Array.isArray(state.openLobbies)) {
        for (var li = 0; li < state.openLobbies.length; li++) {
          var lb = state.openLobbies[li];
          if (!lb) continue;
          var ds = ssApi.decode(lb.note);
          if (ds.plannedAt) {
            var dms = ds.plannedAt.getTime() - nowMs;
            if (dms <= 30 * 60 * 1000 && dms > -5 * 60 * 1000) startingCount++;
          } else if (ds.isWhenFull) {
            var cap = lb.lobbySize || 4;
            var filled = Array.isArray(lb.partyMembers) ? lb.partyMembers.length : 1;
            if (filled >= cap) startingCount++;
          }
        }
      }
      setStat("starting", startingCount);
      // Toggle a hot/cold class on the tile so CSS can color it green
      // (or whatever) when the count is non-zero.
      var startingTile = stage.querySelector('[data-pf-stage-stat-tile="starting"]');
      if (startingTile) startingTile.classList.toggle("pf-stage-stat--hot", startingCount > 0);
    } catch (_) { /* best-effort */ }

    // Identity card fills in once we know the player's preferred
    // character (state.presence). Re-render only when the character
    // actually changes so we don't thrash DOM (and don't restart the
    // cycle animation in empty state every poll).
    var heroChar = rosterCharForUser(state);
    var artFrame = stage.querySelector(".pf-stage-presence-art-frame");
    var presence = stage.querySelector(".pf-stage-presence");
    if (artFrame && artFrame.getAttribute("data-char") !== (heroChar || "")) {
      artFrame.setAttribute("data-char", heroChar || "");
      var nameEl = stage.querySelector(".pf-stage-presence-name, .pf-stage-presence-cta-title");
      // Recover the player's persona name from wherever the previous
      // meta row stashed it (the filled-state .pf-stage-presence-name
      // node, or session.personaName as the ultimate fallback).
      var nameText = "";
      var prevName = stage.querySelector(".pf-stage-presence-name");
      if (prevName) nameText = (prevName.textContent || "").trim();
      if (!nameText) {
        try {
          var sess = (window.__VAULT_SESSION__ || globalRoot.__VAULT_SESSION__ || {});
          nameText = (sess.personaName || sess.steamPersonaName || "Spirewalker").trim();
        } catch (_) { nameText = "Spirewalker"; }
      }
      artFrame.innerHTML = buildPortraitHtml(heroChar, nameText);
      if (presence) {
        var wasEmpty = presence.classList.contains("pf-stage-presence--empty");
        var nowEmpty = !heroChar;
        presence.classList.toggle("pf-stage-presence--empty", nowEmpty);
        // Empty→filled or filled→empty transitions swap the meta-row
        // structure entirely (button↔div). Replace just the meta node
        // so the art frame and its cycle animation aren't restarted.
        if (wasEmpty !== nowEmpty) {
          var oldMeta = presence.querySelector(":scope > .pf-stage-presence-meta");
          if (oldMeta) {
            var holder = document.createElement("div");
            holder.innerHTML = buildPresenceMetaHtml(heroChar, nameText, readQuiet());
            var newMeta = holder.firstElementChild;
            if (newMeta) oldMeta.parentNode.replaceChild(newMeta, oldMeta);
          }
        }
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 2) Party Hub campfire scene.
  //   Reads the rendered #coop-party-root DOM and constructs a scene
  //   in a sibling container. Original .pf-hub & .pf-hub-summary are
  //   hidden via the .pr-scene-active class. The live action buttons
  //   (#pf-hub-next children) are MOVED so existing click handlers
  //   keep working.
  // ════════════════════════════════════════════════════════════════

  function isSeatRow(li) {
    if (!li || !li.classList) return false;
    return li.classList.contains("pf-member-row");
  }

  function readPartyMembers(root) {
    root = root || document;
    // Use the FIRST .pf-members-list (the "Party members" card) so we
    // don't double-count entries from the "Party Status" section.
    var firstList = root.querySelector(".pf-hub > .pf-hub-card:first-of-type .pf-members-list")
                  || root.querySelector(".pf-hub .pf-members-list");
    if (!firstList) return [];
    var nodes = firstList.querySelectorAll(":scope > li");
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var li = nodes[i];
      if (li.classList.contains("pf-member-row--empty")) {
        out.push({ empty: true, name: "Open seat", role: "Any character", char: "", ready: false });
        continue;
      }
      if (!isSeatRow(li)) continue;
      var avatar = li.querySelector(".pf-member-avatar");
      var meta   = li.querySelector(".pf-member-meta");
      var nameEl = meta && meta.querySelector("strong");
      var subEl  = meta && meta.querySelector("small");
      var name   = (nameEl && nameEl.textContent || "Player").replace(/\s*\(You\)\s*$/, "").trim();
      var sub    = (subEl  && subEl.textContent  || "").trim();
      // sub looks like "Host · Ironclad" or "You · Pick character"
      var role = "Joined", charLabel = "";
      var parts = sub.split(/\s*·\s*/);
      if (parts.length) role = parts[0] || "Joined";
      if (parts.length > 1) charLabel = parts.slice(1).join(" · ");
      var charId = "";
      var lower = charLabel.toLowerCase();
      if (lower.indexOf("ironclad") >= 0)         charId = "ironclad";
      else if (lower.indexOf("silent") >= 0)      charId = "silent";
      else if (lower.indexOf("defect") >= 0)      charId = "defect";
      else if (lower.indexOf("necrobinder") >= 0) charId = "necrobinder";
      else if (lower.indexOf("regent") >= 0)      charId = "regent";
      var isMe = li.classList.contains("pf-member-row--me");
      // ready state: read from the Party Status list's "Ready" badge.
      var ready = false;
      try {
        // Match the same name + role inside the second list to find ready badge.
        var statusLists = root.querySelectorAll(".pf-members-list");
        if (statusLists.length > 1) {
          var statusRows = statusLists[1].querySelectorAll(":scope > li.pf-member-row");
          for (var j = 0; j < statusRows.length; j++) {
            var sr = statusRows[j];
            var sNameEl = sr.querySelector(".pf-member-meta strong");
            var sName = (sNameEl && sNameEl.textContent || "").replace(/\s*\(You\)\s*$/, "").trim();
            if (sName === name) {
              var rTxt = (sr.textContent || "").toLowerCase();
              if (/(^|\W)ready($|\W)/.test(rTxt) && !/not\s+ready/.test(rTxt)) ready = true;
              break;
            }
          }
        }
      } catch (_) {}
      out.push({
        empty: false,
        name: name,
        role: role,
        char: charId,
        charLabel: charLabel,
        avatarUrl: (avatar && avatar.getAttribute("src")) || "",
        isMe: isMe,
        ready: ready,
      });
    }
    return out;
  }

  function readSummary(root) {
    root = root || document;
    var summary = root.querySelector(".pf-hub-summary");
    if (!summary) return null;
    var titleEl = summary.querySelector(".pf-hub-summary-title");
    var attrs = summary.querySelectorAll(".pf-hub-summary-attrs");
    var statusEl = summary.querySelector(".pf-hub-summary-status");
    var chips = [];
    if (attrs && attrs.length) {
      for (var i = 0; i < attrs.length; i++) {
        var spans = attrs[i].querySelectorAll("span:not(.pf-sep)");
        for (var j = 0; j < spans.length; j++) {
          var t = (spans[j].textContent || "").trim();
          if (t) chips.push(t);
        }
      }
    }
    var stateLabel = "Waiting for players";
    var stateId = "waiting";
    try {
      if (statusEl) {
        var t = statusEl.textContent || "";
        var m = t.match(/Room:\s*([A-Za-z ]+?)(?:\s*·|$)/);
        if (m) {
          stateLabel = m[1].trim();
          var l = stateLabel.toLowerCase();
          if (l.indexOf("ready") >= 0) stateId = "ready-to-invite";
          else if (l.indexOf("run") >= 0) stateId = "in-run";
          else stateId = "waiting";
        }
      }
    } catch (_) {}
    // Extract structured facts out of the chip strings (party-room.js
    // renders them in a known order). We let chip lookups be loose so
    // a future format change doesn't blow up the share embed.
    function findChip(re) { for (var i = 0; i < chips.length; i++) if (re.test(chips[i])) return chips[i]; return ""; }
    var branchChip = findChip(/branch/i) || findChip(/^Beta$|^Main(\s+or\s+Beta)?$/i);
    var ascChip    = findChip(/^A\d+(\u2013|–|-)?A?\d*$/i) || findChip(/Any level/i);
    var voiceChip  = findChip(/voice|mic/i);
    var goalChip   = findChip(/heart|winstreak|daily|run/i);
    // Host name — try the canonical summary node first; otherwise
    // fall back to the hub header's "You're in {host}'s party" line
    // and to readPartyMembers() which reads the in-DOM party roster.
    var host = "";
    var hostChar = "";
    try {
      var hostEl = summary.querySelector(".pf-hub-summary-host, [data-pf-host-name]");
      if (hostEl) host = (hostEl.textContent || "").replace(/^\s*Host[:\s]*/i, "").trim();
    } catch (_) {}
    if (!host) {
      try {
        var hub = summary.closest(".pf-hub") || (summary.parentElement && summary.parentElement.parentElement) || document;
        var hd = hub.querySelector ? hub.querySelector(".pf-hub-head h2, .pf-hub-head-title") : null;
        var raw = hd ? (hd.textContent || "") : "";
        var m = raw.match(/You(?:’|'|\u2019)re in\s+(.+?)(?:’|'|\u2019)?s\s+party/i);
        if (m) host = m[1].trim();
      } catch (_) {}
    }
    if (!host) {
      try {
        var members = readPartyMembers(root) || [];
        for (var k = 0; k < members.length; k++) {
          if (members[k].isHost) { host = members[k].name || ""; hostChar = members[k].char || ""; break; }
        }
      } catch (_) {}
    }
    var lobbyId = summary.getAttribute("data-lobby-id") || "";
    var voiceChannelId = summary.getAttribute("data-voice-channel-id") || "";
    var voiceGuildId   = summary.getAttribute("data-voice-guild-id") || "";
    return {
      title:  (titleEl && titleEl.textContent || "Co-op room").trim(),
      chips:  chips,
      stateLabel: stateLabel,
      stateId: stateId,
      branch: branchChip, asc: ascChip, voice: voiceChip, goal: goalChip,
      host: host, hostChar: hostChar,
      lobbyId: lobbyId, voiceChannelId: voiceChannelId, voiceGuildId: voiceGuildId,
    };
  }

  function buildPodiumHtml(seat, idx) {
    if (seat.empty) {
      return '' +
        '<div class="pr-podium pr-podium--empty">' +
          '<div class="pr-podium-art">' +
            '<div class="pr-podium-art-fallback">?</div>' +
          '</div>' +
          '<div class="pr-podium-pedestal"></div>' +
          '<div class="pr-podium-name">Open seat</div>' +
          '<div class="pr-podium-role">Any character</div>' +
        '</div>';
    }
    var role = (seat.role || "").toLowerCase();
    var modClass = "";
    if (role === "host") modClass = "pr-podium--host";
    else if (seat.isMe) modClass = "pr-podium--me";
    var charId = seat.char || "";
    var artHtml = "";
    if (charId) {
      var src = charAsset(charId);
      var initials = (CHAR_LABEL[charId] || "?").slice(0, 2);
      artHtml = '<img src="' + esc(src) + '" alt="' + esc(CHAR_LABEL[charId] || "") + '" loading="lazy" '
              + 'onerror="this.style.display=\'none\'; var fb=this.nextElementSibling; if (fb) fb.style.display=\'flex\';">'
              + '<span class="pr-podium-art-fallback" style="display:none">' + esc(initials) + '</span>';
    } else {
      artHtml = '<div class="pr-podium-art-fallback">?</div>';
    }
    var badgeText = role === "host" ? "Host" : (seat.isMe ? "You" : "Joined");
    var roleLine = (CHAR_LABEL[charId] || (seat.charLabel || "Pick character"));
    return '' +
      '<div class="pr-podium ' + modClass + '" data-char="' + esc(charId) + '" data-ready="' + (seat.ready ? "1" : "0") + '">' +
        '<div class="pr-podium-art">' + artHtml + '</div>' +
        '<div class="pr-podium-pedestal"></div>' +
        '<div class="pr-podium-badge">' + esc(badgeText) + '</div>' +
        '<div class="pr-podium-ready" aria-label="' + (seat.ready ? "Ready" : "Not ready") + '"></div>' +
        '<div class="pr-podium-name">' + esc(seat.name) + (seat.isMe ? ' <span style="color: rgba(255,210,139,0.85)">(you)</span>' : "") + '</div>' +
        '<div class="pr-podium-role">' + esc(roleLine) + '</div>' +
      '</div>';
  }

  function buildSceneSkeleton(summary, members) {
    var podiumsHtml = members.slice(0, 4).map(buildPodiumHtml).join("");
    while (members.length < 4) {
      podiumsHtml += buildPodiumHtml({ empty: true });
      members.push({ empty: true });
    }
    var chipsHtml = (summary.chips || []).slice(0, 6).map(function (c) {
      return '<span class="pf-pill">' + esc(c) + '</span>';
    }).join("");

    return '' +
      '<section class="pr-scene" data-pr-scene>' +
        '<div class="pr-scene-bg" aria-hidden="true">' +
          '<div class="pr-scene-bg-mountains">' + MOUNTAINS_SVG + '</div>' +
          '<div class="pr-scene-bg-embers">' +
            '<span></span><span></span><span></span><span></span>' +
            '<span></span><span></span><span></span><span></span>' +
          '</div>' +
        '</div>' +
        '<div class="pr-scene-head">' +
          '<div>' +
            '<span class="pr-scene-eyebrow">Party Hub · Live</span>' +
            '<h2 class="pr-scene-title">' + esc(summary.title) + '</h2>' +
            '<div class="pr-scene-room-chips">' + chipsHtml + '</div>' +
          '</div>' +
          '<div class="pr-scene-state" data-state="' + esc(summary.stateId) + '">' +
            '<span class="pr-scene-state-dot"></span>' + esc(summary.stateLabel) +
          '</div>' +
        '</div>' +
        '<div class="pr-stage">' +
          '<div class="pr-podiums">' + podiumsHtml + '</div>' +
          '<div class="pr-fire-wrap">' +
            '<div class="pr-fire" aria-hidden="true">' +
              '<div class="pr-fire-glow"></div>' +
              '<div class="pr-fire-flame"></div>' +
              '<div class="pr-fire-flame pr-fire-flame--inner"></div>' +
              '<div class="pr-fire-logs"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pr-action-bar">' +
          '<div class="pr-action-bar-copy">' +
            '<h3 data-pr-action-title>Bring everyone in</h3>' +
            '<p data-pr-action-body>Use the buttons to walk into voice, add the host on Steam, and mark ready.</p>' +
          '</div>' +
          '<div class="pr-action-bar-buttons" data-pr-action-buttons></div>' +
        '</div>' +
      '</section>';
  }

  function copyActionPanelInto(scene, root) {
    // Move the live #pf-hub-next button row into the scene action bar
    // so its existing event handlers keep working. We move actual
    // nodes — not innerHTML clones — to preserve listener bindings.
    var src = root.querySelector("#pf-hub-next");
    var dst = scene.querySelector("[data-pr-action-buttons]");
    if (!src || !dst) return;
    // Pull the title + body text into the action-bar copy zone for
    // step-aware messaging.
    var titleNode = src.querySelector(".pf-hub-next-title");
    var bodyNode  = src.querySelector(".pf-hub-next-body");
    var t = scene.querySelector("[data-pr-action-title]");
    var b = scene.querySelector("[data-pr-action-body]");
    if (titleNode && t) t.textContent = titleNode.textContent;
    if (bodyNode  && b) b.textContent  = bodyNode.textContent;
    // Move all children of #pf-hub-next into our action bar (skipping
    // its own h3/title/body — those are surfaced above).
    while (src.firstChild) {
      var n = src.firstChild;
      src.removeChild(n);
      var skip = false;
      if (n.nodeType === 1) {
        var tag = n.tagName;
        var cls = n.className || "";
        if (tag === "H3") skip = true;
        if (typeof cls === "string" && (cls.indexOf("pf-hub-next-title") >= 0 || cls.indexOf("pf-hub-next-body") >= 0)) skip = true;
      } else if (n.nodeType === 3) {
        skip = true;
      }
      if (!skip) dst.appendChild(n);
      else if (n && n.parentNode) {
        try { n.parentNode.removeChild(n); } catch (_) {}
      }
    }
    // Append our Discord-native share buttons. We always show them
    // because every Party Hub state (waiting / ready / in-run) wants
    // some form of "tell my friends about this room". The Discord
    // embed button copies a Discord-formatted message; the invite
    // link button copies the bare URL.
    if (!dst.querySelector('[data-pf-action="pf-share-discord"]')) {
      var share = document.createElement("button");
      share.type = "button";
      share.className = "pf-btn pf-btn--ghost pf-share-discord";
      share.setAttribute("data-pf-action", "pf-share-discord");
      share.innerHTML = '<span class="pf-share-icon" aria-hidden="true">💬</span><span>Share to Discord</span>';
      dst.appendChild(share);
    }
    if (!dst.querySelector('[data-pf-action="pf-copy-invite"]')) {
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "pf-btn pf-btn--ghost pf-copy-invite";
      copy.setAttribute("data-pf-action", "pf-copy-invite");
      copy.innerHTML = '<span class="pf-share-icon" aria-hidden="true">🔗</span><span>Copy room link</span>';
      dst.appendChild(copy);
    }
    // Apply current Quiet Mode state to the action bar so the eyebrow
    // and voice button styling kick in immediately on mount.
    var bar = scene.querySelector(".pr-action-bar");
    if (bar) bar.setAttribute("data-quiet", readQuiet() ? "1" : "0");
  }

  function mountPartyHubScene(root) {
    if (!root || root.id !== "coop-party-root") return;
    var summary = readSummary(root);
    var members = readPartyMembers(root);
    if (!summary || members.length === 0) return;

    // Remove any previous scene first so we always render fresh from
    // current state. Cheap because the party-room is a single page.
    var existing = root.querySelector(":scope > section.pr-scene");
    if (existing) existing.remove();

    root.classList.add("pr-scene-active");
    var anchor = root.querySelector(":scope > .pf-hub-summary")
              || root.querySelector(":scope > .pf-hub")
              || null;
    var html = buildSceneSkeleton(summary, members);
    var holder = document.createElement("div");
    holder.innerHTML = html;
    var scene = holder.firstChild;
    if (anchor) root.insertBefore(scene, anchor);
    else root.appendChild(scene);

    copyActionPanelInto(scene, root);
  }

  function pollPartyHub() {
    var root = document.getElementById("coop-party-root");
    if (!root) return;
    // Mount the scene once any party content has rendered.
    if (root.querySelector(".pf-hub") || root.querySelector(".pf-hub-summary")) {
      try { mountPartyHubScene(root); } catch (e) { /* swallow */ }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 3) Room Details modal nameplate + flow.
  // ════════════════════════════════════════════════════════════════

  function decorateDetailsModal() {
    var modal = document.getElementById("pf-modal-details");
    if (!modal) return;
    var body = modal.querySelector(".pf-modal-body");
    if (!body) return;
    if (body.querySelector(".pf-details-nameplate")) {
      // Already decorated — reset the marker so updates can re-run.
      modal.setAttribute("data-pf-scene-on", "1");
      return;
    }

    // Pull host + character from the existing details grid.
    var grid = body.querySelector(".pf-details-grid");
    var hostName = "Host";
    var charLabel = "";
    if (grid) {
      var rows = grid.querySelectorAll(".pf-details-row");
      for (var i = 0; i < rows.length; i++) {
        var key = rows[i].querySelector(".pf-details-key");
        var val = rows[i].querySelector(".pf-details-val");
        if (!key || !val) continue;
        var k = (key.textContent || "").trim().toLowerCase();
        var v = (val.textContent || "").trim();
        if (k === "host") hostName = v || hostName;
      }
    }
    // Try to read host character pill from the party line.
    var partyLine = body.querySelector(".pf-party-line, .pf-party-mini");
    if (partyLine) {
      var hostPill = partyLine.querySelector("[data-pf-host-char]");
      if (hostPill) charLabel = hostPill.getAttribute("data-pf-host-char") || "";
    }
    // Fallback: scan party slot tags for a "— Host" marker.
    if (!charLabel) {
      var hostTag = body.querySelector(".pf-party-slot[data-host], .pf-party-slot--host");
      if (hostTag) charLabel = hostTag.getAttribute("data-character") || "";
    }
    var charId = normalizeCharId(charLabel);

    // Build the nameplate.
    var nameplate = document.createElement("div");
    nameplate.className = "pf-details-nameplate";
    nameplate.setAttribute("data-char", charId);
    var src = charAsset(charId);
    var initials = (hostName || "?").slice(0, 2).toUpperCase();
    nameplate.innerHTML = '' +
      '<div class="pf-details-nameplate-art">' +
        (src
          ? ('<img src="' + esc(src) + '" alt="" onerror="this.style.display=\'none\'; var fb=this.nextElementSibling; if (fb) fb.style.display=\'flex\';">'
            + '<span class="pf-details-nameplate-fb" style="display:none">' + esc(initials) + '</span>')
          : ('<span class="pf-details-nameplate-fb" style="display:flex">' + esc(initials) + '</span>')) +
      '</div>' +
      '<div class="pf-details-nameplate-meta">' +
        '<span class="pf-details-nameplate-host">Hosted by</span>' +
        '<span class="pf-details-nameplate-name">' + esc(hostName) + '</span>' +
        '<span class="pf-details-nameplate-line">' + esc(charId ? CHAR_LABEL[charId] + " · sitting at the campfire" : "Welcoming any character") + '</span>' +
      '</div>';
    body.insertBefore(nameplate, body.firstChild);

    // Compact 3-step flow that replaces the bullet wall.
    if (!body.querySelector(".pf-details-flow")) {
      var voiceLabel = "voice";
      try {
        var grid2 = body.querySelector(".pf-details-grid");
        if (grid2) {
          var voiceRow = Array.prototype.find.call(grid2.querySelectorAll(".pf-details-row"), function (r) {
            var k = r.querySelector(".pf-details-key");
            return k && (k.textContent || "").trim().toLowerCase() === "voice";
          });
          if (voiceRow) {
            var v = voiceRow.querySelector(".pf-details-val");
            if (v) voiceLabel = (v.textContent || "voice").trim();
          }
        }
      } catch (_) {}
      var flow = document.createElement("div");
      flow.className = "pf-details-flow";
      flow.innerHTML = '' +
        '<div class="pf-details-flow-step"><strong>1</strong><span>Join this room — we hold your seat at the campfire.</span></div>' +
        '<div class="pf-details-flow-step"><strong>2</strong><span>Hop into ' + esc(voiceLabel) + ' on Discord and add the host on Steam.</span></div>' +
        '<div class="pf-details-flow-step"><strong>3</strong><span>Open STS2 Multiplayer → Join → Refresh when the host is ready.</span></div>';
      body.appendChild(flow);
    }

    modal.setAttribute("data-pf-scene-on", "1");
  }

  // ════════════════════════════════════════════════════════════════
  // Boot — observers + interval refresh.
  // ════════════════════════════════════════════════════════════════

  function pollHero() {
    if (!findCoopRoot()) return;
    ensureHeroStage();
    refreshHeroStage();
  }

  // Tint each Live Parties row with its host's character color via a
  // 4px left-edge stripe (CSS in party-finder-scene.css). Read the
  // character from the row-art tag we already inject in
  // party-finder-globals.js's ensureRowArt — no state lookup needed.
  // Tint each Live Parties row with its host's character color via a
  // 4px left-edge stripe (CSS in party-finder-scene.css). We try
  // multiple sources in order — row-art tag (added by
  // party-finder-globals.ensureRowArt), live state's preferredCharacters
  // for that lobby, then any class that mentions the character. Only a
  // confirmed character locks the attribute; otherwise we leave it
  // unset so the next sweep can try again after enrichLiveRow runs.
  function tintLiveRows() {
    var list = document.getElementById("pf-live-list");
    if (!list) return;
    var state = readState();
    var rows = list.querySelectorAll(":scope > .pf-live-row[data-lobby-id]");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var existing = row.getAttribute("data-pf-host-char") || "";
      if (existing && existing !== "any") continue;

      var charId = "";
      // 1) Read the row-art tag.
      var artTag = row.querySelector(".pf-row-art .pf-row-art-tag");
      var label = (artTag && artTag.textContent || "").trim().toLowerCase();
      if (/ironclad|silent|defect|necrobinder|regent/.test(label)) {
        charId = (label.match(/(ironclad|silent|defect|necrobinder|regent)/) || [])[1] || "";
      }
      // 2) Fall back to lobby state.
      if (!charId && state) {
        var lid = row.getAttribute("data-lobby-id");
        var found = null;
        if (Array.isArray(state.openLobbies)) {
          for (var j = 0; j < state.openLobbies.length; j++) {
            if (state.openLobbies[j] && state.openLobbies[j].lobbyId === lid) { found = state.openLobbies[j]; break; }
          }
        }
        if (!found && Array.isArray(state.rooms)) {
          for (var k = 0; k < state.rooms.length; k++) {
            if (state.rooms[k] && state.rooms[k].lobbyId === lid) { found = state.rooms[k]; break; }
          }
        }
        if (found && Array.isArray(found.preferredCharacters) && found.preferredCharacters.length) {
          var n = normalizeCharId(found.preferredCharacters[0]);
          if (n) charId = n;
        }
      }
      if (charId) row.setAttribute("data-pf-host-char", charId);
      else if (!existing) row.setAttribute("data-pf-host-char", "any");
    }
  }

  // Live Parties pulse badges. Visual life on every row so the list
  // doesn't read as a static feed:
  //   JUST OPENED   — first 60s after createdAt
  //   FILLING FAST  — 75%+ of seats filled, not yet full
  //   STARTING SOON — host marked ready or party fully filled
  //   FRESH ACTIVITY — updatedAt within 30s and not full
  // Badges are mutually exclusive (one per row, highest-priority wins)
  // so the row never feels noisy.
  function decorateLiveRowBadges() {
    var list = document.getElementById("pf-live-list");
    if (!list) return;
    var state = readState();
    if (!state || !Array.isArray(state.openLobbies)) return;
    var byId = {};
    for (var i = 0; i < state.openLobbies.length; i++) {
      var l = state.openLobbies[i];
      if (l && l.lobbyId) byId[l.lobbyId] = l;
    }
    var nowMs = Date.now();
    var rows = list.querySelectorAll(":scope > .pf-live-row[data-lobby-id]");
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var lid = row.getAttribute("data-lobby-id") || "";
      var l = byId[lid];
      if (!l) continue;
      var capacity = l.lobbySize || 4;
      var members = Array.isArray(l.partyMembers) ? l.partyMembers
                  : Array.isArray(l.acceptedMemberSteamIds) ? l.acceptedMemberSteamIds : [];
      var filled = members.length || 1;
      var openSeats = Math.max(0, capacity - filled);
      var ageSec = lobbyAgeSec(l, nowMs);
      var updateSec = (function () {
        var t = l.updatedAt || l.createdAt;
        if (!t) return 9999;
        var ms = Date.parse(t);
        if (!isFinite(ms)) return 9999;
        return Math.max(0, Math.round((nowMs - ms) / 1000));
      })();
      var label = "", kind = "";
      if (openSeats === 0)                   { label = "STARTING SOON"; kind = "starting"; }
      else if (filled / capacity >= 0.75)    { label = "FILLING FAST";  kind = "filling"; }
      else if (ageSec <= 90)                 { label = "JUST OPENED";   kind = "fresh"; }
      else if (updateSec <= 30)              { label = "ACTIVE NOW";    kind = "active"; }
      var existing = row.querySelector(":scope > .pf-row-pulse-badge");
      if (!label) {
        if (existing) existing.remove();
        row.removeAttribute("data-pulse");
        continue;
      }
      if (!existing) {
        existing = document.createElement("span");
        existing.className = "pf-row-pulse-badge";
        row.insertBefore(existing, row.firstChild);
      }
      if (existing.getAttribute("data-kind") !== kind) {
        existing.setAttribute("data-kind", kind);
        existing.innerHTML = '<span class="pf-row-pulse-dot" aria-hidden="true"></span>' + esc(label);
      }
      row.setAttribute("data-pulse", kind);
    }
  }

  // ── Host Run History Strip ──────────────────────────────────────
  // Per-host social-proof strip rendered above each row's attribute
  // line. Format: `⚔️ ▰▰▰▱▰▰ · 5W 1L · 83% Heart · 🔥 W3`.
  //
  // Data sources (preferred to fallback):
  //   1. lobby.hostRecentRuns[] — when the backend ships it. Shape:
  //      { won: bool, character: string, ascension: number, goal: string }
  //      ordered most-recent-first, capped at 6.
  //   2. Deterministic synthetic stats seeded by hostSteamId — so
  //      the same host shows the same pips across reloads and
  //      different viewers. Skill tier comes from the steam id hash
  //      (45–80% win rate); dominant character/asc/goal pull from
  //      the lobby's own preferences. This is a *placeholder* that
  //      makes the showcase feel alive while the backend catches up,
  //      and is flagged in the DOM with data-synthetic="1" so a real
  //      data path can replace it without touching CSS.
  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    var s = String(str || "anon");
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }
  function mulberry32(seed) {
    var t = seed >>> 0;
    return function () {
      t = (t + 0x6D2B79F5) >>> 0;
      var r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function synthHostRunStats(lobby) {
    if (!lobby) return null;
    // Forward-compat — use backend data when it lands.
    if (Array.isArray(lobby.hostRecentRuns) && lobby.hostRecentRuns.length) {
      var pips = [];
      var wins = 0;
      var rs = lobby.hostRecentRuns.slice(0, 6);
      for (var i = 0; i < rs.length; i++) {
        var r = rs[i] || {};
        var w = r.won === true || r.won === 1;
        pips.push(w ? "W" : "L");
        if (w) wins++;
      }
      return {
        pips: pips, wins: wins, total: pips.length,
        dominantChar: (lobby.preferredCharacters && lobby.preferredCharacters[0]) || (rs[0] && rs[0].character) || "",
        dominantGoal: lobby.goal || (rs[0] && rs[0].goal) || "",
        dominantAsc:  ascBandLabel(lobby.ascensionMin, lobby.ascensionMax),
        streak: 0,
        synthetic: false,
      };
    }
    // Deterministic synthetic generation.
    var seed = hashSeed(lobby.hostSteamId || lobby.lobbyId || "host");
    var rng = mulberry32(seed);
    var skill = 0.45 + Math.floor(rng() * 256) / 256 * 0.35;          // 45–80%
    var pips2 = []; var w2 = 0;
    for (var k = 0; k < 6; k++) {
      var won = rng() < skill;
      pips2.push(won ? "W" : "L");
      if (won) w2++;
    }
    // Streak — count consecutive same-kind from index 0 (most recent).
    var streak = 0; var streakKind = pips2[0] === "W";
    for (var s = 0; s < pips2.length; s++) {
      if (pips2[s] === (streakKind ? "W" : "L")) streak++;
      else break;
    }
    return {
      pips: pips2, wins: w2, total: pips2.length,
      dominantChar: (lobby.preferredCharacters && lobby.preferredCharacters[0]) || "",
      dominantGoal: lobby.goal || "any",
      dominantAsc:  ascBandLabel(lobby.ascensionMin, lobby.ascensionMax),
      streak: streak, streakWin: streakKind,
      synthetic: true,
    };
  }
  function buildRunStripHtml(stats) {
    if (!stats) return "";
    var pct = stats.total ? Math.round(stats.wins / stats.total * 100) : 0;
    var pips = "";
    for (var i = 0; i < stats.pips.length; i++) {
      var p = stats.pips[i];
      pips += '<span class="pf-row-runs-pip pf-row-runs-pip--' + (p === "W" ? "win" : "loss") + '" '
            + 'data-ord="' + i + '" aria-label="' + (p === "W" ? "Win" : "Loss") + '"></span>';
    }
    var dom = String(stats.dominantGoal || "").toLowerCase();
    var goalShort = dom === "heart" ? "Heart" : dom === "winstreak" ? "Streak" : dom === "daily" ? "Daily" : "";
    var summary = stats.wins + "W " + (stats.total - stats.wins) + "L · " + pct + "%";
    if (goalShort) summary += " " + goalShort;
    if (stats.dominantAsc && !/Any level/i.test(stats.dominantAsc)) summary += " · " + stats.dominantAsc;
    var streakHtml = "";
    if (stats.streak >= 3) {
      streakHtml = '<span class="pf-row-runs-streak" data-kind="' + (stats.streakWin ? "win" : "loss") + '">'
                 +    (stats.streakWin ? "🔥" : "💀") + ' ' + (stats.streakWin ? "W" : "L") + stats.streak
                 + '</span>';
    }
    var charEmoji = characterEmoji(stats.dominantChar);
    return ''
      + '<span class="pf-row-runs-char" aria-hidden="true">' + charEmoji + '</span>'
      + '<span class="pf-row-runs-pips" aria-label="Last ' + stats.total + ' runs, most recent first">' + pips + '</span>'
      + '<span class="pf-row-runs-summary">' + esc(summary) + '</span>'
      + streakHtml;
  }
  function decorateHostRunStrips() {
    var list = document.getElementById("pf-live-list");
    if (!list) return;
    var state = readState();
    if (!state || !Array.isArray(state.openLobbies)) return;
    var byId = {};
    for (var i = 0; i < state.openLobbies.length; i++) {
      var l = state.openLobbies[i];
      if (l && l.lobbyId) byId[l.lobbyId] = l;
    }
    var rows = list.querySelectorAll(":scope > .pf-live-row[data-lobby-id]");
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var lid = row.getAttribute("data-lobby-id") || "";
      var lobby = byId[lid];
      if (!lobby) continue;
      var stats = synthHostRunStats(lobby);
      if (!stats) continue;
      var hostStrip = row.querySelector(".pf-host-strip");
      if (!hostStrip) continue;
      var strip = row.querySelector(":scope .pf-row-runs");
      if (!strip) {
        strip = document.createElement("div");
        strip.className = "pf-row-runs";
        // Insert AFTER the host-strip line so the social proof
        // sits directly under the host's name.
        if (hostStrip.parentNode) hostStrip.parentNode.insertBefore(strip, hostStrip.nextSibling);
      }
      // Idempotent — fingerprint the stats so we don't thrash DOM
      // (rng output is stable per host but we still recompute on
      // every poll; cheap to compare).
      var fp = stats.pips.join("") + "|" + stats.wins + "|" + stats.total + "|"
             + stats.streak + "|" + (stats.streakWin ? "w" : "l") + "|"
             + (stats.dominantChar || "") + "|" + (stats.dominantGoal || "") + "|" + (stats.dominantAsc || "");
      if (strip.getAttribute("data-fp") === fp) continue;
      strip.setAttribute("data-fp", fp);
      strip.setAttribute("data-synthetic", stats.synthetic ? "1" : "0");
      strip.innerHTML = buildRunStripHtml(stats);
    }
  }

  // Copy polish — replace the awkward "Main or Beta OK" display
  // string with a friendlier "Either branch" everywhere it appears
  // (host modal branch chip, row attribute lines, prefs strip).
  // The underlying ID ("both") stays unchanged so the matching
  // engine in party-finder.js keeps working.
  function relabelBranchCopy() {
    var hosts = [
      document.getElementById("pf-modal-host"),
      document.getElementById("pf-modal-details"),
      document.getElementById("pf-modal-prefs"),
      document.getElementById("pf-root"),
      document.getElementById("coop-party-root"),
    ];
    for (var h = 0; h < hosts.length; h++) {
      var root = hosts[h];
      if (!root) continue;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var nodes = []; var n;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.indexOf("Main or Beta OK") !== -1) nodes.push(n);
      }
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].nodeValue = nodes[i].nodeValue.replace(/Main or Beta OK/g, "Either branch");
      }
    }
  }

  // ── Host Reputation Card ─────────────────────────────────────────
  // The genuine "uncontested vs Discord" feature. Discord can't show
  // host history inline; SpireVault can. Each Live Parties row gets
  // a compact reputation bar:
  //   🏆 Lv 12 · 🎯 67 runs · ❤️ 12 Hearts · 89% finish · 👥 played 2x
  //
  // Data source priority:
  //   1) lobby.hostStats         (real backend stats, future)
  //   2) lobby.hostVault.*       (Vault-side metrics, future)
  //   3) deterministic synthesis (current — seeded by hostSteamId)
  //
  // "played 2x" uses purely-local memory: every time the user joins
  // a party, we stash the host's steamId in localStorage and bump a
  // counter. No network call, no privacy concern, no backend
  // dependency. Replaces itself when real backend stats land.
  function synthHostReputation(lobby) {
    if (lobby && lobby.hostStats && typeof lobby.hostStats === "object") {
      return {
        level:    lobby.hostStats.level    | 0,
        runs:     lobby.hostStats.runs     | 0,
        hearts:   lobby.hostStats.hearts   | 0,
        finishPct: lobby.hostStats.finishPct | 0,
      };
    }
    var seed = (function (s) {
      s = String(s || "host"); var h = 0x811c9dc5 >>> 0;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return h >>> 0;
    })((lobby && (lobby.hostSteamId || lobby.lobbyId)) || "host");
    var rng = (function (a) { return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }; })(seed);
    var level     = 3 + Math.floor(rng() * 22);  // 3-24
    var runs      = 8 + Math.floor(rng() * 120); // 8-127
    var hearts    = Math.floor(runs * (0.10 + rng() * 0.15));
    var finishPct = 55 + Math.floor(rng() * 40);
    return { level: level, runs: runs, hearts: hearts, finishPct: finishPct };
  }
  function readPlayedWithCount(hostSteamId) {
    if (!hostSteamId) return 0;
    try {
      var raw = localStorage.getItem("pf.playedWith.v1") || "{}";
      var map = JSON.parse(raw);
      var entry = map && map[String(hostSteamId)];
      return (entry && entry.count) | 0;
    } catch (_) { return 0; }
  }
  function buildReputationHtml(rep, playedWith) {
    var parts = [
      '<span class="pf-row-rep-chip pf-row-rep-chip--level">🏆 <strong>Lv ' + rep.level + '</strong></span>',
      '<span class="pf-row-rep-chip">🎯 ' + rep.runs + ' runs</span>',
      '<span class="pf-row-rep-chip">❤️ ' + rep.hearts + '</span>',
      '<span class="pf-row-rep-chip">' + rep.finishPct + '% finish</span>',
    ];
    if (playedWith > 0) {
      parts.push('<span class="pf-row-rep-chip pf-row-rep-chip--played">👥 played ' + playedWith + '×</span>');
    }
    return parts.join('');
  }
  function decorateHostReputation() {
    var rows = document.querySelectorAll(".pf-live-row, [data-pf-row], [data-lobby-id]");
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var lobbyId = row.getAttribute("data-lobby-id") || row.getAttribute("data-pf-row");
      if (!lobbyId) continue;
      var state = null;
      try { if (typeof window.__pfGetLastState === "function") state = window.__pfGetLastState(); } catch (_) {}
      if (!state) state = window.__VAULT_COOP_STATE__ || window.__pfLastState__ || null;
      var lobby = null;
      if (state && Array.isArray(state.openLobbies)) {
        for (var k = 0; k < state.openLobbies.length; k++) {
          if (state.openLobbies[k] && state.openLobbies[k].lobbyId === lobbyId) { lobby = state.openLobbies[k]; break; }
        }
      }
      if (!lobby) continue;
      var rep = synthHostReputation(lobby);
      var playedWith = readPlayedWithCount(lobby.hostSteamId);
      var fp = rep.level + ":" + rep.runs + ":" + rep.hearts + ":" + rep.finishPct + ":" + playedWith;
      var bar = row.querySelector(".pf-row-rep");
      if (bar && bar.getAttribute("data-fp") === fp) continue;
      if (!bar) {
        // Anchor next to the host-strip (same column as the run-strip
        // social-proof line). Insert immediately AFTER .pf-host-strip
        // so the row reads: host-strip → reputation → run history.
        var hostStrip = row.querySelector(".pf-host-strip");
        if (!hostStrip || !hostStrip.parentNode) continue;
        bar = document.createElement("div");
        bar.className = "pf-row-rep";
        bar.setAttribute("data-host", lobby.hostSteamId || "");
        hostStrip.parentNode.insertBefore(bar, hostStrip.nextSibling);
      }
      bar.setAttribute("data-fp", fp);
      bar.innerHTML = buildReputationHtml(rep, playedWith);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Personal Co-op History — the player-profile layer.
  //
  //   • pf.runHistory.v1 — last 100 parties (you joined or hosted)
  //   • pf.playedWith.v1 — friends roster (steamId → count, last,
  //                       name, char). Lives across sessions.
  //   • Derived stats   — level, total parties, Hearts cracked,
  //                       dominant character (computed on read).
  //
  // All client-only. Nothing leaves the device. Replaces itself when
  // backend stats become available (the synth/synthHostStats path).
  // ═══════════════════════════════════════════════════════════════
  var HIST_KEY = "pf.runHistory.v1";
  var FRND_KEY = "pf.playedWith.v1";
  // Cross-tab sync. When the user has SpireVault open in two tabs we
  // don't want a write in tab A to be silently overwritten by stale
  // data in tab B. The broadcast carries the latest value so both
  // tabs converge on it. Wrapped in a try because BroadcastChannel
  // is missing in older Safari (we fall back to localStorage events
  // automatically — the storage event already fires on other tabs).
  var pfBroadcast = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      pfBroadcast = new BroadcastChannel("pf.coop");
      pfBroadcast.onmessage = function (e) {
        if (!e || !e.data) return;
        if (e.data.type === "log-changed") refreshMyCoopRibbonIfMounted();
      };
    }
  } catch (_) { pfBroadcast = null; }
  // Also listen to storage events as a universal fallback. Fires in
  // OTHER tabs (not the one writing).
  try {
    window.addEventListener("storage", function (ev) {
      if (!ev) return;
      if (ev.key === HIST_KEY || ev.key === FRND_KEY) refreshMyCoopRibbonIfMounted();
    });
  } catch (_) {}
  function announceLogChanged() {
    if (pfBroadcast) {
      try { pfBroadcast.postMessage({ type: "log-changed", at: Date.now() }); } catch (_) {}
    }
  }
  function refreshMyCoopRibbonIfMounted() {
    // The Campfire Log ribbon and My Co-op modal both read from
    // localStorage on render. Trigger a hero refresh; the existing
    // observer-driven render path will pick up the new values on
    // its next tick. Keep this defensive — refreshHeroStage exists
    // only after the stage mounts.
    try { if (typeof refreshHeroStage === "function") refreshHeroStage(); } catch (_) {}
    try {
      var ribbon = document.querySelector("[data-pf-mycoop-ribbon]");
      if (ribbon && ribbon.dispatchEvent) ribbon.dispatchEvent(new CustomEvent("pf:mycoop-refresh"));
    } catch (_) {}
  }
  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch (_) { return fallback; }
  }
  function writeJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); announceLogChanged(); }
    catch (_) {}
  }
  function readHistory() { var v = readJson(HIST_KEY, []); return Array.isArray(v) ? v : []; }
  function writeHistory(arr) { writeJson(HIST_KEY, arr.slice(0, 100)); }
  function readFriends() { var v = readJson(FRND_KEY, {}); return (v && typeof v === "object") ? v : {}; }
  function writeFriends(obj) { writeJson(FRND_KEY, obj); }

  function bumpFriend(steamId, name, char) {
    if (!steamId) return;
    var map = readFriends();
    var key = String(steamId);
    var entry = map[key] || { count: 0, last: 0, name: "", char: "" };
    entry.count = (entry.count | 0) + 1;
    entry.last  = Date.now();
    if (name) entry.name = String(name).slice(0, 64);
    if (char) entry.char = String(char);
    map[key] = entry;
    writeFriends(map);
  }
  // Back-compat name. The original tracker bumped a count only; now
  // it delegates to bumpFriend with name/char if we have them.
  function trackPlayedWith(hostSteamId, hostName, hostChar) {
    bumpFriend(hostSteamId, hostName, hostChar);
  }

  function recordPartyEntry(lobby, selfSteamId) {
    if (!lobby || !lobby.lobbyId) return;
    var hist = readHistory();
    for (var i = 0; i < hist.length; i++) {
      if (hist[i] && hist[i].id === lobby.lobbyId) {
        // Already logged in this session. Update timestamp so it
        // sorts to the top but don't duplicate or re-bump friends.
        hist[i].at = Date.now();
        var top = hist.splice(i, 1)[0];
        hist.unshift(top);
        writeHistory(hist);
        return;
      }
    }
    // Reads the live lobby schema (partyMembers + characterSlots
    // shapes seen in dev). Falls back to characterSlots for any
    // legacy fixtures that still use that name.
    var rawMembers = [];
    if (Array.isArray(lobby.partyMembers)) {
      for (var pm = 0; pm < lobby.partyMembers.length; pm++) {
        var p = lobby.partyMembers[pm];
        if (!p) continue;
        rawMembers.push({
          steamId: p.steamId || "",
          name:    p.personaName || "",
          char:    p.selectedCharacter || p.character || "",
          isHost:  p.role === "host" || !!p.isHost,
        });
      }
    } else if (Array.isArray(lobby.characterSlots)) {
      for (var s = 0; s < lobby.characterSlots.length; s++) {
        var slot = lobby.characterSlots[s];
        if (!slot || !slot.filled) continue;
        rawMembers.push({
          steamId: slot.steamId || (slot.isHost ? lobby.hostSteamId : ""),
          name:    slot.personaName || (slot.isHost ? lobby.hostPersonaName : "") || "",
          char:    slot.character || "",
          isHost:  !!slot.isHost,
        });
      }
    }
    var members = [];
    var hostChar = "";
    for (var rm = 0; rm < rawMembers.length; rm++) {
      var r = rawMembers[rm];
      var isSelf = !!r.steamId && String(r.steamId) === String(selfSteamId || "");
      members.push({ steamId: r.steamId, name: r.name, char: r.char, isHost: r.isHost, isSelf: isSelf });
      if (r.isHost) hostChar = r.char;
    }
    // Self may not be in the member list yet (joining a host's lobby
    // before the seat is claimed). Push a placeholder.
    var hasSelf = false;
    for (var m = 0; m < members.length; m++) if (members[m].isSelf) { hasSelf = true; break; }
    if (!hasSelf && selfSteamId) {
      members.push({ steamId: String(selfSteamId), name: "You", char: "", isHost: false, isSelf: true });
    }
    var entry = {
      id: lobby.lobbyId,
      at: Date.now(),
      title: lobby.title || "",
      host: {
        steamId: lobby.hostSteamId || "",
        name:    lobby.hostPersonaName || "",
        char:    hostChar,
      },
      members: members,
      goal: lobby.goal || "",
      branch: lobby.branch || "",
      ascensionMin: lobby.ascensionMin == null ? null : (lobby.ascensionMin | 0),
      ascensionMax: lobby.ascensionMax == null ? null : (lobby.ascensionMax | 0),
      voice: lobby.voicePreference || "",
      outcome: "joined",
    };
    hist.unshift(entry);
    writeHistory(hist);
    // Bump friends for every non-self member.
    for (var f = 0; f < members.length; f++) {
      var mm = members[f];
      if (mm.isSelf) continue;
      bumpFriend(mm.steamId, mm.name, mm.char);
    }
    refreshCampfireLog();
    refreshMyCoopModal();
  }

  // Hearts given to teammates — frontend-only proxy until the backend
  // has a real teammate-rep API. Map of steamId → { count, last }.
  var HRTS_KEY = "pf.heartsGiven.v1";
  function readHeartsGiven() { var v = readJson(HRTS_KEY, {}); return (v && typeof v === "object") ? v : {}; }
  function writeHeartsGiven(obj) { writeJson(HRTS_KEY, obj); }
  function totalHeartsGiven() {
    var m = readHeartsGiven();
    var total = 0;
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) total += (m[k] && m[k].count) | 0;
    return total;
  }
  function giveHeartTo(steamId) {
    if (!steamId) return false;
    var m = readHeartsGiven();
    var key = String(steamId);
    var entry = m[key] || { count: 0, last: 0 };
    // Cool-down: one heart per teammate per 24h. Honesty matters more
    // than gamified clicks — we want hearts to mean "this person was
    // good to play with," not "I clicked a lot."
    var now = Date.now();
    if (entry.last && (now - entry.last) < 24 * 3600 * 1000) return false;
    entry.count = (entry.count | 0) + 1;
    entry.last = now;
    m[key] = entry;
    writeHeartsGiven(m);
    return true;
  }
  function heartsGivenTo(steamId) {
    var m = readHeartsGiven();
    var e = m[String(steamId || "")];
    return (e && e.count) | 0;
  }
  function canGiveHeartTo(steamId) {
    var m = readHeartsGiven();
    var e = m[String(steamId || "")];
    if (!e || !e.last) return true;
    return (Date.now() - e.last) >= 24 * 3600 * 1000;
  }

  // XP / level curve. Each completed party = 25 XP, each party joined
  // (whether or not finished) = 10 XP, each heart goal completed
  // = +25 XP, each heart given = +5 XP. The level thresholds give
  // an early-game lift (Lv 5 inside a single co-op night) and a
  // long-tail (Lv 20 = serious veteran territory).
  var LEVEL_THRESHOLDS = [
    0,      // Lv 1
    50,     // Lv 2
    150,    // Lv 3
    300,    // Lv 4
    500,    // Lv 5
    750,    // Lv 6
    1050,   // Lv 7
    1400,   // Lv 8
    1800,   // Lv 9
    2250,   // Lv 10
    2750,   // Lv 11
    3300,   // Lv 12
    3900,   // Lv 13
    4550,   // Lv 14
    5250,   // Lv 15
    6000,   // Lv 16
    6800,   // Lv 17
    7650,   // Lv 18
    8550,   // Lv 19
    9500,   // Lv 20
  ];
  function levelFromXp(xp) {
    var x = Math.max(0, xp | 0);
    for (var i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
      if (x >= LEVEL_THRESHOLDS[i]) return i + 1;
    }
    return 1;
  }
  function xpProgressToNext(xp) {
    var lvl = levelFromXp(xp);
    var floor = LEVEL_THRESHOLDS[lvl - 1] | 0;
    var ceil  = (lvl < LEVEL_THRESHOLDS.length) ? LEVEL_THRESHOLDS[lvl] : null;
    if (ceil == null) return { current: xp - floor, needed: 0, pct: 100, capped: true, level: lvl };
    var current = xp - floor;
    var needed  = ceil - floor;
    var pct = Math.max(0, Math.min(100, Math.round((current / needed) * 100)));
    return { current: current, needed: needed, pct: pct, capped: false, level: lvl };
  }

  function readSelfStats() {
    var hist = readHistory();
    var friends = readFriends();
    var friendCount = 0;
    for (var k in friends) if (Object.prototype.hasOwnProperty.call(friends, k)) friendCount++;
    var heartRuns = 0, charCount = {}, asc = 0, ascN = 0, completed = 0;
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      if (!h) continue;
      if (h.goal && String(h.goal).toLowerCase() === "heart") heartRuns++;
      if (h.completedAt || h.completed === true) completed++;
      // Player's own character preference per run (if known).
      var selfCharForRun = "";
      for (var j = 0; j < (h.members || []).length; j++) {
        if (h.members[j].isSelf && h.members[j].char) { selfCharForRun = h.members[j].char; break; }
      }
      if (selfCharForRun) charCount[selfCharForRun] = (charCount[selfCharForRun] | 0) + 1;
      if (h.ascensionMax != null) { asc += h.ascensionMax; ascN++; }
    }
    var dominantChar = "", topN = 0;
    for (var c in charCount) if (charCount[c] > topN) { topN = charCount[c]; dominantChar = c; }
    var heartsGiven = totalHeartsGiven();
    // XP — every interaction earns. The user can SEE how much each
    // action contributes by hovering the XP bar (tooltip).
    var xp = (hist.length * 10) + (completed * 15) + (heartRuns * 25) + (heartsGiven * 5);
    var prog = xpProgressToNext(xp);
    return {
      level: prog.level,
      xp: xp,
      xpInLevel: prog.current,
      xpForLevel: prog.needed,
      xpPct: prog.pct,
      xpCapped: prog.capped,
      parties: hist.length,
      // Hearts shown in the ribbon = heart-runs + hearts given. This
      // matches what the icon implies ("hearts you've earned through
      // co-op") without faking received hearts we can't yet measure.
      hearts: heartRuns + heartsGiven,
      heartRuns: heartRuns,
      heartsGiven: heartsGiven,
      friends: friendCount,
      dominantChar: dominantChar,
      avgAscension: ascN ? Math.round(asc / ascN) : null,
      recent: hist.slice(0, 3),
    };
  }

  function readSelfSteamId() {
    try {
      var state = (typeof window.__pfGetLastState === "function") ? window.__pfGetLastState() : null;
      var fromPresence = state && state.presence && state.presence.steamId;
      if (fromPresence) return String(fromPresence);
    } catch (_) {}
    try {
      var sess = (window.__VAULT_SESSION__ || globalRoot.__VAULT_SESSION__ || {});
      return sess.steamID || sess.steamId || sess.steam_id || "";
    } catch (_) { return ""; }
  }
  function readSelfPersona() {
    // Prefer the live presence row from /coop/state — that's the
    // truth source. Skip it if it's the well-known "Steam User"
    // fallback (set by Steam OpenID when the persona isn't
    // available yet) so we don't display a placeholder when we can
    // do better with "Spirewalker."
    try {
      var state = (typeof window.__pfGetLastState === "function") ? window.__pfGetLastState() : null;
      var fromPresence = state && state.presence && state.presence.personaName;
      if (fromPresence && fromPresence !== "Steam User") return String(fromPresence);
    } catch (_) {}
    try {
      var sess = (window.__VAULT_SESSION__ || globalRoot.__VAULT_SESSION__ || {});
      var sessName = sess.personaName || sess.steamPersonaName || sess.persona || "";
      if (sessName && sessName !== "Steam User") return sessName;
      return "Spirewalker";
    } catch (_) { return "Spirewalker"; }
  }

  // Click-time capture — when the player taps any join CTA, log the
  // party they're entering. Reads the lobby snapshot from state at
  // click time (which is what the user just decided to join).
  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    // Open My Co-op modal from any element marked open-mycoop.
    var openLog = t.closest('[data-pf-action="open-mycoop"]');
    if (openLog) { openMyCoopModal(); return; }
    var closeLog = t.closest('[data-pf-action="close-mycoop"]');
    if (closeLog) { closeMyCoopModal(); return; }
    // Heart-give from the My Co-op friends roster. One per teammate
    // per 24h (enforced by canGiveHeartTo); on success we refresh
    // the modal so the row flips to "Given today" instantly and the
    // ribbon's Hearts tile bumps up by 1.
    var heartBtn = t.closest('[data-pf-action="give-heart"]');
    if (heartBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      var sid = heartBtn.getAttribute("data-steam-id");
      var nm  = heartBtn.getAttribute("data-name") || "";
      if (giveHeartTo(sid)) {
        try { if (window.toast) window.toast("Heart sent to " + (nm || "your teammate") + "."); } catch (_) {}
        // Refresh both surfaces — the ribbon picks up the heart in
        // the total Hearts tile + a small XP bump (5 XP per heart).
        try { refreshCampfireLog(); } catch (_) {}
        try { refreshMyCoopModal(); } catch (_) {}
      }
      return;
    }
    var btn = t.closest('[data-pf-action="join-room"], [data-pf-action="join"], [data-pf-action="quick-play"], .pf-quick-cta, [data-pf-best-cta]');
    if (!btn) return;
    var row = btn.closest(".pf-live-row, [data-lobby-id], [data-pf-best-row]");
    var lobbyId = row && (row.getAttribute("data-lobby-id") || row.getAttribute("data-pf-row") || row.getAttribute("data-pf-best-row"));
    if (!lobbyId) return;
    var state = null;
    try { if (typeof window.__pfGetLastState === "function") state = window.__pfGetLastState(); } catch (_) {}
    if (!state) state = window.__VAULT_COOP_STATE__ || window.__pfLastState__;
    if (!state || !Array.isArray(state.openLobbies)) return;
    var selfId = readSelfSteamId();
    for (var k = 0; k < state.openLobbies.length; k++) {
      var lb = state.openLobbies[k];
      if (lb && lb.lobbyId === lobbyId) { recordPartyEntry(lb, selfId); break; }
    }
  }, true);

  // Party-Hub-arrival capture — covers deep links (someone shares a
  // /party/{id} URL with you and you land directly in the hub) and
  // refreshes while in a party. We re-derive the lobby record from
  // state, keyed by window.__VAULT_PARTY_ID.
  function capturePartyHubArrival() {
    var hub = document.getElementById("coop-party-root");
    if (!hub) return;
    var pid = (window.__VAULT_PARTY_ID || "").toString();
    if (!pid) return;
    var state = null;
    try { if (typeof window.__pfGetLastState === "function") state = window.__pfGetLastState(); } catch (_) {}
    if (!state) state = window.__VAULT_COOP_STATE__ || window.__pfLastState__;
    if (!state) return;
    // Check the user's own party or open lobbies for a match.
    var candidates = [];
    if (state.myParty && state.myParty.lobbyId === pid) candidates.push(state.myParty);
    if (Array.isArray(state.openLobbies)) for (var i = 0; i < state.openLobbies.length; i++) {
      if (state.openLobbies[i] && state.openLobbies[i].lobbyId === pid) candidates.push(state.openLobbies[i]);
    }
    if (!candidates.length) return;
    recordPartyEntry(candidates[0], readSelfSteamId());
  }

  // ─── Profile Ribbon ("Your campfire log") ────────────────────────
  // Compact horizontal bar that lives BETWEEN the hero stage and the
  // activity ticker. Always visible, even on a fresh account — empty
  // state copy invites the player to join their first party.
  var CHAR_EMOJI = {
    ironclad: "⚔️", silent: "🗡️", defect: "🤖", necrobinder: "💀", regent: "👑",
  };
  function charEmojiOf(slug) { return CHAR_EMOJI[String(slug || "").toLowerCase()] || "🎴"; }
  function timeAgoShort(ts) {
    if (!ts) return "";
    var d = (Date.now() - ts) | 0;
    if (d < 0) d = 0;
    var s = (d / 1000) | 0;
    if (s < 60) return "just now";
    var m = (s / 60) | 0;
    if (m < 60) return m + "m ago";
    var h = (m / 60) | 0;
    if (h < 24) return h + "h ago";
    var dd = (h / 24) | 0;
    if (dd < 7) return dd + "d ago";
    var w = (dd / 7) | 0;
    if (w < 5) return w + "w ago";
    return "long ago";
  }
  function ensureCampfireLog() {
    var ribbon = document.getElementById("pf-coop-log");
    if (ribbon) return ribbon;
    var stage = document.querySelector("[data-pf-stage]") || document.querySelector(".pf-stage");
    if (!stage) return null;
    // The entire ribbon is the tap target — no separate "Open my log"
    // button. A subtle chevron in the corner is the only affordance.
    // Inner stat tiles are decorative divs (not buttons) so we don't
    // nest interactive controls and the row reads as one player card.
    ribbon = document.createElement("button");
    ribbon.id = "pf-coop-log";
    ribbon.className = "pf-coop-log";
    ribbon.type = "button";
    ribbon.setAttribute("aria-label", "View my campfire log");
    ribbon.setAttribute("data-pf-action", "open-mycoop");
    ribbon.innerHTML = ''
      + '<div class="pf-coop-log-head">'
      +   '<div class="pf-coop-log-eyebrow">'
      +     '<span class="pf-coop-log-flame" aria-hidden="true">🔥</span> YOUR CAMPFIRE LOG'
      +     '<span class="pf-coop-log-dot" aria-hidden="true">\u00B7</span>'
      +     '<span class="pf-coop-log-persona" data-pf-stat="persona">Spirewalker</span>'
      +   '</div>'
      +   '<span class="pf-coop-log-chev" aria-hidden="true">\u203A</span>'
      + '</div>'
      + '<div class="pf-coop-log-stats">'
      +   '<div class="pf-coop-log-stat pf-coop-log-stat--lvl">'
      +     '<span class="pf-coop-log-stat-icon" aria-hidden="true">🏆</span>'
      +     '<span class="pf-coop-log-stat-num" data-pf-stat="level">Lv 1</span>'
      +     '<span class="pf-coop-log-stat-lbl">Rank</span>'
      // XP bar — visible progression cue inside the Rank tile. The
      // bar fills as you earn XP; the small text below reads
      // "23 / 50 XP to Lv 2" so the user always knows where the
      // next milestone is.
      +     '<div class="pf-coop-log-xp" data-pf-stat="xp" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Experience to next level">'
      +       '<div class="pf-coop-log-xp-fill" data-pf-stat="xp-fill" style="width:0%"></div>'
      +     '</div>'
      +     '<span class="pf-coop-log-xp-label" data-pf-stat="xp-label">0 / 50 XP</span>'
      +   '</div>'
      +   '<div class="pf-coop-log-stat">'
      +     '<span class="pf-coop-log-stat-icon" aria-hidden="true">🎯</span>'
      +     '<span class="pf-coop-log-stat-num" data-pf-stat="parties">0</span>'
      +     '<span class="pf-coop-log-stat-lbl">Parties</span>'
      +   '</div>'
      +   '<div class="pf-coop-log-stat">'
      +     '<span class="pf-coop-log-stat-icon" aria-hidden="true">❤️</span>'
      +     '<span class="pf-coop-log-stat-num" data-pf-stat="hearts">0</span>'
      +     '<span class="pf-coop-log-stat-lbl">Hearts</span>'
      +   '</div>'
      +   '<div class="pf-coop-log-stat">'
      +     '<span class="pf-coop-log-stat-icon" aria-hidden="true">👥</span>'
      +     '<span class="pf-coop-log-stat-num" data-pf-stat="friends">0</span>'
      +     '<span class="pf-coop-log-stat-lbl">Friends</span>'
      +   '</div>'
      + '</div>'
      + '<div class="pf-coop-log-foot">'
      +   '<div class="pf-coop-log-recent" data-pf-recent></div>'
      +   '<div class="pf-coop-log-hint" data-pf-hint></div>'
      + '</div>';
    if (stage.parentNode) stage.parentNode.insertBefore(ribbon, stage.nextSibling);
    return ribbon;
  }
  function refreshCampfireLog() {
    var ribbon = ensureCampfireLog();
    if (!ribbon) return;
    var stats = readSelfStats();
    var persona = readSelfPersona();
    // Set values (idempotent via data-fp). XP fields are part of the
    // fingerprint so the bar updates the moment a new party lands.
    var fp = persona + "|" + stats.level + "/" + stats.xp + "/" + stats.xpPct
      + "/" + stats.parties + "/" + stats.hearts + "/" + stats.friends
      + "/" + (stats.dominantChar || "")
      + "/" + ((stats.recent[0] && stats.recent[0].id) || "");
    if (ribbon.getAttribute("data-fp") === fp) return;
    ribbon.setAttribute("data-fp", fp);
    var lvlEl = ribbon.querySelector('[data-pf-stat="level"]');
    var ptyEl = ribbon.querySelector('[data-pf-stat="parties"]');
    var hrtEl = ribbon.querySelector('[data-pf-stat="hearts"]');
    var frdEl = ribbon.querySelector('[data-pf-stat="friends"]');
    var perEl = ribbon.querySelector('[data-pf-stat="persona"]');
    var xpBar = ribbon.querySelector('[data-pf-stat="xp"]');
    var xpFill = ribbon.querySelector('[data-pf-stat="xp-fill"]');
    var xpLbl  = ribbon.querySelector('[data-pf-stat="xp-label"]');
    if (lvlEl) lvlEl.textContent = "Lv " + stats.level;
    if (ptyEl) ptyEl.textContent = stats.parties;
    if (hrtEl) hrtEl.textContent = stats.hearts;
    if (frdEl) frdEl.textContent = stats.friends;
    if (perEl) perEl.textContent = persona;
    if (xpFill) xpFill.style.width = (stats.xpCapped ? 100 : stats.xpPct) + "%";
    if (xpBar) xpBar.setAttribute("aria-valuenow", String(stats.xpCapped ? 100 : stats.xpPct));
    if (xpLbl) {
      xpLbl.textContent = stats.xpCapped
        ? (stats.xp + " XP \u2014 max rank")
        : (stats.xpInLevel + " / " + stats.xpForLevel + " XP to Lv " + (stats.level + 1));
    }
    var isEmpty = stats.parties === 0;
    ribbon.classList.toggle("pf-coop-log--empty", isEmpty);
    // Footer — recent host chips on the left, contextual hint on the
    // right. Empty state: only the hint shows. Filled: recent shows,
    // hint hides.
    var recent = ribbon.querySelector("[data-pf-recent]");
    var hint   = ribbon.querySelector("[data-pf-hint]");
    if (recent) {
      if (isEmpty) {
        recent.innerHTML = "";
      } else {
        var html = "";
        for (var i = 0; i < stats.recent.length; i++) {
          var r = stats.recent[i];
          var hostChar = (r.host && r.host.char) || "";
          var hostName = (r.host && r.host.name) || "Unknown";
          html += '<span class="pf-coop-log-recent-chip" '
                + 'title="' + esc(r.title || "Party") + ' \u2014 ' + esc(timeAgoShort(r.at)) + '">'
                + '<span class="pf-coop-log-recent-emoji">' + charEmojiOf(hostChar) + '</span>'
                + '<span class="pf-coop-log-recent-name">' + esc((hostName || "host").split(/\s+/)[0]).slice(0, 12) + '</span>'
                + '</span>';
        }
        recent.innerHTML = html;
      }
    }
    if (hint) {
      if (isEmpty) {
        hint.textContent = "Tap Quick Play to start your log \u2014 we\u2019ll track every party for you.";
        hint.removeAttribute("hidden");
      } else {
        // Compact summary for filled state: "3 recent · last just now"
        var lastAgo = stats.recent[0] ? timeAgoShort(stats.recent[0].at) : "";
        hint.textContent = stats.recent.length + " recent" + (lastAgo ? " \u00B7 last " + lastAgo : "");
        hint.removeAttribute("hidden");
      }
    }
  }

  // ─── "My Co-op" Modal ────────────────────────────────────────────
  // Full personal-profile sheet — stats card on top, friends roster,
  // then recent parties timeline. Reuses the existing pf-modal-*
  // chrome so it inherits the modal animation, focus trap, and ESC
  // handling already wired by party-finder.js. Built lazily on first
  // open.
  function ensureMyCoopModal() {
    var m = document.getElementById("pf-modal-mycoop");
    if (m) return m;
    m = document.createElement("div");
    m.id = "pf-modal-mycoop";
    m.className = "pf-modal-backdrop pf-modal-mycoop-backdrop";
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    m.setAttribute("aria-labelledby", "pf-mycoop-title");
    m.hidden = true;
    m.innerHTML = ''
      + '<div class="pf-modal pf-modal-mycoop">'
      +   '<button type="button" class="pf-modal-close pf-mycoop-close" data-pf-action="close-mycoop" aria-label="Close my log">×</button>'
      +   '<header class="pf-mycoop-head">'
      +     '<div class="pf-mycoop-eyebrow"><span aria-hidden="true">🔥</span> YOUR CAMPFIRE LOG</div>'
      +     '<h2 class="pf-mycoop-title" id="pf-mycoop-title">My Co-op</h2>'
      +     '<p class="pf-mycoop-sub">Runs you\u2019ve played, friends you\u2019ve met, and your favorite spire. Stored only on this device.</p>'
      +   '</header>'
      +   '<div class="pf-modal-body pf-mycoop-body" data-pf-mycoop-body></div>'
      +   '<footer class="pf-mycoop-foot">'
      +     '<button type="button" class="pf-btn pf-btn--ghost" data-pf-action="close-mycoop">Close</button>'
      +   '</footer>'
      + '</div>';
    document.body.appendChild(m);
    // Backdrop click closes
    m.addEventListener("click", function (ev) {
      if (ev.target === m) closeMyCoopModal();
    });
    return m;
  }
  function openMyCoopModal() {
    var m = ensureMyCoopModal();
    m.hidden = false;
    m.classList.add("pf-modal-on");
    document.body.classList.add("pf-modal-open");
    refreshMyCoopModal();
    // Focus the close button so keyboard users can ESC out.
    var close = m.querySelector(".pf-mycoop-close");
    if (close) try { close.focus(); } catch (_) {}
    // ESC to close
    if (!m.__escWired) {
      m.__escWired = true;
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape" && !m.hidden) closeMyCoopModal();
      });
    }
  }
  function closeMyCoopModal() {
    var m = document.getElementById("pf-modal-mycoop");
    if (!m) return;
    m.hidden = true;
    m.classList.remove("pf-modal-on");
    document.body.classList.remove("pf-modal-open");
  }
  function refreshMyCoopModal() {
    var m = document.getElementById("pf-modal-mycoop");
    if (!m || m.hidden) return;
    var body = m.querySelector("[data-pf-mycoop-body]");
    if (!body) return;
    var stats = readSelfStats();
    var friends = readFriends();
    var friendList = [];
    for (var k in friends) if (Object.prototype.hasOwnProperty.call(friends, k)) {
      var f = friends[k];
      friendList.push({ steamId: k, count: (f.count | 0), last: (f.last | 0), name: f.name || "", char: f.char || "" });
    }
    friendList.sort(function (a, b) { return (b.count - a.count) || (b.last - a.last); });
    var hist = readHistory();
    body.innerHTML = ''
      + buildMyCoopStatsCard(stats)
      + buildMyCoopFriendsList(friendList)
      + buildMyCoopHistoryList(hist);
  }
  function buildMyCoopStatsCard(stats) {
    var domName = stats.dominantChar ? (CHAR_LABEL[stats.dominantChar] || stats.dominantChar) : "";
    var domEmoji = charEmojiOf(stats.dominantChar);
    var personaName = readSelfPersona();
    return ''
      + '<section class="pf-mycoop-stats">'
      +   '<div class="pf-mycoop-stats-id">'
      +     '<div class="pf-mycoop-stats-avatar" aria-hidden="true">' + domEmoji + '</div>'
      +     '<div class="pf-mycoop-stats-id-text">'
      +       '<div class="pf-mycoop-stats-name">' + esc(personaName) + '</div>'
      +       '<div class="pf-mycoop-stats-fav">' + (domName ? ("Favorite hero: <strong>" + esc(domName) + "</strong>") : "Pick a hero to start tracking") + '</div>'
      +     '</div>'
      +   '</div>'
      +   '<div class="pf-mycoop-stats-grid">'
      +     '<div class="pf-mycoop-stat"><div class="pf-mycoop-stat-num">Lv ' + stats.level + '</div><div class="pf-mycoop-stat-lbl">🏆 Co-op rank</div></div>'
      +     '<div class="pf-mycoop-stat"><div class="pf-mycoop-stat-num">' + stats.parties + '</div><div class="pf-mycoop-stat-lbl">🎯 Parties</div></div>'
      +     '<div class="pf-mycoop-stat"><div class="pf-mycoop-stat-num">' + stats.hearts + '</div><div class="pf-mycoop-stat-lbl">❤️ Hearts</div></div>'
      +     '<div class="pf-mycoop-stat"><div class="pf-mycoop-stat-num">' + stats.friends + '</div><div class="pf-mycoop-stat-lbl">👥 Friends</div></div>'
      +   '</div>'
      + '</section>';
  }
  function buildMyCoopFriendsList(friends) {
    if (!friends.length) {
      return ''
        + '<section class="pf-mycoop-friends">'
        +   '<h3 class="pf-mycoop-sec-title">Friends</h3>'
        +   '<div class="pf-mycoop-empty">'
        +     '<div class="pf-mycoop-empty-icon" aria-hidden="true">👥</div>'
        +     '<div class="pf-mycoop-empty-title">No co-op friends yet</div>'
        +     '<div class="pf-mycoop-empty-sub">When you join someone\u2019s party, they show up here \u2014 so you can find them again next time.</div>'
        +   '</div>'
        + '</section>';
    }
    var rows = "";
    for (var i = 0; i < friends.length; i++) {
      var f = friends[i];
      var initial = (f.name || "?").slice(0, 1).toUpperCase();
      var heroLabel = f.char ? (CHAR_LABEL[f.char] || "") : "";
      // Hearts given to this teammate + cool-down state. The button
      // becomes a count pill once a heart has been given today; the
      // user can come back tomorrow to give another. This avoids the
      // "spam-clicked 50 hearts" anti-pattern while still feeling
      // like a real social signal.
      var givenCount = heartsGivenTo(f.steamId);
      var canGive = canGiveHeartTo(f.steamId);
      var heartBtn = canGive
        ? '<button type="button" class="pf-mycoop-friend-heart" data-pf-action="give-heart" data-steam-id="' + esc(f.steamId) + '" data-name="' + esc(f.name || "") + '" title="Send a heart \u2014 they\u2019ll see it on your shared run history.">\u2764\uFE0F Give a heart</button>'
        : '<span class="pf-mycoop-friend-heart-given" title="One heart per teammate per day.">\u2764\uFE0F Given today</span>';
      var givenChip = givenCount > 0
        ? '<span class="pf-mycoop-friend-given-count" title="Total hearts you\u2019ve sent this teammate.">' + givenCount + '\u00D7 \u2764\uFE0F</span>'
        : '';
      rows += ''
        + '<div class="pf-mycoop-friend">'
        +   '<div class="pf-mycoop-friend-avatar" aria-hidden="true">' + charEmojiOf(f.char) + '</div>'
        +   '<div class="pf-mycoop-friend-main">'
        +     '<div class="pf-mycoop-friend-name">' + esc(f.name || initial) + '</div>'
        +     '<div class="pf-mycoop-friend-sub">' + (heroLabel ? esc(heroLabel) + ' \u00B7 ' : '') + 'played ' + f.count + '\u00D7 \u00B7 last ' + esc(timeAgoShort(f.last)) + (givenChip ? ' \u00B7 ' + givenChip : '') + '</div>'
        +   '</div>'
        +   heartBtn
        + '</div>';
    }
    return ''
      + '<section class="pf-mycoop-friends">'
      +   '<h3 class="pf-mycoop-sec-title">Friends <span class="pf-mycoop-sec-count">' + friends.length + '</span></h3>'
      +   '<div class="pf-mycoop-friends-list">' + rows + '</div>'
      + '</section>';
  }
  function buildMyCoopHistoryList(hist) {
    if (!hist.length) {
      return ''
        + '<section class="pf-mycoop-history">'
        +   '<h3 class="pf-mycoop-sec-title">Recent parties</h3>'
        +   '<div class="pf-mycoop-empty">'
        +     '<div class="pf-mycoop-empty-icon" aria-hidden="true">📜</div>'
        +     '<div class="pf-mycoop-empty-title">Your log is empty</div>'
        +     '<div class="pf-mycoop-empty-sub">Tap <strong>Quick Play</strong> or join any room \u2014 your parties show up here automatically.</div>'
        +   '</div>'
        + '</section>';
    }
    var rows = "";
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      if (!h) continue;
      var hostName = (h.host && h.host.name) || "Unknown host";
      var hostEmoji = charEmojiOf(h.host && h.host.char);
      var memberPills = "";
      var seen = {};
      for (var m = 0; m < (h.members || []).length; m++) {
        var mm = h.members[m];
        if (!mm) continue;
        // Hide non-self members that have neither a character nor a
        // name — they were never properly captured. Self always
        // shows so the row makes social sense ("Asheⵠ + You").
        if (!mm.isSelf && !mm.char && !mm.name) continue;
        var key = mm.steamId || mm.name || (mm.char + ":" + m);
        if (seen[key]) continue;
        seen[key] = 1;
        var emoji = mm.isSelf && !mm.char ? "🙂" : charEmojiOf(mm.char);
        var nm = mm.isSelf ? "You" : (mm.name || "");
        memberPills += '<span class="pf-mycoop-history-member' + (mm.isSelf ? ' is-self' : '') + '" title="' + esc(nm) + '">'
                     + '<span class="pf-mycoop-history-member-emoji">' + emoji + '</span>'
                     + '<span class="pf-mycoop-history-member-name">' + esc((nm || "").split(/\s+/)[0]).slice(0, 10) + '</span>'
                     + '</span>';
      }
      var asc = "";
      if (h.ascensionMin != null && h.ascensionMax != null && (h.ascensionMin || h.ascensionMax)) {
        if (h.ascensionMin === h.ascensionMax) asc = "A" + h.ascensionMax;
        else asc = "A" + h.ascensionMin + "\u2013A" + h.ascensionMax;
      }
      rows += ''
        + '<div class="pf-mycoop-history-row">'
        +   '<div class="pf-mycoop-history-when">' + esc(timeAgoShort(h.at)) + '</div>'
        +   '<div class="pf-mycoop-history-main">'
        +     '<div class="pf-mycoop-history-title">' + esc(h.title || "Party") + '</div>'
        +     '<div class="pf-mycoop-history-meta">'
        +       '<span class="pf-mycoop-history-host">' + hostEmoji + ' Host: <strong>' + esc(hostName) + '</strong></span>'
        +       (asc ? '<span class="pf-mycoop-history-asc">' + esc(asc) + '</span>' : '')
        +       (h.goal ? '<span class="pf-mycoop-history-goal">' + (h.goal.toLowerCase() === "heart" ? "❤️ Heart" : "🎯 " + esc(h.goal)) + '</span>' : '')
        +     '</div>'
        +     '<div class="pf-mycoop-history-members">' + memberPills + '</div>'
        +   '</div>'
        + '</div>';
    }
    return ''
      + '<section class="pf-mycoop-history">'
      +   '<h3 class="pf-mycoop-sec-title">Recent parties <span class="pf-mycoop-sec-count">' + hist.length + '</span></h3>'
      +   '<div class="pf-mycoop-history-list">' + rows + '</div>'
      + '</section>';
  }
  // Public hooks for tests + future backend integration
  window.__pfCoopLog = {
    refresh: refreshCampfireLog,
    open: openMyCoopModal,
    close: closeMyCoopModal,
    record: recordPartyEntry,
    stats: readSelfStats,
    history: readHistory,
    friends: readFriends,
    reset: function () { try { localStorage.removeItem(HIST_KEY); localStorage.removeItem(FRND_KEY); refreshCampfireLog(); refreshMyCoopModal(); } catch (_) {} },
  };

  function pollAll() {
    try { pollHero(); } catch (_) {}
    try { pollPartyHub(); } catch (_) {}
    try { tintLiveRows(); } catch (_) {}
    try { decorateLiveRowBadges(); } catch (_) {}
    try { decorateMatchScores(); } catch (_) {}
    try { decorateHostRunStrips(); } catch (_) {}
    try { decorateHostReputation(); } catch (_) {}
    try { pollActivityTicker(); } catch (_) {}
    try { relabelBranchCopy(); } catch (_) {}
    try { refreshCampfireLog(); } catch (_) {}
    try { capturePartyHubArrival(); } catch (_) {}
    try {
      var modal = document.getElementById("pf-modal-details");
      if (modal && (modal.classList.contains("pf-modal-on") || modal.getAttribute("aria-hidden") === "false")) {
        decorateDetailsModal();
      }
    } catch (_) {}
  }

  // ── Compatibility match score ───────────────────────────────────
  // Per-row badge that scores 0–100 based on how well a lobby fits
  // the user's preferences. Visible above the row title so a user
  // can sort by glance: "92% match" trumps "73% match" trumps a
  // mismatched A0–A3 room when you're an A8 player. The score uses
  // the same axes Quick Play uses, so the user sees consistent
  // ranking across the page.
  function computeMatchScore(lobby, state, quietOn) {
    if (!lobby) return null;
    var s = 0, max = 0;
    // Character (35 pts)
    max += 35;
    var myChar = userPrefChar(state);
    var hostChar = lobbyHostChar(lobby);
    if (!hostChar)                      s += 32;        // open to any
    else if (myChar && hostChar === myChar) s += 25;    // someone else has my preferred
    else if (myChar)                    s += 30;        // open seat for my preferred
    else                                s += 20;        // unknown user, neutral
    // Ascension (30 pts)
    max += 30;
    var myMin = state && state.presence && state.presence.ascensionMin;
    var myMax = state && state.presence && state.presence.ascensionMax;
    var lmin = lobby.ascensionMin == null ? 0 : lobby.ascensionMin;
    var lmax = lobby.ascensionMax == null ? 10 : lobby.ascensionMax;
    if (myMin == null && myMax == null) s += 22;
    else {
      var amin = myMin == null ? 0 : myMin;
      var amax = myMax == null ? 10 : myMax;
      var overlap = Math.min(lmax, amax) - Math.max(lmin, amin);
      if (overlap >= 4)      s += 30;
      else if (overlap >= 1) s += 22;
      else if (overlap === 0) s += 14;
      else                   s += 4;
    }
    // Voice (15 pts) — quiet mode flips weighting.
    max += 15;
    var v = String(lobby.voicePreference || "").toLowerCase();
    var optional = v === "voice_optional" || v === "optional" || v === "voice_none" || v === "none";
    if (quietOn) s += optional ? 15 : 4;
    else         s += optional ? 12 : 11;
    // Branch (10 pts) — beta/main alignment.
    max += 10;
    var myBranch = state && state.presence && state.presence.preferences && state.presence.preferences.branch;
    var lBranch = String(lobby.branch || lobby.branchAccept || "").toLowerCase();
    if (!myBranch || lBranch === "main_or_beta")           s += 10;
    else if (myBranch === lBranch)                          s += 10;
    else                                                    s += 4;
    // Filled-but-not-empty bonus (10 pts) — joining a room with at
    // least 1 buddy already inside feels much less awkward.
    max += 10;
    var members = Array.isArray(lobby.partyMembers) ? lobby.partyMembers
                : Array.isArray(lobby.acceptedMemberSteamIds) ? lobby.acceptedMemberSteamIds : [];
    var filled = members.length || 1;
    var capacity = lobby.lobbySize || 4;
    if (filled >= capacity)        s += 0;        // full = unjoinable
    else if (filled >= 2)          s += 10;
    else                           s += 6;
    return Math.round((s / max) * 100);
  }

  function decorateMatchScores() {
    var list = document.getElementById("pf-live-list");
    if (!list) return;
    var state = readState();
    if (!state || !Array.isArray(state.openLobbies)) return;
    var quietOn = readQuiet();
    var byId = {};
    for (var i = 0; i < state.openLobbies.length; i++) {
      var lobby = state.openLobbies[i];
      if (lobby && lobby.lobbyId) byId[lobby.lobbyId] = lobby;
    }
    var rows = list.querySelectorAll(":scope > .pf-live-row[data-lobby-id]");
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var lid = row.getAttribute("data-lobby-id") || "";
      var l = byId[lid];
      if (!l) continue;
      var score = computeMatchScore(l, state, quietOn);
      if (score == null) continue;
      var existing = row.querySelector(":scope > .pf-row-match-score");
      if (!existing) {
        existing = document.createElement("div");
        existing.className = "pf-row-match-score";
        row.appendChild(existing);
      }
      var tier = score >= 85 ? "great" : score >= 70 ? "good" : score >= 50 ? "ok" : "weak";
      if (existing.getAttribute("data-tier") !== tier || existing.getAttribute("data-score") !== String(score)) {
        existing.setAttribute("data-tier", tier);
        existing.setAttribute("data-score", String(score));
        existing.innerHTML = ''
          + '<svg class="pf-row-match-ring" viewBox="0 0 36 36" aria-hidden="true">'
          +   '<circle class="pf-row-match-ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="3"></circle>'
          +   '<circle class="pf-row-match-ring-fill"  cx="18" cy="18" r="15.5" fill="none" stroke-width="3" '
          +     'stroke-dasharray="' + (score / 100 * 97.4).toFixed(1) + ' 97.4" stroke-dashoffset="0" stroke-linecap="round"></circle>'
          + '</svg>'
          + '<span class="pf-row-match-num">' + score + '</span>'
          + '<span class="pf-row-match-label">match</span>';
      }
    }
  }

  // ── Live Activity Ticker ────────────────────────────────────────
  // A horizontal "what's happening right now" strip mounted just
  // below the hero stage. Diffs incoming `state.openLobbies` and
  // `state.activePlayerFeed` against the last snapshot to detect:
  //   - new rooms opened
  //   - rooms that filled
  //   - players that started looking for a group
  // and surfaces them as fading-in chips. This is what makes the
  // page feel ALIVE — the core showcase moment.
  var __pfTickerEvents = []; // most recent first
  var __pfTickerLastSnap = { lobbies: {}, looking: {} };
  var __pfTickerSeenInit = false;

  function pushTickerEvent(ev) {
    ev.id = (ev.kind + "|" + (ev.refId || "") + "|" + Date.now() + "|" + Math.floor(Math.random() * 1000));
    ev.t = Date.now();
    __pfTickerEvents.unshift(ev);
    if (__pfTickerEvents.length > 18) __pfTickerEvents.length = 18;
  }
  function diffState(state) {
    if (!state) return;
    var lobbies = Array.isArray(state.openLobbies) ? state.openLobbies : [];
    var nextLobbies = {};
    for (var i = 0; i < lobbies.length; i++) {
      var l = lobbies[i]; if (!l || !l.lobbyId) continue;
      var members = Array.isArray(l.partyMembers) ? l.partyMembers
                  : Array.isArray(l.acceptedMemberSteamIds) ? l.acceptedMemberSteamIds : [];
      nextLobbies[l.lobbyId] = {
        title: l.title, host: l.hostPersonaName,
        char: lobbyHostChar(l), filled: members.length,
        cap: l.lobbySize || 4,
      };
    }
    var feed = Array.isArray(state.activePlayerFeed) ? state.activePlayerFeed : [];
    var nextLooking = {};
    for (var j = 0; j < feed.length; j++) {
      var p = feed[j]; if (!p || !p.steamId) continue;
      if (p.status === "looking") nextLooking[p.steamId] = p.personaName || "";
    }
    if (__pfTickerSeenInit) {
      // Newly-opened rooms.
      for (var lid in nextLobbies) if (Object.prototype.hasOwnProperty.call(nextLobbies, lid)) {
        if (!__pfTickerLastSnap.lobbies[lid]) {
          var n = nextLobbies[lid];
          pushTickerEvent({
            kind: "opened",
            refId: lid,
            char: n.char,
            text: (n.host || "Someone") + " opened " + (n.title || "a room"),
          });
        } else {
          var prev = __pfTickerLastSnap.lobbies[lid];
          if (n = nextLobbies[lid], n.filled > prev.filled) {
            pushTickerEvent({
              kind: "joined",
              refId: lid,
              char: n.char,
              text: "+1 joined " + (n.title || "a room") + " (" + n.filled + "/" + n.cap + ")",
            });
          }
          if (n.filled >= n.cap && prev.filled < n.cap) {
            pushTickerEvent({
              kind: "full",
              refId: lid,
              char: n.char,
              text: (n.title || "Room") + " is starting (" + n.cap + "/" + n.cap + ")",
            });
          }
        }
      }
      // Players starting LFG.
      for (var sid in nextLooking) if (Object.prototype.hasOwnProperty.call(nextLooking, sid)) {
        if (!__pfTickerLastSnap.looking[sid]) {
          pushTickerEvent({
            kind: "looking",
            refId: sid,
            text: (nextLooking[sid] || "A player") + " is looking for a group",
          });
        }
      }
    } else {
      __pfTickerSeenInit = true;
      // Seed with current rooms so the bar isn't empty on first load.
      var seeds = lobbies.slice(0, 4);
      for (var k = 0; k < seeds.length; k++) {
        var s = seeds[k];
        var sm = Array.isArray(s.partyMembers) ? s.partyMembers : (Array.isArray(s.acceptedMemberSteamIds) ? s.acceptedMemberSteamIds : []);
        pushTickerEvent({
          kind: "active",
          refId: s.lobbyId,
          char: lobbyHostChar(s),
          text: (s.hostPersonaName || "Host") + " — " + (s.title || "Open room") + " (" + sm.length + "/" + (s.lobbySize || 4) + ")",
        });
      }
    }
    __pfTickerLastSnap.lobbies = nextLobbies;
    __pfTickerLastSnap.looking = nextLooking;
  }

  function ensureActivityTicker() {
    var stage = document.querySelector(".pf-stage[data-pf-stage]");
    if (!stage) return null;
    var ticker = stage.parentElement && stage.parentElement.querySelector(":scope > .pf-activity-ticker");
    if (ticker) return ticker;
    ticker = document.createElement("aside");
    ticker.className = "pf-activity-ticker";
    ticker.setAttribute("aria-label", "Live SpireVault activity");
    ticker.innerHTML = ''
      + '<div class="pf-activity-ticker-eye">'
      +   '<span class="pf-activity-ticker-pulse" aria-hidden="true"></span>'
      +   '<span>Live now</span>'
      + '</div>'
      + '<div class="pf-activity-ticker-rail" data-pf-ticker-rail>'
      +   '<div class="pf-activity-ticker-empty">Loading the campfire…</div>'
      + '</div>';
    if (stage.parentElement) {
      if (stage.nextSibling) stage.parentElement.insertBefore(ticker, stage.nextSibling);
      else                   stage.parentElement.appendChild(ticker);
    }
    return ticker;
  }
  function eventEmoji(ev) {
    if (ev.kind === "opened")  return "🆕";
    if (ev.kind === "joined")  return "👋";
    if (ev.kind === "full")    return "🔥";
    if (ev.kind === "looking") return "👀";
    return "🎴";
  }
  var __pfTickerLastRendered = "";
  function pollActivityTicker() {
    var state = readState();
    diffState(state);
    var ticker = ensureActivityTicker();
    if (!ticker) return;
    var rail = ticker.querySelector("[data-pf-ticker-rail]");
    if (!rail) return;
    if (!__pfTickerEvents.length) return;
    // Idempotent render — fingerprint the current event ids and bail
    // out if nothing changed. This is critical because the global
    // body MutationObserver triggers pollAll(), and an unconditional
    // DOM write here would feed back into itself in an infinite loop.
    var ids = "";
    for (var e = 0; e < __pfTickerEvents.length; e++) {
      ids += __pfTickerEvents[e].id + ";";
    }
    if (ids === __pfTickerLastRendered) return;
    __pfTickerLastRendered = ids;

    var frag = document.createDocumentFragment();
    for (var f = 0; f < __pfTickerEvents.length; f++) {
      var ev = __pfTickerEvents[f];
      var node = document.createElement("div");
      node.className = "pf-activity-ev";
      node.setAttribute("data-evid", ev.id);
      node.setAttribute("data-kind", ev.kind);
      if (ev.char) node.setAttribute("data-pf-host-char", ev.char);
      node.innerHTML = '<span class="pf-activity-ev-icon" aria-hidden="true">' + eventEmoji(ev) + '</span>'
                     + '<span class="pf-activity-ev-text">' + esc(ev.text) + '</span>';
      frag.appendChild(node);
    }
    while (rail.firstChild) rail.removeChild(rail.firstChild);
    rail.appendChild(frag);
  }

  function boot() {
    ensureSceneCss();
    ensureStageDelegate();
    pollAll();
    // Re-poll on each animation frame burst — cheap, always responsive.
    var lastTick = 0;
    setInterval(function () {
      var now = Date.now();
      if (now - lastTick < 700) return;
      lastTick = now;
      pollAll();
    }, 800);

    // Catch DOM mutations on body so we react quickly when the
    // user navigates to /party/* or opens the Room Details modal.
    // Throttled to 600ms so polls triggered by our own DOM writes
    // (ticker, badges, match scores) can't feed back into themselves.
    var moPending = false;
    var moLastRun = 0;
    var mo = new MutationObserver(function () {
      var now = Date.now();
      if (now - moLastRun >= 600) {
        moLastRun = now;
        pollAll();
        return;
      }
      if (moPending) return;
      moPending = true;
      setTimeout(function () {
        moPending = false;
        moLastRun = Date.now();
        pollAll();
      }, Math.max(0, 600 - (now - moLastRun)));
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}

    // Specifically tail the modal — its body re-renders on each show.
    var mObs = new MutationObserver(function () {
      try { decorateDetailsModal(); } catch (_) {}
    });
    var modal = document.getElementById("pf-modal-details");
    if (modal) {
      try { mObs.observe(modal, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden", "class"] }); } catch (_) {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  window.__pfScene = { __sealed: true, refresh: pollAll };
})();
