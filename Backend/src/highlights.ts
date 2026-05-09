import type { Env } from "./types";
import { getSessionProfile } from "./presence";

/**
 * Community highlights — share-a-run feed.
 *
 * Product surface: the user finishes a great run, opens the share modal,
 * and clicks "Share to Community". A short summary card lands on a
 * shared feed that everyone signed in can browse, react to, and comment
 * on. There is no upvote / downvote; only positive reactions and short
 * comments. Authors can delete their own highlights and comments.
 *
 * STORAGE SHAPE (intentionally simple):
 *
 *   `highlights:feed`              JSON `{ items: Highlight[], updatedAt }`
 *                                  TTL: indefinite (refreshed on every
 *                                  share/react/comment/delete). Cap 200
 *                                  most-recent highlights — older ones
 *                                  are evicted, and their author's
 *                                  reverse-index entry plus their
 *                                  comments key are cleaned up.
 *
 *   `highlights:author:<sid>`      JSON `{ ids: string[] }`
 *                                  Per-user cap: 5 highlights live at any
 *                                  time. The 6th eviction-cleans the
 *                                  oldest one. Used for the "your
 *                                  highlights" list and to enforce
 *                                  ownership on delete.
 *
 *   `highlights:comments:<id>`     JSON `{ comments: HighlightComment[] }`
 *                                  Up to 100 comments per highlight.
 *                                  TTL mirrors the highlight itself.
 *
 *   Reaction sids live INLINE inside the feed entry (`reactionSets`)
 *   for dedup. They never go on the wire to the client — the feed
 *   GET strips them and computes only `viewerReactions` per request.
 *
 * Why one feed key (not one key per highlight + a list op):
 *   List operations are KV's most expensive surface (1k/day on free
 *   tier). At <200 highlights total this whole feature fits in a
 *   single ~400 KB blob and we never touch list. The hot read path
 *   is exactly 1 KV get per feed render. Modify = read + write. KV's
 *   eventual consistency means a burst of simultaneous reactions can
 *   clobber each other and lose a few counts; that's acceptable for
 *   v0 (counts may briefly be off-by-one, never wrong about which
 *   highlights exist). If it ever bites, promote to Durable Objects.
 */

const FEED_KEY = "highlights:feed";
const AUTHOR_PREFIX = "highlights:author:";
const COMMENTS_PREFIX = "highlights:comments:";

/** Hard ceiling on items kept in the global feed. Old items beyond this
 *  cap get evicted on each share so the feed key never grows past
 *  ~400 KB. */
const FEED_MAX = 200;

/** Per-user cap on simultaneously-live highlights. Sharing a 6th evicts
 *  the oldest one. Keeps a single user from monopolizing the feed and
 *  bounds storage per Steam ID. */
const AUTHOR_HIGHLIGHTS_MAX = 5;

/** Max comments per highlight. Past this, oldest is dropped. */
const COMMENTS_MAX = 100;

/** Curated reaction set. Frozen so the client/server agree exactly. */
export const ALLOWED_REACTIONS = Object.freeze([
  "🔥", "❤️", "👏", "🎯", "💀", "😂",
] as const);
export type Reaction = typeof ALLOWED_REACTIONS[number];

// MARK: - Wire types ---------------------------------------------------------

/**
 * Sanitized run summary embedded in a highlight. Smaller surface than
 * the full RunSummary in `runs.ts` — we deliberately strip cardChoices,
 * seed, etc. because none of that is interesting in a shareable card
 * and including it leaks more than necessary.
 */
export interface HighlightRun {
  character: string;
  ascension: number;
  floorReached: number;
  won: boolean;
  playTimeSeconds: number;
  endedAt: string;
  /** ISO-8601. Optional — clamps to a sane historical window when set
   *  so we can render "Daily Run · MMM D" type badges. */
  startedAt?: string;
  /** STS2 `game_mode` literal, lower-cased. We accept any string the
   *  client sends so a future STS2 patch can ship a new mode without
   *  needing a backend change; the UI is responsible for treating
   *  unknown values gracefully. Clamped to 24 chars. */
  gameMode?: string;
  /** True if the run ended via the in-game "abandon" option rather
   *  than by death or victory. */
  wasAbandoned?: boolean;
  /** Run seed (≤ 32 chars). Useful for daily challenges where every
   *  player on the same day shares one seed. */
  seed?: string;
  /** Daily / custom-game modifier ids (post-prefix), ≤ 8 entries. */
  modifiers?: string[];
  killedBy?: string;
  /** Up to 12 relic ids, ≤ 64 chars each. */
  relics: string[];
  /** Curated highlight card ids, ≤ 12, ≤ 64 chars each. The client
   *  picks which cards from the deck are "the interesting ones" the
   *  same way it does for the share image. */
  deckHighlights: string[];
  neowBonus?: string;
}

export interface Highlight {
  id: string;
  authorID: string;
  authorPersona: string;
  authorAvatar?: string;
  /** Optional 280-char user note posted alongside the run. */
  caption?: string;
  run: HighlightRun;
  /** Denormalized counts: emoji → count. */
  reactions: Record<string, number>;
  /** Denormalized comment count. Source of truth lives in the
   *  `highlights:comments:<id>` key. Updated transactionally enough
   *  that drift is bounded to "off by one for a few seconds" in worst
   *  case. */
  commentCount: number;
  createdAt: string;
}

/** Internal-only: reaction-sid sets for dedup. Stored alongside the
 *  highlight in the feed but stripped before going on the wire. */
interface HighlightInternal extends Highlight {
  reactionSets?: Record<string, string[]>;
}

/** Wire-format response for `GET /highlights`. */
export interface HighlightView extends Highlight {
  /** Emojis the *requesting user* has toggled on. Computed per-request,
   *  never stored. Empty array for unauthenticated callers. */
  viewerReactions: string[];
}

export interface HighlightComment {
  id: string;
  authorID: string;
  authorPersona: string;
  authorAvatar?: string;
  text: string;
  createdAt: string;
}

// MARK: - Sanitization -------------------------------------------------------

function clampString(v: unknown, max: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  return v.length > max ? v.slice(0, max) : v;
}

function clampNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clampStringArr(v: unknown, max: number, perItem = 64): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .slice(0, max)
    .map((s) => s.slice(0, perItem));
}

/** Validate + clamp the user-supplied run payload. Returns null when
 *  required fields are missing — the caller should reject with 400. */
function sanitizeRun(raw: unknown): HighlightRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const character = clampString(r.character, 24);
  if (!character) return null;
  const endedAt = clampString(r.endedAt, 64);
  if (!endedAt) return null;
  // gameMode: tolerate unknown strings, clamp size, lowercase. The UI
  // is the policy layer for what counts as "daily" — by validating
  // shape here and decoding meaning at render time we don't have to
  // rev the backend every time STS2 ships a new game mode (custom,
  // ascension-limited daily, holiday event, etc.).
  const gameMode = typeof r.gameMode === "string"
    ? clampString(r.gameMode.toLowerCase(), 24) || undefined
    : undefined;
  // Modifiers: same shape as relics — bounded list of bounded strings.
  const modifiers = Array.isArray(r.modifiers)
    ? clampStringArr(r.modifiers, 8, 64).map((m) => m.toLowerCase()) || undefined
    : undefined;
  // startedAt: must parse and not be more than 5 years in the past or
  // 1 day in the future. Anything outside that window is dropped
  // silently so the UI falls back to endedAt.
  let startedAt: string | undefined;
  if (typeof r.startedAt === "string") {
    const candidate = clampString(r.startedAt, 64);
    const t = Date.parse(candidate);
    if (Number.isFinite(t)) {
      const now = Date.now();
      const fiveYearsAgo = now - 5 * 365 * 24 * 60 * 60 * 1000;
      const oneDayAhead = now + 24 * 60 * 60 * 1000;
      if (t >= fiveYearsAgo && t <= oneDayAhead) startedAt = candidate;
    }
  }
  const seed = typeof r.seed === "string" ? clampString(r.seed, 32) || undefined : undefined;
  return {
    character,
    ascension: Math.max(0, Math.min(20, Math.floor(clampNumber(r.ascension, 0)))),
    floorReached: Math.max(0, Math.min(60, Math.floor(clampNumber(r.floorReached, 0)))),
    won: r.won === true,
    playTimeSeconds: Math.max(0, Math.min(60 * 60 * 12, Math.floor(clampNumber(r.playTimeSeconds, 0)))),
    endedAt,
    startedAt,
    gameMode,
    wasAbandoned: r.wasAbandoned === true ? true : undefined,
    seed,
    modifiers: modifiers && modifiers.length > 0 ? modifiers : undefined,
    killedBy: typeof r.killedBy === "string" ? clampString(r.killedBy, 64) : undefined,
    relics: clampStringArr(r.relics, 12, 64),
    deckHighlights: clampStringArr(r.deckHighlights ?? r.deckAtEnd, 12, 64),
    neowBonus: typeof r.neowBonus === "string" ? clampString(r.neowBonus, 64) : undefined,
  };
}

function sanitizeCaption(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 280);
}

function sanitizeComment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 280);
}

function isAllowedReaction(s: unknown): s is Reaction {
  return typeof s === "string" && (ALLOWED_REACTIONS as readonly string[]).includes(s);
}

// MARK: - Feed I/O -----------------------------------------------------------

interface FeedBlob {
  items: HighlightInternal[];
  updatedAt: string;
}

async function readFeed(env: Env): Promise<FeedBlob> {
  const raw = await env.LOBBIES.get(FEED_KEY);
  if (!raw) return { items: [], updatedAt: new Date(0).toISOString() };
  try {
    const parsed = JSON.parse(raw) as FeedBlob;
    if (!parsed || !Array.isArray(parsed.items)) {
      return { items: [], updatedAt: new Date(0).toISOString() };
    }
    return parsed;
  } catch {
    return { items: [], updatedAt: new Date(0).toISOString() };
  }
}

async function writeFeed(env: Env, feed: FeedBlob): Promise<void> {
  feed.updatedAt = new Date().toISOString();
  // Defensive cap. Anything over FEED_MAX (oldest first) gets evicted
  // before we write — keeps the blob bounded even if a logic bug ever
  // forgets to slice on the modify path.
  if (feed.items.length > FEED_MAX) {
    feed.items = feed.items.slice(0, FEED_MAX);
  }
  await env.LOBBIES.put(FEED_KEY, JSON.stringify(feed));
}

interface AuthorIndex { ids: string[]; }

async function readAuthorIndex(env: Env, sid: string): Promise<AuthorIndex> {
  const raw = await env.LOBBIES.get(`${AUTHOR_PREFIX}${sid}`);
  if (!raw) return { ids: [] };
  try {
    const parsed = JSON.parse(raw) as AuthorIndex;
    if (!parsed || !Array.isArray(parsed.ids)) return { ids: [] };
    return parsed;
  } catch {
    return { ids: [] };
  }
}

async function writeAuthorIndex(env: Env, sid: string, idx: AuthorIndex): Promise<void> {
  await env.LOBBIES.put(`${AUTHOR_PREFIX}${sid}`, JSON.stringify(idx));
}

interface CommentsBlob { comments: HighlightComment[]; }

async function readComments(env: Env, id: string): Promise<CommentsBlob> {
  const raw = await env.LOBBIES.get(`${COMMENTS_PREFIX}${id}`);
  if (!raw) return { comments: [] };
  try {
    const parsed = JSON.parse(raw) as CommentsBlob;
    if (!parsed || !Array.isArray(parsed.comments)) return { comments: [] };
    return parsed;
  } catch {
    return { comments: [] };
  }
}

async function writeComments(env: Env, id: string, blob: CommentsBlob): Promise<void> {
  await env.LOBBIES.put(`${COMMENTS_PREFIX}${id}`, JSON.stringify(blob));
}

// MARK: - Helpers ------------------------------------------------------------

function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Strip server-internal fields and compute viewerReactions for the
 *  request. Safe to send straight on the wire. */
function viewFor(item: HighlightInternal, viewerSID: string | null): HighlightView {
  const { reactionSets, ...rest } = item;
  let viewerReactions: string[] = [];
  if (viewerSID && reactionSets) {
    viewerReactions = Object.entries(reactionSets)
      .filter(([, sids]) => Array.isArray(sids) && sids.includes(viewerSID))
      .map(([emoji]) => emoji);
  }
  return { ...rest, viewerReactions };
}

// MARK: - Public API ---------------------------------------------------------

export interface ShareResult {
  ok: true;
  highlight: HighlightView;
}
export interface ShareError {
  ok: false;
  status: number;
  error: string;
}

/**
 * Share a run to the community feed. The caller's session-bound SteamID
 * is used as the author — never the request body — so a tampered client
 * can't forge attribution. Enforces the per-user cap (oldest evicted)
 * and clamps every user-controlled string.
 */
export async function shareHighlight(
  env: Env,
  authorID: string,
  body: unknown
): Promise<ShareResult | ShareError> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid body" };
  }
  const b = body as Record<string, unknown>;
  const run = sanitizeRun(b.run);
  if (!run) {
    return { ok: false, status: 400, error: "invalid run" };
  }
  const caption = sanitizeCaption(b.caption);

  // Snapshot author identity at share time so persona/avatar changes
  // post-share don't rewrite history. If we can't resolve a profile
  // (very unusual — a session always implies a profile) fall back to
  // a generic display name; the SteamID is still the source of truth
  // for ownership checks.
  const profile = await getSessionProfile(env, authorID);

  const id = newId();
  const item: HighlightInternal = {
    id,
    authorID,
    authorPersona: profile?.personaName ?? "Steam User",
    authorAvatar: profile?.avatarURL,
    caption,
    run,
    reactions: {},
    reactionSets: {},
    commentCount: 0,
    createdAt: new Date().toISOString(),
  };

  const feed = await readFeed(env);
  // Insert at head.
  feed.items.unshift(item);

  // Per-user cap. Walk the index and evict the oldest if over.
  const authorIdx = await readAuthorIndex(env, authorID);
  authorIdx.ids.unshift(id);
  let evicted: string[] = [];
  while (authorIdx.ids.length > AUTHOR_HIGHLIGHTS_MAX) {
    const evictId = authorIdx.ids.pop();
    if (evictId) evicted.push(evictId);
  }

  // Drop evicted items from the global feed too.
  if (evicted.length > 0) {
    feed.items = feed.items.filter((it) => !evicted.includes(it.id));
  }
  // Also enforce the global FEED_MAX (oldest first, no matter the author).
  if (feed.items.length > FEED_MAX) {
    const overflow = feed.items.slice(FEED_MAX);
    feed.items = feed.items.slice(0, FEED_MAX);
    // Best-effort: clean up author indexes for evicted others too.
    for (const it of overflow) {
      evicted.push(it.id);
    }
  }

  await Promise.all([
    writeFeed(env, feed),
    writeAuthorIndex(env, authorID, authorIdx),
    // Best-effort cleanup of orphaned comment blobs for evicted items.
    ...evicted.map((eid) => env.LOBBIES.delete(`${COMMENTS_PREFIX}${eid}`)),
  ]);

  return { ok: true, highlight: viewFor(item, authorID) };
}

/**
 * Public read of the global feed. Authenticated callers get
 * `viewerReactions` populated; guests get an empty array on each item
 * so the UI can decide whether to highlight reaction buttons.
 */
export async function listHighlights(
  env: Env,
  viewerSID: string | null,
  opts: { limit?: number } = {}
): Promise<HighlightView[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const feed = await readFeed(env);
  return feed.items.slice(0, limit).map((it) => viewFor(it, viewerSID));
}

/**
 * Single-highlight read. Useful when the client wants to refresh a
 * specific card after a reaction or comment without re-paginating.
 */
export async function getHighlight(
  env: Env,
  id: string,
  viewerSID: string | null
): Promise<HighlightView | null> {
  const feed = await readFeed(env);
  const item = feed.items.find((it) => it.id === id);
  if (!item) return null;
  return viewFor(item, viewerSID);
}

export interface ReactResult {
  ok: true;
  highlight: HighlightView;
}
export interface ReactError {
  ok: false;
  status: number;
  error: string;
}

/**
 * Toggle a reaction. POSTing the same emoji twice removes it. Reactions
 * dedup per-user-per-emoji so stacking infinite ❤️s on one post isn't
 * a thing. The server is the source of truth for both the count and the
 * "did this user react" flag.
 */
export async function toggleReaction(
  env: Env,
  highlightID: string,
  reactorSID: string,
  emoji: unknown
): Promise<ReactResult | ReactError> {
  if (!isAllowedReaction(emoji)) {
    return { ok: false, status: 400, error: "invalid reaction" };
  }
  const feed = await readFeed(env);
  const idx = feed.items.findIndex((it) => it.id === highlightID);
  if (idx === -1) {
    return { ok: false, status: 404, error: "not found" };
  }
  const item = feed.items[idx];
  item.reactionSets ??= {};
  const sids = item.reactionSets[emoji] ?? [];
  const has = sids.includes(reactorSID);
  if (has) {
    item.reactionSets[emoji] = sids.filter((s) => s !== reactorSID);
    if (item.reactionSets[emoji].length === 0) {
      delete item.reactionSets[emoji];
    }
  } else {
    item.reactionSets[emoji] = [...sids, reactorSID];
  }
  // Recompute denorm counts from authoritative sets so we never drift
  // out of sync within a single write — drift only happens across
  // races between concurrent writers, which we accept for v0.
  item.reactions = {};
  for (const [k, v] of Object.entries(item.reactionSets)) {
    if (v.length > 0) item.reactions[k] = v.length;
  }
  feed.items[idx] = item;
  await writeFeed(env, feed);
  return { ok: true, highlight: viewFor(item, reactorSID) };
}

export interface CommentResult {
  ok: true;
  comment: HighlightComment;
  highlight: HighlightView;
}

/**
 * Post a comment on a highlight. Author identity is the session
 * SteamID; persona/avatar snapshotted from session profile. Length
 * capped at 280 chars. Past 100 comments per highlight, oldest is
 * dropped to keep the comment blob bounded.
 */
export async function postComment(
  env: Env,
  highlightID: string,
  authorID: string,
  rawText: unknown
): Promise<CommentResult | ReactError> {
  const text = sanitizeComment(rawText);
  if (!text) {
    return { ok: false, status: 400, error: "empty comment" };
  }
  const feed = await readFeed(env);
  const idx = feed.items.findIndex((it) => it.id === highlightID);
  if (idx === -1) {
    return { ok: false, status: 404, error: "not found" };
  }
  const profile = await getSessionProfile(env, authorID);
  const comment: HighlightComment = {
    id: newId(),
    authorID,
    authorPersona: profile?.personaName ?? "Steam User",
    authorAvatar: profile?.avatarURL,
    text,
    createdAt: new Date().toISOString(),
  };
  const blob = await readComments(env, highlightID);
  blob.comments.push(comment);
  if (blob.comments.length > COMMENTS_MAX) {
    blob.comments = blob.comments.slice(-COMMENTS_MAX);
  }
  await writeComments(env, highlightID, blob);

  // Update denorm count on the feed entry.
  const item = feed.items[idx];
  item.commentCount = blob.comments.length;
  feed.items[idx] = item;
  await writeFeed(env, feed);

  return {
    ok: true,
    comment,
    highlight: viewFor(item, authorID),
  };
}

/**
 * Read all comments for a highlight in chronological order. Pagination
 * isn't worth bothering with at COMMENTS_MAX = 100; the whole list
 * fits in a single response easily.
 */
export async function listComments(
  env: Env,
  highlightID: string
): Promise<{ comments: HighlightComment[] } | ReactError> {
  const feed = await readFeed(env);
  const exists = feed.items.some((it) => it.id === highlightID);
  if (!exists) return { ok: false, status: 404, error: "not found" };
  const blob = await readComments(env, highlightID);
  return { comments: blob.comments };
}

export interface DeleteResult { ok: true; }

/**
 * Author-only delete. Removes the highlight from the global feed, the
 * author's index, and tears down the comment blob. Idempotent: returns
 * `ok` even if the highlight is already gone (so a double-click on the
 * delete button is harmless).
 */
export async function deleteHighlight(
  env: Env,
  highlightID: string,
  callerSID: string
): Promise<DeleteResult | ReactError> {
  const feed = await readFeed(env);
  const idx = feed.items.findIndex((it) => it.id === highlightID);
  if (idx === -1) {
    return { ok: true };
  }
  const item = feed.items[idx];
  if (item.authorID !== callerSID) {
    return { ok: false, status: 403, error: "not your highlight" };
  }
  feed.items.splice(idx, 1);
  await writeFeed(env, feed);

  const authorIdx = await readAuthorIndex(env, callerSID);
  authorIdx.ids = authorIdx.ids.filter((id) => id !== highlightID);
  await writeAuthorIndex(env, callerSID, authorIdx);

  await env.LOBBIES.delete(`${COMMENTS_PREFIX}${highlightID}`);
  return { ok: true };
}

/**
 * Author-only comment delete. Reduces the highlight's denormalized
 * comment count.
 */
export async function deleteComment(
  env: Env,
  highlightID: string,
  commentID: string,
  callerSID: string
): Promise<DeleteResult | ReactError> {
  const blob = await readComments(env, highlightID);
  const idx = blob.comments.findIndex((c) => c.id === commentID);
  if (idx === -1) return { ok: true };
  const c = blob.comments[idx];
  // Author of the comment OR author of the highlight may delete.
  if (c.authorID !== callerSID) {
    const feed = await readFeed(env);
    const item = feed.items.find((it) => it.id === highlightID);
    if (!item || item.authorID !== callerSID) {
      return { ok: false, status: 403, error: "not yours to delete" };
    }
  }
  blob.comments.splice(idx, 1);
  await writeComments(env, highlightID, blob);

  // Update denorm count on the feed entry.
  const feed = await readFeed(env);
  const fIdx = feed.items.findIndex((it) => it.id === highlightID);
  if (fIdx >= 0) {
    feed.items[fIdx].commentCount = blob.comments.length;
    await writeFeed(env, feed);
  }
  return { ok: true };
}
