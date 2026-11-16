/* SpireVault landing page.
 *
 *   1. The featured climber's card carries one of their own lines
 *   2. Live "players signed up" count from the matchmaking server
 *   3. Download links and version pills from the latest GitHub release
 *   4. The screenshot buttons under "Your numbers, drawn like the game"
 *   5. Sections rise into place as they scroll in
 *   6. A link to an answer opens it
 *
 * The page is complete without any of this: every element below has a
 * sensible server-rendered default, and each feature fails on its own.
 * boot.js (in <head>) has already rolled the climber and marked reduced
 * motion before this runs.
 */
(() => {
  "use strict";

  const SERVER_URL = "https://vault-coop.coreycrooks.workers.dev";
  const GITHUB_REPO = "c3rooks/SpireVault";
  // Matches the app's own poll and the "updates every 30 s" the page claims.
  const PRESENCE_POLL_MS = 30_000;
  const SHOT_WIDTHS = Object.freeze([960, 1440, 1920, 2880]);
  const SHOT_DEFAULT_WIDTH = 1440;
  const PHONE_SHOT_WIDTHS = Object.freeze([780, 1170]);
  // Installers may only be linked from this repository's own release downloads.
  const RELEASE_ASSET_PREFIX = `https://github.com/${GITHUB_REPO}/releases/download/`;

  const root = document.documentElement;
  const byId = (id) => document.getElementById(id);
  const setText = (el, text) => {
    if (el) el.textContent = text;
  };
  const params = (() => {
    try {
      return new URLSearchParams(window.location.search);
    } catch {
      return new URLSearchParams();
    }
  })();

  // ---- 1. The climber's line ---------------------------------------------------
  // The same lines the app's header duel uses (Web/script.js CLIMBER_LINES).
  const OWN_LINES = Object.freeze({
    ironclad: Object.freeze(["Anger. Steel. Repeat.", "Burning Blood keeps me going.", "Strength I trust.", "Bash first. Talk never.", "Block, anger, kill."]),
    silent: Object.freeze(["From the shadows.", "Silent. Deadly. Done.", "Daggers first.", "Poisons stack. So do bodies.", "Catalyst on full poison. Watch."]),
    defect: Object.freeze(["Channel. Defend. Destroy.", "Three orbs. One plan.", "Compute the kill.", "Lightning prefers your face.", "Frost and Focus. That's all."]),
    regent: Object.freeze(["Bow to the deck.", "My court awaits.", "The crown is heavy. So is my hammer.", "Kneel or fall. Either works."]),
    necrobinder: Object.freeze(["Bones remember.", "Death is a setback.", "I bound them. They bind back.", "The grave has a deck list."]),
  });

  /**
   * The lines a featured climber may say.
   * @param {string} climber
   * @returns {ReadonlyArray<string>}
   */
  function linesFor(climber) {
    return OWN_LINES[climber] || [];
  }

  function speak() {
    const climber = root.getAttribute("data-climber") || "";
    // The card boot.js chose; each card already carries a line of its own.
    const line = document.querySelector(`.featured[data-c="${CSS.escape(climber)}"] .featured-line`);
    if (!line) return;
    const lines = linesFor(climber);
    if (lines.length === 0) return; // the card keeps the line it was written with
    // ?line=<n> pins the line (the screenshot checks use it).
    const pinned = Number.parseInt(params.get("line") || "", 10);
    const index = Number.isInteger(pinned) ? Math.abs(pinned) % lines.length : Math.floor(Math.random() * lines.length);
    setText(line, lines[index]);
  }

  // ---- 2. Live count -----------------------------------------------------------
  // The server's roster is everyone signed up, not everyone online right now,
  // so the wording says "signed up".
  /** @param {number} count @param {number} inGame */
  function presenceCopy(count, inGame) {
    if (count === 0) {
      return { line: "Be the first to sign up.", count: "—", label: "no one signed up yet · be the first", inGame: "—" };
    }
    const plural = count === 1 ? "player signed up" : "players signed up";
    return {
      line: inGame > 0 ? `${count} signed up · ${inGame} currently in Slay the Spire 2` : `${count} ${plural}`,
      count: String(count),
      label: plural,
      inGame: String(inGame),
    };
  }

  const PRESENCE_DOWN = Object.freeze({
    line: "Live count unavailable right now.",
    count: "—",
    label: "live count unavailable right now",
    inGame: "—",
  });

  /**
   * The live dots (hero chip and co-op ticket) take the state's colour, as
   * the app's connection line does: gold while checking (no state yet),
   * green when people are signed up, grey when nobody is, red when the count
   * cannot be reached.
   * @param {{ line: string, count: string, label: string, inGame: string }} copy
   * @param {"live"|"empty"|"down"} state
   */
  function showPresence(copy, state) {
    setText(byId("presence-text"), copy.line);
    setText(byId("presence-count"), copy.count);
    setText(byId("presence-label"), copy.label);
    setText(byId("presence-ingame"), copy.inGame);
    const card = byId("coop-card");
    if (card) card.classList.toggle("is-empty", state !== "live");
    document.querySelectorAll(".hero-presence, #coop-card").forEach((el) => {
      el.setAttribute("data-state", state);
    });
  }

  let presenceInFlight = false;
  /** A request that goes silent is given up on, so the next tick can try again. */
  const PRESENCE_TIMEOUT_MS = 10_000;

  async function refreshPresence() {
    // A hidden tab does not need the number, and two answers must not race.
    if (document.hidden || presenceInFlight) return;
    presenceInFlight = true;
    try {
      const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(PRESENCE_TIMEOUT_MS) : undefined;
      const response = await fetch(`${SERVER_URL}/presence`, { cache: "no-store", signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const roster = await response.json();
      const people = Array.isArray(roster) ? roster : [];
      const inGame = people.filter((person) => person && person.inSTS2).length;
      showPresence(presenceCopy(people.length, inGame), people.length === 0 ? "empty" : "live");
    } catch {
      // The count is decoration; say so plainly and try again next tick.
      showPresence(PRESENCE_DOWN, "down");
    } finally {
      presenceInFlight = false;
    }
  }

  // ---- 3. Latest release -------------------------------------------------------
  // Truthfulness contract: a version pill shows a tag GitHub actually returned,
  // and a download link only points at an installer that is attached to that
  // release. Otherwise the server-rendered defaults stay: the links go to the
  // releases page and the pills stay empty (hidden).
  /**
   * @param {{ assets?: Array<{ name?: string, browser_download_url?: string }> }} release
   * @param {RegExp} pattern
   * @returns {string | null}
   */
  function pickAsset(release, pattern) {
    const assets = Array.isArray(release && release.assets) ? release.assets : [];
    const hit = assets.find((asset) => {
      const name = String((asset && asset.name) || "");
      return pattern.test(name) && !/\.blockmap$/i.test(name);
    });
    const url = String((hit && hit.browser_download_url) || "");
    return url.startsWith(RELEASE_ASSET_PREFIX) ? url : null;
  }

  /** @param {string[]} ids @param {string} href */
  function pointAt(ids, href) {
    ids.forEach((id) => {
      const link = byId(id);
      if (!link) return;
      link.setAttribute("href", href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener");
    });
  }

  async function resolveLatestRelease() {
    let release = null;
    try {
      const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (response.ok) release = await response.json();
    } catch {
      release = null; // rate-limited or offline: keep the defaults
    }
    if (!release) return;

    const version = typeof release.tag_name === "string" ? release.tag_name : "";
    const dmg = pickAsset(release, /\.dmg$/i);
    const exe = pickAsset(release, /_x64-setup\.exe$/i);

    if (dmg) {
      pointAt(["dmg-link", "download-cta-mac"], dmg);
      if (version) ["hero-version", "install-version"].forEach((id) => setText(byId(id), version));
    }
    if (exe) {
      pointAt(["exe-link", "download-cta-win"], exe);
      if (version) ["hero-version-win", "install-version-win"].forEach((id) => setText(byId(id), version));
    }
  }

  // ---- 4. The screenshot buttons -----------------------------------------------
  const SHOT_ALT = Object.freeze({
    overview: "SpireVault Overview on sample data: a win-rate ring, run totals, and six stat cards fanned like a hand.",
    characters: "Characters tab on sample data: one banner per character with win rate and run count.",
    ascensions: "Ascensions tab on sample data: a spire with one storey per ascension level, each with its win rate and run count, the highest one reached marked as your peak.",
    relics: "Top Relics tab on sample data: the three best relics on a podium with their in-game art, and a ranked list below.",
    cards: "Cards tab on sample data: the three most-picked cards on a podium, shown as real game cards, with pick counts and win rates.",
    runs: "Recent Runs tab on sample data: filter chips for outcome, ascension and character above a list of runs, each with its floor, time and a Victory or Defeat stamp.",
  });

  function wireViewer() {
    const tabs = Array.from(document.querySelectorAll(".viewer-tab"));
    const shot = byId("viewer-shot");
    const phoneShot = byId("viewer-shot-phone");
    const panel = byId("viewer-panel");
    if (tabs.length === 0 || !shot || !panel) return;

    /** @param {HTMLElement} tab @param {boolean} moveFocus */
    const select = (tab, moveFocus) => {
      const name = tab.dataset.shot || "";
      if (!SHOT_ALT[name]) return;
      tabs.forEach((other) => {
        const isOn = other === tab;
        other.classList.toggle("is-on", isOn);
        other.setAttribute("aria-selected", String(isOn));
        other.tabIndex = isOn ? 0 : -1;
      });
      // Phones get the same tab as the app draws it on a phone.
      if (phoneShot) phoneShot.setAttribute("srcset", PHONE_SHOT_WIDTHS.map((w) => `/assets/shots/${name}-phone-${w}-v3.webp ${w}w`).join(", "));
      shot.setAttribute("srcset", SHOT_WIDTHS.map((w) => `/assets/shots/${name}-${w}-v3.webp ${w}w`).join(", "));
      shot.setAttribute("src", `/assets/shots/${name}-${SHOT_DEFAULT_WIDTH}-v3.webp`);
      shot.setAttribute("alt", SHOT_ALT[name]);
      panel.setAttribute("aria-labelledby", tab.id);
      if (moveFocus) tab.focus();
    };

    const STEP = Object.freeze({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 });
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (event) => {
        let next = -1;
        if (event.key in STEP) next = (index + STEP[event.key] + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next < 0) return;
        event.preventDefault();
        select(tabs[next], true);
      });
    });
  }

  // ---- 5. Scroll reveals -------------------------------------------------------
  function wireReveals() {
    if (root.classList.contains("reduce-motion") || !("IntersectionObserver" in window)) return;
    const targets = Array.from(document.querySelectorAll("[data-reveal]"));
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0 },
    );
    // What is already on screen (or above it) stays as it was painted; only
    // what is below the window starts hidden, and the observer shows it.
    const windowBottom = window.innerHeight;
    const waiting = targets.filter((target) => {
      if (target.getBoundingClientRect().top >= windowBottom) return true;
      target.classList.add("is-in");
      return false;
    });
    root.classList.add("can-reveal");
    waiting.forEach((target) => observer.observe(target));
  }

  // ---- 6. A link to an answer (#runcoach, or an old link from elsewhere) opens it
  function openLinkedAnswer() {
    let id = "";
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return; // a malformed fragment names nothing
    }
    if (!id) return;
    const target = document.getElementById(id);
    if (target && target.tagName === "DETAILS") target.open = true;
  }

  // ---- 7. Local testing ---------------------------------------------------------
  // When this page is served from this machine, ?app=http://localhost:<port>
  // sends its app links to a local copy of the app, so both looks can be
  // tried without touching the live app. Ignored anywhere else, and only a
  // local address is accepted.
  const LOCAL_HOST = /^(localhost|127\.0\.0\.1)$/;
  const LIVE_APP = "https://app.spirevault.app";
  function useLocalApp() {
    if (!LOCAL_HOST.test(window.location.hostname)) return;
    let local;
    try {
      local = new URL(new URLSearchParams(window.location.search).get("app") || "");
    } catch {
      return; // no ?app=, or not an address
    }
    if (local.protocol !== "http:" || !LOCAL_HOST.test(local.hostname)) return;
    document.querySelectorAll(`a[href^="${LIVE_APP}"]`).forEach((link) => {
      link.setAttribute("href", String(link.getAttribute("href")).replace(LIVE_APP, local.origin));
    });
  }

  /**
   * Runs one start-up step. A step that throws is reported and the rest
   * still run: each feature fails on its own.
   * @param {() => void} step
   * @returns {boolean} whether it finished
   */
  function start(step) {
    try {
      step();
      return true;
    } catch (error) {
      console.error(`SpireVault: ${step.name} failed`, error);
      return false;
    }
  }

  start(speak);
  start(wireViewer);
  start(wireReveals);
  start(openLinkedAnswer);
  start(useLocalApp);
  // The checks ask this for a climber's lines.
  window.SpireVaultSite = Object.freeze({ linesFor });
  window.addEventListener("hashchange", openLinkedAnswer);
  refreshPresence();
  window.setInterval(refreshPresence, PRESENCE_POLL_MS);
  // Catch up at once when the tab comes back, instead of waiting for the tick.
  document.addEventListener("visibilitychange", refreshPresence);
  resolveLatestRelease();
})();
