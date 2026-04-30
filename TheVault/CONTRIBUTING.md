# Contributing to The Vault

Thanks for taking the time. The bar is "ship something useful for STS2 players,
keep it boringly reliable, never write to the user's save folder."

## Quick start

```bash
git clone https://github.com/<your-handle>/the-vault.git
cd the-vault
swift build
swift test
```

## What we want

- Bug reports with a sample save file (or anonymized snippet) attached.
- New parsers for save layouts that don't fit JSON or Godot ConfigFile —
  conform to `RunFormatParser`, register in `SaveFileParser.defaultStrategies()`,
  add a fixture under `Tests/VaultCoreTests/Fixtures/` plus a happy-path test.
- Stats ideas with a one-line "this is the question I'd answer with this number".
- Cross-platform fixes — Vault should compile on Linux and Windows; macOS is
  the only thing we test against today.

## What we don't want

- Anything that mutates the STS2 save folder. Read-only is a hard rule.
- Network calls. Vault never phones home.
- Closed-source dependencies.
- Re-orderings of `CSVExporter.columns`. Add columns at the end so existing
  spreadsheets keep working.

## Adding a new parser (5-minute version)

1. Create `Sources/VaultCore/Parsing/MyFormatParser.swift` implementing
   `RunFormatParser`. Its `canHandle(url:head:)` should be cheap and specific —
   prefer extension match plus a content sniff.
2. Map the source format onto `RunRecord` via the helpers in `JSONRunParser`
   (or copy them — they're intentionally simple).
3. Register the parser:
   ```swift
   public static func defaultStrategies() -> [RunFormatParser] {
       [JSONRunParser(), GodotConfigParser(), MyFormatParser()]
   }
   ```
4. Drop a representative file in `Tests/VaultCoreTests/Fixtures/`.
5. Add a happy-path test that asserts the canonical fields you mapped.

## Schema discipline

If you change `RunRecord` in a way that breaks reads, bump `RunRecord.schemaVersion`.
The store will refuse to load mismatched files — this is intentional. Bumping
should be rare; carrying through with `raw` is preferred to schema churn.

## Style

- No external dependencies. Foundation only.
- Doc comments above every public type, ideally explaining *why* the type exists.
- Tests live next to the thing they test.
- ANSI/UI escape sequences only via `AnsiTheme` so `NO_COLOR` keeps working.

## Code of Conduct

Be patient, be kind, no shittiness in issues or PRs. If someone's confused,
they're not stupid — the docs are stupid. Fix the docs.
