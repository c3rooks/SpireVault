import SwiftUI
import VaultCore

// =========================================================================
// OverlayRootView
// -------------------------------------------------------------------------
// Root SwiftUI view inside the overlay NSPanel. Switches between the
// collapsed pill and the expanded panel based on `controller.expanded`.
// Pulls live data from AppState (steamAuth + presenceService) so the
// overlay never opens its own network connections.
// =========================================================================

struct OverlayRootView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            if controller.expanded {
                OverlayExpandedView(controller: controller)
            } else {
                OverlayPillView(controller: controller)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Subtle background — the NSPanel itself is transparent so this
        // is what the user sees. RoundedRectangle gives the rounded
        // corners; the NSPanel shadow renders behind it for free.
        .background(
            RoundedRectangle(cornerRadius: controller.expanded ? 14 : 19, style: .continuous)
                .fill(Color(white: 0.075))
                .overlay(
                    RoundedRectangle(cornerRadius: controller.expanded ? 14 : 19, style: .continuous)
                        .stroke(Color.white.opacity(0.10), lineWidth: 1)
                )
        )
        .clipShape(
            RoundedRectangle(cornerRadius: controller.expanded ? 14 : 19, style: .continuous)
        )
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.18), value: controller.expanded)
    }
}

// =========================================================================
// OverlayPillView — collapsed state
// -------------------------------------------------------------------------
// 152×38 floating pill. Avatar + status dot + online count + chevron.
// Tap anywhere on the pill expands the panel. The whole surface is
// drag-to-reposition (NSPanel.isMovableByWindowBackground takes care of
// that); we only intercept clicks on the explicit hit areas.
// =========================================================================

struct OverlayPillView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        HStack(spacing: 8) {
            avatar
            VStack(alignment: .leading, spacing: 1) {
                Text(personaShort)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(subline)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            chevron
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            controller.toggleExpanded()
        }
    }

    private var avatar: some View {
        ZStack(alignment: .bottomTrailing) {
            AvatarImage(urlString: state.steamAuth.profile?.avatarURL, size: 24)
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
                .overlay(Circle().stroke(Color(white: 0.075), lineWidth: 1.5))
                .offset(x: 1, y: 1)
        }
        .frame(width: 26, height: 26)
    }

    private var chevron: some View {
        Image(systemName: "chevron.up")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.white.opacity(0.45))
    }

    private var personaShort: String {
        let p = state.steamAuth.profile?.personaName ?? "Not signed in"
        return String(p.prefix(14))
    }

    private var subline: String {
        if let svc = state.presenceService {
            let count = svc.entries.count
            let looking = svc.entries.filter { $0.status == .looking }.count
            if !svc.isConnected { return "offline" }
            return "\(count) online · \(looking) looking"
        }
        return "Sign in to connect"
    }

    private var statusColor: Color {
        guard state.presenceService != nil else { return Color.gray }
        switch state.presenceService?.myStatus {
        case .looking: return Color(red: 0.43, green: 0.85, blue: 0.49)
        case .inCoop:  return Color(red: 1.00, green: 0.50, blue: 0.10)
        case .inRun:   return Color(red: 0.95, green: 0.82, blue: 0.30)
        case .afk:     return Color.gray
        case .none:    return Color.gray
        }
    }
}

// =========================================================================
// OverlayExpandedView — expanded panel state
// -------------------------------------------------------------------------
// 320×360 panel with:
//   • Header (avatar + persona + close button)
//   • Status segmented control (4 options)
//   • Live counts ("Online", "Looking", "In Co-op")
//   • Quick actions (Open The Vault, Sign out)
// =========================================================================

struct OverlayExpandedView: View {
    @ObservedObject var controller: OverlayController
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 12)
            divider

            statusBlock
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            divider

            countsBlock
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            divider

            Spacer(minLength: 0)
            footer
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 1)
    }

    private var header: some View {
        HStack(spacing: 10) {
            AvatarImage(urlString: state.steamAuth.profile?.avatarURL, size: 36)
            VStack(alignment: .leading, spacing: 1) {
                Text(state.steamAuth.profile?.personaName ?? "Not signed in")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(state.steamAuth.profile == nil
                     ? "Sign in to use the overlay"
                     : "Steam connected")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.white.opacity(0.55))
            }
            Spacer()
            Button {
                controller.collapse()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.6))
                    .frame(width: 24, height: 24)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.white.opacity(0.06))
                    )
            }
            .buttonStyle(.plain)
            .help("Collapse overlay")
        }
    }

    private var statusBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("STATUS")
                .font(.system(size: 10, weight: .heavy))
                .tracking(1.2)
                .foregroundStyle(.white.opacity(0.55))
            statusSegmented
        }
    }

    private var statusSegmented: some View {
        HStack(spacing: 4) {
            statusPill(.looking, "Looking")
            statusPill(.inRun, "In a run")
            statusPill(.inCoop, "Co-op")
            statusPill(.afk, "AFK")
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
        )
    }

    private func statusPill(_ value: PresenceStatus, _ label: String) -> some View {
        let pressed = state.presenceService?.myStatus == value
        return Button {
            guard let svc = state.presenceService else { return }
            svc.myStatus = value
            Task { await svc.pushMyStatus() }
        } label: {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(pressed ? Color.white : .white.opacity(0.7))
                .frame(maxWidth: .infinity)
                .frame(height: 26)
                .background(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(pressed
                              ? LinearGradient(colors: [
                                    Color(red: 1, green: 0.55, blue: 0.10),
                                    Color(red: 1, green: 0.42, blue: 0.10),
                                ], startPoint: .top, endPoint: .bottom)
                              : LinearGradient(colors: [.clear, .clear],
                                               startPoint: .top, endPoint: .bottom))
                )
        }
        .buttonStyle(.plain)
        .disabled(state.presenceService == nil)
    }

    private var countsBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("LIVE FEED")
                .font(.system(size: 10, weight: .heavy))
                .tracking(1.2)
                .foregroundStyle(.white.opacity(0.55))
            HStack(spacing: 10) {
                statTile(value: onlineCount, label: "Online")
                statTile(value: lookingCount, label: "Looking")
                statTile(value: inCoopCount, label: "In co-op")
            }
        }
    }

    private func statTile(value: Int, label: String) -> some View {
        VStack(spacing: 2) {
            Text("\(value)")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.white)
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.white.opacity(0.55))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.white.opacity(0.03))
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(Color.white.opacity(0.06), lineWidth: 1)
                )
        )
    }

    private var footer: some View {
        HStack {
            Button {
                controller.openMainWindow()
            } label: {
                Text("Open The Vault")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
            }
            .buttonStyle(.plain)
            Spacer()
            if state.steamAuth.isSignedIn {
                Button {
                    Task { await state.presenceService?.goOffline() }
                    state.steamAuth.signOut()
                    controller.collapse()
                } label: {
                    Text("Sign out")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color(red: 0.85, green: 0.45, blue: 0.45))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Computed counts

    private var onlineCount: Int {
        state.presenceService?.entries.count ?? 0
    }
    private var lookingCount: Int {
        state.presenceService?.entries.filter { $0.status == .looking }.count ?? 0
    }
    private var inCoopCount: Int {
        state.presenceService?.entries.filter { $0.status == .inCoop }.count ?? 0
    }
}

// =========================================================================
// AvatarImage — async-loading round avatar with a fallback bezel
// -------------------------------------------------------------------------
// Pulls the Steam avatar URL via AsyncImage, falls back to the Vault mark
// when missing or while loading. Centralized so both pill and expanded
// views render avatars identically.
// =========================================================================

struct AvatarImage: View {
    let urlString: String?
    let size: CGFloat

    var body: some View {
        Group {
            if let s = urlString, let url = URL(string: s) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let img): img.resizable()
                    default: fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 1))
    }

    private var fallback: some View {
        ZStack {
            Color(red: 0.15, green: 0.10, blue: 0.18)
            Image(systemName: "person.fill")
                .foregroundStyle(.white.opacity(0.35))
                .font(.system(size: size * 0.55, weight: .bold))
        }
    }
}
