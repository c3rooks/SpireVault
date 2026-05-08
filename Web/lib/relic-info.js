// relic-info.js
// =========================================================================
// Hand-curated drill-down content for the Top Relics tab.
//
// What each entry contains:
//   - rarity:    common | uncommon | rare | shop | boss | event | starter
//   - effect:    1-line in-game description (the relic's actual mechanic)
//   - tip:       1-2 sentences on when/why to pick this relic
//   - synergy:   short list of card archetypes / characters that pair well
//
// Source: Slay the Spire 2 in-game tooltips and the public wiki at
// slaythespire.wiki.gg, cross-checked against the manifest of relics
// the parser actually recognizes (Web/assets/sts2/manifest.json).
//
// The list deliberately covers the relics that show up most often on
// the Top Relics tab (by winrate). Niche / character-locked relics
// fall through to a generic-but-honest fallback ("Played N times,
// outcomes here") rather than fabricated copy.
// =========================================================================

export const RELIC_INFO = {
  burningblood: {
    rarity: "starter",
    effect: "Heal 6 HP after each combat. (Ironclad starter.)",
    tip: "Free sustain on every fight — extends how many losses you can absorb between rests, especially valuable in Act 1 before you have a stable block plan.",
    synergy: ["Ironclad", "Rest-strat", "Tanky front lines"],
  },
  pureblood: {
    rarity: "starter",
    effect: "Silent's starter — heal 4 HP after each combat in Act 1, then again in Act 2.",
    tip: "Less sustain than Burning Blood but still a free heal you'll trigger 50+ times. Don't skip campfires just because of this.",
    synergy: ["Silent"],
  },
  cracked_orb: {
    rarity: "starter",
    effect: "Defect's starter — channel 1 Lightning at the start of each combat.",
    tip: "Free orb every fight. Pairs hard with Focus and any orb-passive payoff (Storm, Static Discharge).",
    synergy: ["Defect", "Lightning builds", "Focus stacking"],
  },
  swordofjade: {
    rarity: "boss",
    effect: "Whenever you exhaust a card, gain 3 Block.",
    tip: "Top-tier exhaust payoff. If your deck has Feel No Pain or Dark Embrace, this is an auto-pick — turns every Burn / Wound into reliable defense.",
    synergy: ["Exhaust", "Ironclad", "Burn / Wound dumps"],
  },
  anchor: {
    rarity: "common",
    effect: "Start each combat with 10 Block.",
    tip: "Saves you ~1 Defend per fight, which compounds to massive turn-1 tempo on long acts. One of the strongest commons regardless of character.",
    synergy: ["Any", "Aggro openers", "Block-thorns plans"],
  },
  artofwar: {
    rarity: "uncommon",
    effect: "If you don't play any Attacks during a turn, gain an extra Energy next turn.",
    tip: "Free energy on skip-attack turns. Combos with skill-heavy decks (Silent discard / Defect setup turns).",
    synergy: ["Silent", "Defect setup turns", "Energy stacking"],
  },
  bagofmarbles: {
    rarity: "common",
    effect: "At the start of each combat, apply 1 Vulnerable to ALL enemies.",
    tip: "Universal multiplier — every attack you cast does 1.5×. Stack with Bronze Scales / Pen Nib for serious damage.",
    synergy: ["Strike spam", "Multi-hit", "AoE clears"],
  },
  bloodvial: {
    rarity: "common",
    effect: "At the start of each combat, heal 2 HP.",
    tip: "Outscales Burning Blood at low ascensions but caps quickly. Prioritize earlier in the run when 2 HP × 50 fights matters.",
    synergy: ["Long acts", "Aggro that takes chip damage"],
  },
  centennialpuzzle: {
    rarity: "common",
    effect: "The first time you lose HP each combat, draw 3 cards.",
    tip: "Massive tempo on a turn-2 spike. Hidden synergy with self-damage cards (Hemokinesis, Reaper) — you trigger it on purpose for the draw.",
    synergy: ["Self-damage", "Setup decks", "Card-draw scaling"],
  },
  letteropener: {
    rarity: "common",
    effect: "Every 3 Skills played, deal 5 damage to ALL enemies.",
    tip: "Quietly scales in skill-heavy Silent / Defect decks. Three Survivor + Acrobatics is already a Letter Opener trigger.",
    synergy: ["Silent skill spam", "Defect setup turns"],
  },
  shovel: {
    rarity: "shop",
    effect: "Once per turn, instead of attacking you may dig and remove a card from your deck.",
    tip: "Best in-run deck-thinning option. Becomes a shop auto-buy in any run where you want to compress your deck around a finisher.",
    synergy: ["Shiv decks", "Combo finishers", "Late-act deck compression"],
  },
  girya: {
    rarity: "boss",
    effect: "Lift 0 / At combat start, gain 1 Strength.",
    tip: "Permanent Strength every fight. Even better when you can stack lifts via Searing Blow / Body Slam.",
    synergy: ["Strength scaling", "Ironclad", "Body Slam decks"],
  },
  ectoplasm: {
    rarity: "boss",
    effect: "Gain 1 extra Energy at the start of each turn. You cannot gain Gold.",
    tip: "Energy-positive game-changer. The no-gold downside hurts shop-reliant builds; perfect for already-strong decks that don't need card-buys.",
    synergy: ["Energy-hungry decks", "Late-act pivot"],
  },
  callingbell: {
    rarity: "boss",
    effect: "Obtain a Curse, a Common Relic, an Uncommon Relic, and a Rare Relic.",
    tip: "Three relics for one slot. Curse is rough but the relic stack usually wins runs by itself. Top boss-relic pick on most ascensions.",
    synergy: ["Any", "Relic-stacking strategy"],
  },
  blackstar: {
    rarity: "boss",
    effect: "Elites drop 2 relics instead of 1.",
    tip: "Trades immediate power for compounding scaling. Best when you've already cleared a few elites in Act 1 (i.e. you know you can stay alive).",
    synergy: ["Elite hunters", "Long-game scaling"],
  },
  dreamcatcher: {
    rarity: "uncommon",
    effect: "When you rest, you may add a card to your deck.",
    tip: "Free card every campfire. Stacks runaway for an already-strong deck; on weak decks the new card can be a liability.",
    synergy: ["Strong-deck pivot", "Long acts"],
  },
  philosophersstone: {
    rarity: "boss",
    effect: "Gain 1 Energy at the start of each turn. ALL enemies start with 1 Strength.",
    tip: "Energy-positive but enemies hit harder. Pair with Block-heavy or Vulnerable-applying plans to neutralize the downside.",
    synergy: ["Block decks", "Vulnerable spam"],
  },
  bookoffiverings: {
    rarity: "rare",
    effect: "Whenever you channel an orb, gain 1 Focus for the rest of combat.",
    tip: "Defect-only insanity. With a few channel sources, you stack Focus into double digits by mid-combat.",
    synergy: ["Defect", "Lightning + Frost"],
  },
  runicpyramid: {
    rarity: "boss",
    effect: "At the end of your turn, you no longer discard your hand.",
    tip: "Holds setup cards (Wraith Form, Catalyst, Echo Form) until the perfect moment. Pivots a deck's whole identity.",
    synergy: ["Setup decks", "Catalyst", "Wraith Form"],
  },
  sneckoeye: {
    rarity: "boss",
    effect: "Draw 2 additional cards each turn, but cards are randomly upgraded or downgraded.",
    tip: "Draw 7 every turn — ridiculously strong on any deck that can spend energy. The randomness rarely matters at scale.",
    synergy: ["Energy decks", "Card-draw scaling"],
  },
  kunai: {
    rarity: "uncommon",
    effect: "Every 3 attacks played, gain 1 Dexterity.",
    tip: "Hidden Dexterity scaling on attack-heavy decks. Pairs with Shiv flurries and Strike spam.",
    synergy: ["Strike spam", "Shiv decks", "Dex stacking"],
  },
  shuriken: {
    rarity: "uncommon",
    effect: "Every 3 attacks played, gain 1 Strength.",
    tip: "Permanent Strength scaling on attack-heavy turns. Top-tier in any aggro plan.",
    synergy: ["Aggro", "Strike spam", "Strength scaling"],
  },
  icecream: {
    rarity: "boss",
    effect: "Energy is now conserved between turns.",
    tip: "Setup-deck enabler. Lets you save energy across slow turns for a massive nuke later.",
    synergy: ["Setup decks", "Combo finishers"],
  },
  tingsha: {
    rarity: "uncommon",
    effect: "Whenever you discard a card during your turn, deal 3 damage to a random enemy.",
    tip: "Free damage on Silent discard turns. Stacks with Tactician / Reflex for absurd burst.",
    synergy: ["Silent discard", "Reflex / Tactician"],
  },
  lizardtail: {
    rarity: "boss",
    effect: "When you would die, instead heal to 50% HP. (Single use.)",
    tip: "One free death. Best on aggressive plans where you're routinely low — turns a wipe into a clean win.",
    synergy: ["Aggro plans", "Glass-cannon"],
  },
};

/** Relic rarity color → matches in-game. */
export const RARITY_COLORS = {
  starter:  "#888a99",
  common:   "#9aa3b1",
  uncommon: "#5fa7d8",
  rare:     "#d4af37",
  shop:     "#5fc28d",
  boss:     "#b27dff",
  event:    "#ff8c42",
};

/** Returns the canonical info entry, or null if we don't ship hand-
 *  written copy for this slug. The renderer should fall back to the
 *  user's personal stats only when this is null — never invent
 *  copy that would lie about an in-game effect. */
export function relicInfoFor(slug) {
  const k = String(slug || "").trim().toLowerCase();
  return RELIC_INFO[k] || null;
}
