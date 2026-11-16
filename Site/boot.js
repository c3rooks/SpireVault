/* Runs before first paint (a tiny blocking script in <head>): deals the
 * first screen's painted scene and its climber, so nothing swaps after the
 * page has drawn, and marks reduced motion. script.js does everything else.
 *
 * The scene is one of the app's painted scenes (css/world-data.css), never
 * the same one twice in a row on this device. The climber stands in the duel
 * and their card stands proud in the hand. The Fool has no runs in the
 * sample data, so he is always in the hand, never dealt.
 *
 * ?scene=<id> and ?climber=<id> pin the deal (used by the screenshot checks).
 * ?og=1 frames the hero for the 1200x630 link-preview picture.
 */
(function bootHero() {
  "use strict";
  var CLIMBERS = ["ironclad", "silent", "defect", "regent", "necrobinder"];
  // Every scene not used as a section band (scripts/build-site-world.mjs).
  var SCENES = ["hive", "study", "overgrowth", "underdocks", "crystal", "aurora", "embers", "crypt"];
  var LAST_SCENE_KEY = "spirevault.site.scene";
  var root = document.documentElement;
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (error) {
    params = null;
  }
  function pick(list, wanted, avoid) {
    if (wanted && list.indexOf(wanted) >= 0) return wanted;
    var pool = list.filter(function (id) {
      return id !== avoid;
    });
    return pool[Math.floor(Math.random() * pool.length)];
  }
  root.setAttribute("data-climber", pick(CLIMBERS, params ? params.get("climber") : null, null));

  var last = null;
  try {
    last = window.localStorage.getItem(LAST_SCENE_KEY);
  } catch (error) {
    last = null; // storage blocked: any scene will do
  }
  var scene = pick(SCENES, params ? params.get("scene") : null, last);
  root.setAttribute("data-scene", scene);
  try {
    window.localStorage.setItem(LAST_SCENE_KEY, scene);
  } catch (error) {
    // Storage full or blocked: the next visit may repeat it, nothing worse.
  }

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
