# Verified Co-op Reputation — spec

Status: **drafted 2026-05-26, target ship v0.11.0 (3 weeks).**
Owner: Corey.
Replaces nothing — net-new feature on top of v0.10.0.

The single most-asked-for thing after shipping the lobby surface was
"can I tell whether the person hosting this room actually plays the
game and actually finishes runs, or are they going to bail at floor 5?"
Discord literally cannot answer that. SpireVault already has the data.
This spec is how we expose it.

## Goals

1. Show a **server-verified** trust signal on every host avatar in the
   live-parties list, the host modal preview, and the friends roster.
2. Make the signal hard to fake — derived from the user's own
   uploaded run history (`runs:<steamID>`) and the server's own party
   lifecycle log, not from anything the client can self-report.
3. Keep the wire shape opaque — clients see **labels and tiers**, not
   the underlying numbers, the same way `coop-recommendations.ts` exposes
   `MatchLabel` rather than the raw fit score. Stops people from
   reverse-engineering the formula and farming it.
4. Ship this without breaking any current client. The new endpoint is
   additive; existing `/coop/state` is untouched on the wire.

## Non-goals (v1)

- Co-op-specific run validation (knowing for certain a Heart kill was
  in co-op vs solo). That requires `RunSummary.coop` metadata which
  needs the save parser updated; defer to v0.12.0.
- Public reputation pages with shareable URLs. Defer to v0.13.0.
- Any kind of leaderboard or rep-tier ranking. Reputation answers
  "should I trust this person to finish a run with me?", not "who is
  the best."
- Negative rep / report system. Out of scope until we see actual
  abuse patterns.

## Evidence sources

Two independent inputs feed the reputation:

### Input 1 — Solo skill from `runs:<steamID>`

Already on the server (KV blob, 365d TTL, max 2000 runs). We never
modify it; reputation reads it.

Derived metrics:
- `totalRunsLogged` — `runs.length`
- `runsLast30d` — `runs.filter(r => r.endedAt within 30d).length`
- `highestAscensionCleared` — `max(runs.filter(won).map(r => r.ascension))`
- `ascensionByCharacter` — `Record<character, max ascension cleared>`
- `heartKills` — `runs.filter(r => r.won && r.floorReached >= 60).length`
- `recentWinRate30d` — wins ÷ total over last 30d, **only if total ≥ 10**;
  otherwise null (don't show win rate on tiny samples — too noisy)
- `lastRunAt` — `runs[0].endedAt` (runs are stored newest-first)

### Input 2 — Co-op reliability from a new event log

`rep:hist:<steamID>` — small KV blob (`CoopHistoryBlob`), per-Steam-ID,
capped at the most recent 200 events. TTL 180d (rolls forward on every
write).

Events get logged from inside the existing party-lifecycle handlers in
`coop-engine.ts`. Best-effort writes — they never block or fail the
caller's action.

| Hook (existing fn) | Event | When | Logged for |
| --- | --- | --- | --- |
| `createLobby` (existing) | `hosted_lobby` | Host posts a room | host |
| `updatePartyMemberStatus` first time → `in_game` | `started_party_run` | Member enters in-game | that member |
| `endParty` (host) | `completed_party_role` | Host calls end-party | host (`role:"host"`), each member whose status is `in_game` (`role:"member"`) |
| `leaveParty` while own status was `in_game` | `abandoned_party` | Member leaves mid-run | the leaving member |
| `endSession` while session was `active` and tied to a `lobbyId` | `completed_session` | Session ends cleanly | each `playerSteamIds` |

Each entry shape:

```typescript
interface CoopHistoryEntry {
  at: string;                 // ISO8601
  event: "hosted_lobby" | "started_party_run" | "completed_party_role"
       | "abandoned_party"   | "completed_session";
  partyId?: string;
  lobbyId?: string;
  sessionId?: string;
  role?: "host" | "member";
}
```

Aggregation:

- `partiesHosted` — count of `hosted_lobby`
- `partiesJoined` — count of `started_party_run`
- `partiesCompleted` — count of `completed_party_role` ∪ `completed_session`
- `partiesAbandoned` — count of `abandoned_party`
- `reliabilityScore` — `partiesCompleted ÷ (partiesCompleted +
  partiesAbandoned)`, expressed 0–100, **with a confidence floor**:
  if `(partiesCompleted + partiesAbandoned) < 5`, score is `null`
  (rendered as "New host"). With ≥ 5 outcomes the score is shown.

## Tier mapping

A single `tier: "newcomer" | "regular" | "trusted" | "veteran" | "ascended"`
is derived server-side. Mapping (subject to tuning):

```
newcomer  default
regular   totalRunsLogged ≥ 10                                          (they actually play)
trusted   regular  +  partiesCompleted ≥ 5  +  reliabilityScore ≥ 80    (they finish co-op runs)
veteran   trusted  +  highestAscensionCleared ≥ 15
ascended  veteran  +  highestAscensionCleared ≥ 20  +  heartKills ≥ 1
```

Tier is the only thing rendered as a colored pill. Underlying numbers
appear in the expanded view (host modal preview, /reputation page in
v0.13).

## Badges

Up to four discrete badges, each a single visual pill:

| Badge id | Earned when |
| --- | --- |
| `heart_kill` | `heartKills ≥ 1` |
| `a20_clear` | `highestAscensionCleared ≥ 20` |
| `host_reliable` | `partiesHosted ≥ 5` and `reliabilityScore ≥ 90` |
| `active_recent` | `runsLast30d ≥ 5` |

## KV schema

```
rep:v1:<steamID>           cached snapshot blob (JSON ReputationBlob)
rep:hist:v1:<steamID>      coop event log (JSON CoopHistoryBlob, capped 200)
```

Both prefixed `rep:` — clean namespace, no collisions per the
exploration report.

`ReputationBlob` includes a `schemaVersion: 1` field so we can evolve
later without a migration framework.

## Endpoints

| Method | Path | Auth | Cache | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/coop/reputation/me` | session required | always fresh | full `ReputationBlob` (incl. raw counters) |
| `GET` | `/coop/reputation/:steamID` | none (public) | up to 5 min | redacted `PublicReputationBlob` (tier + badges + first-played + last-active month, no raw counters) |

`PublicReputationBlob` shape:

```typescript
interface PublicReputationBlob {
  schemaVersion: 1;
  steamID: string;
  tier: ReputationTier;
  badges: ReputationBadge[];
  firstPlayedMonth?: string;   // "2026-03"
  lastActiveMonth?: string;    // "2026-05"
  partiesCompleted?: number;   // bucketed: <5, 5-19, 20-49, 50-99, 100+
  partiesCompletedBucket?: "<5" | "5-19" | "20-49" | "50-99" | "100+";
  recompute_after?: string;    // hint for client cache
}
```

Bucketing on the public endpoint stops people from precision-farming
(e.g. "I went from 49 to 50 parties so I jumped a tier"). The
authenticated `/me` endpoint shows the exact number.

## Caching

- `rep:v1:<steamID>` is recomputed on read if older than:
  - 60 seconds for the requesting user's own /me read
  - 5 minutes for any /:steamID read
- `rep:hist:v1:<steamID>` is appended on every event hook,
  rate-limited per-bucket (`rep-hist-write`, 30/min IP).
- The 1s tick on the lobby page does **not** poll reputation;
  reputation is fetched once when a row is rendered and cached
  per-Steam-ID for 5 minutes in browser memory.

## Rate limits

Per `coop-routes.ts` pattern:

| Bucket | Max | Window | Routes |
| --- | --- | --- | --- |
| `coop-rep-read` | 60 | 60s | `GET /coop/reputation/:steamID` |
| `coop-rep-self-read` | 30 | 60s | `GET /coop/reputation/me` |
| (internal) `coop-rep-hist-write` | 30 | 60s | event log appends |

## UI surfaces (this spec)

**v0.11.0 ships only the badge on `pf-live-row`** — small, low-risk,
high-signal. The host modal preview, friends roster, and dedicated
reputation page come in v0.12.0/v0.13.0 once we've seen real data
shapes from production.

The badge is one element: a colored tier dot next to the host's
persona name on each live row. Hover reveals tier name + earned
badges. No raw numbers. Loading state is invisible (the dot just
appears once the fetch resolves) — a "skeleton" pulse on a row that
already has rich content would be visual noise.

## Anti-abuse

- **Bots that spam-host empty rooms** to inflate `partiesHosted`:
  capped because `partiesHosted` doesn't directly raise the tier — only
  `partiesCompleted` does, which requires either an actual `endParty`
  call from a host *with* members in `in_game` status, or a
  `completed_session` from `endSession` on a multi-player session.
- **Solo abandoner** (joins, hits in_game, leaves): caught by
  `abandoned_party` event; pulls `reliabilityScore` down.
- **Silent drop-out** (closes the tab without calling leave): the
  party TTL (45 min idle) eventually expires the party. We do **not**
  charge `abandoned_party` on TTL expiry — too noisy, false-positives
  on people whose laptop slept. Only charge on explicit `leaveParty`
  while own status was `in_game`.
- **Self-pair to farm**: same Steam ID can't appear twice in
  `playerSteamIds` (existing engine invariant).
- **Two accounts farming each other**: detectable later via shared-IP
  patterns, but out of scope for v0.11.0.

## Migration / versioning

- New `rep:v1:` prefix; if we change the formula, bump to `rep:v2:`
  and let `v1:` age out via TTL. `schemaVersion` field inside the blob
  pins the formula version separately so we can recompute lazily.
- Client should ignore `tier` values it doesn't recognise (forward
  compat: a future `legendary` tier shouldn't break older builds).

## Test strategy

`/tmp/coop-reputation-test.mjs` (Node, no Worker runtime — uses an
in-memory KV stub like the existing tests):
- Seeds `runs:<sid>` with a controlled fixture (mix of A0/A15/A20
  wins, Heart kills, recent + old).
- Seeds `rep:hist:v1:<sid>` with a controlled fixture (5 hosted, 4
  completed, 1 abandoned).
- Calls the compute function directly and asserts the resulting
  `ReputationBlob` (tier, badges, exact counters).
- Asserts the public redacted shape strips raw counters.

End-to-end Puppeteer smoke (`/tmp/pf-rep-badge-test.mjs`) renders the
beta lobby and asserts a tier dot appears on a host row after
`/coop/reputation/:sid` resolves.

## Roadmap that depends on this

- **v0.12.0 — Steam Rich Presence helper**: when STS2 boots, the
  desktop helper sets your status to `looking` and pulls your own
  reputation tier into the embedded lobby UI.
- **v0.12.x — Synced ready-up + auto-advance**: orthogonal, doesn't
  block on this.
- **v0.13.0 — Daily Co-op Challenge**: blocked on the seed spike
  (`docs/coop-daily-challenge-spec.md`).
- **v0.13.x — Post-run shared report**: needs `RunSummary.coop`
  metadata first; that comes with the parser update in v0.12.0.

## Open questions

- Should `tier` be visible on the requester's own profile (could feel
  judgmental on a fresh account)? **Decision: yes, but the empty-state
  copy reads "Just getting started — your tier appears after 10 runs."**
- How aggressive should the co-op completion confidence floor be?
  **Decision: 5 outcomes for `reliabilityScore`, 5 hosted for
  `host_reliable` badge.** Tunable in v0.11.x without schema change.
