/**
 * Verified Co-op Reputation — engine.
 *
 * Spec:  docs/coop-reputation-spec.md
 * Types: Backend/src/coop-reputation-types.ts
 *
 * Reads two existing data sources from KV:
 *
 *   runs:<steamID>           solo run history (always client-uploaded but server-trusted)
 *   rep:hist:v1:<steamID>    server-authored co-op event log (best-effort appended from
 *                            coop-engine.ts party / session lifecycle handlers)
 *
 * Writes one cached snapshot:
 *
 *   rep:v1:<steamID>         ReputationBlob — recomputed on read if stale.
 *
 * This module is intentionally read-mostly. The only writers are:
 *
 *   - appendCoopHistory(...)   tiny best-effort log append; never throws
 *   - computeReputation(...)   recomputes + caches the snapshot
 *
 * Both wrap KV failures so they cannot ever break a caller. The party
 * lifecycle handlers in coop-engine.ts log via try/catch around
 * appendCoopHistory so a logging error never rejects the user's action.
 */

import type { Env } from "./types";
import {
  type CoopHistoryBlob,
  type CoopHistoryEntry,
  type CoopHistoryEventType,
  type PartiesCompletedBucket,
  type PublicReputationBlob,
  type ReputationBadge,
  type ReputationBlob,
  type ReputationCounters,
  type ReputationTier,
  COOP_HISTORY_MAX,
  COOP_REP_PUBLIC_FRESH_MS,
  COOP_REP_SELF_FRESH_MS,
  COOP_REP_TTL_SECONDS,
  RELIABILITY_CONFIDENCE_FLOOR,
  repHistoryKey,
  repKey,
} from "./coop-reputation-types";

interface StoredRun {
  id?: unknown;
  character?: unknown;
  ascension?: unknown;
  floorReached?: unknown;
  won?: unknown;
  endedAt?: unknown;
}

interface RunsBlobShape {
  runs?: StoredRun[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// History log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort append to the per-Steam-ID co-op event log. Never throws —
 * KV failures are swallowed so a logging error cannot break the user action
 * that triggered it.
 *
 * Caps the log at COOP_HISTORY_MAX entries (newest-first) and refreshes the
 * TTL on every write.
 */
export async function appendCoopHistory(
  env: Env,
  steamID: string,
  event: CoopHistoryEventType,
  refs: { partyId?: string; lobbyId?: string; sessionId?: string; role?: "host" | "member" } = {},
): Promise<void> {
  if (!steamID) return;
  try {
    const entry: CoopHistoryEntry = {
      at: new Date().toISOString(),
      event,
      ...(refs.partyId ? { partyId: refs.partyId } : {}),
      ...(refs.lobbyId ? { lobbyId: refs.lobbyId } : {}),
      ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
      ...(refs.role ? { role: refs.role } : {}),
    };

    const existing = await readHistory(env, steamID);
    const entries = [entry, ...existing].slice(0, COOP_HISTORY_MAX);

    const blob: CoopHistoryBlob = {
      schemaVersion: 1,
      steamID,
      entries,
      updatedAt: entry.at,
    };
    await env.LOBBIES.put(repHistoryKey(steamID), JSON.stringify(blob), {
      expirationTtl: COOP_REP_TTL_SECONDS,
    });
  } catch {
    // Best-effort. Swallow.
  }
}

async function readHistory(env: Env, steamID: string): Promise<CoopHistoryEntry[]> {
  try {
    const raw = await env.LOBBIES.get(repHistoryKey(steamID));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CoopHistoryBlob;
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    return parsed.entries;
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot cache read / write
// ─────────────────────────────────────────────────────────────────────────────

async function readCachedReputation(env: Env, steamID: string): Promise<ReputationBlob | null> {
  try {
    const raw = await env.LOBBIES.get(repKey(steamID));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReputationBlob;
    if (!parsed || parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCachedReputation(env: Env, blob: ReputationBlob): Promise<void> {
  try {
    await env.LOBBIES.put(repKey(blob.steamID), JSON.stringify(blob), {
      expirationTtl: COOP_REP_TTL_SECONDS,
    });
  } catch {
    /* swallow */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the cached snapshot. If absent or older than the freshness window,
 * recompute and persist a fresh snapshot. Returns null only if compute also
 * failed (KV down). Cache miss for a Steam ID that has uploaded zero runs
 * still returns a valid ReputationBlob — just the empty one.
 */
export async function getReputation(
  env: Env,
  steamID: string,
  opts: { freshMs: number } = { freshMs: COOP_REP_PUBLIC_FRESH_MS },
): Promise<ReputationBlob | null> {
  const cached = await readCachedReputation(env, steamID);
  if (cached) {
    const ageMs = Date.now() - new Date(cached.computedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs < opts.freshMs) {
      return cached;
    }
  }
  try {
    return await computeReputation(env, steamID);
  } catch {
    return cached;
  }
}

/**
 * Force a fresh compute and cache write. Used by /coop/reputation/me and by
 * any code that wants an authoritative read.
 */
export async function computeReputation(env: Env, steamID: string): Promise<ReputationBlob> {
  const [runs, history] = await Promise.all([
    readRuns(env, steamID),
    readHistory(env, steamID),
  ]);
  const counters = aggregateCounters(runs, history);
  const tier = tierFromCounters(counters);
  const badges = badgesFromCounters(counters);
  const monthFromRun = (iso?: string): string | undefined => {
    if (!iso) return undefined;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return undefined;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const firstPlayedMonth = runs.length > 0 ? monthFromRun(toIso(runs[runs.length - 1].endedAt)) : undefined;
  const lastActiveMonth = monthFromRun(counters.lastRunAt);

  const blob: ReputationBlob = {
    schemaVersion: 1,
    steamID,
    computedAt: new Date().toISOString(),
    tier,
    badges,
    counters,
    ...(firstPlayedMonth ? { firstPlayedMonth } : {}),
    ...(lastActiveMonth ? { lastActiveMonth } : {}),
  };
  await writeCachedReputation(env, blob);
  return blob;
}

async function readRuns(env: Env, steamID: string): Promise<StoredRun[]> {
  try {
    const raw = await env.LOBBIES.get(`runs:${steamID}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RunsBlobShape;
    if (!parsed || !Array.isArray(parsed.runs)) return [];
    return parsed.runs;
  } catch {
    return [];
  }
}

function toIso(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

function toBool(x: unknown): boolean {
  return x === true;
}

function toNum(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function toCharSlug(x: unknown): string | undefined {
  if (typeof x !== "string") return undefined;
  const trimmed = x.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 32) return undefined;
  return trimmed;
}

/** Pure aggregator — exported for the test. */
export function aggregateCounters(
  runs: StoredRun[],
  history: CoopHistoryEntry[],
): ReputationCounters {
  const now = Date.now();
  const cutoff30d = now - 30 * MS_PER_DAY;

  let totalRunsLogged = 0;
  let runsLast30d = 0;
  let wins30d = 0;
  let highestAscensionCleared = 0;
  let heartKills = 0;
  let lastRunAtMs = 0;
  let lastRunAt: string | undefined;
  const ascensionByCharacter: Record<string, number> = {};

  for (const r of runs) {
    totalRunsLogged += 1;
    const endedAtIso = toIso(r.endedAt);
    const endedAtMs = endedAtIso ? new Date(endedAtIso).getTime() : NaN;
    if (Number.isFinite(endedAtMs) && endedAtMs > lastRunAtMs) {
      lastRunAtMs = endedAtMs;
      lastRunAt = endedAtIso;
    }
    if (Number.isFinite(endedAtMs) && endedAtMs >= cutoff30d) {
      runsLast30d += 1;
      if (toBool(r.won)) wins30d += 1;
    }

    if (toBool(r.won)) {
      const asc = toNum(r.ascension);
      if (asc > highestAscensionCleared) highestAscensionCleared = asc;
      const slug = toCharSlug(r.character);
      if (slug) {
        const prev = ascensionByCharacter[slug] ?? 0;
        if (asc > prev) ascensionByCharacter[slug] = asc;
      }
      if (toNum(r.floorReached) >= 60) heartKills += 1;
    }
  }

  const recentWinRate30d = runsLast30d >= 10 ? Math.round((wins30d / runsLast30d) * 100) / 100 : null;

  let partiesHosted = 0;
  let partiesJoined = 0;
  let partiesCompleted = 0;
  let partiesAbandoned = 0;

  for (const e of history) {
    switch (e.event) {
      case "hosted_lobby":
        partiesHosted += 1;
        break;
      case "started_party_run":
        partiesJoined += 1;
        break;
      case "completed_party_role":
      case "completed_session":
        partiesCompleted += 1;
        break;
      case "abandoned_party":
        partiesAbandoned += 1;
        break;
    }
  }

  const outcomes = partiesCompleted + partiesAbandoned;
  const reliabilityScore =
    outcomes >= RELIABILITY_CONFIDENCE_FLOOR
      ? Math.round((partiesCompleted / outcomes) * 100)
      : null;

  return {
    totalRunsLogged,
    runsLast30d,
    highestAscensionCleared,
    ascensionByCharacter,
    heartKills,
    recentWinRate30d,
    ...(lastRunAt ? { lastRunAt } : {}),
    partiesHosted,
    partiesJoined,
    partiesCompleted,
    partiesAbandoned,
    reliabilityScore,
  };
}

/** Pure tier mapping — exported for the test. */
export function tierFromCounters(c: ReputationCounters): ReputationTier {
  const isRegular = c.totalRunsLogged >= 10;
  if (!isRegular) return "newcomer";
  const isTrusted =
    isRegular &&
    c.partiesCompleted >= 5 &&
    (c.reliabilityScore ?? 0) >= 80;
  if (!isTrusted) return "regular";
  const isVeteran = isTrusted && c.highestAscensionCleared >= 15;
  if (!isVeteran) return "trusted";
  const isAscended = isVeteran && c.highestAscensionCleared >= 20 && c.heartKills >= 1;
  if (!isAscended) return "veteran";
  return "ascended";
}

/** Pure badge mapping — exported for the test. */
export function badgesFromCounters(c: ReputationCounters): ReputationBadge[] {
  const out: ReputationBadge[] = [];
  if (c.heartKills >= 1) out.push("heart_kill");
  if (c.highestAscensionCleared >= 20) out.push("a20_clear");
  if (c.partiesHosted >= 5 && (c.reliabilityScore ?? 0) >= 90) out.push("host_reliable");
  if (c.runsLast30d >= 5) out.push("active_recent");
  return out;
}

function bucketParties(n: number): PartiesCompletedBucket {
  if (n < 5) return "<5";
  if (n < 20) return "5-19";
  if (n < 50) return "20-49";
  if (n < 100) return "50-99";
  return "100+";
}

/** Strip raw counters for the public endpoint. */
export function toPublic(blob: ReputationBlob): PublicReputationBlob {
  const recomputeAfter = new Date(
    new Date(blob.computedAt).getTime() + COOP_REP_PUBLIC_FRESH_MS,
  ).toISOString();
  const out: PublicReputationBlob = {
    schemaVersion: 1,
    steamID: blob.steamID,
    tier: blob.tier,
    badges: blob.badges,
    partiesCompletedBucket: bucketParties(blob.counters.partiesCompleted),
    recomputeAfter,
    ...(blob.firstPlayedMonth ? { firstPlayedMonth: blob.firstPlayedMonth } : {}),
    ...(blob.lastActiveMonth ? { lastActiveMonth: blob.lastActiveMonth } : {}),
  };
  return out;
}

/** Public freshness used by route caching. */
export { COOP_REP_PUBLIC_FRESH_MS, COOP_REP_SELF_FRESH_MS };
