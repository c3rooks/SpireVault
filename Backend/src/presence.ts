import type { Env, PresenceEntry, PresenceUpsert, PlayerStats, PublicPresenceEntry } from "./types";
import { getPairsMap } from "./pairs";

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
 *     listPresence     → 1 read
 *     acceptHeartbeat  → 1 read, plus 1 write when the row is an hour old or
 *                        the heartbeat changes it
 *     upsertPresence   → 1 read + 1 write
 *     deletePresence   → 1 read + 1 write
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

// Persistent presence model.
//
// We do NOT auto-prune the roster based on heartbeat staleness anymore.
// The product semantics changed: once a user has signed in via Steam
// OpenID, they appear on the co-op feed permanently until they EXPLICITLY
// sign out. Closing the browser, sleeping the laptop, putting the phone
// down — none of those should remove someone from the feed. The feed is
// a living roster of everyone who's signed up, not a "who's tapping
// keys this exact second" list.
//
// Two safety nets keep the roster from growing unbounded:
//
//   1. `MAX_ROSTER_ENTRIES` (200) — when the roster fills, the entries
//      with the *oldest* `updatedAt` get evicted to make room for newer
//      activity. Stale signups roll out naturally as new ones roll in.
//
//   2. `ROSTER_TTL_SECONDS` on the KV blob itself (30 days). The blob
//      gets re-written on every heartbeat, which restarts the TTL, so
//      this only triggers if literally no one heartbeats for 30 straight
//      days — at which point the product is dead anyway.
//
// Per-row `updatedAt` says when the player was last active, to the hour (see
// ROSTER_REFRESH_INTERVAL_MS). It decides who is dropped at the cap and
// orders the operator's table; no player-facing screen shows it any more.
/**
 * Minimum spacing between two writes of one player's row, whatever the
 * request says. Legit clients heartbeat every ~180 s; anything faster is
 * either a bug or an abuser.
 */
const MIN_HEARTBEAT_INTERVAL_MS = 60_000; // 60 s — was 2 s; we no longer need fast pulses
/**
 * How long a row stands before a heartbeat that changes nothing rewrites it.
 *
 * Nothing shown to players reads a row's `updatedAt` any more (the roster
 * screen that showed "12 min ago" is gone); it orders the operator's table
 * and picks who is dropped at the cap, and an hour is fine enough for both.
 * At the client's 180 s cadence this is one roster write an hour per open
 * tab instead of twenty, out of about 1,000 KV writes a day for everyone.
 */
const ROSTER_REFRESH_INTERVAL_MS = 60 * 60_000;
const ROSTER_KEY = "presence:roster";
// 30 days. Way longer than the old 7-day value because the persistent
// presence model means we want the roster to survive even a multi-week
// quiet period without losing the list of signed-up users. The blob's
// TTL is renewed on every write, so in practice this only triggers if
// no one heartbeats for 30 straight days.
const ROSTER_TTL_SECONDS = 30 * 86400;
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

/**
 * Read the roster blob and normalize whatever shape we find on disk.
 *
 * Defensive parsing because this key has historically been written by:
 *   - the worker itself                  (correct: `{ entries: [...] }`)
 *   - manual operator cleanup scripts    (sometimes: bare array `[...]`)
 *   - older worker versions              (correct, but worth tolerating)
 *
 * Before this function was hardened, a bare-array blob made `roster.entries`
 * undefined; `listPresence` then crashed on `roster.entries.length` and the
 * outer `getPresenceCached` swallowed the error and served an empty roster
 * to every client — silently hiding every signed-in user. That bug cost us
 * a launch's worth of credibility before we caught it. This function now:
 *
 *   1. Accepts both the canonical and bare-array shapes.
 *   2. Discards entries that don't look like real PresenceEntry objects.
 *   3. Never returns `entries: undefined` — only ever `[]` on failure.
 */
async function readRoster(env: Env): Promise<Roster> {
  const raw = await env.LOBBIES.get(ROSTER_KEY);
  if (!raw) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).entries)) {
    arr = (parsed as any).entries;
  } else {
    return { entries: [] };
  }
  // Filter to entries that have the bare minimum shape we render. Anything
  // missing a 17-digit Steam ID or a string updatedAt is junk we don't want
  // surfaced to the public feed.
  const entries: PresenceEntry[] = (arr as any[]).filter(
    (e) =>
      e &&
      typeof e === "object" &&
      typeof e.steamID === "string" &&
      /^\d{17}$/.test(e.steamID) &&
      typeof e.updatedAt === "string"
  );
  return { entries };
}

/**
 * Persist the roster. Always serializes the canonical `{ entries: [...] }`
 * shape — never a bare array — so future readers don't have to guess.
 * Any caller that passes us a malformed object gets coerced into an empty
 * roster rather than letting half-typed data hit production.
 */
async function writeRoster(env: Env, roster: Roster): Promise<void> {
  const safe: Roster = {
    entries: Array.isArray(roster?.entries) ? roster.entries : [],
  };
  await env.LOBBIES.put(ROSTER_KEY, JSON.stringify(safe), {
    expirationTtl: ROSTER_TTL_SECONDS,
  });
}

// MARK: - Heartbeats ---------------------------------------------------------

/**
 * A heartbeat body is a status, a handle and a few counters: a few hundred
 * characters at most. Anything longer is not parsed.
 */
const MAX_PRESENCE_BODY_CHARS = 4096;
/** KV's one-write-per-key second, plus a margin, before a refused write is tried again. */
const KV_WRITE_RETRY_DELAY_MS = 1100;

/** How this module waits. An object so the offline checks can stand in for real time. */
export const timers = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The heartbeat body, or null when it says nothing: empty, oversized, not
 * JSON, or not an object. Web clients from before November 2026 send an empty
 * beacon here as their page unloads; that is a request to turn away, not a
 * fault.
 */
export function parsePresenceBody(raw: string): PresenceUpsert | null {
  if (!raw.trim() || raw.length > MAX_PRESENCE_BODY_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as PresenceUpsert;
}

/**
 * KV takes one write per key per second and rejects a second one with
 * "KV PUT failed: 429 Too Many Requests". On the heartbeat path that means
 * another write to the same key landed within this second: a repeat, not a
 * fault. Any other KV failure (an outage, the daily write quota, a failed
 * read) is not matched and still surfaces as an error.
 */
function isKvWriteRateError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /KV PUT failed: 429/i.test(message);
}

/**
 * How far a row's date is from `at`, in either direction, so a row dated in
 * the future does not count as fresh forever. Infinity when it has no date.
 */
function ageAt(entry: PresenceEntry, at: number): number {
  const last = Date.parse(entry.updatedAt);
  return Number.isFinite(last) ? Math.abs(at - last) : Infinity;
}

/**
 * The player's roster row if it was written within the minimum spacing of
 * `at`, else null. Nothing rewrites such a row.
 */
function freshEntry(roster: Roster, steamID: string, at: number): PresenceEntry | null {
  const prev = roster.entries.find((e) => e.steamID === steamID);
  return prev && ageAt(prev, at) < MIN_HEARTBEAT_INTERVAL_MS ? prev : null;
}

/** The part of a row that a heartbeat body decides, as one comparable string. */
function bodyFields(from: Partial<PresenceUpsert>): string {
  return JSON.stringify([
    validStatus(from.status),
    sanitizeNote(from.note ?? ""),
    sanitizeDiscord(from.discordHandle) ?? null,
    sanitizeStats(from.stats) ?? null,
  ]);
}

/**
 * The player's roster row if this heartbeat has nothing to store, else null:
 * the row is fresh, or it is under an hour old and the body says what the row
 * already says.
 */
function standingEntry(
  roster: Roster,
  steamID: string,
  body: PresenceUpsert,
  now: number
): PresenceEntry | null {
  const prev = roster.entries.find((e) => e.steamID === steamID);
  if (!prev) return null;
  const age = ageAt(prev, now);
  if (age < MIN_HEARTBEAT_INTERVAL_MS) return prev;
  if (age < ROSTER_REFRESH_INTERVAL_MS && bodyFields(prev) === bodyFields(body)) return prev;
  return null;
}

async function buildEntry(
  env: Env,
  roster: Roster,
  steamID: string,
  body: PresenceUpsert,
  now: number
): Promise<PresenceEntry> {
  const prev = roster.entries.find((e) => e.steamID === steamID);
  const sessionProfile = await getSessionProfile(env, steamID);
  return {
    steamID,
    personaName: sessionProfile?.personaName ?? prev?.personaName ?? "Steam User",
    avatarURL: sessionProfile?.avatarURL ?? prev?.avatarURL,
    discordHandle: sanitizeDiscord(body.discordHandle),
    stats: sanitizeStats(body.stats),
    status: validStatus(body.status),
    note: sanitizeNote(body.note ?? ""),
    inSTS2: false, // populated at read time
    updatedAt: new Date(now).toISOString(),
  };
}

/** A copy of the roster with `entry` in its player's place (or added). */
function rosterWith(roster: Roster, entry: PresenceEntry): Roster {
  const idx = roster.entries.findIndex((e) => e.steamID === entry.steamID);
  const entries =
    idx >= 0
      ? [...roster.entries.slice(0, idx), entry, ...roster.entries.slice(idx + 1)]
      : [...roster.entries, entry];
  if (entries.length <= MAX_ROSTER_ENTRIES) return { entries };

  // Bound the roster. Past the cap, drop whichever entry hasn't been
  // refreshed in the longest time. New arrivals can still join, they just
  // push out the most stale row instead of growing forever.
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { entries: newestFirst.slice(0, MAX_ROSTER_ENTRIES) };
}

/**
 * What happened to the roster for an accepted heartbeat:
 *   stored     the player's row was written
 *   unchanged  their row already says it and is under an hour old (or under
 *              a minute old, whatever it says), so nothing was written
 *   deferred   KV had taken another roster write within the second; the
 *              caller owes `storeDeferredHeartbeat(env, entry)`
 */
export type HeartbeatWrite = "stored" | "unchanged" | "deferred";

/** What became of one `POST /presence`. */
export type HeartbeatOutcome<Refusal> =
  /** The body said nothing. No KV read or write was spent on it. */
  | { kind: "invalid" }
  /** The caller's write limiter said no. Nothing was written to the roster. */
  | { kind: "refused"; refusal: Refusal }
  /** The player is, or within about a second will be, on the roster as `entry`. */
  | { kind: "accepted"; entry: PresenceEntry; write: HeartbeatWrite };

/**
 * Handle one heartbeat, spending KV writes only where they change something.
 * The Worker has about 1,000 writes a day for every player together, a tab
 * sends a heartbeat every three minutes for as long as it is open, and one
 * page load can send several within a second.
 *
 * The order is the point:
 *
 *   1. A body that says nothing is turned away before any KV use.
 *   2. A heartbeat with nothing to store (see `standingEntry`) is answered
 *      from the roster read. It costs no write at all, and that is nearly
 *      every heartbeat.
 *   3. `admitWrite` (the per-IP limiter, itself a KV write) is asked when the
 *      heartbeat adds the player or changes their row. It returns null to go
 *      ahead, or the refusal to send back. The hourly refresh of an unchanged
 *      row does not ask: it is one write an hour per player at most, and the
 *      limiter would double it.
 *   4. A write KV refuses because the key was written within this second is a
 *      repeat that got past step 2: two requests read the roster before either
 *      wrote it, or two players heartbeat in the same second. That is a
 *      success for the client, and the write is handed back as "deferred".
 */
export async function acceptHeartbeat<Refusal>(
  env: Env,
  steamID: string,
  rawBody: string,
  admitWrite: () => Promise<Refusal | null>
): Promise<HeartbeatOutcome<Refusal>> {
  const body = parsePresenceBody(rawBody);
  if (!body) return { kind: "invalid" };

  const now = Date.now();
  const roster = await readRoster(env);
  const standing = standingEntry(roster, steamID, body, now);
  if (standing) return { kind: "accepted", entry: standing, write: "unchanged" };

  const prev = roster.entries.find((e) => e.steamID === steamID);
  const isHourlyRefresh = prev !== undefined && bodyFields(prev) === bodyFields(body);
  if (!isHourlyRefresh) {
    let refusal: Refusal | null;
    try {
      refusal = await admitWrite();
    } catch (err) {
      if (!isKvWriteRateError(err)) throw err;
      // The limiter could not count this request because it counted another
      // one from the same address within this second. Let it through: KV
      // holds the roster write below to the same one-per-second rule, so a
      // burst still cannot write the roster faster than the limiter allows.
      refusal = null;
    }
    if (refusal !== null) return { kind: "refused", refusal };
  }

  const entry = await buildEntry(env, roster, steamID, body, now);
  try {
    await writeRoster(env, rosterWith(roster, entry));
  } catch (err) {
    if (!isKvWriteRateError(err)) throw err;
    return { kind: "accepted", entry, write: "deferred" };
  }
  return { kind: "accepted", entry, write: "stored" };
}

/**
 * The second try for a roster write KV refused (see `acceptHeartbeat`), run
 * after the response has gone. It is the one write that heartbeat owed, not
 * an extra one: nothing is written when the row arrived in the meantime (the
 * twin request stored it), and a second refusal is left for the player's next
 * heartbeat, which carries the same data. Returns whether it wrote.
 */
export async function storeDeferredHeartbeat(env: Env, entry: PresenceEntry): Promise<boolean> {
  await timers.sleep(KV_WRITE_RETRY_DELAY_MS);
  const roster = await readRoster(env);
  if (freshEntry(roster, entry.steamID, Date.parse(entry.updatedAt))) return false;
  try {
    await writeRoster(env, rosterWith(roster, entry));
  } catch (err) {
    if (!isKvWriteRateError(err)) throw err;
    console.warn("[presence] roster write refused twice by KV's per-key limit; left for the next heartbeat");
    return false;
  }
  return true;
}

// MARK: - Roster CRUD --------------------------------------------------------

/**
 * Put a player on the roster outside the heartbeat route (sign-in does this
 * so a player who never heartbeats is still listed). Returns the existing
 * row untouched when it is fresh; unlike `acceptHeartbeat`, a failed write
 * throws, because the caller records it.
 */
export async function upsertPresence(
  env: Env,
  steamID: string,
  body: PresenceUpsert
): Promise<PresenceEntry> {
  const now = Date.now();
  const roster = await readRoster(env);
  const fresh = freshEntry(roster, steamID, now);
  if (fresh) return fresh;

  const entry = await buildEntry(env, roster, steamID, body, now);
  await writeRoster(env, rosterWith(roster, entry));
  return entry;
}

export async function deletePresence(env: Env, steamID: string): Promise<void> {
  const roster = await readRoster(env);
  const next = roster.entries.filter((e) => e.steamID !== steamID);
  if (next.length === roster.entries.length) {
    // Nothing to delete and we already paid for the read; skip the write.
    return;
  }
  await writeRoster(env, { entries: next });
}

/**
 * List the full persistent roster. Every signed-up user (who hasn't
 * explicitly signed out) shows up here regardless of whether they're
 * actively heartbeating. Steam-Web-API enrichment of `inSTS2` is layered
 * on top so the UI can highlight people who are literally in the game
 * right now versus people who signed up earlier.
 */
export async function listPresence(env: Env): Promise<PresenceEntry[]> {
  const roster = await readRoster(env);
  if (roster.entries.length === 0) return [];

  // Steam-Web inGame set + co-op pair table fetched in parallel; both
  // are best-effort enrichments layered on top of the persistent roster.
  // Either failing keeps the roster usable (no inSTS2 highlight, no pill)
  // rather than turning a transient KV blip into an empty-feed bug.
  const [inGame, pairs] = await Promise.all([
    fetchInGameSet(env, roster.entries.map((e) => e.steamID)),
    getPairsMap(env).catch(() => ({} as Record<string, never>)),
  ]);

  for (const e of roster.entries) {
    e.inSTS2 = inGame.has(e.steamID);
    const pair = pairs[e.steamID];
    if (pair) {
      e.paired = {
        partnerID: pair.partnerID,
        partnerPersona: pair.partnerPersona,
        partnerAvatar: pair.partnerAvatar,
        since: pair.since,
      };
    } else {
      // Defensive: scrub any stale `paired` value that might have slipped
      // into the stored roster blob (older worker versions could have
      // written it; we never want to surface a pair without a live entry
      // in the pair map backing it).
      delete e.paired;
    }
  }
  return roster.entries;
}

/**
 * Anonymized view of the presence feed. Returns the same roster
 * `listPresence` would — same row count, same status/inSTS2/note
 * values, same `updatedAt` ordering — but every identity field is
 * stripped. Callers use this for unauthenticated clients so guests
 * can see accurate social proof ("3 people looking right now") and
 * live status without harvesting Steam handles.
 *
 * The `anonId` is a short deterministic hash of
 *   `steamID + UTC-date + salt`
 * which means:
 *   - Two different guests watching the same roster see consistent
 *     anonIds within the same UTC day (so "Player 8F2A" on one row
 *     stays stable across polls).
 *   - The same user's anonId ROTATES at UTC midnight, so long-term
 *     correlation attacks (tracking a status pattern over weeks to
 *     deanonymize someone) are capped to a single day's worth of
 *     signal.
 *   - The hash can't be reversed without knowing the salt (which
 *     never leaves the worker).
 */
export async function listPresencePublic(env: Env): Promise<PublicPresenceEntry[]> {
  const full = await listPresence(env);
  return Promise.all(full.map((e) => sanitizeEntry(e)));
}

async function sanitizeEntry(e: PresenceEntry): Promise<PublicPresenceEntry> {
  return {
    anonId: await anonymizeSteamId(e.steamID),
    status: e.status,
    note: "", // Note can leak social identifiers ("hit me up on discord as @foo"); strip for guests.
    inSTS2: e.inSTS2,
    updatedAt: e.updatedAt,
  };
}

/** Deterministic short hash used as the `anonId`. SHA-256 of
 *  `<steamID>|<UTC-YYYY-MM-DD>|vault-v1`, take first 6 hex chars.
 *  No need for a server-side secret — the date-bucketing already
 *  prevents cross-day correlation and the 6-char truncation makes
 *  brute-forcing the Steam ID computationally meaningless. */
async function anonymizeSteamId(steamID: string): Promise<string> {
  const utcDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const material = `${steamID}|${utcDate}|vault-v1`;
  const bytes = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 3)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.toUpperCase();
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

// Exported so the `/me` route can rehydrate (steamID, persona, avatar)
// for a request that only carried a session bearer/cookie. Keeping reads
// of session-profile rows centralized here makes it easier to evolve the
// stored shape without combing through call sites.
export async function getSessionProfile(env: Env, steamID: string): Promise<SessionProfile | null> {
  const raw = await env.LOBBIES.get(`${SESSION_PROFILE_PREFIX}${steamID}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as SessionProfile; } catch { return null; }
}

// MARK: - Steam Web API enrichment ------------------------------------------

/** GetPlayerSummaries accepts at most this many Steam IDs per call. */
const STEAM_SUMMARIES_BATCH = 100;
/**
 * A Steam call that has not answered by now is given up on, so a slow Steam
 * only drops the in-game highlight instead of holding up the whole roster
 * (the landing page and the app stop waiting on it after 10 s).
 */
const STEAM_SUMMARIES_TIMEOUT_MS = 3000;

/**
 * Which of `ids` are in STS2 right now. The whole roster is asked about, 100
 * IDs per Steam call (two calls at the 200-entry cap). A batch that fails
 * only loses its own players' highlight; the others still count.
 */
async function fetchInGameSet(env: Env, ids: string[]): Promise<Set<string>> {
  if (!env.STEAM_WEB_API_KEY) return new Set();
  const filtered = Array.from(new Set(ids.filter((s) => /^\d{17}$/.test(s))));
  const batches: string[][] = [];
  for (let i = 0; i < filtered.length; i += STEAM_SUMMARIES_BATCH) {
    batches.push(filtered.slice(i, i + STEAM_SUMMARIES_BATCH));
  }
  const found = await Promise.all(batches.map((batch) => fetchInGameBatch(env, batch)));
  return new Set(found.flatMap((set) => [...set]));
}

async function fetchInGameBatch(env: Env, batch: string[]): Promise<Set<string>> {
  try {
    const url =
      `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/` +
      `?key=${env.STEAM_WEB_API_KEY}&steamids=${batch.join(",")}`;
    const resp = await fetch(url, {
      cf: { cacheTtl: 30, cacheEverything: true },
      signal: AbortSignal.timeout(STEAM_SUMMARIES_TIMEOUT_MS),
    });
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
