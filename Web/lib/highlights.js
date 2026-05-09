// highlights.js
// =========================================================================
// Thin client for the Worker's /highlights endpoints. Pure data — the
// renderer owns the DOM. Mirrors the surface of `lib/invites.js`.
//
// Wire format reference (see Backend/src/highlights.ts):
//   Highlight {
//     id, authorID, authorPersona, authorAvatar?, caption?,
//     run: { character, ascension, floorReached, won, playTimeSeconds,
//            endedAt, killedBy?, relics, deckHighlights, neowBonus? },
//     reactions: { "🔥": 3, ... },
//     commentCount: number,
//     createdAt: ISO,
//     viewerReactions: string[]
//   }
//
//   HighlightComment {
//     id, authorID, authorPersona, authorAvatar?, text, createdAt
//   }
// =========================================================================

/** Curated reaction set — kept in sync with Backend/src/highlights.ts. */
export const ALLOWED_REACTIONS = Object.freeze([
  "🔥", "❤️", "👏", "🎯", "💀", "😂",
]);

async function parseJSON(r) {
  if (!r.ok) {
    let msg = `http ${r.status}`;
    try {
      const data = await r.json();
      if (data?.error) msg = data.error;
    } catch {}
    return { ok: false, status: r.status, error: msg };
  }
  try {
    const data = await r.json();
    return { ok: true, ...data };
  } catch {
    return { ok: false, status: r.status, error: "bad json" };
  }
}

/**
 * Public read of the global feed. Auth optional — pass a sessionToken to
 * receive `viewerReactions` populated per item.
 *
 * Resolves to `{ ok: true, items: HighlightView[] }` on success or
 * `{ ok: false, status, error }` on transport / 4xx failure.
 */
export async function fetchFeed(serverURL, sessionToken) {
  const headers = { accept: "application/json" };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const r = await fetch(`${serverURL}/highlights`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers,
  });
  if (!r.ok) return { ok: false, status: r.status };
  const data = await r.json();
  return { ok: true, items: Array.isArray(data?.items) ? data.items : [] };
}

/**
 * Refresh a single highlight. Useful after the user reacts/comments to
 * pull the canonical state without re-paginating the whole feed.
 */
export async function fetchHighlight(serverURL, sessionToken, id) {
  const headers = { accept: "application/json" };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  const r = await fetch(`${serverURL}/highlights/${encodeURIComponent(id)}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers,
  });
  return parseJSON(r);
}

/**
 * Share a run to the community feed.
 *
 * `payload` shape:
 *   {
 *     run: {
 *       character, ascension, floorReached, won, playTimeSeconds,
 *       endedAt, killedBy?, relics: string[],
 *       deckHighlights: string[],
 *       neowBonus?
 *     },
 *     caption?: string  // ≤ 280 chars
 *   }
 *
 * Server enforces the per-user cap (5 active) + per-user rate limit
 * (1 share / 5 min). 429 rejections include `retry_after_sec`.
 */
export async function shareRun(serverURL, sessionToken, payload) {
  const r = await fetch(`${serverURL}/highlights`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify(payload),
  });
  return parseJSON(r);
}

/**
 * Author-only delete of a highlight. Idempotent — returns ok even if
 * the highlight is already gone.
 */
export async function deleteHighlight(serverURL, sessionToken, id) {
  const r = await fetch(`${serverURL}/highlights/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  return parseJSON(r);
}

/**
 * Toggle a reaction. POSTing the same emoji twice removes it.
 * Server validates emoji is in the curated set.
 */
export async function toggleReaction(serverURL, sessionToken, id, emoji) {
  const r = await fetch(
    `${serverURL}/highlights/${encodeURIComponent(id)}/reactions`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ emoji }),
    }
  );
  return parseJSON(r);
}

/**
 * Public comment list. Auth not required so guests can browse comments.
 */
export async function fetchComments(serverURL, id) {
  const r = await fetch(
    `${serverURL}/highlights/${encodeURIComponent(id)}/comments`,
    { method: "GET", credentials: "include", cache: "no-store" }
  );
  return parseJSON(r);
}

export async function postComment(serverURL, sessionToken, id, text) {
  const r = await fetch(
    `${serverURL}/highlights/${encodeURIComponent(id)}/comments`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ text }),
    }
  );
  return parseJSON(r);
}

export async function deleteComment(serverURL, sessionToken, highlightID, commentID) {
  const r = await fetch(
    `${serverURL}/highlights/${encodeURIComponent(highlightID)}/comments/${encodeURIComponent(commentID)}`,
    {
      method: "DELETE",
      credentials: "include",
      headers: { authorization: `Bearer ${sessionToken}` },
    }
  );
  return parseJSON(r);
}
