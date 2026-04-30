import SwiftUI

@main
struct VaultApp: App {
    @StateObject private var state = AppState()

    init() {
        Notifier.requestAuthorization()
    }

    var body: some Scene {
        WindowGroup("The Vault") {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 1080, minHeight: 700)
                .preferredColorScheme(.dark)
                .task { await state.bootstrap() }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Vault") {
                Button("Rescan Saves") {
                    Task { await state.scan(); state.attachStatsToProfile() }
                }
                .keyboardShortcut("r")
                Button("Reveal Save Folder in Finder") { state.revealSaveFolder() }
                Divider()
                Button("Export CSV…") { state.exportCSV() }
                    .keyboardShortcut("e")
                Divider()
                Button("Refresh Co-op Feed") {
                    Task { await state.presenceService?.refresh() }
                }
                .keyboardShortcut("l")
                .disabled(state.presenceService == nil)
                Button(state.steamAuth.isSignedIn ? "Sign Out of Steam" : "Sign In with Steam…") {
                    if state.steamAuth.isSignedIn {
                        Task { await state.presenceService?.goOffline() }
                        state.steamAuth.signOut()
                    } else {
                        state.steamAuth.signIn(via: state.config.effectiveServerURL)
                    }
                }
            }
        }

        Settings {
            SettingsView()
                .environmentObject(state)
                .frame(width: 540, height: 480)
                .preferredColorScheme(.dark)
        }
    }
}
