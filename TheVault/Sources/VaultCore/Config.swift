import Foundation

/// On-disk user prefs at `~/.config/vault/config.json`. Optional — every field
/// is overridable on the CLI. We only use it so power users (and Ascension
/// Companion) don't have to pass flags every time.
public struct VaultConfig: Codable {
    public var saveDir: String?
    public var historyPath: String?
    public var color: ColorPref?

    public enum ColorPref: String, Codable { case auto, always, never }

    public init(saveDir: String? = nil, historyPath: String? = nil, color: ColorPref? = nil) {
        self.saveDir = saveDir
        self.historyPath = historyPath
        self.color = color
    }

    public static func defaultURL() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".config/vault/config.json")
    }

    public static func load(from url: URL = defaultURL()) -> VaultConfig {
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let cfg = try? JSONDecoder().decode(VaultConfig.self, from: data)
        else { return VaultConfig() }
        return cfg
    }

    public func save(to url: URL = defaultURL()) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(self).write(to: url, options: [.atomic])
    }
}
