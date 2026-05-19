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

/** Stored shape per user (KV `presence:<steamID>`) and what the AUTHED list returns. */
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
  /**
   * Server-derived at roster-list time. Populated when the user has an
   * active co-op pairing (created by accepting an invite). Stays absent
   * for solo users. Drives the green "Playing with @X" pill on the
   * roster row. Auto-clears after `PAIR_DURATION_SECONDS` or when
   * either side hits `DELETE /pair`.
   */
  paired?: PairedPartner;
}

/**
 * Wire-format slice of a co-op pair. Mirrors the relevant fields of
 * `PairInfo` in `pairs.ts` (we deliberately omit `expiresAt` from the
 * wire — the client doesn't need to think about pair TTLs, the row
 * just appears or doesn't).
 */
export interface PairedPartner {
  partnerID: string;
  partnerPersona: string;
  partnerAvatar?: string;
  since: string;
}

/**
 * Public, privacy-safe shape returned by `GET /presence` to
 * unauthenticated clients. Deliberately strips every identity field
 * (steamID, personaName, avatarURL, discordHandle, stats) so a guest
 * — or a scraper — cannot harvest Steam handles from the feed.
 *
 * `anonId` is a short opaque identifier (6-char hash of the Steam
 * ID + a rotating salt) so the UI can still show distinct rows and
 * render status dots, but there's no way to correlate anonId back
 * to a Steam account without the server's salt. Rotated daily so
 * even within a single guest's session the same anonId never ties
 * to a tracked identity long-term.
 *
 * `inSTS2` / `status` / `note` are preserved — those are public
 * signals the player explicitly advertised to the community feed,
 * and they're what makes the count meaningful ("3 looking right
 * now, 2 in game"). The guest sees accurate social proof without
 * any personal data.
 */
export interface PublicPresenceEntry {
  anonId: string;
  status: PresenceStatus;
  note: string;
  inSTS2: boolean;
  updatedAt: string;
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

  /**
   * Local-dev test-harness toggle. Set to "1" via the `[env.localdev]`
   * block in `wrangler.toml` (or any non-production override). When
   * present, the `/_debug/seed-session` and `/_debug/wipe` routes are
   * exposed so `verify-coop-lobbies.mjs` can mint Steam sessions
   * without a real OpenID round-trip. Unset in production — those
   * routes 404 like any other unknown path.
   */
  LOCAL_DEBUG?: string;

  /**
   * Optional dev-only co-op sandbox toggle (see `coop-sandbox.ts`).
   * Production deploys must leave this unset.
   */
  DEV_COOP_SANDBOX?: string;
}
