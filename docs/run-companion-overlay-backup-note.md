# Run Companion Overlay Backup Note

Date: 2026-05-06  
Branch: `feature/run-companion-overlay`  
Scope: Local-only planning + implementation for Overlay preview.

## Repository Surfaces Identified

- Frontend app (web companion): `Web/`
- Marketing site: `Site/`
- Cloudflare Worker backend: `Backend/`
- Native macOS SwiftUI app: `VaultApp/`
- Shared Swift package + CLI: `TheVault/`

## Important Existing Routes / Entry Points (Before Overlay Edits)

- Web app root: `/`
- Web auth callback: `/auth.html`
- Worker proxy session endpoint (Pages Functions): `/api/_session`
- Worker API passthrough (Pages Functions): `/api/*`
- Worker auth + coop endpoints (origin worker): `/me`, `/presence`, `/invites`, `/runs`
- Marketing site root: `https://spirevault.app/`

## Important Files to Preserve

- Web shell and behavior:
  - `Web/index.html`
  - `Web/script.js`
  - `Web/styles.css`
  - `Web/_headers`
- Web API/session proxy:
  - `Web/functions/api/_session.js`
  - `Web/functions/api/[[path]].js`
- Marketing site:
  - `Site/index.html`
  - `Site/styles.css`
- Backend worker:
  - `Backend/src/index.ts`
  - `Backend/src/auth.ts`
  - `Backend/src/presence.ts`
  - `Backend/src/runs.ts`
- Native app:
  - `VaultApp/App/RootView.swift`
  - `VaultApp/App/SettingsView.swift`
  - `VaultApp/App/AppState.swift`

## Safety Rules for This Pass

- No production deploy.
- No Cloudflare production config edits.
- No KV namespace or route changes in production.
- Keep changes local in this branch.
