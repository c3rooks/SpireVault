/* Verified Co-op Reputation — Level Badge + popover.
 *
 * v2 (2026-05-27) — rank transparency pass:
 *   - Every place a tier renders is now a clickable button (the LevelBadge).
 *   - Clicking opens a single shared popover with:
 *       · Tier number + STS-native name (Initiate / Climber / Verified /
 *         Spire-Keeper / Heart-Slayer)
 *       · One-line flavor
 *       · "How to climb" — three concrete paths with point values
 *       · "Why rank matters" — backed by a real consequence shipping in
 *         the same deploy (Verified+ hosts pinned higher in the lobby
 *         recommendations sort; see coop-routes.ts tierBoost)
 *       · "How the Vault ranks players →" footer link
 *   - Newcomer/Initiate now renders a quiet "Lv 1 · Initiate" tag rather
 *     than nothing. Previously a brand-new player saw no badge at all,
 *     which read as a stigma ("Lv1 with no context"). Now it reads as
 *     "you're here, you're starting."
 *
 * Keyboard / a11y:
 *   - Badge is a real <button> with aria-haspopup="dialog" + descriptive label.
 *   - Popover is role="dialog" aria-modal="true", focus trap, Esc closes,
 *     focus returns to the trigger on close.
 *   - prefers-reduced-motion suppresses the open transition + ascended glow.
 *
 * Failure modes are silent. If /coop/reputation/<sid> is unreachable the
 * slot just doesn't hydrate — the lobby row keeps working.
 */
(function attachReputationRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfRepRuntime) return;
  window.__pfRepRuntime = true;

  var CACHE_TTL_MS = 5 * 60 * 1000;
  var cache = new Map(); // steamID -> { at, blob }
  var inflight = new Map(); // steamID -> Promise

  // ── Tier display data ────────────────────────────────────────────────
  // Mapping from backend tier slug → user-facing identity. The backend
  // wire shape is unchanged; this is purely UI. See docs/coop-reputation-spec.md
  // for the threshold details that back each tier.
  var TIER_INFO = {
    newcomer: {
      level: 1,
      name: "Initiate",
      glyph: "I",
      flavor: "New to the Vault. Welcome to the climb.",
      rank: 0,
    },
    regular: {
      level: 2,
      name: "Climber",
      glyph: "II",
      flavor: "You've logged real runs. The climb is on.",
      rank: 1,
    },
    trusted: {
      level: 3,
      name: "Verified",
      glyph: "III",
      flavor: "Joiners trust you — you finish what you start.",
      rank: 2,
    },
    veteran: {
      level: 4,
      name: "Spire-Keeper",
      glyph: "IV",
      flavor: "A15+ clears. The late floors don't scare you.",
      rank: 3,
    },
    ascended: {
      level: 5,
      name: "Heart-Slayer",
      glyph: "V",
      flavor: "A20 with a Heart kill. Top of the spire.",
      rank: 4,
    },
  };

  function infoFor(tier) {
    return TIER_INFO[tier] || TIER_INFO.newcomer;
  }

  // The three concrete climb paths, ordered to read like a tutorial.
  // Point values are illustrative — they correspond directly to the
  // counters the backend tracks (totalRunsLogged, partiesCompleted,
  // highestAscensionCleared) but framed as XP so they're glanceable.
  var CLIMB_PATHS = [
    {
      points: "+50 XP each",
      label: "Log your STS runs.",
      detail: "10 runs unlocks Climber.",
    },
    {
      points: "+100 XP each",
      label: "Finish a co-op run with your party.",
      detail: "5 clean finishes unlocks Verified.",
    },
    {
      points: "+250 XP each",
      label: "Push Ascensions.",
      detail: "A15 → Spire-Keeper · A20 + Heart kill → Heart-Slayer.",
    },
  ];

  // Why rank matters — anchored to the consequence shipping in the same
  // deploy (Verified+ hosts get a boost in the lobby sort).
  var WHY_RANK_LINE =
    "Verified hosts and higher are pinned higher in the lobby list. " +
    "Joiners trust them more — seats fill faster.";

  function badgeLabel(b) {
    switch (b) {
      case "heart_kill":    return "Heart kill";
      case "a20_clear":     return "A20 clear";
      case "host_reliable": return "Reliable host";
      case "active_recent": return "Active";
      default:              return String(b || "");
    }
  }

  function badgeGlyph(b) {
    switch (b) {
      case "heart_kill":    return "♥";
      case "a20_clear":     return "A20";
      case "host_reliable": return "✓";
      case "active_recent": return "•";
      default:              return "";
    }
  }

  // ── Fetch + cache ────────────────────────────────────────────────────
  function fetchRep(steamID) {
    if (!steamID) return Promise.resolve(null);
    var cached = cache.get(steamID);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return Promise.resolve(cached.blob);
    }
    var pending = inflight.get(steamID);
    if (pending) return pending;
    // v203 integrity fix: hit the same-origin /api proxy (Pages Function
    // functions/api/[[path]].js → worker /coop/reputation). The bare
    // /coop/reputation/<sid> path is NOT proxied at app.spirevault.app —
    // it falls through to the SPA index.html, so r.json() always threw
    // and the badge silently rendered the "newcomer" fallback for EVERY
    // host (real veterans included). Routing through /api returns the
    // real { tier, badges, partiesCompletedBucket } so the LevelBadge
    // now shows genuinely-fetched reputation instead of a stub.
    var url = "/api/coop/reputation/" + encodeURIComponent(steamID);
    var p = fetch(url, { credentials: "include", headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("rep_" + r.status);
        return r.json();
      })
      .then(function (j) {
        var rep = j && j.reputation ? j.reputation : null;
        cache.set(steamID, { at: Date.now(), blob: rep });
        inflight.delete(steamID);
        return rep;
      })
      .catch(function () {
        inflight.delete(steamID);
        // Cache the miss too — avoid hammering on a dead endpoint.
        cache.set(steamID, { at: Date.now(), blob: null });
        return null;
      });
    inflight.set(steamID, p);
    return p;
  }

  // ── Badge render ─────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderSlot(slot, rep) {
    if (!slot) return;
    // Use a synthetic newcomer blob if rep is missing — the system is
    // additive and a brand-new player (or a public endpoint miss) should
    // still see the explainer when they click. Better than an invisible
    // hole that begs the question "what's a Lv1?"
    var tier = (rep && rep.tier) || "newcomer";
    var info = infoFor(tier);
    var badges = (rep && Array.isArray(rep.badges)) ? rep.badges.slice(0, 3) : [];
    var verifiedCheck = info.rank >= 2 ? '<span class="pf-level-check" aria-hidden="true">✓</span>' : "";
    var badgePills = badges.length > 0
      ? '<span class="pf-level-pills" aria-hidden="true">' +
          badges.map(function (b) {
            return '<span class="pf-level-pill pf-level-pill--' + escHtml(b) + '" title="' + escHtml(badgeLabel(b)) + '">' + escHtml(badgeGlyph(b)) + "</span>";
          }).join("") +
        "</span>"
      : "";
    var aria = "Level " + info.level + " · " + info.name +
      (badges.length > 0 ? " · " + badges.map(badgeLabel).join(", ") : "") +
      ". Open level details.";

    slot.dataset.tier = tier;
    slot.dataset.level = String(info.level);
    slot.innerHTML =
      '<button type="button" class="pf-level-badge" data-tier="' + escHtml(tier) + '" data-pf-level-trigger="1" aria-haspopup="dialog" aria-expanded="false" aria-label="' + escHtml(aria) + '" title="' + escHtml("Lv " + info.level + " · " + info.name) + '">' +
        '<span class="pf-level-badge-glyph" aria-hidden="true">' + escHtml(info.glyph) + "</span>" +
        '<span class="pf-level-badge-name" aria-hidden="true">' + escHtml(info.name) + "</span>" +
        verifiedCheck +
        badgePills +
      "</button>";
  }

  function hydrateSlot(slot) {
    if (!slot || slot.dataset.pfRepHydrated === "1") return;
    var sid = slot.getAttribute("data-host-steam-id");
    if (!sid) return;
    slot.dataset.pfRepHydrated = "1";
    fetchRep(sid).then(function (rep) {
      // Cache the rep blob on the slot so the popover can read it
      // without re-fetching when the click handler runs.
      try { slot.__pfRep = rep; } catch (_) {}
      renderSlot(slot, rep);
    });
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll("[data-pf-rep-slot]");
    for (var i = 0; i < nodes.length; i++) hydrateSlot(nodes[i]);
  }

  // ── Auto-annotate the prod surfaces ──────────────────────────────────
  // Mirrors the v1 behavior — inject `[data-pf-rep-slot]` into the
  // coop-lobbies.js Open Rooms cards and Best Matches cards.
  function autoAnnotateProdSurface(root) {
    var scope = root || document;

    var recCards = scope.querySelectorAll(".coop-rec-card[data-rec-sid]");
    for (var i = 0; i < recCards.length; i++) {
      var card = recCards[i];
      if (card.querySelector("[data-pf-rep-slot]")) continue;
      var sid = card.getAttribute("data-rec-sid");
      if (!sid) continue;
      var head = card.querySelector(".coop-rec-head");
      if (!head) continue;
      var slot = document.createElement("span");
      slot.className = "pf-rep-slot pf-rep-slot--inline-coop";
      slot.setAttribute("data-pf-rep-slot", "1");
      slot.setAttribute("data-host-steam-id", sid);
      head.appendChild(slot);
    }

    var lobbyCards = scope.querySelectorAll(".coop-lobby-card[data-lobby-id]");
    if (lobbyCards.length > 0) {
      var state = null;
      try {
        if (typeof window.__pfGetLastState === "function") state = window.__pfGetLastState();
      } catch (_) {}
      if (state && Array.isArray(state.lobbies || state.openLobbies)) {
        var lobbies = state.openLobbies || state.lobbies;
        var byId = Object.create(null);
        for (var k = 0; k < lobbies.length; k++) {
          var l = lobbies[k];
          if (l && l.lobbyId) byId[l.lobbyId] = l;
        }
        // Also pick up the requester's own lobby (rendered as "Your Room").
        if (state.lobby && state.lobby.lobbyId) byId[state.lobby.lobbyId] = state.lobby;
        for (var m = 0; m < lobbyCards.length; m++) {
          var lc = lobbyCards[m];
          var lid = lc.getAttribute("data-lobby-id");
          var lobby = byId[lid];
          if (!lobby || !lobby.hostSteamId) continue;
          var host = lc.querySelector(".coop-lobby-host");
          if (!host) continue;
          if (host.querySelector("[data-pf-rep-slot]")) continue;
          var slot2 = document.createElement("span");
          slot2.className = "pf-rep-slot pf-rep-slot--inline-coop";
          slot2.setAttribute("data-pf-rep-slot", "1");
          slot2.setAttribute("data-host-steam-id", lobby.hostSteamId);
          host.appendChild(slot2);
        }
      }
    }
  }

  // ── Popover ──────────────────────────────────────────────────────────
  // Single, lazy, global popover element. Re-used across triggers. The
  // popover is a manual `role="dialog"` rather than <dialog>` so the
  // bottom-sheet styling on mobile is straightforward and so we don't
  // hit the Safari issues with native <dialog> backdrop styling.
  var popover = null;
  var popoverBackdrop = null;
  var openerEl = null;
  var lastFocused = null;

  function ensurePopover() {
    if (popover) return popover;
    popoverBackdrop = document.createElement("div");
    popoverBackdrop.className = "pf-level-popover-backdrop";
    popoverBackdrop.hidden = true;
    popoverBackdrop.addEventListener("click", closePopover);

    popover = document.createElement("div");
    popover.className = "pf-level-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-modal", "true");
    popover.setAttribute("aria-labelledby", "pf-level-popover-title");
    popover.setAttribute("aria-describedby", "pf-level-popover-flavor");
    popover.hidden = true;
    popover.tabIndex = -1;
    popover.addEventListener("keydown", onPopoverKeydown);
    popover.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.matches) return;
      if (t.matches("[data-pf-level-close]") || t.closest("[data-pf-level-close]")) {
        closePopover();
      }
    });

    document.body.appendChild(popoverBackdrop);
    document.body.appendChild(popover);

    document.addEventListener("click", function (e) {
      if (popover.hidden) return;
      var t = e.target;
      if (!t) return;
      if (popover.contains(t)) return;
      if (openerEl && openerEl.contains(t)) return;
      closePopover();
    }, true);

    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);

    return popover;
  }

  function onPopoverKeydown(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      closePopover();
      return;
    }
    if (e.key === "Tab") {
      // Focus trap.
      var focusables = popover.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) {
        e.preventDefault();
        popover.focus();
        return;
      }
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function isMobile() {
    return window.matchMedia && window.matchMedia("(max-width: 600px)").matches;
  }

  function reposition() {
    if (!popover || popover.hidden || !openerEl) return;
    if (isMobile()) {
      // Bottom sheet — no positioning math.
      popover.style.top = "";
      popover.style.left = "";
      popover.style.right = "";
      popover.style.bottom = "";
      return;
    }
    var r = openerEl.getBoundingClientRect();
    var pw = popover.offsetWidth || 340;
    var ph = popover.offsetHeight || 280;
    var pad = 8;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    // Prefer below the trigger.
    var top = r.bottom + pad;
    if (top + ph > vh - 8) top = Math.max(8, r.top - ph - pad);
    var left = r.left;
    if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
    popover.style.position = "fixed";
    popover.style.top = top + "px";
    popover.style.left = left + "px";
    popover.style.right = "";
    popover.style.bottom = "";
  }

  function buildPopoverHtml(rep, tier) {
    var info = infoFor(tier);
    var badges = (rep && Array.isArray(rep.badges)) ? rep.badges : [];
    var badgeList = badges.length > 0
      ? '<ul class="pf-level-badges-list">' +
          badges.map(function (b) {
            return '<li><span class="pf-level-pill pf-level-pill--' + escHtml(b) + '" aria-hidden="true">' + escHtml(badgeGlyph(b)) + '</span> ' + escHtml(badgeLabel(b)) + "</li>";
          }).join("") +
        "</ul>"
      : "";
    var bucketLine = (rep && rep.partiesCompletedBucket && rep.partiesCompletedBucket !== "<5")
      ? '<p class="pf-level-stat">Co-op runs finished: <strong>' + escHtml(rep.partiesCompletedBucket) + "</strong></p>"
      : "";
    var pathItems = CLIMB_PATHS.map(function (p) {
      return '<li>' +
        '<span class="pf-level-path-points">' + escHtml(p.points) + '</span>' +
        '<span class="pf-level-path-body">' +
          '<strong>' + escHtml(p.label) + '</strong>' +
          '<span class="pf-level-path-detail">' + escHtml(p.detail) + '</span>' +
        '</span>' +
      '</li>';
    }).join("");

    return (
      '<header class="pf-level-popover-head">' +
        '<span class="pf-level-popover-icon" data-tier="' + escHtml(tier) + '" aria-hidden="true">' + escHtml(info.glyph) + "</span>" +
        '<div class="pf-level-popover-headline">' +
          '<h2 id="pf-level-popover-title" class="pf-level-popover-title">Level ' + info.level + ' · ' + escHtml(info.name) + "</h2>" +
          '<p id="pf-level-popover-flavor" class="pf-level-popover-flavor">' + escHtml(info.flavor) + "</p>" +
        "</div>" +
        '<button type="button" class="pf-level-popover-close" data-pf-level-close aria-label="Close level details">×</button>' +
      "</header>" +
      bucketLine +
      badgeList +
      '<section class="pf-level-section">' +
        '<h3 class="pf-level-section-title">How to climb</h3>' +
        '<ol class="pf-level-paths">' + pathItems + "</ol>" +
      "</section>" +
      '<section class="pf-level-section pf-level-section--why">' +
        '<h3 class="pf-level-section-title">Why rank matters</h3>' +
        '<p class="pf-level-why">' + escHtml(WHY_RANK_LINE) + "</p>" +
      "</section>" +
      '<footer class="pf-level-popover-foot">' +
        '<a class="pf-level-help-link" href="/coop#how-ranks-work" data-pf-level-close>How the Vault ranks players →</a>' +
      "</footer>"
    );
  }

  function openPopover(triggerEl) {
    if (!triggerEl) return;
    ensurePopover();
    openerEl = triggerEl;
    lastFocused = document.activeElement;
    var slot = triggerEl.closest("[data-pf-rep-slot]");
    var rep = (slot && slot.__pfRep) || null;
    var tier = (rep && rep.tier) || (slot ? slot.dataset.tier : "newcomer") || "newcomer";
    popover.dataset.tier = tier;
    popover.innerHTML = buildPopoverHtml(rep, tier);
    triggerEl.setAttribute("aria-expanded", "true");
    if (isMobile()) {
      popover.classList.add("pf-level-popover--sheet");
      popoverBackdrop.hidden = false;
    } else {
      popover.classList.remove("pf-level-popover--sheet");
      popoverBackdrop.hidden = true;
    }
    popover.hidden = false;
    reposition();
    // Initial focus to the close button so Esc / Enter is immediately
    // discoverable to keyboard / screen-reader users.
    var closeBtn = popover.querySelector(".pf-level-popover-close");
    if (closeBtn) closeBtn.focus();
    else popover.focus();
  }

  function closePopover() {
    if (!popover || popover.hidden) return;
    popover.hidden = true;
    if (popoverBackdrop) popoverBackdrop.hidden = true;
    if (openerEl) {
      try { openerEl.setAttribute("aria-expanded", "false"); } catch (_) {}
    }
    if (lastFocused && typeof lastFocused.focus === "function") {
      try { lastFocused.focus(); } catch (_) {}
    }
    openerEl = null;
    lastFocused = null;
  }

  function onDocumentClick(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var trigger = t.closest("[data-pf-level-trigger]");
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    if (openerEl === trigger && popover && !popover.hidden) {
      closePopover();
      return;
    }
    openPopover(trigger);
  }

  function onDocumentKeydown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var t = e.target;
    if (!t || !t.matches || !t.matches("[data-pf-level-trigger]")) return;
    e.preventDefault();
    if (openerEl === t && popover && !popover.hidden) {
      closePopover();
    } else {
      openPopover(t);
    }
  }

  // Expose the API for ad-hoc callers (Details modal, future surfaces).
  window.VaultLevelBadge = {
    open: function (sidOrEl) {
      var el = null;
      if (typeof sidOrEl === "string") {
        el = document.querySelector('[data-pf-rep-slot][data-host-steam-id="' + sidOrEl.replace(/"/g, "") + '"] [data-pf-level-trigger]');
      } else if (sidOrEl && sidOrEl.nodeType === 1) {
        el = sidOrEl.matches("[data-pf-level-trigger]") ? sidOrEl : sidOrEl.querySelector("[data-pf-level-trigger]");
      }
      if (el) openPopover(el);
    },
    close: closePopover,
    tierInfo: function (tier) { return infoFor(tier); },
    fetch: fetchRep,
  };

  function start() {
    autoAnnotateProdSurface(document);
    scan(document);
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onDocumentKeydown);

    if (typeof MutationObserver !== "function") return;
    // -------------------------------------------------------------------
    // v202 poll-jank fix:
    //
    // Old behavior — observe `document.body` with `subtree:true`. Every
    // single innerHTML write anywhere on the page (lobby list, recs,
    // primary state card, side card, party hub, modals, sandbox, even
    // toast injection) fired this callback, which then ran
    // `autoAnnotateProdSurface(document)` + `scan(document)` — two full
    // document walks per mutation, for every poll cycle. At 15s cadence
    // on a list with ~25 cards the page paid 50+ document walks per
    // poll just from this observer alone. That was the primary visible
    // "jump every 5–15s" jank source.
    //
    // New behavior — rAF-coalesced debounce: regardless of how many
    // mutations the page fires in one frame, we only do at most one
    // scan/annotate pass per animation frame. With the upstream
    // mutate-in-place renderers, unchanged-card polls no longer cause
    // any subtree mutation at all, so this observer becomes truly
    // quiet in steady state.
    //
    // We still observe document.body because the SPA-route swap, the
    // host modal, the Best Matches list, and dev sandbox can each
    // create rep-slot nodes outside the lobby surface. Scoping just
    // to one container would miss them.
    // -------------------------------------------------------------------
    var rafPending = false;
    function scheduleFullScan() {
      if (rafPending) return;
      rafPending = true;
      var run = function () {
        rafPending = false;
        try {
          autoAnnotateProdSurface(document);
          scan(document);
        } catch (_) { /* defensive — runtime augmentation must never crash the page */ }
      };
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(run);
      } else {
        setTimeout(run, 16);
      }
    }
    var mo = new MutationObserver(function (entries) {
      // Fast-path the synchronous work: directly hydrate any rep slot
      // that landed as an added node so a brand-new lobby card gets
      // its LevelBadge without waiting a frame. The expensive full
      // document scan is deferred to the next animation frame so a
      // burst of mutations only costs one walk.
      var sawAdds = false;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.addedNodes || e.addedNodes.length === 0) continue;
        for (var j = 0; j < e.addedNodes.length; j++) {
          var n = e.addedNodes[j];
          if (!n || n.nodeType !== 1) continue;
          sawAdds = true;
          if (n.matches && n.matches("[data-pf-rep-slot]")) hydrateSlot(n);
        }
      }
      if (sawAdds) scheduleFullScan();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
