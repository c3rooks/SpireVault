/**
 * /api/_session — first-party session cookie management.
 *
 * Three verbs:
 *
 *   POST /api/_session  { token: "<bearer from /auth.html>" }
 *     Sets the HttpOnly `vault_session` cookie scoped to
 *     app.spirevault.app, then proxies a `/me` call to the worker
 *     using that token to confirm it's actually valid (so we don't
 *     stamp a useless cookie). Returns the rehydrated session profile
 *     so the caller can render the signed-in UI without a second round
 *     trip. 401 if the token doesn't bind to a live session.
 *
 *   GET  /api/_session
 *     Reads the cookie, asks the worker /me for the bound profile,
 *     returns it. Used on cold boot so a returning user lands signed in
 *     even though localStorage was wiped by ITP. 401 if no cookie or
 *     the worker rejects the bearer.
 *
 *   DELETE /api/_session
 *     Clears the cookie AND tells the worker to invalidate the session
 *     token server-side (so a leaked token can't be replayed within its
 *     30-day TTL). Idempotent — succeeds even with no cookie.
 *
 * Why this exists at all: localStorage on iOS Safari is deleted after 7
 * days of no interaction (ITP). A first-party HttpOnly cookie set by a
 * server on the same origin survives ITP indefinitely as long as the
 * user keeps visiting. By layering this cookie on top of the existing
 * bearer-in-localStorage flow we get persistence on mobile without
 * breaking desktop or the native macOS app, both of which keep using
 * the bearer header path.
 */
import {
  buildClearCookie,
  buildSetCookie,
  readSessionCookie,
  WORKER_ORIGIN,
} from "../_shared/cookie.js";

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });

/** Strict shape gate matching `cookieSessionToken` on the worker side. */
function looksLikeSessionToken(s) {
  return typeof s === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(s);
}

async function rehydrate(token) {
  // Use the worker's /me endpoint as the source of truth — if the bearer
  // is valid the worker tells us who it belongs to, including the
  // cached persona/avatar. We never trust client-supplied profile data.
  const r = await fetch(`${WORKER_ORIGIN}/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  const { request } = context;
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (method === "POST") {
    let body = null;
    try {
      body = await request.json();
    } catch {
      /* fall through to validation */
    }
    const token = body && body.token;
    if (!looksLikeSessionToken(token)) {
      return json({ error: "bad_token" }, { status: 400 });
    }
    const profile = await rehydrate(token);
    if (!profile) {
      // Don't set the cookie if the worker doesn't recognize the
      // bearer — otherwise we'd persist garbage that just generates
      // 401s on every subsequent request.
      return json({ error: "invalid_session" }, { status: 401 });
    }
    return json(profile, {
      status: 200,
      headers: { "set-cookie": buildSetCookie(token) },
    });
  }

  if (method === "GET") {
    const token = readSessionCookie(request);
    if (!token) return json({ error: "no_cookie" }, { status: 401 });
    const profile = await rehydrate(token);
    if (!profile) {
      // Cookie is present but the worker rejected the bearer — token
      // expired, was revoked, or KV lost it. Clear the dead cookie so
      // the client doesn't keep retrying with it.
      return json(
        { error: "expired" },
        { status: 401, headers: { "set-cookie": buildClearCookie() } }
      );
    }
    return json(profile);
  }

  if (method === "DELETE") {
    const token = readSessionCookie(request);
    // Best-effort revoke: hit the worker's DELETE /me which deletes the
    // session: KV row. If the worker is down we still clear the cookie
    // locally so the user is logged out from this device immediately.
    if (token) {
      try {
        await fetch(`${WORKER_ORIGIN}/me`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        /* worker unreachable — local cookie clear still proceeds */
      }
    }
    return json(
      { ok: true },
      { headers: { "set-cookie": buildClearCookie() } }
    );
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
}
