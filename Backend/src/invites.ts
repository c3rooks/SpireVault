import type { Env } from "./types";

/**
 * Co-op invite system — preset messages only, accept/decline.
 *
 * Why preset messages:
 *   The user explicitly didn't want a free-text DM channel because it'd open
 *   the door to profanity, harassment, and targeted abuse. So instead of an
 *   open chat, every invite carries one of a small fixed set of canonical
 *   intents ("Want to co-op?", "I'm A20+", "GG one round", etc.). The wire
 *   format only carries the message *id* — the human-readable text is owned
 *   by the client. That means we can edit copy without a backend deploy and
 *   we can localize later without changing the storage shape.
 *
 * Storage layout in KV:
 *   - `invite:<id>`              → Invite JSON,  TTL = INVITE_TTL_SECONDS
 *   - `inbox:<toID>:<inviteId>`  → "" (presence marker), TTL same as invite
 *   - `outbox:<fromID>:<toID>`   → "<inviteId>", TTL = INVITE_DEDUPE_SECONDS
 *
 * The outbox key is a soft rate-limit: one pending invite per (sender→receiver)
 * pair within the dedupe window. Stops "spam-clicked invite 50 times".
 *
 * The inbox uses a per-recipient prefix so listing your inbox is one
 * `KV.list({ prefix: "inbox:<me>:" })` call. We don't bother with a
 * per-sender outbox listing — senders see acceptance state via a status
 * change on the invite record itself.
 */

const INVITE_TTL_SECONDS = 30 * 60;          // invites live 30 min
const INVITE_DEDUPE_SECONDS = 60;             // can't re-invite same person for 60 s
const INVITE_PREFIX = "invite:";
const INBOX_PREFIX = "inbox:";
const OUTBOX_PREFIX = "outbox:";

/**
 * The closed set of allowed invite messages. The client renders the human text
 * keyed by `id`; the wire only ever carries the id. Keep this list small —
 * every entry is something a stranger could send a stranger and still feel ok.
 *
 * NOTE: do not add anything that could be used as harassment when sent
 * unsolicited. "GG" type messages are post-game, not invites.
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
  respondedAt?: string;
}

// MARK: - Validation ---------------------------------------------------------

function isValidSteamID(s: string): boolean {
  return typeof s === "string" && /^\d{17}$/.test(s);
}

function isValidMessageId(s: any): s is keyof typeof INVITE_MESSAGES {
  return typeof s === "string" && Object.prototype.hasOwnProperty.call(INVITE_MESSAGES, s);
}

function newInviteId(): string {
  // 16 bytes of randomness, hex-encoded. Plenty for a TTL-scoped, sender-keyed id.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// MARK: - Helpers ------------------------------------------------------------

async function getPresenceProfile(env: Env, steamID: string): Promise<{ persona: string; avatar?: string } | null> {
  // Reuse what the presence service already stamped — saves us a Steam API call.
  const raw = await env.LOBBIES.get(`session-profile:${steamID}`);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { personaName: string; avatarURL?: string };
    return { persona: p.personaName ?? "Steam User", avatar: p.avatarURL };
  } catch {
    return null;
  }
}

async function getInvite(env: Env, id: string): Promise<Invite | null> {
  const raw = await env.LOBBIES.get(`${INVITE_PREFIX}${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw) as Invite; } catch { return null; }
}

async function putInvite(env: Env, invite: Invite): Promise<void> {
  await env.LOBBIES.put(
    `${INVITE_PREFIX}${invite.id}`,
    JSON.stringify(invite),
    { expirationTtl: INVITE_TTL_SECONDS }
  );
}

// MARK: - Public API ---------------------------------------------------------

/**
 * Send an invite. The body is just `{ toID, messageId }`. Sender identity is
 * taken from the verified session — never from the body.
 */
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

  // Recipient must currently have presence — no inviting offline strangers.
  const recipientPresence = await env.LOBBIES.get(`presence:${toID}`);
  if (!recipientPresence) {
    return { ok: false, status: 404, error: "recipient_offline" };
  }

  // Dedupe: refuse if there's already a pending invite from this sender to this
  // recipient within INVITE_DEDUPE_SECONDS. Returns the existing invite so the
  // UI can still show "you already invited them" state.
  const dedupeKey = `${OUTBOX_PREFIX}${fromID}:${toID}`;
  const existingId = await env.LOBBIES.get(dedupeKey);
  if (existingId) {
    const existing = await getInvite(env, existingId);
    if (existing && existing.status === "pending") {
      return { ok: true, invite: existing };
    }
  }

  const fromProfile = await getPresenceProfile(env, fromID);
  const toProfile = await getPresenceProfile(env, toID);

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
    createdAt: new Date().toISOString(),
  };

  await putInvite(env, invite);
  await env.LOBBIES.put(`${INBOX_PREFIX}${toID}:${invite.id}`, "", {
    expirationTtl: INVITE_TTL_SECONDS,
  });
  await env.LOBBIES.put(dedupeKey, invite.id, {
    expirationTtl: INVITE_DEDUPE_SECONDS,
  });

  return { ok: true, invite };
}

/**
 * List the caller's inbox — all unresolved invites *to* them, plus recently
 * resolved ones (so the UI can flash "X declined" briefly). The cap stops a
 * runaway sender from making a feed unreadable.
 */
export async function listInbox(env: Env, toID: string): Promise<Invite[]> {
  const out: Invite[] = [];
  const page = await env.LOBBIES.list({ prefix: `${INBOX_PREFIX}${toID}:`, limit: 50 });
  for (const key of page.keys) {
    const id = key.name.slice(`${INBOX_PREFIX}${toID}:`.length);
    const invite = await getInvite(env, id);
    if (invite) out.push(invite);
  }
  // Newest first.
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

/**
 * List the caller's outbox — invites *they* sent that are still around.
 * Useful so the sender can see "still pending / accepted / declined".
 */
export async function listOutbox(env: Env, fromID: string): Promise<Invite[]> {
  // Outbox isn't indexed by sender, so we walk the active invites table once.
  // Cheap because INVITE_TTL caps it at minutes of activity.
  const out: Invite[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.LOBBIES.list({ prefix: INVITE_PREFIX, cursor, limit: 200 });
    for (const k of page.keys) {
      const raw = await env.LOBBIES.get(k.name);
      if (!raw) continue;
      try {
        const invite = JSON.parse(raw) as Invite;
        if (invite.fromID === fromID) out.push(invite);
      } catch { /* skip */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out.slice(0, 50);
}

/**
 * Respond to an invite — accept or decline. Only the recipient can call this.
 */
export async function respondToInvite(
  env: Env,
  inviteId: string,
  responderID: string,
  accept: boolean
): Promise<{ ok: true; invite: Invite } | { ok: false; status: number; error: string }> {
  const invite = await getInvite(env, inviteId);
  if (!invite) return { ok: false, status: 404, error: "not_found" };
  if (invite.toID !== responderID) {
    return { ok: false, status: 403, error: "not_yours" };
  }
  if (invite.status !== "pending") {
    return { ok: false, status: 409, error: "already_resolved" };
  }

  invite.status = accept ? "accepted" : "declined";
  invite.respondedAt = new Date().toISOString();

  await putInvite(env, invite);

  // Pull from the inbox immediately on decline; on accept, leave it briefly so
  // the recipient's UI can show "Accepted — see deep-links" before TTL drops it.
  if (!accept) {
    await env.LOBBIES.delete(`${INBOX_PREFIX}${responderID}:${inviteId}`);
  }

  return { ok: true, invite };
}

/**
 * Withdraw an invite the caller sent. Used when the sender clicks "cancel".
 */
export async function withdrawInvite(
  env: Env,
  inviteId: string,
  callerID: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const invite = await getInvite(env, inviteId);
  if (!invite) return { ok: false, status: 404, error: "not_found" };
  if (invite.fromID !== callerID) {
    return { ok: false, status: 403, error: "not_yours" };
  }
  await env.LOBBIES.delete(`${INVITE_PREFIX}${inviteId}`);
  await env.LOBBIES.delete(`${INBOX_PREFIX}${invite.toID}:${inviteId}`);
  await env.LOBBIES.delete(`${OUTBOX_PREFIX}${invite.fromID}:${invite.toID}`);
  return { ok: true };
}
