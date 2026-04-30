import Foundation

/// Canonical Vault run record. This is the format we WRITE — it is intentionally
/// decoupled from whatever shape STS2 happens to use on disk this week.
///
/// Schema is versioned so downstream readers (Ascension Companion, dashboards)
/// can fail loud if they don't understand a future revision.
public struct RunRecord: Codable, Hashable, Identifiable {

    public static let schemaVersion = 1

    public var id: String              // stable run id (seed + timestamp if no native id)
    public var schemaVersion: Int = RunRecord.schemaVersion
    public var sourceFile: String      // basename of the file we parsed (for traceability)
    public var parsedAt: Date          // when Vault wrote this record

    // Core run identity
    public var character: Character?
    public var ascension: Int?
    public var seed: String?
    public var won: Bool?
    public var floorReached: Int?
    public var playTimeSeconds: Int?
    public var startedAt: Date?
    public var endedAt: Date?

    // Snapshots
    public var deckAtEnd: [String]      // card ids (lowercased, snake_case best-effort)
    public var relics: [String]         // relic ids
    public var potions: [String]        // potion ids

    // Per-floor decisions (nil-tolerant — older runs may not have these)
    public var cardPicks: [CardPick]
    public var relicPicks: [RelicPick]

    // Numeric snapshot at end of run
    public var maxHP: Int?
    public var currentHP: Int?
    public var gold: Int?

    // Free-form passthrough so we don't lose data even if we don't model it yet
    public var raw: [String: AnyCodable]?

    public init(
        id: String,
        sourceFile: String,
        parsedAt: Date = Date(),
        character: Character? = nil,
        ascension: Int? = nil,
        seed: String? = nil,
        won: Bool? = nil,
        floorReached: Int? = nil,
        playTimeSeconds: Int? = nil,
        startedAt: Date? = nil,
        endedAt: Date? = nil,
        deckAtEnd: [String] = [],
        relics: [String] = [],
        potions: [String] = [],
        cardPicks: [CardPick] = [],
        relicPicks: [RelicPick] = [],
        maxHP: Int? = nil,
        currentHP: Int? = nil,
        gold: Int? = nil,
        raw: [String: AnyCodable]? = nil
    ) {
        self.id = id
        self.sourceFile = sourceFile
        self.parsedAt = parsedAt
        self.character = character
        self.ascension = ascension
        self.seed = seed
        self.won = won
        self.floorReached = floorReached
        self.playTimeSeconds = playTimeSeconds
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.deckAtEnd = deckAtEnd
        self.relics = relics
        self.potions = potions
        self.cardPicks = cardPicks
        self.relicPicks = relicPicks
        self.maxHP = maxHP
        self.currentHP = currentHP
        self.gold = gold
        self.raw = raw
    }
}

public enum Character: String, Codable, CaseIterable {
    case ironclad
    case silent
    case regent
    case necrobinder
    case defect
    case unknown

    /// Best-effort normalize: case-insensitive, accepts common synonyms.
    public static func from(_ raw: String?) -> Character? {
        guard let raw else { return nil }
        let key = raw.lowercased().replacingOccurrences(of: " ", with: "")
        switch key {
        case "ironclad", "ic": return .ironclad
        case "silent", "si": return .silent
        case "regent", "re", "rg": return .regent
        case "necrobinder", "nb", "binder": return .necrobinder
        case "defect", "df", "de": return .defect
        default: return .unknown
        }
    }
}

public struct CardPick: Codable, Hashable {
    public var floor: Int?
    public var offered: [String]       // card ids that were on offer
    public var picked: String?         // nil = skipped / "Skip"
    public var source: PickSource?     // reward, shop, event, neow

    public init(floor: Int? = nil, offered: [String] = [], picked: String? = nil, source: PickSource? = nil) {
        self.floor = floor
        self.offered = offered
        self.picked = picked
        self.source = source
    }
}

public struct RelicPick: Codable, Hashable {
    public var floor: Int?
    public var relicID: String
    public var source: PickSource?

    public init(floor: Int? = nil, relicID: String, source: PickSource? = nil) {
        self.floor = floor
        self.relicID = relicID
        self.source = source
    }
}

public enum PickSource: String, Codable {
    case combatReward
    case eliteReward
    case bossReward
    case shop
    case event
    case neow
    case chest
    case unknown
}

// MARK: - AnyCodable passthrough

/// Tiny type-erased codable used to carry unmodeled fields through Vault unchanged.
/// Lets us round-trip future STS2 fields without modeling them today.
public struct AnyCodable: Codable, Hashable {
    public let value: Any

    public init(_ value: Any) { self.value = value }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self.value = NSNull()
        } else if let b = try? c.decode(Bool.self) {
            self.value = b
        } else if let i = try? c.decode(Int.self) {
            self.value = i
        } else if let d = try? c.decode(Double.self) {
            self.value = d
        } else if let s = try? c.decode(String.self) {
            self.value = s
        } else if let a = try? c.decode([AnyCodable].self) {
            self.value = a
        } else if let o = try? c.decode([String: AnyCodable].self) {
            self.value = o
        } else {
            self.value = NSNull()
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case is NSNull: try c.encodeNil()
        case let b as Bool: try c.encode(b)
        case let i as Int: try c.encode(i)
        case let d as Double: try c.encode(d)
        case let s as String: try c.encode(s)
        case let a as [AnyCodable]: try c.encode(a)
        case let o as [String: AnyCodable]: try c.encode(o)
        default: try c.encodeNil()
        }
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(String(describing: value))
    }

    public static func == (lhs: AnyCodable, rhs: AnyCodable) -> Bool {
        String(describing: lhs.value) == String(describing: rhs.value)
    }
}
