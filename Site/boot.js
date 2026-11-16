/* Runs before first paint (a tiny blocking script in <head>): rolls which
 * climber's card is featured in the hero, so the picture never swaps after
 * the page has drawn, and marks reduced motion. script.js does everything else.
 *
 * ?climber=<id> pins the roll (used by the screenshot checks). The Fool has
 * no runs in the sample data, so he is always in the hand, never featured.
 * ?og=1 frames the hero for the 1200x630 link-preview picture.
 */
(function bootHero() {
  "use strict";
  var FEATURED = ["ironclad", "silent", "defect", "regent", "necrobinder"];
  var root = document.documentElement;
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (error) {
    params = null;
  }
  var wanted = params ? params.get("climber") : null;
  var climber = FEATURED.indexOf(wanted) >= 0 ? wanted : FEATURED[Math.floor(Math.random() * FEATURED.length)];
  root.setAttribute("data-climber", climber);

  var reduce = false;
  try {
    reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (error) {
    reduce = false;
  }
  if (reduce || (params && params.get("motion") === "off")) root.classList.add("reduce-motion");
  if (params && params.get("og") === "1") root.classList.add("og");
  root.classList.add("js");
})();
