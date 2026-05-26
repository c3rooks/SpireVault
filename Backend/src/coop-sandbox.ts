import type { Env } from "./types";
import {
  COOP_LOBBY_TTL_S,
  COOP_PARTY_TTL_S,
  COOP_JOIN_REQUEST_TTL_S,
  newRandomId,
  writePresence,
  writeLobby,
  writeJoinRequest,
  writeLobbyJoinIds,
  writeUserJoinIds,
  writeParty,
  listPresence,
  listLobbies,
} from "./coop-store";
import type {
  CoopGoal,
  CoopParty,
  CoopPartyMember,
  CoopPresence,
  CoopPresenceStatus,
  JoinRequest,
  RunLobby,
  RunLobbySize,
  VoicePreference,
  VoicePreset,
} from "./coop-types";
import { normalizeRunLobby } from "./coop-lobby-utils";

/**
 * Local-only co-op sandbox for Co-op Lobby Beta QA.
 *
 * All seeded entities use `local-*` Steam IDs and are tracked in
 * `sandbox:coop:registry` so reset can wipe preview KV without touching
 * production (routes are gated by LOCAL_DEBUG / DEV_COOP_SANDBOX).
 */

const REGISTRY_KEY = "sandbox:coop:registry";
const META_KEY = "sandbox:coop:meta";

export type SandboxScenario = "A" | "B" | "C" | "D" | "E" | "F" | "G";

export interface SandboxPersona {
  steamId: string;
  name: string;
  status: CoopPresenceStatus;
  goal?: CoopGoal;
  ascensionMin?: number;
  ascensionMax?: number;
  voicePreference?: VoicePreference;
  avatarUrl?: string;
}

export const SANDBOX_PERSONAS: readonly SandboxPersona[] = [
  {
    steamId: "local-corey",
    name: "c3rooks",
    status: "looking",
    goal: "any",
    ascensionMin: 0,
    ascensionMax: 10,
  },
  {
    steamId: "local-boble",
    name: "Boble",
    status: "looking",
    goal: "heart",
    ascensionMin: 8,
    ascensionMax: 10,
    voicePreference: "optional",
  },
  {
    steamId: "local-mako",
    name: "Mako",
    status: "looking",
    goal: "casual",
    ascensionMin: 0,
    ascensionMax: 3,
    voicePreference: "optional",
  },
  {
    steamId: "local-mega",
    name: "Mega",
    status: "afk",
    goal: "casual",
    ascensionMin: 0,
    ascensionMax: 3,
  },
  {
    steamId: "local-iamweird",
    name: "IAmWeird",
    status: "looking",
    goal: "any",
    ascensionMin: 0,
    ascensionMax: 10,
    voicePreference: "optional",
  },
] as const;

interface SandboxRegistry {
  keys: string[];
  personaIds: string[];
  scenario?: SandboxScenario;
  updatedAt: string;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

export function isCoopSandboxAllowed(env: Env, req: Request): boolean {
  const debugOn =
    env.LOCAL_DEBUG === "1" ||
    env.DEV_COOP_SANDBOX === "1" ||
    env.DEV_COOP_SANDBOX === "true";
  if (!debugOn) return false;

  const host = new URL(req.url).hostname;
  const prodHosts = new Set([
    "spirevault.app",
    "app.spirevault.app",
    "vault-coop.coreycrooks.workers.dev",
  ]);
  if (prodHosts.has(host)) return false;

  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost")
  );
}

function personaById(steamId: string): SandboxPersona | undefined {
  return SANDBOX_PERSONAS.find((p) => p.steamId === steamId);
}

function personaByName(name: string): SandboxPersona | undefined {
  const n = name.trim().toLowerCase();
  return SANDBOX_PERSONAS.find(
    (p) => p.name.toLowerCase() === n || p.steamId === name,
  );
}

async function readRegistry(env: Env): Promise<SandboxRegistry> {
  const raw = await env.LOBBIES.get(REGISTRY_KEY);
  if (!raw) {
    return { keys: [], personaIds: [], updatedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(raw) as SandboxRegistry;
    return {
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      personaIds: Array.isArray(parsed.personaIds) ? parsed.personaIds : [],
      scenario: parsed.scenario,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return { keys: [], personaIds: [], updatedAt: new Date().toISOString() };
  }
}

async function writeRegistry(env: Env, reg: SandboxRegistry): Promise<void> {
  reg.updatedAt = new Date().toISOString();
  await env.LOBBIES.put(REGISTRY_KEY, JSON.stringify(reg), {
    expirationTtl: 7 * 86400,
  });
}

async function trackKey(env: Env, key: string): Promise<void> {
  const reg = await readRegistry(env);
  if (!reg.keys.includes(key)) reg.keys.push(key);
  await writeRegistry(env, reg);
}

async function trackPersona(env: Env, steamId: string): Promise<void> {
  const reg = await readRegistry(env);
  if (!reg.personaIds.includes(steamId)) reg.personaIds.push(steamId);
  await writeRegistry(env, reg);
}

async function ensureProfile(env: Env, persona: SandboxPersona): Promise<void> {
  const key = `session-profile:${persona.steamId}`;
  await env.LOBBIES.put(
    key,
    JSON.stringify({
      personaName: persona.name,
      avatarURL: persona.avatarUrl ?? "",
    }),
    { expirationTtl: 7 * 86400 },
  );
  await trackKey(env, key);
}

function nowIso(): string {
  return new Date().toISOString();
}

function freshPresence(persona: SandboxPersona, patch: Partial<CoopPresence> = {}): CoopPresence {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  return {
    steamId: persona.steamId,
    personaName: persona.name,
    avatarUrl: persona.avatarUrl ?? "/assets/vault-mark.svg",
    steamProfileUrl: `https://steamcommunity.com/id/${persona.steamId}`,
    status: patch.status ?? persona.status,
    goal: patch.goal ?? persona.goal,
    ascensionMin: patch.ascensionMin ?? persona.ascensionMin,
    ascensionMax: patch.ascensionMax ?? persona.ascensionMax,
    voicePreference: patch.voicePreference ?? persona.voicePreference,
    currentLobbyId: patch.currentLobbyId,
    currentSessionId: patch.currentSessionId,
    currentPartyId: patch.currentPartyId,
    lastHeartbeatAt: iso,
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    updatedAt: iso,
    ...patch,
  };
}

async function seedPresence(
  env: Env,
  persona: SandboxPersona,
  patch: Partial<CoopPresence> = {},
): Promise<CoopPresence> {
  await ensureProfile(env, persona);
  const row = freshPresence(persona, patch);
  await writePresence(env, row);
  await trackKey(env, `coop:presence:${persona.steamId}`);
  await trackPersona(env, persona.steamId);
  return row;
}

async function seedLobby(
  env: Env,
  opts: {
    host: SandboxPersona;
    title: string;
    mode?: string;
    goal: CoopGoal;
    lobbySize?: RunLobbySize;
    ascensionMin?: number;
    ascensionMax?: number;
    voicePreference?: VoicePreference;
    approvalRequired?: boolean;
    voicePreset?: VoicePreset;
    voiceChannelUrl?: string;
    preferredCharacters?: RunLobby["preferredCharacters"];
    note?: string;
    acceptedMemberSteamIds: string[];
    pendingSeatRequestSteamIds?: string[];
    status?: RunLobby["status"];
    partyId?: string;
  },
): Promise<RunLobby> {
  const now = Date.now();
  const iso = nowIso();
  const host = opts.host;
  const lobby: RunLobby = normalizeRunLobby({
    lobbyId: newRandomId(),
    hostSteamId: host.steamId,
    hostPersonaName: host.name,
    hostAvatarUrl: host.avatarUrl ?? "/assets/vault-mark.svg",
    title: opts.title,
    mode: opts.mode ?? opts.goal,
    goal: opts.goal,
    lobbySize: opts.lobbySize ?? 4,
    ascensionMin: opts.ascensionMin,
    ascensionMax: opts.ascensionMax,
    voicePreference: opts.voicePreference,
    approvalRequired: opts.approvalRequired === true,
    voicePreset: opts.voicePreset ?? "any",
    voiceChannelUrl: opts.voiceChannelUrl,
    preferredCharacters: opts.preferredCharacters,
    note: opts.note,
    status: opts.status ?? "open",
    acceptedMemberSteamIds: opts.acceptedMemberSteamIds,
    pendingSeatRequestSteamIds: opts.pendingSeatRequestSteamIds ?? [],
    memberSteamIds: opts.acceptedMemberSteamIds,
    pendingJoinRequestSteamIds: opts.pendingSeatRequestSteamIds ?? [],
    partyId: opts.partyId,
    createdAt: iso,
    updatedAt: iso,
    expiresAt: new Date(now + COOP_LOBBY_TTL_S * 1000).toISOString(),
  });

  await writeLobby(env, lobby);
  await trackKey(env, `coop:lobby:${lobby.lobbyId}`);
  await trackKey(env, `coop:lobby:by-host:${host.steamId}`);

  for (const sid of opts.acceptedMemberSteamIds) {
    const p = personaById(sid) ?? host;
    await seedPresence(env, p, {
      currentLobbyId: lobby.lobbyId,
      status: sid === host.steamId ? "looking" : "looking",
      currentPartyId: opts.partyId,
    });
  }
  return lobby;
}

async function seedJoinRequest(
  env: Env,
  lobby: RunLobby,
  from: SandboxPersona,
  selectedCharacter?: JoinRequest["selectedCharacter"],
): Promise<JoinRequest> {
  const now = Date.now();
  const req: JoinRequest = {
    requestId: newRandomId(),
    lobbyId: lobby.lobbyId,
    fromSteamId: from.steamId,
    toHostSteamId: lobby.hostSteamId,
    selectedCharacter,
    status: "pending",
    createdAt: nowIso(),
    expiresAt: new Date(now + COOP_JOIN_REQUEST_TTL_S * 1000).toISOString(),
    fromPersonaName: from.name,
    fromAvatarUrl: from.avatarUrl ?? "/assets/vault-mark.svg",
  };
  await writeJoinRequest(env, req);
  await writeLobbyJoinIds(env, lobby.lobbyId, [req.requestId]);
  await writeUserJoinIds(env, from.steamId, [req.requestId]);
  await trackKey(env, `coop:join:${req.requestId}`);
  await trackKey(env, `coop:lobby-joins:${lobby.lobbyId}`);
  await trackKey(env, `coop:user-joins:${from.steamId}`);

  lobby.pendingSeatRequestSteamIds = [
    ...(lobby.pendingSeatRequestSteamIds ?? []),
    from.steamId,
  ];
  lobby.pendingJoinRequestSteamIds = lobby.pendingSeatRequestSteamIds;
  lobby.updatedAt = nowIso();
  await writeLobby(env, lobby);

  await seedPresence(env, from, { currentLobbyId: undefined });
  return req;
}

async function seedParty(
  env: Env,
  lobby: RunLobby,
  members: Array<{
    persona: SandboxPersona;
    status?: CoopPartyMember["status"];
    selectedCharacter?: CoopPartyMember["selectedCharacter"];
  }>,
): Promise<CoopParty> {
  const now = Date.now();
  const iso = nowIso();
  const party: CoopParty = {
    partyId: newRandomId(),
    lobbyId: lobby.lobbyId,
    hostSteamId: lobby.hostSteamId,
    lobbySize: (lobby.lobbySize ?? 4) as RunLobbySize,
    members: members.map(({ persona, status, selectedCharacter }) => ({
      steamId: persona.steamId,
      personaName: persona.name,
      avatarUrl: persona.avatarUrl ?? "/assets/vault-mark.svg",
      selectedCharacter,
      status: status ?? "joined",
      updatedAt: iso,
    })),
    status: "active",
    createdAt: iso,
    updatedAt: iso,
    expiresAt: new Date(now + COOP_PARTY_TTL_S * 1000).toISOString(),
  };
  await writeParty(env, party);
  await trackKey(env, `coop:party:${party.partyId}`);
  for (const m of members) {
    await trackKey(env, `coop:party-by-user:${m.persona.steamId}`);
    await seedPresence(env, m.persona, {
      currentLobbyId: lobby.lobbyId,
      currentPartyId: party.partyId,
      status: m.status === "in_game" ? "solo" : "looking",
    });
  }
  await trackKey(env, `coop:party-by-lobby:${lobby.lobbyId}`);

  lobby.partyId = party.partyId;
  lobby.updatedAt = iso;
  await writeLobby(env, lobby);
  return party;
}

export async function resetCoopSandbox(env: Env): Promise<{ deleted: number }> {
  const reg = await readRegistry(env);
  const keys = [
    ...reg.keys,
    REGISTRY_KEY,
    META_KEY,
    "coop:presence:index",
    "coop:lobby:index",
  ];
  await Promise.allSettled(keys.map((k) => env.LOBBIES.delete(k)));
  await writeRegistry(env, { keys: [], personaIds: [], updatedAt: nowIso() });
  return { deleted: keys.length };
}

function resolveHostPersona(
  body: { hostSteamId?: string; persona?: string } | null,
): SandboxPersona {
  if (body?.hostSteamId) {
    const p = personaById(body.hostSteamId);
    if (p) return p;
  }
  if (body?.persona) {
    const p = personaByName(body.persona);
    if (p) return p;
  }
  return SANDBOX_PERSONAS[0]!;
}

export async function seedCoopSandboxScenario(
  env: Env,
  scenario: SandboxScenario,
  body: { hostSteamId?: string; persona?: string } | null,
): Promise<{ scenario: SandboxScenario; hostSteamId: string }> {
  await resetCoopSandbox(env);
  const reg = await readRegistry(env);
  reg.scenario = scenario;
  await writeRegistry(env, reg);

  const hostPersona = resolveHostPersona(body);

  switch (scenario) {
    case "A": {
      await seedPresence(env, hostPersona, { status: "looking" });
      break;
    }
    case "B": {
      const mako = personaById("local-mako")!;
      const boble = personaById("local-boble")!;
      const mega = personaById("local-mega")!;
      const weird = personaById("local-iamweird")!;
      await seedPresence(env, personaById("local-corey")!);
      await seedLobby(env, {
        host: mako,
        title: "Standard · A10 Heart Attempt",
        mode: "standard",
        goal: "heart",
        lobbySize: 4,
        ascensionMin: 8,
        ascensionMax: 10,
        voicePreference: "optional",
        voicePreset: "lfg1",
        approvalRequired: false,
        preferredCharacters: ["defect"],
        note: "Trying to get a clean Heart run.",
        acceptedMemberSteamIds: [mako.steamId],
      });
      await seedLobby(env, {
        host: boble,
        title: "Daily · Score Push",
        mode: "daily",
        goal: "daily",
        lobbySize: 4,
        ascensionMin: 0,
        ascensionMax: 10,
        voicePreference: "no",
        preferredCharacters: ["silent"],
        note: "Daily run, chill pace.",
        acceptedMemberSteamIds: [boble.steamId, weird.steamId],
      });
      await seedLobby(env, {
        host: mega,
        title: "Custom · Casual Run",
        mode: "custom",
        goal: "casual",
        lobbySize: 3,
        ascensionMin: 0,
        ascensionMax: 3,
        voicePreference: "optional",
        preferredCharacters: ["necrobinder"],
        note: "Testing weird modifiers.",
        acceptedMemberSteamIds: [mega.steamId],
      });
      await seedPresence(env, hostPersona);
      break;
    }
    case "C": {
      await seedLobby(env, {
        host: hostPersona,
        title: "test",
        mode: "standard",
        goal: "any",
        lobbySize: 4,
        acceptedMemberSteamIds: [hostPersona.steamId],
      });
      break;
    }
    case "D": {
      const lobby = await seedLobby(env, {
        host: hostPersona,
        title: "test",
        mode: "standard",
        goal: "any",
        lobbySize: 4,
        acceptedMemberSteamIds: [hostPersona.steamId],
      });
      await seedJoinRequest(env, lobby, personaById("local-boble")!, "silent");
      break;
    }
    case "E": {
      const boble = personaById("local-boble")!;
      const lobby = await seedLobby(env, {
        host: hostPersona,
        title: "test",
        mode: "standard",
        goal: "any",
        lobbySize: 4,
        acceptedMemberSteamIds: [hostPersona.steamId, boble.steamId],
        status: "open",
      });
      await seedParty(env, lobby, [
        { persona: hostPersona, selectedCharacter: "ironclad" },
        { persona: boble, selectedCharacter: "silent" },
      ]);
      break;
    }
    case "F": {
      const members = [
        hostPersona,
        personaById("local-boble")!,
        personaById("local-mako")!,
        personaById("local-iamweird")!,
      ];
      await seedLobby(env, {
        host: hostPersona,
        title: "test · Full",
        mode: "standard",
        goal: "any",
        lobbySize: 4,
        acceptedMemberSteamIds: members.map((m) => m.steamId),
        status: "full",
      });
      break;
    }
    case "G": {
      const boble = personaById("local-boble")!;
      const lobby = await seedLobby(env, {
        host: hostPersona,
        title: "test · In Run",
        mode: "standard",
        goal: "any",
        lobbySize: 4,
        acceptedMemberSteamIds: [hostPersona.steamId, boble.steamId],
        status: "open",
      });
      await seedParty(env, lobby, [
        { persona: hostPersona, status: "in_game", selectedCharacter: "ironclad" },
        { persona: boble, status: "in_game", selectedCharacter: "silent" },
      ]);
      break;
    }
    default:
      break;
  }

  await env.LOBBIES.put(
    META_KEY,
    JSON.stringify({ scenario, hostSteamId: hostPersona.steamId, seededAt: nowIso() }),
    { expirationTtl: 7 * 86400 },
  );

  return { scenario, hostSteamId: hostPersona.steamId };
}

export async function mintSandboxSession(
  env: Env,
  steamId: string,
): Promise<{ token: string; steamID: string } | Response> {
  const persona = personaById(steamId) ?? personaByName(steamId);
  if (!persona) {
    return json({ ok: false, error: "unknown_persona", message: "Unknown sandbox persona." }, { status: 400 });
  }
  await ensureProfile(env, persona);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await env.LOBBIES.put(`session:${token}`, persona.steamId, {
    expirationTtl: 60 * 60 * 24,
  });
  await trackKey(env, `session:${token}`);
  await seedPresence(env, persona);
  return { token, steamID: persona.steamId };
}

export async function getSandboxStateCounts(env: Env): Promise<Record<string, number | string>> {
  const reg = await readRegistry(env);
  const allPresence = await listPresence(env);
  const sandboxPresence = allPresence.filter((p) => p.steamId.startsWith("local-"));
  const allLobbies = await listLobbies(env);
  const sandboxLobbies = allLobbies.filter((l) => l.hostSteamId.startsWith("local-"));
  const openSandbox = sandboxLobbies.filter((l) => l.status === "open");

  return {
    scenario: reg.scenario ?? "",
    sandboxPersonas: reg.personaIds.length,
    allLobbiesCount: allLobbies.length,
    openLobbiesCount: allLobbies.filter((l) => l.status === "open").length,
    sandboxOpenLobbiesCount: openSandbox.length,
    sandboxLobbiesCount: sandboxLobbies.length,
    playersLookingCount: sandboxPresence.filter((p) => p.status === "looking").length,
    activePlayersCount: sandboxPresence.length,
    registryKeys: reg.keys.length,
  };
}

export async function handleCoopSandboxRoute(
  req: Request,
  env: Env,
  pathname: string,
  method: string,
): Promise<Response | null> {
  if (!pathname.startsWith("/_debug/coop-sandbox")) return null;
  if (!isCoopSandboxAllowed(env, req)) {
    return new Response("Not Found", { status: 404 });
  }

  if (method === "GET" && pathname === "/_debug/coop-sandbox/state") {
    const counts = await getSandboxStateCounts(env);
    return json({
      ok: true,
      personas: SANDBOX_PERSONAS.map((p) => ({
        steamId: p.steamId,
        name: p.name,
      })),
      ...counts,
    });
  }

  if (method === "POST" && pathname === "/_debug/coop-sandbox/reset") {
    const result = await resetCoopSandbox(env);
    return json({ ok: true, ...result });
  }

  if (method === "POST" && pathname === "/_debug/coop-sandbox/seed") {
    const body = await req.json().catch(() => null) as
      | { scenario?: string; hostSteamId?: string; persona?: string }
      | null;
    const scenario = (body?.scenario ?? "A").toUpperCase() as SandboxScenario;
    if (!["A", "B", "C", "D", "E", "F", "G"].includes(scenario)) {
      return json({ ok: false, error: "invalid_scenario" }, { status: 400 });
    }
    const result = await seedCoopSandboxScenario(env, scenario, body);
    return json({ ok: true, ...result });
  }

  if (method === "POST" && pathname === "/_debug/coop-sandbox/act-as") {
    const body = await req.json().catch(() => null) as
      | { steamId?: string; persona?: string }
      | null;
    const id = body?.steamId ?? body?.persona ?? "local-corey";
    const minted = await mintSandboxSession(env, id);
    if (minted instanceof Response) return minted;
    return json({
      ok: true,
      token: minted.token,
      steamID: minted.steamID,
      personaName: personaById(minted.steamID)?.name ?? minted.steamID,
    });
  }

  return new Response("Not Found", { status: 404 });
}
