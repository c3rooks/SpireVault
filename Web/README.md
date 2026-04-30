# Web/

Browser-only companion for The Vault — `app.spirevault.app`.

Pure HTML + CSS + ES module. **No build step, no framework, no runtime
dependency at all.** Talks to the same Cloudflare Worker the macOS app uses,
so signing in here gives you the same verified Steam identity and the same
presence feed.

## What it does

* **Sign in with Steam** (OpenID 2.0 round-trip via the Worker). 30-day session.
* Render the public **presence feed** of everyone with The Vault open.
* Let the user post their own status (looking / solo / in co-op / AFK), a
  short note, and an optional Discord handle.
* One-click reach-out: open the Steam profile, copy the Discord handle, fire
  a Steam friend request.

## What it does **not** do

* No local STS2 save reading. The web has no filesystem access by design —
  that's the macOS app's job. Web users don't show stats next to their name
  unless they also run the macOS app on the same Steam account.
* No share-run cards (yet). Same reason.
* No analytics, no telemetry, no third-party scripts.

## Running locally

```bash
cd Web
make dev          # http://127.0.0.1:8788
```

For local OpenID to round-trip back to your dev server, sign in once on
production and copy the session token, **or** use the included
`Backend/scripts/smoke-test.sh` to manually exercise the API.

> **Heads up:** the Worker's `safeReturnURL()` allows
> `http://127.0.0.1:*` and `http://localhost:*`, so a local sign-in actually
> works end-to-end if your Worker is deployed and reachable.

## Deploying

```bash
npx wrangler pages project create vault-web --production-branch main
make deploy
```

Then in the Cloudflare Pages dashboard:

1. **Custom domains** → add `app.spirevault.app` (DNS managed by Cloudflare).
2. The Worker also needs to know about this hostname. Either trust the
   built-in allowlist (`app.spirevault.app` is already on it), **or** if you
   self-host on a different domain, set `ALLOWED_RETURN_HOSTS=mywebapp.tld`
   on the Worker (`wrangler secret put ALLOWED_RETURN_HOSTS`).

## Security notes

* The session token is stored in `localStorage` (same as a normal web app).
  It's only sent over HTTPS, only to the Worker. Tab-close fires a best-effort
  `sendBeacon` to the Worker.
* CSP in `_headers` restricts everything to first-party + the Worker
  (`connect-src`) + Steam avatar CDNs (`img-src`). Tightening this further is
  fine; loosening it should be done deliberately.
* The Worker's open-redirect guard (`safeReturnURL`) prevents an attacker
  from harvesting a session by sending a victim through a malicious sign-in
  link. The web app passes its own origin as `return=` so this matters.

## Files

| File          | Purpose |
| ---           | --- |
| `index.html`  | Two views in one: signed-out hero + signed-in feed. JS picks. |
| `auth.html`   | Steam OpenID return target. Validates nonce, stores session, redirects to `/`. |
| `script.js`   | App logic: poll feed, push status, render rows, handle sign-in/out. |
| `styles.css`  | Theming consistent with the macOS app and the marketing site. |
| `_headers`    | Strict CSP + cache headers for Cloudflare Pages. |
| `wrangler.toml` | Pages project config. |
