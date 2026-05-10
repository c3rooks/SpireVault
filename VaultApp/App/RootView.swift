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
        // AppState can ask us to hop tabs (e.g. when "Sign in with
        // Steam" is tapped while the user's on the native Beta or
        // Settings tab — we need a web-hosted view on screen for
        // the embedded WKWebView to drive sign-in). We consume the
        // request once so a stale @Published value can't keep
        // forcing the tab back.
        .onChange(of: state.pendingSidebarHop) { hop in
            guard let hop else { return }
            section = hop
            DispatchQueue.main.async { state.pendingSidebarHop = nil }
        }
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
                // Beta and Settings render with the legacy native
                // title bar because they're native SwiftUI panels.
                // Every other tab is hosted by the WebView, which
                // already paints its own matching panel header
                // (matching the cloud version pixel-for-pixel) — so
                // we render *no* native chrome above it. The web's
                // per-panel toolbar (Refresh / Import / Export menu)
                // is bridged to native AppState via WebHostAction in
                // desktop-host mode, so every visible button still
                // routes through real macOS surfaces (NSOpenPanel,
                // NSSavePanel, VaultCore parser). The legacy
                // `WebHostToolbar` row was removed in v0.9.3 because
                // it was a parallel native copy of the same buttons,
                // producing a duplicated toolbar that broke parity
                // with the cloud.
                if [SidebarSection.beta, .settings].contains(section) {
                    AppHeaderBar(section: section)
                }
                DetailView(section: $section)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary)
        }
        .background(Theme.bgPrimary)
    }
}

// MARK: - Sidebar

enum SidebarSection: Hashable, CaseIterable, Identifiable {
    case overview, characters, ascensions, relics, cards, runs
    case coop, highlights, news
    case beta
    case settings

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
        // Renamed from "Community Highlights" → "Highlights" in v0.9.3
        // to match the embedded web companion's sidebar label exactly.
        // The desktop chrome is now a 1:1 mirror of cloud nav.
        case .highlights: return "Highlights"
        case .news:       return "News"
        case .beta:       return "Beta"
        case .settings:   return "Settings"
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
        case .highlights: return "star.bubble.fill"
        case .news:       return "newspaper.fill"
        case .beta:       return "flask.fill"
        case .settings:   return "gearshape.fill"
        }
    }
    /// Stats sections vs. community — used to group the sidebar.
    /// Mirrors the embedded web companion's layout exactly: STATS
    /// (Overview … Recent Runs) above, COMMUNITY (Co-op, Highlights,
    /// News, Beta) below. The previous "SYSTEM" group held just Beta
    /// + the (already hidden) Settings row; in v0.9.3 we collapsed
    /// it because Beta belongs next to News in the cloud, and Settings
    /// is reachable from the persona pill.
    var group: SidebarGroup {
        switch self {
        case .overview, .characters, .ascensions, .relics, .cards, .runs: return .stats
        case .coop, .highlights, .news, .beta: return .community
        case .settings: return .community // hidden anyway; group is unused
        }
    }
    /// Whether this section is rendered as a sidebar row.
    /// `.settings` is intentionally hidden from the sidebar in v0.9 —
    /// it's now reached via the menu that drops out of the persona
    /// pill in the sidebar footer (matching the web app). The enum
    /// case stays because tens of `selection = .settings` call sites
    /// (update banner, onboarding, deep-links) still need to navigate
    /// to the Settings panel programmatically.
    var isSidebarVisible: Bool {
        switch self {
        case .settings: return false
        default: return true
        }
    }
}

enum SidebarGroup: String, CaseIterable, Identifiable {
    /// Two groups, matching the web companion's `nav-group` divisions
    /// in `Web/index.html`: STATS up top, COMMUNITY (with Beta tucked
    /// at the end) below. The legacy `system` case is gone — Beta
    /// moved into COMMUNITY and Settings is reached via the persona
    /// pill menu, so there's nothing left to render in a system row.
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
                    // Native FILTERS (Character / Outcome / Window) was
                    // removed in v0.9.3. The embedded web companion has
                    // its own per-panel filter UI that drives the
                    // canonical stats engine; a parallel native filter
                    // bar would only show on the never-rendered legacy
                    // SwiftUI panels and confuse users into thinking
                    // they're filtering the embedded view. One filter
                    // surface, one engine, one source of truth.
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
                let items = SidebarSection.allCases.filter { $0.group == group && $0.isSidebarVisible }
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
        case .beta:
            return "NEW"
        case .coop:
            guard let svc = state.presenceService else { return nil }
            // Show "people online" count, excluding ourselves.
            let mySID = state.steamAuth.profile?.steamID
            let others = svc.entries.filter { $0.steamID != mySID }
            let inGame = others.filter(\.inSTS2).count
            if inGame > 0 { return "\(inGame)" }
            return others.isEmpty ? nil : "\(others.count)"
        case .highlights:
            // Tiny "•" dot when highlights have arrived since last
            // visit — same UX as the web app's red sidebar dot.
            return CommunityHighlightsBadge.unreadDot(for: state.communityHighlights,
                                                     mySteamID: state.steamAuth.profile?.steamID)
        case .news:
            return NewsCatalog.hasUnreadLatest ? "•" : nil
        case .settings:
            // Surface an "Update" badge whenever the auto-checker has
            // discovered a newer release. Nudges users toward the
            // self-update flow without being modal about it.
            if case .updateAvailable = state.updateService.status { return "Update" }
            if case .readyToInstall = state.updateService.status { return "Ready" }
            return nil
        default: return nil
        }
    }

    private var footer: some View {
        VStack(spacing: 8) {
            Divider().background(Theme.cardBorder.opacity(0.6))

            // The persona pill became the canonical entry point for
            // settings + beta + sign-out in v0.9 (the standalone
            // "Settings" sidebar row was retired). Signed-in users
            // get the full menu; guests get a "Open Settings" button
            // and a "Sign in with Steam" CTA so save-data plumbing
            // is never gated on an account.
            if let me = state.steamAuth.profile {
                signedInPillMenu(me: me)
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
            } else {
                guestPill
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
    private func signedInPillMenu(me: PlayerProfile) -> some View {
        // The persona pill is the only entry point for Settings, Beta,
        // and Sign out on the desktop sidebar — the standalone rows
        // were retired in v0.9 to mirror the cloud. That hand-off
        // worked great visually but produced a real bug: with
        // `.menuIndicator(.hidden)` + `.menuStyle(.borderlessButton)` +
        // `.buttonStyle(.plain)` the result looks like static text. A
        // user on a fresh install reads it as "this is just my name
        // displayed" and never clicks. We address that here with a
        // visible disclosure chevron, a hover-state background pill,
        // and a tooltip explaining what the menu does.
        Menu {
            Button {
                selection = .settings
            } label: {
                Label("Settings", systemImage: "gearshape.fill")
            }
            Button {
                selection = .beta
            } label: {
                Label("Beta features", systemImage: "flask.fill")
            }
            Divider()
            if let updateMenuLabel {
                Button {
                    selection = .settings
                } label: {
                    Label(updateMenuLabel, systemImage: "arrow.down.circle.fill")
                }
            }
            Button {
                selection = .coop
            } label: {
                Label("Open Co-op", systemImage: "person.2.wave.2.fill")
            }
            Divider()
            Button(role: .destructive) {
                state.steamAuth.signOut()
            } label: {
                Label("Sign out of Steam", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            PersonaPillLabel(me: me)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .help("Account, settings, and beta features")
    }

    private var updateMenuLabel: String? {
        switch state.updateService.status {
        case .updateAvailable: return "Update available"
        case .readyToInstall:  return "Update ready to install"
        default:               return nil
        }
    }

    @ViewBuilder
    private var guestPill: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                // Drive the embedded WebView's OpenID flow. This used
                // to be `state.steamAuth.signIn(via:)` which shelled
                // out to NSWorkspace; that left the cookie in the
                // user's default browser and (on machines with two
                // copies of The Vault.app installed) re-launched the
                // wrong one via `thevault://`, giving the user two
                // desktop windows. The new path keeps everything in
                // the embedded WKWebView and feeds the verified
                // session straight back into native SteamAuth.
                state.requestEmbeddedSignIn(currentTab: selection)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "person.crop.square")
                        .imageScale(.small)
                    Text("Sign in with Steam")
                        .font(.system(size: 12, weight: .bold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
                .background(
                    LinearGradient(
                        colors: [Theme.gold.opacity(0.30), Theme.accent.opacity(0.18)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Theme.gold.opacity(0.45), lineWidth: 1)
                )
                .foregroundStyle(Theme.text)
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                Button {
                    selection = .settings
                } label: {
                    Label("Settings", systemImage: "gearshape.fill")
                        .font(.system(size: 11, weight: .semibold))
                }
                Spacer()
                Button {
                    selection = .beta
                } label: {
                    Label("Beta", systemImage: "flask.fill")
                        .font(.system(size: 11, weight: .semibold))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.textTertiary)
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

    /// Legacy helper kept for the (currently unused) signed-out
    /// preview path. The live render uses `PersonaPillLabel` below
    /// so we can carry hover state into the chrome.
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

/// Sidebar persona pill — the desktop counterpart to the web's `me-pill`.
/// Renders avatar + persona + status, with a hover-state background and a
/// permanent disclosure chevron so it reads as a control, not a label.
/// Wrapped by a SwiftUI `Menu` in the parent view; on tap macOS expands
/// the popover with Settings / Beta / Sign out / "Open Co-op" / update
/// status. Without the affordance baked in here the parent's plain-style
/// menu looks visually inert and users don't realise it's clickable —
/// the exact bug a v0.9.5 user reported as "steam profile isnt showing
/// on desktop, i cant even click into it like i can on web."
private struct PersonaPillLabel: View {
    let me: PlayerProfile
    @State private var hover = false

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Theme.gold.opacity(0.20))
                .overlay(
                    Text(String(me.personaName.prefix(1)).uppercased())
                        .font(.system(size: 12, weight: .black, design: .rounded))
                        .foregroundStyle(Theme.gold)
                )
                .frame(width: 28, height: 28)
                .overlay(Circle().stroke(Theme.gold.opacity(0.6), lineWidth: 1))
            VStack(alignment: .leading, spacing: 1) {
                Text(me.personaName)
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                if let s = me.stats {
                    Text("\(s.skillTier.label) · \(s.skillTier.ascensionRange)")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                } else {
                    Text("Account · settings")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            // Permanent disclosure indicator. The native `.menuIndicator`
            // doesn't render reliably with `.menuStyle(.borderlessButton)`
            // + `.buttonStyle(.plain)` (the combo we need to integrate
            // with the dark sidebar styling), so we draw one ourselves.
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.textTertiary)
                .opacity(hover ? 1.0 : 0.7)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(hover ? Theme.cardBGRaised : Theme.cardBG.opacity(0.5))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(hover ? Theme.gold.opacity(0.45) : Theme.cardBorder.opacity(0.6), lineWidth: 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
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
//
// The native FILTERS sidebar group (Character / Outcome / Window pickers)
// was removed in v0.9.3. The embedded web companion drives every visible
// data panel through its own filter UI and stats engine — keeping a
// parallel SwiftUI filter form would just maintain dead code that
// looks active. RunFilter, RunFilter.apply(), and AppState.filter are
// retained because CSV export and a couple of native fallback paths
// still reference them; they just no longer have a UI binding.

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

// `WebHostToolbar` was removed in v0.9.3. It used to paint a thin
// native row of Rescan / Export / Saves buttons above the embedded
// WebView, but the WebView already paints its own per-panel toolbar
// (Refresh / Import / Export menu) that matches the cloud's UI
// pixel-for-pixel. The two stacked produced a visibly duplicated
// chrome that broke parity. The web's buttons now bridge to native
// AppState via `WebHostAction` (see `Web/script.js` desktop-host
// branch + `WebHostView.swift`'s `kind: "action"` handler) so every
// visible affordance still runs through real macOS surfaces — no
// fidelity lost, no duplicate row gained.

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
