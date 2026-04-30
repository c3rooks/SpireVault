import Foundation

/// Diagnostics for `vault doctor`. Walks every place we'd look for runs and
/// reports what's wrong, what's right, and what's missing. Built so the
/// output can be pasted into a GitHub issue verbatim without leaking PII
/// beyond the user's home folder paths.
public struct DoctorReport {

    public struct Finding {
        public enum Severity { case ok, info, warn, fail }
        public let severity: Severity
        public let title: String
        public let detail: String
    }

    public var findings: [Finding] = []
    public var saveCandidates: [URL] = []
    public var resolvedSaveDir: URL?
    public var historyURL: URL?
    public var historyDocument: HistoryStore.Document?
    public var sampleParse: ParseOutcome?
    public var vaultVersion: String = VaultVersion.current

    public mutating func add(_ severity: Finding.Severity, _ title: String, _ detail: String) {
        findings.append(Finding(severity: severity, title: title, detail: detail))
    }

    public func render(theme: AnsiTheme = .auto()) -> String {
        var out = ""
        out += theme.heading("VAULT DOCTOR") + "  " + theme.dim("v\(vaultVersion)") + "\n\n"
        for f in findings {
            let badge: String
            switch f.severity {
            case .ok:   badge = theme.heading("✓ OK   ")
            case .info: badge = theme.dim    ("· INFO ")
            case .warn: badge = theme.bold   ("! WARN ")
            case .fail: badge = theme.bold   ("✗ FAIL ")
            }
            out += "\(badge) \(f.title)\n"
            if !f.detail.isEmpty {
                for line in f.detail.split(separator: "\n") {
                    out += "         " + theme.dim(String(line)) + "\n"
                }
            }
        }
        return out
    }
}

public enum Doctor {

    public static func diagnose(
        explicitSaveDir: URL? = nil,
        historyURL: URL,
        env: [String: String] = ProcessInfo.processInfo.environment
    ) -> DoctorReport {
        var report = DoctorReport()
        report.historyURL = historyURL

        // 1) Save folder discovery
        let candidates = SaveFolderLocator.candidates(env: env)
        report.saveCandidates = candidates
        if let explicitSaveDir {
            report.resolvedSaveDir = explicitSaveDir
            if FileManager.default.fileExists(atPath: explicitSaveDir.path) {
                report.add(.ok, "Save dir override exists", explicitSaveDir.path)
            } else {
                report.add(.fail, "Save dir override does NOT exist", explicitSaveDir.path)
            }
        } else if let resolved = candidates.first {
            report.resolvedSaveDir = resolved
            report.add(.ok, "Detected save folder", resolved.path)
            if candidates.count > 1 {
                report.add(.info, "Other candidates also exist",
                           candidates.dropFirst().map(\.path).joined(separator: "\n"))
            }
        } else {
            report.add(.fail, "No save folder detected",
                       "Set VAULT_SAVE_DIR or pass --save-dir.\nRun `vault discover` to see candidates checked.")
        }

        // 2) Save folder contents
        if let dir = report.resolvedSaveDir {
            let files = SaveFolderLocator.enumerateSaveFiles(in: dir)
            if files.isEmpty {
                report.add(.warn, "Save folder has no parseable files",
                           "Vault looks for *.json, *.save, *.run, *.tres, *.res, *.cfg, *.dat\nin \(dir.path) (recursive).")
            } else {
                report.add(.ok, "Save folder contains \(files.count) candidate file(s)",
                           files.prefix(5).map(\.lastPathComponent).joined(separator: "\n")
                           + (files.count > 5 ? "\n…and \(files.count - 5) more" : ""))
                // 3) Sample parse the newest file. Prefer `.run` files since
                // those are real completed runs; fall back to other extensions
                // if the user's folder doesn't have any.
                let runFiles = files.filter { $0.pathExtension.lowercased() == "run" }
                let pool = runFiles.isEmpty ? files : runFiles
                if let newest = pool.max(by: { lhs, rhs in
                    (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                        ?? .distantPast
                    < (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)
                        ?? .distantPast
                }) {
                    let outcome = SaveFileParser().parse(url: newest)
                    report.sampleParse = outcome
                    switch outcome {
                    case .parsed(let r):
                        report.add(.ok, "Sample parse succeeded",
                                   "\(newest.lastPathComponent) → \(r.character?.rawValue ?? "?") A\(r.ascension ?? -1) \(r.won == true ? "WIN" : "loss") f\(r.floorReached ?? -1)")
                    case .skipped(let why):
                        report.add(.warn, "Sample parse skipped", "\(newest.lastPathComponent): \(why)")
                    case .failed(let err):
                        report.add(.fail, "Sample parse failed",
                                   "\(newest.lastPathComponent): \(err.localizedDescription)\nIf this is a valid completed run, please open an issue with this file.")
                    }
                }
            }
        }

        // 4) History store health
        let store = HistoryStore(url: historyURL)
        if FileManager.default.fileExists(atPath: historyURL.path) {
            do {
                let doc = try store.load()
                report.historyDocument = doc
                if doc.header.schemaVersion == RunRecord.schemaVersion {
                    report.add(.ok, "history.json is current schema (v\(doc.header.schemaVersion))",
                               "\(doc.runs.count) run(s) stored at \(historyURL.path)")
                } else {
                    report.add(.warn, "history.json schema mismatch",
                               "On disk: v\(doc.header.schemaVersion). Vault: v\(RunRecord.schemaVersion).\nVault will refuse to merge incompatible schemas to avoid data loss. Run `vault reset` to start fresh.")
                }
            } catch {
                report.add(.fail, "history.json could not be loaded",
                           "\(historyURL.path)\n\(error.localizedDescription)")
            }
        } else {
            report.add(.info, "No history.json yet",
                       "Will be created at \(historyURL.path) on first scan.")
        }

        // 5) Environment knobs
        if let v = env["VAULT_SAVE_DIR"] { report.add(.info, "VAULT_SAVE_DIR is set", v) }
        if env["NO_COLOR"] != nil { report.add(.info, "NO_COLOR is set", "Vault will skip ANSI colors.") }
        if env["FORCE_COLOR"] != nil { report.add(.info, "FORCE_COLOR is set", "Vault will emit colors even when piped.") }

        return report
    }
}
