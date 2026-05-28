/**
 * SpireVault House Lobby auto-renewer.
 *
 * Two persistent operator-hosted lobbies that ambient on the live board so
 * /coop/state never returns an empty `openLobbies` array during peak hours.
 * The single highest-leverage anti-cold-start move per the diagnostic
 * report — if a signed-in visitor lands on the empty lobby page and sees
 * nothing happening, they bounce. House lobbies guarantee there is always
 * something visible to click on, and an open seat to claim.
 *
 * ## Identity
 *
 * House lobbies are a FIRST-CLASS concept, not a spoofed user:
 *
 *   - `RunLobby.isHouseLobby = true` is the marker every consumer
 *     (rendering, filtering, join paths) keys off.
 *   - `RunLobby.houseSlug` is the stable template id
 *     (`house-a0-casual`, `house-a10-heart`) so the bot can recreate
 *     a specific template by name and the frontend can map slugs to
 *     curated copy / colors.
 *   - `hostSteamId` is a RESERVED synthetic Steam64 in the range
 *     `76561190000000000` + n. Steam's real ID space starts at
 *     `76561197960265728` (account number = 1, instance = 1,
 *     account type = individual), so anything below that is
 *     guaranteed to never collide with a real account. The 17-digit
 *     length matches the validator `^\d{17}$` so all existing
 *     Steam-ID-shaped code paths accept it without modification.
 *   - `hostPersonaName = "SpireVault House"` is rendered verbatim on
 *     the lobby card. There is no real human behind it; the joiner
 *     knows the lobby is an ambient room because of the badge the
 *     frontend will render (Stage A copy polish is being handled by
 *     the parallel worker; this module writes the data field they
 *     read).
 *
 * ## Lifecycle
 *
 * The renewer is invoked from two surfaces:
 *
 *   1. The `scheduled` handler in `index.ts` (cron `*\/15 * * * *`).
 *      Every 15 min the renewer:
 *        a. Acquires a 5-min KV-based mutex (`house-lobby:lock`).
 *        b. For each `HOUSE_LOBBIES` template, reads the pointer
 *           at `house-lobby:<slug>` to find the current `lobbyId`.
 *        c. If the lobby exists and `expiresAt > now + 10 min`,
 *           it's healthy — no-op.
 *        d. If `expiresAt <= now + 10 min`, EXTEND in place:
 *           bump `expiresAt` to `now + 35 min`, preserve everything
 *           else (lobbyId, seats, joiners, party). Real human
 *           joiners are NEVER kicked by the renewer.
 *        e. If the lobby doesn't exist (first run, manually closed,
 *           KV gc), CREATE a fresh lobby and store the new pointer.
 *
 *   2. The admin surface `/admin/house-lobbies/*` (in `index.ts`):
 *      - `POST /admin/house-lobbies/run-now` forces a renewer pass.
 *      - `POST /admin/house-lobbies/close-all` is the kill switch.
 *      - `GET  /admin/house-lobbies/status` returns the current state.
 *      All three require `Authorization: Bearer <HOUSE_LOBBY_ADMIN_SECRET>`.
 *
 * ## Peak-hours gate
 *
 * "Peak hours" are UTC 18:00–06:00 (covers EU evenings + the full NA
 * evening). Outside peak the renewer:
 *   - Does NOT create new lobbies — small organic activity has room
 *     to breathe without House drowning it out.
 *   - DOES extend existing lobbies that have at least one real human
 *     joiner so we never break a live game just because the clock
 *     ticked off-peak.
 *   - LETS empty House lobbies expire naturally instead of force-
 *     closing them (avoids ungraceful UX where the lobby disappears
 *     while someone is mid-tap).
 *
 * ## Idempotence + safety
 *
 *  - Running the renewer twice in a row is a no-op the second time.
 *  - The KV mutex prevents two concurrent cron triggers from racing
 *    (Cloudflare retries cron deliveries on transient errors, and we
 *    don't want two `createLobby` calls minting twin lobbies that
 *    both grab the slug pointer).
 *  - The renewer is best-effort per template: a failure on one
 *    template doesn't abort the others. All errors are captured into
 *    the result struct so the admin status endpoint can surface them.
 *  - Every renewer pass logs a single `[house-lobbies]` line with
 *    {created, extended, errors, peak, locked}. Grep-friendly for
 *    `wrangler tail`.
 *
 * ## What this module deliberately does NOT do
 *
 *  - It does NOT route through `createLobby` in `coop-engine.ts` —
 *    that function runs profile lookups, presence side-effects, and
 *    in-session/in-party guards that don't apply to a synthetic host.
 *    We construct the `RunLobby` directly and `writeLobby` it.
 *  - It does NOT write a presence row for the synthetic Steam ID.
 *    Presence has a 5-min TTL but cron is 15-min, so a presence row
 *    would expire mid-cycle and the lobby would vanish from
 *    `/coop/state` (the filter requires fresh host presence). Instead
 *    we made the filter and the join path bypass the presence check
 *    when `lobby.isHouseLobby` is true. See `coop-routes.ts`
 *    (`buildStateBundle`) and `coop-engine.ts` (`joinLobbySeat`,
 *    `requestToJoinLobby`).
 *  - It does NOT enqueue the House host into the party state machine
 *    on its own. Real human joiners go through the normal
 *    `joinLobbySeat` flow which creates a party with the House host
 *    as slot 1 and the joiner as slot 2.
 *
 * ## Synthetic-host-ready patch (v0.2, urgent)
 *
 * The frontend ready-up runtime gates the party launch on
 *   `liveMembers.every(m => m.status === "ready" || "in_game")`.
 * The synthetic host has no client, so its slot is permanently
 * stuck on `"joined"` and every party with a House host is
 * un-launchable — joiners see "Waiting on SpireVault House" and
 * bounce.
 *
 * Fix (Option A — auto-ready the synthetic host):
 *   1. `ensurePartyForLobby` in `coop-engine.ts` seeds the synthetic
 *      host's seat as `"ready"` (with `readyAt` stamped) the moment
 *      a party is minted around a House lobby. Newly-created House
 *      parties launch correctly with no further action.
 *   2. Every renewer pass calls `ensureHouseHostReadyInParty` for
 *      each live House lobby. The call is idempotent and only patches
 *      synthetic hosts that are still on `"joined"`; it never
 *      regresses a host that has advanced to `"in_game"`. This is
 *      how the two currently-stuck human joiners get unblocked
 *      retroactively without a forced lobby recycle.
 *
 * We rejected Option B (`isAmbientHost` + frontend opt-out of launch
 * sync) because the launch sync lives entirely in JS frontend code
 * and the parallel frontend worker owns those files this sprint —
 * the backend equivalent of "opt out of the gate" is exactly
 * Option A: hand the gate a status it already accepts.
 *
 * Option C (auto-promote a real joiner to host on 2nd human join) is
 * the structurally cleanest long-term answer but touches the by-host
 * KV index, the slug pointer, presence rows, and renewer invariants.
 * Deferred — file as a follow-up once Option A has paid down the
 * immediate joiner-trap cost.
 */

import type { Env } from "./types";
import type { CoopGoal, RunLobby, RunLobbySize } from "./coop-types";
import {
  COOP_LOBBY_TTL_S,
  deleteParty,
  getPartyIdForLobby,
  newRandomId,
  readLobby,
  readParty,
  writeLobby,
  deleteLobby,
} from "./coop-store";
import { ensureHouseHostReadyInParty } from "./coop-engine";
import { getSessionProfile } from "./presence";

// ────────────────────────────────────────────────────────────────────
// Types + configs
// ────────────────────────────────────────────────────────────────────

/**
 * Static template for a House lobby. Add new entries here to spin up
 * additional ambient lobbies — the renewer picks them up automatically.
 *
 * The `hostSteamId` MUST be in the reserved synthetic range
 * `765611900000000XX`. See module doc for the rationale.
 */
export interface HouseLobbyConfig {
  /** Stable id (kebab-case). Used as the KV pointer key suffix. */
  slug: string;
  /** Display title rendered verbatim on the lobby card. */
  title: string;
  /** Reserved synthetic Steam64. NEVER overlaps with real Steam accounts. */
  hostSteamId: string;
  /** Run goal (drives matching score + frontend filter chips). */
  goal: CoopGoal;
  /** Single ascension target (used for both min and max). */
  ascension: number;
  /** Lobby seat count INCLUDING the House placeholder host (so 4 = 3 humans). */
  seatCount: RunLobbySize;
  /** Optional short host note rendered under the title. ≤160 chars. */
  note: string;
  /** Optional friendly tags for the frontend (display only, no semantics). */
  tags?: readonly string[];
}

/**
 * The two ambient lobbies. Order is the spawn order — slot 1 (A0 Casual)
 * gets created first so even a partial renewer pass keeps the friendlier
 * room visible. Add more templates by appending entries; the renewer
 * iterates this array in order.
 */
export const HOUSE_LOBBIES: readonly HouseLobbyConfig[] = [
  {
    slug: "house-a0-casual",
    title: "SpireVault House · A0 Casual · all welcome",
    // Reserved synthetic Steam64. Below 76561197960265728 — guaranteed
    // to never collide with any real Steam individual account.
    hostSteamId: "76561190000000001",
    goal: "casual",
    ascension: 0,
    seatCount: 4,
    note: "Ambient room — drop in for a chill A0 run. New to co-op? Start here.",
    tags: ["house", "casual", "any-character"],
  },
  {
    slug: "house-a10-heart",
    title: "SpireVault House · A10 Heart Attempts",
    hostSteamId: "76561190000000002",
    goal: "heart",
    ascension: 10,
    seatCount: 4,
    note: "Ambient A10 Heart pugs. Voice optional. Bring your favorite hero.",
    tags: ["house", "a10", "heart"],
  },
];

// Public helper so callers can look up a template by slug without
// re-implementing the find. Returns undefined for unknown slugs.
export function getHouseLobbyConfig(
  slug: string,
): HouseLobbyConfig | undefined {
  return HOUSE_LOBBIES.find((c) => c.slug === slug);
}

// ────────────────────────────────────────────────────────────────────
// KV keys
// ────────────────────────────────────────────────────────────────────

const HOUSE_LOBBY_POINTER_PREFIX = "house-lobby:";
const HOUSE_LOBBY_LOCK_KEY = "house-lobby:lock";
const HOUSE_LOBBY_LOCK_TTL_S = 5 * 60;
// Pointer KV TTL = 24h. The pointer is just a short string ("which
// lobbyId is currently this slug"), so we keep it longer than any
// individual lobby to survive a long off-peak window where lobbies
// expire naturally but the slug→lobbyId mapping should still be
// findable by the next renewer pass for diagnostics.
const HOUSE_LOBBY_POINTER_TTL_S = 24 * 60 * 60;

// "Healthy" = the lobby's `expiresAt` is more than this many ms in the
// future. Anything closer triggers a 35-min extend. With a 15-min cron
// and a 35-min lobby TTL, we have a comfortable 2x safety margin: even
// if a single cron tick is dropped entirely, the next one (≤30 min
// later) still extends before the lobby would expire.
const HOUSE_LOBBY_HEALTHY_MARGIN_MS = 10 * 60 * 1000;

// ────────────────────────────────────────────────────────────────────
// Peak-hours gate
// ────────────────────────────────────────────────────────────────────

/**
 * Peak hours in UTC. Returns true when `at` falls inside the peak
 * window (18:00 UTC inclusive → 06:00 UTC exclusive next day, i.e.
 * the window WRAPS through midnight). Covers EU evenings (18:00–23:00
 * UTC ≈ 19:00–24:00 CET) and the full NA evening (18:00–06:00 UTC ≈
 * 14:00–02:00 ET / 11:00–23:00 PT).
 *
 * Off-peak (06:00–18:00 UTC ≈ NA overnight + early morning) is the
 * quiet window. We respect organic activity there and don't seed.
 */
export function isPeakHourUTC(at: Date = new Date()): boolean {
  const h = at.getUTCHours();
  // 18..23 inclusive OR 0..5 inclusive ≡ 12 hours of peak per day.
  return h >= 18 || h < 6;
}

// ────────────────────────────────────────────────────────────────────
// Renewer result types
// ────────────────────────────────────────────────────────────────────

export interface HouseLobbyRunSummary {
  ranAt: string;
  peak: boolean;
  /** Slugs whose lobby was CREATED fresh (didn't exist before). */
  created: string[];
  /** Slugs whose lobby was EXTENDED in place (expiresAt bumped). */
  extended: string[];
  /** Slugs whose lobby was already healthy and untouched. */
  healthy: string[];
  /**
   * Slugs whose creation was SKIPPED due to peak-hours gating. The
   * lobby pointer was absent (or pointed at a dead lobby) and the
   * clock is off-peak, so we deliberately did not seed.
   */
  skippedOffPeak: string[];
  /**
   * Slugs whose ACTIVE PARTY had its synthetic-host seat retroactively
   * flipped from `"joined"` to `"ready"` this pass. Empty under normal
   * operation — populated only when an older party (minted before the
   * v0.2 House-host-ready fix shipped) is still alive and held a
   * stuck synthetic-host seat. See `ensureHouseHostReadyInParty` in
   * `coop-engine.ts` for the patch semantics.
   */
  hostPatched: string[];
  /** Per-slug error messages collected during the pass. */
  errors: { slug: string; message: string }[];
  /** True iff we held the renewer lock; false on a contended pass. */
  locked: boolean;
}

export interface HouseLobbyStatusEntry {
  slug: string;
  title: string;
  lobbyId: string | null;
  status: "open" | "full" | "missing" | "stale";
  expiresAt: string | null;
  /** Minutes until `expiresAt`. Negative = already past. */
  expiresInMinutes: number | null;
  /** Count of accepted members EXCLUDING the synthetic House host. */
  humanJoinerCount: number;
  acceptedMemberSteamIds: string[];
}

export interface HouseLobbyAdminStatus {
  now: string;
  peak: boolean;
  entries: HouseLobbyStatusEntry[];
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Top-level renewer entry point. Idempotent. Safe to call from the
 * cron `scheduled` handler OR from the admin `run-now` endpoint.
 *
 * The lock is a soft mutex backed by `KV.put(lock, ..., expirationTtl)`.
 * KV is eventually consistent so the lock is best-effort — two cron
 * triggers firing within a few hundred ms could both observe an empty
 * lock and proceed. We accept that race because:
 *   (a) The renewer is idempotent — both passes will end with the
 *       same KV state.
 *   (b) The pointer write is last-writer-wins, so at worst one of the
 *       two losing-race lobbies leaks into KV with no pointer. It
 *       expires on its own 35 min later.
 * If `force=true`, the caller bypasses the lock check (used by
 * admin `run-now` so an operator can force a pass without waiting
 * for the next cron tick).
 */
export async function runHouseLobbyRenewer(
  env: Env,
  opts: { force?: boolean } = {},
): Promise<HouseLobbyRunSummary> {
  const ranAt = new Date();
  const summary: HouseLobbyRunSummary = {
    ranAt: ranAt.toISOString(),
    peak: isPeakHourUTC(ranAt),
    created: [],
    extended: [],
    healthy: [],
    skippedOffPeak: [],
    hostPatched: [],
    errors: [],
    locked: false,
  };

  // Soft mutex. A force-pass (operator-triggered) ignores the lock so
  // an operator never gets stuck waiting on a stuck/abandoned lock.
  if (!opts.force) {
    const lockHolder = await env.LOBBIES.get(HOUSE_LOBBY_LOCK_KEY);
    if (lockHolder) {
      console.log(
        `[house-lobbies] skip: lock held (holder=${lockHolder}, t=${summary.ranAt})`,
      );
      return summary;
    }
  }
  const lockToken = newRandomId();
  try {
    await env.LOBBIES.put(HOUSE_LOBBY_LOCK_KEY, lockToken, {
      expirationTtl: HOUSE_LOBBY_LOCK_TTL_S,
    });
    summary.locked = true;
  } catch (err) {
    // If lock write itself fails, proceed anyway — the worst case is
    // a contended pass which is still idempotent.
    summary.errors.push({
      slug: "_lock",
      message: `lock write failed: ${stringifyErr(err)}`,
    });
  }

  for (const config of HOUSE_LOBBIES) {
    try {
      await renewSingle(env, config, summary);
    } catch (err) {
      summary.errors.push({
        slug: config.slug,
        message: stringifyErr(err),
      });
    }
  }

  console.log(
    `[house-lobbies] pass ranAt=${summary.ranAt} peak=${summary.peak} ` +
      `locked=${summary.locked} created=${JSON.stringify(summary.created)} ` +
      `extended=${JSON.stringify(summary.extended)} ` +
      `healthy=${JSON.stringify(summary.healthy)} ` +
      `skippedOffPeak=${JSON.stringify(summary.skippedOffPeak)} ` +
      `hostPatched=${JSON.stringify(summary.hostPatched)} ` +
      `errors=${summary.errors.length}`,
  );
  for (const e of summary.errors) {
    console.log(`[house-lobbies] error slug=${e.slug} msg=${e.message}`);
  }

  // Best-effort lock release. If the lock TTL hits first that's fine —
  // the next pass will just observe an empty lock and proceed.
  if (summary.locked) {
    try {
      // Only release if we still own it (constant-time-ish compare to
      // avoid clobbering a lock taken by a parallel pass after TTL).
      const current = await env.LOBBIES.get(HOUSE_LOBBY_LOCK_KEY);
      if (current === lockToken) {
        await env.LOBBIES.delete(HOUSE_LOBBY_LOCK_KEY);
      }
    } catch {
      /* let the TTL clear it */
    }
  }

  return summary;
}

/**
 * Snapshot the current state of all House lobbies for the operator
 * admin endpoint. Purely a read — no writes, no side effects.
 */
export async function getHouseLobbyStatus(
  env: Env,
): Promise<HouseLobbyAdminStatus> {
  const now = Date.now();
  const entries: HouseLobbyStatusEntry[] = [];
  for (const config of HOUSE_LOBBIES) {
    const pointer = await readPointer(env, config.slug);
    if (!pointer) {
      entries.push({
        slug: config.slug,
        title: config.title,
        lobbyId: null,
        status: "missing",
        expiresAt: null,
        expiresInMinutes: null,
        humanJoinerCount: 0,
        acceptedMemberSteamIds: [],
      });
      continue;
    }
    const lobby = await readLobby(env, pointer);
    if (!lobby) {
      entries.push({
        slug: config.slug,
        title: config.title,
        lobbyId: pointer,
        status: "stale",
        expiresAt: null,
        expiresInMinutes: null,
        humanJoinerCount: 0,
        acceptedMemberSteamIds: [],
      });
      continue;
    }
    const exp = Date.parse(lobby.expiresAt);
    const accepted = lobby.acceptedMemberSteamIds ?? [];
    entries.push({
      slug: config.slug,
      title: config.title,
      lobbyId: lobby.lobbyId,
      status: lobby.status === "full" ? "full" : "open",
      expiresAt: lobby.expiresAt,
      expiresInMinutes: Number.isFinite(exp)
        ? Math.round((exp - now) / 60_000)
        : null,
      humanJoinerCount: accepted.filter((sid) => sid !== config.hostSteamId)
        .length,
      acceptedMemberSteamIds: accepted,
    });
  }
  return {
    now: new Date(now).toISOString(),
    peak: isPeakHourUTC(new Date(now)),
    entries,
  };
}

/**
 * Emergency kill switch. Iterates every House lobby template, deletes
 * the underlying lobby record + by-host pointer + the slug pointer.
 * Real human joiners get dropped — this is operator-pulled and the
 * intent is explicitly to shut down ambient activity. Safe to call
 * even when no lobby exists for a slug (idempotent).
 */
export async function closeAllHouseLobbies(
  env: Env,
): Promise<{ closed: string[]; errors: { slug: string; message: string }[] }> {
  const closed: string[] = [];
  const errors: { slug: string; message: string }[] = [];
  for (const config of HOUSE_LOBBIES) {
    try {
      const pointer = await readPointer(env, config.slug);
      if (pointer) {
        const lobby = await readLobby(env, pointer);
        if (lobby) {
          await deleteLobby(env, lobby);
          closed.push(config.slug);
        }
      }
      await deletePointer(env, config.slug);
    } catch (err) {
      errors.push({ slug: config.slug, message: stringifyErr(err) });
    }
  }
  console.log(
    `[house-lobbies] close-all ranAt=${new Date().toISOString()} ` +
      `closed=${JSON.stringify(closed)} errors=${errors.length}`,
  );
  return { closed, errors };
}

// ────────────────────────────────────────────────────────────────────
// Per-template renewer
// ────────────────────────────────────────────────────────────────────

async function renewSingle(
  env: Env,
  config: HouseLobbyConfig,
  summary: HouseLobbyRunSummary,
): Promise<void> {
  const now = Date.now();
  const pointer = await readPointer(env, config.slug);
  let existingLobby = pointer ? await readLobby(env, pointer) : null;
  // Holds whichever lobby record is the live one at end-of-pass —
  // either the existing one (after a healthy no-op or an extend) or
  // the freshly created one. We always run the synthetic-host-ready
  // patch against this reference before returning so any party that
  // was minted before the v0.2 fix gets unstuck on the next pass.
  let liveLobby: RunLobby | null = null;

  // Option C aftermath: if a real joiner promoted themselves to host
  // (`promoteHouseJoinerToHost`), the registry pointer is stale by
  // design — the lobby record still exists but `isHouseLobby` is
  // now false. Clear the pointer so this pass falls through to
  // "create a fresh House lobby for the slug." Do NOT extend the
  // promoted lobby's TTL: it's a normal player-hosted room now and
  // lives or dies on its own heartbeat lifecycle.
  if (existingLobby && !existingLobby.isHouseLobby) {
    await deletePointer(env, config.slug);
    existingLobby = null;
  }

  // The lobby exists. Decide between no-op (healthy), extend, or
  // a fall-through-to-recreate path when it's already terminal.
  if (existingLobby) {
    if (existingLobby.status === "closed" || existingLobby.status === "expired") {
      await deletePointer(env, config.slug);
      existingLobby = null;
    } else {
      const exp = Date.parse(existingLobby.expiresAt);
      const isHealthy =
        Number.isFinite(exp) && exp > now + HOUSE_LOBBY_HEALTHY_MARGIN_MS;
      if (isHealthy) {
        summary.healthy.push(config.slug);
        liveLobby = existingLobby;
      } else {
        // Has real human joiners? Extend even if off-peak — never break
        // a live game just because the clock ticked.
        const humanJoiners = (existingLobby.acceptedMemberSteamIds ?? []).filter(
          (sid) => sid !== config.hostSteamId,
        );
        const shouldExtend = summary.peak || humanJoiners.length > 0;
        if (!shouldExtend) {
          // Off-peak + no joiners + expiring soon → let it die. No
          // live lobby reference to patch; bail.
          summary.skippedOffPeak.push(config.slug);
          return;
        }
        await extendInPlace(env, existingLobby, now);
        summary.extended.push(config.slug);
        liveLobby = existingLobby;
      }
    }
  }

  // No existing lobby (either never existed or was terminal). Only
  // create during peak hours; off-peak we leave the slot dormant.
  if (!liveLobby) {
    if (!summary.peak) {
      summary.skippedOffPeak.push(config.slug);
      return;
    }
    liveLobby = await createFreshHouseLobby(env, config, now);
    summary.created.push(config.slug);
  }

  // Synthetic-host-ready patch. Idempotent and cheap (1 KV read for
  // the party id, then 0–1 KV write). This is the path that
  // retroactively unsticks parties that were minted before v0.2
  // shipped — without it, the two real joiners sitting in the
  // current A0 Casual / A10 Heart lobbies would stay blocked
  // staring at "Waiting on SpireVault House" until they
  // bounced. Errors are swallowed into the summary so a bad party
  // record on one slug doesn't abort the renewer for the other.
  try {
    const { patched } = await ensureHouseHostReadyInParty(env, liveLobby);
    if (patched) summary.hostPatched.push(config.slug);
  } catch (err) {
    summary.errors.push({
      slug: config.slug,
      message: `host-ready patch failed: ${stringifyErr(err)}`,
    });
  }
}

async function extendInPlace(
  env: Env,
  lobby: RunLobby,
  nowMs: number,
): Promise<void> {
  // Preserve everything (lobbyId, seats, joiners, partyId, all state)
  // and only refresh the lifetime window. This is the path that
  // guarantees real human joiners are NOT kicked when the renewer
  // ticks — same lobby, same seats, just `expiresAt` slides forward.
  lobby.updatedAt = new Date(nowMs).toISOString();
  lobby.expiresAt = new Date(nowMs + COOP_LOBBY_TTL_S * 1000).toISOString();
  await writeLobby(env, lobby);
}

async function createFreshHouseLobby(
  env: Env,
  config: HouseLobbyConfig,
  nowMs: number,
): Promise<RunLobby> {
  const lobby: RunLobby = {
    lobbyId: newRandomId(),
    hostSteamId: config.hostSteamId,
    hostPersonaName: "SpireVault House",
    // Pages serves /assets/vault-mark.svg at app.spirevault.app. The
    // frontend renders this path verbatim and resolves it on its own
    // origin, so a relative path is correct (and survives if/when
    // the static asset host changes).
    hostAvatarUrl: "/assets/vault-mark.svg",
    title: config.title,
    mode: config.goal,
    goal: config.goal,
    lobbySize: config.seatCount,
    ascensionMin: config.ascension,
    ascensionMax: config.ascension,
    // House lobbies use OPEN-JOIN semantics (approvalRequired: false)
    // so a curious visitor can claim a seat in one tap. The synthetic
    // host has no human behind it to approve requests anyway —
    // approval-required would just leave joiners stuck.
    approvalRequired: false,
    voicePreset: "any",
    note: config.note,
    status: "open",
    acceptedMemberSteamIds: [config.hostSteamId],
    pendingSeatRequestSteamIds: [],
    memberSteamIds: [config.hostSteamId],
    pendingJoinRequestSteamIds: [],
    isHouseLobby: true,
    houseSlug: config.slug,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + COOP_LOBBY_TTL_S * 1000).toISOString(),
  };
  await writeLobby(env, lobby);
  await writePointer(env, config.slug, lobby.lobbyId);
  return lobby;
}

// ────────────────────────────────────────────────────────────────────
// Pointer helpers
// ────────────────────────────────────────────────────────────────────

async function readPointer(env: Env, slug: string): Promise<string | null> {
  const v = await env.LOBBIES.get(HOUSE_LOBBY_POINTER_PREFIX + slug);
  return v && /^[0-9a-f]{32}$/.test(v) ? v : null;
}

async function writePointer(
  env: Env,
  slug: string,
  lobbyId: string,
): Promise<void> {
  await env.LOBBIES.put(HOUSE_LOBBY_POINTER_PREFIX + slug, lobbyId, {
    expirationTtl: HOUSE_LOBBY_POINTER_TTL_S,
  });
}

async function deletePointer(env: Env, slug: string): Promise<void> {
  try {
    await env.LOBBIES.delete(HOUSE_LOBBY_POINTER_PREFIX + slug);
  } catch {
    /* best-effort */
  }
}

// ────────────────────────────────────────────────────────────────────
// Option C — Auto-promote first real joiner to host
// ────────────────────────────────────────────────────────────────────

/**
 * Recompute the title of a promoted House lobby so it reads as the
 * new host's room rather than "SpireVault House · …". Kept short and
 * predictable so existing title-driven UX (deep-links, search) keeps
 * working.
 *
 *   "SpireVault House · A0 Casual · all welcome"  →  "<persona> · A0 Casual"
 *   "SpireVault House · A10 Heart Attempts"       →  "<persona> · A10 Heart Attempts"
 *
 * If the existing title doesn't start with the House prefix we leave
 * it alone — the lobby was already a normal lobby (defensive).
 */
function promoteTitle(existingTitle: string, persona: string): string {
  const prefix = "SpireVault House · ";
  const safePersona = (persona || "Steam Climber").trim().slice(0, 32);
  if (existingTitle && existingTitle.startsWith(prefix)) {
    let rest = existingTitle.slice(prefix.length);
    // Strip the trailing " · all welcome" decoration so the new owner
    // doesn't inherit operator copy.
    rest = rest.replace(/\s*·\s*all welcome\s*$/i, "").trim();
    if (rest.length > 0) return `${safePersona} · ${rest}`;
  }
  return existingTitle || `${safePersona} · Open room`;
}

/**
 * Promote the first real human joiner to be the lobby's host (Option C).
 *
 * Returns the rewritten lobby on a successful promotion or `null` when
 * the lobby isn't a House lobby anymore (already promoted by a parallel
 * request, lock contention, etc). The caller continues the normal join
 * flow against whichever lobby record they end up with.
 *
 * Side effects:
 *   - Rewrites `lobby.hostSteamId` to the real joiner. Updates persona
 *     name + avatar from the joiner's session profile.
 *   - Rewrites the title with `promoteTitle` (see above).
 *   - Clears `isHouseLobby` + `houseSlug` so every consumer treats the
 *     lobby as a normal player-hosted room from this moment on.
 *   - Sets `acceptedMemberSteamIds` and `memberSteamIds` to `[real]` —
 *     the synthetic host steps out, and the joiner is now in seat 1.
 *   - Deletes the `coop:lobby:by-host:<synth>` pointer.
 *     `writeLobby` writes the `coop:lobby:by-host:<real>` pointer.
 *   - Deletes the slug pointer (`house-lobby:<slug>`) so the next
 *     renewer pass mints a fresh House lobby for that slug.
 *   - Deletes any party that was previously minted around the
 *     synthetic host. The caller is expected to mint a fresh party
 *     against the promoted lobby via `ensurePartyForLobby`.
 *
 * Concurrency:
 *   - A KV mutex `house-lobby:promote:<lobbyId>` (TTL 10s) protects
 *     against two simultaneous joiners both promoting. KV puts are
 *     eventually consistent so the lock is best-effort — we follow it
 *     up with a fresh `readLobby` post-acquisition and bail if
 *     `isHouseLobby` is already false.
 *   - Idempotent on a second call: returns `null` if the lobby has
 *     already been promoted. Safe to re-enter from the engine.
 */
const HOUSE_LOBBY_PROMOTE_LOCK_PREFIX = "house-lobby:promote:";
const HOUSE_LOBBY_PROMOTE_LOCK_TTL_S = 10;

export async function promoteHouseJoinerToHost(
  env: Env,
  lobby: RunLobby,
  realJoinerSteamID: string,
): Promise<RunLobby | null> {
  if (!lobby.isHouseLobby) return null;
  if (!realJoinerSteamID || realJoinerSteamID === lobby.hostSteamId) {
    return null;
  }

  const lockKey = HOUSE_LOBBY_PROMOTE_LOCK_PREFIX + lobby.lobbyId;
  // Soft mutex — KV puts settle within seconds. We accept the same
  // race we accept in `runHouseLobbyRenewer`: if two requests both
  // observe an empty lock, the post-acquisition `readLobby` below
  // catches the second one and it returns null.
  const existing = await env.LOBBIES.get(lockKey);
  if (existing) return null;

  const lockToken = newRandomId();
  try {
    await env.LOBBIES.put(lockKey, lockToken, {
      expirationTtl: HOUSE_LOBBY_PROMOTE_LOCK_TTL_S,
    });
  } catch {
    /* fall through — promotion is still safe on the second read */
  }

  let promoted: RunLobby | null = null;
  try {
    // Re-read after lock acquisition. If a parallel request already
    // promoted, `isHouseLobby` will be false here and we bail.
    const fresh = await readLobby(env, lobby.lobbyId);
    if (!fresh || !fresh.isHouseLobby) return null;
    if (fresh.status !== "open") return null;

    const slug = fresh.houseSlug;
    const synthSid = fresh.hostSteamId;

    const profile = await getSessionProfile(env, realJoinerSteamID);
    const personaName = profile?.personaName ?? "Steam Climber";
    const avatarUrl = profile?.avatarURL || undefined;

    const next: RunLobby = {
      ...fresh,
      hostSteamId: realJoinerSteamID,
      hostPersonaName: personaName,
      hostAvatarUrl: avatarUrl,
      title: promoteTitle(fresh.title, personaName),
      isHouseLobby: false,
      houseSlug: undefined,
      acceptedMemberSteamIds: [realJoinerSteamID],
      memberSteamIds: [realJoinerSteamID],
      // Drop the partyId so the caller's `ensurePartyForLobby` mints a
      // fresh party with the real joiner as host. The old party (if
      // any existed) was built around the synthetic host and has the
      // wrong `hostSteamId` to reuse. We delete the underlying record
      // below so the lobby→party pointer doesn't leak it back.
      partyId: undefined,
      updatedAt: new Date().toISOString(),
    };

    // The synthetic host's by-host index used to point at this lobby.
    // Clear it explicitly — `writeLobby` would only update the by-host
    // index for the NEW host (real joiner), not delete the old one.
    if (synthSid) {
      try {
        await env.LOBBIES.delete(`coop:lobby:by-host:${synthSid}`);
      } catch {
        /* best-effort */
      }
    }

    // Tear down any party that was minted around the synthetic host
    // before this promotion (would have `hostSteamId === synthSid`
    // and stale members). The caller mints a fresh one for the
    // promoted lobby.
    const prevPartyId =
      fresh.partyId || (await getPartyIdForLobby(env, fresh.lobbyId));
    if (prevPartyId) {
      const prevParty = await readParty(env, prevPartyId);
      if (prevParty) {
        try {
          await deleteParty(env, prevParty);
        } catch {
          /* best-effort */
        }
      }
    }

    await writeLobby(env, next);

    // Clear the House registry pointer. The next renewer pass will
    // observe `null` here and mint a fresh House lobby for the slug.
    if (slug) {
      await deletePointer(env, slug);
    }

    console.log(
      `[house-lobbies] promoted slug=${slug ?? "?"} ` +
        `from=${synthSid} to=${realJoinerSteamID} ` +
        `lobbyId=${fresh.lobbyId}`,
    );
    promoted = next;
  } finally {
    // Best-effort lock release. If we owned the lock, delete it; if
    // the TTL hits first or another worker took over after expiry,
    // leave their token alone.
    try {
      const cur = await env.LOBBIES.get(lockKey);
      if (cur === lockToken) {
        await env.LOBBIES.delete(lockKey);
      }
    } catch {
      /* TTL fallback */
    }
  }

  return promoted;
}

// ────────────────────────────────────────────────────────────────────
// Utilities
// ────────────────────────────────────────────────────────────────────

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
