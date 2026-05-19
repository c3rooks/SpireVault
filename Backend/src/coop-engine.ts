import type { Env } from "./types";
import {
  COOP_GOALS,
  COOP_INVITE_MESSAGES,
  COOP_PRESENCE_STATUSES,
  VOICE_PREFERENCES,
  type CoopGoal,
  type CoopInvite,
  type CoopPresence,
  type CoopPresenceStatus,
  type CoopParty,
  type CoopPartyMember,
  type CoopPartyMemberStatus,
  type CoopSession,
  type JoinRequest,
  type RunLobby,
  type RunLobbySize,
  type VoicePreference,
} from "./coop-types";
import {
  COOP_MAX_ASCENSION,
  lobbyCapacity,
  lobbyIsFull,
  normalizeRunLobby,
} from "./coop-lobby-utils";
import {
  COOP_INVITE_TTL_S,
  COOP_JOIN_REQUEST_TTL_S,
  COOP_LOBBY_TTL_S,
  COOP_PARTY_TTL_S,
  COOP_PRESENCE_TTL_S,
  COOP_SESSION_TTL_S,
  COOP_STALE_GRACE_S,
  deleteLobby,
  deleteParty,
  getActiveLobbyIdForHost,
  getActivePartyIdForUser,
  getActiveSessionIdForUser,
  getPartyIdForLobby,
  isUnderDeclineCooldown,
  listLobbies,
  listPresence,
  newRandomId,
  readInbox,
  readInvite,
  readJoinRequest,
  readLobby,
  readLobbyJoinIds,
  readOutbox,
  readParty,
  readPresence,
  readSession,
  readUserJoinIds,
  recordDecline,
  writeInbox,
  writeInvite,
  writeJoinRequest,
  writeLobby,
  writeLobbyJoinIds,
  writeOutbox,
  writeParty,
  writePresence,
  writeSession,
  writeUserJoinIds,
} from "./coop-store";
import { getSessionProfile } from "./presence";

const STS2_APP_ID = "2868840";

// ---------- Errors / result type ----------

export type CoopOk<T> = { ok: true; value: T };
export type CoopErr = { ok: false; status: number; error: string; message: string };
export type CoopResult<T> = CoopOk<T> | CoopErr;

function ok<T>(value: T): CoopOk<T> { return { ok: true, value }; }
function err(status: number, error: string, message: string): CoopErr {
  return { ok: false, status, error, message };
}

// ---------- Caps ----------

export const MAX_PENDING_OUTGOING_INVITES = 5;
export const MAX_PENDING_JOIN_REQUESTS = 5;
export const MAX_NOTE_LEN = 160;
export const MAX_TITLE_LEN = 80;
export const MAX_PREFERRED_CHARS = 6;
export const MAX_DISCORD_LEN = 40;

// ---------- Sanitizers / validators ----------

export function isValidSteamId(s: unknown): s is string {
  return typeof s === "string" && /^\d{17}$/.test(s);
}

export function sanitizeText(raw: unknown, maxLen: number): string {
  const s = String(raw ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/<[^>]*>/g, "") // strip any tag-shaped content
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, maxLen);
}

export function sanitizeOptionalText(
  raw: unknown,
  maxLen: number,
): string | undefined {
  const out = sanitizeText(raw, maxLen);
  return out.length > 0 ? out : undefined;
}

export function clampInt(
  raw: unknown,
  min: number,
  max: number,
): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}

function isValidGoal(g: unknown): g is CoopGoal {
  return typeof g === "string" && (COOP_GOALS as readonly string[]).includes(g);
}

function isValidStatus(s: unknown): s is CoopPresenceStatus {
  return (
    typeof s === "string" &&
    (COOP_PRESENCE_STATUSES as readonly string[]).includes(s)
  );
}

function isValidVoice(v: unknown): v is VoicePreference {
  return (
    typeof v === "string" &&
    (VOICE_PREFERENCES as readonly string[]).includes(v)
  );
}

export function sanitizePreferredCharacters(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((x) => typeof x === "string")
    .map((s) => sanitizeText(s, 32))
    .filter((s) => s.length > 0);
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_PREFERRED_CHARS);
}

export function sanitizeAscensionRange(
  rawMin: unknown,
  rawMax: unknown,
): { ascensionMin?: number; ascensionMax?: number } {
  let min = clampInt(rawMin, 0, COOP_MAX_ASCENSION);
  let max = clampInt(rawMax, 0, COOP_MAX_ASCENSION);
  if (min != null && max != null && min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return { ascensionMin: min, ascensionMax: max };
}

// ---------- Freshness ----------

export function isPresenceActive(p: CoopPresence, now: number = Date.now()): boolean {
  const exp = Date.parse(p.expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp + COOP_STALE_GRACE_S * 1000 > now;
}

// ---------- Presence ops ----------

export interface PresenceUpsertBody {
  status?: unknown;
  note?: unknown;
  discordHandle?: unknown;
  ascensionMin?: unknown;
  ascensionMax?: unknown;
  goal?: unknown;
  voicePreference?: unknown;
  preferredCharacters?: unknown;
  personaName?: unknown;
  avatarUrl?: unknown;
}

async function profileFor(
  env: Env,
  steamId: string,
): Promise<{ personaName: string; avatarUrl?: string }> {
  const p = await getSessionProfile(env, steamId);
  return {
    personaName: p?.personaName ?? "Steam User",
    avatarUrl: p?.avatarURL || undefined,
  };
}

async function fetchSteamPlayerInfo(
  env: Env,
  steamId: string,
): Promise<{ inSTS2: boolean; steamOnline: boolean }> {
  if (!env.STEAM_WEB_API_KEY) return { inSTS2: false, steamOnline: true };
  try {
    const url =
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
      `?key=${env.STEAM_WEB_API_KEY}&steamids=${steamId}`;
    const resp = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } } as RequestInit);
    if (!resp.ok) return { inSTS2: false, steamOnline: true };
    const data = (await resp.json()) as any;
    const players: any[] = data?.response?.players ?? [];
    const player = players.find((p: any) => String(p?.steamid) === steamId);
    if (!player) return { inSTS2: false, steamOnline: true };
    const inSTS2 = player?.gameid && String(player.gameid) === STS2_APP_ID;
    const steamOnline = Number(player.personastate) !== 0;
    return { inSTS2: !!inSTS2, steamOnline };
  } catch {
    return { inSTS2: false, steamOnline: true };
  }
}

export async function upsertPresenceV2(
  env: Env,
  steamId: string,
  body: PresenceUpsertBody,
): Promise<CoopResult<CoopPresence>> {
  const prev = await readPresence(env, steamId);
  const profile = await profileFor(env, steamId);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const status: CoopPresenceStatus = isValidStatus(body.status)
    ? body.status
    : prev?.status ?? "looking";

  const { ascensionMin, ascensionMax } = sanitizeAscensionRange(
    body.ascensionMin ?? prev?.ascensionMin,
    body.ascensionMax ?? prev?.ascensionMax,
  );

  const goal = isValidGoal(body.goal) ? body.goal : prev?.goal;
  const voicePreference = isValidVoice(body.voicePreference)
    ? body.voicePreference
    : prev?.voicePreference;

  const preferredCharacters =
    sanitizePreferredCharacters(body.preferredCharacters) ??
    prev?.preferredCharacters;

  const next: CoopPresence = {
    steamId,
    personaName: profile.personaName ?? prev?.personaName ?? "Steam User",
    avatarUrl: profile.avatarUrl ?? prev?.avatarUrl,
    steamProfileUrl: `https://steamcommunity.com/profiles/${steamId}`,
    status,
    note: sanitizeOptionalText(body.note ?? prev?.note, MAX_NOTE_LEN),
    discordHandle: sanitizeOptionalText(
      body.discordHandle ?? prev?.discordHandle,
      MAX_DISCORD_LEN,
    ),
    ascensionMin,
    ascensionMax,
    goal,
    voicePreference,
    preferredCharacters,
    currentLobbyId: prev?.currentLobbyId,
    currentSessionId: prev?.currentSessionId,
    // User explicitly set their status — clear the auto-set flag.
    statusAutoSet: false,
    lastHeartbeatAt: nowIso,
    expiresAt: new Date(now + COOP_PRESENCE_TTL_S * 1000).toISOString(),
    updatedAt: nowIso,
  };

  await writePresence(env, next);
  return ok(next);
}

export type HeartbeatResult = { presence: CoopPresence; forceStatus?: CoopPresenceStatus };

export async function heartbeatPresence(
  env: Env,
  steamId: string,
): Promise<CoopResult<HeartbeatResult>> {
  const [prev, profile, steamInfo] = await Promise.all([
    readPresence(env, steamId),
    profileFor(env, steamId),
    fetchSteamPlayerInfo(env, steamId),
  ]);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let status: CoopPresenceStatus = prev?.status ?? "looking";
  let statusAutoSet: boolean = prev?.statusAutoSet ?? false;
  let forceStatus: CoopPresenceStatus | undefined;

  // --- Steam-based auto-status logic ---
  // Priority 1: Steam offline → push to "afk" (skip if already afk/offline/paired)
  if (!steamInfo.steamOnline) {
    if (status !== "afk" && status !== "offline" && status !== "paired") {
      status = "afk";
      statusAutoSet = true;
      forceStatus = "afk";
    }
  // Priority 2: In STS2 while looking → auto-flip to "solo"
  } else if (steamInfo.inSTS2 && status === "looking") {
    status = "solo";
    statusAutoSet = true;
    forceStatus = "solo";
  // Priority 3: Left STS2 after server auto-set to "solo" → restore "looking"
  } else if (!steamInfo.inSTS2 && status === "solo" && statusAutoSet) {
    status = "looking";
    statusAutoSet = false;
    forceStatus = "looking";
  }

  const next: CoopPresence = {
    steamId,
    personaName: prev?.personaName ?? profile.personaName,
    avatarUrl: prev?.avatarUrl ?? profile.avatarUrl,
    steamProfileUrl:
      prev?.steamProfileUrl ?? `https://steamcommunity.com/profiles/${steamId}`,
    status,
    note: prev?.note,
    discordHandle: prev?.discordHandle,
    ascensionMin: prev?.ascensionMin,
    ascensionMax: prev?.ascensionMax,
    goal: prev?.goal,
    voicePreference: prev?.voicePreference,
    preferredCharacters: prev?.preferredCharacters,
    currentLobbyId: prev?.currentLobbyId,
    currentSessionId: prev?.currentSessionId,
    statusAutoSet,
    lastHeartbeatAt: nowIso,
    expiresAt: new Date(now + COOP_PRESENCE_TTL_S * 1000).toISOString(),
    updatedAt: nowIso,
  };
  await writePresence(env, next);

  // Refresh the host's lobby TTL if they own one.
  if (next.currentLobbyId) {
    const lobby = await readLobby(env, next.currentLobbyId);
    if (lobby && lobby.hostSteamId === steamId && lobby.status === "open") {
      lobby.updatedAt = nowIso;
      lobby.expiresAt = new Date(now + COOP_LOBBY_TTL_S * 1000).toISOString();
      await writeLobby(env, lobby);
    }
  }

  return ok({ presence: next, forceStatus });
}

// ---------- Helpers ----------

async function setPresenceField(
  env: Env,
  steamId: string,
  patch: Partial<CoopPresence>,
): Promise<void> {
  const prev = await readPresence(env, steamId);
  if (!prev) return;
  const now = Date.now();
  const next: CoopPresence = {
    ...prev,
    ...patch,
    updatedAt: new Date(now).toISOString(),
  };
  await writePresence(env, next);
}

async function pruneInbox(
  env: Env,
  steamId: string,
): Promise<CoopInvite[]> {
  const ids = await readInbox(env, steamId);
  const out: CoopInvite[] = [];
  const liveIds: string[] = [];
  for (const id of ids) {
    const inv = await readInvite(env, id);
    if (!inv) continue;
    if (inv.status !== "pending") continue;
    const exp = Date.parse(inv.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) continue;
    out.push(inv);
    liveIds.push(id);
  }
  if (liveIds.length !== ids.length) await writeInbox(env, steamId, liveIds);
  return out;
}

async function pruneOutbox(
  env: Env,
  steamId: string,
): Promise<CoopInvite[]> {
  const ids = await readOutbox(env, steamId);
  const out: CoopInvite[] = [];
  const liveIds: string[] = [];
  for (const id of ids) {
    const inv = await readInvite(env, id);
    if (!inv) continue;
    if (inv.status !== "pending") continue;
    const exp = Date.parse(inv.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) continue;
    out.push(inv);
    liveIds.push(id);
  }
  if (liveIds.length !== ids.length) await writeOutbox(env, steamId, liveIds);
  return out;
}

async function pruneLobbyJoinRequests(
  env: Env,
  lobbyId: string,
): Promise<JoinRequest[]> {
  const ids = await readLobbyJoinIds(env, lobbyId);
  const out: JoinRequest[] = [];
  const liveIds: string[] = [];
  for (const id of ids) {
    const r = await readJoinRequest(env, id);
    if (!r) continue;
    if (r.status !== "pending") continue;
    const exp = Date.parse(r.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) continue;
    out.push(r);
    liveIds.push(id);
  }
  if (liveIds.length !== ids.length) await writeLobbyJoinIds(env, lobbyId, liveIds);
  return out;
}

async function pruneUserJoinRequests(
  env: Env,
  steamId: string,
): Promise<JoinRequest[]> {
  const ids = await readUserJoinIds(env, steamId);
  const out: JoinRequest[] = [];
  const liveIds: string[] = [];
  for (const id of ids) {
    const r = await readJoinRequest(env, id);
    if (!r) continue;
    if (r.status !== "pending") continue;
    const exp = Date.parse(r.expiresAt);
    if (Number.isFinite(exp) && exp <= Date.now()) continue;
    out.push(r);
    liveIds.push(id);
  }
  if (liveIds.length !== ids.length) await writeUserJoinIds(env, steamId, liveIds);
  return out;
}

// ---------- Lobby ops ----------

export interface CreateLobbyBody {
  title?: unknown;
  goal?: unknown;
  mode?: unknown;
  lobbySize?: unknown;
  ascensionMin?: unknown;
  ascensionMax?: unknown;
  voicePreference?: unknown;
  preferredCharacters?: unknown;
  note?: unknown;
  discordHandle?: unknown;
}

export async function createLobby(
  env: Env,
  hostSteamId: string,
  body: CreateLobbyBody,
): Promise<CoopResult<RunLobby>> {
  if (await getActiveSessionIdForUser(env, hostSteamId)) {
    return err(409, "in_session", "You're already in a co-op session.");
  }
  if (await getActivePartyIdForUser(env, hostSteamId)) {
    return err(409, "in_party", "You're already in a Party Room.");
  }
  const existingLobbyId = await getActiveLobbyIdForHost(env, hostSteamId);
  if (existingLobbyId) {
    const existing = await readLobby(env, existingLobbyId);
    if (existing && existing.status === "open") {
      return err(409, "lobby_exists", "You already have an active lobby.");
    }
  }

  const title = sanitizeText(body.title, MAX_TITLE_LEN);
  if (title.length === 0) {
    return err(400, "invalid_title", "Lobby title is required.");
  }
  if (!isValidGoal(body.goal)) {
    return err(400, "invalid_goal", "Pick a valid run goal.");
  }

  const profile = await profileFor(env, hostSteamId);
  const { ascensionMin, ascensionMax } = sanitizeAscensionRange(
    body.ascensionMin,
    body.ascensionMax,
  );
  const sizeRaw = clampInt(body.lobbySize, 2, 4);
  const lobbySize: RunLobbySize =
    sizeRaw === 2 || sizeRaw === 3 || sizeRaw === 4 ? sizeRaw : 4;
  const mode =
    sanitizeOptionalText(body.mode, 40) ??
    (typeof body.goal === "string" ? body.goal : undefined);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const lobby: RunLobby = {
    lobbyId: newRandomId(),
    hostSteamId,
    hostPersonaName: profile.personaName,
    hostAvatarUrl: profile.avatarUrl,
    title,
    mode,
    goal: body.goal as CoopGoal,
    lobbySize,
    ascensionMin,
    ascensionMax,
    voicePreference: isValidVoice(body.voicePreference)
      ? (body.voicePreference as VoicePreference)
      : undefined,
    preferredCharacters: sanitizePreferredCharacters(body.preferredCharacters),
    note: sanitizeOptionalText(body.note, MAX_NOTE_LEN),
    discordHandle: sanitizeOptionalText(body.discordHandle, MAX_DISCORD_LEN),
    status: "open",
    acceptedMemberSteamIds: [hostSteamId],
    pendingSeatRequestSteamIds: [],
    memberSteamIds: [hostSteamId],
    pendingJoinRequestSteamIds: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(now + COOP_LOBBY_TTL_S * 1000).toISOString(),
  };

  await writeLobby(env, lobby);
  await setPresenceField(env, hostSteamId, {
    currentLobbyId: lobby.lobbyId,
    status: "looking",
  });
  return ok(lobby);
}

export interface UpdateLobbyBody extends CreateLobbyBody {}

export async function updateLobby(
  env: Env,
  hostSteamId: string,
  lobbyId: string,
  body: UpdateLobbyBody,
): Promise<CoopResult<RunLobby>> {
  const lobby = await readLobby(env, lobbyId);
  if (!lobby) return err(404, "not_found", "Lobby not found.");
  if (lobby.hostSteamId !== hostSteamId) {
    return err(403, "not_host", "Only the host can edit this lobby.");
  }
  if (lobby.status !== "open" && lobby.status !== "pending") {
    return err(409, "lobby_closed", "This lobby is no longer editable.");
  }

  if (body.title !== undefined) {
    const t = sanitizeText(body.title, MAX_TITLE_LEN);
    if (t.length === 0) return err(400, "invalid_title", "Title is required.");
    lobby.title = t;
  }
  if (body.goal !== undefined) {
    if (!isValidGoal(body.goal)) return err(400, "invalid_goal", "Invalid goal.");
    lobby.goal = body.goal as CoopGoal;
  }
  if (body.ascensionMin !== undefined || body.ascensionMax !== undefined) {
    const r = sanitizeAscensionRange(
      body.ascensionMin ?? lobby.ascensionMin,
      body.ascensionMax ?? lobby.ascensionMax,
    );
    lobby.ascensionMin = r.ascensionMin;
    lobby.ascensionMax = r.ascensionMax;
  }
  if (body.voicePreference !== undefined) {
    lobby.voicePreference = isValidVoice(body.voicePreference)
      ? (body.voicePreference as VoicePreference)
      : undefined;
  }
  if (body.preferredCharacters !== undefined) {
    lobby.preferredCharacters = sanitizePreferredCharacters(body.preferredCharacters);
  }
  if (body.note !== undefined) {
    lobby.note = sanitizeOptionalText(body.note, MAX_NOTE_LEN);
  }
  if (body.discordHandle !== undefined) {
    lobby.discordHandle = sanitizeOptionalText(body.discordHandle, MAX_DISCORD_LEN);
  }
  if (body.lobbySize !== undefined) {
    const sizeRaw = clampInt(body.lobbySize, 2, 4);
    if (sizeRaw === 2 || sizeRaw === 3 || sizeRaw === 4) {
      lobby.lobbySize = sizeRaw;
    }
  }

  const now = Date.now();
  lobby.updatedAt = new Date(now).toISOString();
  lobby.expiresAt = new Date(now + COOP_LOBBY_TTL_S * 1000).toISOString();
  await writeLobby(env, lobby);
  return ok(lobby);
}

export async function closeLobby(
  env: Env,
  callerSteamId: string,
  lobbyId: string,
): Promise<CoopResult<{ closed: boolean }>> {
  const lobby = await readLobby(env, lobbyId);
  if (!lobby) return ok({ closed: false });
  if (lobby.hostSteamId !== callerSteamId) {
    return err(403, "not_host", "Only the host can close this lobby.");
  }

  // Cancel every pending join request for this lobby
  const joins = await pruneLobbyJoinRequests(env, lobbyId);
  for (const r of joins) {
    r.status = "cancelled";
    await writeJoinRequest(env, r);
    const user = await readUserJoinIds(env, r.fromSteamId);
    await writeUserJoinIds(
      env,
      r.fromSteamId,
      user.filter((id) => id !== r.requestId),
    );
  }
  await writeLobbyJoinIds(env, lobbyId, []);

  // Cancel any pending invites that referenced this lobby (outgoing
  // from the host). Best-effort — invites without lobby refs are left.
  const out = await pruneOutbox(env, lobby.hostSteamId);
  for (const inv of out) {
    if (inv.lobbyId === lobbyId && inv.status === "pending") {
      inv.status = "cancelled";
      await writeInvite(env, inv);
      // remove from recipient's inbox
      const inbox = await readInbox(env, inv.toSteamId);
      await writeInbox(
        env,
        inv.toSteamId,
        inbox.filter((id) => id !== inv.inviteId),
      );
    }
  }

  // Mark the lobby itself closed before deleting it so any in-flight
  // reader sees a clean terminal state.
  lobby.status = "closed";
  lobby.updatedAt = new Date().toISOString();
  await writeLobby(env, lobby);
  await deleteLobby(env, lobby);

  // Clear the host's currentLobbyId on their presence row.
  await setPresenceField(env, lobby.hostSteamId, { currentLobbyId: undefined });
  return ok({ closed: true });
}

export async function requestToJoinLobby(
  env: Env,
  fromSteamId: string,
  lobbyId: string,
): Promise<CoopResult<JoinRequest>> {
  const lobby = await readLobby(env, lobbyId);
  if (!lobby) return err(404, "not_found", "This lobby expired.");
  if (lobby.status !== "open") {
    return err(409, "lobby_closed", "This lobby is no longer open.");
  }
  if (lobby.hostSteamId === fromSteamId) {
    return err(400, "self_lobby", "You can't request to join your own lobby.");
  }
  if (lobbyIsFull(lobby)) {
    return err(409, "lobby_full", "This lobby is full.");
  }
  if ((lobby.acceptedMemberSteamIds ?? []).includes(fromSteamId)) {
    return err(409, "already_member", "You're already in this lobby.");
  }
  if (await getActiveSessionIdForUser(env, fromSteamId)) {
    return err(409, "in_session", "You're already in a co-op session.");
  }
  if (await getActivePartyIdForUser(env, fromSteamId)) {
    return err(409, "in_party", "You're already in a Party Room.");
  }
  // Block stale targets
  const hostPresence = await readPresence(env, lobby.hostSteamId);
  if (!hostPresence || !isPresenceActive(hostPresence)) {
    return err(409, "host_stale", "They went offline.");
  }
  if (hostPresence.status === "afk" || hostPresence.status === "offline") {
    return err(409, "host_stale", "They went offline.");
  }
  if (hostPresence.status === "paired") {
    return err(409, "host_paired", "They're already paired.");
  }

  // Block self under pair cooldown
  if (await isUnderDeclineCooldown(env, fromSteamId, lobby.hostSteamId)) {
    return err(429, "decline_cooldown", "Give them a moment before trying again.");
  }

  // Cap pending join requests per user
  const existing = await pruneUserJoinRequests(env, fromSteamId);
  if (existing.some((r) => r.lobbyId === lobbyId)) {
    return ok(existing.find((r) => r.lobbyId === lobbyId)!);
  }
  if (existing.length >= MAX_PENDING_JOIN_REQUESTS) {
    return err(429, "too_many_requests", "Too many pending join requests.");
  }

  const fromProfile = await profileFor(env, fromSteamId);
  const now = Date.now();
  const req: JoinRequest = {
    requestId: newRandomId(),
    lobbyId,
    fromSteamId,
    toHostSteamId: lobby.hostSteamId,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + COOP_JOIN_REQUEST_TTL_S * 1000).toISOString(),
    fromPersonaName: fromProfile.personaName,
    fromAvatarUrl: fromProfile.avatarUrl,
  };

  await writeJoinRequest(env, req);
  const lobbyIds = await readLobbyJoinIds(env, lobbyId);
  await writeLobbyJoinIds(env, lobbyId, [...lobbyIds, req.requestId]);
  const userIds = await readUserJoinIds(env, fromSteamId);
  await writeUserJoinIds(env, fromSteamId, [...userIds, req.requestId]);
  lobby.pendingSeatRequestSteamIds = Array.from(
    new Set([...(lobby.pendingSeatRequestSteamIds ?? []), fromSteamId]),
  );
  lobby.pendingJoinRequestSteamIds = lobby.pendingSeatRequestSteamIds;
  lobby.updatedAt = new Date(now).toISOString();
  await writeLobby(env, lobby);

  return ok(req);
}

export async function cancelJoinRequest(
  env: Env,
  callerSteamId: string,
  lobbyId: string,
): Promise<CoopResult<{ cancelled: boolean }>> {
  const userIds = await readUserJoinIds(env, callerSteamId);
  let foundId: string | null = null;
  for (const id of userIds) {
    const r = await readJoinRequest(env, id);
    if (r && r.lobbyId === lobbyId && r.status === "pending") {
      foundId = id;
      r.status = "cancelled";
      await writeJoinRequest(env, r);
      break;
    }
  }
  if (!foundId) return ok({ cancelled: false });

  await writeUserJoinIds(env, callerSteamId, userIds.filter((id) => id !== foundId));
  const lobbyJoinIds = await readLobbyJoinIds(env, lobbyId);
  await writeLobbyJoinIds(
    env,
    lobbyId,
    lobbyJoinIds.filter((id) => id !== foundId),
  );

  const lobby = await readLobby(env, lobbyId);
  if (lobby) {
    lobby.pendingJoinRequestSteamIds = lobby.pendingJoinRequestSteamIds.filter(
      (sid) => sid !== callerSteamId,
    );
    lobby.updatedAt = new Date().toISOString();
    await writeLobby(env, lobby);
  }
  return ok({ cancelled: true });
}

export async function declineJoinRequest(
  env: Env,
  hostSteamId: string,
  lobbyId: string,
  requesterSteamId: string,
): Promise<CoopResult<{ declined: boolean }>> {
  const lobby = await readLobby(env, lobbyId);
  if (!lobby) return err(404, "not_found", "Lobby not found.");
  if (lobby.hostSteamId !== hostSteamId) {
    return err(403, "not_host", "Only the host can decline.");
  }

  const ids = await readLobbyJoinIds(env, lobbyId);
  let targetId: string | null = null;
  for (const id of ids) {
    const r = await readJoinRequest(env, id);
    if (r && r.fromSteamId === requesterSteamId && r.status === "pending") {
      targetId = id;
      r.status = "declined";
      await writeJoinRequest(env, r);
      break;
    }
  }
  if (!targetId) return ok({ declined: false });

  await writeLobbyJoinIds(env, lobbyId, ids.filter((id) => id !== targetId));
  const userIds = await readUserJoinIds(env, requesterSteamId);
  await writeUserJoinIds(
    env,
    requesterSteamId,
    userIds.filter((id) => id !== targetId),
  );

  lobby.pendingJoinRequestSteamIds = lobby.pendingJoinRequestSteamIds.filter(
    (sid) => sid !== requesterSteamId,
  );
  lobby.updatedAt = new Date().toISOString();
  await writeLobby(env, lobby);

  await recordDecline(env, requesterSteamId, hostSteamId);
  return ok({ declined: true });
}

/**
 * Host accepts a pending join request. Mints a co-op session, marks the
 * lobby `full`, cancels all conflicting invites/requests on both sides.
 */
export async function acceptJoinRequest(
  env: Env,
  hostSteamId: string,
  lobbyId: string,
  requesterSteamId: string,
): Promise<CoopResult<{ session: CoopSession | null; lobby: RunLobby; party: CoopParty }>> {
  const lobby = await readLobby(env, lobbyId);
  if (!lobby) return err(404, "not_found", "Lobby not found.");
  if (lobby.hostSteamId !== hostSteamId) {
    return err(403, "not_host", "Only the host can accept.");
  }
  if (lobby.status !== "open") {
    return err(409, "lobby_closed", "This lobby is no longer open.");
  }
  if (lobbyIsFull(lobby)) {
    return err(409, "lobby_full", "This lobby is full.");
  }

  // Re-check session locks RIGHT before pair so the narrow KV race
  // window cannot let two accepts both succeed.
  if (await getActiveSessionIdForUser(env, hostSteamId)) {
    return err(409, "in_session", "You're already in a co-op session.");
  }
  if (await getActiveSessionIdForUser(env, requesterSteamId)) {
    return err(409, "they_paired", "They're already paired.");
  }
  if (await getActivePartyIdForUser(env, requesterSteamId)) {
    return err(409, "they_in_party", "They're already in a Party Room.");
  }

  // Find the join request
  const ids = await readLobbyJoinIds(env, lobbyId);
  let targetId: string | null = null;
  for (const id of ids) {
    const r = await readJoinRequest(env, id);
    if (r && r.fromSteamId === requesterSteamId && r.status === "pending") {
      const exp = Date.parse(r.expiresAt);
      if (Number.isFinite(exp) && exp <= Date.now()) continue;
      targetId = id;
      break;
    }
  }
  if (!targetId) return err(404, "request_not_found", "That request expired.");

  // Promote requester into accepted seats
  const accepted = Array.from(
    new Set([...(lobby.acceptedMemberSteamIds ?? [lobby.hostSteamId]), requesterSteamId]),
  );
  lobby.acceptedMemberSteamIds = accepted;
  lobby.memberSteamIds = accepted;

  const party = await ensurePartyForLobby(env, lobby, requesterSteamId);
  lobby.partyId = party.partyId;

  // Mint pairing session when at least two players (STS2 co-op minimum)
  let session: CoopSession | null = null;
  if (accepted.length >= 2) {
    session = await mintSession(env, hostSteamId, requesterSteamId, lobbyId);
  }

  // Mark the request accepted, drop it from indexes
  const reqBlob = await readJoinRequest(env, targetId);
  if (reqBlob) {
    reqBlob.status = "accepted";
    await writeJoinRequest(env, reqBlob);
  }
  await writeLobbyJoinIds(env, lobbyId, []);
  const userIds = await readUserJoinIds(env, requesterSteamId);
  await writeUserJoinIds(
    env,
    requesterSteamId,
    userIds.filter((id) => id !== targetId),
  );

  lobby.pendingSeatRequestSteamIds = [];
  lobby.pendingJoinRequestSteamIds = [];
  lobby.status = lobbyIsFull(lobby) ? "full" : "open";
  lobby.updatedAt = new Date().toISOString();
  await writeLobby(env, lobby);

  // Cancel conflicting invites for both players (outgoing AND incoming)
  await cancelConflictingInvites(env, hostSteamId);
  await cancelConflictingInvites(env, requesterSteamId);

  // Cancel any OTHER pending join requests from the requester
  await cancelOtherJoinRequestsFromUser(env, requesterSteamId, targetId);

  // Stamp session ids onto presence rows
  const presencePatch: Partial<CoopPresence> = {
    currentPartyId: party.partyId,
    currentLobbyId: lobbyId,
    status: session ? "paired" : "looking",
  };
  if (session) presencePatch.currentSessionId = session.sessionId;
  await setPresenceField(env, hostSteamId, presencePatch);
  await setPresenceField(env, requesterSteamId, presencePatch);

  return ok({ session, lobby, party });
}

// ---------- Direct invites ----------

export interface SendInviteBody {
  toSteamId?: unknown;
  lobbyId?: unknown;
  messagePreset?: unknown;
}

export async function sendInvite(
  env: Env,
  fromSteamId: string,
  body: SendInviteBody,
): Promise<CoopResult<CoopInvite>> {
  if (!isValidSteamId(body.toSteamId)) {
    return err(400, "invalid_target", "Pick someone to invite.");
  }
  const toSteamId = body.toSteamId;
  if (toSteamId === fromSteamId) {
    return err(400, "self_invite", "You can't invite yourself.");
  }
  const messagePreset =
    typeof body.messagePreset === "string" &&
    Object.prototype.hasOwnProperty.call(COOP_INVITE_MESSAGES, body.messagePreset)
      ? body.messagePreset
      : undefined;
  const lobbyId =
    typeof body.lobbyId === "string" && body.lobbyId.length > 0
      ? body.lobbyId
      : undefined;

  if (lobbyId) {
    const lobby = await readLobby(env, lobbyId);
    if (!lobby) return err(404, "lobby_gone", "That lobby expired.");
    if (lobby.hostSteamId !== fromSteamId) {
      return err(403, "not_host", "Only the host can invite to this lobby.");
    }
    if (lobby.memberSteamIds.length >= 2) {
      return err(409, "lobby_full", "This lobby is full.");
    }
  }

  // Sender state checks
  if (await getActiveSessionIdForUser(env, fromSteamId)) {
    return err(409, "in_session", "You're already in a co-op session.");
  }
  // Target state checks
  if (await getActiveSessionIdForUser(env, toSteamId)) {
    return err(409, "they_paired", "They're already paired.");
  }
  const targetPresence = await readPresence(env, toSteamId);
  if (!targetPresence || !isPresenceActive(targetPresence)) {
    return err(409, "target_offline", "They went offline.");
  }
  if (
    targetPresence.status === "afk" ||
    targetPresence.status === "offline" ||
    targetPresence.status === "paired"
  ) {
    return err(409, "target_unavailable", "They went offline.");
  }

  // Decline cooldown
  if (await isUnderDeclineCooldown(env, fromSteamId, toSteamId)) {
    return err(429, "decline_cooldown", "Give them a moment before trying again.");
  }

  // Cap pending outgoing invites
  const pending = await pruneOutbox(env, fromSteamId);
  if (pending.some((i) => i.toSteamId === toSteamId && i.status === "pending")) {
    return ok(pending.find((i) => i.toSteamId === toSteamId)!);
  }
  if (pending.length >= MAX_PENDING_OUTGOING_INVITES) {
    return err(429, "too_many_invites", "Slow down — too many invites.");
  }

  const [fromProfile, toProfile] = await Promise.all([
    profileFor(env, fromSteamId),
    profileFor(env, toSteamId),
  ]);
  const now = Date.now();
  const inv: CoopInvite = {
    inviteId: newRandomId(),
    fromSteamId,
    toSteamId,
    lobbyId,
    messagePreset,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + COOP_INVITE_TTL_S * 1000).toISOString(),
    fromPersonaName: fromProfile.personaName,
    fromAvatarUrl: fromProfile.avatarUrl,
    toPersonaName: toProfile.personaName,
    toAvatarUrl: toProfile.avatarUrl,
  };
  await writeInvite(env, inv);
  const outbox = await readOutbox(env, fromSteamId);
  await writeOutbox(env, fromSteamId, [...outbox, inv.inviteId]);
  const inbox = await readInbox(env, toSteamId);
  await writeInbox(env, toSteamId, [...inbox, inv.inviteId]);
  return ok(inv);
}

export async function cancelInvite(
  env: Env,
  callerSteamId: string,
  inviteId: string,
): Promise<CoopResult<{ cancelled: boolean }>> {
  const inv = await readInvite(env, inviteId);
  if (!inv) return ok({ cancelled: false });
  if (inv.fromSteamId !== callerSteamId) {
    return err(403, "not_sender", "Only the sender can cancel.");
  }
  if (inv.status !== "pending") return ok({ cancelled: false });
  inv.status = "cancelled";
  await writeInvite(env, inv);
  await removeInviteFromIndexes(env, inv);
  return ok({ cancelled: true });
}

export async function declineInvite(
  env: Env,
  callerSteamId: string,
  inviteId: string,
): Promise<CoopResult<{ declined: boolean }>> {
  const inv = await readInvite(env, inviteId);
  if (!inv) return err(404, "not_found", "That invite expired.");
  if (inv.toSteamId !== callerSteamId) {
    return err(403, "not_recipient", "You can't decline that invite.");
  }
  if (inv.status !== "pending") return err(409, "already_resolved", "That invite was already handled.");
  inv.status = "declined";
  await writeInvite(env, inv);
  await removeInviteFromIndexes(env, inv);
  await recordDecline(env, inv.fromSteamId, inv.toSteamId);
  return ok({ declined: true });
}

export async function acceptInvite(
  env: Env,
  callerSteamId: string,
  inviteId: string,
): Promise<CoopResult<{ session: CoopSession; invite: CoopInvite }>> {
  const inv = await readInvite(env, inviteId);
  if (!inv) return err(404, "not_found", "That invite expired.");
  if (inv.toSteamId !== callerSteamId) {
    return err(403, "not_recipient", "You can't accept that invite.");
  }
  if (inv.status !== "pending") return err(409, "already_resolved", "That invite was already handled.");
  const exp = Date.parse(inv.expiresAt);
  if (Number.isFinite(exp) && exp <= Date.now()) {
    inv.status = "expired";
    await writeInvite(env, inv);
    return err(410, "expired", "That invite expired.");
  }

  // Re-check session locks
  if (await getActiveSessionIdForUser(env, inv.fromSteamId)) {
    return err(409, "they_paired", "They're already paired.");
  }
  if (await getActiveSessionIdForUser(env, inv.toSteamId)) {
    return err(409, "you_paired", "You're already in a co-op session.");
  }

  let lobbyForSession: string | undefined = inv.lobbyId;
  let lobby: RunLobby | null = inv.lobbyId ? await readLobby(env, inv.lobbyId) : null;
  if (lobby) {
    if (lobby.status !== "open") {
      lobbyForSession = undefined;
      lobby = null;
    } else if (lobby.memberSteamIds.length >= 2) {
      lobbyForSession = undefined;
      lobby = null;
    }
  }

  const session = await mintSession(
    env,
    inv.fromSteamId,
    inv.toSteamId,
    lobbyForSession,
  );

  inv.status = "accepted";
  await writeInvite(env, inv);
  await removeInviteFromIndexes(env, inv);

  if (lobby) {
    lobby.memberSteamIds = Array.from(
      new Set([...lobby.memberSteamIds, inv.toSteamId]),
    );
    lobby.pendingJoinRequestSteamIds = [];
    lobby.status = "full";
    lobby.updatedAt = new Date().toISOString();
    await writeLobby(env, lobby);
  }

  // Cancel conflicting invites/requests on both sides
  await cancelConflictingInvites(env, inv.fromSteamId);
  await cancelConflictingInvites(env, inv.toSteamId);
  await cancelOtherJoinRequestsFromUser(env, inv.fromSteamId);
  await cancelOtherJoinRequestsFromUser(env, inv.toSteamId);

  // Stamp presence
  await setPresenceField(env, inv.fromSteamId, {
    currentSessionId: session.sessionId,
    currentLobbyId: lobbyForSession,
    status: "paired",
  });
  await setPresenceField(env, inv.toSteamId, {
    currentSessionId: session.sessionId,
    currentLobbyId: lobbyForSession,
    status: "paired",
  });

  return ok({ session, invite: inv });
}

// ---------- Sessions ----------

async function mintSession(
  env: Env,
  aSid: string,
  bSid: string,
  lobbyId?: string,
): Promise<CoopSession> {
  const now = Date.now();
  const session: CoopSession = {
    sessionId: newRandomId(),
    playerSteamIds: [aSid, bSid],
    lobbyId,
    status: "active",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + COOP_SESSION_TTL_S * 1000).toISOString(),
  };
  await writeSession(env, session);
  return session;
}

// ---------- Party room ----------

async function memberRowFor(
  env: Env,
  steamId: string,
  status: CoopPartyMemberStatus = "joined",
): Promise<CoopPartyMember> {
  const profile = await profileFor(env, steamId);
  return {
    steamId,
    personaName: profile.personaName,
    avatarUrl: profile.avatarUrl,
    status,
    updatedAt: new Date().toISOString(),
  };
}

async function ensurePartyForLobby(
  env: Env,
  lobby: RunLobby,
  newestMemberSteamId: string,
): Promise<CoopParty> {
  const norm = normalizeRunLobby(lobby);
  const existingId =
    lobby.partyId ?? (await getPartyIdForLobby(env, lobby.lobbyId));
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cap = lobbyCapacity(norm) as RunLobbySize;

  if (existingId) {
    const existing = await readParty(env, existingId);
    if (existing && existing.status === "active") {
      const ids = new Set(existing.members.map((m) => m.steamId));
      for (const sid of norm.acceptedMemberSteamIds ?? []) {
        if (!ids.has(sid)) {
          existing.members.push(await memberRowFor(env, sid));
        }
      }
      existing.updatedAt = nowIso;
      existing.expiresAt = new Date(now + COOP_PARTY_TTL_S * 1000).toISOString();
      await writeParty(env, existing);
      return existing;
    }
  }

  const members: CoopPartyMember[] = [];
  for (const sid of norm.acceptedMemberSteamIds ?? []) {
    const st: CoopPartyMemberStatus =
      sid === newestMemberSteamId ? "joined" : "joined";
    members.push(await memberRowFor(env, sid, st));
  }

  const party: CoopParty = {
    partyId: newRandomId(),
    lobbyId: lobby.lobbyId,
    hostSteamId: lobby.hostSteamId,
    lobbySize: cap,
    members,
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: new Date(now + COOP_PARTY_TTL_S * 1000).toISOString(),
  };
  await writeParty(env, party);
  return party;
}

export async function readPartyForUser(
  env: Env,
  steamId: string,
): Promise<CoopParty | null> {
  const id = await getActivePartyIdForUser(env, steamId);
  if (!id) return null;
  const party = await readParty(env, id);
  if (!party || party.status !== "active") return null;
  return party;
}

export async function updatePartyMemberStatus(
  env: Env,
  callerSteamId: string,
  partyId: string,
  status: unknown,
): Promise<CoopResult<CoopParty>> {
  if (
    typeof status !== "string" ||
    !(["ready", "character_select", "in_game", "joined"] as string[]).includes(status)
  ) {
    return err(400, "invalid_status", "Pick a valid status.");
  }
  const party = await readParty(env, partyId);
  if (!party || party.status !== "active") {
    return err(404, "not_found", "Party Room not found.");
  }
  const member = party.members.find((m) => m.steamId === callerSteamId);
  if (!member) {
    return err(403, "not_participant", "You're not in this Party Room.");
  }
  member.status = status as CoopPartyMemberStatus;
  member.updatedAt = new Date().toISOString();
  party.updatedAt = member.updatedAt;
  await writeParty(env, party);
  return ok(party);
}

export async function leaveParty(
  env: Env,
  callerSteamId: string,
  partyId: string,
): Promise<CoopResult<{ left: boolean }>> {
  const party = await readParty(env, partyId);
  if (!party) return ok({ left: false });
  const member = party.members.find((m) => m.steamId === callerSteamId);
  if (!member) return ok({ left: false });
  member.status = "left";
  member.updatedAt = new Date().toISOString();
  party.updatedAt = member.updatedAt;
  await writeParty(env, party);
  await setPresenceField(env, callerSteamId, {
    currentPartyId: undefined,
    currentLobbyId: undefined,
    status: "looking",
  });
  return ok({ left: true });
}

export async function endParty(
  env: Env,
  callerSteamId: string,
  partyId: string,
): Promise<CoopResult<{ ended: boolean }>> {
  const party = await readParty(env, partyId);
  if (!party) return ok({ ended: false });
  if (party.hostSteamId !== callerSteamId) {
    return err(403, "not_host", "Only the host can end the party.");
  }
  party.status = "ended";
  party.updatedAt = new Date().toISOString();
  await writeParty(env, party);
  for (const m of party.members) {
    await setPresenceField(env, m.steamId, {
      currentPartyId: undefined,
      currentLobbyId: undefined,
      currentSessionId: undefined,
      status: "looking",
    });
  }
  await deleteParty(env, party);
  const lobby = await readLobby(env, party.lobbyId);
  if (lobby) await deleteLobby(env, lobby);
  return ok({ ended: true });
}

export async function endSession(
  env: Env,
  callerSteamId: string,
  sessionId: string,
): Promise<CoopResult<{ ended: boolean }>> {
  const session = await readSession(env, sessionId);
  if (!session) return ok({ ended: false });
  if (!session.playerSteamIds.includes(callerSteamId)) {
    return err(403, "not_participant", "You're not in that session.");
  }
  if (session.status !== "active") return ok({ ended: false });

  session.status = "ended";
  session.endedAt = new Date().toISOString();
  await writeSession(env, session);

  for (const sid of session.playerSteamIds) {
    const partyId = await getActivePartyIdForUser(env, sid);
    await setPresenceField(env, sid, {
      currentSessionId: undefined,
      currentLobbyId: undefined,
      currentPartyId: undefined,
      status: "looking",
    });
    if (partyId) {
      const party = await readParty(env, partyId);
      if (party) await deleteParty(env, party);
    }
  }

  // If the session was tied to a lobby, close that lobby so it doesn't
  // hang around as `full`.
  if (session.lobbyId) {
    const lobby = await readLobby(env, session.lobbyId);
    if (lobby) {
      await deleteLobby(env, lobby);
    }
  }

  await deleteSession(env, session);
  return ok({ ended: true });
}

async function deleteSession(env: Env, session: CoopSession): Promise<void> {
  // Re-import would be circular; just inline the cleanup.
  // The store-level function does the same thing.
  // We can call it via dynamic import to avoid recursion concerns? Simpler: just hand-roll.
  // Actually `coop-store` exports it already; re-export via local alias is unnecessary.
  // Keep this thin pass-through so the engine doesn't reach into multiple store APIs.
  const mod = await import("./coop-store");
  await mod.deleteSession(env, session);
}

// ---------- Conflict cancellation ----------

async function removeInviteFromIndexes(
  env: Env,
  inv: CoopInvite,
): Promise<void> {
  const outbox = await readOutbox(env, inv.fromSteamId);
  await writeOutbox(
    env,
    inv.fromSteamId,
    outbox.filter((id) => id !== inv.inviteId),
  );
  const inbox = await readInbox(env, inv.toSteamId);
  await writeInbox(
    env,
    inv.toSteamId,
    inbox.filter((id) => id !== inv.inviteId),
  );
}

async function cancelConflictingInvites(env: Env, steamId: string): Promise<void> {
  // Cancel outgoing pending
  const outgoing = await pruneOutbox(env, steamId);
  for (const inv of outgoing) {
    if (inv.status !== "pending") continue;
    inv.status = "cancelled";
    await writeInvite(env, inv);
    await removeInviteFromIndexes(env, inv);
  }
  // Cancel incoming pending
  const incoming = await pruneInbox(env, steamId);
  for (const inv of incoming) {
    if (inv.status !== "pending") continue;
    inv.status = "cancelled";
    await writeInvite(env, inv);
    await removeInviteFromIndexes(env, inv);
  }
}

async function cancelOtherJoinRequestsFromUser(
  env: Env,
  steamId: string,
  keepRequestId?: string,
): Promise<void> {
  const ids = await readUserJoinIds(env, steamId);
  const remaining: string[] = [];
  for (const id of ids) {
    if (keepRequestId && id === keepRequestId) {
      remaining.push(id);
      continue;
    }
    const r = await readJoinRequest(env, id);
    if (!r) continue;
    if (r.status !== "pending") continue;
    r.status = "cancelled";
    await writeJoinRequest(env, r);

    const lobbyIds = await readLobbyJoinIds(env, r.lobbyId);
    await writeLobbyJoinIds(
      env,
      r.lobbyId,
      lobbyIds.filter((x) => x !== id),
    );
    const lobby = await readLobby(env, r.lobbyId);
    if (lobby) {
      lobby.pendingJoinRequestSteamIds = lobby.pendingJoinRequestSteamIds.filter(
        (sid) => sid !== steamId,
      );
      lobby.updatedAt = new Date().toISOString();
      await writeLobby(env, lobby);
    }
  }
  await writeUserJoinIds(env, steamId, remaining);
}

// ---------- Re-exports used by the route layer ----------

export {
  COOP_GOALS,
  COOP_INVITE_MESSAGES,
  COOP_PRESENCE_STATUSES,
  VOICE_PREFERENCES,
};

// Pruning helpers exported for the /state route
export {
  pruneInbox,
  pruneOutbox,
  pruneUserJoinRequests,
  pruneLobbyJoinRequests,
};

// Listings exported for /state
export { listLobbies, listPresence };
