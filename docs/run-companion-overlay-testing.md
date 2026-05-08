# Run Companion Overlay - Local QA

## Preconditions

1. Clone repo.
2. Checkout `feature/run-companion-overlay`.
3. Install dependencies where needed:
   - `cd Backend && npm install`
   - `cd Web && npm install`
   - `cd Site && npm install`

## Web companion QA

1. Run local web app (`cd Web && make dev`).
2. Open local URL and verify existing landing/shell still loads.
3. Verify existing tabs still work: Overview, Characters, Ascensions, Relics, Cards, Runs, Co-op, News.
4. Confirm Overview shows the **Run Companion Overlay** card.
5. Click `Open overlay`; verify Overlay tab loads.
6. Open `/overlay`; verify the same Overlay panel loads.
7. Switch modes (Full / Compact / Minimal HUD).
8. Fill run status fields.
9. Toggle deck-direction tags.
10. Toggle decision checklist items and confirm the **Advisor** card recommendation updates immediately.
11. Add/update notes.
12. Toggle reminders.
13. Update overlay settings (font size, position, transparency, privacy reminder).
14. Refresh page; verify overlay state persists, including collapsed sections and AI provider settings.
15. Confirm no overlay data is sent to backend by default (network tab).
16. Confirm no console errors.

## Advisor (local recommendation)

1. With no decision checked, confirm the Advisor shows a generic deck-direction nudge.
2. Check `Card reward` and confirm the recommendation switches to a card-reward heuristic.
3. Toggle `Need scaling` reminder; confirm rationale updates and confidence rises.
4. Switch decision to `Shop` and confirm advice changes again.
5. Confirm the Advisor card shows confidence pill (low/medium/high) and an Assumptions disclosure.
6. Confirm copy explicitly states: support, not a verdict, no game memory, no automation.

## Optional AI screenshot assist

1. Expand `Screenshot assist (optional)` and confirm the consent banner appears first.
2. Click `I understand, enable manual screenshot assist`; banner disappears, settings unlock.
3. Enter a fake API key, click `Analyze screenshot`, pick a small PNG.
4. Confirm a friendly error toast appears (the key is invalid, the call is gated, no crash).
5. Enter a real key (only if you choose), pick a screenshot of a card-reward screen.
6. Confirm the Advisor card replaces the local recommendation with the AI result and a `Screenshot assist` source pill.
7. Click `Clear last AI result`; confirm Advisor reverts to local recommendation.
8. Click `Analyze screenshot` twice in a row within 10 seconds; confirm a rate-limit toast.

## Regression checks

1. Steam OpenID sign-in still works.
2. Co-op live feed and invite flow still render.
3. Local run import still works from folder picker.
4. IndexedDB/local cached runs still load.
5. News tab still loads and marks read state.
6. Marketing page still renders all sections.

## Optional native planning check

- Native always-on-top overlay is planned, not implemented in this pass.
- Verify copy labels this as native-only/planned where applicable.

## Build verification

- `cd Web && make preflight` passes.
- `cd Backend && npm install && npx tsc --noEmit` passes.
- No linter errors on edited files.

## Production safety

- Do NOT deploy from this branch automatically.
- All changes stay local on `feature/run-companion-overlay`.
- Cloudflare config, KV, secrets, DNS untouched.
