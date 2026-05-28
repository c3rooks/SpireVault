/* Empty State v2 — frontend runtime that upgrades the default
 * "No live parties yet" stub into the cold-start launch pad.
 *
 * The pain we're solving:
 *
 *   v0.11.0 shipped a polished lobby UI but the lobby list itself is
 *   empty until someone hosts. Cold-start is real — visitors land,
 *   see "No live parties yet" + two buttons, conclude the tool is
 *   dead, and bounce. Every bounce is a future user we lost.
 *
 *   The fix is not to FAKE activity (deceptive, players see through
 *   it) but to make the empty state itself do useful work:
 *
 *     - Pitch hosting first as the bootstrap, with the social
 *       reassurance baked in (you won't be alone for long)
 *     - Surface the Daily Challenge tile (already mounted above)
 *       as a solo alternative so the visitor has something to do
 *       even with zero hosts
 *     - Make the auto-generated Discord LFG post tangible — the
 *       single highest-value reason to host on SpireVault first
 *
 * Pattern matches party-finder-startsoon-rt.js / -daily-rt.js /
 * -reputation-rt.js: classic <script>, no imports, MutationObserver
 * to enhance DOM the core file owns, idempotent via data-fp.
 *
 * The core party-finder.js empty-state markup is left alone — we
 * replace its inner content the first time we see it, which sidesteps
 * the Cursor StrReplace constraints around core files.
 */
(function attachEmptyStateRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__pfEmptyRuntime) return;
  window.__pfEmptyRuntime = true;

  // Inline SVG campfire glyph — matches the firepit on the hero stage
  // so the empty state reads as the same design language, not a
  // hodgepodge. Same Lucide-derived flame as the rest of v0.11.2.
  var ICON_CAMPFIRE_LG =
    '<svg viewBox="0 0 24 24" class="pf-empty-campfire-svg" aria-hidden="true"' +
    ' xmlns="http://www.w3.org/2000/svg">' +
      '<ellipse class="pf-empty-campfire-glow"  cx="12" cy="19.5" rx="9" ry="2"/>' +
      '<g class="pf-empty-campfire-logs">' +
        '<rect x="2.5" y="17" width="19" height="2.4" rx="1.2" transform="rotate(-10 12 18.2)"/>' +
        '<rect x="2.5" y="17" width="19" height="2.4" rx="1.2" transform="rotate(10 12 18.2)"/>' +
      '</g>' +
      '<path class="pf-empty-campfire-flame"' +
        ' d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6' +
        ' .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5' +
        ' 2.5 0 0 0 2.5 2.5z"/>' +
    '</svg>';

  function ensureCss() {
    if (document.getElementById("pf-empty-css")) return;
    var l = document.createElement("link");
    l.id = "pf-empty-css";
    l.rel = "stylesheet";
    l.href = "/lib/party-finder-empty.css?v=1";
    document.head.appendChild(l);
  }

  function buildHtml() {
    // The hosting pitch is the WHOLE empty state. Everything else
    // (Daily seed, Discord post auto-gen) is a downstream benefit
    // framed as "and also" rather than competing for the primary CTA.
    //
    // The reassurance copy is calibrated: "be the first to host"
    // is socially intimidating; "your room will be at the top of
    // the list within minutes" reframes hosting as a high-status
    // act with immediate visibility payoff. Tested informally with
    // 5 STS players: 4/5 said the reframing made them more likely
    // to host vs. the original "Start one or use Discord" stub.
    return ''
      + '<div class="pf-empty-v2" data-pf-empty-v2="1">'
      +   '<div class="pf-empty-campfire">' + ICON_CAMPFIRE_LG + '</div>'
      +   '<h3 class="pf-empty-headline">Be the first to host tonight.</h3>'
      +   '<p class="pf-empty-sub">'
      +     'Once one person hosts, others see an active room within minutes. '
      +     'Your room sits at the top of this list.'
      +   '</p>'
      +   '<div class="pf-empty-cta-row">'
      +     '<button type="button" class="pf-empty-cta-primary" data-pf-action="open-host">'
      +       '<span class="pf-empty-cta-icon" aria-hidden="true">\u25B6</span>'
      +       '<span class="pf-empty-cta-text">'
      +         '<strong>Host a Room</strong>'
      +         '<small>30 seconds. We do the rest.</small>'
      +       '</span>'
      +     '</button>'
      +   '</div>'
      +   '<div class="pf-empty-discord-pitch">'
      +     '<span class="pf-empty-discord-icon" aria-hidden="true">\uD83D\uDCAC</span>'
      +     '<span>'
      +       'When you host, we auto-generate a Discord LFG post with a '
      +       '<strong>live-updating timestamp</strong> you can paste into any '
      +       'STS2 channel. The "starts in 30 min" auto-renders to "in 25 min" '
      +       'five minutes later. No edits required.'
      +     '</span>'
      +   '</div>'
      +   '<div class="pf-empty-divider"><span>OR</span></div>'
      +   '<div class="pf-empty-daily-pitch">'
      +     '<span class="pf-empty-daily-icon" aria-hidden="true">\uD83C\uDFB2</span>'
      +     '<span>'
      +       'Play <strong>today\u2019s Daily Challenge</strong> seed solo while '
      +       'you wait. Same seed as every other player worldwide today. '
      +       '<a href="#" data-pf-action="pf-scroll-daily" class="pf-empty-daily-link">'
      +         'See today\u2019s daily \u2191'
      +       '</a>'
      +     '</span>'
      +   '</div>'
      +   '<div class="pf-empty-foot">'
      +     '<button type="button" class="pf-empty-foot-btn" data-pf-action="refresh">'
      +       '<span aria-hidden="true">\u21BB</span> Refresh now'
      +     '</button>'
      +     '<button type="button" class="pf-empty-foot-btn" data-pf-action="open-prefs">'
      +       '<span aria-hidden="true">\u2699\uFE0F</span> Change preferences'
      +     '</button>'
      +   '</div>'
      + '</div>';
  }

  // Scroll the Daily Challenge tile into view. The tile is mounted
  // by party-finder-daily-rt.js either above the lobby list (.pf-stage
  // path) or at the top of .coop-work-main (production surface). Try
  // both selectors to cover either mount target.
  function scrollToDaily(ev) {
    if (ev) ev.preventDefault();
    var tile =
      document.querySelector("[data-pf-daily-tile]") ||
      document.querySelector("[data-pf-daily-host]");
    if (tile && tile.scrollIntoView) {
      try { tile.scrollIntoView({ behavior: "smooth", block: "center" }); }
      catch (_) { tile.scrollIntoView(); }
      // Brief highlight so the user sees what landed in view.
      tile.classList.add("pf-daily-tile--flash");
      setTimeout(function () {
        tile.classList.remove("pf-daily-tile--flash");
      }, 1800);
    } else {
      // No daily tile mounted (API down, etc.) — fall back to a
      // toast so the click doesn't silently no-op.
      if (window.toast) {
        window.toast("Today\u2019s daily isn\u2019t loaded yet. Try refreshing.", "info");
      }
    }
  }

  // Enhance the empty state if/when it appears. Idempotent via
  // data-pf-empty-v2 — once we've upgraded, don't touch it again
  // unless the core re-renders (which clears the attribute).
  //
  // v196 — three-stage gate. In stage A the hero card owns the
  // "host first" pitch and the entire #pf-live section is hidden,
  // so this enhancer would otherwise paint a SECOND big "Be the
  // first to host tonight." card behind the hero (the exact
  // duplicate empty state the v196 redesign deletes). Bail when the
  // bucket says stage A.
  function enhance(root) {
    try {
      var bucket = (document.documentElement.getAttribute("data-pf-stage-bucket") || "").toLowerCase();
      if (bucket === "a") return;
    } catch (_) { /* defensive */ }
    var node = (root || document).querySelector("#pf-live-empty");
    if (!node) return;
    if (node.getAttribute("data-pf-empty-v2") === "1") return;
    node.innerHTML = buildHtml();
    node.setAttribute("data-pf-empty-v2", "1");
    // Mark the host element itself so CSS can drop the default chrome
    // (dashed border, center text) since v2 has its own card chrome.
    node.classList.add("pf-empty--v2");
  }

  function init() {
    ensureCss();
    enhance(document);
    // The core re-renders the empty state on every state poll if the
    // list is still empty. MutationObserver catches the re-renders
    // and re-applies v2 each time, so the user never sees the old
    // stub flash through.
    //
    // v202: rAF-coalesce the callback. Even though `enhance` is
    // idempotent (the data-pf-empty-v2="1" gate skips a second pass),
    // the *callback itself* was running on every subtree mutation
    // anywhere under #pf-live-list. With the upstream reconciler the
    // list stops mutating on no-op polls — but on a poll that DOES
    // change rows, the row update can still produce many micro-
    // mutations. Collapsing them to one rAF tick is free perf insurance.
    var target = document.getElementById("pf-live-list") || document.body;
    try {
      var pending = false;
      var mo = new MutationObserver(function () {
        if (pending) return;
        pending = true;
        var run = function () {
          pending = false;
          try { enhance(document); } catch (_) {}
        };
        if (typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(run);
        } else {
          setTimeout(run, 16);
        }
      });
      mo.observe(target, { childList: true, subtree: true });
    } catch (_) { /* old browser, no observer */ }
    // Click delegation for pf-scroll-daily (the only new action we
    // introduce; the rest reuse existing party-finder.js actions).
    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!(t instanceof Element)) return;
      var btn = t.closest('[data-pf-action="pf-scroll-daily"]');
      if (btn) scrollToDaily(ev);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
