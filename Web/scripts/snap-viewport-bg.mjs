import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = "https://app.spirevault.app";

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForSelector(".tab-panel", { timeout: 10000 });

  await page.click(`button.nav-row[data-tab="relics"]`);
  await page.waitForTimeout(400);

  // Top of page.
  await page.screenshot({ path: "/tmp/sv-relics-top.png", fullPage: false });
  console.log("saved /tmp/sv-relics-top.png");

  // Scrolled to bottom of relics list.
  await page.evaluate(() => {
    const el = document.querySelector('.tab-panel[data-tab="relics"]');
    el.scrollIntoView({ block: "end" });
    window.scrollBy(0, 600);
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/sv-relics-bottom.png", fullPage: false });
  console.log("saved /tmp/sv-relics-bottom.png");

  await browser.close();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
