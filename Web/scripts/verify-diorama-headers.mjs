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
  page.on("requestfailed", (req) =>
    errors.push(`reqfail: ${req.url()} ${req.failure()?.errorText}`),
  );

  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".tab-panel", { timeout: 10000 });

  // 1. Body should NOT have a scene background anywhere.
  for (const t of TABS) {
    const bodyBg = await page.evaluate((tab) => {
      const panel = document.querySelector(`.tab-panel[data-tab="${tab}"]`);
      return panel ? getComputedStyle(panel).backgroundImage : "MISSING";
    }, t);
    const bad = /scene-/.test(bodyBg);
    console.log(
      `[${bad ? "FAIL" : "OK"}] ${t} panel bg: ${bodyBg.slice(0, 50)} (expect none)`,
    );
  }

  // 2. Each stats tab should have a companion-slot WITH a .scene
  //    inside, AND the .scene should have a real scene image.
  const observedBosses = new Set();
  const observedClimbers = new Set();
  for (const t of TABS) {
    await page.click(`button.nav-row[data-tab="${t}"]`);
    await page.waitForTimeout(350);

    const info = await page.evaluate((tab) => {
      const panel = document.querySelector(`.tab-panel[data-tab="${tab}"]`);
      if (!panel) return { exists: false };
      const slot = panel.querySelector(".companion-slot");
      const scene = panel.querySelector(".companion-slot .scene");
      const climberImg = panel.querySelector(".scene-figure-climber img");
      const bossImg = panel.querySelector(".scene-figure-boss img");
      return {
        exists: true,
        hasSlot: !!slot,
        hasScene: !!scene,
        sceneBg: scene ? getComputedStyle(scene).backgroundImage : "",
        climberSrc: climberImg ? climberImg.getAttribute("src") : null,
        bossSrc: bossImg ? bossImg.getAttribute("src") : null,
        bossLabel: bossImg ? bossImg.getAttribute("alt") : null,
      };
    }, t);

    if (info.bossLabel) observedBosses.add(info.bossLabel);
    if (info.climberSrc) observedClimbers.add(info.climberSrc);

    const ok =
      info.hasSlot &&
      info.hasScene &&
      /scene-/.test(info.sceneBg) &&
      info.bossSrc &&
      info.climberSrc;

    console.log(
      `[${ok ? "OK" : "FAIL"}] ${t}: slot=${info.hasSlot} scene=${info.hasScene} bg=${info.sceneBg.slice(0, 40)}... boss=${info.bossLabel}`,
    );
  }

  // 3. Recent Runs should NOT have a slot or scene.
  await page.click(`button.nav-row[data-tab="runs"]`);
  await page.waitForTimeout(200);
  const runsHasSlot = await page.evaluate(() => {
    const panel = document.querySelector('.tab-panel[data-tab="runs"]');
    return !!panel.querySelector(".companion-slot");
  });
  console.log(
    `[${runsHasSlot ? "FAIL" : "OK"}] Recent Runs has no diorama (slot=${runsHasSlot})`,
  );

  // 4. Re-roll bubble several times on Overview to confirm boss
  //    randomization is working.
  await page.click(`button.nav-row[data-tab="overview"]`);
  await page.waitForTimeout(200);
  for (let i = 0; i < 12; i++) {
    await page.click(".tab-panel[data-tab='overview'] .scene-bubble");
    await page.waitForTimeout(80);
    const boss = await page.evaluate(() => {
      const img = document.querySelector(
        ".tab-panel[data-tab='overview'] .scene-figure-boss img",
      );
      return img ? img.getAttribute("alt") : null;
    });
    if (boss) observedBosses.add(boss);
  }
  console.log(
    `\nObserved ${observedBosses.size} unique bosses across rolls: ${[...observedBosses].join(", ")}`,
  );

  if (observedBosses.size < 2) {
    console.log(
      "[FAIL] Boss never changed across 12 re-rolls — randomization is broken",
    );
  } else {
    console.log("[OK] Boss randomization working");
  }

  if (errors.length) {
    console.log("\nErrors:");
    errors.forEach((e) => console.log(`  ${e}`));
  } else {
    console.log("\nNo console/page errors.");
  }

  // Snapshot one tab for visual confirmation.
  await page.click(`button.nav-row[data-tab="relics"]`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/sv-relics-after.png", fullPage: false });
  console.log("\nsaved /tmp/sv-relics-after.png");

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
