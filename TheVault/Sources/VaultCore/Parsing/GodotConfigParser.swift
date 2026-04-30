import Foundation

/// Hand-rolled parser for Godot `ConfigFile` / `.tres` text save format.
///
/// Godot ConfigFile looks like:
///
///   [section_name]
///   key = "string"
///   number = 42
///   list = [ "a", "b", 3 ]
///
/// `.tres` is similar but with a header and resource declarations. We only need
/// to extract scalar/array values from sections — full Godot resource graph
/// reconstruction is out of scope.
///
/// This parser is intentionally minimal: it pulls all sections+keys into a
/// nested `[String: [String: Any]]` and then forwards to JSONRunParser's
/// mapping logic by treating section keys as run fields.
public struct GodotConfigParser: RunFormatParser {

    public init() {}

    public func canHandle(url: URL, head: Data) -> Bool {
        let ext = url.pathExtension.lowercased()
        if ["tres", "res", "cfg", "save", "run"].contains(ext) { return true }
        // Sniff for a `[section]` header at the top
        if let s = String(data: head, encoding: .utf8) {
            return s.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[")
        }
        return false
    }

    public func parse(url: URL, data: Data) throws -> RunRecord? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        let sections = Self.parseSections(text)

        // Promote the most likely "run" section to top level. Try common names first.
        let candidateNames = ["run", "RunData", "run_data", "save", "SaveData"]
        var flat: [String: Any] = [:]
        for name in candidateNames {
            if let s = sections[name] {
                flat = s
                break
            }
        }
        // Fallback: merge all sections, last-write-wins. Better than dropping data.
        if flat.isEmpty {
            for (_, s) in sections {
                for (k, v) in s { flat[k] = v }
            }
        }
        if flat.isEmpty { return nil }

        return JSONRunParser.recordFromObject(flat, sourceFile: url.lastPathComponent)
    }

    // MARK: - Tiny ConfigFile lexer

    static func parseSections(_ text: String) -> [String: [String: Any]] {
        var sections: [String: [String: Any]] = [:]
        var current = "_root"
        sections[current] = [:]

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix(";") || line.hasPrefix("#") { continue }
            if line.hasPrefix("[") && line.hasSuffix("]") {
                // [section] or [resource type=... id=...] — we only care about the first token
                let inner = String(line.dropFirst().dropLast())
                let name = inner.split(separator: " ").first.map(String.init) ?? inner
                current = name
                if sections[current] == nil { sections[current] = [:] }
                continue
            }
            // key = value
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            let raw = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            sections[current, default: [:]][key] = parseValue(raw)
        }
        return sections
    }

    static func parseValue(_ raw: String) -> Any {
        if raw.hasPrefix("\"") && raw.hasSuffix("\"") && raw.count >= 2 {
            return String(raw.dropFirst().dropLast())
        }
        if raw == "true" { return true }
        if raw == "false" { return false }
        if let i = Int(raw) { return i }
        if let d = Double(raw) { return d }
        if raw.hasPrefix("[") && raw.hasSuffix("]") {
            // naive split — fine for ["a","b",1] but would break on nested objects
            let inner = String(raw.dropFirst().dropLast())
            return inner.split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .map { parseValue($0) }
        }
        // Strip Godot type prefixes like Array[String](...) or PackedStringArray("a","b")
        if let openParen = raw.firstIndex(of: "("), raw.hasSuffix(")") {
            let inner = String(raw[raw.index(after: openParen)...].dropLast())
            return parseValue("[\(inner)]")
        }
        return raw
    }
}
