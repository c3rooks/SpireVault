# Site/

The landing page for **SpireVault**: `spirevault.app`.

Plain HTML, CSS and one small script. No framework and no build step. Hosted
on Cloudflare Pages (project `vault-site`). It is a separate deploy from the
web app in `Web/` (`app.spirevault.app`).

Everything in this folder is published. Do not leave scratch files here.

## Preview

```bash
/opt/homebrew/opt/node@24/bin/node scripts/dev-site.mjs      # http://127.0.0.1:8791
```

`dev-site.mjs` serves this folder with its real `_headers` (so the
content-security-policy applies locally too) and its `_redirects`.

## What is in here

| File | Purpose |
| --- | --- |
| `index.html` | The page. Semantic HTML, no inline styles or scripts. |
| `boot.js` | Runs before first paint: rolls which climber's card is featured in the hero, marks reduced motion. |
| `script.js` | The featured climber's line, the live count, download links from the latest GitHub release, the screenshot buttons, scroll reveals. |
| `css/tokens.css` | Design tokens (copied from the app's `Web/styles/src/tokens/tokens.css`). |
| `css/base.css` | Fonts, reset, focus, reduced motion. |
| `css/components.css` | Nav, buttons, chips, titles, section surfaces and the heading rows. |
| `css/hero.css` | The first screen: the words, one featured climber card and the hand of the other five. |
| `css/sections.css` | Setup, what you get, co-op. |
| `css/sections-lower.css` | Privacy, downloads, questions, the closing call, the footer. |
| `assets/fonts/` | Self-hosted fonts (OFL), the same three files the app uses. |
| `assets/art/` | Emblem, map icons, and `epoch/`: paintings from the game (its timeline portraits), at their own size (`-2x`), half size (`-1x`) and 560px for the hand. |
| `assets/shots/`, `assets/share/` | Pictures of the app and a share card, from `scripts/snap-app-for-site.mjs`; `coop-party-*` is cut from `docs/screenshots/coop-play/`. |
| `_headers` | Security headers and the content-security-policy. |
| `_redirects` | `/download`, `/coop`, `/github` shortcuts, and the old installer address to the GitHub releases page. |

`/assets/*` is cached for a year, so every asset file carries a version in its
name (`-v1`). Change the picture, change the name. The CSS and JS links share
one `?v=` number; bump it when any of them changes.

No picture is drawn larger than half its own pixels, so everything is sharp on
a 2x screen; `scripts/verify-site.mjs --only sharp` fails if one is. The game's
character sprites are too small for a landing page and are not used here.

## What the page does at runtime

- **Live count.** Every 30 seconds `script.js` reads
  `https://vault-coop.coreycrooks.workers.dev/presence` and shows how many
  players are signed up and how many are in the game.
- **Downloads.** On load it asks GitHub for the latest release, shows its tag,
  and points the download buttons at the installers attached to it. If GitHub
  does not answer, the buttons go to the releases page and no version is shown.
- **The hero.** One of five climbers is featured per visit, with one of their own lines; The Fool is always in the hand.

## Checks and captures

```bash
node scripts/verify-site.mjs                 # layout, links, wiring, motion, speed, contrast
node scripts/snap-site.mjs --full --sections # review pictures in docs/screenshots/site/
```

## Deploy

Only when the page has been approved. A deploy never uploads this folder: it
uploads a clean copy of the files the page serves, staged outside iCloud by
`scripts/stage-site.mjs`. This folder also holds the Makefile, this README, the
pictures the GitHub README embeds (`assets/screenshots/`) and an old Mac
installer, and none of those are published. Downloads come from the GitHub
release; the installer's old address redirects there.

```bash
make list                   # the files a deploy would publish
make deploy BRANCH=preview  # a preview address
make deploy                 # production
```

## Content-security-policy

`_headers` allows scripts, styles, fonts and images from this site only, and
network calls to the matchmaking server and the GitHub API. There are no
inline styles or scripts on the page; keep it that way, or the browser will
block them.
