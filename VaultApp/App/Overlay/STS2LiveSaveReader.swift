import Foundation
import VaultCore

// =========================================================================
// STS2LiveSaveReader
// -------------------------------------------------------------------------
// Reads the *live* Slay the Spire 2 save (`current_run.save`) and turns
// it into a structured `LiveRunSnapshot` the overlay AI can stuff into
// its prompt. This is the difference between the coach guessing from a
// blurry screenshot and the coach knowing exactly:
//
//   * Defect, Ascension 6, floor 12, 57/75 HP, 145 gold
//   * Deck (with upgrades): 4 strikes, 4 defends, bash+1, ironwave, ...
//   * Relics: cracked_core, pen_nib (5/9), bag_of_marbles, ...
//   * Game mode: daily / standard / custom
//   * Modifiers: double_time, flight, ...
//   * Last visited room type: combat / shop / event
//
// All from a JSON file the user is already letting us read for the rest
// of the app. No memory injection, no DLL hooks, no Cheat Engine.
//
// Loading model: lazy + on-demand. The overlay calls
// `snapshot(saveFolder:)` right before each prompt build. Reading
// `current_run.save` is a few KB of JSON — well under a millisecond on
// any Mac shipped this decade — so caching for "performance" would just
// add staleness bugs. We cache for ~2 seconds anyway to coalesce the
// rapid-fire chip clicks the user might do ("Card pick", then immediately
// "Why?"), and we expose `forceRefresh:` to bypass when the user
// explicitly hits the refresh button in settings.
// =========================================================================

@MainActor
final class STS2LiveSaveReader {

    // MARK: - Snapshot model

    struct LiveRunSnapshot: Equatable {
        let inProgress: Bool
        let character: String?
        let ascension: Int?
        let floor: Int
        let act: Int?
        let currentHP: Int?
        let maxHP: Int?
        let gold: Int?
        let seed: String?
        let gameMode: String?
        let modifiers: [String]
        /// Card identifiers, lower-cased, with `+N` upgrade suffix. Counts
        /// are preserved (a deck with 4 strikes appears as 4 entries).
        let deck: [String]
        let relics: [String]
        let potions: [String]
        let lastRoomType: String?
        let pathTail: [(floor: Int, type: String)]
        let buildID: String?
        let schemaVersion: Int?
        /// File modification time so the overlay can show "as of 18s ago"
        /// when the user wonders whether the snapshot is fresh.
        let fileModifiedAt: Date?
        let sourceURL: URL?

        static func == (lhs: LiveRunSnapshot, rhs: LiveRunSnapshot) -> Bool {
            // Equatable so SwiftUI views holding @Published snapshots
            // don't redraw on identical re-reads. Compare the small set
            // of headline fields — full deck/relic equality on every
            // tick is wasteful and the state-machine drivers downstream
            // only care about the headline anyway.
            lhs.inProgress == rhs.inProgress
                && lhs.character == rhs.character
                && lhs.ascension == rhs.ascension
                && lhs.floor == rhs.floor
                && lhs.currentHP == rhs.currentHP
                && lhs.maxHP == rhs.maxHP
                && lhs.gold == rhs.gold
                && lhs.deck == rhs.deck
                && lhs.relics == rhs.relics
                && lhs.lastRoomType == rhs.lastRoomType
                && lhs.gameMode == rhs.gameMode
                && lhs.modifiers == rhs.modifiers
        }
    }

    // MARK: - Cache

    private var cached: LiveRunSnapshot?
    private var cachedAt: Date = .distantPast
    private let cacheTTL: TimeInterval = 2.0

    init() {}

    /// Find and parse `current_run.save`, returning a snapshot or nil if
    /// no live run is on disk. Looks in (in order):
    ///   1. `<saveFolder>/profile1/saves/current_run.save`
    ///   2. `<saveFolder>/saves/current_run.save`
    ///   3. Recursive search up to depth 3 (handles odd Steam Cloud
    ///      layouts and user-renamed profile dirs).
    func snapshot(saveFolder: URL?, forceRefresh: Bool = false) -> LiveRunSnapshot? {
        if !forceRefresh,
           let cached, Date().timeIntervalSince(cachedAt) < cacheTTL {
            return cached
        }
        guard let folder = saveFolder ?? SaveFolderLocator.resolve() else {
            return nil
        }
        guard let saveURL = locateCurrentRunSave(in: folder) else {
            cached = nil
            cachedAt = Date()
            return nil
        }
        guard let data = try? Data(contentsOf: saveURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: saveURL.path)
        let modAt = attrs?[.modificationDate] as? Date
        let snap = parse(obj: obj, sourceURL: saveURL, modifiedAt: modAt)
        cached = snap
        cachedAt = Date()
        return snap
    }

    /// Force-evict the cache. Call after the user hits a manual refresh.
    func invalidate() {
        cached = nil
        cachedAt = .distantPast
    }

    // MARK: - Locate

    private func locateCurrentRunSave(in folder: URL) -> URL? {
        let fm = FileManager.default
        let candidates: [URL] = [
            folder.appendingPathComponent("profile1/saves/current_run.save"),
            folder.appendingPathComponent("saves/current_run.save"),
            folder.appendingPathComponent("current_run.save"),
        ]
        for c in candidates where fm.fileExists(atPath: c.path) {
            return c
        }
        // Last resort: a bounded recursive walk. STS2 only has a few
        // dozen files in the save dir so this is cheap.
        if let walker = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) {
            var checked = 0
            for case let url as URL in walker {
                checked += 1
                if checked > 400 { break }
                if url.lastPathComponent.lowercased() == "current_run.save" {
                    return url
                }
            }
        }
        return nil
    }

    // MARK: - Parse

    private func parse(obj: [String: Any], sourceURL: URL, modifiedAt: Date?) -> LiveRunSnapshot? {
        // Fingerprint identical to the JS / Swift parsers: must have a
        // `players[0]` and a `map_point_history` array. Otherwise this is
        // a profile / settings save and we should give up cleanly.
        guard let players = obj["players"] as? [[String: Any]],
              let player = players.first,
              let mapHistory = obj["map_point_history"] as? [[Any]] else {
            return nil
        }

        let inProgress: Bool = {
            // Rule 1: filename says current_run.save → live, full stop.
            if sourceURL.lastPathComponent.lowercased().contains("current_run") {
                return true
            }
            // Rule 2: explicit win field present → completed run.
            if obj["win"] is Bool { return false }
            if let i = obj["win"] as? Int, i == 0 || i == 1 { return false }
            // Rule 3: was_abandoned + killed_by_encounter → completed.
            if (obj["was_abandoned"] as? Bool) == true { return false }
            if (obj["killed_by_encounter"] as? String)?.isEmpty == false { return false }
            return true
        }()

        var floor = 0
        var pathTail: [(Int, String)] = []
        var lastRoomType: String?
        var lastStats: [String: Any]?
        var actCount = 0
        for act in mapHistory {
            actCount += 1
            for case let point as [String: Any] in act {
                floor += 1
                let roomType = (point["rooms"] as? [[String: Any]])?.first?["room_type"] as? String
                let mapType  = point["map_point_type"] as? String
                let type = liveRoomType(room: roomType, mapPoint: mapType)
                lastRoomType = type
                pathTail.append((floor, type))
                if let stats = (point["player_stats"] as? [[String: Any]])?.first {
                    lastStats = stats
                }
            }
        }
        // Keep only the last six floors of path so the prompt stays
        // small. The model never needs the full act-1 trail when
        // deciding a turn-three combat play.
        if pathTail.count > 6 { pathTail = Array(pathTail.suffix(6)) }

        let currentHP: Int? =
            (player["current_hp"] as? Int)
            ?? (lastStats?["current_hp"] as? Int)
        let maxHP: Int? =
            (player["max_hp"] as? Int)
            ?? (lastStats?["max_hp"] as? Int)
        let gold: Int? =
            (player["gold"] as? Int)
            ?? (player["current_gold"] as? Int)
            ?? (lastStats?["current_gold"] as? Int)

        var deck: [String] = []
        if let cards = player["deck"] as? [[String: Any]] {
            for c in cards {
                guard let raw = c["id"] as? String else { continue }
                let stripped = stripPrefix("CARD.", raw).lowercased()
                let upgrade = (c["current_upgrade_level"] as? Int) ?? 0
                deck.append(upgrade > 0 ? "\(stripped)+\(upgrade)" : stripped)
            }
        }

        var relics: [String] = []
        if let rs = player["relics"] as? [[String: Any]] {
            for r in rs {
                if let id = r["id"] as? String {
                    relics.append(stripPrefix("RELIC.", id).lowercased())
                }
            }
        }

        var potions: [String] = []
        if let ps = player["potions"] as? [[String: Any]] {
            for p in ps {
                if let id = p["id"] as? String {
                    potions.append(stripPrefix("POTION.", id).lowercased())
                }
            }
        }

        // Modifiers can be `["MODIFIER.X"]` or `[{"id":"MODIFIER.X"}]`.
        var modifiers: [String] = []
        if let raw = obj["modifiers"] as? [Any] {
            for m in raw {
                if let s = m as? String {
                    modifiers.append(stripPrefix("MODIFIER.", s).lowercased())
                } else if let dict = m as? [String: Any], let id = dict["id"] as? String {
                    modifiers.append(stripPrefix("MODIFIER.", id).lowercased())
                }
            }
        }

        let character: String? = {
            if let s = player["character"] as? String { return stripPrefix("CHARACTER.", s).lowercased() }
            if let s = obj["character"] as? String { return stripPrefix("CHARACTER.", s).lowercased() }
            if let dict = player["character"] as? [String: Any], let s = dict["id"] as? String {
                return stripPrefix("CHARACTER.", s).lowercased()
            }
            return nil
        }()

        let mode: String? = {
            guard let m = obj["game_mode"] as? String, !m.isEmpty else { return nil }
            return m.lowercased()
        }()

        let snap = LiveRunSnapshot(
            inProgress: inProgress,
            character: character,
            ascension: obj["ascension"] as? Int,
            floor: floor,
            act: actCount > 0 ? actCount : nil,
            currentHP: currentHP,
            maxHP: maxHP,
            gold: gold,
            seed: obj["seed"] as? String,
            gameMode: mode,
            modifiers: modifiers,
            deck: deck,
            relics: relics,
            potions: potions,
            lastRoomType: lastRoomType,
            pathTail: pathTail,
            buildID: obj["build_id"] as? String,
            schemaVersion: obj["schema_version"] as? Int,
            fileModifiedAt: modifiedAt,
            sourceURL: sourceURL
        )
        return snap
    }

    // MARK: - Helpers

    private func stripPrefix(_ prefix: String, _ raw: String) -> String {
        raw.hasPrefix(prefix) ? String(raw.dropFirst(prefix.count)) : raw
    }

    private func liveRoomType(room: String?, mapPoint: String?) -> String {
        switch (mapPoint ?? "").lowercased() {
        case "boss":  return "boss"
        case "elite": return "elite"
        case "shop":  return "shop"
        default: break
        }
        switch (room ?? "").lowercased() {
        case "monster", "combat":   return "combat"
        case "elite":               return "elite"
        case "boss":                return "boss"
        case "shop":                return "shop"
        case "event":               return "event"
        case "rest", "campfire":    return "rest"
        case "ancient", "treasure": return "chest"
        default: return "unknown"
        }
    }
}

// =========================================================================
// LiveRunSnapshot rendering helpers
// -------------------------------------------------------------------------
// Two consumers want pretty strings off the snapshot:
//   * The overlay UI (live-run header + footer in the chat panel).
//   * The AI prompt builder (a compact YAML-ish block injected into
//     the system prompt so the model knows the actual game state).
// We keep both renderings adjacent to the type so they never drift.
// =========================================================================

extension STS2LiveSaveReader.LiveRunSnapshot {

    /// Tight summary suitable for the pill / header.
    /// e.g. "Defect A6 · Floor 12 · 57/75 HP · 145g"
    var headlineLine: String {
        var bits: [String] = []
        if let c = character?.capitalized { bits.append(c) }
        if let a = ascension { bits.append("A\(a)") }
        bits.append("F\(floor)")
        if let hp = currentHP, let max = maxHP {
            bits.append("\(hp)/\(max) HP")
        }
        if let g = gold { bits.append("\(g)g") }
        return bits.joined(separator: " · ")
    }

    /// Two-line summary for the expanded header:
    ///   "Defect · Ascension 6"
    ///   "Floor 12 · 57/75 HP · 145g · last room: shop"
    var subtitleLine: String {
        var bits: [String] = []
        bits.append("Floor \(floor)")
        if let hp = currentHP, let max = maxHP { bits.append("\(hp)/\(max) HP") }
        if let g = gold { bits.append("\(g)g") }
        if let room = lastRoomType, room != "unknown" { bits.append("last room: \(room)") }
        return bits.joined(separator: " · ")
    }

    var modeBadge: String? {
        guard let m = gameMode, m != "standard", m != "normal" else { return nil }
        return m.capitalized + " run"
    }

    /// Compact prompt block. Designed to be small enough that it fits
    /// in any model's context budget while still giving the LLM enough
    /// to give specific, non-generic advice.
    func promptBlock() -> String {
        var lines: [String] = ["[live-run-snapshot]"]
        if !inProgress {
            lines.append("status: no live run on disk (suggest the player launch / continue a run)")
            return lines.joined(separator: "\n")
        }
        if let c = character { lines.append("character: \(c)") }
        if let a = ascension { lines.append("ascension: A\(a)") }
        lines.append("floor: \(floor)")
        if let act { lines.append("act: \(act)") }
        if let hp = currentHP, let max = maxHP { lines.append("hp: \(hp)/\(max)") }
        if let g = gold { lines.append("gold: \(g)") }
        if let m = gameMode { lines.append("game_mode: \(m)") }
        if !modifiers.isEmpty { lines.append("modifiers: " + modifiers.joined(separator: ", ")) }
        if let room = lastRoomType, room != "unknown" {
            lines.append("last_visited_room: \(room)")
        }
        if !pathTail.isEmpty {
            let tail = pathTail.map { "F\($0.floor):\($0.type)" }.joined(separator: " → ")
            lines.append("path_tail: \(tail)")
        }
        if !relics.isEmpty {
            lines.append("relics: " + relics.joined(separator: ", "))
        }
        if !potions.isEmpty {
            lines.append("potions: " + potions.joined(separator: ", "))
        }
        if !deck.isEmpty {
            // Rolled-up frequency view so a 25-card deck doesn't take 25
            // separate lines. "strike x4 · defend x4 · bash+1 · iron_wave"
            let rollup = rollUp(cards: deck)
            lines.append("deck (\(deck.count)): " + rollup)
        }
        if let mod = fileModifiedAt {
            let age = Int(max(0, -mod.timeIntervalSinceNow))
            lines.append("snapshot_age_s: \(age)")
        }
        return lines.joined(separator: "\n")
    }

    private func rollUp(cards: [String]) -> String {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for c in cards {
            if counts[c] == nil { order.append(c) }
            counts[c, default: 0] += 1
        }
        return order.map { id in
            let n = counts[id] ?? 1
            return n > 1 ? "\(id) ×\(n)" : id
        }.joined(separator: " · ")
    }
}
