# Overlay Party Room — deferred

The web Party Room at `/party/:partyId` is the canonical post-accept surface for this milestone.

The macOS/Windows overlay does not mirror Party Room state yet. When overlay work resumes, it should:

1. Read `GET /coop/parties/:partyId` on the same session bearer as the web app.
2. Show the same checklist labels (Ready, Character Select, In Game).
3. Never add a third co-op UI — only reflect the active party for the signed-in Steam user.

Until then, players use the web companion or in-app WebView (same DOM as `app.spirevault.app`).
