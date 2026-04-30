import Foundation
import VaultCore

// MARK: - Tiny zero-dep arg parsing

let argv = CommandLine.arguments
let command = argv.dropFirst().first ?? "help"
let args = Array(argv.dropFirst().dropFirst())

func flag(_ name: String) -> String? {
    guard let idx = args.firstIndex(of: "--\(name)") else { return nil }
    let next = args.index(after: idx)
    guard next < args.endIndex else { return nil }
    return args[next]
}

func bool(_ name: String) -> Bool { args.contains("--\(name)") }

let cfg = VaultConfig.load()

func resolveColorTheme() -> AnsiTheme {
    if bool("no-color") { return .plain }
    if bool("color") { return .colored }
    switch cfg.color {
    case .always: return .colored
    case .never:  return .plain
    case .auto, .none: return AnsiTheme.auto()
    }
}
let theme = resolveColorTheme()

let logger: Logger = {
    let lvl: Logger.Level = bool("verbose") ? .debug : (bool("quiet") ? .warn : .info)
    return Logger(minLevel: lvl, theme: theme)
}()

func defaultStore() -> URL {
    if let s = flag("out") {
        return URL(fileURLWithPath: (s as NSString).expandingTildeInPath)
    }
    if let s = cfg.historyPath {
        return URL(fileURLWithPath: (s as NSString).expandingTildeInPath)
    }
    let home = FileManager.default.homeDirectoryForCurrentUser
    return home.appendingPathComponent("Library/Application Support/AscensionCompanion/vault/history.json")
}

func resolveSaveFolder() -> URL? {
    if let s = flag("save-dir") {
        return URL(fileURLWithPath: (s as NSString).expandingTildeInPath, isDirectory: true)
    }
    if let s = cfg.saveDir {
        return URL(fileURLWithPath: (s as NSString).expandingTildeInPath, isDirectory: true)
    }
    return SaveFolderLocator.resolve()
}

func parseFilter() -> RunFilter {
    var f = RunFilter()
    if let raw = flag("character") { f.character = Character.from(raw) }
    if let raw = flag("min-ascension"), let n = Int(raw) { f.minAscension = n }
    if let raw = flag("max-ascension"), let n = Int(raw) { f.maxAscension = n }
    if let raw = flag("ascension"), let n = Int(raw) { f.minAscension = n; f.maxAscension = n }
    if bool("won") { f.won = true }
    if bool("lost") { f.won = false }
    if let raw = flag("since") {
        f.since = RunFilter.parseRelativeSince(raw) ?? ISO8601DateFormatter().date(from: raw)
    }
    if let raw = flag("until") {
        f.until = ISO8601DateFormatter().date(from: raw)
    }
    return f
}

// MARK: - Commands

func usage() {
    let text = """
    \(theme.heading("THE VAULT")) \(theme.dim("v\(VaultVersion.current)"))
    Read-only run-history exporter for STS2.

    \(theme.bold("USAGE"))
      vault discover                        List candidate save folders detected on this machine
      vault doctor                          Diagnose setup, parsing, and history state
      vault scan       [opts]               Parse save folder once, append to history.json
      vault watch      [opts]               Same as scan, then keep running
      vault stats      [opts]               Render winrate / archetype tables from history.json
      vault export     [opts]               Write history as CSV (filters supported)
      vault parse      <file>               Parse a single save file, print JSON record
      vault reset      [--yes]              Delete history.json (confirmation required)
      vault config     [get|set|path]       View / edit ~/.config/vault/config.json
      vault version

    \(theme.bold("COMMON OPTIONS"))
      --save-dir <path>                     Override save folder (or set VAULT_SAVE_DIR)
      --out <path>                          history.json location (default: AscensionCompanion app support)
      --quiet                               Suppress info logs
      --verbose                             Show debug logs
      --color / --no-color                  Force/skip ANSI colors (also honors NO_COLOR / FORCE_COLOR)

    \(theme.bold("FILTERS")) (apply to stats / export)
      --character <name>                    ironclad | silent | regent | necrobinder | defect
      --ascension <n>                       Exact ascension level
      --min-ascension <n>  --max-ascension <n>
      --won  /  --lost                      Restrict to wins / losses
      --since <token>                       Relative (7d / 24h / 2w) or ISO8601
      --until <iso8601>

    \(theme.bold("EXPORT"))
      --csv <path>                          Write CSV to path instead of stdout
      --json                                Emit history as JSON instead of CSV

    \(theme.bold("STATS"))
      --top <n>                             Limit to top N entries per table (default 15)
      --min-sample <n>                      Hide buckets with fewer than N runs (default 3)

    \(theme.bold("NOTES"))
      • Vault is read-only. It never writes to your STS2 save folder.
      • Files >10MB are skipped to avoid pathological inputs.
      • Schema is versioned — incompatible history files are rejected loudly,
        not merged silently. Run `vault reset` to start fresh.
    """
    print(text)
}

func cmdDiscover() {
    let candidates = SaveFolderLocator.candidates()
    if candidates.isEmpty {
        logger.error("No STS2 save folder detected. Pass --save-dir or set VAULT_SAVE_DIR.")
        exit(1)
    }
    for url in candidates {
        print(url.path)
    }
}

func cmdDoctor(folder: URL?, store: URL) {
    let report = Doctor.diagnose(explicitSaveDir: folder, historyURL: store)
    print(report.render(theme: theme))
    let hasFail = report.findings.contains { $0.severity == .fail }
    exit(hasFail ? 1 : 0)
}

func cmdScan(folder: URL?, store: URL) {
    guard let folder else {
        logger.error("No save folder. Use --save-dir, set VAULT_SAVE_DIR, or run `vault discover`.")
        exit(1)
    }
    let parser = SaveFileParser()
    let files = SaveFolderLocator.enumerateSaveFiles(in: folder)
    logger.notice("scanning \(files.count) file(s) in \(folder.path)")

    var records: [RunRecord] = []
    var skipped = 0
    var failed = 0
    for url in files {
        switch parser.parse(url: url) {
        case .parsed(let r):
            records.append(r)
            let bits: [String] = [
                r.character?.rawValue ?? "?",
                r.ascension.map { "A\($0)" } ?? "A?",
                r.won.map { $0 ? "WIN" : "loss" } ?? "?",
                "f\(r.floorReached ?? -1)"
            ]
            logger.ok("\(url.lastPathComponent) → \(bits.joined(separator: " "))")
        case .skipped(let reason):
            skipped += 1
            logger.skip("\(url.lastPathComponent) (\(reason))")
        case .failed(let err):
            failed += 1
            logger.fail("\(url.lastPathComponent) — \(err.localizedDescription)")
        }
    }

    let storeRef = HistoryStore(url: store)
    do {
        let added = try storeRef.upsert(records)
        logger.notice("\(records.count) parsed · \(added) new · \(skipped) skipped · \(failed) failed → \(store.path)")
    } catch {
        logger.error("write failed — \(error.localizedDescription)")
        exit(1)
    }
}

func cmdWatch(folder: URL?, store: URL) {
    guard let folder else {
        logger.error("No save folder. Use --save-dir or `vault discover`.")
        exit(1)
    }
    logger.notice("watching \(folder.path) (Ctrl-C to stop)")
    let parser = SaveFileParser()
    let storeRef = HistoryStore(url: store)
    let watcher = SaveFolderWatcher(folder: folder) { files in
        var records: [RunRecord] = []
        for url in files {
            if case .parsed(let r) = parser.parse(url: url) {
                records.append(r)
            }
        }
        if let added = try? storeRef.upsert(records), added > 0 {
            logger.notice("+\(added) run(s) added")
        }
    }
    watcher.start()
    dispatchMain()
}

func cmdExport(store: URL) {
    let storeRef = HistoryStore(url: store)
    do {
        let doc = try storeRef.load()
        let runs = parseFilter().apply(doc.runs)
        if bool("json") {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            enc.dateEncodingStrategy = .iso8601
            let data = try enc.encode(runs)
            if let csvPath = flag("csv") {
                try data.write(to: URL(fileURLWithPath: (csvPath as NSString).expandingTildeInPath))
                logger.notice("wrote \(runs.count) run(s) JSON to \(csvPath)")
            } else if let path = flag("json-out") {
                try data.write(to: URL(fileURLWithPath: (path as NSString).expandingTildeInPath))
                logger.notice("wrote \(runs.count) run(s) JSON to \(path)")
            } else {
                print(String(data: data, encoding: .utf8) ?? "")
            }
            return
        }
        let csv = CSVExporter.render(runs: runs)
        if let csvPath = flag("csv") {
            try csv.write(toFile: (csvPath as NSString).expandingTildeInPath, atomically: true, encoding: .utf8)
            logger.notice("wrote \(runs.count) row(s) to \(csvPath)")
        } else {
            print(csv, terminator: "")
        }
    } catch {
        logger.error("export failed — \(error.localizedDescription)")
        exit(1)
    }
}

func cmdStats(store: URL) {
    let storeRef = HistoryStore(url: store)
    do {
        let doc = try storeRef.load()
        let runs = parseFilter().apply(doc.runs)
        if runs.isEmpty {
            logger.warn("no runs match. Run `vault scan` first or relax filters.")
            exit(0)
        }
        let topN = flag("top").flatMap(Int.init) ?? 15
        let minSample = flag("min-sample").flatMap(Int.init) ?? 3
        let report = StatsEngine.summarize(runs: runs, relicMinSample: minSample, cardMinSample: minSample, topN: topN)

        if bool("json") {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            enc.dateEncodingStrategy = .iso8601
            let data = try enc.encode(report)
            print(String(data: data, encoding: .utf8) ?? "")
            return
        }
        print(StatsRenderer.render(report, theme: theme))
    } catch {
        logger.error("stats failed — \(error.localizedDescription)")
        exit(1)
    }
}

func cmdParse(path: String) {
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    switch SaveFileParser().parse(url: url) {
    case .parsed(let r):
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(r), let s = String(data: data, encoding: .utf8) {
            print(s)
        }
    case .skipped(let reason):
        logger.warn("skipped — \(reason)")
        exit(2)
    case .failed(let err):
        logger.error("failed — \(err.localizedDescription)")
        exit(1)
    }
}

func cmdReset(store: URL) {
    guard FileManager.default.fileExists(atPath: store.path) else {
        logger.notice("nothing to reset — \(store.path) does not exist")
        return
    }
    if !bool("yes") {
        FileHandle.standardError.write(Data("Delete \(store.path)? Type 'yes' to confirm: ".utf8))
        let resp = readLine() ?? ""
        guard resp.lowercased() == "yes" else {
            logger.notice("aborted")
            exit(1)
        }
    }
    do {
        try FileManager.default.removeItem(at: store)
        logger.notice("deleted \(store.path)")
    } catch {
        logger.error("could not delete: \(error.localizedDescription)")
        exit(1)
    }
}

func cmdConfig() {
    let action = args.first ?? "show"
    switch action {
    case "path":
        print(VaultConfig.defaultURL().path)
    case "show", "get":
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(VaultConfig.load()),
           let s = String(data: data, encoding: .utf8) {
            print(s)
        }
    case "set":
        // vault config set <key> <value>
        let restAfterSet = args.dropFirst()
        guard let key = restAfterSet.first, restAfterSet.count >= 2 else {
            logger.error("usage: vault config set <key> <value>")
            exit(1)
        }
        let value = restAfterSet.dropFirst().joined(separator: " ")
        var c = VaultConfig.load()
        switch key {
        case "save_dir", "saveDir":         c.saveDir = value
        case "history_path", "historyPath": c.historyPath = value
        case "color":
            guard let pref = VaultConfig.ColorPref(rawValue: value) else {
                logger.error("color must be one of: auto, always, never")
                exit(1)
            }
            c.color = pref
        default:
            logger.error("unknown key '\(key)'. Valid: save_dir, history_path, color")
            exit(1)
        }
        do {
            try c.save()
            logger.notice("saved config to \(VaultConfig.defaultURL().path)")
        } catch {
            logger.error("save failed: \(error.localizedDescription)")
            exit(1)
        }
    default:
        logger.error("unknown config action '\(action)'. Try: show | get | set | path")
        exit(1)
    }
}

// MARK: - Dispatch

let folder = resolveSaveFolder()
let store = defaultStore()

switch command {
case "version":   print("TheVault \(VaultVersion.current)")
case "discover":  cmdDiscover()
case "doctor":    cmdDoctor(folder: folder, store: store)
case "scan":      cmdScan(folder: folder, store: store)
case "watch":     cmdWatch(folder: folder, store: store)
case "export":    cmdExport(store: store)
case "stats":     cmdStats(store: store)
case "parse":
    guard let f = args.first else {
        logger.error("parse needs a file path")
        exit(1)
    }
    cmdParse(path: f)
case "reset":     cmdReset(store: store)
case "config":    cmdConfig()
case "help", "-h", "--help":
    usage()
default:
    usage()
    exit(1)
}
