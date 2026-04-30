import Foundation

/// Result of attempting to parse a single STS2 save file.
public enum ParseOutcome {
    case parsed(RunRecord)
    case skipped(reason: String)
    case failed(error: Error)
}

/// Strategy interface — every concrete format (JSON, Godot ConfigFile, .tres text)
/// implements this. We try them in order and pick the first that succeeds.
public protocol RunFormatParser {
    /// Quick sniff so we don't waste time trying obviously-wrong formats.
    func canHandle(url: URL, head: Data) -> Bool
    /// Attempt full parse. Throw to signal real failure (corrupt, unreadable).
    /// Return nil if the file is the right shape but doesn't represent a completed run.
    func parse(url: URL, data: Data) throws -> RunRecord?
}

/// Top-level facade. Holds a list of strategies, returns the first hit.
public final class SaveFileParser {

    private let strategies: [RunFormatParser]

    public init(strategies: [RunFormatParser] = SaveFileParser.defaultStrategies()) {
        self.strategies = strategies
    }

    public static func defaultStrategies() -> [RunFormatParser] {
        // Order matters: the STS2-specific parser runs first, fast-rejects on
        // anything that doesn't have its fingerprint, and falls through to the
        // generic JSON / Godot parsers used by tests and other formats.
        [
            STS2RunParser(),
            JSONRunParser(),
            GodotConfigParser()
        ]
    }

    public func parse(url: URL) -> ParseOutcome {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return .failed(error: error)
        }
        let head = data.prefix(512)

        // Try each strategy that claims it can handle this file. A throw or nil
        // from one strategy must NOT prevent the next from running — Godot saves
        // and JSON runs frequently look similar to a fast sniff.
        var lastError: Error?
        for strategy in strategies where strategy.canHandle(url: url, head: head) {
            do {
                if let record = try strategy.parse(url: url, data: data) {
                    return .parsed(record)
                }
            } catch {
                lastError = error
                continue
            }
        }
        if let lastError {
            return .failed(error: lastError)
        }
        return .skipped(reason: "no strategy matched \(url.lastPathComponent)")
    }
}
