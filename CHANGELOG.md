# Changelog

Notable changes, written like commit notes a person actually wrote.
Dates in YYYY-MM-DD. The project follows [Semantic Versioning](https://semver.org)
loosely — patch bumps for fixes, minor for features, major if I ever
break the wire format.

## v0.10.0 — 2026-05-26

The Co-op Lobby is the default surface now. Four months of "Beta" tab
toggles end here. Classic Co-op (the live roster) is still one click
away under "Switch to Classic Co-op" in the header — it just isn't
what you land on anymore. The whole point of this release is making
SpireVault do three things the STS2 Discord literally cannot do, so a
co-op tool has a reason to be open at all.

**Live-updating Discord LFG posts.** When you host a room with a
planned start, "Copy Discord LFG Post" now embeds Discord's native
`<t:UNIX:R>` (relative) and `<t:UNIX:t>` (local time) timestamp tags.
Paste the post into your channel, Discord renders it as "Starts in 28
minutes," and re-renders it as "Starts in 23 minutes" five minutes
later — no edits, no re-posts, no bot. Each viewer sees their own
local time on the second tag. The post-copy toast tells the user
straight up: "Discord LFG post copied — it'll live-update in your
channel." Implemented in `Web/lib/coop-lobbies.js` and
`Web/lib/party-room.js`. The encoded planned-start lives in the
lobby `note` field as a `[start=ISO]` prefix and survives the
backend `sanitizeText` pass intact (covered by
`/tmp/pf-sanitizer-roundtrip-test.mjs`).

**Synced GO moment.** Hosts pick now / 15m / 30m / 1h / when-full at
host time. Everyone in the lobby ticks the same countdown badge in
real time, driven by a single 1s loop in
`Web/lib/party-finder-startsoon-rt.js`. At T-60s, opted-in users get a
Web Audio chime + browser notification (gated behind a single Alerts
gear next to the Quiet Match toggle — green dot when either is
active). At T-0 the row pulses green and reveals a "Launch Steam now"
CTA; the host gets a one-tap "⚡ Start now" pill if they want to
fast-forward the countdown. Steam deep-link has a fallback: if the
`steam://` URL doesn't get consumed within 800ms (Steam not
installed), a "Don't have Steam? Open the store →" link reveals
itself underneath. Same pattern Discord and Slack use for their deep
links.

**Campfire Log is real now.** It used to be a static ribbon that
rendered fake numbers. v0.10.0 ties it to actual local data:

- `pf.runHistory.v1` — every party you join gets logged with character,
  outcome, ascension floor, planned-start ISO, teammates list.
- `pf.playedWith.v1` — derived friends roster with count + last-seen
  per Steam ID. Surfaces in the My Co-op modal, sorted by recency.
- `pf.heartsGiven.v1` — heart-give state per Steam ID with a 24-hour
  cool-down. One heart per teammate per day, so it stays meaningful.
- XP curve: `+10` party joined, `+15` completed, `+25` heart-run goal
  hit, `+5` heart sent. Level thresholds in
  `Web/lib/party-finder-scene.js` — Spirewalker → Embertongue → Heart
  Walker → Spire-Climber → Ascended → Eternal. The bar inside the
  Rank tile fills smoothly as XP accumulates.
- Cross-tab sync: a `BroadcastChannel("pf-coop-log")` channel
  announces history / friends / hearts changes; tabs that don't
  support `BroadcastChannel` fall back to a `storage` event listener.
  A heart sent in tab A updates tab B inside ~250ms.
- "Steam User" persona fallback: if Steam returns the literal placeholder
  "Steam User," the log displays the rank instead. No "Steam User
  hosted 14 parties" copy in the wild.

**Quiet match (renamed from Quiet mode).** Single toggle next to the
hero CTAs that biases matchmaking toward voice-optional rooms.
Renamed because "Sound" and "Notifications" already meant different
things and overloading "Quiet" was confusing. Three mic states are
now consistent across the app: "Mic preferred," "Mic optional,"
"Quiet — no mic."

**One Alerts gear instead of two floating toggles.** The old
`pf-alerts-bar` is gone. A ⚙️ gear next to Quiet match opens a
popover with both Sound chime and Browser notification toggles in one
place. Green dot lights up on the gear when either is on, so the
closed state still tells you what you've enabled. Fixes "I have to
hunt for the toggle" and "the floating bar overlaps the lobby list on
narrow viewports." Code in `Web/lib/party-finder-startsoon-rt.js`,
styles in `Web/lib/party-finder-startsoon.css`.

**Live Parties auto-sort by urgency.** Composite tier sort in
`Web/lib/party-finder.js`:

```
Tier 1: planned start ≤ 15 min  (sorted by start time ascending)
Tier 2: planned start 15–60 min (sorted by start time ascending)
Tier 3: everything else         (sorted by fit score, then recency)
```

So if you want to play *right now*, the imminent rooms are the first
thing on the page.

**Pagination + viewport-aware ticking.** Live Parties caps at 25 rows
with a "Show 25 more" footer (resets on prefs change). The 1-second
countdown loop now runs through an `IntersectionObserver` that marks
each row `data-pf-visible` — countdowns only re-render for rows
actually on screen, plus the user's own row even when scrolled off.
Rooms default to visible until the observer reports otherwise so
headless tests stay deterministic. Tested at simulated 200 visible
rooms; main-thread cost stays under 4ms per tick.

**Beta default + reconnecting banner.** The lobby ships default-on,
which means it needs a bail-out without a deploy. Three layers:

1. Per-browser, no auth: `?beta=off` persists an opt-out for that
   browser; `?beta=kill` sets a per-browser kill flag; `?beta=on`
   clears both. Query string is stripped on load so links stay clean.
2. Server-pushed: the Cloudflare Worker reads
   `COOP_LOBBY_BETA_KILL=1` from env (and `COOP_LOBBY_BETA_ENABLED=0`)
   and emits `flags.coopLobbyBetaKill: true` in `/coop/state`. Every
   connected client downgrades to Classic on the next poll (≤15s
   focused, ≤60s hidden). No deploy.
3. Code-level: `ENABLE_COOP_LOBBY_BETA = false` in `Web/script.js`
   plus a redeploy. Hides the toggle entirely.

If `/coop/state` fails twice in a row, a yellow "Reconnecting..."
banner appears at the top of the lobby. After five fails it flips red
with "Can't reach the server. Your stats may be stale." A "Retry now"
button forces a refresh. No more silently-stale UI.

**Note budget UI.** The host modal's note field shows live remaining
characters, dynamically reduced when a planned start is selected
(`[start=ISO]` prefix reserves ~29 chars from the 160-char backend
budget). Counter goes amber at ≤12 left, red at <0, and the input's
`maxlength` enforces the same cap so the post never gets silently
truncated server-side.

**Accessibility / cross-browser.** Added `role="status" aria-live="polite"`
to the Starting Soon stat tile so screen readers announce the urgency
flip. `prefers-reduced-motion: reduce` disables the GO pulse, the tab
title flash, the network-banner pulse, and the Starting Soon tile
pulse — information stays in color and text. Safari `AudioContext`
unlock now happens synchronously inside the Sound-toggle click
handler (Safari rejects async unlocks). `Notification.requestPermission`
handles both promise-form and callback-form return values for older
Firefox / Safari.

**What's not in this release.** Verified co-op reputation (real
ascensions cleared, real Heart kills, completion rate, host
reliability score) is the next sprint and the actual lock-in feature —
2–3 weeks, mostly backend. Steam Rich Presence integration is right
behind it (a small desktop helper that flips your status to "looking"
when STS2 is open). Synced ready-up + auto-advance, Daily Co-op
Challenge, and Post-run shared report are sequenced after that. None
of those land in v0.10.0.

**Versioning.**

- Web companion / lobby surface bumped to v0.10.0.
- Backend `/coop/state` schema added optional `flags` object —
  unauth'd clients still see `flags: undefined`, so old desktop
  builds keep working.
- Marketing site (`Site/index.html`) co-op section + feature card
  rewritten for the new default. News post 007 added.

## v0.9.9 — 2026-05-10

Run Coach overlay perf + UX pass: instant tracker chips, global
hotkey, streaming chat, opinionated follow-ups, and an at-a-glance
unseen-observations dot on the pill. The overlay still only opens
its own network connections — no Vault server touches any of this.

**Tracker chips now land within ~50ms of the save write.** STS2
fsync()s `current_run.save` after every map node, every reward
pick, and every relic gain. Previously we polled it on a 4-second
loop, so a "Took Streamline+" chip could lag 0–4 seconds behind the
player's click. Now a `DispatchSource.makeFileSystemObjectSource`
(kqueue-backed) watches the file directly and fires within ~50ms,
debounced to 250ms to coalesce the triple-flush STS2 sometimes does.
The 4s timer becomes an 8s backstop — only used if the watcher
can't attach (file not yet on disk).

**Global hotkey: ⌥Space opens the Coach from anywhere.** Even
inside fullscreen STS2. Built on Carbon's `RegisterEventHotKey` so
the user never has to grant Accessibility access — the OS routes
hot-key events to us before any other app, and the input field
auto-focuses on expand. Press it again to dismiss. Configurable
modifier+key in Coach settings → Coach behaviour → Global hotkey.

**Streaming responses for free-form chat.** Asking a question or
hitting Recap now streams tokens token-by-token instead of staring
at a spinner for 3-8s. Both providers supported (OpenAI and
Anthropic SSE). Structured cards (Path / Reward / Shop / Event /
Combat) still wait for a clean parse — half-streamed JSON would
look like garbage. Toggle off in settings if your provider rate-
limits SSE.

**Coach auto-follow-up on disagreements.** When a tracker chip
fires with `DIFFERENT` or `SKIPPED` (e.g. you took Bash when I
recommended Streamline+), the Coach posts a one-line acknowledgment
+ pivot ("OK Bash works if you upgrade it; otherwise look for a
removal at next shop"). Off uses zero tokens; on adds one ~100-token
call per disagreed pick. Coalesced — only one in-flight follow-up
at a time.

**Unseen-observations dot on the collapsed pill.** Tracker chips and
Coach follow-ups that arrive while the chat is collapsed now bump a
small attention dot on the Coach pill button. Cleared the moment you
expand the chat — pure read-receipt semantics.

**Glossary fuzzy lookup + miss telemetry.** The bundled card /
relic glossary keys are snake_case, but STS2 saves use CamelCase
("BurningBlood"). A new fuzzy resolver strips non-alphanumerics on
both sides so all three save conventions ("BurningBlood",
"burning_blood", "Burning Blood") resolve to the same entry. For
cards / relics still not in the glossary, we now log them to
`~/Library/Application Support/SpireVault/missing-cards.log`
(once per ID per process; never uploaded) so future builds know
exactly which IDs to add. The model also gets a `[glossary-misses]`
hint telling it to hedge on those specifically rather than
hallucinate effects.

Smoke-tested: 6/6 SSE + hotkey + glossary + debounce scenarios pass.
Debug + Release builds clean, zero linter warnings on overlay files.

## v0.9.8 — 2026-05-10

Fixes the "where are all the changes?" report from a user stuck on
v0.8.1 several months after v0.9.x shipped. Their auto-checker had
been working all along — it just had nowhere to surface the result.

**Why nobody saw the update prompt.**

Pre-v0.9.8 flow:

1. App launches → `UpdateService.autoCheckIfDue()` hits the GitHub
   Releases API, finds a newer version, sets
   `status = .updateAvailable`.
2. That status was rendered *only* inside `SettingsView.updateBlock`.
3. The standalone **Settings** sidebar row was retired in v0.9 in
   favour of the persona-pill dropdown.
4. A user who never opens the persona pill (most of them) had zero
   in-window signal that an update was waiting.

Compounding it, the existing flow required *two* clicks once the
prompt was eventually found — "Download update" then "Install &
relaunch" — which left another stall point in the middle.

**Fix — persistent in-window banner + background staging.**

- New `UpdateBanner` lives above the sidebar+detail split in
  `RootView`, visible on every tab. Renders four states:
  `.updateAvailable` (with "Later" / "View on GitHub"),
  `.downloading` (with inline progress bar), `.readyToInstall`
  (with the primary "Install & restart" affordance, default-action
  keyboard shortcut), and `.failed` (with "Retry" / "Open GitHub").
  Brand-tinted gradient for the discovery and progress states; gold/
  orange for the ready state (action-required); red tint for failed.
- `UpdateService.checkForUpdates(userInitiated:)` now eagerly
  flows from `.updateAvailable` straight into `downloadUpdate()`.
  Updates are 5–6 MB DMGs against GitHub Releases — bandwidth cost
  is negligible, and it collapses the two-button "Download → Install"
  flow into a single "Install & restart" by the time the user
  actually sees the banner.
- New `dismissBannerForSession()` lets the user defer the banner
  until next launch *or* the next re-check (whichever comes first),
  but the `.readyToInstall` state is intentionally non-dismissable
  — the DMG is already staged, there's nothing to defer.
- New `bannerShouldShow` getter centralises the visibility rules so
  RootView doesn't have to do its own state inspection.
- `RootView` re-fires `autoCheckIfDue()` on
  `NSApplication.didBecomeActiveNotification`. Important for the "I
  haven't quit the app since the last release went out" case —
  previously the throttle would block the launch-time check from
  re-evaluating until the next cold boot.
- `.readyToInstall` is now a guard against `checkForUpdates`
  re-entering — once we've paid the download cost, recycling the
  state on a re-check would be wasted work and risks losing the
  staged DMG.

**Recovering manually.**

If you're reading this from a build *older* than v0.9.8, you won't
get the banner. Either:

- **Open the Vault menu → Check for Updates…** in any v0.8+ build,
  walk through Download → Install & relaunch in Settings, or
- **Drag the latest DMG** from
  [`releases/latest/download/The-Vault-0.9.8.dmg`](https://github.com/c3rooks/SpireVault/releases/latest/download/The-Vault-0.9.8.dmg)
  into `/Applications`. Once you're on v0.9.8 the banner will
  catch every future release automatically.

**Versioning.**

- `Info.plist` / `project.yml` → `CFBundleShortVersionString = 0.9.8`,
  `CFBundleVersion = 17`.
- `HistoryStore.current = "0.9.8"`.
- Marketing site banners + FAQ → v0.9.8.

## v0.9.7 — 2026-05-10

Focused polish on the Run Coach enable/disable cycle, on top of the
v0.9.6 fixes. Verified end-to-end via cold-start tests against three
configurations: `overlayEnabled = false` (no panel), `overlayEnabled
= true` (pill at default top-center), and `overlayEnabled = true`
with a deliberately off-screen persisted origin (panel falls back
and re-stamps a reachable coordinate).

**Off-screen origin recovery.**

- New bounds check in `OverlayController.show()`. The persisted
  top-left is only honoured if at least the leading ~80pt of the
  panel still lands inside *some* connected display's `visibleFrame`.
  Otherwise we fall through to `defaultOrigin()` (top-center of the
  main screen, 30pt below the menu bar) and *wipe* the saved
  coordinates so the next user-initiated drag stamps a fresh,
  reachable origin instead of silently re-tripping the same fallback
  every show().
- The classic "I re-enabled the overlay but it never came back"
  report was almost always this — external monitor disconnected,
  multi-display rearranged, scaled-display switch — leaving the
  saved origin in negative-half-plane territory. Now it self-heals.

**BetaView toggle UX.**

- "Reset position to top center" now goes through the
  `enabled = false; enabled = true` cycle instead of a raw
  `hide(); show()` pair. That gets the v0.9.6 `mode = .pill` reset
  for free *and* re-runs the new bounds-check above. Cleaner than
  reasoning about each side effect separately.
- "Show now" renamed to **"Bring overlay to front"** and scoped to
  doing exactly that. The old version force-expanded chat as a
  debugging affordance, which surprised users who'd just enabled
  the overlay and were expecting the pill at the top of their
  screen.
- New explanatory hint text under the toggle when the overlay is
  off: "Disabled. Toggle on to bring the pill back at the top of
  your main display." So the empty space below the switch has a
  real purpose instead of looking like the toggle did nothing.

**Versioning.**

- `Info.plist` / `project.yml` → `CFBundleShortVersionString = 0.9.7`,
  `CFBundleVersion = 16`.
- `HistoryStore.current = "0.9.7"`.
- DMG built as `The-Vault-0.9.7.dmg`, ad-hoc signed, attached to the
  GitHub release. **Vault → Check for Updates…** in any v0.9.x
  install will offer the upgrade automatically.

## v0.9.6 — 2026-05-10

Three user-reported bugs in v0.9.5 — overlay enable/disable not behaving
the way the on/off switch implies, the embedded sidebar tabs going
silent on cold launch, and the Steam persona pill in the sidebar
reading as static text instead of an interactive menu — plus the rest
of the Run Coach polish pass that came out of "make sure that
everything works, if I disable in the app it disappears, if I enable it
comes back."

**Run Coach overlay — enable/disable that does what the toggle says.**

- `OverlayController.hide()` now resets `mode = .pill` so re-enabling
  always brings the canonical small pill back instead of restoring
  whatever larger panel size (chat / settings) the user happened to
  have open at the moment of disable. This is the one fix that cleanly
  matches the "the pill comes back" mental model that the toggle
  implies.
- New defensive bounds check on the persisted top-left in `show()`. If
  the saved origin lands off-screen (external monitor disconnected,
  multi-display rearranged, scaled-display switch), we fall back to
  the default top-center position *and* wipe the saved origin so the
  next user-initiated drag stamps a fresh, reachable coordinate. The
  classic "I re-enabled the overlay but nothing came back" report
  was mostly this.
- BetaView **Reset position to top center** now goes through the
  enabled-toggle off→on cycle. That gets the `mode = .pill` reset for
  free and re-runs the bounds-check above. Cleaner behavior than the
  previous `hide(); show()` pair.
- BetaView **Show now** renamed to **Bring overlay to front** and
  scoped to actually doing exactly that — the old version
  force-expanded chat as a debugging affordance and confused users
  who'd just enabled the overlay and wanted the pill at the top.
- BetaView shows an explicit "Disabled. Toggle on to bring the pill
  back at the top of your main display." hint when the overlay is
  off, so the empty space below the toggle has a real purpose.

**Run Coach key-store wording — last of the v0.9.5 cleanup.**

The v0.9.5 release moved the BYO API key off the macOS keychain into a
file-backed store at
`~/Library/Application Support/AscensionCompanion/vault/overlay-keys.json`,
but a few user-visible strings still said "Keychain":

- BetaView "On file in Keychain" badge → "On file".
- BetaView "Saved to Keychain." / "Couldn't save to Keychain." →
  neutral "Saved." / a real diagnostic message that names the actual
  filesystem failure mode.
- BetaView footer prose names the on-disk path + perms (0600).
- Overlay settings sheet copy + "Removed." labels match.
- Helper renamed from `refreshKeychainState()` to `refreshKeyState()`
  / `refreshFromStore()` to match the actual backing.

**Embedded sidebar tabs going silent on cold launch.**

Reported on macOS v0.9.5: "none of the tabs are working, when you
select them nothing changes — only the page is overview working."
Traced to the JS bridge between SwiftUI sidebar and the embedded
`WKWebView`:

- `WebHostView` was gating every `requestTabSwitch` on a
  `bridgeReady` flag that only flipped true after the page sent a
  `kind:"ready"` message via a 4-second polling user-script. If
  `window.SpireVault` wasn't defined within that 4s window — slow
  CPU, deferred ES module parse, or any throw before the SpireVault
  setup at line ~13363 of `script.js` — the gate stayed permanently
  closed, silently buffering one `pendingTab` and dropping every
  click after.

Fix:

- `Web/script.js`: hoist `window.SpireVault` to the very top of the
  module (line ~1085) with a queueing stub. `switchTab` buffers the
  latest tab into `__VAULT_HOST_QUEUE.tab`; `startSignIn` flips
  `__VAULT_HOST_QUEUE.signIn`; `onTabChange` wires its real listener
  via `window.addEventListener` so it survives the stub-to-impl swap.
- The full `SpireVault` impl at the bottom of the module replaces the
  stub, drains any queued sign-in click, posts a deterministic
  `kind:"ready"` straight to native (no more polling-window race),
  and posts a `kind:"auth"` payload if the page already has a real
  bearer session (catches the cross-launch case where the WebView
  remembers the user but native didn't).
- `Web/script.js` `boot()` reads `__VAULT_HOST_QUEUE.tab` *before*
  deciding the initial panel, so a sidebar click during cold-launch
  wins over the URL's `?tab=overview` and over localStorage's
  last-tab.
- `WebHostView`: drop the `bridgeReady` gate from
  `requestTabSwitch`. Always evaluate the JS, with a `Timer`-driven
  retry loop (200ms × 30 attempts ≈ 6s) that uses the JS return value
  to detect "stub didn't queue" and retries until success or budget
  exhaust. Same treatment for `requestSignInIfNeeded` — fire
  immediately, the page-side stub queues if SpireVault isn't ready
  and the existing ready-handler reissue still runs as backup.

**Steam persona pill — visible chevron, hover, "I am a button" affordance.**

Reported: "steam profile isnt showing on desktop — i cant even click
into it like i can on web." Two compounding causes:

- Cross-launch auth never synced. The macOS WKWebView shares its data
  store across launches (cookies + localStorage live in
  `WKWebsiteDataStore.default()`), so a user already signed in on the
  page side came back authenticated visually but native
  `SteamAuth.profile` stayed nil. The native sidebar rendered the
  guest pill instead of the persona menu. Fixed by the new
  `kind:"auth"` payload above — `script.js` now re-issues it on every
  page load if a bearer session exists.
- Even when signed in, the SwiftUI Menu used
  `.menuIndicator(.hidden)` + `.menuStyle(.borderlessButton)` +
  `.buttonStyle(.plain)`. Result: looked like static text, no hover
  state, no chevron — users didn't realise it was a control.

Fix: `RootView` ships a new `PersonaPillLabel` with a visible chevron
disclosure indicator, hover state with a gold-tinted border + raised
background, and a larger avatar circle. Reads as a control at every
glance. The Menu chrome (`.menuStyle(.borderlessButton)` etc.) is
unchanged so dark-sidebar styling integration stays intact.

**Versioning.**

- `Info.plist` / `project.yml` → `CFBundleShortVersionString = 0.9.6`,
  `CFBundleVersion = 15`.
- `HistoryStore.current = "0.9.6"`.
- Web companion build pinned to `v153`.
- DMG built as `The-Vault-0.9.6.dmg`, ad-hoc signed, attached to the
  GitHub release. **Vault → Check for Updates…** in any v0.9.x
  install will offer the upgrade automatically.

## v0.9.5 — 2026-05-10

Hotfix for the recurring login-keychain prompt that was hitting every
DMG user as soon as they saved an API key in Run Coach (Beta). The
prompt looked like:

> The Vault wants to use your confidential information stored in
> "com.coreycrooks.thevault.overlay" in your keychain.

…and it came back on every overlay action. Apologies — that was
unusable.

**Why it was happening.**

The overlay's per-provider API key was stored in the user's macOS
login keychain (`SecItemAdd` against `kSecClassGenericPassword`,
service `com.coreycrooks.thevault.overlay`). The keychain item's
default ACL is "only the exact code signature that created this item
can read it without prompting" — and every release of an ad-hoc-
signed DMG has a *different* ad-hoc code signature. So the running
app's signature never matched the signature recorded on the item,
and macOS asked for the login keychain password on every read of the
key (which is to say, every overlay action — Assist, chip prompts,
chat sends, settings panel mount). `SecItemDelete` exhibits the same
prompt for items the running signature didn't create, so even a
"best-effort migrate then delete" path couldn't quietly recover.

The keychain wasn't actually buying anything for this distribution
model anyway — without a Team ID and an access-group entitlement
there's no shared keychain group, and any process running as the user
can already read the file system. It was protecting against a threat
that doesn't exist in a sideloaded ad-hoc-signed app while breaking
the actual product.

**The fix.**

`OverlayKeychain` keeps its name and its public surface
(`apiKey(for:)`, `hasKey(for:)`, `setAPIKey(_:for:)`, `delete(account:)`)
so call sites don't move, but it now delegates to a new file-backed
`OverlayKeyStore`:

- File: `~/Library/Application Support/AscensionCompanion/vault/overlay-keys.json`
- Directory perms `0700`, file perms `0600`, atomic temp-file rename
  on every write.
- Each value XOR-scrambled against a fixed bundled key before going
  to disk — pure obfuscation so `cat` / `grep` / Spotlight don't emit
  raw `sk-…` strings, not encryption against a determined attacker.
- Versioned envelope on disk so we can swap in OS-protected storage
  later without forcing users to re-paste.
- Single-process serial dispatch queue serialises reads and writes
  inside the running app.

**Migration.**

There is none, on purpose: any code path that read or deleted the
legacy keychain entry would have surfaced the exact prompt this
release exists to suppress. Existing users will see "No API key on
file" once after upgrading and need to paste their key into
**Beta → Run Coach** one more time. The legacy keychain entry,
if any, sits unread in your login keychain and can be removed via
Keychain Access.app at your leisure — we won't touch it.

**Versioning.**

- `Info.plist` / `project.yml` → `CFBundleShortVersionString = 0.9.5`,
  `CFBundleVersion = 14`.
- `HistoryStore.current = "0.9.5"`.
- DMG built as `The-Vault-0.9.5.dmg`, ad-hoc signed, attached to the
  GitHub release. **Vault → Check for Updates…** in any v0.9.x
  install will offer the upgrade automatically; Steam session, run
  history, sidebar layout, and Run Coach settings (other than the
  API key, see above) all carry over.

## v0.9.4 — 2026-05-10

UI polish on the Run Coach overlay (Beta) and a refreshed marketing
site that finally shows what the panel actually looks like. Also a
real fix for the "black box behind the rounded border" report — that
was a transparent-NSPanel + opaque-NSHostingView interaction painting
a sharp dark rectangle behind the rounded SwiftUI card.

**Overlay UI/UX touch-up.**

- `OverlayController.show()` now sets `panel.hasShadow = false` and
  switches the `NSHostingView` layer to `isOpaque = false` with a
  clear `backgroundColor` *after* SwiftUI has rendered into it once
  (touching `host.layer` synchronously during init triggers an AppKit
  layout cycle that can deadlock subsequent `setFrame()` calls). Net
  effect: the overlay reads as a real rounded glass card sitting on
  the desktop instead of a rounded card pasted onto a sharp-cornered
  black backdrop.
- `OverlayRootView` background gets a small redesign — cooler
  midnight base, two ember accents (top-left bright, bottom-right
  cooler purple counter-weight), and a hairline white top edge so the
  bevel border doesn't sit on a flat fill. Two-stop strokeBorder + an
  inner inset stroke for a luminous rim that survives over busy game
  backgrounds.
- The BETA pill in the chat header is brand-gradient now (matches the
  Assist chip's energy) instead of the previous flat orange tint.
- Single soft drop shadow at the SwiftUI level instead of a two-layer
  contact + ambient stack — the second pass interacted badly with the
  panel resize during mode transitions.
- New convenience shortcuts under **Vault → Run Coach: Show Pill**
  (⌘⇧⌥1) and **Vault → Run Coach: Open Chat** (⌘⇧⌥2). Useful for
  power users who already know what mode they want, and as
  deterministic anchors for screenshot / E2E automation.

**Marketing site.**

- New dedicated **Run Coach** section on
  [spirevault.app](https://spirevault.app) with a real screenshot of
  the polished pill + a pixel-matched HTML/CSS recreation of the
  chat card (so it stays sharp at every Retina density). Section
  copy is human-toned, walks through the two states, the streamer-
  safe default, BYO-key flow, and explicitly notes the build is
  **macOS .dmg only at the moment, Windows .exe coming next**.
- Top nav gains a `Run Coach BETA` link so the section is reachable
  in one click from the hero.
- The existing Run Coach feature card and the FAQ entry both get
  rewritten for the same "Mac DMG / .exe coming next" framing.
- Hero install button + DMG link bumped to v0.9.4.

**Versioning + persistence.**

- `Info.plist` / `project.yml` → `CFBundleShortVersionString = 0.9.4`,
  `CFBundleVersion = 13`.
- `HistoryStore.current = "0.9.4"`.
- DMG built as `The-Vault-0.9.4.dmg`, ad-hoc signed, attached to the
  GitHub release. The in-app **Vault → Check for Updates…** flow
  picks it up automatically on existing v0.9.x installs.

## v0.9.3 — 2026-05-10

Hotfix for the two highest-pain bugs reported against v0.9.2: clicking
"Sign in with Steam" did nothing in the desktop app, and on machines
with two copies of The Vault.app installed it spawned a second
window. Both came from the same root cause — the sign-in flow was
shelling out to `NSWorkspace.open()` for the worker URL, which dropped
the session cookie into the user's default browser (where the embedded
WebView could never see it) and on dual-installs delivered the
`thevault://` return to the *other* copy of the app.

**Sign-in stays inside the WKWebView now.**

- `WebHostView` allows the worker host and `steamcommunity.com` (plus
  `steampowered.com`) to navigate *inside* the embedded WebView. The
  full Steam OpenID round-trip (`worker /auth/steam/start` → Steam →
  `worker /auth/steam/callback` → `app.spirevault.app/auth.html`) now
  happens in-process, so the resulting cookie + localStorage end up in
  `cfg.websiteDataStore = .default()` where the embedded view
  actually reads them.
- New JS bridge message `kind: "auth"` lets `auth.html` post the
  verified Steam payload (steamID, persona, avatar, session) straight
  to native code, and `SteamAuth.acceptWebSession(...)` seats it. The
  sidebar pill, Co-op presence, and every native API write all light
  up at the same instant the embedded view does — no more "I'm
  signed-in inside the page but the surrounding chrome thinks I'm a
  guest" mismatch.
- New `window.SpireVault.startSignIn()` is the entrypoint the native
  app calls when its sidebar / menu / settings "Sign in with Steam"
  buttons are tapped. AppState bumps `embeddedSignInTicket` and
  optionally hops the sidebar to a web-hosted tab first (so the
  WebView is on screen to drive the OpenID flow), and the coordinator
  fires `startSignIn()` once the bridge handshake completes.

**No more duplicate desktop windows.**

- Added `LSMultipleInstancesProhibited = true` to `Info.plist`. With
  this, macOS Launch Services brings the running instance forward
  instead of launching a second copy when a deep-link is delivered.
  Combined with the in-WebView sign-in path (which removes the
  NSWorkspace hop entirely), the two-window failure mode is gone.

**Touched files.**

- `VaultApp/App/WebHostView.swift` — Steam-OpenID-aware nav policy,
  `WebAuthPayload`, `kind: "auth"` handler, sign-in ticket fan-out.
- `VaultApp/App/Coop/SteamAuth.swift` — `acceptWebSession(...)`.
- `VaultApp/App/AppState.swift` — `embeddedSignInTicket`,
  `requestEmbeddedSignIn(currentTab:)`, `pendingSidebarHop`.
- `VaultApp/App/RootView.swift` — observes `pendingSidebarHop`,
  guest pill calls `requestEmbeddedSignIn`.
- `VaultApp/App/{VaultApp,SettingsView,Coop/CoopView}.swift` — same
  rewire for menu, settings, and the dead-code Co-op fallback.
- `VaultApp/App/DetailView.swift` — passes ticket + auth callback to
  `WebHostView`.
- `Web/script.js` — `window.SpireVault.startSignIn()` and
  `seedSession(profile)`.
- `Web/auth.html` — posts `kind: "auth"` to the native bridge in
  desktop-host mode.
- `VaultApp/Info.plist` + `project.yml` — version bump,
  `LSMultipleInstancesProhibited`.

## v0.9.2 — 2026-05-10

The desktop app stops maintaining a parallel SwiftUI copy of every cloud
panel. From this build forward, the macOS app embeds the live web
companion (`app.spirevault.app`) for every data tab — Overview,
Characters, Ascensions, Top Relics, Cards, Recent Runs, Co-op,
Community Highlights, News. One UI, one set of animations, one source
of truth. Native code keeps responsibility for the things only native
code can do.

**WebHostView (desktop ↔ cloud bridge).**

- New `WebHostView` (SwiftUI wrapper around `WKWebView`) replaces every
  data tab's native panel. Loads `https://app.spirevault.app/?desktop=1&tab=<id>`,
  injects `window.__VAULT_DESKTOP__ = true` at document-start so the
  page boots into desktop-host mode (sidebar / install pitch / "Pick
  STS2 saves" CTA hidden), and hands off external links (Steam, GitHub,
  mailto, http) to `NSWorkspace.open` so they open in the user's actual
  browser instead of swallowing them inside the WebView.
- The native sidebar drives the embedded tab via a tiny
  `window.SpireVault.switchTab(...)` bridge. In-page tab changes
  (clicking "Open Co-op" inside a news post) propagate back to the
  native sidebar via a `spirevault:tab` custom event so the highlight
  stays in sync. Beta and Settings stay 100% native because they need
  `NSPanel` / Keychain / `NSOpenPanel`.
- A slim native toolbar above each embedded panel still surfaces
  Rescan, Export, and Open Saves Folder so VaultCore data ops are
  always one click away — even though the panel chrome itself is now
  rendered by the cloud.

**Runs injection — local data, cloud rendering.**

- The desktop's `[RunRecord]` snapshot is JSON-encoded and pushed into
  the embedded page via `window.SpireVault.ingestDesktopRuns(...)`,
  which calls `commitParsedRuns` internally. Result: the embedded view
  sees the user's actual run history (their real win-rate, real best
  floor, real recent-form chart) instead of the demo set, with no
  dependency on cloud sync.
- The push is hashed and runs only when the snapshot changes, so
  SwiftUI's habit of re-running `updateNSView` on every parent
  re-render doesn't keep re-uploading the same 400-run JSON.
- Pending runs are queued and replayed once the bridge handshake
  completes, so the very first paint after launch already shows real
  data instead of a flash of demo numbers.

**Bug fixes.**

- **Community Highlights 404** — the desktop was hitting
  `/api/highlights` while the worker exposes `/highlights`. Every
  desktop user was seeing "Highlights endpoint returned 404" no matter
  what was on the cloud, including their own freshly-posted highlights.
  Path corrected; the highlights tab now reflects the cloud.
- **Web update banner inside the desktop** — the "A newer version of
  Spire Vault is available" banner was firing inside the WebView on
  every web deploy, scaring users into thinking the macOS app itself
  was out of date. Suppressed when running embedded — the desktop has
  its own native `UpdateService` for DMG-level updates.
- **Sample-data flash** — the amber "Showing sample data — link your
  STS2 saves" pill no longer flashes while the host is preparing to
  push runs. Hidden outright in desktop-host mode; the pill was
  meaningless inside the desktop because the native side already owns
  save folder linking.

**Real newsletter capture.**

- New worker route `POST /notify` (KV-backed) captures email +
  topic + source for the long-promised weekly digest. Plain-text,
  zero email is sent from the endpoint — the list is just stored
  until the digest mailer is wired. IP-rate-limited (6/hour/IP).
  No third party in the loop.
- News posts that mention the digest now have a real signup form
  underneath, wired to `/notify` with proper success / error / rate-
  limit / invalid-email states. The "newsletter is broken" complaint
  is closed.

**News sync.**

- New post #006 ("The desktop app is now the cloud") published on both
  web and the desktop's news catalog. The latest macOS post id was
  drifting ahead of the web's news feed (#005 only existed in
  `NewsCatalog.swift`); from this build the web is the canonical news
  surface and the macOS app reads it through the embedded WebView.

**Versioning.**

- `Info.plist` / `project.yml`: 0.9.2 (build 11).
- `VaultVersion.current`: 0.9.2.
- Web: `script.js?v=149`, `styles.css?v=115`.

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
