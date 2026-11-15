/* Runs before first paint (a tiny blocking script in <head>): rolls the
 * climber who stands in the hero, so the figure never swaps after the page
 * has drawn, and marks reduced motion. script.js does everything else.
 *
 * ?climber=<id> and ?room=<id> pin the roll (used by the screenshot checks).
 * ?og=1 frames the hero for the 1200x630 link-preview picture.
 *
 * It also holds back the room pictures further down the page ("lazy-art")
 * until script.js sees them come near the screen. If script.js never runs,
 * the hold is dropped once the page has loaded, so no room is left bare.
 */
(function bootHero() {
  "use strict";
  var CLIMBERS = ["ironclad", "silent", "defect", "regent", "necrobinder", "fool"];
  var ROOMS = ["glory", "study", "falls", "overgrowth", "hive", "underdocks"];
  var root = document.documentElement;
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (error) {
    params = null;
  }
  var wanted = params ? params.get("climber") : null;
  var climber = CLIMBERS.indexOf(wanted) >= 0 ? wanted : CLIMBERS[Math.floor(Math.random() * CLIMBERS.length)];
  root.setAttribute("data-climber", climber);

  var room = params ? params.get("room") : null;
  if (ROOMS.indexOf(room) >= 0) root.setAttribute("data-room", room);

  var reduce = false;
  try {
    reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    reduce = false;
  }
  if (reduce || (params && params.get("motion") === "off")) root.classList.add("reduce-motion");
  if (params && params.get("og") === "1") root.classList.add("og");
  root.classList.add("js");

  if ("IntersectionObserver" in window) {
    root.classList.add("lazy-art");
    window.addEventListener("load", function dropHoldIfScriptMissing() {
      if (!window.SpireVaultSite) root.classList.remove("lazy-art");
    });
  }
})();
