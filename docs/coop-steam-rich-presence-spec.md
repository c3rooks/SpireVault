# Steam Rich Presence Integration — spec

Status: **web-side endpoint shipped in v0.11.0. Native helper deferred
to v0.12.0 (2–4 weeks).**

The version of SpireVault that wins is the one that's *already
running* when you boot STS2. A small background process watches the
Steam client, sees STS2 launch, and flips your SpireVault co-op
status to "Looking" without you opening a tab. When you quit STS2,
your status goes back to idle on its own. This is what turns
SpireVault from a tool you remember to use into a daemon.

## v0.11.0 (this release): the web half

- `Backend/src/coop-rich-presence.ts` — pure `planRichPresenceUpdate`
  function + audit log helper. No presence write inside this module;
  it returns the *plan* and the caller (the helper itself) hits
  `/coop/heartbeat` with the computed status.
- `POST /coop/rich-presence/ingest` — authed, 30/min IP rate limit.
  Accepts the helper's report, validates the STS2 app id (2868840),
  logs the ingest for "is the helper alive?" debugging, returns the
  computed plan.
- KV: `coop:richp:log:<steamID>` — 50-entry capped audit log per
  Steam ID, 7-day TTL.

The endpoint is up *now* so the desktop helper can be developed
against a real production target.

## v0.12.0: the native helper

Lives under `VaultApp/App/Helpers/SteamRichPresence/` (macOS,
SwiftUI / no UI window) and `VaultApp/Windows/SpireVaultHelper/`
(Windows, .NET background service). One binary per platform, ~5 MB
each.

### Detection: how the helper knows STS2 is running

**macOS:**
- Steam exposes a JSON file at `~/Library/Application Support/Steam/
  config/loginusers.vdf` plus a running-game pipe at
  `~/Library/Application Support/Steam/Steam.AppIfn`.
- More reliable: watch the Steam process's running-game IPC by
  subscribing to the system's running-app list via
  `NSWorkspace.shared.notificationCenter` observing
  `didLaunchApplicationNotification` / `didTerminateApplicationNotification`
  for bundle id `com.valvesoftware.steam`. When Steam announces a
  running game, the helper polls
  `~/Library/Application Support/Steam/registry.vdf` for the
  `RunningAppID` value (set by Steam each time a game starts).
- Cross-check: poll `pgrep -f "Slay the Spire 2"` once per second.
  AppID 2868840 confirms.

**Windows:**
- Same idea with `HKCU\Software\Valve\Steam\RunningAppID` in the
  Windows registry. Steam updates it instantly on game start /
  stop.
- Cross-check: `Process.GetProcessesByName("Slay the Spire 2")`.

### Report cadence

- On state change → immediate POST.
- Heartbeat: every 60s while STS2 is running, every 120s while not.
- Backoff on 429 / 5xx: 30s, then 1 min, then 5 min, capped at 5 min.

### Auth

The helper reads a SpireVault session token from a shared keychain
entry (`com.spirevault.session` on macOS, Credential Vault on
Windows). The token is the same one the web companion uses, written
by the web app via a `postMessage` handshake the first time the user
opens SpireVault with the helper running. No re-login.

### Activity detail

The helper does *not* read STS2 saves directly (that's VaultCore's
job, and we don't want two readers fighting for the file lock). It
reports only:
- `state`: `"in-game"`, `"in-menu"`, or `"not-running"`.
- Optional `activityDetail`: pulled from Steam's own Rich Presence
  API (`SteamFriends.GetFriendRichPresence()`), which STS2 already
  populates with strings like "Floor 12 · A15."

### Distribution

- macOS: signed-and-notarised pkg installer at
  `https://github.com/c3rooks/SpireVault/releases/latest/download/
  SpireVaultHelper.pkg`. Adds a LaunchAgent under
  `~/Library/LaunchAgents/com.spirevault.helper.plist`. Auto-update
  via the same Sparkle channel as Vault.app.
- Windows: MSI installer registers a Windows Service named
  `SpireVaultHelper`. Auto-update via Squirrel.
- Linux: a `systemd --user` unit + a tarball. Less polish, ships
  same week.

### Opt-out

The helper checks for `~/Library/Application Support/SpireVault/
helper-disabled` (macOS) / equivalent on other OSes every 60s and
exits cleanly if found. The settings panel in Vault.app surfaces
this as a toggle.

## What's not in v0.12 (deferred)

- **Public visibility of activity detail to non-friends.** Steam's
  RP is friends-only at the source. We can only show it to other
  SpireVault users who are *also* Steam friends with this user. v0.13
  spec.
- **Helper-driven invite acceptance.** A nice future feature where
  accepting a SpireVault invite triggers `steam://run/2868840` on
  the user's machine via the helper. Adds substantial complexity for
  marginal lift over the existing "Launch Steam now" CTA. Park.
- **Helper-driven save-folder discovery.** The desktop app already
  asks via `NSOpenPanel`. No reason to move it into the helper.
