/* Post-run Shared Report — frontend.
 *
 * Adds a "Share this run" button to the user's own active-party row
 * once the party has reached `in_game` for any member, and also to
 * the row immediately after `endParty` is called (the row gets a
 * 30-second grace before disappearing). Tapping the button:
 *
 *   1. POSTs /coop/share/from-party with the partyId.
 *   2. Server returns a shareId.
 *   3. Copies a public share URL — https://app.spirevault.app/share/coop/:shareId —
 *      to the clipboard.
 *   4. Toasts the URL so the user knows what landed.
 *   5. If the host typed a caption, it gets included on the share card
 *      (one-line prompt before POST).
 *
 * Pure additive. If the API fails the button just shows "Couldn't
 * share — try again."
 */
(function attachShareRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfShareRuntime) return;
  window.__pfShareRuntime = true;

  function getState() {
    try {
      if (typeof window.__pfGetLastState === "function") {
        return window.__pfGetLastState() || null;
      }
    } catch (_) {}
    return null;
  }

  function getActiveParty() {
    var s = getState();
    return s && s.party ? s.party : null;
  }

  function partyEligible(party) {
    if (!party || !Array.isArray(party.members)) return false;
    // Eligible once any member is in_game OR was in_game (status === left
    // counts as having played because the engine only marks left after
    // they passed through in_game in the abandon path).
    return party.members.some(function (m) {
      return m.status === "in_game" || m.status === "left";
    });
  }

  function toast(msg) {
    try {
      if (window.PFH && typeof window.PFH.toast === "function") {
        window.PFH.toast(msg);
        return;
      }
    } catch (_) {}
    try {
      var t = document.createElement("div");
      t.className = "pf-daily-toast"; // reuse existing toast styling
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(function () { try { t.remove(); } catch (_) {} }, 3000);
    } catch (_) {}
  }

  function copyText(text) {
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }
    } catch (_) {}
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
      } catch (_) {}
      resolve();
    });
  }

  function captureShare(partyId, caption) {
    return fetch("/coop/share/from-party", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ partyId: partyId, ...(caption ? { caption: caption } : {}) }),
    })
      .then(function (r) { if (!r.ok) throw new Error("http_" + r.status); return r.json(); })
      .then(function (j) { return j && j.shareId ? j.shareId : null; })
      .catch(function () { return null; });
  }

  function ensureShareBtn(row) {
    if (row.querySelector("[data-pf-share-btn]")) return;
    var actions = row.querySelector(".pf-live-actions") || row;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pf-share-btn";
    btn.setAttribute("data-pf-share-btn", "1");
    btn.textContent = "Share this run";
    btn.addEventListener("click", function () {
      var party = getActiveParty();
      if (!party) {
        toast("No active party to share.");
        return;
      }
      // Best-effort one-line caption prompt — Esc / blank submits without one.
      var caption = null;
      try {
        var input = window.prompt("One-line caption for the share card (optional):", "");
        if (input && input.trim().length > 0) caption = input.trim();
      } catch (_) {}
      btn.disabled = true;
      btn.textContent = "Capturing…";
      captureShare(party.partyId, caption).then(function (shareId) {
        btn.disabled = false;
        if (!shareId) {
          btn.textContent = "Couldn't share — try again";
          setTimeout(function () { btn.textContent = "Share this run"; }, 2500);
          return;
        }
        var url = window.location.origin + "/share/coop/" + encodeURIComponent(shareId);
        copyText(url).then(function () {
          btn.textContent = "Copied ✓";
          toast("Share URL copied — paste it anywhere: " + url);
          setTimeout(function () { btn.textContent = "Share this run"; }, 2500);
        });
      });
    });
    actions.appendChild(btn);
  }

  function scan() {
    var party = getActiveParty();
    if (!partyEligible(party)) return;
    if (!party.lobbyId) return;
    var row = document.querySelector(
      '.pf-live-row[data-lobby-id="' + String(party.lobbyId).replace(/"/g, '\\"') + '"]',
    );
    if (!row) return;
    ensureShareBtn(row);
  }

  function start() {
    scan();
    if (typeof MutationObserver === "function") {
      var mo = new MutationObserver(function () { scan(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    // Also rescan periodically in case state updates without a DOM swap.
    setInterval(scan, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
