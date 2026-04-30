import type { Env, PresenceEntry, PresenceUpsert, PlayerStats } from "./types";

/**
 * Presence storage + Steam Web API enrichment.
 *
 * Storage layout in KV:
 *   - `presence:<steamID>` → `PresenceEntry` JSON, TTL = PRESENCE_TTL_SECONDS.
 *
 * The TTL is the entire lifetime guarantee. Clients heartbeat every ~2 min;
 * if a client disappears (quit, crash, network drop) the entry just expires
 * and falls off the list. There is no separate "online users" index — KV
 * `list({ prefix: "presence:" })` is fast enough at this scale.
 *
 * The persona name + avatar are pulled from the verified Steam profile that
 * the OpenID flow stamped onto the session record (see `auth.ts`). The
 * client doesn't get to pick them — that prevents impersonation by display
 * name. The `inSTS2` flag is computed server-side at list time by batching
 * all visible SteamIDs through `GetPlayerSummaries`.
 */

const PRESENCE_TTL_SECONDS = 5 * 60; // 5 min — heartbeats every ~2 min
/**
 * Minimum spacing between heartbeats from the same session. Legit clients
 * write every ~90 s; anything faster is either a bug or an abuser. We don't
 * want to bill ourselves into a corner on KV writes either way. Two seconds
 * is small enough that humans clicking radios fast still feel snappy
 * (the change-handler debounces at 600 ms client-side anyway).
 */
const MIN_HEARTBEAT_INTERVAL_MS = 2000;
const PRESENCE_PREFIX = "presence:";
const SESSION_PROFILE_PREFIX = "session-profile:";
/** STS2's Steam appid. Hard-coded because that's literally the product. */
const STS2_APP_ID = "2868840";

// MARK: - Public CRUD --------------------------------------------------------

/**
 * Upsert the caller's presence. The verified `steamID` comes from the session
 * (never from the body). Persona/avatar are pulled from the session-profile
 * KV record stamped at OpenID time.
 */
export async function upsertPresence(
  env: Env,
  steamID: string,
  body: PresenceUpsert
): Promise<PresenceEntry> {
  // Anti-flood: reject heartbeats from the same SteamID closer together than
  // MIN_HEARTBEAT_INTERVAL_MS. Reads are cheap; this avoids hammering KV
  // writes if a client gets stuck in a tight loop or someone tries to abuse
  // the auth-gated endpoint.
  const existing = await env.LOBBIES.get(`${PRESENCE_PREFIX}${steamID}`);
  if (existing) {
    try {
      const prev = JSON.parse(existing) as PresenceEntry;
      const last = Date.parse(prev.updatedAt);
      if (
        Number.isFinite(last) &&
        Date.now() - last < MIN_HEARTBEAT_INTERVAL_MS
      ) {
        // Treat as success but don't write — the client already had a fresh
        // record. They get the unchanged entry back for free.
        return prev;
      }
    } catch {
      // Fall through and write — the old record was unreadable anyway.
    }
  }

  const sessionProfile = await getSessionProfile(env, steamID);

  const entry: PresenceEntry = {
    steamID,
    personaName: sessionProfile?.personaName ?? "Steam User",
    avatarURL: sessionProfile?.avatarURL,
    discordHandle: sanitizeDiscord(body.discordHandle),
    stats: sanitizeStats(body.stats),
    status: validStatus(body.status),
    note: sanitizeNote(body.note ?? ""),
    inSTS2: false, // populated at read time
    updatedAt: new Date().toISOString(),
  };

  await env.LOBBIES.put(`${PRESENCE_PREFIX}${steamID}`, JSON.stringify(entry), {
    expirationTtl: PRESENCE_TTL_SECONDS,
  });
  return entry;
}

export async function deletePresence(env: Env, steamID: string): Promise<void> {
  await env.LOBBIES.delete(`${PRESENCE_PREFIX}${steamID}`);
}

/**
 * List everyone currently online. Enriches with Steam Web API in batches so
 * the UI can display "in STS2 right now" badges without each client having to
 * hold a Steam API key.
 */
export async function listPresence(env: Env): Promise<PresenceEntry[]> {
  const entries: PresenceEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.LOBBIES.list({ prefix: PRESENCE_PREFIX, cursor });
    for (const key of page.keys) {
      const raw = await env.LOBBIES.get(key.name);
      if (!raw) continue;
      try {
        entries.push(JSON.parse(raw) as PresenceEntry);
      } catch {
        // Skip malformed entries — KV TTL will clear them eventually.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (entries.length === 0) return [];

  const inGame = await fetchInGameSet(env, entries.map((e) => e.steamID));
  for (const e of entries) {
    e.inSTS2 = inGame.has(e.steamID);
  }
  return entries;
}

// MARK: - Session profile ----------------------------------------------------

/**
 * `auth.ts` writes one of these per successful sign-in so presence-time UI
 * doesn't need to pay for a Steam Web API call to get the persona name.
 */
export interface SessionProfile {
  personaName: string;
  avatarURL?: string;
}

export async function putSessionProfile(
  env: Env,
  steamID: string,
  profile: SessionProfile,
  ttlSeconds: number
): Promise<void> {
  await env.LOBBIES.put(
    `${SESSION_PROFILE_PREFIX}${steamID}`,
    JSON.stringify(profile),
    { expirationTtl: ttlSeconds }
  );
}

async function getSessionProfile(env: Env, steamID: string): Promise<SessionProfile | null> {
  const raw = await env.LOBBIES.get(`${SESSION_PROFILE_PREFIX}${steamID}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as SessionProfile; } catch { return null; }
}

// MARK: - Steam Web API enrichment ------------------------------------------

/**
 * Returns the subset of `ids` that are currently playing STS2 according to
 * GetPlayerSummaries. Cached at the Cloudflare edge for 30 seconds — adequate
 * since heartbeats are slower than that and presence is inherently fuzzy.
 */
async function fetchInGameSet(env: Env, ids: string[]): Promise<Set<string>> {
  if (!env.STEAM_WEB_API_KEY) return new Set();
  const filtered = Array.from(new Set(ids.filter((s) => /^\d{17}$/.test(s)))).slice(0, 100);
  if (filtered.length === 0) return new Set();
  try {
    const url =
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
      `?key=${env.STEAM_WEB_API_KEY}&steamids=${filtered.join(",")}`;
    const resp = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
    if (!resp.ok) return new Set();
    const data = (await resp.json()) as any;
    const players = data?.response?.players ?? [];
    const inGame = new Set<string>();
    for (const p of players) {
      if (p?.gameid && String(p.gameid) === STS2_APP_ID) {
        inGame.add(String(p.steamid));
      }
    }
    return inGame;
  } catch {
    return new Set();
  }
}

// MARK: - Sanitizers ---------------------------------------------------------

function validStatus(s: any): "looking" | "inRun" | "inCoop" | "afk" {
  const allowed = ["looking", "inRun", "inCoop", "afk"];
  return allowed.includes(s) ? s : "looking";
}

function sanitizeNote(n: string): string {
  return String(n ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .slice(0, 140);
}

function sanitizeDiscord(d?: string): string | undefined {
  if (typeof d !== "string") return undefined;
  const trimmed = d.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 40);
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeStats(s?: PlayerStats): PlayerStats | undefined {
  if (!s) return undefined;
  return {
    totalRuns: clampInt(s.totalRuns, 0, 1_000_000),
    wins: clampInt(s.wins, 0, 1_000_000),
    maxAscension: clampInt(s.maxAscension, 0, 20),
    preferredCharacter:
      typeof s.preferredCharacter === "string"
        ? s.preferredCharacter.slice(0, 32)
        : undefined,
  };
}

function clampInt(v: any, min: number, max: number): number {
  const n = Math.floor(Number(v) || 0);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
