# SpireVault Sync: store listing drafts

Drafts for the Chrome Web Store and Microsoft Edge Add-ons. Nothing has been submitted and no developer account has been created. Build the upload with `node Extension/scripts/pack.mjs` (it writes `Extension/dist/spirevault-sync-<version>.zip`, with the local test origin removed).

Both stores take the same zip. Chrome's developer account has a one-time $5 fee; Edge's is free.

---

## Listing text (both stores)

**Name** (max 75)

> SpireVault Sync

**Short description** (max 132; also the manifest's `description`)

> New Slay the Spire 2 runs show up in SpireVault by themselves. Reads your save folder; never changes it.

**Category:** Chrome: *Tools* (or *Entertainment* → *Games*). Edge: *Productivity*.

**Language:** English (United States)

**Detailed description**

> Finish a run in Slay the Spire 2, switch to SpireVault, and it's already there.
>
> SpireVault (app.spirevault.app) is a free stats tracker for Slay the Spire 2: win rates, ascensions, relics, card picks and every run you've played. Browsers don't let a website read the game's save folder, so until now you had to pick that folder again after every session. This extension does the reading for you.
>
> HOW IT WORKS
> • While a SpireVault tab is open, the extension checks your Slay the Spire 2 save folder about once a minute.
> • New runs are handed to the SpireVault tab, which adds them to your stats.
> • If you're signed in to SpireVault with Steam, they're saved to your SpireVault account as usual, so your phone sees them too.
>
> SETUP (ABOUT 20 SECONDS)
> 1. Add the extension.
> 2. Turn on "Allow access to file URLs" for it. SpireVault opens the right page for you and brings you back.
> That's it. There is nothing to configure.
>
> WHAT IT READS, AND WHAT IT DOESN'T
> • It reads finished-run files (.run) inside the game's own SlayTheSpire2 save folder. Nothing else on your computer.
> • It never writes, moves or deletes anything. Your saves are safe.
> • It talks only to app.spirevault.app, and only when that page asks. It sends nothing anywhere itself.
> • No ads, no analytics, no tracking, no account of its own.
> • Open source: github.com/c3rooks/SpireVault (the Extension folder).
>
> WORKS WITH
> Chrome, Edge, Brave, Arc and Opera on macOS, Windows and Linux. All save profiles and modded saves are included.
>
> SpireVault is a fan project and is not affiliated with Mega Crit.

**Edge only: search terms** (up to 7): `slay the spire 2`, `spirevault`, `sts2`, `run tracker`, `stats`, `save sync`, `deckbuilder`

---

## Images to prepare (not made yet)

| Asset | Size | Notes |
|---|---|---|
| Store icon | 128×128 PNG | `Extension/icons/icon-128.png` (the Spire Crest) |
| Screenshots, 1 to 5 | 1280×800 PNG | Suggested: (1) the setup card with step 2 current, (2) Overview with the status line "Synced just now · 732 runs", (3) the toolbar popup. Use the game's own art only; no AI-made header figures in store images. |
| Small promo tile (Chrome, optional) | 440×280 PNG | Crest on the dark app background. |

---

## Privacy tab (Chrome Web Store)

**Single purpose**

> Keep the SpireVault stats page (app.spirevault.app) up to date with the user's Slay the Spire 2 run history by reading the game's local save files and handing new runs to the open SpireVault tab.

**Permission justifications**

| Permission | Justification |
|---|---|
| `host_permissions: file:///*` | The extension's whole purpose is to read the user's Slay the Spire 2 save files from disk, which web pages cannot do. Chrome grants `file:` access as all-or-nothing behind the user's "Allow access to file URLs" switch and ignores any path in the pattern, so a narrower pattern is not possible. The limit is enforced in code instead: the extension only ever reads files matching `<…>/SlayTheSpire2/steam/<Steam ID>/[modded/]profile<N>/saves/history/*.run`, plus one listing of the computer's user-folders directory to locate the home folder. It never writes. The page cannot pass a URL or path to be read. |
| `host_permissions: https://app.spirevault.app/*` | The content script that relays messages between the SpireVault page and the service worker runs only on this site. The host permission is also needed to connect SpireVault tabs that were already open when the extension was installed. |
| `scripting` | Used once at start-up to add the same content script to SpireVault tabs that were already open, so the user does not have to reload the page after installing or after flipping the file-access switch. It injects only the extension's own packaged `content.js`, only into app.spirevault.app. |
| `storage` | Remembers where the save folder was found and when the last sync happened (shown in the popup). Nothing leaves the device. |

**Remote code:** No. All code is in the package. No `eval`, no remotely hosted scripts.

**Data usage (what to tick)**

- Collected data types: none of the listed categories applies to what the extension itself collects, because it sends nothing to any server. If the form requires a choice for data handled on the user's behalf, the closest is **"User activity"** → no, **"Website content"** → no; game run history is not among the listed categories.
- Certifications: tick all three:
  - "I do not sell or transfer user data to third parties, outside of the approved use cases"
  - "I do not use or transfer user data for purposes that are unrelated to my item's single purpose"
  - "I do not use or transfer user data to determine creditworthiness or for lending purposes"

**Privacy policy URL:** required by the form. The text below needs a public page (for example `https://spirevault.app/sync-privacy`). That page does not exist yet.

---

## Privacy policy text (to publish)

> **SpireVault Sync: privacy**
>
> *Last updated: [date]*
>
> SpireVault Sync is a browser extension for SpireVault (app.spirevault.app), a stats tracker for Slay the Spire 2.
>
> **What it reads.** Finished-run files (`.run`) in Slay the Spire 2's own save folder on your computer: `SlayTheSpire2/steam/<your Steam ID>/…/saves/history/`. To find that folder it lists the names of the user folders on your computer once. It reads nothing else, and it cannot read anything until you turn on "Allow access to file URLs" for it.
>
> **What it does with them.** It hands the contents of new run files to the SpireVault tab you have open, and only when that tab asks. SpireVault then shows them in your stats. If you are signed in to SpireVault with Steam, SpireVault saves your runs to your SpireVault account, exactly as it does when you import your saves by hand; that is covered by SpireVault's own privacy terms.
>
> **What it never does.** It never changes, moves or deletes your files. It does not send anything to any server itself. It has no analytics, no ads and no tracking. It holds no sign-in, password or Steam session. It does not read your browsing history or the content of any site other than app.spirevault.app.
>
> **What it stores.** On your device only: the location of your save folder and the time of the last sync.
>
> **Removing it.** Remove the extension from your browser's extensions page. Nothing is left behind on your computer or on any server.
>
> **Contact.** [contact address]

---

## Edge Add-ons: notes for certification

> This extension reads local game save files for one game (Slay the Spire 2) and passes new run files to the user's open tab on https://app.spirevault.app. It requires the user to enable "Allow access to file URLs" on the extension's details page; without it the extension does nothing. To test: (1) install, (2) open https://app.spirevault.app, click "Auto-sync" in the toolbar, (3) follow the two steps. Without the game installed, step 3 reports that no save folder was found; a sample save folder for testing is in the public repository under Extension/tests/fixtures/saves and can be pasted into the card's folder field. The source is public at github.com/c3rooks/SpireVault.

---

## After the listing exists

1. Put the two store links in `STORE_URLS` in `Web/lib/sync-bridge.js`. Until then players without the extension see nothing new.
2. First install from the store: check the two points listed as unverified in `phase-0-findings.md` (the switch appears and starts off; the open tab reconnects after it is flipped).
3. Chrome assigns the extension its permanent ID on first upload. Nothing in the code depends on the ID.
