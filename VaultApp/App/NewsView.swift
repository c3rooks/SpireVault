import SwiftUI

/// In-app News feed that mirrors the web app's `/news` master/detail
/// view. Posts are hardcoded here so they can be edited in any text
/// editor; for one-or-two posts a week, a markdown loader would be
/// ceremony for no benefit. When/if the cadence picks up, we lift the
/// list into a JSON file the app downloads from the Web bucket.
///
/// The post bodies intentionally mirror the web app's wording so a
/// user reading on macOS sees the same release notes as a user
/// reading at app.spirevault.app.
struct NewsView: View {
    @State private var selectedID: String = NewsCatalog.posts.first?.id ?? ""

    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            // Left rail — chronologically-ordered article list.
            VStack(alignment: .leading, spacing: 6) {
                ForEach(NewsCatalog.posts) { post in
                    NewsListItem(
                        post: post,
                        selected: selectedID == post.id,
                        onTap: { selectedID = post.id }
                    )
                }
            }
            .frame(width: 260, alignment: .topLeading)

            // Right pane — selected article body.
            ScrollView {
                if let post = NewsCatalog.posts.first(where: { $0.id == selectedID }) ?? NewsCatalog.posts.first {
                    NewsArticle(post: post)
                        .padding(.bottom, 40)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        // Mark the latest post as read whenever the user opens the
        // News tab. The sidebar's "NEW" badge clears immediately and
        // won't reappear until we ship a newer post-id.
        .onAppear { NewsCatalog.markLatestRead() }
    }
}

// MARK: - List item ----------------------------------------------------------

private struct NewsListItem: View {
    let post: NewsPost
    let selected: Bool
    let onTap: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 4) {
                Text(post.eyebrow.uppercased())
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .tracking(1.6)
                    .foregroundStyle(Theme.accent)
                Text(post.title)
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(Theme.text)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                if !post.tags.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(post.tags.prefix(2), id: \.self) { tag in
                            Text(tag)
                                .font(.system(size: 9, weight: .semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Theme.cardBGRaised))
                                .overlay(Capsule().stroke(Theme.cardBorder, lineWidth: 1))
                                .foregroundStyle(Theme.textTertiary)
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected
                          ? Theme.accent.opacity(0.16)
                          : (hover ? Theme.cardBGRaised : Color.clear))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(selected ? Theme.accent.opacity(0.55) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: selected)
    }
}

// MARK: - Article body -------------------------------------------------------

private struct NewsArticle: View {
    let post: NewsPost

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(post.eyebrow.uppercased())
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .tracking(2)
                    .foregroundStyle(Theme.accent)
                Text(post.title)
                    .font(.system(size: 26, weight: .heavy, design: .serif))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Corey · \(post.readMinutes) min read")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.textSecondary)
            }

            ForEach(Array(post.body.enumerated()), id: \.offset) { _, block in
                NewsBlockView(block: block)
            }

            HStack(spacing: 8) {
                ForEach(post.tags, id: \.self) { tag in
                    Text(tag)
                        .font(.system(size: 10, weight: .heavy, design: .rounded))
                        .tracking(1.5)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Theme.cardBGRaised))
                        .overlay(Capsule().stroke(Theme.cardBorder, lineWidth: 1))
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Button {
                    if let url = URL(string: "https://app.spirevault.app/#news-\(post.id)") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Label("Read on web", systemImage: "safari")
                        .font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(.top, 12)
        }
    }
}

private struct NewsBlockView: View {
    let block: NewsBlock
    var body: some View {
        switch block {
        case .lede(let text):
            Text(text)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
        case .paragraph(let text):
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(Theme.text.opacity(0.92))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let text):
            Text(text)
                .font(.system(size: 16, weight: .heavy, design: .rounded))
                .foregroundStyle(Theme.gold)
                .padding(.top, 8)
        case .feature(let title, let body):
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 14, weight: .heavy))
                    .foregroundStyle(Theme.text)
                Text(body)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.text.opacity(0.92))
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Theme.cardBGRaised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Theme.cardBorder, lineWidth: 1)
            )
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .font(.system(size: 13, weight: .heavy))
                            .foregroundStyle(Theme.accent)
                        Text(item)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text.opacity(0.92))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 4)
        case .roadmap(let items, let isInflight):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items, id: \.self) { item in
                    HStack(alignment: .top, spacing: 10) {
                        Circle()
                            .fill(isInflight ? Theme.gold : Theme.accent)
                            .frame(width: 8, height: 8)
                            .padding(.top, 6)
                        Text(item)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.text.opacity(0.92))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(isInflight
                                  ? Theme.gold.opacity(0.06)
                                  : Theme.cardBGRaised.opacity(0.5))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(isInflight ? Theme.gold.opacity(0.4) : Theme.cardBorder, lineWidth: 1)
                    )
                }
            }
        }
    }
}

// MARK: - Catalog ------------------------------------------------------------

struct NewsPost: Identifiable {
    let id: String
    let eyebrow: String
    let title: String
    let readMinutes: Int
    let tags: [String]
    let body: [NewsBlock]
}

enum NewsBlock {
    case lede(String)
    case paragraph(String)
    case heading(String)
    case feature(title: String, body: String)
    case bullets([String])
    case roadmap(items: [String], isInflight: Bool)
}

enum NewsCatalog {
    /// The most recently *published* post lives at index 0. Bumping
    /// this constant when adding a new post lights the sidebar's
    /// "NEW" pill for every existing user until they open News.
    static let latestPostID = "003-2026-05-09-sts2-v0_105_0-support"

    static let posts: [NewsPost] = [
        NewsPost(
            id: "003-2026-05-09-sts2-v0_105_0-support",
            eyebrow: "Patch · May 9, 2026",
            title: "STS2 v0.105.0 (Bestiary, Aeonglass) is supported",
            readMinutes: 2,
            tags: ["Patch", "Game data", "v0.105.0"],
            body: [
                .lede("Mega Crit shipped a beta patch on May 8 that touched the Neow pool, reworked an Ancients reward, and replaced the Act 3 boss. Runs from the new build now show up correctly in Spire Vault — names, labels, and tooltips included."),

                .heading("What we added"),
                .feature(
                    title: "Three new Neow relics",
                    body: "Kaleidoscope (temporary name), Fishing Rod, and Silken Tress are now recognized in run history. Each gets a hand-curated tooltip with the exact in-game effect plus a quick \"when to pick\" note. Art icons will slot in once Mega Crit publishes the assets — until then, the renderer shows the same 2-letter glyph fallback we use for any unfamiliar relic."
                ),
                .feature(
                    title: "Pumpkin Candle reworked, Infused Core buffed",
                    body: "Pumpkin Candle swapped its \"extinguishes at the start of Act 3\" rider for \"extinguishes after 5 combats, kindle at rest sites.\" Defect's Infused Core picked up a bonus \"Lightning Orbs deal 1 additional damage\" line. Both tooltips reflect the new copy, so hovering them in Recent Runs reads what your actual game shows you."
                ),
                .feature(
                    title: "Aeonglass replaces Doormaker",
                    body: "The new Act 3 boss is in the boss label table — \"Killed by\" rows now read Aeonglass rather than a raw slug. Doormaker stays in the label table too so older runs in your history don't suddenly mis-render."
                ),

                .heading("What this means for unknown future relics"),
                .paragraph("The parser was already designed to forward unknown content as raw slugs — nothing about Spire Vault assumes a closed list of relics. Any post-v0.105.0 patch that ships brand-new relics will tally in the Top Relics tab, show up in deck lists, and roll up into win-rate buckets the moment your save file lands. We just won't have a hand-written tooltip for them until we patch this list. — Corey"),
            ]
        ),

        NewsPost(
            id: "002-2026-05-09-run-compare-and-auto-refresh-status",
            eyebrow: "Update · May 9, 2026",
            title: "Run Compare, Auto-refresh status — and what we're testing next",
            readMinutes: 5,
            tags: ["Update", "New feature", "Roadmap", "Community"],
            body: [
                .lede("Big batch this week. Two new features, one root-cause fix that had been driving people quietly nuts, and an honest look at what's in the dev branch right now — including the conversation I'm starting with the Slay the Spire 2 community on getting more testers in here."),

                .heading("What's new — live on prod"),
                .feature(
                    title: "Run Compare — pick 2 or 3 runs, see them side by side",
                    body: "There's a new Compare button in the Recent Runs filter bar (hit `c` on your keyboard if you're a power user). Toggle it, click 2 or 3 rows, and the bottom-of-screen bar opens a side-by-side comparison: stats, top relics, and the cards that are unique to each run vs. the cards every selected run shared. The hero panel above the columns surfaces every relic and card in the intersection with a soft golden glow — so the question \"what made my winning runs win?\" answers itself."
                ),
                .feature(
                    title: "Auto-refresh status pill — you can finally see when it stops",
                    body: "For a long time the auto-refresh loop would just… quietly stop, because Chrome silently downgrades the folder permission from \"granted\" to \"prompt\" between sessions. There's now a status pill at the top of Recent Runs: green pulse with \"last checked 14s ago\" when healthy, amber with a one-click Resume when the browser dropped your grant. We also opportunistically piggyback on your next click anywhere on the page to silently re-request the permission."
                ),
                .feature(
                    title: "That sticky hover tooltip — root-caused and gone",
                    body: "Patch after patch wasn't fixing it because they were all treating the symptom. The actual cause was CSS specificity: `.h-tooltip { display: flex }` and the user-agent `[hidden] { display: none }` rule had identical specificity, and \"later wins\" silently overrode the hidden attribute. One `[hidden] { display: none !important }` backstop near the top of the stylesheet, and the entire tooltip lifecycle works the way it always claimed to."
                ),
                .feature(
                    title: "\"Unknown character\" rows — smarter fallback",
                    body: "Schema-16 partial writes occasionally land on disk with the explicit character field missing. The parser now tallies cards in the deck (each character's starter cards are namespaced — silent_strike, ironclad_bash) and falls back to starter relics (Burning Blood, Ring of the Snake, Cracked Core) as a last resort. If we can see what you started with, we can tell you what you played."
                ),
                .heading("Smaller polish that adds up"),
                .bullets([
                    "Daily-run badges with the actual date, instead of mis-rendering daily runs as \"Ascension 2\".",
                    "Settings tab centralizes import / export / clear / disconnect / sign-out so the toolbar isn't a mile long.",
                    "Pinned characters — star a class on the Characters tab and it sticks to the top of the list.",
                    "Keyboard shortcuts: 1–9 for tabs, / focuses search, ? opens a help overlay, c toggles Compare on Recent Runs.",
                    "Win-rate sparkline on the Overview tab — rolling trend across your last 20 runs.",
                    "Deep links: copy a direct link to any run or any community highlight.",
                    "Milestone toasts for first victory, win streaks, run-count tiers, and per-character clears.",
                    "Reactions on community highlights live in a clean popover instead of bare emojis everywhere.",
                ]),

                .heading("In dev right now"),
                .roadmap(items: [
                    "macOS Run Companion Overlay v1 — floating window over Slay the Spire 2 with co-op pair status, online count, and optional deck reminders.",
                    "Daily challenge leaderboard — group all daily-run highlights from the same seed into a leaderboard view.",
                    "Run replay scrubber — step through a run floor by floor inside the run-detail modal, watching deck/relics/HP evolve.",
                ], isInflight: true),

                .heading("Roadmap — honest order of operations"),
                .roadmap(items: [
                    "Native Windows app — same backend, same UI, native window via Tauri.",
                    "iOS Companion data alignment — bringing the App Store app onto the same data shape as the web.",
                    "Weekly digest email — optional, off by default, plain text. One email a week.",
                    "Co-op chat in-app — close the loop without needing a Steam tab open.",
                ], isInflight: false),

                .heading("Reaching out to the Slay the Spire community"),
                .paragraph("I'm starting a conversation with the Slay the Spire 2 official Discord about getting Spire Vault in front of more testers. The plan is to ask the moderators if I can post a short pinned message in #community-tools (or wherever they think it belongs) inviting players to try the web app and send me bug reports."),
                .paragraph("What I'm specifically looking for: a couple of dozen testers spread across all five characters and the full ascension range, especially A15–A20 victories so the Compare mode has real data to chew on. People playing on the latest STS2 build — schema-16 character-extraction edge cases are exactly the kind of thing that only shows up on real machines, not mine. Honest feedback on the new Compare modal and the auto-refresh pill."),
                .paragraph("This is opt-in, no posting on anyone's behalf, no DMs without permission. If a moderator from the STS2 Discord is reading this and would like a guided tour of the app or my notes on data handling and privacy, my email is in the footer of every page."),

                .heading("A small ask, same as last time"),
                .paragraph("If something feels broken, weird, or just unfinished — please tell me. File an issue on GitHub, or hit me up on the co-op feed. Every \"this clicks but doesn't do anything\" report makes the next build measurably better. — Corey"),
            ]
        ),

        NewsPost(
            id: "001-2026-05-05-bug-fixes-and-updates",
            eyebrow: "Update · May 5, 2026",
            title: "Bug fixes & updates — thank you for using Spire Vault",
            readMinutes: 4,
            tags: ["Update", "Bug fixes", "Roadmap"],
            body: [
                .lede("First, the obvious thing: thank you for being here. Spire Vault went from \"weird side project\" to \"people are actually using this\" because of you. Quick rundown of what's new, then a few things I'm working on next."),
                .heading("What's new"),
                .feature(
                    title: "Co-op pairing — you can now see who's playing with who",
                    body: "When you and another player both accept an invite, both rows on the roster pick up a green \"Co-op — w/ @PartnerName\" pill. The invite button on a paired row turns into a \"Busy\" tag instead of a dead button. Pairs auto-clear after 4 hours."
                ),
                .feature(
                    title: "The cache & reload mess is finally fixed",
                    body: "There's now a small banner at the top of the app when a newer version is out: \"A newer version of Spire Vault is available — Reload now.\" Click it whenever you're ready. Sign-in and stats stick across reloads."
                ),
                .feature(
                    title: "Run paths, but readable",
                    body: "The Recent Runs modal now shows your full path through every act with proper map icons — campfire, treasure chest, elite, boss, shop. Each act starts collapsed; the act where you died (or won) gets a red DIED HERE or green VICTORY chip on the closed header."
                ),
                .feature(
                    title: "Cross-device run history that actually syncs",
                    body: "Run history is keyed to your Steam ID and synced to the cloud. Sign in on your laptop, import once, then open the app on your phone — everything's already there. A small \"Synced N runs · last sync 2 min ago\" pill in the toolbar shows status."
                ),
                .heading("What I'm working on next"),
                .roadmap(items: [
                    "Community Highlights — opt-in share-a-run feed.",
                    "A real Windows app via Tauri.",
                    "iOS Companion sync alignment.",
                    "Optional weekly \"what changed\" digest email.",
                ], isInflight: false),
            ]
        ),
    ]

    static func markLatestRead() {
        UserDefaults.standard.set(latestPostID, forKey: "vault.app.news.lastRead")
    }
    static var hasUnreadLatest: Bool {
        let last = UserDefaults.standard.string(forKey: "vault.app.news.lastRead") ?? ""
        return last != latestPostID
    }
}
