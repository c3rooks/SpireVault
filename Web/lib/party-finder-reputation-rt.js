/* Verified Co-op Reputation — frontend display layer.
 *
 * Loaded as a classic script by coop-sandbox.js after the party-finder
 * scene + startsoon runtime. Watches `.pf-host-strip` host strips and
 * injects a small tier dot + tooltip into every `[data-pf-rep-slot]`
 * that has a `data-host-steam-id`.
 *
 * Cache:
 *   - In-memory `Map<steamID, { fetchedAt, blob, ttlMs }>`. Default
 *     TTL 5 minutes (matches server `COOP_REP_PUBLIC_FRESH_MS`).
 *   - In-flight `Map<steamID, Promise>` so concurrent rows for the
 *     same host coalesce to one network call.
 *
 * Failure modes are silent. If the API returns a 404 / 500 / network
 * error the dot just doesn't render — the lobby row keeps working.
 */
(function attachReputationRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfRepRuntime) return;
  window.__pfRepRuntime = true;

  var CACHE_TTL_MS = 5 * 60 * 1000;
  var cache = new Map(); // steamID -> { at, blob }
  var inflight = new Map(); // steamID -> Promise

  function fetchRep(steamID) {
    if (!steamID) return Promise.resolve(null);
    var cached = cache.get(steamID);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return Promise.resolve(cached.blob);
    }
    var pending = inflight.get(steamID);
    if (pending) return pending;
    var url = "/coop/reputation/" + encodeURIComponent(steamID);
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
        return null;
      });
    inflight.set(steamID, p);
    return p;
  }

  function tierLabel(tier) {
    switch (tier) {
      case "newcomer": return "New host";
      case "regular":  return "Regular";
      case "trusted":  return "Trusted host";
      case "veteran":  return "Veteran";
      case "ascended": return "Ascended";
      default:         return "";
    }
  }

  function badgeLabel(b) {
    switch (b) {
      case "heart_kill":    return "Heart kill";
      case "a20_clear":     return "A20 clear";
      case "host_reliable": return "Reliable host";
      case "active_recent": return "Active";
      default:              return b;
    }
  }

  function tooltipText(rep) {
    if (!rep) return "";
    var parts = [tierLabel(rep.tier)];
    if (Array.isArray(rep.badges) && rep.badges.length > 0) {
      parts.push(rep.badges.map(badgeLabel).join(" · "));
    }
    if (rep.partiesCompletedBucket) {
      parts.push("Co-op runs: " + rep.partiesCompletedBucket);
    }
    return parts.join(" — ");
  }

  function renderSlot(slot, rep) {
    if (!slot) return;
    if (!rep || rep.tier === "newcomer") {
      // Newcomer = no signal. Render nothing to keep rows clean.
      slot.innerHTML = "";
      slot.removeAttribute("data-tier");
      slot.removeAttribute("title");
      return;
    }
    slot.dataset.tier = rep.tier;
    slot.setAttribute("title", tooltipText(rep));
    slot.setAttribute("aria-label", tooltipText(rep));
    var badgesHtml = "";
    if (Array.isArray(rep.badges) && rep.badges.length > 0) {
      badgesHtml = '<span class="pf-rep-badges" aria-hidden="true">' +
        rep.badges.slice(0, 3).map(function (b) {
          var glyph = b === "heart_kill" ? "♥"
                    : b === "a20_clear" ? "A20"
                    : b === "host_reliable" ? "✓"
                    : b === "active_recent" ? "•"
                    : "";
          return '<span class="pf-rep-badge pf-rep-badge--' + b + '">' + glyph + "</span>";
        }).join("") +
      "</span>";
    }
    slot.innerHTML =
      '<span class="pf-rep-dot pf-rep-dot--' + rep.tier + '" aria-hidden="true"></span>' +
      badgesHtml;
  }

  function hydrateSlot(slot) {
    if (!slot || slot.dataset.pfRepHydrated === "1") return;
    var sid = slot.getAttribute("data-host-steam-id");
    if (!sid) return;
    slot.dataset.pfRepHydrated = "1";
    fetchRep(sid).then(function (rep) { renderSlot(slot, rep); });
  }

  function scan(root) {
    var nodes = (root || document).querySelectorAll("[data-pf-rep-slot]");
    for (var i = 0; i < nodes.length; i++) hydrateSlot(nodes[i]);
  }

  function start() {
    scan(document);
    if (typeof MutationObserver !== "function") return;
    var mo = new MutationObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        for (var j = 0; j < e.addedNodes.length; j++) {
          var n = e.addedNodes[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.matches && n.matches("[data-pf-rep-slot]")) hydrateSlot(n);
          if (n.querySelectorAll) scan(n);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
