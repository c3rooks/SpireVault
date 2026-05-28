// party-finder-scale.js
// =====================================================================
// Live Parties scale-aware toolbar + density + cap, layered on top of
// party-finder.js without touching that file. Loaded as a classic
// script after party-finder-globals.js (see coop-sandbox.js).
//
// Design:
//   - Sticky toolbar above #pf-live-list with search, sort segment,
//     quick filter chips, and a count badge.
//   - Visible cap (default 12) with a "Show all N rooms" reveal.
//   - Auto density classes on #pf-live-list based on visible count:
//       cozy (< 12) | compact (12-30) | dense (30+)
//   - CSS `order` is used for sort so we never fight the renderer's
//     DOM order, and rows that don't match get a `pf-row-hidden` class.
//   - Idempotent. Observes #pf-live-list and re-applies after each
//     party-finder.js render.
// =====================================================================

(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var globalRoot = root;
  var doc = root.document;
  if (root.__pfScaleSealed) return;
  root.__pfScaleSealed = true;

  // Pull in the companion CSS exactly once. Stays a sibling stylesheet
  // so we don't fight the StrReplace block on party-finder.css.
  (function loadScaleCss() {
    if (doc.querySelector('link[data-pf-scale-css]')) return;
    var link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/lib/party-finder-scale.css?v=1';
    link.setAttribute('data-pf-scale-css', '1');
    doc.head.appendChild(link);
  })();

  // Pull helpers off PFH (set up by party-finder-globals.js).
  var H = root.PFH || {};
  var normalizeCharId = H.normalizeCharId || function (s) {
    return String(s || '').toLowerCase().trim();
  };
  var parseIsoMs = H.parseIsoMs || function (s) {
    if (!s) return 0;
    var t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  };
  var findLobbyById = H.findLobbyById || function (state, id) {
    if (!state || !id) return null;
    var pools = [state.openLobbies, state.rooms, [state.lobby]];
    for (var i = 0; i < pools.length; i++) {
      var arr = pools[i];
      if (!Array.isArray(arr)) continue;
      for (var j = 0; j < arr.length; j++) {
        var l = arr[j];
        if (l && (l.lobbyId === id || l.id === id)) return l;
      }
    }
    return null;
  };

  // ── State (per-tab session) ─────────────────────────────────────────
  var pfLive = {
    search: '',
    sort: 'best',
    chips: Object.create(null),
    cap: 12,
  };

  // ── Filter / sort predicates ────────────────────────────────────────
  function presence(state) { return (state && state.presence) || {}; }
  function presenceCharIds(state) {
    var arr = presence(state).preferredCharacters || [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var n = normalizeCharId(arr[i]);
      if (n) out.push(n);
    }
    return out;
  }
  function presenceAscRange(state) {
    var p = presence(state);
    return {
      min: (typeof p.ascensionMin === 'number') ? p.ascensionMin : 0,
      max: (typeof p.ascensionMax === 'number') ? p.ascensionMax : 10,
    };
  }
  function lobbyFilledSeats(lobby) {
    if (Array.isArray(lobby.acceptedMemberSteamIds)) return lobby.acceptedMemberSteamIds.length;
    if (Array.isArray(lobby.memberSteamIds)) return lobby.memberSteamIds.length;
    return 1;
  }
  function lobbyAgeSec(lobby, nowMs) {
    var t = parseIsoMs(lobby.createdAt);
    return t ? Math.max(0, (nowMs - t) / 1000) : 9999;
  }
  function matchSearch(lobby, q) {
    if (!q) return true;
    var hay = [
      lobby.title || '',
      lobby.hostPersonaName || '',
      lobby.note || '',
      (lobby.preferredCharacters || []).join(' '),
      lobby.discordChannelName || '',
    ].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function matchChip(lobby, chip, state, nowMs) {
    switch (chip) {
      case 'my-asc': {
        var r = presenceAscRange(state);
        var lo = (typeof lobby.ascensionMin === 'number') ? lobby.ascensionMin : 0;
        var hi = (typeof lobby.ascensionMax === 'number') ? lobby.ascensionMax : 10;
        return !(hi < r.min || lo > r.max);
      }
      case 'my-char': {
        var mine = presenceCharIds(state);
        var hostCs = (lobby.preferredCharacters || []).map(normalizeCharId).filter(Boolean);
        if (!hostCs.length) return true;
        if (!mine.length) return false;
        for (var i = 0; i < mine.length; i++) if (hostCs.indexOf(mine[i]) !== -1) return true;
        return false;
      }
      case 'voice':
        return lobby.voicePreference === 'required' ||
               !!lobby.discordChannelInviteUrl ||
               !!lobby.voiceChannelName;
      case 'no-mic':
        return !(lobby.micPolicy === 'required' || lobby.voicePreference === 'required');
      case 'filling': {
        var size = lobby.lobbySize || 4;
        var filled = lobbyFilledSeats(lobby);
        return (size - filled) === 1 && filled < size;
      }
      case 'new':
        return lobbyAgeSec(lobby, nowMs) < 90;
      case 'open':
        return !(lobby.preferredCharacters && lobby.preferredCharacters.length);
      default:
        return true;
    }
  }
  function matchAllChips(lobby, state, nowMs) {
    for (var c in pfLive.chips) {
      if (!pfLive.chips[c]) continue;
      if (!matchChip(lobby, c, state, nowMs)) return false;
    }
    return true;
  }
  function sortKey(lobby, sort, nowMs, state) {
    var size = lobby.lobbySize || 4;
    var filled = lobbyFilledSeats(lobby);
    var open = Math.max(0, size - filled);
    var created = parseIsoMs(lobby.createdAt) || 0;
    var updated = parseIsoMs(lobby.updatedAt) || created;
    switch (sort) {
      case 'new':     return -created;
      case 'filling': return open === 0 ? 1e15 : -(filled * 1000) - (updated / 1e9);
      case 'active':  return -updated;
      case 'best':
      default: {
        // Cheap "best fit" composite: prefers my-char and my-asc rooms,
        // then filling-fast, then newest.
        var bonus = 0;
        if (matchChip(lobby, 'my-char', state, nowMs)) bonus -= 1e9;
        if (matchChip(lobby, 'my-asc',  state, nowMs)) bonus -= 5e8;
        return bonus - filled * 1000 - (created / 1e9);
      }
    }
  }

  // ── Toolbar DOM ─────────────────────────────────────────────────────
  function svgSearch() {
    return '<svg viewBox="0 0 16 16" aria-hidden="true" width="14" height="14">' +
           '<path d="M11.5 11.5 14 14M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Z" ' +
           'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
           '</svg>';
  }
  // v196 — three-stage gate. The toolbar is a deliberate stage-C
  // surface; stage A and B don't paint it at all. We read the bucket
  // off the documentElement, which is owned by party-finder-scene.js
  // (also defaults to "a" when state hasn't loaded yet, so we err
  // on the side of NOT painting noise on a cold page).
  function currentStageBucket() {
    var v = (doc.documentElement.getAttribute('data-pf-stage-bucket') || 'a').toLowerCase();
    return (v === 'a' || v === 'b' || v === 'c') ? v : 'a';
  }
  function shouldMountToolbar() {
    return currentStageBucket() === 'c';
  }
  function ensureFilterTrigger(section) {
    // Stage-C Filter button: a small iOS-style icon button that sits
    // in the section header (right side, near Host a Room). Click
    // toggles the inline toolbar open/closed. Hidden in any other
    // stage via CSS reading [data-pf-stage-bucket].
    if (!section) return;
    var head = section.querySelector('.pf-section-head .pf-section-actions');
    if (!head) return;
    if (head.querySelector('[data-pf-action="pf-toggle-filter-sheet"]')) return;
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'pf-btn pf-btn--ghost pf-btn--sm pf-live-filter-trigger';
    btn.setAttribute('data-pf-action', 'pf-toggle-filter-sheet');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'pf-live-toolbar');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M3 6h18"/><path d="M6 12h12"/><path d="M10 18h4"/>' +
      '</svg><span>Filter</span>';
    head.appendChild(btn);
    btn.addEventListener('click', function () {
      var open = section.getAttribute('data-pf-toolbar-open') === '1';
      section.setAttribute('data-pf-toolbar-open', open ? '0' : '1');
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
  }
  function ensureToolbar() {
    if (!shouldMountToolbar()) return null;
    var section = doc.getElementById('pf-live');
    if (!section) return null;
    ensureFilterTrigger(section);
    var existing = section.querySelector('.pf-live-toolbar');
    if (existing) return existing;
    var list = section.querySelector('#pf-live-list');
    if (!list) return null;
    var bar = doc.createElement('div');
    bar.className = 'pf-live-toolbar';
    bar.id = 'pf-live-toolbar';
    bar.setAttribute('data-pf-live-toolbar', '1');
    bar.innerHTML =
      '<div class="pf-live-toolbar-row pf-live-toolbar-row--top">' +
        '<label class="pf-live-search">' +
          svgSearch() +
          '<input type="search" placeholder="Search title, host, or note" ' +
          'data-pf-live-search aria-label="Filter rooms" />' +
        '</label>' +
        '<div class="pf-live-sort" role="tablist" aria-label="Sort">' +
          '<button type="button" class="pf-live-sort-btn is-active" data-pf-sort="best" role="tab">Best fit</button>' +
          '<button type="button" class="pf-live-sort-btn" data-pf-sort="new" role="tab">Newest</button>' +
          '<button type="button" class="pf-live-sort-btn" data-pf-sort="filling" role="tab">Filling fast</button>' +
          '<button type="button" class="pf-live-sort-btn" data-pf-sort="active" role="tab">Most active</button>' +
        '</div>' +
      '</div>' +
      '<div class="pf-live-toolbar-row pf-live-toolbar-row--chips" role="group" aria-label="Quick filters">' +
        '<button type="button" class="pf-live-chip" data-pf-quick="my-asc">My ascension</button>' +
        '<button type="button" class="pf-live-chip" data-pf-quick="my-char">Plays my hero</button>' +
        '<button type="button" class="pf-live-chip" data-pf-quick="voice">Voice in room</button>' +
        '<button type="button" class="pf-live-chip" data-pf-quick="no-mic">Mic optional</button>' +
        '<button type="button" class="pf-live-chip" data-pf-quick="filling">Filling fast</button>' +
        '<button type="button" class="pf-live-chip" data-pf-quick="new">Just hosted</button>' +
        '<button type="button" class="pf-live-chip" data-pf-quick="open">Open to any</button>' +
      '</div>' +
      '<div class="pf-live-toolbar-row pf-live-toolbar-row--meta">' +
        '<span class="pf-live-count" data-pf-live-count>0 rooms</span>' +
        '<button type="button" class="pf-live-clear" data-pf-live-clear hidden>Clear filters</button>' +
      '</div>';
    section.insertBefore(bar, list);
    wireToolbar(bar);
    return bar;
  }
  function wireToolbar(bar) {
    var input = bar.querySelector('[data-pf-live-search]');
    if (input) {
      var t = 0;
      input.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          pfLive.search = String(input.value || '').trim().toLowerCase();
          apply();
        }, 140);
      });
    }
    bar.addEventListener('click', function (e) {
      var sortBtn = e.target.closest && e.target.closest('[data-pf-sort]');
      if (sortBtn) {
        pfLive.sort = sortBtn.getAttribute('data-pf-sort') || 'best';
        var sibs = bar.querySelectorAll('[data-pf-sort]');
        for (var i = 0; i < sibs.length; i++) {
          sibs[i].classList.toggle('is-active', sibs[i] === sortBtn);
        }
        apply();
        return;
      }
      var chip = e.target.closest && e.target.closest('[data-pf-quick]');
      if (chip) {
        var key = chip.getAttribute('data-pf-quick');
        pfLive.chips[key] = !pfLive.chips[key];
        chip.classList.toggle('is-active', !!pfLive.chips[key]);
        apply();
        return;
      }
      var clear = e.target.closest && e.target.closest('[data-pf-live-clear]');
      if (clear) {
        pfLive.search = '';
        pfLive.chips = Object.create(null);
        pfLive.cap = 12;
        if (input) input.value = '';
        var chips = bar.querySelectorAll('[data-pf-quick]');
        for (var j = 0; j < chips.length; j++) chips[j].classList.remove('is-active');
        apply();
        return;
      }
      var more = e.target.closest && e.target.closest('[data-pf-live-more]');
      if (more) {
        pfLive.cap = Infinity;
        apply();
        return;
      }
    });
    // Delegated "Clear filters" inside no-match block also routes here.
    doc.addEventListener('click', function (e) {
      var c = e.target.closest && e.target.closest('[data-pf-live-clear]');
      if (!c) return;
      if (bar.contains(c)) return; // already handled above
      pfLive.search = '';
      pfLive.chips = Object.create(null);
      pfLive.cap = 12;
      if (input) input.value = '';
      var chips = bar.querySelectorAll('[data-pf-quick]');
      for (var j = 0; j < chips.length; j++) chips[j].classList.remove('is-active');
      apply();
    });
  }

  function ensureMoreBtn(matches, total) {
    var section = doc.getElementById('pf-live');
    if (!section) return;
    var existing = section.querySelector('[data-pf-live-more]');
    var hiddenCount = Math.max(0, matches - pfLive.cap);
    var need = pfLive.cap !== Infinity && matches > pfLive.cap;
    if (!need) {
      if (existing) existing.remove();
      return;
    }
    var label = 'Show all ' + total + ' rooms (' + hiddenCount + ' more)';
    if (existing) {
      if (existing.textContent !== label) existing.textContent = label;
      return;
    }
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'pf-live-more';
    btn.setAttribute('data-pf-live-more', '1');
    btn.textContent = label;
    section.appendChild(btn);
  }
  function ensureNoMatchBlock(matches, total) {
    var section = doc.getElementById('pf-live');
    if (!section) return;
    var existing = section.querySelector('[data-pf-live-empty-filter]');
    var anyFilter = !!pfLive.search ||
      Object.keys(pfLive.chips).some(function (k) { return pfLive.chips[k]; });
    var need = total > 0 && matches === 0 && anyFilter;
    if (!need) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var div = doc.createElement('div');
    div.className = 'pf-live-empty-filter';
    div.setAttribute('data-pf-live-empty-filter', '1');
    div.innerHTML =
      '<div class="pf-live-empty-filter-title">No rooms match those filters</div>' +
      '<div class="pf-live-empty-filter-sub">' +
        'Loosen a chip or clear the search to see all ' + total + ' open rooms.' +
      '</div>' +
      '<button type="button" class="pf-btn pf-btn--ghost pf-btn--sm" data-pf-live-clear>Clear filters</button>';
    var list = section.querySelector('#pf-live-list');
    if (list && list.nextSibling) section.insertBefore(div, list.nextSibling);
    else section.appendChild(div);
  }

  function apply() {
    var list = doc.getElementById('pf-live-list');
    if (!list) return;
    var rows = list.querySelectorAll(':scope > [data-lobby-id]');
    var state = (typeof root.__pfGetLastState === 'function')
      ? root.__pfGetLastState() : null;
    var nowMs = parseIsoMs(state && state.serverTime) || Date.now();

    var matches = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if ((row.tagName || '').toUpperCase() === 'BUTTON') continue;
      var lobbyId = row.getAttribute('data-lobby-id');
      var lobby = findLobbyById(state || {}, lobbyId);
      if (!lobby) {
        row.classList.add('pf-row-hidden');
        continue;
      }
      var ok = matchSearch(lobby, pfLive.search) && matchAllChips(lobby, state, nowMs);
      row.classList.toggle('pf-row-hidden', !ok);
      if (ok) {
        matches.push({ row: row, key: sortKey(lobby, pfLive.sort, nowMs, state) });
      } else {
        row.style.removeProperty('order');
      }
    }
    matches.sort(function (a, b) { return a.key - b.key; });
    for (var j = 0; j < matches.length; j++) {
      matches[j].row.style.order = String(j);
      matches[j].row.classList.toggle(
        'pf-row-collapsed',
        pfLive.cap !== Infinity && j >= pfLive.cap
      );
    }

    var visible = pfLive.cap === Infinity
      ? matches.length
      : Math.min(matches.length, pfLive.cap);
    list.classList.remove('pf-live-list--cozy', 'pf-live-list--compact', 'pf-live-list--dense');
    if (visible >= 30)      list.classList.add('pf-live-list--dense');
    else if (visible >= 12) list.classList.add('pf-live-list--compact');
    else                    list.classList.add('pf-live-list--cozy');

    updateCounts(matches.length, rows.length);
    ensureMoreBtn(matches.length, rows.length);
    ensureNoMatchBlock(matches.length, rows.length);
  }
  function updateCounts(matches, total) {
    var bar = doc.querySelector('[data-pf-live-toolbar]');
    if (!bar) return;
    var label = bar.querySelector('[data-pf-live-count]');
    if (label) {
      var text;
      if (total === 0)            text = 'No rooms yet';
      else if (matches === total) text = total + ' rooms';
      else                        text = matches + ' of ' + total + ' rooms';
      if (label.textContent !== text) label.textContent = text;
    }
    var clearBtn = bar.querySelector('[data-pf-live-clear]');
    var anyFilter = !!pfLive.search ||
      Object.keys(pfLive.chips).some(function (k) { return pfLive.chips[k]; });
    if (clearBtn) clearBtn.hidden = !anyFilter;
  }

  function boot() {
    var section = doc.getElementById('pf-live');
    if (!section) {
      setTimeout(boot, 200);
      return;
    }
    // v196 — re-evaluate the stage bucket every poll so a 3rd lobby
    // appearing mid-session promotes the page to full UI (stage C)
    // and exposes the Filter trigger + toolbar in place.
    ensureToolbar();
    apply();
    var list = doc.getElementById('pf-live-list');
    if (list) {
      var mo = new MutationObserver(function () {
        ensureToolbar();
        apply();
      });
      mo.observe(list, { childList: true, subtree: false });
    }
    setInterval(function () {
      ensureToolbar();
      apply();
    }, 4000);
  }
  if (doc.readyState !== 'loading') {
    boot();
    setTimeout(boot, 700);
  } else {
    doc.addEventListener('DOMContentLoaded', boot, { once: true });
  }
  root.__pfApplyLiveFilters = apply;
})(typeof window !== 'undefined' ? window : null);
