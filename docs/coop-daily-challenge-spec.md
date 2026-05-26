# Daily Co-op Challenge — spec

Status: **v1 shipped in v0.11.0 (2026-05-26).**

Every UTC day, SpireVault picks a deterministic seed + a suggested
character + a suggested ascension. Every client in the world sees the
same daily challenge. Tap the tile, the seed is on your clipboard,
go type it into STS2's seed field on character select, then host a
co-op room. Other people doing the same challenge end up in your
lobby list with a recognisable seed.

## What landed

- `Backend/src/coop-daily.ts` — pure derivation (`fnv1a(date)` → seed
  string, character, ascension) plus a small `coop:daily:joined:<date>`
  KV blob that tracks how many distinct hosts posted a daily-tagged
  lobby today.
- `GET /coop/daily-challenge` — public, 5-minute browser cache, no
  auth required. Returns `{ date, seed, character, ascension,
  expiresAt, joinedCount }`.
- `Web/lib/party-finder-daily-rt.js` + `Web/lib/party-finder-daily.css`
  — frontend tile under the hero stats. Click → seed to clipboard +
  toast.
- `[daily=YYYY-MM-DD]` note tag: when a host types this into the lobby
  note (or the frontend auto-injects it after the tile click), the
  `createLobby` engine call records the host in
  `coop:daily:joined:<date>` so `joinedCount` increments.
- `/tmp/coop-daily-test.mjs` — 17 unit tests covering determinism,
  seed format, pool coverage, and tag parsing.

## Trust model

- The seed isn't enforced — we have no game-side mod and we're not
  trying to verify the run was actually on that seed. The challenge
  is a coordination signal, not a leaderboard.
- `joinedCount` is host-Steam-ID-deduped per day so spamming `Create
  lobby` doesn't inflate the number.

## What's not in v1

- A "today's leaderboard" view. Possible v0.12 follow-up once we have
  enough hosts per day to make it useful. Hooks to add: `coop:daily:
  results:<date>` aggregated from `RunSummary` rows whose `seed`
  matches the daily seed.
- Enforcement of "you ran the actual seed." Needs save-parser changes
  to expose seed reliably on every `RunSummary` (it's already there
  on the type, but the desktop parser doesn't fill it for every save
  yet — verify in v0.12 spike).
- Multi-region / per-locale challenges. Single global UTC challenge
  is the right v1.
