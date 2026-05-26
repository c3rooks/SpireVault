// SessionTokenStore — read the SpireVault session token from the
// user's keychain. The Vault.app writes it via a `postMessage`
// handshake the first time the user opens the web app with the
// helper installed; we just read.
//
// Keychain item:
//   service: com.spirevault.session
//   account: <Steam ID — empty string accepted as wildcard for now>
//
// The Vault.app writes the same item shape (see
// VaultApp/App/Coop/SteamAuth.swift for the writer side). The helper
// only ever reads.

import Foundation
import Security

final class SessionTokenStore {
  private let service = "com.spirevault.session"

  /// Returns the token string, or nil if the item is missing /
  /// unreadable. Never throws — logs and returns nil instead.
  func readToken() -> String? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data,
       let token = String(data: data, encoding: .utf8), !token.isEmpty {
      return token
    }
    // Some macOS versions (esp. behind FileVault) refuse the keychain
    // read until the user has logged in interactively. We exit cleanly
    // in that case — the LaunchAgent will respawn us on next login.
    if status != errSecSuccess && status != errSecItemNotFound {
      Log.warn("Keychain read failed with OSStatus \(status)")
    }
    // Fallback: read a plaintext token at
    // ~/Library/Application Support/SpireVault/session-token
    // if present. This is the path Vault.app uses on first-run
    // before the keychain entry is sealed. Treated as a one-shot —
    // we don't delete the file (Vault.app cleans up on next launch).
    let fallback = applicationSupportFile("session-token")
    if let data = try? Data(contentsOf: fallback),
       let token = String(data: data, encoding: .utf8)?
                       .trimmingCharacters(in: .whitespacesAndNewlines),
       !token.isEmpty {
      _ = query.removeValue(forKey: kSecMatchLimit as String)
      _ = query.removeValue(forKey: kSecReturnData as String)
      // Best-effort: seal the fallback into the keychain so we don't
      // depend on the plaintext file going forward.
      var addQuery = query
      addQuery[kSecValueData as String] = Data(token.utf8)
      addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
      if addStatus != errSecSuccess && addStatus != errSecDuplicateItem {
        Log.warn("Failed to seal fallback token into keychain: \(addStatus)")
      }
      return token
    }
    return nil
  }

  private func applicationSupportFile(_ name: String) -> URL {
    let base = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask
    ).first ?? URL(fileURLWithPath: NSHomeDirectory())
    return base
      .appendingPathComponent("SpireVault", isDirectory: true)
      .appendingPathComponent(name)
  }
}
