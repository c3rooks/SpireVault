import XCTest
@testable import VaultCore

final class StatsTests: XCTestCase {

    private func run(
        id: String,
        character: Character,
        ascension: Int,
        won: Bool,
        relics: [String] = [],
        picks: [(offered: [String], picked: String?)] = []
    ) -> RunRecord {
        RunRecord(
            id: id,
            sourceFile: "\(id).json",
            character: character,
            ascension: ascension,
            won: won,
            relics: relics,
            cardPicks: picks.map { CardPick(offered: $0.offered, picked: $0.picked) }
        )
    }

    func testCharacterAndAscensionWinrates() {
        let runs: [RunRecord] = [
            run(id: "1", character: .ironclad, ascension: 6, won: true),
            run(id: "2", character: .ironclad, ascension: 6, won: false),
            run(id: "3", character: .ironclad, ascension: 6, won: true),
            run(id: "4", character: .silent,   ascension: 0, won: false)
        ]
        let s = StatsEngine.summarize(runs: runs)
        XCTAssertEqual(s.totalRuns, 4)
        XCTAssertEqual(s.totalWins, 2)
        let ic = s.byCharacter.first(where: { $0.key == "ironclad" })!
        XCTAssertEqual(ic.runs, 3)
        XCTAssertEqual(ic.wins, 2)
        XCTAssertEqual(ic.winrate, 2.0/3.0, accuracy: 0.0001)
    }

    func testRelicWinrateRespectsMinSample() {
        let runs: [RunRecord] = [
            run(id: "1", character: .ironclad, ascension: 5, won: true,  relics: ["pendulum"]),
            run(id: "2", character: .ironclad, ascension: 5, won: true,  relics: ["pendulum"]),
            run(id: "3", character: .ironclad, ascension: 5, won: false, relics: ["pendulum"]),
            run(id: "4", character: .ironclad, ascension: 5, won: true,  relics: ["regalite"])  // only 1 sample
        ]
        let s = StatsEngine.summarize(runs: runs, relicMinSample: 3)
        XCTAssertNotNil(s.byRelic.first(where: { $0.key == "pendulum" }))
        XCTAssertNil(s.byRelic.first(where: { $0.key == "regalite" }), "should be filtered by min sample")
    }

    func testTopPickedCardsCountsAndWins() {
        let runs: [RunRecord] = [
            run(id: "1", character: .ironclad, ascension: 5, won: true,
                picks: [(["inflame", "anger"], "inflame"),
                        (["inflame", "shrug"], "inflame")]),
            run(id: "2", character: .ironclad, ascension: 5, won: false,
                picks: [(["inflame", "anger"], "inflame")])
        ]
        let s = StatsEngine.summarize(runs: runs, cardMinSample: 1)
        let inflame = s.topPickedCards.first(where: { $0.key == "inflame" })!
        XCTAssertEqual(inflame.runs, 3)        // picked 3 times total
        XCTAssertEqual(inflame.wins, 2)        // 2 of those picks were in winning runs
    }

    func testFilterByCharacter() {
        let runs: [RunRecord] = [
            run(id: "1", character: .ironclad, ascension: 5, won: true),
            run(id: "2", character: .silent,   ascension: 5, won: false)
        ]
        let only = RunFilter(character: .ironclad).apply(runs)
        XCTAssertEqual(only.count, 1)
        XCTAssertEqual(only[0].character, .ironclad)
    }

    func testFilterByAscensionRangeAndOutcome() {
        let runs: [RunRecord] = [
            run(id: "1", character: .ironclad, ascension: 0, won: true),
            run(id: "2", character: .ironclad, ascension: 5, won: true),
            run(id: "3", character: .ironclad, ascension: 9, won: false)
        ]
        let mid = RunFilter(minAscension: 5, maxAscension: 8, won: true).apply(runs)
        XCTAssertEqual(mid.map(\.id), ["2"])
    }

    func testFilterByRelativeSince() {
        let now = Date()
        let yesterday = now.addingTimeInterval(-86400)
        let lastWeek  = now.addingTimeInterval(-7 * 86400 - 60)
        let r1 = RunRecord(id: "fresh", sourceFile: "x", endedAt: yesterday)
        let r2 = RunRecord(id: "old",   sourceFile: "x", endedAt: lastWeek)

        let cutoff = RunFilter.parseRelativeSince("2d", now: now)!
        let kept = RunFilter(since: cutoff).apply([r1, r2])
        XCTAssertEqual(kept.map(\.id), ["fresh"])
    }

    func testCharacterNormalization() {
        XCTAssertEqual(Character.from("IronClad"), .ironclad)
        XCTAssertEqual(Character.from(" Silent "), .silent)
        XCTAssertEqual(Character.from("RG"), .regent)
        XCTAssertEqual(Character.from("Necrobinder"), .necrobinder)
        XCTAssertEqual(Character.from("DEFECT"), .defect)
        XCTAssertEqual(Character.from("Watcher"), .unknown)
        XCTAssertNil(Character.from(nil))
    }

    func testSchemaMismatchIsRejected() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vault-schema-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }

        // Forge a v999 file
        let bogus = """
        {
          "header": { "schemaVersion": 999, "generatedAt": "2026-04-28T00:00:00Z", "vault": "TheVault/0.0.0" },
          "runs": []
        }
        """
        try bogus.write(to: tmp, atomically: true, encoding: .utf8)

        let store = HistoryStore(url: tmp)
        XCTAssertThrowsError(try store.load()) { err in
            XCTAssertTrue(err is HistoryStoreError, "expected HistoryStoreError, got \(err)")
        }
    }

    func testCSVEscapesEmbeddedCommas() {
        let r = RunRecord(id: "weird,id", sourceFile: "x", seed: "a\"b")
        let csv = CSVExporter.render(runs: [r])
        XCTAssertTrue(csv.contains("\"weird,id\""))
        XCTAssertTrue(csv.contains("\"a\"\"b\""))
    }

    func testRealSTS2RunFileParses() throws {
        let url = Bundle.module.url(forResource: "sts2_run.run", withExtension: nil, subdirectory: "Fixtures")!
        guard case let .parsed(r) = SaveFileParser().parse(url: url) else {
            XCTFail("expected parse")
            return
        }
        XCTAssertEqual(r.character, .ironclad)
        XCTAssertEqual(r.ascension, 8)
        XCTAssertEqual(r.won, true)
        XCTAssertEqual(r.seed, "TESTSEED12")
        XCTAssertEqual(r.playTimeSeconds, 1200)
        XCTAssertEqual(r.floorReached, 2)
        XCTAssertEqual(r.relics, ["burning_blood", "pendulum"])
        XCTAssertTrue(r.deckAtEnd.contains("strike_red"))
        XCTAssertTrue(r.deckAtEnd.contains("demon_form+1"))
        XCTAssertEqual(r.cardPicks.count, 2)
        XCTAssertEqual(r.cardPicks[0].picked, "inflame")
        XCTAssertEqual(r.cardPicks[1].source, .eliteReward)
        XCTAssertEqual(r.relicPicks.first?.relicID, "pendulum")
        XCTAssertEqual(r.maxHP, 75)
        XCTAssertEqual(r.gold, 130)
        XCTAssertEqual(r.id, "sts2-1777000000")
    }

    func testProgressSaveIsSkipped() throws {
        // Account-level files (no `players`/`map_point_history`) must NOT be
        // treated as runs — they should fall through every strategy.
        let json = """
        { "version": 9, "unlocks": ["IRONCLAD"], "options": { "music": 0.5 } }
        """
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("progress-\(UUID().uuidString).save")
        try json.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let outcome = SaveFileParser().parse(url: url)
        if case .parsed(let r) = outcome, r.character == nil, r.ascension == nil, r.won == nil {
            XCTFail("non-run file produced an empty 'parsed' record (\(r.id)) — it should be skipped or failed instead")
        }
    }

    func testNullJSONFieldsAreNotStringified() throws {
        // Regression: `picked: null` was leaking through as the literal string "<null>".
        let json = """
        {
          "run_id": "null-test",
          "character": "Ironclad",
          "ascension": null,
          "card_choices": [
            { "floor": 1, "offered": ["a", "b"], "picked": null }
          ]
        }
        """
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("null-\(UUID().uuidString).json")
        try json.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        guard case let .parsed(record) = SaveFileParser().parse(url: url) else {
            XCTFail("expected parse")
            return
        }
        XCTAssertNil(record.ascension)
        XCTAssertEqual(record.cardPicks.count, 1)
        XCTAssertNil(record.cardPicks[0].picked)
    }

    func testMostSkippedExcludesAlwaysPickedCards() {
        let runs: [RunRecord] = [
            run(id: "1", character: .ironclad, ascension: 5, won: true,
                picks: [(["always_picked", "always_skipped"], "always_picked")]),
            run(id: "2", character: .ironclad, ascension: 5, won: true,
                picks: [(["always_picked", "always_skipped"], "always_picked")]),
            run(id: "3", character: .ironclad, ascension: 5, won: false,
                picks: [(["always_picked", "always_skipped"], "always_picked")])
        ]
        let s = StatsEngine.summarize(runs: runs, cardMinSample: 1)
        XCTAssertNotNil(s.topSkippedCards.first(where: { $0.key == "always_skipped" }))
        XCTAssertNil(s.topSkippedCards.first(where: { $0.key == "always_picked" }),
                     "100%-picked cards should not appear in the skipped list")
    }

    func testDoctorReportsMissingHistoryAsInfo() {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vault-doctor-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let history = dir.appendingPathComponent("history.json")
        let report = Doctor.diagnose(
            explicitSaveDir: dir,
            historyURL: history,
            env: ["VAULT_SAVE_DIR": dir.path]
        )
        XCTAssertTrue(report.findings.contains { $0.title.contains("No history.json yet") })
    }
}
