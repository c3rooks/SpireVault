import type { Env } from "./types";
import type {
  CoopInvite,
  CoopPresenceFeedRow,
  CoopStateBundle,
  JoinRequest,
} from "./coop-types";
import {
  COOP_INVITE_MESSAGES,
} from "./coop-types";
import {
  acceptInvite,
  acceptJoinRequest,
  cancelInvite,
  cancelJoinRequest,
  closeLobby,
  createLobby,
  declineInvite,
  declineJoinRequest,
  endSession,
  heartbeatPresence,
  isPresenceActive,
  listLobbies,
  listPresence,
  pruneInbox,
  pruneOutbox,
  pruneUserJoinRequests,
  pruneLobbyJoinRequests,
  requestToJoinLobby,
  sendInvite,
  updateLobby,
  upsertPresenceV2,
  type CreateLobbyBody,
  type PresenceUpsertBody,
  type SendInviteBody,
  type UpdateLobbyBody,
} from "./coop-engine";
import {
  COOP_INACTIVE_HIDE_S,
  readLobby,
  readPresence,
  readSession,
} from "./coop-store";
import { recommendMatches } from "./coop-recommendations";
import { checkAndConsume, clientIP, hashID } from "./ratelimit";
import { requireSession } from "./auth";

/**
 * Co-op route surface. Mounted under `/coop/*`. Every write goes
 * through `requireSession` so a request cannot impersonate another
 * Steam ID.
 *
 * Response shape:
 *   Success → 200 with `{ ok: true, ...payload }` or the bundle directly
 *   for /state.
 *   Friendly client errors → 4xx with `{ ok: false, error, message }`.
 *   Server / KV outage → 5xx with `{ ok: false, error: "internal" }`.
 */

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

function errResp(status: number, error: string, message: string): Response {
  return json({ ok: false, error, message }, { status });
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function rateLimit(
  env: Env,
  req: Request,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<Response | null> {
  const ip = clientIP(req);
  if (!ip) return null;
  const id = await hashID(ip);
  const r = await checkAndConsume(env, { bucket, id, max, windowSeconds });
  if (r.allowed) return null;
  return json(
    { ok: false, error: "rate_limited", message: "Slow down — try again in a moment." },
    { status: 429, headers: { "retry-after": String(r.retryAfterSec) } },
  );
}

// ---------- Public route dispatcher ----------

/**
 * Return Response if this request is a co-op route handled here.
 * Otherwise return null and the caller falls through to other matchers.
 */
export async function handleCoopRoute(
  req: Request,
  env: Env,
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (method === "GET" && pathname === "/coop/messages") {
    return json({ ok: true, messages: COOP_INVITE_MESSAGES });
  }

  if (method === "GET" && pathname === "/coop/state") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    return await buildStateResponse(env, auth.steamID);
  }
  if (method === "GET" && pathname === "/coop/recommendations") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const bundle = await buildStateBundle(env, auth.steamID);
    return json({ ok: true, recommendations: bundle.recommendedMatches });
  }

  if (method === "POST" && pathname === "/coop/presence") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-presence-write", 30, 60);
    if (rl) return rl;
    const body = (await readJson(req)) as PresenceUpsertBody | null;
    if (!body || typeof body !== "object") {
      return errResp(400, "invalid_body", "Missing body.");
    }
    const r = await upsertPresenceV2(env, auth.steamID, body);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, presence: r.value });
  }

  if (method === "POST" && pathname === "/coop/heartbeat") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-heartbeat", 120, 60);
    if (rl) return rl;
    const r = await heartbeatPresence(env, auth.steamID);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, presence: r.value });
  }

  if (method === "POST" && pathname === "/coop/lobbies") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-write", 60, 60);
    if (rl) return rl;
    const body = (await readJson(req)) as CreateLobbyBody | null;
    if (!body || typeof body !== "object") {
      return errResp(400, "invalid_body", "Missing body.");
    }
    const r = await createLobby(env, auth.steamID, body);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, lobby: r.value });
  }

  // Per-lobby routes
  const lobbyMatch = pathname.match(
    /^\/coop\/lobbies\/([0-9a-f]{32})(?:\/(close|request|accept|decline|cancel-request))?$/,
  );
  if (lobbyMatch) {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const lobbyId = lobbyMatch[1]!;
    const subroute = lobbyMatch[2];

    const rl = await rateLimit(env, req, "coop-write", 60, 60);
    if (rl) return rl;

    if (!subroute && method === "PATCH") {
      const body = (await readJson(req)) as UpdateLobbyBody | null;
      if (!body || typeof body !== "object") {
        return errResp(400, "invalid_body", "Missing body.");
      }
      const r = await updateLobby(env, auth.steamID, lobbyId, body);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, lobby: r.value });
    }
    if (subroute === "close" && method === "POST") {
      const r = await closeLobby(env, auth.steamID, lobbyId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, ...r.value });
    }
    if (subroute === "request" && method === "POST") {
      const r = await requestToJoinLobby(env, auth.steamID, lobbyId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, request: r.value });
    }
    if (subroute === "cancel-request" && method === "POST") {
      const r = await cancelJoinRequest(env, auth.steamID, lobbyId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, ...r.value });
    }
    if ((subroute === "accept" || subroute === "decline") && method === "POST") {
      const body = (await readJson(req)) as { fromSteamId?: string } | null;
      const requesterSteamId =
        body && typeof body.fromSteamId === "string" ? body.fromSteamId : "";
      if (!/^\d{17}$/.test(requesterSteamId)) {
        return errResp(400, "invalid_target", "Pick a requester to respond to.");
      }
      if (subroute === "accept") {
        const r = await acceptJoinRequest(env, auth.steamID, lobbyId, requesterSteamId);
        if (!r.ok) return errResp(r.status, r.error, r.message);
        return json({ ok: true, session: r.value.session, lobby: r.value.lobby });
      }
      const r = await declineJoinRequest(env, auth.steamID, lobbyId, requesterSteamId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, ...r.value });
    }
    return errResp(404, "not_found", "Unknown lobby route.");
  }

  // Invites
  if (method === "POST" && pathname === "/coop/invites") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl1 = await rateLimit(env, req, "coop-write", 60, 60);
    if (rl1) return rl1;
    // Per-IP soft cap: 20 invite attempts per 10 minutes. The primary
    // per-user pending cap (`MAX_PENDING_OUTGOING_INVITES`) is enforced
    // inside `sendInvite()`; this IP bucket exists to stop a single
    // dorm/coffee-shop IP from coordinating spam across multiple
    // logged-in Steam accounts. Anything tighter than ~20/10min
    // starts catching legitimate users with several back-and-forth
    // invite rounds.
    const rl2 = await rateLimit(env, req, "coop-invite-window", 20, 10 * 60);
    if (rl2) return rl2;
    const body = (await readJson(req)) as SendInviteBody | null;
    if (!body || typeof body !== "object") {
      return errResp(400, "invalid_body", "Missing body.");
    }
    const r = await sendInvite(env, auth.steamID, body);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, invite: r.value });
  }

  const inviteMatch = pathname.match(
    /^\/coop\/invites\/([0-9a-f]{32})\/(accept|decline|cancel)$/,
  );
  if (inviteMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-write", 60, 60);
    if (rl) return rl;
    const inviteId = inviteMatch[1]!;
    const action = inviteMatch[2];
    if (action === "accept") {
      const r = await acceptInvite(env, auth.steamID, inviteId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, session: r.value.session, invite: r.value.invite });
    }
    if (action === "decline") {
      const r = await declineInvite(env, auth.steamID, inviteId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, ...r.value });
    }
    const r = await cancelInvite(env, auth.steamID, inviteId);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, ...r.value });
  }

  // Sessions
  const sessionMatch = pathname.match(/^\/coop\/sessions\/([0-9a-f]{32})\/end$/);
  if (sessionMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const r = await endSession(env, auth.steamID, sessionMatch[1]!);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, ...r.value });
  }

  return null;
}

// ---------- /coop/state aggregator ----------

async function buildStateResponse(
  env: Env,
  steamID: string,
): Promise<Response> {
  const bundle = await buildStateBundle(env, steamID);
  return json({ ok: true, ...bundle });
}

async function buildStateBundle(
  env: Env,
  steamID: string,
): Promise<CoopStateBundle> {
  // Make sure this user has a presence row. Boot-time call ensures
  // the user shows up even if they haven't heartbeated yet.
  let presence = await readPresence(env, steamID);
  if (!presence) {
    const r = await upsertPresenceV2(env, steamID, {});
    if (r.ok) presence = r.value;
  }
  if (!presence) {
    throw new Error("could not initialize presence");
  }

  const [
    allPresence,
    allLobbies,
    incomingInvites,
    outgoingInvites,
    outgoingJoinRequests,
  ] = await Promise.all([
    listPresence(env),
    listLobbies(env),
    pruneInbox(env, steamID),
    pruneOutbox(env, steamID),
    pruneUserJoinRequests(env, steamID),
  ]);

  // Resolve our own lobby + session
  let myLobby = presence.currentLobbyId
    ? await readLobby(env, presence.currentLobbyId)
    : null;
  if (myLobby && myLobby.status !== "open" && myLobby.status !== "full" && myLobby.status !== "pending") {
    myLobby = null;
  }
  const mySession = presence.currentSessionId
    ? await readSession(env, presence.currentSessionId)
    : null;

  // Incoming join requests if I host a lobby
  let incomingJoinRequests: JoinRequest[] = [];
  if (myLobby && myLobby.hostSteamId === steamID) {
    incomingJoinRequests = await pruneLobbyJoinRequests(env, myLobby.lobbyId);
  }

  // Cancel sets for scoring
  const pendingOutgoingInviteTargetIds = new Set(
    outgoingInvites.filter((i) => i.status === "pending").map((i) => i.toSteamId),
  );
  // We don't track decline cooldowns by user — they're per-pair KV keys.
  // For recommendations we look up cooldowns lazily on a small slice
  // (top candidates) to avoid 100 KV reads on every state poll.
  const candidatePool = allPresence.filter((p) => p.steamId !== steamID);

  // First pass: score without cooldown info to pick the top ~16 candidates.
  const firstPass = recommendMatches(
    {
      currentUser: presence,
      candidates: candidatePool,
      pendingOutgoingInviteTargetIds,
      declineCooldownPartnerIds: new Set(),
    },
    16,
  );

  // Pull cooldown info for those top candidates (cheap — bounded by 16).
  const declineCooldownPartnerIds = new Set<string>();
  await Promise.all(
    firstPass.slice(0, 16).map(async (m) => {
      const { isUnderDeclineCooldown } = await import("./coop-store");
      const cd = await isUnderDeclineCooldown(env, steamID, m.steamId);
      if (cd) declineCooldownPartnerIds.add(m.steamId);
    }),
  );

  const recommendedMatches = recommendMatches(
    {
      currentUser: presence,
      candidates: candidatePool,
      pendingOutgoingInviteTargetIds,
      declineCooldownPartnerIds,
    },
    8,
  );

  // Filter lobbies for the open browser:
  //   - hosts must be fresh
  //   - exclude the user's own lobby (it's surfaced as `lobby`)
  //   - status === "open"
  const now = Date.now();
  const openLobbiesAll = allLobbies.filter((l) => {
    if (l.status !== "open") return false;
    if (l.hostSteamId === steamID) return false;
    const host = allPresence.find((p) => p.steamId === l.hostSteamId);
    if (!host) return false;
    if (!isPresenceActive(host, now)) return false;
    if (host.status === "afk" || host.status === "offline" || host.status === "paired") {
      return false;
    }
    return true;
  });

  // Sort lobbies: best match first, then newest, then most-recent activity.
  const scoreFor = (sid: string): number => {
    const p = allPresence.find((x) => x.steamId === sid);
    if (!p) return -1000;
    // Reuse the scoring as a proxy for "this host probably matches me"
    const m = recommendMatches(
      {
        currentUser: presence,
        candidates: [p],
        pendingOutgoingInviteTargetIds,
        declineCooldownPartnerIds,
      },
      1,
    );
    return m.length > 0 ? labelToNumeric(m[0]!.label) : 0;
  };
  openLobbiesAll.sort((a, b) => {
    const sa = scoreFor(a.hostSteamId);
    const sb = scoreFor(b.hostSteamId);
    if (sb !== sa) return sb - sa;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  // Cap the open-lobbies wire payload. At 8000 users the lobby count
  // can grow into the hundreds; the client browses with sort+filter
  // so anything past the top 50 by relevance is never seen. Future:
  // a "show more" cursor for power users. For now the cap is the
  // pragmatic shield against ballooning bundle size.
  const OPEN_LOBBIES_CAP = 50;
  const openLobbies = openLobbiesAll.slice(0, OPEN_LOBBIES_CAP);
  const openLobbiesTotalCount = openLobbiesAll.length;

  // Active player feed: everyone fresh, capped to keep payload bounded.
  const activePlayerFeedAll: CoopPresenceFeedRow[] = allPresence
    .map((p) => ({
      steamId: p.steamId,
      personaName: p.personaName,
      avatarUrl: p.avatarUrl,
      status: p.status,
      goal: p.goal,
      ascensionMin: p.ascensionMin,
      ascensionMax: p.ascensionMax,
      voicePreference: p.voicePreference,
      note: p.note,
      discordHandle: p.discordHandle,
      currentLobbyId: p.currentLobbyId,
      currentSessionId: p.currentSessionId,
      lastHeartbeatAt: p.lastHeartbeatAt,
      isActive: isPresenceActive(p, now),
    }))
    .filter((row) => {
      if (!row.isActive) {
        // Stale rows are hidden from the feed once they're inactive
        // beyond the hide threshold. Computed below.
        const age = (now - Date.parse(row.lastHeartbeatAt)) / 1000;
        if (!Number.isFinite(age)) return false;
        return age <= COOP_INACTIVE_HIDE_S;
      }
      return true;
    });

  activePlayerFeedAll.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return Date.parse(b.lastHeartbeatAt) - Date.parse(a.lastHeartbeatAt);
  });

  // True totals — computed BEFORE the wire cap so the lobby bar stays
  // accurate at any scale. The feed cap below is purely a payload-size
  // shield (200 rows × ~250 bytes ≈ 50 KB on the wire vs. ~2 MB
  // uncapped at 8000 users).
  const playersOnlineCount = activePlayerFeedAll.filter((r) => r.isActive).length;
  const lookingNowCount = activePlayerFeedAll.filter(
    (r) => r.isActive && r.status === "looking",
  ).length;
  const pairedNowCount = activePlayerFeedAll.filter(
    (r) => r.isActive && r.status === "paired",
  ).length;

  // Always keep the user's session partner in the feed even if the
  // freshness cut would knock them out — otherwise the activity card
  // can't render the partner's name.
  const partnerSteamId =
    mySession?.status === "active"
      ? (mySession.playerSteamIds || []).find((sid) => sid !== steamID)
      : undefined;

  const ACTIVE_FEED_CAP = 200;
  let activePlayerFeed = activePlayerFeedAll.slice(0, ACTIVE_FEED_CAP);
  if (
    partnerSteamId &&
    !activePlayerFeed.some((r) => r.steamId === partnerSteamId)
  ) {
    const partnerRow = activePlayerFeedAll.find(
      (r) => r.steamId === partnerSteamId,
    );
    if (partnerRow) activePlayerFeed = [partnerRow, ...activePlayerFeed];
  }

  return {
    presence,
    session: mySession,
    lobby: myLobby,
    incomingInvites: filterPending(incomingInvites),
    outgoingInvites: filterPending(outgoingInvites),
    incomingJoinRequests,
    outgoingJoinRequests,
    openLobbies,
    openLobbiesTotalCount,
    recommendedMatches,
    activePlayerFeed,
    playersOnlineCount,
    lookingNowCount,
    pairedNowCount,
    serverTime: new Date(now).toISOString(),
  };
}

function filterPending(invites: CoopInvite[]): CoopInvite[] {
  const now = Date.now();
  return invites.filter((i) => {
    if (i.status !== "pending") return false;
    const exp = Date.parse(i.expiresAt);
    if (!Number.isFinite(exp)) return false;
    return exp > now;
  });
}

function labelToNumeric(label: string): number {
  if (label === "Strong match") return 100;
  if (label === "Good match") return 60;
  if (label === "Different goal") return 20;
  return 0;
}
