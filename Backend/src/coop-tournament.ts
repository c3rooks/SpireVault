/**
 * Co-op tournament brackets — cosmetic-only prizes, no Stripe.
 *
 * Why we ship without Stripe:
 *
 *   The plan explicitly chose cosmetic-only prizes for the first
 *   tournament cycle. That removes the entire Stripe integration
 *   surface (KYC, refunds, dispute handling, regional licensing)
 *   while still delivering the moat — no other STS2 tool has
 *   tournament infrastructure at all. We can layer paid prizes on
 *   later when there's measurable demand, without breaking the
 *   bracket data model.
 *
 * Bracket model (single elimination, 4 or 8 teams):
 *
 *   round 0 (quarterfinals)   : 4 matches  (8-team only)
 *   round 1 (semifinals)      : 2 matches
 *   round 2 (finals)          : 1 match
 *
 *   Each match is a slot pair. Winners advance into the next
 *   round's slot computed by floor(matchIndex/2).
 *
 *   Match scoring is reported manually by the host (or auto-derived
 *   from a closed RunLiveSnapshot when the Companion mod is in play).
 *   We trust the report — disputes get handled in Discord.
 *
 * Storage:
 *
 *   tournament:<id>          → Tournament JSON (TTL 14 days)
 *   tournament:index         → list of recent tournament ids
 *   tournament:slug:<slug>   → tournament id (URL slug → id lookup)
 *
 * Anti-abuse:
 *
 *   - Only the organizer can advance brackets (steamId stored in tournament)
 *   - Rate limit is per-user on writes (handled in coop-routes.ts)
 *   - Bracket size is capped at 8 — no surprise tournaments of 64
 */

import type { Env } from "./types";

export type TournamentStatus = "draft" | "open" | "running" | "complete" | "cancelled";
export type TournamentSize = 4 | 8;

export interface TournamentTeam {
  /** Stable team id; ULID-ish. */
  teamId: string;
  /** Display name; capped at 64 chars. */
  name: string;
  /** Steam IDs of team members; min 1, max 4. */
  memberSteamIds: string[];
  /** Optional contact handle (Discord, etc). */
  contact?: string;
  /** Server-stamped on registration. */
  registeredAt: string;
}

export interface TournamentMatch {
  /** Round 0/1/2 + slot index uniquely identifies a match. */
  round: number;
  slot: number;
  teamA?: string; // teamId
  teamB?: string;
  /** Winner's teamId once the match is reported. */
  winner?: string;
  /** Free-form score line ("3-1", "Foo died on F50, Bar cleared"). */
  score?: string;
  /** ISO when reported. */
  reportedAt?: string;
}

export interface Tournament {
  schemaVersion: 1;

  tournamentId: string;
  /** Public URL slug. */
  slug: string;
  title: string;
  /** Long-form description, rules, prize description. */
  description: string;

  organizerSteamId: string;
  organizerPersona: string;

  size: TournamentSize;
  status: TournamentStatus;
  /** Cosmetic prize description. Free-form text — no payments. */
  prize: string;

  /** Optional ascension constraint (e.g. "all matches A10"). */
  ascensionMin?: number;
  ascensionMax?: number;

  /** ISO when registration opens / closes. */
  registrationOpensAt: string;
  registrationClosesAt: string;
  /** ISO when first match is expected to start. */
  startsAt: string;

  teams: TournamentTeam[];
  matches: TournamentMatch[];

  createdAt: string;
  updatedAt: string;
}

const TOURNAMENT_PREFIX = "tournament:";
const TOURNAMENT_SLUG_PREFIX = "tournament:slug:";
const TOURNAMENT_INDEX_KEY = "tournament:index";
const TOURNAMENT_TTL_S = 14 * 24 * 60 * 60;
const INDEX_TTL_S = 30 * 24 * 60 * 60;
const INDEX_MAX = 100;

const TITLE_MAX = 96;
const DESC_MAX = 1200;
const NAME_MAX = 64;
const PRIZE_MAX = 200;
const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const STEAM_ID_RE = /^\d{17}$/;

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface CreateTournamentInput {
  slug: string;
  title: string;
  description?: string;
  size: TournamentSize;
  prize?: string;
  ascensionMin?: number;
  ascensionMax?: number;
  registrationClosesAt: string;
  startsAt: string;
}

export async function createTournament(
  env: Env,
  organizerSteamId: string,
  organizerPersona: string,
  body: CreateTournamentInput,
): Promise<{ ok: true; tournament: Tournament } | { ok: false; status: number; error: string; message: string }> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body", message: "Missing JSON body." };
  }
  if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
    return { ok: false, status: 400, error: "invalid_slug", message: "slug must be 3-40 chars, lowercase letters/digits/dash." };
  }
  if (body.size !== 4 && body.size !== 8) {
    return { ok: false, status: 400, error: "invalid_size", message: "size must be 4 or 8." };
  }
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, status: 400, error: "invalid_title", message: "title is required." };
  }

  // Slug uniqueness check.
  const existingId = await env.LOBBIES.get(TOURNAMENT_SLUG_PREFIX + body.slug);
  if (existingId) {
    return { ok: false, status: 409, error: "slug_taken", message: "That slug is already in use." };
  }

  const tournamentId = generateId();
  const now = new Date().toISOString();
  const tournament: Tournament = {
    schemaVersion: 1,
    tournamentId,
    slug: body.slug,
    title: body.title.slice(0, TITLE_MAX),
    description: (body.description ?? "").slice(0, DESC_MAX),
    organizerSteamId,
    organizerPersona: organizerPersona.slice(0, NAME_MAX),
    size: body.size,
    status: "open",
    prize: (body.prize ?? "Bragging rights and a SpireVault leaderboard pin.").slice(0, PRIZE_MAX),
    ascensionMin: typeof body.ascensionMin === "number" ? body.ascensionMin : undefined,
    ascensionMax: typeof body.ascensionMax === "number" ? body.ascensionMax : undefined,
    registrationOpensAt: now,
    registrationClosesAt: body.registrationClosesAt,
    startsAt: body.startsAt,
    teams: [],
    matches: [],
    createdAt: now,
    updatedAt: now,
  };

  await Promise.all([
    putJson(env, TOURNAMENT_PREFIX + tournamentId, tournament, TOURNAMENT_TTL_S),
    env.LOBBIES.put(TOURNAMENT_SLUG_PREFIX + body.slug, tournamentId, { expirationTtl: TOURNAMENT_TTL_S }),
    appendIndex(env, tournamentId),
  ]);
  return { ok: true, tournament };
}

export interface RegisterTeamInput {
  name: string;
  memberSteamIds: string[];
  contact?: string;
}

export async function registerTeam(
  env: Env,
  tournamentId: string,
  registrarSteamId: string,
  body: RegisterTeamInput,
): Promise<{ ok: true; tournament: Tournament } | { ok: false; status: number; error: string; message: string }> {
  const tournament = await readJson<Tournament>(env, TOURNAMENT_PREFIX + tournamentId);
  if (!tournament) return { ok: false, status: 404, error: "not_found", message: "Tournament not found." };
  if (tournament.status !== "open") {
    return { ok: false, status: 409, error: "registration_closed", message: "Registration is closed for this tournament." };
  }
  if (tournament.teams.length >= tournament.size) {
    return { ok: false, status: 409, error: "tournament_full", message: "Tournament is at capacity." };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_body", message: "Missing JSON body." };
  }
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return { ok: false, status: 400, error: "invalid_name", message: "Team name is required." };
  }
  if (!Array.isArray(body.memberSteamIds) || body.memberSteamIds.length === 0 || body.memberSteamIds.length > 4) {
    return { ok: false, status: 400, error: "invalid_members", message: "memberSteamIds must contain 1-4 Steam IDs." };
  }
  for (const sid of body.memberSteamIds) {
    if (typeof sid !== "string" || !STEAM_ID_RE.test(sid)) {
      return { ok: false, status: 400, error: "invalid_steam_id", message: `Bad Steam ID: ${sid}` };
    }
  }
  if (!body.memberSteamIds.includes(registrarSteamId)) {
    return { ok: false, status: 403, error: "not_a_member", message: "You can only register teams you're on." };
  }
  // No duplicate members across teams.
  for (const t of tournament.teams) {
    for (const sid of t.memberSteamIds) {
      if (body.memberSteamIds.includes(sid)) {
        return { ok: false, status: 409, error: "member_dupe", message: `${sid} is already on team ${t.name}.` };
      }
    }
  }

  const team: TournamentTeam = {
    teamId: generateId(),
    name: body.name.slice(0, NAME_MAX),
    memberSteamIds: body.memberSteamIds,
    contact: typeof body.contact === "string" ? body.contact.slice(0, 120) : undefined,
    registeredAt: new Date().toISOString(),
  };
  tournament.teams.push(team);
  tournament.updatedAt = new Date().toISOString();
  await putJson(env, TOURNAMENT_PREFIX + tournamentId, tournament, TOURNAMENT_TTL_S);
  return { ok: true, tournament };
}

/** Seed brackets randomly when registration closes. Organizer-only. */
export async function seedBracket(
  env: Env,
  tournamentId: string,
  organizerSteamId: string,
): Promise<{ ok: true; tournament: Tournament } | { ok: false; status: number; error: string; message: string }> {
  const tournament = await readJson<Tournament>(env, TOURNAMENT_PREFIX + tournamentId);
  if (!tournament) return { ok: false, status: 404, error: "not_found", message: "Tournament not found." };
  if (tournament.organizerSteamId !== organizerSteamId) {
    return { ok: false, status: 403, error: "not_organizer", message: "Only the organizer can seed the bracket." };
  }
  if (tournament.status !== "open") {
    return { ok: false, status: 409, error: "wrong_status", message: "Bracket can only be seeded from 'open' status." };
  }
  if (tournament.teams.length < 2) {
    return { ok: false, status: 409, error: "not_enough_teams", message: "Need at least 2 teams to seed." };
  }

  // Pad to size with byes so the bracket is a clean power of 2.
  const padded: (TournamentTeam | null)[] = [...tournament.teams];
  while (padded.length < tournament.size) padded.push(null);

  // Shuffle (Fisher-Yates with crypto.getRandomValues).
  for (let i = padded.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [padded[i], padded[j]] = [padded[j]!, padded[i]!];
  }

  // Build round-0 matches.
  const matches: TournamentMatch[] = [];
  const round0Count = padded.length / 2;
  for (let slot = 0; slot < round0Count; slot++) {
    const a = padded[slot * 2];
    const b = padded[slot * 2 + 1];
    matches.push({
      round: 0,
      slot,
      teamA: a?.teamId,
      teamB: b?.teamId,
      // Auto-advance byes (one team is null) by recording the present team as winner.
      winner: a && !b ? a.teamId : !a && b ? b.teamId : undefined,
    });
  }
  tournament.matches = matches;
  tournament.status = "running";
  tournament.updatedAt = new Date().toISOString();
  // Auto-advance any byes.
  await advanceByesInPlace(tournament);
  await putJson(env, TOURNAMENT_PREFIX + tournamentId, tournament, TOURNAMENT_TTL_S);
  return { ok: true, tournament };
}

/** Report a match result — organizer-only for the cosmetic-only ship. */
export async function reportMatch(
  env: Env,
  tournamentId: string,
  organizerSteamId: string,
  body: { round: number; slot: number; winnerTeamId: string; score?: string },
): Promise<{ ok: true; tournament: Tournament } | { ok: false; status: number; error: string; message: string }> {
  const tournament = await readJson<Tournament>(env, TOURNAMENT_PREFIX + tournamentId);
  if (!tournament) return { ok: false, status: 404, error: "not_found", message: "Tournament not found." };
  if (tournament.organizerSteamId !== organizerSteamId) {
    return { ok: false, status: 403, error: "not_organizer", message: "Only the organizer can report matches." };
  }
  if (tournament.status !== "running") {
    return { ok: false, status: 409, error: "wrong_status", message: "Tournament is not running." };
  }
  const match = tournament.matches.find((m) => m.round === body.round && m.slot === body.slot);
  if (!match) return { ok: false, status: 404, error: "match_not_found", message: "Match not found." };
  if (match.winner) {
    return { ok: false, status: 409, error: "match_reported", message: "Match already reported." };
  }
  if (body.winnerTeamId !== match.teamA && body.winnerTeamId !== match.teamB) {
    return { ok: false, status: 400, error: "invalid_winner", message: "winner must be one of the match teams." };
  }
  match.winner = body.winnerTeamId;
  match.score = typeof body.score === "string" ? body.score.slice(0, 80) : undefined;
  match.reportedAt = new Date().toISOString();

  // Advance the winner into the next round.
  await advanceWinner(tournament, match);

  // If the final match has a winner, mark the tournament complete.
  const lastRound = Math.log2(tournament.size);
  const finalMatch = tournament.matches.find((m) => m.round === lastRound - 0); // last round is log2(size)-1
  // (We compute lastRound as a count, so the last-round index is lastRound - 1.)
  const finalIdx = lastRound - 1;
  const finals = tournament.matches.find((m) => m.round === finalIdx);
  if (finals?.winner) {
    tournament.status = "complete";
  }
  void finalMatch; // appease TS; finals is the one we actually use

  tournament.updatedAt = new Date().toISOString();
  await putJson(env, TOURNAMENT_PREFIX + tournamentId, tournament, TOURNAMENT_TTL_S);
  return { ok: true, tournament };
}

export async function readTournament(env: Env, idOrSlug: string): Promise<Tournament | null> {
  // Treat anything with hex chars only as an id; anything else look up by slug.
  let id = idOrSlug;
  if (SLUG_RE.test(idOrSlug)) {
    const lookedUp = await env.LOBBIES.get(TOURNAMENT_SLUG_PREFIX + idOrSlug);
    if (lookedUp) id = lookedUp;
  }
  return readJson<Tournament>(env, TOURNAMENT_PREFIX + id);
}

export async function listTournaments(env: Env): Promise<Tournament[]> {
  const idx = await readJson<{ ids: string[] }>(env, TOURNAMENT_INDEX_KEY);
  const ids = idx?.ids ?? [];
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readJson<Tournament>(env, TOURNAMENT_PREFIX + id)));
  const live = rows.filter((r): r is Tournament => !!r);
  live.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return live.slice(0, 50);
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

async function advanceByesInPlace(t: Tournament): Promise<void> {
  // Walk rounds; for any match with one slot null, treat the present team as winner.
  let progress = true;
  while (progress) {
    progress = false;
    for (const m of t.matches) {
      if (m.winner) continue;
      if (m.teamA && !m.teamB) {
        m.winner = m.teamA;
        progress = true;
      } else if (!m.teamA && m.teamB) {
        m.winner = m.teamB;
        progress = true;
      }
    }
    // Push the auto-advanced winners into the next round so subsequent
    // rounds can also collapse.
    for (const m of t.matches) {
      if (m.winner) await advanceWinner(t, m);
    }
  }
}

async function advanceWinner(t: Tournament, match: TournamentMatch): Promise<void> {
  if (!match.winner) return;
  const nextRound = match.round + 1;
  const nextSlot = Math.floor(match.slot / 2);
  const isBSide = match.slot % 2 === 1;
  let next = t.matches.find((m) => m.round === nextRound && m.slot === nextSlot);
  if (!next) {
    next = { round: nextRound, slot: nextSlot };
    t.matches.push(next);
  }
  if (isBSide) next.teamB = match.winner;
  else next.teamA = match.winner;
}

function generateId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function randInt(maxExclusive: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % maxExclusive;
}

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.LOBBIES.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

async function putJson(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  await env.LOBBIES.put(key, JSON.stringify(value), { expirationTtl: ttl });
}

async function appendIndex(env: Env, id: string): Promise<void> {
  const blob = await readJson<{ ids: string[] }>(env, TOURNAMENT_INDEX_KEY);
  const ids = blob?.ids ?? [];
  if (ids.includes(id)) return;
  ids.unshift(id);
  if (ids.length > INDEX_MAX) ids.length = INDEX_MAX;
  await putJson(env, TOURNAMENT_INDEX_KEY, { ids }, INDEX_TTL_S);
}
