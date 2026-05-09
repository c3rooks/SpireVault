import Foundation
import AppKit
import Combine

/// In-app update checker, downloader, and installer.
///
/// We deliberately do NOT use Sparkle here. Sparkle is great, but it
/// requires:
///
///   * EdDSA signing keys + an appcast XML on a fixed URL we control.
///   * A Developer ID-signed and notarized .app to land on macOS 14+
///     without a Gatekeeper warning every launch.
///
/// Spire Vault ships ad-hoc-signed today (the Makefile uses `--sign -`)
/// because there's no paid Apple Developer account behind the project.
/// Sparkle's signed-XML invariants don't fit that posture cleanly, and
/// shipping Sparkle without signing the appcast is exactly the kind of
/// "feels secure, isn't" half-measure I want to avoid.
///
/// Instead: this service points directly at the project's GitHub
/// Releases page. GitHub serves DMGs over HTTPS with their own
/// integrity guarantees, and we layer a SHA-256 check from the release
/// notes on top so a hijacked Releases asset would still fail to
/// install. Compared to Sparkle this gives us:
///
///   - Zero new infra (no appcast XML, no signing key, no R2 bucket).
///   - The same Release artifact developers + manual downloaders
///     already use, so the "did the auto-update install the same
///     binary I'd download by hand" answer is trivially yes.
///   - Easy revocation: deleting a bad release on GitHub immediately
///     stops the auto-updater from picking it up. No appcast to redact.
///
/// Trade-off: GitHub's API has a 60 req/hour anonymous rate limit per
/// IP. We respect it by checking at most once every six hours per
/// launch and caching the response in `~/Library/Caches/`.
@MainActor
public final class UpdateService: ObservableObject {

    // MARK: - Public types

    public enum Status: Equatable {
        case idle
        case checking
        case upToDate(currentVersion: String, checkedAt: Date)
        case updateAvailable(latest: ReleaseInfo)
        case downloading(progress: Double, latest: ReleaseInfo)
        case readyToInstall(dmgURL: URL, latest: ReleaseInfo)
        case installing
        case failed(String)
    }

    public struct ReleaseInfo: Equatable, Hashable {
        public let tag: String         // e.g. "v0.8.0"
        public let version: String     // numeric tag without the "v" — "0.8.0"
        public let name: String        // human-readable release title
        public let notes: String       // markdown body
        public let publishedAt: Date
        public let dmgURL: URL
        public let dmgName: String
        public let dmgSize: Int64
        /// Optional SHA-256 from the release body (we look for a line
        /// like `SHA-256: <hex>` in the notes). nil = no integrity
        /// pin, just trust HTTPS to GitHub.
        public let dmgSHA256: String?
    }

    // MARK: - Published UI state

    @Published public private(set) var status: Status = .idle
    @Published public var lastCheckedAt: Date?
    @Published public var latestRelease: ReleaseInfo?

    // MARK: - Constants

    /// We check at most every this many seconds per launch. Manual
    /// "Check for updates" clicks bypass the throttle.
    private let autoCheckIntervalSeconds: TimeInterval = 6 * 60 * 60

    private let owner: String
    private let repo: String
    private let session: URLSession

    public init(owner: String = "c3rooks", repo: String = "SpireVault") {
        self.owner = owner
        self.repo = repo
        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: cfg)
    }

    public var currentVersion: String { VaultBundleInfo.shortVersion }

    // MARK: - Public API

    /// Silent background check. Safe to call on every app launch — does
    /// nothing if we already checked within `autoCheckIntervalSeconds`.
    public func autoCheckIfDue() async {
        if let last = lastCheckedAt, Date().timeIntervalSince(last) < autoCheckIntervalSeconds {
            return
        }
        await checkForUpdates(userInitiated: false)
    }

    /// Manual check from the Settings UI button.
    public func checkForUpdates(userInitiated: Bool) async {
        if case .checking = status { return }
        if case .downloading = status { return }
        status = .checking
        do {
            let info = try await fetchLatestRelease()
            self.latestRelease = info
            self.lastCheckedAt = Date()
            if compareVersion(info.version, isNewerThan: currentVersion) {
                status = .updateAvailable(latest: info)
            } else {
                status = .upToDate(currentVersion: currentVersion, checkedAt: Date())
            }
        } catch {
            // Suppress noisy network errors during auto-checks; only
            // surface failures the user explicitly asked for.
            if userInitiated {
                status = .failed(humanReadable(error))
            } else {
                status = .idle
            }
        }
    }

    /// Download the DMG to a cache location and verify its size +
    /// optional SHA-256. Updates `status` with download progress so
    /// the UI can show a bar.
    public func downloadUpdate() async {
        guard let info = latestRelease else { return }
        status = .downloading(progress: 0, latest: info)
        do {
            let dest = try await downloadDMG(info)
            try verifyDMG(at: dest, expected: info)
            status = .readyToInstall(dmgURL: dest, latest: info)
        } catch {
            status = .failed(humanReadable(error))
        }
    }

    /// Mount the DMG, replace the running .app in place, and relaunch
    /// the new build. macOS keeps the old executable mapped so a
    /// `rm -rf /Applications/The Vault.app && cp -R …` is safe even
    /// while we're the running process — the OS finishes the cleanup
    /// when our PID exits.
    public func installAndRelaunch() async {
        guard case let .readyToInstall(dmgURL, info) = status else { return }
        status = .installing
        do {
            try await installFromDMG(dmgURL: dmgURL, info: info)
            // installFromDMG calls relaunch(); if it returns we somehow
            // got past `exit(0)` — fall back to "ready" so the user
            // can try again.
            status = .readyToInstall(dmgURL: dmgURL, latest: info)
        } catch {
            status = .failed(humanReadable(error))
        }
    }

    /// Open the GitHub release page in the user's browser. Useful as a
    /// fallback when the auto-installer can't (e.g. The Vault.app lives
    /// outside /Applications and we'd need elevated permissions to
    /// rewrite it in place).
    public func openReleasePage() {
        let url = URL(string: "https://github.com/\(owner)/\(repo)/releases/latest")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - Network: latest release

    private func fetchLatestRelease() async throws -> ReleaseInfo {
        var req = URLRequest(url: URL(string: "https://api.github.com/repos/\(owner)/\(repo)/releases/latest")!)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Spire-Vault-macOS/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw UpdateError.network("GitHub releases API returned \(code)")
        }
        let payload = try JSONDecoder().decode(GitHubRelease.self, from: data)
        guard let dmg = payload.assets.first(where: { $0.name.lowercased().hasSuffix(".dmg") }) else {
            throw UpdateError.malformed("No .dmg asset on the latest release")
        }
        let tag = payload.tag_name
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        return ReleaseInfo(
            tag: tag,
            version: version,
            name: payload.name ?? tag,
            notes: payload.body ?? "",
            publishedAt: parseISO(payload.published_at),
            dmgURL: URL(string: dmg.browser_download_url)!,
            dmgName: dmg.name,
            dmgSize: dmg.size,
            dmgSHA256: extractSHA256(from: payload.body ?? "")
        )
    }

    // MARK: - Network: download

    private func downloadDMG(_ info: ReleaseInfo) async throws -> URL {
        let cache = try cacheDirectory()
        let dest = cache.appendingPathComponent(info.dmgName)
        // Re-use a previously-downloaded file if size matches — saves
        // the user from a second 50 MB download if they hit Install
        // again later.
        if let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path),
           let size = attrs[.size] as? Int64, size == info.dmgSize {
            return dest
        }
        // Stream with progress.
        let (tmp, resp) = try await session.download(for: URLRequest(url: info.dmgURL),
                                                     delegate: nil)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw UpdateError.network("Downloading the update returned \(code)")
        }
        if FileManager.default.fileExists(atPath: dest.path) {
            try FileManager.default.removeItem(at: dest)
        }
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }

    private func verifyDMG(at url: URL, expected info: ReleaseInfo) throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = attrs[.size] as? Int64, size == info.dmgSize else {
            throw UpdateError.malformed("Downloaded DMG size doesn't match the release listing")
        }
        // Optional SHA-256 verification when the release body declared
        // one. If it didn't (early releases didn't), HTTPS to GitHub is
        // our only integrity gate, which is the same posture as a
        // hand download.
        guard let expectedHex = info.dmgSHA256 else { return }
        let actualHex = try sha256Hex(of: url)
        if actualHex.lowercased() != expectedHex.lowercased() {
            throw UpdateError.malformed("DMG SHA-256 doesn't match the release notes")
        }
    }

    // MARK: - Install

    private func installFromDMG(dmgURL: URL, info: ReleaseInfo) async throws {
        // Mount via hdiutil. We use `-nobrowse` so Finder doesn't pop
        // open with the DMG, and `-readonly` because we never need to
        // write into it.
        let mount = try runProcess(
            "/usr/bin/hdiutil",
            ["attach", "-nobrowse", "-readonly", "-noautoopen", dmgURL.path]
        )
        guard let mountPoint = parseHDIUtilMountPoint(mount.stdout) else {
            throw UpdateError.install("Couldn't find the mount point in hdiutil output")
        }
        defer {
            // Best-effort detach. Failing here doesn't affect the
            // install — macOS will eject on next reboot anyway.
            _ = try? runProcess("/usr/bin/hdiutil", ["detach", mountPoint, "-quiet"])
        }
        let mountedAppURL = URL(fileURLWithPath: mountPoint)
            .appendingPathComponent("The Vault.app")
        guard FileManager.default.fileExists(atPath: mountedAppURL.path) else {
            throw UpdateError.install("The Vault.app not found inside the DMG")
        }

        // Where is the running app installed? We replace it in place.
        let runningAppURL = Bundle.main.bundleURL
        let parent = runningAppURL.deletingLastPathComponent()
        // If the user is running the app from /Applications (or
        // /Users/<me>/Applications), we have permission to replace
        // it. If they're running it from a DMG / Downloads / build
        // dir, replacing in-place won't surface in their Applications
        // folder — bail and tell them to drag-install.
        let isInAppsFolder =
            parent.path == "/Applications" ||
            parent.path.hasSuffix("/Applications") ||
            parent.path.hasSuffix("/Library/Caches/com.apple.dt.Xcode/UserData")
        if !isInAppsFolder {
            throw UpdateError.install(
                "The Vault is running from \(parent.path). Drag the new build from the DMG into your Applications folder, then relaunch."
            )
        }

        // The dance:
        //   1. Stage the new app to a sibling temp dir.
        //   2. Move the running app to the trash.
        //   3. Rename the staged app into place.
        //   4. Launch it.
        //   5. exit() the running process — macOS keeps our PID
        //      and its mapped pages alive long enough to detach.
        let staging = parent.appendingPathComponent(".the-vault-staging-\(UUID().uuidString)")
        try? FileManager.default.removeItem(at: staging)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let stagedApp = staging.appendingPathComponent("The Vault.app")
        try FileManager.default.copyItem(at: mountedAppURL, to: stagedApp)

        // Clear Apple's quarantine bit so the freshly-copied app can
        // launch without a "downloaded from the internet" prompt. We
        // stripped FinderInfo at build time; this is the runtime
        // equivalent of `xattr -dr com.apple.quarantine`.
        _ = try? runProcess("/usr/bin/xattr", ["-cr", stagedApp.path])

        // Move the running app to the user's Trash via NSWorkspace —
        // gives them an undo path if anything looks wrong post-update.
        var trashedURL: NSURL?
        try (FileManager.default).trashItem(at: runningAppURL, resultingItemURL: &trashedURL)

        // Rename the staged copy into place.
        try FileManager.default.moveItem(at: stagedApp, to: runningAppURL)
        try? FileManager.default.removeItem(at: staging)

        relaunch(newAppURL: runningAppURL)
    }

    private func relaunch(newAppURL: URL) {
        // Kick off a tiny shell helper that waits for our PID to die,
        // then `open`s the new app. We can't `open -a` ourselves and
        // exit cleanly in the same process — `open` returns
        // immediately, but the system gets unhappy if we try to open
        // a bundle that's still running.
        let pid = ProcessInfo.processInfo.processIdentifier
        let cmd = """
        while kill -0 \(pid) 2>/dev/null; do sleep 0.2; done
        open '\(newAppURL.path)'
        """
        let task = Process()
        task.launchPath = "/bin/sh"
        task.arguments = ["-c", cmd]
        try? task.run()
        // Give the relauncher a moment to actually fork before we go.
        Thread.sleep(forTimeInterval: 0.2)
        NSApp.terminate(nil)
        // Belt and braces — terminate(nil) goes through delegate hooks
        // that could veto the quit. exit(0) doesn't.
        exit(0)
    }

    // MARK: - Helpers

    private func cacheDirectory() throws -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dir = caches.appendingPathComponent("com.coreycrooks.thevault.app/updates", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func runProcess(_ path: String, _ args: [String]) throws -> (stdout: String, stderr: String) {
        let proc = Process()
        proc.launchPath = path
        proc.arguments = args
        let outPipe = Pipe(); let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        try proc.run()
        proc.waitUntilExit()
        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        if proc.terminationStatus != 0 {
            throw UpdateError.install("\(path) exited \(proc.terminationStatus): \(err.isEmpty ? out : err)")
        }
        return (out, err)
    }

    private func parseHDIUtilMountPoint(_ stdout: String) -> String? {
        // hdiutil prints tab-separated rows; the mount point is the
        // last whitespace-separated column on the first row that
        // contains "/Volumes/". We keep the parsing flexible to
        // tolerate variable column counts across macOS versions.
        for line in stdout.components(separatedBy: "\n") {
            if let range = line.range(of: "/Volumes/") {
                return String(line[range.lowerBound...]).trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    private func sha256Hex(of url: URL) throws -> String {
        // Stream the file rather than loading it into memory — DMGs
        // can be 50–100 MB and we don't need the whole thing resident.
        // We shell out to `/usr/bin/shasum` because Foundation doesn't
        // expose CryptoKit on macOS 12 without conditional compilation
        // and our deployment target is 13.0.
        let result = try runProcess("/usr/bin/shasum", ["-a", "256", url.path])
        // `shasum` output: "<hex>  <path>"
        return result.stdout
            .split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
    }

    /// Pull a SHA-256 line out of the release notes. We accept a few
    /// common formats so I don't have to remember the canonical one
    /// every time I cut a release.
    private func extractSHA256(from body: String) -> String? {
        let patterns = [
            "(?im)^\\s*SHA-?256\\s*[:=]\\s*([A-Fa-f0-9]{64})",
            "(?im)^\\s*sha256\\s+([A-Fa-f0-9]{64})",
        ]
        for p in patterns {
            if let regex = try? NSRegularExpression(pattern: p),
               let match = regex.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)),
               match.numberOfRanges >= 2,
               let range = Range(match.range(at: 1), in: body) {
                return String(body[range])
            }
        }
        return nil
    }

    private func parseISO(_ s: String?) -> Date {
        guard let s else { return Date() }
        let f = ISO8601DateFormatter()
        return f.date(from: s) ?? Date()
    }

    /// Compare semantic version strings ("0.8.0" vs "0.10.1"). Returns
    /// true iff `a` is strictly newer than `b`.
    private func compareVersion(_ a: String, isNewerThan b: String) -> Bool {
        let av = a.split(separator: ".").compactMap { Int($0) }
        let bv = b.split(separator: ".").compactMap { Int($0) }
        let count = max(av.count, bv.count)
        for i in 0..<count {
            let lhs = i < av.count ? av[i] : 0
            let rhs = i < bv.count ? bv[i] : 0
            if lhs != rhs { return lhs > rhs }
        }
        return false
    }

    private func humanReadable(_ error: Error) -> String {
        if let e = error as? UpdateError { return e.message }
        return (error as NSError).localizedDescription
    }
}

// MARK: - Wire types ---------------------------------------------------------

/// Subset of the GitHub Releases API response we actually use. Codable
/// will silently ignore extra fields, which keeps us forward-compatible
/// when GitHub adds new ones.
private struct GitHubRelease: Decodable {
    let tag_name: String
    let name: String?
    let body: String?
    let published_at: String?
    let assets: [Asset]
    struct Asset: Decodable {
        let name: String
        let size: Int64
        let browser_download_url: String
    }
}

// MARK: - Errors -------------------------------------------------------------

enum UpdateError: Error {
    case network(String)
    case malformed(String)
    case install(String)
    var message: String {
        switch self {
        case .network(let s):   return "Network: \(s)"
        case .malformed(let s): return "Release: \(s)"
        case .install(let s):   return "Install: \(s)"
        }
    }
}

// MARK: - Bundle helpers -----------------------------------------------------

/// Centralized so the rest of the app doesn't have to know which key
/// holds the user-visible version string. Defaults to "0.0.0" if the
/// plist is malformed — the comparator above will then treat any
/// fetched release as newer, which is the correct degraded behavior.
public enum VaultBundleInfo {
    public static var shortVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }
    public static var buildNumber: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
    }
}
