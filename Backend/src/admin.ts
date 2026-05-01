import type { Env, PresenceEntry } from "./types";

/**
 * Operator-only admin surface. Two endpoints:
 *
 *   GET /admin         → tiny single-file HTML dashboard
 *   GET /admin/stats   → JSON metrics powering the dashboard
 *
 * Both are bearer-gated against `env.ADMIN_TOKEN`. Anyone hitting the
 * surface without the right token (or with no token at all) gets back the
 * exact same JSON 404 the Worker uses for any other unknown route. We do
 * NOT 401: that would advertise the existence of a protected surface.
 *
 * Security posture:
 *  - The token is set via `wrangler secret put ADMIN_TOKEN` — it never
 *    appears in wrangler.toml, the GitHub repo, or any public deploy.
 *  - The HTML dashboard prompts in-page for the same token and stores it in
 *    `sessionStorage` so an operator can refresh without re-typing. Closing
 *    the tab drops it.
 *  - Stats only ever contain aggregates + the operator's own users' Steam
 *    persona names (which they typed publicly). No raw IPs, no auth
 *    cookies, nothing PII.
 *
 * KV layout this surface relies on:
 *
 *   presence:<steamID>          short-TTL presence row (existing)
 *   session:<token>             bearer→steamID (existing)
 *   session-profile:<steamID>   persona+avatar at OpenID time (existing)
 *
 *   user:<steamID>              first-ever-seen marker, no TTL.
 *                               Written once per unique user, ever.
 *   user-meta:<steamID>         {personaName, firstSeen, lastSeen} JSON,
 *                               touched on every successful sign-in.
 *   seen:<YYYYMMDD>:<steamID>   per-user-per-day flag, TTL ~10 days.
 *                               Lets us count DAU without a separate
 *                               analytics service.
 *   signin:<ISO>:<steamID>      sign-in event, TTL 30 days. Powers the
 *                               "recent sign-ins" list.
 *
 * SIGN-IN FUNNEL — added so we can see exactly where users drop off
 * between "click Sign in with Steam" and "show up on the co-op feed".
 * Without this, every failure between Steam and our site is silent.
 *
 *   funnel:start:<YYYYMMDD>           counter, TTL 90d. Every /auth/steam/start hit.
 *   funnel:cb-attempt:<YYYYMMDD>      counter, TTL 90d. Every /auth/steam/callback hit.
 *   funnel:cb-ok:<YYYYMMDD>           counter, TTL 90d. Successful Steam verifications.
 *   funnel:cb-fail:<reason>:<YYYYMMDD> counter, TTL 90d. Failed callbacks by reason.
 *   funnel:diag:<reason>:<YYYYMMDD>   counter, TTL 90d. Client-side beacons
 *                                     (nonce mismatch, redirect lost session, etc).
 *   funnel:diag-ev:<ISO>:<reason>     event row, TTL 30d. Recent diagnostic events
 *                                     with detail (mobile in-app browser, etc).
 *   funnel:roster-first:<steamID>     marker, no TTL. Set the first time a user
 *                                     appears in the presence roster after auth.
 *                                     Lets us spot "auth'd but never heartbeated".
 */

const ADMIN_PATHS = new Set(["/admin", "/admin/stats"]);

/** Returns true iff this request looks like it's targeting the admin surface. */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.has(pathname);
}

/**
 * 404 with the same JSON shape index.ts already emits for unknown routes,
 * so admin paths are byte-indistinguishable from any other miss.
 */
function notFound(): Response {
  // CORS headers are added by the outer withCORS layer in index.ts so admin
  // paths are byte-indistinguishable from public 404s.
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function tokenIsValid(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  // Accept the token in two places so the dashboard can fetch it from JS
  // (Authorization header) or paste it into a URL once for ad-hoc curling.
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return constantTimeEq(m[1]!, env.ADMIN_TOKEN);
  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  return q ? constantTimeEq(q, env.ADMIN_TOKEN) : false;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Top-level entry.
 *
 *  /admin       → always returns the gate HTML. The page is content-free
 *                 (just a token prompt) so this doesn't reveal anything an
 *                 attacker couldn't already see in the public source.
 *                 The HTML carries no real metrics; those only come from
 *                 the gated /admin/stats endpoint.
 *
 *  /admin/stats → 404 to anyone without the right bearer token, byte-
 *                 indistinguishable from any other unknown route.
 *                 This is the actual data gate.
 */
export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/admin") return adminHTML();
  if (url.pathname === "/admin/stats") {
    if (!tokenIsValid(req, env)) return notFound();
    return adminStats(env);
  }
  return notFound();
}

// MARK: - Stats aggregation --------------------------------------------------

interface AdminStats {
  generatedAt: string;
  online: {
    count: number;
    inSTS2: number;
    entries: Array<{
      steamID: string;
      personaName: string;
      status: string;
      note: string;
      inSTS2: boolean;
      updatedAt: string;
    }>;
  };
  totals: {
    everSignedIn: number;
    activeLast24h: number;
    activeLast7d: number;
    sessionsActive: number;
  };
  daily: Array<{ date: string; activeUsers: number }>;
  recentSignIns: Array<{
    when: string;
    steamID: string;
    personaName: string;
  }>;

  // Sign-in funnel: per-day breakdown of "click Sign in" → "land on roster".
  // Lets us see in one glance if traffic is even reaching the auth surface.
  funnel: {
    today: FunnelDay;
    last7Days: FunnelDay[];
  };

  // Why people are bouncing. Aggregated reasons across the last 30 days
  // so we can tell mobile-in-app-browser nonce loss from Steam rejection.
  failures: {
    callbackFailures: Record<string, number>;
    clientDiagnostics: Record<string, number>;
    recentEvents: Array<{
      when: string;
      reason: string;
      detail: string;
    }>;
  };

  // Every user who has ever auth'd, with whether they made it to the roster.
  // Sorted by lastSeen desc so the top of the list is "people who tried
  // most recently". This is what answers "did anyone besides my friend try?"
  allUsers: Array<{
    steamID: string;
    personaName: string;
    firstSeen: string;
    lastSeen: string;
    onRoster: boolean;
  }>;
}

interface FunnelDay {
  date: string;
  authStart: number;
  callbackHit: number;
  callbackOk: number;
  callbackFail: number;
  clientDiag: number;
}

async function adminStats(env: Env): Promise<Response> {
  const now = new Date();

  // ---- online presence ----
  // Single-roster read; presence layout switched to `presence:roster` JSON to
  // stop the per-poll list() bleed on the public endpoint.
  const onlineEntries: PresenceEntry[] = [];
  {
    const raw = await env.LOBBIES.get("presence:roster");
    if (raw) {
      try {
        const r = JSON.parse(raw) as { entries?: PresenceEntry[] };
        if (Array.isArray(r.entries)) onlineEntries.push(...r.entries);
      } catch {}
    }
  }

  // ---- ever-signed-in count (count keys) ----
  let everSignedIn = 0;
  {
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({ prefix: "user:", cursor, limit: 1000 });
      everSignedIn += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  // ---- daily-active over the last 7 days, plus 24h subset ----
  const days: Array<{ date: string; activeUsers: number }> = [];
  let activeLast24h = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const tag = ymd(d);
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({
        prefix: `seen:${tag}:`,
        cursor,
        limit: 1000,
      });
      count += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    days.push({ date: tag, activeUsers: count });
    if (i === 0) activeLast24h = count;
  }
  const activeLast7d = days.reduce((acc, d) => acc + d.activeUsers, 0);

  // ---- recent sign-ins (last 30) ----
  const signIns: AdminStats["recentSignIns"] = [];
  {
    let cursor: string | undefined;
    const all: Array<{ when: string; steamID: string }> = [];
    do {
      const page = await env.LOBBIES.list({ prefix: "signin:", cursor, limit: 1000 });
      for (const k of page.keys) {
        // key form: signin:<ISO>:<steamID>
        const rest = k.name.slice("signin:".length);
        const splitAt = rest.lastIndexOf(":");
        if (splitAt < 0) continue;
        all.push({ when: rest.slice(0, splitAt), steamID: rest.slice(splitAt + 1) });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    all.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    const top = all.slice(0, 30);
    for (const e of top) {
      const meta = await env.LOBBIES.get(`user-meta:${e.steamID}`);
      let persona = "Steam User";
      if (meta) {
        try {
          const m = JSON.parse(meta);
          if (m?.personaName) persona = m.personaName;
        } catch {}
      }
      signIns.push({ when: e.when, steamID: e.steamID, personaName: persona });
    }
  }

  // ---- active sessions ----
  let sessionsActive = 0;
  {
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({ prefix: "session:", cursor, limit: 1000 });
      sessionsActive += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  // ---- sign-in funnel (last 7 days, per-day) ----
  const funnelDays: FunnelDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const tag = ymd(d);
    const [authStart, callbackHit, callbackOk, callbackFail, clientDiag] =
      await Promise.all([
        readCounter(env, `funnel:start:${tag}`),
        readCounter(env, `funnel:cb-attempt:${tag}`),
        readCounter(env, `funnel:cb-ok:${tag}`),
        readCounterPrefix(env, `funnel:cb-fail:`, `:${tag}`),
        readCounterPrefix(env, `funnel:diag:`, `:${tag}`),
      ]);
    funnelDays.push({
      date: tag,
      authStart,
      callbackHit,
      callbackOk,
      callbackFail,
      clientDiag,
    });
  }
  const today = funnelDays[0]!;

  // ---- callback failure reasons (aggregate over 30 days for stability) ----
  const callbackFailures: Record<string, number> = {};
  const clientDiagnostics: Record<string, number> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const tag = ymd(d);
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({
        prefix: `funnel:cb-fail:`,
        cursor,
        limit: 1000,
      });
      for (const k of page.keys) {
        if (!k.name.endsWith(`:${tag}`)) continue;
        const reason = k.name.slice("funnel:cb-fail:".length, -tag.length - 1);
        const v = await env.LOBBIES.get(k.name);
        callbackFailures[reason] =
          (callbackFailures[reason] ?? 0) + Number(v ?? 0);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    let cursor2: string | undefined;
    do {
      const diagPage = await env.LOBBIES.list({
        prefix: `funnel:diag:`,
        cursor: cursor2,
        limit: 1000,
      });
      for (const k of diagPage.keys) {
        if (!k.name.endsWith(`:${tag}`)) continue;
        const reason = k.name.slice("funnel:diag:".length, -tag.length - 1);
        const v = await env.LOBBIES.get(k.name);
        clientDiagnostics[reason] =
          (clientDiagnostics[reason] ?? 0) + Number(v ?? 0);
      }
      cursor2 = diagPage.list_complete ? undefined : diagPage.cursor;
    } while (cursor2);
  }

  // ---- recent diagnostic events (last 50, with detail) ----
  const recentEvents: AdminStats["failures"]["recentEvents"] = [];
  {
    let cursor: string | undefined;
    const all: Array<{ when: string; reason: string; key: string }> = [];
    do {
      const page = await env.LOBBIES.list({
        prefix: "funnel:diag-ev:",
        cursor,
        limit: 1000,
      });
      for (const k of page.keys) {
        // key form: funnel:diag-ev:<ISO>:<reason>
        const rest = k.name.slice("funnel:diag-ev:".length);
        const splitAt = rest.lastIndexOf(":");
        if (splitAt < 0) continue;
        all.push({
          when: rest.slice(0, splitAt),
          reason: rest.slice(splitAt + 1),
          key: k.name,
        });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    all.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    for (const e of all.slice(0, 50)) {
      const detail = (await env.LOBBIES.get(e.key)) ?? "";
      recentEvents.push({ when: e.when, reason: e.reason, detail });
    }
  }

  // ---- every user ever signed in (with on-roster flag) ----
  // Capped at 500 to keep the JSON small. If you ever go past 500 unique users
  // you'll want pagination, but at that point the funnel is *working*.
  const rosterIDs = new Set(onlineEntries.map((e) => e.steamID));
  const allUsers: AdminStats["allUsers"] = [];
  {
    let cursor: string | undefined;
    const userIDs: string[] = [];
    do {
      const page = await env.LOBBIES.list({ prefix: "user:", cursor, limit: 1000 });
      for (const k of page.keys) {
        const sid = k.name.slice("user:".length);
        if (/^\d{17}$/.test(sid)) userIDs.push(sid);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && userIDs.length < 500);

    // Pull metadata in parallel batches so this scales gracefully.
    const metas = await Promise.all(
      userIDs.map(async (sid) => {
        const raw = await env.LOBBIES.get(`user-meta:${sid}`);
        if (!raw) return { steamID: sid, meta: null as any };
        try {
          return { steamID: sid, meta: JSON.parse(raw) };
        } catch {
          return { steamID: sid, meta: null as any };
        }
      })
    );
    for (const { steamID, meta } of metas) {
      allUsers.push({
        steamID,
        personaName: meta?.personaName ?? "Steam User",
        firstSeen: meta?.firstSeen ?? "",
        lastSeen: meta?.lastSeen ?? "",
        onRoster: rosterIDs.has(steamID),
      });
    }
    allUsers.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  }

  const stats: AdminStats = {
    generatedAt: now.toISOString(),
    online: {
      count: onlineEntries.length,
      inSTS2: onlineEntries.filter((e) => e.inSTS2).length,
      entries: onlineEntries
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((e) => ({
          steamID: e.steamID,
          personaName: e.personaName,
          status: e.status,
          note: e.note,
          inSTS2: e.inSTS2,
          updatedAt: e.updatedAt,
        })),
    },
    totals: { everSignedIn, activeLast24h, activeLast7d, sessionsActive },
    daily: days.reverse(),
    recentSignIns: signIns,
    funnel: {
      today,
      last7Days: funnelDays.slice().reverse(),
    },
    failures: {
      callbackFailures,
      clientDiagnostics,
      recentEvents,
    },
    allUsers,
  };

  return new Response(JSON.stringify(stats), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// MARK: - User-tracking writes -----------------------------------------------

/**
 * Called once on every successful Steam OpenID callback. Side effects:
 *  - Marks the user as ever-seen (idempotent).
 *  - Updates user-meta with the latest persona/avatar + lastSeen.
 *  - Records a sign-in event for the recent-sign-ins list (TTL 30 days).
 *  - Marks today's "seen" key (TTL 10 days) so DAU counts pick it up.
 */
export async function recordSignIn(
  env: Env,
  steamID: string,
  personaName: string,
  avatarURL: string | undefined
): Promise<void> {
  const now = new Date();
  const nowISO = now.toISOString();
  const day = ymd(now);

  // ever-seen marker, no TTL
  await env.LOBBIES.put(`user:${steamID}`, "1");

  // metadata: read-modify-write so firstSeen survives later sign-ins
  let firstSeen = nowISO;
  try {
    const existing = await env.LOBBIES.get(`user-meta:${steamID}`);
    if (existing) {
      const prev = JSON.parse(existing);
      if (typeof prev?.firstSeen === "string") firstSeen = prev.firstSeen;
    }
  } catch {}

  await env.LOBBIES.put(
    `user-meta:${steamID}`,
    JSON.stringify({ personaName, avatarURL, firstSeen, lastSeen: nowISO })
  );

  // recent-sign-ins event (TTL 30d, keyed for natural sort order)
  await env.LOBBIES.put(`signin:${nowISO}:${steamID}`, "1", {
    expirationTtl: 30 * 86_400,
  });

  // today's DAU marker (TTL 10d so 7-day-back lookback is safe)
  await env.LOBBIES.put(`seen:${day}:${steamID}`, "1", {
    expirationTtl: 10 * 86_400,
  });
}

/**
 * Called on every successful presence heartbeat. Touches the daily-seen marker
 * so DAU stays accurate even for users who came online once today and never
 * re-authed.
 *
 * IMPORTANT: this runs on **every** heartbeat. We read first and only write
 * if the marker isn't already set today. Reads are abundant (100k/day on free
 * tier); writes are scarce (1k/day). One write per user per day, max — instead
 * of one write per heartbeat per user.
 */
export async function recordHeartbeat(env: Env, steamID: string): Promise<void> {
  const day = ymd(new Date());
  const key = `seen:${day}:${steamID}`;
  const existing = await env.LOBBIES.get(key);
  if (existing) return; // already marked today — save the write
  // KV is eventually consistent; setting the same value keeps the TTL fresh.
  await env.LOBBIES.put(`seen:${day}:${steamID}`, "1", {
    expirationTtl: 10 * 86_400,
  });
}

// MARK: - Funnel tracking ---------------------------------------------------

/**
 * Atomic-ish counter increment. KV doesn't have a real atomic increment, so
 * this is read-modify-write: two simultaneous bumps from different colos can
 * collide and lose one tick. That's fine for a funnel — we're trying to
 * spot orders of magnitude (0 vs 5 vs 50), not bill anyone for sub-tick
 * accuracy.
 *
 * `ttlSeconds` is renewed on every write so an active counter never expires.
 */
/**
 * Increment a daily KV counter. KV does not support atomic increments, so
 * this is a best-effort read-modify-write. Two concurrent bumps on the
 * same edge cache window can both read the same value and undercount by 1.
 *
 * For a hobby-scale funnel that peaks at a few sign-ins per minute, the
 * shape (start vs cb-attempt vs cb-ok vs roster-first) is what matters
 * to the operator. Absolute counts will be slightly low under bursty
 * load — that's acceptable given there's no Durable Object overhead.
 *
 * (Earlier versions tried `cacheTtl: 0` to dodge the read cache, but KV
 * rejects any cacheTtl below 60s and the rejection threw silently inside
 * `.catch(() => {})`, zeroing out every callback funnel write. Don't
 * bring it back without using a real atomic primitive.)
 */
async function bumpCounter(
  env: Env,
  key: string,
  ttlSeconds: number
): Promise<void> {
  const existing = await env.LOBBIES.get(key);
  const next = (Number(existing ?? 0) || 0) + 1;
  await env.LOBBIES.put(key, String(next), { expirationTtl: ttlSeconds });
}

async function readCounter(env: Env, key: string): Promise<number> {
  const v = await env.LOBBIES.get(key);
  return Number(v ?? 0) || 0;
}

/**
 * Sum every counter that matches `<prefix>...<suffix>`. Used to roll up
 * `funnel:cb-fail:*:<day>` and `funnel:diag:*:<day>` without pre-knowing
 * which reason codes have been recorded.
 *
 * One list-op per call, plus one read per matching key. We only invoke it
 * inside the admin endpoint, which is operator-only and not on a hot path.
 */
async function readCounterPrefix(
  env: Env,
  prefix: string,
  suffix: string
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.LOBBIES.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys) {
      if (!k.name.endsWith(suffix)) continue;
      const v = await env.LOBBIES.get(k.name);
      total += Number(v ?? 0) || 0;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return total;
}

const FUNNEL_TTL = 90 * 86_400;

/** Bumped on every /auth/steam/start. */
export async function recordAuthStart(env: Env): Promise<void> {
  await bumpCounter(env, `funnel:start:${ymd(new Date())}`, FUNNEL_TTL);
}

/** Bumped on every /auth/steam/callback hit, regardless of outcome. */
export async function recordAuthCallbackAttempt(env: Env): Promise<void> {
  await bumpCounter(env, `funnel:cb-attempt:${ymd(new Date())}`, FUNNEL_TTL);
}

/** Bumped only when Steam OpenID verifies + we extract a SteamID. */
export async function recordAuthCallbackOK(env: Env): Promise<void> {
  await bumpCounter(env, `funnel:cb-ok:${ymd(new Date())}`, FUNNEL_TTL);
}

/**
 * Bumped when the callback fails for a known reason. `reason` should be a
 * short, slug-safe string ("verify-rejected", "no-claimed-id", etc) so the
 * dashboard can show a meaningful breakdown.
 */
export async function recordAuthCallbackFail(
  env: Env,
  reason: string
): Promise<void> {
  const safe = (reason || "unknown").replace(/[^a-z0-9_-]/gi, "-").slice(0, 40);
  await bumpCounter(env, `funnel:cb-fail:${safe}:${ymd(new Date())}`, FUNNEL_TTL);
}

/**
 * Client-side diagnostic beacon. Used when the browser knows something the
 * server can't possibly know — e.g. "we landed on /auth.html but the nonce
 * we stored before redirecting is gone, this is almost certainly an
 * in-app browser stripping sessionStorage across the OpenID redirect".
 */
export async function recordClientDiagnostic(
  env: Env,
  reason: string,
  detail: string
): Promise<void> {
  const day = ymd(new Date());
  const safeReason = (reason || "unknown").replace(/[^a-z0-9_-]/gi, "-").slice(0, 40);
  const safeDetail = (detail || "").replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 280);
  // Counter — for the funnel rollup.
  await bumpCounter(env, `funnel:diag:${safeReason}:${day}`, FUNNEL_TTL);
  // Event row — keeps a sample of *what* the user saw.
  // 30 day TTL, ISO-keyed for natural sort order.
  await env.LOBBIES.put(
    `funnel:diag-ev:${new Date().toISOString()}:${safeReason}`,
    safeDetail,
    { expirationTtl: 30 * 86_400 }
  );
}

/**
 * Marks a user as having reached the live presence roster at least once.
 * Lives forever (no TTL) so the admin dashboard can compute the
 * "auth'd but never on roster" gap retrospectively.
 *
 * Idempotent: read-first-skip so we don't burn a write per heartbeat.
 */
export async function recordRosterFirstSeen(
  env: Env,
  steamID: string
): Promise<void> {
  const key = `funnel:roster-first:${steamID}`;
  const existing = await env.LOBBIES.get(key);
  if (existing) return;
  await env.LOBBIES.put(key, new Date().toISOString());
}

// MARK: - Dashboard HTML -----------------------------------------------------

function adminHTML(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Vault · ops</title>
<style>
  :root {
    --bg:#0c0a14; --bg2:#06040a; --card:#14111e; --card2:#1a1626;
    --bd:#28233a; --gold:#d4af37; --ember:#ff6b1a; --emberHi:#ffa05c;
    --text:#f4eddc; --t2:#b6abc4; --t3:#6c647a; --win:#6dd97c; --loss:#ff5f6d;
  }
  * { box-sizing: border-box; }
  html,body { background: var(--bg); color: var(--text); margin:0; padding:0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  a { color: var(--emberHi); }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 28px 64px; }
  header { display:flex; align-items:center; gap:14px; padding-bottom:22px;
    border-bottom: 1px solid var(--bd); margin-bottom: 28px; }
  header h1 { margin:0; font-size: 18px; letter-spacing:1px; color: var(--gold); }
  header .live { color: var(--win); font-size:12px; }
  header .stamp { color: var(--t3); font-size:12px; margin-left:auto; }
  .grid { display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); }
  .card { background: var(--card); border:1px solid var(--bd); border-radius: 14px;
    padding: 18px 20px; }
  .card h3 { margin:0 0 6px; font-size: 11px; color: var(--t3); letter-spacing:2px;
    font-weight:700; text-transform:uppercase; }
  .card .v { font-size: 36px; font-weight: 800; letter-spacing:-0.02em; color: var(--text); }
  .card .v.gold { color: var(--gold); }
  .card .v.ember { background:linear-gradient(120deg, var(--emberHi), var(--gold));
    -webkit-background-clip:text; -webkit-text-fill-color: transparent; }
  .card .sub { font-size:11px; color: var(--t3); margin-top: 6px; }
  section { margin-top: 32px; }
  section h2 { margin: 0 0 12px; font-size: 12px; color: var(--gold);
    letter-spacing:2px; text-transform:uppercase; font-weight:800; }
  table { width:100%; border-collapse: collapse; background: var(--card);
    border:1px solid var(--bd); border-radius: 14px; overflow:hidden; }
  th, td { text-align:left; padding: 10px 14px; border-bottom: 1px solid var(--bd);
    font-size: 13px; }
  th { background: var(--card2); font-size:10px; color:var(--t3);
    text-transform:uppercase; letter-spacing:1.5px; }
  tr:last-child td { border-bottom: 0; }
  td.muted { color: var(--t3); font-size:12px; }
  .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size:10px;
    font-weight:700; letter-spacing:1px; text-transform:uppercase; border:1px solid; }
  .pill.looking { color: var(--win); border-color: rgba(109,217,124,0.4); background: rgba(109,217,124,0.1); }
  .pill.inRun  { color: var(--ember); border-color: rgba(255,107,26,0.4); background: rgba(255,107,26,0.1); }
  .pill.inCoop { color: var(--gold); border-color: rgba(212,175,55,0.4); background: rgba(212,175,55,0.1); }
  .pill.afk    { color: var(--t3); border-color: var(--bd); }
  .spark { display:flex; gap:6px; align-items:flex-end; height:60px; padding:6px 0; }
  .spark .bar { flex:1; min-width:8px; background:linear-gradient(180deg, var(--ember), var(--gold));
    border-radius: 3px 3px 0 0; opacity:0.85; position:relative; }
  .spark .bar:hover { opacity:1; }
  .spark .bar .n { position:absolute; top:-18px; left:50%; transform:translateX(-50%);
    font-size:10px; color: var(--t3); }
  .spark .lbl { font-size:9px; color:var(--t3); text-align:center; letter-spacing:1px; }
  .funnel-row { display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap; }
  .funnel-step { flex: 1 1 140px; padding: 12px 14px; background: var(--card2);
    border-radius: 10px; min-width: 120px; }
  .funnel-step .funnel-label { font-size: 10px; color: var(--t3);
    letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; }
  .funnel-step .funnel-value { font-size: 30px; font-weight: 800; color: var(--gold);
    letter-spacing: -0.02em; margin-top: 4px; }
  .funnel-step .funnel-sub { font-size: 11px; color: var(--t3); margin-top: 2px; }
  .funnel-arrow { display: flex; align-items: center; color: var(--ember);
    font-size: 18px; padding: 0 2px; }
  .funnel-foot { font-size: 11px; color: var(--t3); margin-top: 14px;
    padding-top: 12px; border-top: 1px solid var(--bd); }
  .gate { max-width: 380px; margin: 80px auto; padding: 28px;
    background: var(--card); border:1px solid var(--bd); border-radius:14px; }
  .gate h2 { margin: 0 0 6px; font-size:16px; color: var(--gold); letter-spacing:1px; }
  .gate p { margin: 0 0 16px; color: var(--t3); font-size:13px; }
  .gate input { width:100%; padding: 12px 14px; background: var(--bg2); color: var(--text);
    border:1px solid var(--bd); border-radius: 8px; font-family: inherit; font-size:14px; }
  .gate button { width:100%; margin-top: 12px; padding: 12px; border:0; border-radius:8px;
    background: linear-gradient(120deg, var(--ember), var(--gold)); color:#1a1626;
    font-weight:800; font-size:13px; letter-spacing:1px; cursor:pointer; }
  .err { color: var(--loss); font-size: 12px; margin-top: 8px; min-height: 1em; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(() => {
  const STORAGE_KEY = "vault.admin.t";
  const root = document.getElementById("root");

  function gate(prefill) {
    root.innerHTML = \`
      <div class="gate">
        <h2>Vault · ops</h2>
        <p>Bearer token, please.</p>
        <input id="t" type="password" autocomplete="off" placeholder="token" value="\${prefill||""}" />
        <button id="go">Enter</button>
        <div class="err" id="e"></div>
      </div>\`;
    document.getElementById("t").focus();
    document.getElementById("go").onclick = tryEnter;
    document.getElementById("t").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") tryEnter();
    });
  }

  async function tryEnter() {
    const t = document.getElementById("t").value.trim();
    if (!t) return;
    const ok = await fetchStats(t).catch(() => null);
    if (!ok) {
      document.getElementById("e").textContent = "rejected.";
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, t);
    render(ok);
  }

  async function fetchStats(token) {
    const r = await fetch("/admin/stats", {
      headers: { authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    return r.json();
  }

  function pill(status) {
    const s = (status || "").toLowerCase();
    const cls = ["looking","inrun","incoop","afk"].includes(s) ? s : "afk";
    return \`<span class="pill \${status}">\${status}</span>\`;
  }

  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return Math.floor(ms / 1000) + "s ago";
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h ago";
    return Math.floor(ms / 86_400_000) + "d ago";
  }

  function fmtDay(yyyymmdd) {
    return yyyymmdd.slice(0,4) + "-" + yyyymmdd.slice(4,6) + "-" + yyyymmdd.slice(6,8);
  }

  function render(s) {
    const max = Math.max(1, ...s.daily.map(d => d.activeUsers));
    const sparkBars = s.daily.map(d => {
      const h = Math.max(2, Math.round(d.activeUsers / max * 56));
      return \`<div style="flex:1;min-width:0">
        <div class="bar" style="height:\${h}px"><span class="n">\${d.activeUsers}</span></div>
        <div class="lbl">\${d.date.slice(6,8)}</div>
      </div>\`;
    }).join("");

    const onlineRows = s.online.entries.length === 0
      ? \`<tr><td colspan="5" class="muted">no one online right now.</td></tr>\`
      : s.online.entries.map(e => \`
        <tr>
          <td>\${escape(e.personaName)}</td>
          <td>\${pill(e.status)}\${e.inSTS2 ? \` <span class="pill inRun">in STS2</span>\` : ""}</td>
          <td class="muted">\${escape(e.note || "—")}</td>
          <td class="muted">\${timeAgo(e.updatedAt)}</td>
          <td class="muted"><a href="https://steamcommunity.com/profiles/\${e.steamID}" target="_blank" rel="noopener">profile</a></td>
        </tr>\`).join("");

    const signinRows = s.recentSignIns.length === 0
      ? \`<tr><td colspan="3" class="muted">no recent sign-ins.</td></tr>\`
      : s.recentSignIns.map(e => \`
        <tr>
          <td>\${escape(e.personaName)}</td>
          <td class="muted">\${timeAgo(e.when)}</td>
          <td class="muted"><a href="https://steamcommunity.com/profiles/\${e.steamID}" target="_blank" rel="noopener">\${e.steamID}</a></td>
        </tr>\`).join("");

    const funnelRows = s.funnel.last7Days.map(d => \`
      <tr>
        <td>\${fmtDay(d.date)}</td>
        <td><strong>\${d.authStart}</strong></td>
        <td>\${d.callbackHit}</td>
        <td>\${d.callbackOk}</td>
        <td class="muted">\${d.callbackFail}</td>
        <td class="muted">\${d.clientDiag}</td>
      </tr>\`).join("");

    const allUserRows = s.allUsers.length === 0
      ? \`<tr><td colspan="5" class="muted">nobody has signed in yet.</td></tr>\`
      : s.allUsers.map(u => \`
        <tr>
          <td>\${escape(u.personaName)}</td>
          <td class="muted"><a href="https://steamcommunity.com/profiles/\${u.steamID}" target="_blank" rel="noopener">\${u.steamID}</a></td>
          <td class="muted">\${u.firstSeen ? timeAgo(u.firstSeen) : "—"}</td>
          <td class="muted">\${u.lastSeen ? timeAgo(u.lastSeen) : "—"}</td>
          <td>\${u.onRoster ? \`<span class="pill looking">on roster</span>\` : \`<span class="pill afk">off roster</span>\`}</td>
        </tr>\`).join("");

    const failureKeys = Object.keys(s.failures.callbackFailures);
    const diagKeys = Object.keys(s.failures.clientDiagnostics);
    const recentFailureRows = s.failures.recentEvents.length === 0
      ? \`<tr><td colspan="3" class="muted">no client-side bounces logged.</td></tr>\`
      : s.failures.recentEvents.map(e => \`
        <tr>
          <td><span class="pill afk">\${escape(e.reason)}</span></td>
          <td class="muted">\${timeAgo(e.when)}</td>
          <td class="muted">\${escape(e.detail || "—")}</td>
        </tr>\`).join("");

    const failureSection = (failureKeys.length === 0 && diagKeys.length === 0 && s.failures.recentEvents.length === 0)
      ? ""
      : \`
        <section>
          <h2>Where people are getting stuck (last 30 days)</h2>
          <div class="grid">
            \${failureKeys.map(k => \`
              <div class="card"><h3>\${escape(k)}</h3>
                <div class="v">\${s.failures.callbackFailures[k]}</div>
                <div class="sub">server rejected</div>
              </div>\`).join("")}
            \${diagKeys.map(k => \`
              <div class="card"><h3>\${escape(k)}</h3>
                <div class="v">\${s.failures.clientDiagnostics[k]}</div>
                <div class="sub">client bounced</div>
              </div>\`).join("")}
          </div>
          <div style="height: 18px"></div>
          <table>
            <thead><tr><th>reason</th><th>when</th><th>detail</th></tr></thead>
            <tbody>\${recentFailureRows}</tbody>
          </table>
        </section>\`;

    root.innerHTML = \`
      <div class="wrap">
        <header>
          <h1>Vault · ops</h1>
          <span class="live">● live</span>
          <span class="stamp">refreshed \${new Date(s.generatedAt).toLocaleTimeString()}</span>
        </header>

        <div class="grid">
          <div class="card"><h3>Online now</h3>
            <div class="v ember">\${s.online.count}</div>
            <div class="sub">\${s.online.inSTS2} of them in STS2 right now</div>
          </div>
          <div class="card"><h3>Active sessions</h3>
            <div class="v">\${s.totals.sessionsActive}</div>
            <div class="sub">unexpired bearer tokens</div>
          </div>
          <div class="card"><h3>Active · 24h</h3>
            <div class="v">\${s.totals.activeLast24h}</div>
            <div class="sub">unique users seen today</div>
          </div>
          <div class="card"><h3>Active · 7d</h3>
            <div class="v">\${s.totals.activeLast7d}</div>
            <div class="sub">cumulative across the week</div>
          </div>
          <div class="card"><h3>Total Vault users</h3>
            <div class="v gold">\${s.totals.everSignedIn}</div>
            <div class="sub">unique Steam IDs ever signed in</div>
          </div>
        </div>

        <section>
          <h2>Last 7 days</h2>
          <div class="card">
            <div class="spark">\${sparkBars}</div>
          </div>
        </section>

        <section>
          <h2>Online right now</h2>
          <table>
            <thead><tr>
              <th>persona</th><th>status</th><th>note</th><th>last heartbeat</th><th>steam</th>
            </tr></thead>
            <tbody>\${onlineRows}</tbody>
          </table>
        </section>

        <section>
          <h2>Sign-in funnel · today</h2>
          <div class="card funnel">
            <div class="funnel-row">
              <div class="funnel-step">
                <div class="funnel-label">Clicked sign in</div>
                <div class="funnel-value">\${s.funnel.today.authStart}</div>
              </div>
              <div class="funnel-arrow">→</div>
              <div class="funnel-step">
                <div class="funnel-label">Returned from Steam</div>
                <div class="funnel-value">\${s.funnel.today.callbackHit}</div>
                <div class="funnel-sub">\${pct(s.funnel.today.callbackHit, s.funnel.today.authStart)}</div>
              </div>
              <div class="funnel-arrow">→</div>
              <div class="funnel-step">
                <div class="funnel-label">Verified by Steam</div>
                <div class="funnel-value">\${s.funnel.today.callbackOk}</div>
                <div class="funnel-sub">\${pct(s.funnel.today.callbackOk, s.funnel.today.callbackHit)}</div>
              </div>
              <div class="funnel-arrow">→</div>
              <div class="funnel-step">
                <div class="funnel-label">Online now</div>
                <div class="funnel-value">\${s.online.count}</div>
              </div>
            </div>
            <div class="funnel-foot">
              \${s.funnel.today.callbackFail} server-side failures ·
              \${s.funnel.today.clientDiag} client-side bounces
            </div>
          </div>
        </section>

        <section>
          <h2>Funnel · last 7 days</h2>
          <table>
            <thead><tr>
              <th>day</th><th>clicked sign in</th><th>back from steam</th>
              <th>verified</th><th>cb fails</th><th>client bounces</th>
            </tr></thead>
            <tbody>\${funnelRows}</tbody>
          </table>
        </section>

        \${failureSection}

        <section>
          <h2>Recent sign-ins</h2>
          <table>
            <thead><tr><th>persona</th><th>when</th><th>steam id</th></tr></thead>
            <tbody>\${signinRows}</tbody>
          </table>
        </section>

        <section>
          <h2>Every Steam user who has signed in (\${s.allUsers.length})</h2>
          <table>
            <thead><tr>
              <th>persona</th><th>steam id</th>
              <th>first seen</th><th>last seen</th><th>on roster</th>
            </tr></thead>
            <tbody>\${allUserRows}</tbody>
          </table>
        </section>
      </div>\`;
  }

  function pct(numerator, denominator) {
    if (!denominator) return "—";
    const p = Math.round((numerator / denominator) * 100);
    return p + "%";
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"
    }[c]));
  }

  async function boot() {
    const cached = sessionStorage.getItem(STORAGE_KEY);
    if (cached) {
      const s = await fetchStats(cached).catch(() => null);
      if (s) {
        render(s);
        // auto-refresh every 30s while the tab is open
        setInterval(async () => {
          const t = sessionStorage.getItem(STORAGE_KEY);
          if (!t) return;
          const ns = await fetchStats(t).catch(() => null);
          if (ns) render(ns);
        }, 30_000);
        return;
      }
      sessionStorage.removeItem(STORAGE_KEY);
    }
    gate("");
  }

  boot();
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}
