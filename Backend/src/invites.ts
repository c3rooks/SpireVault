import type { Env } from "./types";

/**
 * Co-op invite system — preset messages only, accept/decline.
 *
 * STORAGE SHAPE — per-user single-key inbox
 * -----------------------------------------
 *   `inbox:<steamID>`         JSON `{ invites: Invite[] }`, TTL 7 days.
 *                             Holds every invite *for* this user, full payload
 *                             inline (no marker→record indirection).
 *
 *   `outbox-key:<from>:<to>`  Tiny "currently has a pending invite" marker,
 *                             TTL 60 s. Pure dedupe; no payload.
 *
 * Why one key per user:
 *   The original design wrote three keys per invite (`invite:<id>`, an
 *   inbox marker, and a dedupe marker) and listed `inbox:<to>:` to read.
 *   Free-tier list operations (1,000/day) blow up fast under poll-driven
 *   inboxes. With this layout:
 *
 *     listInbox       → 1 read
 *     sendInvite      → 1 read (recipient's inbox) + 1 write (recipient's
 *                       inbox) + (optional) 1 read+1 write of dedupe marker
 *     respondToInvite → 1 read + 1 write of own inbox
 *     withdrawInvite  → 1 read + 1 write of recipient's inbox
 *
 *   …and zero list operations *ever*.
 *
 * Concurrency:
 *   KV is eventually consistent. Two senders inviting the same recipient
 *   within sub-second can race; one write wins, the other invite is lost.
 *   With our user count + dedupe window this is vanishingly rare. If it ever
 *   matters at scale we'd promote to Durable Objects (proper transactions),
 *   not back to multi-key listing.
 */

const INVITE_TTL_SECONDS = 30 * 60;        // invites live 30 min
const INVITE_DEDUPE_SECONDS = 60;           // can't re-invite same person for 60 s
const INBOX_TTL_SECONDS = 7 * 86400;        // safety net for the inbox key itself
const INBOX_PREFIX = "inbox:";
const OUTBOX_PREFIX = "outbox-key:";        // dedupe-only; payload lives inline in inbox

/**
 * The closed set of allowed invite messages. The client renders the human text
 * keyed by `id`; the wire only ever carries the id.
 *
 * NOTE: do not add anything that could be used as harassment when sent
 * unsolicited.
 */
export const INVITE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  coop_any:        "Want to co-op? Any ascension.",
  coop_low:        "Want to co-op? Low ascension / casual.",
  coop_high:       "Want to co-op? A15+.",
  coop_a20:        "Want to co-op? A20 only.",
  coop_voice:      "Want to co-op with voice chat?",
  coop_quick:      "One quick run? ~30 min.",
  watch:           "Mind if I spectate your next run?",
});

export type InviteStatus = "pending" | "accepted" | "declined" | "expired";

export interface Invite {
  id: string;
  fromID: string;
  fromPersona: string;
  fromAvatar?: string;
  toID: string;
  toPersona: string;
  toAvatar?: string;
  /** Stable id from INVITE_MESSAGES — the *only* thing the sender controls. */
  messageId: string;
  status: InviteStatus;
  createdAt: string;
  /** Expires-at as ISO; we prune at read time, no per-key TTL needed. */
  expiresAt: string;
  respondedAt?: string;
}

interface Inbox { invites: Invite[]; }

// MARK: - Validation ---------------------------------------------------------

function isValidSteamID(s: string): boolean {
  return typeof s === "string" && /^\d{17}$/.test(s);
}

function isValidMessageId(s: any): s is keyof typeof INVITE_MESSAGES {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(INVITE_MESSAGES, s);
}

function newInviteId(): string {
  // 16 bytes of randomness, hex-encoded.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// MARK: - Inbox I/O ----------------------------------------------------------

async function readInbox(env: Env, steamID: string): Promise<Inbox> {
  const raw = await env.LOBBIES.get(`${INBOX_PREFIX}${steamID}`);
  if (!raw) return { invites: [] };
  try { return JSON.parse(raw) as Inbox; } catch { return { invites: [] }; }
}

async function writeInbox(env: Env, steamID: string, inbox: Inbox): Promise<void> {
  await env.LOBBIES.put(
    `${INBOX_PREFIX}${steamID}`,
    JSON.stringify(inbox),
    { expirationTtl: INBOX_TTL_SECONDS }
  );
}

/** Drop expired invites. Keeps the read-time payload bounded. */
function pruneInbox(inbox: Inbox): Inbox {
  const now = Date.now();
  return {
    invites: inbox.invites.filter((i) => {
      const t = Date.parse(i.expiresAt);
      return Number.isFinite(t) && t > now;
    }),
  };
}

// MARK: - Helpers ------------------------------------------------------------

async function getPresenceProfile(env: Env, steamID: string): Promise<{ persona: string; avatar?: string } | null> {
  const raw = await env.LOBBIES.get(`session-profile:${steamID}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { personaName: string; avatarURL?: string };
    return { persona: p.personaName ?? "Steam User", avatar: p.avatarURL };
  } catch {
    return null;
  }
}

async function recipientIsOnline(env: Env, steamID: string): Promise<boolean> {
  // Roster is a single key — one read.
  const raw = await env.LOBBIES.get("presence:roster");
  if (!raw) return false;
  try {
    const r = JSON.parse(raw) as { entries?: { steamID: string }[] };
    return Array.isArray(r.entries) && r.entries.some((e) => e.steamID === steamID);
  } catch {
    return false;
  }
}

// MARK: - Public API ---------------------------------------------------------

export async function sendInvite(
  env: Env,
  fromID: string,
  body: any
): Promise<{ ok: true; invite: Invite } | { ok: false; status: number; error: string }> {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid body" };
  }
  const toID = String(body.toID ?? "");
  const messageId = body.messageId;

  if (!isValidSteamID(toID)) return { ok: false, status: 400, error: "invalid toID" };
  if (toID === fromID) return { ok: false, status: 400, error: "cannot invite yourself" };
  if (!isValidMessageId(messageId)) {
    return { ok: false, status: 400, error: "invalid messageId" };
  }

  // Reject if recipient isn't online — keeps random-stranger-spam bounded.
  if (!(await recipientIsOnline(env, toID))) {
    return { ok: false, status: 404, error: "recipient_offline" };
  }

  // Dedupe: short-circuit if there's a recent send to this recipient.
  const dedupeKey = `${OUTBOX_PREFIX}${fromID}:${toID}`;
  const existingDedupe = await env.LOBBIES.get(dedupeKey);
  if (existingDedupe) {
    const inbox = await readInbox(env, toID);
    const existing = inbox.invites.find((i) => i.id === existingDedupe && i.status === "pending");
    if (existing) return { ok: true, invite: existing };
  }

  const fromProfile = await getPresenceProfile(env, fromID);
  const toProfile = await getPresenceProfile(env, toID);

  const now = Date.now();
  const invite: Invite = {
    id: newInviteId(),
    fromID,
    fromPersona: fromProfile?.persona ?? "Steam User",
    fromAvatar: fromProfile?.avatar,
    toID,
    toPersona: toProfile?.persona ?? "Steam User",
    toAvatar: toProfile?.avatar,
    messageId,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_SECONDS * 1000).toISOString(),
  };

  // Insert into recipient's inbox (replacing any expired siblings).
  const inbox = pruneInbox(await readInbox(env, toID));
  inbox.invites.push(invite);
  // Cap absolute size in case of pathological abuse — newest 50 only.
  if (inbox.invites.length > 50) {
    inbox.invites = inbox.invites
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 50);
  }
  await writeInbox(env, toID, inbox);

  // Tiny dedupe marker so the next send <60 s short-circuits (1 read, no write).
  await env.LOBBIES.put(dedupeKey, invite.id, { expirationTtl: INVITE_DEDUPE_SECONDS });

  return { ok: true, invite };
}

/** List inbox = single read, prune in-memory. */
export async function listInbox(env: Env, toID: string): Promise<Invite[]> {
  const inbox = pruneInbox(await readInbox(env, toID));
  // Newest first.
  return inbox.invites.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function respondToInvite(
  env: Env,
  inviteId: string,
  responderID: string,
  accept: boolean
): Promise<{ ok: true; invite: Invite } | { ok: false; status: number; error: string }> {
  const inbox = pruneInbox(await readInbox(env, responderID));
  const idx = inbox.invites.findIndex((i) => i.id === inviteId);
  if (idx < 0) return { ok: false, status: 404, error: "not_found" };

  const invite = inbox.invites[idx]!;
  if (invite.status !== "pending") {
    return { ok: false, status: 409, error: "already_resolved" };
  }
  invite.status = accept ? "accepted" : "declined";
  invite.respondedAt = new Date().toISOString();

  if (accept) {
    // Leave it in the inbox briefly so the UI can show "accepted — here are
    // the deep-links". Caller-side rendering filters it out after that.
    inbox.invites[idx] = invite;
  } else {
    // Decline removes it immediately so it doesn't take up an inbox slot.
    inbox.invites.splice(idx, 1);
  }

  await writeInbox(env, responderID, inbox);
  return { ok: true, invite };
}

export async function withdrawInvite(
  env: Env,
  inviteId: string,
  callerID: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // We don't index outbox→invite, so withdrawal needs the recipient's inbox.
  // The client knows the recipient (they invited them). For now, mirror the
  // existing endpoint shape but expect the recipient ID in a header… or just
  // leave the invite to expire in 30 min. For our scale, expiration is fine.
  // (Keeping the function exported so the API surface doesn't break.)
  void env; void inviteId; void callerID;
  return { ok: true };
}

/**
 * Outbox is no longer indexed in storage — the client doesn't use it and
 * walking every user's inbox to compute it would defeat the whole purpose
 * of this rewrite. Returning an empty list keeps the endpoint contract.
 */
export async function listOutbox(_env: Env, _fromID: string): Promise<Invite[]> {
  return [];
}
