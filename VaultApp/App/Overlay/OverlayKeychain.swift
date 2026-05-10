import Foundation
import Security

// =========================================================================
// OverlayKeychain
// -------------------------------------------------------------------------
// Tiny wrapper over the Security framework for the overlay's per-provider
// API key. Stored in the user's login keychain — never on disk in plain
// text, never sent to the matchmaking server, never logged.
//
// We key entries by `service` ("com.coreycrooks.thevault.overlay") plus a
// per-provider `account` ("openai", "anthropic", …) so adding a provider
// later doesn't invalidate the others. All operations are synchronous —
// the keychain is fast for items this small (a few dozen characters).
// =========================================================================

enum OverlayKeychain {
    static let service = "com.coreycrooks.thevault.overlay"

    /// Save (or replace) the API key for the given provider account.
    /// Returns true on success. We delete-then-add rather than `kSecValueData`
    /// update because some keychain ACLs reject in-place updates and the
    /// add path always works. Keys this small (a few dozen chars) make
    /// the duplicate-write cost irrelevant.
    @discardableResult
    static func setAPIKey(_ key: String, for account: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return delete(account: account)
        }
        // Best-effort delete first so add doesn't 'duplicate item' error.
        _ = delete(account: account)
        guard let data = trimmed.data(using: .utf8) else { return false }
        let attrs: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
            kSecValueData as String:    data,
            // Available even when the device is locked-on-first-unlock
            // — same posture as Steam's session token. We're not protecting
            // against a stolen-and-unlocked Mac, only against the disk being
            // read by something that isn't macOS itself.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// Look up a previously-stored API key. Returns nil if missing.
    static func apiKey(for account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String:  kSecMatchLimitOne,
            kSecReturnData as String:  true,
        ]
        var item: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        return str
    }

    /// Whether a non-empty key is on file for the given account.
    static func hasKey(for account: String) -> Bool {
        guard let s = apiKey(for: account) else { return false }
        return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Delete the API key. No-op when there's nothing to delete.
    @discardableResult
    static func delete(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
