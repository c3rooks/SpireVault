import Foundation

/// Pretty-prints a `StatsReport` to a terminal as ASCII tables.
///
/// `theme` decides whether we emit ANSI color codes. The CLI passes `.plain`
/// when stdout isn't a TTY (pipes, files) so consumers don't see escape junk.
public enum StatsRenderer {

    public static func render(_ report: StatsReport, theme: AnsiTheme = .auto()) -> String {
        var out = ""
        out += theme.heading("VAULT STATS") + "\n"
        out += theme.dim("Generated " + ISO8601DateFormatter().string(from: report.generatedAt)) + "\n"
        out += "\n"

        out += summary(report, theme: theme) + "\n\n"

        if !report.byCharacter.isEmpty {
            out += theme.heading("Per character") + "\n"
            out += renderTable(
                headers: ["Character", "Runs", "Wins", "Winrate"],
                rows: report.byCharacter.map {
                    [$0.key, "\($0.runs)", "\($0.wins)", percent($0.winrate)]
                },
                aligns: [.left, .right, .right, .right],
                theme: theme
            )
            out += "\n\n"
        }

        if !report.byAscension.isEmpty {
            out += theme.heading("Per ascension") + "\n"
            out += renderTable(
                headers: ["Asc", "Runs", "Wins", "Winrate"],
                rows: report.byAscension.map {
                    [$0.key, "\($0.runs)", "\($0.wins)", percent($0.winrate)]
                },
                aligns: [.left, .right, .right, .right],
                theme: theme
            )
            out += "\n\n"
        }

        if !report.byRelic.isEmpty {
            out += theme.heading("Top relics by winrate") + theme.dim(" (min sample applied)") + "\n"
            out += renderTable(
                headers: ["Relic", "Seen", "Wins", "Winrate", "Appearance"],
                rows: report.byRelic.map {
                    [$0.key, "\($0.runs)", "\($0.wins)", percent($0.winrate),
                     $0.pickedRate.map(percent) ?? "-"]
                },
                aligns: [.left, .right, .right, .right, .right],
                theme: theme
            )
            out += "\n\n"
        }

        if !report.byArchetypeTag.isEmpty {
            out += theme.heading("Per archetype") + "\n"
            out += renderTable(
                headers: ["Archetype", "Runs", "Wins", "Winrate"],
                rows: report.byArchetypeTag.map {
                    [$0.key, "\($0.runs)", "\($0.wins)", percent($0.winrate)]
                },
                aligns: [.left, .right, .right, .right],
                theme: theme
            )
            out += "\n\n"
        }

        if !report.topPickedCards.isEmpty {
            out += theme.heading("Most-picked cards") + "\n"
            out += renderTable(
                headers: ["Card", "Picks", "Wins after pick", "Winrate", "Pick rate"],
                rows: report.topPickedCards.map {
                    [$0.key, "\($0.runs)", "\($0.wins)", percent($0.winrate),
                     $0.pickedRate.map(percent) ?? "-"]
                },
                aligns: [.left, .right, .right, .right, .right],
                theme: theme
            )
            out += "\n\n"
        }

        if !report.topSkippedCards.isEmpty {
            out += theme.heading("Most-skipped cards") + theme.dim(" (offered often, picked rarely)") + "\n"
            out += renderTable(
                headers: ["Card", "Offered", "Picked", "Pick rate"],
                rows: report.topSkippedCards.map {
                    [$0.key, "\($0.runs)", "\($0.wins)", $0.pickedRate.map(percent) ?? "-"]
                },
                aligns: [.left, .right, .right, .right],
                theme: theme
            )
            out += "\n"
        }

        return out
    }

    private static func summary(_ r: StatsReport, theme: AnsiTheme) -> String {
        let line1 = theme.bold("\(r.totalRuns)") + " runs · "
            + theme.bold("\(r.totalWins)") + " wins · "
            + theme.bold(percent(r.overallWinrate)) + " winrate"
        return line1
    }

    public enum Align { case left, right }

    public static func renderTable(
        headers: [String],
        rows: [[String]],
        aligns: [Align]? = nil,
        theme: AnsiTheme = .plain
    ) -> String {
        guard !headers.isEmpty else { return "" }
        let columns = headers.count
        let aligns = aligns ?? Array(repeating: Align.left, count: columns)

        // Compute column widths from raw text (theme-stripped, since color codes don't take cells).
        var widths = headers.map { $0.count }
        for row in rows {
            for (i, cell) in row.enumerated() where i < columns {
                widths[i] = max(widths[i], cell.count)
            }
        }

        func pad(_ s: String, width: Int, align: Align) -> String {
            let gap = max(0, width - s.count)
            switch align {
            case .left: return s + String(repeating: " ", count: gap)
            case .right: return String(repeating: " ", count: gap) + s
            }
        }

        var out = ""
        // Header row
        let headerCells = headers.enumerated().map { (i, h) in
            theme.bold(pad(h, width: widths[i], align: aligns[i]))
        }
        out += headerCells.joined(separator: "  ") + "\n"
        // Separator
        let seps = widths.map { String(repeating: "─", count: $0) }
        out += theme.dim(seps.joined(separator: "  ")) + "\n"
        // Data
        for row in rows {
            let cells = row.enumerated().map { (i, c) in
                pad(c, width: widths[i], align: aligns[i])
            }
            out += cells.joined(separator: "  ") + "\n"
        }
        return out
    }

    public static func percent(_ d: Double) -> String {
        let pct = d * 100
        return String(format: "%.1f%%", pct)
    }
}

/// ANSI styling helper. `auto()` decides whether to emit codes based on whether
/// stdout is connected to a terminal — important so piping into a file or grep
/// doesn't get junk.
public struct AnsiTheme {

    public let bold: (String) -> String
    public let dim: (String) -> String
    public let heading: (String) -> String

    public static let plain = AnsiTheme(
        bold: { $0 },
        dim: { $0 },
        heading: { $0 }
    )

    public static let colored = AnsiTheme(
        bold: { "\u{1B}[1m\($0)\u{1B}[0m" },
        dim:  { "\u{1B}[2m\($0)\u{1B}[0m" },
        heading: { "\u{1B}[1;36m\($0)\u{1B}[0m" }
    )

    public static func auto(forceColor: Bool? = nil) -> AnsiTheme {
        if let forceColor { return forceColor ? .colored : .plain }
        // Respect NO_COLOR convention (https://no-color.org)
        if ProcessInfo.processInfo.environment["NO_COLOR"] != nil { return .plain }
        // Respect FORCE_COLOR for piped/CI scenarios
        if ProcessInfo.processInfo.environment["FORCE_COLOR"] != nil { return .colored }
        // TTY check
        return isatty(fileno(stdout)) != 0 ? .colored : .plain
    }
}
