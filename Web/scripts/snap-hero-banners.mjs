import { chromium, devices } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = "https://app.spirevault.app";

const run = async () => {
  const browser = await chromium.launch();

  // Desktop snapshots of every themed tab.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const dpage = await desktop.newPage();
  await dpage.goto(URL, { waitUntil: "networkidle" });
  await dpage.waitForSelector(".tab-panel", { timeout: 10000 });
  for (const t of ["overview", "characters", "ascensions", "relics", "cards"]) {
    await dpage.click(`button.nav-row[data-tab="${t}"]`);
    await dpage.waitForTimeout(350);
    await dpage.screenshot({ path: `/tmp/hero-${t}.png`, clip: { x: 220, y: 0, width: 1060, height: 320 } });
  }
  await desktop.close();

  // Mobile snapshot of overview.
  const mobile = await browser.newContext({ ...devices["iPhone 13"] });
  const mpage = await mobile.newPage();
  await mpage.goto(URL, { waitUntil: "networkidle" });
  await mpage.waitForSelector(".tab-panel", { timeout: 10000 });
  await mpage.screenshot({ path: "/tmp/hero-mobile-overview.png", fullPage: false });
  await browser.close();
  console.log("snapshots saved to /tmp/hero-*.png");
};

run().catch((e) => { console.error(e); process.exit(1); });
