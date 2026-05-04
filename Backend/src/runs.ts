import type { Env } from "./types";

/**
 * Per-Steam-ID run-history sync.
 *
 * STORAGE SHAPE — single key per user
 * -----------------------------------
 *   `runs:<steamID>` → JSON `{ runs: RunSummary[], updatedAt, count, source }`
 *   TTL: 365 days (refreshed on every upload).
 *
 * Why one key per user (not one per run):
 *   The product semantics are "the user's run list, as a single set." Reads
 *   and writes are atomic — the client uploads its full local set after
 *   every parse, and downloads the full set on a fresh device. There's no
 *   cross-user query, no per-run write, no need for partition. One key
 *   per user is the cheapest read shape KV offers (1 read = whole list).
 *
 * Why we de-duplicate server-side:
 *   The .run file ids are stable across devices (they're the stable hash
 *   the desktop app and web app emit from the file's seed+timestamp), so
 *   if the user uploads from web AND mobile, both will redundantly send
 *   the same runs. Server merges by id, keeping the most-recent
 *   `endedAt` (last-write-wins on the same run).
 *
 * Wire-format guarantees:
 *   - Mobile + web read the SAME shape. A field added here MUST be safe
 *     to add to both clients before the next backend deploy.
 *   - Empty list responses are `200 { runs: [] }`, not 404. The client
 *     should never need to special-case "no runs".
 */

export interface RunSummary {
  /** Stable cross-device id. Both web parser (parseSTS2Run.id) and the
   *  mobile parser must emit the same id for the same `.run` file. */
  id: string;
  character: string;
  ascension: number;
  floorReached: number;
  won: boolean;
  playTimeSeconds: number;
  /** ISO8601. Used for last-write-wins on duplicate ids. */
  endedAt: string;
  startedAt?: string;
  seed?: string;
  killedBy?: string;
  relics: string[];
  deckAtEnd: string[];
  /** Optional card-pick history: list of `{ floor, picked, skipped }`. Capped
   *  at 60 entries server-side to keep stored size bounded. */
  cardChoices?: Array<{ floor: number; picked?: string; skipped?: string[] }>;
  neowBonus?: string;
}

interface RunsBlob {
  runs: RunSummary[];
  updatedAt: string;
  count: number;
  /** "web" | "ios" | "macos" — last device that wrote. Visible to the
   *  user as a "synced from web 12m ago" hint. Optional. */
  source?: string;
}

export const RUNS_KEY_PREFIX = "runs:";
const RUNS_TTL_SECONDS = 365 * 86_400;

/** Hard ceiling on stored runs per user. STS2 saves are tiny (~1 KB each
 *  summarized), but a 10k-run player would still push past 10 MB; cap
 *  to keep KV cost predictable and worker memory bounded. Most players
 *  have well under 1k runs over the lifetime of the game. */
export const MAX_RUNS_PER_USER = 2_000;

/** Hard ceiling on cardChoices entries per run — typical run has ~50,
 *  but corrupt save files have been seen with multi-thousand entries.
 *  Truncate to keep stored size bounded. */
const MAX_CARD_CHOICES = 60;

function clampString(v: unknown, max: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  if (v.length > max) return v.slice(0, max);
  return v;
}

function clampNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clampBool(v: unknown): boolean {
  return v === true;
}

function clampStringArr(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .slice(0, max)
    .map((x) => x.slice(0, 64));
}

/** Trust nothing the client sends — coerce every field to its expected
 *  type and clamp lengths. Returns null if `id` or `character` are
 *  missing (the only fields we treat as load-bearing). */
function sanitizeRun(raw: unknown): RunSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = clampString(r.id, 96);
  const character = clampString(r.character, 32);
  if (!id || !character) return null;
  const choices = Array.isArray(r.cardChoices) ? r.cardChoices : [];
  return {
    id,
    character,
    ascension: clampNumber(r.ascension, 0),
    floorReached: clampNumber(r.floorReached, 0),
    won: clampBool(r.won),
    playTimeSeconds: clampNumber(r.playTimeSeconds, 0),
    endedAt: clampString(r.endedAt, 32, new Date().toISOString()),
    startedAt: r.startedAt ? clampString(r.startedAt, 32) : undefined,
    seed: r.seed ? clampString(r.seed, 64) : undefined,
    killedBy: r.killedBy ? clampString(r.killedBy, 96) : undefined,
    relics: clampStringArr(r.relics, 64),
    deckAtEnd: clampStringArr(r.deckAtEnd, 256),
    cardChoices: choices.slice(0, MAX_CARD_CHOICES).map((c: unknown) => {
      const cc = (c ?? {}) as Record<string, unknown>;
      return {
        floor: clampNumber(cc.floor, 0),
        picked: cc.picked ? clampString(cc.picked, 64) : undefined,
        skipped: clampStringArr(cc.skipped, 8),
      };
    }),
    neowBonus: r.neowBonus ? clampString(r.neowBonus, 96) : undefined,
  };
}

export async function getRuns(env: Env, steamID: string): Promise<RunsBlob> {
  const raw = await env.LOBBIES.get(RUNS_KEY_PREFIX + steamID);
  if (!raw) {
    return { runs: [], updatedAt: new Date(0).toISOString(), count: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as RunsBlob;
    if (!parsed || !Array.isArray(parsed.runs)) {
      return { runs: [], updatedAt: new Date(0).toISOString(), count: 0 };
    }
    return parsed;
  } catch {
    return { runs: [], updatedAt: new Date(0).toISOString(), count: 0 };
  }
}

export interface UploadResult {
  count: number;
  updatedAt: string;
  /** How many of the uploaded runs were brand-new (didn't exist in cloud
   *  copy). Useful for a "synced 3 new runs" status pill. */
  added: number;
  /** True when the upload exceeded MAX_RUNS_PER_USER and the oldest
   *  entries (by endedAt) were dropped to fit. */
  truncated: boolean;
}

/** Merge the uploaded runs into the existing cloud copy.
 *
 *   - Dedupe by id (last-write-wins on duplicate id, keyed by `endedAt`).
 *   - Sort by `endedAt` desc so the freshest runs survive truncation.
 *   - Truncate to MAX_RUNS_PER_USER.
 *
 * The merge means a user uploading their full library every parse is
 * cheap on the wire (no diff protocol) but won't lose runs that exist
 * only on the OTHER device — a player using both web + mobile in the
 * same week will accumulate both sets. */
export async function uploadRuns(
  env: Env,
  steamID: string,
  body: unknown,
  source?: string,
): Promise<{ ok: true; result: UploadResult } | { ok: false; status: number; error: string }> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid body" };
  }
  const incoming = (body as { runs?: unknown }).runs;
  if (!Array.isArray(incoming)) {
    return { ok: false, status: 400, error: "missing runs[]" };
  }
  if (incoming.length > MAX_RUNS_PER_USER * 2) {
    // Reject obviously-pathological payloads before we even parse them
    // — keeps a misbehaving client from blowing through worker CPU on
    // sanitization alone.
    return { ok: false, status: 413, error: "too many runs" };
  }
  const sanitized: RunSummary[] = [];
  for (const r of incoming) {
    const s = sanitizeRun(r);
    if (s) sanitized.push(s);
  }

  const existing = await getRuns(env, steamID);
  const byId = new Map<string, RunSummary>();
  for (const r of existing.runs) byId.set(r.id, r);

  let added = 0;
  for (const r of sanitized) {
    const prev = byId.get(r.id);
    if (!prev) {
      added++;
      byId.set(r.id, r);
    } else {
      // Last-write-wins by endedAt
      const a = Date.parse(prev.endedAt);
      const b = Date.parse(r.endedAt);
      if (Number.isFinite(b) && (!Number.isFinite(a) || b >= a)) {
        byId.set(r.id, r);
      }
    }
  }

  // Sort newest-first so truncation drops the oldest runs.
  const merged = Array.from(byId.values()).sort((a, b) => {
    const da = Date.parse(a.endedAt) || 0;
    const db = Date.parse(b.endedAt) || 0;
    return db - da;
  });
  const truncated = merged.length > MAX_RUNS_PER_USER;
  const final = truncated ? merged.slice(0, MAX_RUNS_PER_USER) : merged;

  const blob: RunsBlob = {
    runs: final,
    updatedAt: new Date().toISOString(),
    count: final.length,
    source: source && typeof source === "string" ? source.slice(0, 16) : undefined,
  };
  await env.LOBBIES.put(RUNS_KEY_PREFIX + steamID, JSON.stringify(blob), {
    expirationTtl: RUNS_TTL_SECONDS,
  });
  return {
    ok: true,
    result: { count: final.length, updatedAt: blob.updatedAt, added, truncated },
  };
}

export async function deleteRuns(env: Env, steamID: string): Promise<void> {
  await env.LOBBIES.delete(RUNS_KEY_PREFIX + steamID);
}
