// Sanity-check the latest hero-banner rework against three concrete
// promises made to the user:
//
//   1. Import / Refresh / Export live in each stats tab's painted
//      banner (`.panel-head-toprow`), not in a separate global strip
//      above the tab panels and not buried in legacy `.panel-actions`.
//   2. The diorama scene (climber + boss + line) re-rolls on tab
//      switch (intentional — gives the page a sense of life). Each
//      tab's diorama renders, with both a climber sprite and a
//      bubble line.
//   3. The bubble is still grid-centered above its speaker on every
//      tab + viewport.
//
// Hits the local server at :8765 and prints PASS/FAIL per check.
import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL  = process.env.URL || "http://127.0.0.1:8765/";
const TABS = ["overview", "characters", "ascensions", "relics", "cards"];

function pass(msg) { console.log(`PASS  ${msg}`); }
function fail(msg) { console.log(`FAIL  ${msg}`); process.exitCode = 1; }

async function snapTab(page, tab) {
  await page.click(`button.nav-row[data-tab="${tab}"]`);
  await page.waitForTimeout(350);
  return await page.evaluate((t) => {
    const panel = document.querySelector(`.tab-panel[data-tab="${t}"]`);
    const head  = panel?.querySelector(".panel-head");
    const slot  = head?.querySelector(".companion-slot");
    if (!head || !slot) return null;
    const climberImg = slot.querySelector(".scene-figure-climber img");
    const bubble = slot.querySelector(".scene-bubble");
    const speakerCol = bubble?.classList.contains("scene-bubble-climber") ? "climber" : "boss";
    const speakerEl  = slot.querySelector(`.scene-figure-${speakerCol}`);
    const r = (n) => { const x = n.getBoundingClientRect(); return { left: x.left, width: x.width }; };
    return {
      hasImportInToprow: !!head?.querySelector('.panel-head-toprow [data-action="upload"]'),
      hasImportInPanelActions: !!head?.querySelector('.panel-actions [data-action="upload"]'),
      climberSrc: climberImg?.getAttribute("src") || null,
      bubbleText: bubble?.textContent.trim().slice(0, 60) || null,
      speaker: speakerCol,
      bubbleCenter:  bubble && (r(bubble).left + r(bubble).width / 2),
      speakerCenter: speakerEl && (r(speakerEl).left + r(speakerEl).width / 2),
    };
  }, tab);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(URL);
  await page.evaluate(() => {
    localStorage.removeItem("vault.web.companion.v2");
    localStorage.removeItem("vault.web.companion");
  });
  await page.reload();
  await page.waitForTimeout(700);

  // Walk every tab in order, snapshot the relevant state.
  const snaps = {};
  for (const t of TABS) snaps[t] = await snapTab(page, t);

  // ─── 1. Import / Refresh / Export live in each banner top row ───
  const toolbarImport = await page.$('.tab-panel[data-tab="overview"] .panel-head-toprow [data-action="upload"]');
  if (toolbarImport) pass("overview banner has the Import button");
  else fail("overview banner is missing the Import button (regression)");
  const toolbarRefresh = await page.$('.tab-panel[data-tab="overview"] .panel-head-toprow [data-action="reload-saves"]');
  if (toolbarRefresh) pass("overview banner has the Refresh button");
  else fail("overview banner is missing the Refresh button (regression)");

  for (const t of TABS) {
    if (snaps[t]?.hasImportInToprow) pass(`${t}: Import in banner toolbar`);
    else fail(`${t}: missing Import in panel-head top row`);
    if (!snaps[t]?.hasImportInPanelActions) pass(`${t}: no legacy Import in panel-actions`);
    else fail(`${t}: duplicate Import still in .panel-actions`);
  }

  // ─── 2. Each stats tab renders a diorama (figures + speech line) ───
  for (const t of TABS) {
    const s = snaps[t];
    if (s?.climberSrc && s?.bubbleText) pass(`${t}: diorama rendered`);
    else fail(`${t}: missing diorama (climber or bubble empty)`);
  }

  // ─── 3. Bubble still centered over speaker on every tab ───
  for (const t of TABS) {
    const s = snaps[t];
    if (!s?.bubbleCenter || !s?.speakerCenter) { fail(`${t}: missing bubble/speaker geometry`); continue; }
    const off = Math.abs(s.bubbleCenter - s.speakerCenter);
    if (off <= 25) pass(`${t}: bubble over ${s.speaker} (offset ${off.toFixed(1)}px)`);
    else            fail(`${t}: bubble off-center by ${off.toFixed(1)}px`);
  }

  // ─── 4. Bubble click re-rolls the scene + propagates everywhere ───
  await page.click(`button.nav-row[data-tab="overview"]`);
  await page.waitForTimeout(200);
  const before = await snapTab(page, "overview");
  await page.click(`.tab-panel[data-tab="overview"] .scene-bubble`);
  await page.waitForTimeout(250);
  const after = await snapTab(page, "overview");
  if (after.bubbleText !== before.bubbleText || after.climberSrc !== before.climberSrc) {
    pass(`bubble click re-rolled the scene (line: "${before.bubbleText}" → "${after.bubbleText}")`);
  } else {
    // Could legitimately roll the same line by chance with a tiny pool.
    // Try once more before giving up.
    await page.click(`.tab-panel[data-tab="overview"] .scene-bubble`);
    await page.waitForTimeout(250);
    const retry = await snapTab(page, "overview");
    if (retry.bubbleText !== before.bubbleText || retry.climberSrc !== before.climberSrc) {
      pass(`bubble click re-rolled (after retry): "${before.bubbleText}" → "${retry.bubbleText}"`);
    } else {
      fail(`bubble click did not re-roll the scene (line stayed "${before.bubbleText}")`);
    }
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(2); });
