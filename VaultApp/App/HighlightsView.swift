import SwiftUI
import VaultCore

/// Wire model for a community-shared run as the Cloudflare Worker
/// returns it. The web app calls these "highlights" and the macOS app
/// uses the same name so server logs and bug reports line up.
///
/// We only decode the fields we actually render. The Worker can ship
/// new fields freely; Codable's default ignore-unknown behavior keeps
/// us forward-compatible.
public struct CommunityHighlight: Identifiable, Codable, Hashable {
    public let id: String
    public let authorName: String
    public let authorAvatar: String?
    public let authorID: String?
    public let createdAt: String
    public let caption: String?
    public let run: HighlightRun
    public let reactions: [String: Int]
    public let viewerReactions: [String]?
    public let commentCount: Int

    public struct HighlightRun: Codable, Hashable {
        public let character: String?
        public let ascension: Int?
        public let won: Bool?
        public let floorReached: Int?
        public let killedBy: String?
        public let playTimeSeconds: Int?
        public let relics: [String]?
        public let cards: [String]?
        public let gameMode: String?
        public let startedAt: String?
    }
}

/// Minimal API client for the highlights feed. We deliberately
/// duplicate the surface here (instead of pulling it from the Web/
/// JS module) because Swift can't share runtime code with the JS
/// client and we don't want a generator pipeline for two endpoints.
@MainActor
final class HighlightsAPI {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: cfg)
    }

    func fetchFeed(token: String?) async throws -> [CommunityHighlight] {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/highlights"))
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.setValue("Spire-Vault-macOS/\(VaultBundleInfo.shortVersion)", forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw NSError(domain: "HighlightsAPI", code: code,
                          userInfo: [NSLocalizedDescriptionKey: "Highlights endpoint returned \(code)"])
        }
        struct Wire: Decodable {
            let items: [CommunityHighlight]?
        }
        return (try? JSONDecoder().decode(Wire.self, from: data).items) ?? []
    }
}

// MARK: - View ---------------------------------------------------------------

struct HighlightsView: View {
    @EnvironmentObject var state: AppState

    @State private var loading = false
    @State private var lastError: String?
    @State private var hovered: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header

            if state.communityHighlights.isEmpty && loading {
                ProgressView("Loading highlights…")
                    .frame(maxWidth: .infinity, minHeight: 360)
            } else if state.communityHighlights.isEmpty {
                emptyState
            } else {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(state.communityHighlights) { h in
                        HighlightCard(highlight: h, hovered: hovered == h.id)
                            .onHover { hovering in
                                hovered = hovering ? h.id : (hovered == h.id ? nil : hovered)
                            }
                    }
                }
            }
        }
        .task { await load() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Community highlights")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                Text("Standout runs shared by other Spire Vault players. Reactions and comments are read-only here — open the web app to participate.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button {
                Task { await load(force: true) }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            Button {
                if let url = URL(string: "https://app.spirevault.app/#h-feed") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Label("Open in browser", systemImage: "safari")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles.rectangle.stack")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.textTertiary)
            Text("No highlights yet")
                .font(.system(size: 16, weight: .heavy, design: .rounded))
            Text(lastError ?? "Be the first to share — open a run and click \"Share to community\" in the share sheet.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, minHeight: 320)
    }

    @MainActor
    private func load(force: Bool = false) async {
        if loading { return }
        // 30 second freshness window — opening / closing the tab
        // shouldn't hammer the worker.
        if !force, let stamp = state.highlightsLoadedAt,
           Date().timeIntervalSince(stamp) < 30 {
            return
        }
        loading = true
        defer { loading = false }
        do {
            let api = HighlightsAPI(baseURL: state.config.effectiveServerURL)
            let token = state.steamAuth.sessionToken
            let items = try await api.fetchFeed(token: token)
            state.communityHighlights = items
            state.highlightsLoadedAt = Date()
            // Opening this tab counts as "seen" for every highlight
            // currently in the feed — mirrors the web app's badge
            // behavior so the sidebar dot clears immediately.
            CommunityHighlightsBadge.markSeen(items: items)
            lastError = nil
        } catch {
            lastError = (error as NSError).localizedDescription
        }
    }
}

// MARK: - Card ---------------------------------------------------------------

private struct HighlightCard: View {
    let highlight: CommunityHighlight
    let hovered: Bool

    private var character: VaultCore.Character? {
        guard let key = highlight.run.character else { return nil }
        return VaultCore.Character.from(key)
    }

    private var color: Color { Theme.characterColor(character) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            stats
            if let cap = highlight.caption, !cap.isEmpty {
                Text(cap)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.cardBG)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(hovered ? color.opacity(0.55) : Theme.cardBorder, lineWidth: 1)
        )
        .shadow(color: hovered ? color.opacity(0.12) : .clear,
                radius: hovered ? 14 : 0, x: 0, y: hovered ? 8 : 0)
        .animation(.easeOut(duration: 0.16), value: hovered)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(color.opacity(0.18))
                .overlay(
                    Image(systemName: Theme.characterIcon(character))
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(color)
                )
                .frame(width: 36, height: 36)
                .overlay(Circle().stroke(color.opacity(0.4), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(highlight.authorName)
                        .font(.system(size: 14, weight: .heavy))
                        .foregroundStyle(Theme.text)
                    if highlight.run.gameMode == "daily" {
                        Pill(text: "DAILY", tint: Theme.gold)
                    }
                }
                Text(relativeAgo(highlight.createdAt))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            outcomeBadge
        }
    }

    @ViewBuilder
    private var outcomeBadge: some View {
        if highlight.run.won == true {
            Pill(text: "VICTORY", tint: Theme.win)
        } else if highlight.run.won == false {
            Pill(text: "DEFEAT", tint: Theme.loss)
        }
    }

    private var stats: some View {
        HStack(spacing: 10) {
            StatChip(label: "Character",
                     value: highlight.run.character.map(Prettify.id) ?? "—")
            if let asc = highlight.run.ascension {
                StatChip(label: "Ascension", value: "A\(asc)")
            }
            if let floor = highlight.run.floorReached {
                StatChip(label: "Floor", value: "\(floor)")
            }
            if let dur = highlight.run.playTimeSeconds {
                StatChip(label: "Time", value: formatDuration(dur))
            }
            Spacer(minLength: 0)
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            ForEach(reactionsSorted, id: \.0) { (emoji, count) in
                Text("\(emoji) \(count)")
                    .font(.system(size: 12, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(Theme.cardBGRaised)
                    )
                    .overlay(Capsule().stroke(Theme.cardBorder, lineWidth: 1))
            }
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 11, weight: .semibold))
                Text("\(highlight.commentCount)")
                    .font(.system(size: 12, weight: .heavy, design: .rounded))
            }
            .foregroundStyle(Theme.textSecondary)
            Button {
                if let url = URL(string: "https://app.spirevault.app/#h-\(highlight.id)") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Label("Open", systemImage: "arrow.up.right")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
    }

    private var reactionsSorted: [(String, Int)] {
        highlight.reactions
            .filter { $0.value > 0 }
            .sorted { $0.value > $1.value }
            .map { ($0.key, $0.value) }
    }

    private func formatDuration(_ sec: Int) -> String {
        let m = sec / 60
        let s = sec % 60
        return String(format: "%d:%02d", m, s)
    }

    private func relativeAgo(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        guard let d = f.date(from: iso) else { return "" }
        let delta = Date().timeIntervalSince(d)
        if delta < 60          { return "just now" }
        if delta < 3600        { return "\(Int(delta / 60))m ago" }
        if delta < 86_400      { return "\(Int(delta / 3600))h ago" }
        if delta < 86_400 * 7  { return "\(Int(delta / 86_400))d ago" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: d)
    }
}

private struct StatChip: View {
    let label: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased())
                .font(.system(size: 8, weight: .heavy, design: .rounded))
                .tracking(1.2)
                .foregroundStyle(Theme.textTertiary)
            Text(value)
                .font(.system(size: 12, weight: .heavy, design: .rounded))
                .foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Theme.cardBGRaised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Theme.cardBorder, lineWidth: 1)
        )
    }
}
