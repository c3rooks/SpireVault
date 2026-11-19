# SpireVault Sync

A browser extension that keeps [SpireVault](https://app.spirevault.app) up to date with your Slay the Spire 2 runs. Finish a run, switch to the SpireVault tab, and it is already there.

Browsers do not let a website read the game's save folder (Chromium blocks `~/Library`, Roaming AppData and `~/.local/share` for pages; Safari and Firefox have no folder access at all), so the site alone can only take a snapshot each time you pick the folder. An extension can read it, once you turn on one switch.

Works in Chrome, Edge, Brave, Arc and Opera on a computer. Manifest V3, no dependencies, no build step: the browser loads this folder as it is.

## What it does

1. A SpireVault tab asks "anything new?" when it loads, when you come back to it, and about once a minute.
2. The service worker lists the save folder and compares it with what the tab already has.
3. It reads the new `.run` files and hands their text to the tab, which imports them like a manual import.

It reads; it never writes. It keeps no account data and no sign-in, runs no remote code, and makes no network requests of its own.

## What it is allowed to read

Chrome's file access for extensions is all or nothing (the switch **Allow access to file URLs**), so the limit is in the code, in `lib/paths.js`, and it is tested:

```
<…>/SlayTheSpire2/steam/<17-digit Steam ID>/profile<N>/saves/history/<name>.run
<…>/SlayTheSpire2/steam/<17-digit Steam ID>/modded/profile<N>/saves/history/<name>.run
```

plus one listing of the computer's user folders (`/Users/`, `/home/`, `C:\Users\`) to find your home folder. `.run.backup` files and everything else are skipped. A page cannot hand the extension a URL or a path to read; it can only say which run files it already has. When you are signed in to SpireVault, only that Steam account's folder is read.

Only SpireVault may ask: the content script runs on `https://app.spirevault.app` (and on `http://127.0.0.1` in this development folder; the store build removes that), relays only messages the page posted to itself, and the service worker checks the sender and every field again. Opening the settings page or changing the folder is relayed only right after a click or a key press. The page is never told where the folder is (the path holds your computer's user name); only the popup shows it.

## Files

| File | Role |
|---|---|
| `manifest.json` | Permissions: `file:///*`, the SpireVault origin, `storage`, `scripting`. |
| `background.js` | Service worker: answers the page, opens the settings page, reconnects open tabs. All `chrome.*` calls are here. |
| `content.js` | The bridge inside a SpireVault tab. Relays messages, nothing else. |
| `lib/listing.js` | Reads Chromium's generated folder-listing page. |
| `lib/paths.js` | Where the saves are on each system, and the only paths that may be read. |
| `lib/diff.js` | Which files are new; size caps. |
| `lib/messages.js` | What a page may ask, and who may ask. |
| `lib/sync.js` | Finds the folder, lists the runs, reads the new ones. |
| `popup.*` | The toolbar popup: is it working, and the one button that fixes it if not. |
| `tests/` | `node --test`; a pretend disk built from `tests/fixtures/saves`. |
| `scripts/pack.mjs` | Builds the store zip. |

The page side is in `Web/lib/sync-bridge*.js`; see `docs/sync-extension/web-hooks.md`.

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, pick this folder.
2. Open a local SpireVault build at `http://127.0.0.1:<port>/?sync=1`.

An unpacked extension starts with **Allow access to file URLs** already on. To see what a store install looks like, turn it off on the extension's **Details** page; the SpireVault toolbar then shows **Auto-sync** with the one step that is left.

## Test

```
node --test Extension/tests/*.test.mjs        # parser, paths, diff, messages, discovery (no browser)
node scripts/verify-sync-extension.mjs        # the real extension in Chromium against a fixture save folder
```

## Pack for the stores

```
node Extension/scripts/pack.mjs
```

writes `Extension/dist/spirevault-sync-<version>.zip` with only the shipped files and without the `127.0.0.1` test origin. Listing text, the privacy disclosure and the permission justifications are drafted in `docs/sync-extension/store-listing.md`.

## Not verified yet

- **Windows and Linux save paths.** Only macOS has been run on a real machine. If the folder is not found, the setup card asks for it; `%APPDATA%\SlayTheSpire2` and `~/.local/share/SlayTheSpire2` work as typed.
- **A store install.** Tested unpacked only; see `docs/sync-extension/phase-0-findings.md`.
- **Edge, Brave, Arc, Opera.** Same engine, not run.
- **The run in progress** (`current_run.save`) is not read. The "current run" card still needs a manual import.
