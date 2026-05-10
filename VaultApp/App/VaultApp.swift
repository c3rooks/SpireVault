import SwiftUI
import AppKit

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

            // Replace macOS's stock "About <App>" with our own branded
            // panel — credits, version, build, link to GitHub. Keeps
            // the menu in the canonical position (Vault → About) so
            // users find it where macOS taught them to look.
            CommandGroup(replacing: .appInfo) {
                Button("About The Vault") { showAboutPanel() }
            }
            // Sit the updater right after About, the same neighborhood
            // every macOS user already learned from Safari, Xcode, etc.
            // Both auto-checks (every 6h on launch) and this manual
            // path funnel through `UpdateService.checkForUpdates`,
            // which then transitions through `updateAvailable →
            // downloading → readyToInstall → installing → relaunch`.
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") {
                    presentUpdatesUI()
                }
                .keyboardShortcut("u", modifiers: [.command, .shift])
                Divider()
            }

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

            // Replace the stock Help menu (which would point at a
            // non-existent .help bundle) with deep links to the public
            // resources users actually need: README, changelog, issue
            // tracker, and the in-app News tab.
            CommandGroup(replacing: .help) {
                Button("Spire Vault Help") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/c3rooks/SpireVault#readme")!)
                }
                .keyboardShortcut("?", modifiers: [.command])
                Button("What's New") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/c3rooks/SpireVault/blob/main/CHANGELOG.md")!)
                }
                Divider()
                Button("Run Coach (Beta) — How it works") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/c3rooks/SpireVault#run-coach-beta")!)
                }
                Button("Marketing Site") {
                    NSWorkspace.shared.open(URL(string: "https://spirevault.app")!)
                }
                Divider()
                Button("Report a Bug…") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/c3rooks/SpireVault/issues/new?labels=bug")!)
                }
                Button("Request a Feature…") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/c3rooks/SpireVault/issues/new?labels=enhancement")!)
                }
                Button("View Source on GitHub") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/c3rooks/SpireVault")!)
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

    // MARK: - Menu actions

    /// Show macOS's stock "About" panel, but with our own credits +
    /// version line. Falls back to the system default if our values
    /// can't be read.
    private func showAboutPanel() {
        let version = VaultBundleInfo.shortVersion
        let build = VaultBundleInfo.buildNumber
        let creditsHTML = """
        <p style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 11px; color: #ccc;">
        A free, open-source companion for <b>Slay the Spire 2</b>.<br/>
        Stats &middot; Co-op &middot; Run Coach (Beta).
        </p>
        <p style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 10px; color: #888;">
        Made by <a href="https://coreycrooks.com">Corey Crooks</a> &middot;
        <a href="https://github.com/c3rooks/SpireVault">github.com/c3rooks/SpireVault</a>
        </p>
        """
        let credits = NSAttributedString(
            string: "A free, open-source companion for Slay the Spire 2.\nStats · Co-op · Run Coach (Beta).\n\nMade by Corey Crooks · github.com/c3rooks/SpireVault",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )
        _ = creditsHTML // reserved for a future custom-window About panel
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: credits,
            .applicationVersion: version,
            .version: build,
        ])
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Manual "Check for Updates" entry point. Triggers a user-initiated
    /// check (which surfaces network failures) and opens the Settings
    /// window so the result has somewhere to land — the Updates block
    /// at the top of Settings shows the live state, progress bar, and
    /// install button.
    private func presentUpdatesUI() {
        Task {
            await state.updateService.checkForUpdates(userInitiated: true)
        }
        // Open the SwiftUI Settings scene so the user sees the result.
        // selectAll: works around a longstanding AppKit quirk where the
        // Settings menu item is the only reliable way to surface the
        // .Settings scene programmatically across macOS 13–14.
        if #available(macOS 14.0, *) {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        } else {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }
}
