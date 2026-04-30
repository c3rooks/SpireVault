# The Vault

A free, open-source run-history exporter and analytics CLI for Slay the Spire 2.

The Vault watches your save folder, parses every completed run it finds, and writes a
clean, versioned `history.json` you can analyse however you want. Then it can render
winrate tables, per-character / per-relic / per-archetype breakdowns, and CSV/JSON
exports. It never modifies the game — read-only, no in-game mod required, no DLLs,
no patching.

It's the data pipeline behind the **Stats** tab in [Ascension Companion](https://apps.apple.com/app/ascension-companion/),
but the Vault itself is unaffiliated, free, and useful on its own.

> Not affiliated with or endorsed by Mega Crit Games.

[![CI](https://github.com/your-handle/the-vault/actions/workflows/ci.yml/badge.svg)](https://github.com/your-handle/the-vault/actions/workflows/ci.yml)
![swift](https://img.shields.io/badge/swift-5.9%2B-orange)
![platform](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey)
![license](https://img.shields.io/badge/license-MIT-blue)

## Install

Requires macOS 13+ and Swift 5.9+ (ships with Xcode 15).

One-liner:

```bash
git clone https://github.com/<your-handle>/the-vault.git
cd the-vault
./install.sh
```

Or manually:

```bash
swift build -c release
cp .build/release/vault /usr/local/bin/
```

Or via Make:

```bash
make install            # PREFIX=/usr/local by default
PREFIX=$HOME/.local make install
```

## Quick tour

```bash
vault doctor            # diagnose setup, save folder, parsing, history
vault scan              # parse every save once, append to history.json
vault watch             # same as scan, then keep running
vault stats             # render winrate tables (see below)
vault export            # CSV to stdout
vault export --csv runs.csv --character ironclad --won --since 30d
vault parse <file>      # inspect a single save file
vault config show
vault reset             # delete history.json (asks first)
```

### Example: `vault stats`

```text
VAULT STATS
Generated 2026-04-28T23:12:44Z

4 runs · 1 wins · 25.0% winrate

Per character
Character  Runs  Wins  Winrate
─────────  ────  ────  ───────
silent        2     0     0.0%
ironclad      1     1   100.0%
defect        1     0     0.0%

Per ascension
Asc  Runs  Wins  Winrate
───  ────  ────  ───────
A6      2     1    50.0%
A3      1     0     0.0%

Top relics by winrate (min sample applied)
Relic          Seen  Wins  Winrate  Appearance
─────────────  ────  ────  ───────  ──────────
burning_blood     1     1   100.0%       25.0%
pendulum          3     1    33.3%       75.0%
snecko_skull      2     0     0.0%       50.0%

Most-skipped cards (offered often, picked rarely)
Card           Offered  Picked  Pick rate
─────────────  ───────  ──────  ─────────
heavy_blade          2       0       0.0%
pommel_strike        2       0       0.0%
```

In a real terminal you also get ANSI colors. Vault honors
[`NO_COLOR`](https://no-color.org) and `FORCE_COLOR`, and detects whether stdout
is a TTY automatically — pipe to `less` or a file and the escape codes drop out.

### Example: `vault doctor`

```text
VAULT DOCTOR  v0.1.0

✓ OK    Detected save folder
        /Users/you/Library/Application Support/Steam/userdata/172072648/2868840/remote
✓ OK    Save folder contains 14 candidate file(s)
        run_2026_04_27_223301.json
        run_2026_04_27_220112.json
        …and 12 more
✓ OK    Sample parse succeeded
        run_2026_04_27_223301.json → ironclad A6 WIN f55
✓ OK    history.json is current schema (v1)
        18 run(s) stored at /Users/you/Library/Application Support/AscensionCompanion/vault/history.json
```

`vault doctor` exits non-zero if it found anything that looks broken, so it
plugs nicely into CI or `set -e` shell scripts.

## Filters

`vault stats` and `vault export` both accept the same filter flags:

| Flag | Example | Effect |
|------|---------|--------|
| `--character` | `--character ironclad` | Restrict to one character |
| `--ascension` | `--ascension 6` | Exact ascension level |
| `--min-ascension` / `--max-ascension` | `--min-ascension 5 --max-ascension 9` | Range |
| `--won` / `--lost` | `--won` | Only winning / losing runs |
| `--since` | `--since 7d` (or ISO8601) | Recent window |
| `--until` | `--until 2026-04-28T00:00:00Z` | Cap |

Plus stats-only flags:

| Flag | Default | Effect |
|------|---------|--------|
| `--top` | 15 | Cap rows per table |
| `--min-sample` | 3 | Hide buckets below N runs (kills 100%-winrate-on-1-run noise) |
| `--json` | off | Emit `StatsReport` as JSON instead of tables |

## What it captures

| Field | Notes |
|-------|-------|
| `character`, `ascension`, `seed` | Normalized to canonical ids |
| `won`, `floorReached`, `playTimeSeconds` | Pulled from common Godot save layouts |
| `deckAtEnd`, `relics`, `potions` | Card / relic / potion ids, lowercased and snake_cased |
| `cardPicks` | Per-floor offered + picked + source (combat/elite/boss/shop/event/neow) |
| `relicPicks` | Per-floor pickup + source |
| `maxHP`, `currentHP`, `gold` | End-of-run snapshot |
| `raw` | Full original object kept verbatim — nothing is lost |

The schema is versioned (`schemaVersion: 1`). If a future release changes the
shape, `HistoryStore` refuses to merge incompatible files with a clear error
rather than silently corrupting them.

## What it does NOT do

- It does **not** modify your STS2 saves. Read-only, full stop.
- It does **not** run inside the game.
- It does **not** phone home, upload, or share data. Everything stays on your disk.
- It does **not** rely on internal Godot APIs that break every patch — when STS2's
  save format shifts, Vault adds a parser and ships a new release. No game patch
  required.

## Configuration

`~/.config/vault/config.json` (created by `vault config set`) supports:

```json
{
  "saveDir":      "/path/to/some/save/folder",
  "historyPath":  "~/Desktop/spire-runs.json",
  "color":        "auto"
}
```

Equivalent CLI flags: `--save-dir`, `--out`, `--color` / `--no-color`.

Environment variables:

| Var | Effect |
|-----|--------|
| `VAULT_SAVE_DIR` | Override save folder discovery |
| `NO_COLOR` | Force plain (no ANSI) output |
| `FORCE_COLOR` | Force color even when piped |

## How it works (one paragraph)

`SaveFolderLocator` resolves the candidate save directories on your platform.
`SaveFolderWatcher` debounces filesystem events from `DispatchSource`. Each file is
fed through `SaveFileParser`, which delegates to `JSONRunParser` or `GodotConfigParser`
based on a quick content sniff (and skips files >10MB so a stray crashdump can't take
us down). Each strategy maps the source format onto the canonical `RunRecord` model,
normalizes ids (`Demon Form` → `demon_form`, `Inflame+` → `inflame_plus`), and the
result lands in `HistoryStore`, which dedupes by `id` and writes atomically.
`StatsEngine` is then a pure function from `[RunRecord]` to a `StatsReport`.

## Roadmap

- v0.2 — per-fight HP delta tracking (when STS2 exposes per-fight logs)
- v0.3 — direct iCloud sync into Ascension Companion
- v0.4 — Windows + Linux install scripts (the parser is already cross-platform)

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for
the rules of the road. Please run `swift test` before opening a PR.

## License

MIT. See [LICENSE](LICENSE).

Slay the Spire 2 is a trademark of Mega Crit Games. The Vault is unaffiliated
fan tooling and reads only data the game already wrote to your disk.
