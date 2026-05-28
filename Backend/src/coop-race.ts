/**
 * Daily Race Mode — async ghost racing on the shared daily seed.
 *
 * The Daily Co-op Challenge already exists (see coop-daily.ts). What
 * was missing: a way for players to race the same seed and compare
 * full runs side-by-side after the fact. This module captures every
 * completed Daily Challenge run as a "ghost" — a compact deck/floor/
 * timing trace anyone can inspect.
 *
 * Why this exists:
 *
 *   STS speedrunners and the streamer audience have been asking for
 *   a "what would my run have looked like vs the top runner at floor
 *   12" comparison since STS1 launched. No tool has shipped it well.
 *   With the Daily Challenge giving us a shared seed and the Companion
 *   mod giving us a real-time deck stream, async ghost racing falls
 *   out almost for free — the data is already flowing.
 *
 * Storage:
 *
 *   race:<dateKey>:<runId>     → RaceGhost JSON (TTL 7 days)
 *   race:index:<dateKey>       → list of run ids for that day
 *
 *   dateKey is YYYY-MM-DD UTC, matching coop-daily.ts.
 *
 * Privacy:
 *
 *   We store personaName + avatar + deck. No private chats, no Steam
 *   IDs in the public payload (server-side row keys do, but the
 *   public list strips them). Same posture as community highlights.
 */

import type { Env } from "./types";

export interface RaceGhostMilestone {
  /** Floor reached at this checkpoint. */
  floor: number;
  /** Wall-clock seconds elapsed since run start. */
  elapsedSec: number;
  /** HP at this floor. */
  hp: number;
  /** Compact deck snapshot — top 8 cards by upgrade level. */
  deckSize: number;
  topCards: string[];
}

export interface RaceGhost {
  schemaVersion: 1;
  runId: string;
  dateKey: string; // YYYY-MM-DD UTC
  hostSteamId: string;
  hostPersonaName: string;
  hostAvatarUrl?: string;
  characterId: string;
  ascension: number;

  /** "victory" | "death" | "abandoned". */
  status: "victory" | "death" | "abandoned";
  /** Floor reached on death/end. */
  endFloor: number;
  /** Total wall-clock seconds. */
  totalSec: number;
  /** Checkpoints — we keep one per floor up to the cap. */
  milestones: RaceGhostMilestone[];

  submittedAt: string;
}

const RACE_PREFIX = "race:";
const RACE_INDEX_PREFIX = "race:index:";
const RACE_TTL_S = 7 * 24 * 60 * 60;
const INDEX_TTL_S = 7 * 24 * 60 * 60;
const INDEX_MAX_PER_DAY = 500;

const STEAM_ID_RE = /^\d{17}$/;
const RUN_ID_RE = /^[A-Z0-9_-]{6,40}$/i;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface SubmitRaceGhostInput {
  runId: string;
  dateKey: string;
  characterId: string;
  ascension: number;
  status: "victory" | "death" | "abandoned";
  endFloor: number;
  totalSec: number;
  milestones?: RaceGhostMilestone[];
}

export async function submitRaceGhost(
  env: Env,
  hostSteamId: string,
  personaName: string,
  avatarUrl: string | undefined,
  body: SubmitRaceGhostInput,
): Promise<{ ok: true; ghost: RaceGhost } | { ok: false; status: number; error: string; message: string }> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body", message: "Missing JSON body." };
  }
  if (typeof body.runId !== "string" || !RUN_ID_RE.test(body.runId)) {
    return { ok: false, status: 400, error: "invalid_run_id", message: "Bad runId." };
  }
  if (typeof body.dateKey !== "string" || !DATE_KEY_RE.test(body.dateKey)) {
    return { ok: false, status: 400, error: "invalid_date", message: "dateKey must be YYYY-MM-DD." };
  }

  const ghost: RaceGhost = {
    schemaVersion: 1,
    runId: body.runId,
    dateKey: body.dateKey,
    hostSteamId,
    hostPersonaName: personaName.slice(0, 64),
    hostAvatarUrl: avatarUrl,
    characterId: String(body.characterId ?? "").slice(0, 24).toLowerCase(),
    ascension: clampInt(body.ascension, 0, 20),
    status: body.status === "victory" || body.status === "death" || body.status === "abandoned" ? body.status : "abandoned",
    endFloor: clampInt(body.endFloor, 0, 100),
    totalSec: Math.max(0, Math.min(60 * 60 * 6, Math.floor(body.totalSec))),
    milestones: Array.isArray(body.milestones)
      ? body.milestones.slice(0, 60).map(validateMilestone).filter((m): m is RaceGhostMilestone => !!m)
      : [],
    submittedAt: new Date().toISOString(),
  };

  await Promise.all([
    putJson(env, RACE_PREFIX + ghost.dateKey + ":" + ghost.runId, ghost, RACE_TTL_S),
    appendIndex(env, ghost.dateKey, ghost.runId),
  ]);
  return { ok: true, ghost };
}

export async function listRaceGhosts(
  env: Env,
  dateKey: string,
): Promise<RaceGhost[]> {
  if (!DATE_KEY_RE.test(dateKey)) return [];
  const idx = await readJson<{ ids: string[] }>(env, RACE_INDEX_PREFIX + dateKey);
  const ids = idx?.ids ?? [];
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readJson<RaceGhost>(env, RACE_PREFIX + dateKey + ":" + id)));
  const live = rows.filter((r): r is RaceGhost => !!r);
  // Sort: victory ascending by totalSec, then deaths/abandoned by endFloor desc.
  live.sort((a, b) => {
    const av = a.status === "victory" ? 0 : 1;
    const bv = b.status === "victory" ? 0 : 1;
    if (av !== bv) return av - bv;
    if (av === 0) return a.totalSec - b.totalSec;
    return b.endFloor - a.endFloor;
  });
  return live.slice(0, 100);
}

export async function readRaceGhost(env: Env, dateKey: string, runId: string): Promise<RaceGhost | null> {
  if (!DATE_KEY_RE.test(dateKey) || !RUN_ID_RE.test(runId)) return null;
  return readJson<RaceGhost>(env, RACE_PREFIX + dateKey + ":" + runId);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function validateMilestone(m: any): RaceGhostMilestone | null {
  if (!m || typeof m !== "object") return null;
  return {
    floor: clampInt(m.floor, 0, 100),
    elapsedSec: Math.max(0, Math.floor(m.elapsedSec ?? 0)),
    hp: Math.max(0, Math.floor(m.hp ?? 0)),
    deckSize: Math.max(0, Math.floor(m.deckSize ?? 0)),
    topCards: Array.isArray(m.topCards)
      ? m.topCards.slice(0, 8).map((s: unknown) => String(s).slice(0, 64)).filter(Boolean)
      : [],
  };
}

function clampInt(n: unknown, min: number, max: number): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.floor(x)));
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.LOBBIES.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function putJson(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  await env.LOBBIES.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

async function appendIndex(env: Env, dateKey: string, runId: string): Promise<void> {
  const blob = await readJson<{ ids: string[] }>(env, RACE_INDEX_PREFIX + dateKey);
  const ids = blob?.ids ?? [];
  if (ids.includes(runId)) return;
  ids.unshift(runId);
  if (ids.length > INDEX_MAX_PER_DAY) ids.length = INDEX_MAX_PER_DAY;
  await putJson(env, RACE_INDEX_PREFIX + dateKey, { ids }, INDEX_TTL_S);
}

// Re-export helper: today's dateKey (UTC). Mirrors coop-daily.ts.
export function todayDateKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Suppress unused export warnings for STEAM_ID_RE which we keep around
// for future parity with the rest of the coop-* modules.
void STEAM_ID_RE;
