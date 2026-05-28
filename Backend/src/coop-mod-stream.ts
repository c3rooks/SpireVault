/**
 * Mod stream ingest — the bridge between the SpireVault Companion mod
 * and SpireVault.app.
 *
 * Why this module exists (it's the keystone of v0.13):
 *
 *   Every other STS2 tool can only see what the player uploads after
 *   the run ends (.run files, screenshots) OR what the in-game overlay
 *   draws locally. Nobody has connected an in-game data source to a
 *   cloud backend that other players can read in real time. SpireVault
 *   is the only player with the cloud + Steam OAuth + Discord + party
 *   hub already wired, so this module flips on the producer end.
 *
 * Data flow:
 *
 *   [STS2 game]
 *      |  Combat / Run hooks emit state every ~1s
 *      v
 *   [SpireVault Companion mod]
 *      |  POST /coop/mod/ingest   (batched ~2s, X-Mod-Token + Steam OAuth)
 *      v
 *   [Worker]                            ┌──────────────┐
 *      |  upsert KV: runlive:<runId> ──>│  KV (60s TTL)│
 *      v                                └──────────────┘
 *   [Spectator / Coach / Party Hub / OBS overlay readers]
 *      GET /coop/run/:runId/live    (10s edge cache, fanout-friendly)
 *
 * Why HTTP batched POST instead of WebSocket:
 *
 *   - Cloudflare Workers only do server-side WebSocket via Durable
 *     Objects, which have nontrivial cost + cold-start.
 *   - The mod runs locally and naturally does egress, so a 2s POST
 *     loop with `keepalive` is fine.
 *   - Spectators read on a 2s pull with edge cache; one popular run
 *     with 50 viewers becomes ~25 KV reads/min, not 50 sockets.
 *   - WebSocket can ship later as a v2 upgrade with the same payload
 *     schema; no client-visible break.
 *
 * Schema versioning:
 *
 *   The wire format carries `schemaVersion` so an older mod can
 *   coexist with a newer worker without spurious "invalid_body"
 *   errors. We only reject schema versions we explicitly don't
 *   know how to read.
 */

import type { Env } from "./types";

// ────────────────────────────────────────────────────────────────────
// Wire types — keep mirrored with the Companion mod's IngestPayload.cs
// ────────────────────────────────────────────────────────────────────

export interface RunLiveCard {
  /** Stable string id (the game uses the snake_case symbol). */
  id: string;
  /** Display name; capped at 64 chars. */
  name: string;
  /** 0 = base, 1 = upgraded once, 2 = double-upgrade. */
  upgrades: number;
  /** Energy cost; -1 means X-cost. */
  cost: number;
  /** "attack" | "skill" | "power" | "status" | "curse". */
  type: string;
}

export interface RunLiveRelic {
  id: string;
  name: string;
  /** Description text, sanitized + capped. */
  description: string;
  /** Optional counter (e.g. blue candle stacks). */
  counter?: number;
}

export interface RunLivePartyMember {
  steamId: string;
  /** Optional — fetched via the party-room/profile path on read. */
  personaName?: string;
  characterId?: string;
  hp?: number;
  maxHp?: number;
  block?: number;
  /** Cards the teammate currently holds in hand (combat only). */
  hand?: RunLiveCard[];
  /** Compact deck size + a few key relic ids for the spectator/coach. */
  deckSize?: number;
  topRelicIds?: string[];
}

export interface RunLiveCombat {
  /** "in_combat" | "between_combats" | "map" | "shop" | "rest" | "event" | "boss" | null. */
  scene: string | null;
  /** 0-indexed turn number when in combat. */
  turn?: number;
  /** Current energy / max energy. */
  energy?: number;
  energyMax?: number;
  /** What the player can see in their hand right now. */
  hand?: RunLiveCard[];
  /** Block on the player. */
  block?: number;
  /** Each enemy's incoming intent line ("Attack 12", "Buff", etc.). */
  enemies?: Array<{
    name: string;
    hp: number;
    maxHp: number;
    intent?: string;
    intentDamage?: number;
  }>;
}

export interface RunLiveSnapshot {
  schemaVersion: 1;

  /** Stable per-run id (mod generates ulid on Run.Start). */
  runId: string;
  /** Steam ID of the host running the mod. */
  hostSteamId: string;
  /** Display name (helps spectators / OBS overlays without an extra fetch). */
  hostPersonaName: string;
  hostAvatarUrl?: string;

  /** "ironclad" | "silent" | "necrobinder" | "regent" | "defect". */
  characterId: string;
  /** 0-20. */
  ascension: number;

  /** Game floor (1-based, monotonic forward). */
  floor: number;
  /** Act 1, 2, 3, 4. */
  act: number;
  /** Player HP / max HP at the snapshot moment. */
  hp: number;
  maxHp: number;
  gold: number;

  /** Full deck (compact card list). */
  deck: RunLiveCard[];
  /** Owned relics. */
  relics: RunLiveRelic[];
  /** Owned potions (id + name). */
  potions: Array<{ id: string; name: string }>;

  /** Combat state — null when not in combat. */
  combat: RunLiveCombat | null;

  /** Co-op party — empty when solo. */
  party: RunLivePartyMember[];

  /** "active" | "victory" | "death" | "abandoned". */
  status: "active" | "victory" | "death" | "abandoned";

  /** Server-stamped on ingest; echoed on read. */
  updatedAt: string;
}

export interface IngestRequestBody {
  schemaVersion: 1;
  runId: string;
  /** Mod build id, useful for "this client is too old" debugging. */
  modVersion: string;
  /**
   * Most recent snapshot. We don't accept arrays of snapshots
   * because the spectator surface only ever needs the latest;
   * batching just inflates payload size without buying anything.
   */
  snapshot: RunLiveSnapshot;
  /** "stop" closes out the run. The KV row is left in place for a
   *  short replay window so the post-run share / narrative path can
   *  pull it; it expires on its own. */
  closing?: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Storage layout
// ────────────────────────────────────────────────────────────────────

/** Live snapshot. Renewed on every ingest with a fresh TTL. */
const LIVE_PREFIX = "runlive:";
/** "Latest run id for this host" pointer, lets a spectator hit
 *  /coop/run/:steamId/live without knowing the runId. */
const HOST_PTR_PREFIX = "runlive:host:";
/** Public runs index — ULIDs of recently-active live runs. */
const RUNS_INDEX_KEY = "runlive:index";

const LIVE_TTL_S = 90; // ~3x the ingest cadence; tolerates a brief network hiccup
const POST_RUN_TTL_S = 30 * 60; // 30 min replay window after the run ends
const INDEX_TTL_S = 2 * 60 * 60;
const INDEX_MAX = 200;

const PERSONA_MAX = 64;
const NAME_MAX = 64;
const DESC_MAX = 240;

// ────────────────────────────────────────────────────────────────────
// Validation — defensive about every free-form string
// ────────────────────────────────────────────────────────────────────

const STEAM_ID_RE = /^\d{17}$/;
const RUN_ID_RE = /^[A-Z0-9_-]{6,40}$/i;
const SCENE_VALUES = new Set([
  "in_combat",
  "between_combats",
  "map",
  "shop",
  "rest",
  "event",
  "boss",
  "victory",
  "death",
]);

function clip(s: unknown, max: number): string {
  if (typeof s !== "string") return "";
  return s.slice(0, max);
}

function num(n: unknown, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function validateCard(c: any): RunLiveCard | null {
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || !c.id) return null;
  return {
    id: clip(c.id, NAME_MAX),
    name: clip(c.name, NAME_MAX),
    upgrades: Math.max(0, Math.min(2, num(c.upgrades, 0))),
    cost: num(c.cost, 0),
    type: clip(c.type, 16),
  };
}

function validateCards(arr: any, cap = 256): RunLiveCard[] {
  if (!Array.isArray(arr)) return [];
  const out: RunLiveCard[] = [];
  for (const c of arr) {
    const v = validateCard(c);
    if (v) out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

function validateRelic(r: any): RunLiveRelic | null {
  if (!r || typeof r !== "object" || typeof r.id !== "string") return null;
  return {
    id: clip(r.id, NAME_MAX),
    name: clip(r.name, NAME_MAX),
    description: clip(r.description, DESC_MAX),
    counter: typeof r.counter === "number" ? r.counter : undefined,
  };
}

function validateSnapshot(raw: any, hostSteamId: string): RunLiveSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schemaVersion !== 1) return null;
  if (typeof raw.runId !== "string" || !RUN_ID_RE.test(raw.runId)) return null;
  if (typeof raw.hostSteamId !== "string" || raw.hostSteamId !== hostSteamId) return null;

  const snap: RunLiveSnapshot = {
    schemaVersion: 1,
    runId: raw.runId,
    hostSteamId,
    hostPersonaName: clip(raw.hostPersonaName, PERSONA_MAX) || "Steam User",
    hostAvatarUrl: typeof raw.hostAvatarUrl === "string" ? clip(raw.hostAvatarUrl, 256) : undefined,
    characterId: clip(raw.characterId, 24).toLowerCase(),
    ascension: Math.max(0, Math.min(20, num(raw.ascension, 0))),
    floor: Math.max(0, num(raw.floor, 0)),
    act: Math.max(1, Math.min(4, num(raw.act, 1))),
    hp: Math.max(0, num(raw.hp, 0)),
    maxHp: Math.max(1, num(raw.maxHp, 1)),
    gold: Math.max(0, num(raw.gold, 0)),
    deck: validateCards(raw.deck, 256),
    relics: Array.isArray(raw.relics)
      ? raw.relics.slice(0, 64).map(validateRelic).filter((r: any): r is RunLiveRelic => !!r)
      : [],
    potions: Array.isArray(raw.potions)
      ? raw.potions
          .slice(0, 5)
          .map((p: any) =>
            p && typeof p.id === "string"
              ? { id: clip(p.id, NAME_MAX), name: clip(p.name, NAME_MAX) }
              : null,
          )
          .filter((p: any): p is { id: string; name: string } => !!p)
      : [],
    combat: validateCombat(raw.combat),
    party: validateParty(raw.party),
    status:
      raw.status === "victory" || raw.status === "death" || raw.status === "abandoned"
        ? raw.status
        : "active",
    updatedAt: new Date().toISOString(),
  };
  return snap;
}

function validateCombat(c: any): RunLiveCombat | null {
  if (!c || typeof c !== "object") return null;
  const scene = typeof c.scene === "string" && SCENE_VALUES.has(c.scene) ? c.scene : null;
  return {
    scene,
    turn: typeof c.turn === "number" ? Math.max(0, c.turn) : undefined,
    energy: typeof c.energy === "number" ? c.energy : undefined,
    energyMax: typeof c.energyMax === "number" ? c.energyMax : undefined,
    hand: validateCards(c.hand, 16),
    block: typeof c.block === "number" ? Math.max(0, c.block) : undefined,
    enemies: Array.isArray(c.enemies)
      ? c.enemies
          .slice(0, 8)
          .map((e: any) =>
            e && typeof e.name === "string"
              ? {
                  name: clip(e.name, NAME_MAX),
                  hp: Math.max(0, num(e.hp, 0)),
                  maxHp: Math.max(1, num(e.maxHp, 1)),
                  intent: typeof e.intent === "string" ? clip(e.intent, 32) : undefined,
                  intentDamage: typeof e.intentDamage === "number" ? e.intentDamage : undefined,
                }
              : null,
          )
          .filter((e: any) => !!e)
      : undefined,
  };
}

function validateParty(arr: any): RunLivePartyMember[] {
  if (!Array.isArray(arr)) return [];
  const out: RunLivePartyMember[] = [];
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    if (typeof m.steamId !== "string" || !STEAM_ID_RE.test(m.steamId)) continue;
    out.push({
      steamId: m.steamId,
      personaName: typeof m.personaName === "string" ? clip(m.personaName, PERSONA_MAX) : undefined,
      characterId: typeof m.characterId === "string" ? clip(m.characterId, 24).toLowerCase() : undefined,
      hp: typeof m.hp === "number" ? Math.max(0, m.hp) : undefined,
      maxHp: typeof m.maxHp === "number" ? Math.max(1, m.maxHp) : undefined,
      block: typeof m.block === "number" ? Math.max(0, m.block) : undefined,
      hand: validateCards(m.hand, 16),
      deckSize: typeof m.deckSize === "number" ? Math.max(0, m.deckSize) : undefined,
      topRelicIds: Array.isArray(m.topRelicIds)
        ? m.topRelicIds.slice(0, 6).map((r: any) => clip(r, NAME_MAX)).filter(Boolean)
        : undefined,
    });
    if (out.length >= 8) break; // mp-cap mod allows up to 8
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// KV plumbing
// ────────────────────────────────────────────────────────────────────

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.LOBBIES.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function putJson(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  await env.LOBBIES.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

async function appendIndex(env: Env, runId: string): Promise<void> {
  const blob = await readJson<{ ids: string[] }>(env, RUNS_INDEX_KEY);
  const ids = blob?.ids ?? [];
  if (ids.includes(runId)) return;
  ids.push(runId);
  if (ids.length > INDEX_MAX) ids.splice(0, ids.length - INDEX_MAX);
  await putJson(env, RUNS_INDEX_KEY, { ids }, INDEX_TTL_S);
}

// ────────────────────────────────────────────────────────────────────
// Public API — called from coop-routes.ts
// ────────────────────────────────────────────────────────────────────

export interface IngestResult {
  ok: true;
  runId: string;
  ttl: number;
}

/**
 * Ingest one snapshot from a Companion mod build. The Steam ID is
 * authoritative from the bound session, never the body — a malicious
 * mod build can't forge another player's runId because the host
 * pointer is keyed on the SteamID off the auth session.
 */
export async function ingestModSnapshot(
  env: Env,
  hostSteamId: string,
  body: any,
): Promise<{ ok: true; result: IngestResult } | { ok: false; status: number; error: string; message: string }> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body", message: "Missing JSON body." };
  }
  if (body.schemaVersion !== 1) {
    return {
      ok: false,
      status: 400,
      error: "schema_unsupported",
      message: `Unsupported schemaVersion ${body.schemaVersion}. Update the Companion mod.`,
    };
  }
  if (typeof body.runId !== "string" || !RUN_ID_RE.test(body.runId)) {
    return { ok: false, status: 400, error: "invalid_run_id", message: "runId must be 6-40 alphanumeric chars." };
  }

  const snap = validateSnapshot(body.snapshot, hostSteamId);
  if (!snap) {
    return { ok: false, status: 400, error: "invalid_snapshot", message: "Snapshot failed validation." };
  }
  if (snap.runId !== body.runId) {
    return {
      ok: false,
      status: 400,
      error: "runid_mismatch",
      message: "snapshot.runId does not match top-level runId.",
    };
  }

  const ttl = body.closing ? POST_RUN_TTL_S : LIVE_TTL_S;

  await Promise.all([
    putJson(env, LIVE_PREFIX + snap.runId, snap, ttl),
    putJson(env, HOST_PTR_PREFIX + hostSteamId, { runId: snap.runId, updatedAt: snap.updatedAt }, ttl),
  ]);
  // Index is best-effort; missing it just means the run doesn't show
  // up in the global "live runs" feed, but direct /watch/<runId>
  // links still work.
  await appendIndex(env, snap.runId).catch(() => {});

  return { ok: true, result: { ok: true, runId: snap.runId, ttl } };
}

/** Read the live snapshot for a run. Returns null if expired/missing. */
export async function readLiveRun(env: Env, runId: string): Promise<RunLiveSnapshot | null> {
  if (!RUN_ID_RE.test(runId)) return null;
  return readJson<RunLiveSnapshot>(env, LIVE_PREFIX + runId);
}

/** Latest live runId for a host. Used by /watch/host/:steamId. */
export async function readHostLatestRunId(env: Env, steamId: string): Promise<string | null> {
  if (!STEAM_ID_RE.test(steamId)) return null;
  const ptr = await readJson<{ runId: string }>(env, HOST_PTR_PREFIX + steamId);
  return ptr?.runId ?? null;
}

/** List currently-live runs (newest first). Public. */
export async function listLiveRuns(env: Env): Promise<RunLiveSnapshot[]> {
  const blob = await readJson<{ ids: string[] }>(env, RUNS_INDEX_KEY);
  const ids = blob?.ids ?? [];
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readLiveRun(env, id)));
  const live = rows.filter((r): r is RunLiveSnapshot => !!r && r.status === "active");
  // Sort by updatedAt desc — most-recently-active first.
  live.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return live.slice(0, 50);
}
