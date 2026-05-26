# Discord Rich Presence + STS2 desktop overlay — design spike

**Status:** spike (no code yet). Out of scope for a single web turn — needs a desktop wrapper that owns the local IPC surface.

**Audience:** anyone picking up the next milestone after the Co-op Lobby Beta web work is shipped.

---

## TL;DR — the two features

1. **Discord Rich Presence** — when a user is in a SpireVault co-op party, their Discord status reads:
   > Slay the Spire 2 · A4 Heart attempt with AshenHost (2 of 4 · 1 spot left)
   > [Ask to Join] [Join Voice]
2. **STS2 overlay** — a tiny always-on-top window pinned next to the Slay the Spire 2 client that shows the same Party Hub podium scene (host, you, other members, ready states, voice channel link). One-click "Mark Ready" without alt-tabbing.

Together they close the last social gap with Discord LFG: Discord users **see** their friend is in a party they can click into, and players **see** their party state without leaving the game. This is the "must-have" jump — the web app stops being optional once these are in place.

## Why this needs a desktop wrapper (and can't be a web turn)

Both features require local-machine APIs no browser exposes:

| Capability | Required surface | Web has it? |
|---|---|---|
| Discord IPC (`discord-rpc`) | Named pipe on Windows, Unix socket on macOS/Linux | No |
| Always-on-top window | Native window flag | No (browser tabs cannot escape the OS chrome) |
| Window positioning (snap to STS2) | Read other process window bounds | No |
| Steam friends overlay deep-link | Steam URL scheme + native browser handoff | Partially (URLs work, callback doesn't) |
| File-system overlay config | Local storage path with system-level perms | Partially (sandboxed) |

The existing Vault desktop wrapper (referenced in `docs/overlay-party-room-deferred.md` and `docs/run-companion-overlay-plan.md`) is the right home. This spike piggybacks on that wrapper — it does **not** propose a new build target.

## Feature 1 — Discord Rich Presence

### What the user sees

In their Discord profile + the "Playing a game" widget visible to all their friends:

```
Slay the Spire 2
  ┌─ A4 Heart attempt — chill
  │   with AshenHost
  │   2 of 4 · 1 spot left
  │   ⏱  Open 3m ago
  │
  │  [Ask to Join]  [Join Voice]
  └────────────────────────────
```

The presence updates in three states:

1. **Idle in SpireVault** — `Looking for a co-op group` + button `[Open SpireVault]`
2. **Hosting a room** — `Hosting: {title} · {n} of {cap} · {asc} {goal}` + `[Ask to Join]`
3. **In a party** — `In party: {title} · {n} of {cap}` + `[Ask to Join]` (only when room has open seats) + `[Join Voice]` (when Discord voice channel is attached)

The "Ask to Join" button triggers Discord's native join-request flow. Friends seeing a player in a party can request a seat with one click, and the SpireVault desktop wrapper handles the request by either:
- Auto-accepting (if the host has "open join" enabled and seat available)
- Surfacing a "JoinRequest from `<friend>`" toast that the host accepts/declines

### Data flow

```
SpireVault desktop wrapper
  ├─ websocket subscribe to /api/coop/state for current Steam ID
  │     (same auth as the web companion)
  ├─ on party state change:
  │     compute presence payload from lobby + party data
  │     call discord-rpc setActivity(payload)
  └─ on Discord JoinRequest event:
        if hostSteamId === me:
          → notify the host UI (toast or push to web)
        else:
          → POST /api/coop/parties/:partyId/seat-request to backend
```

### Discord Activity payload shape

```json
{
  "details": "A4 Heart attempt — chill",
  "state": "with AshenHost · 2/4 (1 open)",
  "largeImageKey": "sts2_ironclad",
  "largeImageText": "Hosting on Ironclad",
  "smallImageKey": "sv_logo",
  "smallImageText": "SpireVault Co-op",
  "partyId": "<spirevault partyId>",
  "partySize": [2, 4],
  "joinSecret": "<encrypted partyId + lobbyId + expiresAt>",
  "buttons": [
    { "label": "Ask to Join",  "url": "https://app.spirevault.app/party/{partyId}?join=ask" },
    { "label": "Join Voice",   "url": "<discord voice deep link>" }
  ],
  "startTimestamp": <unix lobby createdAt>
}
```

`joinSecret` is opaque to Discord — when a friend clicks "Ask to Join," Discord opens our app's URL handler (`spirevault://join?secret=...`), which the desktop wrapper decrypts and uses to call our backend.

### Open questions

- Discord caps Rich Presence updates to ~5/min. The lobby filling/draining could fire faster than that — debounce to 1 update per 15s, with a final snapshot on transition into "starting" or "closed."
- Discord's "Game Detection" lists are not API-publishable; we either get listed manually with Discord or rely on the desktop wrapper being identified as the source. Likely OK — they do approve "companion app" registrations.
- The `joinSecret` needs an expiration (5–10 min) and host-side allowlist to prevent screenshot-based hijack. Backend endpoint is additive, not a breaking change.

### Privacy and ToS

- All payloads contain only data the user has already published into a public lobby — no run history, no personal stats, no friend lists.
- The user must opt in via desktop wrapper setting `Show party in Discord status`. Default OFF for first launch; the UI prompt explains exactly what's shared.
- The wrapper never reads Discord's own data (DMs, server list, etc.) — only writes via the IPC `setActivity` channel.

### Effort estimate

- Wrapper IPC: ~1 day (the `@discordjs/rpc` package + reconnect logic)
- Backend `/seat-request` endpoint: ~0.5 day (additive, mirrors existing `/join` flow)
- Web toast UI for incoming join requests: ~0.5 day
- Settings UI + opt-in flow: ~0.5 day
- E2E + Discord approval round-trip: ~1 day buffer

**Total:** ~3.5 days for a shippable v1.

---

## Feature 2 — STS2 desktop overlay

### What the user sees

A 320×460 always-on-top window, semi-transparent, that snaps to the right edge of the Slay the Spire 2 window. It shows:

- **Top:** room title + goal pill (Heart, Daily, etc.) + ascension band
- **Middle:** the campfire podium scene (same as `pr-scene` on the web), 4 stones with character art + ready state per member
- **Bottom-left:** `🔥 You're ready` chip (toggles to `Tap to ready up` when not)
- **Bottom-right:** `🎤 Join Voice` button (links to the Discord channel)
- **Footer:** activity ticker echo — same chips as the web hero stage but compressed to one line

When STS2 is minimized or not focused, the overlay fades to 60% opacity. When STS2 is foregrounded, it goes to 100%.

### Why this exists

The web Party Hub is gorgeous but a player has to alt-tab to see it. That defeats the "no friction" promise. With the overlay:

- A player can mark themselves ready without leaving STS2.
- The host can see who's stuck on character select.
- The activity ticker keeps live event awareness without context-switching.
- Co-op coordination ("I'm doing the elite", "use this potion") happens via voice in Discord while the visual state lives in the overlay.

### Architecture

The overlay is a **second window inside the same desktop wrapper process**, sharing the wrapper's auth + websocket subscription. It renders the existing `Web/lib/party-room.js` + `party-finder-scene.js` modules with a `data-pf-mode="overlay"` body attribute that:

- Forces compact layout (`min-width: 320px`, `min-height: 460px`)
- Hides the sidebar + page header
- Disables the body MutationObserver-driven hero stage (the overlay never shows the Co-op tab)
- Pins the podium scene as the root and routes "Mark Ready" → existing backend `/api/coop/parties/:partyId/me/status` endpoint

The overlay is essentially a **specialized chrome** over the existing web bundle, NOT a fork. Same code, same auth, same backend — just a different shell.

### Window-position handling

| Platform | Approach |
|---|---|
| macOS | NSPanel with `NSWindowAbove` level, `NSWindowCollectionBehaviorMoveToActiveSpace`; snap via `[NSScreen mainScreen visibleFrame]` + STS2 window bounds via Accessibility API (needs user grant) |
| Windows | WS_EX_TOPMOST + WS_EX_NOACTIVATE; snap via `EnumWindows` + `FindWindowEx` for the STS2 main HWND |
| Linux | wlroots `layer-shell` for Wayland; `_NET_WM_STATE_ABOVE` for X11 |

Snap is **opt-in**, not mandatory — if the user disables it, the overlay floats and they drag it where they like (position persisted to local config).

### "Mark Ready" — the killer interaction

The overlay's ready-up chip dispatches a click event into the embedded web view; the web view's existing handler fires `POST /api/coop/parties/:partyId/me/status` — exactly the same code path the web Party Hub uses. **No new backend endpoint, no new API surface.** The overlay is purely a UI shell over the existing web state machine.

### Open questions

- Accessibility-API window snapping requires a one-time macOS grant (`System Settings → Privacy → Accessibility`). UX should educate, not surprise. Pattern: first launch shows a "Want the overlay to snap to STS2? Grant Accessibility" card, with a "Not now" option that falls back to floating.
- Should the overlay show the **other party members'** character-select progress in real time? Backend already has `member.status` — the answer is yes, and the design already accounts for it via the podium `data-ready` attribute.
- On Linux/Wayland, transparency + always-on-top is compositor-dependent. v1 should ship Linux as "floating only, no transparency" and improve later.

### Effort estimate

- Desktop wrapper window mgmt (2 platforms): ~3 days
- Overlay-mode CSS + body attribute: ~1 day
- Accessibility grant UX: ~0.5 day
- E2E + ready-up smoke test in overlay: ~0.5 day
- Polish + animation feel parity with web: ~1 day

**Total:** ~6 days for a shippable v1 (macOS + Windows). Linux + 1 day.

---

## Combined rollout plan

1. **Pre-req:** desktop wrapper picks up the existing Party Hub web bundle (already in `docs/overlay-party-room-deferred.md`). Today this is stale — the wrapper would load `app.spirevault.app/party/{id}` directly. Either way, no new web code needed before this spike unlocks.
2. **Phase 1 — Rich Presence only.** Ship presence-only behind a setting. Friends see SpireVault parties in Discord; they click "Ask to Join" → opens the web Party Hub join flow. No overlay yet. **Win:** existing Discord LFG channels gain real-time SpireVault context without players doing anything.
3. **Phase 2 — Overlay shell.** Ship the overlay window with the embedded Party Hub. No window-snap yet, just a floating panel the user drags into place. **Win:** ready-up + voice-join without alt-tab.
4. **Phase 3 — Overlay polish + window snap.** Accessibility grant flow, STS2 detection, transparency tuning. **Win:** "this feels like it shipped with the game."

Each phase is independently valuable and shippable. Phase 1 alone moves SpireVault from "nice web tool" to "Discord LFG amplifier." Phase 2+3 finishes the "must-have" promise.

## What this spike does NOT include

- Discord OAuth login. We never need it for these features; presence and join-request use only the IPC channel + URL handler. Adding OAuth is a separate decision with separate tradeoffs.
- Discord bot for posting LFG messages into channels. The web Party Hub already provides a clipboard rich embed — bot delivery is sugar, not core.
- Reading the STS2 game state. We do NOT inject into STS2, modify memory, or call modding APIs. The overlay reflects SpireVault party state only; the game and the overlay live in parallel.
- Any change to the existing web bundle's behavior. The overlay reuses the existing web Party Hub render path with a body-attribute opt-in for chrome-stripping.

## Risk + open questions to resolve before Phase 1

- Discord application registration timeline. Their team has occasionally delayed companion-app approvals 2–4 weeks. Submit early.
- Apple notarization of the desktop wrapper with the new IPC binary — confirm we're already on a notarized track.
- `joinSecret` encryption — should it be backend-issued (server-known secret, time-limited) or wrapper-issued (HMAC over partyId + nonce)? Lean server-issued so the host can revoke.
- Should the overlay also expose Quick Play? Probably yes — but that's Phase 2 polish, not part of the initial spike.

---

## Why I'm filing this as a spike

It is shippable engineering work, but it's outside the scope of a single web turn because every feature crosses the browser sandbox boundary. The web team can keep iterating on Party Hub, Live Parties, and matching without blocking on this. When the desktop wrapper picks back up, both features are pre-designed — the implementer reads this doc, picks a phase, and ships.
