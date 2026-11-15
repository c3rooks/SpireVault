# Co-op: one-tap Play

**Status:** built 2026-11-14, replaces the lobby board, the Party Hub and "When are you free?".

## Why

Nobody used the lobby system. On 2026-11-14 prod had 124 accounts, and every player's reputation summary read zero parties hosted, joined or completed. The board only looked busy because of two fake "house" rooms. At this size the binding constraint is that two players are rarely online at the same moment, so co-op is now one button plus a queue that survives a closed tab.

## The flow

1. **Play.** Pick a climber (or Any) and the game branch (Stable / Beta; The Fool only on Beta), tap Play.
2. **Matched.** If anyone is waiting on the same branch, you are matched at once. Otherwise you wait in line; with pings on you can close the tab and get a push when someone joins (or, if you opted in, when someone starts looking).
3. **Party.** Up to 4 players. The player who waited longest hosts. Steps on the card:
   1. Add each other on Steam (`steam://friends/add/<id>`): the host adds each joiner, joiners add the host.
   2. Launch STS2 (`steam://run/2868840`). Host: Multiplayer → Host, then "I'm hosting". Joiners: Multiplayer → Join → the host.
   3. The host taps "We're in". The party locks (nobody else can join) and counts as a co-op run.

Leaving before the run starts hands the host role on, or dissolves the party and puts the remaining player back in line at their original place. Signing out does the same for a party that has not started, takes you out of line, and turns pings off for the account.

## Where things live

| Piece | File |
| --- | --- |
| Matching rules (pure, unit-tested) | `Backend/src/coop-play-core.ts` |
| The one live queue (Durable Object `COOP_PLAY`) | `Backend/src/coop-play-do.ts` |
| Routes `/coop/play*` | `Backend/src/coop-play-routes.ts` |
| Web Push (VAPID, no payload) | `Backend/src/coop-play-push.ts`, `Web/sw.js` |
| The card (state, polling, actions) | `Web/lib/coop-play.js` |
| Markup per state | `Web/lib/coop-play-view.js` |
| Chime, notification, push subscribe | `Web/lib/coop-play-alerts.js` |
| Styles: structure + classic paint | `Web/lib/coop-play.css` |
| Styles: new-look paint | `Web/styles/src/surfaces/coop.css` |

Usage counters (taps, matches, wait times, Steam adds, "we're in") are kept per day by the Durable Object and shown under "Co-op Play" on `/admin/stats`.

## Running it locally

1. Start the `worker-local` (8787) and `web-steam` (8790) launch configs.
2. Sign in: real Steam on `http://localhost:8790`, or a sandbox persona with `http://localhost:8790/api/_dev-login?as=c3rooks&next=/coop`.
3. Put another player in line so Play matches instantly:
   ```bash
   curl -X POST http://127.0.0.1:8787/_debug/coop-sandbox/play-seed -H 'content-type: application/json' -d '{"persona":"Boble","branch":"stable","character":"ironclad"}'
   ```
   Drive that persona's steps with `/_debug/coop-sandbox/play-act` (`{"persona":"Boble","action":"poll|steam_add|hosting|in_game|leave"}`). A matched persona that is never polled times out after 3–5 minutes, like a real player who walked away. `/_debug/coop-sandbox/reset` clears everything.
4. Pings need VAPID keys: `node Backend/scripts/gen-vapid.mjs`, then put both lines in `Backend/.dev.vars` (git-ignored) and restart the worker.

## Checks

- `make -C Backend preflight`: types, offline suite, and `scripts/verify-coop-play.mjs` (matching and push).
- `node Backend/scripts/verify-coop-play-flow.mjs`: end to end against the local worker. Its "pings switched on mid-search" step only runs when that worker has VAPID keys; without them it prints `skip`.
- `node scripts/verify-ui-next.mjs --only coop`: every state in both looks, Play visible without scrolling at 1440, 1024 and 390px. Set `VERIFY_UI_PORT` if 8798 is taken.
- `node scripts/snap-coop-play.mjs`: screenshots of every state into `docs/screenshots/coop-play/`.

## Deploying

Worker first (it adds the Durable Object migration and removes the house-room cron), then `POST /admin/house-lobbies/close-all` once, then the web app. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_JWK` as Worker secrets for pings. Confirm the Worker deploy actually produced a new version.

The old lobby, party, intent and invite endpoints are still in the Worker for one release so stale tabs fail softly. Removing them is a separate decision.

## Still unproven

- That two people pressing Steam "Add" on each other become friends without a manual accept.
- That Stable and Beta players can't join each other (if they can, drop the branch filter).
- That Safari shows a notification for a payload-free push.

## History

The specs for the retired lobby system (`coop-run-lobby-upgrade-plan.md`, `coop-party-room-bridge.md`, `coop-synced-readyup-spec.md`, `coop-daily-challenge-spec.md`, `coop-reputation-spec.md`, `coop-lobby-preflight.md`, …) are kept for reference only; none of that UI exists any more.
