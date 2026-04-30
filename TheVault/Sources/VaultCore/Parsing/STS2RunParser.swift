import Foundation

/// Parser for the *real* Slay the Spire 2 run save format (`.run` files written
/// to `…/profile1/saves/history/<unix_ts>.run`).
///
/// Schema reference (STS2 build 0.104.x, schema_version 9):
///
/// ```text
/// {
///   "ascension": 6,
///   "seed": "XRFSQVQP53",
///   "start_time": 1777333156,
///   "run_time": 1875,
///   "win": false,
///   "was_abandoned": false,
///   "build_id": "v0.104.0",
///   "killed_by_encounter": "ENCOUNTER.KNIGHTS_ELITE",
///   "schema_version": 9,
///   "acts": ["ACT.UNDERDOCKS", ...],
///   "players": [{
///       "id": 1,
///       "character": "CHARACTER.DEFECT",
///       "badges": [{ "id": "ELITE", "rarity": "bronze" }],
///       "deck":   [{ "id": "CARD.STRIKE_DEFECT", "floor_added_to_deck": 1, ... }],
///       "relics": [{ "id": "RELIC.CRACKED_CORE",  "floor_added_to_deck": 1 }],
///       "potions": [],
///   }],
///   "map_point_history": [[
///       { "map_point_type": "monster",
///         "player_stats": [{
///             "card_choices": [{ "card": {"id":"CARD.X"}, "was_picked": true }],
///             "relic_choices": [{ "choice": "RELIC.X", "was_picked": true }],
///             "current_hp": 54, "max_hp": 75, "current_gold": 114,
///             ...
///         }],
///         "rooms":  [{ "model_id": "EVENT.NEOW", "room_type": "event" }]
///       }, ...
///   ], ...]
/// }
/// ```
///
/// Anything we don't model we keep verbatim under `RunRecord.raw` so future
/// versions can read it without a re-scan.
public struct STS2RunParser: RunFormatParser {

    public init() {}

    public func canHandle(url: URL, head: Data) -> Bool {
        // `.run` is unambiguous. Be permissive on extension but still require
        // a JSON object header so we don't trip on Godot binary saves.
        guard url.pathExtension.lowercased() == "run"
                || url.pathExtension.lowercased() == "json"
                || url.pathExtension.lowercased() == "save"
        else { return false }
        return JSONRunParser.looksLikeJSONObject(head)
    }

    public func parse(url: URL, data: Data) throws -> RunRecord? {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        // STS2 fingerprint: top-level `players` array AND `map_point_history`.
        // If those are missing this is account/profile data (progress.save,
        // settings.save, prefs.save) — bail so the next parser strategy can try.
        guard let players = object["players"] as? [[String: Any]],
              let firstPlayer = players.first,
              let mapHistory = object["map_point_history"] as? [[Any]]
        else {
            return nil
        }

        let runID: String = {
            if let s = object["start_time"] as? Int { return "sts2-\(s)" }
            return "sts2-" + url.deletingPathExtension().lastPathComponent
        }()

        var record = RunRecord(id: runID, sourceFile: url.path)
        record.character = parseCharacter(firstPlayer["character"])
        record.ascension = object["ascension"] as? Int
        record.seed      = object["seed"] as? String
        record.won       = object["win"] as? Bool

        if let st = object["start_time"] as? Int {
            record.startedAt = Date(timeIntervalSince1970: TimeInterval(st))
        }
        if let rt = object["run_time"] as? Int {
            record.playTimeSeconds = rt
            if let st = record.startedAt {
                record.endedAt = st.addingTimeInterval(TimeInterval(rt))
            }
        }

        // Floor reached = total map points actually visited across all acts.
        record.floorReached = mapHistory.reduce(0) { $0 + $1.count }

        // Deck / relics / potions, with id prefixes stripped and lowercased.
        if let deck = firstPlayer["deck"] as? [[String: Any]] {
            record.deckAtEnd = deck.compactMap { item -> String? in
                guard let raw = item["id"] as? String else { return nil }
                let upgrade = (item["current_upgrade_level"] as? Int) ?? 0
                let base = STS2RunParser.normalize(prefix: "CARD.", raw: raw)
                return upgrade > 0 ? "\(base)+\(upgrade)" : base
            }
        }
        if let relics = firstPlayer["relics"] as? [[String: Any]] {
            record.relics = relics.compactMap { ($0["id"] as? String).map { STS2RunParser.normalize(prefix: "RELIC.", raw: $0) } }
        }
        if let potions = firstPlayer["potions"] as? [[String: Any]] {
            record.potions = potions.compactMap { ($0["id"] as? String).map { STS2RunParser.normalize(prefix: "POTION.", raw: $0) } }
        }

        // Card picks per map point. Use the position in `map_point_history`
        // as the floor index (1-based) — STS2 doesn't store an explicit floor
        // number on each pick.
        var cardPicks: [CardPick] = []
        var relicPicks: [RelicPick] = []
        var lastStats: [String: Any]?
        var floor = 0
        for act in mapHistory {
            for case let point as [String: Any] in act {
                floor += 1
                let roomType = (point["rooms"] as? [[String: Any]])?.first?["room_type"] as? String
                let source = STS2RunParser.pickSource(forRoomType: roomType, mapPointType: point["map_point_type"] as? String)

                guard let stats = (point["player_stats"] as? [[String: Any]])?.first else { continue }
                lastStats = stats

                if let choices = stats["card_choices"] as? [[String: Any]] {
                    let offered: [String] = choices.compactMap { c in
                        guard let card = c["card"] as? [String: Any], let id = card["id"] as? String else { return nil }
                        return STS2RunParser.normalize(prefix: "CARD.", raw: id)
                    }
                    let picked: String? = choices.first(where: { ($0["was_picked"] as? Bool) == true })
                        .flatMap { $0["card"] as? [String: Any] }
                        .flatMap { $0["id"] as? String }
                        .map { STS2RunParser.normalize(prefix: "CARD.", raw: $0) }
                    if !offered.isEmpty || picked != nil {
                        cardPicks.append(CardPick(floor: floor, offered: offered, picked: picked, source: source))
                    }
                }

                if let choices = stats["relic_choices"] as? [[String: Any]] {
                    // We only record picked relics; skipped relics are
                    // already implicit in the offered list, and `RelicPick`
                    // doesn't model an "offered but skipped" state.
                    for c in choices where (c["was_picked"] as? Bool) == true {
                        guard let id = c["choice"] as? String else { continue }
                        relicPicks.append(RelicPick(
                            floor: floor,
                            relicID: STS2RunParser.normalize(prefix: "RELIC.", raw: id),
                            source: source
                        ))
                    }
                }
            }
        }
        record.cardPicks = cardPicks
        record.relicPicks = relicPicks

        // End-of-run snapshot — pulled from the last visited map point.
        if let stats = lastStats {
            record.maxHP = stats["max_hp"] as? Int
            record.currentHP = stats["current_hp"] as? Int
            record.gold = stats["current_gold"] as? Int
        }

        // Stash useful unmodeled fields. `was_abandoned` is the one we'll most
        // likely promote next, but for now it stays in raw so consumers can opt
        // in without a schema bump.
        var raw: [String: AnyCodable] = [:]
        for key in ["was_abandoned", "build_id", "game_mode", "killed_by_encounter",
                    "killed_by_event", "schema_version", "modifiers", "platform_type"] {
            if let v = object[key] { raw[key] = AnyCodable(v) }
        }
        if let badges = firstPlayer["badges"] { raw["badges"] = AnyCodable(badges) }
        record.raw = raw.isEmpty ? nil : raw

        record.parsedAt = Date()
        return record
    }

    // MARK: - Helpers

    /// "CARD.STRIKE_DEFECT" → "strike_defect"
    /// "RELIC.CRACKED_CORE" → "cracked_core"
    /// "CHARACTER.DEFECT" → "defect"
    static func normalize(prefix: String, raw: String) -> String {
        var s = raw
        if s.hasPrefix(prefix) { s.removeFirst(prefix.count) }
        return s.lowercased()
    }

    private func parseCharacter(_ value: Any?) -> Character? {
        guard let raw = value as? String else { return nil }
        let stripped = STS2RunParser.normalize(prefix: "CHARACTER.", raw: raw)
        // `Character.from` already handles "ironclad" / "regent" / etc. exactly.
        return Character.from(stripped)
    }

    /// Map STS2 room/point types to our `PickSource` enum so the stats engine
    /// can group correctly.
    private static func pickSource(forRoomType room: String?, mapPointType: String?) -> PickSource {
        switch (mapPointType ?? "").lowercased() {
        case "boss":   return .bossReward
        case "elite":  return .eliteReward
        case "shop":   return .shop
        default: break
        }
        switch (room ?? "").lowercased() {
        case "monster", "combat":   return .combatReward
        case "elite":               return .eliteReward
        case "boss":                return .bossReward
        case "shop":                return .shop
        case "event":               return .event
        case "ancient", "treasure": return .chest
        default: return .unknown
        }
    }
}

// Expose JSON sniff helper for STS2RunParser without duplicating logic.
extension JSONRunParser {
    static func looksLikeJSONObject(_ head: Data) -> Bool {
        var d = head
        if d.starts(with: [0xEF, 0xBB, 0xBF]) { d = d.dropFirst(3) }
        return d.first == 0x7B  // '{'
    }
}
