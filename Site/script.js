/* The Vault — landing page enhancements
 *   1. Sticky-nav border on scroll
 *   2. Live "X players online" count from the matchmaking server
 *   3. Hero + install download buttons resolved to the latest GitHub release
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

// ─── Live presence count ────────────────────────────────────────────────────
const presenceText        = document.getElementById("presence-text");
const presenceCount       = document.getElementById("presence-count");
const heroFloatingCount   = document.getElementById("hero-floating-count");

async function refreshPresence() {
  try {
    const resp = await fetch(`${SERVER_URL}/presence`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const list = await resp.json();
    const count = Array.isArray(list) ? list.length : 0;
    const inGame = Array.isArray(list)
      ? list.filter((p) => p && p.inSTS2).length
      : 0;

    if (presenceCount) presenceCount.textContent = String(count);
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
    if (heroFloatingCount) {
      heroFloatingCount.textContent =
        count === 0
          ? "Be the first"
          : count === 1
            ? "1 player online"
            : `${count} players online`;
    }
  } catch {
    if (presenceCount) presenceCount.textContent = "—";
    if (presenceText) presenceText.textContent =
      "Live count momentarily unavailable.";
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
