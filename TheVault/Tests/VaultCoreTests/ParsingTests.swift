import XCTest
@testable import VaultCore

final class ParsingTests: XCTestCase {

    func fixtureURL(_ name: String) -> URL {
        Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures")!
    }

    func testJSONHappyPath() throws {
        let url = fixtureURL("sample_run.json")
        let parser = SaveFileParser()
        guard case let .parsed(record) = parser.parse(url: url) else {
            XCTFail("expected parse success")
            return
        }

        XCTAssertEqual(record.id, "test-run-001")
        XCTAssertEqual(record.character, .ironclad)
        XCTAssertEqual(record.ascension, 6)
        XCTAssertEqual(record.won, true)
        XCTAssertEqual(record.floorReached, 17)
        XCTAssertEqual(record.deckAtEnd.count, 7)
        XCTAssertTrue(record.deckAtEnd.contains("inflame_plus"))   // normalized
        XCTAssertEqual(record.relics, ["burning_blood", "pendulum", "regalite"])
        XCTAssertEqual(record.cardPicks.count, 3)
        XCTAssertEqual(record.cardPicks[0].source, .combatReward)
        XCTAssertEqual(record.cardPicks[2].picked, "demon_form")
        XCTAssertEqual(record.relicPicks.first?.source, .neow)
    }

    func testGodotConfigHappyPath() throws {
        let url = fixtureURL("sample_run.cfg")
        let parser = SaveFileParser()
        guard case let .parsed(record) = parser.parse(url: url) else {
            XCTFail("expected parse success")
            return
        }
        XCTAssertEqual(record.id, "test-run-002")
        XCTAssertEqual(record.character, .silent)
        XCTAssertEqual(record.ascension, 3)
        XCTAssertEqual(record.won, false)
        XCTAssertEqual(record.floorReached, 12)
        XCTAssertEqual(record.deckAtEnd.count, 6)
        XCTAssertEqual(record.relics, ["snecko_skull", "pendulum"])
    }

    func testHistoryStoreUpsertIsIdempotent() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vault-test-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let store = HistoryStore(url: tmp)
        let r = RunRecord(id: "abc", sourceFile: "x.json", character: .defect, ascension: 1)

        let firstAdded = try store.upsert([r])
        let secondAdded = try store.upsert([r])

        XCTAssertEqual(firstAdded, 1)
        XCTAssertEqual(secondAdded, 0, "duplicate upsert should add nothing")

        let doc = try store.load()
        XCTAssertEqual(doc.runs.count, 1)
        XCTAssertEqual(doc.runs[0].id, "abc")
        XCTAssertEqual(doc.header.schemaVersion, RunRecord.schemaVersion)
    }

    func testCSVExportColumnsStable() throws {
        let r = RunRecord(
            id: "csv-1",
            sourceFile: "x.json",
            character: .ironclad,
            ascension: 6,
            seed: "S1",
            won: true,
            floorReached: 17,
            playTimeSeconds: 1820,
            deckAtEnd: ["a", "b"],
            relics: ["r1"]
        )
        let csv = CSVExporter.render(runs: [r])
        let lines = csv.split(separator: "\n").map(String.init)
        XCTAssertEqual(lines[0], CSVExporter.columns.joined(separator: ","))
        XCTAssertTrue(lines[1].hasPrefix("csv-1,ironclad,6,true,17,1820"))
    }

    func testParserRejectsGarbageGracefully() throws {
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vault-junk-\(UUID().uuidString).json")
        try Data([0x00, 0xFF, 0xAB]).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let outcome = SaveFileParser().parse(url: tmp)
        switch outcome {
        case .parsed: XCTFail("garbage should not parse")
        case .skipped, .failed: break
        }
    }
}
