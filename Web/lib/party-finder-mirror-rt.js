/* Discord LFG Mirror — frontend runtime.
 *
 * Polls /coop/mirrors every 30s and injects mirrored-lobby cards
 * INTO the existing lobby list with a "via Discord" badge. Cards
 * are visually distinct (purple Discord accent, dashed link
 * indicator) so users immediately know they're a bridge to an
 * external post, not a native SpireVault party.
 *
 * Why we render mirrors into the SAME list rather than a separate
 * tab:
 *
 *   - The cold-start problem we're solving IS the empty list. If
 *     mirrors live in a sidebar, the list still looks dead and the
 *     visitor still bounces.
 *   - SpireVault native lobbies have richer click behavior (join,
 *     show party). Mirror cards click out to Discord. That's a
 *     reasonable mixed-mode list as long as the visual treatment
 *     makes the difference obvious.
 *   - Filtering / sorting is consistent — the same "starting soon"
 *     bucket and reputation chips apply uniformly.
 *
 * Mounting strategy:
 *
 *   - Beta surface: inject mirror cards above the existing live
 *     parties list inside #pf-live-list. Use a wrapper marker so we
 *     don't fight party-finder.js's re-renders.
 *   - Production (coop-lobbies.js) surface: inject above the
 *     .coop-lobbies-grid. Same wrapper marker.
 *
 * Idempotent: re-poll just diffs against existing mirror cards and
 * adds/removes as needed. No full DOM teardown per poll.
 */
(function attachMirrorRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfMirrorRuntime) return;
  window.__pfMirrorRuntime = true;

  var POLL_MS = 30 * 1000;
  var WRAP_ID = "pf-mirror-wrap";
  var EMPTY_WRAP_ID = "pf-mirror-empty-wrap";

  // Inline SVG used in the "via Discord" badge. Lucide-derived
  // chat-bubble + matches the icon language elsewhere in v0.11.2.
  var ICON_DISCORD =
    '<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" ' +
    'class="pf-mirror-badge-icon">' +
      '<path d="M20 11a8 8 0 0 0-16 0v6a4 4 0 0 0 4 4h2v-6H6v-2a6 6 0 0 1 12 0v2h-4v6h2a4 4 0 0 0 4-4v-6z" ' +
        'fill="currentColor"/>' +
    '</svg>';

  function ensureCss() {
    if (document.getElementById("pf-mirror-css")) return;
    var l = document.createElement("link");
    l.id = "pf-mirror-css";
    l.rel = "stylesheet";
    l.href = "/lib/party-finder-mirror.css?v=2";
    document.head.appendChild(l);
  }

  // ── Polling ─────────────────────────────────────────────────────
  var lastFetchAt = 0;
  var inflight = null;
  var lastSnapshot = []; // last successful fetch's mirrors array
  function fetchMirrors() {
    if (inflight) return inflight;
    if (Date.now() - lastFetchAt < 5000 && lastSnapshot.length) {
      return Promise.resolve(lastSnapshot);
    }
    inflight = fetch("/coop/mirrors", {
      credentials: "omit", // public endpoint
      headers: { accept: "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        inflight = null;
        lastFetchAt = Date.now();
        if (j && Array.isArray(j.mirrors)) {
          lastSnapshot = j.mirrors;
          return j.mirrors;
        }
        return [];
      })
      .catch(function () { inflight = null; return lastSnapshot; });
    return inflight;
  }

  // ── Hint chip rendering ─────────────────────────────────────────
  function characterLabel(slug) {
    switch (slug) {
      case "ironclad":    return "Ironclad";
      case "silent":      return "Silent";
      case "defect":      return "Defect";
      case "regent":      return "Regent";
      case "necrobinder": return "Necrobinder";
      default:            return slug || "?";
    }
  }
  function voiceLabel(state) {
    if (state === "no-voice") return "No voice";
    if (state === "voice")    return "Voice";
    if (state === "optional") return "Voice optional";
    return "";
  }
  function buildHints(hints) {
    if (!hints || typeof hints !== "object") return "";
    var chips = [];
    if (typeof hints.ascension === "number") {
      chips.push('<span class="pf-mirror-chip pf-mirror-chip--asc">A' + hints.ascension + '</span>');
    }
    if (Array.isArray(hints.characters) && hints.characters.length) {
      hints.characters.slice(0, 3).forEach(function (c) {
        chips.push('<span class="pf-mirror-chip pf-mirror-chip--char">' + escapeHtml(characterLabel(c)) + '</span>');
      });
    }
    var v = voiceLabel(hints.voiceState);
    if (v) {
      chips.push('<span class="pf-mirror-chip pf-mirror-chip--voice">' + escapeHtml(v) + '</span>');
    }
    if (typeof hints.seatsWanted === "number" && hints.seatsWanted > 0) {
      chips.push('<span class="pf-mirror-chip pf-mirror-chip--seats">+' + hints.seatsWanted + ' wanted</span>');
    }
    if (typeof hints.daily === "string" && hints.daily) {
      chips.push('<span class="pf-mirror-chip pf-mirror-chip--daily">Daily seed</span>');
    }
    return chips.join("");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function relTime(iso) {
    var t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    var d = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (d < 60)    return d + "s ago";
    if (d < 3600)  return Math.floor(d / 60) + "m ago";
    if (d < 86400) return Math.floor(d / 3600) + "h ago";
    return Math.floor(d / 86400) + "d ago";
  }

  // ── Card markup ─────────────────────────────────────────────────
  function buildCardHtml(m) {
    var avatar = m.authorAvatarUrl
      ? '<img class="pf-mirror-avatar" src="' + escapeHtml(m.authorAvatarUrl) + '" alt="" referrerpolicy="no-referrer"/>'
      : '<div class="pf-mirror-avatar pf-mirror-avatar--fallback" aria-hidden="true">' +
          escapeHtml((m.authorName || "?").charAt(0).toUpperCase()) +
        '</div>';
    var chipsHtml = buildHints(m.parsedHints);
    var msg = escapeHtml(m.rawMessage || "").slice(0, 200);
    var src = m.discordChannelName && m.discordChannelName !== "discord"
      ? "#" + escapeHtml(m.discordChannelName) + " \u2022 " + escapeHtml(m.discordGuildName || "Discord")
      : escapeHtml(m.discordGuildName || "Discord");
    var jump = m.discordJumpUrl || "https://discord.com/";
    return ''
      + '<a class="pf-mirror-card" data-pf-mirror-id="' + escapeHtml(m.mirrorId || "") + '"'
      +   ' href="' + escapeHtml(jump) + '" target="_blank" rel="noopener noreferrer">'
      +   '<div class="pf-mirror-card-head">'
      +     avatar
      +     '<div class="pf-mirror-card-id">'
      +       '<div class="pf-mirror-author">' + escapeHtml(m.authorName || "Discord user") + '</div>'
      +       '<div class="pf-mirror-source">' + src + ' \u2022 ' + escapeHtml(relTime(m.postedAt)) + '</div>'
      +     '</div>'
      +     '<div class="pf-mirror-badge" title="Bridged from Discord">'
      +       ICON_DISCORD
      +       '<span>via Discord</span>'
      +     '</div>'
      +   '</div>'
      +   (msg ? '<div class="pf-mirror-message">' + msg + '</div>' : '')
      +   (chipsHtml ? '<div class="pf-mirror-chips">' + chipsHtml + '</div>' : '')
      +   '<div class="pf-mirror-foot">'
      +     '<span class="pf-mirror-foot-cta">Open in Discord \u2192</span>'
      +   '</div>'
      + '</a>';
  }

  // ── Wrapper management ──────────────────────────────────────────
  /**
   * Find the right place to mount the mirror wrapper. The order is:
   *
   *   1. Beta surface (#pf-live-list)         — signed-in, rich UI
   *   2. Production surface (.coop-lobbies-grid) — signed-in, classic UI
   *   3. Guest surface (.guest-coop)          — signed-out visitors
   *
   * Mounting on the guest surface is THE cold-start unlock: most
   * first-time visitors are signed out, and showing them real live
   * Discord LFG activity ("here are 4 players in your timezone
   * looking right now → sign in to play with them") is the highest-
   * leverage conversion lever for the whole funnel.
   */
  function findMountTarget() {
    // Beta surface — inject above #pf-live-list (inside its parent
    // section so the section header acts as the "Live Parties" label).
    var betaList = document.getElementById("pf-live-list");
    if (betaList && betaList.parentElement) {
      return { mode: "beta", parent: betaList.parentElement, anchor: betaList };
    }
    // Production surface (coop-lobbies.js).
    var coopGrid = document.querySelector(".coop-lobbies-grid");
    if (coopGrid && coopGrid.parentElement) {
      return { mode: "coop", parent: coopGrid.parentElement, anchor: coopGrid };
    }
    // Guest surface — signed-out visitors. Append to .guest-coop so
    // the mirror strip sits BELOW the Steam sign-in card (the card
    // remains the primary CTA) but still above any "what does
    // signing in do" details. The intent: visitor sees real Discord
    // LFG activity in their first scroll → "people are actually
    // here, let me sign in".
    var guest = document.querySelector(".guest-coop");
    if (guest) {
      return { mode: "guest", parent: guest, anchor: null };
    }
    return null;
  }

  function ensureWrap() {
    var existing = document.getElementById(WRAP_ID);
    if (existing) return existing;
    var target = findMountTarget();
    if (!target) return null;
    var wrap = document.createElement("div");
    wrap.id = WRAP_ID;
    wrap.className = "pf-mirror-wrap pf-mirror-wrap--" + target.mode;
    wrap.setAttribute("aria-label", "Bridged from Discord");
    if (target.anchor) {
      target.parent.insertBefore(wrap, target.anchor);
    } else {
      // No anchor — append (used by the guest surface where the
      // mirror strip is appended below the sign-in card).
      target.parent.appendChild(wrap);
    }
    return wrap;
  }

  /**
   * Inject a "+N more on Discord" footer line when there are mirrors,
   * giving the user the explicit context that the list contains
   * bridged content. Critical for trust — they shouldn't be surprised
   * when a card opens Discord instead of joining a SpireVault party.
   */
  function renderHeader(wrap, count) {
    var head = wrap.querySelector("[data-pf-mirror-head]");
    if (count <= 0) {
      if (head) head.remove();
      return;
    }
    if (!head) {
      head = document.createElement("div");
      head.setAttribute("data-pf-mirror-head", "1");
      head.className = "pf-mirror-head";
      wrap.appendChild(head);
    }
    head.innerHTML = ''
      + '<span class="pf-mirror-head-icon" aria-hidden="true">' + ICON_DISCORD + '</span>'
      + '<span class="pf-mirror-head-title">'
      +   count + ' active LFG post' + (count === 1 ? '' : 's') + ' bridged from Discord'
      + '</span>'
      + '<span class="pf-mirror-head-sub">Click a card to view the original message in Discord.</span>';
  }

  function renderList(wrap, mirrors) {
    var list = wrap.querySelector("[data-pf-mirror-list]");
    if (!list) {
      list = document.createElement("div");
      list.setAttribute("data-pf-mirror-list", "1");
      list.className = "pf-mirror-list";
      wrap.appendChild(list);
    }
    if (mirrors.length === 0) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = mirrors.map(buildCardHtml).join("");
  }

  // ── Tick ────────────────────────────────────────────────────────
  function tick() {
    fetchMirrors().then(function (mirrors) {
      mirrors = Array.isArray(mirrors) ? mirrors : [];
      var wrap = ensureWrap();
      if (!wrap) return; // mount target not ready
      renderHeader(wrap, mirrors.length);
      renderList(wrap, mirrors);
      // If wrap is empty AND we have an empty mount, kill the wrap so
      // we don't leave behind a phantom header div.
      if (mirrors.length === 0) {
        var head = wrap.querySelector("[data-pf-mirror-head]");
        var list = wrap.querySelector("[data-pf-mirror-list]");
        if (!head && (!list || !list.children.length)) {
          wrap.remove();
        }
      }
    });
  }

  function init() {
    ensureCss();
    tick();
    setInterval(tick, POLL_MS);
    // Re-tick on visibility change so a tab that's been backgrounded
    // for >30s gets fresh data the moment it comes back.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") tick();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
