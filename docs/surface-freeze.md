# Surface freeze

**Status:** active as of 2026-08-23
**Lifts when:** the exit criteria below are met, or a deliberate decision is recorded here to lift it early.

## The problem this addresses

Spire Vault has ~84 lifetime accounts and, at the time of writing, no measured
answer to whether any of them come back. Against that, the codebase carries a
tournament bracket system, a daily race with ghost replays, an AI run coach, a
community highlights feed with reactions and threaded comments, Steam Rich
Presence ingestion, a mod-stream surface, a Discord LFG mirror, and a
reputation system with tiers.

Each of those was a reasonable idea. Collectively they are the problem. Every
surface has to be kept working across every deploy, appears in the UI competing
for the same attention, and consumes review and debugging capacity that is not
going into the one thing that determines whether this product survives — that
people who sign up come back next week.

Adding a ninth surface will not fix a retention number. It will make the
retention number harder to move, because the next bug will take longer to find.

## What is frozen

No new features, no expansions, and no UI-prominence increases for:

| Surface | Where |
| --- | --- |
| Tournaments / brackets | `Backend/src/coop-tournament.ts` |
| Daily race + ghosts | `Backend/src/coop-race.ts` |
| AI run coach | `Web/run-coach.js` |
| Community highlights | `Backend/src/highlights.ts` |
| Mod stream | mod-stream routes in `Backend/src/coop-routes.ts` |
| Clip generation | `Backend/src/coop-clip.ts` |
| Discord LFG mirror | `Backend/src/coop-mirror.ts`, `Web/lib/party-finder-mirror-rt.js` |
| Discord bot / interactions | `Backend/src/discord-interactions.ts`, `Bot/` |

**Still allowed on frozen surfaces:**

- Security fixes.
- Crash and data-loss fixes.
- Changes required to keep them compiling or working as other code changes
  around them.
- Deletion, if a surface turns out to be unused.

**Explicitly not allowed:** new endpoints, new UI, new configuration, "while
I'm in here" improvements, and performance work on surfaces nobody is using.

### A note on the Discord entries

These are frozen for a different reason than the rest. The product decision is
that Spire Vault does not become a bot in anyone's server and does not call the
Discord API — the goal is to remove the need to go post in Discord, not to
replace or colonize it. The existing mirror and interaction scaffolding is
dormant and not deployed. It stays in the tree for now, unextended.

## What is not frozen

Work that moves the retention number, or that tells us whether it moved:

- **Scheduled play intents** (`Backend/src/coop-intents.ts`,
  `Web/lib/party-finder-intents-rt.js`). This is the current bet: at our
  concurrency, the binding constraint on co-op is that two interested players
  are rarely online in the same five minutes. Intents are the only surface that
  attacks that directly.
- **The import funnel.** Getting a save folder parsed is the activation event.
  Anything that raises the conversion from "opened the picker" to "runs
  committed" is in scope.
- **Retention instrumentation** — the cohort table, the ingest funnel, the JS
  error capture, and the KV write budget panel on `/admin/stats`.
- **Correctness and reliability** anywhere in the product.

## Exit criteria

Lift the freeze when the `/admin/stats` cohort table can show, over at least
four consecutive weekly cohorts:

1. **Activation ≥ 60%** — of users who sign in, at least 60% import runs.
   Below this the product is failing before it starts, and no fifth surface
   helps.
2. **7-day return of activated users ≥ 30%** — of users who imported runs and
   are old enough to judge, at least 30% came back within a week.
3. **At least one intent match per week converting into a session** — evidence
   that the scheduling bet works, rather than that people merely filled it in
   once.

These are deliberately modest. They are not "good"; they are the floor at which
adding surface area stops being obviously the wrong move.

## Why these numbers

Activation and 7-day return are the two rates in the funnel where a failure is
unrecoverable by anything downstream. A tournament system cannot help a user
who never got their save file parsed, and a highlights feed cannot help a user
who never came back to see it. Until both are healthy, effort spent anywhere
else is effort spent on people who have already left.

## Reviewing this

Re-read this document when the cohort table has four weeks of data — the
`seen:` markers need 90 days of TTL runway before D30 is trustworthy, and that
clock started on 2026-08-23. If the criteria are met, record the decision to
lift and delete this file. If they are not, the freeze holds and the question
becomes which frozen surface to *delete*, not which to resume.
