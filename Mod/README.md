# SpireVault Companion Mod

The first Slay the Spire 2 mod that streams live run state to a cloud
backend. The web app at <https://spirevault.app> consumes the stream
and renders:

- live spectator URLs (`/watch?runId=<runId>`)
- OBS Browser Source overlays (`/watch?runId=<runId>&overlay=1`)
- a teammate-visible damage meter / deck inspector
- the AI Coach's team-aware analysis (`/coach`)
- post-run share cards + auto-clipped highlights
- the Daily Race ghost leaderboard

This mod is what makes all of those features work; without it, the web
side falls back to whatever the player uploads after the fact (the
existing `.run` parsing path).

## Build status

| Stage | Status | Scope |
|-------|--------|-------|
| **v0.1** | scaffolded (this branch) | Steam Rich Presence sync + damage meter |
| v0.2 | scoped | teammate decks + live party hub mirror |
| v0.3 | scoped | auto-share post-run + Discord LFG auto-post |

The scaffold is hand-off ready. The C# files compile against the STS2
game DLLs once they're added as references (see `BUILD.md`). The wire
format is locked: the mod's `IngestPayload.cs` mirrors
`Backend/src/coop-mod-stream.ts`'s `RunLiveSnapshot` exactly.

## Prerequisites

- .NET 9.0 SDK (matches the game's runtime)
- Slay the Spire 2 installed locally (so you can reference its
  game-side DLLs from `<STS2 install>/managed/`)
- [BaseLib-StS2](https://www.nexusmods.com/slaythespire2/mods/3) — every
  serious STS2 mod depends on it for hook helpers and ModConfig
- Optional: [sts2-modding-mcp](https://github.com/elliotttate/sts2-modding-mcp)
  + Cursor for AI-assisted hook discovery (151 tools, 5-10x speedup)

## Build

```bash
cd Mod/SpireVaultCompanion
# Set the STS2 path so the project file can find game DLLs to reference.
export STS2_PATH="$HOME/Library/Application Support/Steam/steamapps/common/SlayTheSpire2"
dotnet restore
dotnet build -c Release
```

The output `bin/Release/net9.0/SpireVaultCompanion.dll` plus
`mod_manifest.json` and `LICENSE` should be zipped together as
`SpireVaultCompanion-v0.1.zip` and dropped into:

```
%APPDATA%/SlayTheSpire2/mods/SpireVaultCompanion/
```

## Configuration

ModConfig exposes:

- **Stream live run** — toggle. Default ON. Off disables all uploads
  for the current run.
- **OBS overlay link** — read-only field; copies
  `https://spirevault.app/watch/<runId>?overlay=1` to clipboard.
- **Diagnostics** — last upload time + last error code.

## Privacy

The mod streams CURRENT run state only:

- character, ascension, deck, hand, hp, floor, gold, relics, potions
- in-combat hand + enemy intents
- party member identifiers (Steam IDs) + their hp/deck size

Nothing leaves your machine until you sign in to SpireVault and start
a run with the mod enabled. The cloud row expires automatically
(90s while live, 30 minutes post-run for the share/replay window).

## Why this exists

Every existing STS2 mod is local-only. Every existing web tool can only
see what the user uploads after the fact. Nobody has connected the two.
The cloud backend (Steam OAuth, presence, party hub, reputation, daily
challenge, Discord LFG mirror) takes 6+ months to replicate. The mod
itself is small. The combo is uncopyable.

## Files

```
Mod/
├── README.md                     this file
├── PUBLISH.md                    Nexus + Steam Workshop publishing checklist
├── BUILD.md                      detailed local build instructions
└── SpireVaultCompanion/
    ├── SpireVaultCompanion.csproj   .NET 9.0 project file
    ├── mod_manifest.json            STS2 mod manifest
    ├── Plugin.cs                    main entry point + lifecycle
    ├── CHANGELOG.md
    ├── LICENSE                      MIT
    ├── Auth/
    │   └── SteamSessionResolver.cs  finds the SpireVault session token
    ├── Combat/
    │   └── DamageMeter.cs           Skada-style damage tracking
    ├── Hooks/
    │   ├── CombatHooks.cs           Harmony patches: turn / damage / energy
    │   ├── PartyHooks.cs            Harmony patches: co-op party state
    │   └── RunHooks.cs              Harmony patches: run start / end
    ├── Models/
    │   └── IngestPayload.cs         wire format DTOs (mirror backend)
    ├── Settings/
    │   └── ModSettings.cs           ModConfig integration
    └── Stream/
        ├── IngestClient.cs          HTTP POST loop to /coop/mod/ingest
        └── SnapshotBuilder.cs       turns game state into RunLiveSnapshot
```
