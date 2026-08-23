import Foundation

// =========================================================================
// STS2CardGlossary
// -------------------------------------------------------------------------
// Hand-curated knowledge base for Slay the Spire 2 cards and relics,
// injected into the AI overlay's system prompt. Solves a real problem:
// the model leans on its general STS knowledge, but STS2 reworked or
// replaced most of the catalog. When a model "knows" a card from STS1
// that does not exist in STS2 — or quotes STS1 numbers for one that
// does — that is a hallucination that costs the player a run.
//
// Strategy: keep a broad, SOURCED table; look up only the cards/relics
// actually present in the player's live deck; inject those entries and
// ONLY those into the prompt. Table size does not affect prompt size —
// a deck references perhaps 25 unique cards — so coverage is limited by
// what we can source, not by token budget.
//
// SOURCE OF TRUTH & BRANCH POLICY
// Every effect string describes the MAIN branch (v0.107.1 "Major
// Update 2", June 2026), which is what most players run. The baseline
// text comes from the wiki-derived STS2 database in the local
// SlayTheSpire2Companion checkout ("zero STS1 content"), with the
// v0.105 -> v0.107.1 patch-note deltas applied on top where Mega Crit
// published complete new text (Drum of Battle, Sword Sage, Offering,
// Infused Core, Pumpkin Candle). Cards whose current text we cannot
// reconstruct — wiki says "Reworked. See in-game text", or the wiki
// snapshot conflicts with later patch-note baselines (Hyperbeam,
// Alignment, Guiding Star, Spoils of Battle, Refine Blade, The Scythe,
// Expect a Fight, Dominate, Anticipate) — get NO entry. A wrong entry
// is worse than no entry: the model falls back to hedged general
// knowledge instead of confidently quoting a stale number.
//
// An earlier revision carried STS1 cards that do not exist in STS2 at
// all (Streamline, Catalyst, Metallicize, Flex, Warcry, Clothesline,
// Heavy Blade, Limit Break, Exhume, Quick Slash, Sneaky Strike, Die
// Die Die, Rebound, Stack) plus STS1 relic text (Blood Vial healed at
// the WRONG TRIGGER, Book of Five Rings had a fabricated orb effect,
// Snecko Eye/Girya/Shovel carried STS1 mechanics). All verified against
// the STS2 database and removed or corrected in this revision. STS2
// also has no "boss" relic tier — "ancient" is the equivalent.
//
// BETA WATCHLIST (net state at beta v0.111.0, Aug 14 2026 — folds
// v0.108.0 -> v0.111.0; several v0.109 redesigns were re-reverted in
// v0.110, so per-patch notes are superseded by this list). NONE of
// these are on main; do not merge them into effect strings until the
// next Major Update. Full netted table: docs/game-data-sync.md.
//   Silent:  Scare RENAMED Sidestep (energy next turn, no Weak) ·
//            Outbreak now Rare Skill (poison ALL, triggers immediately) ·
//            Haze cost 2, +Weak · Mirage exhausts (upgrade removes) ·
//            Well-Laid Plans cost 2(1), Rare, no hand discard ·
//            Expertise draws 2(3) w/ Retain · Echoing Slash + Accelerant
//            -> Uncommon · Tracking +50% (was double) · Flick-Flack 7(9)
//   Ironclad: Demon Form 3(4) Str · Mangle 20(26) · Pact's End 18(24) ·
//            Rampage base 10, +5(10) · Setup Strike 3(4) · Howl From
//            Beyond 18(24) · Colossus 4(7) · Crimson Mantle 7(10) ·
//            Taunt Common 6(7) · Cruelty -> Uncommon · Bloodletting ->
//            Uncommon · Juggling copies the original attack (bugfix)
//   Defect:  Thunder 8(11) · Null 1(2) Weak · Refract 10(13) ·
//            Synchronize focus 1(2), no self-Exhaust · Rocket Punch
//            reduces cost by 1 (not to 0) · Shatter gains Exhaust ·
//            Biased Cognition 5(6) · Trash to Treasure upgrade lowers
//            cost (not Innate)
//   Regent:  Terraforming 7(10) Vigor · Crush Under 8(9) · Pillar of
//            Creation 2(3) per created card · Devastate 35(45) ·
//            Resonance 2 stars · Kingly cards unchanged
//   Necro:   Sacrifice = TRIPLE Osty max HP · Eidolon plays Ethereal
//            cards from Exhaust pile (not hand-exhaust) · Shroud 3(4) ·
//            Time's Up loses Exhaust · Soulbound shuffles souls into
//            draw pile
//   New beta-only multiplayer cards (v0.108/0.109): IC Midnight/Blaze/
//   Outrage · Silent Blade Symphony/Concoct/Fade · Regent Plot/
//   Constellation/Tutor · Necro Underworld/Soulbound/Cacophony · Defect
//   Hibernate/One For All/Imitation Learning. No entries until they
//   reach main and full text is published.
//
// Future: when a live deck contains a card the glossary doesn't cover,
// unmatchedIdentifiers logs it locally so coverage can grow per build.
// =========================================================================

enum STS2CardGlossary {

    // MARK: - Card entries
    //
    // Keys are normalized: lowercased, no `+N` upgrade suffix, and the
    // save's `ic_`/`si_`/`de_`/`re_`/`nb_`/`cl_` prefixes dropped (the
    // stripped-key fuzzy lookup below also tolerates CamelCase / kebab /
    // spaced variants). Strike/Defend keep the per-character suffix
    // convention (`strike_red`, `defend_regent`, ...) used by
    // resolveStrikeDefend.
    //
    // Format: name | cost | type | effect. Cost "X" means unplayable or
    // variable; effects are the base (unupgraded) card text.

    static let cards: [String: Entry] = [
        // ---- Colorless / curses / statuses ----
        "ascender_s_bane": .init(name: "Ascender's Bane", cost: "X", type: "curse",
            effect: "Unplayable. Ethereal. Eternal."),
        "wound": .init(name: "Wound", cost: "X", type: "status",
            effect: "Unplayable."),
        "dazed": .init(name: "Dazed", cost: "X", type: "status",
            effect: "Unplayable. Ethereal."),
        "slimed": .init(name: "Slimed", cost: "1", type: "status",
            effect: "Draw 1 card. Exhaust."),
        "burn": .init(name: "Burn", cost: "X", type: "status",
            effect: "Unplayable. At the end of your turn, if this is in your Hand, take 2 damage."),
        "void": .init(name: "Void", cost: "X", type: "status",
            effect: "Unplayable. Ethereal. Whenever you draw this card, lose 1 Energy."),
        "regret": .init(name: "Regret", cost: "X", type: "curse",
            effect: "Unplayable. At the end of your turn, if this is in your Hand, lose 1 HP for each card in your Hand."),
        "shame": .init(name: "Shame", cost: "X", type: "curse",
            effect: "Unplayable. At the end of your turn, if this is in your Hand, gain 1 Frail."),
        "guilty": .init(name: "Guilty", cost: "X", type: "curse",
            effect: "Unplayable. Removed from your Deck after 5 combats."),
        "apparition": .init(name: "Apparition", cost: "1", type: "skill",
            effect: "Ethereal. Gain 1 Intangible. Exhaust."),

        // ---- Ironclad ----
        "strike_red": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_red": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "bash": .init(name: "Bash", cost: "2", type: "attack",
            effect: "Deal 8 damage. Apply 2 Vulnerable."),
        "anger": .init(name: "Anger", cost: "0", type: "attack",
            effect: "Deal 6 damage. Add a copy of this card into your Discard Pile."),
        "armaments": .init(name: "Armaments", cost: "1", type: "skill",
            effect: "Gain 5 Block. Upgrade a card in your Hand."),
        "blood_wall": .init(name: "Blood Wall", cost: "2", type: "skill",
            effect: "Lose 2 HP. Gain 16 Block."),
        "bloodletting": .init(name: "Bloodletting", cost: "0", type: "skill",
            effect: "Lose 3 HP. Gain 2 Energy."),
        "body_slam": .init(name: "Body Slam", cost: "1", type: "attack",
            effect: "Deal damage equal to your Block."),
        "breakthrough": .init(name: "Breakthrough", cost: "1", type: "attack",
            effect: "Lose 1 HP. Deal 9 damage to ALL enemies."),
        "cinder": .init(name: "Cinder", cost: "2", type: "attack",
            effect: "Deal 17 damage. Exhaust the top card of your Draw Pile."),
        "havoc": .init(name: "Havoc", cost: "1", type: "skill",
            effect: "Play the top card of your Draw Pile and Exhaust it."),
        "headbutt": .init(name: "Headbutt", cost: "1", type: "attack",
            effect: "Deal 9 damage. Put a card from your Discard Pile on top of your Draw Pile."),
        "iron_wave": .init(name: "Iron Wave", cost: "1", type: "attack",
            effect: "Gain 5 Block. Deal 5 damage."),
        "molten_fist": .init(name: "Molten Fist", cost: "1", type: "attack",
            effect: "Deal 10 damage. Double the enemy's Vulnerable. Exhaust."),
        "perfected_strike": .init(name: "Perfected Strike", cost: "2", type: "attack",
            effect: "Deal 6 damage. Deals 2 additional damage for ALL your cards containing \"Strike\"."),
        "pommel_strike": .init(name: "Pommel Strike", cost: "1", type: "attack",
            effect: "Deal 9 damage. Draw 1 card."),
        "setup_strike": .init(name: "Setup Strike", cost: "1", type: "attack",
            effect: "Deal 7 damage. Gain 2 Strength this turn."),
        "shrug_it_off": .init(name: "Shrug It Off", cost: "1", type: "skill",
            effect: "Gain 8 Block. Draw 1 card."),
        "sword_boomerang": .init(name: "Sword Boomerang", cost: "1", type: "attack",
            effect: "Deal 3 damage to a random enemy 3 times."),
        "thunderclap": .init(name: "Thunderclap", cost: "1", type: "attack",
            effect: "Deal 4 damage and apply 1 Vulnerable to ALL enemies."),
        "tremble": .init(name: "Tremble", cost: "1", type: "skill",
            effect: "Apply 2 Vulnerable."),
        "true_grit": .init(name: "True Grit", cost: "1", type: "skill",
            effect: "Gain 7 Block. Exhaust 1 card at random."),
        "twin_strike": .init(name: "Twin Strike", cost: "1", type: "attack",
            effect: "Deal 5 damage twice."),
        "ashen_strike": .init(name: "Ashen Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage. Deals 3 additional damage for each card in your Exhaust Pile."),
        "battle_trance": .init(name: "Battle Trance", cost: "0", type: "skill",
            effect: "Draw 3 cards. You cannot draw additional cards this turn."),
        "bludgeon": .init(name: "Bludgeon", cost: "3", type: "attack",
            effect: "Deal 32 damage."),
        "bully": .init(name: "Bully", cost: "0", type: "attack",
            effect: "Deal 4 damage. Deals 2 additional damage for each Vulnerable on the enemy."),
        "burning_pact": .init(name: "Burning Pact", cost: "1", type: "skill",
            effect: "Exhaust 1 card. Draw 2 cards."),
        "dismantle": .init(name: "Dismantle", cost: "1", type: "attack",
            effect: "Deal 8 damage. If the enemy is Vulnerable, hits twice."),
        "evil_eye": .init(name: "Evil Eye", cost: "1", type: "skill",
            effect: "Gain 8 Block. Gain another 8 Block if you have Exhausted a card this turn."),
        "feel_no_pain": .init(name: "Feel No Pain", cost: "1", type: "power",
            effect: "Whenever a card is Exhausted, gain 3 Block."),
        "fight_me": .init(name: "Fight Me!", cost: "2", type: "attack",
            effect: "Deal 5 damage twice. Gain 2 Strength. The enemy gains 1 Strength."),
        "flame_barrier": .init(name: "Flame Barrier", cost: "2", type: "skill",
            effect: "Gain 12 Block. Whenever you are attacked this turn, deal 4 damage back."),
        "hemokinesis": .init(name: "Hemokinesis", cost: "1", type: "attack",
            effect: "Lose 2 HP. Deal 14 damage."),
        "howl_from_beyond": .init(name: "Howl from Beyond", cost: "3", type: "attack",
            effect: "Deal 16 damage to ALL enemies. At the start of your turn, plays from the Exhaust Pile."),
        "infernal_blade": .init(name: "Infernal Blade", cost: "1", type: "skill",
            effect: "Add a random Attack into your Hand. It's free to play this turn. Exhaust."),
        "inflame": .init(name: "Inflame", cost: "1", type: "power",
            effect: "Gain 2 Strength."),
        "juggling": .init(name: "Juggling", cost: "1", type: "power",
            effect: "Add a copy of the third Attack you play each turn into your Hand."),
        "pillage": .init(name: "Pillage", cost: "1", type: "attack",
            effect: "Deal 6 damage. Draw cards until you draw a non-Attack card."),
        "rage": .init(name: "Rage", cost: "0", type: "skill",
            effect: "Whenever you play an Attack this turn, gain 3 Block."),
        "rampage": .init(name: "Rampage", cost: "1", type: "attack",
            effect: "Deal 9 damage. Increase this card's damage by 5 this combat."),
        "rupture": .init(name: "Rupture", cost: "1", type: "power",
            effect: "Whenever you lose HP on your turn, gain 1 Strength."),
        "second_wind": .init(name: "Second Wind", cost: "1", type: "skill",
            effect: "Exhaust all non-Attack cards in your Hand. Gain 5 Block for each card Exhausted."),
        "stampede": .init(name: "Stampede", cost: "2", type: "power",
            effect: "At the end of your turn, 1 random Attack in your Hand is played against a random enemy."),
        "stomp": .init(name: "Stomp", cost: "3", type: "attack",
            effect: "Deal 12 damage to ALL enemies. Costs 1 less for each Attack played this turn."),
        "stone_armor": .init(name: "Stone Armor", cost: "1", type: "power",
            effect: "Gain 4 Plating."),
        "taunt": .init(name: "Taunt", cost: "1", type: "skill",
            effect: "Gain 7 Block. Apply 1 Vulnerable."),
        "uppercut": .init(name: "Uppercut", cost: "2", type: "attack",
            effect: "Deal 13 damage. Apply 1 Weak. Apply 1 Vulnerable."),
        "vicious": .init(name: "Vicious", cost: "1", type: "power",
            effect: "Whenever you apply Vulnerable, draw 1 card."),
        "whirlwind": .init(name: "Whirlwind", cost: "1", type: "attack",
            effect: "Deal 5 damage to ALL enemies X times."),
        "barricade": .init(name: "Barricade", cost: "3", type: "power",
            effect: "Block is not removed at the start of your turn."),
        "brand": .init(name: "Brand", cost: "0", type: "skill",
            effect: "Lose 1 HP. Exhaust 1 card. Gain 1 Strength."),
        "cascade": .init(name: "Cascade", cost: "1", type: "skill",
            effect: "Play the top X cards of your Draw Pile."),
        "colossus": .init(name: "Colossus", cost: "1", type: "skill",
            effect: "Gain 5 Block. You receive 50% less damage from Vulnerable enemies this turn."),
        "conflagration": .init(name: "Conflagration", cost: "1", type: "attack",
            effect: "Deal 8 damage to ALL enemies. Deals 2 additional damage for each other Attack you've played this turn."),
        "crimson_mantle": .init(name: "Crimson Mantle", cost: "1", type: "power",
            effect: "At the start of your turn, lose 1 HP and gain 8 Block."),
        "cruelty": .init(name: "Cruelty", cost: "1", type: "power",
            effect: "Vulnerable enemies take an additional 25% damage."),
        "dark_embrace": .init(name: "Dark Embrace", cost: "2", type: "power",
            effect: "Whenever a card is Exhausted, draw 1 card."),
        "demon_form": .init(name: "Demon Form", cost: "3", type: "power",
            effect: "At the start of your turn, gain 2 Strength."),
        "feed": .init(name: "Feed", cost: "1", type: "attack",
            effect: "Deal 10 damage. If Fatal, raise your Max HP by 3. Exhaust."),
        "fiend_fire": .init(name: "Fiend Fire", cost: "2", type: "attack",
            effect: "Exhaust your Hand. Deal 7 damage for each card Exhausted. Exhaust."),
        "impervious": .init(name: "Impervious", cost: "2", type: "skill",
            effect: "Gain 30 Block. Exhaust."),
        "juggernaut": .init(name: "Juggernaut", cost: "2", type: "power",
            effect: "Whenever you gain Block, deal 5 damage to a random enemy."),
        "mangle": .init(name: "Mangle", cost: "3", type: "attack",
            effect: "Deal 15 damage. Enemy loses 10 Strength this turn."),
        "offering": .init(name: "Offering", cost: "0", type: "skill",
            effect: "Lose 6 HP. Gain 2 Energy. Draw 3 cards. Exhaust."),
        "one_two_punch": .init(name: "One-Two Punch", cost: "1", type: "skill",
            effect: "This turn, your next Attack is played an extra time."),
        "pact_s_end": .init(name: "Pact's End", cost: "0", type: "attack",
            effect: "Can only be played if you have 3 or more cards in your Exhaust Pile. Deal 17 damage to ALL enemies."),
        "tear_asunder": .init(name: "Tear Asunder", cost: "2", type: "attack",
            effect: "Deal 5 damage. Hits an additional time for each time you lost HP this combat."),
        "thrash": .init(name: "Thrash", cost: "1", type: "attack",
            effect: "Deal 4 damage twice. Exhaust a random Attack in your Hand and add its damage to this card."),
        "unmovable": .init(name: "Unmovable", cost: "2", type: "power",
            effect: "The first time you gain Block from a card each turn, double the amount gained."),
        "break": .init(name: "Break", cost: "2", type: "attack",
            effect: "Deal 20 damage. Apply 5 Vulnerable."),

        // ---- Silent ----
        "strike_green": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_green": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "neutralize": .init(name: "Neutralize", cost: "0", type: "attack",
            effect: "Deal 3 damage. Apply 1 Weak."),
        "survivor": .init(name: "Survivor", cost: "1", type: "skill",
            effect: "Gain 8 Block. Discard 1 card."),
        "backflip": .init(name: "Backflip", cost: "1", type: "skill",
            effect: "Gain 5 Block. Draw 2 cards."),
        "dagger_spray": .init(name: "Dagger Spray", cost: "1", type: "attack",
            effect: "Deal 4 damage to ALL enemies twice."),
        "dagger_throw": .init(name: "Dagger Throw", cost: "1", type: "attack",
            effect: "Deal 9 damage. Draw 1 card. Discard 1 card."),
        "deadly_poison": .init(name: "Deadly Poison", cost: "1", type: "skill",
            effect: "Apply 5 Poison."),
        "deflect": .init(name: "Deflect", cost: "0", type: "skill",
            effect: "Gain 4 Block."),
        "dodge_and_roll": .init(name: "Dodge and Roll", cost: "1", type: "skill",
            effect: "Gain 4 Block. Next turn, gain 4 Block."),
        "flick_flack": .init(name: "Flick-Flack", cost: "1", type: "attack",
            effect: "Sly. Deal 7 damage to ALL enemies."),
        "backstab": .init(name: "Backstab", cost: "0", type: "attack",
            effect: "Innate. Deal 11 damage. Exhaust."),
        "footwork": .init(name: "Footwork", cost: "1", type: "power",
            effect: "Gain 2 Dexterity."),
        "envenom": .init(name: "Envenom", cost: "2", type: "power",
            effect: "Whenever an Attack deals unblocked damage, apply 1 Poison."),
        "wraith_form": .init(name: "Wraith Form", cost: "3", type: "power",
            effect: "Gain 2 Intangible. At the start of your turn, lose 1 Dexterity."),
        "burst": .init(name: "Burst", cost: "1", type: "skill",
            effect: "This turn, your next Skill is played an extra time."),
        "corrosive_wave": .init(name: "Corrosive Wave", cost: "1", type: "skill",
            effect: "Whenever you draw a card this turn, apply 3 Poison to ALL enemies."),
        "echoing_slash": .init(name: "Echoing Slash", cost: "1", type: "attack",
            effect: "Deal 10 damage to ALL enemies. Repeat this effect for each enemy killed."),
        "grand_finale": .init(name: "Grand Finale", cost: "0", type: "attack",
            effect: "Can only be played if there are no cards in your Draw Pile. Deal 50 damage to ALL enemies."),
        "malaise": .init(name: "Malaise", cost: "1", type: "skill",
            effect: "Enemy loses X Strength. Apply X Weak. Exhaust."),
        "master_planner": .init(name: "Master Planner", cost: "2", type: "power",
            effect: "When you play a Skill, it gains Sly."),
        "nightmare": .init(name: "Nightmare", cost: "3", type: "skill",
            effect: "Choose a card. Next turn, add 3 copies of that card into your Hand. Exhaust."),
        "serpent_form": .init(name: "Serpent Form", cost: "3", type: "power",
            effect: "Whenever you play a card, deal 4 damage to a random enemy."),
        "shadow_step": .init(name: "Shadow Step", cost: "1", type: "skill",
            effect: "Discard your Hand. Next turn, Attacks deal double damage."),
        "shadowmeld": .init(name: "Shadowmeld", cost: "1", type: "skill",
            effect: "Double your Block gain this turn."),
        "storm_of_steel": .init(name: "Storm of Steel", cost: "1", type: "skill",
            effect: "Discard your Hand. Add 1 Shiv into your Hand for each card discarded."),
        "the_hunt": .init(name: "The Hunt", cost: "1", type: "attack",
            effect: "Deal 10 damage. If Fatal, gain an additional card reward. Exhaust."),
        "tools_of_the_trade": .init(name: "Tools of the Trade", cost: "1", type: "power",
            effect: "At the start of your turn, draw 1 card and discard 1 card."),
        "tracking": .init(name: "Tracking", cost: "2", type: "power",
            effect: "Weak enemies take double damage from Attacks."),
        "suppress": .init(name: "Suppress", cost: "0", type: "attack",
            effect: "Innate. Deal 11 damage. Apply 3 Weak."),
        "outbreak": .init(name: "Outbreak", cost: "1", type: "power",
            effect: "Every 3 times you apply Poison, deal 11 damage to ALL enemies."),
        "well_laid_plans": .init(name: "Well-Laid Plans", cost: "1", type: "power",
            effect: "At the end of your turn, Retain up to 1 card."),
        "expertise": .init(name: "Expertise", cost: "1", type: "skill",
            effect: "Draw cards until you have 6 in your Hand."),
        "mirage": .init(name: "Mirage", cost: "1", type: "skill",
            effect: "Gain Block equal to Poison on ALL enemies. Exhaust."),
        "haze": .init(name: "Haze", cost: "3", type: "skill",
            effect: "Sly. Apply 4 Poison to ALL enemies."),
        "accelerant": .init(name: "Accelerant", cost: "1", type: "power",
            effect: "Poison is triggered 1 additional time."),
        "poisoned_stab": .init(name: "Poisoned Stab", cost: "1", type: "attack",
            effect: "Deal 6 damage. Apply 3 Poison."),
        "slice": .init(name: "Slice", cost: "0", type: "attack",
            effect: "Deal 6 damage."),
        "leg_sweep": .init(name: "Leg Sweep", cost: "2", type: "skill",
            effect: "Apply 2 Weak. Gain 11 Block."),

        // ---- Defect ----
        "strike_blue": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_blue": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "zap": .init(name: "Zap", cost: "1", type: "skill",
            effect: "Channel 1 Lightning."),
        "dualcast": .init(name: "Dualcast", cost: "1", type: "skill",
            effect: "Evoke your rightmost Orb twice."),
        "ball_lightning": .init(name: "Ball Lightning", cost: "1", type: "attack",
            effect: "Deal 7 damage. Channel 1 Lightning."),
        "barrage": .init(name: "Barrage", cost: "1", type: "attack",
            effect: "Deal 5 damage for each Channeled Orb."),
        "beam_cell": .init(name: "Beam Cell", cost: "0", type: "attack",
            effect: "Deal 3 damage. Apply 1 Vulnerable."),
        "claw": .init(name: "Claw", cost: "0", type: "attack",
            effect: "Deal 3 damage. Increase the damage of ALL Claw cards by 2 this combat."),
        "cold_snap": .init(name: "Cold Snap", cost: "1", type: "attack",
            effect: "Deal 6 damage. Channel 1 Frost."),
        "compile_driver": .init(name: "Compile Driver", cost: "1", type: "attack",
            effect: "Deal 7 damage. Draw 1 card for each unique Orb you have."),
        "coolheaded": .init(name: "Coolheaded", cost: "1", type: "skill",
            effect: "Channel 1 Frost. Draw 1 card."),
        "focused_strike": .init(name: "Focused Strike", cost: "1", type: "attack",
            effect: "Deal 9 damage. Gain 1 Focus this turn."),
        "go_for_the_eyes": .init(name: "Go for the Eyes", cost: "0", type: "attack",
            effect: "Deal 3 damage. If the enemy intends to attack, apply 1 Weak."),
        "hologram": .init(name: "Hologram", cost: "1", type: "skill",
            effect: "Gain 3 Block. Put a card from your Discard Pile into your Hand. Exhaust."),
        "hotfix": .init(name: "Hotfix", cost: "0", type: "skill",
            effect: "Gain 2 Focus this turn."),
        "leap": .init(name: "Leap", cost: "1", type: "skill",
            effect: "Gain 9 Block."),
        "lightning_rod": .init(name: "Lightning Rod", cost: "1", type: "skill",
            effect: "Gain 4 Block. At the start of the next 2 turns, Channel 1 Lightning."),
        "sweeping_beam": .init(name: "Sweeping Beam", cost: "1", type: "attack",
            effect: "Deal 6 damage to ALL enemies. Draw 1 card."),
        "uproar": .init(name: "Uproar", cost: "2", type: "attack",
            effect: "Deal 5 damage twice. Play a random Attack from your Draw Pile."),
        "boot_sequence": .init(name: "Boot Sequence", cost: "0", type: "skill",
            effect: "Innate. Gain 10 Block. Exhaust."),
        "capacitor": .init(name: "Capacitor", cost: "1", type: "power",
            effect: "Gain 2 Orb Slots."),
        "chaos": .init(name: "Chaos", cost: "1", type: "skill",
            effect: "Channel 1 random Orb."),
        "chill": .init(name: "Chill", cost: "0", type: "skill",
            effect: "Channel 1 Frost for each enemy. Exhaust."),
        "darkness": .init(name: "Darkness", cost: "1", type: "skill",
            effect: "Channel 1 Dark. Trigger the passive ability of all Dark Orbs."),
        "double_energy": .init(name: "Double Energy", cost: "1", type: "skill",
            effect: "Double your Energy. Exhaust."),
        "glacier": .init(name: "Glacier", cost: "2", type: "skill",
            effect: "Gain 6 Block. Channel 2 Frost."),
        "glasswork": .init(name: "Glasswork", cost: "1", type: "skill",
            effect: "Gain 5 Block. Channel 1 Glass."),
        "hailstorm": .init(name: "Hailstorm", cost: "1", type: "power",
            effect: "At the end of your turn, if you have Frost, deal 6 damage to ALL enemies."),
        "loop": .init(name: "Loop", cost: "1", type: "power",
            effect: "At the start of your turn, trigger the passive ability of your rightmost Orb."),
        "null": .init(name: "Null", cost: "2", type: "attack",
            effect: "Deal 10 damage. Apply 2 Weak. Channel 1 Dark."),
        "refract": .init(name: "Refract", cost: "3", type: "attack",
            effect: "Deal 9 damage twice. Channel 2 Glass."),
        "rip_and_tear": .init(name: "Rip and Tear", cost: "1", type: "attack",
            effect: "Deal 7 damage to a random enemy twice."),
        "rocket_punch": .init(name: "Rocket Punch", cost: "2", type: "attack",
            effect: "Deal 13 damage. Draw 1 card. When a Status card is created, reduce this card's cost to 0 this turn."),
        "skim": .init(name: "Skim", cost: "1", type: "skill",
            effect: "Draw 3 cards."),
        "storm": .init(name: "Storm", cost: "1", type: "power",
            effect: "Whenever you play a Power, Channel 1 Lightning."),
        "synchronize": .init(name: "Synchronize", cost: "1", type: "skill",
            effect: "Gain 2 Focus this turn for each unique Orb you have. Exhaust."),
        "tempest": .init(name: "Tempest", cost: "1", type: "skill",
            effect: "Channel X Lightning."),
        "thunder": .init(name: "Thunder", cost: "1", type: "power",
            effect: "Whenever you Evoke Lightning, deal 6 damage to each enemy hit."),
        "all_for_one": .init(name: "All for One", cost: "2", type: "attack",
            effect: "Deal 10 damage. Put ALL 0 cards from your Discard Pile into your Hand."),
        "buffer": .init(name: "Buffer", cost: "2", type: "power",
            effect: "Prevent the next time you would lose HP."),
        "coolant": .init(name: "Coolant", cost: "1", type: "power",
            effect: "At the start of your turn, gain 2 Block for each unique Orb you have."),
        "creative_ai": .init(name: "Creative AI", cost: "3", type: "power",
            effect: "At the start of your turn, add a random Power into your Hand."),
        "defragment": .init(name: "Defragment", cost: "1", type: "power",
            effect: "Gain 1 Focus."),
        "echo_form": .init(name: "Echo Form", cost: "3", type: "power",
            effect: "Ethereal. The first card you play each turn is played an extra time."),
        "ice_lance": .init(name: "Ice Lance", cost: "3", type: "attack",
            effect: "Deal 19 damage. Channel 3 Frost."),
        "machine_learning": .init(name: "Machine Learning", cost: "1", type: "power",
            effect: "At the start of your turn, draw 1 additional card."),
        "meteor_strike": .init(name: "Meteor Strike", cost: "5", type: "attack",
            effect: "Deal 24 damage. Channel 3 Plasma."),
        "multi_cast": .init(name: "Multi-Cast", cost: "1", type: "skill",
            effect: "Evoke your rightmost Orb X times."),
        "rainbow": .init(name: "Rainbow", cost: "2", type: "skill",
            effect: "Channel 1 Lightning. Channel 1 Frost. Channel 1 Dark. Exhaust."),
        "reboot": .init(name: "Reboot", cost: "0", type: "skill",
            effect: "Shuffle ALL your cards into your Draw Pile. Draw 4 cards. Exhaust."),
        "shatter": .init(name: "Shatter", cost: "1", type: "attack",
            effect: "Deal 11 damage to ALL enemies. Evoke all of your Orbs."),
        "trash_to_treasure": .init(name: "Trash to Treasure", cost: "1", type: "power",
            effect: "Whenever you create a Status card, Channel 1 random Orb."),
        "biased_cognition": .init(name: "Biased Cognition", cost: "1", type: "power",
            effect: "Gain 4 Focus. At the start of your turn, lose 1 Focus."),
        "quadcast": .init(name: "Quadcast", cost: "1", type: "skill",
            effect: "Evoke your rightmost Orb 4 times."),

        // ---- Regent ----
        "strike_regent": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_regent": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "falling_star": .init(name: "Falling Star", cost: "0", type: "attack",
            effect: "Deal 7 damage. Apply 1 Weak. Apply 1 Vulnerable."),
        "venerate": .init(name: "Venerate", cost: "1", type: "skill",
            effect: "Gain 5 Block. Gain 1 Star."),
        "astral_pulse": .init(name: "Astral Pulse", cost: "0", type: "attack",
            effect: "Deal 14 damage to ALL enemies."),
        "celestial_might": .init(name: "Celestial Might", cost: "2", type: "attack",
            effect: "Deal 6 damage 3 times."),
        "cloak_of_stars": .init(name: "Cloak of Stars", cost: "0", type: "skill",
            effect: "Gain 7 Block."),
        "cosmic_indifference": .init(name: "Cosmic Indifference", cost: "1", type: "skill",
            effect: "Gain 6 Block. Put a card from your Discard Pile on top of your Draw Pile."),
        "crescent_spear": .init(name: "Crescent Spear", cost: "1", type: "attack",
            effect: "Deal 6 damage. Deals 2 additional damage for ALL your cards that have a cost."),
        "crush_under": .init(name: "Crush Under", cost: "1", type: "attack",
            effect: "Deal 7 damage to ALL enemies. All enemies lose 1 Strength this turn."),
        "gather_light": .init(name: "Gather Light", cost: "1", type: "skill",
            effect: "Gain 7 Block. Gain 1 Star."),
        "glitterstream": .init(name: "Glitterstream", cost: "2", type: "skill",
            effect: "Gain 11 Block. Next turn, gain 4 Block."),
        "know_thy_place": .init(name: "Know Thy Place", cost: "0", type: "skill",
            effect: "Apply 1 Weak. Apply 1 Vulnerable. Exhaust."),
        "patter": .init(name: "Patter", cost: "1", type: "skill",
            effect: "Gain 8 Block. Gain 2 Vigor."),
        "photon_cut": .init(name: "Photon Cut", cost: "1", type: "attack",
            effect: "Deal 10 damage. Draw 1 card. Put 1 card from your Hand on top of your Draw Pile."),
        "solar_strike": .init(name: "Solar Strike", cost: "1", type: "attack",
            effect: "Deal 8 damage. Gain 1 Star."),
        "wrought_in_war": .init(name: "Wrought in War", cost: "1", type: "attack",
            effect: "Deal 7 damage. Forge 5."),
        "devastate": .init(name: "Devastate", cost: "1", type: "attack",
            effect: "Deal 30 damage."),
        "furnace": .init(name: "Furnace", cost: "1", type: "power",
            effect: "At the start of your turn, Forge 4."),
        "gamma_blast": .init(name: "Gamma Blast", cost: "0", type: "attack",
            effect: "Deal 13 damage. Apply 2 Weak. Apply 2 Vulnerable."),
        "glimmer": .init(name: "Glimmer", cost: "1", type: "skill",
            effect: "Draw 3 cards. Put 1 card from your Hand on top of your Draw Pile."),
        "kingly_kick": .init(name: "Kingly Kick", cost: "4", type: "attack",
            effect: "Deal 24 damage. Whenever you draw this card, reduce its cost by 1."),
        "kingly_punch": .init(name: "Kingly Punch", cost: "1", type: "attack",
            effect: "Deal 8 damage. Whenever you draw this card, increase its damage by 3 this combat."),
        "lunar_blast": .init(name: "Lunar Blast", cost: "0", type: "attack",
            effect: "Deal 4 damage for each Skill already played this turn."),
        "manifest_authority": .init(name: "Manifest Authority", cost: "1", type: "skill",
            effect: "Gain 7 Block. Add 1 random Colorless card into your Hand."),
        "monologue": .init(name: "Monologue", cost: "0", type: "skill",
            effect: "Whenever you play a card this turn, gain 1 Strength this turn."),
        "pale_blue_dot": .init(name: "Pale Blue Dot", cost: "1", type: "power",
            effect: "If you play 5 or more cards in a turn, draw 1 card at the start of your next turn."),
        "particle_wall": .init(name: "Particle Wall", cost: "0", type: "skill",
            effect: "Gain 9 Block. Return this card to your Hand."),
        "pillar_of_creation": .init(name: "Pillar of Creation", cost: "1", type: "power",
            effect: "Whenever you create a card, gain 3 Block."),
        "prophesize": .init(name: "Prophesize", cost: "2", type: "skill",
            effect: "Draw 6 cards."),
        "quasar": .init(name: "Quasar", cost: "0", type: "skill",
            effect: "Choose 1 of 3 random Colorless cards to add into your Hand."),
        "reflect": .init(name: "Reflect", cost: "1", type: "skill",
            effect: "Gain 17 Block. Blocked attack damage is reflected to your attacker this turn."),
        "resonance": .init(name: "Resonance", cost: "1", type: "skill",
            effect: "Gain 1 Strength. ALL enemies lose 1 Strength."),
        "stardust": .init(name: "Stardust", cost: "0", type: "attack",
            effect: "Deal 5 damage to a random enemy X times."),
        "supermassive": .init(name: "Supermassive", cost: "1", type: "attack",
            effect: "Deal 5 damage. Deals 3 additional damage for each card you created this combat."),
        "terraforming": .init(name: "Terraforming", cost: "1", type: "skill",
            effect: "Gain 6 Vigor."),
        "arsenal": .init(name: "Arsenal", cost: "1", type: "power",
            effect: "Whenever a card is created, gain 1 Strength."),
        "comet": .init(name: "Comet", cost: "0", type: "attack",
            effect: "Deal 33 damage. Apply 3 Weak. Apply 3 Vulnerable."),
        "dying_star": .init(name: "Dying Star", cost: "1", type: "attack",
            effect: "Ethereal. Deal 9 damage to ALL enemies. ALL enemies lose 9 Strength this turn."),
        "heavenly_drill": .init(name: "Heavenly Drill", cost: "1", type: "attack",
            effect: "Deal 8 damage X times. Double X if it's 4 or more."),
        "i_am_invincible": .init(name: "I Am Invincible", cost: "1", type: "skill",
            effect: "Gain 9 Block. At the end of your turn, if this is on top of your Draw Pile, play it."),
        "monarch_s_gaze": .init(name: "Monarch's Gaze", cost: "3", type: "power",
            effect: "Whenever you attack an enemy, it loses 1 Strength this turn."),
        "neutron_aegis": .init(name: "Neutron Aegis", cost: "1", type: "power",
            effect: "Gain 8 Plating."),
        "royalties": .init(name: "Royalties", cost: "1", type: "power",
            effect: "At the end of combat, gain 30 Gold."),
        "seven_stars": .init(name: "Seven Stars", cost: "2", type: "attack",
            effect: "Deal 7 damage to ALL enemies 7 times."),
        "the_smith": .init(name: "The Smith", cost: "1", type: "skill",
            effect: "Forge 30."),
        "tyranny": .init(name: "Tyranny", cost: "1", type: "power",
            effect: "At the start of your turn, draw 1 card and Exhaust 1 card from your Hand."),
        "void_form": .init(name: "Void Form", cost: "3", type: "power",
            effect: "End your turn. The first 2 cards you play each turn are free to play."),
        "meteor_shower": .init(name: "Meteor Shower", cost: "0", type: "attack",
            effect: "Deal 14 damage to ALL enemies. Apply 2 Weak and Vulnerable to ALL enemies."),

        // ---- Necrobinder ----
        "strike_necrobinder": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_necrobinder": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "bodyguard": .init(name: "Bodyguard", cost: "1", type: "skill",
            effect: "Summon 5."),
        "afterlife": .init(name: "Afterlife", cost: "1", type: "skill",
            effect: "Summon 6. Exhaust."),
        "blight_strike": .init(name: "Blight Strike", cost: "1", type: "attack",
            effect: "Deal 8 damage. Apply Doom equal to damage dealt."),
        "defile": .init(name: "Defile", cost: "1", type: "attack",
            effect: "Ethereal. Deal 13 damage."),
        "defy": .init(name: "Defy", cost: "1", type: "skill",
            effect: "Ethereal. Gain 6 Block. Apply 1 Weak."),
        "drain_power": .init(name: "Drain Power", cost: "1", type: "attack",
            effect: "Deal 10 damage. Upgrade 2 random cards in your Discard Pile."),
        "fear": .init(name: "Fear", cost: "1", type: "attack",
            effect: "Ethereal. Deal 7 damage. Apply 1 Vulnerable."),
        "flatten": .init(name: "Flatten", cost: "2", type: "attack",
            effect: "Osty deals 12 damage. This card costs 0 if Osty has attacked this turn."),
        "graveblast": .init(name: "Graveblast", cost: "1", type: "attack",
            effect: "Deal 4 damage. Put a card from your Discard Pile into your Hand. Exhaust."),
        "negative_pulse": .init(name: "Negative Pulse", cost: "1", type: "skill",
            effect: "Gain 5 Block. Apply 7 Doom to ALL enemies."),
        "poke": .init(name: "Poke", cost: "0", type: "attack",
            effect: "Osty deals 6 damage."),
        "pull_aggro": .init(name: "Pull Aggro", cost: "2", type: "skill",
            effect: "Summon 4. Gain 7 Block."),
        "reap": .init(name: "Reap", cost: "3", type: "attack",
            effect: "Retain. Deal 27 damage."),
        "scourge": .init(name: "Scourge", cost: "1", type: "skill",
            effect: "Apply 13 Doom. Draw 1 card."),
        "sculpting_strike": .init(name: "Sculpting Strike", cost: "1", type: "attack",
            effect: "Deal 8 damage. Add Ethereal to a card in your Hand."),
        "snap": .init(name: "Snap", cost: "1", type: "attack",
            effect: "Osty deals 7 damage. Add Retain to a card in your Hand."),
        "sow": .init(name: "Sow", cost: "1", type: "attack",
            effect: "Retain. Deal 8 damage to ALL enemies."),
        "bone_shards": .init(name: "Bone Shards", cost: "1", type: "attack",
            effect: "If Osty is alive, he deals 9 damage to ALL enemies and you gain 9 Block. Osty dies."),
        "bury": .init(name: "Bury", cost: "4", type: "attack",
            effect: "Deal 52 damage."),
        "countdown": .init(name: "Countdown", cost: "1", type: "power",
            effect: "At the start of your turn, apply 6 Doom to a random enemy."),
        "death_march": .init(name: "Death March", cost: "1", type: "attack",
            effect: "Deal 8 damage. Deals 3 additional damage for each card drawn during your turn."),
        "death_s_door": .init(name: "Death's Door", cost: "1", type: "skill",
            effect: "Gain 6 Block. If you applied Doom this turn, gain Block 2 additional times."),
        "deathbringer": .init(name: "Deathbringer", cost: "2", type: "skill",
            effect: "Apply 21 Doom and 1 Weak to ALL enemies."),
        "debilitate": .init(name: "Debilitate", cost: "1", type: "attack",
            effect: "Deal 7 damage. Vulnerable and Weak are twice as effective against the enemy for the next 3 turns."),
        "dredge": .init(name: "Dredge", cost: "1", type: "skill",
            effect: "Put 3 cards from your Discard Pile into your Hand. Exhaust."),
        "enfeebling_touch": .init(name: "Enfeebling Touch", cost: "1", type: "skill",
            effect: "Ethereal. Enemy loses 8 Strength this turn."),
        "fetch": .init(name: "Fetch", cost: "0", type: "attack",
            effect: "Osty deals 3 damage. If this is the first time this card has been played this turn, draw 1 card."),
        "high_five": .init(name: "High Five", cost: "2", type: "attack",
            effect: "Osty deals 11 damage and applies 2 Vulnerable to ALL enemies."),
        "legion_of_bone": .init(name: "Legion of Bone", cost: "2", type: "skill",
            effect: "ALL players Summon 6. Exhaust."),
        "lethality": .init(name: "Lethality", cost: "1", type: "power",
            effect: "Ethereal. The first Attack each turn deals 50% additional damage."),
        "no_escape": .init(name: "No Escape", cost: "1", type: "skill",
            effect: "Apply 10 Doom, plus an additional 5 Doom for every 10 Doom already on this enemy."),
        "pagestorm": .init(name: "Pagestorm", cost: "1", type: "power",
            effect: "Whenever you draw an Ethereal card, draw 1 card."),
        "parse": .init(name: "Parse", cost: "1", type: "skill",
            effect: "Ethereal. Draw 3 cards."),
        "pull_from_below": .init(name: "Pull from Below", cost: "1", type: "attack",
            effect: "Deal 5 damage for each Ethereal card played this combat."),
        "putrefy": .init(name: "Putrefy", cost: "1", type: "skill",
            effect: "Apply 2 Weak. Apply 2 Vulnerable. Exhaust."),
        "rattle": .init(name: "Rattle", cost: "1", type: "attack",
            effect: "Osty deals 7 damage. Hits an additional time for each other time he has attacked this turn."),
        "shroud": .init(name: "Shroud", cost: "1", type: "power",
            effect: "Whenever you apply Doom, gain 2 Block."),
        "sic_em": .init(name: "Sic 'Em", cost: "1", type: "attack",
            effect: "Osty deals 5 damage. Whenever Osty hits this enemy this turn, Summon 2."),
        "spur": .init(name: "Spur", cost: "1", type: "skill",
            effect: "Retain. Summon 3. Osty heals 5 HP."),
        "eidolon": .init(name: "Eidolon", cost: "2", type: "skill",
            effect: "Exhaust your Hand. If 9 cards were Exhausted this way, gain 1 Intangible."),
        "end_of_days": .init(name: "End of Days", cost: "3", type: "skill",
            effect: "Apply 29 Doom to ALL enemies. Kill enemies with at least as much Doom as HP."),
        "eradicate": .init(name: "Eradicate", cost: "1", type: "attack",
            effect: "Retain. Deal 11 damage X times."),
        "misery": .init(name: "Misery", cost: "0", type: "attack",
            effect: "Deal 7 damage. Apply any debuffs on the enemy to ALL other enemies."),
        "necro_mastery": .init(name: "Necro Mastery", cost: "2", type: "power",
            effect: "Summon 5. Whenever Osty loses HP, ALL enemies lose that much HP as well."),
        "oblivion": .init(name: "Oblivion", cost: "0", type: "skill",
            effect: "Whenever you play a card this turn, apply 3 Doom to the enemy."),
        "reanimate": .init(name: "Reanimate", cost: "3", type: "skill",
            effect: "Summon 20. Exhaust."),
        "reaper_form": .init(name: "Reaper Form", cost: "3", type: "power",
            effect: "Whenever Attacks deal damage, they also apply that much Doom."),
        "sacrifice": .init(name: "Sacrifice", cost: "1", type: "skill",
            effect: "Retain. If Osty is alive, he dies and you gain Block equal to double his Max HP."),
        "spirit_of_ash": .init(name: "Spirit of Ash", cost: "1", type: "power",
            effect: "Whenever you play an Ethereal card, gain 4 Block."),
        "time_s_up": .init(name: "Time's Up", cost: "2", type: "attack",
            effect: "Deal damage equal to the enemy's Doom. Exhaust."),
        "undeath": .init(name: "Undeath", cost: "0", type: "skill",
            effect: "Gain 7 Block. Add a copy of this card into your Discard Pile."),
        "banshee_s_cry": .init(name: "Banshee's Cry", cost: "6", type: "attack",
            effect: "Deal 33 damage to ALL enemies. Costs less for each Ethereal card played this combat."),
        "hang": .init(name: "Hang", cost: "1", type: "attack",
            effect: "Deal 10 damage. Double the damage ALL Hang cards deal to this enemy."),
        "forbidden_grimoire": .init(name: "Forbidden Grimoire", cost: "2", type: "power",
            effect: "At the end of combat, you may remove a card from your Deck. Eternal."),
    ]

    // MARK: - Relic entries
    //
    // Same shape. All ten starter relics (both tiers for all five
    // characters) plus the most frequently seen neutrals, ancients, and
    // class relics. Empty-description relics in the source database
    // (Kunai, Shuriken, Letter Opener, Pen Nib, Ornamental Fan, Calling
    // Bell, Whetstone, War Paint, Sozu, ...) ship no entry — the model
    // hedges instead of quoting STS1 numbers.

    static let relics: [String: Entry] = [
        "burningblood": .init(name: "Burning Blood", cost: "—", type: "starter",
            effect: "Ironclad starter. At the end of combat, heal 6 HP."),
        "blackblood": .init(name: "Black Blood", cost: "—", type: "starter",
            effect: "Ironclad starter. At the end of combat, heal 12 HP."),
        "ringofthesnake": .init(name: "Ring of the Snake", cost: "—", type: "starter",
            effect: "Silent starter. At the start of each combat, draw 2 additional cards."),
        "ringofthedrake": .init(name: "Ring of the Drake", cost: "—", type: "starter",
            effect: "Silent starter. At the start of your first 3 turns, draw 2 additional cards."),
        "crackedcore": .init(name: "Cracked Core", cost: "—", type: "starter",
            effect: "Defect starter. At the start of each combat, Channel 1 Lightning."),
        "infusedcore": .init(name: "Infused Core", cost: "—", type: "starter",
            effect: "Defect Ancient starter. Start of combat: Channel 1 Lightning; Lightning Orbs deal +1 damage. (v0.105 rework.)"),
        "divinedestiny": .init(name: "Divine Destiny", cost: "—", type: "starter",
            effect: "Regent starter. Start of each combat: gain 6 Stars."),
        "divineright": .init(name: "Divine Right", cost: "—", type: "starter",
            effect: "Regent Ancient starter. Start of each combat: gain Stars (larger grant than Divine Destiny)."),
        "boundphylactery": .init(name: "Bound Phylactery", cost: "—", type: "starter",
            effect: "Necrobinder starter. At the start of your turn, Summon 1."),
        "phylacteryunbound": .init(name: "Phylactery Unbound", cost: "—", type: "starter",
            effect: "Necrobinder starter. At the start of each combat, Summon 5. At the start of your turn, Summon 2."),
        "anchor": .init(name: "Anchor", cost: "—", type: "common",
            effect: "Start each combat with 10 Block."),
        "bagofmarbles": .init(name: "Bag of Marbles", cost: "—", type: "uncommon",
            effect: "At the start of each combat, apply 1 Vulnerable to ALL enemies."),
        "bagofpreparation": .init(name: "Bag of Preparation", cost: "—", type: "common",
            effect: "At the start of each combat, draw 2 additional cards."),
        "bloodvial": .init(name: "Blood Vial", cost: "—", type: "common",
            effect: "At the start of each combat, heal 2 HP."),
        "lantern": .init(name: "Lantern", cost: "—", type: "common",
            effect: "Start each combat with an additional Energy."),
        "oddlysmoothstone": .init(name: "Oddly Smooth Stone", cost: "—", type: "common",
            effect: "Start each combat with 1 Dexterity."),
        "vajra": .init(name: "Vajra", cost: "—", type: "common",
            effect: "Start each combat with 1 Strength."),
        "akabeko": .init(name: "Akabeko", cost: "—", type: "uncommon",
            effect: "At the start of each combat, gain 8 Vigor."),
        "bronzescales": .init(name: "Bronze Scales", cost: "—", type: "common",
            effect: "Start each combat with 3 Thorns."),
        "centennialpuzzle": .init(name: "Centennial Puzzle", cost: "—", type: "common",
            effect: "The first time you lose HP each combat, draw 3 cards."),
        "happyflower": .init(name: "Happy Flower", cost: "—", type: "common",
            effect: "Every 3 turns, gain Energy."),
        "gorget": .init(name: "Gorget", cost: "—", type: "common",
            effect: "At the start of each combat, gain 4 Plating."),
        "orichalcum": .init(name: "Orichalcum", cost: "—", type: "uncommon",
            effect: "If you end your turn without Block, gain 6 Block."),
        "vambrace": .init(name: "Vambrace", cost: "—", type: "uncommon",
            effect: "The first time you gain Block from a card each combat, double the amount gained."),
        "gamblingchip": .init(name: "Gambling Chip", cost: "—", type: "rare",
            effect: "At the start of each combat, discard any number of cards then draw that many."),
        "tungstenrod": .init(name: "Tungsten Rod", cost: "—", type: "rare",
            effect: "Whenever you would lose HP, lose 1 less."),
        "icecream": .init(name: "Ice Cream", cost: "—", type: "rare",
            effect: "Energy is now conserved between turns."),
        "lizardtail": .init(name: "Lizard Tail", cost: "—", type: "rare",
            effect: "When you would die, heal to 50% of your Max HP instead (works once)."),
        "velvetchoker": .init(name: "Velvet Choker", cost: "—", type: "ancient",
            effect: "Gain Energy at the start of each turn. You cannot play more than 6 cards per turn."),
        "philosophersstone": .init(name: "Philosopher's Stone", cost: "—", type: "ancient",
            effect: "Gain Energy at the start of each turn. ALL enemies start combat with 1 Strength."),
        "runicpyramid": .init(name: "Runic Pyramid", cost: "—", type: "ancient",
            effect: "At the end of your turn, you no longer discard your Hand."),
        "sneckoeye": .init(name: "Snecko Eye", cost: "—", type: "ancient",
            effect: "At the start of your turn, draw 2 additional cards. Start each combat Confused."),
        "ectoplasm": .init(name: "Ectoplasm", cost: "—", type: "ancient",
            effect: "You can no longer gain Gold. Gain Energy at the start of each turn."),
        "blackstar": .init(name: "Black Star", cost: "—", type: "ancient",
            effect: "Elites drop an additional Relic when defeated."),
        "pumpkincandle": .init(name: "Pumpkin Candle", cost: "—", type: "ancient",
            effect: "Gain 1 Energy at the start of each turn. Extinguishes after 5 combats; can be Kindled at Rest Sites. (v0.105 rework.)"),
        "redskull": .init(name: "Red Skull", cost: "—", type: "common",
            effect: "While your HP is at or below 50%, you have 3 additional Strength. (Ironclad.)"),
        "paperphrog": .init(name: "Paper Phrog", cost: "—", type: "uncommon",
            effect: "Enemies with Vulnerable take 75% more damage rather than 50%. (Ironclad.)"),
        "selfformingclay": .init(name: "Self-Forming Clay", cost: "—", type: "uncommon",
            effect: "Whenever you lose HP in combat, gain 3 Block next turn. (Ironclad.)"),
        "charonsashes": .init(name: "Charon's Ashes", cost: "—", type: "rare",
            effect: "Whenever you Exhaust a card, deal 3 damage to ALL enemies. (Ironclad.)"),
        "brimstone": .init(name: "Brimstone", cost: "—", type: "shop",
            effect: "At the start of your turn, gain 2 Strength and ALL enemies gain 1 Strength. (Ironclad.)"),
        "sneckoskull": .init(name: "Snecko Skull", cost: "—", type: "common",
            effect: "Whenever you apply Poison, apply an additional 1 Poison. (Silent.)"),
        "twistedfunnel": .init(name: "Twisted Funnel", cost: "—", type: "uncommon",
            effect: "At the start of each combat, apply 4 Poison to ALL enemies. (Silent.)"),
        "toughbandages": .init(name: "Tough Bandages", cost: "—", type: "rare",
            effect: "Whenever you discard a card during your turn, gain 3 Block. (Silent.)"),
        "paperkrane": .init(name: "Paper Krane", cost: "—", type: "rare",
            effect: "Enemies with Weak deal 40% less damage to you rather than 25%. (Silent.)"),
        "helicaldart": .init(name: "Helical Dart", cost: "—", type: "rare",
            effect: "Whenever you play a Shiv, gain 1 Dexterity this turn. (Silent.)"),
        "datadisk": .init(name: "Data Disk", cost: "—", type: "common",
            effect: "Start each combat with 1 Focus. (Defect.)"),
        "goldplatedcables": .init(name: "Gold-Plated Cables", cost: "—", type: "uncommon",
            effect: "Your rightmost Orb triggers its passive an additional time. (Defect.)"),
        "runiccapacitor": .init(name: "Runic Capacitor", cost: "—", type: "shop",
            effect: "Start each combat with 3 additional Orb Slots. (Defect.)"),
        "emotionchip": .init(name: "Emotion Chip", cost: "—", type: "rare",
            effect: "If you lost HP during the previous turn, trigger the passive ability of all Orbs at the start of your turn. (Defect.)"),
        "regalite": .init(name: "Regalite", cost: "—", type: "common",
            effect: "Whenever a card is created, gain Block. (Regent.)"),
        "fencingmanual": .init(name: "Fencing Manual", cost: "—", type: "common",
            effect: "At the start of each combat, Forge 10. (Regent.)"),
        "vitruvianminion": .init(name: "Vitruvian Minion", cost: "—", type: "shop",
            effect: "Cards containing \"Minion\" deal double damage and gain double Block. (Regent.)"),
        "miniregent": .init(name: "Mini Regent", cost: "—", type: "rare",
            effect: "The first time you spend each turn, gain 1 Strength. (Regent.)"),
        "boneflute": .init(name: "Bone Flute", cost: "—", type: "common",
            effect: "Whenever Osty attacks, gain 2 Block. (Necrobinder.)"),
        "undyingsigil": .init(name: "Undying Sigil", cost: "—", type: "shop",
            effect: "Enemies with at least as much Doom as HP deal 50% less damage. (Necrobinder.)"),
        "bighat": .init(name: "Big Hat", cost: "—", type: "rare",
            effect: "At the start of each combat, add 2 random Ethereal cards into your Hand. (Necrobinder.)"),
        "bookrepairknife": .init(name: "Book Repair Knife", cost: "—", type: "uncommon",
            effect: "Whenever a non-Minion enemy dies to Doom, heal 3 HP. (Necrobinder.)"),
    ]

    // MARK: - Lookup

    /// Resolve a card / upgraded-card identifier from the live deck to
    /// the matching glossary entry. Returns nil if unknown.
    ///
    /// Accepts: `bash`, `bash+1`, `streamline+`, `STRIKE_RED`,
    /// `card.bash`, etc. Normalization mirrors what STS2LiveSaveReader
    /// produces (lowercased, no `card.` prefix).
    static func entryForCard(rawID: String) -> Entry? {
        cardEntry(forNormalized: normalize(rawID))
    }

    static func entryForRelic(rawID: String) -> Entry? {
        relicEntry(forNormalized: normalize(rawID))
    }

    /// IDs (deck cards + relics) the player has in the live save
    /// that the glossary doesn't recognize. Used by the AI service to
    /// log telemetry to disk so we can expand the glossary in future
    /// builds without bothering the player. The set is unique;
    /// upgrade markers are stripped before lookup so "streamline+1"
    /// and "streamline+2" both resolve to "streamline".
    static func unmatchedIdentifiers(deckCards: [String],
                                     relicIDs: [String],
                                     characterHint: String? = nil) -> Set<String> {
        var unmatched: Set<String> = []
        for raw in deckCards {
            let key = normalize(raw)
            let resolved = resolveStrikeDefend(key, character: characterHint)
            if cardEntry(forNormalized: resolved) == nil && cardEntry(forNormalized: key) == nil {
                unmatched.insert(key)
            }
        }
        for raw in relicIDs {
            let key = normalize(raw)
            if relicEntry(forNormalized: key) == nil {
                unmatched.insert(key)
            }
        }
        return unmatched
    }

    /// Build a compact glossary block for a given list of card and
    /// relic identifiers. De-duplicates so a deck with 4 strikes
    /// emits ONE strike entry (the model doesn't need it 4 times).
    /// Returns an empty string when nothing matches — caller should
    /// branch on .isEmpty before stitching into the prompt.
    static func glossaryBlock(deckCards: [String],
                              relicIDs: [String],
                              characterHint: String? = nil) -> String {
        var seen = Set<String>()
        var lines: [String] = []
        for raw in deckCards {
            let key = normalize(raw)
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            // Resolve "strike" → character-specific strike entry when
            // we have a hint (so the model gets "Strike — Defect" vs
            // "Strike — Ironclad" if it ever matters; today they're
            // identical but we lay the groundwork).
            let resolvedKey = resolveStrikeDefend(key, character: characterHint)
            if let entry = cardEntry(forNormalized: resolvedKey) ?? cardEntry(forNormalized: key) {
                lines.append("- \(entry.name) [\(entry.cost) · \(entry.type)] — \(entry.effect)")
            }
        }
        if !lines.isEmpty {
            lines.insert("CARDS in your deck:", at: 0)
        }

        var relicLines: [String] = []
        var relicSeen = Set<String>()
        for raw in relicIDs {
            let key = normalize(raw)
            guard !relicSeen.contains(key) else { continue }
            relicSeen.insert(key)
            if let entry = relicEntry(forNormalized: key) {
                relicLines.append("- \(entry.name) — \(entry.effect)")
            }
        }
        if !relicLines.isEmpty {
            if !lines.isEmpty { lines.append("") }
            lines.append("RELICS active:")
            lines.append(contentsOf: relicLines)
        }

        return lines.joined(separator: "\n")
    }

    // MARK: - Internals

    /// Strip upgrade marker, lowercase, drop `card.` / `relic.` prefix.
    /// Examples:
    ///   "Streamline+1" → "streamline"
    ///   "BASH+"        → "bash"
    ///   "card.zap"     → "zap"
    private static func normalize(_ raw: String) -> String {
        var s = raw.lowercased()
        if let dot = s.firstIndex(of: ".") {
            // Drop a leading "card." / "relic." namespace.
            let prefix = String(s[..<dot])
            if prefix == "card" || prefix == "relic" || prefix == "potion" {
                s = String(s[s.index(after: dot)...])
            }
        }
        // Trim any "+N" upgrade suffix.
        if let plus = s.firstIndex(of: "+") {
            s = String(s[..<plus])
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Stripped-key form for fuzzy dictionary lookups. STS2 saves
    /// store relic / card identifiers in several conventions —
    /// "BurningBlood" (CamelCase), "burning_blood" (snake), "Burning
    /// Blood" (spaced), or even "burning-blood" (kebab). All three
    /// should resolve to the same glossary entry. Stripping non-
    /// alphanumerics gives every variant the same canonical shape:
    /// "burningblood".
    private static func stripped(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s where ch.isLetter || ch.isNumber {
            out.append(ch)
        }
        return out
    }

    /// Cached stripped → canonical-key maps so we do the strip work
    /// once per process instead of on every lookup. Populated lazily
    /// the first time we need it. Tied to the cards / relics statics
    /// above — if those change at runtime (they don't, they're
    /// `static let`), the cache would lie.
    private static let cardStrippedKeys: [String: String] = {
        var m: [String: String] = [:]
        for k in cards.keys { m[stripped(k)] = k }
        return m
    }()
    private static let relicStrippedKeys: [String: String] = {
        var m: [String: String] = [:]
        for k in relics.keys { m[stripped(k)] = k }
        return m
    }()

    /// Look up a card glossary entry, trying both the normalized key
    /// and its stripped form. Returns nil if neither matches.
    private static func cardEntry(forNormalized key: String) -> Entry? {
        if let entry = cards[key] { return entry }
        let stripKey = stripped(key)
        if let canonical = cardStrippedKeys[stripKey] {
            return cards[canonical]
        }
        return nil
    }

    /// Look up a relic glossary entry, trying both the normalized key
    /// and its stripped form. Returns nil if neither matches.
    private static func relicEntry(forNormalized key: String) -> Entry? {
        if let entry = relics[key] { return entry }
        let stripKey = stripped(key)
        if let canonical = relicStrippedKeys[stripKey] {
            return relics[canonical]
        }
        return nil
    }

    /// Map a generic "strike" / "defend" key to the character-specific
    /// entry when the character is known. Falls back to the generic
    /// entry when not.
    private static func resolveStrikeDefend(_ key: String, character: String?) -> String {
        guard key == "strike" || key == "defend" else { return key }
        let suffix: String? = {
            switch (character ?? "").lowercased() {
            case "ironclad":     return "red"
            case "silent":       return "green"
            case "defect":       return "blue"
            case "regent":       return "regent"
            case "necrobinder":  return "necrobinder"
            default: return nil
            }
        }()
        if let s = suffix { return "\(key)_\(s)" }
        return key
    }

    // MARK: - Entry shape

    struct Entry: Equatable {
        let name: String
        let cost: String
        let type: String
        let effect: String
    }
}
