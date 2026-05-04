import type { Env, PresenceUpsert } from "./types";
import {
  upsertPresence,
  deletePresence,
  listPresence,
  getSessionProfile,
} from "./presence";
import {
  steamAuthStart,
  steamAuthCallback,
  requireSession,
  refreshSessionTTL,
  bearerTokenFromRequest,
  cookieSessionToken,
} from "./auth";
import {
  handleAdmin,
  isAdminPath,
  recordHeartbeat,
  recordClientDiagnostic,
  recordRosterFirstSeen,
} from "./admin";
import {
  sendInvite,
  listInbox,
  listOutbox,
  respondToInvite,
  withdrawInvite,
  INVITE_MESSAGES,
} from "./invites";
import {
  getRuns,
  uploadRuns,
  deleteRuns,
} from "./runs";
import { checkAndConsume, clientIP, hashID } from "./ratelimit";

/**
 * Origins allowed to make credentialed cross-origin requests to the worker.
 *
 * Why this matters: `navigator.sendBeacon` always sends credentials. A
 * wildcard ACAO (`*`) is rejected by browsers when credentials are
 * included, which silently kills every diagnostic beacon from the real
 * web app — exactly the kind of dead funnel-logging that hides bugs from
 * the operator. We have to echo a SPECIFIC origin and pair it with
 * `access-control-allow-credentials: true`.
 *
 * Anything not in this list falls back to wildcard ACAO without
 * credentials, which is fine for the public read endpoints.
 */
const ALLOWED_ORIGINS = new Set([
  "https://app.spirevault.app",
  "https://spirevault.app",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const reqHeaders = req.headers.get("access-control-request-headers") ?? "content-type, authorization";
  if (ALLOWED_ORIGINS.has(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": reqHeaders,
      "access-control-allow-credentials": "true",
      "access-control-max-age": "86400",
      "vary": "origin",
    };
  }
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": reqHeaders,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

/**
 * Decorate any response with the request-scoped CORS headers. Critical for
 * error paths like `requireSession`'s 401, which otherwise bypass our
 * `json()` helper and return CORS-naked responses that the browser can't
 * even read the status of.
 */
function withCORS(resp: Response, cors: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(cors)) {
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
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeadersFor(req);
    return withCORS(await handle(req, env, ctx, cors), cors);
  },
} satisfies ExportedHandler<Env>;

/**
 * Run a fire-and-forget side effect (KV counter bumps, funnel logging, etc)
 * without blocking the response. Wraps `ctx.waitUntil` so the Workers
 * runtime keeps the promise alive past the response — without `waitUntil`,
 * unawaited promises spawned inside a request handler get *terminated* the
 * moment the handler returns its Response. This is exactly the bug that was
 * silently zeroing out our funnel logging in production.
 */
function bg(ctx: ExecutionContext, p: Promise<unknown>): void {
  try {
    ctx.waitUntil(p.catch(() => {}));
  } catch {
    // Defensive: if waitUntil itself throws (it shouldn't), don't crash
    // the request — the side effect is best-effort by definition.
  }
}

async function handle(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>
): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
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
        return getPresenceCached(req, env, ctx);
      }
      if (method === "POST" && pathname === "/presence") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;

        // Per-IP write throttle. Legit clients heartbeat every 180 s and pulse
        // a few extra times when the user toggles status / edits a note. 30
        // writes/min from one IP is ~10x normal; anything more is a script.
        const ipLimit = await ipWriteLimit(env, req, "presence-write", 30, 60);
        if (!ipLimit.ok) return ipLimit.resp;

        const body = (await req.json()) as PresenceUpsert;
        if (!body || typeof body !== "object") {
          return badRequest("invalid presence body");
        }
        const result = await upsertPresence(env, auth.steamID, body);
        // Best-effort: refresh today's DAU marker. Non-fatal if it fails.
        bg(ctx, recordHeartbeat(env, auth.steamID));
        // Mark roster-first-seen for funnel attribution. Idempotent (read-
        // first-skip), so a frequent heartbeater only pays the read cost.
        bg(ctx, recordRosterFirstSeen(env, auth.steamID));
        // Sliding-window session refresh. An active user heartbeating every
        // 3 minutes never gets logged out for stale-session reasons; only an
        // explicit sign-out, or a true 30-day absence, can expire them.
        const token = bearerTokenFromRequest(req);
        if (token) {
          bg(ctx, refreshSessionTTL(env, token, auth.steamID));
        }
        // So the next GET /presence from anyone sees this user immediately
        // instead of waiting out the edge-cache window (up to 15 s).
        await purgePresenceFeedCache();
        return json(result);
      }
      if (method === "DELETE" && pathname === "/presence") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        await deletePresence(env, auth.steamID);
        await purgePresenceFeedCache();
        return json({ ok: true });
      }

      // ----- Steam OpenID auth -----
      if (method === "GET" && pathname === "/auth/steam/start") {
        return steamAuthStart(req, env, ctx);
      }
      if (method === "GET" && pathname === "/auth/steam/callback") {
        return steamAuthCallback(req, env, ctx);
      }

      // Session rehydration. Reads the session credential off the request
      // (Authorization: Bearer ... OR vault_session cookie via the Pages
      // proxy) and returns the bound SteamID + cached persona/avatar. The
      // web client calls this on boot through `/api/_session` so it can
      // restore a logged-in session purely from a HttpOnly cookie — the
      // localStorage path remains as fallback for legacy clients and
      // browsers where cookies are blocked.
      //
      // 200: { steamID, personaName, avatarURL }
      // 401: missing/invalid/expired session
      // Hard sign-out — invalidates the session token server-side so a
      // stolen/leaked token can't be replayed even within the 30-day TTL.
      // Idempotent: succeeds whether the token is valid, expired, or
      // missing entirely (so the client can fire-and-forget on logout).
      if (method === "DELETE" && pathname === "/me") {
        const token = bearerTokenFromRequest(req) ?? cookieSessionToken(req);
        if (token) {
          // Best-effort delete; we don't care if KV says the key is gone.
          bg(ctx, env.LOBBIES.delete(`session:${token}`));
        }
        return json({ ok: true });
      }

      if (method === "GET" && pathname === "/me") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        // Sliding TTL on every /me hit so any active client (desktop tab
        // open, mobile background poll) keeps the session warm without
        // having to wait for a presence heartbeat. Token can come from
        // either the bearer header (legacy clients, native app, proxy)
        // or a cookie when the request hits the worker directly.
        const token = bearerTokenFromRequest(req) ?? cookieSessionToken(req);
        if (token) {
          bg(ctx, refreshSessionTTL(env, token, auth.steamID));
        }
        const profile = await getSessionProfile(env, auth.steamID);
        return json({
          steamID: auth.steamID,
          personaName: profile?.personaName ?? "Steam User",
          avatarURL: profile?.avatarURL ?? "",
        });
      }

      // Client-side diagnostic beacon. Public POST. The browser reaches this
      // when it can see something the server can't: nonce missing after the
      // OpenID round-trip (in-app browsers strip sessionStorage), session
      // token missing or malformed in the redirect URL, etc. Used purely for
      // funnel attribution — no PII beyond the user agent string and an
      // operator-defined "reason" code. Hard rate-limited per IP because
      // this is the one truly public write surface.
      if (method === "POST" && pathname === "/auth/diag") {
        const ipLimit = await ipWriteLimit(env, req, "auth-diag", 10, 60);
        if (!ipLimit.ok) return ipLimit.resp;
        const body = (await req.json().catch(() => null)) as
          | { reason?: string; detail?: string }
          | null;
        if (!body || typeof body.reason !== "string") {
          return badRequest("invalid diag body");
        }
        await recordClientDiagnostic(env, body.reason, String(body.detail ?? ""));
        return json({ ok: true });
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
        // Per-IP cap is independent of the per-sender cap inside sendInvite().
        // Keeps a single dorm/coffee-shop IP from coordinating spam across
        // multiple Steam accounts.
        const ipLimit = await ipWriteLimit(env, req, "invites-send", 40, 60 * 60);
        if (!ipLimit.ok) return ipLimit.resp;
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

      // ----- Cross-device run history sync (Steam-ID keyed) -----
      // The user uploads from web (after parsing their .run files) and
      // reads from mobile (or vice versa). Storage is the merged set of
      // every device that ever uploaded for this Steam ID, deduped by
      // run id, sorted by endedAt desc, capped at 2k runs.
      //
      // GET    /runs    → { runs, updatedAt, count }
      // POST   /runs    → { count, updatedAt, added, truncated }
      // DELETE /runs    → { ok: true }
      //
      // All three require a verified session — there is no public read
      // surface for someone else's run history. The Steam ID comes
      // straight off the bound session, never the request body, so a
      // user can only see/modify their own runs.
      if (pathname === "/runs" && method === "GET") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        return json(await getRuns(env, auth.steamID));
      }
      if (pathname === "/runs" && method === "POST") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        // Tighter throttle than presence — uploads are larger and rarer
        // by design. 6/min covers "imported from web, then mobile, then
        // web again on a refresh" without enabling abuse.
        const ipLimit = await ipWriteLimit(env, req, "runs-upload", 6, 60);
        if (!ipLimit.ok) return ipLimit.resp;
        const body = await req.json().catch(() => null);
        const source = req.headers.get("x-vault-source") ?? undefined;
        const result = await uploadRuns(env, auth.steamID, body, source);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json(result.result);
      }
      if (pathname === "/runs" && method === "DELETE") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        await deleteRuns(env, auth.steamID);
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
 *   - With a 30 s client poll, even one browser per colo means we serve at
 *     least one cached response per cycle for free. Two browsers in the same
 *     colo means we go ~2x → 1 KV read per cycle. With more it's nearly free.
 *
 * Why 15 s and not "as long as possible":
 *   The presence card is the visible heartbeat of the whole landing page.
 *   At 15 s the worst-case staleness someone sees ("did my friend appear?")
 *   is barely noticeable, and the cache is long enough to absorb a refresh-
 *   spam attack from a single tab without it touching KV.
 */
const PRESENCE_EDGE_CACHE_S = 15;

/** Synthetic cache key — must match `purgePresenceFeedCache`. */
const PRESENCE_FEED_CACHE_KEY = new Request("https://presence.cache/feed/v3", {
  method: "GET",
});

/**
 * Drop the edge-cached `/presence` snapshot. Called after every roster write
 * (POST upsert, DELETE sign-out) so nobody stares at a stale feed that still
 * lists zero players for up to `PRESENCE_EDGE_CACHE_S` after their friend
 * just heartbeated in.
 */
async function purgePresenceFeedCache(): Promise<void> {
  try {
    await caches.default.delete(PRESENCE_FEED_CACHE_KEY);
  } catch {
    /* never fail the authenticated write path on cache quirks */
  }
}

async function getPresenceCached(_req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;

  const hit = await cache.match(PRESENCE_FEED_CACHE_KEY);
  if (hit) return hit;

  let data: Awaited<ReturnType<typeof listPresence>>;
  try {
    data = await listPresence(env);
  } catch (err) {
    // KV outage on the read side — the most user-visible failure mode
    // (everyone sees an empty feed even though the roster is fine).
    // Record it so we can correlate "no users showing up" complaints
    // with actual KV health, and return an empty array rather than 500
    // so the client fails open.
    bg(ctx, recordClientDiagnostic(env, "presence-read-failed", String((err as Error)?.message ?? err)));
    data = [];
  }
  const body = JSON.stringify(data);
  // Don't bake CORS into the cached body — outer withCORS layer adds the
  // request-scoped CORS on every response, including cache hits served by
  // the next request from a different origin.
  const resp = new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${PRESENCE_EDGE_CACHE_S}, s-maxage=${PRESENCE_EDGE_CACHE_S}`,
    },
  });
  // Best-effort cache write; never fail a user response on a cache miss.
  try { await cache.put(PRESENCE_FEED_CACHE_KEY, resp.clone()); } catch {}
  return resp;
}

/**
 * Helper: per-IP write rate limit. Returns either {ok:true} or a ready-made
 * 429 Response. Hashes the IP before keying KV so we never store raw client
 * IPs in our own state.
 *
 * `bucket` namespaces the limiter so the presence-write quota is independent
 * of the invites-send quota; you can hit one ceiling without locking the
 * other path.
 */
async function ipWriteLimit(
  env: Env,
  req: Request,
  bucket: string,
  max: number,
  windowSeconds: number
): Promise<{ ok: true } | { ok: false; resp: Response }> {
  const ip = clientIP(req);
  if (!ip) return { ok: true }; // Unknown IP — let the per-user limits handle it.
  const id = await hashID(ip);
  const result = await checkAndConsume(env, { bucket, id, max, windowSeconds });
  if (result.allowed) return { ok: true };
  return {
    ok: false,
    resp: json(
      { error: "rate_limited", retry_after_sec: result.retryAfterSec },
      {
        status: 429,
        headers: { "retry-after": String(result.retryAfterSec) },
      }
    ),
  };
}
