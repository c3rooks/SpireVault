/* The Vault — landing page enhancements
 *   1. Sticky-nav border on scroll
 *   2. Live "X players online" count from the matchmaking server
 *   3. Hero + install download buttons resolved to the latest GitHub release
 *   4. Click-to-zoom lightbox on showcase screenshots
 */

const SERVER_URL = "https://vault-coop.coreycrooks.workers.dev";
const GITHUB_REPO = "c3rooks/SpireVault";

// ─── Sticky nav border ──────────────────────────────────────────────────────
const nav = document.querySelector(".nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 4);
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

// ─── Lightbox for showcase screenshots ──────────────────────────────────────
//
// Click any .screenshot tile → full-screen view of the image with the
// figcaption underneath. Esc / click-outside / × button all close it.
// Restores body scroll lock and previously-focused element on close so
// keyboard users land back where they were.
(() => {
  const tiles = document.querySelectorAll("#showcase .screenshot");
  if (tiles.length === 0) return;

  const lb = document.createElement("div");
  lb.className = "lightbox";
  lb.setAttribute("role", "dialog");
  lb.setAttribute("aria-modal", "true");
  lb.setAttribute("aria-hidden", "true");
  lb.innerHTML = `
    <button class="lightbox-close" type="button" aria-label="Close">&times;</button>
    <figure class="lightbox-figure">
      <img alt="" />
      <figcaption></figcaption>
    </figure>
  `;
  document.body.appendChild(lb);

  const lbImg     = lb.querySelector("img");
  const lbCap     = lb.querySelector("figcaption");
  const lbClose   = lb.querySelector(".lightbox-close");
  const lbFigure  = lb.querySelector(".lightbox-figure");

  let lastFocus = null;

  function open(srcImg, caption) {
    lastFocus = document.activeElement;
    lbImg.src = srcImg.currentSrc || srcImg.src;
    lbImg.alt = srcImg.alt || "";
    lbCap.innerHTML = caption || "";
    lb.classList.add("is-open");
    lb.setAttribute("aria-hidden", "false");
    document.documentElement.style.overflow = "hidden";
    requestAnimationFrame(() => lbClose.focus());
  }

  function close() {
    lb.classList.remove("is-open");
    lb.setAttribute("aria-hidden", "true");
    document.documentElement.style.overflow = "";
    lbImg.src = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  tiles.forEach((tile) => {
    tile.addEventListener("click", (e) => {
      // Don't hijack clicks on real anchor links inside captions.
      if (e.target.closest("a")) return;
      const img = tile.querySelector("img");
      const cap = tile.querySelector("figcaption");
      if (!img) return;
      open(img, cap ? cap.innerHTML : "");
    });
    tile.setAttribute("tabindex", "0");
    tile.setAttribute("role", "button");
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const img = tile.querySelector("img");
        const cap = tile.querySelector("figcaption");
        if (img) open(img, cap ? cap.innerHTML : "");
      }
    });
  });

  // Close on backdrop click (but not when clicking the figure itself)
  lb.addEventListener("click", (e) => {
    if (e.target === lb) close();
  });
  lbClose.addEventListener("click", close);
  lbFigure.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lb.classList.contains("is-open")) close();
  });
})();

// ─── Live presence count ────────────────────────────────────────────────────
const presenceText      = document.getElementById("presence-text");
const presenceCount     = document.getElementById("presence-count");
const presenceLabel     = document.getElementById("presence-label");
const presenceInGame    = document.getElementById("presence-ingame");
const coopCard          = document.getElementById("coop-card");
const heroFloatingCount = document.getElementById("hero-floating-count");

async function refreshPresence() {
  try {
    const resp = await fetch(`${SERVER_URL}/presence`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    const count = Array.isArray(list) ? list.length : 0;
    const inGame = Array.isArray(list)
      ? list.filter((p) => p && p.inSTS2).length
      : 0;

    // Co-op card: count + label (with humane empty state)
    if (presenceCount) presenceCount.textContent = count === 0 ? "—" : String(count);
    if (presenceLabel) {
      presenceLabel.textContent =
        count === 0
          ? "no one signed in yet · be the first"
          : count === 1
            ? "player online right now"
            : "players online right now";
    }
    if (presenceInGame) {
      presenceInGame.textContent = inGame === 0 && count === 0 ? "—" : String(inGame);
    }
    if (coopCard) coopCard.classList.toggle("is-empty", count === 0);

    // Inline trust line under the install CTAs
    if (presenceText) {
      if (count === 0) {
        presenceText.textContent = "Be the first online today.";
      } else if (inGame > 0) {
        presenceText.textContent =
          `${count} online · ${inGame} currently in Slay the Spire 2`;
      } else {
        presenceText.textContent =
          count === 1
            ? "1 player online right now"
            : `${count} players online right now`;
      }
    }

    // Hero floating card
    if (heroFloatingCount) {
      heroFloatingCount.textContent =
        count === 0
          ? "Live presence"
          : count === 1
            ? "1 player online"
            : `${count} players online`;
    }
  } catch {
    if (presenceCount) presenceCount.textContent = "—";
    if (presenceLabel) presenceLabel.textContent = "live count momentarily unavailable";
    if (presenceInGame) presenceInGame.textContent = "—";
    if (coopCard) coopCard.classList.add("is-empty");
    if (presenceText) presenceText.textContent = "Live count momentarily unavailable.";
    if (heroFloatingCount) heroFloatingCount.textContent = "Live presence";
  }
}
refreshPresence();
setInterval(refreshPresence, 12_000);

// ─── Latest release auto-link ───────────────────────────────────────────────
//
// Resolves the hero "Download for macOS" + the install card's "Download .dmg"
// to the freshest release on GitHub. Three cases handled:
//   1. Release exists + .dmg asset attached  -> direct download
//   2. Release exists, no .dmg               -> point at release page
//   3. No release / repo not yet public      -> "Build from source" fallback
//
// Case 3 is what we hit before the v0.1 release is cut. Better to send the user
// to a real working URL (the build-from-source section in the README) than a 404.
const dmgLink     = document.getElementById("dmg-link");
const heroCTA     = document.getElementById("download-cta");
const heroVersion = document.getElementById("hero-version");
const installVer  = document.getElementById("install-version");

const BUILD_FROM_SOURCE_URL =
  `https://github.com/${GITHUB_REPO}#build-from-source`;
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

function setDownloadFallback(label) {
  if (heroVersion) heroVersion.textContent = label;
  if (installVer)  installVer.textContent  = label;
  if (dmgLink) {
    dmgLink.href = BUILD_FROM_SOURCE_URL;
    dmgLink.target = "_blank";
    dmgLink.rel = "noopener";
  }
  if (heroCTA) {
    heroCTA.href = "#install";
  }
}

async function resolveLatestRelease() {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { cache: "no-store" }
    );
    if (resp.status === 404) {
      // Repo private / no releases yet → don't pretend a download exists.
      setDownloadFallback("build from source");
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const tag  = (data.tag_name || "").replace(/^v/, "") || null;
    const dmg  = (data.assets || []).find(
      (a) => /\.dmg$/i.test(a.name) && a.browser_download_url
    );
    if (heroVersion && tag)  heroVersion.textContent = `v${tag}`;
    if (installVer  && tag)  installVer.textContent  = `v${tag}`;
    if (dmgLink && dmg) {
      dmgLink.href = dmg.browser_download_url;
      dmgLink.removeAttribute("target");
    } else if (dmgLink) {
      dmgLink.href = RELEASES_URL;
      dmgLink.target = "_blank";
    }
    if (heroCTA && dmg) {
      heroCTA.href = dmg.browser_download_url;
    }
  } catch {
    // Network error or rate-limited GitHub API. Don't break the buttons —
    // route to the releases page where the user can pick manually.
    if (dmgLink) { dmgLink.href = RELEASES_URL; dmgLink.target = "_blank"; }
    if (heroCTA) { heroCTA.href = RELEASES_URL; heroCTA.target = "_blank"; }
  }
}
resolveLatestRelease();
