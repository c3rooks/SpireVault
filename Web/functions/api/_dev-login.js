/**
 * Local-only dev sign-in — mints a sandbox session via the worker.
 * Active only when WORKER_ORIGIN_OVERRIDE points at loopback or a
 * *.workers.dev preview host (see getWorkerOrigin).
 */
import { getWorkerOrigin, WORKER_ORIGIN, buildSetCookie } from "../_shared/cookie.js";

const PERSONA_MAP = {
  c3rooks: "local-corey",
  corey: "local-corey",
  boble: "local-boble",
  mako: "local-mako",
  mega: "local-mega",
  iamweird: "local-iamweird",
  iAmWeird: "local-iamweird",
};

export async function onRequest(context) {
  const { request, env } = context;
  const origin = getWorkerOrigin(env);
  if (origin === WORKER_ORIGIN) {
    return new Response("Not available in production", { status: 404 });
  }

  const url = new URL(request.url);
  const as = url.searchParams.get("as") || "c3rooks";
  const steamId = PERSONA_MAP[as] ?? PERSONA_MAP[as.toLowerCase()] ?? as;

  const resp = await fetch(`${origin}/_debug/coop-sandbox/act-as`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ steamId }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.token) {
    return new Response(data.message || "Dev login failed", { status: resp.status || 500 });
  }

  const headers = new Headers();
  headers.set("location", url.searchParams.get("next") || "/");
  headers.append("Set-Cookie", buildSetCookie(data.token, undefined, request));
  return new Response(null, { status: 303, headers });
}
