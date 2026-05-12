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
 * Decide whether to stamp `Secure` on the session cookie.
 *
 * Chrome / Safari / Arc / Firefox REJECT a `Secure` cookie returned
 * over plain HTTP — even from localhost. In production every request
 * to app.spirevault.app is HTTPS, so we always want Secure. But when
 * `wrangler pages dev` serves the app over `http://127.0.0.1:3000` for
 * local development, returning `Secure` would silently drop the
 * cookie and the user would loop on the sign-in screen.
 *
 * Rule: emit Secure iff the incoming request was HTTPS.
 */
export function shouldUseSecureCookie(request) {
  if (!request || typeof request.url !== "string") return true;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return true;
  }
}

/**
 * Build the Set-Cookie header value for our session cookie.
 *
 *   - HttpOnly:  not readable by JS.
 *   - Secure:    HTTPS only — see `shouldUseSecureCookie`.
 *   - SameSite=Lax: top-level same-site nav OK, third-party iframe no.
 *   - Path=/:    site-wide.
 */
export function buildSetCookie(token, maxAge = COOKIE_MAX_AGE_SECONDS, request = null) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
  ];
  if (shouldUseSecureCookie(request)) parts.push("Secure");
  parts.push("SameSite=Lax");
  return parts.join("; ");
}

/**
 * Build the Set-Cookie header value used to clear our session cookie.
 * Setting Max-Age=0 with the same Path tells the browser to drop it.
 */
export function buildClearCookie(request = null) {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
  ];
  if (shouldUseSecureCookie(request)) parts.push("Secure");
  parts.push("SameSite=Lax");
  return parts.join("; ");
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
 * Default worker origin (production). Used unless an operator-supplied
 * `WORKER_ORIGIN_OVERRIDE` env var points at a vetted shape — see
 * `getWorkerOrigin` below.
 *
 * If this ever moves, change it here AND in Web/script.js (SERVER_URL)
 * — there's a one-line preflight check that fails if those drift.
 */
export const WORKER_ORIGIN = "https://vault-coop.coreycrooks.workers.dev";

/**
 * Resolve the worker origin to proxy `/api/*` to.
 *
 * Production: env unset → returns the hard-coded prod origin.
 *
 * Dev / preview: operator sets `WORKER_ORIGIN_OVERRIDE` in
 * `Web/.dev.vars` (gitignored) to one of:
 *
 *   - http://127.0.0.1:8787   (the worker started by `wrangler dev`)
 *   - http://localhost:8787
 *   - https://<name>.workers.dev   (a preview worker we deployed; e.g.
 *                                   `vault-coop-preview.coreycrooks.workers.dev`)
 *
 * Defence-in-depth allowlist: only those two shapes are honored. Any
 * other value falls back to prod so a misconfigured Pages env can
 * never silently proxy real users through an attacker-controlled host.
 *
 *   - Loopback HTTP is safe because it never leaves the box.
 *   - `*.workers.dev` is bounded to Cloudflare-hosted workers.
 */
export function getWorkerOrigin(env) {
  const override = env && typeof env.WORKER_ORIGIN_OVERRIDE === "string"
    ? env.WORKER_ORIGIN_OVERRIDE.trim()
    : "";
  if (!override) return WORKER_ORIGIN;
  try {
    const u = new URL(override);
    const host = u.hostname;
    const isLoopback =
      u.protocol === "http:" &&
      (host === "127.0.0.1" ||
        host === "::1" ||
        host === "localhost" ||
        host.endsWith(".localhost"));
    const isPreviewWorker =
      u.protocol === "https:" && host.endsWith(".workers.dev");
    if (!isLoopback && !isPreviewWorker) return WORKER_ORIGIN;
    return `${u.protocol}//${u.host}`;
  } catch {
    return WORKER_ORIGIN;
  }
}
