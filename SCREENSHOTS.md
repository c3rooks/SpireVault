# Screenshot capture guide

Take these in order. The Vault app should already be running (I just
launched it — check your Dock). After each one, save into the exact
filename listed; the swap-in script at the bottom of this doc will
wire them into the site, README, and Web companion automatically.

## What to capture

The marketing site references three shots and one OG image. All four
should be taken at retina (Cmd+Shift+5 on macOS captures at retina
automatically).

---

### 1. Overview tab (the marquee shot)

This is the screenshot that lands above the fold on the marketing
site. Highest stakes.

- **In the app:** click **Overview** in the sidebar (top of stats
  group)
- **Pre-state needed:** at least 5–10 finished runs in your history,
  or the screen is mostly empty placeholders
- **Window size:** roughly **1440 × 900** (drag the bottom-right
  corner)
- **Capture command:** `Cmd+Shift+5` → "Capture Selected Window" → click
  the app
- **Save as:** `Site/assets/screenshots/overview.png`

If you have no runs yet because STS2 isn't installed on this Mac,
generate fake-but-plausible runs by:

```bash
# from anywhere
echo "Use the existing test fixtures in TheVault/Tests/VaultCoreTests/Fixtures/"
echo "Or play one quick STS2 run and let the watcher pick it up live."
```

---

### 2. Co-op tab — signed in, feed populated

The "find a partner" hero shot. Has to show the feed has *people in
it*, not the empty state.

- **In the app:** click **Co-op** in the sidebar
- **Pre-state needed:**
  1. Click "Sign in with Steam" → complete the Steam OpenID flow in
     your browser → land back in the app signed in
  2. Either (a) open <https://vault-web-e90.pages.dev> in a browser,
     sign in with a *second* Steam account so a row shows up, or (b)
     ask a friend to install the DMG too. One other row beats none.
- **Window size:** same 1440 × 900
- **Capture command:** `Cmd+Shift+5` → "Capture Selected Window"
- **Save as:** `Site/assets/screenshots/coop.png`

If you can't get another user online in time, set your own status to
"Looking for co-op" with a real note ("A12, 30 min, voice optional"),
add a Discord handle, and screenshot just the **Your status** card
plus the empty feed below it. The status card by itself is still a
strong demonstration of the UI.

---

### 3. Share-Run card

The polish-shot — proves the visual quality.

- **In the app:** Sidebar → **Recent Runs** → click any single run
- **Pre-state needed:** at least one finished run
- Look for a "Share" button (or similar) in the run's detail view
- The card popover or panel that appears is what you screenshot
- **Capture command:** `Cmd+Shift+4` → drag-select just the card
- **Save as:** `Site/assets/screenshots/share.png`

If the share card flow is buggy or missing, skip this one — the
script below tolerates a missing `share.png`.

---

### 4. Open Graph preview (the social-share image)

This is the image that appears when someone pastes the spirevault.app
link into Discord, Slack, X, etc. It needs to be **1200 × 630
pixels** (standard OG dimensions) and visually clear at thumbnail
size.

The simplest way: use the Overview screenshot, but cropped to
1200 × 630 with some space for the marketing text. Or if you have
Figma / Photoshop, lay the cropped Overview shot on a dark background
with the headline "Find a Slay the Spire 2 co-op partner — at your
skill level" in white.

- **Save as:** `Site/assets/screenshots/og.png`

If you skip this one, the SVG version I generated earlier
(`Site/assets/og.svg`) keeps working — but a real product shot is
strictly better.

---

## After you save the screenshots

Run this one command from the project root. It verifies the files
exist, swaps every SVG reference in the site, README, and Web
companion to the new PNGs, and redeploys.

```bash
make screenshots-live
```

If that target doesn't exist yet (it doesn't — I'll add it after you
confirm the files are in place), run this directly:

```bash
./scripts/swap-screenshots.sh
```

The script is idempotent — running it twice does nothing the second
time.
