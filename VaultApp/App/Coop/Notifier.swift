import Foundation
import UserNotifications

/// Thin wrapper around `UNUserNotificationCenter` so the rest of the app can
/// fire-and-forget notifications without dragging in the framework everywhere.
enum Notifier {

    /// Request notification authorization once at app launch. Safe to call
    /// repeatedly — the system caches the user's decision.
    @MainActor
    static func requestAuthorization() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in
            // Silent — the user-facing prompt itself is the feedback.
        }
    }

    static func notify(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let req = UNNotificationRequest(identifier: UUID().uuidString,
                                        content: content,
                                        trigger: nil)
        UNUserNotificationCenter.current().add(req) { _ in }
    }
}
