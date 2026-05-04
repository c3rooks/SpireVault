// Verifies the diorama hero banner against the user's two open bugs:
//
//   1. The speech bubble is geometrically *centered above the speaker*
//      (within a few px of the column's horizontal middle), not floating
//      off to one edge of the diorama.
//   2. With a fresh localStorage (`vault.web.companion.v2` unset) the
//      climber randomizes across renders — i.e. the new key bump
//      actually lands you in Random by default and isn't silently
//      pinned to "defect".
//
// Hits the local dev server at :8765 so we can validate the change
// before pushing to production. Spits a PASS/FAIL line per check.
//
// Usage:
//   node scripts/verify-bubble-center.mjs
import { chromium } from "/Users/corey/Desktop/Business-Automation/node_modules/playwright/index.mjs";

const URL = process.env.URL || "http://127.0.0.1:8765/";
const TABS = ["overview", "characters", "ascensions", "relics", "cards"];

function pass(msg) { console.log(`PASS  ${msg}`); }
function fail(msg) { console.log(`FAIL  ${msg}`); process.exitCode = 1; }

async function measureBubbleCenter(page, tab) {
  await page.click(`button.nav-row[data-tab="${tab}"]`);
  await page.waitForTimeout(400);
  const slot = page.locator(`.tab-panel[data-tab="${tab}"] .companion-slot`).first();
  await slot.waitFor({ state: "visible", timeout: 4000 });

  // Dump positions in a single browser-side eval for a consistent snapshot.
  return await slot.evaluate((el) => {
    const scene  = el.querySelector(".scene");
    const bubble = el.querySelector(".scene-bubble");
    const climber = el.querySelector(".scene-figure-climber");
    const boss   = el.querySelector(".scene-figure-boss");
    if (!scene || !bubble || !climber || !boss) return null;
    const rect = (n) => {
      const r = n.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
    };
    return {
      scene:   rect(scene),
      bubble:  rect(bubble),
      climber: rect(climber),
      boss:    rect(boss),
      isClimberSpeaking: bubble.classList.contains("scene-bubble-climber"),
      bubbleText: bubble.textContent.trim().slice(0, 60),
      climberLabel: climber.getAttribute("aria-label") || "",
    };
  });
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.goto(URL);

  // Force a fresh "Random" default by clearing the new key.
  await page.evaluate(() => {
    localStorage.removeItem("vault.web.companion.v2");
    localStorage.removeItem("vault.web.companion");
  });
  await page.reload();
  await page.waitForTimeout(600);

  // ─── Check 1: bubble centered over speaker column ───
  for (const tab of TABS) {
    const m = await measureBubbleCenter(page, tab);
    if (!m) { fail(`[${tab}] could not measure diorama (slot missing)`); continue; }

    const speakerRect = m.isClimberSpeaking ? m.climber : m.boss;
    const speakerCenter = speakerRect.left + speakerRect.width / 2;
    const bubbleCenter  = m.bubble.left  + m.bubble.width  / 2;
    const offset = Math.abs(bubbleCenter - speakerCenter);

    // Tolerance: bubble can drift a few px due to padding / column-gap,
    // but anything more than ~25px reads as visibly off-center.
    if (offset <= 25) {
      pass(`[${tab}] bubble centered over ${m.isClimberSpeaking ? "climber" : "boss"} (offset ${offset.toFixed(1)}px) — "${m.bubbleText}"`);
    } else {
      fail(`[${tab}] bubble off-center by ${offset.toFixed(1)}px (speaker=${speakerCenter.toFixed(1)}, bubble=${bubbleCenter.toFixed(1)})`);
    }

    // Also check the bubble doesn't physically overlap the figure below.
    const bubbleBottom = m.bubble.top + m.bubble.height;
    if (bubbleBottom <= speakerRect.top + 8) {
      pass(`[${tab}] bubble sits above figure (bottom=${bubbleBottom.toFixed(1)}, figure top=${speakerRect.top.toFixed(1)})`);
    } else {
      fail(`[${tab}] bubble overlaps figure (bottom=${bubbleBottom.toFixed(1)}, figure top=${speakerRect.top.toFixed(1)})`);
    }
  }

  // ─── Check 2: random default actually randomizes ───
  await page.click(`button.nav-row[data-tab="overview"]`);
  await page.waitForTimeout(300);
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    // Click the bubble to re-roll, then grab the climber image src.
    const bubble = page.locator(`.tab-panel[data-tab="overview"] .scene-bubble`).first();
    await bubble.click({ force: true }).catch(() => {});
    await page.waitForTimeout(120);
    const src = await page.locator(`.tab-panel[data-tab="overview"] .scene-figure-climber img`).first().getAttribute("src").catch(() => null);
    if (src) {
      const slug = src.split("/").pop().split(".")[0];
      seen.add(slug);
    }
  }
  if (seen.size >= 3) {
    pass(`Random climber rolls produced ${seen.size} distinct characters: ${[...seen].join(", ")}`);
  } else {
    fail(`Random climber stuck — only saw ${seen.size} distinct (${[...seen].join(", ")}) over 14 rolls`);
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(2); });
