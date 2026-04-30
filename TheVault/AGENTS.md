# AGENTS.md

Guidance for AI coding agents (Claude, Cursor, Codex) working in this repo.

## Project shape

- **Library:** `Sources/VaultCore` — pure Foundation, no deps.
- **Executable:** `Sources/vault` — thin CLI wrapper, also Foundation-only.
- **Tests:** `Tests/VaultCoreTests` — XCTest with fixture files in `Fixtures/`.

## Hard rules

1. **Read-only on STS2 saves.** Never open files for write under the user's
   `Mega Crit/SlayTheSpire2` directory. Vault parses, never mutates.
2. **No network.** No URLSession, no analytics, no auto-update checks.
3. **No external dependencies.** Package.swift has zero `dependencies:`. Keep it
   that way. New libraries require a clear paragraph of justification.
4. **`CSVExporter.columns` ordering is frozen.** Add columns at the end. Any
   reorder breaks downstream consumers (Ascension Companion, user spreadsheets).
5. **Bump `RunRecord.schemaVersion` on breaking format changes.** The store
   refuses to load mismatched schemas — by design. Don't loosen this.

## When asked to add a feature

- Add a focused unit test alongside it.
- Add the public surface to `CHANGELOG.md` under `## [Unreleased]`.
- Run `swift build && swift test` before claiming done.

## When asked to add a save format

- Conform to `RunFormatParser`.
- `canHandle` should match by extension first, content sniff second.
- Register in `SaveFileParser.defaultStrategies()`.
- Add a fixture and a happy-path test.

## Style

- Tabs vs spaces: 4 spaces, Swift default.
- Doc comments on every `public` type and significant function, focused on
  the *why*. Nobody needs "// returns the value".
- ANSI / TTY output goes through `AnsiTheme` so `NO_COLOR` is honored.
- Logging through `Logger` (stderr), never via `print()` from library code.

## Don't

- Don't move files for stylistic reasons.
- Don't introduce SwiftPM plugins.
- Don't add a Swift Package macro.
- Don't take user paths from arbitrary env vars beyond `VAULT_SAVE_DIR`,
  `NO_COLOR`, `FORCE_COLOR`. Anything else is a CLI flag.
