import Foundation

// =========================================================================
// OverlayKeychain
// -------------------------------------------------------------------------
// Storage for the overlay's per-provider BYO API key.
//
// We *used* to back this with the macOS login keychain
// (`SecItemAdd` / `SecItemCopyMatching` against
// `kSecClassGenericPassword`, service `com.coreycrooks.thevault.overlay`).
// That broke for users who installed the DMG: every release of an
// ad-hoc-signed bundle has a different ad-hoc code signature, so the
// keychain item's trusted-app ACL never matches the running app's
// signature and macOS prompts for the user's login keychain password
// on every read of the key. Once a key was on file, the user got the
// `"The Vault wants to use your confidential information stored in
// com.coreycrooks.thevault.overlay"` modal on every overlay action.
// `SecItemDelete` exhibits the same prompt for items whose ACL the
// running signature didn't create, so even a "best-effort migrate
// then delete" path can't cleanly recover.
//
// What it actually buys for an ad-hoc-signed sideloaded app: nothing.
// Any process running as the user can already read the file system,
// and there's no other user of this Mac that could see this app's
// keychain group anyway (we don't share an access-group entitlement;
// without a Team ID we can't). The keychain prompt was protecting
// against a threat that doesn't exist in this distribution model
// while breaking the actual product.
//
// New backing store: a JSON file at
//
//   ~/Library/Application Support/AscensionCompanion/vault/overlay-keys.json
//
// with directory perms `0700`, file perms `0600`, and per-value XOR
// scrambling against a fixed app secret. The XOR is *obfuscation*,
// not encryption — it stops the value from showing up as plaintext
// in `cat`, `grep`, Spotlight indexes, or backup tools that don't
// honour file perms. Anyone with the bundle and the file can recover
// it; that's true of the keychain in this distribution model too.
//
// The public surface (`apiKey(for:)`, `hasKey(for:)`,
// `setAPIKey(_:for:)`, `delete(account:)`) is unchanged so call sites
// in OverlayAIService / OverlayViews / BetaView don't need to know.
// We keep the type name `OverlayKeychain` for the same reason — pure
// search-and-replace would have churned a lot of files for no gain.
// =========================================================================

enum OverlayKeychain {
    /// Logical service identifier — matches the historical keychain
    /// service for continuity with logs, docs, and SECURITY.md prose.
    static let service = "com.coreycrooks.thevault.overlay"

    @discardableResult
    static func setAPIKey(_ key: String, for account: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return delete(account: account)
        }
        return OverlayKeyStore.shared.set(account: account, value: trimmed)
    }

    static func apiKey(for account: String) -> String? {
        OverlayKeyStore.shared.get(account: account)
    }

    static func hasKey(for account: String) -> Bool {
        guard let s = apiKey(for: account) else { return false }
        return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @discardableResult
    static func delete(account: String) -> Bool {
        OverlayKeyStore.shared.delete(account: account)
    }
}

// =========================================================================
// OverlayKeyStore
// -------------------------------------------------------------------------
// File-backed JSON store for overlay BYO keys. Single-process model
// (the overlay only runs in the foreground app) so we don't need
// cross-process locks — a serial DispatchQueue serialises reads and
// writes within the process, and we always write atomically via a
// temp-file rename so a crash mid-write can't truncate the file.
// =========================================================================

private final class OverlayKeyStore {
    static let shared = OverlayKeyStore()

    private let queue = DispatchQueue(label: "vault.overlay.keystore", qos: .userInitiated)
    private let fileURL: URL
    private var cache: [String: String] = [:]
    private var loaded = false

    /// Static obfuscation key. Not a secret — the bundle ships with it.
    /// Its only job is to keep `cat overlay-keys.json` from emitting
    /// readable API keys on the user's terminal.
    private static let scrambleKey: [UInt8] = Array(
        "vault-overlay-byok/v1".utf8
    )

    private init() {
        let support = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first!
        self.fileURL = support
            .appendingPathComponent("AscensionCompanion", isDirectory: true)
            .appendingPathComponent("vault", isDirectory: true)
            .appendingPathComponent("overlay-keys.json")
    }

    // MARK: - Public API (called via OverlayKeychain)

    func get(account: String) -> String? {
        queue.sync {
            ensureLoadedLocked()
            return cache[account]
        }
    }

    func set(account: String, value: String) -> Bool {
        queue.sync {
            ensureLoadedLocked()
            cache[account] = value
            return persistLocked()
        }
    }

    func delete(account: String) -> Bool {
        queue.sync {
            ensureLoadedLocked()
            guard cache.removeValue(forKey: account) != nil else {
                // No key for this account — treat as success so callers
                // that "delete on empty input" don't see spurious failures.
                return true
            }
            return persistLocked()
        }
    }

    // MARK: - Internals (must be called on `queue`)

    private func ensureLoadedLocked() {
        guard !loaded else { return }
        loaded = true
        guard let raw = try? Data(contentsOf: fileURL) else { return }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: raw) else { return }
        var rebuilt: [String: String] = [:]
        for (account, scrambled) in envelope.entries {
            guard let bytes = Data(base64Encoded: scrambled) else { continue }
            guard let decoded = Self.unscramble(bytes) else { continue }
            rebuilt[account] = decoded
        }
        self.cache = rebuilt
    }

    private func persistLocked() -> Bool {
        let dir = fileURL.deletingLastPathComponent()
        do {
            // Directory: create if missing, then tighten perms to 0700 so
            // other local users can't list/read the contents.
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
            )
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o700))],
                ofItemAtPath: dir.path
            )

            var encoded: [String: String] = [:]
            for (account, raw) in cache {
                encoded[account] = Self.scramble(raw).base64EncodedString()
            }
            let envelope = Envelope(version: 1, entries: encoded)
            let data = try JSONEncoder().encode(envelope)

            // Atomic write
            try data.write(to: fileURL, options: .atomic)
            try? FileManager.default.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: fileURL.path
            )
            return true
        } catch {
            return false
        }
    }

    // MARK: - Scrambling

    /// XOR a UTF-8 string against `scrambleKey` (cycled). Pure
    /// obfuscation — see file header.
    private static func scramble(_ s: String) -> Data {
        let bytes = Array(s.utf8)
        var out = [UInt8](repeating: 0, count: bytes.count)
        for i in 0..<bytes.count {
            out[i] = bytes[i] ^ scrambleKey[i % scrambleKey.count]
        }
        return Data(out)
    }

    private static func unscramble(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        var out = [UInt8](repeating: 0, count: bytes.count)
        for i in 0..<bytes.count {
            out[i] = bytes[i] ^ scrambleKey[i % scrambleKey.count]
        }
        return String(bytes: out, encoding: .utf8)
    }

    // MARK: - File envelope

    /// On-disk shape. Versioned so we can evolve the scramble or
    /// migrate to OS-protected storage later without forcing users
    /// to re-paste their key.
    private struct Envelope: Codable {
        let version: Int
        let entries: [String: String]
    }
}
