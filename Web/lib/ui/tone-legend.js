// The win-rate colour key, shared by Top Relics and Cards so the same colour
// means the same thing on both tabs. script.js winrateTone() picks the tone
// against the player's own win rate; these labels say the same in words.
// Styles: styles/src/components/charts.css (.v-tone-legend).

import { esc, fixed } from "./html.js?v=1";

/** @typedef {"win"|"gold"|"accent"} WinTone */

/** What each tone means, in words a player can act on. */
export const TONE_LABELS = Object.freeze({
  win: "Proven above your average",
  gold: "Above your average",
  accent: "At or below your average",
});

/**
 * Any unknown tone reads as the neutral one.
 * @param {string} tone
 * @returns {WinTone}
 */
export function toneKey(tone) {
  return tone === "win" || tone === "gold" ? tone : "accent";
}

/**
 * The legend chips: the three tones, then the hatched small-sample mark.
 * @param {{ baselinePct: number, lowSampleRuns: number, lowSampleNoun: string }} opts
 *   baselinePct    the player's overall win rate, 0..100
 *   lowSampleNoun  what the small-sample count counts ("runs", "picks")
 * @returns {string}
 */
export function toneLegendHtml({ baselinePct, lowSampleRuns, lowSampleNoun }) {
  return `
    <ul class="v-tone-legend" aria-label="How to read the colors">
      <li class="v-tone-legend-base">Your average: <b>${fixed(baselinePct)}%</b></li>
      <li data-tone="win"><i aria-hidden="true"></i>${TONE_LABELS.win}</li>
      <li data-tone="gold"><i aria-hidden="true"></i>${TONE_LABELS.gold}</li>
      <li data-tone="accent"><i aria-hidden="true"></i>${TONE_LABELS.accent}</li>
      <li class="is-low"><i aria-hidden="true"></i>Under ${lowSampleRuns} ${esc(lowSampleNoun)}</li>
    </ul>`;
}
