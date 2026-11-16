/**
 * The first-screen checks of scripts/verify-site.mjs: that the whole first
 * screen fits a laptop window, that the duel and the hand are right for every
 * climber, and that no picture on the page is drawn past its pixels.
 */

import { loadLazy, openPage } from "./verify-site-harness.mjs";
import { drawnTooLarge, heroGeometry } from "./verify-site-page.mjs";

/** The climbers boot.js may deal into the duel, and everyone who must be on the first screen. */
export const FEATURED = Object.freeze(["ironclad", "silent", "defect", "regent", "necrobinder"]);
const EVERYONE = Object.freeze([...FEATURED, "fool"]);
/** Where a rotated card's corner may reach past the hero's column without being a fault. */
const SLACK_PX = 1;
/** A picture may be drawn up to this many device pixels per picture pixel. */
const STRETCH_LIMIT = 1.05;
/** How far a hand card may reach over a figure's box (the boxes have air around the art). */
const COVER_SLACK_PX = 12;

/**
 * The whole first screen fits the window: copy, the duel and the hand.
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
      inside(geo.duel.climberBox, "the climber in the duel");
      inside(geo.duel.bossBox, "the Architect");
      if (geo.cards.length !== EVERYONE.length) failures.push(`${where}: expected ${EVERYONE.length} cards in the hand, found ${geo.cards.length}`);
      geo.cards.forEach((card) => inside(card.box, `hand card (${card.climber})`));
    } finally {
      await context.close();
    }
  }
  return failures;
}

/** How far two boxes overlap, in px of height (0 when they do not). */
function overlapHeight(a, b) {
  if (!a || !b || a.right <= b.left || b.right <= a.left) return 0;
  return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/**
 * For each climber the roll can deal, at each width: that climber stands in
 * the duel with their own figure and one of their lines, on a painted scene;
 * all six climbers (The Fool among them) are in the hand, the dealt one's card
 * standing proud; nothing leaves the screen or covers the figures.
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
        const { duel } = geo;
        if (duel.climber !== climber) failures.push(`${where}: the duel deals ${duel.climber || "nobody"}`);
        if (!duel.climberBox || !duel.bossBox) {
          failures.push(`${where}: the duel is not drawn (climber ${!!duel.climberBox}, Architect ${!!duel.bossBox})`);
          continue;
        }
        if (!duel.climberArt.includes(`/assets/figure/${climber}-ink-`)) failures.push(`${where}: wrong figure in the duel (${duel.climberArt})`);
        if (!duel.bossArt.includes("/assets/figure/architect-ink-")) failures.push(`${where}: the Architect's figure is missing (${duel.bossArt})`);
        if (!/\/assets\/scene\//.test(geo.scene.art)) failures.push(`${where}: no painted scene behind the duel (${geo.scene.id || "none dealt"})`);
        if (duel.lineBy !== climber) failures.push(`${where}: the balloon speaks for ${duel.lineBy || "nobody"}`);
        if (!lines) failures.push(`${where}: window.SpireVaultSite.linesFor missing`);
        else if (!lines.includes(duel.line)) failures.push(`${where}: "${duel.line}" is not one of their lines`);

        const inHand = geo.cards.map((c) => c.climber);
        if (inHand.join(",") !== EVERYONE.join(",")) failures.push(`${where}: the hand holds ${inHand.join(", ") || "nothing"}, expected ${EVERYONE.join(", ")}`);
        for (const c of geo.cards) if (!c.art.includes(`/${c.climber}-`)) failures.push(`${where}: ${c.climber}'s hand card shows ${c.art}`);
        const proud = geo.cards.filter((c) => c.proud).map((c) => c.climber);
        if (proud.join(",") !== climber) failures.push(`${where}: the card standing proud is ${proud.join(", ") || "nobody's"}, not ${climber}'s`);

        for (const [label, box] of [["the climber in the duel", duel.climberBox], ["the Architect", duel.bossBox], ...geo.cards.map((c) => [`${c.climber}'s hand card`, c.box])]) {
          if (box.width < 40 || box.height < 40) failures.push(`${where}: ${label} is not drawn`);
          if (box.left < -SLACK_PX || box.right > geo.viewport.width + SLACK_PX) failures.push(`${where}: ${label} runs off the side`);
          if (geo.hero && (box.top < geo.hero.top - SLACK_PX || box.bottom > geo.hero.bottom + SLACK_PX)) failures.push(`${where}: ${label} sticks out of the hero`);
        }
        // The hand is dealt on the floor, never over the figures.
        for (const c of geo.cards) {
          const over = Math.max(overlapHeight(c.box, duel.climberBox), overlapHeight(c.box, duel.bossBox));
          if (over > COVER_SLACK_PX) failures.push(`${where}: ${c.climber}'s hand card covers the duel by ${Math.round(over)}px`);
        }
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
