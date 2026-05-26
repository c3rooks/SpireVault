// SpireVaultHelper — entrypoint.
//
// Lifecycle:
//   1. Read the SpireVault session token from the user's keychain.
//      If missing → log + exit cleanly (the user hasn't signed into
//      SpireVault yet). LaunchAgent will respawn us on next login.
//   2. Start watching Steam state. SteamWatcher fires `.gameStarted`,
//      `.gameStopped`, and `.menuActive` callbacks.
//   3. On every state change AND on a 60-second heartbeat (while
//      STS2 is running) / 120-second heartbeat (while idle), POST
//      the current state to /coop/rich-presence/ingest.
//   4. Check ~/Library/Application Support/SpireVault/helper-disabled
//      every 60 seconds; if it exists, exit cleanly.
//
// Errors are logged but never crash the process — the helper must be
// boring and reliable, like a smoke detector.

import Foundation
import AppKit  // for NSWorkspace

let opts = HelperOptions.parse(CommandLine.arguments)

if opts.printVersion {
  print("SpireVaultHelper \(HelperOptions.version)")
  exit(0)
}

Log.info("SpireVaultHelper \(HelperOptions.version) starting")

// Honor opt-out file. Checked once at start and on every 60s heartbeat.
let optOutPath = HelperOptions.optOutFlagPath()
if FileManager.default.fileExists(atPath: optOutPath.path) {
  Log.info("Opt-out flag present at \(optOutPath.path) — exiting cleanly")
  exit(0)
}

let tokenStore = SessionTokenStore()
guard let token = tokenStore.readToken() else {
  Log.warn("No SpireVault session token in keychain — exiting. Sign into the web app once, then re-launch this helper.")
  exit(0)
}

let client = IngestClient(baseURL: opts.baseURL, sessionToken: token)
let watcher = SteamWatcher()

// `RunLoop.main.run()` keeps the process alive. The watcher's
// callbacks fire from NSWorkspace's notification queue (main thread),
// and the heartbeat fires from a DispatchSource on the main queue.
//
// We post on every state change and on a heartbeat tick so a missed
// notification (laptop sleep, NSWorkspace bug) gets reconciled within
// 60s instead of never.

var lastReportedState: SteamState = .notRunning
var lastReportAt: Date = .distantPast

func report(state: SteamState, activityDetail: String?, reason: String) {
  let now = Date()
  Log.info("Reporting state=\(state.wireValue) reason=\(reason) detail=\(activityDetail ?? "-")")
  client.send(
    state: state,
    activityDetail: activityDetail,
    reportedAt: now,
    helperVersion: HelperOptions.version,
    hostOS: "macos",
    stsAppId: HelperOptions.stsAppId
  ) { result in
    switch result {
    case .success:
      lastReportedState = state
      lastReportAt = now
    case .failure(let err):
      Log.warn("Ingest failed: \(err.localizedDescription) — will retry on next heartbeat")
    }
  }
}

watcher.onChange = { state, detail in
  report(state: state, activityDetail: detail, reason: "change")
}

// Heartbeat tick.
let timer = DispatchSource.makeTimerSource(queue: .main)
let runningInterval: DispatchTimeInterval = .seconds(60)
let idleInterval: DispatchTimeInterval = .seconds(120)

func scheduleHeartbeat() {
  let interval = (lastReportedState == .inGame) ? runningInterval : idleInterval
  timer.schedule(deadline: .now() + interval, repeating: interval)
}

timer.setEventHandler {
  // Opt-out check.
  if FileManager.default.fileExists(atPath: optOutPath.path) {
    Log.info("Opt-out flag present — exiting cleanly")
    exit(0)
  }
  let snapshot = watcher.snapshot()
  // Only emit if it's been ≥30s since the last successful report —
  // change events are still primary; this is the safety net.
  if Date().timeIntervalSince(lastReportAt) < 30 { return }
  report(state: snapshot.state, activityDetail: snapshot.activityDetail, reason: "heartbeat")
  scheduleHeartbeat()
}
scheduleHeartbeat()
timer.resume()

// Initial probe: emit current state so server gets a sample within
// the first few seconds of helper start.
let initial = watcher.snapshot()
report(state: initial.state, activityDetail: initial.activityDetail, reason: "startup")

// Start observing NSWorkspace.
watcher.start()

// Keep the process alive.
RunLoop.main.run()
