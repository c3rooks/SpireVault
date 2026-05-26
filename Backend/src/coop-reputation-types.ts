/**
 * Verified Co-op Reputation — wire types.
 *
 * Spec: docs/coop-reputation-spec.md
 *
 * Two storage blobs live in the single LOBBIES KV namespace:
 *
 *   rep:v1:<steamID>           ReputationBlob   — cached snapshot, recomputed on read.
 *   rep:hist:v1:<steamID>      CoopHistoryBlob  — capped (200) event log, appended from
 *                                                 party-lifecycle handlers in coop-engine.ts.
 *
 * Two endpoints:
 *
 *   GET /coop/reputation/me       auth required.   Returns full ReputationBlob.
 *   GET /coop/reputation/:sid     public.          Returns redacted PublicReputationBlob.
 *
 * The public endpoint hides the underlying counters (bucketed only) so that
 * the formula isn't directly farmable. Same idea as coop-recommendations.ts
 * exposing a MatchLabel rather than the raw fit score.
 */

export type ReputationTier =
  | "newcomer"
  | "regular"
  | "trusted"
  | "veteran"
  | "ascended";

export type ReputationBadge =
  | "heart_kill"      // any Heart kill (won && floorReached >= 60) in run history
  | "a20_clear"       // any A20 win
  | "host_reliable"   // ≥ 5 hosted, reliabilityScore ≥ 90
  | "active_recent";  // ≥ 5 runs in last 30d

export type CoopHistoryEventType =
  | "hosted_lobby"
  | "started_party_run"
  | "completed_party_role"
  | "abandoned_party"
  | "completed_session";

export interface CoopHistoryEntry {
  /** ISO8601. */
  at: string;
  event: CoopHistoryEventType;
  partyId?: string;
  lobbyId?: string;
  sessionId?: string;
  /** "host" or "member" — only set for completed_party_role. */
  role?: "host" | "member";
}

export interface CoopHistoryBlob {
  schemaVersion: 1;
  steamID: string;
  /** Newest-first. Capped at COOP_HISTORY_MAX. */
  entries: CoopHistoryEntry[];
  updatedAt: string;
}

export interface ReputationCounters {
  totalRunsLogged: number;
  runsLast30d: number;
  highestAscensionCleared: number;
  /** keyed by stable character slug (the same one RunSummary.character uses). */
  ascensionByCharacter: Record<string, number>;
  heartKills: number;
  /** null if total runs in the last 30 days < 10 (sample too small). */
  recentWinRate30d: number | null;
  /** ISO8601 of the most recent run, or undefined if no runs. */
  lastRunAt?: string;
  partiesHosted: number;
  partiesJoined: number;
  partiesCompleted: number;
  partiesAbandoned: number;
  /** 0..100, or null when (partiesCompleted + partiesAbandoned) < 5. */
  reliabilityScore: number | null;
}

export interface ReputationBlob {
  schemaVersion: 1;
  steamID: string;
  /** ISO8601 of last compute. */
  computedAt: string;
  tier: ReputationTier;
  badges: ReputationBadge[];
  counters: ReputationCounters;
  /** "2026-03" — month of the first logged run, derived from runs:<steamID>. */
  firstPlayedMonth?: string;
  /** "2026-05" — month of the most recent run. */
  lastActiveMonth?: string;
}

export type PartiesCompletedBucket = "<5" | "5-19" | "20-49" | "50-99" | "100+";

export interface PublicReputationBlob {
  schemaVersion: 1;
  steamID: string;
  tier: ReputationTier;
  badges: ReputationBadge[];
  firstPlayedMonth?: string;
  lastActiveMonth?: string;
  /** Bucketed completion count — never the precise number on the public endpoint. */
  partiesCompletedBucket: PartiesCompletedBucket;
  /** Hint for the client cache. ISO8601 — the client may freely use the response
   *  until this time even if it has its own cache controls. */
  recomputeAfter: string;
}

/** Confidence floor below which reliabilityScore is null and the host_reliable
 *  badge cannot be earned. Tunable in v0.11.x without a schema change. */
export const RELIABILITY_CONFIDENCE_FLOOR = 5;

/** How many entries the history log keeps per Steam ID. Older entries are
 *  dropped on append. ~200 is enough to cover ~6 months of heavy co-op play. */
export const COOP_HISTORY_MAX = 200;

/** TTL on rep:* and rep:hist:* keys (180 days, refreshed on every write). */
export const COOP_REP_TTL_SECONDS = 180 * 24 * 60 * 60;

/** Cache freshness windows for the read endpoints. */
export const COOP_REP_SELF_FRESH_MS = 60 * 1000;       // 60s for /me
export const COOP_REP_PUBLIC_FRESH_MS = 5 * 60 * 1000; // 5 min for /:steamID

/** KV key builders. */
export function repKey(steamID: string): string {
  return `rep:v1:${steamID}`;
}

export function repHistoryKey(steamID: string): string {
  return `rep:hist:v1:${steamID}`;
}
