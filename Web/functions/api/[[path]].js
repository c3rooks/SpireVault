/**
 * /api/* — first-party proxy to the worker.
 *
 * Frontend calls (e.g. `/api/presence`) hit this Pages Function on
 * app.spirevault.app. We:
 *
 *   1. Strip the `/api` prefix and forward to
 *      https://vault-coop.coreycrooks.workers.dev/<path>.
 *   2. Translate the inbound `vault_session` cookie into an
 *      `Authorization: Bearer <token>` header for the worker (only if
 *      the request didn't already supply its own Authorization header,
 *      so explicit bearer callers stay in control).
 *   3. Forward the worker's response back, including any `Set-Cookie`
 *      headers it emits.
 *
 * Routes ending in `_session` are served by sibling files
 * (`_session.js`) and never reach this catch-all because Pages routes
 * the more-specific file first.
 *
 * Why this exists: cookies are origin-scoped. For a session cookie set
 * on app.spirevault.app to travel to vault-coop.coreycrooks.workers.dev
 * we'd need third-party cookies, which iOS Safari (ITP) blocks by
 * default. By proxying the worker through the same origin as the page,
 * the cookie is first-party and persists across mobile sessions.
 */
import { readSessionCookie, WORKER_ORIGIN } from "../_shared/cookie.js";

/**
 * Headers we strip before forwarding to the worker. Cloudflare /
 * the runtime already provides correct values on the outbound `fetch`
 * (host, content-length, etc.) — re-sending the inbound versions
 * confuses the upstream and triggers content-length mismatches when
 * the body is consumed.
 *
 * `cookie` is dropped because we translate it to an `authorization`
 * header instead, and we don't want the worker to see other cookies
 * the browser might keep in scope (analytics jars, etc.).
 */
const HOP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "cookie",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

export async function onRequest(context) {
  const { request, params } = context;
  const url = new URL(request.url);

  // `params.path` is the wildcard segments — for `/api/presence` it's
  // `["presence"]`; for `/api/invites/abc/accept` it's
  // `["invites","abc","accept"]`. Pages also hands us a string sometimes
  // depending on the runtime; normalize to an array.
  const segments = Array.isArray(params.path)
    ? params.path
    : params.path
    ? [params.path]
    : [];
  const upstreamPath = "/" + segments.join("/");
  const upstreamURL = WORKER_ORIGIN + upstreamPath + url.search;

  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }

  // Translate the cookie into a bearer header in two cases:
  //
  //   1. No Authorization header at all — caller is relying on cookie
  //      auth (browser POSTing through `/api/*`).
  //
  //   2. Sentinel `Authorization: Bearer __cookie__` — caller has a
  //      JS-side session record that was rehydrated from the cookie
  //      (so JS doesn't actually know the real token) but is using
  //      the legacy code path that wants to set an explicit bearer
  //      header. The frontend stamps this sentinel on cookie-rehydrated
  //      sessions; we substitute the real token here from the cookie.
  //
  // Anything else (real bearer, operator curl, native app) passes
  // through untouched.
  const incomingAuth = headers.get("authorization") || "";
  const isSentinel = /^Bearer\s+__cookie__$/i.test(incomingAuth);
  if (!incomingAuth || isSentinel) {
    const token = readSessionCookie(request);
    if (token) headers.set("authorization", `Bearer ${token}`);
    else if (isSentinel) headers.delete("authorization");
  }

  // Tell the worker which IP this came from. The worker's per-IP rate
  // limiter reads `cf-connecting-ip` first; without this header the
  // limiter would key on the *Pages Functions* IP and treat every
  // user as the same person (defeating the limiter entirely).
  const realIP =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";
  if (realIP) headers.set("cf-connecting-ip", realIP);

  // Forward the body verbatim. For methods without a body
  // (GET/HEAD/DELETE/OPTIONS), pass `undefined` — passing an empty
  // ReadableStream confuses some Workers runtimes.
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream;
  try {
    upstream = await fetch(upstreamURL, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "upstream_unreachable",
        message: String((err && err.message) || err),
      }),
      { status: 502, headers: { "content-type": "application/json" } }
    );
  }

  // Forward upstream response, including Set-Cookie. We don't rewrite
  // the cookie body — the worker doesn't currently set its own
  // cookies, and if it ever does, they'd land on vault-coop.* (third
  // party). The `_session` route sets its own cookies on
  // app.spirevault.app directly.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
