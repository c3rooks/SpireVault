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

## Share to Discord

While you are looking, and in a party that still has a seat, the card has a **Share to Discord** button. It replaces the old lobby's "Copy Discord LFG Post". It copies a three-line post (who is waiting or in the party, their climbers, the game version, seats open, and a link); on a phone it opens the share sheet instead. A toast confirms the copy and the button reads "Post copied" for a moment.

- **The link** is `https://app.spirevault.app/coop?branch=stable|beta`. Opening it preselects that game version on the Play card (`script.js` stores it at boot, `coop-play.js` reads it once), which survives a Steam sign-in. It is not a link to one party: Play puts the next player into the oldest party gathering on that version, which at this size is the sharer's. `/party/<id>` only works for someone already in that party, so it is never shared. A link that joins one named party would need a server change.
- **Names are untrusted.** The post goes out under the sharer's Discord account, so every Steam name is stripped of mentions, markdown, links and line breaks (`discordSafe`).
- **The link preview.** `/coop` is the app, so it used to unfurl as the stats pitch. `Web/functions/coop.js` now serves the same page with seven co-op Open Graph and Twitter tags and `Web/assets/og-coop-v2.jpg` (built by `node scripts/build-coop-og.mjs`). The browser-tab title and search description are untouched.
- The Play card itself carries the button only while a seat can be taken (looking, or a party with room). Before you tap Play the post is still available from the panel under the card, worded as an invitation ("wants to climb"), because nobody is in line yet.

## Under the Play card

The card used to end with empty page below it. Three things sit there now (`Web/lib/coop-play-more.js`), in every state:

- **Right now**: one line of counts from the Play view: players looking on Stable, on Beta, and players in a party.
- **Bring someone**: the post drawn as it will read in Discord, with the link's preview card, plus Share to Discord and Copy link. Hidden for a full party and a run under way.
- **Your co-op climbs**: from the player's own saves (`Web/lib/coop-climbs.js`): co-op runs, wins, win rate (wins over every co-op run, abandoned ones included, as on Overview), best floor, the party with the most wins, and the last three co-op runs with each party's climbers.

What a co-op save holds was checked against the game: its run history keeps a list of players (`RunHistoryPlayer`: a 64-bit id, the character, deck, relics), one per player. `sts2-run-parser.js` now keeps `partySize` and `party` (every player's climber, in the file's order). The save does not say which entry is the local player, so:

- the co-op numbers are about the party as a whole and never claim which climber was yours;
- a co-op run's own `character`, deck and relics are still the first listed player's, as they always were. If that is not the local player, the stats tabs attribute the run to the wrong climber. Fixing that needs a real co-op save to confirm how to tell the players apart (the ids are 64-bit, beyond what `JSON.parse` keeps exactly).

The panel always has the same three parts: the four numbers, the party with the most wins standing in a game room (the latest party before any win), and the last three co-op runs drawn with the climbers' sprites. Side by side with "Bring someone" the two panels are the same height and both are filled to the foot: here the room is the part that grows, there the picture in the link's card. In every room (the Play card's too) the seats and climbers stand centred, with as much bare ground on the left as on the right.

## Names are never cut where there is room

Found by the Nov 16 UI audit and fixed in `Web/lib/coop-play-view.js`, `coop-play.js` and `coop-play.css`:

- **Name tags** are sized by script (`fitPartyTags`). A tag is measured in fractions of a pixel and rounded up with one pixel to spare, because a tag 0.3px narrower than its name is drawn as "Ma…". While the room has space, the width is only a floor, so a name that grows later widens its tag. Two climbers standing close push their tags apart by equal amounts instead of shrinking them. Tags are fitted again when any room changes size and when a font finishes loading (`loadingdone`), not only when the whole card resizes.
- **The climber picker** never uses an ellipsis. A name too long for its tile breaks at a soft hyphen ("Necro-binder" on two lines).
- **Recent runs** share one set of columns (`subgrid`), so every row starts its names on the same left edge.
- **The room fills the card** before a match: beside the taller controls it grows to the foot of the card.
- **Game version** options are 44px tall, an empty seat is dark enough to hide the props behind it, and in classic the tab's empty head takes no room.

`scripts/verify-ui-next.mjs --only coop` checks all of this at 1920, 1440, 1280, 1180, 768 and 390 in both looks. `VERIFY_UI_MATCH="no name is cut"` runs just those checks.

## The party card has no empty column

On a wide card the party state used to stack its three steps in the left column, with the room alone at the top of the right one and some 550px of empty card under it. Now (`Web/lib/coop-play.css`, "A party, on a wide card"; markup in `partyHtml`):

- the heading and the room share the top row, the heading level with the middle of the room;
- the three steps stand side by side under them, equally tall, each with its buttons on the step's floor so the buttons share one line;
- a foot row (`.cp-foot`) closes the card: the help line takes the width, Leave party stands at its right end.

The card is about 520px tall at 1440 instead of about 880, so the whole flow is on screen at once. On cards 860px wide or less nothing changed: heading, room, then the steps stacked. In both layouts a 32-character Steam name is cut with an ellipsis inside its Add button, and the help line is a 44px target. Checked by "in a party the steps stand side by side under the room, with no empty column" at the same six widths in both looks.

When there are no co-op runs to show, the same layout is drawn on sample numbers, tagged **Example** and dimmed, under a note that says why and offers the app's own button: Import saves (no saves loaded), or Refresh (saves read before parties were counted, or saves with no co-op runs yet). The app's sample runs are never counted as the player's.

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
| Share to Discord: the post, safe names, copy and share sheet | `Web/lib/coop-play-share.js` |
| Under the card: live strip, invite panel, co-op numbers | `Web/lib/coop-play-more.js`, `Web/lib/coop-climbs.js` |
| Link preview for `/coop` | `Web/functions/coop.js`, `Web/functions/_shared/coop-embed.js`, `scripts/build-coop-og.mjs` |
| Styles: structure + classic paint | `Web/lib/coop-play.css` |
| Styles: new-look paint | `Web/styles/src/surfaces/coop.css` |

Usage counters (taps, matches, wait times, Steam adds, "we're in") are kept per day by the Durable Object and shown under "Co-op Play" on `/admin/stats`.

## Running it locally

1. Start the `worker-local` (8787) and `web-steam` (8790) launch configs.
2. Sign in: real Steam on `http://127.0.0.1:8790`, or a sandbox persona with `http://127.0.0.1:8790/api/_dev-login?as=c3rooks&next=/coop`. Use 127.0.0.1, not localhost: the app sends localhost visits to 127.0.0.1, and a sign-in cookie set on localhost would be left behind.
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
- `node Web/scripts/verify-coop-share.mjs` (part of `make -C Web preflight`): the Discord post, name safety, copy and share-sheet paths, and the `/coop` preview tags, offline.
- `node Web/scripts/verify-coop-climbs.mjs` (also in the web preflight): the parser keeps every player of a save, and the co-op numbers count only runs with a party.
- `node scripts/snap-coop-play.mjs`: screenshots of every state into `docs/screenshots/coop-play/`. `--only searching,party-host` limits the states; `SNAP_COOP_PORT` moves its server if 8784 is taken.

## Deploying

Worker first (it adds the Durable Object migration and clears the house-room cron), then `POST /admin/house-lobbies/close-all` once, then the web app. The cron is cleared by the explicit `[triggers] crons = []` in `Backend/wrangler.toml`: wrangler only sends schedules when `crons` is defined, so a config with no `[triggers]` section would leave the live `*/15` schedule running. After the deploy, check that the Worker shows no cron trigger. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_JWK` as Worker secrets for pings. Confirm the Worker deploy actually produced a new version.

The old lobby, party, intent and invite endpoints are still in the Worker for one release so stale tabs fail softly. Removing them is a separate decision.

## Still unproven

- That two people pressing Steam "Add" on each other become friends without a manual accept.
- That Stable and Beta players can't join each other (if they can, drop the branch filter).
- That Safari shows a notification for a payload-free push.

## History

The specs for the retired lobby system (`coop-run-lobby-upgrade-plan.md`, `coop-party-room-bridge.md`, `coop-synced-readyup-spec.md`, `coop-daily-challenge-spec.md`, `coop-reputation-spec.md`, `coop-lobby-preflight.md`, …) are kept for reference only; none of that UI exists any more.
