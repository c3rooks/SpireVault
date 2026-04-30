import Foundation
import VaultCore

// MARK: - Wire-format models
//
// These are the exact shapes that travel between The Vault macOS app and the
// matchmaking Worker. The product is a presence feed: "who has The Vault
// open right now and how can I reach them?" — not a lobby system. We do not
// host games; players coordinate the actual STS2 multiplayer invite over
// Steam or Discord after finding each other here.

/// Public-ish profile shown in the presence feed. The Steam fields come from
/// Steam OpenID + Steam Web API on the server side; `discordHandle` is
/// user-supplied and entirely optional.
public struct PlayerProfile: Codable, Hashable, Identifiable {
    public var id: String { steamID }
    public var steamID: String
    public var personaName: String
    public var avatarURL: String?
    public var discordHandle: String?
    public var stats: PlayerStats?

    public init(steamID: String, personaName: String, avatarURL: String? = nil,
                discordHandle: String? = nil, stats: PlayerStats? = nil) {
        self.steamID = steamID
        self.personaName = personaName
        self.avatarURL = avatarURL
        self.discordHandle = discordHandle
        self.stats = stats
    }
}

public struct PlayerStats: Codable, Hashable {
    public var totalRuns: Int
    public var wins: Int
    public var maxAscension: Int
    public var preferredCharacter: String?
    public var winrate: Double { totalRuns == 0 ? 0 : Double(wins) / Double(totalRuns) }
    public var skillTier: SkillTier { SkillTier.from(maxAscension: maxAscension, winrate: winrate) }

    public init(totalRuns: Int, wins: Int, maxAscension: Int, preferredCharacter: String? = nil) {
        self.totalRuns = totalRuns
        self.wins = wins
        self.maxAscension = maxAscension
        self.preferredCharacter = preferredCharacter
    }
}

public enum SkillTier: String, Codable, CaseIterable {
    case learning, climber, ascendant, master

    public var label: String {
        switch self {
        case .learning:  return "Learning"
        case .climber:   return "Climber"
        case .ascendant: return "Ascendant"
        case .master:    return "Master"
        }
    }

    public var ascensionRange: String {
        switch self {
        case .learning:  return "A0–A2"
        case .climber:   return "A3–A6"
        case .ascendant: return "A7–A12"
        case .master:    return "A13+"
        }
    }

    public static func from(maxAscension: Int, winrate: Double) -> SkillTier {
        switch maxAscension {
        case ..<3:   return .learning
        case 3..<7:  return .climber
        case 7..<13: return .ascendant
        default:     return .master
        }
    }
}

// MARK: - Presence

/// What the user wants other people to read into their entry. Free-form text
/// lives in `note`; this is the structured filterable signal.
public enum PresenceStatus: String, Codable, CaseIterable, Identifiable {
    case looking   // available to play co-op right now
    case inRun     // playing solo, don't interrupt
    case inCoop    // already in a co-op run
    case afk       // around but not at the desk

    public var id: Self { self }

    public var label: String {
        switch self {
        case .looking: return "Looking for co-op"
        case .inRun:   return "In a solo run"
        case .inCoop:  return "Already in co-op"
        case .afk:     return "AFK"
        }
    }

    public var shortLabel: String {
        switch self {
        case .looking: return "LOOKING"
        case .inRun:   return "SOLO RUN"
        case .inCoop:  return "IN CO-OP"
        case .afk:     return "AFK"
        }
    }

    public var hint: String {
        switch self {
        case .looking: return "Show me as available — I want to play right now"
        case .inRun:   return "Visible but not pingable — I'm focused on a solo climb"
        case .inCoop:  return "Already partnered up. Wave but don't expect a reply"
        case .afk:     return "Around but stepped away from the keyboard"
        }
    }
}

/// A single live entry in the presence feed. One per signed-in user; refreshed
/// by an in-app heartbeat and auto-expired by the server after a few minutes
/// of silence so stale entries can never accumulate.
public struct PresenceEntry: Codable, Hashable, Identifiable {
    public var id: String { steamID }
    public var steamID: String
    public var personaName: String
    public var avatarURL: String?
    public var discordHandle: String?
    public var stats: PlayerStats?
    public var status: PresenceStatus
    /// Free-form 140-char message. "DM me on Discord", "joining @SpireFan",
    /// "voice optional", whatever they want to say.
    public var note: String
    /// Server-derived: true if this player is currently running Slay the Spire 2
    /// according to the Steam Web API. Helpful colour for the UI ("they're
    /// already in-game, ask for an invite").
    public var inSTS2: Bool
    public var updatedAt: Date

    public init(steamID: String, personaName: String, avatarURL: String? = nil,
                discordHandle: String? = nil, stats: PlayerStats? = nil,
                status: PresenceStatus = .looking, note: String = "",
                inSTS2: Bool = false, updatedAt: Date = Date()) {
        self.steamID = steamID
        self.personaName = personaName
        self.avatarURL = avatarURL
        self.discordHandle = discordHandle
        self.stats = stats
        self.status = status
        self.note = note
        self.inSTS2 = inSTS2
        self.updatedAt = updatedAt
    }
}

/// Body for `POST /presence` — what the client sends on each heartbeat.
/// Server fills `inSTS2`, `updatedAt`, and `avatarURL` if it can resolve them
/// from Steam. The host SteamID is always read from the session, never trusted
/// from the body.
public struct PresenceUpsert: Codable {
    public var status: PresenceStatus
    public var note: String
    public var discordHandle: String?
    public var stats: PlayerStats?

    public init(status: PresenceStatus, note: String,
                discordHandle: String? = nil, stats: PlayerStats? = nil) {
        self.status = status
        self.note = note
        self.discordHandle = discordHandle
        self.stats = stats
    }
}
