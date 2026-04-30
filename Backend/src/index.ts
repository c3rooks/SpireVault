import type { Env, PresenceUpsert } from "./types";
import { upsertPresence, deletePresence, listPresence } from "./presence";
import { steamAuthStart, steamAuthCallback, requireSession } from "./auth";
import { handleAdmin, isAdminPath, recordHeartbeat } from "./admin";
import {
  sendInvite,
  listInbox,
  listOutbox,
  respondToInvite,
  withdrawInvite,
  INVITE_MESSAGES,
} from "./invites";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...CORS_HEADERS,
      ...init.headers,
    },
  });

/**
 * Decorate any response with CORS headers. Critical for error paths like
 * `requireSession`'s 401, which otherwise bypass our `json()` helper and
 * return CORS-naked responses that the browser can't even read the status of.
 */
function withCORS(resp: Response): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

const text = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...init.headers,
    },
  });

const notFound = () => json({ error: "not_found" }, { status: 404 });
const badRequest = (msg: string) =>
  json({ error: "bad_request", message: msg }, { status: 400 });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return withCORS(await handle(req, env));
  },
} satisfies ExportedHandler<Env>;

async function handle(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Health
      if (method === "GET" && pathname === "/") {
        return text("vault-coop online");
      }

      // ----- Presence feed -----
      // Reads are public so the UI can render the gate before sign-in.
      //
      // Edge-cached for 8 s on the worker's CF colo. KV reads are abundant
      // (100k/day) compared to writes (1k/day), but with multiple browsers
      // polling the feed every 30 s we'd still rather collapse identical
      // requests at the edge before they hit KV at all.
      if (method === "GET" && pathname === "/presence") {
        return getPresenceCached(req, env);
      }
      if (method === "POST" && pathname === "/presence") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const body = (await req.json()) as PresenceUpsert;
        if (!body || typeof body !== "object") {
          return badRequest("invalid presence body");
        }
        const result = await upsertPresence(env, auth.steamID, body);
        // Best-effort: refresh today's DAU marker. Non-fatal if it fails.
        recordHeartbeat(env, auth.steamID).catch(() => {});
        return json(result);
      }
      if (method === "DELETE" && pathname === "/presence") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        await deletePresence(env, auth.steamID);
        return json({ ok: true });
      }

      // ----- Steam OpenID auth -----
      if (method === "GET" && pathname === "/auth/steam/start") {
        return steamAuthStart(req, env);
      }
      if (method === "GET" && pathname === "/auth/steam/callback") {
        return steamAuthCallback(req, env);
      }

      // ----- Co-op invites -----
      // Public read: catalog of allowed messages so the client can render labels.
      if (method === "GET" && pathname === "/invites/messages") {
        return json({ messages: INVITE_MESSAGES });
      }
      // All other invite endpoints require a verified session.
      if (pathname === "/invites" && method === "POST") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const body = await req.json().catch(() => null);
        const result = await sendInvite(env, auth.steamID, body);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ invite: result.invite });
      }
      if (pathname === "/invites/inbox" && method === "GET") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        return json({ invites: await listInbox(env, auth.steamID) });
      }
      if (pathname === "/invites/outbox" && method === "GET") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        return json({ invites: await listOutbox(env, auth.steamID) });
      }
      // /invites/:id/accept | /invites/:id/decline | DELETE /invites/:id
      const inviteRespondMatch = pathname.match(/^\/invites\/([0-9a-f]{32})\/(accept|decline)$/);
      if (inviteRespondMatch && method === "POST") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const [, id, action] = inviteRespondMatch;
        const result = await respondToInvite(env, id, auth.steamID, action === "accept");
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ invite: result.invite });
      }
      const inviteIdMatch = pathname.match(/^\/invites\/([0-9a-f]{32})$/);
      if (inviteIdMatch && method === "DELETE") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const [, id] = inviteIdMatch;
        const result = await withdrawInvite(env, id, auth.steamID);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ ok: true });
      }

      // ----- Admin (operator-only, bearer-gated, returns 404 to public) -----
      if (method === "GET" && isAdminPath(pathname)) {
        return handleAdmin(req, env);
      }

      return notFound();
    } catch (err: any) {
      return json(
        { error: "internal", message: String(err?.message ?? err) },
        { status: 500 }
      );
    }
}

/**
 * Cache the public presence feed at the edge for a short window. The Cache API
 * is keyed by a synthetic URL so we don't have to think about query strings.
 *
 * What this saves us:
 *   - Identical /presence GETs from the same colo within the cache window
 *     skip the worker handler entirely → 0 KV reads for those.
 *   - With a 30s client poll + 2 active browsers, we still hit KV ~1-2x per
 *     poll cycle, instead of once per browser per cycle.
 */
async function getPresenceCached(_req: Request, env: Env): Promise<Response> {
  const cacheKey = new Request("https://presence.cache/feed/v2", { method: "GET" });
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const data = await listPresence(env);
  const body = JSON.stringify(data);
  const resp = new Response(body, {
    headers: {
      "content-type": "application/json",
      // 8 s public cache. Browsers ignore (we set no-store on the fetch),
      // but Cloudflare's edge cache sees this and respects it.
      "cache-control": "public, max-age=8, s-maxage=8",
      ...CORS_HEADERS,
    },
  });
  // Best-effort cache write; never fail a user response on a cache miss.
  try { await cache.put(cacheKey, resp.clone()); } catch {}
  return resp;
}
