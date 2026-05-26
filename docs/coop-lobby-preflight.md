# Co-op Lobby Beta — pre-flight smoke checklist

Last verified: $(date) on this branch.

This document is the gate between "Beta Default in dev" and
"Beta Default in production." Run every step before flipping the prod
deploy. It exists because automated tests can stub everything except
the real Steam OpenID round trip and the real Cloudflare Worker.

---

## Automated coverage already passing on this branch

The following Puppeteer tests run against `wrangler pages dev`:

| Test                          | What it covers                                                  |
| ----------------------------- | --------------------------------------------------------------- |
| `pf-coop-log-test`            | Campfire Log ribbon mounts; My Co-op modal opens                |
| `pf-default-beta-test`        | Beta defaults ON; Switch to Classic flips and persists          |
| `pf-host-above-fold-test`     | "Host a Room" CTA visible on 1024×700 + 390×844 without scroll  |
| `pf-host-modal-test`          | Host modal renders 6 fields with no domain-violation strings    |
| `pf-scene-test`               | Hero stage stats; Party Hub deep-link Discord clipboard         |
| `pf-in-party-error-test`      | Backend `already_in_party` surface + Refresh-now button         |
| `pf-mic-labels-test`          | Mic options are Mic preferred / Mic optional / Quiet — no mic   |
| `pf-startsoon-test`           | Alerts gear+popover, planned-start chiprow, encoded `[start=]`  |
| `pf-startsoon-p2-test`        | Live Parties sort, hero "starting soon" tile, host Lock-in      |
| `pf-campfire-xp-test`         | XP curve, persona fallback, heart-give cool-down                |
| `pf-console-errors-test`      | No console errors during full common flow                       |

Plus a pure-Node sanitizer round-trip (`pf-sanitizer-roundtrip-test`)
that verifies the `[start=ISO]` prefix survives the production
`sanitizeText` regex byte-for-byte.

---

## Manual smoke — required before flipping `Beta Default → ON` in prod

You will need:

- 2 real Steam accounts logged into SpireVault on 2 different machines
  or browsers. The headless tests cannot exercise OpenID.
- 1 Discord channel where you can post and see your own message
  preview.

### A. Backend round-trip with the real Worker (blocks ship)

1. Deploy backend to a preview env: `cd Backend && npx wrangler deploy`.
2. From account 1, host a room with a planned start of "In 15 min" and
   a note like `Heart attempt — chill`.
3. Open the lobby in DevTools → Network and inspect the POST/PATCH
   payload to `/coop/lobbies`. The `note` field MUST start with
   `[start=YYYY-MM-DDTHH:MM:SSZ]` and contain your text.
4. From account 2, GET `/coop/state`. The same lobby's `note` field
   in the response must be byte-identical (no stripped brackets, no
   altered whitespace).
5. **PASS criteria:** account 2 sees the live countdown badge update
   every second and the badge text reads "in 15m" → "in 14m" etc.

### B. Server kill switch (blocks ship)

1. With Beta default ON in localStorage, set the Worker env
   `COOP_LOBBY_BETA_KILL=1` (use `wrangler secret put COOP_LOBBY_BETA_KILL`
   or edit `Backend/wrangler.toml` `[vars]`).
2. Redeploy. Wait ≤15s on a focused tab.
3. **PASS criteria:** The Beta UI swaps back to Classic without a
   page reload, and `localStorage.getItem("spirevault.coopLobbyBeta.kill")`
   reads `"1"`.
4. Clear the var, redeploy. Reload. Beta returns.

URL override (no deploy): visit `/coop?beta=off` → flips to Classic
and persists; `/coop?beta=on` → flips back. `/coop?beta=kill` → sets
the kill flag for that browser only. The query string is stripped on
landing so links stay clean.

### C. Real Discord round-trip (blocks newsletter)

1. From account 1, host a room with planned start "In 30 min."
2. Click **Copy Discord LFG Post** in the Party Hub.
3. Paste into Discord. Verify the post body contains:
   - `Starts <t:UNIX:R>` rendered live as "in 29 minutes"
   - `(<t:UNIX:t> your time)` rendered as the channel viewer's local
     time, NOT yours
   - The SpireVault join link
4. Wait 5 minutes. **PASS criteria:** The Discord message updates by
   itself — no edit, no re-post.

### D. Two-tab convergence (blocks newsletter)

1. Open SpireVault in two browser tabs as the same user.
2. In tab A, give a heart to a teammate from the My Co-op modal.
3. **PASS criteria:** Tab B's Campfire Log Hearts tile increments
   within ~250 ms (BroadcastChannel) or on next focus (storage
   event fallback). No reload required.

### E. Offline / state-failure recovery (blocks ship)

1. Throttle your network to "Offline" in DevTools.
2. Wait 30s. **PASS criteria:** A yellow "Reconnecting…" banner
   appears at the top of the Co-op tab.
3. Wait 60s more. The banner copy switches to "Can't reach the
   server. Your stats may be stale." in red.
4. Click **Retry now**, restore network. Banner clears.

### F. Notification permission flow (blocks newsletter)

1. Fresh browser profile. Click the **⚙ Alerts** gear in the hero.
2. Click **Browser notification**. The permission prompt fires.
3. Choose "Allow." **PASS criteria:** the gear's green dot lights up;
   the popover label reads "on."
4. Block in browser settings. Reload. **PASS criteria:** the popover
   label reads "blocked," and clicking it does NOT re-prompt.

### G. Audio chime — Safari sanity (recommended)

1. Open in Safari (macOS or iOS).
2. Click **⚙ Alerts** → **Sound chime**. Test chime should play.
3. **PASS criteria:** chime audible. If silent, AudioContext lock
   bypass needs review (see `tryUnlockAudio` in `party-finder-startsoon-rt.js`
   — it now resumes synchronously in the click handler, but iOS Safari
   has historically been finicky).

### H. STS2 deep link with no Steam installed (recommended)

1. Open in a fresh browser on a machine without Steam installed.
2. Trigger a GO moment (use the Dev Sandbox to fast-forward a lobby).
3. Click **Launch Steam.** **PASS criteria:** ~800 ms after the click,
   a "Don't have Steam? Open the store →" link appears under the CTA.

---

## Beta toggle copy — verified

Default ON state:
> "Prefer the old layout? Switch to Classic Co-op"

Opt-out state (after clicking Switch to Classic):
> "You're on Classic Co-op. Switch to the new Co-op Lobby"

Killed state (`ENABLE_COOP_LOBBY_BETA = false` OR server kill flag):
> Toggle is hidden. Users see Classic Co-op only.

---

## Rollback procedure

1. **Server-side, no deploy:** `wrangler secret put COOP_LOBBY_BETA_KILL`
   and set to `1`. Within ≤15s every focused tab swaps to Classic.
2. **Per-user, no deploy:** share `<spirevault.app>/coop?beta=off`
   in your Discord support channel.
3. **Code, requires deploy:** flip `ENABLE_COOP_LOBBY_BETA = false`
   in `Web/script.js` and redeploy. The toggle disappears entirely.

---

## What still needs a backend before week-1 post-ship

- Real `lobby.plannedStartAt` field replacing the `[start=...]` shim
  (cleaner DX; the shim works, but it shouldn't live forever).
- Cross-member ready-up (`readyMemberIds[]` on lobbies + a
  `/coop/lobbies/:id/ready` endpoint).
- Server-side hearts-received counter (currently `pf.heartsGiven.v1`
  is browser-local).
- Web Push (replaces the in-tab `Notification` API for users who
  closed the tab).
- Analytics: host rate, lock-in usage, Discord copy rate, GO →
  Steam launch conversion.
