import SwiftUI
import VaultCore

struct DetailView: View {
    @EnvironmentObject var state: AppState
    let section: SidebarSection

    var body: some View {
        Group {
            // Co-op renders its own scroll/layout chrome — no padding wrapper.
            if section == .coop {
                CoopView()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 28) {
                        if let r = state.report, !state.runs.isEmpty {
                            switch section {
                            case .overview:   OverviewView(report: r)
                            case .characters: CharactersView(report: r)
                            case .ascensions: AscensionsView(report: r)
                            case .relics:     RelicsView(report: r)
                            case .cards:      CardsView(report: r)
                            case .runs:       RecentRunsView(runs: state.filter.apply(state.runs))
                            case .coop:       EmptyView() // unreachable
                            }
                        } else if state.runs.isEmpty {
                            EmptyStateView()
                                .frame(maxWidth: .infinity, minHeight: 500)
                        } else {
                            ProgressView()
                                .frame(maxWidth: .infinity, minHeight: 500)
                        }
                    }
                    .padding(.horizontal, 28)
                    .padding(.vertical, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .background(Theme.bgPrimary)
    }
}

// MARK: - Overview hero

struct OverviewView: View {
    let report: StatsReport
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HeroBlock(report: report)

            // Co-op callout only when there's real signal: someone (besides
            // us) is online on the matchmaking server.
            if let svc = state.presenceService {
                let mySID = state.steamAuth.profile?.steamID
                let others = svc.entries.filter { $0.steamID != mySID }
                if !others.isEmpty {
                    CoopOverviewCTA(service: svc, others: others)
                }
            }

            CharacterTileGrid(report: report)

            AscensionChart(report: report)

            HStack(alignment: .top, spacing: 16) {
                TopRelicsCompact(report: report)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                TopCardsCompact(report: report)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}

private struct CoopOverviewCTA: View {
    @ObservedObject var service: PresenceService
    let others: [PresenceEntry]

    var body: some View {
        let inGame = others.filter(\.inSTS2).count
        let looking = others.filter { $0.status == .looking }.count

        HStack(alignment: .center, spacing: 18) {
            Image("VaultEmblem")
                .resizable().aspectRatio(contentMode: .fit)
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(color: Theme.accent.opacity(0.5), radius: 12)
            VStack(alignment: .leading, spacing: 4) {
                Text("CO-OP")
                    .font(.system(size: 10, weight: .black, design: .rounded))
                    .tracking(2)
                    .foregroundStyle(Theme.gold)
                Text(headline(total: others.count, looking: looking, inGame: inGame))
                    .font(.system(size: 16, weight: .heavy, design: .serif))
                    .foregroundStyle(Theme.text)
                Text("Open the Co-op tab to see who's around and message them on Steam or Discord.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .heavy))
                .foregroundStyle(Theme.accent)
        }
        .padding(18)
        .background(
            LinearGradient(colors: [Theme.cardBG, Theme.bgDeep],
                           startPoint: .leading, endPoint: .trailing),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(
                    LinearGradient(colors: [Theme.accent.opacity(0.6), Theme.gold.opacity(0.3)],
                                   startPoint: .leading, endPoint: .trailing),
                    lineWidth: 1.2
                )
        )
    }

    private func headline(total: Int, looking: Int, inGame: Int) -> String {
        if inGame > 0 {
            return "\(inGame) player\(inGame == 1 ? "" : "s") in Slay the Spire 2 right now"
        }
        if looking > 0 {
            return "\(looking) player\(looking == 1 ? "" : "s") looking for co-op"
        }
        return "\(total) other player\(total == 1 ? "" : "s") online"
    }
}

// MARK: - HERO

struct HeroBlock: View {
    let report: StatsReport

    var body: some View {
        HStack(alignment: .center, spacing: 24) {
            // Big winrate ring
            ZStack {
                RingGauge(value: report.overallWinrate, lineWidth: 12)
                    .frame(width: 168, height: 168)
                VStack(spacing: 0) {
                    Text(Prettify.percent(report.overallWinrate))
                        .font(.system(size: 38, weight: .heavy, design: .rounded))
                        .foregroundStyle(report.overallWinrate >= 0.10 ? Theme.win : Theme.accent)
                        .monospacedDigit()
                    Text("WINRATE")
                        .font(.system(size: 10, weight: .bold, design: .rounded))
                        .tracking(2)
                        .foregroundStyle(Theme.textSecondary)
                }
            }
            .frame(width: 168, height: 168)

            VStack(alignment: .leading, spacing: 14) {
                Text("Run history")
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(2)
                    .foregroundStyle(Theme.textTertiary)
                HStack(alignment: .firstTextBaseline, spacing: 24) {
                    BigStat(value: "\(report.totalRuns)", label: "RUNS",  tint: Theme.text)
                    BigStat(value: "\(report.totalWins)", label: "WINS",  tint: Theme.win)
                    BigStat(value: "\(report.totalRuns - report.totalWins)", label: "LOSSES", tint: Theme.loss)
                }
                if let bestChar = report.byCharacter.max(by: { $0.winrate < $1.winrate }) {
                    HStack(spacing: 8) {
                        Image(systemName: "crown.fill").foregroundStyle(Theme.gold)
                        Text("Best:")
                            .foregroundStyle(Theme.textSecondary)
                        Text(Prettify.id(bestChar.key))
                            .foregroundStyle(Theme.characterColor(forKey: bestChar.key))
                            .fontWeight(.semibold)
                        Text("· \(Prettify.percent(bestChar.winrate)) over \(bestChar.runs) runs")
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .font(.system(size: 12, weight: .medium))
                }
            }

            Spacer(minLength: 0)
        }
        .premiumPanel(padding: 28, cornerRadius: 18)
    }
}

private struct BigStat: View {
    let value: String
    let label: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 36, weight: .heavy, design: .rounded))
                .foregroundStyle(tint)
                .monospacedDigit()
            Text(label)
                .font(.system(size: 10, weight: .heavy, design: .rounded))
                .tracking(1.5)
                .foregroundStyle(Theme.textSecondary)
        }
    }
}

private struct RingGauge: View {
    let value: Double
    var lineWidth: CGFloat = 10

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.cardBorder, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: max(0.005, min(1, CGFloat(value))))
                .stroke(
                    LinearGradient(
                        colors: value >= 0.10 ? [Theme.winBright, Theme.win] : [Theme.accentBright, Theme.accent],
                        startPoint: .top, endPoint: .bottom
                    ),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))
                .shadow(color: Theme.accent.opacity(0.4), radius: 12, y: 0)
        }
    }
}

// MARK: - Character tile grid

struct CharacterTileGrid: View {
    let report: StatsReport

    private let columns = [GridItem(.adaptive(minimum: 200, maximum: 260), spacing: 16, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Per character", systemImage: "person.3.fill")
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(report.byCharacter, id: \.key) { b in
                    CharacterTile(bucket: b)
                }
            }
        }
    }
}

struct CharacterTile: View {
    let bucket: StatsReport.Bucket
    @State private var hover = false

    private var character: VaultCore.Character? { VaultCore.Character.from(bucket.key) }
    private var color: Color { Theme.characterColor(character) }
    private var icon: String { Theme.characterIcon(character) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(color)
                    .frame(width: 36, height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(color.opacity(0.18))
                    )
                Spacer()
                Pill(text: "\(bucket.runs) runs", tint: Theme.textSecondary, bold: false)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(Prettify.id(bucket.key))
                    .font(.system(size: 17, weight: .heavy, design: .rounded))
                    .foregroundStyle(Theme.text)
                Text("\(bucket.wins) wins · \(bucket.runs - bucket.wins) losses")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(Prettify.percent(bucket.winrate))
                        .font(.system(size: 28, weight: .heavy, design: .rounded))
                        .foregroundStyle(color)
                        .monospacedDigit()
                    Spacer()
                    Text("WINRATE")
                        .font(.system(size: 9, weight: .heavy, design: .rounded))
                        .tracking(1.5)
                        .foregroundStyle(Theme.textTertiary)
                }
                ProgressBar(value: bucket.winrate, tint: color)
            }
        }
        .premiumPanel(
            padding: 18,
            cornerRadius: 14,
            stroke: hover ? color.opacity(0.6) : Theme.cardBorder,
            fill: Theme.cardBG
        )
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
    }
}

struct ProgressBar: View {
    let value: Double
    var tint: Color = Theme.accent
    var height: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: height/2)
                    .fill(Theme.cardBGRaised)
                RoundedRectangle(cornerRadius: height/2)
                    .fill(LinearGradient(
                        colors: [tint, tint.opacity(0.8)],
                        startPoint: .leading, endPoint: .trailing
                    ))
                    .frame(width: max(2, CGFloat(value) * geo.size.width))
                    .shadow(color: tint.opacity(0.4), radius: 4, y: 0)
            }
        }
        .frame(height: height)
    }
}

// MARK: - Ascension chart

struct AscensionChart: View {
    let report: StatsReport

    private var sorted: [StatsReport.Bucket] {
        report.byAscension.sorted {
            ascNum($0.key) < ascNum($1.key)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Per ascension", systemImage: "chart.bar.fill")
            HStack(alignment: .bottom, spacing: 10) {
                ForEach(sorted, id: \.key) { b in
                    AscensionBar(bucket: b, maxRuns: maxRuns)
                }
                Spacer(minLength: 0)
            }
            .frame(height: 180)
            .premiumPanel(padding: 18, cornerRadius: 14)
        }
    }

    private var maxRuns: Int { sorted.map(\.runs).max() ?? 1 }
    private func ascNum(_ key: String) -> Int { Int(key.dropFirst()) ?? 0 }
}

private struct AscensionBar: View {
    let bucket: StatsReport.Bucket
    let maxRuns: Int

    @State private var hover = false

    var body: some View {
        VStack(spacing: 6) {
            ZStack(alignment: .bottom) {
                // Background full bar
                RoundedRectangle(cornerRadius: 6)
                    .fill(Theme.cardBGRaised)
                    .frame(width: 36, height: 130)

                // Total runs height (proportional)
                RoundedRectangle(cornerRadius: 6)
                    .fill(LinearGradient(
                        colors: [Theme.cardBorderHi, Theme.cardBG],
                        startPoint: .top, endPoint: .bottom
                    ))
                    .frame(width: 36, height: barHeight)

                // Wins fill (winrate proportion of the run-count bar)
                if bucket.wins > 0 {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(LinearGradient(
                            colors: [Theme.winBright, Theme.win],
                            startPoint: .top, endPoint: .bottom
                        ))
                        .frame(width: 36, height: winsHeight)
                }

                if hover {
                    VStack(spacing: 0) {
                        Text(Prettify.percent(bucket.winrate))
                            .font(.system(size: 9, weight: .heavy, design: .rounded))
                            .foregroundStyle(Theme.text)
                        Text("\(bucket.wins)/\(bucket.runs)")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Theme.bgDeep))
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.cardBorderHi, lineWidth: 1))
                    .offset(y: -barHeight - 4)
                }
            }
            Text(bucket.key)
                .font(.system(size: 10, weight: .heavy, design: .rounded))
                .foregroundStyle(Theme.textSecondary)
        }
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
    }

    private var barHeight: CGFloat {
        max(8, CGFloat(bucket.runs) / CGFloat(max(maxRuns, 1)) * 130)
    }
    private var winsHeight: CGFloat {
        guard bucket.runs > 0 else { return 0 }
        return barHeight * CGFloat(bucket.wins) / CGFloat(bucket.runs)
    }
}

// MARK: - Compact relics + cards (overview)

struct TopRelicsCompact: View {
    let report: StatsReport

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Top relics", systemImage: "sparkles", accent: Theme.gold)
            VStack(spacing: 6) {
                ForEach(report.byRelic.prefix(8), id: \.key) { b in
                    RelicRow(bucket: b)
                }
                if report.byRelic.isEmpty {
                    Text("No relic data yet.")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            .premiumPanel(padding: 14, cornerRadius: 12)
        }
    }
}

struct RelicRow: View {
    let bucket: StatsReport.Bucket
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkles")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Theme.gold)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Theme.goldSoft))
            VStack(alignment: .leading, spacing: 1) {
                Text(Prettify.id(bucket.key))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                Text("\(bucket.runs) seen · \(bucket.wins) wins")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textSecondary)
            }
            Spacer()
            Text(Prettify.percent(bucket.winrate))
                .font(.system(size: 13, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(bucket.winrate >= 0.5 ? Theme.win : Theme.gold)
        }
    }
}

struct TopCardsCompact: View {
    let report: StatsReport

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Most-picked cards", systemImage: "rectangle.stack.fill")
            VStack(spacing: 6) {
                ForEach(report.topPickedCards.prefix(8), id: \.key) { b in
                    CardPickRow(bucket: b)
                }
                if report.topPickedCards.isEmpty {
                    Text("No card pick data yet.")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
            }
            .premiumPanel(padding: 14, cornerRadius: 12)
        }
    }
}

struct CardPickRow: View {
    let bucket: StatsReport.Bucket
    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "rectangle.fill")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.accent)
                .frame(width: 24, height: 24)
                .background(Circle().fill(Theme.accentSoft))
            Text(Prettify.id(bucket.key))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.text)
                .lineLimit(1)
            Spacer()
            Text("\(bucket.runs)x")
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
            Text(Prettify.percent(bucket.winrate))
                .font(.system(size: 13, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(bucket.winrate >= 0.5 ? Theme.win : Theme.accent)
                .frame(width: 56, alignment: .trailing)
        }
    }
}

// MARK: - Per-section dedicated views

struct CharactersView: View {
    let report: StatsReport
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionTitle("Winrate by character", systemImage: "person.3.fill")
            CharacterTileGrid(report: report).overlay(Color.clear)
        }
    }
}

struct AscensionsView: View {
    let report: StatsReport
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            AscensionChart(report: report)

            VStack(alignment: .leading, spacing: 10) {
                SectionTitle("Detailed breakdown", systemImage: "list.number")
                VStack(spacing: 0) {
                    ForEach(report.byAscension.sorted { ascNum($0.key) < ascNum($1.key) }, id: \.key) { b in
                        AscensionDetailRow(bucket: b)
                        if b.key != report.byAscension.last?.key {
                            Divider().background(Theme.cardBorder.opacity(0.5))
                        }
                    }
                }
                .premiumPanel(padding: 0, cornerRadius: 12)
            }
        }
    }

    private func ascNum(_ key: String) -> Int { Int(key.dropFirst()) ?? 0 }
}

private struct AscensionDetailRow: View {
    let bucket: StatsReport.Bucket
    var body: some View {
        HStack(spacing: 14) {
            Text(bucket.key)
                .font(.system(size: 13, weight: .heavy, design: .rounded))
                .foregroundStyle(Theme.gold)
                .frame(width: 36, alignment: .leading)
            ProgressBar(value: bucket.winrate, tint: bucket.winrate >= 0.10 ? Theme.win : Theme.accent)
                .frame(maxWidth: .infinity)
            Text(Prettify.percent(bucket.winrate))
                .font(.system(size: 12, weight: .heavy, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(Theme.text)
                .frame(width: 60, alignment: .trailing)
            Text("\(bucket.wins)w / \(bucket.runs)r")
                .font(.system(size: 11, weight: .medium).monospacedDigit())
                .foregroundStyle(Theme.textSecondary)
                .frame(width: 90, alignment: .trailing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

struct RelicsView: View {
    let report: StatsReport
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            SectionTitle("Top relics by winrate", systemImage: "sparkles", accent: Theme.gold)
            Text("Sorted by winrate, with a minimum-sample filter applied to suppress one-run flukes.")
                .font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 12)], spacing: 12) {
                ForEach(report.byRelic, id: \.key) { b in
                    RelicCard(bucket: b)
                }
            }
        }
    }
}

private struct RelicCard: View {
    let bucket: StatsReport.Bucket
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "sparkles")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Theme.gold)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Theme.goldSoft))
            VStack(alignment: .leading, spacing: 4) {
                Text(Prettify.id(bucket.key))
                    .font(.system(size: 14, weight: .heavy, design: .rounded))
                    .foregroundStyle(Theme.text)
                HStack(spacing: 8) {
                    Pill(text: "\(bucket.runs) seen", tint: Theme.textSecondary, bold: false)
                    Pill(text: "\(bucket.wins)w", tint: Theme.win)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 0) {
                Text(Prettify.percent(bucket.winrate))
                    .font(.system(size: 22, weight: .heavy, design: .rounded))
                    .foregroundStyle(bucket.winrate >= 0.5 ? Theme.win : Theme.gold)
                    .monospacedDigit()
                Text("WINRATE")
                    .font(.system(size: 8, weight: .heavy, design: .rounded))
                    .tracking(1.5).foregroundStyle(Theme.textTertiary)
            }
        }
        .premiumPanel(padding: 14, cornerRadius: 12)
    }
}

struct CardsView: View {
    let report: StatsReport
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 12) {
                SectionTitle("Most-picked cards", systemImage: "rectangle.stack.fill")
                VStack(spacing: 4) {
                    ForEach(report.topPickedCards, id: \.key) { CardPickRow(bucket: $0) }
                }
                .premiumPanel(padding: 14, cornerRadius: 12)
            }

            if !report.topSkippedCards.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    SectionTitle("Most-skipped cards", systemImage: "rectangle.stack.badge.minus", accent: Theme.loss)
                    Text("Offered often, picked rarely.")
                        .font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
                    VStack(spacing: 4) {
                        ForEach(report.topSkippedCards, id: \.key) { b in
                            HStack(spacing: 10) {
                                Image(systemName: "xmark.rectangle.fill")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(Theme.loss)
                                    .frame(width: 24, height: 24)
                                    .background(Circle().fill(Theme.loss.opacity(0.18)))
                                Text(Prettify.id(b.key))
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Theme.text)
                                Spacer()
                                Text("\(b.runs) offered")
                                    .font(.system(size: 11).monospacedDigit())
                                    .foregroundStyle(Theme.textSecondary)
                                Text("\(b.wins) picked")
                                    .font(.system(size: 11).monospacedDigit())
                                    .foregroundStyle(Theme.textSecondary)
                                    .frame(width: 80, alignment: .trailing)
                                Text(Prettify.percent(b.pickedRate ?? 0))
                                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.loss)
                                    .frame(width: 60, alignment: .trailing)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                    .premiumPanel(padding: 14, cornerRadius: 12)
                }
            }
        }
    }
}

// MARK: - Recent runs

struct RecentRunsView: View {
    let runs: [RunRecord]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle("Recent runs", systemImage: "clock.fill")
            if runs.isEmpty {
                Text("No runs match the current filters.")
                    .font(.system(size: 12)).foregroundStyle(Theme.textSecondary)
            } else {
                let sorted = runs.sorted {
                    ($0.endedAt ?? $0.parsedAt) > ($1.endedAt ?? $1.parsedAt)
                }
                LazyVStack(spacing: 8) {
                    ForEach(sorted.prefix(120), id: \.id) { r in
                        RunRow(run: r)
                    }
                }
            }
        }
    }
}

struct RunRow: View {
    let run: RunRecord
    @State private var hover = false
    @State private var showShare = false

    private var color: Color { Theme.characterColor(run.character) }
    private var icon: String { Theme.characterIcon(run.character) }

    var body: some View {
        HStack(spacing: 0) {
            // Character-colored stripe on the left edge
            Rectangle()
                .fill(color)
                .frame(width: 4)

            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(color)
                    .frame(width: 36, height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(color.opacity(0.15))
                    )

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(run.character.map { Prettify.id($0.rawValue) } ?? "Unknown")
                            .font(.system(size: 14, weight: .heavy, design: .rounded))
                            .foregroundStyle(Theme.text)
                        if let asc = run.ascension {
                            Pill(text: "A\(asc)", tint: Theme.gold)
                        }
                        if let f = run.floorReached {
                            Pill(text: "Floor \(f)", tint: Theme.textSecondary, bold: false)
                        }
                    }
                    if let date = run.endedAt ?? run.startedAt {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.system(size: 11)).foregroundStyle(Theme.textSecondary)
                    }
                }

                Spacer()

                if let dur = run.playTimeSeconds {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(formatDuration(dur))
                            .font(.system(size: 13, weight: .heavy, design: .rounded).monospacedDigit())
                            .foregroundStyle(Theme.text)
                        Text("DURATION")
                            .font(.system(size: 8, weight: .heavy, design: .rounded))
                            .tracking(1.5)
                            .foregroundStyle(Theme.textTertiary)
                    }
                }

                outcomeBadge

                Button {
                    showShare = true
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(hover ? Theme.text : Theme.textSecondary)
                        .frame(width: 28, height: 28)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(hover ? Theme.cardBGRaised : Color.clear)
                        )
                }
                .buttonStyle(.plain)
                .help("Share this run")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(hover ? Theme.cardBGRaised : Theme.cardBG)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(hover ? color.opacity(0.5) : Theme.cardBorder, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
        .sheet(isPresented: $showShare) {
            ShareSheet(run: run)
        }
    }

    @ViewBuilder
    private var outcomeBadge: some View {
        let isWin = run.won == true
        Text(isWin ? "VICTORY" : "DEFEAT")
            .font(.system(size: 10, weight: .heavy, design: .rounded))
            .tracking(2)
            .foregroundStyle(isWin ? Theme.winBright : Theme.lossBright)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill((isWin ? Theme.win : Theme.loss).opacity(0.18))
            )
            .overlay(
                Capsule().stroke((isWin ? Theme.win : Theme.loss).opacity(0.5), lineWidth: 1)
            )
    }

    private func formatDuration(_ sec: Int) -> String {
        let m = sec / 60
        let s = sec % 60
        return String(format: "%d:%02d", m, s)
    }
}

// MARK: - Empty state

struct EmptyStateView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "tray")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Theme.textTertiary)
            Text("No runs yet")
                .font(.system(size: 22, weight: .heavy, design: .rounded))
                .foregroundStyle(Theme.text)
            Text("Finish a run in Slay the Spire 2, then click Rescan.")
                .font(.system(size: 13)).foregroundStyle(Theme.textSecondary)
            Button("Rescan now") { Task { await state.scan() } }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .controlSize(.large)
        }
    }
}
