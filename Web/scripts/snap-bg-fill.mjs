import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = "https://app.spirevault.app";
const OUT = "/tmp/spirevault-bg-fill";

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".tab-panel", { timeout: 10000 });

  for (const t of ["overview", "characters", "ascensions", "relics", "cards"]) {
    await page.click(`button.nav-row[data-tab="${t}"]`);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `${OUT}-${t}.png`,
      fullPage: true,
    });
    console.log(`saved ${OUT}-${t}.png`);
  }

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
