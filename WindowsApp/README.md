# The Vault — Windows desktop wrapper

A thin native window around the live cloud app at
**[app.spirevault.app](https://app.spirevault.app)**. Built on
[Tauri 2](https://tauri.app), so the binary is ~10 MB instead of the
~120 MB an Electron equivalent would weigh.

The whole point is **parity**: every pixel a user sees, every API call,
every co-op event lives in the cloud — desktop just adds a native
chrome, save-folder watcher, and OBS-invisible overlay window.

```
┌──────────────────────────────────────────────────────┐
│  main window:    https://app.spirevault.app/?desktop=1│
│  overlay window: https://app.spirevault.app/?desktop=1&overlay=1│
└──────────────────────────────────────────────────────┘
```

If you want to change the UI, change the web companion (`Web/`). This
crate only owns: window chrome, file-system watcher, save parsing,
screen capture for Run Coach, and the JavaScript bridge that pipes
local data into the WebView via `window.SpireVault.ingestDesktopRuns`.

## Build it locally

Requires Rust (stable), Node 20+, and Windows 10/11 (the WebView2
runtime ships with the OS since 2022). On macOS this crate can be
built for development too, but the release pipeline is Windows-only.

```bash
cd WindowsApp
npm install            # installs the Tauri CLI as a devDependency
npm run dev            # hot-reload dev build, loads app.spirevault.app
npm run build          # release: target/release/bundle/{nsis,msi}/*.exe
```

The release artefacts land at:

```
WindowsApp/src-tauri/target/release/bundle/
├── nsis/The-Vault_<VERSION>_x64-setup.exe   ← shipped to GitHub Releases
└── msi/The-Vault_<VERSION>_x64_en-US.msi    ← built but not released
```

## CI / Releases

`.github/workflows/desktop-release.yml` is the source of truth. It
fires on any `v*` tag and runs two jobs in parallel:

| Job        | Runner          | Output                                       |
| ---------- | --------------- | -------------------------------------------- |
| `windows`  | windows-latest  | `The-Vault_<v>_x64-setup.exe` (Tauri / NSIS) |
| `macos`    | macos-14        | `The-Vault-<v>.dmg` (native Swift via VaultApp) |

Both upload to the same GitHub Release keyed by the pushed tag. Cut a
release by:

```bash
# from main, with the working tree clean
git tag v0.9.9
git push origin v0.9.9
```

Manual dry runs without producing a release:

```bash
gh workflow run desktop-release.yml -f dry_run=true
```

## What this wrapper deliberately does NOT include

- **No auto-updater plugin.** The web app is loaded fresh on every
  launch — "updates" are just a page reload. This keeps the installer
  surface minimal and avoids the signing-key plumbing the Tauri
  updater plugin requires.
- **No bundled web assets.** `tauri.conf.json` points `url` at
  `https://app.spirevault.app/?desktop=1` directly; the `ui/`
  folder only contains a loading shim used during `cargo tauri dev`
  when the cloud URL is unreachable.
- **No separate desktop UI.** Every navigation tab, button, and
  modal belongs to the web companion. Touch web first, ship to
  desktop free.

## Code signing

Skipped for the MVP. Users see the SmartScreen "Windows protected
your PC" prompt on first launch — click **More info → Run anyway**.
The warning clears automatically once the installer earns reputation
(~50 unique installs). When we're ready to add real signing, populate
these GitHub Actions secrets and the workflow will pick them up
without further changes:

- `WINDOWS_CODE_SIGN_CERT_BASE64`
- `WINDOWS_CODE_SIGN_CERT_PASSWORD`

(See `WindowsApp/src-tauri/tauri.conf.json` → `bundle.windows` for
the signing block we'd populate.)
