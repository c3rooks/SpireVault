import SwiftUI
import VaultCore

struct SettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var advancedOpen = false
    @State private var customURLInput = ""
    @State private var customURLError: String?
    @State private var customURLSavedAt: Date?

    var body: some View {
        ZStack {
            Theme.bgPrimary.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("SETTINGS")
                        .font(.system(size: 11, weight: .heavy, design: .rounded))
                        .tracking(2)
                        .foregroundStyle(Theme.textSecondary)

                    updateBlock
                    saveFolderBlock
                    historyFileBlock
                    matchmakingBlock
                    steamProfileBlock
                    diagnosticsBlock
                }
                .padding(20)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            customURLInput = state.config.customServerURL?.absoluteString ?? ""
            advancedOpen = state.config.customServerURL != nil
        }
    }

    /// "Updates" block. Shows the current version, when we last
    /// checked, and the relevant action button(s) for whatever state
    /// the UpdateService is in. The whole flow is gated by user
    /// gestures — we never silently download or install.
    private var updateBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Updates", systemImage: "arrow.down.circle")
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("The Vault \(state.updateService.currentVersion)")
                            .font(.system(size: 12, weight: .heavy))
                            .foregroundStyle(Theme.textPrimary)
                        Text(updateStatusLine)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    updateActions
                }

                if case let .downloading(progress, _) = state.updateService.status {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .tint(Theme.accent)
                }

                if !releaseNotesPreview.isEmpty {
                    DisclosureGroup {
                        Text(releaseNotesPreview)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding(.top, 6)
                    } label: {
                        Label("What's in this update", systemImage: "list.bullet.rectangle")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
            }
            .premiumPanel(padding: 12, cornerRadius: 10)
        }
    }

    private var updateStatusLine: String {
        switch state.updateService.status {
        case .idle:
            return "Last checked: never. Click \"Check for updates\" to look for a newer build on GitHub Releases."
        case .checking:
            return "Checking GitHub Releases for a newer build…"
        case let .upToDate(version, _):
            return "You're on the latest release (\(version))."
        case let .updateAvailable(latest):
            return "A newer build is available: \(latest.tag) — \(latest.name)."
        case let .downloading(progress, latest):
            let pct = Int((progress * 100).rounded())
            return "Downloading \(latest.tag) (\(pct)% of \(formatBytes(latest.dmgSize)))…"
        case let .readyToInstall(_, latest):
            return "Ready to install \(latest.tag). The Vault will relaunch automatically."
        case .installing:
            return "Installing — this should only take a few seconds."
        case let .failed(message):
            return "Update failed: \(message)"
        }
    }

    @ViewBuilder
    private var updateActions: some View {
        switch state.updateService.status {
        case .idle, .upToDate, .failed:
            Button("Check for updates") {
                Task { await state.updateService.checkForUpdates(userInitiated: true) }
            }
            .controlSize(.small)
        case .checking:
            ProgressView().controlSize(.small)
        case .updateAvailable:
            HStack(spacing: 8) {
                Button("Download update") {
                    Task { await state.updateService.downloadUpdate() }
                }
                .controlSize(.small)
                .keyboardShortcut(.defaultAction)
                Button("View on GitHub") { state.updateService.openReleasePage() }
                    .controlSize(.small)
            }
        case .downloading:
            ProgressView().controlSize(.small)
        case .readyToInstall:
            Button("Install & relaunch") {
                Task { await state.updateService.installAndRelaunch() }
            }
            .controlSize(.small)
            .keyboardShortcut(.defaultAction)
        case .installing:
            ProgressView().controlSize(.small)
        }
    }

    private var releaseNotesPreview: String {
        if case let .updateAvailable(info) = state.updateService.status {
            return String(info.notes.prefix(2400))
        }
        if case let .readyToInstall(_, info) = state.updateService.status {
            return String(info.notes.prefix(2400))
        }
        return ""
    }

    private func formatBytes(_ bytes: Int64) -> String {
        let f = ByteCountFormatter()
        f.allowedUnits = [.useMB]
        f.countStyle = .file
        return f.string(fromByteCount: bytes)
    }

    private var saveFolderBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Save folder", systemImage: "folder")
            HStack {
                Text(state.saveFolder?.path ?? "Not set")
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1).truncationMode(.head)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Change…") { state.chooseSaveFolder() }.controlSize(.small)
            }
            .premiumPanel(padding: 12, cornerRadius: 10)
        }
    }

    private var historyFileBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("History file", systemImage: "doc.text")
            HStack {
                Text(state.historyURL.path)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1).truncationMode(.head)
                    .foregroundStyle(Theme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Reveal") {
                    NSWorkspace.shared.activateFileViewerSelecting([state.historyURL])
                }
                .controlSize(.small)
            }
            .premiumPanel(padding: 12, cornerRadius: 10)
        }
    }

    private var matchmakingBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Co-op matchmaking", systemImage: "network")
            VStack(alignment: .leading, spacing: 12) {
                currentServerRow

                DisclosureGroup(isExpanded: $advancedOpen) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Override the matchmaking server. Useful for testing your own deployment of the open-source Worker (`Backend/`). Leave blank to use the bundled default.")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 8) {
                            TextField("https://your-deployment.workers.dev",
                                      text: $customURLInput)
                                .textFieldStyle(.plain)
                                .font(.system(size: 11, design: .monospaced))
                                .padding(8)
                                .background(Theme.cardBG, in: RoundedRectangle(cornerRadius: 6))
                                .overlay(RoundedRectangle(cornerRadius: 6)
                                    .stroke(Theme.cardBorder, lineWidth: 1))

                            Button("Save") { saveOverride() }
                                .controlSize(.small)
                            Button("Reset") {
                                customURLInput = ""
                                state.setCustomServer(nil)
                                customURLError = nil
                                customURLSavedAt = Date()
                            }
                            .controlSize(.small)
                            .disabled(state.config.customServerURL == nil)
                        }
                        if let customURLError {
                            Text(customURLError)
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.lossBright)
                        }
                        if customURLSavedAt != nil {
                            Text("Saved.")
                                .font(.system(size: 10))
                                .foregroundStyle(Theme.winBright)
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    Label("Advanced — custom server", systemImage: "wrench.adjustable")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .premiumPanel(padding: 12, cornerRadius: 10)
        }
    }

    private var currentServerRow: some View {
        HStack(spacing: 10) {
            Image(systemName: state.config.isUsingDefault ? "checkmark.seal.fill" : "wrench.adjustable")
                .foregroundStyle(state.config.isUsingDefault ? Theme.winBright : Theme.gold)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.config.isUsingDefault ? "Default matchmaking server" : "Custom matchmaking server")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(Theme.textPrimary)
                Text(state.config.effectiveServerURL.absoluteString)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
        }
    }

    private func saveOverride() {
        let trimmed = customURLInput.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            state.setCustomServer(nil)
            customURLError = nil
            customURLSavedAt = Date()
            return
        }
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            customURLError = "Enter a valid http(s) URL."
            return
        }
        state.setCustomServer(url)
        customURLError = nil
        customURLSavedAt = Date()
    }

    private var steamProfileBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Steam sign-in", systemImage: "person.crop.square")
            VStack(alignment: .leading, spacing: 8) {
                if let p = state.steamAuth.profile {
                    HStack(spacing: 10) {
                        Image(systemName: "checkmark.seal.fill")
                            .foregroundStyle(Theme.winBright)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.personaName).font(.system(size: 12, weight: .heavy))
                            Text(p.steamID)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(Theme.textSecondary)
                        }
                        Spacer()
                        Button("Sign out") {
                            Task { await state.presenceService?.goOffline() }
                            state.steamAuth.signOut()
                        }
                        .controlSize(.small)
                    }
                } else {
                    HStack {
                        Text("Not signed in. Open the Co-op tab to connect.")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textSecondary)
                        Spacer()
                        Button("Sign in with Steam") {
                            state.steamAuth.signIn(via: state.config.effectiveServerURL)
                        }
                        .controlSize(.small)
                    }
                }
            }
            .premiumPanel(padding: 12, cornerRadius: 10)
        }
    }

    private var diagnosticsBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Diagnostics", systemImage: "stethoscope")
            Button("Run Doctor") { state.runDoctor() }.controlSize(.small)
            if let report = state.doctorReport {
                ScrollView {
                    Text(report.render(theme: .plain))
                        .font(.system(size: 10, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .foregroundStyle(Theme.text)
                }
                .frame(height: 140)
                .padding(8)
                .background(Theme.bgDeep)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
