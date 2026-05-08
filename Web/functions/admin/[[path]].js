/**
 * /admin/* — same-origin proxy to the worker's admin endpoints.
 *
 * Mirrors the `/api/[[path]]` proxy but for the admin surface so the
 * operator can hit `https://app.spirevault.app/admin` instead of
 * remembering the worker's `*.workers.dev` URL. The worker still
 * gates on the `Authorization: Bearer <ADMIN_TOKEN>` header — this
 * proxy just rewrites the URL and forwards the headers verbatim.
 *
 * The admin dashboard's HTML is served at `/admin` (no path
 * component); `/admin/stats` returns JSON. Both routes proxy to
 * the same upstream.
 */
import { WORKER_ORIGIN } from "../_shared/cookie.js";

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

  const segments = Array.isArray(params.path)
    ? params.path
    : params.path
    ? [params.path]
    : [];
  // Always prefix with /admin so /admin/stats stays /admin/stats and
  // bare /admin (no path) hits the worker root admin route.
  const upstreamPath = "/admin" + (segments.length ? "/" + segments.join("/") : "");
  const upstreamURL = WORKER_ORIGIN + upstreamPath + url.search;

  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    if (HOP_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }

  const realIP =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for") ||
    "";
  if (realIP) headers.set("cf-connecting-ip", realIP);

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

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
