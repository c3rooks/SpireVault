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
    l.href = "/lib/party-finder-scene.css?v=18";
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

  // ── icon set ──────────────────────────────────────────────────────
  //
  // Why these are inline SVG strings instead of <img> tags or emojis:
  //
  //   - Emojis (🏆 🎯 ❤️ 👥 🔥) render differently across macOS, Windows,
  //     iOS, Android and even between Safari and Chrome on the same OS.
  //     The earlier build used emojis here and the result looked like
  //     four icons from four different design systems pasted together.
  //
  //   - <img> tags would force a network fetch per icon and lose the
  //     ability to inherit color from `currentColor`. Inline SVG lets
  //     the CSS layer tint each icon with the ember-gold accent so the
  //     whole campfire-log row reads as a single design language.
  //
  // Paths are derived from Lucide (MIT). Stroke-based, 24x24 viewBox,
  // 2px stroke. Keep them as string constants so the JS bundle still
  // parses on older Safari that doesn't ship template literals (the
  // rest of this file is already old-school string concatenation).
  var SVG_OPEN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
                  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var SVG_CLOSE = '</svg>';

  var ICON_TROPHY = SVG_OPEN +
    '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>' +
    '<path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>' +
    '<path d="M4 22h16"/>' +
    '<path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>' +
    '<path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>' +
    '<path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>' +
    SVG_CLOSE;

  // Two crossed swords — reads as "co-op encounter" / a party. The
  // previous target icon (🎯) looked like a dartboard which has no
  // semantic tie to STS2 runs.
  var ICON_SWORDS = SVG_OPEN +
    '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/>' +
    '<line x1="13" y1="19" x2="19" y2="13"/>' +
    '<line x1="16" y1="16" x2="20" y2="20"/>' +
    '<line x1="19" y1="21" x2="21" y2="19"/>' +
    '<polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/>' +
    '<line x1="5" y1="14" x2="9" y2="18"/>' +
    '<line x1="7" y1="17" x2="4" y2="20"/>' +
    '<line x1="3" y1="19" x2="5" y2="21"/>' +
    SVG_CLOSE;

  // Heart — outline, fills with currentColor when the user has hearts.
  // The previous ❤️ emoji rendered as a flat red which clashed with
  // the warm gold/ember palette used throughout the campfire log.
  var ICON_HEART = SVG_OPEN +
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' +
    SVG_CLOSE;

  // Users — two figures. The previous 👥 emoji rendered as a flat
  // monochrome blob on macOS and as a 2-tone outline on Windows;
  // the Lucide version is consistent everywhere.
  var ICON_USERS = SVG_OPEN +
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="9" cy="7" r="4"/>' +
    '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
    '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>' +
    SVG_CLOSE;

  // Flame — used in both the Campfire Log eyebrow (small) and the
  // My Co-op modal eyebrow. The Lucide flame has a definite "tongue"
  // shape that reads as fire at any size, unlike the emoji 🔥 which
  // varies wildly by OS.
  var ICON_FLAME = SVG_OPEN +
    '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' +
    SVG_CLOSE;

  // Custom campfire — used for the 56x56 firepit decoration next to
  // the "Pick your hero" / "Your campfire" identity card. This is
  // the user-facing showpiece icon; the four CSS-drawn pieces below
  // (logs, flame, glow) used to ship here but read as a torch flame
  // rather than a campfire and had to go.
  //
  // Structure:
  //   - radial glow ellipse behind the logs (animated in CSS)
  //   - two stacked logs angled slightly to imply X-stacking
  //   - a Lucide flame path rising from the logs (animated separately)
  // viewBox 24x24, scaled by CSS on .pf-stage-presence-firepit.
  var ICON_CAMPFIRE =
    '<svg viewBox="0 0 24 24" class="pf-firepit-svg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<ellipse class="pf-firepit-svg-glow" cx="12" cy="19.5" rx="9" ry="2"/>' +
      '<g class="pf-firepit-svg-logs">' +
        '<rect x="2.5"  y="17" width="19" height="2.4" rx="1.2" transform="rotate(-10 12 18.2)"/>' +
        '<rect x="2.5"  y="17" width="19" height="2.4" rx="1.2" transform="rotate(10 12 18.2)"/>' +
      '</g>' +
      '<path class="pf-firepit-svg-flame" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' +
    '</svg>';
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

    // v196 — three-stage hero. The same DOM ships on every load, but
    // the .pf-stage element carries a `data-pf-stage-bucket` attribute
    // (a | b | c) set from state.openLobbies.length in refreshHeroStage().
    // CSS in styles.css handles the show/hide so we don't have to
    // re-emit the whole tree on every poll.
    //
    // Stage A (0 open lobbies) — the empty page is calm: keep one
    // bullet of explainer, hide Quick Play, show one big primary
    // "Host a room and call your friends in", collapse stats into one
    // quiet inline line, fold Quiet + Alerts behind a gear top-right.
    //
    // Stages B/C — Quick Play primary, Host secondary; the inline stat
    // line stays so the page reads consistently as you scale up.
    return '' +
      // Top-right gear collapses Quiet match + Alerts in stage A. In
      // stages B/C they reappear inline in the CTA row (CSS handles it).
      '<button type="button" class="pf-stage-gear" data-pf-action="pf-toggle-options-sheet" aria-haspopup="true" aria-expanded="false" aria-label="Quiet match and alerts">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<circle cx="12" cy="12" r="3"/>' +
          '<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>' +
        '</svg>' +
        '<span class="pf-stage-gear-dot" data-pf-alerts-dot aria-hidden="true"></span>' +
      '</button>' +
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
          '<p class="pf-stage-sub">One tap. We pick the best open room, walk you in, and keep voice optional.</p>' +
          // Single bullet — the most evocative differentiator. The
          // 3-bullet list shipped in v195 read as marketing noise on
          // an empty page. One sentence keeps the page calm.
          '<ul class="pf-stage-prop pf-stage-prop--single" aria-label="Why SpireVault Co-op">' +
            '<li><span class="pf-stage-prop-icon" aria-hidden="true">\u23F1\uFE0F</span><span><strong>Synced GO moment</strong> launches Steam together.</span></li>' +
          '</ul>' +
          '<div class="pf-stage-cta">' +
            // STAGE A primary: one big confident CTA. v197 collapses the
            // 3-step Host modal into a single tap — clicking POSTs
            // QUICK_HOST_DEFAULTS via window.__coopQuickHost.run() and
            // drops the user straight into their Party Hub. The copy
            // shifts from "call your friends in" (which implies social
            // capital) to agency framing: anyone can join, no friends
            // required, change the defaults later from inside the room.
            // Stages B/C keep the modal entry point (see below).
            '<button type="button" class="pf-stage-host pf-stage-host--mega" data-pf-stage-only="a" data-pf-action="pf-host-tonight" data-pf-mega-busy="0">' +
              '<span class="pf-stage-host-icon" aria-hidden="true" data-pf-mega-icon>＋</span>' +
              '<span class="pf-stage-host-label">' +
                '<strong>Open a room for anyone</strong>' +
                '<small>One tap. We\u2019ll set sensible defaults \u2014 change them later.</small>' +
              '</span>' +
              '<span class="pf-stage-host-spinner" data-pf-mega-spinner aria-hidden="true"></span>' +
              '<span class="pf-stage-quickplay-pulse" aria-hidden="true"></span>' +
            '</button>' +
            // STAGES B/C primary: auto-match Quick Play. Hidden in A.
            '<button type="button" class="pf-stage-quickplay" data-pf-stage-only="bc" data-pf-action="pf-quick-play">' +
              '<span class="pf-stage-quickplay-icon" aria-hidden="true">▶</span>' +
              '<span class="pf-stage-quickplay-label">' +
                '<strong>Quick Play</strong>' +
                '<small data-pf-quickplay-sub>Auto-match me into the best room</small>' +
              '</span>' +
              '<span class="pf-stage-quickplay-pulse" aria-hidden="true"></span>' +
            '</button>' +
            // STAGES B/C secondary: standard host button. Hidden in A
            // (the mega button above covers hosting).
            '<button type="button" class="pf-stage-host" data-pf-stage-only="bc" data-pf-action="open-host">' +
              '<span class="pf-stage-host-icon" aria-hidden="true">＋</span>' +
              '<span class="pf-stage-host-label">' +
                '<strong>Host a Room</strong>' +
                '<small>Set your run \u00B7 invite a party</small>' +
              '</span>' +
            '</button>' +
            // Quiet match + Alerts. In stages B/C they sit in-row;
            // in stage A CSS hides them and the gear-icon sheet
            // surfaces the same controls.
            '<label class="pf-stage-quiet" data-pf-quiet-toggle data-pf-stage-only="bc" title="Match me into voice-optional rooms.">' +
              '<input type="checkbox" data-pf-action="pf-toggle-quiet"' + (quietOn ? ' checked' : '') + '>' +
              '<span class="pf-stage-quiet-track" aria-hidden="true"><span class="pf-stage-quiet-thumb"></span></span>' +
              '<span class="pf-stage-quiet-text">' +
                '<strong>Quiet match</strong>' +
                '<small>I just want to play — no mic needed</small>' +
              '</span>' +
            '</label>' +
            '<button type="button" class="pf-stage-alerts-gear" data-pf-stage-only="bc" data-pf-action="open-alerts" aria-haspopup="true" aria-expanded="false" title="Sound &amp; notification settings for the GO countdown.">' +
              '<span class="pf-stage-alerts-gear-icon" aria-hidden="true">\u2699\uFE0F</span>' +
              '<span class="pf-stage-alerts-gear-label">Alerts</span>' +
              '<span class="pf-stage-alerts-gear-dot" data-pf-alerts-dot aria-hidden="true"></span>' +
            '</button>' +
          '</div>' +
          // Inline single-line stats — small caps, gold-dim. Replaces
          // the 4 stat tiles (3 of which were zero on an empty page
          // and felt like vanity boxes).
          //
          // v197: in stage A the raw counts ("0 online · 0 hosting ·
          // 0 looking") read as dead-storefront energy. We swap to a
          // positive-presence rewrite ("N players are around right
          // now — be the first to open a room and we'll match them
          // in.") via the .pf-stage-stats-line__presence span. The
          // counts span stays in the DOM for buckets B/C so the page
          // reads consistently once liquidity exists. Toggling between
          // the two is driven by the `data-pf-line-mode` attribute set
          // each refresh from refreshHeroStage().
          '<p class="pf-stage-stats-line" data-pf-stage-stats-line data-pf-line-mode="a">' +
            '<span class="pf-stage-stats-line__presence" data-pf-stage-presence-line>' +
              // Initial copy — matches the "online == 0" rewrite so a
              // first paint before /coop/state lands doesn't flash the
              // legacy "0 online" wording for a frame. Real text is
              // painted by refreshHeroStage() on the first state poll.
              '<span class="pf-presence-msg">Open a room and we\u2019ll ping the next player who shows up.</span>' +
            '</span>' +
            '<span class="pf-stage-stats-line__counts">' +
              '<span class="pf-stage-stats-line-label">Live tonight:</span> ' +
              '<strong data-pf-stage-stat="online">0</strong> online' +
              ' \u00B7 ' +
              '<strong data-pf-stage-stat="hosting">0</strong> hosting' +
              ' \u00B7 ' +
              '<strong data-pf-stage-stat="looking">0</strong> looking' +
              '<span data-pf-stage-stats-line-starting hidden> \u00B7 ' +
                '<strong data-pf-stage-stat="starting">0</strong> starting soon' +
              '</span>' +
            '</span>' +
          '</p>' +
          // Off-screen tiles preserve the data-pf-stage-stat anchors
          // for older code paths (party-finder-startsoon-rt + tests
          // grep these). Inline line above is the visible truth.
          '<div class="pf-stage-stats" data-pf-stage-stats hidden aria-hidden="true">' +
            '<div class="pf-stage-stat pf-stage-stat--starting" data-pf-stage-stat-tile="starting"></div>' +
          '</div>' +
        '</div>' +
        '<div class="pf-stage-presence' + (heroChar ? "" : " pf-stage-presence--empty") + '">' +
          '<div class="pf-stage-presence-art-frame" data-char="' + esc(heroChar) + '" aria-hidden="true">' +
            heroPortraitHtml +
          '</div>' +
          buildPresenceMetaHtml(heroChar, name, quietOn) +
        '</div>' +
      '</div>' +
      // Matchmaker animation host — three small face-down STS-style
      // cards, fixed-positioned overlay slot dropped right under the
      // CTA row. Hidden by default; runMatchmakerAnimation() flips
      // [data-running] and the cards flip sequentially in CSS.
      '<div class="pf-matchmaker" data-pf-matchmaker hidden aria-hidden="true">' +
        '<div class="pf-matchmaker-cards" data-pf-matchmaker-cards>' +
          '<div class="pf-matchmaker-card" data-pf-card="0"><div class="pf-matchmaker-card-inner">' +
            '<div class="pf-matchmaker-card-face pf-matchmaker-card-face--back" aria-hidden="true">' + ICON_CAMPFIRE + '</div>' +
            '<div class="pf-matchmaker-card-face pf-matchmaker-card-face--front" data-pf-card-front="0"></div>' +
          '</div></div>' +
          '<div class="pf-matchmaker-card" data-pf-card="1"><div class="pf-matchmaker-card-inner">' +
            '<div class="pf-matchmaker-card-face pf-matchmaker-card-face--back" aria-hidden="true">' + ICON_CAMPFIRE + '</div>' +
            '<div class="pf-matchmaker-card-face pf-matchmaker-card-face--front" data-pf-card-front="1"></div>' +
          '</div></div>' +
          '<div class="pf-matchmaker-card" data-pf-card="2"><div class="pf-matchmaker-card-inner">' +
            '<div class="pf-matchmaker-card-face pf-matchmaker-card-face--back" aria-hidden="true">' + ICON_CAMPFIRE + '</div>' +
            '<div class="pf-matchmaker-card-face pf-matchmaker-card-face--front" data-pf-card-front="2"></div>' +
          '</div></div>' +
          '<div class="pf-matchmaker-sweep" aria-hidden="true"></div>' +
        '</div>' +
        '<p class="pf-matchmaker-caption" data-pf-matchmaker-caption>Dealing your party\u2026</p>' +
      '</div>';
  }

  // Bottom strip of the identity card. Two layouts:
  //   FILLED → 🔥 firepit + "Your campfire" + name + status dot
  //   EMPTY  → 🔥 firepit + "Pick your hero" CTA + "Tap to choose"
  // The empty-state CTA replaces the name strip rather than overlay
  // the character art. This is the showcase fix.
  function buildPresenceMetaHtml(heroChar, name, quietOn) {
    // Single SVG campfire replaces the four CSS-drawn shapes (flame +
    // inner flame + logs + glow). The CSS version read as a tall yellow
    // torch flame on top of brown blocks; the SVG reads as a recognizable
    // campfire glyph with subtle flicker animation handled in CSS.
    var firepit =
      '<div class="pf-stage-presence-firepit" aria-hidden="true">' +
        ICON_CAMPFIRE +
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
    // v196 — set the stage bucket BEFORE first paint so the right CTA
    // shows immediately. Computes off whatever readState() returns
    // right now (likely null on cold paint → bucket "a") so the empty
    // page renders calm rather than flashing both buttons.
    var initialState = readState();
    var initialBucket = pfStageBucketForState(initialState);
    stage.setAttribute("data-pf-stage-bucket", initialBucket);
    try {
      var html = document.documentElement;
      if (html.getAttribute("data-pf-stage-bucket") !== initialBucket) {
        html.setAttribute("data-pf-stage-bucket", initialBucket);
      }
    } catch (_) {}
    stage.innerHTML = buildStageHtml(readSession(), initialState);
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
    else {
      // Neutral state — let the state-aware mode label win so we don't
      // clobber "Reopen your lobby" / "Leave current party to host" with
      // the default auto-match copy while the user is in a hosting-shaped
      // UX mode.
      renderQuickPlayLabel(stage, resolveQuickPlayMode(readState()));
    }
  }

  // Resolve the hosting-shaped UX mode for the existing Quick Play
  // button. Prefers the canonical resolver published by coop-lobbies.js
  // (window.__coopQuickHost.resolveMode) so the rules stay in lockstep;
  // falls back to an inline implementation when scene.js boots before
  // mountCoopLobbies has installed the bridge. Returns one of:
  //   "default" | "signed_out" | "hosting" | "in_other_party"
  function resolveQuickPlayMode(state) {
    try {
      var bridge = window.__coopQuickHost;
      if (bridge && typeof bridge.resolveMode === "function") {
        return bridge.resolveMode(state || {});
      }
    } catch (_) { /* fall through */ }
    var session = readSession();
    if (!session || !session.steamID) return "signed_out";
    var sid = (state && state.presence && state.presence.steamId) || session.steamID;
    var lobby = state && state.lobby;
    if (lobby && lobby.hostSteamId === sid && lobby.status === "open") return "hosting";
    var party = state && state.party;
    if (party && party.status === "active" && party.hostSteamId && party.hostSteamId !== sid) {
      return "in_other_party";
    }
    return "default";
  }

  // Update the existing Quick Play button's label + sub-text in place
  // based on the resolved mode. The button visuals (orange gradient,
  // pulse, icon) stay identical — we only repurpose the copy and aria
  // label so a hosting host sees "Reopen your lobby" and a guest sees
  // "Sign in to host" without us forking a second button.
  function renderQuickPlayLabel(stage, mode) {
    if (!stage) stage = document.querySelector(".pf-stage[data-pf-stage]");
    if (!stage) return;
    var btn = stage.querySelector('[data-pf-action="pf-quick-play"]');
    if (!btn) return;
    var labelStrong = btn.querySelector(".pf-stage-quickplay-label > strong");
    var labelSub = btn.querySelector("[data-pf-quickplay-sub]");
    if (!labelStrong || !labelSub) return;
    var copy;
    switch (mode) {
      case "signed_out":
        copy = {
          title: "Sign in to host",
          sub: "Sign in with Steam, then one click opens a wide-open room.",
          aria: "Sign in to host \u2014 opens a wide-open room after Steam sign-in",
        };
        break;
      case "hosting":
        copy = {
          title: "Reopen your lobby",
          sub: "You already have an open room. Click to jump back to it.",
          aria: "Reopen your lobby \u2014 scroll to the room you're already hosting",
        };
        break;
      case "in_other_party":
        copy = {
          title: "Leave current party to host",
          sub: "You're in another player's party right now.",
          aria: "Leave current party to host \u2014 confirm before leaving",
        };
        break;
      default:
        copy = {
          title: "Quick Play",
          sub: readQuiet() ? "Quiet match \u2014 no mic needed" : "Auto-match me into the best room",
          aria: "Quick Play \u2014 auto-match me into the best open room",
        };
    }
    // Don't clobber transient states ("matching"/"joining"/"no-match")
    // — flashQuickPlayState owns the sub-text while one of those is on.
    var transient = stage.getAttribute("data-quickplay");
    if (transient && transient !== "" && transient !== "neutral") {
      if (labelStrong.textContent !== copy.title) labelStrong.textContent = copy.title;
      btn.setAttribute("aria-label", copy.aria);
      btn.setAttribute("data-pf-quickplay-mode", mode);
      return;
    }
    if (labelStrong.textContent !== copy.title) labelStrong.textContent = copy.title;
    if (labelSub.textContent !== copy.sub) labelSub.textContent = copy.sub;
    btn.setAttribute("aria-label", copy.aria);
    btn.setAttribute("data-pf-quickplay-mode", mode);
  }

  // Telemetry — preserve the GA event the deleted orange hero used to
  // fire so the conversion funnel keeps tracking the same "user wants
  // to play right now" intent across the redesign.
  function fireQuickPlayTelemetry(name, payload) {
    try {
      if (typeof window === "undefined") return;
      if (typeof window.gtag !== "function") return;
      window.gtag("event", name, { event_category: "coop_quick_host", ...(payload || {}) });
    } catch (_) { /* analytics never blocks the UI */ }
  }

  // Synthesize a click on the global [data-action="signin-cta"]
  // delegated handler so signed-out users get routed through the same
  // Steam OpenID start path that every other sign-in CTA uses.
  function triggerSteamSignIn() {
    try {
      var existing = document.querySelector('[data-action="signin-cta"]');
      if (existing && typeof existing.click === "function") { existing.click(); return; }
    } catch (_) { /* fall through */ }
    try {
      var synth = document.createElement("button");
      synth.type = "button";
      synth.setAttribute("data-action", "signin-cta");
      synth.style.display = "none";
      document.body.appendChild(synth);
      synth.click();
      synth.remove();
    } catch (_) { /* best-effort */ }
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
    var state = readState();
    var mode = resolveQuickPlayMode(state);

    // Always fire the conversion event the deleted orange hero used to
    // fire — same event name, same category, with the resolved mode so
    // the GA funnel keeps differentiating sign-in / reopen / leave /
    // auto-match taps.
    fireQuickPlayTelemetry("lobby_quick_host_click", { mode: mode });

    if (mode === "signed_out") {
      triggerSteamSignIn();
      return;
    }

    // For hosting / in_other_party / auto-host paths, delegate to the
    // canonical pipeline still living in coop-lobbies.js (scroll to
    // existing lobby card; ad-hoc confirm + /coop/parties/:id/leave then
    // POST /coop/lobbies with QUICK_HOST_DEFAULTS). Falls through to the
    // local auto-match flow if the bridge isn't installed yet.
    if (mode === "hosting" || mode === "in_other_party") {
      try {
        var bridge = window.__coopQuickHost;
        if (bridge && typeof bridge.run === "function") {
          var ret = bridge.run();
          if (ret && typeof ret.catch === "function") {
            ret.catch(function (_) { /* coop-lobbies surfaces its own toast */ });
          }
          return;
        }
      } catch (_) { /* fall through to auto-match as a safety net */ }
    }

    // Default mode: existing auto-match flow — pick the best open room
    // and synthesize a join click. This is what the user originally
    // expected from "Quick Play" pre-v194; we preserve it bit-for-bit.
    flashQuickPlayState(stage, "matching");
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
    // v196 — matchmaker animation. Three cards flip; the third reveals
    // the picked lobby's host character (or host avatar fallback).
    // Animation finishes BEFORE the join request POSTs so the user
    // sees the reveal as the cause of the navigation, not as a
    // separate event after the page swap.
    var hostChar = lobbyHostChar(lobby);
    var heroSrc = hostChar ? charAsset(hostChar)
      : (lobby.hostAvatarUrl || "/assets/vault-mark.svg");
    var heroLbl = hostChar
      ? (CHAR_LABEL[hostChar] || "Host")
      : (lobby.hostPersonaName || "Host");
    runMatchmakerAnimation({
      reason: "quick-play",
      heroImage: heroSrc,
      heroLabel: heroLbl,
      caption: "Found your party. Walking you in\u2026",
    }).then(function () {
      triggerJoinForLobby(lobby.lobbyId);
      // doJoinRoom redirects on success; reset state if it didn't (errors).
      setTimeout(function () {
        flashQuickPlayState(stage, null);
        var n = document.querySelector(".pf-stage-quickplay-why");
        if (n) n.remove();
      }, 4500);
    });
  }

  // v197 — stage-A one-tap host. Fires GA telemetry, kicks off the
  // matchmaker card-flip animation in parallel (fire-and-forget, no
  // gating), POSTs /coop/lobbies via window.__coopQuickHost.run(), and
  // on failure falls back to the standard 3-step Host modal so the user
  // is never stranded. The mega button itself flips into a busy state
  // (spinner + locked CTA) for the duration of the POST.
  function onStageAOneTapClick(megaBtn) {
    // GA: separate funnel event for the new one-tap path so the split
    // from the modal-driven "lobby_quick_host_click" is visible in GA4.
    try {
      if (typeof window.gtag === "function") {
        window.gtag("event", "lobby_stage_a_one_tap_click", {
          event_category: "coop_quick_host",
          mode: "stage_a_one_tap",
        });
      }
    } catch (_) {}

    // Lock the mega button visually. The coop-lobbies bridge also
    // emits a busy hook (__coopQuickHostBusyHook) which the global
    // listener installed in ensureStageDelegate mirrors; this inline
    // flip just guarantees the user sees feedback within the same
    // animation frame, even if the bridge hook fires slightly later.
    setMegaButtonBusy(megaBtn, true);

    // Fire-and-forget matchmaker animation. The user's own character
    // (or a neutral campfire fallback) is the reveal card; the POST
    // races in parallel so the lobby exists by the time the cards
    // settle. We don't gate the POST on the animation finishing —
    // the diagnostic worker confirmed v196's POST-runs-unconditionally
    // pattern is the right shape here too.
    try {
      var state = readState();
      var myChar = rosterCharForUser(state);
      var heroSrc = myChar
        ? charAsset(myChar)
        : "/assets/vault-mark.svg";
      var heroLbl = myChar ? (CHAR_LABEL[myChar] || "Host") : "Host";
      // Best effort: never let the animation throw out of the click
      // handler. .then chain swallows the resolution.
      var animP = runMatchmakerAnimation({
        reason: "host",
        heroImage: heroSrc,
        heroLabel: heroLbl,
        caption: "Opening your room\u2026",
      });
      if (animP && typeof animP.then === "function") {
        animP.then(function () { /* no-op — caller doesn't gate on it */ });
      }
    } catch (_) { /* animation is purely decorative; never throw */ }

    // Drive the existing state-aware quick-host pipeline. It handles
    // sign-in handoff / reopen-existing / leave-current-party / POST
    // for us; we only need to react to the {ok:false, action:
    // "create_failed"} branch with a fallback to the Host modal.
    var bridge = (typeof window !== "undefined") ? window.__coopQuickHost : null;
    if (!bridge || typeof bridge.run !== "function") {
      // The bridge should always be installed by the time the scene is
      // mounted (coop-lobbies.js sets it on mountCoopLobbies). If it
      // isn't (loading race), fall back to the modal so the user has a
      // path forward — same fallback the failure branch uses.
      setMegaButtonBusy(megaBtn, false);
      openHostModalFallback("Couldn\u2019t quick-host \u2014 pick your settings.");
      return;
    }
    var p;
    try { p = bridge.run(); } catch (_) { p = null; }
    if (!p || typeof p.then !== "function") {
      // Synchronous failure — treat as create_failed for fallback.
      setMegaButtonBusy(megaBtn, false);
      openHostModalFallback("Couldn\u2019t quick-host \u2014 pick your settings.");
      return;
    }
    p.then(function (res) {
      setMegaButtonBusy(megaBtn, false);
      if (res && res.ok && res.action === "created") {
        try {
          if (typeof window.gtag === "function") {
            window.gtag("event", "lobby_stage_a_one_tap_created", {
              event_category: "coop_quick_host",
              lobby_id: res.lobbyId || "",
            });
          }
        } catch (_) {}
        return;
      }
      // Only fall back when the POST itself failed. signin_handoff /
      // hosting_scroll / leave_canceled / leave_failed branches have
      // already toasted / navigated the user appropriately.
      if (res && res.action === "create_failed") {
        openHostModalFallback("Couldn\u2019t quick-host \u2014 pick your settings.");
      }
    }).catch(function (_) {
      setMegaButtonBusy(megaBtn, false);
      openHostModalFallback("Couldn\u2019t quick-host \u2014 pick your settings.");
    });
  }

  function setMegaButtonBusy(btn, busy) {
    if (!btn || !btn.setAttribute) return;
    btn.setAttribute("data-pf-mega-busy", busy ? "1" : "0");
    btn.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) btn.setAttribute("disabled", "disabled");
    else btn.removeAttribute("disabled");
  }

  function openHostModalFallback(toastMessage) {
    try {
      if (toastMessage && typeof window !== "undefined") {
        var toastFn = window.__pfToast;
        if (typeof toastFn === "function") toastFn(toastMessage);
      }
    } catch (_) {}
    try {
      var synthHost = document.createElement("button");
      synthHost.type = "button";
      synthHost.style.position = "absolute";
      synthHost.style.opacity = "0";
      synthHost.style.pointerEvents = "none";
      synthHost.setAttribute("data-pf-action", "open-host");
      document.body.appendChild(synthHost);
      synthHost.click();
      setTimeout(function () { try { synthHost.remove(); } catch (_) {} }, 0);
    } catch (_) { /* nothing else we can do */ }
  }

  // Mirror the coop-lobbies busy state onto the mega button so the
  // spinner stays in sync even if a second tap fires while the first
  // POST is still in-flight (the bridge's `busy` flag guards re-entry
  // but the user's pointer doesn't know that).
  function installMegaBusyMirror() {
    if (typeof window === "undefined") return;
    if (window.__coopQuickHostBusyHook) return; // someone else owns it
    window.__coopQuickHostBusyHook = function (payload) {
      try {
        var btn = document.querySelector(
          '.pf-stage[data-pf-stage-bucket="a"] [data-pf-action="pf-host-tonight"]',
        );
        if (!btn) return;
        var busy = !!(payload && payload.busy);
        setMegaButtonBusy(btn, busy);
      } catch (_) { /* hook never throws */ }
    };
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

  // v196 — Options sheet anchored under the gear icon. Surfaces
  // Quiet match toggle + Alerts gear so stage A users can still
  // access them. Stage B/C duplicate the controls inline, so the
  // sheet is rarely opened there (it still works either way).
  function buildOptionsSheetHtml(quietOn) {
    return ''
      + '<div class="pf-stage-options-row">'
      +   '<label class="pf-stage-options-toggle">'
      +     '<input type="checkbox" data-pf-action="pf-toggle-quiet"' + (quietOn ? ' checked' : '') + '>'
      +     '<span class="pf-stage-quiet-track" aria-hidden="true"><span class="pf-stage-quiet-thumb"></span></span>'
      +     '<span class="pf-stage-options-toggle-text">'
      +       '<strong>Quiet match</strong>'
      +       '<small>No mic needed. I\u2019ll just listen.</small>'
      +     '</span>'
      +   '</label>'
      + '</div>'
      + '<button type="button" class="pf-stage-options-row pf-stage-options-row--btn" data-pf-action="open-alerts">'
      +   '<span class="pf-stage-options-row-icon" aria-hidden="true">\u2699\uFE0F</span>'
      +   '<span class="pf-stage-options-toggle-text">'
      +     '<strong>Alerts</strong>'
      +     '<small>GO countdown sounds &amp; notifications</small>'
      +   '</span>'
      + '</button>';
  }
  function toggleOptionsSheet(triggerEl) {
    var stage = document.querySelector(".pf-stage[data-pf-stage]");
    if (!stage) return;
    var sheet = stage.querySelector(".pf-stage-options-sheet");
    if (sheet && sheet.parentNode) {
      sheet.parentNode.removeChild(sheet);
      if (triggerEl) triggerEl.setAttribute("aria-expanded", "false");
      return;
    }
    sheet = document.createElement("div");
    sheet.className = "pf-stage-options-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Match options");
    sheet.innerHTML = buildOptionsSheetHtml(readQuiet());
    stage.appendChild(sheet);
    if (triggerEl) triggerEl.setAttribute("aria-expanded", "true");
    // Click-outside dismiss.
    function offClick(ev) {
      if (!sheet || !document.body.contains(sheet)) {
        document.removeEventListener("click", offClick, true);
        return;
      }
      if (sheet.contains(ev.target)) return;
      if (triggerEl && triggerEl.contains(ev.target)) return;
      try { sheet.parentNode.removeChild(sheet); } catch (_) {}
      if (triggerEl) triggerEl.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", offClick, true);
    }
    setTimeout(function () { document.addEventListener("click", offClick, true); }, 0);
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
    // v197 — mirror the coop-lobbies busy state onto the stage-A mega
    // CTA so the spinner appears synchronously when the POST is racing
    // KV. Idempotent; only installs once per page lifetime.
    installMegaBusyMirror();
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
      // v197 — stage A mega CTA. Two paths, branched on stage bucket:
      //
      //   Stage A (0 open lobbies) → ONE-TAP host. We bypass the
      //     3-step Host modal entirely and call window.__coopQuickHost
      //     .run() (routes to performQuickHostCreate in coop-lobbies.js
      //     with QUICK_HOST_DEFAULTS). The matchmaker card-flip
      //     animation still kicks off in parallel for visual polish
      //     (fire-and-forget; the POST runs unconditionally). On
      //     POST 200 the existing pipeline navigates to Party Hub.
      //     On {ok:false} we fall back to opening the standard Host
      //     modal so the user has a path forward.
      //
      //   Stages B/C → keep the existing open-host synth click. Those
      //     users have liquidity context and may want to customize.
      var hostMega = t.closest('[data-pf-action="pf-host-tonight"]');
      if (hostMega) {
        ev.preventDefault();
        ev.stopPropagation();
        var megaBucket = "";
        try {
          megaBucket = (document.documentElement.getAttribute("data-pf-stage-bucket") || "").toLowerCase();
        } catch (_) { megaBucket = ""; }
        if (megaBucket !== "a") {
          try {
            if (typeof window.gtag === "function") {
              window.gtag("event", "lobby_quick_host_click", { event_category: "coop_quick_host", mode: "host_tonight" });
            }
          } catch (_) {}
          // Stage B/C: synth a click on the hidden open-host button
          // so the modal opens with the existing 3-step wizard.
          var synthHost = document.createElement("button");
          synthHost.type = "button";
          synthHost.style.position = "absolute";
          synthHost.style.opacity = "0";
          synthHost.style.pointerEvents = "none";
          synthHost.setAttribute("data-pf-action", "open-host");
          document.body.appendChild(synthHost);
          try { synthHost.click(); } catch (_) {}
          setTimeout(function () { try { synthHost.remove(); } catch (_) {} }, 0);
          return;
        }
        // Stage A: one-tap host. Telemetry for the new path stays
        // separate from the modal-driven "lobby_quick_host_click"
        // event so the funnel split is visible in GA4.
        onStageAOneTapClick(hostMega);
        return;
      }
      // v196 — gear icon at top-right of hero. In stage A this is
      // the only entry point for Quiet match + Alerts. Pops a small
      // sheet directly below the gear with both controls.
      var gear = t.closest('[data-pf-action="pf-toggle-options-sheet"]');
      if (gear) {
        ev.preventDefault();
        ev.stopPropagation();
        toggleOptionsSheet(gear);
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

  // ── v196 — stage-aware bucketing + matchmaker animation ────────────
  //
  // Bucket the page by how many open rooms exist:
  //   a = 0 lobbies → minimal hero, page ends after Showtime
  //   b = 1-2       → simple "Open rooms" list under compact hero
  //   c = 3+        → full UI with Filter sheet, Best party recommendation
  //
  // We tag a single attribute on the .pf-stage element and on
  // document.documentElement so EVERY stylesheet on the page can react
  // (party-finder.css, party-finder-scale.css, party-finder-empty.css,
  // and the new rules in styles.css). One source of truth.
  function pfStageBucketForState(state) {
    var n = 0;
    try {
      if (state && Array.isArray(state.openLobbies)) {
        for (var i = 0; i < state.openLobbies.length; i++) {
          var l = state.openLobbies[i];
          if (!l) continue;
          if (l.status === "closed" || l.status === "expired") continue;
          n++;
        }
      }
    } catch (_) { /* defensive */ }
    if (n === 0) return "a";
    if (n <= 2) return "b";
    return "c";
  }
  function applyStageBucket(stage, bucket) {
    if (!stage) return;
    if (stage.getAttribute("data-pf-stage-bucket") !== bucket) {
      stage.setAttribute("data-pf-stage-bucket", bucket);
    }
    try {
      var html = document.documentElement;
      if (html.getAttribute("data-pf-stage-bucket") !== bucket) {
        html.setAttribute("data-pf-stage-bucket", bucket);
      }
    } catch (_) {}
  }
  // Expose to party-finder.js so its render gate (pf-best / pf-prefs /
  // pf-live) can read the same bucket without re-computing.
  try { window.__pfStageBucket = pfStageBucketForState; } catch (_) {}

  // Matchmaker animation — three flip-cards next to the CTA. ~1500ms
  // total. Honors prefers-reduced-motion (200ms simple fade).
  //
  // opts:
  //   - reason: "quick-play" | "host"
  //   - heroImage: URL of the third card's front face (host avatar /
  //                character art / user's chosen character)
  //   - heroLabel: alt text for the hero image
  //   - caption: optional caption replacing the default "Dealing your party…"
  //
  // Returns a Promise that resolves when the animation completes (or
  // when the reduced-motion fade ends). Callers should await this and
  // then run the network action (POST join / POST lobby) so the user
  // sees the cards flip *before* the page transition.
  function prefersReducedMotion() {
    try {
      return typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) { return false; }
  }
  function fireMatchmakerTelemetry(name, payload) {
    try {
      if (typeof window === "undefined") return;
      if (typeof window.gtag !== "function") return;
      window.gtag("event", name, { event_category: "coop_quick_host", ...(payload || {}) });
    } catch (_) { /* analytics never blocks the UI */ }
  }
  function ensureMatchmakerHost() {
    // The .pf-matchmaker element ships inside .pf-stage as part of
    // buildStageHtml. If it's missing (older session, scene hasn't
    // mounted), construct a body-level fallback so the animation
    // still runs above the page.
    var host = document.querySelector(".pf-stage [data-pf-matchmaker]");
    if (host) return host;
    host = document.createElement("div");
    host.className = "pf-matchmaker pf-matchmaker--portal";
    host.setAttribute("data-pf-matchmaker", "");
    host.setAttribute("aria-hidden", "true");
    host.hidden = true;
    document.body.appendChild(host);
    return host;
  }
  function paintMatchmakerFront(host, heroImage, heroLabel) {
    // Card index 2 is the reveal card. Card 1 gets a small sparkle.
    // Card 0 stays face-down for visual rhythm (audience misdirection,
    // STS-style).
    var revealFront = host.querySelector('[data-pf-card-front="2"]');
    if (revealFront) {
      if (heroImage) {
        revealFront.innerHTML = '<img alt="' + esc(heroLabel || "") + '" src="' + esc(heroImage) + '"'
          + ' onerror="this.style.display=\'none\'; var p=this.parentNode; if (p) p.classList.add(\'pf-matchmaker-card-face--fallback\');"/>';
      } else {
        revealFront.innerHTML = '';
        revealFront.classList.add("pf-matchmaker-card-face--fallback");
      }
    }
    var sparkleFront = host.querySelector('[data-pf-card-front="1"]');
    if (sparkleFront) {
      sparkleFront.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12 3v6"/><path d="M12 15v6"/><path d="M3 12h6"/><path d="M15 12h6"/>' +
          '<path d="M5.6 5.6l4.2 4.2"/><path d="M14.2 14.2l4.2 4.2"/>' +
          '<path d="M18.4 5.6l-4.2 4.2"/><path d="M9.8 14.2l-4.2 4.2"/>' +
        '</svg>';
    }
    var baseFront = host.querySelector('[data-pf-card-front="0"]');
    if (baseFront) baseFront.innerHTML = '';
  }
  function runMatchmakerAnimation(opts) {
    opts = opts || {};
    var reason = opts.reason || "unknown";
    var heroImage = opts.heroImage || "";
    var heroLabel = opts.heroLabel || "";
    var caption = opts.caption || "Dealing your party\u2026";
    var reduced = prefersReducedMotion();
    var host = ensureMatchmakerHost();
    if (!host) return Promise.resolve({ ran: false });
    var cap = host.querySelector("[data-pf-matchmaker-caption]");
    if (cap) cap.textContent = caption;
    paintMatchmakerFront(host, heroImage, heroLabel);
    host.hidden = false;
    host.setAttribute("aria-hidden", "false");
    host.setAttribute("data-pf-reduced", reduced ? "1" : "0");
    host.setAttribute("data-pf-reason", reason);
    // Force a reflow so the [data-running] flip catches the transition.
    // eslint-disable-next-line no-unused-expressions
    host.offsetWidth;
    host.setAttribute("data-running", "1");
    fireMatchmakerTelemetry("matchmaker_anim_start", { reason: reason, reduced: reduced ? 1 : 0 });
    var duration = reduced ? 200 : 1500;
    return new Promise(function (resolve) {
      setTimeout(function () {
        // Leave the reveal card visible for one extra beat so the
        // user reads what was revealed before navigation kicks in.
        // The caller decides when to actually navigate.
        fireMatchmakerTelemetry("matchmaker_anim_complete", { reason: reason, reduced: reduced ? 1 : 0 });
        host.removeAttribute("data-running");
        // Hide on a small delay so a follow-up navigation away
        // doesn't show a stray flash of cards. Best-effort.
        setTimeout(function () {
          try { host.hidden = true; host.setAttribute("aria-hidden", "true"); } catch (_) {}
        }, reduced ? 0 : 400);
        resolve({ ran: true, reduced: reduced });
      }, duration);
    });
  }
  // Expose to party-finder.js so its host-submit + join paths can
  // trigger the animation without us reaching back into scene.js
  // privately. Keep the signature small and stable.
  try {
    window.__pfMatchmaker = Object.freeze({
      run: runMatchmakerAnimation,
      prefersReduced: prefersReducedMotion,
    });
  } catch (_) {}

  function refreshHeroStage() {
    var stage = document.querySelector(".pf-stage[data-pf-stage]");
    if (!stage) return;
    var state = readState();
    if (!state) {
      // Even without state yet, default to bucket "a" so the page
      // doesn't paint with Quick Play visible until /coop/state
      // returns and tells us there's something to match into.
      applyStageBucket(stage, "a");
      return;
    }
    applyStageBucket(stage, pfStageBucketForState(state));
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

    // v197 — stage-A positive-presence framing. The legacy "0 online ·
    // 0 hosting · 0 looking" line read as dead-storefront on an empty
    // page. We reshape it into agency copy keyed on the online count,
    // toggled via the `data-pf-line-mode` attribute on the stats line:
    //   bucket A → mode="a" → presence span visible, counts hidden
    //   bucket B/C → mode="bc" → counts visible, presence span hidden
    try {
      var bucketNow = (document.documentElement.getAttribute("data-pf-stage-bucket") || "a").toLowerCase();
      var statsLine = stage.querySelector("[data-pf-stage-stats-line]");
      if (statsLine) {
        statsLine.setAttribute("data-pf-line-mode", bucketNow === "a" ? "a" : "bc");
        if (bucketNow === "a") {
          var presenceEl = statsLine.querySelector("[data-pf-stage-presence-line]");
          if (presenceEl) {
            var onlineNum = (typeof online === "number" && isFinite(online)) ? online : 0;
            var presenceHtml;
            if (onlineNum >= 3) {
              // Bold number, then quieter caps tail — single row, no boxes.
              presenceHtml =
                '<strong class="pf-presence-num">' + fmtCount(onlineNum) + '</strong>' +
                '<span class="pf-presence-msg"> players are around right now \u2014 be the first to open a room and we\u2019ll match them in.</span>';
            } else if (onlineNum === 1 || onlineNum === 2) {
              presenceHtml =
                '<strong class="pf-presence-num">A few</strong>' +
                '<span class="pf-presence-msg"> players are here right now \u2014 open a room and they\u2019ll see it instantly.</span>';
            } else {
              // No zero count visible — agency framing only.
              presenceHtml =
                '<span class="pf-presence-msg">Open a room and we\u2019ll ping the next player who shows up.</span>';
            }
            if (presenceEl.innerHTML !== presenceHtml) {
              presenceEl.innerHTML = presenceHtml;
            }
          }
        }
      }
    } catch (_) { /* presence line is decorative; never throw */ }

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
      // v196 — inline stats line. Reveal the " · N starting soon"
      // segment only when there is something starting; an inline
      // "0 starting" rolls into the rhythm of the line and gets read
      // as noise.
      var startingSeg = stage.querySelector("[data-pf-stage-stats-line-starting]");
      if (startingSeg) startingSeg.hidden = !(startingCount > 0);
    } catch (_) { /* best-effort */ }

    // Quick Play button label is state-aware: "Quick Play" /
    // "Reopen your lobby" / "Leave current party to host" / "Sign in
    // to host". Refresh on every poll so a host who closes their
    // lobby in another tab flips back to "Quick Play" without a
    // page reload.
    try { renderQuickPlayLabel(stage, resolveQuickPlayMode(state)); } catch (_) { /* defensive */ }

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

  // ── Host Run History Strip — REMOVED (v203 integrity fix) ────────
  // This strip ("⚔️ ▰▰▰▱▰▰ · 5W 1L · 83% Heart · 🔥 W3") was a seeded-RNG
  // placeholder synthesized from hostSteamId — the backend never ships
  // `hostRecentRuns`, so every host saw fabricated win/loss pips,
  // streaks, and finish percentages. Fabricated reputation data is an
  // integrity violation: the cards must only ever show REAL data, and
  // there is no public per-lobby run-history contract to show. The
  // honest host signal is the v198 LevelBadge (real tier + bucket from
  // /coop/reputation). The synth path, helpers (hashSeed/mulberry32),
  // and the decorator are intentionally gone — do NOT reintroduce a
  // placeholder/random stat here. When a real `hostRecentRuns` contract
  // ships, render it from that data only.

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

  // ── Host Reputation Card — REMOVED (v203 integrity fix) ──────────
  // This inline chip ("🏆 Lv 12 · 🎯 67 runs · ❤️ 12 Hearts · 89% finish")
  // was synthesized by a seeded RNG keyed on hostSteamId because the
  // backend never ships `lobby.hostStats`. Every host — including the
  // operator-seeded House lobbies and real players — showed stable but
  // ENTIRELY FABRICATED level/runs/hearts/finish numbers. Worse, it
  // contradicted the REAL v198 LevelBadge on the same card (chip said
  // "Lv 3 · 121 runs" while the badge popover said "Initiate · newcomer
  // · <5 parties").
  //
  // The public reputation contract (/coop/reputation/<sid>) is
  // intentionally privacy-bucketed: it exposes only `tier`, `badges[]`,
  // and `partiesCompletedBucket` — NOT raw run counts, hearts, or finish
  // %. So those numbers cannot be shown truthfully and must not be
  // shown at all. The honest, single source of truth is the v198
  // LevelBadge (party-finder-reputation-rt.js), which already mounts on
  // these rows via the `[data-pf-rep-slot]` annotation and renders the
  // real tier + popover. The synth chip is gone with no fallback — do
  // NOT reintroduce any synthesized/placeholder/random stat here.

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
      +     '<span class="pf-coop-log-flame" aria-hidden="true">' + ICON_FLAME + '</span> YOUR CAMPFIRE LOG'
      +     '<span class="pf-coop-log-dot" aria-hidden="true">\u00B7</span>'
      +     '<span class="pf-coop-log-persona" data-pf-stat="persona">Spirewalker</span>'
      +   '</div>'
      +   '<span class="pf-coop-log-chev" aria-hidden="true">\u203A</span>'
      + '</div>'
      + '<div class="pf-coop-log-stats">'
      +   '<div class="pf-coop-log-stat pf-coop-log-stat--lvl">'
      +     '<span class="pf-coop-log-stat-icon pf-coop-log-stat-icon--svg" aria-hidden="true">' + ICON_TROPHY + '</span>'
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
      +   '<div class="pf-coop-log-stat pf-coop-log-stat--parties">'
      +     '<span class="pf-coop-log-stat-icon pf-coop-log-stat-icon--svg" aria-hidden="true">' + ICON_SWORDS + '</span>'
      +     '<span class="pf-coop-log-stat-num" data-pf-stat="parties">0</span>'
      +     '<span class="pf-coop-log-stat-lbl">Parties</span>'
      +   '</div>'
      +   '<div class="pf-coop-log-stat pf-coop-log-stat--hearts">'
      +     '<span class="pf-coop-log-stat-icon pf-coop-log-stat-icon--svg" aria-hidden="true">' + ICON_HEART + '</span>'
      +     '<span class="pf-coop-log-stat-num" data-pf-stat="hearts">0</span>'
      +     '<span class="pf-coop-log-stat-lbl">Hearts</span>'
      +   '</div>'
      +   '<div class="pf-coop-log-stat pf-coop-log-stat--friends">'
      +     '<span class="pf-coop-log-stat-icon pf-coop-log-stat-icon--svg" aria-hidden="true">' + ICON_USERS + '</span>'
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
      +     '<div class="pf-mycoop-eyebrow"><span class="pf-mycoop-eyebrow-flame" aria-hidden="true">' + ICON_FLAME + '</span> YOUR CAMPFIRE LOG</div>'
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
    // v203: decorateHostRunStrips()/decorateHostReputation() removed —
    // they rendered fabricated seeded-RNG host stats. The real host
    // signal is the v198 LevelBadge (party-finder-reputation-rt.js).
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
