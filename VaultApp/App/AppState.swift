import Foundation
import AppKit
import SwiftUI
import Combine
import VaultCore

/// Single source of truth for the UI. All filesystem and parsing work happens
/// off the main actor; results are published back via `@MainActor` updates.
@MainActor
final class AppState: ObservableObject {

    // MARK: - User-facing state
    @Published var saveFolder: URL?
    @Published var historyURL: URL = AppState.defaultHistoryURL()
    @Published var status: ScanStatus = .idle
    @Published var runs: [RunRecord] = []
    @Published var report: StatsReport?
    @Published var lastScanAt: Date?
    @Published var filter = RunFilter()
    @Published var needsOnboarding = false
    @Published var doctorReport: DoctorReport?

    // MARK: - Co-op
    @Published var config: AppConfig
    let steamAuth: SteamAuth

    /// Presence feed service. Non-nil iff the user has signed in with Steam.
    /// `config.effectiveServerURL` is always populated (default or override),
    /// so the only gate is auth.
    @Published private(set) var presenceService: PresenceService?

    private var cancellables: Set<AnyCancellable> = []

    enum ScanStatus: Equatable {
        case idle
        case scanning(progress: Double, current: String)
        case error(String)
    }

    // MARK: - Init

    init() {
        let cfg = AppConfig.loadOrDefault()
        self.config = cfg
        let auth = SteamAuth()
        self.steamAuth = auth
        self.presenceService = Self.makePresenceService(config: cfg, auth: auth)

        // Re-render whenever sign-in state changes, and rebuild the presence
        // service so it tears down its loops cleanly on sign-out.
        auth.objectWillChange
            .sink { [weak self] _ in
                guard let self else { return }
                self.rebuildPresenceService()
                self.objectWillChange.send()
            }
            .store(in: &cancellables)
    }

    private static func makePresenceService(config: AppConfig, auth: SteamAuth) -> PresenceService? {
        guard auth.isSignedIn else { return nil }
        return PresenceService(
            baseURL: config.effectiveServerURL,
            me: { auth.profile },
            token: { auth.sessionToken }
        )
    }

    private func rebuildPresenceService() {
        presenceService?.stop()
        Task { await presenceService?.goOffline() }
        if let svc = Self.makePresenceService(config: config, auth: steamAuth) {
            presenceService = svc
            svc.start()
        } else {
            presenceService = nil
        }
    }

    // MARK: - Bootstrap

    func bootstrap() async {
        // 1) Load persisted prefs
        let cfg = VaultConfig.load()
        if let p = cfg.saveDir { saveFolder = URL(fileURLWithPath: p) }
        if let p = cfg.historyPath { historyURL = URL(fileURLWithPath: p) }

        // 2) Try to auto-detect the save folder
        if saveFolder == nil {
            saveFolder = SaveFolderLocator.resolve()
        }

        // 3) Load whatever's already on disk so the UI isn't blank
        await loadHistoryFromDisk()

        // 4) Decide onboarding vs auto-scan
        if saveFolder == nil {
            needsOnboarding = true
        } else if runs.isEmpty {
            await scan()
        }

        // 5) Auto-attach our stats to the Steam profile so others can read them
        attachStatsToProfile()

        // 6) Boot presence loops if we're already signed in from a prior session
        presenceService?.start()
    }

    /// Recompute the viewer's PlayerStats from local runs and stamp it onto
    /// the cached Steam profile + push it through presence.
    func attachStatsToProfile() {
        guard steamAuth.profile != nil else { return }
        let total = runs.count
        let wins = runs.filter { $0.won == true }.count
        let maxAsc = runs.compactMap { $0.won == true ? $0.ascension : nil }.max() ?? 0
        let preferred = mostFrequentCharacter()
        steamAuth.updateStats(.init(totalRuns: total, wins: wins,
                                     maxAscension: maxAsc,
                                     preferredCharacter: preferred?.rawValue))
        Task { await presenceService?.pushMyStatus() }
    }

    private func mostFrequentCharacter() -> VaultCore.Character? {
        var counts: [VaultCore.Character: Int] = [:]
        for r in runs { if let c = r.character { counts[c, default: 0] += 1 } }
        return counts.max(by: { $0.value < $1.value })?.key
    }

    // MARK: - Co-op config

    /// Override the matchmaking server URL. Pass `nil` to revert to the
    /// bundled default.
    func setCustomServer(_ url: URL?) {
        config.customServerURL = url
        config.save()
        rebuildPresenceService()
        objectWillChange.send()
    }

    // MARK: - Scanning

    func scan() async {
        guard let folder = saveFolder else {
            status = .error("No save folder selected.")
            return
        }
        status = .scanning(progress: 0, current: "Looking for saves…")

        let parser = SaveFileParser()
        let files = SaveFolderLocator.enumerateSaveFiles(in: folder)
        let total = max(files.count, 1)

        var parsed: [RunRecord] = []
        var processed = 0

        await Task.detached(priority: .userInitiated) {
            for url in files {
                let outcome = parser.parse(url: url)
                processed += 1
                if case .parsed(let r) = outcome {
                    parsed.append(r)
                }
                if processed % 25 == 0 || processed == total {
                    let progress = Double(processed) / Double(total)
                    let label = url.lastPathComponent
                    await MainActor.run {
                        self.status = .scanning(progress: progress, current: label)
                    }
                }
            }
        }.value

        do {
            let store = HistoryStore(url: historyURL)
            _ = try store.upsert(parsed)
            await loadHistoryFromDisk()
            status = .idle
            lastScanAt = Date()
        } catch {
            status = .error(error.localizedDescription)
        }
    }

    private func loadHistoryFromDisk() async {
        let store = HistoryStore(url: historyURL)
        do {
            let doc = try store.load()
            self.runs = doc.runs
            self.recomputeReport()
        } catch {
            self.status = .error(error.localizedDescription)
        }
    }

    func recomputeReport() {
        let filtered = filter.apply(runs)
        self.report = StatsEngine.summarize(runs: filtered)
    }

    // MARK: - Save folder management

    func chooseSaveFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select your Slay the Spire 2 save folder"
        panel.prompt = "Choose"
        if let auto = SaveFolderLocator.resolve() {
            panel.directoryURL = auto.deletingLastPathComponent()
        }
        if panel.runModal() == .OK, let url = panel.url {
            saveFolder = url
            persistConfig()
            needsOnboarding = false
            Task { await scan() }
        }
    }

    func revealSaveFolder() {
        guard let folder = saveFolder else { return }
        NSWorkspace.shared.activateFileViewerSelecting([folder])
    }

    func runDoctor() {
        let report = Doctor.diagnose(
            explicitSaveDir: saveFolder,
            historyURL: historyURL
        )
        self.doctorReport = report
    }

    // MARK: - Export

    func exportCSV() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "vault-runs.csv"
        panel.allowedContentTypes = [.commaSeparatedText]
        if panel.runModal() == .OK, let url = panel.url {
            let csv = CSVExporter.render(runs: filter.apply(runs))
            try? csv.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    // MARK: - Persistence

    private func persistConfig() {
        var cfg = VaultConfig.load()
        cfg.saveDir = saveFolder?.path
        cfg.historyPath = historyURL.path
        try? cfg.save()
    }

    private static func defaultHistoryURL() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent("Library/Application Support/AscensionCompanion/vault/history.json")
    }
}
