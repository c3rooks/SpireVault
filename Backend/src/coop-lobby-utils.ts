import type { RunLobby, RunLobbySize } from "./coop-types";
import { RUN_LOBBY_SIZES } from "./coop-types";

/** STS2 ascension cap for co-op matchmaking. */
export const COOP_MAX_ASCENSION = 10;

export function isValidLobbySize(n: unknown): n is RunLobbySize {
  return typeof n === "number" && (RUN_LOBBY_SIZES as readonly number[]).includes(n);
}

/**
 * Normalize legacy KV rows so handlers always see slot fields.
 * Host is always slot 1 in `acceptedMemberSteamIds`.
 */
export function normalizeRunLobby(lobby: RunLobby): RunLobby {
  const accepted =
    lobby.acceptedMemberSteamIds ??
    lobby.memberSteamIds ??
    [lobby.hostSteamId];
  const pending =
    lobby.pendingSeatRequestSteamIds ??
    lobby.pendingJoinRequestSteamIds ??
    [];
  const lobbySize: RunLobbySize =
    lobby.lobbySize === 2 || lobby.lobbySize === 3 || lobby.lobbySize === 4
      ? lobby.lobbySize
      : 2;

  return {
    ...lobby,
    lobbySize,
    acceptedMemberSteamIds: accepted,
    pendingSeatRequestSteamIds: pending,
    memberSteamIds: accepted,
    pendingJoinRequestSteamIds: pending,
  };
}

export function lobbyCapacity(lobby: RunLobby): number {
  return normalizeRunLobby(lobby).lobbySize ?? 2;
}

export function lobbyOpenSeats(lobby: RunLobby): number {
  const cap = lobbyCapacity(lobby);
  const filled = (normalizeRunLobby(lobby).acceptedMemberSteamIds ?? []).length;
  return Math.max(0, cap - filled);
}

export function lobbyIsFull(lobby: RunLobby): boolean {
  return lobbyOpenSeats(lobby) <= 0;
}
