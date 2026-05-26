/**
 * Post-run Shared Report — capture a small public share card describing
 * a co-op run so the host can post it to Discord / X / Reddit after a
 * party finishes.
 *
 * Spec: docs/coop-post-run-shared-report-spec.md
 *
 * Storage:
 *   coop:share:<shareId>   public share-card blob, 30-day TTL
 *
 * Trust model:
 *   - The CAPTURE endpoint requires session auth and the caller must be
 *     a member of the party in question. We snapshot what the server
 *     already knows about that party (members, lobbyId, hostSteamId,
 *     character selections, party status). Nothing client-supplied
 *     except the partyId and an optional one-line note.
 *   - The READ endpoint is fully public — no auth — but contains no
 *     sensitive data (no Steam IDs in plaintext, no run-detail seeds
 *     unless the user opted in).
 */

import type { Env } from "./types";
import { newRandomId, readParty } from "./coop-store";

export interface ShareCardPayload {
  shareId: string;
  partyId: string;
  /** Free-form host-supplied caption. Max 240 chars. */
  caption?: string;
  /** Roster snapshot (display names only, no Steam IDs). */
  members: Array<{
    personaName: string;
    character?: string;
    role: "host" | "member";
    outcome: "in_game" | "left" | "ready" | "joined" | "character_select";
  }>;
  /** ISO8601 of the party's createdAt. */
  startedAt?: string;
  /** ISO8601 of the share capture (close to end-of-party). */
  endedAt: string;
  /** Daily challenge date if the party was tagged with [daily=YYYY-MM-DD]. */
  dailyDate?: string;
}

const SHARE_TTL_S = 30 * 24 * 60 * 60; // 30 days

function shareKey(shareId: string): string {
  return `coop:share:${shareId}`;
}

function sanitizeCaption(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 240);
}

/**
 * Capture a share card for an existing party. Caller must be a member
 * of the party. Returns the new shareId.
 */
export async function captureShareCard(
  env: Env,
  callerSteamId: string,
  body: { partyId?: unknown; caption?: unknown },
): Promise<{ ok: true; shareId: string } | { ok: false; status: number; error: string }> {
  const partyId = typeof body.partyId === "string" ? body.partyId.slice(0, 64) : "";
  if (!partyId) return { ok: false, status: 400, error: "missing_party_id" };
  const party = await readParty(env, partyId);
  if (!party) return { ok: false, status: 404, error: "party_not_found" };
  const isMember = party.members.some((m) => m.steamId === callerSteamId);
  if (!isMember) return { ok: false, status: 403, error: "not_member" };

  // Derive daily tag from the lobby note if any (the lobby's still
  // around for ~5 minutes after the party ends thanks to the grace
  // window in COOP_LOBBY_TTL_S).
  let dailyDate: string | undefined;
  try {
    if (party.lobbyId) {
      const lobbyRaw = await env.LOBBIES.get(`coop:lobby:${party.lobbyId}`);
      if (lobbyRaw) {
        const parsed = JSON.parse(lobbyRaw) as { note?: string };
        const m = /\[daily=(\d{4}-\d{2}-\d{2})\]/.exec(parsed?.note ?? "");
        if (m) dailyDate = m[1];
      }
    }
  } catch {
    /* swallow */
  }

  const payload: ShareCardPayload = {
    shareId: newRandomId(),
    partyId: party.partyId,
    members: party.members.map((m) => ({
      personaName: m.personaName ?? "Player",
      character: m.selectedCharacter,
      role: m.steamId === party.hostSteamId ? "host" : "member",
      outcome: m.status as ShareCardPayload["members"][number]["outcome"],
    })),
    endedAt: new Date().toISOString(),
    ...(party.createdAt ? { startedAt: party.createdAt } : {}),
    ...(dailyDate ? { dailyDate } : {}),
    ...(sanitizeCaption(body.caption) ? { caption: sanitizeCaption(body.caption) } : {}),
  };

  try {
    await env.LOBBIES.put(shareKey(payload.shareId), JSON.stringify(payload), {
      expirationTtl: SHARE_TTL_S,
    });
  } catch {
    return { ok: false, status: 503, error: "store_failed" };
  }
  return { ok: true, shareId: payload.shareId };
}

/** Public read — no auth. Returns the share card or null. */
export async function readShareCard(env: Env, shareId: string): Promise<ShareCardPayload | null> {
  const sanitized = shareId.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 64);
  if (!sanitized) return null;
  try {
    const raw = await env.LOBBIES.get(shareKey(sanitized));
    if (!raw) return null;
    return JSON.parse(raw) as ShareCardPayload;
  } catch {
    return null;
  }
}
