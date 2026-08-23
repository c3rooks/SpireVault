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
// A10 (fight two bosses at the end of Act 3) is the current Early
// Access ceiling. If Mega Crit ships a higher level we'll still render a
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
    blurb: "More elites, stingier Ancient heals, and tighter gold. The first real step up from a casual clear.",
  },
  {
    key: "mid",
    label: "Mid climb",
    band: [4, 6],
    accent: "#ff8c42",
    blurb: "A potion slot gone, a cursed starting card, and pricier removes. Resource management starts to bite.",
  },
  {
    key: "expert",
    label: "Expert",
    band: [7, 9],
    accent: "#e94560",
    blurb: "Rare and upgraded cards dry up while enemies gain HP and damage. Tight margins on every act.",
  },
  {
    key: "master",
    label: "Master",
    band: [10, 10],
    accent: "#9b83ff",
    blurb: "The Early Access ceiling: a second boss waits at the end of Act 3. Verify modifiers on the in-game level-select screen.",
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
 *  screen (verified by beta testers against the live build). Each level
 *  applies a single, specific rule change — they do NOT all just "make
 *  enemies stronger". Update when Mega Crit rebalances. */
export const ASCENSION_MODIFIERS = {
  0: {
    title: "Baseline",
    modifier: null,
    detail: "No modifiers applied. Clears count toward unlocking Ascension 1.",
  },
  1: {
    title: "More elites",
    modifier: "Elites spawn more often",
    detail: "Roughly 60% more elite encounters appear across the run.",
  },
  2: {
    title: "Weaker heals",
    modifier: "Ancients heal less",
    detail: "Ancients restore only 80% of your missing HP — this includes Neow's heal at the start of a run.",
  },
  3: {
    title: "Gold squeeze",
    modifier: "Less gold drops",
    detail: "Enemies and treasure chests drop 25% less gold.",
  },
  4: {
    title: "Fewer potions",
    modifier: "One less potion slot",
    detail: "You start each run with one fewer potion slot.",
  },
  5: {
    title: "Cursed start",
    modifier: "Start with an Ascender's Bane",
    detail: "Each run begins with an Ascender's Bane in your deck.",
  },
  6: {
    title: "Expensive removes",
    modifier: "Pricier card removal",
    detail: "Card removal at the Merchant starts at 100 gold (up from 75), and each subsequent removal costs 50 gold more (up from 25).",
  },
  7: {
    title: "Thinner rewards",
    modifier: "Rare & upgraded cards halved",
    detail: "Rare and upgraded cards appear half as often — in combat rewards from every enemy and in the Merchant's stock.",
  },
  // A8/A9 note — the per-enemy numbers behind these two levels are being
  // actively retuned on the BETA branch (v0.111.0, Aug 2026: Exoskeleton
  // and Entomancer HP at A8; Globe Head, Louse Progenitor and Soul Fysh
  // scaling at A9; Torchhead Amalgam at A9 in v0.108/0.109). The rule
  // *described* here is unchanged on both branches — only the magnitudes
  // moved, and those live in-game, not in this file.
  8: {
    title: "Tankier enemies",
    modifier: "Enemies have more HP",
    detail: "All enemies have increased maximum HP.",
  },
  9: {
    title: "Harder hits",
    modifier: "Enemies deal more damage",
    detail: "All enemies deal increased damage and scale harder.",
  },
  10: {
    title: "Twin bosses",
    modifier: "Double Act 3 boss",
    detail: "You fight two bosses back-to-back at the end of Act 3 — the current Early Access ceiling.",
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
