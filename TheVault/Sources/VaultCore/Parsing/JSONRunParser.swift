import Foundation

/// Parses STS2 run files that are plain JSON. STS2 has been observed shipping
/// run history as JSON in the user data folder (subject to change every patch),
/// so this is the most likely happy path.
///
/// The mapping is intentionally tolerant: we never assume a key is present,
/// and we keep a copy of the raw object on `RunRecord.raw` so nothing is lost.
public struct JSONRunParser: RunFormatParser {

    public init() {}

    public func canHandle(url: URL, head: Data) -> Bool {
        if url.pathExtension.lowercased() == "json" { return true }
        // Sniff: only `{` — `[` collides with Godot section headers and we
        // never expect a top-level JSON array for a single run record anyway.
        let stripped = stripBOM(head)
        guard let first = stripped.first else { return false }
        return first == 0x7B /* { */
    }

    public func parse(url: URL, data: Data) throws -> RunRecord? {
        let stripped = stripBOM(data)
        guard let any = try JSONSerialization.jsonObject(with: stripped, options: [.fragmentsAllowed]) as? [String: Any] else {
            return nil
        }
        // Refuse to produce an empty record from an account-level file
        // (`progress.save`, `prefs.save`, …). If none of the run-shaped fields
        // are present, return nil so the caller skips this file.
        let runShapedKeys: Set<String> = [
            "run_id", "uuid", "character", "class", "ascension", "victory", "won",
            "floor_reached", "max_floor", "card_choices", "card_picks", "deck_at_end",
            "master_deck", "started_at", "ended_at", "timestamp_end", "play_time_seconds",
            "playtime_seconds"
        ]
        if Set(any.keys).intersection(runShapedKeys).isEmpty {
            return nil
        }
        return Self.recordFromObject(any, sourceFile: url.lastPathComponent)
    }

    // MARK: - Mapping

    /// Public + static so tests and adapters can call it directly without spinning up a parser.
    public static func recordFromObject(_ obj: [String: Any], sourceFile: String) -> RunRecord {
        let id = string(obj, "run_id", "id", "uuid")
            ?? "\(string(obj, "seed") ?? UUID().uuidString)-\(int(obj, "ended_at", "timestamp_end") ?? Int(Date().timeIntervalSince1970))"

        let character = Character.from(string(obj, "character", "class", "character_class"))
        let ascension = int(obj, "ascension", "ascension_level")
        let seed = string(obj, "seed")
        let won = bool(obj, "victory", "won", "victorious")
        let floor = int(obj, "floor_reached", "floor", "max_floor")
        let playTime = int(obj, "play_time_seconds", "playtime_seconds", "playtime", "elapsed_seconds")
        let started = date(obj, "started_at", "timestamp_start", "start_time")
        let ended = date(obj, "ended_at", "timestamp_end", "end_time")

        let deck = stringArray(obj, "deck_at_end", "master_deck", "deck", "final_deck")
            .map(Self.normalizeID)
        let relics = stringArray(obj, "relics", "relic_ids", "relics_obtained")
            .map(Self.normalizeID)
        let potions = stringArray(obj, "potions", "potion_ids")
            .map(Self.normalizeID)

        let cardPicks = parseCardPicks(obj["card_choices"] ?? obj["card_picks"])
        let relicPicks = parseRelicPicks(obj["relic_choices"] ?? obj["relic_picks"])

        let maxHP = int(obj, "max_hp", "max_health")
        let curHP = int(obj, "current_hp", "current_health")
        let gold = int(obj, "gold")

        let raw = obj.mapValues { AnyCodable($0) }

        return RunRecord(
            id: id,
            sourceFile: sourceFile,
            character: character,
            ascension: ascension,
            seed: seed,
            won: won,
            floorReached: floor,
            playTimeSeconds: playTime,
            startedAt: started,
            endedAt: ended,
            deckAtEnd: deck,
            relics: relics,
            potions: potions,
            cardPicks: cardPicks,
            relicPicks: relicPicks,
            maxHP: maxHP,
            currentHP: curHP,
            gold: gold,
            raw: raw
        )
    }

    static func normalizeID(_ raw: String) -> String {
        raw.lowercased()
            .replacingOccurrences(of: " ", with: "_")
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: "+", with: "_plus")
    }

    // MARK: - Helpers

    private static func parseCardPicks(_ any: Any?) -> [CardPick] {
        guard let array = any as? [[String: Any]] else { return [] }
        return array.map { entry in
            CardPick(
                floor: int(entry, "floor"),
                offered: stringArray(entry, "offered", "options", "choices").map(Self.normalizeID),
                picked: string(entry, "picked", "chosen", "taken").map(Self.normalizeID),
                source: pickSource(string(entry, "source", "from"))
            )
        }
    }

    private static func parseRelicPicks(_ any: Any?) -> [RelicPick] {
        guard let array = any as? [[String: Any]] else { return [] }
        return array.compactMap { entry in
            guard let rid = string(entry, "relic", "relic_id", "id") else { return nil }
            return RelicPick(
                floor: int(entry, "floor"),
                relicID: Self.normalizeID(rid),
                source: pickSource(string(entry, "source", "from"))
            )
        }
    }

    private static func pickSource(_ s: String?) -> PickSource? {
        guard let s = s?.lowercased() else { return nil }
        switch s {
        case "combat", "combat_reward", "fight": return .combatReward
        case "elite", "elite_reward": return .eliteReward
        case "boss", "boss_reward": return .bossReward
        case "shop", "merchant": return .shop
        case "event": return .event
        case "neow", "ancient": return .neow
        case "chest", "treasure": return .chest
        default: return .unknown
        }
    }

    // MARK: - Field accessors (variadic-keys, type-coerced)
    //
    // All helpers treat `NSNull` and missing keys identically — that's how
    // `null` lands in our objects after JSONSerialization, and we never want
    // to leak a literal "<null>" string into card / relic ids.

    private static func string(_ d: [String: Any], _ keys: String...) -> String? {
        for k in keys {
            guard let v = d[k], !(v is NSNull) else { continue }
            if let s = v as? String { return s }
            return String(describing: v)
        }
        return nil
    }

    private static func int(_ d: [String: Any], _ keys: String...) -> Int? {
        for k in keys {
            guard let v = d[k], !(v is NSNull) else { continue }
            if let i = v as? Int { return i }
            if let d = v as? Double { return Int(d) }
            if let s = v as? String, let i = Int(s) { return i }
        }
        return nil
    }

    private static func bool(_ d: [String: Any], _ keys: String...) -> Bool? {
        for k in keys {
            guard let v = d[k], !(v is NSNull) else { continue }
            if let b = v as? Bool { return b }
            if let i = v as? Int { return i != 0 }
            if let s = v as? String { return ["true", "1", "yes", "won", "victory"].contains(s.lowercased()) }
        }
        return nil
    }

    private static func date(_ d: [String: Any], _ keys: String...) -> Date? {
        for k in keys {
            guard let v = d[k], !(v is NSNull) else { continue }
            if let i = v as? Int { return Date(timeIntervalSince1970: TimeInterval(i)) }
            if let dbl = v as? Double { return Date(timeIntervalSince1970: dbl) }
            if let s = v as? String, let dbl = Double(s) { return Date(timeIntervalSince1970: dbl) }
            if let s = v as? String, let parsed = ISO8601DateFormatter().date(from: s) { return parsed }
        }
        return nil
    }

    private static func stringArray(_ d: [String: Any], _ keys: String...) -> [String] {
        for k in keys {
            guard let arr = d[k] as? [Any] else { continue }
            return arr.compactMap { item in
                if item is NSNull { return nil }
                if let s = item as? String { return s }
                if let dict = item as? [String: Any], let id = dict["id"] as? String { return id }
                return nil
            }
        }
        return []
    }

    private func stripBOM(_ data: Data) -> Data {
        if data.starts(with: [0xEF, 0xBB, 0xBF]) { return data.dropFirst(3) }
        return data
    }

    private static func stripBOM(_ data: Data) -> Data {
        if data.starts(with: [0xEF, 0xBB, 0xBF]) { return data.dropFirst(3) }
        return data
    }
}

// File-scope shims used by the static `parseCardPicks` / `parseRelicPicks`
// closures (they can't see private instance helpers, so we duplicate the
// NSNull-aware coercion logic here verbatim).

private func stripBOM(_ data: Data) -> Data {
    if data.starts(with: [0xEF, 0xBB, 0xBF]) { return data.dropFirst(3) }
    return data
}

private func string(_ d: [String: Any], _ keys: String...) -> String? {
    for k in keys {
        guard let v = d[k], !(v is NSNull) else { continue }
        if let s = v as? String { return s }
        return String(describing: v)
    }
    return nil
}

private func int(_ d: [String: Any], _ keys: String...) -> Int? {
    for k in keys {
        guard let v = d[k], !(v is NSNull) else { continue }
        if let i = v as? Int { return i }
        if let d = v as? Double { return Int(d) }
        if let s = v as? String, let i = Int(s) { return i }
    }
    return nil
}

private func stringArray(_ d: [String: Any], _ keys: String...) -> [String] {
    for k in keys {
        guard let arr = d[k] as? [Any] else { continue }
        return arr.compactMap { item in
            if item is NSNull { return nil }
            if let s = item as? String { return s }
            if let dict = item as? [String: Any], let id = dict["id"] as? String { return id }
            return nil
        }
    }
    return []
}
