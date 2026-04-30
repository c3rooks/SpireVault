import type { Env, PresenceEntry, PresenceUpsert, PlayerStats } from "./types";

/**
 * Presence storage + Steam Web API enrichment.
 *
 * STORAGE SHAPE — single-roster key
 * ----------------------------------
 *   `presence:roster` → JSON `{ entries: PresenceEntry[] }`, TTL 7 days.
 *
 * Why one big key instead of one key per user:
 *   The original design used `presence:<sid>` per user and a `KV.list({ prefix })`
 *   to read the feed. That cost one **list operation** (the smallest free-tier
 *   bucket — 1,000/day) plus one read per online user, on every poll. With two
 *   browsers polling every 12 s the list-op quota torched in hours.
 *
 *   Roster math is much friendlier:
 *
 *     listPresence    → 1 read
 *     upsertPresence  → 1 read + 1 write
 *     deletePresence  → 1 read + 1 write
 *
 *   …with zero list operations *ever*. Inline pruning at read time is what lets
 *   us drop the per-key TTL (we keep `updatedAt` on each entry and discard
 *   anything older than `PRESENCE_TTL_SECONDS`).
 *
 * Concurrency:
 *   KV is eventually consistent; two simultaneous upserts can race and lose one
 *   entry's update. For presence that's fine — the next heartbeat refreshes
 *   from the loser. We don't depend on read-modify-write for anything where
 *   correctness matters.
 */

const PRESENCE_TTL_SECONDS = 5 * 60; // 5 min — heartbeats every ~3 min
/**
 * Minimum spacing between heartbeats from the same session. Legit clients
 * write every ~180 s; anything faster is either a bug or an abuser.
 */
const MIN_HEARTBEAT_INTERVAL_MS = 60_000; // 60 s — was 2 s; we no longer need fast pulses
const ROSTER_KEY = "presence:roster";
const ROSTER_TTL_SECONDS = 7 * 86400;
/**
 * Hard ceiling on online-feed size. The wire format gets shipped to every
 * polling client, so the bigger this is the more bytes we egress and the
 * more memory each Worker invocation chews. 200 is comfortably above any
 * realistic concurrency for an STS2 fan tool, and gives us a knob to drop
 * the worst offender's row first if a flood ever shows up.
 */
const MAX_ROSTER_ENTRIES = 200;
const SESSION_PROFILE_PREFIX = "session-profile:";
/** STS2's Steam appid. Hard-coded because that's literally the product. */
const STS2_APP_ID = "2868840";

interface Roster { entries: PresenceEntry[]; }

// MARK: - Roster I/O ---------------------------------------------------------

async function readRoster(env: Env): Promise<Roster> {
  const raw = await env.LOBBIES.get(ROSTER_KEY);
  if (!raw) return { entries: [] };
  try { return JSON.parse(raw) as Roster; } catch { return { entries: [] }; }
}

async function writeRoster(env: Env, roster: Roster): Promise<void> {
  await env.LOBBIES.put(ROSTER_KEY, JSON.stringify(roster), {
    expirationTtl: ROSTER_TTL_SECONDS,
  });
}

/** Drop entries whose `updatedAt` is older than PRESENCE_TTL_SECONDS. */
function pruneStale(roster: Roster): Roster {
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  return {
    entries: roster.entries.filter((e) => {
      const t = Date.parse(e.updatedAt);
      return Number.isFinite(t) && t >= cutoff;
    }),
  };
}

// MARK: - Public CRUD --------------------------------------------------------

export async function upsertPresence(
  env: Env,
  steamID: string,
  body: PresenceUpsert
): Promise<PresenceEntry> {
  const roster = pruneStale(await readRoster(env));
  const idx = roster.entries.findIndex((e) => e.steamID === steamID);
  const prev = idx >= 0 ? roster.entries[idx] : null;

  // Anti-flood: if we wrote this user's row in the last MIN_HEARTBEAT_INTERVAL_MS,
  // return the existing record without touching KV. Saves writes on
  // misbehaving / spam-clicking clients.
  if (prev) {
    const last = Date.parse(prev.updatedAt);
    if (Number.isFinite(last) && Date.now() - last < MIN_HEARTBEAT_INTERVAL_MS) {
      return prev;
    }
  }

  const sessionProfile = await getSessionProfile(env, steamID);

  const entry: PresenceEntry = {
    steamID,
    personaName: sessionProfile?.personaName ?? prev?.personaName ?? "Steam User",
    avatarURL: sessionProfile?.avatarURL ?? prev?.avatarURL,
    discordHandle: sanitizeDiscord(body.discordHandle),
    stats: sanitizeStats(body.stats),
    status: validStatus(body.status),
    note: sanitizeNote(body.note ?? ""),
    inSTS2: false, // populated at read time
    updatedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    roster.entries[idx] = entry;
  } else {
    roster.entries.push(entry);
  }

  // Bound the roster. If we're past the cap, drop whichever existing entry
  // hasn't been refreshed in the longest time. New arrivals can still join,
  // they just push out the most stale row instead of growing forever.
  if (roster.entries.length > MAX_ROSTER_ENTRIES) {
    roster.entries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    roster.entries = roster.entries.slice(0, MAX_ROSTER_ENTRIES);
  }

  await writeRoster(env, roster);
  return entry;
}

export async function deletePresence(env: Env, steamID: string): Promise<void> {
  const roster = pruneStale(await readRoster(env));
  const next = roster.entries.filter((e) => e.steamID !== steamID);
  if (next.length === roster.entries.length) {
    // Nothing to delete and we already paid for the read; skip the write.
    return;
  }
  await writeRoster(env, { entries: next });
}

/**
 * List everyone currently online. Steam-Web-API enrichment is unchanged but
 * is now layered on a single-read roster instead of a list+N-gets fan-out.
 */
export async function listPresence(env: Env): Promise<PresenceEntry[]> {
  const roster = pruneStale(await readRoster(env));
  if (roster.entries.length === 0) return [];

  const inGame = await fetchInGameSet(env, roster.entries.map((e) => e.steamID));
  for (const e of roster.entries) {
    e.inSTS2 = inGame.has(e.steamID);
  }
  return roster.entries;
}

// MARK: - Session profile ----------------------------------------------------

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
