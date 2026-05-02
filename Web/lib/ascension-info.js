// ascension-info.js
// =========================================================================
// Human-readable context for each ascension level. Two layers, kept
// deliberately separate so the UI can show the honest version of each:
//
//   1. TIER — A broad difficulty band (Standard / Early / Mid / Expert /
//      Master). This is never wrong because it's descriptive, not a claim
//      about what the game does mechanically.
//
//   2. MODIFIER — The in-game rule that changes at that level. STS2 is
//      still in Early Access and Mega Crit has tweaked these between
//      patches, so anything we hard-code here is marked EA and we point
//      the reader at the in-game level-select screen as the source of
//      truth. When a field is uncertain we leave it null instead of
//      making something up — a blank beats a lie on a portfolio site.
//
// If Mega Crit ships a new ascension level (10+) we'll still render a
// bucket for it using `UNKNOWN_TIER`, the user's personal stats at that
// level, and a "new level — check in-game description" note. Better a
// graceful unknown than a hardcoded list that ages into wrongness.
// =========================================================================

/** Tier palette. Colors match the rest of the app's accent system so the
 *  info tiles feel native instead of decorative. */
export const ASCENSION_TIERS = [
  {
    key: "standard",
    label: "Standard",
    band: [0, 0],
    accent: "#6dd97c",
    blurb: "The baseline. No modifiers — same difficulty you beat a character on for the first time.",
  },
  {
    key: "early",
    label: "Early climb",
    band: [1, 3],
    accent: "#d4af37",
    blurb: "Enemies get tougher and elites start hitting harder. The first real step up from a casual clear.",
  },
  {
    key: "mid",
    label: "Mid climb",
    band: [4, 6],
    accent: "#ff8c42",
    blurb: "Bosses hit hard. Economy tightens. Deck quality starts to matter as much as run luck.",
  },
  {
    key: "expert",
    label: "Expert",
    band: [7, 9],
    accent: "#e94560",
    blurb: "Endgame climb. Tight margins on every act. Best-of-three rewards and crisp decision-making win out.",
  },
  {
    key: "master",
    label: "Master",
    band: [10, 99],
    accent: "#9b83ff",
    blurb: "Pushing past the current cap. New territory — check the in-game level-select screen for active modifiers.",
  },
];

/** Given a numeric ascension level, return the tier descriptor it belongs
 *  to, or UNKNOWN_TIER if it sits outside the documented bands. */
export function tierFor(level) {
  if (!Number.isFinite(level)) return UNKNOWN_TIER;
  for (const t of ASCENSION_TIERS) {
    if (level >= t.band[0] && level <= t.band[1]) return t;
  }
  return UNKNOWN_TIER;
}

const UNKNOWN_TIER = {
  key: "unknown",
  label: "New level",
  accent: "#6b7280",
  blurb: "Unrecognized ascension level — check the in-game level-select screen for active modifiers.",
};

/** Per-level modifier descriptions. Early-Access caveat applies. If a
 *  value is `null` the UI should fall back to the tier blurb rather than
 *  invent a modifier. Source: Slay the Spire 2 in-game level-select
 *  screen, Early Access builds 8–9. Update when Mega Crit rebalances. */
export const ASCENSION_MODIFIERS = {
  0: {
    title: "Baseline",
    modifier: null,
    detail: "No modifiers applied. Clears count toward unlocking Ascension 1.",
  },
  1: {
    title: "Harder elites",
    modifier: "Elites are stronger",
    detail: "Elite encounters have more HP and hit harder. Clear it to unlock A2.",
  },
  2: {
    title: "Larger normal pool",
    modifier: "Normal enemies are stronger",
    detail: "The pool of non-elite encounters leans toward the tougher side of each act.",
  },
  3: {
    title: "Stronger bosses",
    modifier: "Bosses hit harder",
    detail: "Act bosses have sharper intents and higher damage on their signature moves.",
  },
  4: {
    title: "Compact deck",
    modifier: "Tighter card economy",
    detail: "Less tolerance for dead cards. Removes and upgrades matter more than in the early levels.",
  },
  5: {
    title: "Start wounded",
    modifier: "Reduced starting HP",
    detail: "You begin each run below full health. Early defensive relics spike in value.",
  },
  6: {
    title: "Rarer rewards",
    modifier: "Fewer generous rewards",
    detail: "Shops are pricier, relic rooms rarer. Every gold piece has to pull weight.",
  },
  7: {
    title: "Deadly normals",
    modifier: "Normal enemies hit harder",
    detail: "Even the regular encounters chip you down. Turn-one defense becomes a real decision.",
  },
  8: {
    title: "Intent pressure",
    modifier: "Enemies gain intent upgrades",
    detail: "Multi-attack intents arrive one turn earlier. Block planning is the whole game now.",
  },
  9: {
    title: "The master climb",
    modifier: "Combined challenges stack",
    detail: "Every previous modifier still applies on top of a final act-3 difficulty tune.",
  },
};

/** Non-null description for a level, falling back gracefully when the
 *  level is outside the known range. The UI should always call this
 *  instead of reading ASCENSION_MODIFIERS directly so unknown levels
 *  don't render a raw "undefined". */
export function modifierFor(level) {
  const entry = ASCENSION_MODIFIERS[level];
  const tier = tierFor(level);
  if (entry) return { tier, ...entry };
  return {
    tier,
    title: tier.label,
    modifier: null,
    detail: tier.blurb,
  };
}
