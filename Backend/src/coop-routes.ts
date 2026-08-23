import type { Env } from "./types";
import type {
  CoopInvite,
  CoopPresence,
  CoopPresenceFeedRow,
  CoopStateBundle,
  JoinRequest,
  PublicCoopRoom,
  RunLobby,
  RunLobbyMemberProfile,
} from "./coop-types";
import {
  COOP_INVITE_MESSAGES,
} from "./coop-types";
import {
  computeReputation,
  getReputation,
  toPublic,
} from "./coop-reputation";
import {
  COOP_REP_PUBLIC_FRESH_MS,
  COOP_REP_SELF_FRESH_MS,
  type ReputationTier,
} from "./coop-reputation-types";
import { getTodayChallenge } from "./coop-daily";
import { captureShareCard, readShareCard } from "./coop-share";
import {
  createMirror,
  deleteMirror,
  listMirrors,
  type CreateMirrorInput,
} from "./coop-mirror";
import {
  logRichPresenceIngest,
  planRichPresenceUpdate,
  type RichPresenceIngestBody,
} from "./coop-rich-presence";
import {
  acceptInvite,
  acceptJoinRequest,
  cancelInvite,
  cancelJoinRequest,
  closeLobby,
  createLobby,
  declineInvite,
  declineJoinRequest,
  endParty,
  endSession,
  getPartyForViewer,
  heartbeatPresence,
  joinLobbySeat,
  leaveParty,
  readPartyForUser,
  reAdvertiseParty,
  updatePartyMemberStatus,
  isPresenceActive,
  listLobbies,
  listPresence,
  pruneInbox,
  pruneOutbox,
  pruneUserJoinRequests,
  pruneLobbyJoinRequests,
  requestToJoinLobby,
  sendInvite,
  signalParty,
  updateLobby,
  upsertPresenceV2,
  type CreateLobbyBody,
  type HeartbeatResult,
  type PresenceUpsertBody,
  type SendInviteBody,
  type UpdateLobbyBody,
} from "./coop-engine";
import {
  COOP_INACTIVE_HIDE_S,
  getActiveLobbyIdForHost,
  readLobby,
  readPresence,
  readSession,
} from "./coop-store";
import { recommendMatches } from "./coop-recommendations";
import { checkAndConsume, clientIP, hashID } from "./ratelimit";
import { requireSession } from "./auth";
import { getSessionProfile } from "./presence";
import {
  ingestModSnapshot,
  listLiveRuns,
  readHostLatestRunId,
  readLiveRun,
} from "./coop-mod-stream";
import { runCoach } from "./coop-coach";
import {
  createTournament,
  listTournaments,
  readTournament,
  registerTeam,
  reportMatch,
  seedBracket,
} from "./coop-tournament";
import {
  listRaceGhosts,
  readRaceGhost,
  submitRaceGhost,
  todayDateKey,
} from "./coop-race";
import { generateClipBundle } from "./coop-clip";
import {
  addIntentWindow,
  countScheduledPlayers,
  findIntentMatches,
  readIntent,
  removeIntentWindow,
  upcomingIntents,
  type IntentWindowInput,
} from "./coop-intents";

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

  // PUBLIC room browser — the Roblox model: anyone can window-shop the
  // live rooms (real titles, real people in the seats) without an
  // account; sign-in is only demanded at the moment they click Join.
  // Payload is sanitized by `toPublicRoom` (no Steam IDs, no discord
  // handles). Short edge cache keeps a link-share spike to ~4 KV reads
  // a minute.
  if (method === "GET" && pathname === "/coop/rooms") {
    const limited = await rateLimit(env, req, "coop-rooms-public", 30, 60);
    if (limited) return limited;
    const [allPresence, allLobbies] = await Promise.all([
      listPresence(env),
      listLobbies(env),
    ]);
    const now = Date.now();
    const visible = allLobbies.filter((l) => lobbyVisibleOnBoard(l, allPresence, now));
    // Fullest-first, then newest — a room with people already in it is
    // the strongest possible "this place is alive" signal for a guest.
    visible.sort((a, b) => {
      const fa = a.acceptedMemberSteamIds?.length ?? 1;
      const fb = b.acceptedMemberSteamIds?.length ?? 1;
      if (fb !== fa) return fb - fa;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
    const rooms = visible.slice(0, 50).map((l) => toPublicRoom(l, allPresence));
    const playersOnlineCount = allPresence.filter((p) => isPresenceActive(p, now)).length;
    const lookingNowCount = allPresence.filter(
      (p) => isPresenceActive(p, now) && p.status === "looking",
    ).length;
    return json(
      {
        ok: true,
        rooms,
        roomsTotalCount: visible.length,
        playersOnlineCount,
        lookingNowCount,
        serverTime: new Date(now).toISOString(),
      },
      { headers: { "cache-control": "public, max-age=15" } },
    );
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

  // ----- Scheduled play intents -----
  //
  // The async half of matchmaking. Lobbies answer "who is here right now";
  // intents answer "who plans to be here later", which is the only question
  // that can be answered at all when two players are never online together.
  // See coop-intents.ts for the reasoning.

  // Public: the upcoming schedule, sanitized. This is what a signed-out
  // visitor (or anyone browsing at 4am) sees instead of an empty board.
  if (method === "GET" && pathname === "/coop/intents/upcoming") {
    const limited = await rateLimit(env, req, "coop-intents-public", 30, 60);
    if (limited) return limited;
    const slots = await upcomingIntents(env);
    return json(
      { ok: true, slots, scheduledPlayers: await countScheduledPlayers(env) },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  }

  if (method === "GET" && pathname === "/coop/intents") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const [intent, matches] = await Promise.all([
      readIntent(env, auth.steamID),
      findIntentMatches(env, auth.steamID),
    ]);
    return json({ ok: true, intent, matches });
  }

  if (method === "POST" && pathname === "/coop/intents") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    // Scheduling is a deliberate, low-frequency action. A cap this tight also
    // protects the KV write budget from a client stuck in a retry loop.
    const limited = await rateLimit(env, req, "coop-intents-write", 20, 60 * 60);
    if (limited) return limited;
    const body = (await readJson(req)) as IntentWindowInput | null;
    if (!body) return errResp(400, "bad_body", "Expected a JSON window.");
    const result = await addIntentWindow(env, auth.steamID, body);
    if (!result.ok) return errResp(400, result.error, result.message);
    const matches = await findIntentMatches(env, auth.steamID);
    return json({ ok: true, intent: result.value, matches });
  }

  if (method === "DELETE" && pathname.startsWith("/coop/intents/")) {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const windowId = pathname
      .slice("/coop/intents/".length)
      .replace(/[^0-9a-f]/gi, "")
      .slice(0, 32);
    if (!windowId) return errResp(400, "invalid_window", "Missing window id.");
    const result = await removeIntentWindow(env, auth.steamID, windowId);
    if (!result.ok) return errResp(404, result.error, result.message);
    return json({ ok: true, intent: result.value });
  }

  // ----- Verified Co-op Reputation (v0.11.0+) -----
  // Spec: docs/coop-reputation-spec.md
  if (method === "GET" && pathname === "/coop/reputation/me") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const limited = await rateLimit(env, req, "coop-rep-self-read", 30, 60);
    if (limited) return limited;
    const rep = await computeReputation(env, auth.steamID);
    return json({ ok: true, reputation: rep });
  }
  if (method === "GET" && pathname.startsWith("/coop/reputation/")) {
    const sidRaw = pathname.slice("/coop/reputation/".length);
    const steamID = sidRaw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 64);
    if (!steamID) {
      return json({ ok: false, error: "invalid_steam_id" }, { status: 400 });
    }
    const limited = await rateLimit(env, req, "coop-rep-read", 60, 60);
    if (limited) return limited;
    const rep = await getReputation(env, steamID, { freshMs: COOP_REP_PUBLIC_FRESH_MS });
    if (!rep) {
      return json({ ok: false, error: "unavailable" }, { status: 503 });
    }
    const cacheSeconds = Math.max(15, Math.floor(COOP_REP_PUBLIC_FRESH_MS / 1000));
    return json(
      { ok: true, reputation: toPublic(rep) },
      { headers: { "cache-control": `public, max-age=${cacheSeconds}` } },
    );
  }
  // ----- Post-run Shared Report (v0.11.0+) -----
  // Spec: docs/coop-post-run-shared-report-spec.md
  if (method === "POST" && pathname === "/coop/share/from-party") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const limited = await rateLimit(env, req, "coop-share-write", 10, 60);
    if (limited) return limited;
    const body = (await readJson(req)) as {
      partyId?: unknown;
      caption?: unknown;
    } | null;
    if (!body) return json({ ok: false, error: "bad_body" }, { status: 400 });
    const result = await captureShareCard(env, auth.steamID, body);
    if (!result.ok) {
      return json({ ok: false, error: result.error }, { status: result.status });
    }
    return json({ ok: true, shareId: result.shareId });
  }
  if (method === "GET" && pathname.startsWith("/coop/share/")) {
    const shareId = pathname.slice("/coop/share/".length);
    const limited = await rateLimit(env, req, "coop-share-read", 120, 60);
    if (limited) return limited;
    const card = await readShareCard(env, shareId);
    if (!card) return json({ ok: false, error: "not_found" }, { status: 404 });
    return json(
      { ok: true, card },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  }

  // ----- Steam Rich Presence ingest (v0.11.0+) -----
  // Spec: docs/coop-steam-rich-presence-spec.md
  // Web side only here; the native helper lives under
  // VaultApp/App/Helpers/SteamRichPresence/ (separate sprint).
  if (method === "POST" && pathname === "/coop/rich-presence/ingest") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const limited = await rateLimit(env, req, "coop-richp-write", 30, 60);
    if (limited) return limited;
    const body = ((await readJson(req)) ?? {}) as RichPresenceIngestBody;
    const plan = planRichPresenceUpdate(body);
    // Log every ingest for "is the helper reporting?" debugging.
    void logRichPresenceIngest(env, auth.steamID, body, plan);
    // The presence write itself reuses the existing
    // POST /coop/heartbeat surface — the helper is encouraged to call
    // /coop/heartbeat directly with the computed status. We return the
    // computed plan so the helper knows what to send. Keeping the
    // presence write out of this route keeps it a single
    // responsibility: validate + plan.
    return json({ ok: true, plan });
  }

  // ----- Daily Co-op Challenge (v0.11.0+) -----
  // Spec: docs/coop-daily-challenge-spec.md
  if (method === "GET" && pathname === "/coop/daily-challenge") {
    const limited = await rateLimit(env, req, "coop-daily-read", 120, 60);
    if (limited) return limited;
    const challenge = await getTodayChallenge(env);
    return json(
      { ok: true, challenge },
      { headers: { "cache-control": "public, max-age=300" } },
    );
  }

  // ----- Discord LFG Mirror (v0.12.0+) -----
  //
  // Bridges an existing Discord LFG channel into SpireVault's lobby
  // surface as ephemeral, read-only "via Discord" cards. The bot
  // hits POST /coop/mirror with a shared secret + message metadata
  // from an approved channel; the frontend reads GET /coop/mirrors
  // every poll. Mirrors expire after 30 min by default.
  //
  // Auth model:
  //
  //   - POST /coop/mirror requires header `X-Bot-Secret: <secret>`
  //     equal to env.DISCORD_BOT_SECRET. This is the minimum trust
  //     boundary so a random script can't flood the mirror namespace.
  //     A future revision will replace this with the Ed25519 verify
  //     on `/discord/interactions` (Discord-native), but the shared-
  //     secret path stays because slash-command UX is friction-y
  //     compared to a Discord.js bot that auto-mirrors approved
  //     channels.
  //
  //   - GET /coop/mirrors is PUBLIC (no auth). Mirror data is
  //     intentionally observable so signed-out visitors landing on
  //     the empty lobby page see real Discord activity and bounce
  //     less. The data itself contains nothing private — it's the
  //     same info a logged-in Discord user could see in the channel.
  //
  //   - DELETE /coop/mirror/:id requires `X-Bot-Secret` (same trust
  //     boundary as create). The bot calls this when the source
  //     Discord message is deleted upstream.
  if (method === "POST" && pathname === "/coop/mirror") {
    const expected = env.DISCORD_BOT_SECRET;
    const provided = req.headers.get("x-bot-secret");
    if (!expected || provided !== expected) {
      return errResp(401, "unauthorized", "Bot secret missing or invalid.");
    }
    const limited = await rateLimit(env, req, "coop-mirror-write", 120, 60);
    if (limited) return limited;
    const body = (await readJson(req)) as Partial<CreateMirrorInput> | null;
    if (!body || typeof body !== "object") {
      return errResp(400, "invalid_body", "Missing body.");
    }
    const required: (keyof CreateMirrorInput)[] = [
      "discordMessageId",
      "discordChannelId",
      "discordChannelName",
      "discordGuildId",
      "discordGuildName",
      "discordJumpUrl",
      "authorName",
      "rawMessage",
    ];
    for (const k of required) {
      if (typeof body[k] !== "string" || (body[k] as string).length === 0) {
        return errResp(400, "invalid_body", `Missing or empty: ${k}`);
      }
    }
    const lobby = await createMirror(env, body as CreateMirrorInput);
    return json({ ok: true, mirror: lobby });
  }

  if (method === "GET" && pathname === "/coop/mirrors") {
    const limited = await rateLimit(env, req, "coop-mirror-read", 120, 60);
    if (limited) return limited;
    const mirrors = await listMirrors(env);
    return json(
      { ok: true, mirrors },
      // Short cache so signed-out visitors hitting the empty state
      // get fresh-ish data without thrashing the worker on hot pages.
      { headers: { "cache-control": "public, max-age=15" } },
    );
  }

  if (method === "DELETE" && pathname.startsWith("/coop/mirror/")) {
    const expected = env.DISCORD_BOT_SECRET;
    const provided = req.headers.get("x-bot-secret");
    if (!expected || provided !== expected) {
      return errResp(401, "unauthorized", "Bot secret missing or invalid.");
    }
    const mirrorId = pathname.slice("/coop/mirror/".length);
    if (!mirrorId || mirrorId.length < 4 || mirrorId.length > 64) {
      return errResp(400, "invalid_id", "Invalid mirror id.");
    }
    await deleteMirror(env, mirrorId);
    return json({ ok: true });
  }

  // Stop TypeScript noticing the unused COOP_REP_SELF_FRESH_MS import in
  // build modes that strip dead code aggressively. The constant is the
  // canonical freshness window for the /me endpoint and is exported here
  // so any cross-module consumers (e.g. future warmup workers) can read it
  // without a duplicate definition.
  void COOP_REP_SELF_FRESH_MS;

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
    const { presence, forceStatus } = r.value as HeartbeatResult;
    const body: Record<string, unknown> = { ok: true, presence };
    if (forceStatus !== undefined) body.forceStatus = forceStatus;
    return json(body);
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
    await announceLobbyToDiscord(env, r.value);
    return json({ ok: true, lobby: r.value });
  }

  // Per-lobby routes
  const lobbyMatch = pathname.match(
    /^\/coop\/lobbies\/([0-9a-f]{32})(?:\/(close|request|join-seat|accept|decline|cancel-request))?$/,
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
      const body = ((await readJson(req)) || {}) as { selectedCharacter?: string } | null;
      const r = await requestToJoinLobby(env, auth.steamID, lobbyId, body || {});
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, request: r.value });
    }
    if (subroute === "join-seat" && method === "POST") {
      const body = ((await readJson(req)) || {}) as { selectedCharacter?: string } | null;
      const r = await joinLobbySeat(env, auth.steamID, lobbyId, body || {});
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({
        ok: true,
        lobby: r.value.lobby,
        party: r.value.party,
        partyId: r.value.partyId,
      });
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
        return json({
          ok: true,
          session: r.value.session,
          lobby: r.value.lobby,
          party: r.value.party,
          partyId: r.value.party.partyId,
        });
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

  // Party room
  const partyGetMatch = pathname.match(/^\/coop\/parties\/([0-9a-f]{32})$/);
  if (partyGetMatch && method === "GET") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const r = await getPartyForViewer(env, auth.steamID, partyGetMatch[1]!);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({
      ok: true,
      party: r.value.party,
      // Surface the linked lobby (or `lobbyMissing: true`) so the
      // Party Hub can render a Re-advertise CTA when the lobby has
      // expired off the public board mid-party. Frontend keys off
      // `lobbyMissing` only — the lobby payload is informational.
      lobby: r.value.lobby,
      lobbyMissing: r.value.lobbyMissing,
    });
  }

  // Host-only Re-advertise. Mints a fresh lobby record from the
  // party's snapshotted metadata when the original 35-min lobby has
  // expired off the board while the party (4 h TTL) is still alive.
  const partyReAdvertiseMatch = pathname.match(
    /^\/coop\/parties\/([0-9a-f]{32})\/re-advertise$/,
  );
  if (partyReAdvertiseMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    // Tighter rate limit on re-advertise specifically (vs the
    // generic 60/60s coop-write bucket): the action mutates the
    // public board and we don't want a host accidentally double-
    // tapping the button into duplicate listings. 5 attempts per
    // minute is plenty for the legitimate "I came back, my room
    // expired, re-list it" flow.
    const rl = await rateLimit(env, req, "coop-re-advertise", 5, 60);
    if (rl) return rl;
    const r = await reAdvertiseParty(env, auth.steamID, partyReAdvertiseMatch[1]!);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, party: r.value.party, lobby: r.value.lobby });
  }

  const partyActionMatch = pathname.match(
    /^\/coop\/parties\/([0-9a-f]{32})\/(status|leave|end|signal)$/,
  );
  if (partyActionMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const partyId = partyActionMatch[1]!;
    const action = partyActionMatch[2];
    if (action === "signal") {
      // Tighter bucket than the generic coop-write: signals are a
      // tap-to-send surface, so 20/30s per user is plenty for genuine
      // back-and-forth while still capping spam (the preset-only model
      // already removes any harassment vector).
      const rlSig = await rateLimit(env, req, "coop-signal", 20, 30);
      if (rlSig) return rlSig;
      const body = (await readJson(req)) as { signal?: string } | null;
      const r = await signalParty(env, auth.steamID, partyId, body?.signal);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, party: r.value });
    }
    const rl = await rateLimit(env, req, "coop-write", 60, 60);
    if (rl) return rl;
    if (action === "status") {
      const body = (await readJson(req)) as { status?: string; selectedCharacter?: string } | null;
      const r = await updatePartyMemberStatus(
        env,
        auth.steamID,
        partyId,
        body?.status,
        body?.selectedCharacter,
      );
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, party: r.value });
    }
    if (action === "leave") {
      const r = await leaveParty(env, auth.steamID, partyId);
      if (!r.ok) return errResp(r.status, r.error, r.message);
      return json({ ok: true, ...r.value });
    }
    const r = await endParty(env, auth.steamID, partyId);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, ...r.value });
  }

  // ────────────────────────────────────────────────────────────────
  // Companion Mod stream — POST /coop/mod/ingest
  //
  // The SpireVault Companion mod posts here every ~2s with the
  // latest RunLiveSnapshot. Auth: a real Steam session (cookie or
  // bearer) AND, optionally, the COMPANION_MOD_SECRET header for
  // defence-in-depth. The bound steamID off the session is the
  // authoritative host id; the body's hostSteamId must match.
  // ────────────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/coop/mod/ingest") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    // Optional second factor — a token shared with mod builds. Lets
    // operators kill-switch all live ingest if a session token leaks
    // by rotating the secret without rotating every user's session.
    const expectedSecret = env.COMPANION_MOD_SECRET;
    if (expectedSecret) {
      const provided = req.headers.get("x-mod-token") ?? "";
      if (provided !== expectedSecret) {
        return errResp(401, "unauthorized", "Companion mod secret mismatch.");
      }
    }
    // 60 writes/min/IP — generous for one mod (~30/min cadence).
    const rl = await rateLimit(env, req, "coop-mod-ingest", 60, 60);
    if (rl) return rl;
    const body = await readJson(req);
    const r = await ingestModSnapshot(env, auth.steamID, body);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ...r.result });
  }

  // GET /coop/mod/runs — public list of currently-live runs.
  if (method === "GET" && pathname === "/coop/mod/runs") {
    const rl = await rateLimit(env, req, "coop-mod-list", 120, 60);
    if (rl) return rl;
    const runs = await listLiveRuns(env);
    return json(
      { ok: true, runs },
      { headers: { "cache-control": "public, max-age=10" } },
    );
  }

  // GET /coop/mod/run/:runId — public read of a live run snapshot.
  // Used by the spectator surface, OBS overlay, Coach v2.
  const liveRunMatch = pathname.match(/^\/coop\/mod\/run\/([A-Z0-9_-]{6,40})$/i);
  if (liveRunMatch && method === "GET") {
    const rl = await rateLimit(env, req, "coop-mod-read", 240, 60);
    if (rl) return rl;
    const snap = await readLiveRun(env, liveRunMatch[1]!);
    if (!snap) return errResp(404, "not_found", "No live run for that id.");
    return json(
      { ok: true, run: snap },
      // Short edge cache — every spectator sharing a colo collapses
      // onto one upstream read. With 50 viewers we typically pay 5-10
      // KV reads/min for the whole run.
      { headers: { "cache-control": "public, max-age=2" } },
    );
  }

  // GET /coop/mod/host/:steamId — latest run for a given host. Lets
  // a spectator URL like /watch/:steamId resolve to a runId without
  // needing the mod's local id first.
  const hostLatestMatch = pathname.match(/^\/coop\/mod\/host\/(\d{17})$/);
  if (hostLatestMatch && method === "GET") {
    const rl = await rateLimit(env, req, "coop-mod-host-read", 120, 60);
    if (rl) return rl;
    const runId = await readHostLatestRunId(env, hostLatestMatch[1]!);
    if (!runId) return errResp(404, "not_found", "No live run for that host.");
    return json({ ok: true, runId });
  }

  // GET /coop/mod/clips/:runId — auto-generated post-run highlight
  // bundle (built from the closed snapshot). 30-min replay window.
  const clipMatch = pathname.match(/^\/coop\/mod\/clips\/([A-Z0-9_-]{6,40})$/i);
  if (clipMatch && method === "GET") {
    const rl = await rateLimit(env, req, "coop-mod-clip-read", 120, 60);
    if (rl) return rl;
    const bundle = await generateClipBundle(env, clipMatch[1]!);
    if (!bundle) return errResp(404, "not_found", "No closed run for that id.");
    return json(
      { ok: true, bundle },
      { headers: { "cache-control": "public, max-age=30" } },
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Coach — POST /coop/coach/analyze
  // ────────────────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/coop/coach/analyze") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    // Coach is expensive (LLM tokens). Tight per-user cap.
    const rlPerUser = await checkAndConsume(env, {
      bucket: "coop-coach",
      id: auth.steamID,
      max: 10,
      windowSeconds: 60 * 60,
    });
    if (!rlPerUser.allowed) {
      return errResp(429, "rate_limited", `Coach limit hit. Try again in ${rlPerUser.retryAfterSec}s.`);
    }
    const body = (await readJson(req)) as
      | { mode?: string; runId?: string; imageRef?: string; question?: string }
      | null;
    if (!body) return errResp(400, "invalid_body", "Missing JSON body.");
    const mode =
      body.mode === "snapshot" || body.mode === "screenshot" || body.mode === "narrative"
        ? body.mode
        : "snapshot";
    const result = await runCoach(env, {
      mode,
      steamId: auth.steamID,
      runId: typeof body.runId === "string" ? body.runId : undefined,
      imageRef: typeof body.imageRef === "string" ? body.imageRef : undefined,
      question: typeof body.question === "string" ? body.question.slice(0, 400) : undefined,
    });
    return json({ ok: true, analysis: result });
  }

  // ────────────────────────────────────────────────────────────────
  // Tournaments
  // ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/coop/tournaments") {
    const rl = await rateLimit(env, req, "coop-tournament-list", 60, 60);
    if (rl) return rl;
    const tournaments = await listTournaments(env);
    return json(
      { ok: true, tournaments },
      { headers: { "cache-control": "public, max-age=30" } },
    );
  }
  if (method === "POST" && pathname === "/coop/tournaments") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-tournament-create", 5, 60 * 60);
    if (rl) return rl;
    const profile = await getSessionProfile(env, auth.steamID);
    const body = (await readJson(req)) as Parameters<typeof createTournament>[3] | null;
    if (!body) return errResp(400, "invalid_body", "Missing body.");
    const r = await createTournament(env, auth.steamID, profile?.personaName ?? "Steam User", body);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, tournament: r.tournament });
  }
  const tournamentReadMatch = pathname.match(/^\/coop\/tournaments\/([a-z0-9-]{3,40})$/);
  if (tournamentReadMatch && method === "GET") {
    const rl = await rateLimit(env, req, "coop-tournament-read", 120, 60);
    if (rl) return rl;
    const t = await readTournament(env, tournamentReadMatch[1]!);
    if (!t) return errResp(404, "not_found", "Tournament not found.");
    return json(
      { ok: true, tournament: t },
      { headers: { "cache-control": "public, max-age=10" } },
    );
  }
  const tournamentRegisterMatch = pathname.match(
    /^\/coop\/tournaments\/([a-z0-9-]{3,40})\/register$/,
  );
  if (tournamentRegisterMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-tournament-write", 20, 60);
    if (rl) return rl;
    const t = await readTournament(env, tournamentRegisterMatch[1]!);
    if (!t) return errResp(404, "not_found", "Tournament not found.");
    const body = (await readJson(req)) as Parameters<typeof registerTeam>[3] | null;
    if (!body) return errResp(400, "invalid_body", "Missing body.");
    const r = await registerTeam(env, t.tournamentId, auth.steamID, body);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, tournament: r.tournament });
  }
  const tournamentSeedMatch = pathname.match(
    /^\/coop\/tournaments\/([a-z0-9-]{3,40})\/seed$/,
  );
  if (tournamentSeedMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-tournament-write", 20, 60);
    if (rl) return rl;
    const t = await readTournament(env, tournamentSeedMatch[1]!);
    if (!t) return errResp(404, "not_found", "Tournament not found.");
    const r = await seedBracket(env, t.tournamentId, auth.steamID);
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, tournament: r.tournament });
  }
  const tournamentReportMatch = pathname.match(
    /^\/coop\/tournaments\/([a-z0-9-]{3,40})\/report$/,
  );
  if (tournamentReportMatch && method === "POST") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-tournament-write", 60, 60);
    if (rl) return rl;
    const t = await readTournament(env, tournamentReportMatch[1]!);
    if (!t) return errResp(404, "not_found", "Tournament not found.");
    const body = (await readJson(req)) as
      | { round?: number; slot?: number; winnerTeamId?: string; score?: string }
      | null;
    if (!body || typeof body.round !== "number" || typeof body.slot !== "number" || typeof body.winnerTeamId !== "string") {
      return errResp(400, "invalid_body", "Need round, slot, winnerTeamId.");
    }
    const r = await reportMatch(env, t.tournamentId, auth.steamID, {
      round: body.round,
      slot: body.slot,
      winnerTeamId: body.winnerTeamId,
      score: body.score,
    });
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, tournament: r.tournament });
  }

  // ────────────────────────────────────────────────────────────────
  // Daily Race
  // ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/coop/race/today") {
    const rl = await rateLimit(env, req, "coop-race-list", 120, 60);
    if (rl) return rl;
    const dateKey = todayDateKey();
    const ghosts = await listRaceGhosts(env, dateKey);
    return json(
      { ok: true, dateKey, ghosts },
      { headers: { "cache-control": "public, max-age=30" } },
    );
  }
  const raceListMatch = pathname.match(/^\/coop\/race\/(\d{4}-\d{2}-\d{2})$/);
  if (raceListMatch && method === "GET") {
    const rl = await rateLimit(env, req, "coop-race-list", 120, 60);
    if (rl) return rl;
    const ghosts = await listRaceGhosts(env, raceListMatch[1]!);
    return json(
      { ok: true, dateKey: raceListMatch[1], ghosts },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  }
  const raceReadMatch = pathname.match(/^\/coop\/race\/(\d{4}-\d{2}-\d{2})\/([A-Z0-9_-]{6,40})$/i);
  if (raceReadMatch && method === "GET") {
    const rl = await rateLimit(env, req, "coop-race-read", 240, 60);
    if (rl) return rl;
    const ghost = await readRaceGhost(env, raceReadMatch[1]!, raceReadMatch[2]!);
    if (!ghost) return errResp(404, "not_found", "Ghost not found.");
    return json(
      { ok: true, ghost },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  }
  if (method === "POST" && pathname === "/coop/race/submit") {
    const auth = await requireSession(req, env);
    if (auth instanceof Response) return auth;
    const rl = await rateLimit(env, req, "coop-race-write", 30, 60 * 60);
    if (rl) return rl;
    const profile = await getSessionProfile(env, auth.steamID);
    const body = (await readJson(req)) as Parameters<typeof submitRaceGhost>[4] | null;
    if (!body) return errResp(400, "invalid_body", "Missing body.");
    const r = await submitRaceGhost(
      env,
      auth.steamID,
      profile?.personaName ?? "Steam User",
      profile?.avatarURL,
      body,
    );
    if (!r.ok) return errResp(r.status, r.error, r.message);
    return json({ ok: true, ghost: r.ghost });
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
  // Fallback: presence.currentLobbyId can lag after create/reconnect;
  // the by-host index is authoritative for open hosted runs.
  if (!myLobby) {
    const hostLobbyId = await getActiveLobbyIdForHost(env, steamID);
    if (hostLobbyId) {
      myLobby = await readLobby(env, hostLobbyId);
    }
  }
  if (myLobby && myLobby.status !== "open" && myLobby.status !== "full" && myLobby.status !== "pending") {
    myLobby = null;
  }
  const mySession = presence.currentSessionId
    ? await readSession(env, presence.currentSessionId)
    : null;
  const myParty = await readPartyForUser(env, steamID);

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
    // Host's own lobby is returned separately as `lobby`; the main board
    // merges it client-side so hosts still see Manage/Close on the board.
    if (l.hostSteamId === steamID) return false;
    return lobbyVisibleOnBoard(l, allPresence, now);
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

  // Verified-host bump — v0.11.x rank-transparency pass.
  //
  // The PRD ("Make the SpireVault rank/level/reputation system transparent
  // and motivating") promises joiners that "Verified hosts get pinned
  // higher — joiners trust them more and seats fill faster." This block
  // delivers that promise honestly: we look up the rep tier for every
  // real (non-House) host on the visible page, then add a tier-keyed
  // boost on top of the existing match score.
  //
  // Boost values are deliberately smaller than a "Strong match" delta
  // (Strong=100, Good=60), so a perfect-fit newcomer is NOT buried under
  // a Heart-Slayer with the wrong goal. A Trusted host with a Good match
  // (60+25=85) still loses to a newcomer with a Strong match (100+0=100),
  // but a Trusted Good match (85) beats a newcomer Good match (60). That
  // is the consequence we promise the joiner in the LevelBadge popover.
  //
  // KV reads here are cached for 5 minutes (`COOP_REP_PUBLIC_FRESH_MS`)
  // and bounded by the number of unique hosts on the visible board (≤
  // OPEN_LOBBIES_CAP=50). House lobbies skip the lookup — operator-hosted
  // synthetic Steam IDs have no rep blob and shouldn't be boosted.
  const realHostSids = Array.from(
    new Set(
      openLobbiesAll
        .filter((l) => !l.isHouseLobby && l.hostSteamId)
        .map((l) => l.hostSteamId),
    ),
  );
  const hostTier = new Map<string, ReputationTier>();
  await Promise.all(
    realHostSids.map(async (sid) => {
      try {
        const blob = await getReputation(env, sid, { freshMs: COOP_REP_PUBLIC_FRESH_MS });
        if (blob?.tier) hostTier.set(sid, blob.tier);
      } catch {
        /* swallow — sort falls through to the existing relevance score */
      }
    }),
  );
  const tierBoost = (sid: string): number => {
    const t = hostTier.get(sid);
    if (t === "ascended") return 50;
    if (t === "veteran")  return 35;
    if (t === "trusted")  return 25;
    return 0;
  };
  openLobbiesAll.sort((a, b) => {
    const sa = scoreFor(a.hostSteamId) + tierBoost(a.hostSteamId);
    const sb = scoreFor(b.hostSteamId) + tierBoost(b.hostSteamId);
    if (sb !== sa) return sb - sa;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  // Cap the open-lobbies wire payload. At 8000 users the lobby count
  // can grow into the hundreds; the client browses with sort+filter
  // so anything past the top 50 by relevance is never seen. Future:
  // a "show more" cursor for power users. For now the cap is the
  // pragmatic shield against ballooning bundle size.
  const OPEN_LOBBIES_CAP = 50;
  // Hydrate persona/avatar snapshots onto every seat so the board can
  // render Roblox-style filled-seat rows (you see WHO is in a room, not
  // just "2 of 4"). Presence rows are already in memory — zero extra KV.
  const openLobbies = openLobbiesAll
    .slice(0, OPEN_LOBBIES_CAP)
    .map((l) => withMemberProfiles(l, allPresence));
  const openLobbiesTotalCount = openLobbiesAll.length;
  if (myLobby) myLobby = withMemberProfiles(myLobby, allPresence);

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

  // Scheduled intents. Fetched together so a single poll carries both halves
  // of matchmaking — who is here now, and who plans to be here later.
  // `listIntents` inside the matcher is a single index read plus one read per
  // scheduled user, and it prunes its own index, so this costs about as much
  // as one extra lobby.
  const [myIntent, intentMatches, scheduledPlayersCount] = await Promise.all([
    readIntent(env, steamID),
    findIntentMatches(env, steamID),
    countScheduledPlayers(env),
  ]);

  return {
    presence,
    session: mySession,
    party: myParty,
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
    intentWindows: myIntent?.windows ?? [],
    intentMatches,
    scheduledPlayersCount,
    serverTime: new Date(now).toISOString(),
    // Feature flags. The Worker can flip `COOP_LOBBY_BETA_KILL=1` in
    // env at runtime (or via wrangler secret) and the next /coop/state
    // poll forces every client back to Classic. Empty object when no
    // flags are active so the wire shape stays stable.
    flags: betaFlagsFromEnv(env),
  };
}

/**
 * Shared board-visibility predicate for open lobbies — used by both the
 * authenticated `/coop/state` board and the public `/coop/rooms`
 * browser so the two surfaces can never drift apart on what counts as
 * a "live" room. (The state board additionally excludes the caller's
 * own lobby before calling this.)
 */
function lobbyVisibleOnBoard(
  l: RunLobby,
  allPresence: CoopPresence[],
  now: number,
): boolean {
  if (l.status !== "open" && l.status !== "full") return false;
  // SpireVault House lobbies are ambient operator-hosted rooms with
  // a synthetic Steam ID — no real human heartbeats, so the
  // host-presence freshness check below would unconditionally hide
  // them. The renewer (`coop-house-lobbies.ts`) is the authority on
  // whether a House lobby is live; if `lobby.isHouseLobby` is true
  // and the lobby's own `expiresAt` is still in the future
  // (`listLobbies` already filtered expired rows out), it stays on
  // the board. See module doc on `runHouseLobbyRenewer` for the
  // lifecycle that backs this bypass.
  if (l.isHouseLobby) return true;
  const host = allPresence.find((p) => p.steamId === l.hostSteamId);
  if (!host) return false;
  if (!isPresenceActive(host, now)) return false;
  // "paired" hosts are already in another live session — drop them.
  if (host.status === "paired") return false;
  // For "offline" we still drop. For "afk" we now SHOW the lobby as long
  // as the host's heartbeat is fresh. Rationale: Steam Invisible / Offline
  // / private-profile users get personastate=0 from the Web API and the
  // heartbeat handler used to auto-flip them to AFK. Their lobby still
  // exists, they're still actively at the keyboard (heartbeat is firing
  // every 30s while the tab is visible), but the prior filter hid them
  // from everyone else. With the matching fix in heartbeatPresence (host
  // of an open lobby cannot be auto-AFK'd), the only remaining way to
  // be "afk" while hosting is to have manually toggled the status pill.
  // Even in that case, a fresh heartbeat means the host is at the
  // keyboard and could respond — show the lobby but the client UI
  // surfaces an "Idle host" hint.
  if (host.status === "offline") return false;
  return true;
}

/**
 * Persona/avatar snapshot for every accepted seat, host first. Members
 * are resolved from the in-memory presence list (every member signed in
 * to join, so a presence row exists in the common case; a missing row
 * degrades to an avatar-less seat, never an error).
 */
function memberProfilesFor(
  l: RunLobby,
  allPresence: CoopPresence[],
): RunLobbyMemberProfile[] {
  const accepted =
    l.acceptedMemberSteamIds && l.acceptedMemberSteamIds.length > 0
      ? l.acceptedMemberSteamIds
      : l.memberSteamIds && l.memberSteamIds.length > 0
        ? l.memberSteamIds
        : [l.hostSteamId];
  const ordered = [
    l.hostSteamId,
    ...accepted.filter((sid) => sid && sid !== l.hostSteamId),
  ].filter(Boolean);
  return ordered.map((sid) => {
    if (sid === l.hostSteamId) {
      return {
        steamId: sid,
        personaName: l.hostPersonaName,
        avatarUrl: l.hostAvatarUrl,
        isHost: true,
      };
    }
    const p = allPresence.find((x) => x.steamId === sid);
    return { steamId: sid, personaName: p?.personaName, avatarUrl: p?.avatarUrl };
  });
}

function withMemberProfiles(l: RunLobby, allPresence: CoopPresence[]): RunLobby {
  return { ...l, memberProfiles: memberProfilesFor(l, allPresence) };
}

/** Strip a lobby down to the guest-safe shape (see `PublicCoopRoom`). */
function toPublicRoom(l: RunLobby, allPresence: CoopPresence[]): PublicCoopRoom {
  const profiles = memberProfilesFor(l, allPresence).map((m) => ({
    personaName: m.personaName,
    avatarUrl: m.avatarUrl,
    ...(m.isHost ? { isHost: true } : {}),
  }));
  return {
    lobbyId: l.lobbyId,
    title: l.title,
    mode: l.mode,
    goal: l.goal,
    // Mirror the client's `lobbySizeOf` default (4) so guest cards and
    // signed-in cards never disagree on seat counts for the same room.
    lobbySize: l.lobbySize === 2 || l.lobbySize === 3 || l.lobbySize === 4 ? l.lobbySize : 4,
    seatsFilled: profiles.length,
    status: l.status,
    ascensionMin: l.ascensionMin,
    ascensionMax: l.ascensionMax,
    voicePreference: l.voicePreference,
    preferredCharacters: l.preferredCharacters,
    approvalRequired: l.approvalRequired,
    note: typeof l.note === "string" ? l.note.slice(0, 280) : undefined,
    hostPersonaName: l.hostPersonaName,
    hostAvatarUrl: l.hostAvatarUrl,
    isHouseLobby: l.isHouseLobby,
    houseSlug: l.houseSlug,
    memberProfiles: profiles,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

// ---------- Discord room announce ----------

/** Same join base the client's "Copy Discord LFG Post" uses. */
const ROOM_JOIN_BASE = "https://spirevault.app/coop?room=";

/** Human labels for goals in the Discord announce (ids are wire-safe). */
const GOAL_ANNOUNCE_LABELS: Record<string, string> = {
  casual: "Casual climb",
  climb: "Standard climb",
  a20: "Max Ascension push",
  heart: "Heart hunt",
  teaching: "Teaching run",
  learning: "Learning run",
  daily: "Daily challenge",
  experimental: "Experimental build",
  any: "Any goal",
};

/**
 * Auto-announce a freshly hosted room to the community Discord.
 *
 * This is the piece that flips the funnel: instead of a host manually
 * copy-pasting an LFG post and begging in Discord (the exact loop the
 * lobby was supposed to kill), hosting a room in the app broadcasts to
 * Discord *for* them with a one-click join link back into the app.
 * Discord becomes an inbound channel, not the venue.
 *
 * Deliberately awaited with a hard 3s cap rather than fire-and-forget:
 * Workers may cancel dangling promises after the response is returned,
 * and a lost announce defeats the purpose. Worst case, hosting a room
 * takes 3s longer once — an acceptable trade for guaranteed delivery.
 * Any failure (no webhook configured, Discord down, timeout) is
 * swallowed: room creation NEVER depends on Discord being up.
 */
async function announceLobbyToDiscord(env: Env, lobby: RunLobby): Promise<void> {
  const webhook = env.DISCORD_LFG_WEBHOOK_URL;
  if (!webhook || lobby.isHouseLobby) return;
  try {
    // Persona names are attacker-controlled text headed for Discord
    // markdown; strip the formatting/mention metacharacters. Combined
    // with allowed_mentions.parse=[] there is no ping or spoof vector.
    const clean = (s: string): string =>
      String(s || "").replace(/[*_`~|@#>\[\]()]/g, "").trim().slice(0, 48);
    const host = clean(lobby.hostPersonaName) || "A climber";
    const title = clean(lobby.title) || "Co-op room";
    const size = lobby.lobbySize === 2 || lobby.lobbySize === 3 ? lobby.lobbySize : 4;
    const goal = GOAL_ANNOUNCE_LABELS[lobby.goal] || "Co-op run";
    // The host modal encodes planned start into the note as
    // `[start=ISO]` or `[start=full]` — surface it as a Discord-native
    // relative timestamp so "starting in 20 minutes" reads correctly
    // in every reader's timezone.
    let startLine = "";
    const m = /\[start=([^\]]+)\]/.exec(lobby.note || "");
    if (m) {
      if (m[1] === "full") {
        startLine = "\nStarts as soon as the party fills.";
      } else {
        const t = Date.parse(m[1]!);
        if (Number.isFinite(t)) startLine = `\nStarts <t:${Math.floor(t / 1000)}:R>.`;
      }
    }
    const content =
      `🎮 **${host}** just opened a co-op room: **${title}**\n` +
      `${goal} · ${size} seats · join in one click, no setup:` +
      `${startLine}\n${ROOM_JOIN_BASE}${lobby.lobbyId}`;
    await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Never let Discord availability affect room creation.
  }
}

function betaFlagsFromEnv(env: Env): { coopLobbyBeta?: boolean; coopLobbyBetaKill?: boolean } | undefined {
  const flags: { coopLobbyBeta?: boolean; coopLobbyBetaKill?: boolean } = {};
  const killRaw = (env as unknown as Record<string, string | undefined>).COOP_LOBBY_BETA_KILL;
  if (killRaw === "1" || killRaw === "true") flags.coopLobbyBetaKill = true;
  const enableRaw = (env as unknown as Record<string, string | undefined>).COOP_LOBBY_BETA_ENABLED;
  if (enableRaw === "0" || enableRaw === "false") flags.coopLobbyBeta = false;
  if (enableRaw === "1" || enableRaw === "true")  flags.coopLobbyBeta = true;
  return Object.keys(flags).length ? flags : undefined;
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
