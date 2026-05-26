# SpireVaultHelper

Tiny macOS LaunchAgent that watches the Steam process and POSTs
state changes to SpireVault's `/coop/rich-presence/ingest` endpoint
so your co-op lobby presence flips automatically when STS2 boots
or quits.

## What it does

- Observes `NSWorkspace` for Steam launch / terminate events.
- Polls `~/Library/Application Support/Steam/registry.vdf` once per
  second while Steam is running, reading the `RunningAppID` value.
  If it's `2868840` (STS2), state is `in-game`. Steam running with no
  active game is `in-menu`. Steam not running is `not-running`.
- Optionally pulls Steam Rich Presence's `steam_display` token out
  of `userdata/<id>/config/localconfig.vdf` so the server can show
  "Currently: Floor 12 · A15" under your name in lobbies.
- POSTs to the worker on every state change AND on a 60s heartbeat
  (running) / 120s heartbeat (idle).
- Reads the SpireVault session token from the user's keychain
  (service `com.spirevault.session`). If missing, exits cleanly —
  the LaunchAgent will respawn at next login. The Vault.app writes
  the token after the first successful Steam sign-in.
- Checks `~/Library/Application Support/SpireVault/helper-disabled`
  every 60 seconds. If present, exits cleanly (Vault.app's settings
  toggle creates / removes this file).

## Build

```bash
cd VaultApp/Helpers/SteamRichPresence

# Universal binary (arm64 + x86_64)
swift build -c release --arch arm64 --arch x86_64

# Output:
ls -la .build/apple/Products/Release/SpireVaultHelper
```

No external dependencies. Pure Foundation + AppKit. ~1.5 MB stripped.

## Run locally (without installing the LaunchAgent)

```bash
# Default base URL (production worker):
./.build/apple/Products/Release/SpireVaultHelper

# Point at local worker dev:
./.build/apple/Products/Release/SpireVaultHelper \
  --base-url http://localhost:8787
```

You'll see ISO-timestamped log lines on stderr. Quit with Ctrl-C.

For a real run, drop a session token at
`~/Library/Application Support/SpireVault/session-token` (one-line,
the same token the web app uses; the helper will seal it into the
keychain on first read) OR write the keychain item directly with
`security add-generic-password -s com.spirevault.session -a default
-w <TOKEN>`.

## Install (release pkg)

The release pkg installer (separate ticket — see
`scripts/build-helper-pkg.sh`) does:

1. Drops the binary at
   `/usr/local/bin/SpireVaultHelper`.
2. Rewrites `__INSTALL_PATH__` and `__HOME__` placeholders in
   `Resources/com.spirevault.helper.plist` and installs it to
   `~/Library/LaunchAgents/com.spirevault.helper.plist`.
3. Runs `launchctl load -w ~/Library/LaunchAgents/com.spirevault.helper.plist`.

Uninstall:

```bash
launchctl unload ~/Library/LaunchAgents/com.spirevault.helper.plist
rm ~/Library/LaunchAgents/com.spirevault.helper.plist
rm /usr/local/bin/SpireVaultHelper
```

## Privacy

- The helper reads two files in your Steam data directory:
  `registry.vdf` (for `RunningAppID`) and `userdata/*/config/localconfig.vdf`
  (for the Rich Presence display string). It never reads your save
  game files, your friends list, or anything outside those two
  paths.
- It sends one POST per state change + a heartbeat. The body is:
  `{ helperVersion, hostOS, state, stsAppId, activityDetail?, reportedAt }`.
  No machine name, no Steam ID, no anything else. The user's Steam
  ID is derived server-side from the session token.
- The opt-out flag is a single touch:
  `touch ~/Library/Application\ Support/SpireVault/helper-disabled`
  causes the helper to exit on its next tick. Vault.app's settings
  panel exposes this as a toggle.

## Spec

Full design + Windows / Linux build plans:
[`docs/coop-steam-rich-presence-spec.md`](../../../docs/coop-steam-rich-presence-spec.md).
