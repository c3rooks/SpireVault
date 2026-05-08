# Run Companion Overlay Plan

## 1) Feature Summary

SpireVault will add a new `Overlay` experience called **Run Companion Overlay**.  
It is a local-first decision-support panel that helps players track run context and make better choices while playing, without modifying the game.

The first version ships as:

- a new **Overlay tab** in the web companion
- a **compact overlay preview mode** (narrow side panel simulation)
- persistent local settings and notes
- trust-first copy that clearly states what the overlay does and does not do

## 2) User Value Proposition

Players often lose context mid-run (path risk, deck direction, potion timing, boss prep, co-op role clarity).  
The overlay keeps these decisions visible in one small panel so users can think faster and more consistently.

Core value statement:

> Make better Slay the Spire 2 run decisions without uploading run history or modifying the game.

## 3) Primary User Flow

1. User opens SpireVault and lands on Overview.
2. User sees a new **Run Companion Overlay** card and taps `Open overlay`.
3. App switches to `/overlay` (or `?tab=overlay` fallback).
4. User selects overlay mode (Full / Compact / Minimal HUD).
5. User fills quick run status and deck-direction tags.
6. User adds short notes and toggles reminder chips.
7. User uses decision helper checklists for card/path/shop/co-op calls.
8. User refreshes/reopens and finds all overlay data persisted locally.

## 4) UI Placement Strategy

- **Marketing site** (`Site/`):
  - Add a dedicated feature section for Run Companion Overlay
  - Include trust copy and CTA buttons:
    - `Try the Web Companion`
    - `Open Overlay Preview`
    - `Read Privacy Model`
  - Add feature badges:
    - Optional
    - Local-first
    - No game modification
    - No run upload
    - macOS companion
    - Web preview

- **Web app navigation** (`Web/`):
  - Add new nav item: `Overlay` (marked `Preview` / `Beta`)
  - Route support:
    - `/overlay`
    - `/?tab=overlay`

- **Overview dashboard**:
  - Add a small card entry point:
    - title + short explanation
    - `Open overlay`
    - `Preview compact mode`

- **Overlay settings surface**:
  - Include settings card inside overlay page for MVP:
    - enable toggle
    - mode
    - always-on-top (native planned label)
    - transparency
    - font size
    - position
    - privacy reminder toggle

## 5) Data / Privacy Model

Local only by default.

Persist in web local storage (or existing local-first pattern) for:

- overlay enabled
- overlay mode
- run status fields (character, act, floor, ascension, goal, boss, path risk)
- deck direction tags
- decision checklists
- notes
- reminder chips
- overlay preferences (font size, position, transparency, privacy reminder)

Rules:

- No overlay notes sent to backend by default.
- No memory reading, no injection, no automation.
- Overlay remains optional and user-controlled.

## 6) MVP Scope

- New Overlay nav tab and route support
- Full Companion mode and Compact mode UI in web app
- Run status form
- Deck direction tags
- Next decision checklist
- Notes text area
- Reminder chips
- Decision helper checklist blocks
- Always-visible privacy card
- Overlay feature labels: `Preview`, `Beta`, `Local-first`, `No game modification`
- Overview entry card + marketing section
- Persistent local state

## 7) Future Scope

- Native macOS always-on-top companion window
- Draggable compact mini-window behavior in native app
- Optional local profile templates (per character)
- Optional import from current run snapshot
- Optional co-op shared planning (explicit opt-in only)
- Optional AI helper prompts only when user provides key/config

## 8) Technical Risks

- Routing on static Pages may 404 without redirect rule for `/overlay`
- Overlay controls can create text overflow on narrow widths if not constrained
- Too many toggles can clutter compact mode if not sectioned carefully
- Existing tab logic might regress if Overlay is not integrated into active-tab switch
- Persistence drift if state schema changes without migration guard

Mitigations:

- add explicit Pages redirect fallback for `/overlay`
- responsive CSS for compact widths
- schema-safe defaults for missing fields
- keep overlay state isolated under a dedicated key

## 9) Local Testing Plan

Manual QA for this pass:

1. Run local web app.
2. Verify existing tabs still render.
3. Verify Overlay nav appears and opens.
4. Visit `/overlay` directly, confirm same overlay UI loads.
5. Fill run status fields and tags.
6. Toggle reminders and decision helper checkboxes.
7. Change overlay preferences and mode.
8. Refresh page and confirm persistence.
9. Confirm no overlay POST/PUT calls are made to backend by default.
10. Verify mobile/narrow width compact readability.
11. Verify no console errors.
12. Verify marketing overlay section and CTAs render.

## 10) Deployment Plan (Preparation Only, No Deploy)

1. Keep changes isolated on `feature/run-companion-overlay`.
2. Run local checks (`typecheck`, `lint`, `build`) where available.
3. Manual QA pass for existing flows:
   - Steam sign-in
   - co-op feed/invites
   - run import/history
   - overview stats tabs
4. Open PR with screenshots of:
   - marketing section
   - overlay full mode
   - overlay compact mode
5. After review approval, run normal release pipeline in a separate deploy step.

No production deployment is performed in this implementation pass.
