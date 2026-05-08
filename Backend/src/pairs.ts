import type { Env } from "./types";

/**
 * Co-op pair tracker — "Playing with @X" status.
 *
 * STORAGE SHAPE — single `pairs:roster` key
 * ------------------------------------------
 *   `pairs:roster` → JSON `{ pairs: { [steamID]: PairInfo } }`, TTL 30 days.
 *
 * A pair is symmetric: when A and B agree to co-op, BOTH `pairs[A]` and
 * `pairs[B]` get written, each pointing at the other side. That way the
 * frontend can render the pill on either row by a single map lookup, and
 * the wire format stays "every entry knows its own partner" instead of
 * "scan the whole map to find the row that points at me".
 *
 * Why one big key (and not `pair:<sid>` per side):
 *   Same reason `presence:roster` is one key — KV `list()` is the costly
 *   free-tier operation, and we'd otherwise have to list-prefix on every
 *   `/presence/roster` fetch to merge in pair info. Single read, no list,
 *   matches the existing pattern.
 *
 * Lifetime:
 *   - Created when a recipient accepts an invite (in `invites.ts`).
 *   - Auto-expires per-pair after 4 hours via inline `expiresAt` ISO
 *     check at read time. Long enough to cover a real STS2 session
 *     (3-4 hours of runs) without leaving "still playing with X" stuck
 *     on someone's row days later.
 *   - Manually cleared via `DELETE /pair` (clears both sides) or when
 *     either user accepts a NEW invite (auto-replace, since you can
 *     only be paired with one person at a time).
 *
 * Concurrency:
 *   KV is eventually consistent. Two simultaneous accept-invites racing
 *   to write the same pair would resolve to whichever write wins; the
 *   loser's invite stays in the inbox and can be re-clicked. For our
 *   scale this is unobservable.
 */

const PAIRS_KEY = "pairs:roster";
const PAIRS_TTL_SECONDS = 30 * 86400;        // KV blob TTL — long; per-pair TTL is enforced inline
const PAIR_DURATION_SECONDS = 4 * 60 * 60;   // 4h per pair, sliding refresh on accept

export interface PairInfo {
  /** Steam ID of the partner this row is paired WITH. */
  partnerID: string;
  /** Persona name of the partner — duplicated here so the frontend can
   *  render the pill without doing a roster cross-lookup. */
  partnerPersona: string;
  /** Optional Steam avatar URL of the partner (already validated http/https). */
  partnerAvatar?: string;
  /** ISO timestamp the pair was formed. */
  since: string;
  /** ISO timestamp the pair will auto-expire. Pruned at read time. */
  expiresAt: string;
}

interface PairsBlob { pairs: Record<string, PairInfo>; }

// MARK: - Storage I/O --------------------------------------------------------

async function readPairs(env: Env): Promise<PairsBlob> {
  const raw = await env.LOBBIES.get(PAIRS_KEY);
  if (!raw) return { pairs: {} };
  try {
    const parsed = JSON.parse(raw) as PairsBlob;
    if (!parsed || typeof parsed !== "object" || !parsed.pairs) return { pairs: {} };
    return parsed;
  } catch {
    return { pairs: {} };
  }
}

async function writePairs(env: Env, blob: PairsBlob): Promise<void> {
  await env.LOBBIES.put(PAIRS_KEY, JSON.stringify(blob), {
    expirationTtl: PAIRS_TTL_SECONDS,
  });
}

/** Drop expired entries. Mutates the blob in place AND returns whether
 *  anything actually changed (so callers can skip the write on no-op). */
function prune(blob: PairsBlob): boolean {
  const now = Date.now();
  let changed = false;
  for (const sid of Object.keys(blob.pairs)) {
    const t = Date.parse(blob.pairs[sid]!.expiresAt);
    if (!Number.isFinite(t) || t <= now) {
      delete blob.pairs[sid];
      changed = true;
    }
  }
  return changed;
}

// MARK: - Public API ---------------------------------------------------------

/**
 * Return the live pairs map keyed by Steam ID. Auto-prunes expired
 * entries (without writing back — pruning at write time covers real
 * cleanup; here we just don't surface stale rows to readers).
 *
 * `listPresence` calls this once per roster fetch and merges into
 * each entry, so this is on the hot path; keep it cheap.
 */
export async function getPairsMap(env: Env): Promise<Record<string, PairInfo>> {
  const blob = await readPairs(env);
  prune(blob);
  return blob.pairs;
}

/**
 * Mark `aID` and `bID` as paired with each other. Replaces whatever
 * existing pair either side had — accepting a new invite implicitly
 * ends the previous co-op session. Both sides get the same `since`
 * and `expiresAt` so the UI on either row stays consistent.
 *
 * No-op if `aID === bID` (an invite that somehow got self-routed).
 */
export async function setPair(
  env: Env,
  aID: string,
  aPersona: string,
  aAvatar: string | undefined,
  bID: string,
  bPersona: string,
  bAvatar: string | undefined
): Promise<void> {
  if (aID === bID) return;

  const blob = await readPairs(env);
  // Side-effect cleanup: if either side was previously paired with
  // someone *else*, drop that someone-else's reciprocal entry too,
  // so the abandoned partner's row stops showing a stale pairing.
  for (const me of [aID, bID]) {
    const existing = blob.pairs[me];
    if (existing && existing.partnerID !== (me === aID ? bID : aID)) {
      delete blob.pairs[existing.partnerID];
    }
  }

  const now = Date.now();
  const since = new Date(now).toISOString();
  const expiresAt = new Date(now + PAIR_DURATION_SECONDS * 1000).toISOString();

  blob.pairs[aID] = {
    partnerID: bID,
    partnerPersona: bPersona,
    partnerAvatar: bAvatar,
    since,
    expiresAt,
  };
  blob.pairs[bID] = {
    partnerID: aID,
    partnerPersona: aPersona,
    partnerAvatar: aAvatar,
    since,
    expiresAt,
  };

  prune(blob);
  await writePairs(env, blob);
}

/**
 * Manually end the caller's pair. Clears the caller's entry AND the
 * partner's reciprocal entry so neither side sees a stale "Playing
 * with X" pill. Idempotent — calling when not paired returns false.
 */
export async function unpair(env: Env, callerID: string): Promise<boolean> {
  const blob = await readPairs(env);
  const existing = blob.pairs[callerID];
  if (!existing) return false;

  delete blob.pairs[callerID];
  // Only delete the partner's reciprocal if it actually points back at
  // us. If the partner already moved on to another co-op session, leave
  // their row alone — that's their pair to manage, not ours.
  const reciprocal = blob.pairs[existing.partnerID];
  if (reciprocal && reciprocal.partnerID === callerID) {
    delete blob.pairs[existing.partnerID];
  }

  prune(blob);
  await writePairs(env, blob);
  return true;
}
