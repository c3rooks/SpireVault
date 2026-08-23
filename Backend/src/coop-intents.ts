import type { Env } from "./types";
import type { CoopGoal, VoicePreference } from "./coop-types";
import { COOP_GOALS, VOICE_PREFERENCES } from "./coop-types";
import { getSessionProfile } from "./presence";

/**
 * Scheduled play intent — "I'm free tonight 8-11pm for A10 Heart".
 *
 * WHY THIS EXISTS
 *
 * Every other co-op surface in this product requires two people to be looking
 * at it during the same five minutes. Presence rows expire 5 minutes after a
 * tab closes; lobbies last 35; invites, 3. At the concurrency this product
 * actually has, two players who both want the same run but show up 20 minutes
 * apart will never see each other, and both will conclude nobody uses it. The
 * empty board is not a UI problem to be dressed up — it is a scheduling
 * problem, and the fix is to let people commit to a *future* time and have the
 * server remember it for them.
 *
 * This is deliberately NOT a lobby. A lobby is "I am here now, join me". An
 * intent is "I plan to be here later, tell me who else plans to be here then".
 * Intents outlive sessions, tabs, and reboots; they are matched by overlap
 * rather than by presence.
 *
 * STORAGE
 *
 *   coop:intent:<steamId>   one row per user, holding up to MAX_WINDOWS
 *                           windows plus a profile snapshot. TTL tracks the
 *                           latest window end, so rows self-clean.
 *   coop:intent:index       list of steamIds that have a row, so we never
 *                           pay for a KV list() on the read path.
 *
 * One key per user rather than one per window is a deliberate write-budget
 * choice: KV writes are the scarce resource here (see the write budget panel
 * in admin.ts), and editing a schedule should cost one write regardless of how
 * many windows it contains.
 */

// ---------- Tunables ----------

/** Most windows a single user may have queued at once. */
const MAX_WINDOWS = 5;

/** Shortest window we accept. Below this there's no room to actually play. */
const MIN_WINDOW_MINUTES = 30;

/** Longest single window. "I'm free all week" is not a plan. */
const MAX_WINDOW_MINUTES = 12 * 60;

/** How far ahead someone may schedule. */
const MAX_LEAD_DAYS = 14;

/**
 * Minimum overlap before we call two intents a match.
 *
 * A Slay the Spire run is not a five-minute commitment; surfacing a 10-minute
 * sliver as a match would generate notifications nobody can act on, which is
 * worse than silence because it teaches people to ignore the feature.
 */
const MIN_OVERLAP_MINUTES = 30;

/** Grace period after a window ends before the row may be dropped. */
const INTENT_GRACE_S = 30 * 60;

/** Hard cap on the TTL we hand KV. */
const INTENT_MAX_TTL_S = (MAX_LEAD_DAYS + 1) * 24 * 60 * 60;

const INTENT_PREFIX = "coop:intent:";
const INTENT_INDEX_KEY = "coop:intent:index";
const INDEX_TTL_S = INTENT_MAX_TTL_S;

// ---------- Types ----------

export interface IntentWindow {
  id: string;
  /** ISO-8601. Inclusive start. */
  startsAt: string;
  /** ISO-8601. Exclusive end. */
  endsAt: string;
  goal?: CoopGoal;
  ascensionMin?: number;
  ascensionMax?: number;
  voicePreference?: VoicePreference;
  note?: string;
  createdAt: string;
}

export interface PlayIntent {
  steamId: string;
  personaName: string;
  avatarUrl?: string;
  windows: IntentWindow[];
  updatedAt: string;
}

/** One overlapping pair, from the point of view of the requesting user. */
export interface IntentMatch {
  /** The requesting user's window. */
  windowId: string;
  withSteamId: string;
  withPersonaName: string;
  withAvatarUrl?: string;
  withNote?: string;
  goal?: CoopGoal;
  /** Intersection of the two windows. */
  overlapStartsAt: string;
  overlapEndsAt: string;
  overlapMinutes: number;
  /** Minutes until the overlap begins. Negative once it is under way. */
  startsInMinutes: number;
}

/**
 * A row on the public "who's planning to play" board. Deliberately carries no
 * Steam ID: this is rendered to signed-out visitors, and the whole point is to
 * show that the schedule is not empty, not to enable cold DMs.
 */
export interface PublicIntentSlot {
  startsAt: string;
  endsAt: string;
  goal?: CoopGoal;
  ascensionMin?: number;
  ascensionMax?: number;
  personaName: string;
  avatarUrl?: string;
}

export type IntentError =
  | "invalid_window"
  | "window_too_short"
  | "window_too_long"
  | "window_in_past"
  | "window_too_far_out"
  | "too_many_windows"
  | "not_found";

export type IntentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IntentError; message: string };

function fail<T>(error: IntentError, message: string): IntentResult<T> {
  return { ok: false, error, message };
}

// ---------- KV plumbing ----------

async function getJSON<T>(env: Env, key: string): Promise<T | null> {
  const raw = await env.LOBBIES.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readIndex(env: Env): Promise<string[]> {
  const blob = await getJSON<{ ids: string[] }>(env, INTENT_INDEX_KEY);
  if (!blob || !Array.isArray(blob.ids)) return [];
  return Array.from(new Set(blob.ids.filter((s) => /^\d{17}$/.test(s))));
}

async function writeIndex(env: Env, ids: string[]): Promise<void> {
  const uniq = Array.from(new Set(ids.filter((s) => /^\d{17}$/.test(s))));
  await env.LOBBIES.put(
    INTENT_INDEX_KEY,
    JSON.stringify({ ids: uniq.slice(-1000), updatedAt: new Date().toISOString() }),
    { expirationTtl: INDEX_TTL_S }
  );
}

function newId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Window helpers ----------

const MS_PER_MIN = 60_000;

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/** Drops windows that have already ended. Pure; does not write. */
function pruneWindows(windows: IntentWindow[], now: number): IntentWindow[] {
  return windows
    .filter((w) => {
      const end = ms(w.endsAt);
      return Number.isFinite(end) && end > now;
    })
    .sort((a, b) => ms(a.startsAt) - ms(b.startsAt));
}

function latestEnd(windows: IntentWindow[]): number {
  return windows.reduce((max, w) => Math.max(max, ms(w.endsAt) || 0), 0);
}

/**
 * Two windows are compatible if their goals can coexist and their ascension
 * ranges intersect. An unset goal, or "any", matches anything — an unset
 * preference is an absence of a constraint, not a constraint of its own.
 */
function goalsCompatible(a?: CoopGoal, b?: CoopGoal): boolean {
  if (!a || !b || a === "any" || b === "any") return true;
  return a === b;
}

function ascensionsOverlap(a: IntentWindow, b: IntentWindow): boolean {
  const aMin = a.ascensionMin ?? 0;
  const aMax = a.ascensionMax ?? 20;
  const bMin = b.ascensionMin ?? 0;
  const bMax = b.ascensionMax ?? 20;
  return aMin <= bMax && bMin <= aMax;
}

// ---------- Validation ----------

function sanitizeNote(note: unknown): string | undefined {
  if (typeof note !== "string") return undefined;
  const clean = note.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 140);
  return clean.length > 0 ? clean : undefined;
}

function sanitizeAscension(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(20, Math.max(0, Math.round(n)));
}

export interface IntentWindowInput {
  startsAt?: string;
  endsAt?: string;
  goal?: string;
  ascensionMin?: number;
  ascensionMax?: number;
  voicePreference?: string;
  note?: string;
}

function buildWindow(
  input: IntentWindowInput,
  now: number
): IntentResult<IntentWindow> {
  const start = ms(String(input.startsAt ?? ""));
  const end = ms(String(input.endsAt ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return fail("invalid_window", "startsAt and endsAt must be ISO-8601 timestamps.");
  }
  if (end <= start) {
    return fail("invalid_window", "The window has to end after it starts.");
  }

  const minutes = (end - start) / MS_PER_MIN;
  if (minutes < MIN_WINDOW_MINUTES) {
    return fail(
      "window_too_short",
      `Give it at least ${MIN_WINDOW_MINUTES} minutes — that's about one run.`
    );
  }
  if (minutes > MAX_WINDOW_MINUTES) {
    return fail(
      "window_too_long",
      `Windows top out at ${MAX_WINDOW_MINUTES / 60} hours. Split it if you're around all day.`
    );
  }

  // A window that has fully elapsed is useless; one already under way is fine
  // and genuinely common ("I'm free right now for the next two hours").
  if (end <= now) {
    return fail("window_in_past", "That window has already ended.");
  }
  if (start - now > MAX_LEAD_DAYS * 24 * 60 * MS_PER_MIN) {
    return fail(
      "window_too_far_out",
      `You can schedule up to ${MAX_LEAD_DAYS} days ahead.`
    );
  }

  const goal = COOP_GOALS.includes(input.goal as CoopGoal)
    ? (input.goal as CoopGoal)
    : undefined;
  const voicePreference = VOICE_PREFERENCES.includes(
    input.voicePreference as VoicePreference
  )
    ? (input.voicePreference as VoicePreference)
    : undefined;

  let ascensionMin = sanitizeAscension(input.ascensionMin);
  let ascensionMax = sanitizeAscension(input.ascensionMax);
  if (ascensionMin !== undefined && ascensionMax !== undefined && ascensionMin > ascensionMax) {
    [ascensionMin, ascensionMax] = [ascensionMax, ascensionMin];
  }

  return {
    ok: true,
    value: {
      id: newId(),
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
      goal,
      ascensionMin,
      ascensionMax,
      voicePreference,
      note: sanitizeNote(input.note),
      createdAt: new Date(now).toISOString(),
    },
  };
}

// ---------- Store ----------

export async function readIntent(
  env: Env,
  steamId: string
): Promise<PlayIntent | null> {
  const row = await getJSON<PlayIntent>(env, INTENT_PREFIX + steamId);
  if (!row) return null;
  const windows = pruneWindows(
    Array.isArray(row.windows) ? row.windows : [],
    Date.now()
  );
  return { ...row, windows };
}

async function persist(env: Env, intent: PlayIntent): Promise<void> {
  const now = Date.now();

  // No windows left means nothing to remember. Drop the row and the index
  // entry rather than leaving an empty husk for every user who ever tried the
  // feature once — the matcher reads every indexed row on every poll.
  if (intent.windows.length === 0) {
    await env.LOBBIES.delete(INTENT_PREFIX + intent.steamId).catch(() => {});
    const ids = await readIndex(env);
    if (ids.includes(intent.steamId)) {
      await writeIndex(env, ids.filter((id) => id !== intent.steamId));
    }
    return;
  }

  const ttl = Math.min(
    INTENT_MAX_TTL_S,
    Math.max(600, Math.ceil((latestEnd(intent.windows) - now) / 1000) + INTENT_GRACE_S)
  );
  await env.LOBBIES.put(
    INTENT_PREFIX + intent.steamId,
    JSON.stringify({ ...intent, updatedAt: new Date(now).toISOString() }),
    { expirationTtl: ttl }
  );

  const ids = await readIndex(env);
  if (!ids.includes(intent.steamId)) {
    await writeIndex(env, [...ids, intent.steamId]);
  }
}

/** Every live intent row. Prunes dead ids out of the index as it goes. */
export async function listIntents(env: Env): Promise<PlayIntent[]> {
  const ids = await readIndex(env);
  if (ids.length === 0) return [];
  const rows = await Promise.all(ids.map((id) => readIntent(env, id)));

  const live: PlayIntent[] = [];
  const liveIds: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const row = rows[i];
    if (row && row.windows.length > 0) {
      live.push(row);
      liveIds.push(ids[i]!);
    }
  }
  // Only pay a write when the index is actually stale.
  if (liveIds.length !== ids.length) await writeIndex(env, liveIds);
  return live;
}

// ---------- Mutations ----------

export async function addIntentWindow(
  env: Env,
  steamId: string,
  input: IntentWindowInput
): Promise<IntentResult<PlayIntent>> {
  const now = Date.now();
  const built = buildWindow(input, now);
  if (!built.ok) return built;

  const profile = await getSessionProfile(env, steamId);
  const existing = await readIntent(env, steamId);
  const windows = existing ? existing.windows : [];

  if (windows.length >= MAX_WINDOWS) {
    return fail(
      "too_many_windows",
      `You already have ${MAX_WINDOWS} windows scheduled. Remove one first.`
    );
  }

  const intent: PlayIntent = {
    steamId,
    personaName: profile?.personaName ?? existing?.personaName ?? "Steam User",
    avatarUrl: profile?.avatarURL || existing?.avatarUrl,
    windows: pruneWindows([...windows, built.value], now),
    updatedAt: new Date(now).toISOString(),
  };
  await persist(env, intent);
  return { ok: true, value: intent };
}

export async function removeIntentWindow(
  env: Env,
  steamId: string,
  windowId: string
): Promise<IntentResult<PlayIntent>> {
  const existing = await readIntent(env, steamId);
  if (!existing) return fail("not_found", "You have no scheduled windows.");
  const remaining = existing.windows.filter((w) => w.id !== windowId);
  if (remaining.length === existing.windows.length) {
    return fail("not_found", "That window is already gone.");
  }
  const intent: PlayIntent = { ...existing, windows: remaining };
  await persist(env, intent);
  return { ok: true, value: intent };
}

// ---------- Matching ----------

/**
 * Every other user whose schedule overlaps this user's by at least
 * MIN_OVERLAP_MINUTES, with compatible goal and ascension range.
 *
 * O(users × windows²), which at this scale is a few hundred comparisons over
 * data already in memory. If the index ever gets large enough for this to
 * matter, bucket windows by hour before comparing — but that day is a long way
 * off and the simple version is the one that stays correct.
 */
export async function findIntentMatches(
  env: Env,
  steamId: string
): Promise<IntentMatch[]> {
  const mine = await readIntent(env, steamId);
  if (!mine || mine.windows.length === 0) return [];

  const now = Date.now();
  const everyone = await listIntents(env);
  const matches: IntentMatch[] = [];

  for (const theirs of everyone) {
    if (theirs.steamId === steamId) continue;
    for (const a of mine.windows) {
      for (const b of theirs.windows) {
        if (!goalsCompatible(a.goal, b.goal)) continue;
        if (!ascensionsOverlap(a, b)) continue;

        const start = Math.max(ms(a.startsAt), ms(b.startsAt));
        const end = Math.min(ms(a.endsAt), ms(b.endsAt));
        const overlapMinutes = Math.floor((end - start) / MS_PER_MIN);
        if (overlapMinutes < MIN_OVERLAP_MINUTES) continue;

        matches.push({
          windowId: a.id,
          withSteamId: theirs.steamId,
          withPersonaName: theirs.personaName,
          withAvatarUrl: theirs.avatarUrl,
          withNote: b.note,
          goal: a.goal ?? b.goal,
          overlapStartsAt: new Date(start).toISOString(),
          overlapEndsAt: new Date(end).toISOString(),
          overlapMinutes,
          startsInMinutes: Math.round((start - now) / MS_PER_MIN),
        });
      }
    }
  }

  // Soonest first — the only ordering anyone cares about.
  matches.sort((x, y) => ms(x.overlapStartsAt) - ms(y.overlapStartsAt));
  return matches.slice(0, 50);
}

/**
 * Sanitized upcoming schedule for the public board.
 *
 * This is what a visitor sees instead of "no live parties yet" at 4am: proof
 * that the schedule has people in it, even when nobody is online this second.
 */
export async function upcomingIntents(
  env: Env,
  limit = 20
): Promise<PublicIntentSlot[]> {
  const everyone = await listIntents(env);
  const now = Date.now();
  const slots: PublicIntentSlot[] = [];

  for (const intent of everyone) {
    for (const w of intent.windows) {
      if (ms(w.endsAt) <= now) continue;
      slots.push({
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        goal: w.goal,
        ascensionMin: w.ascensionMin,
        ascensionMax: w.ascensionMax,
        personaName: intent.personaName,
        avatarUrl: intent.avatarUrl,
      });
    }
  }

  slots.sort((a, b) => ms(a.startsAt) - ms(b.startsAt));
  return slots.slice(0, limit);
}

/** Count of distinct users with at least one live window. For empty states. */
export async function countScheduledPlayers(env: Env): Promise<number> {
  const everyone = await listIntents(env);
  return everyone.length;
}
