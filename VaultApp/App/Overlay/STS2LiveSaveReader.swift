import Foundation
import VaultCore

// =========================================================================
// STS2LiveSaveReader
// -------------------------------------------------------------------------
// Reads the *live* Slay the Spire 2 save (`current_run.save`) and turns
// it into a structured `LiveRunSnapshot` the overlay AI can stuff into
// its prompt. This is the difference between the coach guessing from a
// blurry screenshot and the coach knowing exactly:
//
//   * Defect, Ascension 6, floor 12, 57/75 HP, 145 gold
//   * Deck (with upgrades): 4 strikes, 4 defends, bash+1, ironwave, ...
//   * Relics: cracked_core, pen_nib (5/9), bag_of_marbles, ...
//   * Game mode: daily / standard / custom
//   * Modifiers: double_time, flight, ...
//   * Last visited room type: combat / shop / event
//
// All from a JSON file the user is already letting us read for the rest
// of the app. No memory injection, no DLL hooks, no Cheat Engine.
//
// Loading model: lazy + on-demand. The overlay calls
// `snapshot(saveFolder:)` right before each prompt build. Reading
// `current_run.save` is a few KB of JSON — well under a millisecond on
// any Mac shipped this decade — so caching for "performance" would just
// add staleness bugs. We cache for ~2 seconds anyway to coalesce the
// rapid-fire chip clicks the user might do ("Card pick", then immediately
// "Why?"), and we expose `forceRefresh:` to bypass when the user
// explicitly hits the refresh button in settings.
// =========================================================================

@MainActor
final class STS2LiveSaveReader {

    // MARK: - Snapshot model

    struct LiveRunSnapshot: Equatable {
        let inProgress: Bool
        let character: String?
        let ascension: Int?
        let floor: Int
        let act: Int?
        let currentHP: Int?
        let maxHP: Int?
        let gold: Int?
        let seed: String?
        let gameMode: String?
        let modifiers: [String]
        /// Card identifiers, lower-cased, with `+N` upgrade suffix. Counts
        /// are preserved (a deck with 4 strikes appears as 4 entries).
        let deck: [String]
        let relics: [String]
        let potions: [String]
        let lastRoomType: String?
        let pathTail: [(floor: Int, type: String)]
        let buildID: String?
        let schemaVersion: Int?
        /// File modification time so the overlay can show "as of 18s ago"
        /// when the user wonders whether the snapshot is fresh.
        let fileModifiedAt: Date?
        let sourceURL: URL?

        static func == (lhs: LiveRunSnapshot, rhs: LiveRunSnapshot) -> Bool {
            // Equatable so SwiftUI views holding @Published snapshots
            // don't redraw on identical re-reads. Compare the small set
            // of headline fields — full deck/relic equality on every
            // tick is wasteful and the state-machine drivers downstream
            // only care about the headline anyway.
            lhs.inProgress == rhs.inProgress
                && lhs.character == rhs.character
                && lhs.ascension == rhs.ascension
                && lhs.floor == rhs.floor
                && lhs.currentHP == rhs.currentHP
                && lhs.maxHP == rhs.maxHP
                && lhs.gold == rhs.gold
                && lhs.deck == rhs.deck
                && lhs.relics == rhs.relics
                && lhs.lastRoomType == rhs.lastRoomType
                && lhs.gameMode == rhs.gameMode
                && lhs.modifiers == rhs.modifiers
        }
    }

    // MARK: - Cache

    private var cached: LiveRunSnapshot?
    private var cachedAt: Date = .distantPast
    private let cacheTTL: TimeInterval = 2.0

    init() {}

    /// Find and parse `current_run.save`, returning a snapshot or nil if
    /// no live run is on disk. Looks in (in order):
    ///   1. `<saveFolder>/profile1/saves/current_run.save`
    ///   2. `<saveFolder>/saves/current_run.save`
    ///   3. Recursive search up to depth 3 (handles odd Steam Cloud
    ///      layouts and user-renamed profile dirs).
    func snapshot(saveFolder: URL?, forceRefresh: Bool = false) -> LiveRunSnapshot? {
        if !forceRefresh,
           let cached, Date().timeIntervalSince(cachedAt) < cacheTTL {
            return cached
        }
        guard let folder = saveFolder ?? SaveFolderLocator.resolve() else {
            return nil
        }
        guard let saveURL = locateCurrentRunSave(in: folder) else {
            cached = nil
            cachedAt = Date()
            return nil
        }
        guard let data = try? Data(contentsOf: saveURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: saveURL.path)
        let modAt = attrs?[.modificationDate] as? Date
        let snap = parse(obj: obj, sourceURL: saveURL, modifiedAt: modAt)
        cached = snap
        cachedAt = Date()
        return snap
    }

    /// Force-evict the cache. Call after the user hits a manual refresh.
    func invalidate() {
        cached = nil
        cachedAt = .distantPast
    }

    // MARK: - Locate

    private func locateCurrentRunSave(in folder: URL) -> URL? {
        let fm = FileManager.default
        let candidates: [URL] = [
            folder.appendingPathComponent("profile1/saves/current_run.save"),
            folder.appendingPathComponent("saves/current_run.save"),
            folder.appendingPathComponent("current_run.save"),
        ]
        for c in candidates where fm.fileExists(atPath: c.path) {
            return c
        }
        // Last resort: a bounded recursive walk. STS2 only has a few
        // dozen files in the save dir so this is cheap.
        if let walker = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) {
            var checked = 0
            for case let url as URL in walker {
                checked += 1
                if checked > 400 { break }
                if url.lastPathComponent.lowercased() == "current_run.save" {
                    return url
                }
            }
        }
        return nil
    }

    // MARK: - Parse

    private func parse(obj: [String: Any], sourceURL: URL, modifiedAt: Date?) -> LiveRunSnapshot? {
        // Fingerprint identical to the JS / Swift parsers: must have a
        // `players[0]` and a `map_point_history` array. Otherwise this is
        // a profile / settings save and we should give up cleanly.
        guard let players = obj["players"] as? [[String: Any]],
              let player = players.first,
              let mapHistory = obj["map_point_history"] as? [[Any]] else {
            return nil
        }

        let inProgress: Bool = {
            // Rule 1: filename says current_run.save → live, full stop.
            if sourceURL.lastPathComponent.lowercased().contains("current_run") {
                return true
            }
            // Rule 2: explicit win field present → completed run.
            if obj["win"] is Bool { return false }
            if let i = obj["win"] as? Int, i == 0 || i == 1 { return false }
            // Rule 3: was_abandoned + killed_by_encounter → completed.
            if (obj["was_abandoned"] as? Bool) == true { return false }
            if (obj["killed_by_encounter"] as? String)?.isEmpty == false { return false }
            return true
        }()

        var floor = 0
        var pathTail: [(Int, String)] = []
        var lastRoomType: String?
        var lastStats: [String: Any]?
        var actCount = 0
        for act in mapHistory {
            actCount += 1
            for case let point as [String: Any] in act {
                floor += 1
                let roomType = (point["rooms"] as? [[String: Any]])?.first?["room_type"] as? String
                let mapType  = point["map_point_type"] as? String
                let type = liveRoomType(room: roomType, mapPoint: mapType)
                lastRoomType = type
                pathTail.append((floor, type))
                if let stats = (point["player_stats"] as? [[String: Any]])?.first {
                    lastStats = stats
                }
            }
        }
        // Keep only the last six floors of path so the prompt stays
        // small. The model never needs the full act-1 trail when
        // deciding a turn-three combat play.
        if pathTail.count > 6 { pathTail = Array(pathTail.suffix(6)) }

        let currentHP: Int? =
            (player["current_hp"] as? Int)
            ?? (lastStats?["current_hp"] as? Int)
        let maxHP: Int? =
            (player["max_hp"] as? Int)
            ?? (lastStats?["max_hp"] as? Int)
        let gold: Int? =
            (player["gold"] as? Int)
            ?? (player["current_gold"] as? Int)
            ?? (lastStats?["current_gold"] as? Int)

        var deck: [String] = []
        if let cards = player["deck"] as? [[String: Any]] {
            for c in cards {
                guard let raw = c["id"] as? String else { continue }
                let stripped = stripPrefix("CARD.", raw).lowercased()
                let upgrade = (c["current_upgrade_level"] as? Int) ?? 0
                deck.append(upgrade > 0 ? "\(stripped)+\(upgrade)" : stripped)
            }
        }

        var relics: [String] = []
        if let rs = player["relics"] as? [[String: Any]] {
            for r in rs {
                if let id = r["id"] as? String {
                    relics.append(stripPrefix("RELIC.", id).lowercased())
                }
            }
        }

        var potions: [String] = []
        if let ps = player["potions"] as? [[String: Any]] {
            for p in ps {
                if let id = p["id"] as? String {
                    let normalized = stripPrefix("POTION.", id).lowercased()
                    // Skip empty potion slots — STS2 represents unfilled
                    // slots as objects with id "POTION.empty_potion" or
                    // "POTION.placeholder". Including them causes the diff
                    // to emit spurious "Used X" / "Found X" chips whenever
                    // a slot shifts position in the save file.
                    guard !normalized.isEmpty,
                          normalized != "empty_potion",
                          normalized != "placeholder",
                          normalized != "empty",
                          normalized != "none" else { continue }
                    potions.append(normalized)
                }
            }
        }

        // Modifiers can be `["MODIFIER.X"]` or `[{"id":"MODIFIER.X"}]`.
        var modifiers: [String] = []
        if let raw = obj["modifiers"] as? [Any] {
            for m in raw {
                if let s = m as? String {
                    modifiers.append(stripPrefix("MODIFIER.", s).lowercased())
                } else if let dict = m as? [String: Any], let id = dict["id"] as? String {
                    modifiers.append(stripPrefix("MODIFIER.", id).lowercased())
                }
            }
        }

        let character: String? = {
            // STS2 uses player["character_id"] = "CHARACTER.SILENT" etc.
            if let s = player["character_id"] as? String { return stripPrefix("CHARACTER.", s).lowercased() }
            if let s = player["character"] as? String { return stripPrefix("CHARACTER.", s).lowercased() }
            if let s = obj["character"] as? String { return stripPrefix("CHARACTER.", s).lowercased() }
            if let dict = player["character"] as? [String: Any], let s = dict["id"] as? String {
                return stripPrefix("CHARACTER.", s).lowercased()
            }
            return nil
        }()

        let mode: String? = {
            guard let m = obj["game_mode"] as? String, !m.isEmpty else { return nil }
            return m.lowercased()
        }()

        let snap = LiveRunSnapshot(
            inProgress: inProgress,
            character: character,
            ascension: obj["ascension"] as? Int,
            floor: floor,
            act: actCount > 0 ? actCount : nil,
            currentHP: currentHP,
            maxHP: maxHP,
            gold: gold,
            seed: obj["seed"] as? String,
            gameMode: mode,
            modifiers: modifiers,
            deck: deck,
            relics: relics,
            potions: potions,
            lastRoomType: lastRoomType,
            pathTail: pathTail,
            buildID: obj["build_id"] as? String,
            schemaVersion: obj["schema_version"] as? Int,
            fileModifiedAt: modifiedAt,
            sourceURL: sourceURL
        )
        return snap
    }

    // MARK: - Helpers

    private func stripPrefix(_ prefix: String, _ raw: String) -> String {
        raw.hasPrefix(prefix) ? String(raw.dropFirst(prefix.count)) : raw
    }

    private func liveRoomType(room: String?, mapPoint: String?) -> String {
        switch (mapPoint ?? "").lowercased() {
        case "boss":  return "boss"
        case "elite": return "elite"
        case "shop":  return "shop"
        default: break
        }
        switch (room ?? "").lowercased() {
        case "monster", "combat":   return "combat"
        case "elite":               return "elite"
        case "boss":                return "boss"
        case "shop":                return "shop"
        case "event":               return "event"
        case "rest", "campfire":    return "rest"
        case "ancient", "treasure": return "chest"
        default: return "unknown"
        }
    }

    /// Public for `STS2LiveSaveWatcher` — callers shouldn't need to
    /// know the location heuristic, but the watcher needs the URL to
    /// open a file descriptor for kqueue.
    func currentSaveURL(saveFolder: URL?) -> URL? {
        guard let folder = saveFolder ?? SaveFolderLocator.resolve() else {
            return nil
        }
        return locateCurrentRunSave(in: folder)
    }
}

// =========================================================================
// STS2LiveSaveWatcher
// -------------------------------------------------------------------------
// Real-time file watcher for `current_run.save` using `DispatchSource`'s
// kqueue-backed file system object monitor. The 4-second poll loop in
// OverlayController is fine for "is the deck still the same?" but it
// pegs tracker latency at 0-4 seconds. With the watcher, the moment
// STS2 fsync()s the save (which it does after every map node and
// after every reward), our handler fires within ~50ms, the diff
// computes, and the chip lands in the chat before the player even
// closes the reward modal.
//
// Mechanics:
//   1. open(path, O_EVTONLY) — non-blocking, no read access, just a
//      handle for kqueue.
//   2. DispatchSource for `[.write, .extend, .delete, .rename]`.
//      .write fires when STS2 saves; .delete/.rename fires when STS2
//      atomic-renames a temp file over current_run.save (which it
//      occasionally does on shutdown). On those, we re-locate the
//      file and re-attach.
//   3. Debounce 250ms — STS2 sometimes triple-writes a save in a single
//      tick (one for the autosave system, one for cloud sync, one for
//      crash recovery). Coalesce so we don't compute the same diff
//      three times.
//   4. Stop/teardown is critical — leaking the DispatchSource leaves
//      the fd open and the kqueue handler firing on a dead closure.
//      `stop()` cancels the source AND closes the fd. Verified with
//      `lsof -p $(pgrep TheVault)` after disable cycles.
// =========================================================================

@MainActor
final class STS2LiveSaveWatcher {

    private weak var reader: STS2LiveSaveReader?
    /// Resolved on every attach attempt so the watcher follows the
    /// active save folder if the user changes it in Settings while the
    /// overlay is enabled. Without the closure we'd be locked to
    /// whichever folder was active at start() time.
    private var saveFolderProvider: (() -> URL?)?
    private var onChange: (() -> Void)?

    private var source: DispatchSourceFileSystemObject?
    private var fd: Int32 = -1
    private var watchedPath: String?

    /// Fallback timer that fires every 5s to re-poll the file location
    /// if we have NO active watcher (file missing, or open() failed).
    /// Once the file appears we attach for real-time updates and the
    /// timer goes quiet. This is the only path that handles "user
    /// launched STS2 after enabling the overlay".
    private var attachTimer: Timer?

    /// Debounce: collapses a burst of writes within this window into
    /// a single onChange callback. STS2 sometimes flushes 3 times in
    /// a single autosave; we only want one diff.
    private var debounceWork: DispatchWorkItem?
    private let debounceInterval: TimeInterval = 0.25

    init(reader: STS2LiveSaveReader) {
        self.reader = reader
    }

    deinit {
        // We can't call `stop()` from deinit (it's @MainActor) — but
        // by the time deinit runs, the @MainActor instance is gone,
        // so the DispatchSource holding `self` weakly would have
        // already been canceled by an explicit stop() before release.
        // The fd + source are MainActor-isolated; if anyone forgot to
        // call stop(), the os may leak the fd until process exit.
        // Acceptable trade-off: explicit lifecycle, no actor hop.
    }

    /// Begin watching. Idempotent — repeated calls re-bind the closures
    /// without tearing down the active source if the path is unchanged.
    /// `saveFolderProvider` is called on every attach attempt so the
    /// watcher stays correct when the user changes the save folder
    /// while the overlay is running.
    func start(saveFolderProvider: @escaping () -> URL?,
               onChange: @escaping () -> Void) {
        self.saveFolderProvider = saveFolderProvider
        self.onChange = onChange
        attemptAttach()
        // Start the fallback timer regardless — if attach succeeds it's
        // a cheap 5s no-op; if attach fails (file not yet on disk) it
        // gives us a slow poll to retry until it appears.
        startAttachTimer()
    }

    /// Tear down completely. Closes the fd and cancels the source.
    func stop() {
        debounceWork?.cancel()
        debounceWork = nil
        tearDownSourceOnly()
        attachTimer?.invalidate()
        attachTimer = nil
        onChange = nil
    }

    // MARK: - Attach

    private func attemptAttach() {
        let folder = saveFolderProvider?()
        guard let reader,
              let url = reader.currentSaveURL(saveFolder: folder) else {
            return
        }
        // Already watching the right path — nothing to do.
        if let existing = watchedPath, existing == url.path, source != nil {
            return
        }
        // Different path (or first attach) — drop any old watcher first.
        if source != nil { tearDownSourceOnly() }

        let openedFD = open(url.path, O_EVTONLY)
        guard openedFD >= 0 else {
            return
        }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: openedFD,
            eventMask: [.write, .extend, .delete, .rename],
            queue: .main
        )
        src.setEventHandler { [weak self] in
            // Hop to MainActor so we can call into the @MainActor
            // members (debounce + onChange wrap @Published state).
            Task { @MainActor [weak self] in
                self?.handleEvent(eventMask: src.data)
            }
        }
        src.setCancelHandler { [openedFD] in
            close(openedFD)
        }
        src.resume()

        self.source = src
        self.fd = openedFD
        self.watchedPath = url.path
    }

    private func tearDownSourceOnly() {
        // Cancel triggers the cancel handler which closes the fd — so
        // we don't close it ourselves here. Doing both leads to an
        // EBADF when the cancel handler later tries to close a
        // descriptor we already released to the OS.
        source?.cancel()
        source = nil
        fd = -1
        watchedPath = nil
    }

    private func handleEvent(eventMask: DispatchSource.FileSystemEvent) {
        // .delete / .rename means STS2 atomic-renamed a temp file over
        // current_run.save. Our fd points at the OLD (now-orphaned)
        // inode — we'll never get another write event. Detach and
        // re-attach to the new file.
        if eventMask.contains(.delete) || eventMask.contains(.rename) {
            tearDownSourceOnly()
            // Try to re-attach immediately, and lean on the timer if
            // the rename target hasn't appeared yet.
            attemptAttach()
        }
        scheduleDebouncedFire()
    }

    private func scheduleDebouncedFire() {
        debounceWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.onChange?()
        }
        debounceWork = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + debounceInterval,
            execute: work
        )
    }

    // MARK: - Attach retry timer

    private func startAttachTimer() {
        attachTimer?.invalidate()
        let timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                // If we already have an active source, this is a
                // no-op; if not, retry attach. Either way also issue
                // a soft-refresh so the snapshot diff catches changes
                // we'd have missed during a detached window.
                self.attemptAttach()
                self.onChange?()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        attachTimer = timer
    }
}

// =========================================================================
// LiveRunSnapshot rendering helpers
// -------------------------------------------------------------------------
// Two consumers want pretty strings off the snapshot:
//   * The overlay UI (live-run header + footer in the chat panel).
//   * The AI prompt builder (a compact YAML-ish block injected into
//     the system prompt so the model knows the actual game state).
// We keep both renderings adjacent to the type so they never drift.
// =========================================================================

extension STS2LiveSaveReader.LiveRunSnapshot {

    /// Tight summary suitable for the pill / header.
    /// e.g. "Defect A6 · Floor 12 · 57/75 HP · 145g"
    var headlineLine: String {
        var bits: [String] = []
        if let c = character?.capitalized { bits.append(c) }
        if let a = ascension { bits.append("A\(a)") }
        bits.append("F\(floor)")
        if let hp = currentHP, let max = maxHP {
            bits.append("\(hp)/\(max) HP")
        }
        if let g = gold { bits.append("\(g)g") }
        return bits.joined(separator: " · ")
    }

    /// Two-line summary for the expanded header:
    ///   "Defect · Ascension 6"
    ///   "Floor 12 · 57/75 HP · 145g · last room: shop"
    var subtitleLine: String {
        var bits: [String] = []
        bits.append("Floor \(floor)")
        if let hp = currentHP, let max = maxHP { bits.append("\(hp)/\(max) HP") }
        if let g = gold { bits.append("\(g)g") }
        if let room = lastRoomType, room != "unknown" { bits.append("last room: \(room)") }
        return bits.joined(separator: " · ")
    }

    var modeBadge: String? {
        guard let m = gameMode, m != "standard", m != "normal" else { return nil }
        return m.capitalized + " run"
    }

    /// Compact prompt block. Designed to be small enough that it fits
    /// in any model's context budget while still giving the LLM enough
    /// to give specific, non-generic advice.
    func promptBlock() -> String {
        var lines: [String] = ["[live-run-snapshot]"]
        if !inProgress {
            lines.append("status: no live run on disk (suggest the player launch / continue a run)")
            return lines.joined(separator: "\n")
        }
        if let c = character { lines.append("character: \(c)") }
        if let a = ascension { lines.append("ascension: A\(a)") }
        lines.append("floor: \(floor)")
        if let act { lines.append("act: \(act)") }
        if let hp = currentHP, let max = maxHP { lines.append("hp: \(hp)/\(max)") }
        if let g = gold { lines.append("gold: \(g)") }
        if let m = gameMode { lines.append("game_mode: \(m)") }
        if !modifiers.isEmpty { lines.append("modifiers: " + modifiers.joined(separator: ", ")) }
        if let room = lastRoomType, room != "unknown" {
            lines.append("last_visited_room: \(room)")
        }
        if !pathTail.isEmpty {
            let tail = pathTail.map { "F\($0.floor):\($0.type)" }.joined(separator: " → ")
            lines.append("path_tail: \(tail)")
        }
        if !relics.isEmpty {
            lines.append("relics: " + relics.joined(separator: ", "))
        }
        if !potions.isEmpty {
            lines.append("potions: " + potions.joined(separator: ", "))
        }
        if !deck.isEmpty {
            // Rolled-up frequency view so a 25-card deck doesn't take 25
            // separate lines. "strike x4 · defend x4 · bash+1 · iron_wave"
            let rollup = rollUp(cards: deck)
            lines.append("deck (\(deck.count)): " + rollup)
        }
        if let mod = fileModifiedAt {
            let age = Int(max(0, -mod.timeIntervalSinceNow))
            lines.append("snapshot_age_s: \(age)")
        }
        return lines.joined(separator: "\n")
    }

    private func rollUp(cards: [String]) -> String {
        var counts: [String: Int] = [:]
        var order: [String] = []
        for c in cards {
            if counts[c] == nil { order.append(c) }
            counts[c, default: 0] += 1
        }
        return order.map { id in
            let n = counts[id] ?? 1
            return n > 1 ? "\(id) ×\(n)" : id
        }.joined(separator: " · ")
    }
}

// =========================================================================
// SnapshotDelta
// -------------------------------------------------------------------------
// "What just happened?" between two `LiveRunSnapshot` reads. The overlay
// poll loop computes one of these every ~4 seconds and posts an inline
// "tracker" chip in the chat when something player-visible changed.
//
// The whole point: the chat is already auto-monitoring the save file,
// so when the player picks Streamline from a card reward we can SEE
// the deck went from N to N+1 and the new card is "streamline+0". The
// coach posts "→ Took Streamline" automatically — no follow-up question
// needed. If we'd recommended Streamline a few turns ago we can also
// say "matches my pick" and start tracking accuracy over time.
//
// We're deliberately conservative about what counts as "player-visible":
//   * Floor advanced — always track (every transition matters).
//   * Card added/removed — always track (reward picks, removals).
//   * Relic added — always track.
//   * Gold delta ≥ 50 — track (filters out per-floor +5 trickle).
//   * HP delta ≥ 8 — track (filters out small chip damage).
//   * Potion added — track.
//
// What we IGNORE:
//   * HP changes inside a single combat (would spam during a fight).
//     Heuristic: only post HP deltas when the floor also advanced.
//   * Modifier toggles (the player can't change these mid-run).
// =========================================================================

struct SnapshotDelta: Equatable {

    /// The high-level kind so the chip can pick an icon + tint.
    enum Kind: String, Equatable {
        case cardAdded       // reward pick / shop card / event card
        case cardRemoved     // removal at shop / event / rest site
        case cardUpgraded    // rest site smith / armaments / event
        case relicAdded
        case relicLost
        case potionAdded
        case potionUsed
        case goldGained      // shop sale rare; combat reward common
        case goldSpent       // shop / event gold cost
        case hpHealed        // rest / event
        case hpLost          // event downside / boss residual
        case floorAdvanced   // pure progression beat
    }

    let kind: Kind
    /// Player-facing label, e.g. "Streamline+", "Pen Nib", "+150g".
    let label: String
    /// Optional secondary detail for the chip (e.g. "from card reward").
    let detail: String?
    /// The floor the delta was observed on, for log/recap context.
    let floor: Int
    /// When we noticed it. Used to age out tracker chips in the UI if
    /// we ever want to (today they just live in the message log).
    let observedAt: Date

    /// Compare two snapshots and emit zero or more deltas. Order is
    /// deterministic: cards before relics before currency, so a single
    /// "I bought a Pen Nib" beat reads naturally in the chat (relic +
    /// gold spent both surface).
    static func diff(previous: STS2LiveSaveReader.LiveRunSnapshot?,
                     current: STS2LiveSaveReader.LiveRunSnapshot) -> [SnapshotDelta] {
        guard let previous else { return [] }
        // Only diff within the same run. If the character changed or the
        // floor reset, a new run started — treat as no-op so we don't
        // post "lost 4 relics" the moment a new run begins.
        if previous.character != current.character { return [] }
        if current.floor < previous.floor { return [] }

        var out: [SnapshotDelta] = []
        let now = Date()
        let floor = current.floor

        // ---- Card additions / removals ----
        // Use multi-set semantics so a deck with Strike ×4 → ×5 emits
        // "+Strike" not "no change".
        let prevBag  = bag(previous.deck)
        let currBag  = bag(current.deck)
        let added    = bagDiff(currBag, minus: prevBag)
        let removed  = bagDiff(prevBag, minus: currBag)
        // Special-case "X+0 → X+1" — treat as upgrade rather than add+remove.
        let (upgrades, addsAfterUpgrade, removesAfterUpgrade) =
            extractUpgrades(added: added, removed: removed)

        for (cardID, count) in upgrades {
            let pretty = prettyCardName(cardID)
            for _ in 0 ..< count {
                out.append(.init(
                    kind: .cardUpgraded,
                    label: "\(pretty)+",
                    detail: "Upgraded",
                    floor: floor,
                    observedAt: now
                ))
            }
        }
        for (cardID, count) in addsAfterUpgrade {
            let pretty = prettyCardName(cardID)
            for _ in 0 ..< count {
                out.append(.init(
                    kind: .cardAdded,
                    label: pretty,
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            }
        }
        for (cardID, count) in removesAfterUpgrade {
            let pretty = prettyCardName(cardID)
            for _ in 0 ..< count {
                out.append(.init(
                    kind: .cardRemoved,
                    label: pretty,
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            }
        }

        // ---- Relics ----
        let relicAdds = arrayDiff(current.relics, minus: previous.relics)
        let relicGone = arrayDiff(previous.relics, minus: current.relics)
        for r in relicAdds {
            out.append(.init(
                kind: .relicAdded,
                label: prettyRelicName(r),
                detail: nil,
                floor: floor,
                observedAt: now
            ))
        }
        for r in relicGone {
            out.append(.init(
                kind: .relicLost,
                label: prettyRelicName(r),
                detail: nil,
                floor: floor,
                observedAt: now
            ))
        }

        // ---- Potions ----
        // Use bag (multiset) semantics — the game stores potions in
        // slot-indexed arrays, so slot order can shift without any
        // player action, which causes false "Used X / Added X" pairs.
        // Counting by name removes the ordering sensitivity.
        let prevPotionBag = bag(previous.potions)
        let currPotionBag = bag(current.potions)
        let potionAddsMap  = bagDiff(currPotionBag, minus: prevPotionBag)
        let potionsGoneMap = bagDiff(prevPotionBag, minus: currPotionBag)
        for (p, count) in potionAddsMap {
            let pretty = prettyRelicName(p)
            for _ in 0 ..< count {
                out.append(.init(
                    kind: .potionAdded,
                    label: pretty,
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            }
        }
        for (p, count) in potionsGoneMap {
            let pretty = prettyRelicName(p)
            for _ in 0 ..< count {
                out.append(.init(
                    kind: .potionUsed,
                    label: pretty,
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            }
        }

        // ---- Gold ----
        if let p = previous.gold, let c = current.gold {
            let delta = c - p
            if delta >= 50 {
                out.append(.init(
                    kind: .goldGained,
                    label: "+\(delta)g",
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            } else if delta <= -50 {
                out.append(.init(
                    kind: .goldSpent,
                    label: "\(delta)g",
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            }
        }

        // ---- HP (only when the floor advanced — avoid in-combat spam) ----
        if current.floor > previous.floor,
           let p = previous.currentHP, let c = current.currentHP {
            let delta = c - p
            if delta >= 8 {
                out.append(.init(
                    kind: .hpHealed,
                    label: "+\(delta) HP",
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            } else if delta <= -8 {
                out.append(.init(
                    kind: .hpLost,
                    label: "\(delta) HP",
                    detail: nil,
                    floor: floor,
                    observedAt: now
                ))
            }
        }

        // ---- Floor advance — emit ONLY if nothing else surfaced.
        // Otherwise the chat fills with "Floor 13 →" lines that compete
        // with the more interesting "Took Streamline" chip.
        if current.floor > previous.floor && out.isEmpty {
            out.append(.init(
                kind: .floorAdvanced,
                label: "Floor \(current.floor)",
                detail: previous.lastRoomType.map { "from \($0)" },
                floor: current.floor,
                observedAt: now
            ))
        }

        return out
    }

    // MARK: - Diff helpers

    private static func bag(_ items: [String]) -> [String: Int] {
        var out: [String: Int] = [:]
        for it in items { out[it, default: 0] += 1 }
        return out
    }

    private static func bagDiff(_ a: [String: Int], minus b: [String: Int]) -> [String: Int] {
        var out: [String: Int] = [:]
        for (k, v) in a {
            let leftover = v - (b[k] ?? 0)
            if leftover > 0 { out[k] = leftover }
        }
        return out
    }

    private static func arrayDiff(_ a: [String], minus b: [String]) -> [String] {
        var bagB = bag(b)
        var out: [String] = []
        for x in a {
            if let n = bagB[x], n > 0 {
                bagB[x] = n - 1
            } else {
                out.append(x)
            }
        }
        return out
    }

    /// Detect (added "X+1", removed "X+0") pairs and reclassify as
    /// upgrades. Walks both bags and consumes matching base IDs.
    private static func extractUpgrades(
        added: [String: Int],
        removed: [String: Int]
    ) -> (upgrades: [String: Int], addsLeft: [String: Int], removesLeft: [String: Int]) {
        var upgrades: [String: Int] = [:]
        var addsLeft = added
        var removesLeft = removed
        for (addedKey, addedCount) in added {
            // Strip "+N" to find the base ID.
            let base = stripUpgrade(addedKey)
            // Look for a matching removed entry that's the unupgraded
            // version (or a lower upgrade tier).
            for (removedKey, removedCount) in removed {
                let removedBase = stripUpgrade(removedKey)
                guard removedBase == base else { continue }
                // Both share a base. Treat the smaller of the two counts
                // as "upgrade" beats; the rest stay as add/remove.
                let upgraded = min(addedCount, removedCount)
                if upgraded > 0 {
                    upgrades[base, default: 0] += upgraded
                    addsLeft[addedKey] = (addsLeft[addedKey] ?? 0) - upgraded
                    if (addsLeft[addedKey] ?? 0) <= 0 { addsLeft.removeValue(forKey: addedKey) }
                    removesLeft[removedKey] = (removesLeft[removedKey] ?? 0) - upgraded
                    if (removesLeft[removedKey] ?? 0) <= 0 { removesLeft.removeValue(forKey: removedKey) }
                }
            }
        }
        return (upgrades, addsLeft, removesLeft)
    }

    private static func stripUpgrade(_ id: String) -> String {
        if let plus = id.firstIndex(of: "+") {
            return String(id[..<plus])
        }
        return id
    }

    /// "streamline+1" → "Streamline+1", "iron_wave" → "Iron Wave".
    /// Cheap title-casing keyed off the underscore convention used by
    /// STS2 IDs. The glossary has nicer names but we want this to work
    /// even for cards we don't have glossary entries for.
    private static func prettyCardName(_ id: String) -> String {
        if let entry = STS2CardGlossary.entryForCard(rawID: id) {
            // Append upgrade marker so "streamline+1" reads "Streamline+1".
            if let plus = id.firstIndex(of: "+") {
                let suffix = String(id[plus...])
                return entry.name + suffix
            }
            return entry.name
        }
        return titlecase(id)
    }

    private static func prettyRelicName(_ id: String) -> String {
        if let entry = STS2CardGlossary.entryForRelic(rawID: id) {
            return entry.name
        }
        return titlecase(id)
    }

    private static func titlecase(_ id: String) -> String {
        id.split(separator: "_")
          .map { $0.prefix(1).uppercased() + $0.dropFirst() }
          .joined(separator: " ")
    }
}
