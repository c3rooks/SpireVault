# Post-run Shared Report — spec

Status: **v1 shipped in v0.11.0 (2026-05-26).**

After a co-op run ends, the host (or any member) taps "Share this run"
and gets a public URL they can drop into Discord / X / Reddit. The
URL renders a small share card showing who played, what characters
they ran, whether anyone finished, and an optional caption.

## What landed

- `Backend/src/coop-share.ts` — `captureShareCard()` (authed) and
  `readShareCard()` (public).
- KV: `coop:share:<shareId>`, 30-day TTL. `shareId` is a 12-char base-62
  string from `newRandomId()`.
- `POST /coop/share/from-party` — authed write, 10/min IP rate limit,
  caller must be a member of the party. Body: `{ partyId, caption? }`.
- `GET /coop/share/:shareId` — public read, 120/min IP rate limit,
  5-minute browser cache. Returns the snapshot.
- `Web/lib/party-finder-share-rt.js` + `Web/lib/party-finder-share.css`
  — adds a "Share this run" button to the user's own active-party row
  once any member has reached `in_game`. Click → optional caption
  prompt → server capture → URL copied to clipboard.

## Trust model

- Capture endpoint reads party state from KV directly. The client
  cannot tamper with member personas, characters, or roles — those
  fields come from the server's own party blob.
- No Steam IDs are stored in the share card. The roster snapshot is
  display-name-only.
- Optional `caption` is the only client-supplied data, clamped to 240
  chars. Stored verbatim.

## Public URL surface

Frontend routes `/share/coop/:shareId` to a small render that calls
`GET /coop/share/:shareId`. The render is intentionally tiny and
public — no auth, no analytics beyond Cloudflare's edge cache log.

v0.11.0 ships the API + the capture button only; the render route is
specced for v0.11.1 (next patch). Until then, the URL works as a JSON
endpoint — pasting it into Discord shows the JSON, which is ugly but
functional. Patch lands within a week.

## What's not in v1

- **Image-rich share card.** v0.11.1 ships the HTML render of
  `/share/coop/:shareId`. v0.12 ships a server-generated PNG via the
  same canvas pipeline that already produces solo Share-Run cards
  (`Web/lib/share-card-canvas.js`).
- **Co-op run outcome on the card.** Today the card shows party
  status at capture time (who was `in_game`, who was `left`). v0.12
  will correlate each member's most-recent `RunSummary` whose
  `endedAt` is within the party window, so the card can say "Heart
  killed by Ironclad + Silent." Blocked on `RunSummary.coop`
  metadata.
- **Twitter / OG preview**. The HTML render in v0.11.1 will include
  the OG tags so a pasted Discord/Twitter link gets a preview.
