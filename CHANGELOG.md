# Changelog

Notable changes, written like commit notes a person actually wrote.
Dates in YYYY-MM-DD. The project follows [Semantic Versioning](https://semver.org)
loosely — patch bumps for fixes, minor for features, major if I ever
break the wire format.

## v0.5.0 — 2026-05-04

The "stop scrolling, start reading" release. Most of the visible
surface of the web companion got rebuilt around what people actually
do with their run data, plus the long-asked-for cross-device sync.

**New: cross-device run sync via Steam ID.**

- Backend now exposes `GET / POST / DELETE /runs`, all session-bound
  to your Steam ID. Web client uploads the parsed run set after every
  successful import (signed-in users only, guests stay 100% local).
- Mobile / second-browser cold-load reads the cloud copy automatically
  when local IndexedDB is empty — sign in on iOS and your web-uploaded
  runs are already there. No QR pairing, no separate account.
- Server merges deduped by run id, last-write-wins on duplicate ids,
  capped at 2k runs per user. Wire format documented in
  `Backend/src/runs.ts`.

**New: image-rich Share-Run cards.**

- Share modal now loads actual relic icons + card art into the canvas,
  not just text bullets. Pre-loads in parallel with a session-scoped
  cache so a second share is instant. Card thumbnails get a top-biased
  crop so the recognizable art shows, not the description box.
- Modal layout reworked so Download PNG / Copy image / Copy markdown
  stay reachable on every viewport (sticky-bottom action row).

**New: KPI strip + analytics on Overview.**

- Six KPI cards above the winrate hero: current streak, last-10 form
  with sparkline, best streak, PB floor, fastest win, this week with
  delta vs last week.
- New "Trends" panel: rolling-10-run winrate sparkline + floor-death
  histogram showing where runs end most often.

**New: Recent Runs tab.**

- Filter chips (character, outcome, ascension band) + search field.
- Click any run row to open a detail modal with character portrait,
  full stats, every relic with its icon, every card in the final deck
  with its art, and the per-floor card-pick history.

**Major UI redesign.**

- Painted banner shrunk from 400 px → 130 px (~67% smaller). Title
  pinned to bottom-left corner; diorama figures reduced to a small
  detail vignette so the actual content (KPIs, charts, run rows) lives
  above the fold instead of below it.
- Persistent global toolbar above the painted banner: Import, Refresh,
  Export (JSON + CSV), and the linked-folder pill in one always-visible
  row. No more duplicate Import buttons hiding inside individual tabs.
- Compact demo strip on Overview replaces the giant Sample Data card
  that used to repeat on every stats tab. Hides entirely once a save
  folder is linked.

**Auto-refresh fixes.**

- Picking a save folder once is enough; the web companion silently
  re-reads every 60 s when STS2 writes new `.run` files. No more
  re-clicking Import after every game.
- Folder-link state survives reloads (IndexedDB persistence) so the
  "Showing sample data" pill flips to "Linked: <folder>" within one
  frame on cold load.

**Marketing site refresh.**

- Every screenshot on `spirevault.app` re-captured against the v0.5
  redesign. Showcase rail now shows Overview, Share card, Run detail,
  Characters, Recent Runs, and the live co-op feed.
- Feature copy updated to reflect that the web companion now has the
  full run tracker — no more "needs local file access, can't do it in
  the browser" footnote.

## v0.1.0 — 2026-04-30

First public release. Cut the GitHub repo, attached the DMG, pointed
the marketing site at the live release.

What's actually shipping:

- Native macOS app reading the STS2 save folder, parsing every `.run`
  file, and computing local Vault stats (winrate by character, max
  ascension cleared, top relics, ascension progression chart).
- Co-op presence feed: sign in with Steam OpenID, post a heartbeat
  every minute, see who else is online with their tier and reach-out
  handles.
- Share-Run cards: PNG and Markdown summaries of any single run.
- Web companion at `app.spirevault.app` for Windows / Linux users —
  same backend, same live feed, no install.

Known rough edges shipping with v0.1:

- DMG is ad-hoc signed, not notarized. First launch needs a right-click
  → Open. I'm not paying Apple's $99/yr fee while this has zero users.
  If we hit a few hundred installs I'll revisit.
- Skill tier in the co-op feed is currently the user's self-declared
  status, not auto-computed from save data. Auto-computation is the
  obvious next thing.
- Co-op feed has no filter UI yet (by tier, by status, etc.). The list
  is small enough that scrolling works for now; if the user count grows
  past ~50 concurrent it'll need filtering.
- No native Windows build. Web companion covers the use case for now.

## Pre-release iteration log

The path to v0.1 wasn't a single commit. Highlights of what got cut,
broken, and rewritten along the way:

### Architecture pivots

- **Started as an iOS Slay-the-Spire-1 companion.** Originally built a
  full iOS app for the original Slay the Spire with App Store
  screenshots, asset catalogs, the works. STS2 launched, the iOS
  version stopped being relevant, and the old project sat as
  `SlayTheSpire2Companion/` while a real STS2 macOS-native version
  grew alongside it. The iOS code is in this repo's `.gitignore` —
  kept locally for reference, deliberately excluded from the public
  release.
- **Pivoted to "co-op finder + run tracker"** after the first Reddit
  thread made it clear: the community already has stats sites, what
  it doesn't have is a way to find someone to play with. Run tracking
  came along because we were already parsing save files anyway.
- **Decided not to host games.** Considered routing Steam invites
  through a back channel, then realized this is exactly the abuse
  vector Mega Crit avoided by gating co-op through Steam friends. Ate
  the scope cut and built the finder layer instead.

### Auth and privacy

- **Tried JWT-only sessions, scrapped them.** Server-issued tokens
  signed with a worker secret, no Steam round-trip on every request.
  Worked fine, but it meant the server was the source of truth for
  identity and an API-key compromise would let an attacker mint
  sessions for any user. Switched to verifying the Steam OpenID
  signature on every write, with a 30-day session token that can only
  be issued after Valve confirms the openid round-trip. Strictly
  better.
- **Backed out of the Discord login fallback.** Initial design let
  users sign in with Discord OAuth too, since the user typed in a
  Discord handle anyway. Realized this added a whole second auth
  surface to harden, and the value was approximately zero. Cut it.

### UI/UX bugs that took longer than they should have

- **OpenID flow silently broke in Safari.** Worked in Chrome, redirect
  came back, session cookie wouldn't stick. Spent two hours staring
  at the Worker logs before noticing the `SameSite=None; Secure`
  cookie attribute combo wasn't being set. One-line fix.
- **Save folder watcher fired twice on each `.run` write.** Godot
  writes the run file in two passes (data, then atomic rename). The
  watcher was firing on both events. Debounced to coalesce events
  within 250ms, problem gone.
- **Share-Run card text rendering was hairy.** Trying to draw rich
  text into a CGContext at retina scale, with the right line-height,
  with the relic icons inline — finally gave up on the inline icons
  and used a horizontal strip below the body text. Looks better
  anyway.

### Things I considered and didn't ship

- A Discord bot that posts your finished runs to a channel. Cool, but
  scope creep, and feels off-brand vs. the privacy-first positioning.
- A "compete with friends" leaderboard. Same reason — pulls the
  product toward "social network" and away from "find a partner and
  play."
- Auto-DMing players who are looking. Hard no. Too easy to abuse,
  and the whole point is to keep this from being yet another
  matchmaker.

### Why the public commit history starts clean

This file documents the history; the public Git history starts at
v0.1.0 because the pre-release work happened across a private
workspace with experimental directories I didn't want to publish
(old iOS App Store assets, dead ends, prototype code with my
personal save files in test fixtures). What you see in the public
repo is the version I'm willing to stand behind.

If you're curious about a specific decision I haven't documented
here, open an issue and ask.
