// SteamWatcher — observes Steam state on macOS.
//
// Two layered signals, OR'd together for resilience:
//
//   1. NSWorkspace launch/terminate notifications for the Steam bundle.
//      Fires instantly when Steam quits or starts. Coarse — doesn't
//      tell us which game is running.
//
//   2. Polling Steam's `~/Library/Application Support/Steam/registry.vdf`
//      for the `RunningAppID` key. Steam writes this each time a game
//      starts/stops. Confirms the running game is STS2 (App ID 2868840).
//
// Combined effect: we know within ~1s whether STS2 is in-game,
// Steam-in-menu, or not running at all.

import Foundation
import AppKit

enum SteamState: Equatable {
  case inGame
  case inMenu
  case notRunning

  var wireValue: String {
    switch self {
    case .inGame:    return "in-game"
    case .inMenu:    return "in-menu"
    case .notRunning: return "not-running"
    }
  }
}

struct SteamSnapshot {
  let state: SteamState
  let activityDetail: String?
}

final class SteamWatcher {
  /// Steam's bundle identifier on macOS.
  private let steamBundleID = "com.valvesoftware.steam"

  /// STS2 App ID.
  private let stsAppId = HelperOptions.stsAppId

  /// Polled every 1s while Steam is up; throttled to every 5s when down.
  private var pollTimer: (any DispatchSourceTimer)?
  private var notifTokens: [any NSObjectProtocol] = []

  /// Callback fired on state change. Always called on the main queue.
  var onChange: ((SteamState, String?) -> Void)?

  private var lastState: SteamState = .notRunning
  private var lastDetail: String?

  /// Begin observing. Idempotent.
  func start() {
    if pollTimer != nil { return }

    let nc = NSWorkspace.shared.notificationCenter
    notifTokens.append(nc.addObserver(
      forName: NSWorkspace.didLaunchApplicationNotification,
      object: nil, queue: .main
    ) { [weak self] note in
      guard
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
        app.bundleIdentifier == self?.steamBundleID
      else { return }
      self?.tick(reason: "steam-launched")
    })
    notifTokens.append(nc.addObserver(
      forName: NSWorkspace.didTerminateApplicationNotification,
      object: nil, queue: .main
    ) { [weak self] note in
      guard
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
        app.bundleIdentifier == self?.steamBundleID
      else { return }
      self?.tick(reason: "steam-terminated")
    })

    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 1.0, repeating: 1.0)
    t.setEventHandler { [weak self] in self?.tick(reason: "poll") }
    t.resume()
    pollTimer = t
    Log.info("SteamWatcher started")
  }

  func stop() {
    pollTimer?.cancel()
    pollTimer = nil
    let nc = NSWorkspace.shared.notificationCenter
    for t in notifTokens { nc.removeObserver(t) }
    notifTokens = []
  }

  /// Synchronous current-state probe. Used by main.swift for the
  /// startup heartbeat without waiting for the first tick.
  func snapshot() -> SteamSnapshot {
    let (state, detail) = probe()
    return SteamSnapshot(state: state, activityDetail: detail)
  }

  // MARK: - Internals

  private func tick(reason: String) {
    let (state, detail) = probe()
    if state == lastState && detail == lastDetail { return }
    lastState = state
    lastDetail = detail
    onChange?(state, detail)
  }

  /// Read the union of NSWorkspace + registry.vdf to compute state.
  private func probe() -> (SteamState, String?) {
    let steamRunning = NSWorkspace.shared.runningApplications.contains { app in
      app.bundleIdentifier == steamBundleID
    }
    if !steamRunning { return (.notRunning, nil) }

    // Steam is running. Check the registry for an active game.
    if let runningAppID = readRunningAppID(), runningAppID == stsAppId {
      let detail = readRichPresenceDetail()
      return (.inGame, detail)
    }
    return (.inMenu, nil)
  }

  /// Parse `~/Library/Application Support/Steam/registry.vdf` for
  /// the `RunningAppID` value. VDF is Valve's text key/value format.
  private func readRunningAppID() -> Int? {
    let path = NSHomeDirectory() + "/Library/Application Support/Steam/registry.vdf"
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
      return nil
    }
    // Match: "RunningAppID"\t\t"2868840"
    // The pattern is generous — VDF whitespace is fluid.
    let pattern = #""RunningAppID"\s*"(\d+)""#
    guard
      let regex = try? NSRegularExpression(pattern: pattern),
      let match = regex.firstMatch(
        in: text,
        range: NSRange(text.startIndex..., in: text)
      ),
      match.numberOfRanges >= 2,
      let r = Range(match.range(at: 1), in: text)
    else { return nil }
    return Int(text[r])
  }

  /// Try to read Steam Rich Presence localised string for the
  /// current user. The format is parsed out of
  /// `~/Library/Application Support/Steam/userdata/<id>/config/
  /// localconfig.vdf` if present. Best-effort — returns nil on any
  /// parse failure. v0.12.0 keeps this conservative (just the
  /// `steam_display` token); v0.13 wires the full localisation pass.
  private func readRichPresenceDetail() -> String? {
    let base = NSHomeDirectory() + "/Library/Application Support/Steam/userdata/"
    guard let entries = try? FileManager.default.contentsOfDirectory(atPath: base) else {
      return nil
    }
    for sub in entries {
      let cfg = base + sub + "/config/localconfig.vdf"
      if FileManager.default.fileExists(atPath: cfg) {
        if let text = try? String(contentsOfFile: cfg, encoding: .utf8) {
          // Look for `"2868840"` block then a `"steam_display"\t"#..."` line.
          let pattern = #""2868840"\s*\{[^}]*?"steam_display"\s*"([^"]+)""#
          if let r = try? NSRegularExpression(pattern: pattern, options: .dotMatchesLineSeparators) {
            if let m = r.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
               m.numberOfRanges >= 2,
               let rr = Range(m.range(at: 1), in: text) {
              let raw = String(text[rr])
              // `#StatusInGame` style tokens — strip the leading #.
              return raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
            }
          }
        }
      }
    }
    return nil
  }
}
