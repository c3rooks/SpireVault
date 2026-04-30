import Foundation

/// Pure-data filter applied in `vault export` / `vault stats` so users can
/// slice history without exporting first. Everything is optional — a default
/// `RunFilter()` matches every run.
public struct RunFilter {
    public var character: Character?
    public var minAscension: Int?
    public var maxAscension: Int?
    public var won: Bool?
    public var since: Date?
    public var until: Date?

    public init(
        character: Character? = nil,
        minAscension: Int? = nil,
        maxAscension: Int? = nil,
        won: Bool? = nil,
        since: Date? = nil,
        until: Date? = nil
    ) {
        self.character = character
        self.minAscension = minAscension
        self.maxAscension = maxAscension
        self.won = won
        self.since = since
        self.until = until
    }

    public func matches(_ r: RunRecord) -> Bool {
        if let character, r.character != character { return false }
        if let minAscension, (r.ascension ?? Int.min) < minAscension { return false }
        if let maxAscension, (r.ascension ?? Int.max) > maxAscension { return false }
        if let won, r.won != won { return false }
        if let since, (r.endedAt ?? r.startedAt ?? r.parsedAt) < since { return false }
        if let until, (r.endedAt ?? r.startedAt ?? r.parsedAt) > until { return false }
        return true
    }

    public func apply(_ runs: [RunRecord]) -> [RunRecord] {
        runs.filter(matches)
    }

    /// Parse a relative-date token like "7d", "24h", "30d" into an absolute Date in the past.
    public static func parseRelativeSince(_ token: String, now: Date = Date()) -> Date? {
        guard let last = token.last else { return nil }
        let head = String(token.dropLast())
        guard let n = Double(head) else { return nil }
        switch last {
        case "h": return now.addingTimeInterval(-n * 3600)
        case "d": return now.addingTimeInterval(-n * 86400)
        case "w": return now.addingTimeInterval(-n * 7 * 86400)
        default:  return nil
        }
    }
}
