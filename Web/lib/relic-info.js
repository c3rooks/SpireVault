// relic-info.js
// =========================================================================
// Hand-curated drill-down content for the Top Relics tab.
//
// What each entry contains:
//   - rarity:    starter | common | uncommon | rare | ancient | shop | event
//                ("ancient" is STS2's boss-relic-equivalent tier — the
//                 Neow's / Tezcatara's / Nonupeipe's / Pael's / Tanx's /
//                 Vakuu's / Orobos' families plus a few legacy relics
//                 promoted into it. STS2 has NO "boss" rarity.)
//   - effect:    the in-game description, quoted from the STS2 wiki's
//                relic module (main branch). Icon runs are rendered as
//                counts — the raw data says "gain Energy Energy" where
//                the game shows two energy icons, so we write "gain 2
//                Energy". That is a rendering choice, not a paraphrase.
//   - tip:       1-2 sentences on when/why to pick this relic (ours)
//   - synergy:   short list of archetypes / characters that pair well
//
// SOURCE OF TRUTH & BRANCH POLICY
// Effects describe the MAIN branch (v0.107.1 "Major Update 2"), which is
// what ~90% of players run. The baseline text comes from the wiki-derived
// database in the local SlayTheSpire2Companion checkout (v0.104-era
// snapshot), with every known v0.105 → v0.107.1 patch-note delta applied
// on top — each one annotated where it happens. Beta-branch changes
// (v0.108.0 → v0.111.0) are tracked in the WATCHLIST comment at the
// bottom and must NOT be merged into `effect` strings until they ship to
// main. See docs/game-data-sync.md for the full netted timeline.
//
// THE ONE RULE: never fabricate in-game text. If we don't have a sourced
// description, the relic gets NO entry and the UI falls back to the
// player's personal stats ("Played N times, outcomes here"), which is
// honest. An entry with invented copy is worse than no entry.
// =========================================================================

export const RELIC_INFO = {
  // ---- Starters (all 10) --------------------------------------------------
  burningblood: {
    rarity: "starter",
    effect: "At the end of combat, heal 6 HP. (Ironclad starter.)",
    tip: "Free sustain on every fight — extends how many losses you can absorb between rests, especially valuable in Act 1 before you have a stable block plan.",
    synergy: ["Ironclad", "Rest-strat", "Tanky front lines"],
  },
  blackblood: {
    rarity: "starter",
    effect: "At the end of combat, heal 12 HP. (Ancient upgrade of Burning Blood.)",
    tip: "Doubled post-combat healing lets you play far greedier — chip damage stops mattering and campfires become upgrade slots instead of heals.",
    synergy: ["Ironclad", "Greedy pathing", "Upgrade-heavy rests"],
  },
  ringofthesnake: {
    rarity: "starter",
    effect: "At the start of each combat, draw 2 additional cards. (Silent starter.)",
    tip: "A 7-card opening hand every fight. Mulligan math favors combo openers — you see your Poison or Shiv engine pieces a full turn earlier than other classes.",
    synergy: ["Silent", "Combo openers", "Turn-1 tempo"],
  },
  ringofthedrake: {
    rarity: "starter",
    effect: "At the start of your first 3 turns, draw 2 additional cards. (Ancient upgrade of Ring of the Snake.)",
    tip: "Six bonus cards across the fight's opening — the strongest setup window in the game. Build around a big turn-3 payoff and it will be online every combat.",
    synergy: ["Silent", "Setup decks", "Draw engines"],
  },
  crackedcore: {
    rarity: "starter",
    effect: "At the start of each combat, Channel 1 Lightning. (Defect starter.)",
    tip: "Free orb every fight. Pairs hard with Focus and any orb-passive payoff — the earlier your Focus comes online, the more this opening Lightning matters.",
    synergy: ["Defect", "Lightning builds", "Focus stacking"],
  },
  infusedcore: {
    // v0.105.0 buff (now on main via v0.107.1): the wiki-era text read
    // "Channel 3 Lightning"; the May patch reshaped it as below.
    rarity: "starter",
    effect: "At the start of each combat, Channel 1 Lightning. Lightning Orbs deal 1 additional damage. (Ancient upgrade of Cracked Core.)",
    tip: "The +1 lightning damage compounds with every passive proc and every evoke. Sets a much higher floor on Lightning-orb decks.",
    synergy: ["Defect", "Lightning builds", "Focus stacking"],
  },
  divinedestiny: {
    rarity: "starter",
    effect: "At the start of each combat, gain 6 Stars. (Regent starter.)",
    tip: "Stars are Regent's casting resource — a guaranteed 6 lets you script your opening turns around a Star spender before the economy comes online.",
    synergy: ["Regent", "Star spenders", "Opening tempo"],
  },
  divineright: {
    rarity: "starter",
    effect: "At the start of each combat, gain Stars. (Ancient upgrade of Divine Destiny — larger grant.)",
    tip: "Same job as Divine Destiny with a bigger opening bankroll. Star-hungry openers become guaranteed rather than conditional.",
    synergy: ["Regent", "Star spenders", "Big openers"],
  },
  boundphylactery: {
    rarity: "starter",
    effect: "At the start of your turn, Summon 1. (Necrobinder starter.)",
    tip: "A steady drip of Souls with zero cards spent. Every Soul payoff in the deck gets fed automatically — it's the metronome the whole class is tuned around.",
    synergy: ["Necrobinder", "Soul payoffs", "Osty scaling"],
  },
  phylacteryunbound: {
    rarity: "starter",
    effect: "At the start of each combat, Summon 5. At the start of your turn, Summon 2. (Ancient upgrade of Bound Phylactery.)",
    tip: "Front-loads a full Soul bank and doubles the per-turn drip. Soul-spender decks skip their setup turn entirely.",
    synergy: ["Necrobinder", "Soul spenders", "Fast starts"],
  },

  // ---- Commons ------------------------------------------------------------
  anchor: {
    rarity: "common",
    effect: "Start each combat with 10 Block.",
    tip: "Saves you ~1 Defend every fight, which compounds into massive turn-1 tempo across an act. One of the strongest commons regardless of character.",
    synergy: ["Any", "Aggro openers", "Turn-1 tempo"],
  },
  amethystaubergine: {
    rarity: "common",
    effect: "Enemies drop 10 additional Gold.",
    tip: "Roughly a free shop relic per act if you fight often. Better the earlier you find it and the more elites you plan to hunt.",
    synergy: ["Shop-heavy routes", "Elite hunting"],
  },
  bagofpreparation: {
    rarity: "common",
    effect: "At the start of each combat, draw 2 additional cards.",
    tip: "A 7-card opening hand finds your engine pieces a turn earlier. Quietly one of the best commons in any combo deck.",
    synergy: ["Combo openers", "Thin decks"],
  },
  bloodvial: {
    rarity: "common",
    effect: "At the start of each combat, heal 2 HP.",
    tip: "Small but it triggers 50+ times a run. Prioritize early — the value is all in how many fights are left.",
    synergy: ["Long acts", "Chip-damage plans"],
  },
  bookoffiverings: {
    rarity: "common",
    effect: "Every 5 cards you add to your Deck, heal 15 HP.",
    tip: "Rewards greedy card-picking. If you're drafting most rewards anyway, this is steady free healing; on skip-heavy strategies it barely triggers.",
    synergy: ["Tall decks", "Draft-everything plans"],
  },
  bronzescales: {
    rarity: "common",
    effect: "Start each combat with 3 Thorns.",
    tip: "Punishes multi-hit enemies all run long. Stacks beautifully with block-heavy plans that make enemies swing into it repeatedly.",
    synergy: ["Block decks", "Thorns scaling"],
  },
  centennialpuzzle: {
    rarity: "common",
    effect: "The first time you lose HP each combat, draw 3 cards.",
    tip: "Massive tempo on a turn-2 spike. Hidden synergy with self-damage — trigger it on purpose the turn you need the draw.",
    synergy: ["Self-damage", "Setup decks", "Card-draw scaling"],
  },
  datadisk: {
    rarity: "common",
    effect: "Start each combat with 1 Focus. (Defect.)",
    tip: "Every orb in the whole fight is stronger. There is no Defect deck that doesn't want this.",
    synergy: ["Defect", "Any orb build"],
  },
  fencingmanual: {
    rarity: "common",
    effect: "At the start of each combat, Forge 10. (Regent.)",
    tip: "A free 10 Forge means your first big spender comes down a turn early. Smooths Regent's slowest opening hands.",
    synergy: ["Regent", "Forge spenders"],
  },
  festivepopper: {
    rarity: "common",
    effect: "At the start of each combat, deal 9 damage to ALL enemies.",
    tip: "Deletes half a hallway fight before turn 1. Value shrinks by Act 3 but the Act 1 tempo is real.",
    synergy: ["Fast hallway clears", "Act 1 tempo"],
  },
  gorget: {
    rarity: "common",
    effect: "At the start of each combat, gain 4 Plating.",
    tip: "Plating soaks small hits every turn until it breaks — quietly strong against multi-attack enemies.",
    synergy: ["Defensive openers", "Multi-hit matchups"],
  },
  happyflower: {
    rarity: "common",
    effect: "Every 3 turns, gain 1 Energy.",
    tip: "Free energy on a timer. The longer your fights run, the better it gets — boss fights love it.",
    synergy: ["Long fights", "Energy-hungry decks"],
  },
  juzubracelet: {
    rarity: "common",
    effect: "Regular enemy combats are no longer encountered in ? rooms.",
    tip: "Turns every ? room into pure upside — events, shrines, or free progress. Route through ?-dense floors once you have it.",
    synergy: ["Event-heavy routes", "Low-HP recovery"],
  },
  lantern: {
    rarity: "common",
    effect: "Start each combat with an additional Energy.",
    tip: "A 4-energy turn 1 every single fight. Openers that need one more energy to come online stop being conditional.",
    synergy: ["Big openers", "Any deck"],
  },
  mealticket: {
    rarity: "common",
    effect: "Whenever you enter a shop room, heal 15 HP.",
    tip: "Makes shops dual-purpose — heal and buy. On shop-dense maps it out-heals a rest site over an act.",
    synergy: ["Shop routes", "Gold-heavy runs"],
  },
  oddlysmoothstone: {
    rarity: "common",
    effect: "Start each combat with 1 Dexterity.",
    tip: "Every block card gains 1 for the whole run. Boring, reliable, always correct to take.",
    synergy: ["Block decks", "Any deck"],
  },
  redskull: {
    rarity: "common",
    effect: "While your HP is at or below 50%, you have 3 additional Strength. (Ironclad.)",
    tip: "Rewards Ironclad's natural bruiser cadence — self-damage cards can switch it on deliberately when you need the kill turn.",
    synergy: ["Ironclad", "Self-damage", "Aggro"],
  },
  regalite: {
    rarity: "common",
    effect: "Whenever a card is created, gain Block. (Regent.)",
    tip: "Every created card is now also a defend. Creation-heavy Regent decks turn this into double-digit free block per turn.",
    synergy: ["Regent", "Card creation"],
  },
  regalpillow: {
    rarity: "common",
    effect: "Whenever you Rest, heal an additional 15 HP.",
    tip: "Turns every rest into a near-full reset. The greedier your pathing, the more this pays.",
    synergy: ["Rest-strat", "Greedy pathing"],
  },
  sneckoskull: {
    rarity: "common",
    effect: "Whenever you apply Poison, apply an additional 1 Poison. (Silent.)",
    tip: "Every single Poison touch is +1. Multi-application cards (and multi-target sprays) scale it absurdly.",
    synergy: ["Silent", "Poison", "Multi-hit applicators"],
  },
  strawberry: {
    rarity: "common",
    effect: "Upon pickup, raise your Max HP by 7.",
    tip: "Permanent buffer. Max HP is the quietest but most universal defensive stat in the game.",
    synergy: ["Any deck"],
  },
  strikedummy: {
    rarity: "common",
    effect: "Cards containing \u201CStrike\u201D deal 3 additional damage.",
    tip: "Only worth it if you're keeping your Strikes — which means early Acts or a deliberate Strike build. Fades as you thin.",
    synergy: ["Strike builds", "Act 1 tempo"],
  },
  vajra: {
    rarity: "common",
    effect: "Start each combat with 1 Strength.",
    tip: "Every attack, every turn, all run. The multi-hit cards in your deck are the real winners.",
    synergy: ["Multi-hit", "Aggro"],
  },
  venerableteaset: {
    rarity: "common",
    effect: "Whenever you enter a Rest Site, start the next combat with an additional 2 Energy.",
    tip: "Rest, then pick a fight — the 5-energy opener that follows usually deletes an elite's first phase.",
    synergy: ["Elite hunting after rests", "Big openers"],
  },

  // ---- Uncommons ------------------------------------------------------------
  akabeko: {
    rarity: "uncommon",
    effect: "At the start of each combat, gain 8 Vigor.",
    tip: "Your first attack each fight hits like a truck. Front-load it into the biggest single hit in your hand.",
    synergy: ["Big single hits", "Opening burst"],
  },
  bagofmarbles: {
    rarity: "uncommon",
    effect: "At the start of each combat, apply 1 Vulnerable to ALL enemies.",
    tip: "A universal 1.5\u00D7 multiplier on your opening turn. Stack with other start-of-combat damage for serious hallway tempo.",
    synergy: ["Aggro openers", "Multi-hit", "AoE clears"],
  },
  bellows: {
    rarity: "uncommon",
    effect: "The first Hand you draw each combat is Upgraded.",
    tip: "Five free upgrades every single fight — openers hit harder, block bigger, cost less. Ridiculous with draw-heavy starters.",
    synergy: ["Draw engines", "Opening tempo"],
  },
  bowlerhat: {
    rarity: "uncommon",
    effect: "Gain 20% additional Gold.",
    tip: "Compounds with every fight and event. Take it early or don't bother — it's an investment relic.",
    synergy: ["Shop routes", "Early pickup"],
  },
  candelabra: {
    rarity: "uncommon",
    effect: "At the start of your 2nd turn, gain 2 Energy.",
    tip: "A scheduled 5-energy turn 2, every fight. Script your biggest play around it.",
    synergy: ["Big turn-2 plays", "Setup decks"],
  },
  goldplatedcables: {
    rarity: "uncommon",
    effect: "Your rightmost Orb triggers its passive an additional time. (Defect.)",
    tip: "Doubles your oldest orb's output. With Lightning parked rightmost this is straight damage; with Frost, straight block.",
    synergy: ["Defect", "Orb passives", "Focus"],
  },
  gremlinhorn: {
    rarity: "uncommon",
    effect: "Whenever an enemy dies, gain 1 Energy and draw 1 card.",
    tip: "Chains kills into tempo. In multi-enemy fights it effectively refunds the card that got the kill.",
    synergy: ["AoE", "Hallway clears"],
  },
  horncleat: {
    rarity: "uncommon",
    effect: "At the start of your 2nd turn, gain 14 Block.",
    tip: "Covers the turn your setup deck is busiest. Free defense exactly when you'd rather be playing powers.",
    synergy: ["Setup decks", "Power-heavy openers"],
  },
  josspaper: {
    rarity: "uncommon",
    effect: "Every 5 times you Exhaust a card, draw 1 card.",
    tip: "Exhaust engines refund themselves. In a dedicated exhaust deck this is a steady extra card every turn or two.",
    synergy: ["Exhaust engines", "Status dumps"],
  },
  luckyfysh: {
    rarity: "uncommon",
    effect: "Whenever you add a card to your Deck, gain 15 Gold.",
    tip: "Pays you to draft. Pairs naturally with Book of Five Rings-style greedy picking — the gold adds up to a free shop relic.",
    synergy: ["Draft-everything plans", "Shop routes"],
  },
  mercuryhourglass: {
    rarity: "uncommon",
    effect: "At the start of your turn, deal 3 damage to ALL enemies.",
    tip: "Free chip every turn that breaks poison-thresholds, kills lice, and finishes wounded enemies. Better in long fights.",
    synergy: ["AoE plans", "Long fights"],
  },
  orichalcum: {
    rarity: "uncommon",
    effect: "If you end your turn without Block, gain 6 Block.",
    tip: "A defensive floor for aggro decks — you never truly end a turn naked. Worst in decks that block every turn anyway.",
    synergy: ["Aggro", "All-out attack turns"],
  },
  pantograph: {
    rarity: "uncommon",
    effect: "At the start of each Boss combat, heal 25 HP.",
    tip: "Effectively walk into every boss with a bonus rest. Lets you spend campfires on upgrades instead of heals.",
    synergy: ["Upgrade-heavy rests", "Boss prep"],
  },
  paperphrog: {
    rarity: "uncommon",
    effect: "Enemies with Vulnerable take 75% more damage rather than 50%. (Ironclad.)",
    tip: "Turns Ironclad's easiest debuff into a colossal multiplier. Uppercut/Bash decks should never pass it.",
    synergy: ["Ironclad", "Vulnerable spam"],
  },
  paperkrane: {
    rarity: "uncommon",
    effect: "Enemies with Weak deal 40% less damage to you rather than 25%. (Silent.)",
    tip: "Weak becomes near-total damage shutdown. With cheap repeat applicators you can facetank fights you had no business surviving.",
    synergy: ["Silent", "Weak spam"],
  },
  parryingshield: {
    rarity: "uncommon",
    effect: "If you end a turn with at least 10 Block, deal 6 damage to a random enemy.",
    tip: "Block decks get free damage for doing what they already do. Adds up over long boss fights.",
    synergy: ["Block decks", "Long fights"],
  },
  pear: {
    rarity: "uncommon",
    effect: "Upon pickup, raise your Max HP by 10.",
    tip: "Permanent buffer, no strings. Always fine.",
    synergy: ["Any deck"],
  },
  planisphere: {
    rarity: "uncommon",
    effect: "Whenever you enter a ? room, heal 4 HP.",
    tip: "Stacks with Juzu-style ? routing. On event-dense maps it's a rest site spread across the act.",
    synergy: ["Event-heavy routes"],
  },
  redmask: {
    rarity: "uncommon",
    effect: "At the start of each combat, apply 1 Weak to ALL enemies.",
    tip: "Opening-turn damage reduction against every enemy. Quietly one of the best defensive uncommons for aggro decks.",
    synergy: ["Aggro", "Weak synergies"],
  },
  selfformingclay: {
    rarity: "uncommon",
    effect: "Whenever you lose HP in combat, gain 3 Block next turn. (Ironclad.)",
    tip: "Converts chip damage into next-turn armor. Self-damage cards trigger it on your terms.",
    synergy: ["Ironclad", "Self-damage", "Bruiser plans"],
  },
  sparklingrouge: {
    rarity: "uncommon",
    effect: "At the start of your 3rd turn, gain 1 Strength and 1 Dexterity.",
    tip: "A scheduled stat bump that arrives exactly when hallway fights get serious. Free value in every long fight.",
    synergy: ["Long fights", "Stat scaling"],
  },
  stonecracker: {
    rarity: "uncommon",
    effect: "At the start of Boss combats, Upgrade 3 random cards in your Draw Pile for the rest of combat.",
    tip: "Boss-only power spike. The taller your deck, the more random the value — thin decks make it reliably hit the cards that matter.",
    synergy: ["Boss prep", "Thin decks"],
  },
  symbioticvirus: {
    rarity: "uncommon",
    effect: "At the start of each combat, Channel 1 Dark. (Defect.)",
    tip: "A Dark orb banking damage from turn 0. In slow fights it matures into a one-orb execute.",
    synergy: ["Defect", "Dark orbs", "Long fights"],
  },
  tingsha: {
    rarity: "uncommon",
    effect: "Whenever you discard a card during your turn, deal 3 damage to a random enemy for each card discarded.",
    tip: "Free damage on Silent discard turns. Stacks with Tactician/Reflex-style packages for absurd chip totals.",
    synergy: ["Silent discard", "Reflex / Tactician"],
  },
  toughbandages: {
    rarity: "uncommon",
    effect: "Whenever you discard a card during your turn, gain 3 Block. (Silent.)",
    tip: "The defensive twin of Tingsha. A discard engine with both online blocks and chips at once.",
    synergy: ["Silent discard", "Block scaling"],
  },
  twistedfunnel: {
    rarity: "uncommon",
    effect: "At the start of each combat, apply 4 Poison to ALL enemies. (Silent.)",
    tip: "Every fight opens with poison already ticking. Catalyst-style multipliers get a free base to work from.",
    synergy: ["Silent", "Poison", "Catalyst payoffs"],
  },
  vambrace: {
    rarity: "uncommon",
    effect: "The first time you gain Block from a card each combat, double the amount gained.",
    tip: "Lead with your biggest block card, not your first Defend — sequencing this correctly is worth 10+ block a fight.",
    synergy: ["Big block cards", "Sequencing"],
  },

  // ---- Rares ---------------------------------------------------------------
  beatingremnant: {
    rarity: "rare",
    effect: "You cannot lose more than 20 HP in a single turn.",
    tip: "A hard floor under every spike turn. Bosses with big single hits (and your own reckless plays) stop being lethal.",
    synergy: ["Anti-burst insurance", "Greedy turns"],
  },
  bighat: {
    rarity: "rare",
    effect: "At the start of each combat, add 2 random Ethereal cards into your Hand. (Necrobinder.)",
    tip: "Two free plays every opening turn that self-clean via Ethereal. Eidolon-style Exhaust payoffs feed off them all fight.",
    synergy: ["Necrobinder", "Ethereal payoffs", "Exhaust"],
  },
  bookmark: {
    rarity: "rare",
    effect: "At the end of each turn, lower the cost of a random Retained card by 1 until played. (Necrobinder.)",
    tip: "Retain engines get their held cards discounted toward free. The longer you hold, the cheaper the payoff turn.",
    synergy: ["Necrobinder", "Retain package"],
  },
  bookrepairknife: {
    rarity: "rare",
    effect: "Whenever a non-Minion enemy dies to Doom, heal 3 HP. (Necrobinder.)",
    tip: "Doom decks get paid in sustain for doing what they already do. Multi-enemy fights become net-positive HP.",
    synergy: ["Necrobinder", "Doom stacking"],
  },
  captainswheel: {
    rarity: "rare",
    effect: "At the start of your 3rd turn, gain 18 Block.",
    tip: "A scheduled wall exactly when setup decks are still assembling. Effectively a free skipped-defense turn per fight.",
    synergy: ["Setup decks", "Boss fights"],
  },
  chandelier: {
    rarity: "rare",
    effect: "At the start of your 3rd turn, gain 3 Energy.",
    tip: "Script your haymaker for turn 3 every fight. Setup decks detonate a turn earlier than the enemy expects.",
    synergy: ["Combo detonation", "Setup decks"],
  },
  charonsashes: {
    rarity: "rare",
    effect: "Whenever you Exhaust a card, deal 3 damage to ALL enemies. (Ironclad.)",
    tip: "Exhaust engines become AoE damage engines. Status dumps stop being defensive plays and start being clears.",
    synergy: ["Ironclad", "Exhaust engines", "Status dumps"],
  },
  cloakclasp: {
    rarity: "rare",
    effect: "At the end of your turn, gain 1 Block for each card in your Hand.",
    tip: "Retain and draw-heavy decks end turns with free armor. Pairs beautifully with hold-your-hand strategies.",
    synergy: ["Retain package", "Draw engines"],
  },
  demontongue: {
    rarity: "rare",
    effect: "The first time you lose HP on your turn, heal HP equal to the amount lost. (Ironclad.)",
    tip: "Your first self-damage each turn is free. Offering-style cards lose their downside entirely.",
    synergy: ["Ironclad", "Self-damage"],
  },
  emotionchip: {
    rarity: "rare",
    effect: "If you lost HP during the previous turn, trigger the passive ability of all Orbs at the start of your turn. (Defect.)",
    tip: "Taking chip damage becomes a full extra orb rotation. Tanky orb decks convert pain directly into output.",
    synergy: ["Defect", "Orb passives", "Bruiser orbs"],
  },
  gamblingchip: {
    rarity: "rare",
    effect: "At the start of each combat, discard any number of cards then draw that many.",
    tip: "A full mulligan every fight. Combo decks essentially choose their opening hand.",
    synergy: ["Combo openers", "Consistency"],
  },
  girya: {
    rarity: "rare",
    effect: "You can now gain Strength at Rest Sites. (3 times max.)",
    tip: "Three campfires become +3 permanent Strength. Multi-hit decks convert it into the biggest damage relic in the game.",
    synergy: ["Multi-hit", "Rest-site economy"],
  },
  helicaldart: {
    rarity: "rare",
    effect: "Whenever you play a Shiv, gain 1 Dexterity this turn. (Silent.)",
    tip: "Shiv flurries now also build a same-turn wall. Blade-dance turns block like a fortress.",
    synergy: ["Silent", "Shiv decks"],
  },
  icecream: {
    rarity: "rare",
    effect: "Energy is now conserved between turns.",
    tip: "Setup-deck enabler — bank slow turns into a massive nuke later. Changes how you sequence everything.",
    synergy: ["Setup decks", "Combo finishers"],
  },
  lizardtail: {
    rarity: "rare",
    effect: "When you would die, heal to 50% of your Max HP instead. (Works once.)",
    tip: "One free death. Aggressive lines you'd never risk become correct — spend it, don't hoard it.",
    synergy: ["Glass-cannon plans", "Greedy pathing"],
  },
  mango: {
    rarity: "rare",
    effect: "Upon pickup, raise your Max HP by 14.",
    tip: "The big brother of Strawberry. Permanent, universal, always fine.",
    synergy: ["Any deck"],
  },
  meatonthebone: {
    rarity: "rare",
    effect: "If your HP is at or below 50% at the end of combat, heal 12 HP.",
    tip: "Bruiser decks that ride low HP get a steady drip back. Pairs naturally with Red Skull-style thresholds.",
    synergy: ["Bruiser plans", "Red Skull"],
  },
  metronome: {
    rarity: "rare",
    effect: "The first time you Channel 7 Orbs each combat, deal 30 damage to ALL enemies. (Defect.)",
    tip: "Channel-spam decks get a scheduled AoE nuke per fight. It usually lands exactly when hallway fights need closing.",
    synergy: ["Defect", "Channel spam"],
  },
  miniregent: {
    rarity: "rare",
    effect: "The first time you spend Stars each turn, gain 1 Strength. (Regent.)",
    tip: "Star decks now scale Strength for free every turn. Long fights snowball hard.",
    synergy: ["Regent", "Star spenders", "Long fights"],
  },
  oldcoin: {
    rarity: "rare",
    effect: "Upon pickup, gain 300 Gold.",
    tip: "An immediate shop windfall. Best found the floor before a shop; plan your route accordingly.",
    synergy: ["Shop routes"],
  },
  pocketwatch: {
    rarity: "rare",
    effect: "Whenever you play 3 or fewer cards during your turn, draw 3 additional cards at the start of your next turn.",
    tip: "Big-card decks trigger it constantly — every haymaker turn refunds itself with a loaded follow-up hand.",
    synergy: ["Few-big-plays decks", "Setup turns"],
  },
  powercell: {
    rarity: "rare",
    effect: "At the start of each combat, add 2 zero-cost cards from your Draw Pile into your Hand. (Defect.)",
    tip: "Claw-style zero-cost packages get their engine pieces in hand on turn 1, every fight.",
    synergy: ["Defect", "Zero-cost package"],
  },
  prayerwheel: {
    rarity: "rare",
    effect: "Normal enemies drop an additional card reward.",
    tip: "Doubles your drafting selection all run. The consistency gain is bigger than it looks — you see the cards your deck actually needs.",
    synergy: ["Draft consistency", "Early pickup"],
  },
  ruinedhelmet: {
    rarity: "rare",
    effect: "The first time you gain Strength each combat, double the amount gained. (Ironclad.)",
    tip: "Lead with your biggest Strength card — a doubled Demon Form is a win condition by itself.",
    synergy: ["Ironclad", "Strength scaling", "Sequencing"],
  },
  shovel: {
    rarity: "rare",
    effect: "You can now dig at Rest Sites to obtain a random Relic.",
    tip: "Converts spare campfires into relic slots. Strong when your deck is already set and HP is stable.",
    synergy: ["Rest-site economy", "Relic stacking"],
  },
  stonecalendar: {
    rarity: "rare",
    effect: "At the end of turn 7, deal 52 damage to ALL enemies.",
    tip: "Stall decks get a guaranteed nuke in long fights. Worthless in fast hallways — know which deck you are.",
    synergy: ["Stall plans", "Boss fights"],
  },
  sturdyclamp: {
    rarity: "rare",
    effect: "Up to 10 Block persists across turns.",
    tip: "Overblocking stops being waste. Block engines bank their surplus into the next enemy spike.",
    synergy: ["Block decks", "Barricade-style plans"],
  },
  thecourier: {
    rarity: "rare",
    effect: "The merchant no longer runs out of cards, relics, or potions and his prices are reduced by 20%.",
    tip: "Shops become renewable. With decent gold income you can genuinely buy a win condition.",
    synergy: ["Shop routes", "Gold engines"],
  },
  tungstenrod: {
    rarity: "rare",
    effect: "Whenever you would lose HP, lose 1 less.",
    tip: "Silently deletes all chip damage — multi-hit enemies and self-damage costs shrink dramatically. Sleeper top-tier defensive relic.",
    synergy: ["Anti-multi-hit", "Self-damage decks"],
  },
  unceasingtop: {
    rarity: "rare",
    effect: "Whenever you have no cards in Hand during your turn, draw a card.",
    tip: "Dump your whole hand, keep drawing. Zero-cost and discard decks turn it into 10+ extra cards a turn.",
    synergy: ["Zero-cost spam", "Discard engines"],
  },
  unsettlinglamp: {
    rarity: "rare",
    effect: "Each combat, the first time you play a card that Debuffs an enemy, double its effect.",
    tip: "Open with your biggest debuff — a doubled opening Catalyst or heavy Weak application swings whole fights.",
    synergy: ["Debuff decks", "Sequencing"],
  },
  vexingpuzzlebox: {
    rarity: "rare",
    effect: "At the start of each combat, add a random card into your Hand. It costs 0.",
    tip: "A free wildcard every opening hand. Low variance in practice — a random 0-cost play is nearly always value.",
    synergy: ["Tempo openers"],
  },
  whitestar: {
    rarity: "rare",
    effect: "Elites drop an additional Rare card reward.",
    tip: "Elite hunting now pays out rares specifically. Take it early and route through every elite you can survive.",
    synergy: ["Elite hunting", "Rare fishing"],
  },

  // ---- Ancients ------------------------------------------------------------
  // STS2's boss-tier relics. The Neow / Tezcatara / Nonupeipe / Pael /
  // Tanx / Vakuu / Orobos families all live here.
  blackstar: {
    rarity: "ancient",
    effect: "Elites drop an additional Relic when defeated.",
    tip: "Trades immediate power for compounding scaling. Best when you've already proven you can clear elites safely.",
    synergy: ["Elite hunters", "Long-game scaling"],
  },
  ectoplasm: {
    rarity: "ancient",
    effect: "You can no longer gain Gold. Gain 1 Energy at the start of each turn.",
    tip: "Energy-positive game-changer. The no-gold downside hurts shop-reliant builds; perfect for decks that are already assembled.",
    synergy: ["Energy-hungry decks", "Late-act pivot"],
  },
  philosophersstone: {
    rarity: "ancient",
    effect: "Gain 1 Energy at the start of each turn. ALL enemies start combat with 1 Strength.",
    tip: "Energy-positive but every enemy hits harder. Pair with block-heavy or Weak-applying plans to neutralize the downside.",
    synergy: ["Block decks", "Weak spam"],
  },
  runicpyramid: {
    rarity: "ancient",
    effect: "At the end of your turn, you no longer discard your Hand.",
    tip: "Holds setup cards until the perfect moment and pivots a deck's whole identity. One of the strongest relics in the game.",
    synergy: ["Setup decks", "Combo assembly"],
  },
  sneckoeye: {
    rarity: "ancient",
    effect: "At the start of your turn, draw 2 additional cards. Start each combat Confused.",
    tip: "Draw 7 with randomized costs. The math favors it hard in decks full of 2-3 cost cards — expensive cards average cheaper under Confusion.",
    synergy: ["Expensive cards", "Draw scaling"],
  },
  pumpkincandle: {
    // v0.105.0 rework (now on main): previously extinguished at the start
    // of Act 3 outright; now runs on a 5-combat fuse you can re-light.
    rarity: "ancient",
    effect: "Gain 1 Energy at the start of each turn. Extinguishes after 5 combats. Can be Kindled at Rest Sites.",
    tip: "Sustained extra energy if you're willing to pay campfires to keep it lit. Trade rest-site healing for tempo on tight ascensions.",
    synergy: ["Energy decks", "Rest-site economy"],
  },
  toybox: {
    rarity: "ancient",
    effect: "Upon pickup, obtain 4 Wax Relics. Every 3 combats, your left-most Wax Relic will melt away.",
    tip: "Four relics on a melting timer — the value is front-loaded, so take it when the next few fights matter most.",
    synergy: ["Tempo spikes", "Elite pushes"],
  },
  meatcleaver: {
    rarity: "ancient",
    effect: "You may Cook at Rest Sites.",
    tip: "Adds a permanent-value option to every campfire. The Cook menu converts HP-to-spare into lasting stats.",
    synergy: ["Rest-site economy"],
  },
  fiddle: {
    rarity: "ancient",
    effect: "At the start of each turn, draw 2 additional cards. You may not draw cards during your turn.",
    tip: "A bigger hand every turn in exchange for your draw cards going dead. Cut draw effects before taking it.",
    synergy: ["Big-hand decks", "No-draw builds"],
  },
  diamonddiadem: {
    rarity: "ancient",
    effect: "Whenever you play 2 or fewer cards in a turn, take half damage from enemies.",
    tip: "Few-big-plays decks get permanent 50% damage reduction. Pocketwatch-style plans wear it perfectly.",
    synergy: ["Few-big-plays decks", "Stall plans"],
  },
  sealofgold: {
    rarity: "ancient",
    effect: "At the start of your turn, spend 5 Gold to gain 1 Energy.",
    tip: "Converts your gold reserve directly into tempo. Gold engines make it effectively free extra energy all run.",
    synergy: ["Gold engines", "Energy decks"],
  },
  toastymittens: {
    rarity: "ancient",
    effect: "At the start of your turn, Exhaust the top card of your Draw Pile and gain 1 Strength.",
    tip: "Permanent Strength every turn at the cost of burning your deck down. Thin decks feel the exhaust; tall decks barely notice.",
    synergy: ["Tall decks", "Strength scaling"],
  },
  furcoat: {
    rarity: "ancient",
    effect: "Upon pickup, mark 7 random combats. Enemies in those rooms have 1 HP.",
    tip: "Seven fights simply stop existing. Pure route acceleration — the earlier you grab it, the more marked rooms you'll actually visit.",
    synergy: ["Fast routing", "Early pickup"],
  },
  signetring: {
    rarity: "ancient",
    effect: "Upon pickup, gain 999 Gold.",
    tip: "A full shopping spree in one relic. Route through every shop you can reach before the gold burns a hole in your pocket.",
    synergy: ["Shop routes", "The Courier"],
  },
  beautifulbracelet: {
    rarity: "ancient",
    effect: "Upon pickup, choose 3 cards in your Deck. Enchant them with Swift 3.",
    tip: "Hand-pick your three engine pieces and make them fly. Enchant the cards you want in your opening hand every fight.",
    synergy: ["Combo consistency", "Engine pieces"],
  },
  sandcastle: {
    rarity: "ancient",
    effect: "Upon pickup, Upgrade 6 random cards.",
    tip: "Six instant upgrades. Best mid-run when your deck is mostly keepers — early it wastes hits on cards you'll cut.",
    synergy: ["Mid-run power spike"],
  },
  distinguishedcape: {
    rarity: "ancient",
    effect: "Upon pickup, lose 9 Max HP. Add 3 Apparitions to your Deck.",
    tip: "Apparitions cap incoming hits at 1 — three of them can trivialize boss spike turns. The Max HP tax stings on already-low runs.",
    synergy: ["Anti-burst", "Boss insurance"],
  },
  boomingconch: {
    // v0.107.1 buff applied to the wiki-era text: the June main-branch
    // patch added the Energy grant on top of the existing Elite draw.
    rarity: "ancient",
    effect: "At the start of Elite combats, draw 2 additional cards and gain 1 Energy.",
    tip: "Elites open with you a full tempo step ahead. Take it when your route hunts elites.",
    synergy: ["Elite hunting"],
  },
  scrollboxes: {
    // v0.107.1 removed the "lose all Gold" clause from the wiki-era text
    // (the downside migrated to Silken Tress — see that entry).
    rarity: "ancient",
    effect: "Upon pickup, choose 1 of 2 packs of cards to add to your Deck.",
    tip: "A themed card package in one pick. Judge the pack against your deck's plan, not card-by-card.",
    synergy: ["Deck pivots", "Draft flexibility"],
  },
  nutritioussoup: {
    // v0.107.1 also made Strikes deal +3 damage as part of this Ember
    // enchant — the tooltip carries the detail in-game.
    rarity: "ancient",
    effect: "Upon pickup, Enchant all Strikes in your Deck with Tezcatara's Ember.",
    tip: "Your starter Strikes stop being dead weight — the Ember enchant (+3 damage as of v0.107.1) makes keeping them genuinely fine.",
    synergy: ["Strike builds", "Early acts"],
  },
  paelseye: {
    rarity: "ancient",
    effect: "The first time each combat you end your turn without playing cards, Exhaust your Hand, and take an extra turn.",
    tip: "A scripted free turn once per fight — skip a turn you'd waste anyway and bank a full extra one. Sequencing puzzle, huge payoff.",
    synergy: ["Setup decks", "Sequencing"],
  },

  // ---- Shop ------------------------------------------------------------
  bread: {
    rarity: "shop",
    effect: "At the start of your first turn, lose 2 Energy. At the start of all other turns, gain 1 Energy.",
    tip: "A weak turn 1 buys a stronger every-turn-after. The longer your average fight, the better the trade.",
    synergy: ["Long fights", "Stall plans"],
  },
  brimstone: {
    rarity: "shop",
    effect: "At the start of your turn, gain 2 Strength and ALL enemies gain 1 Strength. (Ironclad.)",
    tip: "You out-scale them 2:1 — end fights fast before the enemy side of the ledger stacks up.",
    synergy: ["Ironclad", "Aggro", "Fast kills"],
  },
  chemicalx: {
    rarity: "shop",
    effect: "The effects of your cost X cards are increased by 2.",
    tip: "Every X-cost play acts two energy bigger. A dedicated X-card deck treats this as its win condition.",
    synergy: ["X-cost package"],
  },
  dollysmirror: {
    rarity: "shop",
    effect: "Upon pickup, obtain an additional copy of a card in your Deck.",
    tip: "Duplicate your single best card. The correct pick is nearly always your engine piece, not your biggest number.",
    synergy: ["Combo consistency"],
  },
  dragonfruit: {
    rarity: "shop",
    effect: "Whenever you gain Gold, raise your Max HP by 1.",
    tip: "Gold income becomes permanent HP. With strong gold engines it quietly adds 30+ Max HP over a run.",
    synergy: ["Gold engines", "Long-game scaling"],
  },
  ghostseed: {
    rarity: "shop",
    effect: "Strikes and Defends gain Ethereal.",
    tip: "Your starters delete themselves as you play — automatic deck-thinning without spending removes.",
    synergy: ["Deck thinning", "Exhaust payoffs"],
  },
  kifuda: {
    rarity: "shop",
    effect: "Upon pickup, Enchant up to 3 cards with Adroit.",
    tip: "Pick your three most-replayed cards and make them cheaper to work with. Engine pieces first, always.",
    synergy: ["Engine pieces", "Combo consistency"],
  },
  lavalamp: {
    rarity: "shop",
    effect: "At the end of combat, Upgrade all card rewards if you took no damage.",
    tip: "Rewards clean play with upgraded drafts. Strong defensive decks effectively draft from a better pool all run.",
    synergy: ["Block decks", "Perfect-clear plans"],
  },
  leeswaffle: {
    rarity: "shop",
    effect: "Upon pickup, raise your Max HP by 7 and heal all of your HP.",
    tip: "A full heal plus a permanent buffer. Best bought when you're hurt — it's a rest site and a Strawberry in one purchase.",
    synergy: ["Emergency recovery"],
  },
  membershipcard: {
    rarity: "shop",
    effect: "50% discount on all products!",
    tip: "Every future shop is half price. The earlier you find it, the more it compounds — with good gold income it's game-warping.",
    synergy: ["Shop routes", "Gold engines"],
  },
  miniaturetent: {
    rarity: "shop",
    effect: "You may choose any number of options at Rest Sites.",
    tip: "Rest AND upgrade AND dig at every campfire. Turns each rest site into two or three floors' worth of value.",
    synergy: ["Rest-site economy", "Girya / Shovel"],
  },
  orrery: {
    rarity: "shop",
    effect: "Upon pickup, gain 5 card rewards.",
    tip: "Five drafts on the spot. Best mid-act when you know exactly what the deck is missing.",
    synergy: ["Deck assembly", "Draft consistency"],
  },
  ringingtriangle: {
    rarity: "shop",
    effect: "Retain your Hand on the first turn of combat.",
    tip: "Turn 1 becomes a planning turn — bank your opener into turn 2 with full information. Setup decks love it.",
    synergy: ["Setup decks", "Sequencing"],
  },
  runiccapacitor: {
    rarity: "shop",
    effect: "Start each combat with 3 additional Orb Slots. (Defect.)",
    tip: "Orb decks skip their slot-building phase entirely. More slots means more passives ticking every turn from turn 1.",
    synergy: ["Defect", "Orb passives", "Focus"],
  },
  screamingflagon: {
    rarity: "shop",
    effect: "If you end your turn with no cards in your Hand, deal 20 damage to ALL enemies.",
    tip: "Dump-your-hand decks get a free AoE nuke every turn they empty out. Zero-cost spam turns it into a win condition.",
    synergy: ["Zero-cost spam", "Discard engines"],
  },
  slingofcourage: {
    rarity: "shop",
    effect: "Start each Elite combat with 2 Strength.",
    tip: "Elite-specific damage boost. Buy it when your route ahead is elite-dense.",
    synergy: ["Elite hunting"],
  },
  theabacus: {
    rarity: "shop",
    effect: "Whenever you shuffle your Draw Pile, gain 6 Block.",
    tip: "Thin, fast-cycling decks shuffle constantly — each cycle is free armor.",
    synergy: ["Thin decks", "Fast cycling"],
  },
  vitruvianminion: {
    rarity: "shop",
    effect: "Cards containing \u201CMinion\u201D deal double damage and gain double Block. (Regent.)",
    tip: "The Minion package doubles across the board. If you're drafting minions, this is the payoff relic.",
    synergy: ["Regent", "Minion package"],
  },
  undyingsigil: {
    rarity: "shop",
    effect: "Enemies with at least as much Doom as HP deal 50% less damage. (Necrobinder.)",
    tip: "Doom decks halve incoming damage from anything they've already condemned. Defense and offense from the same stack.",
    synergy: ["Necrobinder", "Doom stacking"],
  },
  wingcharm: {
    rarity: "shop",
    effect: "A random card in each card reward is Enchanted with Swift 1.",
    tip: "Every future draft has a sweetened option. Early purchase compounds across the whole run.",
    synergy: ["Draft value", "Early pickup"],
  },

  // ---- Event ------------------------------------------------------------
  swordofjade: {
    rarity: "event",
    effect: "Start each combat with 3 Strength.",
    tip: "Flat +3 Strength every fight, no strings. Multi-hit decks convert it into the best damage-per-relic in the event pool.",
    synergy: ["Multi-hit", "Aggro"],
  },
  dreamcatcher: {
    rarity: "event",
    effect: "Whenever you Rest, you may add a card to your Deck.",
    tip: "Free card every campfire. Stacks runaway value for an already-strong deck; on weak decks the extra card can be a liability.",
    synergy: ["Strong-deck pivot", "Rest-strat"],
  },
  bigmushroom: {
    rarity: "event",
    effect: "Upon pickup, raise your Max HP by 20. At the start of each combat, draw 2 fewer cards.",
    tip: "A huge HP buffer priced in tempo. Decks with start-of-combat draw (Bag of Preparation, Snake rings) cancel the downside.",
    synergy: ["Draw compensation", "Tanky plans"],
  },
  bingbong: {
    rarity: "event",
    effect: "Whenever you add a card to your Deck, add one additional copy.",
    tip: "Every draft is a playset. Terrifying with engine pieces, poisonous with situational picks — draft with double conviction.",
    synergy: ["Engine duplication", "Committed archetypes"],
  },
  bonetea: {
    rarity: "event",
    effect: "At the start of the next combat, Upgrade your starting hand.",
    tip: "One fight with a fully upgraded opener. Save the buff for the elite or boss door if you can path it.",
    synergy: ["Elite prep", "One-fight spike"],
  },
  darkstoneperiapt: {
    rarity: "event",
    effect: "Whenever you obtain a Curse, raise your Max HP by 6.",
    tip: "Curse-positive events become HP printers. Curse-synergy decks turn their downside economy into a stat stick.",
    synergy: ["Curse decks", "Event routing"],
  },
  embertea: {
    rarity: "event",
    effect: "At the start of the next 5 combats, gain 2 Strength.",
    tip: "Five juiced fights. Route into elites while it's hot.",
    synergy: ["Elite pushes", "Tempo windows"],
  },
  forgottensoul: {
    rarity: "event",
    effect: "Whenever you Exhaust a card, deal 1 damage to a random enemy.",
    tip: "Exhaust engines pick up free chip damage. Small per trigger, but dedicated engines trigger it a dozen times a fight.",
    synergy: ["Exhaust engines", "Status dumps"],
  },
  fragrantmushroom: {
    rarity: "event",
    effect: "Upon pickup, lose 15 HP and Upgrade 3 random cards.",
    tip: "HP for upgrades — the classic greed trade. Best taken healthy, right before a rest site.",
    synergy: ["Upgrade value", "Healthy pickup"],
  },
  fresnellens: {
    rarity: "event",
    effect: "Whenever you add a card that gains Block to your Deck, Enchant it with Nimble 2.",
    tip: "Every block card you draft comes pre-enchanted. Defensive decks compound this into serious extra armor.",
    synergy: ["Block decks", "Draft value"],
  },
  handdrill: {
    rarity: "event",
    effect: "Whenever you break an enemy's Block, apply 2 Vulnerable.",
    tip: "Block-breakers now open a damage window automatically. Big single hits love following a shield break.",
    synergy: ["Big hits", "Anti-block matchups"],
  },
  kaleidoscope: {
    rarity: "event",
    effect: "Upon pickup, gain 2 card rewards with cards from other characters.",
    tip: "Free off-class flex picks. Adds depth early when your own pool is still skeletal — strongest on classes whose Act 1 commons are weakest.",
    synergy: ["Off-class flex", "Deck-building"],
  },
  fishingrod: {
    rarity: "event",
    effect: "Every 3 normal combats, Upgrade a random card in your Deck.",
    tip: "Passive deck-wide upgrades on a generous trigger. Best in tall decks where any upgrade is value.",
    synergy: ["Tall decks", "Long-game scaling"],
  },
  // v0.107.1 moved the "lose all gold" downside here from Neow's Scroll
  // Boxes — if you're diffing against the May beta text, this is the change.
  silkentress: {
    rarity: "event",
    effect: "Enchant all cards in the first card reward with Glam. Upon pickup, lose all gold.",
    tip: "Front-loads a whole reward with Regent's Glam enchantment, but empties your wallet — take it early when you have little gold to lose. In co-op it only affects the player who chose it (clarified in the v0.108.0 beta notes).",
    synergy: ["Regent", "Glam decks", "Early pickup"],
  },
  mawbank: {
    rarity: "event",
    effect: "Whenever you climb a floor, gain 12 Gold. No longer works when you spend any Gold at the shop.",
    tip: "A steady income stream that dies the moment you shop. Decide upfront: bank the whole act, then spend big once.",
    synergy: ["Gold engines", "Delayed shopping"],
  },
  mrstruggles: {
    rarity: "event",
    effect: "At the start of your turn, deal damage equal to the turn number to ALL enemies.",
    tip: "Escalating free AoE. Slow, tanky decks ride it to inevitable wins in long fights.",
    synergy: ["Stall plans", "Long fights"],
  },
  royalpoison: {
    rarity: "event",
    effect: "At the start of each combat, lose 4 HP.",
    tip: "A pure downside relic from a devil's bargain — the event's other half is what you paid for. Budget the HP drain into your rest planning.",
    synergy: ["Event trade-offs"],
  },
  swordofstone: {
    rarity: "event",
    effect: "Transforms into a powerful Relic after defeating 5 Elites.",
    tip: "An elite-hunting quest with a payoff at the end. Only take it on routes that can actually feed it five elites.",
    synergy: ["Elite hunting", "Long-game scaling"],
  },
  teaofdiscourtesy: {
    rarity: "event",
    effect: "At the start of the next combat, shuffle 2 Dazed into your Draw Pile.",
    tip: "A small tax on your next fight from an event trade. Exhaust engines shrug it off entirely.",
    synergy: ["Event trade-offs", "Exhaust engines"],
  },
  theboot: {
    // v0.107.1: the minimum-damage floor now applies to Osty's attacks
    // too, which quietly buffs Necrobinder pet builds.
    rarity: "event",
    effect: "Whenever you would deal 4 or less unblocked attack damage, increase it to 5.",
    tip: "Every small hit rounds up — Shivs, multi-hits, and (as of v0.107.1) Osty's attacks all sneak extra damage through.",
    synergy: ["Shiv decks", "Multi-hit", "Necrobinder pets"],
  },
  thechosencheese: {
    rarity: "event",
    effect: "At the end of combat, gain 1 Max HP.",
    tip: "Permanent growth on every fight. The earlier you find it, the bigger your endgame HP pool — route through fights, not around them.",
    synergy: ["Fight-heavy routing", "Long-game scaling"],
  },
  wongosmysteryticket: {
    rarity: "event",
    effect: "Receive 3 random Relics after 5 combats.",
    tip: "A five-fight investment for a three-relic payout. Nearly always worth it unless the run ends first.",
    synergy: ["Long-game scaling"],
  },

  // ---- Neow (beta v0.109.0 additions) ---------------------------------------
  // These exist ONLY on the beta branch as of this writing. Main-branch
  // players will never roll them; beta players' runs can already contain
  // the slugs. Effect strings are Mega Crit's own copy from the patch
  // notes, quoted verbatim.
  dowsingrod: {
    rarity: "event",
    effect: "Upon pickup, add 1 Dowsing to your Deck. (Dowsing: Quest, 0 cost — after entering 5 more ? rooms, transform this into Abundance.)",
    tip: "A quest relic that pays off in ? rooms — Abundance offers a choice of 3 upgraded Powers. Take it when your route is event-heavy. Beta branch only (v0.109.0) for now.",
    synergy: ["Event-heavy routes", "Power decks", "Neow pool"],
  },
  neowssacrifice: {
    rarity: "event",
    effect: "Upon pickup, procure 1 Ambergris and add 1 Guilty to your Deck. (Ambergris: heal for 50% of your max HP. Take an extra turn after this one.)",
    tip: "Banked emergency button — Ambergris is a half-heal plus a free extra turn, which can steal a boss fight. The Guilty curse is the tax. Beta branch only (v0.109.0) for now.",
    synergy: ["Curse mitigation", "Boss insurance", "Neow pool"],
  },
};

// -------------------------------------------------------------------------
// KNOWN GAPS — v0.107.1 changed relics we can't fully verify.
//
// Sere Talon and Jeweled Mask have no sourced main-branch description
// (the wiki module is blank for them), and Pendulum's wiki text literally
// says "Reworked. See in-game text." Per the ONE RULE above they ship no
// entry and fall back to personal stats. If you have STS2 open, a
// screenshot + one-line GitHub issue is all it takes to close these out.
// Same for the ~60 other blank-description relics — coverage here is
// every relic with sourced text, not every relic that exists.
// -------------------------------------------------------------------------

// -------------------------------------------------------------------------
// BETA-BRANCH WATCHLIST — the NET state of relic changes as of beta
// v0.111.0 (Aug 14, 2026), folding together v0.108.0 → v0.111.0. Several
// v0.109.0 redesigns were partially reverted by v0.110.0, so earlier
// per-patch notes are superseded by this list. None of these are on the
// main branch; apply them to the entries above only when the next Major
// Update lands. Full netted timeline: docs/game-data-sync.md.
//
//   - Diamond Diadem (diamonddiadem) REWORKED — "Start combat with 20
//     Block. Block is not removed at the start of your next turn."
//     (replaces the play-2-or-fewer / half-damage design)
//   - Beautiful Bracelet (beautifulbracelet) REWORKED — enchants 4
//     RANDOM cards (no longer chosen) with Swift 2 (was choose-3, Swift 3)
//   - Seal of Gold (sealofgold) — gold cost per Energy 5 -> 3
//   - Toasty Mittens (toastymittens) — now Exhausts a card from your
//     HAND instead of the top of the Draw Pile
//   - Fur Coat (furcoat) — marked combats 7 -> 8
//   - Signet Ring (signetring) — gold 999 -> 888
//   - Brightest Flame (brightestflame) — max HP loss on activation 1 -> 2
//   - Toy Box (toybox) — relics gained 4 -> 5
//   - Meat Cleaver (meatcleaver) — Cook healing 9 -> 5
//   - Fiddle (fiddle) — draw briefly 3 in v0.109, REVERTED to 2 in
//     v0.110 (i.e. main text above is already correct for beta too)
//   - History Course (historycourse) — now only repeats Attacks
//   - Sere Talon (seretalon) / Distinguished Cape (distinguishedcape)
//     — downsides swapped between the two
//   - Orobos' Sand Castle (sandcastle) — moved Pool 1 -> Pool 2
//   - Jeweled Mask (jeweledmask) — now selects a non-Innate power
//     unless all powers are Innate (v0.111.0)
//   - Divine Destiny (divinedestiny, Regent starter) — Star gain 6 -> 7
//   - Regalite (regalite, Regent) — reworked to once-per-turn in
//     v0.110, block 6 -> 4 in v0.111 (net: first created card each
//     turn grants 4 Block)
//   - NEW Neow relics: Dowsing Rod, Neow's Sacrifice (entries above,
//     marked beta)
// -------------------------------------------------------------------------

/** Relic rarity color → matches in-game tiers. STS2 has no "boss"
 *  rarity — "ancient" is the equivalent tier — but the key stays for
 *  safety against stale cached data. */
export const RARITY_COLORS = {
  starter:  "#888a99",
  common:   "#9aa3b1",
  uncommon: "#5fa7d8",
  rare:     "#d4af37",
  ancient:  "#6fd8c8",
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
