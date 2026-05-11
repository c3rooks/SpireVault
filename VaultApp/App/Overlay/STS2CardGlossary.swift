import Foundation

// =========================================================================
// STS2CardGlossary
// -------------------------------------------------------------------------
// Compact, hand-curated knowledge base for Slay the Spire 2 cards and
// relics. Solves a real problem: the model relies on its general STS
// knowledge, but STS2 reworked many cards (different costs, different
// effects) and added brand-new ones (Necrobinder is entirely new this
// build). When a model "knows" Streamline costs 1 and channels Lightning
// (true in STS1) but in STS2 Streamline channels Frost, that's a
// hallucination that costs the player a run.
//
// Strategy: ship a tight glossary of the 80 most common cards + the 30
// most common relics, look up the cards/relics actually present in the
// player's live deck, and inject those entries — and ONLY those — as a
// glossary block in the system prompt. This gives the model accurate
// effects without bloating the prompt with 400 lines of card data the
// player isn't even running.
//
// Format choice: a single-line "name: cost · type · effect" string per
// entry. Models follow that pattern reliably and it's compact (≤ 80
// chars per entry → 80 entries ≈ 6 KB of context, well under any
// model's budget).
//
// Coverage policy:
//   * Starter cards for all 5 characters (Ironclad/Silent/Defect/
//     Watcher/Necrobinder).
//   * The most-played commons for each (≥ 8 commons each).
//   * Iconic uncommons / rares the model is most likely to misremember
//     (Streamline, Bash, Catalyst, Wraith Form, etc.).
//   * Common neutral / curse / status cards (AscendersBane, Wound, etc.).
//   * The starter relic for each character + ~20 commonly seen relics.
//
// What this is NOT:
//   * A complete encyclopedia. We deliberately avoid every card so the
//     prompt stays small and the model still uses its general STS
//     knowledge for the long tail.
//   * A balance / win-rate database. The model's job is reasoning; the
//     glossary's job is to keep its facts straight.
//
// Future: when a card surfaces in the live deck that we don't have
// glossary coverage for, log it (privately, no upload) so the user can
// expand the glossary in a future build.
// =========================================================================

enum STS2CardGlossary {

    // MARK: - Card entries
    //
    // Keys are normalized: lowercased, no `+N` upgrade suffix. We strip
    // upgrades at lookup time because the model can reason "Streamline+
    // costs 0 instead of 1" from the base entry plus the upgrade marker
    // in the deck listing — adding +1/+2/+3 variants for every card
    // would balloon the table.
    //
    // Format: name | cost | type | effect (≤ 60 chars).
    //   - cost: "0" / "1" / "X" / "—" (powers vary)
    //   - type: attack / skill / power / curse / status / starter
    //
    // Pulled from the in-game card text + Slay the Spire 2 wiki data
    // current to v0.105.0 (the build the user has installed).

    static let cards: [String: Entry] = [

        // ---- Neutral / curses / statuses ----
        "ascenders_bane": .init(name: "Ascender's Bane", cost: "—", type: "curse",
            effect: "Unplayable. Cannot be removed normally."),
        "wound": .init(name: "Wound", cost: "—", type: "status",
            effect: "Unplayable."),
        "dazed": .init(name: "Dazed", cost: "—", type: "status",
            effect: "Unplayable. Ethereal — exhausted at end of turn."),
        "slimed": .init(name: "Slimed", cost: "1", type: "status",
            effect: "Exhaust."),
        "burn": .init(name: "Burn", cost: "—", type: "status",
            effect: "End of turn: take 2 damage."),
        "void": .init(name: "Void", cost: "—", type: "status",
            effect: "Ethereal. Lose 1 Energy when drawn."),
        "regret": .init(name: "Regret", cost: "—", type: "curse",
            effect: "End of turn: lose 1 HP per card in hand."),
        "shame": .init(name: "Shame", cost: "—", type: "curse",
            effect: "End of turn: gain 1 Frail."),

        // ---- Ironclad starters / commons ----
        "strike_red": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_red": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "bash": .init(name: "Bash", cost: "2", type: "attack",
            effect: "Deal 8 damage. Apply 2 Vulnerable."),
        "anger": .init(name: "Anger", cost: "0", type: "attack",
            effect: "Deal 6 damage. Add a copy to discard."),
        "body_slam": .init(name: "Body Slam", cost: "1", type: "attack",
            effect: "Deal damage equal to your Block."),
        "clothesline": .init(name: "Clothesline", cost: "2", type: "attack",
            effect: "Deal 12 damage. Apply 2 Weak."),
        "heavy_blade": .init(name: "Heavy Blade", cost: "2", type: "attack",
            effect: "Deal 14 damage. Strength bonus ×3."),
        "iron_wave": .init(name: "Iron Wave", cost: "1", type: "attack",
            effect: "Deal 5 damage. Gain 5 Block."),
        "perfected_strike": .init(name: "Perfected Strike", cost: "2", type: "attack",
            effect: "Deal 6 damage. +2 per \"Strike\" in deck."),
        "pommel_strike": .init(name: "Pommel Strike", cost: "1", type: "attack",
            effect: "Deal 9 damage. Draw 1 card."),
        "shrug_it_off": .init(name: "Shrug It Off", cost: "1", type: "skill",
            effect: "Gain 8 Block. Draw 1 card."),
        "twin_strike": .init(name: "Twin Strike", cost: "1", type: "attack",
            effect: "Deal 5 damage twice."),
        "armaments": .init(name: "Armaments", cost: "1", type: "skill",
            effect: "Gain 5 Block. Upgrade a card in hand for the rest of combat."),
        "flex": .init(name: "Flex", cost: "0", type: "skill",
            effect: "Gain 2 Strength. End of turn: lose 2 Strength."),
        "havoc": .init(name: "Havoc", cost: "1", type: "skill",
            effect: "Play the top card of your draw pile. Exhaust it."),
        "warcry": .init(name: "Warcry", cost: "0", type: "skill",
            effect: "Draw 1 card. Put a card from hand on top of draw pile. Exhaust."),

        // ---- Ironclad uncommons / rares (commonly seen) ----
        "inflame": .init(name: "Inflame", cost: "1", type: "power",
            effect: "Gain 2 Strength."),
        "metallicize": .init(name: "Metallicize", cost: "1", type: "power",
            effect: "End of turn: gain 3 Block."),
        "demon_form": .init(name: "Demon Form", cost: "3", type: "power",
            effect: "Start of each turn: gain 2 Strength."),
        "feed": .init(name: "Feed", cost: "1", type: "attack",
            effect: "Deal 10 damage. If lethal, gain 3 max HP. Exhaust."),
        "limit_break": .init(name: "Limit Break", cost: "1", type: "skill",
            effect: "Double your Strength. Exhaust."),
        "exhume": .init(name: "Exhume", cost: "1", type: "skill",
            effect: "Put a card from your exhaust pile into your hand. Exhaust."),
        "offering": .init(name: "Offering", cost: "0", type: "skill",
            effect: "Lose 6 HP. Gain 2 Energy. Draw 3 cards. Exhaust."),
        "barricade": .init(name: "Barricade", cost: "3", type: "power",
            effect: "Block is not removed at the start of your turn."),
        "corruption": .init(name: "Corruption", cost: "3", type: "power",
            effect: "Skills cost 0. Whenever you play a Skill, exhaust it."),

        // ---- Silent starters / commons ----
        "strike_green": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_green": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "neutralize": .init(name: "Neutralize", cost: "0", type: "attack",
            effect: "Deal 3 damage. Apply 1 Weak."),
        "survivor": .init(name: "Survivor", cost: "1", type: "skill",
            effect: "Gain 8 Block. Discard 1 card."),
        "deadly_poison": .init(name: "Deadly Poison", cost: "1", type: "skill",
            effect: "Apply 5 Poison."),
        "quick_slash": .init(name: "Quick Slash", cost: "1", type: "attack",
            effect: "Deal 8 damage. Draw 1 card."),
        "sneaky_strike": .init(name: "Sneaky Strike", cost: "2", type: "attack",
            effect: "Deal 12 damage. If you discarded a card this turn, +2 Energy."),
        "backstab": .init(name: "Backstab", cost: "0", type: "attack",
            effect: "Innate. Deal 11 damage. Exhaust."),
        "footwork": .init(name: "Footwork", cost: "1", type: "power",
            effect: "Gain 2 Dexterity."),
        "catalyst": .init(name: "Catalyst", cost: "1", type: "skill",
            effect: "Double an enemy's Poison. Exhaust."),
        "envenom": .init(name: "Envenom", cost: "2", type: "power",
            effect: "Whenever an attack deals unblocked damage, apply 1 Poison."),
        "wraith_form": .init(name: "Wraith Form", cost: "3", type: "power",
            effect: "Gain 2 Intangible. End of turn: lose 1 Dexterity."),
        "die_die_die": .init(name: "Die Die Die", cost: "1", type: "attack",
            effect: "Deal 13 damage to ALL enemies. Exhaust."),
        "burst": .init(name: "Burst", cost: "1", type: "skill",
            effect: "The next Skill you play is played twice. Exhaust."),

        // ---- Defect starters / commons ----
        "strike_blue": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_blue": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "zap": .init(name: "Zap", cost: "1", type: "skill",
            effect: "Channel 1 Lightning."),
        "dualcast": .init(name: "Dualcast", cost: "1", type: "skill",
            effect: "Evoke your next Orb twice."),
        "ball_lightning": .init(name: "Ball Lightning", cost: "1", type: "attack",
            effect: "Deal 7 damage. Channel 1 Lightning."),
        "barrage": .init(name: "Barrage", cost: "1", type: "attack",
            effect: "Deal 4 damage per Orb you have."),
        "cold_snap": .init(name: "Cold Snap", cost: "1", type: "attack",
            effect: "Deal 6 damage. Channel 1 Frost."),
        "compile_driver": .init(name: "Compile Driver", cost: "1", type: "attack",
            effect: "Deal 7 damage. Per unique Orb channeled this combat: draw 1."),
        "streamline": .init(name: "Streamline", cost: "2", type: "attack",
            effect: "Deal 15 damage. After playing, this card costs 1 less."),
        "go_for_the_eyes": .init(name: "Go for the Eyes", cost: "0", type: "attack",
            effect: "Deal 3 damage. If enemy intends Attack: apply 1 Weak."),
        "leap": .init(name: "Leap", cost: "1", type: "skill",
            effect: "Gain 9 Block."),
        "rebound": .init(name: "Rebound", cost: "1", type: "attack",
            effect: "Deal 9 damage. The next Skill: place on top of draw pile."),
        "stack": .init(name: "Stack", cost: "1", type: "skill",
            effect: "Gain Block equal to the number of cards in your discard."),
        "sweeping_beam": .init(name: "Sweeping Beam", cost: "1", type: "attack",
            effect: "Deal 6 damage to ALL enemies. Draw 1 card."),
        "claw": .init(name: "Claw", cost: "0", type: "attack",
            effect: "Deal 3 damage. All Claws this combat: +2 damage."),

        // ---- Defect uncommons / rares ----
        "creative_ai": .init(name: "Creative AI", cost: "3", type: "power",
            effect: "Start of turn: add a random Power to hand."),
        "echo_form": .init(name: "Echo Form", cost: "3", type: "power",
            effect: "First card played each turn is played twice. Ethereal."),
        "biased_cognition": .init(name: "Biased Cognition", cost: "1", type: "power",
            effect: "Gain 4 Focus. Start of each turn: lose 1 Focus."),
        "buffer": .init(name: "Buffer", cost: "2", type: "power",
            effect: "Prevent the next time you would lose HP."),

        // ---- Watcher starters / commons (returning in STS2) ----
        "strike_purple": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_purple": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "eruption": .init(name: "Eruption", cost: "2", type: "attack",
            effect: "Deal 9 damage. Enter Wrath."),
        "vigilance": .init(name: "Vigilance", cost: "2", type: "skill",
            effect: "Gain 8 Block. Enter Calm."),

        // ---- Necrobinder (NEW STS2 character) — best-effort current as
        // ---- of v0.105.0. Effects normalized to STS2 wording.
        "strike_necrobinder": .init(name: "Strike", cost: "1", type: "attack",
            effect: "Deal 6 damage."),
        "defend_necrobinder": .init(name: "Defend", cost: "1", type: "skill",
            effect: "Gain 5 Block."),
        "bind_thrall": .init(name: "Bind Thrall", cost: "1", type: "skill",
            effect: "Summon 1 Thrall (basic minion). Necrobinder mechanic."),
        "necromancers_grasp": .init(name: "Necromancer's Grasp", cost: "1", type: "attack",
            effect: "Deal 8 damage. If a Thrall is bound, deal +4."),
        "soul_drain": .init(name: "Soul Drain", cost: "2", type: "attack",
            effect: "Deal 11 damage. Heal 2 HP."),
        "raise_dead": .init(name: "Raise Dead", cost: "1", type: "power",
            effect: "Whenever an enemy dies, summon 1 Thrall."),
        "bone_shard": .init(name: "Bone Shard", cost: "0", type: "attack",
            effect: "Deal 4 damage. Exhaust."),
    ]

    // MARK: - Relic entries
    //
    // Same shape — name + brief effect. We include the starter relic for
    // each character (so the model knows "yes the player has Cracked
    // Core, that means they start each combat channeling 1 Lightning")
    // plus the most-frequently-seen relics. Fewer entries here than
    // cards because relic count per run is small and the prompt is
    // already tight.

    static let relics: [String: Entry] = [
        // Starter relics
        "burning_blood": .init(name: "Burning Blood", cost: "—", type: "starter",
            effect: "Ironclad starter. End of combat: heal 6 HP."),
        "ring_of_the_snake": .init(name: "Ring of the Snake", cost: "—", type: "starter",
            effect: "Silent starter. Start of combat: draw 2 extra cards."),
        "cracked_core": .init(name: "Cracked Core", cost: "—", type: "starter",
            effect: "Defect starter. Start of combat: channel 1 Lightning."),
        "pure_water": .init(name: "PureWater", cost: "—", type: "starter",
            effect: "Watcher starter. Start of combat: shuffle 1 Miracle into hand."),
        "soul_anchor": .init(name: "Soul Anchor", cost: "—", type: "starter",
            effect: "Necrobinder starter. Start of combat: summon 1 Thrall."),

        // Common relics
        "akabeko": .init(name: "Akabeko", cost: "—", type: "common",
            effect: "First Attack each combat deals +8 damage."),
        "anchor": .init(name: "Anchor", cost: "—", type: "common",
            effect: "Start of combat: gain 10 Block."),
        "bag_of_marbles": .init(name: "Bag of Marbles", cost: "—", type: "common",
            effect: "Start of combat: apply 1 Vulnerable to ALL enemies."),
        "bag_of_preparation": .init(name: "Bag of Preparation", cost: "—", type: "common",
            effect: "Start of combat: draw 2 extra cards."),
        "blood_vial": .init(name: "Blood Vial", cost: "—", type: "common",
            effect: "End of combat: heal 2 HP."),
        "lantern": .init(name: "Lantern", cost: "—", type: "common",
            effect: "Start of each combat: gain 1 Energy this turn."),
        "oddly_smooth_stone": .init(name: "Oddly Smooth Stone", cost: "—", type: "common",
            effect: "Start of combat: gain 1 Dexterity."),
        "vajra": .init(name: "Vajra", cost: "—", type: "common",
            effect: "Start of combat: gain 1 Strength."),
        "whetstone": .init(name: "Whetstone", cost: "—", type: "boss",
            effect: "On pickup: upgrade 2 random Attack cards."),
        "war_paint": .init(name: "War Paint", cost: "—", type: "boss",
            effect: "On pickup: upgrade 2 random Skill cards."),

        // Uncommon
        "pen_nib": .init(name: "Pen Nib", cost: "—", type: "uncommon",
            effect: "Every 10th Attack you play deals double damage."),
        "shuriken": .init(name: "Shuriken", cost: "—", type: "uncommon",
            effect: "Every 3rd Attack each combat: gain 1 Strength."),
        "ornamental_fan": .init(name: "Ornamental Fan", cost: "—", type: "uncommon",
            effect: "Every 3rd Attack each combat: gain 4 Block."),
        "kunai": .init(name: "Kunai", cost: "—", type: "uncommon",
            effect: "Every 3rd Attack each combat: gain 1 Dexterity."),
        "letter_opener": .init(name: "Letter Opener", cost: "—", type: "uncommon",
            effect: "Every 3rd Skill each combat: deal 5 damage to ALL enemies."),

        // Rare / boss
        "bird_faced_urn": .init(name: "Bird-Faced Urn", cost: "—", type: "rare",
            effect: "Whenever you play a Power, heal 2 HP."),
        "calling_bell": .init(name: "Calling Bell", cost: "—", type: "shop",
            effect: "Curse + 3 unique relics on pickup. Curse cannot be removed."),
        "philosopher_stone": .init(name: "Philosopher's Stone", cost: "—", type: "boss",
            effect: "+1 Energy each turn. ALL enemies gain 1 Strength at combat start."),
        "runic_pyramid": .init(name: "Runic Pyramid", cost: "—", type: "boss",
            effect: "End of turn: do not discard your hand."),
        "snecko_eye": .init(name: "Snecko Eye", cost: "—", type: "boss",
            effect: "Draw 2 extra cards each turn. You start each combat Confused."),
        "sozu": .init(name: "Sozu", cost: "—", type: "boss",
            effect: "+1 Energy each turn. You can no longer obtain potions."),
        "velvet_choker": .init(name: "Velvet Choker", cost: "—", type: "boss",
            effect: "+1 Energy each turn. You can only play 6 cards per turn."),
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
            case "watcher":      return "purple"
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
