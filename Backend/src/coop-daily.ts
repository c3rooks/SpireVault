/**
 * Daily Co-op Challenge — derives a deterministic seed-of-the-day plus a
 * suggested character and ascension. Every client in the world sees the
 * same daily challenge.
 *
 * Spec: docs/coop-daily-challenge-spec.md
 *
 * The seed is presented as a string the user types into STS2's seed
 * field on character select. We don't enforce it — there's no mod hook
 * — we just promote it everywhere so co-op partners can play the same
 * board on purpose.
 *
 * Deterministic mapping (no KV write needed for the day's challenge —
 * just compute on request):
 *
 *   utcDate          → fnv1a(utcDate)                → uint32
 *   uint32           → base36, padded               → seed string (10–12 chars)
 *   uint32 high bits → index into CHARACTER_POOL
 *   uint32 low bits  → ascension 0..20
 *
 * A separate `coop:daily:joined:<utcDate>` KV blob (set, not consulted
 * for fairness) tracks how many people joined today's challenge for
 * leaderboard display. That's an additive write — never blocks the
 * read.
 */

import type { Env } from "./types";

export interface DailyChallenge {
  /** UTC date string YYYY-MM-DD. */
  date: string;
  /** Seed the user types into STS2's seed field. Base-36 string. */
  seed: string;
  /** Suggested character slug — same set the lobby uses. */
  character: "ironclad" | "silent" | "defect" | "regent" | "necrobinder";
  /** Suggested ascension. 0..20. */
  ascension: number;
  /** ISO8601 of when this challenge expires (next UTC day 00:00). */
  expiresAt: string;
  /** How many distinct hosts posted a lobby for this challenge today. */
  joinedCount?: number;
}

const CHARACTER_POOL: DailyChallenge["character"][] = [
  "ironclad",
  "silent",
  "defect",
  "regent",
  "necrobinder",
];

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str: string): number {
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** UTC date string YYYY-MM-DD for a given timestamp. */
function utcDateString(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Next UTC 00:00 after `now`. */
function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Pure derivation — exported for tests. */
export function deriveChallenge(date: string): Omit<DailyChallenge, "expiresAt" | "joinedCount"> {
  const h = fnv1a(date);
  // Seed: combine the hash with a one-letter day offset so identical
  // date hashes (impossible in practice, but defensive) wouldn't ever
  // collide. Render in base-36, pad to 10 chars.
  const seedNum = (h ^ 0x9e3779b9) >>> 0;
  const seedStr = seedNum.toString(36).padStart(10, "0").toUpperCase();
  // Character: use the top 3 bits of the hash, modulo pool length.
  const character = CHARACTER_POOL[(h >>> 29) % CHARACTER_POOL.length];
  // Ascension: mid bits, mod 21 (0..20 inclusive).
  const ascension = ((h >>> 4) & 0xffff) % 21;
  return { date, seed: seedStr, character, ascension };
}

/** Return today's challenge. No KV reads for the deterministic parts. */
export async function getTodayChallenge(env: Env, now: number = Date.now()): Promise<DailyChallenge> {
  const date = utcDateString(now);
  const expiresAt = new Date(nextUtcMidnight(now)).toISOString();
  const base = deriveChallenge(date);
  const joinedCount = await readJoinedCount(env, date);
  return { ...base, expiresAt, joinedCount };
}

const JOINED_TTL_S = 3 * 24 * 60 * 60; // keep 3 days for late summary reads

function joinedKey(date: string): string {
  return `coop:daily:joined:${date}`;
}

interface JoinedBlob {
  date: string;
  hostSteamIds: string[];
  updatedAt: string;
}

async function readJoined(env: Env, date: string): Promise<JoinedBlob | null> {
  try {
    const raw = await env.LOBBIES.get(joinedKey(date));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as JoinedBlob;
    if (!parsed || !Array.isArray(parsed.hostSteamIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readJoinedCount(env: Env, date: string): Promise<number> {
  const blob = await readJoined(env, date);
  return blob ? blob.hostSteamIds.length : 0;
}

/**
 * Best-effort: record that a host posted a daily-challenge lobby for the
 * given date. Called from coop-engine.ts createLobby when the note carries
 * a `[daily=YYYY-MM-DD]` tag.
 *
 * Idempotent on host Steam ID + date — calling twice with the same host
 * Steam ID for the same date doesn't double-count.
 */
export async function recordDailyJoin(env: Env, date: string, hostSteamId: string): Promise<void> {
  if (!date || !hostSteamId) return;
  try {
    const existing = (await readJoined(env, date)) ?? {
      date,
      hostSteamIds: [],
      updatedAt: new Date().toISOString(),
    };
    if (existing.hostSteamIds.includes(hostSteamId)) return;
    existing.hostSteamIds.push(hostSteamId);
    existing.updatedAt = new Date().toISOString();
    // Cap at 1000 — generous for a single day.
    if (existing.hostSteamIds.length > 1000) {
      existing.hostSteamIds = existing.hostSteamIds.slice(-1000);
    }
    await env.LOBBIES.put(joinedKey(date), JSON.stringify(existing), {
      expirationTtl: JOINED_TTL_S,
    });
  } catch {
    /* swallow */
  }
}

/** Look for a `[daily=YYYY-MM-DD]` tag in lobby note text. */
export function extractDailyTag(note: string | undefined | null): string | null {
  if (typeof note !== "string") return null;
  const m = /\[daily=(\d{4}-\d{2}-\d{2})\]/.exec(note);
  return m ? m[1] : null;
}
