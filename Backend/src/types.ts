/**
 * Shared wire-format types — keep these mirroring `CoopModels.swift` exactly.
 *
 * The product is a presence feed: "who has The Vault open right now and how
 * can I reach them?" There is no lobby/host/region machinery on the wire —
 * we deliberately removed that. Coordination happens off-app over Steam
 * friends or Discord after a player finds someone interesting in the feed.
 */

export interface PlayerStats {
  totalRuns: number;
  wins: number;
  maxAscension: number;
  preferredCharacter?: string;
}

export interface PlayerProfile {
  steamID: string;
  personaName: string;
  avatarURL?: string;
  discordHandle?: string;
  stats?: PlayerStats;
}

export type PresenceStatus = "looking" | "inRun" | "inCoop" | "afk";

/** Body the client sends on each heartbeat. */
export interface PresenceUpsert {
  status: PresenceStatus;
  note: string;
  discordHandle?: string;
  stats?: PlayerStats;
}

/** Stored shape per user (KV `presence:<steamID>`) and what the list returns. */
export interface PresenceEntry {
  steamID: string;
  personaName: string;
  avatarURL?: string;
  discordHandle?: string;
  stats?: PlayerStats;
  status: PresenceStatus;
  note: string;
  /** Server-derived from Steam Web API at fetch time when an API key is set. */
  inSTS2: boolean;
  updatedAt: string; // ISO8601
}

export interface Env {
  LOBBIES: KVNamespace; // KV namespace; name kept for backward compat
  PUBLIC_BASE_URL: string;
  STS_APP_ID: string;
  STEAM_WEB_API_KEY: string; // wrangler secret
  /**
   * Comma-separated list of additional `host` values that are allowed as
   * sign-in `return=` URLs (in addition to the bundled defaults). Set this
   * if you self-host the web companion on a different domain.
   */
  ALLOWED_RETURN_HOSTS?: string;

  /**
   * Optional bearer token that unlocks the operator-only `/admin` and
   * `/admin/stats` endpoints. Set with `wrangler secret put ADMIN_TOKEN` so
   * it never lands in the repo. When unset (or any request supplies the
   * wrong value), those endpoints respond with the same JSON 404 as any
   * other unknown route — indistinguishable from "endpoint doesn't exist".
   *
   * This is intentional opaqueness, not security through obscurity: the
   * endpoint is also strictly bearer-gated. The 404 simply doesn't
   * advertise that an admin surface exists at all.
   */
  ADMIN_TOKEN?: string;
}
