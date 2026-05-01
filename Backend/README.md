# vault-coop — Cloudflare Worker

The matchmaking server for **The Vault**. It does one thing: aggregate
**presence** across all signed-in players so the macOS app can render a
"who's around right now and how do I reach them?" feed.

It deliberately does NOT host games, route invites, or model lobbies. STS2
multiplayer goes through Steam friends — the Worker just helps two players
*find each other* before that handoff.

Runs on Cloudflare's free tier (100k requests/day). For an STS2-mod-sized
audience this is permanently free; even a viral moment would cost a few
dollars per month at most.

---

## What it stores

KV (`LOBBIES` namespace, name kept for backward compat):

| Key                              | Value                         | TTL    | Purpose                             |
| -------------------------------- | ----------------------------- | ------ | ----------------------------------- |
| `session:<token>`                | verified SteamID64            | 30 d   | bearer auth                         |
| `session-profile:<steamID>`      | `{ personaName, avatarURL }`  | 30 d   | render persona w/o re-hitting Steam |
| `presence:roster`                | `{ entries: PresenceEntry[] }`| 30 d   | the public co-op feed               |
| `user:<steamID>`                 | `"1"`                         | none   | ever-signed-in marker (forever)     |
| `user-meta:<steamID>`            | `{ persona, firstSeen, lastSeen }` | none | persona history                |
| `signin:<ISO>:<steamID>`         | `"1"`                         | 30 d   | recent-sign-ins event log           |
| `seen:<YYYYMMDD>:<steamID>`      | `"1"`                         | 10 d   | DAU rollup                          |
| `funnel:start:<YYYYMMDD>`        | counter                       | 90 d   | "Sign in with Steam" clicks         |
| `funnel:cb-attempt:<YYYYMMDD>`   | counter                       | 90 d   | OpenID callbacks received           |
| `funnel:cb-ok:<YYYYMMDD>`        | counter                       | 90 d   | successful Steam verifications      |
| `funnel:cb-fail:<reason>:<day>`  | counter                       | 90 d   | callback failures by reason         |
| `funnel:diag:<reason>:<day>`     | counter                       | 90 d   | client-side bounces (in-app browser, etc) |
| `funnel:diag-ev:<ISO>:<reason>`  | detail string                 | 30 d   | recent diag events with user agent  |
| `funnel:roster-first:<steamID>`  | ISO timestamp                 | none   | first time on roster (forever)      |

Nothing private — every field originates either from the user's own input
(status / note / Discord handle) or from the public Steam Web API. There is
no run history, deck data, payment info, or moderation log.

## Persistence model — "everyone who signs in is on the feed forever"

Steam-authed users land on the roster the moment OpenID verification
succeeds (server-side, before the browser even bounces back to the
client) and **stay there until they explicitly sign out**. Closing the
tab, sleeping the laptop, putting the phone down — none of that removes
them. The feed is a living roster of everyone who's ever signed up, not
a "who's tapping keys this exact second" list.

Two safety nets keep the roster bounded:

1. **`MAX_ROSTER_ENTRIES = 200`** — when the roster fills, the entries
   with the oldest `updatedAt` get evicted to make room for newer
   activity. New arrivals always get in; the most stale signups roll
   out as the new ones roll in.
2. **`ROSTER_TTL_SECONDS = 30 days`** — the blob is re-written on every
   heartbeat, restarting its TTL. Only triggers if literally nobody
   heartbeats for 30 straight days.

If a user disappears from the feed, the cause is one of (in order):
explicit DELETE /presence (sign-out button), explicit eviction by
roster cap, or 30-day total quiet across all users. Nothing else.

## Observability — "did people actually try to sign in?"

The single most important question a launch-day operator asks is "I have
2,000 page views, why do I only see N users?" The full answer lives in
the `/admin` dashboard (bearer-gated, indistinguishable from any other
404 to the public).

The funnel surfaces a per-day breakdown:

```
clicked sign in  →  back from steam  →  verified  →  on roster
```

If `clicked sign in` is high but `back from steam` is low, users are
bouncing AT Steam (closed tab, blocked at school, etc).
If `back from steam` is high but `verified` is low, Steam is rejecting
us (rare; check `funnel:cb-fail:*` for reasons).
If `verified` is high but `on roster` is low, KV writes are failing
during auth — `funnel:cb-fail:auto-roster-failed` will be non-zero.
If everything is high but client-side `funnel:diag:nonce-missing` is
also high, in-app browsers (Reddit, X, Facebook) are stripping
sessionStorage across the OpenID redirect — the most common silent
failure mode.

The dashboard also lists every Steam user who has ever signed in
(persona + first/last seen + on-roster flag) so you can answer
"did Player X actually try?" with proof.

## One-time setup

```bash
cd Backend
npm install
npx wrangler login

# 1) Create the KV namespace; paste both IDs into wrangler.toml
npx wrangler kv:namespace create LOBBIES
npx wrangler kv:namespace create LOBBIES --preview

# 2) Steam Web API key (https://steamcommunity.com/dev/apikey)
npx wrangler secret put STEAM_WEB_API_KEY

# 3) Deploy
npm run deploy
```

After deploy your Worker is live at
`https://vault-coop.<your-subdomain>.workers.dev`. Set that URL as
`PUBLIC_BASE_URL` in `wrangler.toml`, then redeploy so OpenID round-trips
back to the right host.

## Wiring The Vault to it

1. Open `VaultApp/App/Coop/AppConfig.swift`.
2. Replace `defaultServerURL` with your deployed Worker URL.
3. Rebuild The Vault. End users never have to configure anything — they
   just sign in with Steam.

Power users can override under **Settings → Co-op matchmaking → Advanced**.
That escape hatch is for forks, private groups, and contributors testing
their own Worker deployment.

## Routes

| Method | Path                            | Auth     | Purpose                                |
| ------ | ------------------------------- | -------- | -------------------------------------- |
| GET    | `/`                             | public   | health check                           |
| GET    | `/presence`                     | public   | list everyone currently online         |
| POST   | `/presence`                     | session  | upsert your presence (heartbeat)       |
| DELETE | `/presence`                     | session  | drop your presence (sign-out)          |
| GET    | `/auth/steam/start?return=&nonce=` | public | Steam OpenID kickoff                   |
| GET    | `/auth/steam/callback?...`      | public   | Steam OpenID return target             |

`session` routes require `Authorization: Bearer <token>` issued by
`/auth/steam/callback`. The Worker resolves the token to a verified SteamID
server-side and ignores any SteamID the client tries to put in the body.

### `return` URL allowlist

The `?return=` parameter on `/auth/steam/start` is **allowlisted** so a
malicious link can't harvest sessions to a domain you don't control. Allowed
by default:

- `thevault://*` — macOS app custom scheme
- `https://app.spirevault.app/*` — official web companion
- `http://127.0.0.1:*` and `http://localhost:*` — local dev

If you self-host the web companion on a different domain, set the optional
secret/var `ALLOWED_RETURN_HOSTS=mydomain.tld,another.tld` and those hosts
become valid `return` targets. Anything else gets coerced to the safe
macOS-app default.

## Anti-abuse posture

- **No mocks anywhere.** No seed data, no fixtures, no offline simulator.
  The feed is the unfiltered, live KV listing — empty if nobody's online.
- **Identity is server-verified.** SteamID is set by Steam OpenID, never by
  the client. Persona name + avatar are pulled from Steam at sign-in time
  and pinned in KV; the client cannot overwrite them.
- **Heartbeat-driven liveness.** Presence entries auto-expire after 5 min
  with no heartbeat. A crashed/quit client cannot leave a stale ghost.
- **Stateless.** Everything lives in KV with TTLs; nothing to compromise.
- **Rate-limited by design.** A single SteamID can only have one presence
  entry; re-POST replaces. KV writes are cheap but capped.
- **API key never leaves the Worker.** The Steam Web API key is a
  Cloudflare secret; the macOS app never sees it.
- **Open & forkable.** If the maintainer disappears, anyone can deploy this
  same Worker code, change one line in The Vault's `AppConfig.swift`
  (or use the Settings override), and the community keeps playing.

## Operator runbook — "the feed looks wrong, what do I check?"

Common scenarios and the exact thing to check first.

### "I have lots of page views but the roster only has me + 1 friend"

This is the most common "is it broken?" question, and almost always the
answer is **mobile in-app browsers stripping sessionStorage** — Reddit,
X, Facebook, Instagram, TikTok and Discord all open links inside their
own webviews, and several of those silently break OpenID flows.

1. Pull live roster:
   ```bash
   curl -s https://vault-coop.coreycrooks.workers.dev/presence | jq .
   ```
2. Open `/admin` (bearer-gated):
   - Look at the **Sign-in funnel · today** card.
   - High `Clicked sign in` and low `Verified by Steam` → users are
     bouncing through Steam, almost always in-app browsers.
   - The **Where people are getting stuck** section breaks failures down
     by reason. `nonce-missing` and `inapp-browser-detected` confirm the
     in-app browser theory.
3. The signed-out hero already shows an "open in Safari/Chrome" warning
   when the UA matches a known in-app browser; nothing for you to do.

### "User Player X says they signed in but they're not on the feed"

1. Open `/admin` → the **Every Steam user who has signed in** table.
2. Search the persona name. If they're there, the row says whether
   they're currently `on roster` or `off roster`.
   - **on roster** → ask them to refresh; they exist, the feed is just
     stale on their side. Edge cache is 15s.
   - **off roster** → they signed in but their roster row was evicted.
     Either they hit the 200-entry cap (rare; needs 200+ users) or they
     hit Sign Out at some point.
3. If they're NOT in the table, they never finished OpenID. Check
   the recent diagnostic events table for `nonce-missing` or
   `nonce-mismatch` near the time they tried.

### "Two players say they can't see each other"

1. Pull `/presence` from both their colos by curling from each location.
   If both responses contain both Steam IDs, the server is fine and the
   client is the issue (browser cache, JS error, broken localStorage).
2. If one colo's response is missing entries, KV is eventually
   consistent — wait 60s and re-pull. The edge cache is 15s and KV
   propagation is typically <30s; sustained inconsistency is unusual.
3. Check `/admin` → `presence-read-failed` counter. If non-zero, KV is
   failing reads and the worker's failing open with an empty array.

### "I want a snapshot of who's currently signed in, right now"

```bash
curl -s https://vault-coop.coreycrooks.workers.dev/presence | jq '.[] | "\(.personaName)  \(.steamID)  \(.updatedAt)"'
```

Or hit `/admin` for the rendered version with last-heartbeat times.

### Verifying everything still works end-to-end

There's a Playwright test that exercises persistence + multi-browser
visibility against the live deploy in `/tmp/sv-roster-verify/test.mjs`
(committed copies live in the local audit folder). It:

- Confirms the roster has real users
- Confirms identical snapshots from two cold-loaded browsers
- Confirms users last seen >1h ago are still listed (proves persistence)
- Confirms /auth/steam/start redirects to Steam (funnel counters bump)
- Confirms /auth/diag accepts client-side beacons

Re-run after any backend change you're nervous about.

### Silent failure modes already caught (so you don't get burned again)

Three categories of "the feed is empty even though users exist" bugs have
hit production. Each one was invisible from the dashboard while it was
happening, which is exactly why they're listed here.

1. **Fire-and-forget KV writes outside `ctx.waitUntil`.** Cloudflare
   Workers terminate any unawaited promise the moment the request handler
   returns its `Response`. Funnel counters, sign-in events, and roster
   markers all silently dropped on the floor for weeks before this was
   spotted. Fix: every background side effect goes through the `bg(ctx, p)`
   helper in `src/index.ts`. If you add another counter, use `bg`.

2. **`bumpCounter` with `cacheTtl: 0`.** Cloudflare's KV `get()` rejects
   `cacheTtl < 60` silently — the read returns `null` instead of throwing,
   so the increment did `null + 1 = 1` repeatedly and counters never
   moved past 1. Fix: never pass `{ cacheTtl: 0 }` to KV reads. The default
   is fine.

3. **Roster blob shape drift.** The canonical storage shape is
   `{ entries: PresenceEntry[] }`. A cleanup script once wrote a bare
   `PresenceEntry[]` to `presence:roster`. Old `readRoster` cast the array
   as Roster, so `roster.entries` resolved to `Array.prototype.entries`
   (a function), `function.length === 0`, and the worker returned `[]` to
   every client without ever throwing. Real users were on the roster but
   the public feed was permanently empty. Fix: `readRoster` now normalizes
   both shapes and filters non-conforming entries; `writeRoster` always
   serializes the canonical shape. If you must edit the roster manually,
   write `{"entries": [...]}` — never a bare array.

4. **CORS wildcard breaking `sendBeacon`.** `navigator.sendBeacon` always
   includes credentials. Browsers reject `Access-Control-Allow-Origin: *`
   responses to credentialed requests, so the diagnostic beacon from the
   real web app was being silently rejected by the browser before it ever
   reached the worker. Fix: `corsHeadersFor(req)` echoes the actual origin
   for known origins (`app.spirevault.app`, `spirevault.app`, localhost)
   and pairs it with `Access-Control-Allow-Credentials: true`. Random
   origins still get `*` for public reads, just without credentials.

## Cost — for real, what does this run?

Cloudflare free tier:
- **Workers**: 100,000 requests/day
- **KV reads**: 100,000/day; writes 1,000/day; storage 1 GB
- **Workers cache**: free

Worst-case math for 200 concurrent users polling every 12 s + heartbeating
every 2 min: ~1.5M requests/day → ~$5/mo on the Workers paid tier (and
KV bumps to $0.50 per million reads). For an STS2 mod's actual audience
(~tens of users) you stay on free tier indefinitely.
