# Changelog

Notable changes, written like commit notes a person actually wrote.
Dates in YYYY-MM-DD. The project follows [Semantic Versioning](https://semver.org)
loosely — patch bumps for fixes, minor for features, major if I ever
break the wire format.

## v0.9.1 — 2026-05-10

Settings collapse into the persona pill, and Run Coach lands in the
**web app** — same Cluely-style floating chat as the desktop, now
rendered inside a real native always-on-top window via the
Document Picture-in-Picture API.

**Settings → persona menu (web + macOS).**

- The standalone "Settings" sidebar row is gone in both apps. Clicking
  your Steam name / persona pill at the bottom of the sidebar now
  opens a menu with Settings, Beta features, Open Co-op, and Sign out.
  Two persistent footer surfaces (the pill + the Settings tab) collapse
  into one place where everything "about you" lives.
- Guests still need Settings (folder linking, import, prefs) without
  Steam — the web app exposes a tiny inline "Settings" link inside the
  guest sign-in pill, and the macOS guest pill grows a Settings + Beta
  shortcut row.

**New: Run Coach in the web app (Beta · Chromium browsers).**

- New `Beta` tab in the web sidebar. Hosts the Run Coach config:
  provider (OpenAI / Anthropic), model, BYO API key, "include a
  screenshot with each question" toggle, optional custom system
  prompt, and a one-button **Launch Run Coach**.
- Launching opens a real native always-on-top OS window via
  `documentPictureInPicture.requestWindow()` — sits on top of every
  window including fullscreen STS2 on Chromium.
- Same Cluely-style chat as the desktop: header pill with Vault
  emblem, quick-action chips (What should I do? · Next encounter ·
  Recap), text input, screenshot toggle, send button. Submitting a
  message captures the screen via `getDisplayMedia()` (downscaled to
  1280px JPEG) and sends it with the prompt directly to the chosen
  provider — Vault never proxies the request and never sees the key.
- Streamer privacy disclosure is unmissable: the browser overlay is
  visible to OBS / QuickTime (no `NSWindow.sharingType` equivalent in
  the browser). The Beta tab tells the user this, and CTAs the macOS
  build for streamers.

**Browser support.**

- Document PiP works on Chrome, Edge, Brave, Opera, Arc, Vivaldi
  (~75% of users). Safari and Firefox don't ship the API yet — the
  Beta tab detects the gap and shows a graceful "open in Chromium or
  install the macOS app" message instead of a broken Launch button.
- Same fallback if `getDisplayMedia()` is missing (sandboxed iframes,
  some in-app browsers).

**Plumbing.**

- `Web/run-coach.js` is a self-contained module that owns the Beta
  tab + the Document PiP overlay window. State lives in
  `localStorage` under `vault.runcoach.*` (key, provider, model,
  prefs); the page warns that the browser doesn't have a Keychain.
- Cache-bust bumps: `script.js?v=143`, `run-coach.js?v=1`.

## v0.9.0 — 2026-05-10

The "Run Coach" release. The macOS overlay grew into a Cluely-style
in-game AI panel that can look at your screen and coach a card pick,
boss relic, or path choice — using your own OpenAI / Anthropic key.
Lives behind a new **Beta** sidebar tab; deliberately not on the
marketing site until it's proven in real runs.

**New: Run Coach overlay (Beta).**

- Cluely-inspired floating panel: a slim pill at the top of the screen
  with the Vault emblem + "Coach" trigger, expanding into a 360×460
  chat surface with action chips (Assist · What should I do? · Recap),
  text input, and a screenshot toggle.
- ⌘↵ from anywhere inside the panel triggers "What should I do?" —
  captures the active display (CGDisplayCreateImage, downscaled to
  ~1280px), sends it with your typed question + tagged run context to
  the configured provider.
- Bring-your-own-key. OpenAI (`gpt-4o-mini` default) or Anthropic
  (`claude-3-5-sonnet-20241022` default). The user's key is stored in
  the macOS Keychain (`com.coreycrooks.thevault.overlay`); The Vault
  servers never see it.
- Streaming-safe defaults: hidden from screen recording / OBS / Zoom
  via `NSWindow.SharingType.none`. Always-on-top toggle for fullscreen
  STS2. All three flags exposed in Beta → Privacy & visibility.
- Optional custom system-prompt addendum so power users can bias the
  Coach toward their character / ascension / build.
- Local run history (last 3 runs + Steam stats when available) is
  passed as compact context so the Coach isn't completely cold.
- Live test panel inside Beta verifies key + provider without
  launching the overlay.

**New: Beta sidebar section.**

- Dedicated home for early features. The first inhabitant is Run
  Coach. Old Settings → "In-game overlay" toggle moved to Beta;
  Settings now focuses on stats + matchmaking only.
- "NEW" pill on the sidebar row until the user opens it.

**Marketing site.**

- Pulled the "Run Companion Overlay" feature card off the landing
  page. Run Coach is shipped through Beta-tab opt-in, not as a
  homepage promise.
- Hero "Download .dmg" button continues to auto-resolve to the latest
  GitHub Releases asset, so the site picks up v0.9.0 the moment the
  release is cut.

**Bumps.**

- `CFBundleShortVersionString` → 0.9.0; `CFBundleVersion` → 9.
- Forward-compatible `AppConfig` decode: new overlay-AI fields use
  `decodeIfPresent` defaults, so an upgrade from v0.8.x doesn't wipe
  the user's matchmaking-server override or saved overlay position.

## v0.6.0 — 2026-05-09

The "polish weekend" release. Profile popover got a second pass,
the macOS app got a real co-op overlay, and the web companion
finally has a working post-pair handoff.

**New: native macOS in-game overlay (opt-in).**

- Floating pill (~150×38) with always-on-top + all-spaces +
  fullscreen-auxiliary collection behavior. Sits over Slay the
  Spire 2 even in fullscreen without stealing focus from the game.
- Click expands to a 320×360 panel with status quick-switch
  (Looking / In a run / In co-op / AFK), live online + looking +
  in-co-op counts, and an Open-The-Vault shortcut.
- Hidden from screen recordings (`NSWindow.SharingType.none`) so
  streamers don't get random UI in their captures.
- Drag-to-position; origin persists across launches in
  `app-config.json` alongside `overlayEnabled`.
- Off by default. Settings → "In-game overlay" toggle controls it.
- Reuses the existing `PresenceService` — no new network surface.
- Code lives in `VaultApp/App/Overlay/`. Roadmap notes for v1
  (invites + pair card surface) in
  `docs/run-companion-overlay-plan.md`.

**New: Steam Chat handoff on the pair card.**

- Profile popover's pair card now has a "Message" button that
  deep-links to `steam://friends/message/<partnerSID>`, opening
  the Steam Chat window with the partner directly. Old "Steam"
  button kept as "Profile" for the cases where you want their
  Steam page instead.
- Footer hint walks the user through the rest of the lobby
  handshake (Steam → friend → "Invite to Game").

**Polish: cross-app UI/UX.**

- Profile popover entrance retuned to Apple's standard decel
  curve (`cubic-bezier(0.16, 1, 0.3, 1)` over 220ms). Reduced-
  motion users now get a flat 120ms fade.
- Sidebar profile pill is quieter — caret and dot fade in only
  when interactive. Orange dot reserved strictly for pending
  invites.
- Mobile bottom-sheet picked up a visible drag handle plus a
  swipe-to-dismiss gesture. Safe-area-bottom respected so the
  sheet doesn't sit under the iOS home indicator.
- Toasts re-styled to match popover language (same easing, same
  shadow stack, max-width capped, safe-area-aware on phones).
- Tab panels gain a soft 220ms entrance fade so navigation
  feels deliberate rather than instantaneous-flash.
- Nav rows pick up a focus-visible ring for keyboard users.

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
