// party-finder-globals.js — Co-op Lobby Beta · classic-script helper bridge
// =========================================================================
// Loaded as a regular <script> (not type=module) so party-finder.js can
// reach these renderers through window.PFH without an ES import. Defines
// the visual atoms used by the Best Party hero card and Live Party rows:
//   • renderSlotStrip     — character-avatar party slot strip
//   • branchPillHtml      — color-coded branch pill (beta / main / both)
//   • modePillHtml        — mode pill (Standard / Daily / Custom)
//   • ascensionPillHtml   — ascension bucket pill (A0-A3 … A10)
//   • goalPillHtml        — goal pill (Heart / Daily / Learning / …)
//   • voicePillHtml       — voice pill (LFG / Flexible / None)
//   • micPillHtml         — mic pill (preferred / no mic / no mic okay)
//   • discordDeepLink     — convert https://discord.com/channels/<g>/<c>
//                           into a desktop deep link
//   • buildDiscordLfgPost — markdown-friendly LFG post text
//
// Domain lock: STS2 only. Roster is Ironclad / Silent / Defect /
// Necrobinder / Regent. Ascension caps at 10. Branch values are limited
// to beta / main / both. Need-count copy renders as "Need +N".
// =========================================================================

(function attachPFH(globalRoot) {
  if (!globalRoot) return;
  var existing = globalRoot.PFH;
  if (existing && existing.__sealed) return;

  // Discord server constants for the public Slay the Spire 2 LFG community.
  // The invite URL is the fallback we open when a joiner isn't yet in the
  // server — Discord shows them "Accept Invite" then drops them in.
  //
  // The channel map lets the Host modal offer real LFG voice channels by
  // name (LFG 1 / LFG 2 / LFG 3) and turns those preset IDs into real
  // discord:// deep links instead of typed labels.
  //
  // Channel IDs are intentionally placeholders here — fill them in once you
  // have admin/owner consent on the STS2 LFG server (right-click channel →
  // "Copy Channel ID" with Developer Mode on). Until then we fall back to
  // the server invite, which still beats the dead-link experience.
  var STS2_DISCORD_INVITE_URL = 'https://discord.gg/slaythespire';
  var STS2_DISCORD_CHANNELS = {
    // preset id  →  full channel URL or invite URL (whatever we have today)
    lfg1: STS2_DISCORD_INVITE_URL,
    lfg2: STS2_DISCORD_INVITE_URL,
    lfg3: STS2_DISCORD_INVITE_URL,
    lfg4: STS2_DISCORD_INVITE_URL,
    lfg5: STS2_DISCORD_INVITE_URL,
    lfg6: STS2_DISCORD_INVITE_URL,
  };
  globalRoot.STS2_DISCORD_INVITE_URL = STS2_DISCORD_INVITE_URL;
  globalRoot.STS2_DISCORD_CHANNELS = STS2_DISCORD_CHANNELS;

  var CHAR_IDS = { ironclad: 1, silent: 1, defect: 1, necrobinder: 1, regent: 1 };
  var CHAR_LABEL = {
    ironclad: 'Ironclad',
    silent: 'Silent',
    defect: 'Defect',
    necrobinder: 'Necrobinder',
    regent: 'Regent',
  };

  function esc(s) {
    var str = s == null ? '' : String(s);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeCharId(v) {
    var id = String(v || '').trim().toLowerCase();
    return CHAR_IDS[id] ? id : '';
  }
  function charLabel(id) {
    return CHAR_LABEL[normalizeCharId(id)] || '';
  }
  function charAsset(id) {
    var slug = normalizeCharId(id);
    return slug ? '/assets/sts2/characters/' + slug + '-v2.webp' : '';
  }

  function ascBucketLabel(min, max) {
    if (min == null && max == null) return 'Any level';
    var lo = Math.max(0, min == null ? 0 : min);
    var hi = Math.min(10, max == null ? 10 : max);
    if (lo === 10 && hi === 10) return 'A10';
    if (lo === 0 && hi === 10) return 'Any level';
    if (lo === 0 && hi === 3) return 'A0-A3';
    if (lo === 4 && hi === 7) return 'A4-A7';
    if (lo === 8 && hi === 10) return 'A8-A10';
    if (lo === hi) return 'A' + lo;
    return 'A' + lo + '-A' + hi;
  }

  function modeLabel(l) {
    var m = String((l && l.mode) || 'standard').toLowerCase();
    if (m === 'daily') return 'Daily';
    if (m === 'custom') return 'Custom';
    return 'Standard';
  }

  function goalLabel(g) {
    var m = String(g || 'any').toLowerCase();
    if (m === 'heart' || m === 'a20') return 'Heart Attempt';
    if (m === 'daily') return 'Daily';
    if (m === 'learning') return 'Learning';
    if (m === 'casual' || m === 'climb') return 'Chill climb';
    if (m === 'high') return 'High Ascension';
    return 'Any run';
  }

  function voicePresetOf(l) {
    return String((l && l.voicePreset) || 'any').toLowerCase();
  }

  function voiceLabelOf(l) {
    var p = voicePresetOf(l);
    if (p === 'none') return 'No voice needed';
    if (p === 'any') return 'Voice flexible';
    if (p === 'lfg1') return 'LFG 1';
    if (p === 'lfg_duo3') return 'LFG 3';
    var num = /^lfg(\d)$/.exec(p);
    if (num) return 'LFG ' + num[1];
    if (p === 'custom' && l && l.voiceChannelUrl) return l.voiceChannelUrl;
    return 'Voice flexible';
  }

  function micLabel(pref) {
    var p = String(pref || 'optional').toLowerCase();
    if (p === 'yes') return 'Mic preferred';
    if (p === 'no') return 'Quiet \u2014 no mic';
    return 'Mic optional';
  }

  function branchIdOf(l) {
    var hay = (((l && l.title) || '') + ' ' + ((l && l.note) || '')).toLowerCase();
    if (/main or beta|beta or main/.test(hay)) return 'both';
    if (/beta branch|on beta\b/.test(hay)) return 'beta';
    if (/main branch|on main\b/.test(hay)) return 'main';
    var sid = (l && l.lobbyId) || '';
    var h = 0;
    for (var i = 0; i < sid.length; i++) {
      h = ((h * 31) + sid.charCodeAt(i)) | 0;
    }
    var bucket = Math.abs(h) % 3;
    if (bucket === 0) return 'beta';
    if (bucket === 1) return 'both';
    return 'main';
  }

  function branchPillHtml(l) {
    var id = branchIdOf(l);
    var cls;
    var label;
    if (id === 'main') {
      cls = 'pf-pill--branch-main';
      label = 'Main branch';
    } else if (id === 'both') {
      cls = 'pf-pill--branch-both';
      label = 'Main or Beta';
    } else {
      cls = 'pf-pill--branch-beta';
      label = 'Beta branch';
    }
    return '<span class="pf-pill ' + cls + '">' + esc(label) + '</span>';
  }

  function modePillHtml(l) {
    return '<span class="pf-pill pf-pill--mode">' + esc(modeLabel(l)) + '</span>';
  }

  function ascensionPillHtml(l) {
    return (
      '<span class="pf-pill pf-pill--asc">' +
      esc(ascBucketLabel(l && l.ascensionMin, l && l.ascensionMax)) +
      '</span>'
    );
  }

  function goalPillHtml(l) {
    return '<span class="pf-pill pf-pill--goal">' + esc(goalLabel(l && l.goal)) + '</span>';
  }

  function voicePillHtml(l) {
    var preset = voicePresetOf(l);
    var cls = preset === 'none' ? 'pf-pill--voice-none' : 'pf-pill--voice';
    return (
      '<span class="pf-pill ' + cls + '" title="Voice">' +
      esc(voiceLabelOf(l)) +
      '</span>'
    );
  }

  function micPillHtml(pref) {
    var p = String(pref || 'optional').toLowerCase();
    var cls = p === 'yes' ? 'pf-pill--mic-yes' : 'pf-pill--mic-no';
    return '<span class="pf-pill ' + cls + '">' + esc(micLabel(pref)) + '</span>';
  }

  function lobbyMembers(l) {
    if (!l) return [];
    var a = l.acceptedMemberSteamIds;
    if (a && a.length) return a;
    return l.hostSteamId ? [l.hostSteamId] : [];
  }
  function lobbySize(l) {
    var n = l && l.lobbySize;
    return n === 2 || n === 3 || n === 4 ? n : 4;
  }
  function hostChar(l) {
    var ids = (l && l.preferredCharacters) || [];
    for (var i = 0; i < ids.length; i++) {
      var id = normalizeCharId(ids[i]);
      if (id) return id;
    }
    return '';
  }

  function renderSlotStrip(l, state) {
    var cap = lobbySize(l);
    var members = lobbyMembers(l);
    var host = hostChar(l);
    var pref = ((l && l.preferredCharacters) || []).slice(1).map(normalizeCharId);
    var mySid = state && state.presence && state.presence.steamId;
    var html = '';

    var hostImg = host
      ? '<img class="pf-slot-img" src="' + esc(charAsset(host)) + '" alt="" />'
      : '';
    var hostName = (l && l.hostPersonaName) || 'Host';
    html +=
      '<div class="pf-slot pf-slot--host" title="Host: ' + esc(hostName) + '">' +
      hostImg +
      '<span class="pf-slot-tag">Host</span>' +
      '</div>';

    for (var i = 1; i < cap; i++) {
      if (i < members.length) {
        var sid = members[i];
        var isMe = sid && sid === mySid;
        var cls = isMe ? 'pf-slot--mine' : 'pf-slot--joined';
        var tag = isMe ? 'You' : 'In';
        var ttl = isMe ? 'You' : 'Joined';
        html +=
          '<div class="pf-slot ' + cls + '" title="' + ttl + '">' +
          '<span class="pf-slot-tag">' + tag + '</span></div>';
      } else {
        var openPref = pref[i - 1];
        var img = openPref
          ? '<img class="pf-slot-img" src="' + esc(charAsset(openPref)) +
            '" alt="" style="opacity:.45;filter:grayscale(.6)" />'
          : '';
        var lbl = openPref ? charLabel(openPref) : 'Open';
        html +=
          '<div class="pf-slot pf-slot--open" title="Open seat — ' + esc(lbl) + '">' +
          img + '</div>';
      }
    }
    return '<div class="pf-slots" aria-label="Party slots">' + html + '</div>';
  }

  function discordDeepLink(url) {
    var raw = String(url || '').trim();
    if (!raw) return '';
    var m = /discord\.com\/channels\/(\d+)\/(\d+)/.exec(raw);
    if (m) return 'discord://discord.com/channels/' + m[1] + '/' + m[2];
    return raw;
  }

  function buildDiscordLfgPost(opts) {
    opts = opts || {};
    var mode = opts.mode || 'Standard';
    var goal = opts.goal || 'Any run';
    var asc = opts.ascension || 'Any level';
    var filled = typeof opts.filled === 'number' ? opts.filled : 1;
    var size = typeof opts.size === 'number' ? opts.size : 4;
    var need = Math.max(0, size - filled);
    var host = opts.host || 'Host';
    var voice = opts.voice || 'Voice flexible';
    var voiceUrl = opts.voiceUrl || '';
    var link = opts.deepLink || '';
    var voiceLine = voiceUrl ? 'Voice: ' + voice + ' ' + voiceUrl : 'Voice: ' + voice;
    var needLine = need > 0 ? 'Need +' + need : 'Full';
    // If we have a lobby in opts (preferred) decode its note via the
    // shared start-soon API. Callers that don't pass a lobby can also
    // pass plannedAt/isWhenFull directly. The output uses Discord's
    // native <t:UNIX:R> tag so the channel renders a live countdown.
    var plannedAt = opts.plannedAt || null;
    var isWhenFull = !!opts.isWhenFull;
    if (!plannedAt && !isWhenFull && opts.lobby && globalRoot.__pfStartSoon) {
      var d = globalRoot.__pfStartSoon.decode(opts.lobby.note);
      plannedAt = d.plannedAt;
      isWhenFull = d.isWhenFull;
    }
    var startLine = '';
    if (plannedAt instanceof Date && !isNaN(plannedAt.getTime())) {
      var unix = Math.floor(plannedAt.getTime() / 1000);
      startLine = 'Starts <t:' + unix + ':R> (<t:' + unix + ':t> your time)';
    } else if (isWhenFull) {
      startLine = 'Starts the moment we fill — claim a seat fast.';
    }
    var lines = [
      'STS2 ' + mode + ' · ' + goal + ' · ' + asc + ' · ' + filled + '/' + size + ' · ' + needLine,
      'Host: ' + host,
      voiceLine,
    ];
    if (startLine) lines.push(startLine);
    if (link) lines.push('Join on SpireVault: ' + link);
    return lines.join('\n');
  }

  function chipWithCharAvatarHtml(charId) {
    var slug = normalizeCharId(charId);
    var label = slug ? charLabel(slug) : 'Open to any';
    var img = slug
      ? '<img class="pf-pref-chip-img" src="' + esc(charAsset(slug)) + '" alt=""/>'
      : '';
    return (
      '<li class="pf-pref-chip">' + img +
      '<span class="pf-pref-chip-key">Character</span>' +
      '<span>' + esc(label) + '</span></li>'
    );
  }

  globalRoot.PFH = {
    __sealed: true,
    esc: esc,
    charLabel: charLabel,
    charAsset: charAsset,
    normalizeCharId: normalizeCharId,
    ascBucketLabel: ascBucketLabel,
    modeLabel: modeLabel,
    goalLabel: goalLabel,
    voiceLabelOf: voiceLabelOf,
    micLabel: micLabel,
    branchPillHtml: branchPillHtml,
    modePillHtml: modePillHtml,
    ascensionPillHtml: ascensionPillHtml,
    goalPillHtml: goalPillHtml,
    voicePillHtml: voicePillHtml,
    micPillHtml: micPillHtml,
    renderSlotStrip: renderSlotStrip,
    discordDeepLink: discordDeepLink,
    buildDiscordLfgPost: buildDiscordLfgPost,
    chipWithCharAvatarHtml: chipWithCharAvatarHtml,
    parseIsoMs: typeof parseIsoMs === 'function' ? parseIsoMs : null,
    findLobbyById: typeof findLobbyById === 'function' ? findLobbyById : null,
  };

  // Also bridge to direct globals so party-finder.js (loaded as an ES
  // module) can resolve them via the global scope without an import.
  // Module identifier lookup falls through module → global, so a bare
  // `branchPillHtml(best)` call in party-finder.js will land here.
  globalRoot.branchPillHtml = branchPillHtml;
  globalRoot.modePillHtml = modePillHtml;
  globalRoot.ascensionPillHtml = ascensionPillHtml;
  globalRoot.goalPillHtml = goalPillHtml;
  globalRoot.voicePillHtml = voicePillHtml;
  globalRoot.micPillHtml = micPillHtml;
  globalRoot.renderSlotStrip = renderSlotStrip;
  globalRoot.discordDeepLink = discordDeepLink;
  globalRoot.buildDiscordLfgPost = buildDiscordLfgPost;

  // ── Discord server registry ──────────────────────────────────────────
  // Multi-server support: each entry has an invite URL plus the labels
  // for the six standard LFG voice slots. The host modal picker swaps
  // which set of labels the Voice chiprow displays. Selected server is
  // persisted in localStorage so subsequent hosts default to it.
  //
  // To add a real server: paste its discord.gg invite into `invite` and
  // override `voiceLabels`/`voiceUrls` if it uses different channel
  // names. The `lfg1`-`lfg6` keys must stay aligned with the backend's
  // voicePreset enum.
  var DISCORD_SERVERS = {
    'sts2-lfg': {
      id: 'sts2-lfg',
      name: 'Slay the Spire 2 LFG',
      subtitle: 'Beta + main, dedicated LFG voice rooms',
      invite: 'https://discord.gg/slaythespire',
      voiceLabels: { lfg1: 'LFG 1', lfg2: 'LFG 2', lfg3: 'LFG 3', lfg4: 'LFG 4', lfg5: 'LFG 5', lfg6: 'LFG 6' },
      voiceUrls: {},
    },
    'sts-main': {
      id: 'sts-main',
      name: 'Slay the Spire',
      subtitle: 'Original community server',
      invite: 'https://discord.gg/slaythespire',
      voiceLabels: { lfg1: 'Co-op 1', lfg2: 'Co-op 2', lfg3: 'Co-op 3', lfg4: 'Co-op 4', lfg5: 'Co-op 5', lfg6: 'Co-op 6' },
      voiceUrls: {},
    },
    'custom': {
      id: 'custom',
      name: 'Your own server',
      subtitle: 'Paste a Discord invite \u2014 we\u2019ll use it instead.',
      invite: '',
      voiceLabels: { lfg1: 'Voice 1', lfg2: 'Voice 2', lfg3: 'Voice 3', lfg4: 'Voice 4', lfg5: 'Voice 5', lfg6: 'Voice 6' },
      voiceUrls: {},
    },
  };
  var LS_DISCORD_SERVER = 'vault.coop.discordServer';
  function getActiveDiscordServerId() {
    try {
      var raw = localStorage.getItem(LS_DISCORD_SERVER);
      if (raw && DISCORD_SERVERS[raw]) return raw;
    } catch (e) { /* ignore */ }
    return 'sts2-lfg';
  }
  function setActiveDiscordServerId(id) {
    if (!DISCORD_SERVERS[id]) return;
    try { localStorage.setItem(LS_DISCORD_SERVER, id); } catch (e) { /* ignore */ }
  }
  globalRoot.DISCORD_SERVERS = DISCORD_SERVERS;
  globalRoot.getActiveDiscordServerId = getActiveDiscordServerId;

  // ── Host modal: step titles + rich review + server picker ────────────
  // We can't easily edit party-finder.js, so this observer watches the
  // host modal's body and stepper and enhances them after render:
  //   1. Mutates the modal H3 + subtitle per step (Run / Party / Review)
  //   2. Step 2: injects a Discord server picker above the Voice chips
  //              and re-labels the voice chips to match the active server
  //   3. Step 3: replaces the flat preview with a rich card preview that
  //              looks like a live-party row (character art + pills +
  //              slot strip).
  var STEP_TITLES = [
    null,
    { title: 'Set up your run', subtitle: 'Pick the run type so the right people see your room.' },
    { title: 'Pick your party', subtitle: 'Choose your character and which voice room you\u2019ll use.' },
    { title: 'Review your room', subtitle: 'This is what other players will see in the Live Parties list.' },
  ];

  function currentHostStep() {
    var stepper = document.getElementById('pf-host-stepper');
    if (!stepper) return 0;
    var active = stepper.querySelector('.pf-step--active');
    var num = active && active.querySelector('.pf-step-num');
    var n = parseInt(num && num.textContent, 10);
    return n > 0 ? n : 0;
  }

  function applyHostModalTitle() {
    var n = currentHostStep();
    var meta = STEP_TITLES[n];
    if (!meta) return;
    var titleEl = document.getElementById('pf-modal-host-title');
    if (!titleEl) return;
    if (titleEl.textContent !== meta.title) titleEl.textContent = meta.title;
    var subEl = titleEl.parentElement && titleEl.parentElement.querySelector('p');
    if (subEl && subEl.textContent !== meta.subtitle) subEl.textContent = meta.subtitle;
  }

  function reverseCharLookup(label) {
    var s = String(label || '').trim().toLowerCase();
    if (CHAR_LABEL.ironclad.toLowerCase() === s) return 'ironclad';
    if (CHAR_LABEL.silent.toLowerCase() === s) return 'silent';
    if (CHAR_LABEL.defect.toLowerCase() === s) return 'defect';
    if (CHAR_LABEL.necrobinder.toLowerCase() === s) return 'necrobinder';
    if (CHAR_LABEL.regent.toLowerCase() === s) return 'regent';
    return '';
  }

  function parseBranchFromLabel(label) {
    var s = String(label || '').toLowerCase();
    if (s.indexOf('beta') >= 0 && s.indexOf('main') >= 0) return 'both';
    if (s.indexOf('beta') >= 0) return 'beta';
    if (s.indexOf('main') >= 0) return 'main';
    return 'beta';
  }

  function pillForBranchLabel(label) {
    var id = parseBranchFromLabel(label);
    var cls = id === 'main' ? 'pf-pill--branch-main'
            : id === 'both' ? 'pf-pill--branch-both'
            : 'pf-pill--branch-beta';
    return '<span class="pf-pill ' + cls + '">' + esc(label) + '</span>';
  }
  function pillFor(cls, text) {
    return '<span class="pf-pill ' + cls + '">' + esc(text) + '</span>';
  }

  function enhanceHostReview() {
    var preview = document.querySelector('#pf-host-body .pf-host-preview');
    if (!preview || preview.getAttribute('data-pf-review-enhanced') === '1') return;
    var titleEl = preview.querySelector('h4');
    var attrsEls = preview.querySelectorAll('.pf-host-preview-attrs');
    var subs = preview.querySelectorAll('.pf-host-preview-sub');
    if (!titleEl || attrsEls.length < 2) return;

    var title = titleEl.textContent || '';
    var line1 = attrsEls[0] ? attrsEls[0].querySelectorAll('span:not(.pf-sep)') : [];
    var branchLabel = line1[0] && line1[0].textContent || 'Beta branch';
    var modeLabel = line1[1] && line1[1].textContent || 'Standard';
    var ascLabel = line1[2] && line1[2].textContent || 'Any level';
    var goalLabel = line1[3] && line1[3].textContent || 'Heart Attempt';

    var voiceText = (attrsEls[1] && attrsEls[1].textContent) || '';
    var voiceMatch = /Voice:\s*([^\u00b7]+)/.exec(voiceText);
    var voiceLabel = voiceMatch ? voiceMatch[1].trim() : 'Voice flexible';
    var micLabel = '';
    var voiceParts = voiceText.split('\u00b7');
    if (voiceParts.length >= 2) micLabel = voiceParts[1].trim();
    if (!micLabel) micLabel = 'Mic optional';

    var hostChar = '';
    var charLine = '';
    var fillText = '';
    var noteText = '';
    for (var i = 0; i < subs.length; i++) {
      var t = subs[i].textContent || '';
      if (/^Characters:/i.test(t)) {
        var m = /Host on\s+([A-Za-z]+)/i.exec(t);
        if (m) hostChar = m[1];
        var rest = t.split('\u00b7');
        if (rest.length >= 2) charLine = rest[1].trim();
      } else if (/\bfilled\b/.test(t)) {
        fillText = t.trim();
      } else if (subs[i].tagName === 'P') {
        noteText = t.replace(/^[\u201c"]|[\u201d"]$/g, '').trim();
      }
    }
    var sizeMatch = /1 of (\d+) filled/.exec(fillText);
    var size = sizeMatch ? Math.min(4, Math.max(2, parseInt(sizeMatch[1], 10))) : 4;

    var charSlug = reverseCharLookup(hostChar);
    var artHtml = charSlug
      ? '<img src="' + esc(charAsset(charSlug)) + '" alt="" />'
      : '<div class="pf-host-review-anyart">Any<br/>character</div>';

    // Build a slot strip preview: HOST + (size - 1) open seats.
    var slotsHtml = '<div class="pf-slots" aria-label="Party preview">';
    slotsHtml += '<div class="pf-slot pf-slot--host" title="You (Host)">' +
      (charSlug ? '<img class="pf-slot-img" src="' + esc(charAsset(charSlug)) + '" alt="" />' : '') +
      '<span class="pf-slot-tag">Host</span></div>';
    for (var k = 1; k < size; k++) {
      slotsHtml += '<div class="pf-slot pf-slot--open" title="Open seat"></div>';
    }
    slotsHtml += '</div>';

    var voiceCls = /no voice/i.test(voiceLabel) ? 'pf-pill--voice-none' : 'pf-pill--voice';
    var micCls = /mic preferred/i.test(micLabel) ? 'pf-pill--mic-yes' : 'pf-pill--mic-no';

    var html = '' +
      '<article class="pf-host-review">' +
        '<div class="pf-host-review-art">' + artHtml +
          (charSlug ? '<span class="pf-host-review-arttag">' + esc(CHAR_LABEL[charSlug]) + '</span>' : '') +
        '</div>' +
        '<div class="pf-host-review-body">' +
          '<span class="pf-eyebrow">Your room \u2014 live preview</span>' +
          '<h4 class="pf-host-review-title">' + esc(title) + '</h4>' +
          '<div class="pf-attrs pf-attrs--pills">' +
            pillForBranchLabel(branchLabel) +
            pillFor('pf-pill--mode', modeLabel) +
            pillFor('pf-pill--asc', ascLabel) +
            pillFor('pf-pill--goal', goalLabel) +
          '</div>' +
          '<div class="pf-attrs pf-attrs--pills">' +
            pillFor(voiceCls, voiceLabel) +
            pillFor(micCls, micLabel) +
          '</div>' +
          slotsHtml +
          '<div class="pf-host-review-fill">1 of ' + size + ' filled \u00b7 ' + (size - 1) + ' open seats \u00b7 ' + esc(charLine || 'Any character welcome') + '</div>' +
          (noteText ? '<p class="pf-host-review-note">\u201c' + esc(noteText) + '\u201d</p>' : '') +
        '</div>' +
      '</article>';

    preview.outerHTML = html;
  }

  function enhanceVoiceServerPicker() {
    var body = document.getElementById('pf-host-body');
    if (!body) return;
    var voiceField = null;
    var fields = body.querySelectorAll('.pf-field');
    for (var i = 0; i < fields.length; i++) {
      var lbl = fields[i].querySelector('.pf-field-label');
      if (lbl && /^voice$/i.test((lbl.textContent || '').trim())) {
        voiceField = fields[i];
        break;
      }
    }
    if (!voiceField) return;
    if (voiceField.getAttribute('data-pf-server-injected') === '1') {
      relabelVoiceChips(voiceField);
      return;
    }
    var activeId = getActiveDiscordServerId();
    var serverIds = Object.keys(DISCORD_SERVERS);
    var pickerHtml = '<div class="pf-field pf-field--server" data-pf-server-picker>' +
      '<span class="pf-field-label">Voice server</span>' +
      '<div class="pf-server-row">';
    for (var s = 0; s < serverIds.length; s++) {
      var sid = serverIds[s];
      var srv = DISCORD_SERVERS[sid];
      var active = sid === activeId;
      pickerHtml += '<button type="button" class="pf-server-btn ' + (active ? 'is-active' : '') + '" data-pf-server="' + esc(sid) + '">' +
        '<span class="pf-server-btn-name">' + esc(srv.name) + '</span>' +
        '<span class="pf-server-btn-sub">' + esc(srv.subtitle) + '</span>' +
        '</button>';
    }
    pickerHtml += '</div></div>';
    voiceField.insertAdjacentHTML('beforebegin', pickerHtml);
    voiceField.setAttribute('data-pf-server-injected', '1');
    relabelVoiceChips(voiceField);
  }

  function relabelVoiceChips(voiceField) {
    var activeId = getActiveDiscordServerId();
    var srv = DISCORD_SERVERS[activeId];
    if (!srv) return;
    var chips = voiceField.querySelectorAll('.pf-chip-btn[data-value]');
    for (var i = 0; i < chips.length; i++) {
      var v = chips[i].getAttribute('data-value');
      if (!v || !srv.voiceLabels[v]) continue;
      // Only mutate when the label actually differs; an unconditional
      // assignment fires a mutation event each call, which feeds back
      // into our parent MutationObserver and loops forever.
      if (chips[i].textContent !== srv.voiceLabels[v]) {
        chips[i].textContent = srv.voiceLabels[v];
      }
    }
  }

  // Delegate clicks on the server picker so a single handler covers all
  // re-renders of the modal body.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.pf-server-btn[data-pf-server]') : null;
    if (!btn) return;
    var id = btn.getAttribute('data-pf-server');
    if (!id || !DISCORD_SERVERS[id]) return;
    setActiveDiscordServerId(id);
    var row = btn.parentElement;
    if (row) {
      var siblings = row.querySelectorAll('.pf-server-btn');
      for (var i = 0; i < siblings.length; i++) siblings[i].classList.remove('is-active');
    }
    btn.classList.add('is-active');
    var body = document.getElementById('pf-host-body');
    if (body) {
      var fields = body.querySelectorAll('.pf-field');
      for (var j = 0; j < fields.length; j++) {
        var lbl = fields[j].querySelector('.pf-field-label');
        if (lbl && /^voice$/i.test((lbl.textContent || '').trim())) {
          relabelVoiceChips(fields[j]);
          break;
        }
      }
    }
  }, false);

  // ── Live preview side panel (steps 1 + 2) ────────────────────────────
  // Builds a sticky "Your room so far" card on the right of the host
  // modal that updates as the host clicks chips. Step 3 already shows
  // the full review so the side panel only renders for steps 1 & 2.
  function readActiveChip(radio) {
    var body = document.getElementById('pf-host-body');
    if (!body) return '';
    var row = body.querySelector('.pf-chiprow[data-pf-radio="' + radio + '"]');
    if (!row) return '';
    var active = row.querySelector('.pf-chip-btn.is-active');
    return active ? (active.getAttribute('data-value') || '') : '';
  }
  function readActiveChipLabel(radio, fallback) {
    var body = document.getElementById('pf-host-body');
    if (!body) return fallback || '';
    var row = body.querySelector('.pf-chiprow[data-pf-radio="' + radio + '"]');
    if (!row) return fallback || '';
    var active = row.querySelector('.pf-chip-btn.is-active');
    return active ? (active.textContent || '').trim() : (fallback || '');
  }
  function readActiveCharBtn() {
    var body = document.getElementById('pf-host-body');
    if (!body) return '';
    var grid = body.querySelector('.pf-char-grid');
    if (!grid) return '';
    var active = grid.querySelector('.pf-char-btn.is-active[data-value]');
    return active ? (active.getAttribute('data-value') || '') : '';
  }

  function buildSidePanelHtml(step) {
    // The Room title <input> only exists in step 1's DOM. Cache the
    // last seen value on the global root so steps 2 + 3 can still echo
    // it in the live preview instead of falling back to a placeholder.
    var titleInput = document.getElementById('pf-host-title');
    if (titleInput && titleInput.value != null) {
      globalRoot.__pfLastHostTitle = titleInput.value.trim();
    }
    var cached = globalRoot.__pfLastHostTitle || '';
    var title = cached || 'Set up your run \u2014 it\u2019ll auto-name itself';
    var branchId = readActiveChip('branch') || 'beta';
    var branchLabel = readActiveChipLabel('branch', 'Beta branch');
    var modeLabel = readActiveChipLabel('mode', 'Standard');
    var ascLabel = readActiveChipLabel('ascensionBucket', 'Any level');
    var goalLabel = readActiveChipLabel('goal', 'Heart');
    var sizeRaw = readActiveChip('lobbySize') || '4';
    var size = Math.max(2, Math.min(4, parseInt(sizeRaw, 10) || 4));
    var voiceId = readActiveChip('voice') || '';
    var voiceLabel = voiceId ? readActiveChipLabel('voice', 'Voice flexible') : 'Voice flexible';
    var voiceCls = voiceId === 'none' ? 'pf-pill--voice-none' : 'pf-pill--voice';
    var micId = readActiveChip('mic') || '';
    var micLabel = micId ? readActiveChipLabel('mic', 'Mic optional') : 'Mic optional';
    var micCls = micId === 'yes' ? 'pf-pill--mic-yes' : 'pf-pill--mic-no';
    var charSlug = readActiveCharBtn();

    var branchCls = branchId === 'main' ? 'pf-pill--branch-main'
                  : branchId === 'both' ? 'pf-pill--branch-both'
                  : 'pf-pill--branch-beta';

    var rosterSlugs = ['ironclad', 'silent', 'defect', 'necrobinder', 'regent'];
    var artHtml;
    if (charSlug) {
      artHtml =
        '<img src="' + esc(charAsset(charSlug)) + '" alt="" />' +
        '<span class="pf-host-side-art-tag">' + esc(CHAR_LABEL[charSlug] || '') + '</span>';
    } else {
      // No character picked yet → render an animated roster carousel
      // so the slot teases the 5 STS2 heroes the user will pick from.
      // Each silhouette fades in/out on a 12s loop (2.4s each), so the
      // empty state still feels alive and game-y.
      var carousel = '';
      for (var ci = 0; ci < rosterSlugs.length; ci++) {
        carousel +=
          '<img class="pf-host-side-roster-img" data-pf-roster-i="' + ci + '" ' +
          'src="' + esc(charAsset(rosterSlugs[ci])) + '" alt="" />';
      }
      artHtml =
        '<div class="pf-host-side-roster" data-pf-roster>' + carousel +
          '<div class="pf-host-side-roster-overlay">' +
            '<span class="pf-host-side-roster-eyebrow">Step 2 unlocks</span>' +
            '<span class="pf-host-side-roster-title">Pick your hero</span>' +
            '<span class="pf-host-side-roster-dots">' +
              '<span></span><span></span><span></span><span></span><span></span>' +
            '</span>' +
          '</div>' +
        '</div>';
    }

    var slotsHtml = '<div class="pf-slots pf-host-side-slots" aria-label="Party preview">';
    slotsHtml += '<div class="pf-slot pf-slot--host">' +
      (charSlug ? '<img class="pf-slot-img" src="' + esc(charAsset(charSlug)) + '" alt="" />' : '') +
      '<span class="pf-slot-tag">Host</span></div>';
    for (var k = 1; k < size; k++) {
      slotsHtml += '<div class="pf-slot pf-slot--open"></div>';
    }
    slotsHtml += '</div>';

    var pillsLine2 = (step >= 2)
      ? '<div class="pf-host-side-pills">' +
          '<span class="pf-pill ' + voiceCls + '">' + esc(voiceLabel) + '</span>' +
          '<span class="pf-pill ' + micCls + '">' + esc(micLabel) + '</span>' +
        '</div>'
      : '';

    var live = '<span class="pf-host-side-update is-live">Live</span>';
    return '' +
      '<aside class="pf-host-side" data-pf-host-side>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
          '<span class="pf-host-side-eyebrow">Your room \u2014 live preview</span>' +
          live +
        '</div>' +
        '<div class="pf-host-side-art">' + artHtml + '</div>' +
        '<div class="pf-host-side-title">' + esc(title) + '</div>' +
        '<div class="pf-host-side-pills">' +
          '<span class="pf-pill ' + branchCls + '">' + esc(branchLabel) + '</span>' +
          '<span class="pf-pill pf-pill--mode">' + esc(modeLabel) + '</span>' +
          '<span class="pf-pill pf-pill--asc">' + esc(ascLabel) + '</span>' +
          '<span class="pf-pill pf-pill--goal">' + esc(goalLabel) + '</span>' +
        '</div>' +
        pillsLine2 +
        slotsHtml +
        '<div class="pf-host-side-foot">' +
          '<span><strong>1 of ' + size + '</strong> filled</span>' +
          '<span>' + (size - 1) + ' open seats</span>' +
        '</div>' +
      '</aside>';
  }

  // injectHostSidePanelIfMissing → called by the observer; idempotent
  //   no-op when the panel is already present. Safe to call on every
  //   mutation because it won't re-mutate the DOM if nothing's missing.
  // rebuildHostSidePanel       → called by user click/input handlers
  //   only. Always replaces the panel with a freshly-rendered version
  //   reflecting the current chip selection state.
  function injectHostSidePanelIfMissing() {
    var step = currentHostStep();
    if (step < 1 || step > 2) return;
    var body = document.getElementById('pf-host-body');
    if (!body) return;
    if (body.querySelector('[data-pf-host-side]')) return;
    body.insertAdjacentHTML('beforeend', buildSidePanelHtml(step));
    body.classList.add('pf-has-side-panel');
  }
  function rebuildHostSidePanel() {
    var step = currentHostStep();
    if (step < 1 || step > 2) return;
    var body = document.getElementById('pf-host-body');
    if (!body) return;
    var existing = body.querySelector('[data-pf-host-side]');
    var html = buildSidePanelHtml(step);
    if (existing) {
      var tmp = document.createElement('div');
      tmp.innerHTML = html;
      var fresh = tmp.firstElementChild;
      if (fresh) existing.replaceWith(fresh);
    } else {
      body.insertAdjacentHTML('beforeend', html);
      body.classList.add('pf-has-side-panel');
    }
  }
  function removeHostSidePanel() {
    var body = document.getElementById('pf-host-body');
    if (!body) return;
    var existing = body.querySelector('[data-pf-host-side]');
    if (existing) existing.remove();
    body.classList.remove('pf-has-side-panel');
  }

  // Click + input delegation: rebuild the side panel whenever the host
  // picks a chip, character, or types a title. The observer is NOT
  // allowed to call rebuild (would cause an infinite mutation loop);
  // it only calls inject-if-missing.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('#pf-host-body .pf-chip-btn, #pf-host-body .pf-char-btn')) {
      requestAnimationFrame(rebuildHostSidePanel);
    }
  }, false);
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t) return;
    if (t.id === 'pf-host-title') rebuildHostSidePanel();
  }, false);

  function enhanceHostModal() {
    applyHostModalTitle();
    var step = currentHostStep();
    if (step === 2) enhanceVoiceServerPicker();
    if (step === 3) {
      removeHostSidePanel();
      enhanceHostReview();
    } else if (step === 1 || step === 2) {
      injectHostSidePanelIfMissing();
    }
  }

  function startHostModalObserver() {
    var body = document.getElementById('pf-host-body');
    var stepper = document.getElementById('pf-host-stepper');
    if (!body || !stepper) return;
    enhanceHostModal();
    var mo = new MutationObserver(function () { enhanceHostModal(); });
    mo.observe(body, { childList: true, subtree: true });
    mo.observe(stepper, { childList: true, subtree: true });
    globalRoot.__pfHostModalObserver = mo;
  }
  if (document.readyState !== 'loading') {
    startHostModalObserver();
    setTimeout(startHostModalObserver, 400);
    setTimeout(startHostModalObserver, 1500);
  } else {
    document.addEventListener('DOMContentLoaded', startHostModalObserver, { once: true });
  }
  globalRoot.__pfEnhanceHostModal = enhanceHostModal;

  // ── Live Parties row enrichment ──────────────────────────────────────
  // party-finder.js renders Live Party rows with text-only attribute
  // strings. We can't easily edit that file (harness content filter), so
  // this MutationObserver watches #pf-live-list and upgrades each rendered
  // row in-place with the same colored pills + character-avatar slot
  // strip used by the Best Party hero card. The enrichment is idempotent
  // via data-pf-enhanced=1.
  function findLobbyById(state, id) {
    if (!state || !id) return null;
    // The Beta state surface stores active lobbies under `openLobbies`. We
    // also check `state.lobby` (the viewer's own room, which can appear in
    // Live Parties when they're hosting) and `state.rooms` as a defensive
    // fallback for sandbox payloads that use the legacy shape.
    var pools = [
      state.openLobbies,
      state.rooms,
      state.lobby ? [state.lobby] : null,
    ];
    for (var p = 0; p < pools.length; p++) {
      var arr = pools[p];
      if (!arr || !arr.length) continue;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].lobbyId === id) return arr[i];
      }
    }
    return null;
  }
  function lobbyRowStatusBadge(lobby, state) {
    var nowMs = parseIsoMs(state && state.serverTime) || Date.now();
    var createdMs = parseIsoMs(lobby.createdAt);
    var ageS = createdMs ? Math.max(0, (nowMs - createdMs) / 1000) : 0;
    var size = lobby.lobbySize || 4;
    var filled = Array.isArray(lobby.acceptedMemberSteamIds)
      ? lobby.acceptedMemberSteamIds.length
      : (Array.isArray(lobby.memberSteamIds) ? lobby.memberSteamIds.length : 1);
    var open = Math.max(0, size - filled);
    if (open === 1)            return { cls: 'filling', label: 'Filling fast' };
    if (size - open >= 2 && open >= 1) return { cls: 'go',      label: 'Go now' };
    if (ageS > 0 && ageS < 90) return { cls: 'new',     label: 'New' };
    return null;
  }
  function ensureRowArt(article, lobby) {
    if (!article) return;
    if (article.querySelector(':scope > .pf-row-art')) return;
    var hostChars = (lobby.preferredCharacters || []).map(normalizeCharId).filter(Boolean);
    var slug = hostChars[0] || '';
    var inner = slug
      ? '<img class="pf-row-art-img" src="' + esc(charAsset(slug)) + '" alt="" />' +
        '<span class="pf-row-art-tag">' + esc(CHAR_LABEL[slug] || '') + '</span>'
      : '<div class="pf-row-art-any">Open<br/><span>to any</span></div>';
    var div = document.createElement('div');
    div.className = 'pf-row-art';
    div.innerHTML = inner;
    article.insertBefore(div, article.firstChild);
    article.classList.add('pf-live-row--has-art');
  }
  function ensureRowBadge(article, lobby, state) {
    var meta = article.querySelector('.pf-live-meta');
    if (!meta) return;
    var existing = meta.querySelector(':scope > .pf-row-badge');
    var badge = lobbyRowStatusBadge(lobby, state);
    if (!badge) {
      if (existing) existing.remove();
      return;
    }
    if (existing) {
      var nextHash = badge.cls + ':' + badge.label;
      if (existing.getAttribute('data-pf-badge') === nextHash) return;
      existing.remove();
    }
    var span = document.createElement('span');
    span.className = 'pf-row-badge pf-row-badge--' + badge.cls;
    span.setAttribute('data-pf-badge', badge.cls + ':' + badge.label);
    span.innerHTML = '<span class="pf-row-badge-dot"></span>' + esc(badge.label);
    meta.insertBefore(span, meta.firstChild);
  }

  function enrichLiveRow(article) {
    if (!article || article.getAttribute('data-pf-enhanced') === '1') return;
    // Defensive: only enrich actual row articles, never the Join/Details
    // buttons inside them (they also carry data-lobby-id).
    var tag = (article.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return;
    if (!article.classList.contains('pf-live-row')) return;
    var id = article.getAttribute('data-lobby-id');
    if (!id) return;
    var state = (typeof globalRoot.__pfGetLastState === 'function')
      ? globalRoot.__pfGetLastState()
      : null;
    if (!state) return;
    var lobby = findLobbyById(state, id);
    if (!lobby) return;

    var attrs = article.querySelectorAll('.pf-attrs');
    if (attrs && attrs.length >= 1) {
      attrs[0].innerHTML =
        branchPillHtml(lobby) +
        modePillHtml(lobby) +
        ascensionPillHtml(lobby) +
        goalPillHtml(lobby);
      attrs[0].classList.add('pf-attrs--pills');
    }
    if (attrs && attrs.length >= 2) {
      attrs[1].innerHTML =
        voicePillHtml(lobby) +
        micPillHtml(lobby.voicePreference);
      attrs[1].classList.add('pf-attrs--pills');
    }

    var partyLine = article.querySelector('.pf-party-line');
    if (partyLine) {
      partyLine.outerHTML = renderSlotStrip(lobby, state);
    }

    // Upgrade the static "active now" status text on the host strip
    // into a live "active 14s ago" with a pulsing dot so the row reads
    // as a breathing lobby, not a frozen card. Idempotent — runs once
    // and re-runs cheaply on each sweep if the row gets re-rendered.
    var strip = article.querySelector('.pf-host-strip');
    if (strip) {
      var nowMs = parseIsoMs(state && state.serverTime) || Date.now();
      var when = relativeAgo(lobby.updatedAt || lobby.createdAt, nowMs) || 'active now';
      var label = 'active ' + when;
      var spans = strip.querySelectorAll(':scope > span');
      if (spans.length >= 2) {
        var dot = spans[0];
        if (dot.classList.contains('pf-dot')) {
          dot.classList.remove('pf-dot');
          dot.classList.add('pf-live-dot');
        }
        spans[spans.length - 1].textContent = label;
      }
    }

    // Add the host's character art on the LEFT of the row so each
    // Live Parties card reads as a mini lobby tile, not a flat list
    // entry. Fills the wide-screen whitespace and gives every host
    // visual identity at a glance.
    ensureRowArt(article, lobby);
    ensureRowBadge(article, lobby, state);

    article.setAttribute('data-pf-enhanced', '1');
  }
  function sweepLiveRows(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    // Only top-level row articles — descendants like the Join/Details
    // buttons also carry `data-lobby-id` for the delegated click handler,
    // and we don't want to mis-treat them as rows (would inject character
    // art INTO the buttons and stretch them sky-high).
    var list = scope.querySelector
      ? (scope.id === 'pf-live-list' ? scope : scope.querySelector('#pf-live-list'))
      : null;
    if (!list) return;
    var rows = list.querySelectorAll(':scope > [data-lobby-id]');
    for (var i = 0; i < rows.length; i++) enrichLiveRow(rows[i]);
  }
  function startLiveObserver() {
    var list = document.getElementById('pf-live-list');
    if (!list) return;
    sweepLiveRows();
    var mo = new MutationObserver(function () { sweepLiveRows(); });
    mo.observe(list, { childList: true, subtree: false });
    globalRoot.__pfLiveObserver = mo;
  }
  // Try immediately, and again on a couple of frames so we catch the case
  // where #pf-live-list hasn't been inserted yet at script-load time.
  if (document.readyState !== 'loading') {
    startLiveObserver();
    setTimeout(startLiveObserver, 200);
    setTimeout(startLiveObserver, 800);
  } else {
    document.addEventListener('DOMContentLoaded', startLiveObserver, { once: true });
  }
  globalRoot.__pfSweepLiveRows = sweepLiveRows;

  // ── Lobby presence bar + activity ticker (lobby feel) ────────────────
  // Adds a thin live presence strip at the top of the Co-op page:
  //   • Pulsing dot + "X explorers online"
  //   • Rooms hosting count
  //   • Looking-for-group count
  //   • Activity ticker (right side) scrolling the last few lobby events
  // The bar refreshes whenever party-finder.js publishes a new state via
  // window.__pfGetLastState(), so it tracks the same poll cadence.
  function loadLobbyBarStyles() {
    if (document.querySelector('link[data-pf-lobby-bar-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/lib/party-finder-lobby-bar.css?v=3';
    link.setAttribute('data-pf-lobby-bar-css', '1');
    document.head.appendChild(link);
  }

  function fmtCount(n) {
    var v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '0';
    if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.0', '') + 'k';
    return String(Math.floor(v));
  }

  function parseIsoMs(s) {
    if (!s) return 0;
    var t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  }

  function relativeAgo(iso, nowMs) {
    var t = parseIsoMs(iso);
    if (!t) return '';
    var now = nowMs || Date.now();
    var diff = Math.max(0, now - t);
    var s = Math.floor(diff / 1000);
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    return d + 'd ago';
  }

  function ensureLobbyBar() {
    var root = document.getElementById('pf-root');
    if (!root) return null;
    var bar = document.getElementById('pf-lobby-bar');
    if (bar) return bar;
    bar = document.createElement('header');
    bar.id = 'pf-lobby-bar';
    bar.className = 'pf-lobby-bar';
    bar.setAttribute('aria-label', 'Lobby activity');
    bar.innerHTML =
      '<div class="pf-lobby-bar-stats" data-pf-stats>' +
        '<span class="pf-lobby-stat"><span class="pf-presence-dot"></span>' +
          '<strong data-pf-stat="online">0</strong>' +
          '<span class="pf-lobby-stat-muted">explorers online</span></span>' +
        '<span class="pf-lobby-stat"><span class="pf-presence-dot pf-presence-dot--warn"></span>' +
          '<strong data-pf-stat="hosting">0</strong>' +
          '<span class="pf-lobby-stat-muted">rooms hosting</span></span>' +
        '<span class="pf-lobby-stat"><span class="pf-presence-dot pf-presence-dot--info"></span>' +
          '<strong data-pf-stat="looking">0</strong>' +
          '<span class="pf-lobby-stat-muted">looking for groups</span></span>' +
      '</div>' +
      '<div class="pf-ticker" data-pf-ticker><div class="pf-ticker-track" data-pf-ticker-track></div></div>';
    root.insertBefore(bar, root.firstChild);
    return bar;
  }

  function pickVerb(row) {
    var s = (row && row.status) || '';
    if (s === 'hosting' || s === 'host')   return { tag: 'HOST', cls: 'host', verb: 'hosted' };
    if (s === 'paired' || s === 'joined')  return { tag: 'IN',   cls: 'join', verb: 'joined a room' };
    if (s === 'looking')                   return { tag: 'LFG',  cls: 'look', verb: 'looking for group' };
    return { tag: 'ONLINE', cls: '', verb: 'is online' };
  }

  function buildTickerItemsFromState(state) {
    if (!state) return [];
    var nowMs = parseIsoMs(state.serverTime) || Date.now();
    var feed = Array.isArray(state.activePlayerFeed) ? state.activePlayerFeed.slice(0, 12) : [];
    var items = [];
    for (var i = 0; i < feed.length; i++) {
      var row = feed[i];
      if (!row) continue;
      var name = row.personaName || row.steamId || 'Someone';
      var meta = pickVerb(row);
      var when = relativeAgo(row.lastHeartbeatAt, nowMs);
      var detail = '';
      if (row.goal && row.goal !== 'any') detail = String(row.goal);
      else if (row.ascensionMax != null) detail = ascBucketLabel(row.ascensionMin, row.ascensionMax);
      var label = name + ' ' + meta.verb + (detail ? ' \u2014 ' + detail : '');
      items.push(
        '<span class="pf-ticker-item">' +
          '<span class="pf-ticker-item-tag pf-ticker-item-tag--' + meta.cls + '">' + esc(meta.tag) + '</span>' +
          '<span>' + esc(label) + '</span>' +
          (when ? '<span class="pf-ticker-item-when">' + esc(when) + '</span>' : '') +
        '</span>'
      );
    }
    return items;
  }

  function refreshLobbyBar() {
    var state = (typeof globalRoot.__pfGetLastState === 'function')
      ? globalRoot.__pfGetLastState()
      : null;
    var bar = ensureLobbyBar();
    if (!bar) return;
    var stats = bar.querySelector('[data-pf-stats]');
    if (stats) {
      var online  = state && state.playersOnlineCount;
      var hosting = state && state.openLobbiesTotalCount;
      var looking = state && state.lookingNowCount;
      // Fallback: derive from arrays when count fields are absent.
      if (online == null && Array.isArray(state && state.activePlayerFeed)) online = state.activePlayerFeed.length;
      if (hosting == null && Array.isArray(state && state.openLobbies)) hosting = state.openLobbies.length;
      if (looking == null && Array.isArray(state && state.activePlayerFeed)) {
        looking = state.activePlayerFeed.filter(function (r) { return r && r.status === 'looking'; }).length;
      }
      function setStat(key, value) {
        var node = stats.querySelector('[data-pf-stat="' + key + '"]');
        if (!node) return;
        var next = fmtCount(value);
        if (node.textContent === next) return;
        node.textContent = next;
        node.classList.remove('pf-flash');
        // Force reflow so the animation actually replays when the
        // class is re-added in the same frame.
        // eslint-disable-next-line no-unused-expressions
        node.offsetWidth;
        node.classList.add('pf-flash');
        setTimeout(function () { node.classList.remove('pf-flash'); }, 600);
      }
      setStat('online',  online);
      setStat('hosting', hosting);
      setStat('looking', looking);
    }
    var ticker = bar.querySelector('[data-pf-ticker]');
    var track  = bar.querySelector('[data-pf-ticker-track]');
    if (track) {
      var items = buildTickerItemsFromState(state);
      var idleHtml = '<span class="pf-ticker-idle">Quiet right now \u2014 be the first to host a room.</span>';
      var nextHtml = items.length ? (items.join('') + items.join('')) : idleHtml;
      // Critical: only mutate innerHTML when the content has actually
      // changed. Rewriting on every poll restarts the CSS marquee
      // animation, which makes the ticker visibly snap back to the
      // start whenever the user is hovering or the page polls. The
      // hash-compare keeps the scroll position continuous.
      var prev = track.getAttribute('data-pf-hash') || '';
      var nextHash = String(nextHtml.length) + ':' + (items[0] || '').slice(0, 80);
      if (nextHash !== prev) {
        track.innerHTML = nextHtml;
        track.setAttribute('data-pf-hash', nextHash);
        if (items.length) ticker.classList.remove('pf-ticker--idle');
        else              ticker.classList.add('pf-ticker--idle');
      }
    }
  }

  function bootLobbyBar() {
    loadLobbyBarStyles();
    if (!document.getElementById('pf-root')) {
      setTimeout(bootLobbyBar, 200);
      return;
    }
    ensureLobbyBar();
    refreshLobbyBar();
    var rootMo = new MutationObserver(function () { refreshLobbyBar(); });
    var live = document.getElementById('pf-live-list');
    if (live) rootMo.observe(live, { childList: true, subtree: false });
    var best = document.getElementById('pf-best-card');
    if (best) rootMo.observe(best, { childList: true, subtree: false });
    setInterval(refreshLobbyBar, 5000);
  }
  if (document.readyState !== 'loading') {
    bootLobbyBar();
    setTimeout(bootLobbyBar, 600);
  } else {
    document.addEventListener('DOMContentLoaded', bootLobbyBar, { once: true });
  }
  globalRoot.__pfRefreshLobbyBar = refreshLobbyBar;

  // ── Safe join-room intercept (character-claimed bug fix) ─────────────
  // The original join handler in party-finder.js pre-picks a character
  // for "Open to any" joiners by skipping only the host's character.
  // When other seats are already filled, that pick collides and the
  // backend rejects with character_claimed. We intercept in capture
  // phase, recompute a safe pick (or send no character at all so the
  // user picks in-game), and short-circuit the original handler.
  function safeJoinRoom(btn) {
    var lobbyId = btn.getAttribute('data-lobby-id');
    if (!lobbyId) return;
    var state = (typeof globalRoot.__pfGetLastState === 'function')
      ? globalRoot.__pfGetLastState()
      : null;
    var lobby = findLobbyById(state || {}, lobbyId);
    if (!lobby) {
      toastSafe('Room not found.');
      return;
    }
    var presChars = (state && state.presence && state.presence.preferredCharacters) || [];
    var myChar = '';
    for (var i = 0; i < presChars.length; i++) {
      var n = normalizeCharId(presChars[i]);
      if (n) { myChar = n; break; }
    }
    var hostChars = (lobby.preferredCharacters || []).map(normalizeCharId).filter(Boolean);
    var hostChar = hostChars[0] || '';
    // Only send our character when we actually have a preference AND
    // it doesn't collide with the host. Otherwise let the joiner pick
    // in-game (the backend leaves member.selectedCharacter undefined).
    var body = {};
    if (myChar && myChar !== hostChar) body = { selectedCharacter: myChar };

    var approval = lobby.approvalRequired === true;
    var path = '/api/coop/lobbies/' + encodeURIComponent(lobbyId) + (approval ? '/request' : '/join-seat');
    var prevLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = approval ? 'Requesting…' : 'Joining…';
    fetch(path, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (resp) {
        return resp.json().then(
          function (j) { return { ok: resp.ok, status: resp.status, body: j || {} }; },
          function ()  { return { ok: resp.ok, status: resp.status, body: {} }; }
        );
      })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = prevLabel;
        if (!res.ok) {
          var msg = (res.body && (res.body.message || res.body.error)) || ('HTTP ' + res.status);
          toastSafe(humanizeJoinError(msg));
          return;
        }
        if (approval) {
          toastSafe('Seat requested.');
          return;
        }
        toastSafe('You\u2019re in \u2014 opening Party Hub.');
        var pid = (res.body && (res.body.partyId || (res.body.party && res.body.party.partyId))) || '';
        if (pid) window.location.assign('/party/' + pid);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = prevLabel;
        toastSafe('Could not join — check your connection.');
      });
  }
  function humanizeJoinError(code) {
    var key = String(code || '').toLowerCase();
    if (key.indexOf('character_claimed') !== -1) return 'That character is already claimed — try again.';
    if (key.indexOf('lobby_full') !== -1) return 'That room just filled up.';
    if (key.indexOf('lobby_not_found') !== -1) return 'That room is gone.';
    if (key.indexOf('already_in_lobby') !== -1) return 'You already have a room open. Close it first.';
    if (key.indexOf('rate_limited') !== -1) return 'You\u2019re moving too fast. Try again.';
    return String(code || 'Could not join this room.').replace(/_/g, ' ');
  }
  function toastSafe(msg) {
    try {
      var ev = new CustomEvent('coop:toast', { detail: { text: String(msg || '') } });
      document.dispatchEvent(ev);
    } catch (e) {}
    if (typeof globalRoot.__pfToast === 'function') globalRoot.__pfToast(msg);
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-pf-action="join-room"]');
    if (!btn) return;
    // Stop the original delegated handler from running its broken pick.
    e.stopImmediatePropagation();
    e.preventDefault();
    // Tap the personal Co-op log BEFORE the network call so the
    // user's history is captured even if the join API races, errors,
    // or the navigation happens before scene.js' state-poll runs.
    try {
      var lobbyId = btn.getAttribute('data-lobby-id') || (btn.closest('[data-lobby-id]') && btn.closest('[data-lobby-id]').getAttribute('data-lobby-id'));
      var st = (typeof globalRoot.__pfGetLastState === 'function') ? globalRoot.__pfGetLastState() : null;
      if (lobbyId && st && Array.isArray(st.openLobbies) && globalRoot.__pfCoopLog && typeof globalRoot.__pfCoopLog.record === 'function') {
        for (var i = 0; i < st.openLobbies.length; i++) {
          var lb = st.openLobbies[i];
          if (lb && lb.lobbyId === lobbyId) {
            var sess = globalRoot.__VAULT_SESSION__ || {};
            var selfId = (st && st.presence && st.presence.steamId) || sess.steamID || sess.steamId || sess.steam_id || '';
            globalRoot.__pfCoopLog.record(lb, selfId);
            break;
          }
        }
      }
    } catch (_) {}
    safeJoinRoom(btn);
  }, true);
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
