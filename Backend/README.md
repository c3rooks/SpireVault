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

| Key                          | Value                       | TTL    |
| ---------------------------- | --------------------------- | ------ |
| `session:<token>`            | verified SteamID64          | 30 d   |
| `session-profile:<steamID>`  | `{ personaName, avatarURL }`| 30 d   |
| `presence:<steamID>`         | `PresenceEntry` JSON        | 5 min  |

Nothing private — every field originates either from the user's own input
(status / note / Discord handle) or from the public Steam Web API. There is
no run history, deck data, payment info, or moderation log.

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

## Cost — for real, what does this run?

Cloudflare free tier:
- **Workers**: 100,000 requests/day
- **KV reads**: 100,000/day; writes 1,000/day; storage 1 GB
- **Workers cache**: free

Worst-case math for 200 concurrent users polling every 12 s + heartbeating
every 2 min: ~1.5M requests/day → ~$5/mo on the Workers paid tier (and
KV bumps to $0.50 per million reads). For an STS2 mod's actual audience
(~tens of users) you stay on free tier indefinitely.
