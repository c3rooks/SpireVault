import type { Env, PresenceUpsert } from "./types";
import {
  upsertPresence,
  deletePresence,
  listPresence,
  listPresencePublic,
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
  recordIngestFirstSeen,
  communityPulse,
} from "./admin";
import {
  sendInvite,
  listInbox,
  listOutbox,
  respondToInvite,
  withdrawInvite,
  INVITE_MESSAGES,
} from "./invites";
import { unpair } from "./pairs";
import {
  getRuns,
  uploadRuns,
  deleteRuns,
} from "./runs";
import {
  shareHighlight,
  listHighlights,
  getHighlight,
  toggleReaction,
  postComment,
  listComments,
  deleteHighlight,
  deleteComment,
} from "./highlights";
import { steamIDForRequest } from "./auth";
import { checkAndConsume, clientIP, hashID } from "./ratelimit";
import { handleNotifySignup } from "./notify";
import { handleCoopRoute } from "./coop-routes";
import { handleCoopSandboxRoute } from "./coop-sandbox";
import { handleDiscordInteractions } from "./discord-interactions";
import {
  closeAllHouseLobbies,
  getHouseLobbyStatus,
  runHouseLobbyRenewer,
} from "./coop-house-lobbies";

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

  /**
   * Cron entry point — Cloudflare invokes this on every trigger
   * listed under `[triggers]` in wrangler.toml. The current schedule
   * is `*\/15 * * * *` (every 15 minutes) which is the SpireVault
   * House Lobby renewer cadence.
   *
   * The renewer is wrapped in `ctx.waitUntil` so the runtime keeps
   * the promise alive for the full pass; Cloudflare otherwise tears
   * the isolate down right after this handler returns.
   *
   * If you add a second cron in the future (e.g. analytics rollup),
   * branch on `event.cron` to dispatch — every trigger pattern fires
   * this same handler.
   */
  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runHouseLobbyRenewer(env).catch((err) => {
        console.log(
          `[house-lobbies] scheduled pass crashed: ${
            (err as Error)?.message ?? err
          }`,
        );
      }),
    );
    // Reference `event.cron` so the parameter isn't reported as unused
    // and so log greps for the cron pattern resolve to a real string.
    console.log(`[house-lobbies] scheduled fired cron=${event.cron}`);
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
      // ----- New co-op run-lobby surface -----
      //
      // All `/coop/*` routes live in `coop-routes.ts`. The dispatcher
      // returns `null` when a request isn't a co-op route, so we fall
      // through to the legacy presence/invites/pair surfaces below.
      // This means old clients that hit `/presence` and `/invites/...`
      // keep working unchanged while new clients use the lobby model.
      if (pathname.startsWith("/coop/")) {
        const resp = await handleCoopRoute(req, env, pathname, method);
        if (resp) return resp;
      }

      // ----- Discord interactions webhook (v0.12.0+) -----
      //
      // The LFG bridge bot can run in one of two configurations:
      //
      //   (a) Discord-native — Discord POSTs interaction events
      //       directly to this worker at /discord/interactions.
      //       Ed25519-verified using env.DISCORD_PUBLIC_KEY.
      //
      //   (b) Bot-process — a separate Node.js Discord.js process
      //       listens via the Discord Gateway and calls
      //       /coop/mirror with a shared secret.
      //
      // Both terminate at coop-mirror.createMirror() so the mirror
      // surface is identical regardless of which transport ships first.
      if (pathname === "/discord/interactions") {
        const resp = await handleDiscordInteractions(req, env);
        if (resp) return resp;
      }

      // ----- Local-only test harness -----
      //
      // The verify-coop-lobbies harness needs a way to mint fake
      // sessions without actually completing a Steam OpenID round-trip.
      // We gate the whole surface behind `env.LOCAL_DEBUG === "1"` which
      // is set ONLY by `wrangler dev` (see `Backend/wrangler.toml`'s
      // `[env.localdev.vars]` block). In production the env var is
      // absent and these routes return 404 like any unknown path.
      const sandboxResp = await handleCoopSandboxRoute(req, env, pathname, method);
      if (sandboxResp) return sandboxResp;

      if (env.LOCAL_DEBUG === "1" && pathname.startsWith("/_debug/")) {
        if (method === "POST" && pathname === "/_debug/seed-session") {
          const body = await req.json().catch(() => null) as
            | { steamID?: string; personaName?: string }
            | null;
          if (!body?.steamID || !/^\d{17}$/.test(body.steamID)) {
            return badRequest("invalid steamID");
          }
          const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          await env.LOBBIES.put(`session:${token}`, body.steamID, {
            expirationTtl: 60 * 60,
          });
          await env.LOBBIES.put(
            `session-profile:${body.steamID}`,
            JSON.stringify({
              personaName: body.personaName ?? "Local Tester",
              avatarURL: "",
            }),
            { expirationTtl: 60 * 60 },
          );
          return json({ ok: true, token, steamID: body.steamID });
        }
        if (method === "POST" && pathname === "/_debug/wipe") {
          // Best-effort wipe of known co-op keys for a clean slate.
          // We can't list KV (free-tier quota), so we just delete the
          // primary indexes plus any keys the caller hands us. When
          // `wipeRateLimits` is set, we ALSO compute the rate-limit
          // bucket keys for THIS request's IP (whatever local-dev
          // wrangler hands us) so the test harness can blow away
          // its own rate-limit state without guessing the right
          // hash. Production never hits this branch because LOCAL_DEBUG
          // is unset.
          const body = await req.json().catch(() => null) as
            | { keys?: string[]; wipeRateLimits?: boolean }
            | null;
          const keys = [
            "coop:presence:index",
            "coop:lobby:index",
            ...(Array.isArray(body?.keys) ? body!.keys : []),
          ];
          if (body?.wipeRateLimits) {
            const ip = clientIP(req);
            const idCandidates = [
              ip,
              "127.0.0.1",
              "::1",
              "",
            ].filter((s, i, arr) => arr.indexOf(s) === i);
            const buckets = [
              "coop-invite-window",
              "coop-write",
              "coop-presence-write",
              "coop-heartbeat",
            ];
            for (const candidate of idCandidates) {
              const id = candidate ? await hashID(candidate) : "";
              for (const b of buckets) {
                keys.push(`rl:${b}:${id}`);
              }
            }
          }
          await Promise.allSettled(keys.map((k) => env.LOBBIES.delete(k)));
          return json({ ok: true, deleted: keys });
        }
      }

      // Health
      if (method === "GET" && pathname === "/") {
        return text("vault-coop online");
      }

      // ----- Presence feed -----
      //
      // Two-tier privacy model:
      //
      //   GET /presence         → PUBLIC, sanitized list (no Steam IDs,
      //                           no personas, no avatars). Used by
      //                           guest/landing UI for accurate social
      //                           proof without letting strangers
      //                           harvest Steam handles from the feed.
      //                           Edge-cached for 15s.
      //
      //   GET /presence/roster  → AUTH-REQUIRED, full roster with
      //                           identity fields. Only signed-in
      //                           Steam users can see who's looking
      //                           and send them invites. Never cached
      //                           (each user's view is identical for
      //                           a given roster state, but we'd
      //                           rather not risk a wrong 15s-old
      //                           avatar for a user who just rejoined).
      //
      // Writes (`POST /presence`, `DELETE /presence`) still require a
      // session — unchanged.
      if (method === "GET" && pathname === "/presence") {
        return getPresenceCached(req, env, ctx);
      }
      if (method === "GET" && pathname === "/presence/roster") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        try {
          const data = await listPresence(env);
          return json(data);
        } catch (err) {
          bg(ctx, recordClientDiagnostic(env, "presence-roster-read-failed", String((err as Error)?.message ?? err)));
          return json([]);
        }
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
        // Accept creates a pair on both sides; bust the public feed cache
        // so the "Playing with @X" pill appears on the next roster fetch
        // without waiting out the 15s edge cache.
        if (action === "accept") {
          await purgePresenceFeedCache();
        }
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

      // ----- Co-op pair (auth-required) -----
      // Manual unpair. Fires both sides — caller's row AND their partner's
      // row stop showing the "Playing with X" pill. Idempotent: returns
      // `{ ok: true }` even if the caller wasn't paired.
      if (pathname === "/pair" && method === "DELETE") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const wasPaired = await unpair(env, auth.steamID);
        // Ensure the next /presence/roster fetch reflects the unpair
        // immediately — the public feed is sanitized so it doesn't expose
        // pair state, but the authed roster does and we want it fresh.
        await purgePresenceFeedCache();
        return json({ ok: true, wasPaired });
      }

      // ----- Public community pulse -----
      // Anonymous aggregate counts (climbers today / this week / all
      // time) for the frontend's community touches. Public by design:
      // no auth, no PII, KV-cached 10 min server-side so the KV list
      // work isn't paid per page load.
      if (pathname === "/stats/community" && method === "GET") {
        return json(await communityPulse(env), {
          headers: { "cache-control": "public, max-age=300" },
        });
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

        // Activation attribution. This is the one place where "the user has
        // actually got their run history into the product" is both true and
        // provably tied to a Steam ID: the client auto-uploads after every
        // successful local ingest, and this route requires a session.
        //
        // The `ingest-runs-committed` diag beacon looks like the more natural
        // hook, but it's fired via navigator.sendBeacon to the worker origin
        // cross-site, so it carries neither the bearer header nor the
        // vault_session cookie (that cookie is set on the Pages origin). It
        // can count imports; it can never say *who* imported.
        //
        // Idempotent read-first-skip, so a daily user pays one KV read.
        if ((result.result?.count ?? 0) > 0) {
          bg(ctx, recordIngestFirstSeen(env, auth.steamID));
        }
        return json(result.result);
      }
      if (pathname === "/runs" && method === "DELETE") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        await deleteRuns(env, auth.steamID);
        return json({ ok: true });
      }

      // ----- Community highlights -----
      //
      // GET    /highlights              public read of recent shared runs.
      //                                 Auth optional — when present, the
      //                                 response is enriched with
      //                                 `viewerReactions` per item.
      // POST   /highlights              auth-required, share a run.
      // GET    /highlights/:id          single highlight (refresh after
      //                                 react/comment without re-paginating).
      // DELETE /highlights/:id          auth-required, author-only.
      // POST   /highlights/:id/reactions auth-required, toggle one of the
      //                                 curated emojis.
      // GET    /highlights/:id/comments public list (so you can browse
      //                                 comments without an account).
      // POST   /highlights/:id/comments auth-required.
      // DELETE /highlights/:id/comments/:cid auth-required, author-of-comment
      //                                       or author-of-highlight.
      if (method === "GET" && pathname === "/highlights") {
        const viewer = await steamIDForRequest(req, env);
        const items = await listHighlights(env, viewer);
        return json({ items });
      }

      // POST /notify  — public "email me when this ships" capture used
      // by news posts that mention the upcoming weekly digest. Stored
      // in KV; zero email is sent from this endpoint. See notify.ts.
      if (method === "POST" && pathname === "/notify") {
        return await handleNotifySignup(req, env);
      }
      if (method === "POST" && pathname === "/highlights") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        // 1 share / 5 min / user. The per-user cap of 5 active highlights
        // already bounds growth; this rate cap stops a single tab from
        // hammering the share button.
        const userLimit = await checkAndConsume(env, {
          bucket: "highlights-share",
          id: auth.steamID,
          max: 1,
          windowSeconds: 5 * 60,
        });
        if (!userLimit.allowed) {
          return json(
            { error: "rate_limited", retry_after_sec: userLimit.retryAfterSec },
            { status: 429, headers: { "retry-after": String(userLimit.retryAfterSec) } }
          );
        }
        const ipLimit = await ipWriteLimit(env, req, "highlights-share-ip", 5, 60 * 60);
        if (!ipLimit.ok) return ipLimit.resp;
        const body = await req.json().catch(() => null);
        const result = await shareHighlight(env, auth.steamID, body);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ highlight: result.highlight });
      }

      const highlightIdMatch = pathname.match(/^\/highlights\/([0-9a-f]{32})$/);
      if (highlightIdMatch && method === "GET") {
        const viewer = await steamIDForRequest(req, env);
        const item = await getHighlight(env, highlightIdMatch[1], viewer);
        if (!item) return notFound();
        return json({ highlight: item });
      }
      if (highlightIdMatch && method === "DELETE") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const result = await deleteHighlight(env, highlightIdMatch[1], auth.steamID);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ ok: true });
      }

      const reactionMatch = pathname.match(/^\/highlights\/([0-9a-f]{32})\/reactions$/);
      if (reactionMatch && method === "POST") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const ipLimit = await ipWriteLimit(env, req, "highlights-react", 60, 60);
        if (!ipLimit.ok) return ipLimit.resp;
        const body = await req.json().catch(() => null) as { emoji?: unknown } | null;
        const result = await toggleReaction(env, reactionMatch[1], auth.steamID, body?.emoji);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ highlight: result.highlight });
      }

      const commentsMatch = pathname.match(/^\/highlights\/([0-9a-f]{32})\/comments$/);
      if (commentsMatch && method === "GET") {
        const result = await listComments(env, commentsMatch[1]);
        if ("ok" in result && result.ok === false) {
          return json({ error: result.error }, { status: result.status });
        }
        return json(result);
      }
      if (commentsMatch && method === "POST") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const userLimit = await checkAndConsume(env, {
          bucket: "highlights-comment",
          id: auth.steamID,
          max: 10,
          windowSeconds: 5 * 60,
        });
        if (!userLimit.allowed) {
          return json(
            { error: "rate_limited", retry_after_sec: userLimit.retryAfterSec },
            { status: 429, headers: { "retry-after": String(userLimit.retryAfterSec) } }
          );
        }
        const body = await req.json().catch(() => null) as { text?: unknown } | null;
        const result = await postComment(env, commentsMatch[1], auth.steamID, body?.text);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ comment: result.comment, highlight: result.highlight });
      }

      const commentIdMatch = pathname.match(/^\/highlights\/([0-9a-f]{32})\/comments\/([0-9a-f]{32})$/);
      if (commentIdMatch && method === "DELETE") {
        const auth = await requireSession(req, env);
        if (auth instanceof Response) return auth;
        const result = await deleteComment(env, commentIdMatch[1], commentIdMatch[2], auth.steamID);
        if (!result.ok) return json({ error: result.error }, { status: result.status });
        return json({ ok: true });
      }

      // ----- Admin (operator-only, bearer-gated, returns 404 to public) -----
      if (method === "GET" && isAdminPath(pathname)) {
        return handleAdmin(req, env);
      }

      // ----- House Lobby admin surface -----
      //
      // Three operator-only endpoints for managing the ambient
      // SpireVault House Lobbies (see coop-house-lobbies.ts). Each
      // requires `Authorization: Bearer <HOUSE_LOBBY_ADMIN_SECRET>`;
      // anything else returns 401.
      //
      // These return a real 401 (not the silent 404 the /admin surface
      // uses) because operators need a precise signal that their
      // token is wrong, AND because the renewer endpoints are
      // already namespaced under /admin/house-lobbies/* which
      // doesn't appear anywhere in the public surface; we're not
      // hiding their existence from a curious scraper.
      if (pathname.startsWith("/admin/house-lobbies/")) {
        const houseResp = await handleHouseLobbyAdmin(req, env, pathname, method);
        if (houseResp) return houseResp;
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

/** Synthetic cache key — must match `purgePresenceFeedCache`.
 *
 *  `/feed/v4` bump: the response shape of `/presence` changed from
 *  `PresenceEntry[]` (identity-heavy) to `PublicPresenceEntry[]`
 *  (sanitized). Old cached body shape must never be served under
 *  the new privacy contract, so rotate the cache key alongside. */
const PRESENCE_FEED_CACHE_KEY = new Request("https://presence.cache/feed/v4", {
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

  let data: Awaited<ReturnType<typeof listPresencePublic>>;
  try {
    data = await listPresencePublic(env);
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
 * Bearer-gate the House Lobby admin surface and dispatch to the
 * appropriate helper. Returns `null` if the path matched the prefix
 * but the verb/route didn't, so the caller falls through to the
 * route-level 404.
 *
 * Auth model: `Authorization: Bearer <env.HOUSE_LOBBY_ADMIN_SECRET>`.
 * Anything else returns 401 — see the comment at the call site for
 * why we use a real 401 instead of the silent 404 pattern.
 */
async function handleHouseLobbyAdmin(
  req: Request,
  env: Env,
  pathname: string,
  method: string,
): Promise<Response | null> {
  const expected = env.HOUSE_LOBBY_ADMIN_SECRET;
  if (!expected || expected.length < 16) {
    // Secret not provisioned. Refuse — operator must `wrangler secret
    // put HOUSE_LOBBY_ADMIN_SECRET` before this surface is usable.
    return new Response(
      JSON.stringify({
        ok: false,
        error: "secret_not_set",
        message:
          "HOUSE_LOBBY_ADMIN_SECRET is not configured on this worker. " +
          "Run `wrangler secret put HOUSE_LOBBY_ADMIN_SECRET` to enable this endpoint.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1]! : "";
  if (!constantTimeStringEq(provided, expected)) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "unauthorized",
        message: "Invalid HOUSE_LOBBY_ADMIN_SECRET bearer token.",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  if (method === "POST" && pathname === "/admin/house-lobbies/run-now") {
    const summary = await runHouseLobbyRenewer(env, { force: true });
    return new Response(JSON.stringify({ ok: true, summary }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }
  if (method === "POST" && pathname === "/admin/house-lobbies/close-all") {
    const result = await closeAllHouseLobbies(env);
    return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }
  if (method === "GET" && pathname === "/admin/house-lobbies/status") {
    const status = await getHouseLobbyStatus(env);
    return new Response(JSON.stringify({ ok: true, ...status }, null, 2), {
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

/**
 * Length-aware constant-time-ish equality for short secrets. We
 * deliberately short-circuit on length mismatch (timing leaks length,
 * which is fine — a leaked secret-length is much weaker than a leaked
 * secret) but compare all character codes for equal-length inputs.
 */
function constantTimeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
