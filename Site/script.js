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
          ? "no one signed up yet · be the first"
          : count === 1
            ? "player signed up"
            : "players signed up";
    }
    if (presenceInGame) {
      presenceInGame.textContent = inGame === 0 && count === 0 ? "—" : String(inGame);
    }
    if (coopCard) coopCard.classList.toggle("is-empty", count === 0);

    // Inline trust line under the install CTAs
    if (presenceText) {
      if (count === 0) {
        presenceText.textContent = "Be the first to sign up.";
      } else if (inGame > 0) {
        presenceText.textContent =
          `${count} signed up · ${inGame} currently in Slay the Spire 2`;
      } else {
        presenceText.textContent =
          count === 1
            ? "1 player signed up"
            : `${count} players signed up`;
      }
    }

    // Hero floating card
    if (heroFloatingCount) {
      heroFloatingCount.textContent =
        count === 0
          ? "Live presence"
          : count === 1
            ? "1 player signed up"
            : `${count} players signed up`;
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
// 30 s matches the web companion's poll cadence and the value we claim in
// the live-presence card. The /presence endpoint is edge-cached for 15 s on
// Cloudflare, so most of these polls don't even hit the worker.
setInterval(refreshPresence, 30_000);

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
const dmgLink      = document.getElementById("dmg-link");
const exeLink      = document.getElementById("exe-link");
const heroCTA      = document.getElementById("download-cta-mac");
const heroWinCTA   = document.getElementById("download-cta-win");
const heroVersion  = document.getElementById("hero-version");
const heroVersionWin = document.getElementById("hero-version-win");
const installVer   = document.getElementById("install-version");
const installVerWin = document.getElementById("install-version-win");
const rcMacVersion = document.getElementById("rc-mac-version");

const BUILD_FROM_SOURCE_URL =
  `https://github.com/${GITHUB_REPO}#build-from-source`;
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

/**
 * Pick a release asset by suffix pattern. Skips blockmap sidecars.
 *
 *   pickAsset(release, /\.dmg$/i)       → first .dmg
 *   pickAsset(release, /_x64-setup\.exe$/i) → Tauri NSIS installer
 */
function pickAsset(release, pattern) {
  const assets = release?.assets;
  if (!Array.isArray(assets)) return null;
  const hit = assets.find((a) => {
    const name = String(a?.name || "");
    return pattern.test(name) && !/\.blockmap$/i.test(name);
  });
  return hit?.browser_download_url || null;
}

/**
 * Resolve real download URLs + version from the latest GitHub release.
 *
 * Truthfulness contract:
 *   - The version pill shows the actual published tag (e.g. v0.9.8),
 *     never an aspirational future tag.
 *   - The Mac DMG link points at the actual .dmg asset on GitHub if
 *     one is attached to the latest release; falls back to the locally
 *     served /assets/The.Vault.dmg only when GitHub's API is
 *     unreachable (rate-limited browsers, offline previews).
 *   - The Windows .exe link is only upgraded to a real release URL
 *     when the latest release ACTUALLY has a `_x64-setup.exe` asset.
 *     If the release has no Windows installer (current state during
 *     Tauri build-out), the Windows CTAs keep their server-rendered
 *     "Coming soon" stub instead of redirecting to /releases/latest,
 *     which would 302 to a release page with no .exe attached — the
 *     credibility-bleed pattern we're explicitly avoiding.
 */
async function resolveLatestRelease() {
  let version = null;
  let exeHref = null;
  let dmgHref = null;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (resp.ok) {
      const release = await resp.json();
      if (release?.tag_name) version = release.tag_name;
      exeHref = pickAsset(release, /_x64-setup\.exe$/i);
      dmgHref = pickAsset(release, /\.dmg$/i);
    }
  } catch {
    /* keep server-rendered defaults */
  }

  // ── macOS: version pill + DMG link ──
  if (version) {
    if (heroVersion)    heroVersion.textContent    = version;
    if (installVer)     installVer.textContent     = version;
    if (rcMacVersion)   rcMacVersion.textContent   = version;
  }

  // Prefer the actual GitHub release asset over the local /assets copy
  // so the version label and the bytes the user downloads agree.
  const macHref = dmgHref || "/assets/The.Vault.dmg";
  if (dmgLink) {
    dmgLink.href = macHref;
    if (macHref.startsWith("http")) { dmgLink.target = "_blank"; dmgLink.rel = "noopener"; }
    else                            { dmgLink.removeAttribute("target"); }
  }
  if (heroCTA) {
    heroCTA.href = macHref;
    if (macHref.startsWith("http")) { heroCTA.target = "_blank"; heroCTA.rel = "noopener"; }
    else                            { heroCTA.removeAttribute("target"); }
  }

  // ── Windows: ONLY upgrade the CTA if a real .exe asset exists ──
  // Otherwise leave the "Coming soon" stub the HTML ships with —
  // anchor link to #install-win and the install card explains the state.
  if (exeHref) {
    if (exeLink) {
      exeLink.href = exeHref;
      exeLink.classList.remove("is-soon", "alt");
      exeLink.target = "_blank";
      exeLink.rel = "noopener";
      const label = exeLink.querySelector("span:first-of-type");
      if (label) label.textContent = "Download .exe";
    }
    if (heroWinCTA) {
      heroWinCTA.href = exeHref;
      heroWinCTA.classList.remove("is-soon");
      heroWinCTA.target = "_blank";
      heroWinCTA.rel = "noopener";
      heroWinCTA.removeAttribute("title");
    }
    if (heroVersionWin)  heroVersionWin.textContent  = version || "latest";
    if (installVerWin)   installVerWin.textContent   = version || "latest";
    if (heroVersionWin)  heroVersionWin.classList.remove("version-soon");
    if (installVerWin)   installVerWin.classList.remove("version-soon");
  }
}
resolveLatestRelease();
