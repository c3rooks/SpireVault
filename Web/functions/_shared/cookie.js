/**
 * Shared cookie helpers for the Pages Functions session layer.
 *
 * Why a separate module: the session-set, session-clear, and session-rehydrate
 * routes all need the *exact* same cookie name + flags. Keeping the
 * definition in one place means future tweaks (Max-Age bump, Path scope,
 * Secure-only enforcement, etc.) happen once and ripple to every endpoint.
 */

/** Cookie name. Must match `cookieSessionToken` in Backend/src/auth.ts. */
export const COOKIE_NAME = "vault_session";

/**
 * Cookie lifetime. Mirrors `SESSION_TTL_SECONDS` on the worker so the
 * cookie expires no later than the bearer it carries. The worker also
 * slides the bearer's KV TTL on every authenticated request, so an
 * actively-used cookie effectively lives until the user explicitly signs
 * out. Stale cookies degrade gracefully (the proxy strips them and the
 * client falls back to the unauthenticated app shell).
 */
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Build the Set-Cookie header value for our session cookie.
 *
 *   - HttpOnly:  not readable by JS — the bearer never lands in the DOM
 *                or in a place an XSS payload could exfiltrate it (the
 *                way localStorage is fully scriptable).
 *   - Secure:    requires HTTPS. App is HTTPS-only in production; this
 *                also makes Safari trust the cookie for cross-tab
 *                persistence (Secure cookies are exempt from some ITP
 *                clamps).
 *   - SameSite=Lax: included on top-level navigations to the same site,
 *                NOT on third-party iframe loads. Adequate for our flow:
 *                the auth callback is a top-level redirect from Steam,
 *                so the cookie ships fine; cross-site script tags can't
 *                steal it.
 *   - Path=/:    everything on app.spirevault.app gets the cookie,
 *                including future routes.
 */
export function buildSetCookie(token, maxAge = COOKIE_MAX_AGE_SECONDS) {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/**
 * Build the Set-Cookie header value used to clear our session cookie.
 * Setting Max-Age=0 with the same Path tells the browser to drop it.
 */
export function buildClearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Read our session cookie out of an inbound `Cookie` header. Mirrors the
 * worker's `cookieSessionToken` so the same shape gates pass on both
 * sides. Returns `null` on missing/malformed cookies.
 */
export function readSessionCookie(request) {
  const raw = request.headers.get("cookie") || "";
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const val = part.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{16,128}$/.test(val) ? val : null;
  }
  return null;
}

/**
 * Worker origin. Hard-coded because Pages Functions don't have a clean
 * way to read wrangler.toml `[vars]` and we don't want to maintain a
 * second config surface. If this ever moves, change it here and in
 * Web/script.js (SERVER_URL) — there's a one-line preflight check
 * that fails if those drift.
 */
export const WORKER_ORIGIN = "https://vault-coop.coreycrooks.workers.dev";
