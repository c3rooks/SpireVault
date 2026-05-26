# Co-op Party Room Bridge

Branch: `feature/coop-party-room-bridge`  
Scope: Run Lobby slots (2–4), Request Seat flow, Party Room web at `/party/:partyId`, Classic + Co-op Lobby Beta only.

## Classic vs Co-op Lobby Beta (unchanged contract)

- **Kill switch:** `COOP_LOBBY_BETA_ENABLED` in `Web/script.js` (default on in dev).
- **Per-user opt-in:** `localStorage.coop_lobby_beta` (`"1"` = Beta, absent/`"0"` = Classic).
- **Surfaces:** `data-coop-mode="classic"` vs `data-coop-mode="beta"` on `body.coop-lobby-beta-on|off`.
- **Backend:** Same `/coop/*` worker; Classic and Beta clients share matchmaking.
- **No third co-op route:** `/coop` only; `/party/:partyId` for Party Room after accept. No `/coop-v2`.

## Party Room

After the host accepts a seat request, members are redirected to `/party/:partyId` with STS2 handoff checklists (Ready, Character Select, In Game, Leave; host may End Party).

## Privacy & overlay (local branch)

- **Privacy:** Steam profile links after accept; no extra PII beyond existing presence fields. Full Steam privacy controls documented in Party Room help text.
- **Overlay:** Not mirrored in this pass — web Party Room is canonical. See `docs/overlay-party-room-deferred.md`.

## Deploy safety

Do **not** deploy this branch to production KV/DO until reviewed. All new keys are `coop:party:*` namespaced; legacy keys untouched.
