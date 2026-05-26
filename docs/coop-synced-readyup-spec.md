# Synced Ready-up + Auto-advance — spec

Status: **v1 shipped in v0.11.0 (2026-05-26).** Frontend-only.

The existing co-op party engine already accepts `joined` → `ready` →
`character_select` → `in_game` on `POST /coop/parties/:id/status`.
v0.11.0 adds the *coordinated* UI around it — every member sees the
same Ready-up state and the same auto-advance moment.

## What landed

- `Web/lib/party-finder-readyup-rt.js` — classic-script runtime that
  finds the user's own active-party row, attaches a single "Ready up"
  pill, polls `GET /coop/parties/:id` every 4 seconds, and renders
  `X / Y ready`.
- `Web/lib/party-finder-readyup.css` — green-glow toggle states with
  `prefers-reduced-motion` guards.
- Bootloader wiring in `Web/lib/coop-sandbox.js`.

## Auto-advance rule

When **all** non-`left` members of the user's active party are in
status `ready` or `in_game` AND:

1. There are at least 2 members in the party (no solo auto-advance —
   you'd be the only one), AND
2. The lobby's planned start time (parsed from the `[start=ISO]` note
   tag) has already elapsed (or there's no planned start at all),

then this client POSTs `status: "in_game"` for the local user
exactly once (`autoAdvancedFor` Set in memory). Other clients do the
same independently — no central coordinator, no race.

Each client's auto-advance is opt-out per browser via
`localStorage["pf.readyup.autoAdvance.v1"] = "off"`. v0.12 will add a
visible toggle in the Alerts gear popover.

## Why frontend-only

Three reasons:

1. **No new backend code.** The engine already accepts every state
   transition the auto-advance needs. Less surface area = fewer
   regressions.
2. **No leader election.** Every client makes its own decision based
   on observable state. If a client's clock drifts or its network is
   sluggish, it just advances itself later — nobody else is blocked.
3. **Trivial rollback.** Pull `party-finder-readyup-rt.js` from the
   bootloader and the feature is gone. Players still see and use the
   existing manual `Ready` / `In game` status flow.

## What's not in v1

- **Per-member Ready buttons on other members' rows.** Today, only
  the user's own member status is exposed by the engine response;
  rendering Ready badges on every member would need an enriched
  `CoopParty.members[].readyAt` field. v0.12.
- **"Waiting on X" copy.** When all-but-one are ready, the count
  reads `3 / 4 ready`. The follow-up version names the holdout
  ("Waiting on Embertongue") once the engine exposes member persona
  names alongside their status.
- **Audio chime on all-ready.** Reuses the existing Sound-alerts
  toggle. v0.12 adds a distinct "all-ready" two-tone chime.
- **Sound + notification when someone else changes status.** Same
  reason as above — needs server push to be useful without spinning
  up a longer poll. Server-Sent Events spike scheduled for v0.13.
