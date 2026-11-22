# SpireVault Sync: what changes in the web app

The page side lives in four new files and eight small edits to `Web/script.js`. Nothing else in `Web/` changes: no markup in `index.html`, no generated stylesheet, no new pins beyond the new files' own `?v=1`.

## New files

| File | What it is |
|---|---|
| `Web/lib/sync-bridge.js` | Talks to the extension, schedules syncs and the automatic pulls of the Steam copy. The only file `script.js` imports. |
| `Web/lib/sync-bridge-core.js` | The parts with no DOM: joining new runs to loaded ones, the record of files already taken in, browser support, wording. Checked by `Web/scripts/verify-sync-bridge.mjs`. |
| `Web/lib/sync-bridge-view.js` | The toolbar button, the setup card and the one-line offer on the import screen. |
| `Web/lib/sync-bridge.css` | Their styles for both looks. Loaded on demand, only in desktop Chromium browsers and only once setup is offered. |
| `Web/scripts/verify-sync-bridge.mjs` | Node checks for the core (add to `make preflight`). |
| `scripts/verify-sync-extension.mjs` | Browser checks with the real extension (not part of preflight: about three minutes). |

## The edits to `Web/script.js`

Each is anchored on text that exists unchanged in the v244 tree, the live v250 copy and the merged test build.

1. **Import.** After `import * as OverlayEngine from "/lib/overlay-engine.js?v=1";`:

   ```js
   import * as SyncBridge from "/lib/sync-bridge.js?v=2";
   ```

2. **`ingestHistoryFiles` takes `merge` and `owner`.** The signature becomes:

   ```js
   async function ingestHistoryFiles(files, { silent = false, merge = false, owner = "" } = {}) {
   ```

   `owner` is the Steam ID of the account folder the extension read (`reply.steamId`). A co-op save lists every player and does not mark the local one, so the reader needs it to show the player's own climber, deck and card picks instead of the first player listed (`Web/lib/run-owner.js`).

3. **New files join the loaded runs.** The import commits whatever it is given as the whole run set, which is right for a folder pick and wrong for a sync that brings three new files. The line that calls `commitParsedRuns` becomes:

   ```js
   const runsToCommit = merge
     ? SyncBridge.mergeWithLoaded(runs, { loaded: isDemoMode ? [] : parsedRuns, live: currentRun })
     : runs;
   const committed = await commitParsedRuns(runsToCommit, plausible[0]?.name || "save", { silent, fileCount: plausible.length, stayOnTab: merge });
   ```

4. **A background sync never moves the player.** `commitParsedRuns` gains `stayOnTab = false`, and its "hop to Overview when on a non-stats tab" becomes `} else if (!stayOnTab) {`. Without this a run arriving while the player is on Co-op or News would switch their tab.

5. **The runs status line.** At the top of `runsStatus()`, after the sample-data check:

   ```js
   const synced = SyncBridge.runsStatus({ count: parsedRuns.length });
   if (synced) return synced;
   ```

   While sync is live the line reads "Synced 2 min ago · 732 runs" with the green dot. Ten minutes without an answer and it falls back to the app's own "Saves read …".

6. **Start at boot.** In `boot()`, before the `// Cross-device sync. Two paths feed this same call:` comment:

   ```js
   SyncBridge.start({
     getSteamId: () => session?.steamID || "",
     isSignedIn: () => Boolean(session?.steamID),
     runCount: () => (isDemoMode ? 0 : parsedRuns.length),
     ingest: (files, from) => ingestHistoryFiles(files, { silent: true, merge: true, owner: from?.owner || "" }),
     pullCloud: () => hydrateFromCloudIfAvailable(),
     toast,
     onChange: () => { renderSyncPill(); renderToolbarEmptyPill(); },
     isDesktopHost: IS_DESKTOP_HOST,
   });
   ```

7. **Refresh.** At the top of `reloadSavedHistoryInteractive()`:

   ```js
   if (SyncBridge.isConnected()) {
     void SyncBridge.syncNow({ announce: true });
     return;
   }
   ```

   With the extension connected, Refresh reads the whole folder again through it instead of opening a folder picker.

8. **Clearing the local cache.** In `clearLocalCacheConfirmed()`, before the "Local cache cleared." toast:

   ```js
   SyncBridge.pause();
   ```

   That action promises to disconnect the save folder. Without this the extension would bring every run back within a minute. Auto-sync stays off in that browser until the player turns it back on from the toolbar's Auto-sync button.

## Applying them to another copy

This branch was cut from an older tree than the live site, so at release the edits are made on the release base, not merged from here. Each anchor above appears exactly once in every copy checked (the v244 tree, the live v250 copy, the merged local test build), so the eight edits apply as written, in any order. Copy the four `lib/sync-bridge*` files and `scripts/verify-sync-bridge.mjs` across unchanged.

Then: bump `VAULT_BUILD` and the `script.js?v=` pins as for any release (this branch carries a local-only number, v952, that must never be deployed), add `@node scripts/verify-sync-bridge.mjs` to the `preflight` target, run `make -C Web preflight`, and run `node scripts/verify-sync-extension.mjs` with `VERIFY_SYNC_WEB` pointing at the release copy.

## What a player without the extension sees

Nothing new, until the extension has a store page. `STORE_URLS` in `lib/sync-bridge.js` is empty; while it is, the toolbar button and the card appear only when the extension is already installed, or with `?sync=1` (remembered per browser, `?sync=0` clears it). Put the store links there at launch.

Phones, Safari, Firefox and the desktop apps never see the button. They do get the other half: a signed-in tab pulls the Steam copy again when it is shown (at most every two minutes) and every five minutes while visible, backing off to thirty minutes if the server fails. A pull that changes nothing redraws nothing.

## Request budget

- **Steam copy, GET `/api/runs`:** at most 12 an hour per visible signed-in tab, none while hidden, none signed out. Each is the whole copy (about 1 ms of Worker time; the cost is transfer).
- **Steam copy, POST `/api/runs`:** unchanged. One upload when new runs arrive, as after any import; a sync that finds nothing uploads nothing.
- **The extension itself makes no network requests.** Its once-a-minute check is a local folder listing.
