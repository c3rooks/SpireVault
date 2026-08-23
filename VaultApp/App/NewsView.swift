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
    ///
    /// Numbering note: ids track the web app's posts of the same
    /// content (app.spirevault.app's news-009 / news-008 cover the
    /// same updates). The web catalog also has a "007" (Co-op Lobby
    /// v2) that hasn't been ported to this native catalog yet —
    /// that's a pre-existing gap, not something these posts caused.
    static let latestPostID = "009-2026-07-23-banners-durable-saves-beta-pass"

    static let posts: [NewsPost] = [
        NewsPost(
            id: "011-2026-08-23-v211-thank-you",
            eyebrow: "Release · August 23, 2026",
            title: "The big one: schedule your co-op, trust every tooltip — and thank you",
            readMinutes: 4,
            tags: ["Release", "Co-op", "Thank you"],
            body: [
                .lede("Today's release is the biggest one since launch, and before anything else: thank you. There are 84 of you now, and some of you open this thing every single day — I see the same names come back morning after morning, and honestly that's the whole reason this update exists. Everything below was built for the people who kept showing up."),

                .heading("Where the game stands"),
                .paragraph("The main branch — what most of you play — is still v0.107.1 \u{201c}Major Update #2\u{201d} from June. We read Mega Crit's v0.108.0 through v0.111.0 beta notes in full; all of it is beta-branch only, and v0.111.0 is the last patch for a while with a big content update teased. Tooltips describe the main branch, with beta changes watchlisted. The beta short version: Silent's poison kit rebuilt (Scare is now Sidestep), Ancients rebalanced across the board, A8-A9 enemies meaner. Run history renders both branches correctly."),

                .heading("Schedule your co-op — nobody has to be online at the same time anymore"),
                .paragraph("The oldest problem with the Co-op tab: two people who both wanted the same run would visit twenty minutes apart, each see an empty board, and each conclude nobody was here. The fix is the new \u{201c}When are you free?\u{201d} panel at the top of Co-op. One tap on \u{201c}Tonight\u{201d} or \u{201c}Saturday\u{201d} (or pick exact times) saves your window on the server — close the tab, shut the laptop, doesn't matter. When someone else's window overlaps yours by at least half an hour, with a compatible goal and ascension range, you both see the match: who, when, and how much overlap."),

                .heading("If the app shows you a game fact, it's the real one"),
                .paragraph("We read Mega Crit's v0.108.0 through v0.111.0 patch notes in full, then re-verified every card and relic tooltip against the game's own data. Relic tooltips went from ~32 to 159; the AI coach's glossary grew from 72 to 279 sourced cards with full Regent and Necrobinder coverage for the first time. Long-hiding Slay the Spire 1 ghosts (looking at you, Snecko Eye) are gone — and an automated check now cross-references every data source on every deploy, so stale tooltips can't ship again."),

                .heading("Faster for the people who come back"),
                .paragraph("Returning visitors were re-downloading about 1.5 MB of JavaScript on every load. Fixed properly: code is cached for a year and updates arrive via version-stamped URLs — repeat visits are dramatically lighter, and this desktop app (now 0.10.0) carries everything above."),

                .heading("What's coming"),
                .paragraph("Mega Crit says a large content update is next — the data ledger and deploy guard we built this cycle exist precisely so SpireVault syncs in hours when it lands. On the co-op side: schedule matches that reach you when the tab is closed, and one-click match-to-lobby. To the daily crew: you know who you are. Keep climbing."),
            ]
        ),
        NewsPost(
            id: "009-2026-07-23-banners-durable-saves-beta-pass",
            eyebrow: "Update · July 23, 2026",
            title: "New banner art, saves you never re-import, and a beta-patch data pass",
            readMinutes: 3,
            tags: ["Update", "UI", "Saves", "Game data"],
            body: [
                .lede("A little of everything today: the five stats-tab banners got fully re-rendered art, imported runs are now pinned so the browser can never quietly evict them, and we did a full read-through of Mega Crit's June and July newsletters plus the v0.108.0 and v0.109.0 beta patch notes to make sure everything in the app matches the game. There are 73 of you climbing with us around the world now — thank you. This one's for you."),

                .heading("New scene art on every stats tab"),
                .paragraph("Overview, Characters, Ascensions, Top Relics, and Cards each carry a brand-new 3D-rendered backdrop — the ember-lit gate hall on Overview, five class-colored alcoves on Characters, a staircase climbing into light on Ascensions, a relic vault on Top Relics, and a scriptorium with floating cards on Cards. Your climber and the boss still stand in the scene the way they always have; the stage behind them just got a serious upgrade. (Since the desktop app embeds the live web panels, you're already looking at it.)"),

                .heading("Import once. Actually once."),
                .paragraph("On the web, runs have always been cached in the browser after an import — but browsers treat that storage as best-effort and are allowed to evict it under disk pressure. As of today the web app asks the browser to mark its storage durable the moment real run data lands, which takes eviction off the table. Desktop users were never affected (your runs are parsed natively from disk), and signed-in users were already double-covered by cloud sync."),

                .heading("The beta-patch data pass"),
                .paragraph("Mega Crit shipped two beta patches since Major Update #2: v0.108.0 (July 3) and v0.109.0 (July 17). Neither is on the main branch yet, so nothing changes for most of you — but if you play beta, your save can already contain content the app had never heard of. Now it has: display names for all sixteen new multiplayer cards (Midnight, Blade Symphony, The Ball, Tutor, and friends) plus the Dowsing quest chain, and hand-written tooltips for the two new Neow relics — Dowsing Rod and Neow's Sacrifice — using Mega Crit's exact wording from the patch notes. Balance changes that only exist on beta (the Diamond Diadem rework, the History Course nerf, Demon Form's buff) are tracked but deliberately not applied to our tooltips until they land on main, so the app never shows numbers your own game doesn't have. — Corey"),
            ]
        ),

        NewsPost(
            id: "008-2026-06-19-sts2-v0_107_1-support",
            eyebrow: "Patch · June 19, 2026",
            title: "STS2 v0.107.1 \u{201c}Major Update #2\u{201d} is supported — Aeonglass hits the main branch",
            readMinutes: 2,
            tags: ["Patch", "Game data", "v0.107.1"],
            body: [
                .lede("Mega Crit shipped Major Update #2 to the main branch on June 18–19 — the update that carries everything from the last two months of beta patches (v0.105.0 through v0.107.0) to every player, not just beta testers. Runs from the new build already show up correctly in The Vault; this post is the \"what changed and what we already had covered\" rundown."),

                .heading("What was already covered"),
                .feature(
                    title: "Aeonglass, the three new Neow relics, and the Bestiary",
                    body: "We added label support for Aeonglass (the Act 3 boss replacing Doormaker) and the three new Neow relics — Kaleidoscope, Fishing Rod, Silken Tress — back when these were beta-only content in v0.105.0. As of this patch they're live for every player, so \"Killed by Aeonglass\" and Neow-relic tooltips should just work on your very first post-patch run. No action needed on our end."
                ),

                .heading("What we fixed for this patch"),
                .feature(
                    title: "Silken Tress picked up a downside — our tooltip now says so",
                    body: "Between the May beta and this main-branch patch, Mega Crit swapped downsides between two Neow relics: Neow's Scroll Boxes lost its \"lose all gold\" clause (that's the buff in the official notes), and Silken Tress picked it up instead. Our Silken Tress tooltip was still showing the old, downside-free May text. It now reads \"Enchant all cards in the first card reward with Glam. Upon pickup, lose all gold.\" — matching what v0.107.1 actually shows you in-game."
                ),

                .heading("What's still on the list"),
                .paragraph("v0.107.1 is a big patch — RNG rework (the PRNG is now xoshiro256**, fixing a real correlation bug between your run seed and things like Neow's Bones curses), official Steam Workshop support, and dozens of card and relic balance changes across every class. None of that changes how The Vault reads your save file, and we don't have hand-written tooltips for every rebalanced relic yet (Neow's Scroll Boxes, Booming Conch, Nutritious Soup, Seal of Gold, Pael's Eye, and The Boot all changed this patch). Those relics still show up correctly in your run history and Top Relics tab — they just fall back to your personal stats instead of a hand-written blurb until we source the exact in-game text. — Corey"),
            ]
        ),

        NewsPost(
            id: "006-2026-05-10-desktop-cloud-parity",
            eyebrow: "Update · May 10, 2026",
            title: "The desktop app is now the cloud — backgrounds, characters, animations, all of it",
            readMinutes: 3,
            tags: ["Update", "Desktop", "Parity"],
            body: [
                .lede("v0.9.2 stops maintaining two parallel UIs. The macOS app now embeds the live web companion (app.spirevault.app) for every data tab — Overview, Characters, Ascensions, Top Relics, Cards, Recent Runs, Co-op, Community Highlights, News. Same backgrounds, same character art, same animations, same hover states, same modals, same share-cards. One UI, one source of truth, no drift."),

                .heading("What changed"),
                .feature(
                    title: "Stats tabs are the cloud, rendered inside the app",
                    body: "We replaced the macOS native versions of every data panel with a WKWebView that loads the same page you'd open in Chrome. The native sidebar (Overview, Characters, Ascensions, Top Relics, Cards, Recent Runs, Co-op, Community Highlights, News) drives the embedded view via a small `window.SpireVault` bridge. Click a tab, the web flips. Click an in-page link inside the embedded panel, the native sidebar follows along."
                ),
                .feature(
                    title: "Your runs stay local — and show up instantly",
                    body: "VaultCore still parses your STS2 saves natively. The desktop pipes the parsed runs into the embedded page via the bridge so the web sees your real history (414 runs, your actual winrate, your actual best floor) instead of the demo set — without uploading anything you didn't already opt into uploading."
                ),
                .feature(
                    title: "Native pieces stayed native",
                    body: "Beta and Settings stayed in SwiftUI: Run Coach needs an NSPanel with sharingType=.none and a Keychain-backed API key (a browser can't replicate either), and Settings needs NSOpenPanel for save folder linking. The menu bar (About, Check for Updates, Help) is still native. The slim toolbar above each panel still has Rescan / Export / Open Saves Folder."
                ),
                .feature(
                    title: "Community Highlights now actually loads",
                    body: "An old typo had the desktop hitting `/api/highlights` while the worker exposes `/highlights` — every desktop user was getting a 404, which is why the highlights tab looked permanently empty. Fixed in v0.9.2. If you posted a highlight, it shows up now."
                ),
                .feature(
                    title: "The newsletter is real",
                    body: "Every news post that promised \"weekly digest email\" now has a real signup form pinned to the worker's new POST /notify route. Plain-text, off by default, one-click unsubscribe when it ships. We're capturing intent in KV until the mailer is wired — no third party touches your address."
                ),

                .heading("Why webview for the data tabs"),
                .paragraph("The cloud version was getting all the love — character art, the architect, click-to-expand cards, the share-card canvas, the live recent-form chart, the run-detail modal. Reproducing all of that in SwiftUI was an entire parallel codebase that drifted further behind every web deploy. Embedding the canonical UI is what every serious cross-platform app does (Notion, Slack, Linear, Discord, Spotify) — one UI, one set of bugs, one rendering surface to QA. The desktop now ships every cloud feature the moment we deploy the web."),

                .heading("Streamers, no behaviour change"),
                .paragraph("Run Coach is still streamer-safe. The macOS overlay is still NSPanel + sharingType=.none and stays invisible to OBS / Zoom / QuickTime. Nothing about the embedded WebView changes that — the WebView is for stats, not the overlay."),

                .heading("What's next"),
                .roadmap(items: [
                    "Bridging Steam OpenID into the embedded page so a single sign-in covers both halves.",
                    "Offline-aware fallback: if the cloud is unreachable, the desktop falls back to a slim native overview rendered from VaultCore.",
                    "Native context menu inside the embedded page (Copy run link / Open in browser / Inspect).",
                    "Wire the digest mailer once we have ~50+ confirmed signups.",
                ], isInflight: false),

                .paragraph("If anything in the embedded view feels off — slow, jittery, missing — file an issue and screenshot it. The webview path is new and the corner cases haven't all been swept. — Corey"),
            ]
        ),

        NewsPost(
            id: "005-2026-05-10-cloud-overlay-and-persona-menu",
            eyebrow: "Update · May 10, 2026",
            title: "Run Coach reaches the web — and Settings now lives in your persona pill",
            readMinutes: 3,
            tags: ["Beta", "Web", "Overlay", "UX"],
            body: [
                .lede("Two changes in v0.9.1: the standalone Settings sidebar item is gone in both apps (clicking your Steam name opens it now), and Run Coach is no longer Mac-only — there's a real always-on-top floating overlay in the web app, built on Document Picture-in-Picture."),

                .heading("Settings folded into the persona pill"),
                .feature(
                    title: "One canonical \"about you\" surface",
                    body: "The footer pill at the bottom of the sidebar (the one that shows your Steam name + \"Saves connected\") is now a clickable menu. Settings, Beta features, Open Co-op, and Sign out live inside it. The standalone Settings row in the sidebar is retired — every \"about you\" control is in one place now, instead of split between a footer pill and a sidebar tab."
                ),
                .feature(
                    title: "Guest path stays clean",
                    body: "First-time visitors who haven't signed in still need Settings (link a save folder, import a history.json, toggle prefs). The macOS guest pill grows a Settings + Beta shortcut row, and the web's guest pill exposes a tiny inline Settings link beneath the sign-in CTA. No save-data plumbing is hidden behind auth."
                ),

                .heading("Run Coach in the web app (Beta)"),
                .feature(
                    title: "A real native always-on-top window — from a browser tab",
                    body: "Open the new Beta tab in the web sidebar, paste your OpenAI or Anthropic key, click Launch, and a 360×540 floating window pops out — sitting on top of every other window, including fullscreen STS2. It's the same Cluely-style chat as the macOS overlay (header pill, action chips, screenshot toggle, send), and uses Document Picture-in-Picture under the hood. No Vault server is in the loop."
                ),
                .feature(
                    title: "Bring your own key, end-to-end",
                    body: "The browser POSTs straight to api.openai.com or api.anthropic.com with your key. Vault never sees the prompt, the key, or the screenshot. Keys live in localStorage on this device — the page tells you that explicitly, because the browser doesn't have a Keychain."
                ),
                .feature(
                    title: "Honest fallback for Safari + Firefox",
                    body: "Document Picture-in-Picture only ships on Chromium browsers right now (Chrome, Edge, Brave, Opera, Arc, Vivaldi). On Safari and Firefox, the Beta tab detects the gap and shows a graceful \"open in Chromium or install the macOS app\" message — no broken Launch button, no half-working overlay."
                ),

                .heading("Streamers should still use the desktop build"),
                .paragraph("The browser overlay is a real OS window, which means OBS, Zoom, and QuickTime can see it. The macOS app uses NSWindow.sharingType=.none to hide the Run Coach from screen recordings entirely. If you stream STS2, grab the .dmg from the marketing site — that build is the streamer-safe version."),

                .heading("What's next"),
                .roadmap(items: [
                    "Persisting Run Coach chat history per session (currently resets on overlay close).",
                    "Web hotkey for \"What should I do?\" matching the desktop's ⌘↵.",
                    "Per-provider model dropdown so you can switch from gpt-4o-mini to gpt-4o without typing.",
                    "Stream-aware mode for the desktop overlay: auto-collapse when OBS goes live.",
                ], isInflight: false),

                .paragraph("Try the web overlay on a real card reward and tell me what felt wrong — bugs and screenshots are the loop. — Corey"),
            ]
        ),

        NewsPost(
            id: "004-2026-05-10-run-coach-beta",
            eyebrow: "Beta · May 10, 2026",
            title: "Run Coach (Beta) — an in-game AI panel for STS2",
            readMinutes: 4,
            tags: ["Beta", "New feature", "Overlay", "AI"],
            body: [
                .lede("v0.9 ships a new Beta tab with the first real version of Run Coach: a Cluely-style floating panel that sits over Slay the Spire 2, looks at your screen on demand, and gives you one ranked decision — using your own OpenAI or Anthropic API key. It's gated behind a Beta toggle, never on by default, and stays off the marketing site until it's proven."),

                .heading("What Run Coach is"),
                .feature(
                    title: "A small floating bar at the top of your screen",
                    body: "By default it's a slim 210×38 pill: the Vault emblem, a \"Coach\" trigger, and an X to close. The pill rides over fullscreen STS2 thanks to NSPanel + .canJoinAllSpaces + .fullScreenAuxiliary, and sets sharingType=.none so OBS, Zoom, QuickTime, and macOS screen recordings can't see it. Streamers don't get random AI panels in their captures."
                ),
                .feature(
                    title: "Hit ⌘↵ and the Coach looks at your screen",
                    body: "Cmd+Enter from inside the panel triggers \"What should I do?\" — the active display is captured (CGDisplayCreateImage, downscaled to ~1280px), packaged with your typed question and a tiny chunk of context from your local run history, and sent to your chosen provider. The reply renders in the chat with a confidence-aware tone and short \"why\" bullets you can verify by looking at the screen."
                ),
                .feature(
                    title: "Bring your own key",
                    body: "OpenAI (default model `gpt-4o-mini`) or Anthropic (default model `claude-3-5-sonnet-latest`). Your key is stored in the macOS Keychain under com.coreycrooks.thevault.overlay and only ever leaves your Mac as an Authorization / x-api-key header on the call to the provider you picked. The Vault servers never touch it, never see your screenshots, never see the prompt or reply."
                ),

                .heading("How to enable it"),
                .bullets([
                    "Open the new Beta tab in the sidebar (look for the flask icon under SYSTEM).",
                    "Pick a provider — OpenAI or Anthropic.",
                    "Paste your API key into the secure field. The Keychain handles storage; you can hide / show / remove the key at any time.",
                    "Flip the \"Enable the Run Coach overlay\" switch. The pill appears at the top center of your active display.",
                    "macOS will prompt for Screen Recording permission the first time the Coach captures the screen. It's a one-time grant under System Settings → Privacy & Security → Screen Recording.",
                ]),

                .heading("What we deliberately did not do"),
                .bullets([
                    "No game memory reads. Run Coach never injects, hooks, or scans the STS2 process. It only sees what you explicitly hand it via the Cmd+Enter screenshot.",
                    "No subscriptions. There's no Vault-hosted LLM. The Vault is still free + open source — Run Coach is just a thin client over the provider you already pay for or want to try.",
                    "No silent telemetry. Failing to capture a screen, a 401 from your provider, a model that doesn't exist — all of that lands in the Beta tab's live test panel, never in a remote logging service.",
                    "No marketing-site mention. Run Coach is shipping in front of real players in Beta first. If it earns its place, it gets a feature card on the landing page.",
                ]),

                .heading("Roadmap from here"),
                .roadmap(items: [
                    "Local-only mode using Apple Foundation Models on macOS 26+ — keys-free, fully offline run advice.",
                    "Region picker for partial-screen capture so the Coach only sees the card-reward modal, not your whole desktop.",
                    "Voice trigger: \"Coach, what's the move?\" → screen capture + ask, no keyboard required.",
                    "Conversation memory that survives a restart, scoped per-character so Coach context resets on a new run.",
                ], isInflight: false),

                .paragraph("Try it on a real card reward, hit Cmd+Enter, and tell me what felt wrong. Bug reports + screenshots make the next build measurably better. — Corey"),
            ]
        ),

        NewsPost(
            id: "003-2026-05-09-sts2-v0_105_0-support",
            eyebrow: "Patch · May 9, 2026",
            title: "STS2 v0.105.0 (Bestiary, Aeonglass) is supported",
            readMinutes: 2,
            tags: ["Patch", "Game data", "v0.105.0"],
            body: [
                .lede("Mega Crit shipped a beta patch on May 8 that touched the Neow pool, reworked an Ancients reward, and replaced the Act 3 boss. Runs from the new build now show up correctly in SpireVault — names, labels, and tooltips included."),

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
                .paragraph("The parser was already designed to forward unknown content as raw slugs — nothing about SpireVault assumes a closed list of relics. Any post-v0.105.0 patch that ships brand-new relics will tally in the Top Relics tab, show up in deck lists, and roll up into win-rate buckets the moment your save file lands. We just won't have a hand-written tooltip for them until we patch this list. — Corey"),
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
                .paragraph("I'm starting a conversation with the Slay the Spire 2 official Discord about getting SpireVault in front of more testers. The plan is to ask the moderators if I can post a short pinned message in #community-tools (or wherever they think it belongs) inviting players to try the web app and send me bug reports."),
                .paragraph("What I'm specifically looking for: a couple of dozen testers spread across all five characters and the full ascension range, especially A15–A20 victories so the Compare mode has real data to chew on. People playing on the latest STS2 build — schema-16 character-extraction edge cases are exactly the kind of thing that only shows up on real machines, not mine. Honest feedback on the new Compare modal and the auto-refresh pill."),
                .paragraph("This is opt-in, no posting on anyone's behalf, no DMs without permission. If a moderator from the STS2 Discord is reading this and would like a guided tour of the app or my notes on data handling and privacy, my email is in the footer of every page."),

                .heading("A small ask, same as last time"),
                .paragraph("If something feels broken, weird, or just unfinished — please tell me. File an issue on GitHub, or hit me up on the co-op feed. Every \"this clicks but doesn't do anything\" report makes the next build measurably better. — Corey"),
            ]
        ),

        NewsPost(
            id: "001-2026-05-05-bug-fixes-and-updates",
            eyebrow: "Update · May 5, 2026",
            title: "Bug fixes & updates — thank you for using SpireVault",
            readMinutes: 4,
            tags: ["Update", "Bug fixes", "Roadmap"],
            body: [
                .lede("First, the obvious thing: thank you for being here. SpireVault went from \"weird side project\" to \"people are actually using this\" because of you. Quick rundown of what's new, then a few things I'm working on next."),
                .heading("What's new"),
                .feature(
                    title: "Co-op pairing — you can now see who's playing with who",
                    body: "When you and another player both accept an invite, both rows on the roster pick up a green \"Co-op — w/ @PartnerName\" pill. The invite button on a paired row turns into a \"Busy\" tag instead of a dead button. Pairs auto-clear after 4 hours."
                ),
                .feature(
                    title: "The cache & reload mess is finally fixed",
                    body: "There's now a small banner at the top of the app when a newer version is out: \"A newer version of SpireVault is available — Reload now.\" Click it whenever you're ready. Sign-in and stats stick across reloads."
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
