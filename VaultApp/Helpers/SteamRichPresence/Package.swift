// swift-tools-version: 5.10
//
// SpireVaultHelper — tiny macOS LaunchAgent that watches the Steam
// process via NSWorkspace + the Steam client's registry file, and
// POSTs state changes to the SpireVault `/coop/rich-presence/ingest`
// endpoint so the user's lobby presence flips automatically when
// STS2 boots / quits.
//
// Build (universal binary):
//   cd VaultApp/Helpers/SteamRichPresence
//   swift build -c release --arch arm64 --arch x86_64
//
// Output binary:
//   .build/apple/Products/Release/SpireVaultHelper
//
// Spec: docs/coop-steam-rich-presence-spec.md
//
// Why SwiftPM and not the main Vault.app Xcode project: the helper
// is a separate, never-foreground LaunchAgent binary. Mixing it into
// the main xcodegen project complicates code-signing entitlements
// (the main app is sandboxed; the helper deliberately is not, so it
// can read ~/Library/Application Support/Steam/). A standalone
// SwiftPM module keeps the boundaries clean. The main Makefile in
// VaultApp/ wires both builds together for release packaging.

import PackageDescription

let package = Package(
  name: "SpireVaultHelper",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "SpireVaultHelper",
      path: "Sources/SpireVaultHelper",
      resources: [
        // The LaunchAgent plist is shipped alongside the binary so
        // the installer pkg can drop it into ~/Library/LaunchAgents/.
        .copy("../../Resources/com.spirevault.helper.plist"),
      ],
      swiftSettings: [
        .enableUpcomingFeature("ConciseMagicFile"),
        .enableUpcomingFeature("ExistentialAny"),
      ]
    )
  ]
)
