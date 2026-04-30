import Foundation

/// Central runtime configuration for The Vault.
///
/// **Matchmaking server:** The Vault ships pointed at a single, public
/// Cloudflare Worker that acts as the presence aggregator. End users never
/// have to set this up — they just sign in with Steam and see who's around.
///
/// Power users (private groups, contributors testing changes) can override
/// the URL under Settings → Advanced. Clearing the override falls back to
/// the bundled default. The override is the only way to point at a different
/// server; there is no offline / mock mode.
struct AppConfig: Codable, Equatable {

    /// User-supplied URL that overrides the bundled default. Most users leave
    /// this `nil` and run on `defaultServerURL`.
    var customServerURL: URL?

    /// Effective server URL the app will actually talk to. Always non-nil at
    /// runtime — either the user's override or the baked-in default.
    var effectiveServerURL: URL { customServerURL ?? AppConfig.defaultServerURL }

    var isUsingDefault: Bool { customServerURL == nil }

    static let `default` = AppConfig(customServerURL: nil)

    // MARK: - Build-time constants

    /// Bundled default. **Edit this single line before cutting a release**
    /// (or override at build time via the `VAULT_DEFAULT_SERVER_URL`
    /// `Info.plist` key — see Resources/Info.plist).
    ///
    /// The URL must be a deployed instance of `Backend/` from this repo.
    /// At STS2 mod scale, Cloudflare's free tier (100k req/day) is more
    /// than enough — operating cost is effectively zero.
    static let defaultServerURL: URL = {
        if let bundled = Bundle.main.object(forInfoDictionaryKey: "VAULT_DEFAULT_SERVER_URL") as? String,
           let url = URL(string: bundled), url.scheme?.hasPrefix("http") == true {
            return url
        }
        return URL(string: "https://vault-coop.coreycrooks.workers.dev")!
    }()

    // MARK: - Persistence

    static func loadOrDefault() -> AppConfig {
        let path = configURL()
        guard let data = try? Data(contentsOf: path),
              let cfg = try? JSONDecoder().decode(AppConfig.self, from: data) else {
            return .default
        }
        return cfg
    }

    func save() {
        let path = AppConfig.configURL()
        try? FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(self) {
            try? data.write(to: path, options: .atomic)
        }
    }

    static func configURL() -> URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                               in: .userDomainMask).first!
        return support
            .appendingPathComponent("AscensionCompanion", isDirectory: true)
            .appendingPathComponent("vault", isDirectory: true)
            .appendingPathComponent("app-config.json")
    }
}
