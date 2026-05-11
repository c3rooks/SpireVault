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

    // MARK: - Overlay (Beta — Run Coach)
    //
    // The in-game AI run coach overlay is opt-in. It floats over fullscreen
    // STS2, captures a screenshot of the current decision when the user
    // hits Cmd+Enter, and asks the configured LLM "what should I do?".
    // Position is persisted across launches so the user only positions it
    // once. The Beta tab inside the app is the only surface that mentions
    // it — the public marketing site stays focused on shipped features.
    var overlayEnabled: Bool = false
    var overlayOriginX: Double? = nil
    var overlayOriginY: Double? = nil

    /// Which AI provider the overlay uses for "Ask" / "What should I do?".
    /// Stored as a raw string so old configs round-trip cleanly even if we
    /// add new providers later.
    var overlayAIProviderRaw: String = "openai"
    /// Model identifier the user picked for the active provider.
    var overlayAIModel: String = "gpt-4o-mini"
    /// Whether the overlay is allowed to attach a screenshot to the prompt.
    /// Defaults on — vision is what makes the coach useful — but the user
    /// can flip it off and rely purely on their typed question + tagged
    /// run context for a fully text-only experience.
    var overlayAttachScreenshot: Bool = true
    /// Whether the overlay is hidden from screen recordings / OBS / Zoom.
    /// On by default because streamers don't want random AI panels in their
    /// captures. The Cluely-style use case keeps this on.
    var overlayInvisibleToCapture: Bool = true
    /// Soft-pin the always-on-top behavior. Off uses macOS default; on
    /// keeps the overlay over fullscreen apps.
    var overlayAlwaysOnTop: Bool = true
    /// Free-form custom system prompt addendum the user can edit. Blank
    /// keeps the default "be a Slay the Spire 2 run advisor" prompt.
    var overlayCustomSystemPrompt: String = ""

    /// Global hot-key for the Run Coach overlay. Tapping the binding
    /// from inside fullscreen STS2 expands the overlay and focuses the
    /// chat input — the "press a key, get help instantly" flow.
    /// Stored as raw strings so we round-trip cleanly even if we add
    /// new modifiers / keys in a future build. Defaults are ⌥+Space:
    /// the same muscle memory most players have from Cluely / Raycast,
    /// and the one combination least likely to clash with an existing
    /// system shortcut.
    var overlayHotKeyEnabled: Bool = true
    var overlayHotKeyModifiersRaw: [String] = ["option"]
    var overlayHotKeyKeyRaw: String = "space"

    /// Whether the Coach automatically posts a one-line follow-up when
    /// a snapshot tracker fires with a verdict that disagrees with the
    /// most recent advice (`.different` or `.skipped`). Off uses
    /// roughly zero tokens; on adds one ~100-token call per disagreed
    /// pick. Defaults on because the value of "I see you took Bash —
    /// fine if you upgrade it" outweighs the per-pick cost.
    var overlayCoachAutoFollowup: Bool = true

    /// Whether the Coach streams long free-form responses back token-
    /// by-token instead of waiting for the full reply. Defaults on
    /// because chat feels noticeably alive with streaming. Structured
    /// responses (path / reward / shop / event / combat) always wait
    /// for a full parse — nothing to render incrementally.
    var overlayStreamingEnabled: Bool = true

    /// UUID string of the display the user pinned as the "game monitor".
    /// nil = auto-resolve: leftmost connected display on multi-monitor
    /// setups (the most common "game left, chat right" layout), or the
    /// overlay's own screen on single-monitor. The UUID is stable across
    /// reboots (backed by CGDisplayCreateUUIDFromDisplayID) so the
    /// preference survives display-list changes better than a bare
    /// CGDirectDisplayID, which can get reassigned by the OS.
    var overlayGameMonitorUUID: String? = nil

    static let `default` = AppConfig(
        customServerURL: nil,
        overlayEnabled: false,
        overlayOriginX: nil,
        overlayOriginY: nil,
        overlayAIProviderRaw: "openai",
        overlayAIModel: "gpt-4o-mini",
        overlayAttachScreenshot: true,
        overlayInvisibleToCapture: true,
        overlayAlwaysOnTop: true,
        overlayCustomSystemPrompt: "",
        overlayHotKeyEnabled: true,
        overlayHotKeyModifiersRaw: ["option"],
        overlayHotKeyKeyRaw: "space",
        overlayCoachAutoFollowup: true,
        overlayStreamingEnabled: true,
        overlayGameMonitorUUID: nil
    )

    // MARK: - Forward-compatible decode
    //
    // Synthesized `Codable` ignores property defaults during decode, which
    // means a config file written by an older build (no overlay-AI fields)
    // would fail to decode and we'd fall back to `.default` and silently
    // wipe the user's matchmaking-server override. Decode each field
    // explicitly with `decodeIfPresent` so adding a new key in a future
    // build is fully forward/backward compatible.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.customServerURL = try c.decodeIfPresent(URL.self, forKey: .customServerURL)
        self.overlayEnabled = try c.decodeIfPresent(Bool.self, forKey: .overlayEnabled) ?? false
        self.overlayOriginX = try c.decodeIfPresent(Double.self, forKey: .overlayOriginX)
        self.overlayOriginY = try c.decodeIfPresent(Double.self, forKey: .overlayOriginY)
        self.overlayAIProviderRaw = try c.decodeIfPresent(String.self, forKey: .overlayAIProviderRaw) ?? "openai"
        let savedModel = try c.decodeIfPresent(String.self, forKey: .overlayAIModel) ?? "gpt-4o-mini"
        let savedProvider = try c.decodeIfPresent(String.self, forKey: .overlayAIProviderRaw) ?? "openai"
        let isStaleAnthropicModel = savedModel.hasPrefix("claude-3") && savedProvider == "anthropic"
        self.overlayAIModel = isStaleAnthropicModel ? "claude-sonnet-4-6" : savedModel
        self.overlayAttachScreenshot = try c.decodeIfPresent(Bool.self, forKey: .overlayAttachScreenshot) ?? true
        self.overlayInvisibleToCapture = try c.decodeIfPresent(Bool.self, forKey: .overlayInvisibleToCapture) ?? true
        self.overlayAlwaysOnTop = try c.decodeIfPresent(Bool.self, forKey: .overlayAlwaysOnTop) ?? true
        self.overlayCustomSystemPrompt = try c.decodeIfPresent(String.self, forKey: .overlayCustomSystemPrompt) ?? ""
        self.overlayHotKeyEnabled = try c.decodeIfPresent(Bool.self, forKey: .overlayHotKeyEnabled) ?? true
        self.overlayHotKeyModifiersRaw = try c.decodeIfPresent([String].self, forKey: .overlayHotKeyModifiersRaw) ?? ["option"]
        self.overlayHotKeyKeyRaw = try c.decodeIfPresent(String.self, forKey: .overlayHotKeyKeyRaw) ?? "space"
        self.overlayCoachAutoFollowup = try c.decodeIfPresent(Bool.self, forKey: .overlayCoachAutoFollowup) ?? true
        self.overlayStreamingEnabled = try c.decodeIfPresent(Bool.self, forKey: .overlayStreamingEnabled) ?? true
        self.overlayGameMonitorUUID = try c.decodeIfPresent(String.self, forKey: .overlayGameMonitorUUID)
    }

    init(
        customServerURL: URL?,
        overlayEnabled: Bool,
        overlayOriginX: Double?,
        overlayOriginY: Double?,
        overlayAIProviderRaw: String,
        overlayAIModel: String,
        overlayAttachScreenshot: Bool,
        overlayInvisibleToCapture: Bool,
        overlayAlwaysOnTop: Bool,
        overlayCustomSystemPrompt: String,
        overlayHotKeyEnabled: Bool,
        overlayHotKeyModifiersRaw: [String],
        overlayHotKeyKeyRaw: String,
        overlayCoachAutoFollowup: Bool,
        overlayStreamingEnabled: Bool,
        overlayGameMonitorUUID: String? = nil
    ) {
        self.customServerURL = customServerURL
        self.overlayEnabled = overlayEnabled
        self.overlayOriginX = overlayOriginX
        self.overlayOriginY = overlayOriginY
        self.overlayAIProviderRaw = overlayAIProviderRaw
        self.overlayAIModel = overlayAIModel
        self.overlayAttachScreenshot = overlayAttachScreenshot
        self.overlayInvisibleToCapture = overlayInvisibleToCapture
        self.overlayAlwaysOnTop = overlayAlwaysOnTop
        self.overlayCustomSystemPrompt = overlayCustomSystemPrompt
        self.overlayHotKeyEnabled = overlayHotKeyEnabled
        self.overlayHotKeyModifiersRaw = overlayHotKeyModifiersRaw
        self.overlayHotKeyKeyRaw = overlayHotKeyKeyRaw
        self.overlayCoachAutoFollowup = overlayCoachAutoFollowup
        self.overlayStreamingEnabled = overlayStreamingEnabled
        self.overlayGameMonitorUUID = overlayGameMonitorUUID
    }

    private enum CodingKeys: String, CodingKey {
        case customServerURL
        case overlayEnabled, overlayOriginX, overlayOriginY
        case overlayAIProviderRaw, overlayAIModel
        case overlayAttachScreenshot, overlayInvisibleToCapture
        case overlayAlwaysOnTop, overlayCustomSystemPrompt
        case overlayHotKeyEnabled, overlayHotKeyModifiersRaw, overlayHotKeyKeyRaw
        case overlayCoachAutoFollowup, overlayStreamingEnabled
        case overlayGameMonitorUUID
    }

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
