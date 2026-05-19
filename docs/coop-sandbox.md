# Co-op Lobby Beta — local sandbox harness

Local-only tooling to seed fake users, lobbies, seat requests, and party rooms for QA. **Never deployed to production UI or production KV.**

## Enable

1. Start the worker: `cd Backend && npx wrangler dev --env localdev` (port 8787).
2. Start the web app: `cd Web && npx wrangler pages dev .` (port 8788).
3. Point Pages at the local worker via `Web/.dev.vars`:
   ```
   WORKER_ORIGIN_OVERRIDE=http://127.0.0.1:8787
   ```
4. Open `http://127.0.0.1:8788`, enable **Co-op Lobby Beta**, sign in via dev login or the sandbox panel.

Quick dev login:

```
http://127.0.0.1:8788/api/_dev-login?as=c3rooks
```

Other personas: `Boble`, `Mako`, `Mega`, `IAmWeird`.

The **Dev Sandbox** panel appears bottom-right on localhost when the Co-op Lobby Beta surface is mounted.

## Seed scenarios

| ID | What it sets up |
|----|-----------------|
| **A** | Empty board — only the active persona's presence |
| **B** | Three open lobbies (Mako, Boble, Mega) + c3rooks looking |
| **C** | Current persona hosts `test` (1/4) — verify main board shows your lobby |
| **D** | You host `test`; Boble has a pending seat request |
| **E** | You host `test`; Boble accepted; active Party Room for both |
| **F** | Full 4/4 lobby — Request Seat disabled |
| **G** | Party with members marked `in_game` |

Seed via panel **Seed scenario** or API:

```bash
curl -X POST http://127.0.0.1:8787/_debug/coop-sandbox/seed \
  -H 'content-type: application/json' \
  -d '{"scenario":"E","hostSteamId":"local-corey"}'
```

## Switch personas

Panel **Switch persona** or:

```bash
curl -X POST http://127.0.0.1:8787/_debug/coop-sandbox/act-as \
  -H 'content-type: application/json' \
  -d '{"steamId":"local-boble"}'
```

## Reset

**Reset sandbox** in the panel or:

```bash
curl -X POST http://127.0.0.1:8787/_debug/coop-sandbox/reset
```

Clears sandbox-tracked preview KV keys and localStorage dev keys (see below).

## Production protection

- Worker routes require `LOCAL_DEBUG=1` or `DEV_COOP_SANDBOX=1` **and** a loopback hostname (`127.0.0.1`, `localhost`). Production worker omits these vars → **404**.
- Frontend panel hidden on `spirevault.app` / `app.spirevault.app`.
- `_dev-login` returns 404 when `WORKER_ORIGIN_OVERRIDE` is unset (production proxy).
- Seeded data uses preview KV (`wrangler dev --env localdev`) — not production namespace.

## localStorage keys

| Key | Purpose |
|-----|---------|
| `spirevault.dev.coopSandbox` | `1` when sandbox mode was used this browser |
| `spirevault.dev.activePersona` | Last `local-*` steam id from persona switch |
| `spirevault.dev.seedScenario` | Last seeded scenario id (A–G) |

Existing unrelated keys (`coop_compact`, session token, etc.) are untouched except `vault_session` on reset.

## Hosted lobby on main board

`visibleOpenLobbies()` merges `state.lobby` (your hosted run) into the Open Run Lobbies list when the server excludes it from `openLobbies`. Host cards show **Manage**, **Close**, and **Open Party Room** when a party exists.

## API reference (local only)

- `GET /_debug/coop-sandbox/state`
- `POST /_debug/coop-sandbox/seed` — `{ scenario, hostSteamId? }`
- `POST /_debug/coop-sandbox/reset`
- `POST /_debug/coop-sandbox/act-as` — `{ steamId }` → `{ token, steamID }`

## Dummy personas

| steamId | Name | Default status |
|---------|------|----------------|
| `local-corey` | c3rooks | looking |
| `local-boble` | Boble | looking (Heart A8–A10) |
| `local-mako` | Mako | looking (Casual A0–A3) |
| `local-mega` | Mega | afk |
| `local-iamweird` | IAmWeird | looking |
