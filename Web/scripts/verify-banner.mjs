import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = "https://app.spirevault.app";
const TABS = ["overview", "characters", "ascensions", "relics", "cards"];

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".tab-panel", { timeout: 10000 });

  // 1. Boss should always be Architect across many rolls.
  const bossesSeen = new Set();
  for (let i = 0; i < 15; i++) {
    await page.click(".tab-panel[data-tab='overview'] .scene-bubble");
    await page.waitForTimeout(60);
    const boss = await page.evaluate(() => {
      const img = document.querySelector(
        ".tab-panel[data-tab='overview'] .scene-figure-boss img",
      );
      return img ? img.getAttribute("alt") : null;
    });
    if (boss) bossesSeen.add(boss);
  }
  const isOnlyArchitect =
    bossesSeen.size === 1 && bossesSeen.has("The Architect");
  console.log(
    `[${isOnlyArchitect ? "OK" : "FAIL"}] Boss pool restricted to Architect: saw ${[...bossesSeen].join(", ")}`,
  );

  // 2. Each tab's panel-head should have the scene image as its
  //    background, and the painted area should span the FULL panel-head
  //    width (not just the diorama box).
  for (const t of TABS) {
    await page.click(`button.nav-row[data-tab="${t}"]`);
    await page.waitForTimeout(350);

    const info = await page.evaluate((tab) => {
      const head = document.querySelector(
        `.tab-panel[data-tab="${tab}"] > .panel-head`,
      );
      const scene = document.querySelector(
        `.tab-panel[data-tab="${tab}"] .scene`,
      );
      if (!head) return { exists: false };
      const headBg = getComputedStyle(head).backgroundImage;
      const headRect = head.getBoundingClientRect();
      const sceneBg = scene ? getComputedStyle(scene).backgroundImage : "";
      return {
        exists: true,
        headBg,
        sceneBg,
        headWidth: Math.round(headRect.width),
        headHeight: Math.round(headRect.height),
      };
    }, t);

    const headHasScene = /scene-/.test(info.headBg);
    const sceneNotPainted = info.sceneBg === "none" || info.sceneBg === "";
    const fullWidth = info.headWidth >= 900;
    const ok = headHasScene && sceneNotPainted && fullWidth;
    console.log(
      `[${ok ? "OK" : "FAIL"}] ${t}: head w=${info.headWidth}px h=${info.headHeight}px headBg=${info.headBg.slice(0, 50)}... sceneBg=${info.sceneBg.slice(0, 30)}`,
    );
  }

  if (errors.length) {
    console.log("\nErrors:");
    errors.forEach((e) => console.log(`  ${e}`));
  } else {
    console.log("\nNo console/page errors.");
  }

  // Capture for visual inspection.
  for (const t of ["overview", "ascensions", "relics"]) {
    await page.click(`button.nav-row[data-tab="${t}"]`);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `/tmp/sv-banner-${t}.png`,
      clip: { x: 220, y: 0, width: 1060, height: 280 },
    });
    console.log(`saved /tmp/sv-banner-${t}.png`);
  }

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
