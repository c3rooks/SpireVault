import Foundation

/// Structured-ish stderr logger. Levels gate noise; symbols make scan output
/// scannable. Color is opt-in so logs piped to files stay clean.
public final class Logger {

    public enum Level: Int, Comparable {
        case debug = 0, info = 1, notice = 2, warn = 3, error = 4
        public static func < (lhs: Level, rhs: Level) -> Bool { lhs.rawValue < rhs.rawValue }
    }

    public var minLevel: Level
    public var theme: AnsiTheme

    public init(minLevel: Level = .info, theme: AnsiTheme = .plain) {
        self.minLevel = minLevel
        self.theme = theme
    }

    public func debug(_ msg: @autoclosure () -> String)  { write(.debug,  msg()) }
    public func info(_ msg: @autoclosure () -> String)   { write(.info,   msg()) }
    public func notice(_ msg: @autoclosure () -> String) { write(.notice, msg()) }
    public func warn(_ msg: @autoclosure () -> String)   { write(.warn,   msg()) }
    public func error(_ msg: @autoclosure () -> String)  { write(.error,  msg()) }

    public func ok(_ msg: String)   { write(.info,   "ok    \(msg)", styleSymbol: theme.heading("✓")) }
    public func skip(_ msg: String) { write(.info,   "skip  \(msg)", styleSymbol: theme.dim("·")) }
    public func fail(_ msg: String) { write(.error,  "fail  \(msg)", styleSymbol: theme.heading("✗")) }

    private func write(_ lvl: Level, _ msg: String, styleSymbol: String? = nil) {
        guard lvl >= minLevel else { return }
        let prefix: String
        switch lvl {
        case .debug:  prefix = theme.dim("DEBUG")
        case .info:   prefix = ""
        case .notice: prefix = theme.bold("→")
        case .warn:   prefix = theme.bold("WARN ")
        case .error:  prefix = theme.bold("ERROR")
        }
        var line = ""
        if let symbol = styleSymbol { line += symbol + " " }
        if !prefix.isEmpty { line += prefix + " " }
        line += msg
        if !line.hasSuffix("\n") { line += "\n" }
        FileHandle.standardError.write(Data(line.utf8))
    }
}
