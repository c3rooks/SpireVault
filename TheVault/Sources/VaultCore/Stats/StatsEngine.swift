import Foundation

/// Aggregations over a collection of `RunRecord`s.
///
/// Pure value-type, no I/O. Feed it `runs`, get back tables. Each summary keeps
/// `runs` (total observed), `wins`, and a derived `winrate` so callers can render
/// any view they want without re-walking the history.
public struct StatsReport: Codable {

    public struct Bucket: Codable, Hashable {
        public let key: String
        public let runs: Int
        public let wins: Int
        public var winrate: Double { runs == 0 ? 0 : Double(wins) / Double(runs) }
        public var pickedRate: Double?     // for relics: how often did this relic appear, given a baseline
    }

    public var totalRuns: Int
    public var totalWins: Int
    public var byCharacter: [Bucket]
    public var byAscension: [Bucket]
    public var byRelic: [Bucket]
    public var byArchetypeTag: [Bucket]    // optional, only filled when caller supplies tagger
    public var topPickedCards: [Bucket]
    public var topSkippedCards: [Bucket]
    public var generatedAt: Date

    public var overallWinrate: Double {
        totalRuns == 0 ? 0 : Double(totalWins) / Double(totalRuns)
    }
}

public enum StatsEngine {

    /// Build a stats report. `relicMinSample` and `cardMinSample` filter out long-tail
    /// noise so a relic seen in 1 run doesn't show as "100% winrate".
    public static func summarize(
        runs: [RunRecord],
        relicMinSample: Int = 3,
        cardMinSample: Int = 3,
        topN: Int = 15,
        archetypeTagger: ((RunRecord) -> [String])? = nil
    ) -> StatsReport {

        let total = runs.count
        let wins = runs.filter { $0.won == true }.count

        let byCharacter = bucket(
            runs: runs,
            key: { $0.character?.rawValue },
            won: { $0.won == true }
        )

        let byAscension = bucket(
            runs: runs,
            key: { $0.ascension.map { "A\($0)" } },
            won: { $0.won == true }
        )

        let byRelic = relicBuckets(
            runs: runs,
            minSample: relicMinSample,
            topN: topN
        )

        let byArchetype: [StatsReport.Bucket]
        if let tagger = archetypeTagger {
            byArchetype = archetypeBuckets(runs: runs, tagger: tagger, topN: topN)
        } else {
            byArchetype = []
        }

        let (picked, skipped) = cardPickStats(
            runs: runs,
            minSample: cardMinSample,
            topN: topN
        )

        return StatsReport(
            totalRuns: total,
            totalWins: wins,
            byCharacter: byCharacter,
            byAscension: byAscension,
            byRelic: byRelic,
            byArchetypeTag: byArchetype,
            topPickedCards: picked,
            topSkippedCards: skipped,
            generatedAt: Date()
        )
    }

    // MARK: - Internals

    private static func bucket(
        runs: [RunRecord],
        key: (RunRecord) -> String?,
        won: (RunRecord) -> Bool
    ) -> [StatsReport.Bucket] {
        var counts: [String: (runs: Int, wins: Int)] = [:]
        for r in runs {
            guard let k = key(r) else { continue }
            var c = counts[k] ?? (0, 0)
            c.runs += 1
            if won(r) { c.wins += 1 }
            counts[k] = c
        }
        return counts
            .map { StatsReport.Bucket(key: $0.key, runs: $0.value.runs, wins: $0.value.wins, pickedRate: nil) }
            .sorted { ($0.runs, $0.wins) > ($1.runs, $1.wins) }
    }

    private static func relicBuckets(
        runs: [RunRecord],
        minSample: Int,
        topN: Int
    ) -> [StatsReport.Bucket] {
        // For each relic we count: how many runs it appeared in, of which how many won.
        // We also keep an "appeared in" rate so the UI can sort by exposure as well as winrate.
        var seen: [String: (runs: Int, wins: Int)] = [:]
        for r in runs {
            let unique = Set(r.relics)
            for relic in unique {
                var s = seen[relic] ?? (0, 0)
                s.runs += 1
                if r.won == true { s.wins += 1 }
                seen[relic] = s
            }
        }
        let total = max(runs.count, 1)
        return seen
            .filter { $0.value.runs >= minSample }
            .map { entry in
                StatsReport.Bucket(
                    key: entry.key,
                    runs: entry.value.runs,
                    wins: entry.value.wins,
                    pickedRate: Double(entry.value.runs) / Double(total)
                )
            }
            .sorted { lhs, rhs in
                if lhs.winrate != rhs.winrate { return lhs.winrate > rhs.winrate }
                return lhs.runs > rhs.runs
            }
            .prefix(topN)
            .map { $0 }
    }

    private static func archetypeBuckets(
        runs: [RunRecord],
        tagger: (RunRecord) -> [String],
        topN: Int
    ) -> [StatsReport.Bucket] {
        var seen: [String: (runs: Int, wins: Int)] = [:]
        for r in runs {
            for tag in Set(tagger(r)) {
                var s = seen[tag] ?? (0, 0)
                s.runs += 1
                if r.won == true { s.wins += 1 }
                seen[tag] = s
            }
        }
        return seen
            .map { StatsReport.Bucket(key: $0.key, runs: $0.value.runs, wins: $0.value.wins, pickedRate: nil) }
            .sorted { $0.runs > $1.runs }
            .prefix(topN)
            .map { $0 }
    }

    private static func cardPickStats(
        runs: [RunRecord],
        minSample: Int,
        topN: Int
    ) -> (picked: [StatsReport.Bucket], skipped: [StatsReport.Bucket]) {
        // For each card we count: how many times it was OFFERED across all picks,
        // and how many times it was actually PICKED. "skip rate" = offered - picked.
        var offered: [String: Int] = [:]
        var picked: [String: Int] = [:]
        var pickedWins: [String: Int] = [:]
        for r in runs {
            let won = r.won == true
            for choice in r.cardPicks {
                for option in Set(choice.offered) {
                    offered[option, default: 0] += 1
                }
                if let pickedCard = choice.picked {
                    picked[pickedCard, default: 0] += 1
                    if won { pickedWins[pickedCard, default: 0] += 1 }
                }
            }
        }

        // Most-picked: weight by pick count, derive winrate from runs that actually picked.
        let mostPicked: [StatsReport.Bucket] = picked
            .filter { $0.value >= minSample }
            .map {
                StatsReport.Bucket(
                    key: $0.key,
                    runs: $0.value,
                    wins: pickedWins[$0.key] ?? 0,
                    pickedRate: Double($0.value) / Double(max(offered[$0.key] ?? 1, 1))
                )
            }
            .sorted { ($0.runs, $0.winrate) > ($1.runs, $1.winrate) }
            .prefix(topN)
            .map { $0 }

        // Most-skipped: cards offered enough to be statistically meaningful
        // AND skipped at least half the time. A card picked 100% of the time
        // it was offered isn't skipped — it just never refused — so we exclude
        // those from this view to keep the table focused.
        let mostSkipped: [StatsReport.Bucket] = offered
            .filter { $0.value >= minSample }
            .compactMap { entry -> StatsReport.Bucket? in
                let p = picked[entry.key] ?? 0
                let rate = Double(p) / Double(entry.value)
                guard rate < 0.5 else { return nil }
                return StatsReport.Bucket(
                    key: entry.key,
                    runs: entry.value,            // offered count
                    wins: p,                       // picked count (re-using `wins` slot)
                    pickedRate: rate
                )
            }
            .sorted { lhs, rhs in
                if (lhs.pickedRate ?? 0) != (rhs.pickedRate ?? 0) {
                    return (lhs.pickedRate ?? 0) < (rhs.pickedRate ?? 0)
                }
                return lhs.runs > rhs.runs   // tie-breaker: more often offered first
            }
            .prefix(topN)
            .map { $0 }

        return (mostPicked, mostSkipped)
    }
}
