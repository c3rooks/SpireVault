import type {
  CoopPresence,
  MatchLabel,
  RecommendedMatch,
} from "./coop-types";
import { isPresenceActive } from "./coop-engine";

/**
 * Server-side scoring + recommendation builder.
 *
 * The numeric score never leaves the worker — clients render the
 * friendly `MatchLabel`. The score is exposed only for testing and
 * to keep sort order stable.
 *
 * The weights below mirror the product spec exactly:
 *
 *   +40 candidate is looking and active
 *   +20 ascension ranges overlap
 *   +15 same goal or either goal is "any"
 *   +10 voice preferences compatible
 *   +10 preferred characters overlap
 *   +10 candidate has Discord if current user prefers voice/Discord
 *   -100 candidate is paired
 *   -100 candidate is stale/offline/afk
 *   -100 candidate is current user
 *    -50 candidate has recently declined current user
 *    -25 candidate already has a pending invite from current user
 */

export interface ScoringContext {
  currentUser: CoopPresence;
  candidates: CoopPresence[];
  /** Steam IDs we currently have an outgoing pending invite to. */
  pendingOutgoingInviteTargetIds: Set<string>;
  /** Steam IDs we are under a decline cooldown with. */
  declineCooldownPartnerIds: Set<string>;
}

export interface ScoredCandidate {
  presence: CoopPresence;
  score: number;
  label: MatchLabel;
}

export function scoreMatch(
  currentUser: CoopPresence,
  candidate: CoopPresence,
  pendingOutgoingInviteTargetIds: Set<string>,
  declineCooldownPartnerIds: Set<string>,
): number {
  let score = 0;
  const now = Date.now();
  const active = isPresenceActive(candidate, now);

  // Hard negatives first
  if (candidate.steamId === currentUser.steamId) score -= 100;
  if (!active) score -= 100;
  if (
    candidate.status === "paired" ||
    candidate.status === "offline" ||
    candidate.status === "afk"
  ) {
    score -= 100;
  }
  if (declineCooldownPartnerIds.has(candidate.steamId)) score -= 50;
  if (pendingOutgoingInviteTargetIds.has(candidate.steamId)) score -= 25;

  // Positive signals
  if (candidate.status === "looking" && active) score += 40;

  if (ascensionOverlaps(currentUser, candidate)) score += 20;

  const currentGoal = currentUser.goal;
  const candidateGoal = candidate.goal;
  if (currentGoal && candidateGoal) {
    if (
      currentGoal === candidateGoal ||
      currentGoal === "any" ||
      candidateGoal === "any"
    ) {
      score += 15;
    }
  } else if (currentGoal === "any" || candidateGoal === "any") {
    score += 15;
  }

  if (voicePreferenceCompatible(currentUser.voicePreference, candidate.voicePreference)) {
    score += 10;
  }

  if (preferredCharactersOverlap(currentUser, candidate)) {
    score += 10;
  }

  if (
    candidate.discordHandle &&
    (currentUser.voicePreference === "yes" ||
      (currentUser.voicePreference === "optional" && candidate.voicePreference === "yes"))
  ) {
    score += 10;
  }

  return score;
}

function ascensionOverlaps(a: CoopPresence, b: CoopPresence): boolean {
  const aMin = a.ascensionMin ?? 0;
  const aMax = a.ascensionMax ?? 10;
  const bMin = b.ascensionMin ?? 0;
  const bMax = b.ascensionMax ?? 10;
  return aMin <= bMax && bMin <= aMax;
}

function voicePreferenceCompatible(
  a: CoopPresence["voicePreference"],
  b: CoopPresence["voicePreference"],
): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a === "optional" || b === "optional") return true;
  return false;
}

function preferredCharactersOverlap(
  a: CoopPresence,
  b: CoopPresence,
): boolean {
  const aSet = new Set((a.preferredCharacters ?? []).map((s) => s.toLowerCase()));
  if (aSet.size === 0) return false;
  return (b.preferredCharacters ?? []).some((c) => aSet.has(c.toLowerCase()));
}

export function labelForScore(score: number): MatchLabel {
  if (score >= 70) return "Strong match";
  if (score >= 40) return "Good match";
  if (score >= 10) return "Different goal";
  return "Recently active";
}

export function recommendMatches(ctx: ScoringContext, limit = 8): RecommendedMatch[] {
  const scored: ScoredCandidate[] = [];
  for (const cand of ctx.candidates) {
    if (cand.steamId === ctx.currentUser.steamId) continue;
    const score = scoreMatch(
      ctx.currentUser,
      cand,
      ctx.pendingOutgoingInviteTargetIds,
      ctx.declineCooldownPartnerIds,
    );
    // We never recommend a hard-negative target.
    if (score <= -50) continue;
    scored.push({ presence: cand, score, label: labelForScore(score) });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break by freshness (most recently heartbeated first).
    const at = Date.parse(a.presence.lastHeartbeatAt) || 0;
    const bt = Date.parse(b.presence.lastHeartbeatAt) || 0;
    return bt - at;
  });
  return scored.slice(0, limit).map((s) => ({
    steamId: s.presence.steamId,
    personaName: s.presence.personaName,
    avatarUrl: s.presence.avatarUrl,
    status: s.presence.status,
    ascensionMin: s.presence.ascensionMin,
    ascensionMax: s.presence.ascensionMax,
    goal: s.presence.goal,
    voicePreference: s.presence.voicePreference,
    note: s.presence.note,
    lastHeartbeatAt: s.presence.lastHeartbeatAt,
    label: s.label,
    hasDiscord: !!s.presence.discordHandle,
  }));
}
