# Site/

Static landing site for **The Vault** — `spirevault.app`.

Pure HTML + CSS + a tiny script. No framework, no build step, no Node runtime
required to ship it. Hosted free on Cloudflare Pages.

## Local preview

```bash
cd Site
make dev          # http://127.0.0.1:8788
```

`make dev` invokes `wrangler pages dev .` (downloaded on demand via `npx`).
Any plain static-file server works too — `python3 -m http.server` for instance.

## Deploy

One-time setup (Cloudflare account + free Pages project):

```bash
npx wrangler login
npx wrangler pages project create vault-site --production-branch main
```

Then publish:

```bash
make deploy       # = wrangler pages deploy . --project-name=vault-site
```

Or wire the repo to Cloudflare Pages from the dashboard — point it at the
`Site/` subdirectory with no build command, and pushes to `main` deploy
automatically.

### Custom domain

In the Cloudflare Pages project → **Custom domains** → add `spirevault.app`.
Cloudflare handles the DNS record + cert automatically when the apex is on
their nameservers.

## What's in here

| File | Purpose |
| --- | --- |
| `index.html`            | The page itself (semantic HTML, accessibility-friendly). |
| `styles.css`            | Hand-rolled dark theme, mirrors the app palette. |
| `script.js`             | Sticky nav, **live presence count** from the Worker, **dynamic DMG link** from the latest GitHub Release. |
| `assets/vault-mark.svg` | Hand-coded brand mark (octagonal vault dial + spire). Used for favicon, nav, hero, footer, social cards. |
| `assets/screenshot-*.svg` | Pre-rendered SVG mockups for first launch. **Replace with real screenshots before going to launch traffic.** |
| `_headers`              | Strict CSP + security headers applied by Cloudflare Pages. |
| `_redirects`            | `/download`, `/coop`, `/github` shortcuts. |
| `wrangler.toml`         | Cloudflare Pages project config (used by `make deploy`). |

## Replacing the SVG mockups with real screenshots

The bundled SVGs are illustrative — they show what the screens *will* look
like. Before driving traffic to the site, swap them for real PNGs taken from
the running macOS app:

1. Run `make run` in `VaultApp/` and capture the Overview, Co-op, and Share
   screens at 2880×1800 (Retina full window).
2. Save them as `screenshot-overview.png`, `screenshot-coop.png`,
   `screenshot-share.png` in `Site/assets/`.
3. Update the three `<img src="…svg">` references in `index.html` to `.png`.
4. `make deploy`.

Optionally also generate `assets/og.png` (1200×630) for the Open Graph card —
the meta tag already references it.

## What the page does at runtime

* **Nav:** sticky, gains a divider once you scroll.
* **Hero CTA + install card:** on page load, `script.js` queries
  `api.github.com/repos/c3rooks/SpireVault/releases/latest`, finds the
  first `.dmg` asset, and rewrites the download links to point at it. If the
  API call fails (rate limit, no release yet), the buttons fall back to the
  releases page so users can still reach the binaries.
* **Live presence count:** every 30 seconds, `script.js` GETs
  `https://vault-coop.coreycrooks.workers.dev/presence` and renders the count
  in two places (the trust line under the hero, and the big card in the Co-op
  section). This is the same public endpoint the macOS app reads. No mock
  data — the number is whatever the live server returns.

## CSP / security

`_headers` sets a strict Content-Security-Policy that only allows scripts
from `'self'`, fonts from Google Fonts, and `connect-src` to the Worker plus
the GitHub API. If you ever add a new external service (analytics, CDN,
embedded video), add the host to the `connect-src` / `script-src` lists.

The site does **not** ship analytics. Cloudflare Pages already provides
unmodifiable per-request logs in the dashboard if you want traffic stats.
