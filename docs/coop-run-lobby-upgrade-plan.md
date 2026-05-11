# Co-op Run Lobby Upgrade — Plan

Branch: `feature/coop-run-lobbies`
Scope: SpireVault co-op page evolves from a flat presence roster into a
Roblox-style **main lobby + temporary user-created run lobbies** model.

> Local-first implementation. No production deploy. No production KV /
> Durable Object / DNS / secrets touched. Everything below ships behind a
> `make dev` workflow until explicitly authorized.

---

## 1. Current Co-op Architecture (as of `main`)

### Backend (Cloudflare Worker, `Backend/`)
- Single Worker (`vault-coop`), entrypoint `Backend/src/index.ts`.
- One KV namespace binding called `LOBBIES` (legacy name; today it is a
  generic key/value store).
- No Durable Objects.
- Steam OpenID 2.0 sign-in flow (`Backend/src/auth.ts`), session bearer
  tokens stored at `session:<token>` with sliding 30-day TTL.
- Edge-cached public presence (`Cache API`, 15s, `/feed/v4` synthetic key).
- Per-IP and per-user rate limiting via KV sliding-window counters
  (`Backend/src/ratelimit.ts`).

### Data model (current KV)
| Key | Shape | Notes |
|---|---|---|
| `presence:roster` | `{ entries: PresenceEntry[] }` | Single blob, 30d TTL, capped at 200 entries. Persistent presence — users stay on the roster until they explicitly sign out. |
| `session-profile:<sid>` | `{ personaName, avatarURL }` | Cached Steam Web summary, 30d TTL. |
| `session:<token>` | `<sid>` | Bearer → SteamID. |
| `inbox:<sid>` | `{ invites: Invite[] }` | Per-user inbox; payloads stored inline. |
| `outbox-key:<from>:<to>` | `<inviteId>` | 60s dedupe marker. |
| `pairs:roster` | `{ pairs: Record<sid, PairInfo> }` | Symmetric pair map, per-pair 4h TTL pruned at read. |
| `rl:<bucket>:<id>` | `number[]` | Sliding-window rate limiter. |

### Current API routes
| Method | Path | Notes |
|---|---|---|
| GET | `/` | Health check. |
| GET | `/presence` | Public anonymized feed (15s edge cache). |
| GET | `/presence/roster` | Auth, full identity-rich roster. |
| POST | `/presence` | Auth, upsert presence (status/note/discord/stats). |
| DELETE | `/presence` | Auth, remove from roster (sign-out path). |
| GET | `/auth/steam/start` | Begin Steam OpenID. |
| GET | `/auth/steam/callback` | Steam OpenID return. |
| GET/DELETE | `/me` | Session profile (also kills bearer on DELETE). |
| POST | `/auth/diag` | Public diagnostic beacon. |
| GET | `/invites/messages` | Closed catalog of preset messages. |
| POST | `/invites` | Auth, send 1:1 invite. |
| GET | `/invites/inbox` | Auth, your inbox. |
| GET | `/invites/outbox` | Auth, your outbox (currently no-op `[]`). |
| POST | `/invites/:id/accept`/`decline` | Auth, respond. |
| DELETE | `/invites/:id` | Auth, withdraw (currently no-op). |
| DELETE | `/pair` | Auth, end current pair. |
| GET/POST/DELETE | `/runs` | Auth, run history sync. |
| GET/POST/DELETE etc. | `/highlights/...` | Community highlights. |
| POST | `/notify` | Mailing list signup. |
| GET | `/admin/*` | Bearer-gated, 404s when unauthed. |

### Frontend (Pages, `Web/`)
- Plain ES modules — `Web/script.js` (~13.6k lines) is the SPA shell.
- `Web/index.html` `data-tab="coop"` panel renders the flat roster.
- `Web/lib/invites.js` — thin REST client for `/invites/...`.
- Same-origin proxy `Web/functions/api/[[path]].js` forwards `/api/*` to
  the worker and translates the `vault_session` HttpOnly cookie into a
  `Authorization: Bearer …` header.
- Heartbeat is `POST /presence` every 180s while the co-op tab is alive
  (`HEARTBEAT_MS`). Roster poll is `GET /presence/roster` every 30s
  (`POLL_FEED_MS`). Inbox poll is `GET /invites/inbox` every 30s
  (`POLL_INBOX_MS`).
- Auto-AFK after 15 minutes of true tab inactivity (`IDLE_AFK_AFTER_MS`).

### macOS / Windows / overlay
- Native shell embeds the web companion in a `WKWebView` for the data
  tabs. Co-op view in the embedded webview is the *same* DOM as
  `app.spirevault.app`. Our changes propagate to the native app
  automatically; no Swift / Tauri changes needed.

---

## 2. Risks With the Current Flat-Feed Model

| Risk | Manifestation at scale |
|---|---|
| Roster capped at **200** (`MAX_ROSTER_ENTRIES`) and evicts oldest | At 500 online users, ~300 are silently missing. |
| No bucketing by goal/ascension — one long scroll | A20-only players drown in casual learners and vice versa. |
| Status set is too small (`looking / inRun / inCoop / afk`) | "Already paired" cannot be expressed; a user mid-co-op still shows as "in co-op" with no partner context, and they can be re-invited. |
| Invite TTL is **30 min**, dedupe is **60s** | Stale invites linger; one sender carpet-bombs once-per-minute fine. |
| Outbox endpoint returns `[]` always | UI can't show "waiting for player". |
| `withdrawInvite` is a no-op | Senders can't cancel. |
| Pair state is *transactional only on accept* | Race condition: A and B both accept invites from C in the same window — both pairs land, C is "paired with two people". |
| No lobby concept | Players can't advertise "A20 Heart Attempts, 1/2", which is the literal product ask. |
| No recommendations | Recommended Players is currently best-effort client-side sorting (`renderFeed.rank`), with no goal/ascension/voice signal. |
| Presence is persistent (never prunes) | "Stale" indicators are visual only — invites still try to find offline users. |

---

## 3. Proposed New Model

### 3.1 Mental shift
- **Before:** "Who is online?"
- **After:** "Who is looking for the same kind of run as me right now?"

### 3.2 Entities (mirroring the spec)

```
UserPresence      — heartbeat-backed, with run preferences attached
RunLobby          — temporary 2-player group advertising a run goal
JoinRequest       — "I'd like to join your lobby"
CoopInvite        — direct "want to co-op?" (lobby-scoped or 1:1)
CoopSession       — confirmed pairing (post-accept) with TTL 4h
```

### 3.3 KV layout

| Key | Shape | TTL | Notes |
|---|---|---|---|
| `coop:presence:<sid>` | `UserPresence` | 5min | Single key per user, refreshed each heartbeat. |
| `coop:presence:index` | `{ ids: string[], updatedAt }` | 7d | Index of known presence keys (no `list()`). Pruned at read time using each entry's `expiresAt`. |
| `coop:lobby:<lobbyId>` | `RunLobby` | 35min | Sliding TTL on host heartbeat. |
| `coop:lobby:index` | `{ ids: string[], updatedAt }` | 7d | Index of lobby keys. Pruned at read. |
| `coop:lobby:by-host:<hostSid>` | `<lobbyId>` | 35min | Reverse lookup — enforces "one active lobby per host". |
| `coop:invite:<inviteId>` | `CoopInvite` | 3min | TTL = invite TTL. |
| `coop:inbox:<sid>` | `{ inviteIds: string[] }` | 1d | Pointer list, pruned at read. |
| `coop:outbox:<sid>` | `{ inviteIds: string[] }` | 1d | Pointer list. |
| `coop:join:<requestId>` | `JoinRequest` | 3min | |
| `coop:lobby-joins:<lobbyId>` | `{ requestIds: string[] }` | 35min | |
| `coop:user-joins:<sid>` | `{ requestIds: string[] }` | 1d | |
| `coop:session:<sessionId>` | `CoopSession` | 4h | |
| `coop:session-by-user:<sid>` | `<sessionId>` | 4h | Enforces "user in only one session at a time". |
| `coop:decline:<fromSid>:<toSid>` | `{ at: iso }` | 10min | Cooldown after decline. |

All keys are namespaced under `coop:` to avoid colliding with existing
data (`presence:roster`, `inbox:<sid>`, `pairs:roster`, …). The existing
keys keep their semantics so the **old flat-presence path keeps working
for non-upgraded clients** during rollout.

### 3.4 Server consistency strategy

Cloudflare KV is eventually consistent and has no transactions. The
quickest correct path for the data shapes above is a **Durable Object**
that owns the matchmaking state, but adding a DO requires migration of
the `wrangler.toml`, the production binding, and edge-cached paths.
Per the prompt's explicit guidance ("if too risky to implement in one
pass, implement the safest working version") we ship the **KV-based
safe version first**, with the following invariants enforced server-
side, never trusting the client:

1. **Heartbeat-driven freshness.** Every read path re-derives whether
   a user/lobby/invite/request is fresh from `expiresAt + 90s grace`.
   Stale entries are filtered out at read time (no nightly cron needed
   — KV TTLs handle eventual cleanup).
2. **Single-mutation guard.** Each mutation re-reads the target objects
   inside the handler and bails with a friendly 409 if any invariant is
   broken (paired, in another lobby, stale, etc.).
3. **Conflict cancellation on accept.** Accepting an invite or join
   request cancels every other `pending` outgoing invite from caller and
   every `pending` inbound invite/request **for both players**, in a
   single write per affected list. KV racing here results in *at worst*
   one extra "already_resolved" toast — never a double pairing — because
   the *session* key is the source of truth and is set only inside one
   atomic put (`coop:session-by-user:<sid>` is rejected if it already
   exists at read-time).
4. **Pre-pair lock.** Before writing the session keys, we check
   `coop:session-by-user:<sid>` for both sides. If either is non-null,
   we 409. The window between read and write is narrow; the worst
   real-world outcome (sub-100ms) is the second accept landing first
   and the first being told "they're already paired".
5. **Heartbeat-bounded growth.** The presence and lobby indexes are
   pruned to `updatedAt > now - INDEX_TTL_MS` on every write to keep
   list size bounded without a cron job.

If we observe real concurrent abuse (multiple invites racing through),
we can drop in a single `MatchmakingDO` Durable Object behind the same
public API — the routes never change — and migrate the keys with a
one-shot script. **That follow-up is documented in §8 "Future work,"
not blocking this PR.**

### 3.5 Match scoring (see `Backend/src/coop-recommendations.ts`)

```ts
// +40 candidate is looking and active
// +20 ascension ranges overlap
// +15 same goal or either goal === "any"
// +10 voice preferences compatible
// +10 preferred characters overlap
// +10 candidate has Discord if current user prefers voice/Discord
// -100 candidate is paired
// -100 candidate is stale/offline/afk
// -100 candidate is current user
// -50  candidate has recently declined current user
// -25  candidate already has a pending invite from current user
```

Friendly labels surfaced in the UI:
- ≥ 70: "Strong match"
- 40–69: "Good match"
- 10–39: "Different goal"
- < 10: "Recently active"

Recommended Players section caps at 8.

### 3.6 Heartbeat / TTL rules

| Surface | Cadence |
|---|---|
| Client heartbeat | 30s while page visible. Backoff to 5min when hidden. |
| Stale threshold | 90s after last heartbeat → no longer "active". |
| Hidden-from-recs threshold | 180s. |
| Lobby TTL | 30min, refreshed by host heartbeat or lobby activity. |
| Invite TTL | 3min (`COOP_INVITE_TTL_S`). |
| Join request TTL | 3min. |
| Session TTL | 4h (`COOP_SESSION_TTL_S`), unless ended manually. |

### 3.7 New API endpoints (worker)

All new routes are mounted under **`/coop/...`** so they coexist with
the existing `/presence`, `/invites`, `/pair`, `/runs` surfaces:

| Method | Path | Purpose |
|---|---|---|
| GET | `/coop/state` | Bundled state (presence/session/lobby/invites/requests/recs/lobbies). |
| POST | `/coop/presence` | Upsert presence v2 with run preferences. |
| POST | `/coop/heartbeat` | Lightweight presence refresh; also bumps lobby. |
| POST | `/coop/lobbies` | Create lobby. |
| PATCH | `/coop/lobbies/:lobbyId` | Update lobby (host only). |
| POST | `/coop/lobbies/:lobbyId/close` | Close lobby. |
| POST | `/coop/lobbies/:lobbyId/request` | Request to join. |
| POST | `/coop/lobbies/:lobbyId/accept` | Host accepts a request. |
| POST | `/coop/lobbies/:lobbyId/decline` | Host declines. |
| POST | `/coop/lobbies/:lobbyId/cancel-request` | Requester cancels. |
| POST | `/coop/invites` | Send direct invite (lobby or 1:1). |
| POST | `/coop/invites/:inviteId/accept` | Accept invite. |
| POST | `/coop/invites/:inviteId/decline` | Decline invite. |
| POST | `/coop/invites/:inviteId/cancel` | Cancel outgoing invite. |
| POST | `/coop/sessions/:sessionId/end` | End a co-op session. |
| GET | `/coop/recommendations` | Optional standalone recs endpoint. |

The existing routes (`/presence`, `/invites/...`, `/pair`) keep working;
the macOS app and Windows app are unaffected.

### 3.8 Rate limits & abuse protection

| Bucket | Limit |
|---|---|
| `coop-invite-pending` (per user) | 5 pending outgoing invites. |
| `coop-invite-window` | 10 invites per 10 minutes (per user). |
| `coop-join-pending` (per user) | 5 pending join requests. |
| `coop-lobby-active` | 1 active lobby per host. |
| `coop-decline-cooldown` | Per-pair, 10min after a decline. |
| `coop-presence-write` (per IP) | 30/min. |
| `coop-write` (per IP, all) | 120/min. |

Server-side validation rejects HTML/script bytes, clamps note ≤ 160 chars,
clamps lobby title ≤ 80 chars, clamps ascension 0–20, clamps numeric
enums to fixed allow-lists.

---

## 4. UI Plan

Co-op page becomes a four-section vertical stack:

1. **Your Co-op Status** — pinned at top, holds preferences & quick
   actions (Save, Create Run Lobby, Quick Match).
2. **Active Session / Your Lobby / Invites** — context-sensitive.
3. **Open Run Lobbies** — primary browsing surface, sorted by match score.
4. **Recommended Players** — up to 8 cards.
5. **Active Player Feed** — secondary collapsible accordion; replaces the
   old flat roster as the long tail.

Both desktop and mobile share the same DOM. CSS uses existing card
tokens (`me-card`, `feed-empty`, etc.) so the visual language stays
consistent with the rest of the app.

The current flat feed is **kept** as a fallback section underneath
"Recommended Players" so the migration is purely additive — a user
with no friends in lobbies still sees the existing roster.

---

## 5. Local Testing Plan

Three layers:

1. **`Backend/scripts/verify-coop-lobbies.mjs`** — new node script that
   spins up a local `wrangler dev` worker, mints two fake sessions via
   a debug-only seed endpoint (gated by `env.LOCAL_DEBUG`, no-op in
   prod), then exercises:
   - presence upsert/heartbeat
   - lobby create / update / close
   - join request / accept / decline / cancel
   - direct invite / accept / decline / cancel
   - session create on accept (verify single-session invariant)
   - rate limits trigger 429
   - cooldown after decline blocks re-invite
   - sanitization (HTML/script in note/title rejected)

2. **`Backend/scripts/smoke-coop.sh`** — curl-driven smoke against
   `wrangler dev`. Asserts every route returns the right status code
   with no auth, with a valid bearer, and with a stranger's bearer.

3. **Manual UI test plan in §6** that operators can walk through using
   two browsers (or one browser + one private tab) on `localhost:8788`
   (Pages dev) against `localhost:8787` (worker dev).

Acceptance criteria for the PR:
- All `verify-coop-lobbies.mjs` tests pass.
- No regression in `verify-roster.mjs` (existing roster contract intact).
- Steam OpenID still completes end-to-end against `wrangler dev`.

---

## 6. Manual UI Walkthrough

> Two Steam users, A and B. Run `wrangler dev` for `Backend/` and
> `wrangler pages dev` for `Web/`. Open
> `http://127.0.0.1:8788/?coop=1` in two profiles.

1. A signs in → lands on "Your Co-op Status" with status `Looking`.
2. A clicks **Create Run Lobby**, picks `A20 Heart Attempts`, `A20`,
   voice optional. Lobby appears in Open Run Lobbies for both users.
3. B sees A's lobby, scores `Strong match`, clicks **Request to Join**.
4. A's "Your Lobby" card shows pending request from B with avatar.
5. A clicks **Accept** → both sides flip into a co-op session. B's row
   in the lobby browser disappears; an "Active Session with @A"
   replaces B's lobby browser top section. A's lobby moves to
   `status: full` and disappears from public list.
6. Either side clicks **End co-op** → session ends, both go back to
   `Looking`.
7. C signs in. C invites A directly. A is in a session → invite is
   rejected server-side with `they_are_paired`. C sees the friendly
   error toast.
8. C sends 6 invites quickly → 6th hits `Slow down — too many invites`.

---

## 7. Production Deployment Notes (NOT executed in this PR)

When ready to deploy:
1. `wrangler deploy` from `Backend/` — no migration needed, new keys
   simply appear.
2. Bump `Web` cache-bust suffixes (`?v=…`) for the new lobby JS module.
3. Roll forward the `Cache-Control` no-store rule on `/script.js`;
   the new co-op JS is ES-module imported so the cache-bust ripples.
4. Watch `/admin/stats` for `funnel:coop-lobby-create` (new counter).
5. If lobby/invite races become observable in production logs, promote
   `coop:lobby:*` and `coop:invite:*` to a Durable Object. The route
   layer doesn't change.

---

## 8. Future Work (Documented, Not Blocking)

- **Durable Object** for true serialized matchmaking writes — see §3.4.
- Voice signals from STS2 game state (relic/character/ascension) to
  upgrade match scoring.
- Lobby chat — explicitly out of scope (Steam handles real comms).
- Lobby with 3+ members for the eventual STS2 multi-co-op (currently
  caps at 2 because Mega Crit's multiplayer is 2-player).
- Friend system / persistent social graph — explicitly out of scope.
