import Foundation
import AppKit

/// Manages "who am I" inside The Vault. The **only** way to sign in is
/// real Steam OpenID via the Cloudflare Worker — no manual entry, no mock,
/// no way to spoof another player's SteamID locally.
///
/// Flow:
///   1. App opens `https://<your-worker>/auth/steam/start?return=thevault://auth&nonce=<random>`.
///   2. The Worker does the OpenID handshake with Steam in the user's browser.
///   3. The Worker mints a server-side session bound to the verified SteamID
///      and `302`s back to `thevault://auth?steamid=…&persona=…&avatar=…&session=…&nonce=…`.
///   4. We confirm the nonce matches the one we sent, then store the
///      `(steamID, sessionToken)` pair. Every write call to the Worker uses
///      `Authorization: Bearer <sessionToken>`. Reads (lobby list) are public.
@MainActor
final class SteamAuth: ObservableObject {

    @Published private(set) var profile: PlayerProfile?
    @Published private(set) var sessionToken: String?

    private var pendingNonce: String?

    private let storeURL: URL = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                               in: .userDomainMask).first!
        let dir = support.appendingPathComponent("AscensionCompanion/vault", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("steam-session.json")
    }()

    init() {
        loadFromDisk()
        registerURLHandler()
    }

    var isSignedIn: Bool { profile != nil && sessionToken != nil }

    // MARK: - Sign in / out

    /// Open the user's browser at the Worker's OpenID kickoff endpoint. The
    /// nonce is single-use and short-lived; only a redirect carrying the
    /// matching nonce is accepted.
    func signIn(via worker: URL) {
        let nonce = Self.makeNonce()
        pendingNonce = nonce
        var comps = URLComponents(url: worker.appendingPathComponent("auth/steam/start"),
                                  resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            URLQueryItem(name: "return", value: "thevault://auth"),
            URLQueryItem(name: "nonce",  value: nonce),
        ]
        if let url = comps.url {
            NSWorkspace.shared.open(url)
        }
    }

    func signOut() {
        profile = nil
        sessionToken = nil
        pendingNonce = nil
        try? FileManager.default.removeItem(at: storeURL)
    }

    /// Refresh the cached `PlayerStats` portion of `profile` from local run history.
    func updateStats(_ stats: PlayerStats) {
        guard var p = profile else { return }
        p.stats = stats
        profile = p
        save()
    }

    // MARK: - URL scheme callback

    private func registerURLHandler() {
        let mgr = NSAppleEventManager.shared()
        mgr.setEventHandler(self,
                            andSelector: #selector(handleURL(_:withReplyEvent:)),
                            forEventClass: AEEventClass(kInternetEventClass),
                            andEventID: AEEventID(kAEGetURL))
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor,
                                 withReplyEvent reply: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: urlString),
              url.scheme == "thevault",
              url.host == "auth",
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return
        }
        let qs = comps.queryItems ?? []
        func q(_ name: String) -> String? { qs.first(where: { $0.name == name })?.value }

        // Replay protection: the redirect must echo the nonce we sent.
        guard let returnedNonce = q("nonce"),
              let expected = pendingNonce,
              returnedNonce == expected else {
            return
        }
        pendingNonce = nil

        guard let steamID = q("steamid"),
              steamID.count == 17, steamID.allSatisfy(\.isNumber),
              let session = q("session"), !session.isEmpty else {
            return
        }
        let persona = q("persona") ?? "Steam User"
        let avatar = q("avatar")

        profile = PlayerProfile(steamID: steamID, personaName: persona, avatarURL: avatar)
        sessionToken = session
        save()
    }

    // MARK: - Persistence

    private struct Stored: Codable {
        var profile: PlayerProfile
        var sessionToken: String
    }

    private func save() {
        guard let p = profile, let s = sessionToken else { return }
        let stored = Stored(profile: p, sessionToken: s)
        if let data = try? JSONEncoder().encode(stored) {
            try? data.write(to: storeURL, options: .atomic)
        }
    }

    private func loadFromDisk() {
        guard let data = try? Data(contentsOf: storeURL),
              let stored = try? JSONDecoder().decode(Stored.self, from: data) else {
            return
        }
        profile = stored.profile
        sessionToken = stored.sessionToken
    }

    // MARK: - Helpers

    private static func makeNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
