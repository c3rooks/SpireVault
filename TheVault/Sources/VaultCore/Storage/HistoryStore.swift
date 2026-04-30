import Foundation

/// Append-only JSON store that holds every parsed run.
///
/// Format on disk:
/// ```
/// {
///   "schemaVersion": 1,
///   "generatedAt": "<ISO8601>",
///   "vault": "TheVault/0.1",
///   "runs": [ <RunRecord>, ... ]
///  }
/// ```
///
/// Idempotent: writing the same RunRecord (same `id`) twice is a no-op.
/// We dedupe on `id`, preferring the most recently parsed copy on conflict.
public final class HistoryStore {

    public struct Header: Codable {
        public var schemaVersion: Int
        public var generatedAt: Date
        public var vault: String
    }

    public struct Document: Codable {
        public var header: Header
        public var runs: [RunRecord]
    }

    public let url: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(url: URL) {
        self.url = url
        self.encoder = JSONEncoder()
        self.encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    /// Load existing document, or return a fresh empty one.
    /// Throws `HistoryStoreError.schemaMismatch` if the on-disk schema doesn't match
    /// what we'd write, so we never silently merge incompatible data.
    public func load() throws -> Document {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return Document(
                header: Header(
                    schemaVersion: RunRecord.schemaVersion,
                    generatedAt: Date(),
                    vault: "TheVault/\(VaultVersion.current)"
                ),
                runs: []
            )
        }
        let data = try Data(contentsOf: url)
        let doc = try decoder.decode(Document.self, from: data)
        guard doc.header.schemaVersion == RunRecord.schemaVersion else {
            throw HistoryStoreError.schemaMismatch(found: doc.header.schemaVersion, expected: RunRecord.schemaVersion)
        }
        return doc
    }

    /// Merge new runs with existing ones, write atomically.
    /// Returns the count of NEW runs that were added (i.e. not duplicates).
    @discardableResult
    public func upsert(_ incoming: [RunRecord]) throws -> Int {
        var doc = try load()
        var byID = Dictionary(uniqueKeysWithValues: doc.runs.map { ($0.id, $0) })
        var added = 0
        for record in incoming {
            if byID[record.id] == nil { added += 1 }
            byID[record.id] = record
        }
        doc.runs = byID.values.sorted { lhs, rhs in
            (lhs.endedAt ?? lhs.parsedAt) < (rhs.endedAt ?? rhs.parsedAt)
        }
        doc.header.generatedAt = Date()
        try writeAtomic(doc)
        return added
    }

    private func writeAtomic(_ doc: Document) throws {
        let data = try encoder.encode(doc)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: url, options: [.atomic])
    }
}

public enum VaultVersion {
    public static let current = "0.1.0"
}

public enum HistoryStoreError: LocalizedError {
    case schemaMismatch(found: Int, expected: Int)

    public var errorDescription: String? {
        switch self {
        case let .schemaMismatch(found, expected):
            return "history.json schema v\(found) is incompatible with Vault v\(expected). " +
                   "Run `vault reset` to start fresh, or downgrade Vault."
        }
    }
}
