import Foundation

/// Resolves the STS2 save folder across platforms.
///
/// Falls back to a list of candidates because:
///  - Mega Crit have not yet (April 2026) committed to a final path
///  - Steam-vs-standalone vs cloud sync vs proton each pick a different home
///  - Users sometimes symlink the folder elsewhere
public enum SaveFolderLocator {

    /// All candidate folders in priority order. Returns those that exist on disk.
    public static func candidates(env: [String: String] = ProcessInfo.processInfo.environment) -> [URL] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser

        var paths: [URL] = []

        // Explicit override (preferred, used by tests and power users)
        if let override = env["VAULT_SAVE_DIR"], !override.isEmpty {
            paths.append(URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true))
        }

        #if os(macOS) || os(Linux)
        let appSupport = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        paths.append(appSupport.appendingPathComponent("Mega Crit/SlayTheSpire2/runs", isDirectory: true))
        paths.append(appSupport.appendingPathComponent("Mega Crit/SlayTheSpire2", isDirectory: true))
        paths.append(appSupport.appendingPathComponent("Mega Crit/Slay the Spire 2/runs", isDirectory: true))
        paths.append(appSupport.appendingPathComponent("Mega Crit/Slay the Spire 2", isDirectory: true))

        // Godot default user dir under ~/Library/Application Support/Godot/app_userdata/
        paths.append(appSupport.appendingPathComponent("Godot/app_userdata/SlayTheSpire2", isDirectory: true))

        // Steam Cloud per-user data
        let steam = appSupport.appendingPathComponent("Steam/userdata", isDirectory: true)
        if fm.fileExists(atPath: steam.path) {
            // 2868840 is STS2's Steam app id
            if let userDirs = try? fm.contentsOfDirectory(at: steam, includingPropertiesForKeys: nil) {
                for u in userDirs {
                    paths.append(u.appendingPathComponent("2868840/remote", isDirectory: true))
                }
            }
        }
        #endif

        return paths.filter { fm.fileExists(atPath: $0.path) }
    }

    /// Picks the first existing candidate, or nil if none found.
    public static func resolve(env: [String: String] = ProcessInfo.processInfo.environment) -> URL? {
        candidates(env: env).first
    }

    /// Returns every plausible save file inside the resolved folder, recursively.
    /// We intentionally include common Godot extensions plus json.
    /// `maxBytes` skips pathological large files so a stray crashdump doesn't
    /// take the parser down. Default is 10MB which is ~100x bigger than any
    /// realistic STS2 run save.
    public static func enumerateSaveFiles(in folder: URL, maxBytes: Int = 10 * 1024 * 1024) -> [URL] {
        let fm = FileManager.default
        guard let walker = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        let allowed: Set<String> = ["json", "save", "run", "tres", "res", "cfg", "dat", "log"]
        var files: [URL] = []
        for case let url as URL in walker {
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true else { continue }
            guard allowed.contains(url.pathExtension.lowercased()) else { continue }
            if let size = values?.fileSize, size > maxBytes { continue }
            files.append(url)
        }
        return files.sorted { $0.path < $1.path }
    }
}
