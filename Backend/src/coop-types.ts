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
  preferredCharacters?: string[];
  /** Active lobby (the one the user is hosting OR is a member of). */
  currentLobbyId?: string;
  /** Active session — set when paired. */
  currentSessionId?: string;
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

export interface RunLobby {
  lobbyId: string;
  hostSteamId: string;
  hostPersonaName: string;
  hostAvatarUrl?: string;
  title: string;
  goal: CoopGoal;
  ascensionMin?: number;
  ascensionMax?: number;
  voicePreference?: VoicePreference;
  preferredCharacters?: string[];
  note?: string;
  discordHandle?: string;
  status: RunLobbyStatus;
  memberSteamIds: string[];
  pendingJoinRequestSteamIds: string[];
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
  note?: string;
  lastHeartbeatAt: string;
  label: MatchLabel;
  hasDiscord: boolean;
}

/**
 * Bundled response for `GET /coop/state`. One round-trip per poll keeps
 * the co-op tab snappy and rate-limit-friendly under high user counts.
 */
export interface CoopStateBundle {
  presence: CoopPresence;
  session: CoopSession | null;
  lobby: RunLobby | null;
  incomingInvites: CoopInvite[];
  outgoingInvites: CoopInvite[];
  incomingJoinRequests: JoinRequest[];
  outgoingJoinRequests: JoinRequest[];
  openLobbies: RunLobby[];
  recommendedMatches: RecommendedMatch[];
  activePlayerFeed: CoopPresenceFeedRow[];
  serverTime: string;
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
