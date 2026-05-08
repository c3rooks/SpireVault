/**
 * /admin (bare path) — same-origin proxy to the worker's admin
 * dashboard HTML.
 *
 * The worker serves the admin gate page at GET /admin. Pages Functions
 * route the bare `/admin` to this `index.js` and any sub-path to the
 * `[[path]].js` catch-all. They both forward to the same worker.
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
  const { request } = context;
  const url = new URL(request.url);
  const upstreamURL = WORKER_ORIGIN + "/admin" + url.search;

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
