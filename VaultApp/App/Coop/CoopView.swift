import SwiftUI
import VaultCore
import AppKit

/// Co-op tab.
///
/// One screen, one job: show me who has The Vault open right now and how I
/// can reach them. There is no host/join/lobby UX — that was overengineered.
/// Coordination happens off-app over Steam friends or Discord; The Vault is
/// purely a presence feed.
struct CoopView: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        VStack(spacing: 0) {
            CoopHeader()
            Divider().background(Theme.cardBorder)
            content
        }
        .background(Theme.bgPrimary)
    }

    @ViewBuilder
    private var content: some View {
        if !app.steamAuth.isSignedIn {
            CoopSignInGate()
        } else if let svc = app.presenceService {
            PresenceFeed(service: svc)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Header

private struct CoopHeader: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Co-op").font(.system(size: 22, weight: .heavy, design: .serif))
                    .foregroundStyle(Theme.textPrimary)
                Text("Find someone to play with — message them on Steam or Discord.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            ConnectionPill(state: pillState, count: liveCount)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 16)
    }

    private var pillState: ConnectionPill.State {
        if !app.steamAuth.isSignedIn { return .signInRequired }
        guard let svc = app.presenceService else { return .signInRequired }
        return svc.isConnected ? .live : .offline
    }

    private var liveCount: Int? {
        guard pillState == .live else { return nil }
        return app.presenceService?.entries.count
    }
}

private struct ConnectionPill: View {
    enum State { case signInRequired, live, offline }
    let state: State
    let count: Int?

    var body: some View {
        let (color, text): (Color, String) = {
            switch state {
            case .signInRequired: return (Theme.goldSoft,   "SIGN IN")
            case .live:           return (Theme.winBright,  count.map { "\($0) ONLINE" } ?? "LIVE")
            case .offline:        return (Theme.lossBright, "OFFLINE")
            }
        }()
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).font(.system(size: 10, weight: .black))
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(color.opacity(0.10), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.5), lineWidth: 1))
    }
}

// MARK: - Sign-in gate

private struct CoopSignInGate: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                Image("VaultEmblem")
                    .resizable().aspectRatio(contentMode: .fit)
                    .frame(width: 90, height: 90)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(Theme.gold.opacity(0.5), lineWidth: 1))
                    .shadow(color: Theme.accent.opacity(0.5), radius: 16)

                VStack(spacing: 8) {
                    Text("Sign in with Steam to see who's around")
                        .font(.system(size: 22, weight: .heavy, design: .serif))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.textPrimary)
                    Text("The Vault uses Steam's official sign-in. Your password never leaves Valve. Once signed in, you'll see other players who have The Vault open right now and can reach out over Steam or Discord.")
                        .font(.system(size: 13))
                        .multilineTextAlignment(.center)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(maxWidth: 560)
                }

                Button {
                    app.steamAuth.signIn(via: app.config.effectiveServerURL)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "globe")
                        Text("Sign in with Steam")
                            .font(.system(size: 14, weight: .heavy))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 22).padding(.vertical, 12)
                    .background(
                        LinearGradient(colors: [Theme.accentBright, Theme.gold],
                                       startPoint: .leading, endPoint: .trailing),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .shadow(color: Theme.accent.opacity(0.5), radius: 10, x: 0, y: 4)
                }
                .buttonStyle(.plain)
                .help("Opens your browser. After Steam approves, you'll be redirected back to The Vault.")
            }
            .padding(28)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }
}

// MARK: - Feed

private struct PresenceFeed: View {
    @EnvironmentObject var app: AppState
    @ObservedObject var service: PresenceService

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                YourStatusCard(service: service)

                others

                if let err = service.lastError {
                    InfoNote("Couldn't reach the matchmaking server: \(err)")
                        .foregroundStyle(Theme.lossBright)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .refreshable { await service.refresh() }
    }

    @ViewBuilder
    private var others: some View {
        let mySID = app.steamAuth.profile?.steamID
        let visible = service.entries.filter { $0.steamID != mySID }
        let stats = app.steamAuth.profile?.stats

        SectionHeader(text: "PLAYERS ONLINE", count: visible.count)

        if visible.isEmpty {
            EmptyFeedState()
        } else {
            VStack(spacing: 10) {
                ForEach(visible) { entry in
                    PresenceRow(entry: entry, viewerStats: stats)
                }
            }
        }
    }
}

private struct SectionHeader: View {
    let text: String
    let count: Int?
    var body: some View {
        HStack(spacing: 8) {
            Text(text).font(.system(size: 10, weight: .black)).tracking(1.6)
                .foregroundStyle(Theme.textTertiary)
            if let count {
                Text("\(count)")
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(Theme.accentBright)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.accentBright.opacity(0.15), in: Capsule())
                    .overlay(Capsule().stroke(Theme.accentBright.opacity(0.5), lineWidth: 1))
            }
        }
    }
}

// MARK: - Your status card

private struct YourStatusCard: View {
    @EnvironmentObject var app: AppState
    @ObservedObject var service: PresenceService
    @State private var saveTask: Task<Void, Never>?

    var body: some View {
        let me = app.steamAuth.profile
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                Avatar(persona: me?.personaName ?? "?", urlString: me?.avatarURL,
                       diameter: 44, color: Theme.gold)
                VStack(alignment: .leading, spacing: 2) {
                    Text(me?.personaName ?? "—")
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundStyle(Theme.textPrimary)
                    if let s = me?.stats {
                        Text("\(s.skillTier.label) · \(s.skillTier.ascensionRange) · \(s.totalRuns) runs")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textTertiary)
                    } else {
                        Text("Steam connected")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
                Spacer()
                if !service.isConnected {
                    Label("Reconnecting…", systemImage: "arrow.triangle.2.circlepath")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.lossBright)
                }
            }

            statusPicker

            HStack(spacing: 10) {
                noteField
                discordField
            }
        }
        .padding(16)
        .background(
            LinearGradient(colors: [Theme.cardBGRaised, Theme.cardBG],
                           startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Theme.gold.opacity(0.35), lineWidth: 1)
        )
    }

    private var statusPicker: some View {
        HStack(spacing: 6) {
            ForEach(PresenceStatus.allCases) { s in
                Button {
                    service.myStatus = s
                    scheduleSave()
                } label: {
                    HStack(spacing: 6) {
                        Circle().fill(color(for: s)).frame(width: 6, height: 6)
                        Text(s.label).font(.system(size: 11, weight: .heavy))
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .foregroundStyle(service.myStatus == s ? color(for: s) : Theme.textSecondary)
                    .background(
                        (service.myStatus == s ? color(for: s) : Color.clear)
                            .opacity(service.myStatus == s ? 0.14 : 0),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(service.myStatus == s ? color(for: s) : Theme.cardBorder,
                                    lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .help(s.hint)
            }
        }
    }

    private var noteField: some View {
        TextField("What you're up to (140 chars, optional)",
                  text: Binding(get: { service.myNote },
                                set: { service.myNote = String($0.prefix(140)); scheduleSave() }))
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            .padding(8)
            .background(Theme.bgDeep, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1))
            .frame(maxWidth: .infinity)
    }

    private var discordField: some View {
        TextField("Discord handle (optional)",
                  text: Binding(get: { service.myDiscord },
                                set: { service.myDiscord = String($0.prefix(40)); scheduleSave() }))
            .textFieldStyle(.plain)
            .font(.system(size: 12, design: .monospaced))
            .padding(8)
            .background(Theme.bgDeep, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1))
            .frame(width: 220)
    }

    private func scheduleSave() {
        // Debounce text edits — flush 0.6s after last change.
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
            await service.pushMyStatus()
        }
    }

    private func color(for s: PresenceStatus) -> Color {
        switch s {
        case .looking: return Theme.winBright
        case .inCoop:  return Theme.accent
        case .inRun:   return Theme.gold
        case .afk:     return Theme.textTertiary
        }
    }
}

// MARK: - Row

private struct PresenceRow: View {
    let entry: PresenceEntry
    let viewerStats: PlayerStats?

    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Avatar(persona: entry.personaName, urlString: entry.avatarURL,
                   diameter: 40, color: stripeColor)
            VStack(alignment: .leading, spacing: 6) {
                topLine
                if !entry.note.isEmpty {
                    Text(entry.note)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                metaLine
            }
            Spacer(minLength: 12)
            actions
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(hovering ? Theme.cardBGRaised : Theme.cardBG)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(stripeColor.opacity(entry.inSTS2 ? 0.55 : 0.25), lineWidth: 1)
        )
        .onHover { hovering = $0 }
    }

    private var stripeColor: Color {
        switch entry.status {
        case .looking: return Theme.winBright
        case .inCoop:  return Theme.accent
        case .inRun:   return Theme.gold
        case .afk:     return Theme.textTertiary
        }
    }

    private var topLine: some View {
        HStack(spacing: 8) {
            Text(entry.personaName)
                .font(.system(size: 14, weight: .heavy))
                .foregroundStyle(Theme.textPrimary)
            statusPill
            if entry.inSTS2 { inGameBadge }
            if let tier = entry.stats?.skillTier {
                Text(tier.label.uppercased())
                    .font(.system(size: 9, weight: .black))
                    .tracking(1.2)
                    .foregroundStyle(Theme.gold)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.gold.opacity(0.12), in: Capsule())
                    .overlay(Capsule().stroke(Theme.gold.opacity(0.45), lineWidth: 1))
            }
        }
    }

    private var statusPill: some View {
        Text(entry.status.shortLabel)
            .font(.system(size: 9, weight: .black))
            .tracking(1.2)
            .foregroundStyle(stripeColor)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(stripeColor.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(stripeColor.opacity(0.5), lineWidth: 1))
    }

    private var inGameBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: "gamecontroller.fill").font(.system(size: 8, weight: .heavy))
            Text("IN STS2").font(.system(size: 9, weight: .black)).tracking(1.2)
        }
        .foregroundStyle(Theme.winBright)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(Theme.winBright.opacity(0.14), in: Capsule())
        .overlay(Capsule().stroke(Theme.winBright.opacity(0.6), lineWidth: 1))
    }

    private var metaLine: some View {
        HStack(spacing: 12) {
            if let s = entry.stats {
                metaChip(icon: "trophy", text: "A\(s.maxAscension) max")
                metaChip(icon: "chart.bar.fill",
                         text: "\(Int((s.winrate * 100).rounded()))% wr · \(s.totalRuns) runs")
                if let preferred = s.preferredCharacter {
                    metaChip(icon: "person.fill", text: preferred.capitalized)
                }
            }
            metaChip(icon: "clock", text: "updated \(relative(entry.updatedAt))")
        }
    }

    private func metaChip(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 9, weight: .semibold))
            Text(text).font(.system(size: 11))
        }
        .foregroundStyle(Theme.textTertiary)
    }

    private var actions: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Button { openSteamProfile() } label: {
                actionLabel(icon: "person.crop.square", text: "Steam")
            }
            .buttonStyle(.plain)
            .help("Open their Steam profile — message them or send a friend request from there.")

            if let discord = entry.discordHandle, !discord.isEmpty {
                Button { copyDiscord(discord) } label: {
                    actionLabel(
                        icon: copied ? "checkmark" : "doc.on.doc",
                        text: copied ? "Copied" : "Discord"
                    )
                }
                .buttonStyle(.plain)
                .help("Copy '\(discord)' — paste into Discord to DM them.")
            }

            Button { addAsFriend() } label: {
                actionLabel(icon: "person.crop.circle.badge.plus", text: "Friend")
            }
            .buttonStyle(.plain)
            .help("Open Steam to send a friend request — required for STS2 multiplayer invites.")
        }
        .frame(width: 110)
    }

    private func actionLabel(icon: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 10, weight: .heavy))
            Text(text).font(.system(size: 11, weight: .heavy))
        }
        .foregroundStyle(Theme.accentBright)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Theme.accentBright.opacity(0.10), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.accentBright.opacity(0.55), lineWidth: 1))
    }

    private func openSteamProfile() {
        // steam://url/SteamIDPage opens the user's profile inside the Steam client.
        if let url = URL(string: "steam://url/SteamIDPage/\(entry.steamID)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func addAsFriend() {
        if let url = URL(string: "steam://friends/add/\(entry.steamID)") {
            NSWorkspace.shared.open(url)
        }
    }

    private func copyDiscord(_ handle: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(handle, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run { copied = false }
        }
    }

    private func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Avatar

private struct Avatar: View {
    let persona: String
    let urlString: String?
    let diameter: CGFloat
    let color: Color

    var body: some View {
        ZStack {
            if let s = urlString, let url = URL(string: s) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFill()
                    default:
                        initials
                    }
                }
            } else {
                initials
            }
        }
        .frame(width: diameter, height: diameter)
        .clipShape(Circle())
        .overlay(Circle().stroke(color.opacity(0.55), lineWidth: 1.5))
    }

    private var initials: some View {
        Circle()
            .fill(color.opacity(0.20))
            .overlay(
                Text(String(persona.prefix(1)).uppercased())
                    .font(.system(size: diameter * 0.42, weight: .black, design: .rounded))
                    .foregroundStyle(color)
            )
    }
}

// MARK: - Empty state

private struct EmptyFeedState: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "person.2.gobackward")
                .font(.system(size: 38, weight: .light))
                .foregroundStyle(Theme.textTertiary)
            Text("Nobody else on the feed yet")
                .font(.system(size: 15, weight: .heavy))
                .foregroundStyle(Theme.textSecondary)
            Text("Leave The Vault open — when someone else with the app fires up Slay the Spire 2, they'll show up here.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textTertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
        .background(Theme.cardBG, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(style: .init(lineWidth: 1, dash: [3, 3]))
                .foregroundStyle(Theme.cardBorder)
        )
    }
}

// MARK: - Info note (shared)

private struct InfoNote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(Theme.textTertiary)
            .frame(maxWidth: 600, alignment: .leading)
            .padding(12)
            .background(Theme.bgDeep, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.cardBorder, lineWidth: 1))
    }
}
