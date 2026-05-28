/**
 * Discord LFG Mirror — storage + lifecycle for "ephemeral lobbies"
 * that originated as a message in an approved Discord channel.
 *
 * Why mirrored lobbies are a SEPARATE namespace from native co-op
 * lobbies:
 *
 *   - Native lobbies have a host with a Steam session, a party
 *     state machine, presence heartbeats, KV writes per state poll,
 *     and full reputation/ready-up wiring. Mirrors are just a
 *     pointer to an external Discord post — joining a mirror means
 *     "open the Discord message", not "enter a party state."
 *
 *   - Native lobbies must reconcile with `/coop/state` for every
 *     signed-in user, every 15s. If we mixed mirrors in, every
 *     join-decline-heartbeat path would need a `if mirror skip`
 *     branch. Cleaner to keep mirrors out of the engine entirely.
 *
 *   - The lifecycle is different. Native lobbies expire when the
 *     host stops heartbeating. Mirrors expire 30 minutes after the
 *     Discord message was posted (LFG posts are ephemeral by
 *     custom — nobody honors a "starting in 30 min" message that's
 *     45 minutes old).
 *
 *   - Listing endpoint is PUBLIC (no auth). The mirror list is
 *     intentionally observable so signed-out visitors landing on
 *     the empty lobby page see real activity from the bridged
 *     Discord channel and bounce less.
 *
 * Storage shape:
 *
 *   mirror:lobby:<mirrorId>           → MirroredLobby JSON, TTL ~30min
 *   mirror:dedup:<discordMessageId>   → mirrorId, TTL same as above
 *   mirror:index                      → string[] of active mirrorIds
 *
 * KV used: same `LOBBIES` binding as native co-op (separate prefix).
 *
 * Anti-abuse:
 *   - Per-message dedup so a bot replay can't double-create
 *   - Per-channel rate limit at the routes layer (handled in
 *     coop-routes.ts, not here)
 *   - Author Steam ID is OPTIONAL and not trusted — the only
 *     trusted identity is the Discord bot's shared secret + the
 *     Discord interactions Ed25519 signature
 *
 * Schema versioning: bump `schemaVersion` on any field shape change
 * so old mirrors written before a deploy still parse safely.
 */

import type { Env } from "./types";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface MirroredLobbyHints {
  /** Parsed STS2 ascension level if the message text mentions one. */
  ascension?: number;
  /** "need 1" → 1; absent if the message doesn't say. */
  seatsWanted?: number;
  /** Lowercased character slugs found in the text. */
  characters?: string[];
  /** "voice", "no-voice", or "optional" if message hints at voice state. */
  voiceState?: "voice" | "no-voice" | "optional";
  /** Daily challenge tag like `[daily=2026-05-26]` if present. */
  daily?: string;
}

export interface MirroredLobby {
  /** Internal SpireVault id (ulid-ish). */
  mirrorId: string;

  /** Identifying the source Discord message + server. */
  discordMessageId: string;
  discordChannelId: string;
  discordChannelName: string;
  discordGuildId: string;
  discordGuildName: string;
  /** Direct https link to the message (Discord's "Copy Message Link"). */
  discordJumpUrl: string;

  /** Discord author identity (display only, never trusted). */
  authorName: string;
  authorAvatarUrl?: string;

  /** Sanitized message text, truncated. */
  rawMessage: string;

  /** Heuristically-parsed LFG hints to power filters / display chips. */
  parsedHints: MirroredLobbyHints;

  postedAt: string;
  expiresAt: string;

  /** Hard-coded 1 for the first ship. Bump on shape change. */
  schemaVersion: 1;
}

export interface CreateMirrorInput {
  discordMessageId: string;
  discordChannelId: string;
  discordChannelName: string;
  discordGuildId: string;
  discordGuildName: string;
  discordJumpUrl: string;
  authorName: string;
  authorAvatarUrl?: string;
  rawMessage: string;
  /** Override TTL in seconds. Defaults to 30 min. */
  ttlSeconds?: number;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const MIRROR_PREFIX = "mirror:lobby:";
const MIRROR_DEDUP_PREFIX = "mirror:dedup:";
const MIRROR_INDEX_KEY = "mirror:index";
const MIRROR_DEFAULT_TTL_S = 30 * 60;
const MIRROR_INDEX_TTL_S = 24 * 60 * 60; // index sweeps daily
const MIRROR_MESSAGE_MAX = 280;
const MIRROR_INDEX_HARD_CAP = 500;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Create a mirrored lobby from a Discord message. If a mirror already
 * exists for the same message (dedup), return that mirror instead so
 * the bot can re-invoke the command idempotently.
 */
export async function createMirror(
  env: Env,
  input: CreateMirrorInput,
): Promise<MirroredLobby> {
  // Dedup — return the existing mirror if this Discord message has
  // already been mirrored. The bot calls this on every interaction
  // so the operation has to be idempotent.
  const existingId = await readDedup(env, input.discordMessageId);
  if (existingId) {
    const existing = await readMirror(env, existingId);
    if (existing) return existing;
    // Dedup stale; fall through and create fresh.
    await deleteDedup(env, input.discordMessageId);
  }

  const mirrorId = generateMirrorId();
  const ttl = Math.max(60, input.ttlSeconds ?? MIRROR_DEFAULT_TTL_S);
  const now = Date.now();
  const lobby: MirroredLobby = {
    mirrorId,
    discordMessageId: input.discordMessageId,
    discordChannelId: input.discordChannelId,
    discordChannelName: input.discordChannelName,
    discordGuildId: input.discordGuildId,
    discordGuildName: input.discordGuildName,
    discordJumpUrl: input.discordJumpUrl,
    authorName: sanitizeShort(input.authorName, 64) || "Discord user",
    authorAvatarUrl: input.authorAvatarUrl,
    rawMessage: sanitizeShort(input.rawMessage, MIRROR_MESSAGE_MAX),
    parsedHints: parseHints(input.rawMessage),
    postedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    schemaVersion: 1,
  };

  await Promise.all([
    putJSON(env, MIRROR_PREFIX + mirrorId, lobby, ttl),
    putJSON(env, MIRROR_DEDUP_PREFIX + input.discordMessageId, { mirrorId }, ttl),
  ]);
  await appendIndex(env, mirrorId);
  return lobby;
}

/** Read a single mirror by id. Returns null if expired/missing. */
export async function readMirror(
  env: Env,
  mirrorId: string,
): Promise<MirroredLobby | null> {
  return getJSON<MirroredLobby>(env, MIRROR_PREFIX + mirrorId);
}

/**
 * List all live mirrors. Sweeps the index of any expired entries
 * inline so a long-running deploy doesn't grow the index forever.
 */
export async function listMirrors(env: Env): Promise<MirroredLobby[]> {
  const ids = await readIndex(env);
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readMirror(env, id)));
  const live: MirroredLobby[] = [];
  const liveIds: string[] = [];
  const nowMs = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const exp = Date.parse(row.expiresAt);
    if (Number.isFinite(exp) && exp < nowMs) continue;
    live.push(row);
    liveIds.push(ids[i]!);
  }
  if (liveIds.length !== ids.length) {
    await writeIndex(env, liveIds);
  }
  // Sort soonest-expiring first so frontend can render them in
  // urgency order without needing its own sort.
  live.sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  return live.reverse(); // newest posts first feels right
}

/**
 * Delete a mirror (called by the bot when the source Discord message
 * is deleted, or by a mod to revoke). Idempotent.
 */
export async function deleteMirror(
  env: Env,
  mirrorId: string,
): Promise<void> {
  const existing = await readMirror(env, mirrorId);
  await del(env, MIRROR_PREFIX + mirrorId);
  if (existing) {
    await del(env, MIRROR_DEDUP_PREFIX + existing.discordMessageId);
  }
  await removeFromIndex(env, mirrorId);
}

// ────────────────────────────────────────────────────────────────────
// Heuristic LFG message parsing
// ────────────────────────────────────────────────────────────────────

/**
 * Pull common LFG hints out of a Discord message. Defensive: returns
 * an empty hints object on any parse failure rather than throwing.
 *
 * Examples (drawn from real `#sts2-lets-play-together` traffic):
 *
 *   "LFG 3 need 1 A10"                  → seats=1, ascension=10
 *   "A0-A10 all welcome"                → (ambiguous range; leave blank)
 *   "Duos Any A / Please Be Chill"      → seats=1 (duo=2 minus self)
 *   "A3 no VC: steam://joinlobby/..."   → ascension=3, voiceState=no-voice
 *   "anyone wanna run a10 silent vc"    → ascension=10, characters=[silent], voiceState=voice
 *
 * We're intentionally CONSERVATIVE — a missing hint is fine; a wrong
 * hint shows misinformation on the lobby card. So we only parse the
 * patterns with high precision and skip everything else.
 */
export function parseHints(text: string): MirroredLobbyHints {
  if (typeof text !== "string" || text.length === 0) return {};
  const lc = text.toLowerCase();
  const out: MirroredLobbyHints = {};

  // Ascension: "a10", "A10", "ascension 10", but NOT "A0-A10" (range).
  // Use a negative lookahead to skip ranges.
  const ascMatch = lc.match(/\ba(\d{1,2})(?!\s*[-\u2013]\s*a?\d)/);
  if (ascMatch) {
    const n = Number(ascMatch[1]);
    if (n >= 0 && n <= 20) out.ascension = n;
  }
  // "ascension 10" / "asc 10" — also valid.
  if (out.ascension === undefined) {
    const asc2 = lc.match(/\basc(?:ension)?\s+(\d{1,2})\b/);
    if (asc2) {
      const n = Number(asc2[1]);
      if (n >= 0 && n <= 20) out.ascension = n;
    }
  }

  // Seats wanted: "need 1", "need 2", "1 more", "2 more", "+1", "+2".
  // Cap at 3 (party is 4 total in STS2 co-op so 3 is the max
  // openable for a 1-seat host).
  let seats: number | undefined;
  const needMatch = lc.match(/\bneed\s*(\d)\b/);
  if (needMatch) seats = Number(needMatch[1]);
  if (seats === undefined) {
    const moreMatch = lc.match(/\b(\d)\s*more\b/);
    if (moreMatch) seats = Number(moreMatch[1]);
  }
  if (seats === undefined) {
    const plusMatch = lc.match(/(?:^|\s)\+(\d)\b/);
    if (plusMatch) seats = Number(plusMatch[1]);
  }
  // "duos any a" → 1 more wanted to fill a duo of 2 (self + 1).
  if (seats === undefined && /\bduos?\b/.test(lc)) seats = 1;
  // "trio" → 2 more (self + 2).
  if (seats === undefined && /\btrios?\b/.test(lc)) seats = 2;
  if (seats !== undefined && seats >= 1 && seats <= 3) out.seatsWanted = seats;

  // Voice state — be CONSERVATIVE; only set if explicit.
  if (/\bno\s*v\.?c\.?\b|\bno\s*vc\b|\bno[-\s]?voice\b|\bno\s*mic\b/.test(lc)) {
    out.voiceState = "no-voice";
  } else if (/\bvoice\s*optional\b|\bmic\s*optional\b|\bvc\s*optional\b/.test(lc)) {
    out.voiceState = "optional";
  } else if (/\bvc\b|\bvoice\b|\bmic\b/.test(lc) && !/\bno\b/.test(lc.slice(0, 20))) {
    // "VC required" / "voice req" — but only mark as voice if the
    // first 20 chars don't have a "no" qualifier (already handled
    // above but defensive).
    out.voiceState = "voice";
  }

  // Characters — match any of the 5 STS2 class names.
  const charSet = new Set<string>();
  if (/\bironclad\b|\bic\b/.test(lc)) charSet.add("ironclad");
  if (/\bsilent\b|\bsi\b/.test(lc)) charSet.add("silent");
  if (/\bdefect\b|\bdf\b/.test(lc)) charSet.add("defect");
  if (/\bregent\b/.test(lc)) charSet.add("regent");
  if (/\bnecro(?:binder)?\b|\bnb\b/.test(lc)) charSet.add("necrobinder");
  if (charSet.size > 0) out.characters = Array.from(charSet);

  // Daily challenge tag: case-insensitive, ISO date.
  const dailyMatch = text.match(/\[daily=(\d{4}-\d{2}-\d{2})\]/i);
  if (dailyMatch) out.daily = dailyMatch[1]!;

  return out;
}

// ────────────────────────────────────────────────────────────────────
// Storage helpers — private to this module
// ────────────────────────────────────────────────────────────────────

async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  const v = await env.LOBBIES.get(key, { type: "json" });
  return (v as T | null) ?? null;
}

async function putJSON(
  env: Env,
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  await env.LOBBIES.put(key, JSON.stringify(value), {
    expirationTtl: Math.max(60, ttlSeconds),
  });
}

async function del(env: Env, key: string): Promise<void> {
  await env.LOBBIES.delete(key);
}

async function readDedup(env: Env, discordMessageId: string): Promise<string | null> {
  const blob = await getJSON<{ mirrorId: string }>(
    env,
    MIRROR_DEDUP_PREFIX + discordMessageId,
  );
  return blob && typeof blob.mirrorId === "string" ? blob.mirrorId : null;
}

async function deleteDedup(env: Env, discordMessageId: string): Promise<void> {
  await del(env, MIRROR_DEDUP_PREFIX + discordMessageId);
}

async function readIndex(env: Env): Promise<string[]> {
  const blob = await getJSON<{ ids: string[] }>(env, MIRROR_INDEX_KEY);
  if (!blob || !Array.isArray(blob.ids)) return [];
  return blob.ids.filter((s) => typeof s === "string");
}

async function writeIndex(env: Env, ids: string[]): Promise<void> {
  // Trim to hard cap, newest-first (we append to the END so newest
  // are LAST; slice from the tail).
  const trimmed = ids.length > MIRROR_INDEX_HARD_CAP
    ? ids.slice(-MIRROR_INDEX_HARD_CAP)
    : ids;
  await putJSON(env, MIRROR_INDEX_KEY, { ids: trimmed }, MIRROR_INDEX_TTL_S);
}

async function appendIndex(env: Env, mirrorId: string): Promise<void> {
  const ids = await readIndex(env);
  if (ids.includes(mirrorId)) return;
  ids.push(mirrorId);
  await writeIndex(env, ids);
}

async function removeFromIndex(env: Env, mirrorId: string): Promise<void> {
  const ids = await readIndex(env);
  const idx = ids.indexOf(mirrorId);
  if (idx < 0) return;
  ids.splice(idx, 1);
  await writeIndex(env, ids);
}

// ────────────────────────────────────────────────────────────────────
// Utility — id generation + sanitization
// ────────────────────────────────────────────────────────────────────

function generateMirrorId(): string {
  // 16 random bytes → base32-ish ulid-shaped string. Not a real
  // ulid (we don't need time-sortable across instances; the index
  // gives us order). Just unique enough.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return "m_" + out;
}

/**
 * Strip control chars, collapse whitespace, hard-cap length.
 * Discord message text can contain arbitrary unicode including
 * RTL override / zero-width chars; we keep the user-readable parts
 * and trim hostile control codes.
 */
function sanitizeShort(input: string, maxLen: number): string {
  if (typeof input !== "string") return "";
  let s = input
    // Drop C0/C1 control chars except newline/tab.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
    // Collapse zero-width / RTL override / direction marks.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    // Collapse runs of whitespace.
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "\u2026";
  return s;
}
