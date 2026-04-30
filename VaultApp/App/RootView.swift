import SwiftUI
import VaultCore

/// Top-level container. Custom split-view-style layout instead of NavigationSplitView
/// so we can fully control the sidebar background — the system one fights us.
struct RootView: View {
    @EnvironmentObject var state: AppState
    @State private var section: SidebarSection = .overview

    var body: some View {
        Group {
            if state.needsOnboarding {
                OnboardingView()
            } else {
                HSplit(section: $section)
            }
        }
        .frame(minWidth: 1080, minHeight: 700)
        .background(Theme.bgDeep)
        .preferredColorScheme(.dark)
    }
}

private struct HSplit: View {
    @EnvironmentObject var state: AppState
    @Binding var section: SidebarSection

    var body: some View {
        HStack(spacing: 0) {
            Sidebar(selection: $section)
                .frame(width: 240)

            Rectangle()
                .fill(Theme.cardBorder.opacity(0.5))
                .frame(width: 1)

            VStack(spacing: 0) {
                if section != .coop {
                    AppHeaderBar(section: section)
                }
                DetailView(section: section)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary)
        }
        .background(Theme.bgPrimary)
    }
}

// MARK: - Sidebar

enum SidebarSection: Hashable, CaseIterable, Identifiable {
    case overview, characters, ascensions, relics, cards, runs, coop

    var id: Self { self }
    var title: String {
        switch self {
        case .overview:   return "Overview"
        case .characters: return "Characters"
        case .ascensions: return "Ascensions"
        case .relics:     return "Top Relics"
        case .cards:      return "Cards"
        case .runs:       return "Recent Runs"
        case .coop:       return "Co-op"
        }
    }
    var icon: String {
        switch self {
        case .overview:   return "square.grid.2x2.fill"
        case .characters: return "person.3.fill"
        case .ascensions: return "chart.bar.fill"
        case .relics:     return "sparkles"
        case .cards:      return "rectangle.stack.fill"
        case .runs:       return "clock.fill"
        case .coop:       return "person.2.wave.2.fill"
        }
    }
    /// Stats sections vs. tools — used to group the sidebar.
    var group: SidebarGroup {
        switch self {
        case .overview, .characters, .ascensions, .relics, .cards, .runs: return .stats
        case .coop: return .community
        }
    }
}

enum SidebarGroup: String, CaseIterable, Identifiable {
    case stats, community
    var id: Self { self }
    var label: String {
        switch self {
        case .stats:     return "STATS"
        case .community: return "COMMUNITY"
        }
    }
}

struct Sidebar: View {
    @EnvironmentObject var state: AppState
    @Binding var selection: SidebarSection

    var body: some View {
        VStack(spacing: 0) {
            wordmark
                .padding(.horizontal, 18)
                .padding(.top, 24)
                .padding(.bottom, 18)

            Divider().background(Theme.cardBorder.opacity(0.6))
                .padding(.horizontal, 18)

            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    sectionGroup
                    filtersGroup
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 16)
            }

            Spacer(minLength: 0)

            footer
        }
        .frame(maxHeight: .infinity)
        .background(Theme.bgSidebar)
    }

    private var wordmark: some View {
        HStack(spacing: 12) {
            Image("VaultEmblem")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Theme.gold.opacity(0.4), lineWidth: 1)
                )
                .shadow(color: Theme.accent.opacity(0.4), radius: 8, x: 0, y: 2)
            VStack(alignment: .leading, spacing: 0) {
                Text("THE VAULT")
                    .font(.system(size: 14, weight: .heavy, design: .serif))
                    .tracking(3)
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Theme.gold, Theme.accentBright],
                            startPoint: .leading, endPoint: .trailing
                        )
                    )
                Text("v\(VaultVersion.current) · for STS2")
                    .font(.system(size: 9, weight: .semibold, design: .rounded))
                    .tracking(1.6)
                    .foregroundStyle(Theme.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sectionGroup: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(SidebarGroup.allCases) { group in
                let items = SidebarSection.allCases.filter { $0.group == group }
                if !items.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(group.label)
                            .font(.system(size: 10, weight: .bold, design: .rounded))
                            .tracking(2)
                            .foregroundStyle(Theme.textTertiary)
                            .padding(.leading, 10)
                            .padding(.bottom, 4)
                        ForEach(items) { s in
                            SidebarRow(section: s,
                                       isSelected: selection == s,
                                       badge: badge(for: s)) {
                                selection = s
                            }
                        }
                    }
                }
            }
        }
    }

    private func badge(for s: SidebarSection) -> String? {
        switch s {
        case .coop:
            guard let svc = state.presenceService else { return nil }
            // Show "people online" count, excluding ourselves.
            let mySID = state.steamAuth.profile?.steamID
            let others = svc.entries.filter { $0.steamID != mySID }
            let inGame = others.filter(\.inSTS2).count
            if inGame > 0 { return "\(inGame)" }
            return others.isEmpty ? nil : "\(others.count)"
        default: return nil
        }
    }

    private var filtersGroup: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("FILTERS")
                .font(.system(size: 10, weight: .bold, design: .rounded))
                .tracking(2)
                .foregroundStyle(Theme.textTertiary)
                .padding(.leading, 10)
            FiltersForm()
                .padding(.horizontal, 8)
        }
    }

    private var footer: some View {
        VStack(spacing: 8) {
            Divider().background(Theme.cardBorder.opacity(0.6))

            if let me = state.steamAuth.profile {
                signedInBlock(me: me)
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
            }

            HStack(spacing: 8) {
                Image(systemName: state.saveFolder == nil ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(state.saveFolder == nil ? Theme.loss : Theme.win)
                    .font(.system(size: 11))
                Text(state.saveFolder == nil ? "No folder set" : "Saves connected")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                Spacer()
                coopStatusIcon
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
        }
    }

    @ViewBuilder
    private var coopStatusIcon: some View {
        if !state.steamAuth.isSignedIn {
            Image(systemName: "circle.dashed")
                .font(.system(size: 10))
                .foregroundStyle(Theme.gold)
                .help("Sign in with Steam to enable co-op")
        } else if let svc = state.presenceService, svc.isConnected {
            Image(systemName: "wifi")
                .font(.system(size: 10))
                .foregroundStyle(Theme.winBright)
                .help("Connected to matchmaking server")
        } else {
            Image(systemName: "wifi.slash")
                .font(.system(size: 10))
                .foregroundStyle(Theme.lossBright)
                .help("Matchmaking server unreachable")
        }
    }

    private func signedInBlock(me: PlayerProfile) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Theme.gold.opacity(0.20))
                .overlay(
                    Text(String(me.personaName.prefix(1)).uppercased())
                        .font(.system(size: 12, weight: .black, design: .rounded))
                        .foregroundStyle(Theme.gold)
                )
                .frame(width: 26, height: 26)
                .overlay(Circle().stroke(Theme.gold.opacity(0.5), lineWidth: 1))
            VStack(alignment: .leading, spacing: 1) {
                Text(me.personaName)
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                if let s = me.stats {
                    Text("\(s.skillTier.label) · \(s.skillTier.ascensionRange)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                } else {
                    Text("Steam connected")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                }
            }
            Spacer()
        }
    }
}

private struct SidebarRow: View {
    let section: SidebarSection
    let isSelected: Bool
    let badge: String?
    let action: () -> Void
    @State private var hovering = false

    init(section: SidebarSection, isSelected: Bool, badge: String? = nil, action: @escaping () -> Void) {
        self.section = section
        self.isSelected = isSelected
        self.badge = badge
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: section.icon)
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 18, alignment: .center)
                    .foregroundStyle(isSelected ? Theme.accent : Theme.textSecondary)
                Text(section.title)
                    .font(.system(size: 13, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? Theme.text : Theme.textSecondary)
                Spacer()
                if let badge {
                    Text(badge)
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(Theme.accentBright)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.accentBright.opacity(0.18), in: Capsule())
                        .overlay(Capsule().stroke(Theme.accentBright.opacity(0.5), lineWidth: 1))
                } else if isSelected {
                    Rectangle()
                        .fill(Theme.accent)
                        .frame(width: 3, height: 16)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isSelected ? Theme.accentSoft : (hovering ? Theme.cardBG.opacity(0.6) : Color.clear))
            )
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

// MARK: - Filters

struct FiltersForm: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FilterRow(label: "Character") {
                Picker("", selection: Binding(
                    get: { state.filter.character },
                    set: { state.filter.character = $0; state.recomputeReport() }
                )) {
                    Text("All").tag(VaultCore.Character?.none)
                    ForEach(allCharacters, id: \.self) { c in
                        Text(c.rawValue.capitalized).tag(VaultCore.Character?.some(c))
                    }
                }
                .labelsHidden()
            }

            FilterRow(label: "Outcome") {
                Picker("", selection: Binding<Bool?>(
                    get: { state.filter.won },
                    set: { state.filter.won = $0; state.recomputeReport() }
                )) {
                    Text("All").tag(Bool?.none)
                    Text("Wins").tag(Bool?.some(true))
                    Text("Losses").tag(Bool?.some(false))
                }
                .labelsHidden()
            }

            FilterRow(label: "Window") {
                Picker("", selection: Binding<TimeWindow>(
                    get: { TimeWindow.from(state.filter.since) },
                    set: { window in state.filter.since = window.dateValue; state.recomputeReport() }
                )) {
                    ForEach(TimeWindow.allCases) { w in Text(w.label).tag(w) }
                }
                .labelsHidden()
            }

            if filtersActive {
                Button {
                    state.filter = RunFilter()
                    state.recomputeReport()
                } label: {
                    Label("Clear filters", systemImage: "xmark.circle")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
                .padding(.top, 4)
            }
        }
    }

    private var filtersActive: Bool {
        state.filter.character != nil || state.filter.won != nil || state.filter.since != nil
    }

    private var allCharacters: [VaultCore.Character] {
        [.ironclad, .silent, .regent, .necrobinder, .defect]
    }
}

private struct FilterRow<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(Theme.textTertiary)
            content()
                .controlSize(.small)
        }
    }
}

enum TimeWindow: String, CaseIterable, Identifiable, Hashable {
    case all, last7d, last30d, last90d
    var id: Self { self }
    var label: String {
        switch self {
        case .all:     return "All time"
        case .last7d:  return "Last 7 days"
        case .last30d: return "Last 30 days"
        case .last90d: return "Last 90 days"
        }
    }
    var dateValue: Date? {
        switch self {
        case .all:     return nil
        case .last7d:  return Date().addingTimeInterval(-7 * 86400)
        case .last30d: return Date().addingTimeInterval(-30 * 86400)
        case .last90d: return Date().addingTimeInterval(-90 * 86400)
        }
    }
    static func from(_ d: Date?) -> TimeWindow {
        guard let d else { return .all }
        let delta = -d.timeIntervalSinceNow / 86400
        if delta <= 8   { return .last7d }
        if delta <= 31  { return .last30d }
        if delta <= 91  { return .last90d }
        return .all
    }
}

// MARK: - Header bar

struct AppHeaderBar: View {
    @EnvironmentObject var state: AppState
    let section: SidebarSection

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text(section.title)
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.text)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            Spacer()
            statusView
            actionButtons
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 18)
        .background(
            Theme.bgPrimary
                .overlay(
                    Rectangle()
                        .fill(Theme.cardBorder.opacity(0.5))
                        .frame(height: 1),
                    alignment: .bottom
                )
        )
    }

    private var subtitle: String? {
        switch state.status {
        case .scanning(_, let label):
            return "Scanning… \(label)"
        case .error(let m):
            return m
        case .idle:
            if let last = state.lastScanAt {
                return "Updated \(last.formatted(.relative(presentation: .numeric)))"
            }
            return nil
        }
    }

    @ViewBuilder
    private var statusView: some View {
        if case let .scanning(progress, _) = state.status {
            ProgressView(value: progress)
                .progressViewStyle(.linear)
                .tint(Theme.accent)
                .frame(width: 120)
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        if section == .coop {
            // CoopView has its own controls — keep this clean.
            EmptyView()
        } else {
            HStack(spacing: 8) {
                HeaderButton(systemImage: "arrow.clockwise", label: "Rescan") {
                    Task {
                        await state.scan()
                        state.attachStatsToProfile()
                    }
                }
                HeaderButton(systemImage: "square.and.arrow.up", label: "Export") {
                    state.exportCSV()
                }
                HeaderButton(systemImage: "folder", label: "Saves") {
                    state.revealSaveFolder()
                }
            }
        }
    }
}

private struct HeaderButton: View {
    let systemImage: String
    let label: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(hover ? Theme.text : Theme.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(hover ? Theme.cardBGRaised : Theme.cardBG)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
