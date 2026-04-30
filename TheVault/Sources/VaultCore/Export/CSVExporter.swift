import Foundation

/// Flat CSV view of run history. One row per run.
///
/// Columns are stable for downstream sheets — we add new columns at the end
/// and never reorder existing ones.
public enum CSVExporter {

    public static let columns: [String] = [
        "id",
        "character",
        "ascension",
        "won",
        "floorReached",
        "playTimeSeconds",
        "endedAt",
        "deckSize",
        "relicCount",
        "seed"
    ]

    public static func render(runs: [RunRecord]) -> String {
        var out = columns.joined(separator: ",") + "\n"
        let iso = ISO8601DateFormatter()
        for r in runs {
            let row: [String] = [
                escape(r.id),
                escape(r.character?.rawValue ?? ""),
                r.ascension.map(String.init) ?? "",
                r.won.map { $0 ? "true" : "false" } ?? "",
                r.floorReached.map(String.init) ?? "",
                r.playTimeSeconds.map(String.init) ?? "",
                r.endedAt.map { iso.string(from: $0) } ?? "",
                String(r.deckAtEnd.count),
                String(r.relics.count),
                escape(r.seed ?? "")
            ]
            out += row.joined(separator: ",") + "\n"
        }
        return out
    }

    private static func escape(_ s: String) -> String {
        if s.contains(",") || s.contains("\"") || s.contains("\n") {
            return "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return s
    }
}
