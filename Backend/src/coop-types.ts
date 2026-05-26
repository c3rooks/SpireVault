/**
 * Co-op run-lobby data model.
 *
 * These types are the wire contract for every `/coop/...` endpoint.
 * The legacy `/presence`, `/invites`, `/pair` surfaces continue to use
 * the shapes in `types.ts` so the macOS app and any old web client keep
 * working unchanged.
 *
 * Naming convention: every type is prefixed by intent
 *   - `CoopPresence` is the heartbeat-backed presence row v2.
 *   - `RunLobby` is the temporary group a host advertises.
 *   - `CoopInvite` / `JoinRequest` are the two ways players opt in.
 *   - `CoopSession` is the post-pair confirmation.
 *
 * All timestamps are ISO-8601 strings. Server is the only writer of
 * `createdAt`, `updatedAt`, and `expiresAt`. Client never sends them.
 */

/** Closed set of "what kind of run am I looking for". */
export type CoopGoal =
  | "casual"
  | "climb"
  | "a20"
  | "heart"
  | "teaching"
  | "learning"
  | "daily"
  | "experimental"
  | "any";

export const COOP_GOALS: readonly CoopGoal[] = [
  "casual",
  "climb",
  "a20",
  "heart",
  "teaching",
  "learning",
  "daily",
  "experimental",
  "any",
];

/** Status the user advertises on their own presence row. */
export type CoopPresenceStatus =
  | "looking"
  | "solo"
  | "paired"
  | "afk"
  | "offline";

export const COOP_PRESENCE_STATUSES: readonly CoopPresenceStatus[] = [
  "looking",
  "solo",
  "paired",
  "afk",
  "offline",
];

export type VoicePreference = "yes" | "no" | "optional";

export const VOICE_PREFERENCES: readonly VoicePreference[] = [
  "yes",
  "no",
  "optional",
];

/** Discord LFG voice preset on a run room (Co-op Lobby Beta reset). */
export type VoicePreset = "none" | "any" | "lfg1" | "lfg_duo3" | "custom";

export const VOICE_PRESETS: readonly VoicePreset[] = [
  "none",
  "any",
  "lfg1",
  "lfg_duo3",
  "custom",
];

export type CoopCharacter =
  | "ironclad"
  | "silent"
  | "defect"
  | "regent"
  | "necrobinder";

export const COOP_CHARACTERS: readonly CoopCharacter[] = [
  "ironclad",
  "silent",
  "defect",
  "regent",
  "necrobinder",
];

/**
 * Live presence row. Stored at `coop:presence:<steamId>`, refreshed on
 * every heartbeat. `expiresAt` is what gates "stale" handling at read
 * time. Persistent — survives short network blips — but the matching
 * algorithm and lobby browser only count entries with `expiresAt > now`.
 */
export interface CoopPresence {
  steamId: string;
  personaName: string;
  avatarUrl?: string;
  steamProfileUrl?: string;
  status: CoopPresenceStatus;
  note?: string;
  discordHandle?: string;
  ascensionMin?: number;
  ascensionMax?: number;
  goal?: CoopGoal;
  voicePreference?: VoicePreference;
  preferredCharacters?: CoopCharacter[];
  /** Active lobby (the one the user is hosting OR is a member of). */
  currentLobbyId?: string;
  /** Active session — set when paired. */
  currentSessionId?: string;
  /** Active party room — set after seat accept. */
  currentPartyId?: string;
  /**
   * True when the server automatically overrode the user's status (e.g.,
   * Steam offline → "afk", or entered STS2 while "looking" → "solo").
   * Cleared when the user explicitly sets their own status via upsert.
   */
  statusAutoSet?: boolean;
  lastHeartbeatAt: string;
  expiresAt: string;
  updatedAt: string;
}

/** Status a run lobby moves through. */
export type RunLobbyStatus =
  | "open"
  | "pending"
  | "full"
  | "expired"
  | "closed";

export const RUN_LOBBY_STATUSES: readonly RunLobbyStatus[] = [
  "open",
  "pending",
  "full",
  "expired",
  "closed",
];

/** STS2 co-op lobby capacity advertised by the host. */
export type RunLobbySize = 2 | 3 | 4;

export const RUN_LOBBY_SIZES: readonly RunLobbySize[] = [2, 3, 4];

export interface RunLobby {
  lobbyId: string;
  hostSteamId: string;
  hostPersonaName: string;
  hostAvatarUrl?: string;
  title: string;
  /** Run mode label (defaults to goal when omitted). */
  mode?: string;
  goal: CoopGoal;
  /** Seats including host. Default 4 for new lobbies; legacy rows omit → 2. */
  lobbySize?: RunLobbySize;
  ascensionMin?: number;
  ascensionMax?: number;
  voicePreference?: VoicePreference;
  /** When true, joiners use Request Seat; default false = open Join Seat. */
  approvalRequired?: boolean;
  voicePreset?: VoicePreset;
  voiceChannelUrl?: string;
  preferredCharacters?: CoopCharacter[];
  note?: string;
  discordHandle?: string;
  status: RunLobbyStatus;
  /** Accepted members (host is slot 1). */
  acceptedMemberSteamIds?: string[];
  /** Pending seat requests (Steam IDs). */
  pendingSeatRequestSteamIds?: string[];
  /** @deprecated Use acceptedMemberSteamIds — kept for KV backward compat. */
  memberSteamIds: string[];
  /** @deprecated Use pendingSeatRequestSteamIds. */
  pendingJoinRequestSteamIds: string[];
  /** Party minted after first accept, when applicable. */
  partyId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type CoopPartyMemberStatus =
  | "joined"
  | "ready"
  | "character_select"
  | "in_game"
  | "left";

export const COOP_PARTY_MEMBER_STATUSES: readonly CoopPartyMemberStatus[] = [
  "joined",
  "ready",
  "character_select",
  "in_game",
  "left",
];

export interface CoopPartyMember {
  steamId: string;
  personaName?: string;
  avatarUrl?: string;
  selectedCharacter?: CoopCharacter;
  status: CoopPartyMemberStatus;
  updatedAt: string;
  /**
   * ISO8601 stamped each time the member's status transitions TO `ready`.
   * Cleared (set to undefined) on any transition away from `ready`.
   *
   * Frontend ready-up runtime reads this to surface "Waiting on X"
   * copy (the member with the oldest non-`ready` updatedAt is the
   * one being waited on; the readyAt timestamps on the others let
   * the UI sort "ready 23s ago / 8s ago" if we ever want it).
   *
   * Added in v0.12.0. Old members written before this field existed
   * have it undefined — the frontend treats undefined as "not ready"
   * which matches the legacy semantics.
   */
  readyAt?: string;
}

export type CoopPartyStatus = "active" | "ended";

export interface CoopParty {
  partyId: string;
  lobbyId: string;
  hostSteamId: string;
  lobbySize: RunLobbySize;
  members: CoopPartyMember[];
  status: CoopPartyStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type CoopInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired";

export const COOP_INVITE_STATUSES: readonly CoopInviteStatus[] = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "expired",
];

/**
 * A direct (or lobby-scoped) invite. `lobbyId` is optional — a 1:1
 * invite that doesn't reference a lobby is a "let's just co-op" ping
 * that, on accept, mints a session anyway.
 */
export interface CoopInvite {
  inviteId: string;
  fromSteamId: string;
  toSteamId: string;
  lobbyId?: string;
  /** Preset message id from `COOP_INVITE_MESSAGES`. Sender controls only this. */
  messagePreset?: string;
  status: CoopInviteStatus;
  createdAt: string;
  expiresAt: string;
  /** Server-stamped denormalized identity so the recipient UI can render
   *  the card without needing a second roundtrip to the presence store. */
  fromPersonaName?: string;
  fromAvatarUrl?: string;
  toPersonaName?: string;
  toAvatarUrl?: string;
}

export type JoinRequestStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired";

export interface JoinRequest {
  requestId: string;
  lobbyId: string;
  fromSteamId: string;
  toHostSteamId: string;
  selectedCharacter?: CoopCharacter;
  status: JoinRequestStatus;
  createdAt: string;
  expiresAt: string;
  fromPersonaName?: string;
  fromAvatarUrl?: string;
}

export type CoopSessionStatus = "active" | "ended" | "expired";

export interface CoopSession {
  sessionId: string;
  playerSteamIds: string[];
  lobbyId?: string;
  status: CoopSessionStatus;
  createdAt: string;
  endedAt?: string;
  expiresAt: string;
}

/**
 * Friendly match label, derived from a numeric score. The numeric score
 * never leaves the server — clients render `label` directly.
 */
export type MatchLabel =
  | "Strong match"
  | "Good match"
  | "Different goal"
  | "Recently active";

export interface RecommendedMatch {
  steamId: string;
  personaName: string;
  avatarUrl?: string;
  status: CoopPresenceStatus;
  ascensionMin?: number;
  ascensionMax?: number;
  goal?: CoopGoal;
  voicePreference?: VoicePreference;
  preferredCharacters?: CoopCharacter[];
  note?: string;
  lastHeartbeatAt: string;
  label: MatchLabel;
  hasDiscord: boolean;
}

/**
 * Bundled response for `GET /coop/state`. One round-trip per poll keeps
 * the co-op tab snappy and rate-limit-friendly under high user counts.
 *
 * `activePlayerFeed` and `openLobbies` are payload-capped at the server
 * so the wire size stays bounded even when 8k users are online. The
 * `*TotalCount` / `playersOnlineCount` / `lookingNowCount` fields
 * carry the true totals so the lobby bar still reads accurately, and
 * the renderer can show "Showing 200 of 4,500" when the cap kicks in.
 */
export interface CoopStateBundle {
  presence: CoopPresence;
  session: CoopSession | null;
  party: CoopParty | null;
  lobby: RunLobby | null;
  incomingInvites: CoopInvite[];
  outgoingInvites: CoopInvite[];
  incomingJoinRequests: JoinRequest[];
  outgoingJoinRequests: JoinRequest[];
  openLobbies: RunLobby[];
  /** Total count of OPEN lobbies before the payload cap was applied. */
  openLobbiesTotalCount?: number;
  recommendedMatches: RecommendedMatch[];
  activePlayerFeed: CoopPresenceFeedRow[];
  /** Live presence rows (active, not hidden as stale) — true total. */
  playersOnlineCount?: number;
  /** Active rows whose status === "looking" — true total. */
  lookingNowCount?: number;
  /** Active rows currently paired — true total. */
  pairedNowCount?: number;
  serverTime: string;
  /**
   * Optional feature flags echoed by the server. The web client reads
   * `flags.coopLobbyBetaKill` / `flags.coopLobbyBeta` to support a
   * server-side rollback of the new lobby surface without a deploy:
   * setting `COOP_LOBBY_BETA_KILL=1` in the Worker env emits
   * `coopLobbyBetaKill: true` here, and the client downgrades to
   * Classic on the next render. See coop-lobby-product-reset.md.
   */
  flags?: {
    coopLobbyBeta?: boolean;
    coopLobbyBetaKill?: boolean;
  };
}

/**
 * Slim row used in "active player feed". Identity-rich (auth-gated)
 * but smaller than `CoopPresence` so the wire payload stays bounded
 * even with hundreds of online users.
 */
export interface CoopPresenceFeedRow {
  steamId: string;
  personaName: string;
  avatarUrl?: string;
  status: CoopPresenceStatus;
  goal?: CoopGoal;
  ascensionMin?: number;
  ascensionMax?: number;
  voicePreference?: VoicePreference;
  note?: string;
  discordHandle?: string;
  currentLobbyId?: string;
  currentSessionId?: string;
  lastHeartbeatAt: string;
  /** Whether the row is currently fresh (true) or stale (false). */
  isActive: boolean;
}

/**
 * Closed set of allowed invite preset messages. Sender controls only
 * the id; the client renders the human text by mapping the id. We
 * deliberately do *not* let arbitrary text through — that's the whole
 * point of keeping invites un-harassable.
 */
// Ascension references match Slay the Spire 2 (max A10). The preset
// ids stay backwards-compatible; only the rendered text changed.
export const COOP_INVITE_MESSAGES: Readonly<Record<string, string>> =
  Object.freeze({
    coop_any: "Want to co-op? Any ascension.",
    coop_low: "Want to co-op? Casual / low ascension.",
    coop_high: "Want to co-op? High Ascension (A8–A10).",
    coop_a20: "Want to co-op? High Ascension (A10).",
    coop_voice: "Want to co-op with voice chat?",
    coop_quick: "One quick run? ~30 min.",
    coop_daily: "Want to co-op the daily?",
    coop_teach: "Want to co-op? Happy to teach.",
    coop_learn: "Want to co-op? Still learning.",
  });

export type CoopInviteMessageId = keyof typeof COOP_INVITE_MESSAGES;
