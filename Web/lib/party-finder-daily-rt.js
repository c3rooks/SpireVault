/* Daily Co-op Challenge — frontend tile.
 *
 * Loaded as a classic script alongside the other party-finder runtimes.
 * Fetches /coop/daily-challenge once per session (server-cached 5min),
 * injects a tile under the hero stat row showing today's seed +
 * suggested character + ascension. Click → copy seed to clipboard +
 * remember to tag the next-hosted lobby's note with `[daily=YYYY-MM-DD]`
 * so the server's joinedCount picks it up.
 *
 * Pure additive. If the API is unreachable the tile just doesn't render.
 */
(function attachDailyRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfDailyRuntime) return;
  window.__pfDailyRuntime = true;

  var REFRESH_MS = 5 * 60 * 1000;
  var challengeCache = null;
  var fetchedAtMs = 0;
  var inflight = null;
  var localTagKey = "pf.daily.activeDate.v1";

  function fetchChallenge() {
    if (challengeCache && Date.now() - fetchedAtMs < REFRESH_MS) {
      return Promise.resolve(challengeCache);
    }
    if (inflight) return inflight;
    inflight = fetch("/coop/daily-challenge", {
      credentials: "include",
      headers: { accept: "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        challengeCache = (j && j.challenge) ? j.challenge : null;
        fetchedAtMs = Date.now();
        inflight = null;
        return challengeCache;
      })
      .catch(function () { inflight = null; return null; });
    return inflight;
  }

  function characterLabel(slug) {
    switch (slug) {
      case "ironclad":    return "Ironclad";
      case "silent":      return "Silent";
      case "defect":      return "Defect";
      case "regent":      return "Regent";
      case "necrobinder": return "Necrobinder";
      default:            return slug || "Any";
    }
  }

  function copyToClipboard(text) {
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (_) { /* fall through */ }
    return new Promise(function (resolve) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (_) { /* ignore */ }
      resolve();
    });
  }

  function rememberActiveDailyDate(date) {
    try { window.localStorage.setItem(localTagKey, date); } catch (_) {}
  }

  function readActiveDailyDate() {
    try { return window.localStorage.getItem(localTagKey) || null; } catch (_) { return null; }
  }
  // Expose so party-finder.js (when it has access) can read for note prefilling.
  window.__pfDailyActiveDate = readActiveDailyDate;

  function toast(msg) {
    try {
      if (window.PFH && typeof window.PFH.toast === "function") {
        window.PFH.toast(msg);
        return;
      }
    } catch (_) {}
    // Lightweight inline toast fallback.
    try {
      var t = document.createElement("div");
      t.className = "pf-daily-toast";
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (_) {} }, 2400);
    } catch (_) {}
  }

  function render(target, challenge) {
    if (!target || !challenge) return;
    var seed = challenge.seed || "";
    var date = challenge.date || "";
    var charLabel = characterLabel(challenge.character);
    var asc = (typeof challenge.ascension === "number") ? challenge.ascension : 0;
    var joined = (typeof challenge.joinedCount === "number") ? challenge.joinedCount : 0;
    var joinedText = joined === 0
      ? "Be the first today"
      : (joined + (joined === 1 ? " host" : " hosts") + " today");
    target.innerHTML =
      '<button type="button" class="pf-daily-tile" data-pf-daily-tile' +
        ' aria-label="Today\'s Co-op Challenge — click to copy seed">' +
        '<span class="pf-daily-eyebrow">Today\'s Co-op Challenge</span>' +
        '<span class="pf-daily-seed" data-pf-daily-seed>' + seed + '</span>' +
        '<span class="pf-daily-meta">' +
          charLabel + ' · A' + asc +
        '</span>' +
        '<span class="pf-daily-joined">' + joinedText + '</span>' +
        '<span class="pf-daily-cta" aria-hidden="true">Copy seed</span>' +
      '</button>';
    var btn = target.querySelector("[data-pf-daily-tile]");
    if (btn) {
      btn.addEventListener("click", function () {
        copyToClipboard(seed);
        rememberActiveDailyDate(date);
        toast("Seed " + seed + " copied — type into STS2 seed field, then host a co-op room.");
      });
    }
  }

  function ensureMount() {
    // 1. Reuse existing slot if present (idempotent across re-pumps).
    var slot = document.querySelector("[data-pf-daily-host]");
    if (slot) return slot;

    // 2. Production default surface: coop-lobbies.js v23 Beta UI.
    //    Anchor the tile inside `.coop-work-main` at the top, ABOVE the
    //    invites/lobbies/recs sections so it's the first thing under the
    //    `.coop-bar` stat row. This is what real signed-in users see —
    //    the party-finder.js Scene below is only mounted on a deeper
    //    sandbox panel.
    var coopMain = document.querySelector(".coop-work-main");
    if (coopMain) {
      var wrap = document.createElement("div");
      wrap.className = "pf-daily-wrap pf-daily-wrap--coop-lobbies";
      wrap.setAttribute("data-pf-daily-host", "1");
      coopMain.insertBefore(wrap, coopMain.firstChild);
      return wrap;
    }

    // 3. Deeper party-finder.js Scene surface (sandbox / prototype).
    var hero = document.querySelector(".pf-stage, #pf-hero, #pf-root .pf-hero, #pf-stats");
    if (!hero) return null;
    var wrap2 = document.createElement("div");
    wrap2.className = "pf-daily-wrap";
    wrap2.setAttribute("data-pf-daily-host", "1");
    hero.appendChild(wrap2);
    return wrap2;
  }

  function pump() {
    var target = ensureMount();
    if (!target) return;
    fetchChallenge().then(function (c) {
      if (c) render(target, c);
    });
  }

  function start() {
    pump();
    // Re-pump on any major DOM swap (route changes, sandbox reseeds).
    if (typeof MutationObserver === "function") {
      var mo = new MutationObserver(function () {
        if (!document.querySelector(".pf-daily-tile")) pump();
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    // Hourly soft refresh in case the user keeps the tab open past midnight.
    setInterval(pump, 60 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
