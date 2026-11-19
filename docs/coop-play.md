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

Leaving before the run starts hands the host role on, or dissolves the party and puts the remaining player back in line at their original place. Signing out turns pings off for that device only. Only when no other device can ping you does it also take you out of line and out of a party that has not started (`POST /coop/play/signout`).

## Pings on every device (walk away from the desk)

Queue on the desktop, walk away, find out on the phone. Since 2026-11-18 (branch `redesign/inked-codex`, not deployed yet):

- **Every device keeps its pings.** Each place a player turns pings on is a device in `dev:<steamID>` (`Backend/src/coop-play-devices.ts`), at most 8. A device's id is the first 16 hex characters of SHA-256 of its push endpoint, so turning pings on again in the same browser refreshes it. Before this there was one `sub:<steamID>` per player and the newest browser replaced the others; an old record becomes a one-device list the first time it is read. A match pings every device, and the push queue holds one entry per device, so a batch of 40 counts real requests.
- **"Away" means the page is not in view.** The card polls `GET /coop/play?visible=0|1`. A tab in the background keeps your place, but a match made while it is hidden still pings your devices. Clients that send nothing count as in view, the old rule.
- **How long to keep looking.** With pings on, a search lasts the chosen stay after you last had the page in view: 30, 60 (default) or 120 minutes (`stay` on `POST /coop/play`). Hidden polls don't stretch it. When it runs out you get one "Your co-op search ended" ping (`endedAt` in the view for 15 minutes, read by the service worker's peek). Without pings the old 90-second rule stands. The card asks under the ping switch, once pings reach you somewhere ("If you step away, keep looking for": 30 min, 1 hour, 2 hours, saved per browser in `vault.coop.play.v1`), and the looking card says how long its search keeps going.
- **Matched while away (with pings on).** You have 5 minutes from the match to look at the page. A hidden tab polling doesn't hold the seat, so your partner isn't stuck waiting. Once you have looked, any poll keeps the seat, because launching the game or Steam hides the tab. Without pings nobody told you, so the old rule holds: any poll, hidden or not, keeps your seat. The "Party found!" ping has two buttons where the browser shows them (Chrome, Edge, Android): **On my way** (`omw`: the party sees you coming, and the 5 minutes start again, once) and **Pass** (gives the seat back at once). Both are sent by `Web/sw.js` with `visible:false`, so they don't count as you being back. The party card then says "Mako is on the way." under the seats line (`MemberView.coming`).
- **Routes:** `GET /coop/play/devices` (labels like "Chrome on Mac", never endpoints), `DELETE /coop/play/devices/:id`, `DELETE /coop/play/push {endpoint}` (that device; with no endpoint, all of them, for old clients), `POST /coop/play/signout {endpoint?}`. The card lists the devices under the ping switch ("Pings go to this browser and Safari on iPhone", a fold-out with Remove on each; removing this browser is the same as switching its pings off). It lives on the Co-op card, where pings are switched, rather than in Settings.

## Share to Discord

While you are looking, and in a party that still has a seat, the card has a **Share to Discord** button. It replaces the old lobby's "Copy Discord LFG Post". It copies a three-line post (who is waiting or in the party, their climbers, the game version, seats open, and a link); on a phone it opens the share sheet instead. A toast confirms the copy and the button reads "Post copied" for a moment.

- **The link** is `https://app.spirevault.app/coop?branch=stable|beta`. Opening it preselects that game version on the Play card (`script.js` stores it at boot, `coop-play.js` reads it once), which survives a Steam sign-in. It is not a link to one party: Play puts the next player into the oldest party gathering on that version, which at this size is the sharer's. `/party/<id>` only works for someone already in that party, so it is never shared. A link that joins one named party would need a server change.
- **Names are untrusted.** The post goes out under the sharer's Discord account, so every Steam name is stripped of mentions, markdown, links and line breaks (`discordSafe`).
- **The link preview.** `/coop` is the app, so it used to unfurl as the stats pitch. `Web/functions/coop.js` now serves the same page with seven co-op Open Graph and Twitter tags and `Web/assets/og-coop-v3.jpg` (built by `node scripts/build-coop-og.mjs`). The browser-tab title and search description are untouched.
- The Play card itself carries the button only while a seat can be taken (looking, or a party with room). Before you tap Play the post is still available from the panel under the card, worded as an invitation ("wants to climb"), because nobody is in line yet.

## Under the Play card

The card used to end with empty page below it. Three things sit there now (`Web/lib/coop-play-more.js`), in every state:

- **Right now**: one line of counts from the Play view: players looking on Stable, on Beta, and players in a party. Only once you are in a party: before that, the counts hang in your room's sky (below).

### The sign in the room's sky

Before a match you stand alone in a tall room beside three empty seats, and the sky above was bare. A sign hangs there now (`skyHtml` in `Web/lib/coop-play-view.js`): players looking on your game version, players in a party, and players Steam shows in Slay the Spire 2 right now, with the first faces. The STS2 count and faces come from the roster the app already polls every 30 seconds (`/presence/roster`, signed-in only, `lastFeed` in `script.js`), without you; the sign redraws when it changes (`refreshRoster`). No new server calls.

- The room grows by the sign's height (padding on a content-box room) and the floor starts under it, so the figures keep their size and never stand behind it.
- Every count stands alone, centred over its label; the faces lead the STS2 label in place of its live dot, so the three numbers stand level.
- What the sign shows grows with its width, so nothing wraps, squeezes or is cut: under 270px the counts with short labels; then the live dots and two faces; at 320px four faces; at 520px the long labels. The co-op check in `scripts/verify-ui-next.mjs` measures this at 1728, 1440, 390 and 320px in both looks.
- With nobody around it reads 0, 0, 0. That is the honest picture.
- **Bring someone**: the post drawn as it will read in Discord, with the link's preview card, plus Share to Discord and Copy link. Hidden for a full party and a run under way.
- **Your co-op climbs**: from the player's own saves (`Web/lib/coop-climbs.js`): co-op runs, wins, win rate (wins over every co-op run, abandoned ones included, as on Overview), best floor, the party with the most wins, and the last three co-op runs with each party's climbers.

What a co-op save holds was checked against the game: its run history keeps a list of players (`RunHistoryPlayer`: a 64-bit id, the character, deck, relics), one per player. `sts2-run-parser.js` now keeps `partySize` and `party` (every player's climber, in the file's order). The save does not say which entry is the local player, so:

- the co-op numbers are about the party as a whole and never claim which climber was yours;
- a co-op run's own `character`, deck and relics are still the first listed player's, as they always were. If that is not the local player, the stats tabs attribute the run to the wrong climber. Fixing that needs a real co-op save to confirm how to tell the players apart (the ids are 64-bit, beyond what `JSON.parse` keeps exactly).

The panel always has the same three parts: the four numbers, the party with the most wins standing in a game room (the latest party before any win), and the last three co-op runs drawn with the climbers' sprites. Side by side with "Bring someone" the two panels are the same height and both are filled to the foot: here the room is the part that grows, there the picture in the link's card. In every room (the Play card's too) the seats and climbers stand centred, with as much bare ground on the left as on the right.

## Names are never cut where there is room

Found by the Nov 16 UI audit and fixed in `Web/lib/coop-play-view.js`, `coop-play.js` and `coop-play.css`:

- **Name tags** are sized by script (`fitPartyTags`). A tag is measured in fractions of a pixel and rounded up with one pixel to spare, because a tag 0.3px narrower than its name is drawn as "Ma…". While the room has space, the width is only a floor, so a name that grows later widens its tag. Two climbers standing close push their tags apart by equal amounts instead of shrinking them. Tags are fitted again when any room changes size and when a font finishes loading (`loadingdone`), not only when the whole card resizes.
- **Names stand under the figures** (2026-11-18, the owner: "the names of the players need to be below the cut out not on top"). A tag starts 6px under its figure's feet. The floor keeps a band of the room free below the feet for it (`--cp-tag-band` in `coop-play.css`), and two rows of it when a crowded party stacks its tags (`.is-stacked`, set by `fitPartyTags`), so in a short room the figures stand a little higher instead of the names leaving the frame. The host's crown floats over the host's head (`HEAD_X` in `coop-play-view.js` says where each climber's head is across its picture; measure again if a sprite is redrawn). It is not in the tag: there it made the tag wider and cut "c3rooks" short on a 320px phone.
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
| Push queue: one entry per device, batches of 40, matched → ended → looking | `Backend/src/coop-play-pushq.ts` |
| The devices that can ping a player (pure) | `Backend/src/coop-play-devices.ts` |
| The card (state, polling, actions) | `Web/lib/coop-play.js` |
| Markup per state, and the sign in the room's sky | `Web/lib/coop-play-view.js` |
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
- `node Backend/scripts/verify-coop-play-flow.mjs`: end to end against the local worker. Its ping steps (switched on mid-search, and the seven two-device steps) only run when that worker has VAPID keys; without them they print `skip`. To test pings without touching `Backend/.dev.vars` or the shared 8787 worker, write throwaway keys with `node Backend/scripts/gen-vapid.mjs | grep -E '^VAPID_(PUBLIC_KEY|PRIVATE_JWK)=' > Backend/.wrangler/vapid-test.env`, start the `worker-pings` launch config (port 8827), and run `node Backend/scripts/verify-coop-play-flow.mjs http://127.0.0.1:8827` (24 steps).

**Pings go out in batches.** Cloudflare caps outbound requests per invocation (50 on Workers Free, 1,000 on Paid), and a "someone's looking" ping fans out to every opted-in player. So the Durable Object queues pings (`pushq` in its storage, one entry per player, matched pings ahead of looking ones), sends one batch of 40 in the call that queued them, and drains the rest from its alarm, one batch per second. 120 subscribers take three batches, about two seconds; 1,000 take 25 seconds. The queue rules are pure and covered by `scripts/verify-coop-play.mjs`.
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
- The move from `sub:<steamID>` to a device list on real production records (the code path is unit-tested, but local sandboxes have no old records).
- That the "Party found!" buttons and the "search ended" ping work on a real phone.

## History

The specs for the retired lobby system (`coop-run-lobby-upgrade-plan.md`, `coop-party-room-bridge.md`, `coop-synced-readyup-spec.md`, `coop-daily-challenge-spec.md`, `coop-reputation-spec.md`, `coop-lobby-preflight.md`, …) are kept for reference only; none of that UI exists any more.
