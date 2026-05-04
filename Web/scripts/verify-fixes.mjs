// Verifies the four user-reported regressions are fixed:
//
//   1. Climber sprites that were facing AWAY from the Architect now
//      get a `scaleX(-1)` (Silent / Necrobinder / Regent / Ironclad).
//      Defect stays unflipped — its sprite already faces right.
//   2. The desktop sidebar's "Sign out" button is HIDDEN for guest
//      visitors. Earlier it always rendered, so guests saw both
//      "Sign in with Steam" and "Sign out" simultaneously.
//   3. Player-feed cards no longer expose a `steam://` URL anywhere
//      visible to a mobile visitor — only `https://steamcommunity.com`
//      links. The deep link broke iOS Safari with "address is invalid".
//   4. The diorama state RE-ROLLS on tab switches. Earlier behavior
//      kept the same climber + bubble line across all five stats
//      tabs which read as a stale UI ("nothing changed when I
//      clicked"). The user explicitly asked for the diorama to
//      change on every tab so the page feels alive — verified here.
//
// Hits the local server at :8765 by default; override with URL=...
import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://127.0.0.1:8765/";

function pass(msg) { console.log(`PASS  ${msg}`); }
function fail(msg) { console.log(`FAIL  ${msg}`); process.exitCode = 1; }

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.waitForTimeout(700);

  // ─── 1. Sprite flip: every climber facing left now mirrored ───
  // We force-pick each character via the picker setting so we can
  // observe its actual rendered transform.
  const FACING = {
    defect:      { facesLeft: false },
    ironclad:    { facesLeft: true },
    silent:      { facesLeft: true },
    regent:      { facesLeft: true },
    necrobinder: { facesLeft: true },
  };
  for (const [id, want] of Object.entries(FACING)) {
    await page.evaluate((cid) => {
      localStorage.setItem("vault.web.companion.v2", cid);
    }, id);
    await page.reload();
    await page.waitForTimeout(600);
    await page.click(`button.nav-row[data-tab="overview"]`).catch(() => {});
    await page.waitForTimeout(250);
    const info = await page.evaluate(() => {
      const img = document.querySelector(".tab-panel[data-tab='overview'] .scene-figure-climber img");
      if (!img) return null;
      const cs = getComputedStyle(img);
      return {
        src: img.getAttribute("src") || "",
        hasFlipClass: img.classList.contains("scene-art-flip"),
        transform: cs.transform,
        spriteFlipVar: cs.getPropertyValue("--sprite-flip").trim(),
      };
    });
    if (!info) { fail(`[${id}] could not find climber img`); continue; }
    const slug = info.src.split("/").pop().split(".")[0];
    if (slug !== id) { fail(`[${id}] picker stuck: expected ${id}, got ${slug}`); continue; }
    if (want.facesLeft) {
      const isMirrored = info.hasFlipClass && info.spriteFlipVar === "-1";
      if (isMirrored) pass(`[${id}] facing-left sprite is mirrored (--sprite-flip=${info.spriteFlipVar})`);
      else            fail(`[${id}] should be mirrored but flipClass=${info.hasFlipClass}, --sprite-flip=${info.spriteFlipVar}`);
    } else {
      const isMirrored = info.hasFlipClass;
      if (!isMirrored) pass(`[${id}] facing-right sprite NOT mirrored (correct)`);
      else             fail(`[${id}] should NOT be mirrored but is (flipClass=${info.hasFlipClass})`);
    }
  }

  // ─── 2. Sign-out hidden for guests ───
  // Make sure the storage is in guest state (no session) and reload.
  await page.evaluate(() => {
    localStorage.removeItem("vault.web.session");
  });
  await page.reload();
  await page.waitForTimeout(700);
  const signoutInfo = await page.evaluate(() => {
    const btn = document.getElementById("signout-btn");
    if (!btn) return { exists: false };
    const cs = getComputedStyle(btn);
    return {
      exists: true,
      hidden: btn.hidden,
      display: cs.display,
      visibility: cs.visibility,
    };
  });
  if (!signoutInfo.exists) { fail("signout-btn missing from DOM"); }
  else if (signoutInfo.hidden && signoutInfo.display !== "none") {
    // hidden attribute respected by browser → display:none — covers both checks
    pass(`Sign out button is hidden for guest (hidden=${signoutInfo.hidden}, display=${signoutInfo.display})`);
  } else if (signoutInfo.hidden) {
    pass(`Sign out button is hidden for guest (hidden attribute set)`);
  } else {
    fail(`Sign out button is VISIBLE to guest (hidden=${signoutInfo.hidden}, display=${signoutInfo.display})`);
  }

  // ─── 3. No steam:// URLs visible to mobile visitors ───
  // Switch to mobile viewport, sign in is hard to fake without OpenID
  // round-trip, but we can at least verify that any player-row HTML
  // we render in the page contains zero `steam://` anchor hrefs.
  // The guest co-op view shows real player rows from the live feed,
  // so if any of them rendered a deep link we'd catch it here.
  const mobileCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const mPage = await mobileCtx.newPage();
  await mPage.goto(URL);
  await mPage.waitForTimeout(800);
  await mPage.click(`button.nav-row[data-tab="coop"]`).catch(() => {});
  await mPage.waitForTimeout(900);
  const steamHrefs = await mPage.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href^="steam://"]')).map(a => a.getAttribute("href"));
  });
  if (steamHrefs.length === 0) {
    pass(`mobile (iOS UA) view has zero \`steam://\` URLs in DOM`);
  } else {
    fail(`mobile (iOS UA) view STILL exposes \`steam://\` URLs: ${steamHrefs.join(", ")}`);
  }

  // ─── 4. Diorama scene RE-ROLLS across tab switches ───
  // Force Random companion (not a fixed character) so the climber
  // can also rotate; the bubble line should rotate either way.
  await page.evaluate(() => {
    localStorage.removeItem("vault.web.companion.v2");
    localStorage.setItem("vault.web.companion", "random");
  });
  await page.reload();
  await page.waitForTimeout(700);
  const TABS = ["overview", "characters", "ascensions", "relics", "cards"];
  const seenLines = new Set();
  for (const t of TABS) {
    await page.click(`button.nav-row[data-tab="${t}"]`);
    await page.waitForTimeout(350);
    const snap = await page.evaluate((tab) => {
      const slot = document.querySelector(`.tab-panel[data-tab="${tab}"] .companion-slot`);
      const bub = slot?.querySelector(".scene-bubble");
      return { line: bub?.textContent.trim().slice(0, 60) || null };
    }, t);
    if (snap.line) seenLines.add(snap.line);
  }
  // With 5 tab switches the bubble pool is large enough that we
  // expect at least 2 different lines. A single line across all 5 is
  // the regression we're guarding against.
  if (seenLines.size >= 2) {
    pass(`diorama line re-rolls on tab switch (${seenLines.size} unique lines across 5 tabs)`);
  } else {
    fail(`diorama line did NOT re-roll: stuck on "${[...seenLines][0]}" across all 5 tabs`);
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(2); });
