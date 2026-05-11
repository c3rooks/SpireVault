import type { Env } from "./types";
import type {
  CoopPresence,
  RunLobby,
  CoopInvite,
  JoinRequest,
  CoopSession,
} from "./coop-types";

/**
 * Storage primitives for the co-op matchmaking system.
 *
 * Why a dedicated module: every co-op KV key is prefixed `coop:` so it
 * never collides with the legacy `presence:roster`, `inbox:*`, `pairs:*`
 * keys. Centralizing key construction here means we can change the
 * layout (e.g. promote to a Durable Object) without combing through
 * every handler.
 *
 * Concurrency model:
 *   - KV is eventually consistent. We accept the inherent race window
 *     (sub-100ms) and protect ourselves with read-before-write guards
 *     in `coop-engine.ts`. The single-session-per-user invariant is
 *     enforced by writing the session AFTER reading both sides — if
 *     two accepts race, one wins and the other gets a 409 on its
 *     next read.
 *   - `*-index` keys keep us list-free. KV `list()` is the costly
 *     operation; we maintain explicit indexes that get pruned at
 *     read time using each entry's `expiresAt`.
 *   - Every blob has its own TTL so stale entries clean themselves up
 *     even when the index isn't refreshed.
 */

// ---------- Key prefixes (one source of truth) ----------

const PRESENCE_PREFIX = "coop:presence:";
const PRESENCE_INDEX_KEY = "coop:presence:index";

const LOBBY_PREFIX = "coop:lobby:";
const LOBBY_INDEX_KEY = "coop:lobby:index";
const LOBBY_BY_HOST_PREFIX = "coop:lobby:by-host:";
const LOBBY_JOINS_PREFIX = "coop:lobby-joins:";

const INVITE_PREFIX = "coop:invite:";
const INBOX_PREFIX = "coop:inbox:";
const OUTBOX_PREFIX = "coop:outbox:";

const JOIN_REQUEST_PREFIX = "coop:join:";
const USER_JOINS_PREFIX = "coop:user-joins:";

const SESSION_PREFIX = "coop:session:";
const SESSION_BY_USER_PREFIX = "coop:session-by-user:";

const DECLINE_COOLDOWN_PREFIX = "coop:decline:";

// ---------- TTLs (seconds) ----------

export const COOP_PRESENCE_TTL_S = 5 * 60;       // 5 minutes per entry
export const COOP_INDEX_TTL_S = 7 * 86400;       // index blobs live a week
export const COOP_LOBBY_TTL_S = 35 * 60;         // 30min + 5min grace
export const COOP_INVITE_TTL_S = 3 * 60;         // 3 minute invites
export const COOP_JOIN_REQUEST_TTL_S = 3 * 60;   // 3 minute join requests
export const COOP_SESSION_TTL_S = 4 * 60 * 60;   // 4 hour sessions
export const COOP_DECLINE_COOLDOWN_S = 10 * 60;  // 10 minute pair cooldown
export const COOP_INBOX_INDEX_TTL_S = 24 * 60 * 60;

export const COOP_STALE_GRACE_S = 90;            // 90s after expiresAt = stale
export const COOP_INACTIVE_HIDE_S = 180;         // 180s = hide from recs/feed

// ---------- ID helpers ----------

/** 16 bytes hex → 32-char id. Cryptographically random. */
export function newRandomId(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Generic JSON I/O ----------

async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.LOBBIES.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function putJSON<T>(
  env: Env,
  key: string,
  value: T,
  ttlSeconds?: number,
): Promise<void> {
  const opts = ttlSeconds && ttlSeconds > 60
    ? { expirationTtl: ttlSeconds }
    : undefined;
  await env.LOBBIES.put(key, JSON.stringify(value), opts);
}

async function del(env: Env, key: string): Promise<void> {
  try {
    await env.LOBBIES.delete(key);
  } catch {
    /* delete is best-effort; the entry's own TTL will eventually clear it */
  }
}

// ---------- Index helpers ----------

interface IdIndex {
  ids: string[];
  updatedAt: string;
}

async function readIndex(env: Env, key: string): Promise<string[]> {
  const blob = await getJSON<IdIndex>(env, key);
  if (!blob || !Array.isArray(blob.ids)) return [];
  return Array.from(new Set(blob.ids.filter((s) => typeof s === "string")));
}

async function writeIndex(
  env: Env,
  key: string,
  ids: string[],
  ttlSeconds: number,
): Promise<void> {
  const uniq = Array.from(new Set(ids.filter((s) => typeof s === "string")));
  // Cap absolute size at 1000 to keep the index from growing unbounded
  // in degenerate cases; the real cap is enforced by individual entry
  // TTLs and inline pruning.
  const capped = uniq.length > 1000 ? uniq.slice(-1000) : uniq;
  await putJSON<IdIndex>(
    env,
    key,
    { ids: capped, updatedAt: new Date().toISOString() },
    ttlSeconds,
  );
}

async function addToIndex(
  env: Env,
  key: string,
  id: string,
  ttlSeconds: number,
): Promise<void> {
  const ids = await readIndex(env, key);
  if (ids.includes(id)) return;
  ids.push(id);
  await writeIndex(env, key, ids, ttlSeconds);
}

async function removeFromIndex(
  env: Env,
  key: string,
  id: string,
  ttlSeconds: number,
): Promise<void> {
  const ids = await readIndex(env, key);
  const next = ids.filter((x) => x !== id);
  if (next.length === ids.length) return;
  await writeIndex(env, key, next, ttlSeconds);
}

// ---------- Presence ----------

export async function readPresence(
  env: Env,
  steamId: string,
): Promise<CoopPresence | null> {
  return getJSON<CoopPresence>(env, PRESENCE_PREFIX + steamId);
}

export async function writePresence(
  env: Env,
  presence: CoopPresence,
): Promise<void> {
  await putJSON(
    env,
    PRESENCE_PREFIX + presence.steamId,
    presence,
    COOP_PRESENCE_TTL_S,
  );
  await addToIndex(env, PRESENCE_INDEX_KEY, presence.steamId, COOP_INDEX_TTL_S);
}

export async function deletePresence(env: Env, steamId: string): Promise<void> {
  await del(env, PRESENCE_PREFIX + steamId);
  await removeFromIndex(env, PRESENCE_INDEX_KEY, steamId, COOP_INDEX_TTL_S);
}

/**
 * Read every active presence row. Returns ONLY rows whose blob is still
 * live in KV — entries pruned by TTL drop out automatically, but stale
 * (alive-blob-but-expired) entries are surfaced so callers can render
 * "last seen 4 min ago" if they choose. Use `pruneIndex: true` to
 * also evict dead ids from the index.
 */
export async function listPresence(
  env: Env,
  opts: { pruneIndex?: boolean } = {},
): Promise<CoopPresence[]> {
  const ids = await readIndex(env, PRESENCE_INDEX_KEY);
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readPresence(env, id)));
  const live: CoopPresence[] = [];
  const liveIds: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    if (row) {
      live.push(row);
      liveIds.push(ids[i]!);
    }
  }
  if (opts.pruneIndex && liveIds.length !== ids.length) {
    await writeIndex(env, PRESENCE_INDEX_KEY, liveIds, COOP_INDEX_TTL_S);
  }
  return live;
}

// ---------- Lobbies ----------

export async function readLobby(
  env: Env,
  lobbyId: string,
): Promise<RunLobby | null> {
  return getJSON<RunLobby>(env, LOBBY_PREFIX + lobbyId);
}

export async function writeLobby(env: Env, lobby: RunLobby): Promise<void> {
  await putJSON(env, LOBBY_PREFIX + lobby.lobbyId, lobby, COOP_LOBBY_TTL_S);
  await addToIndex(env, LOBBY_INDEX_KEY, lobby.lobbyId, COOP_INDEX_TTL_S);
  await putJSON(
    env,
    LOBBY_BY_HOST_PREFIX + lobby.hostSteamId,
    { lobbyId: lobby.lobbyId, updatedAt: lobby.updatedAt },
    COOP_LOBBY_TTL_S,
  );
}

export async function deleteLobby(env: Env, lobby: RunLobby): Promise<void> {
  await del(env, LOBBY_PREFIX + lobby.lobbyId);
  await del(env, LOBBY_BY_HOST_PREFIX + lobby.hostSteamId);
  await del(env, LOBBY_JOINS_PREFIX + lobby.lobbyId);
  await removeFromIndex(env, LOBBY_INDEX_KEY, lobby.lobbyId, COOP_INDEX_TTL_S);
}

export async function getActiveLobbyIdForHost(
  env: Env,
  hostSteamId: string,
): Promise<string | null> {
  const blob = await getJSON<{ lobbyId: string }>(
    env,
    LOBBY_BY_HOST_PREFIX + hostSteamId,
  );
  return blob?.lobbyId ?? null;
}

export async function listLobbies(env: Env): Promise<RunLobby[]> {
  const ids = await readIndex(env, LOBBY_INDEX_KEY);
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readLobby(env, id)));
  const live: RunLobby[] = [];
  const liveIds: string[] = [];
  const now = Date.now();
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const exp = Date.parse(row.expiresAt);
    if (Number.isFinite(exp) && exp + COOP_STALE_GRACE_S * 1000 < now) continue;
    if (row.status === "closed" || row.status === "expired") continue;
    live.push(row);
    liveIds.push(ids[i]!);
  }
  if (liveIds.length !== ids.length) {
    await writeIndex(env, LOBBY_INDEX_KEY, liveIds, COOP_INDEX_TTL_S);
  }
  return live;
}

// ---------- Invites ----------

export async function readInvite(
  env: Env,
  inviteId: string,
): Promise<CoopInvite | null> {
  return getJSON<CoopInvite>(env, INVITE_PREFIX + inviteId);
}

export async function writeInvite(env: Env, invite: CoopInvite): Promise<void> {
  await putJSON(env, INVITE_PREFIX + invite.inviteId, invite, COOP_INVITE_TTL_S);
}

export async function deleteInvite(env: Env, inviteId: string): Promise<void> {
  await del(env, INVITE_PREFIX + inviteId);
}

interface InboxIndex { inviteIds: string[]; updatedAt: string; }

export async function readInbox(env: Env, steamId: string): Promise<string[]> {
  const blob = await getJSON<InboxIndex>(env, INBOX_PREFIX + steamId);
  if (!blob || !Array.isArray(blob.inviteIds)) return [];
  return blob.inviteIds.filter((s) => typeof s === "string");
}

export async function writeInbox(
  env: Env,
  steamId: string,
  inviteIds: string[],
): Promise<void> {
  const uniq = Array.from(new Set(inviteIds));
  await putJSON<InboxIndex>(
    env,
    INBOX_PREFIX + steamId,
    { inviteIds: uniq, updatedAt: new Date().toISOString() },
    COOP_INBOX_INDEX_TTL_S,
  );
}

export async function readOutbox(env: Env, steamId: string): Promise<string[]> {
  const blob = await getJSON<InboxIndex>(env, OUTBOX_PREFIX + steamId);
  if (!blob || !Array.isArray(blob.inviteIds)) return [];
  return blob.inviteIds.filter((s) => typeof s === "string");
}

export async function writeOutbox(
  env: Env,
  steamId: string,
  inviteIds: string[],
): Promise<void> {
  const uniq = Array.from(new Set(inviteIds));
  await putJSON<InboxIndex>(
    env,
    OUTBOX_PREFIX + steamId,
    { inviteIds: uniq, updatedAt: new Date().toISOString() },
    COOP_INBOX_INDEX_TTL_S,
  );
}

// ---------- Join requests ----------

export async function readJoinRequest(
  env: Env,
  requestId: string,
): Promise<JoinRequest | null> {
  return getJSON<JoinRequest>(env, JOIN_REQUEST_PREFIX + requestId);
}

export async function writeJoinRequest(env: Env, req: JoinRequest): Promise<void> {
  await putJSON(
    env,
    JOIN_REQUEST_PREFIX + req.requestId,
    req,
    COOP_JOIN_REQUEST_TTL_S,
  );
}

export async function deleteJoinRequest(env: Env, requestId: string): Promise<void> {
  await del(env, JOIN_REQUEST_PREFIX + requestId);
}

interface JoinIndex { requestIds: string[]; updatedAt: string; }

export async function readLobbyJoinIds(
  env: Env,
  lobbyId: string,
): Promise<string[]> {
  const blob = await getJSON<JoinIndex>(env, LOBBY_JOINS_PREFIX + lobbyId);
  if (!blob || !Array.isArray(blob.requestIds)) return [];
  return blob.requestIds;
}

export async function writeLobbyJoinIds(
  env: Env,
  lobbyId: string,
  requestIds: string[],
): Promise<void> {
  const uniq = Array.from(new Set(requestIds));
  await putJSON<JoinIndex>(
    env,
    LOBBY_JOINS_PREFIX + lobbyId,
    { requestIds: uniq, updatedAt: new Date().toISOString() },
    COOP_LOBBY_TTL_S,
  );
}

export async function readUserJoinIds(
  env: Env,
  steamId: string,
): Promise<string[]> {
  const blob = await getJSON<JoinIndex>(env, USER_JOINS_PREFIX + steamId);
  if (!blob || !Array.isArray(blob.requestIds)) return [];
  return blob.requestIds;
}

export async function writeUserJoinIds(
  env: Env,
  steamId: string,
  requestIds: string[],
): Promise<void> {
  const uniq = Array.from(new Set(requestIds));
  await putJSON<JoinIndex>(
    env,
    USER_JOINS_PREFIX + steamId,
    { requestIds: uniq, updatedAt: new Date().toISOString() },
    COOP_INBOX_INDEX_TTL_S,
  );
}

// ---------- Sessions ----------

export async function readSession(
  env: Env,
  sessionId: string,
): Promise<CoopSession | null> {
  return getJSON<CoopSession>(env, SESSION_PREFIX + sessionId);
}

export async function writeSession(env: Env, session: CoopSession): Promise<void> {
  await putJSON(env, SESSION_PREFIX + session.sessionId, session, COOP_SESSION_TTL_S);
  for (const sid of session.playerSteamIds) {
    await putJSON(
      env,
      SESSION_BY_USER_PREFIX + sid,
      { sessionId: session.sessionId, status: session.status },
      COOP_SESSION_TTL_S,
    );
  }
}

export async function deleteSession(env: Env, session: CoopSession): Promise<void> {
  await del(env, SESSION_PREFIX + session.sessionId);
  for (const sid of session.playerSteamIds) {
    await del(env, SESSION_BY_USER_PREFIX + sid);
  }
}

export async function getActiveSessionIdForUser(
  env: Env,
  steamId: string,
): Promise<string | null> {
  const blob = await getJSON<{ sessionId: string; status: string }>(
    env,
    SESSION_BY_USER_PREFIX + steamId,
  );
  if (!blob) return null;
  if (blob.status !== "active") return null;
  return blob.sessionId;
}

// ---------- Decline cooldown ----------

export async function recordDecline(
  env: Env,
  fromSteamId: string,
  toSteamId: string,
): Promise<void> {
  const key = `${DECLINE_COOLDOWN_PREFIX}${fromSteamId}:${toSteamId}`;
  await putJSON(
    env,
    key,
    { at: new Date().toISOString() },
    COOP_DECLINE_COOLDOWN_S,
  );
}

export async function isUnderDeclineCooldown(
  env: Env,
  fromSteamId: string,
  toSteamId: string,
): Promise<boolean> {
  const key = `${DECLINE_COOLDOWN_PREFIX}${fromSteamId}:${toSteamId}`;
  const blob = await getJSON<{ at: string }>(env, key);
  return blob != null;
}
