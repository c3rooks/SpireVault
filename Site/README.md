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
| `boot.js` | Runs before first paint: rolls the climber in the hero, marks reduced motion. |
| `script.js` | The climber's line, the live count, download links from the latest GitHub release, the screenshot buttons, scroll reveals. |
| `css/tokens.css` | Design tokens (copied from the app's `Web/styles/src/tokens/tokens.css`) and one block per game room. |
| `css/base.css` | Fonts, reset, focus, reduced motion. |
| `css/components.css` | Nav, buttons, chips, titles, paper cards, the speech balloon. |
| `css/hero.css` | The first screen: room, duel, the hand of stat cards. |
| `css/hero-small.css` | The first screen below 1100px: copy, then the room band, then the hand as a row. |
| `css/sections.css` | Everything below the first screen, in page order. |
| `assets/fonts/` | Self-hosted fonts (OFL), the same three files the app uses. |
| `assets/hero/` | Game rooms and inked figures. Rooms come from `scripts/build-site-backdrops.mjs`. |
| `assets/art/` | Emblem and map icons. |
| `assets/shots/`, `assets/share/` | Pictures of the app and a share card, from `scripts/snap-app-for-site.mjs`. |
| `_headers` | Security headers and the content-security-policy. |
| `_redirects` | `/download`, `/coop`, `/github` shortcuts. |

`/assets/*` is cached for a year, so every asset file carries a version in its
name (`-v1`). Change the picture, change the name. The CSS and JS links share
one `?v=` number; bump it when any of them changes.

## What the page does at runtime

- **Live count.** Every 30 seconds `script.js` reads
  `https://vault-coop.coreycrooks.workers.dev/presence` and shows how many
  players are signed up and how many are in the game.
- **Downloads.** On load it asks GitHub for the latest release, shows its tag,
  and points the download buttons at the installers attached to it. If GitHub
  does not answer, the buttons go to the releases page and no version is shown.
- **The hero.** A climber is rolled per visit and says one of their own lines.

## Checks and captures

```bash
node scripts/verify-site.mjs                 # layout, links, wiring, motion, speed, contrast
node scripts/snap-site.mjs --full --sections # review pictures in docs/screenshots/site/
```

## Deploy

Only when the page has been approved. A deploy never uploads this folder: it
uploads a clean copy of the files the page serves, staged outside iCloud by
`scripts/stage-site.mjs`. This folder also holds the Makefile, this README, the
pictures the GitHub README embeds (`assets/screenshots/`) and a Mac installer,
and none of those are published.

`DMG` says what to do with the Mac installer and has no default, because the
copy in `assets/` is not the file that is live.

```bash
make list                            # the files a deploy would publish
make deploy DMG=none BRANCH=preview  # a preview address, without the installer
make deploy DMG=none                 # production, without the installer
make deploy DMG=/path/to/The.Vault.dmg   # production, with that installer
```

## Content-security-policy

`_headers` allows scripts, styles, fonts and images from this site only, and
network calls to the matchmaking server and the GitHub API. There are no
inline styles or scripts on the page; keep it that way, or the browser will
block them.
