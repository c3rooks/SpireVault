/**
 * The first-screen checks of scripts/verify-site.mjs: that the whole first
 * screen fits a laptop window, that the featured card and the hand are right
 * for every climber, and that no picture on the page is drawn past its pixels.
 */

import { loadLazy, openPage } from "./verify-site-harness.mjs";
import { drawnTooLarge, heroGeometry } from "./verify-site-page.mjs";

/** The climbers boot.js may feature, and everyone who must be on the first screen. */
export const FEATURED = Object.freeze(["ironclad", "silent", "defect", "regent", "necrobinder"]);
const EVERYONE = Object.freeze([...FEATURED, "fool"]);
/** Where a rotated card's corner may reach past the hero's column without being a fault. */
const SLACK_PX = 1;
/** A picture may be drawn up to this many device pixels per picture pixel. */
const STRETCH_LIMIT = 1.05;

/**
 * The whole first screen fits the window: copy, featured card and hand.
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 * @param {ReadonlyArray<{ width: number, height: number }>} folds
 */
export async function checkFold(browser, baseUrl, folds) {
  const failures = [];
  for (const fold of folds) {
    const { page, context } = await openPage(browser, baseUrl, { ...fold });
    try {
      const geo = await page.evaluate(heroGeometry);
      const where = `${fold.width}x${fold.height}`;
      const inside = (box, label) => {
        if (!box) return failures.push(`${where}: ${label} missing`);
        if (box.bottom > fold.height + 0.5) failures.push(`${where}: ${label} runs ${Math.round(box.bottom - fold.height)}px below the fold`);
        if (geo.hero && (box.top < geo.hero.top - 0.5 || box.bottom > geo.hero.bottom + 0.5)) failures.push(`${where}: ${label} sticks out of the hero`);
        return null;
      };
      inside(geo.hero, "hero");
      inside(geo.lastCopyChild, "copy");
      if (geo.featured.length !== 1) failures.push(`${where}: expected 1 featured card, found ${geo.featured.length}`);
      geo.featured.forEach((card) => inside(card.box, `featured card (${card.climber})`));
      if (geo.cards.length !== 5) failures.push(`${where}: expected 5 cards in the hand, found ${geo.cards.length}`);
      geo.cards.forEach((card) => inside(card.box, `hand card (${card.climber})`));
    } finally {
      await context.close();
    }
  }
  return failures;
}

/**
 * For each climber the roll can feature, at each width: that climber's card
 * is the big one with their own painting and one of their lines, the other
 * five (The Fool among them) are the hand, and nothing leaves the screen.
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 * @param {ReadonlyArray<number>} widths
 * @param {Record<number, number>} heights
 * @param {number} phoneMaxWidth
 */
export async function checkHand(browser, baseUrl, widths, heights, phoneMaxWidth) {
  const failures = [];
  if (widths.length === 0) failures.push("no widths to check the hand at");
  for (const width of widths) {
    for (const climber of FEATURED) {
      const { page, context } = await openPage(browser, baseUrl, { width, height: heights[width] || 900, query: `climber=${climber}&motion=off`, phone: width <= phoneMaxWidth });
      try {
        const geo = await page.evaluate(heroGeometry);
        const lines = await page.evaluate((id) => (window.SpireVaultSite ? window.SpireVaultSite.linesFor(id) : null), climber);
        const where = `${climber} at ${width}`;
        const [card] = geo.featured;
        if (geo.featured.length !== 1 || !card) {
          failures.push(`${where}: ${geo.featured.length} featured cards showing`);
          continue;
        }
        if (card.climber !== climber) failures.push(`${where}: the featured card is ${card.climber}`);
        if (!card.art.includes(`/${climber}-2x-`)) failures.push(`${where}: wrong painting on the featured card (${card.art})`);
        if (!/^\d+\.\d$/.test(card.rate)) failures.push(`${where}: the featured card's win rate reads "${card.rate}"`);
        if (!lines) failures.push(`${where}: window.SpireVaultSite.linesFor missing`);
        else if (!lines.includes(card.line)) failures.push(`${where}: "${card.line}" is not one of their lines`);

        const inHand = geo.cards.map((c) => c.climber);
        const expected = EVERYONE.filter((id) => id !== climber);
        if (inHand.join(",") !== expected.join(",")) failures.push(`${where}: the hand holds ${inHand.join(", ") || "nothing"}, expected ${expected.join(", ")}`);
        for (const c of geo.cards) if (!c.art.includes(`/${c.climber}-`)) failures.push(`${where}: ${c.climber}'s hand card shows ${c.art}`);

        for (const [label, box] of [["featured card", card.box], ...geo.cards.map((c) => [`${c.climber}'s hand card`, c.box])]) {
          if (box.width < 40 || box.height < 40) failures.push(`${where}: ${label} is not drawn`);
          if (box.left < -SLACK_PX || box.right > geo.viewport.width + SLACK_PX) failures.push(`${where}: ${label} runs off the side`);
          if (geo.hero && (box.top < geo.hero.top - SLACK_PX || box.bottom > geo.hero.bottom + SLACK_PX)) failures.push(`${where}: ${label} sticks out of the hero`);
        }
        // The hand sits under the featured card, never over its numbers.
        const highest = Math.min(...geo.cards.map((c) => c.box.top));
        if (highest < card.box.bottom - card.box.height * 0.12) failures.push(`${where}: the hand covers the featured card by ${Math.round(card.box.bottom - highest)}px`);
      } finally {
        await context.close();
      }
    }
  }
  return failures;
}

/**
 * No picture anywhere on the page is drawn past its own pixels on a 2x screen.
 * @param {import("playwright").Browser} browser
 * @param {string} baseUrl
 * @param {ReadonlyArray<{ width: number, height: number, phone?: boolean }>} screens
 */
export async function checkSharp(browser, baseUrl, screens) {
  const failures = [];
  for (const screen of screens) {
    const { page, context } = await openPage(browser, baseUrl, { ...screen, scale: 2 });
    try {
      await loadLazy(page);
      const offenders = await page.evaluate(drawnTooLarge, STRETCH_LIMIT);
      for (const offender of offenders) failures.push(`${screen.width} wide: ${offender}`);
    } finally {
      await context.close();
    }
  }
  return failures;
}
