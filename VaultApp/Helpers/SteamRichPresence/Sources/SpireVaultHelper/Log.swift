// Log — minimal stderr logger for the helper.
//
// The helper runs as a LaunchAgent so stdout is captured by launchd
// and persisted to ~/Library/Logs/SpireVaultHelper/stdout.log via the
// plist's StandardOutPath. We just print plain lines; launchd handles
// rotation.

import Foundation

enum Log {
  static func info(_ message: @autoclosure () -> String) {
    write("INFO ", message())
  }
  static func warn(_ message: @autoclosure () -> String) {
    write("WARN ", message())
  }
  static func error(_ message: @autoclosure () -> String) {
    write("ERROR", message())
  }

  private static let formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  private static func write(_ level: String, _ msg: String) {
    let ts = formatter.string(from: Date())
    FileHandle.standardError.write(Data("\(ts) \(level) \(msg)\n".utf8))
  }
}
