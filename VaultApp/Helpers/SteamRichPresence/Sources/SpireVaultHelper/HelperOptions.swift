// HelperOptions — parses command-line args + constants.
//
// Args (all optional):
//   --base-url <URL>     defaults to https://vault-coop.coreycrooks.workers.dev
//   --version            print version and exit
//
// Why a tiny home-grown parser instead of ArgumentParser: keeps the
// helper a single-target package with zero external dependencies.
// Smaller binary, faster builds, fewer surprises in code-signing.

import Foundation

struct HelperOptions {
  static let version = "0.12.0"

  /// STS2 Steam App ID. Used to validate the helper is reporting
  /// for the right game. Sent on every ingest.
  static let stsAppId: Int = 2868840

  /// Default production worker URL. Override with `--base-url` for
  /// staging or local dev (`http://localhost:8787`).
  static let defaultBaseURL = URL(string: "https://vault-coop.coreycrooks.workers.dev")!

  /// Path the helper checks every 60s. If it exists, the helper
  /// exits cleanly. The Vault.app settings panel toggles it.
  static func optOutFlagPath() -> URL {
    let appSupport = FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask
    ).first ?? URL(fileURLWithPath: NSHomeDirectory())
    return appSupport
      .appendingPathComponent("SpireVault", isDirectory: true)
      .appendingPathComponent("helper-disabled")
  }

  var baseURL: URL
  var printVersion: Bool

  static func parse(_ argv: [String]) -> HelperOptions {
    var baseURL = defaultBaseURL
    var printVersion = false
    var i = 1
    while i < argv.count {
      let a = argv[i]
      switch a {
      case "--version":
        printVersion = true
        i += 1
      case "--base-url":
        if i + 1 < argv.count, let u = URL(string: argv[i + 1]) {
          baseURL = u
          i += 2
        } else {
          i += 1
        }
      default:
        i += 1
      }
    }
    return HelperOptions(baseURL: baseURL, printVersion: printVersion)
  }
}
