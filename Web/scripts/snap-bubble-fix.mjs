// Capture before/after style screenshots of the diorama hero banner so
// we can eyeball the bubble-centering + random-climber fix without
// guessing from numbers alone. Saves four PNGs in /tmp:
//
//   /tmp/sv-bubble-overview-desktop.png
//   /tmp/sv-bubble-ascensions-desktop.png
//   /tmp/sv-bubble-overview-mobile.png
//   /tmp/sv-bubble-ascensions-mobile.png
import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://127.0.0.1:8765/";
const SHOTS = [
  { name: "overview-desktop",   tab: "overview",   viewport: { width: 1280, height: 800 } },
  { name: "ascensions-desktop", tab: "ascensions", viewport: { width: 1280, height: 800 } },
  { name: "overview-mobile",    tab: "overview",   viewport: { width: 412,  height: 915 } },
  { name: "ascensions-mobile",  tab: "ascensions", viewport: { width: 412,  height: 915 } },
];

async function main() {
  const browser = await chromium.launch();
  for (const shot of SHOTS) {
    const ctx = await browser.newContext({ viewport: shot.viewport });
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.evaluate(() => {
      localStorage.removeItem("vault.web.companion.v2");
      localStorage.removeItem("vault.web.companion");
    });
    await page.reload();
    await page.waitForTimeout(700);
    await page.click(`button.nav-row[data-tab="${shot.tab}"]`).catch(() => {});
    await page.waitForTimeout(400);
    const banner = page.locator(`.tab-panel[data-tab="${shot.tab}"] .panel-head`).first();
    await banner.waitFor({ state: "visible", timeout: 4000 });
    const out = `/tmp/sv-bubble-${shot.name}.png`;
    await banner.screenshot({ path: out });
    console.log(`saved ${out}`);
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(2); });
