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
  getWorkerOrigin,
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

/**
 * Rehydrate a session via the worker's `/me` endpoint.
 *
 * Returns one of:
 *   { ok: true, profile }                      → valid bearer
 *   { ok: false, definitive: true }            → token invalid (401/404)
 *                                                — safe to clear cookie
 *   { ok: false, definitive: false, status }   → transient failure
 *                                                (5xx, network, parse) —
 *                                                MUST keep cookie so the
 *                                                user isn't logged out by
 *                                                a hiccup in upstream KV
 *
 * The previous version returned `null` for everything and the caller
 * cleared the cookie unconditionally. Result: a single transient
 * 503 from the worker silently logged real users out of normal-
 * browser sessions. Now we only clear on a definitive auth-fail.
 */
async function rehydrate(token, workerOrigin) {
  let r;
  try {
    r = await fetch(`${workerOrigin}/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    // Network blip / DNS hiccup. Token may still be valid; do NOT
    // clear the cookie. The next page load will retry.
    return { ok: false, definitive: false, status: 0 };
  }
  if (r.ok) {
    try {
      const profile = await r.json();
      return { ok: true, profile };
    } catch {
      // Worker returned 200 but body is unparseable — treat as
      // transient (probably a partial response). Keep the cookie.
      return { ok: false, definitive: false, status: r.status };
    }
  }
  // Only 401/403/404 are definitive "this token is dead". Everything
  // else (429, 5xx, etc.) is transient and we keep the cookie so
  // a slow KV doesn't force users to re-sign-in.
  const definitive = r.status === 401 || r.status === 403 || r.status === 404;
  return { ok: false, definitive, status: r.status };
}

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();
  const workerOrigin = getWorkerOrigin(env);

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
    const result = await rehydrate(token, workerOrigin);
    if (!result.ok) {
      // Don't set the cookie if the worker doesn't recognize the
      // bearer — otherwise we'd persist garbage that just generates
      // 401s on every subsequent request. Surface the upstream
      // status so the client can distinguish "your token is bad"
      // from "the server is having a moment".
      return json(
        { error: result.definitive ? "invalid_session" : "upstream_unavailable",
          status: result.status },
        { status: result.definitive ? 401 : 503 }
      );
    }
    return json(result.profile, {
      status: 200,
      headers: { "set-cookie": buildSetCookie(token, undefined, request) },
    });
  }

  if (method === "GET") {
    const token = readSessionCookie(request);
    if (!token) return json({ error: "no_cookie" }, { status: 401 });
    const result = await rehydrate(token, workerOrigin);
    if (result.ok) return json(result.profile);

    if (result.definitive) {
      // Worker said this token is genuinely dead (401/403/404).
      // Clear the cookie so the client doesn't keep retrying with it.
      return json(
        { error: "expired", status: result.status },
        { status: 401, headers: { "set-cookie": buildClearCookie(request) } }
      );
    }

    // Transient failure (5xx, network, etc). KEEP THE COOKIE — the
    // next page load will retry. This is the bug-fix that stops
    // users from being logged out by a temporary KV blip. Return
    // 503 so the client knows to try again later, but does NOT
    // think the session is dead.
    return json(
      { error: "upstream_unavailable", status: result.status },
      { status: 503 }
    );
  }

  if (method === "DELETE") {
    const token = readSessionCookie(request);
    // Best-effort revoke: hit the worker's DELETE /me which deletes the
    // session: KV row. If the worker is down we still clear the cookie
    // locally so the user is logged out from this device immediately.
    if (token) {
      try {
        await fetch(`${workerOrigin}/me`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        /* worker unreachable — local cookie clear still proceeds */
      }
    }
    return json(
      { ok: true },
      { headers: { "set-cookie": buildClearCookie(request) } }
    );
  }

  return json({ error: "method_not_allowed" }, { status: 405 });
}
