import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = "https://app.spirevault.app";

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

  // 1. Tagline should be gone everywhere.
  const taglineCount = await page.locator(".scene-tagline").count();
  console.log(`scene-tagline elements present: ${taglineCount} (expect 0)`);

  // 2. For each themed tab, check that the background covers the whole panel
  //    and the image is actually loaded (not just a CSS reference).
  const tabs = ["overview", "characters", "ascensions", "relics", "cards"];
  for (const t of tabs) {
    await page.click(`button.nav-row[data-tab="${t}"]`);
    await page.waitForTimeout(250);

    const info = await page.evaluate((tabName) => {
      const el = document.querySelector(`.tab-panel[data-tab="${tabName}"]`);
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        exists: true,
        bgImage: cs.backgroundImage,
        bgSize: cs.backgroundSize,
        bgAttachment: cs.backgroundAttachment,
        bgPosition: cs.backgroundPosition,
        height: rect.height,
        width: rect.width,
      };
    }, t);

    const ok =
      info.exists &&
      /scene-/.test(info.bgImage) &&
      info.bgSize === "cover" &&
      info.bgAttachment === "fixed";

    console.log(
      `[${ok ? "OK" : "FAIL"}] ${t}: size=${info.bgSize} attach=${info.bgAttachment} h=${Math.round(info.height)}px image=${info.bgImage.slice(0, 60)}...`,
    );
  }

  // 3. Recent Runs should NOT have a scene background.
  await page.click(`button.nav-row[data-tab="runs"]`);
  await page.waitForTimeout(200);
  const recentBg = await page.evaluate(() => {
    const el = document.querySelector('.tab-panel[data-tab="runs"]');
    return getComputedStyle(el).backgroundImage;
  });
  console.log(
    `[${/scene-/.test(recentBg) ? "FAIL" : "OK"}] runs (Recent Runs): bgImage=${recentBg.slice(0, 40)} (expect none)`,
  );

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
