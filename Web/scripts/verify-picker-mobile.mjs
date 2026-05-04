import { chromium, devices } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = "https://app.spirevault.app";

const run = async () => {
  const browser = await chromium.launch();

  // ── DESKTOP ────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dpage = await desktop.newPage();
  const errors = [];
  dpage.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  dpage.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  await dpage.goto(URL, { waitUntil: "networkidle" });
  await dpage.waitForSelector(".tab-panel", { timeout: 10000 });

  // Open the picker and verify it's not clipped.
  await dpage.click(".tab-panel[data-tab='overview'] .scene-figure-climber");
  await dpage.waitForTimeout(250);
  const pickerInfo = await dpage.evaluate(() => {
    const p = document.querySelector(".tab-panel[data-tab='overview'] .companion-picker");
    if (!p) return { exists: false };
    const r = p.getBoundingClientRect();
    return {
      exists: true,
      hidden: p.hasAttribute("hidden"),
      top: Math.round(r.top),
      left: Math.round(r.left),
      width: Math.round(r.width),
      height: Math.round(r.height),
      // Find the nearest scrollable/overflow ancestor and its rect
      // to check whether the picker bleeds outside any clip region.
      pickerVisibleHeight: (() => {
        // visible height = how much of the picker is within the viewport
        const vh = window.innerHeight;
        return Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      })(),
    };
  });
  const pickerOk = pickerInfo.exists && !pickerInfo.hidden && pickerInfo.height > 100;
  console.log(`[${pickerOk ? "OK" : "FAIL"}] desktop picker visible: hidden=${pickerInfo.hidden} h=${pickerInfo.height}px visibleH=${pickerInfo.pickerVisibleHeight}px`);

  // Snapshot picker open.
  await dpage.screenshot({ path: "/tmp/sv-picker-desktop.png", clip: { x: 220, y: 0, width: 1060, height: 480 } });
  console.log("saved /tmp/sv-picker-desktop.png");

  // Click "Random" to switch.
  const randomOption = await dpage.locator('.tab-panel[data-tab="overview"] .companion-option[data-companion-id="random"]').first();
  await randomOption.click();
  await dpage.waitForTimeout(150);
  // After picking Random, the picker should be re-rendered (so it'll be hidden).
  const afterPick = await dpage.evaluate(() => localStorage.getItem("vault.web.companion"));
  console.log(`[${afterPick === "random" ? "OK" : "FAIL"}] localStorage after Random click: ${afterPick}`);

  // Re-roll a few times and confirm climber actually changes.
  const climbers = new Set();
  for (let i = 0; i < 12; i++) {
    await dpage.click(".tab-panel[data-tab='overview'] .scene-bubble");
    await dpage.waitForTimeout(60);
    const c = await dpage.evaluate(() => {
      const img = document.querySelector(".tab-panel[data-tab='overview'] .scene-figure-climber img");
      return img ? img.getAttribute("alt") : null;
    });
    if (c) climbers.add(c);
  }
  console.log(`[${climbers.size >= 2 ? "OK" : "FAIL"}] climber randomizes: saw ${[...climbers].join(", ")}`);

  // Snapshot the banner header for visual confirm.
  await dpage.screenshot({ path: "/tmp/sv-banner-desktop.png", clip: { x: 220, y: 0, width: 1060, height: 280 } });
  console.log("saved /tmp/sv-banner-desktop.png");
  await desktop.close();

  // ── MOBILE ─────────────────────────────────────────────────────
  const mobile = await browser.newContext({ ...devices["iPhone 13"] });
  const mpage = await mobile.newPage();
  await mpage.goto(URL, { waitUntil: "networkidle" });
  await mpage.waitForSelector(".tab-panel", { timeout: 10000 });

  for (const t of ["overview", "characters", "relics"]) {
    // Mobile uses a hamburger-style nav-row in the sidebar, but on
    // narrow viewports the sidebar collapses. The nav-row buttons
    // still exist in the DOM so tab-switching by selector works.
    await mpage.evaluate((tab) => {
      const btn = document.querySelector(`button.nav-row[data-tab="${tab}"]`);
      if (btn) btn.click();
    }, t);
    await mpage.waitForTimeout(350);

    const info = await mpage.evaluate((tab) => {
      const head = document.querySelector(`.tab-panel[data-tab="${tab}"] > .panel-head`);
      if (!head) return { exists: false };
      const cs = getComputedStyle(head);
      const r = head.getBoundingClientRect();
      const climberImg = document.querySelector(`.tab-panel[data-tab="${tab}"] .scene-figure-climber img`);
      const bossImg = document.querySelector(`.tab-panel[data-tab="${tab}"] .scene-figure-boss img`);
      return {
        exists: true,
        bgImage: cs.backgroundImage,
        width: Math.round(r.width),
        height: Math.round(r.height),
        climberSrc: climberImg ? climberImg.src : null,
        bossSrc: bossImg ? bossImg.src : null,
      };
    }, t);
    const ok = info.exists && /scene-/.test(info.bgImage) && info.climberSrc && info.bossSrc;
    console.log(`[${ok ? "OK" : "FAIL"}] mobile ${t}: bg=${info.bgImage.slice(0, 40)}... w=${info.width} h=${info.height}`);

    await mpage.screenshot({ path: `/tmp/sv-mobile-${t}.png`, fullPage: false });
  }
  console.log("saved /tmp/sv-mobile-*.png");

  if (errors.length) {
    console.log("\nErrors:");
    errors.forEach((e) => console.log(`  ${e}`));
  } else {
    console.log("\nNo console/page errors.");
  }

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
