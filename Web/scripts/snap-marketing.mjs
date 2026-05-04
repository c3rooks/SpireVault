// Marketing screenshot capture for the Site/ landing page.
//
// Captures fresh screenshots of the redesigned web companion (v52
// banner shrink + image-rich share card + Recent Runs detail modal)
// at marketing-grade dimensions and writes them to:
//   Site/assets/screenshots/web-overview.png
//   Site/assets/screenshots/web-characters.png
//   Site/assets/screenshots/web-runs.png
//   Site/assets/screenshots/web-run-detail.png
//   Site/assets/screenshots/web-share.png
//   Site/assets/screenshots/web-mobile.png
//
// Each shot uses the local Web/ build served by python http.server so
// the captures pick up the latest CSS/JS without any deploy step.
//
// Usage:
//   cd Web/ && node scripts/snap-marketing.mjs

import { chromium, devices } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { mkdirSync } from "node:fs";

const PORT = 8851;
const ROOT = "/Users/corey/Desktop/SlayTheSpireApp/Web";
const OUT  = "/Users/corey/Desktop/SlayTheSpireApp/Site/assets/screenshots";
mkdirSync(OUT, { recursive: true });

const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
await wait(800);

const URL = `http://127.0.0.1:${PORT}/`;
const browser = await chromium.launch();
const log = (msg) => console.log("· " + msg);

try {
  // ── DESKTOP ──────────────────────────────────────────────────────
  // 1440×900 — generous canvas so the marketing site can render the
  // shot inside a chrome window without scaling artifacts.
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const dpage = await desktop.newPage();
  await dpage.goto(URL, { waitUntil: "networkidle" });
  await dpage.waitForSelector(".tab-panel", { timeout: 10000 });
  await wait(800);

  for (const tab of [
    { id: "overview",   name: "web-overview" },
    { id: "characters", name: "web-characters" },
    { id: "ascensions", name: "web-ascensions" },
    { id: "relics",     name: "web-relics" },
    { id: "cards",      name: "web-cards" },
    { id: "runs",       name: "web-runs" },
  ]) {
    await dpage.click(`button.nav-row[data-tab="${tab.id}"]`);
    await wait(700);
    await dpage.screenshot({ path: `${OUT}/${tab.name}.png`, fullPage: false });
    log(`captured ${tab.name}.png`);
  }

  // 2. Run detail modal — open the first run on Recent Runs.
  await dpage.click(`button.nav-row[data-tab="runs"]`);
  await wait(500);
  await dpage.click(".run-row");
  await wait(700);
  await dpage.screenshot({ path: `${OUT}/web-run-detail.png`, fullPage: false });
  log("captured web-run-detail.png");
  // Close detail
  await dpage.keyboard.press("Escape");
  await wait(300);

  // 3. Image-rich share card — click any run's share button.
  await dpage.click(".run-row .run-share-btn");
  await wait(2000); // wait for relic + card images to preload
  await dpage.screenshot({ path: `${OUT}/web-share.png`, fullPage: false });
  log("captured web-share.png");
  await dpage.keyboard.press("Escape");
  await wait(300);
  await desktop.close();

  // ── MOBILE ──────────────────────────────────────────────────────
  const mobile = await browser.newContext({
    ...devices["iPhone 13"],
    deviceScaleFactor: 3,
  });
  const mpage = await mobile.newPage();
  await mpage.goto(URL, { waitUntil: "networkidle" });
  await mpage.waitForSelector(".tab-panel", { timeout: 10000 });
  await wait(800);

  await mpage.screenshot({ path: `${OUT}/web-mobile-overview.png`, fullPage: false });
  log("captured web-mobile-overview.png");

  await mpage.click(`button.nav-row[data-tab="runs"]`);
  await wait(600);
  await mpage.screenshot({ path: `${OUT}/web-mobile-runs.png`, fullPage: false });
  log("captured web-mobile-runs.png");

  await browser.close();
} catch (e) {
  console.error("snap-marketing failed:", e);
  process.exitCode = 1;
} finally {
  server.kill();
}
console.log("\nAll captures written to", OUT);
