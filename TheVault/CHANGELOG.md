# Changelog

All notable changes to The Vault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Vault macOS app + Co-op
- **Native macOS app** (`VaultApp/`) — full GUI alternative to the CLI with
  premium dark-themed interface, character-colored stat tiles, ascension chart,
  top-relics/cards panels, and a recent-runs feed with shareable run cards
  (PNG + Markdown export).
- **Co-op matchmaking** — skill-matched lobby browser, host form with
  character / ascension / region / mode filters, tier-based "great match /
  stretch / mismatch" badges keyed to your Vault stats.
- **Steam OpenID sign-in** via the Cloudflare Worker bridge, plus a manual
  SteamID64 fallback for offline / advanced use.
- **Friend presence tracker** — once you're Steam friends with someone, The
  Vault polls Steam Web API (proxied through the Worker so the key never hits
  the client) and fires a native macOS notification the moment they hop into
  Slay the Spire 2 multiplayer.
- **Custom URL scheme** `thevault://auth?…` for the OpenID callback.
- **Cloudflare Worker backend** (`Backend/`) — TypeScript Worker with KV
  storage, 30-minute auto-expiring lobbies, Steam OpenID 2.0 verification,
  and a presence proxy. One-command deploy via `wrangler deploy`.
- **Offline mode** — no Worker URL: empty public lobby list (no fabricated
  rows). You can still host a lobby in-process for same-machine testing.
- **App icon and emblem** — vault-door artwork; `vault-logo-master.png` in
  `VaultApp/Resources/` is the source of truth for regenerating PNGs.

### Fixed
- **Asset catalog was not in the Xcode target** — `Assets.xcassets` is now a
  listed source path so `AppIcon` and `VaultEmblem` actually ship inside the
  `.app` bundle (fixes blank sidebar / Dock icons).
- **Co-op lobby list accuracy** — removed hardcoded "seed" lobbies; counts and
  rows now reflect only your Worker (remote) or your own hosted lobby
  (offline), never placeholder personas.

## [0.1.0] - 2026-04-28

Initial release.

### Added
- `vault discover` — list candidate STS2 save folders.
- `vault doctor` — full setup and health diagnosis with severity-tagged findings.
- `vault scan` — one-shot parse of every save file, idempotent upsert into history.
- `vault watch` — stay running and react to new save files via `DispatchSource`.
- `vault stats` — per-character / per-ascension / per-relic / per-archetype winrate
  tables, top-picked and most-skipped card analytics, with min-sample filtering
  and configurable top-N. ANSI-colored when stdout is a TTY.
- `vault export` — CSV (default) or JSON output. Filters: `--character`,
  `--ascension` (or `--min-ascension`/`--max-ascension`), `--won`/`--lost`,
  `--since 7d`, `--until <iso8601>`.
- `vault parse <file>` — single-file inspect, useful for adding new save layouts.
- `vault reset` — interactive deletion of `history.json` (`--yes` to skip prompt).
- `vault config` — read/write `~/.config/vault/config.json` (saveDir, historyPath, color).
- Pluggable parser strategies: `JSONRunParser` and `GodotConfigParser`. New
  formats can be added by conforming to `RunFormatParser` and registering with
  `SaveFileParser.defaultStrategies()`.
- Versioned schema (`schemaVersion: 1`). Loading an incompatible history file
  throws `HistoryStoreError.schemaMismatch` rather than silently merging.
- File-size limit (default 10MB) on save folder enumeration to avoid
  pathological inputs.
- Honors `NO_COLOR` and `FORCE_COLOR` environment conventions.
- `VAULT_SAVE_DIR` environment variable as save folder override.

### Changed
- N/A.

### Fixed
- N/A.

### Security
- Vault is read-only. It never writes to the STS2 save folder.
