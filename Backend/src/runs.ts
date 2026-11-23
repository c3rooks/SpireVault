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
  /** Card-pick history as objects: `{ floor, picked, skipped }`, capped at
   *  60 entries. No web build ever filled it (the upload read a field its
   *  runs never had), and web builds since 2026-11-18 send `picks` instead;
   *  kept for any client that does send it. */
  cardChoices?: Array<{ floor: number; picked?: string; skipped?: string[] }>;
  neowBonus?: string;
  /** STS2 `game_mode`, lower-cased ("standard", "daily", "blitz", …). Web
   *  builds before 2026-11-18 sent only the beta modes ("blitz", "dread")
   *  whose ascension is off the standard ladder; later ones send every mode. */
  gameMode?: string;
  // ---- Run detail, sent by web builds since 2026-11-18 --------------------
  // A player's other devices show nothing but this copy, so it carries what
  // the tabs show. All optional: older clients neither send nor read them.
  /** Every card reward of the run as one string: screens joined by ";",
   *  each `floor:picked|skipped,skipped` (nothing before "|" when the reward
   *  was skipped). One string, not `cardChoices` objects, because every
   *  upload parses and re-writes the player's whole copy inside the Worker's
   *  processor budget: 8,000 reward screens as objects more than doubled that
   *  work for a 726-run library, and a string adds almost none. */
  picks?: string;
  /** The player quit the run: shown as Abandoned, not as a defeat. */
  wasAbandoned?: boolean;
  /** A run from the game's Custom Run screen (the save's `is_custom_game`, or
   *  `game_mode: "custom"` before v0.113). Web builds since 2026-11-22 send it
   *  only when true; such runs stay out of win streaks. */
  isCustom?: boolean;
  /** Daily-run modifier slugs. */
  modifiers?: string[];
  /** The rooms walked, one string per act and one letter per room
   *  (Web/lib/cloud-run-wire.js holds the letters). */
  path?: string[];
  /** Players in the run's save file; 1 for a solo run. */
  partySize?: number;
  /** A co-op party's characters, in the save's order; "" for one that could
   *  not be read. Left out for a solo run. */
  party?: string[];
  /** Which of `party` this record is told from: the player whose save folder
   *  it came from. Web builds since 2026-11-22 send it when they know; a
   *  co-op record without it may show a teammate's character and deck. */
  seat?: number;
}

/** The fields one record of a run may lack because the client that sent it
 *  predates them. When two records of a run meet, values for these survive
 *  from whichever has them (see withDetailFrom). */
const DETAIL_FIELDS = ["picks", "gameMode", "wasAbandoned", "isCustom", "modifiers", "path", "partySize", "party"] as const;

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
/** Cards kept per `cardChoices` entry besides the picked one. */
const MAX_SKIPPED_PER_CHOICE = 8;
/** Length of one run's `picks`. A long real run (31 reward screens, one of
 *  them a 30-card offer) is about 1,500 characters. */
const MAX_PICKS_CHARS = 8_000;
/** `picks` is card ids (percent-escaped where an id is not plain) and its
 *  four separators, nothing else. */
const PICKS_PATTERN = /^[A-Za-z0-9_+.%:|,;-]*$/;
/** Size of one player's stored copy, in characters. Workers KV refuses a
 *  value over 25 MiB and a character is at most 3 bytes, so this always
 *  fits. A real 2,000-run library with card picks is about 3 million. */
const MAX_BLOB_CHARS = 8_000_000;
const MAX_MODIFIERS = 16;
const MAX_ACTS = 12;
const MAX_ROOMS_PER_ACT = 80;
const MAX_PARTY = 8;
/** One act of `path`: lower-case room letters only. */
const ACT_PATH_PATTERN = /^[a-z]*$/;

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

/** A non-empty clamped string list, or undefined so nothing is stored. */
function optionalStringArr(v: unknown, max: number): string[] | undefined {
  const list = clampStringArr(v, max);
  return list.length > 0 ? list : undefined;
}

/** The rooms walked, or undefined. One act that is not plain room letters
 *  drops the whole path: keeping the rest would shift every floor number. */
function sanitizePath(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const acts = v.slice(0, MAX_ACTS);
  if (!acts.every((act) => typeof act === "string" && ACT_PATH_PATTERN.test(act))) return undefined;
  return (acts as string[]).map((act) => act.slice(0, MAX_ROOMS_PER_ACT));
}

/** One run's card picks, or undefined. Too long is cut at the last whole
 *  reward screen; any character outside the format drops the lot. */
function sanitizePicks(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_PICKS_CHARS * 4) return undefined;
  if (!PICKS_PATTERN.test(v)) return undefined;
  if (v.length <= MAX_PICKS_CHARS) return v;
  const lastWholeScreen = v.lastIndexOf(";", MAX_PICKS_CHARS);
  return lastWholeScreen > 0 ? v.slice(0, lastWholeScreen) : undefined;
}

function sanitizePartySize(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 1) return undefined;
  return Math.min(MAX_PARTY, Math.floor(v));
}

/** Whose side of a co-op run the record tells: the local player's place in
 *  `party`. Only for a party of two or more, and only inside it. */
function sanitizeSeat(v: unknown, partySize: number | undefined): number | undefined {
  if (!partySize || partySize < 2) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= partySize) return undefined;
  return v;
}

/** A co-op party's characters. Entries stay in place ("" for one the client
 *  could not read) so a party of three keeps three entries. */
function sanitizeParty(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  return v.slice(0, MAX_PARTY).map((climber) => clampString(climber, 32));
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
  const partySize = sanitizePartySize(r.partySize);
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
        skipped: clampStringArr(cc.skipped, MAX_SKIPPED_PER_CHOICE),
      };
    }),
    neowBonus: r.neowBonus ? clampString(r.neowBonus, 96) : undefined,
    gameMode: typeof r.gameMode === "string" && r.gameMode
      ? clampString(r.gameMode.toLowerCase(), 24) || undefined
      : undefined,
    picks: sanitizePicks(r.picks),
    wasAbandoned: r.wasAbandoned === true ? true : undefined,
    isCustom: r.isCustom === true ? true : undefined,
    modifiers: optionalStringArr(r.modifiers, MAX_MODIFIERS),
    path: sanitizePath(r.path),
    partySize,
    party: sanitizeParty(r.party),
    seat: sanitizeSeat(r.seat, partySize),
  };
}

/** `kept` is the record of a run that stays (the later ending; the upload
 *  on a tie) and `other` is the one it replaces. Both describe one run and
 *  differ in how much of it the client sent: web builds before 2026-11-18
 *  send no card picks and none of DETAIL_FIELDS, browsers keep those builds
 *  cached for a while, and a run with no end time is stamped with the upload
 *  time, so the thinner record is often the "later" one. Taking it whole
 *  would empty the Cards tab on every other device again. So whatever `kept`
 *  lacks, it takes from `other`. Returns `kept` itself when it lacks nothing. */
function withDetailFrom(kept: RunSummary, other: RunSummary): RunSummary {
  // Card picks (`picks`, `cardChoices`) are one player's. A record that does
  // not say whose side it tells is the first player's (who every reader takes
  // when it cannot tell), so picks only cross between records of the same side.
  const sameSide = (kept.seat ?? 0) === (other.seat ?? 0);
  const filled: Partial<RunSummary> = {};
  for (const field of DETAIL_FIELDS) {
    if (field === "picks" && !sameSide) continue;
    if (kept[field] === undefined && other[field] !== undefined) {
      Object.assign(filled, { [field]: other[field] });
    }
  }
  if (sameSide && (kept.cardChoices?.length ?? 0) === 0 && (other.cardChoices?.length ?? 0) > 0) {
    filled.cardChoices = other.cardChoices;
  }
  return Object.keys(filled).length > 0 ? { ...kept, ...filled } : kept;
}

const EMPTY_BLOB_TEXT = JSON.stringify({ runs: [], updatedAt: new Date(0).toISOString(), count: 0 });

/** The stored copy exactly as KV holds it, for GET /runs. The copy is
 *  already the JSON the client wants, and parsing it only to write it out
 *  again was the Worker's most expensive request (3 to 4 ms of its 10 ms
 *  processor budget for a 726-run library, measured live on 2026-11-18,
 *  before card picks made the copy larger). Anything that does not look
 *  like a copy this module wrote goes through getRuns instead. */
export async function getRunsText(env: Env, steamID: string): Promise<string> {
  const raw = await env.LOBBIES.get(RUNS_KEY_PREFIX + steamID);
  if (!raw) return EMPTY_BLOB_TEXT;
  if (raw.startsWith('{"runs":[') && raw.endsWith("}")) return raw;
  try {
    const parsed = JSON.parse(raw) as RunsBlob;
    return parsed && Array.isArray(parsed.runs) ? JSON.stringify(parsed) : EMPTY_BLOB_TEXT;
  } catch {
    return EMPTY_BLOB_TEXT;
  }
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
      // A co-op record that knows whose side it tells (`seat`) stays over
      // one that does not, which may be telling a teammate's: web builds
      // before 2026-11-22, and the desktop apps' reader. End times do not
      // decide between those two: readers do not stamp a run's end alike,
      // and a run sent with none is stamped with the upload time.
      // Otherwise last-write-wins by endedAt: the later ending is the record
      // that stays (the upload on a tie). Detail it lacks is kept from the other.
      const a = Date.parse(prev.endedAt);
      const b = Date.parse(r.endedAt);
      const gainsSide = r.seat !== undefined && prev.seat === undefined;
      const losesSide = prev.seat !== undefined && r.seat === undefined;
      const isLater = !Number.isFinite(a) || b >= a;
      const takeUpload = Number.isFinite(b) && !losesSide && (gainsSide || isLater);
      byId.set(r.id, takeUpload ? withDetailFrom(r, prev) : withDetailFrom(prev, r));
    }
  }

  // Sort newest-first so truncation drops the oldest runs. Each end time is
  // read once, not on every comparison.
  const endedAtMs = new Map<string, number>();
  for (const r of byId.values()) endedAtMs.set(r.id, Date.parse(r.endedAt) || 0);
  const merged = Array.from(byId.values()).sort(
    (a, b) => (endedAtMs.get(b.id) ?? 0) - (endedAtMs.get(a.id) ?? 0),
  );
  const withinCount = merged.length > MAX_RUNS_PER_USER ? merged.slice(0, MAX_RUNS_PER_USER) : merged;

  const updatedAt = new Date().toISOString();
  const blobFor = (runs: RunSummary[]): RunsBlob => ({
    runs,
    updatedAt,
    count: runs.length,
    source: source && typeof source === "string" ? source.slice(0, 16) : undefined,
  });
  // A copy too large for KV would fail every upload from then on. Real
  // libraries are nowhere near; this only bounds a pathological one, by
  // dropping its oldest runs a fifth at a time.
  let kept = withinCount;
  let text = JSON.stringify(blobFor(kept));
  while (text.length > MAX_BLOB_CHARS && kept.length > 1) {
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length * 0.8)));
    text = JSON.stringify(blobFor(kept));
  }
  await env.LOBBIES.put(RUNS_KEY_PREFIX + steamID, text, {
    expirationTtl: RUNS_TTL_SECONDS,
  });
  return {
    ok: true,
    result: { count: kept.length, updatedAt, added, truncated: kept.length < merged.length },
  };
}

export async function deleteRuns(env: Env, steamID: string): Promise<void> {
  await env.LOBBIES.delete(RUNS_KEY_PREFIX + steamID);
}
