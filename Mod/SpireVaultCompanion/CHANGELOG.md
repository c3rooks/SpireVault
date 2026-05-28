# SpireVault Companion — CHANGELOG

## v0.1.0 — Foundation (current)

- Project scaffold (.NET 9.0, Harmony 2, BaseLib-StS2 reference)
- Wire format locked: `Models/IngestPayload.cs` mirrors
  `Backend/src/coop-mod-stream.ts` exactly
- Ingest loop: 2-second POST cadence, 8-second timeout, drops
  overlapping ticks, surfaces last-error to ModConfig diagnostics
- Steam session resolver: env vars (dev), `~/.spirevault/companion.json`
  (production), silent degraded mode when neither is present
- Run lifecycle hooks (start, end) + combat hooks (enter, tick, exit)
  + party hook stub
- Local Skada-style damage meter (5 buckets: outgoing, incoming,
  healing, block, vulnerable)

The v0.1 ship is the **producer side** of the wire format. The
backend ingest endpoint, spectator UI, OBS overlay, and AI Coach
already consume this exact payload — the day v0.1 binary lands in a
player's mods folder, every web feature lights up automatically.

## v0.2.0 — Teammate decks (planned)

- Network-sync'd party member decks + hands
- Full party hub mirror (live deck inspector, hover panels for every
  teammate)
- Damage meter forwarded onto the wire format

## v0.3.0 — Auto-share (planned)

- On run-end: auto-generate share-card + Coach narrative
- Optional Discord LFG auto-post when starting a co-op lobby with
  the mod enabled
