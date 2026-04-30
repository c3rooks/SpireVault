import Foundation
import Combine
import AppKit
import VaultCore

/// Talks to the Worker's `/presence` endpoints. Owns:
///   - the heartbeat loop that keeps the user visible to others,
///   - the polling loop that refreshes the feed,
///   - and the fast paths (sign out, status change) that flush state through
///     the server immediately rather than waiting for the next tick.
///
/// All writes carry `Authorization: Bearer <session>` and the server cross-
/// checks the session-bound SteamID against the body — so the client cannot
/// claim another player's identity by tampering with locally-stored values.
@MainActor
final class PresenceService: ObservableObject {

    // MARK: - Published state

    @Published private(set) var entries: [PresenceEntry] = []
    @Published private(set) var lastError: String?
    @Published private(set) var isConnected = false
    /// The local user's mirrored copy. Drives the "Your status" card.
    @Published var myStatus: PresenceStatus = .looking
    @Published var myNote: String = ""
    @Published var myDiscord: String = ""

    // MARK: - Plumbing

    private let baseURL: URL
    private let session: URLSession
    private let me: () -> PlayerProfile?
    private let token: () -> String?

    private var heartbeatTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    /// How often the client refreshes the feed when the user is actively
    /// looking at the Co-op tab. Polling backs off to `idleInterval` when the
    /// app loses focus.
    private let activeInterval: TimeInterval = 12
    private let idleInterval: TimeInterval = 60
    /// Heartbeat is half the server's TTL so a single dropped request can't
    /// take you offline. Server TTL is 5 min → heartbeat every 2 min.
    private let heartbeatInterval: TimeInterval = 120

    init(baseURL: URL,
         session: URLSession = .shared,
         me: @escaping () -> PlayerProfile?,
         token: @escaping () -> String?) {
        self.baseURL = baseURL
        self.session = session
        self.me = me
        self.token = token
    }

    deinit {
        heartbeatTask?.cancel()
        pollTask?.cancel()
    }

    // MARK: - Lifecycle

    func start() {
        stop()
        heartbeatTask = Task { [weak self] in
            await self?.heartbeatLoop()
        }
        pollTask = Task { [weak self] in
            await self?.pollLoop()
        }
        Task { await refresh() }
    }

    func stop() {
        heartbeatTask?.cancel(); heartbeatTask = nil
        pollTask?.cancel(); pollTask = nil
    }

    // MARK: - Public actions

    /// Push the user's current status/note/discord up immediately. Called on
    /// every UI change so other clients see updates within ~one poll tick.
    func pushMyStatus() async {
        await heartbeat()
        await refresh()
    }

    /// Refresh the feed. Safe to call from anywhere.
    func refresh() async {
        do {
            let body: [PresenceEntry] = try await get("/presence")
            self.entries = body
                .sorted(by: Self.sortOrder)
            self.isConnected = true
            self.lastError = nil
        } catch {
            self.entries = []
            self.isConnected = false
            self.lastError = humanize(error)
        }
    }

    /// Drop the user's presence on logout / quit / clear-server. Best-effort.
    func goOffline() async {
        guard let me = me() else { return }
        var req = URLRequest(url: baseURL.appendingPathComponent("/presence"))
        req.httpMethod = "DELETE"
        attachAuth(&req)
        // Body lets the server double-check the session vs. SteamID.
        req.httpBody = try? JSONEncoder.iso8601().encode(["steamID": me.steamID])
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try? await session.data(for: req)
        self.entries = []
    }

    // MARK: - Loops

    private func heartbeatLoop() async {
        // First beat is immediate so the user pops in fast.
        await heartbeat()
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(heartbeatInterval * 1_000_000_000))
            if Task.isCancelled { break }
            await heartbeat()
        }
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            let active = await MainActor.run { NSApp.isActive }
            let interval = active ? activeInterval : idleInterval
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            if Task.isCancelled { break }
            await refresh()
        }
    }

    private func heartbeat() async {
        guard token() != nil else { return }
        let upsert = PresenceUpsert(
            status: myStatus,
            note: String(myNote.prefix(140)),
            discordHandle: myDiscord.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil
                : String(myDiscord.trimmingCharacters(in: .whitespaces).prefix(40)),
            stats: me()?.stats
        )
        do {
            let _: PresenceEntry = try await post("/presence", body: upsert)
        } catch {
            // Heartbeat errors don't surface to the UI — the next refresh will.
        }
    }

    // MARK: - Sort

    /// "Looking" rises above "in run" / "AFK"; in-game players rise within
    /// their group; ties broken by most-recently-updated.
    private static func sortOrder(_ a: PresenceEntry, _ b: PresenceEntry) -> Bool {
        let rank: (PresenceEntry) -> Int = {
            switch $0.status {
            case .looking: return 0
            case .inCoop:  return 1
            case .inRun:   return 2
            case .afk:     return 3
            }
        }
        if rank(a) != rank(b) { return rank(a) < rank(b) }
        if a.inSTS2 != b.inSTS2 { return a.inSTS2 && !b.inSTS2 }
        return a.updatedAt > b.updatedAt
    }

    // MARK: - HTTP

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, _) = try await session.data(from: baseURL.appendingPathComponent(path))
        return try JSONDecoder.iso8601().decode(T.self, from: data)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        attachAuth(&req)
        req.httpBody = try JSONEncoder.iso8601().encode(body)
        let (data, _) = try await session.data(for: req)
        return try JSONDecoder.iso8601().decode(T.self, from: data)
    }

    private func attachAuth(_ req: inout URLRequest) {
        if let t = token(), !t.isEmpty {
            req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        }
    }

    private func humanize(_ err: Error) -> String {
        if let urlErr = err as? URLError {
            switch urlErr.code {
            case .notConnectedToInternet: return "You're offline. Reconnect and try again."
            case .timedOut:               return "Matchmaking server timed out."
            case .cannotFindHost,
                 .cannotConnectToHost:    return "Can't reach matchmaking server."
            default: return urlErr.localizedDescription
            }
        }
        return err.localizedDescription
    }
}

// MARK: - JSON helpers

extension JSONDecoder {
    static func iso8601() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}

extension JSONEncoder {
    static func iso8601() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }
}
