# SpireVault Discord LFG Bridge Bot

A minimal Discord bot that lets players mirror an LFG message from an
approved Discord channel into the SpireVault co-op lobby surface as
an ephemeral "via Discord" card. The card auto-expires after 30
minutes (matching real LFG-post lifetimes) and links back to the
original Discord message.

This is the single biggest cold-start unlock for SpireVault co-op:
once the bot is live in an active LFG channel, the SpireVault lobby
list is never empty during peak hours, and every visitor lands on a
page that demonstrably ferries them straight to people looking to
play right now.

## What it does

When a Discord user right-clicks any message in an enabled channel
and selects **Apps → Mirror to SpireVault**:

1. The Discord client fires a signed interaction at the SpireVault
   worker (`POST /discord/interactions`).
2. The worker verifies the Ed25519 signature against the bot's
   public key.
3. The worker checks the channel against the per-guild allowlist.
4. The worker calls `createMirror` (in `Backend/src/coop-mirror.ts`)
   to store an ephemeral mirrored-lobby record in KV, keyed by the
   Discord message id (so re-mirroring is idempotent).
5. The worker replies ephemerally to the Discord user with a link
   to the live SpireVault lobby surface.
6. Within 30 seconds, every SpireVault visitor sees the bridged
   LFG post as a "via Discord" card with parsed ascension /
   character / voice / seats hints.
7. After 30 minutes (or earlier if the bot calls `DELETE`), the
   mirror disappears from the lobby surface.

There is **no message-content scraping**. The bot never sees a
message unless a user explicitly invokes the command on it.

## What it does NOT do

- Does not read or store messages from non-enabled channels.
- Does not store the message anywhere except SpireVault's own KV.
- Does not link Discord identity to Steam identity.
- Does not write back into Discord channels (the only reply is the
  ephemeral acknowledgement, visible to the invoking user only).
- Does not run on a persistent server. Everything is Cloudflare
  Workers (free tier) — no VPS, no Docker, no monitoring overhead.

---

## One-time setup

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New
   Application** → name it `SpireVault LFG Bridge`.
2. **General Information** tab — copy:
   - Application ID → `DISCORD_APPLICATION_ID`
   - Public Key → `DISCORD_PUBLIC_KEY`
3. **Bot** tab → **Add Bot** → **Reset Token** → copy:
   - Token → `DISCORD_BOT_TOKEN`
4. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: none required (we use interaction webhooks)
   - Copy the generated URL and use it to invite the bot to your
     test server. **Do NOT** invite it to the official STS Discord
     until you have mod approval (see "Mod pitch" below).

### 2. Configure the worker

From the `Backend/` directory:

```sh
echo -n "<your_public_key>" | wrangler secret put DISCORD_PUBLIC_KEY
echo -n "<random_long_secret>" | wrangler secret put DISCORD_BOT_SECRET
```

`DISCORD_BOT_SECRET` is only needed if you plan to also use the
Node.js bot path (`POST /coop/mirror` with shared secret). For
pure-webhook deployments, only `DISCORD_PUBLIC_KEY` is required.

### 3. Set the Interactions Endpoint URL in Discord

1. Open your application in the Discord dev portal.
2. **General Information** → **Interactions Endpoint URL**:
   `https://vault-coop.coreycrooks.workers.dev/discord/interactions`
   (substitute your worker's URL if different).
3. Click **Save Changes**. Discord will POST a signed PING to your
   endpoint to verify it works. If the save fails, the worker
   logs the verification attempt (likely cause: wrong public key).

### 4. Register the slash command + context menu

```sh
cd Bot
export DISCORD_APPLICATION_ID=...
export DISCORD_BOT_TOKEN=...
export DISCORD_GUILD_ID=<your_test_guild_id>   # optional, for guild-scoped registration

npm run register:guild     # instant propagation in the test guild
# OR
npm run register           # global registration (up to 1h propagation)
```

Two commands are installed:

- **`Mirror to SpireVault`** — right-click any message → Apps menu.
- **`/spire-mirror message:"..."`** — slash command for typing in chat.

### 5. Enable specific channels

By default, the worker rejects mirror attempts from every channel
to prevent accidental cross-server leakage. Mods must opt in each
channel. Until the operator endpoint lands (`v0.12.1`), the
allowlist is edited directly via wrangler:

```sh
cd Backend
wrangler kv key put --binding=LOBBIES --remote \
  "mirror:allow:<guildId>" \
  '{"channelIds":["<lfgChannelId>"]}'
```

Multiple channels → add more ids to `channelIds`. Removing a
channel → write back the JSON without that id.

### 6. Verify

```sh
cd Bot
export API_BASE=https://vault-coop.coreycrooks.workers.dev
export DISCORD_APPLICATION_ID=...
export DISCORD_BOT_TOKEN=...
export DISCORD_GUILD_ID=<your_guild_id>   # optional
npm run verify
```

All checks should be green. If any fail, the script prints the
exact remediation.

### 7. Test in your test guild

In a channel that's on the allowlist:

1. Post a message like `LFG A10 Silent, +1 wanted, voice optional`.
2. Right-click → **Apps** → **Mirror to SpireVault**.
3. You should see an ephemeral reply with a SpireVault link.
4. Open <https://app.spirevault.app/?tab=coop> → the mirrored
   card appears within 30 seconds.

---

## Kill switches

If the bot misbehaves or the mods ask to disable it:

```sh
cd Bot
npm run kill -- pause-writes        # bot can't create new mirrors
npm run kill -- pause-interactions  # Discord webhook returns 401
npm run kill -- drain-now           # nuke all live mirror cards
npm run kill -- status              # show current state
```

These commands PRINT the exact `wrangler` invocations to execute;
they do not run automatically. This is intentional — every kill
action is a deliberate, traceable shell command.

---

## Mod pitch (for the Slay the Spire / STS2 Discord moderators)

Copy-paste this into a DM to a mod or post in `#moderator-questions`:

> Hi — I built SpireVault (<https://app.spirevault.app>), the
> companion app for STS2 co-op. I'd like to ask permission to
> install a small bot in the LFG channel that would let players
> mirror their LFG posts into SpireVault's lobby finder as
> ephemeral "via Discord" cards (auto-expire after 30 min).
>
> The bot is **read-only and explicit-action only**: it never
> scrapes channel messages. It only sees a message when a user
> right-clicks it and explicitly selects "Mirror to SpireVault"
> from the Apps menu. There is no MESSAGE_CONTENT intent
> required and the bot's permission set is the minimum Discord
> allows.
>
> The full source is here: <https://github.com/coreycrooks/SlayTheSpireApp/tree/main/Bot>
> and the worker-side endpoint that receives the interactions is
> here: <https://github.com/coreycrooks/SlayTheSpireApp/blob/main/Backend/src/discord-interactions.ts>
>
> Why this is useful for the server: LFG posts in Discord scroll
> off in 30 minutes anyway. By mirroring them into SpireVault,
> they ALSO surface to players who aren't on Discord at that
> moment but ARE actively browsing for a co-op partner — which
> drives more people back to your server, since every mirror
> links back to the original Discord message.
>
> I have multiple kill switches (per-channel, per-bot, per-guild,
> drain-now) that I can invoke instantly if anything goes wrong,
> and the bot is happy to operate in a single channel only.
> Happy to demo in a test channel first.
>
> What permissions would you need me to demonstrate / change
> before approving this for the real LFG channel?

---

## Architecture quick-reference

```
┌────────────────────┐    interaction (signed)    ┌──────────────────────┐
│  Discord client    │ ─────────────────────────> │  Cloudflare Worker   │
│  (right-click msg) │                            │  /discord/interactions │
└────────────────────┘                            │  (verifies Ed25519)  │
                                                  └──────────┬───────────┘
                                                             │
                                                             v
                                                  ┌──────────────────────┐
                                                  │  createMirror()      │
                                                  │  Backend/src/        │
                                                  │  coop-mirror.ts      │
                                                  │  → KV write,         │
                                                  │    dedup by msg id,  │
                                                  │    30-min TTL        │
                                                  └──────────┬───────────┘
                                                             │
                                                             v
                                                  ┌──────────────────────┐
┌────────────────────┐    GET /coop/mirrors       │  Cloudflare KV       │
│  SpireVault web UI │ <───────────────────────── │  (mirror:* prefix)   │
│  (party-finder-    │                            └──────────────────────┘
│   mirror-rt.js)    │
└────────────────────┘
```

KV namespaces used (all under the existing `LOBBIES` binding, so no
new wrangler config needed):

- `mirror:lobby:<mirrorId>` — the mirror record itself (30-min TTL)
- `mirror:dedup:<discordMessageId>` — message-id → mirrorId (30-min TTL)
- `mirror:index` — list of active mirror ids (24h TTL, swept on read)
- `mirror:allow:<guildId>` — per-guild channel allowlist (no TTL)

## Future work

- **v0.12.1**: Replace direct wrangler kv writes for the allowlist
  with an authenticated `/admin/mirror-allow` endpoint so mods can
  toggle channels without shell access.
- **v0.12.2**: Bot REST API call to fetch channel name for prettier
  display (currently shows `discord` as fallback).
- **v0.13.0**: Two-way bridge — SpireVault host clicks "post to
  Discord" and the bot posts back as the host (with consent prompt).
