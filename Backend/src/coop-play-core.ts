/**
 * One-tap co-op matchmaking — pure logic, no I/O.
 *
 * A player taps Play. If a party is gathering on their game branch they join
 * it; otherwise they pair with the oldest other player waiting; otherwise
 * they wait in the queue. Everything here is a function of (state, now) so it
 * can be tested with a fake clock. `CoopPlayDO` (coop-play-do.ts) owns the one
 * live copy of the state and runs these functions one request at a time,
 * which is what makes the matching race-free.
 *
 * State is never mutated in place: every operation returns a new state.
 */

import { COOP_CHARACTERS, type CoopCharacter } from "./coop-types";

// MARK: - Tunables

export const MAX_PARTY = 4;
/** A waiting player who stops polling is dropped after this long. */
export const TICKET_TTL_MS = 90_000;
/**
 * …unless they turned on pings. Then they choose how long to keep looking
 * after they last had the page in front of them (STAY_CHOICES_MIN), and a
 * hidden tab that keeps polling does not stretch it.
 */
export const STAY_CHOICES_MIN: readonly number[] = [30, 60, 120];
export const DEFAULT_STAY_MIN = 60;
export const TICKET_TTL_PUSH_MS = DEFAULT_STAY_MIN * 60_000;
/** A matched member who stops polling before the run starts is dropped. */
export const MEMBER_TIMEOUT_MS = 3 * 60_000;
/**
 * Someone matched while away (they were pinged) has this long from the match,
 * or from tapping "On my way", to come back to the page.
 */
export const MEMBER_AWAY_GRACE_MS = 5 * 60_000;
/** A member is "away" at match time if they have not had the page in view for this long. */
export const AWAY_AFTER_MS = 20_000;
/** "Your search ended" stays readable (for the service worker's peek) this long. */
export const ENDED_NOTICE_MS = 15 * 60_000;
/** New players can join a gathering party for this long after it formed. */
export const MATCH_JOIN_WINDOW_MS = 15 * 60_000;
/** Matches are forgotten after this long, whatever their state. */
export const MATCH_MAX_AGE_MS = 4 * 60 * 60_000;
/** "Someone's looking" pings: at most one per recipient per window… */
export const PING_RECIPIENT_COOLDOWN_MS = 30 * 60_000;
/** …and one fan-out per sender per window. */
export const PING_SENDER_COOLDOWN_MS = 10 * 60_000;

// MARK: - Types

export type Branch = "stable" | "beta";
export const BRANCHES: readonly Branch[] = ["stable", "beta"];

export interface PlayerProfile {
  sid: string;
  name: string;
  avatar?: string;
}

export interface Ticket extends PlayerProfile {
  character?: CoopCharacter;
  branch: Branch;
  push: boolean;
  /** With pings on: how long to keep looking after the page was last in view. */
  stayMs?: number;
  createdAt: number;
  /** Any poll, visible or not. Keeps a ticket without pings alive. */
  lastSeenAt: number;
  /** A poll from a page in view (missing on state saved before this existed). */
  lastVisibleAt?: number;
  /** Set when a match fell apart and this player was put back in line. */
  notice?: Notice;
}

export type MemberStatus = "joined" | "in_game" | "left";

export interface Member extends PlayerProfile {
  character?: CoopCharacter;
  push: boolean;
  stayMs?: number;
  /** When this player first tapped Play — decides host and queue order. */
  queuedAt: number;
  joinedAt: number;
  lastSeenAt: number;
  lastVisibleAt?: number;
  /**
   * Did not have the page in view when the match formed (got a push instead).
   * Cleared when they look at the page again.
   */
  awayAtMatch: boolean;
  /** Tapped "On my way" on the ping: the party is told, the grace restarts. */
  comingAt?: number;
  steamAdded: boolean;
  status: MemberStatus;
}

export interface Match {
  matchId: string;
  branch: Branch;
  createdAt: number;
  hostSid: string;
  hostHosting: boolean;
  /** Set when the host says the run has started; nobody else can join. */
  locked: boolean;
  members: Member[];
  notice?: Notice;
}

export interface PingPref {
  looking: boolean;
  branch: Branch;
  lastPingedAt?: number;
}

export interface PlayState {
  tickets: Record<string, Ticket>;
  matches: Record<string, Match>;
  pings: Record<string, PingPref>;
  /** Last "someone's looking" fan-out per sender. */
  fanouts: Record<string, number>;
  /** When a pinged player's search ran out (missing on state saved before this existed). */
  ended?: Record<string, number>;
}

export type Notice = "partner_left" | "host_changed" | "expired";

export type CounterKey =
  | "play_tap"
  | "matched"
  | "joined_party"
  | "cancel"
  | "steam_add"
  | "hosting"
  | "in_game"
  | "partner_left"
  | "expired"
  | "wait_lt10s"
  | "wait_lt30s"
  | "wait_lt2m"
  | "wait_lt10m"
  | "wait_gt10m";

export type PlayEvent =
  | { type: "count"; key: CounterKey }
  | { type: "player"; sid: string }
  | { type: "push_matched"; sid: string; matchId: string }
  | { type: "push_looking"; sids: string[] }
  | { type: "push_ended"; sid: string }
  | { type: "history"; sid: string; role: "host" | "member"; matchId: string };

export type ViewState = "idle" | "searching" | "matched" | "in_game";

export interface MemberView {
  sid: string;
  name: string;
  avatar?: string;
  character?: CoopCharacter;
  isHost: boolean;
  isYou: boolean;
  steamAdded: boolean;
  status: MemberStatus;
  /** Pinged while away and tapped "On my way": the others see them coming. */
  coming: boolean;
}

export interface PlayView {
  state: ViewState;
  lookingCount: number;
  playingCount: number;
  lookingByBranch: Record<Branch, number>;
  pings: { looking: boolean };
  ticket?: {
    createdAt: number;
    character?: CoopCharacter;
    branch: Branch;
    push: boolean;
    /** With pings on: how long the search lasts after you last had the page in view. */
    stayMs?: number;
  };
  /** Your pinged search ran out this long ago (shown on the "search ended" ping). */
  endedAt?: number;
  match?: {
    matchId: string;
    branch: Branch;
    createdAt: number;
    youAreHost: boolean;
    hostSid: string;
    hostHosting: boolean;
    locked: boolean;
    seatsLeft: number;
    members: MemberView[];
  };
  notice?: Notice;
}

export interface Result {
  state: PlayState;
  view: PlayView;
  events: PlayEvent[];
}

export interface PlayRequest {
  character?: unknown;
  branch?: unknown;
  push?: unknown;
  /** Minutes to keep looking with pings on: one of STAY_CHOICES_MIN. */
  stay?: unknown;
}

/** "omw" = "On my way", tapped on a ping. "Pass" on a ping is "leave". */
export type PlayAction = "steam_add" | "hosting" | "in_game" | "leave" | "omw";
export const PLAY_ACTIONS: readonly PlayAction[] = ["steam_add", "hosting", "in_game", "leave", "omw"];

// MARK: - Small helpers

export function emptyState(): PlayState {
  return { tickets: {}, matches: {}, pings: {}, fanouts: {}, ended: {} };
}

/** Minutes from the client → milliseconds; anything not offered falls back to the default. */
export function sanitizeStay(raw: unknown): number {
  const min = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return (STAY_CHOICES_MIN.includes(min) ? min : DEFAULT_STAY_MIN) * 60_000;
}

/** When the page was last in view. State saved before visibility existed only has lastSeenAt. */
function seenVisible(x: { lastSeenAt: number; lastVisibleAt?: number }): number {
  return x.lastVisibleAt ?? x.lastSeenAt;
}

export function sanitizeCharacter(raw: unknown): CoopCharacter | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  return (COOP_CHARACTERS as readonly string[]).includes(s) ? (s as CoopCharacter) : undefined;
}

export function sanitizeBranch(raw: unknown): Branch {
  return raw === "beta" ? "beta" : "stable";
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = rec;
  return rest;
}

function activeMembers(match: Match): Member[] {
  return match.members.filter((m) => m.status !== "left");
}

function findMatchFor(state: PlayState, sid: string): Match | undefined {
  return Object.values(state.matches).find((m) =>
    m.members.some((mem) => mem.sid === sid && mem.status !== "left"),
  );
}

function waitBucket(ms: number): CounterKey {
  if (ms < 10_000) return "wait_lt10s";
  if (ms < 30_000) return "wait_lt30s";
  if (ms < 120_000) return "wait_lt2m";
  if (ms < 600_000) return "wait_lt10m";
  return "wait_gt10m";
}

/**
 * Without pings a ticket lives while something polls. With pings it lives for
 * the chosen stay after the page was last in view: a hidden tab polling in the
 * background does not keep someone in line all night.
 */
function ticketExpired(t: Ticket, now: number): boolean {
  if (!t.push) return now - t.lastSeenAt > TICKET_TTL_MS;
  return now - seenVisible(t) > (t.stayMs ?? TICKET_TTL_PUSH_MS);
}

/**
 * A member pinged while away must come back (or tap "On my way") within the
 * grace, counted from the match: a hidden tab that keeps polling does not hold
 * the seat. Once they have looked, any poll keeps the seat, because a player
 * who tabs out to Steam or the game must not lose it.
 *
 * Someone without pings was never told, so the old rule holds for them: any
 * poll, hidden or not, keeps the seat, with the longer grace if they were
 * away. That also covers pings turned off after the match.
 */
function memberSilent(m: Member, now: number): boolean {
  if (m.awayAtMatch && m.push) return now - Math.max(m.joinedAt, m.comingAt ?? 0) > MEMBER_AWAY_GRACE_MS;
  if (m.awayAtMatch) return now - m.lastSeenAt > MEMBER_AWAY_GRACE_MS;
  return now - m.lastSeenAt > MEMBER_TIMEOUT_MS;
}

function memberFromTicket(t: Ticket, now: number): Member {
  // With pings, "away" means the page was not in view (they get a ping).
  // Without, it keeps its old meaning, no poll at all lately, so a player
  // tabbed out to the game with the page still polling is not "away".
  const away = now - (t.push ? seenVisible(t) : t.lastSeenAt) > AWAY_AFTER_MS;
  return {
    sid: t.sid,
    name: t.name,
    avatar: t.avatar,
    character: t.character,
    push: t.push,
    stayMs: t.stayMs,
    queuedAt: t.createdAt,
    joinedAt: now,
    lastSeenAt: now,
    lastVisibleAt: away ? seenVisible(t) : now,
    awayAtMatch: away,
    steamAdded: false,
    status: "joined",
  };
}

function ticketFromMember(m: Member, branch: Branch, now: number, notice: Notice): Ticket {
  const lastSeenAt = Math.max(m.lastSeenAt, now - AWAY_AFTER_MS);
  return {
    sid: m.sid,
    name: m.name,
    avatar: m.avatar,
    character: m.character,
    branch,
    push: m.push,
    stayMs: m.stayMs,
    createdAt: m.queuedAt,
    lastSeenAt,
    // Someone who never came back to the page keeps the clock they had; the
    // rest start a fresh stay from now.
    lastVisibleAt: m.awayAtMatch ? seenVisible(m) : lastSeenAt,
    notice,
  };
}

/** Earliest-queued active member. Ties go to whoever joined the match first. */
function pickHost(members: Member[]): Member | undefined {
  return [...members].sort((a, b) => a.queuedAt - b.queuedAt || a.joinedAt - b.joinedAt)[0];
}

function isJoinable(match: Match, branch: Branch, now: number): boolean {
  return (
    !match.locked &&
    match.branch === branch &&
    now - match.createdAt < MATCH_JOIN_WINDOW_MS &&
    activeMembers(match).length < MAX_PARTY
  );
}

// MARK: - View

export function viewFor(state: PlayState, sid: string): PlayView {
  const tickets = Object.values(state.tickets);
  const lookingByBranch: Record<Branch, number> = { stable: 0, beta: 0 };
  for (const t of tickets) lookingByBranch[t.branch] += 1;
  const playingCount = Object.values(state.matches).reduce(
    (n, m) => n + activeMembers(m).length,
    0,
  );
  const base: PlayView = {
    state: "idle",
    lookingCount: tickets.length,
    playingCount,
    lookingByBranch,
    pings: { looking: Boolean(state.pings[sid]?.looking) },
  };

  const match = findMatchFor(state, sid);
  if (match) {
    const active = activeMembers(match);
    return {
      ...base,
      state: match.locked ? "in_game" : "matched",
      notice: match.notice,
      match: {
        matchId: match.matchId,
        branch: match.branch,
        createdAt: match.createdAt,
        youAreHost: match.hostSid === sid,
        hostSid: match.hostSid,
        hostHosting: match.hostHosting,
        locked: match.locked,
        seatsLeft: Math.max(0, MAX_PARTY - active.length),
        members: active.map((m) => ({
          sid: m.sid,
          name: m.name,
          avatar: m.avatar,
          character: m.character,
          isHost: m.sid === match.hostSid,
          isYou: m.sid === sid,
          steamAdded: m.steamAdded,
          status: m.status,
          coming: m.awayAtMatch && m.comingAt !== undefined,
        })),
      },
    };
  }

  const ticket = state.tickets[sid];
  if (ticket) {
    return {
      ...base,
      state: "searching",
      notice: ticket.notice,
      ticket: {
        createdAt: ticket.createdAt,
        character: ticket.character,
        branch: ticket.branch,
        push: ticket.push,
        ...(ticket.push ? { stayMs: ticket.stayMs ?? TICKET_TTL_PUSH_MS } : {}),
      },
    };
  }
  const endedAt = state.ended?.[sid];
  return endedAt === undefined ? base : { ...base, endedAt };
}

// MARK: - Housekeeping

/**
 * Drop expired tickets, time out silent members, dissolve broken matches and
 * forget old ones. Every public operation runs this first.
 */
export function tick(
  state: PlayState,
  now: number,
  newId: () => string = randomHex,
): { state: PlayState; events: PlayEvent[] } {
  const events: PlayEvent[] = [];
  let tickets = { ...state.tickets };
  let ended = Object.fromEntries(
    Object.entries(state.ended ?? {}).filter(([, at]) => now - at <= ENDED_NOTICE_MS),
  );
  for (const t of Object.values(tickets)) {
    if (ticketExpired(t, now)) {
      tickets = omit(tickets, t.sid);
      events.push({ type: "count", key: "expired" });
      // Someone who left with pings on is told their search is over, so they
      // never think they are still in line.
      if (t.push) {
        ended = { ...ended, [t.sid]: now };
        events.push({ type: "push_ended", sid: t.sid });
      }
    }
  }

  let next: PlayState = { ...state, tickets, ended };
  for (const match of Object.values(state.matches)) {
    if (now - match.createdAt > MATCH_MAX_AGE_MS) {
      next = { ...next, matches: omit(next.matches, match.matchId) };
      continue;
    }
    if (match.locked) continue;
    const active = activeMembers(match);
    const silent = active.filter((m) => memberSilent(m, now));
    if (silent.length === 0) continue;
    if (silent.length === active.length) {
      next = { ...next, matches: omit(next.matches, match.matchId) };
      events.push({ type: "count", key: "expired" });
      continue;
    }
    for (const m of silent) {
      const r = leaveMatch(next, next.matches[match.matchId], m.sid, now);
      next = r.state;
      events.push(...r.events);
    }
  }
  const made = matchmake(next, now, "", newId);
  return { state: made.state, events: [...events, ...made.events] };
}

/**
 * Put waiting players into parties: first into a party still gathering on
 * their branch, otherwise pair the two oldest waiting on the same branch.
 * Runs until nothing changes. The caller (who is polling right now) never
 * gets a push; anyone matched while away does, if they turned pings on.
 */
function matchmake(
  state0: PlayState,
  now: number,
  callerSid: string,
  newId: () => string = randomHex,
): { state: PlayState; events: PlayEvent[] } {
  let state = state0;
  const events: PlayEvent[] = [];
  for (;;) {
    const queue = Object.values(state.tickets).sort((a, b) => a.createdAt - b.createdAt);
    let changed = false;
    for (const t of queue) {
      const gathering = Object.values(state.matches)
        .filter((m) => isJoinable(m, t.branch, now))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (gathering) {
        const member = memberFromTicket(t, now);
        const match: Match = { ...gathering, members: [...gathering.members, member] };
        state = {
          ...state,
          tickets: omit(state.tickets, t.sid),
          matches: { ...state.matches, [match.matchId]: match },
        };
        events.push(
          { type: "count", key: "joined_party" },
          { type: "count", key: waitBucket(now - t.createdAt) },
          ...awayPushes([member], match.matchId, callerSid),
        );
        changed = true;
        break;
      }
      const partner = queue.find((o) => o.sid !== t.sid && o.branch === t.branch);
      if (partner) {
        const members = [memberFromTicket(t, now), memberFromTicket(partner, now)];
        const host = pickHost(members) ?? members[0];
        const match: Match = {
          matchId: newId(),
          branch: t.branch,
          createdAt: now,
          hostSid: host.sid,
          hostHosting: false,
          locked: false,
          members,
        };
        state = {
          ...state,
          tickets: omit(omit(state.tickets, t.sid), partner.sid),
          matches: { ...state.matches, [match.matchId]: match },
        };
        events.push(
          { type: "count", key: "matched" },
          { type: "count", key: waitBucket(now - t.createdAt) },
          { type: "count", key: waitBucket(now - partner.createdAt) },
          ...awayPushes(members, match.matchId, callerSid),
        );
        changed = true;
        break;
      }
    }
    if (!changed) return { state, events };
  }
}

function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Remove `sid` from a match. Before the run starts this can hand the host role
 * on, or dissolve the match and put the survivor back in line at their
 * original queue time. After the run starts it only marks them as left.
 */
function leaveMatch(
  state: PlayState,
  match: Match | undefined,
  sid: string,
  now: number,
): { state: PlayState; events: PlayEvent[] } {
  if (!match) return { state, events: [] };
  const events: PlayEvent[] = [];
  const members = match.members.map((m) =>
    m.sid === sid ? { ...m, status: "left" as const } : m,
  );
  const active = members.filter((m) => m.status !== "left");

  if (active.length === 0) {
    return { state: { ...state, matches: omit(state.matches, match.matchId) }, events };
  }

  if (!match.locked && active.length < 2) {
    events.push({ type: "count", key: "partner_left" });
    let tickets = { ...state.tickets };
    for (const m of active) {
      tickets = { ...tickets, [m.sid]: ticketFromMember(m, match.branch, now, "partner_left") };
    }
    return {
      state: { ...state, tickets, matches: omit(state.matches, match.matchId) },
      events,
    };
  }

  let hostSid = match.hostSid;
  let notice = match.notice;
  let hostHosting = match.hostHosting;
  if (sid === match.hostSid && !match.locked) {
    hostSid = pickHost(active)?.sid ?? hostSid;
    hostHosting = false;
    notice = "host_changed";
  }
  return {
    state: {
      ...state,
      matches: { ...state.matches, [match.matchId]: { ...match, members, hostSid, hostHosting, notice } },
    },
    events,
  };
}

// MARK: - Operations

export interface Ctx {
  now: number;
  /** Returns a fresh 32-hex-char id. Injected so tests are deterministic. */
  newId: () => string;
}

/**
 * Tap Play. Idempotent: tapping again while searching or matched returns the
 * same state (and refreshes your choices while you are still searching).
 */
export function play(state0: PlayState, who: PlayerProfile, req: PlayRequest, ctx: Ctx): Result {
  const { now } = ctx;
  const ticked = tick(touch(state0, who.sid, now), now, ctx.newId);
  let state = ticked.state;
  const events: PlayEvent[] = [...ticked.events];
  const character = sanitizeCharacter(req.character);
  const branch = sanitizeBranch(req.branch);
  const push = req.push === true;

  if (findMatchFor(state, who.sid)) {
    return { state, view: viewFor(state, who.sid), events };
  }

  events.push({ type: "count", key: "play_tap" }, { type: "player", sid: who.sid });

  const prior = state.tickets[who.sid];
  const ticket: Ticket = {
    sid: who.sid,
    name: who.name,
    avatar: who.avatar,
    character,
    branch,
    push,
    ...(push ? { stayMs: sanitizeStay(req.stay) } : {}),
    createdAt: prior && prior.branch === branch ? prior.createdAt : now,
    lastSeenAt: now,
    lastVisibleAt: now,
  };
  const othersWaiting = Object.values(state.tickets).filter(
    (t) => t.branch === branch && t.sid !== who.sid,
  ).length;
  state = {
    ...state,
    tickets: { ...state.tickets, [who.sid]: ticket },
    ended: omit(state.ended ?? {}, who.sid),
  };

  const made = matchmake(state, now, who.sid, ctx.newId);
  state = made.state;
  events.push(...made.events);

  // Nobody around: tell people who asked to know that someone is looking.
  if (state.tickets[who.sid] && othersWaiting === 0 && !prior) {
    const fan = lookingFanout(state, who.sid, branch, now);
    state = fan.state;
    events.push(...fan.events);
  }
  return { state, view: viewFor(state, who.sid), events };
}

/** Members who were matched while away get a push (if they turned pings on). */
function awayPushes(members: Member[], matchId: string, callerSid: string): PlayEvent[] {
  return members
    .filter((m) => m.sid !== callerSid && m.awayAtMatch && m.push)
    .map((m) => ({ type: "push_matched" as const, sid: m.sid, matchId }));
}

/**
 * The first person waiting on a branch tells everyone who opted into
 * "ping me when someone's looking" — throttled per recipient and per sender
 * so the Play button can't be used to spam.
 */
function lookingFanout(
  state: PlayState,
  senderSid: string,
  branch: Branch,
  now: number,
): { state: PlayState; events: PlayEvent[] } {
  const lastFan = state.fanouts[senderSid];
  if (lastFan !== undefined && now - lastFan < PING_SENDER_COOLDOWN_MS) {
    return { state, events: [] };
  }
  const busy = new Set<string>([
    ...Object.keys(state.tickets),
    ...Object.values(state.matches).flatMap((m) => activeMembers(m).map((mem) => mem.sid)),
  ]);
  const recipients = Object.entries(state.pings)
    .filter(([sid, p]) =>
      p.looking &&
      p.branch === branch &&
      sid !== senderSid &&
      !busy.has(sid) &&
      (p.lastPingedAt === undefined || now - p.lastPingedAt >= PING_RECIPIENT_COOLDOWN_MS),
    )
    .map(([sid]) => sid);
  if (recipients.length === 0) return { state, events: [] };
  let pings = { ...state.pings };
  for (const sid of recipients) pings = { ...pings, [sid]: { ...pings[sid], lastPingedAt: now } };
  return {
    state: { ...state, pings, fanouts: { ...state.fanouts, [senderSid]: now } },
    events: [{ type: "push_looking", sids: recipients }],
  };
}

/**
 * Mark a player as seen. `visible` is false for a poll from a tab in the
 * background and for a ping's action button: either keeps a ticket or seat
 * alive, but only a page in view counts as the player being back.
 */
function touch(state: PlayState, sid: string, now: number, visible = true): PlayState {
  const ticket = state.tickets[sid];
  if (ticket) {
    // A hidden poll on a ticket saved before visibility existed pins its
    // "last in view" to the old lastSeenAt first, or the poll would stretch it.
    const seen = visible
      ? { lastSeenAt: now, lastVisibleAt: now }
      : { lastSeenAt: now, lastVisibleAt: seenVisible(ticket) };
    return { ...state, tickets: { ...state.tickets, [sid]: { ...ticket, ...seen } } };
  }
  const match = findMatchFor(state, sid);
  if (!match) return state;
  const members = match.members.map((m) => {
    if (m.sid !== sid) return m;
    return visible
      ? { ...m, lastSeenAt: now, lastVisibleAt: now, awayAtMatch: false }
      : { ...m, lastSeenAt: now, lastVisibleAt: seenVisible(m) };
  });
  return { ...state, matches: { ...state.matches, [match.matchId]: { ...match, members } } };
}

/**
 * Poll: keeps your ticket or seat alive and returns the current view. Clients
 * that predate visibility send nothing, which counts as in view (the old rule).
 */
export function poll(state0: PlayState, sid: string, ctx: Ctx, visible = true): Result {
  const ticked = tick(touch(state0, sid, ctx.now, visible), ctx.now, ctx.newId);
  return { state: ticked.state, view: viewFor(ticked.state, sid), events: ticked.events };
}

/**
 * Your view, read without being seen: no keep-alive and no housekeeping, so
 * the state is left exactly as it was. For the service worker, which asks
 * "what happened?" when a push arrives while the player is away. A poll
 * there would mark them as back and end the longer grace they are owed.
 */
export function peek(state: PlayState, sid: string): PlayView {
  return viewFor(state, sid);
}

/** Leave the queue. Leaving a match goes through `act(…, "leave")`. */
export function cancel(state0: PlayState, sid: string, ctx: Ctx): Result {
  const ticked = tick(state0, ctx.now, ctx.newId);
  const events: PlayEvent[] = [...ticked.events];
  let state = ticked.state;
  if (state.tickets[sid]) {
    state = { ...state, tickets: omit(state.tickets, sid) };
    events.push({ type: "count", key: "cancel" });
  }
  return { state, view: viewFor(state, sid), events };
}

/**
 * Party steps: Steam add, "I'm hosting", "We're in", leave, and "On my way".
 * `visible` is false when the step comes from a ping's button (the service
 * worker), which must not count as the player being back at the page.
 */
export function act(state0: PlayState, sid: string, action: PlayAction, ctx: Ctx, visible = true): Result {
  const { now } = ctx;
  const ticked = tick(touch(state0, sid, now, visible), now, ctx.newId);
  const events: PlayEvent[] = [...ticked.events];
  let state = ticked.state;
  const match = findMatchFor(state, sid);
  if (!match) return { state, view: viewFor(state, sid), events };

  if (action === "omw") {
    // The party sees "coming", and the player gets a fresh grace to get there,
    // once: tapping again doesn't hold the seat any longer.
    const members = match.members.map((m) => (m.sid === sid ? { ...m, comingAt: m.comingAt ?? now } : m));
    state = { ...state, matches: { ...state.matches, [match.matchId]: { ...match, members } } };
    return { state, view: viewFor(state, sid), events };
  }

  if (action === "leave") {
    const r = leaveMatch(state, match, sid, now);
    // The leaver does not go back in line; only the people left behind do.
    state = { ...r.state, tickets: omit(r.state.tickets, sid) };
    events.push(...r.events);
    return { state, view: viewFor(state, sid), events };
  }

  if (action === "steam_add") {
    const members = match.members.map((m) => (m.sid === sid ? { ...m, steamAdded: true } : m));
    const first = !match.members.find((m) => m.sid === sid)?.steamAdded;
    state = { ...state, matches: { ...state.matches, [match.matchId]: { ...match, members } } };
    if (first) events.push({ type: "count", key: "steam_add" });
    return { state, view: viewFor(state, sid), events };
  }

  if (action === "hosting") {
    if (match.hostSid !== sid || match.hostHosting) {
      return { state, view: viewFor(state, sid), events };
    }
    state = { ...state, matches: { ...state.matches, [match.matchId]: { ...match, hostHosting: true } } };
    events.push({ type: "count", key: "hosting" });
    return { state, view: viewFor(state, sid), events };
  }

  // in_game: the member says the run started. The host saying so (or every
  // active member saying so) locks the party and counts it once.
  const members = match.members.map((m) =>
    m.sid === sid && m.status !== "left" ? { ...m, status: "in_game" as const } : m,
  );
  const active = members.filter((m) => m.status !== "left");
  const lock = !match.locked && (sid === match.hostSid || active.every((m) => m.status === "in_game"));
  const updated: Match = { ...match, members, locked: match.locked || lock, notice: undefined };
  state = { ...state, matches: { ...state.matches, [match.matchId]: updated } };
  if (lock) {
    events.push({ type: "count", key: "in_game" });
    for (const m of active) {
      events.push({
        type: "history",
        sid: m.sid,
        role: m.sid === match.hostSid ? "host" : "member",
        matchId: match.matchId,
      });
    }
  }
  return { state, view: viewFor(state, sid), events };
}

/** Turn "ping me when someone's looking" on or off. */
export function setLookingPings(
  state0: PlayState,
  sid: string,
  on: boolean,
  branch: Branch,
  ctx: Ctx,
): Result {
  const ticked = tick(state0, ctx.now, ctx.newId);
  const prev = ticked.state.pings[sid];
  const pings = on
    ? { ...ticked.state.pings, [sid]: { looking: true, branch, lastPingedAt: prev?.lastPingedAt } }
    : omit(ticked.state.pings, sid);
  const state = { ...ticked.state, pings };
  return { state, view: viewFor(state, sid), events: ticked.events };
}

/**
 * Pings were switched on or off (a device added or dropped). A player already
 * in line keeps their place: the waiting ticket, or party seat, just takes the
 * new flag, so the ticket lives for the stay (the default hour, since this
 * ticket never chose one) with pings and 90 s without, and a match made while
 * they are away can reach them.
 */
export function setPushFlag(state: PlayState, sid: string, push: boolean): PlayState {
  const ticket = state.tickets[sid];
  if (ticket) {
    return { ...state, tickets: { ...state.tickets, [sid]: { ...ticket, push } } };
  }
  const match = findMatchFor(state, sid);
  if (!match) return state;
  const members = match.members.map((m) => (m.sid === sid ? { ...m, push } : m));
  return { ...state, matches: { ...state.matches, [match.matchId]: { ...match, members } } };
}

/**
 * Signed out on the last device that could ping them: leave the line and any
 * party that has not started, so nobody waits for someone who is gone. A run
 * already under way is left as it is.
 */
export function leaveEverything(state0: PlayState, sid: string, ctx: Ctx): Result {
  const cancelled = cancel(state0, sid, ctx);
  const match = findMatchFor(cancelled.state, sid);
  if (!match || match.locked) return cancelled;
  const left = act(cancelled.state, sid, "leave", ctx, false);
  return { state: left.state, view: left.view, events: [...cancelled.events, ...left.events] };
}

/** True when nothing time-based is pending, so the DO can skip its alarm. */
export function isQuiet(state: PlayState): boolean {
  return Object.keys(state.tickets).length === 0 && Object.keys(state.matches).length === 0;
}

/** Public live line for signed-out visitors and the idle card. */
export function pulse(state: PlayState): Pick<PlayView, "lookingCount" | "playingCount" | "lookingByBranch"> {
  const v = viewFor(state, "");
  return { lookingCount: v.lookingCount, playingCount: v.playingCount, lookingByBranch: v.lookingByBranch };
}
