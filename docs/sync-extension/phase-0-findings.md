# SpireVault Sync, phase 0: what a Chrome extension can read

*Tested 2026-11-19 on macOS, in real Google Chrome 157.0.8103.79 and in Playwright's Chromium 151, with throwaway profiles and throwaway extensions. Read-only: nothing was installed in anyone's own Chrome profile and no save file was touched.*

## The question

Can a Manifest V3 extension list the Slay the Spire 2 save folder and read its `.run` files, in real Chrome, and what is the least permission that allows it?

## Answer

Yes. With the extension's **Allow access to file URLs** switch on, a service worker (or any extension page) can `fetch()` a `file://` folder and gets Chromium's generated listing page, and can `fetch()` any file in it. With the switch off, every `file://` fetch fails. The permission cannot be narrowed to the game's folder: Chrome discards the path of a `file:` host permission.

## What was run

Six throwaway extensions, identical except for the manifest, each probed from its service worker and from an extension page, with the switch on, off, and on again:

| Manifest | Switch on | Switch off | Permission Chrome reports |
|---|---|---|---|
| `host_permissions: ["file:///*"]` | reads everything | every fetch fails | `file:///*` |
| `host_permissions: ["file:///Users/*/Library/Application%20Support/SlayTheSpire2/*"]` | reads everything, **including files outside that folder** | every fetch fails | `file:///*` |
| same pattern with a literal space | same | same | `file:///*` |
| only `optional_host_permissions: ["file:///*"]` | every fetch fails (not granted until requested) | every fetch fails | none |
| no file permission, one content script matching `file:///*/SlayTheSpire2/*` | reads everything | every fetch fails | the content-script pattern |
| no file permission at all | every fetch fails | every fetch fails | none |

"Reads everything" means all of these worked:

- the history folder's listing (1,352 entries on the test machine, 729 of them `.run`),
- one `.run` file (21,405 bytes, matching the size in the listing),
- the listing of `…/SlayTheSpire2/steam/`, of the home folder, and of `/Users/` (so the home folder can be found without asking),
- a file outside the game folder (`/etc/hosts`), which is the proof that path narrowing does nothing.

Other things measured:

- `chrome.extension.isAllowedFileSchemeAccess()` was `true` with the switch on and `false` with it off, in every variant.
- A folder listing answers with `status 0` and `ok false` but readable text; a file answers `200` and `ok true`. A missing file or folder, or the switch being off, is a rejected fetch (`TypeError: Failed to fetch`).
- No variant produced an install warning for the file permission.
- Flipping the switch restarts the extension. Access comes back with the switch; nothing has to be reinstalled.
- Results in Chromium 151 match Chrome 157.

## Why the path does not narrow anything

Chromium's manifest parser (`extensions/common/manifest_handlers/permissions_parser.cc`, read on `main` the same day) says so directly:

> The path component is not used for host permissions, so we force it to match all paths.

and then calls `pattern.SetPath("/*")`. The same function sets `wants_file_access` for any host permission (required or optional) that covers the `file` scheme, which is what makes the switch appear on the extension's details page, and strips the `file` scheme from the granted pattern until the switch is on.

## Decisions taken from this

1. **Manifest:** `host_permissions: ["file:///*"]`, stated plainly. A narrower-looking pattern would read the same files while claiming otherwise.
2. **The real limit is in the code**, and it is tested: the extension only builds URLs of the form `<…>/SlayTheSpire2/steam/<17 digits>/[modded/]profile<N>/saves/history/<name>.run`, plus one listing of the computer's user folders (`/Users/`, `/home/`, `C:\Users\`) to find the home folder. A page cannot pass it a URL or a path to read. See `Extension/lib/paths.js` and `Extension/tests/`.
3. **Required, not optional, permission.** Optional needs a second prompt on top of the switch. The required one adds no install warning.
4. **Setup has two steps and cannot have fewer:** install, then the switch. Chrome offers no way to turn the switch on from code or from a prompt. The extension opens its own details page (`chrome://extensions/?id=<id>`) so the switch is one click away, and brings the player back to SpireVault when it is flipped.

## What is still unverified

| Point | Why | How to settle it |
|---|---|---|
| A **store install** (packed, switch off by default) | Real Chrome ignores `--load-extension`; the test extensions were loaded unpacked over the debugging pipe, where the switch starts on. The off state was reproduced by turning the switch off, and the parser source says the switch is shown for any `file:` host permission, but an actual store install has not been seen. | First install from the store listing (even unlisted). |
| After the switch is flipped on a store install, does the open SpireVault tab reconnect without a reload? | Works for the unpacked build (covered by `scripts/verify-sync-extension.mjs`). A packed extension restarts through a slightly different path. | Same first store install. If it does not, the page shows the extension as missing until the tab is reloaded; nothing is lost. |
| **Windows** (`C:\Users\<you>\AppData\Roaming\SlayTheSpire2\`) | No Windows machine was available. The path comes from other trackers and Godot's documentation. Listing `file:///C:/Users/` and the listing format on Windows are untested. | Run the extension on Windows once. If the folder is not found, the setup card asks for the path (`%APPDATA%\SlayTheSpire2` works as typed). |
| **Linux** (`~/.local/share/SlayTheSpire2/`, and the Flatpak Steam home) | Same. | Same. Steam Deck's browser may be sandboxed away from the folder; Deck is meant to be covered by the later Workshop mod, not this. |
| Edge, Brave, Arc, Opera | Same engine and the same extension system; not run. | Load the unpacked folder in each. |
| Store review of an extension with `file:///*` | Cannot be known in advance. | The listing drafts in `store-listing.md` explain the single purpose and the limit in code. |

## How to repeat the test in your own Chrome

Nothing needs the command line:

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the repo's `Extension` folder.
2. On the extension's **Details** page, **Allow access to file URLs** is on by default for an unpacked extension. Turn it off to see the store's starting state.
3. Open a local SpireVault build (`http://127.0.0.1:<port>/?sync=1`) and follow the setup card.
