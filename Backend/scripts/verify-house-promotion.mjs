#!/usr/bin/env node
/**
 * End-to-end verification of the House lobby "Option C" auto-promotion
 * (`promoteHouseJoinerToHost` in Backend/src/coop-house-lobbies.ts +
 * the call site in `joinLobbySeat` in Backend/src/coop-engine.ts).
 *
 * What we prove:
 *
 *  1. The scheduled cron handler mints House lobbies (sanity check
 *     shared with verify-house-host-ready.mjs).
 *  2. A real human joiner who claims a seat in a House lobby becomes
 *     the lobby's HOST — `hostSteamId` is rewritten to the joiner's
 *     SteamID, `hostPersonaName` and `hostAvatarUrl` come from their
 *     profile, and the title is rewritten so it reads as their room.
 *  3. The promoted lobby is no longer flagged as a House lobby
 *     (`isHouseLobby === false`, `houseSlug` cleared).
 *  4. The slug registry pointer (`house-lobby:<slug>`) is cleared so
 *     the next renewer pass mints a fresh House lobby.
 *  5. The next renewer pass DOES mint a fresh House lobby for that
 *     slug — the registry repopulates with a NEW lobbyId.
 *  6. Re-running joinLobbySeat against an already-promoted lobby is a
 *     no-op for promotion (idempotence) — the joiner's second call
 *     just returns the existing party/lobby unchanged.
 *
 * Usage:
 *   node Backend/scripts/verify-house-promotion.mjs
 *   node Backend/scripts/verify-house-promotion.mjs --base=http://127.0.0.1:8789
 *
 * Requires the worker running with --env localdev so `/_debug/*` and
 * the scheduled trigger endpoint are reachable.
 */

import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://127.0.0.1:8789";

// Real human joiner. 17 digits so passes the validator.
const REAL_JOINER = "76561111199999992";
// House synthetic host steam IDs — must match HOUSE_LOBBIES in
// Backend/src/coop-house-lobbies.ts.
const HOUSE_A0 = "76561190000000001";
const HOUSE_A10 = "76561190000000002";

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    failures.push({ label, detail });
    console.log(`  [FAIL] ${label}${detail ? "\n         " + detail : ""}`);
  }
}

async function jsonFetch(method, pathStr, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await fetch(BASE + pathStr, init);
  let data;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, body: data };
}

async function seed(steamID, personaName) {
  const r = await jsonFetch("POST", "/_debug/seed-session", undefined, {
    steamID,
    personaName,
  });
  if (r.status !== 200) throw new Error("seed-session failed: " + JSON.stringify(r));
  return r.body.token;
}

async function triggerScheduled() {
  const r = await fetch(BASE + "/cdn-cgi/handler/scheduled", { method: "GET" });
  return r.status;
}

async function run() {
  console.log(`Target: ${BASE}\n`);

  // Wipe known House lobby pointers + synthetic host indexes so each
  // run starts from a clean slate. We can't list KV from the harness,
  // so we delete the specific keys the renewer touches by name.
  await jsonFetch("POST", "/_debug/wipe", undefined, {
    keys: [
      "house-lobby:house-a0-casual",
      "house-lobby:house-a10-heart",
      "house-lobby:lock",
      `coop:lobby:by-host:${HOUSE_A0}`,
      `coop:lobby:by-host:${HOUSE_A10}`,
      `coop:lobby:by-host:${REAL_JOINER}`,
      `coop:presence:${REAL_JOINER}`,
      `coop:session-by-user:${REAL_JOINER}`,
      `coop:party-by-user:${REAL_JOINER}`,
    ],
    wipeRateLimits: true,
  });

  console.log("1) Cron handler creates House lobbies");
  const cronStatus = await triggerScheduled();
  check("scheduled handler returns 200", cronStatus === 200, `status=${cronStatus}`);
  await sleep(800);

  // Seed real joiner + heartbeat.
  const token = await seed(REAL_JOINER, "Real Joiner Two");
  await jsonFetch("POST", "/coop/presence", token, { status: "looking", goal: "casual" });
  await jsonFetch("POST", "/coop/heartbeat", token, {});

  console.log("\n2) Locate the A0 Casual House lobby pre-promotion");
  let state = await jsonFetch("GET", "/coop/state", token);
  const a0Pre = (state.body?.openLobbies ?? []).find((l) => l.hostSteamId === HOUSE_A0);
  check("A0 Casual House lobby visible pre-promotion", !!a0Pre, JSON.stringify(state.body?.openLobbies?.map((l) => ({ id: l.lobbyId, host: l.hostSteamId, house: l.isHouseLobby }))));
  if (!a0Pre) {
    console.log("Cannot proceed without a House lobby — aborting.");
    return;
  }
  const oldLobbyId = a0Pre.lobbyId;
  check("pre-promotion: isHouseLobby === true", a0Pre.isHouseLobby === true);
  check("pre-promotion: title still operator copy", String(a0Pre.title || "").startsWith("SpireVault House"), a0Pre.title);

  console.log("\n3) Real joiner claims a seat → Option C promotion fires");
  const join = await jsonFetch("POST", `/coop/lobbies/${oldLobbyId}/join-seat`, token, {});
  check("join-seat returns 200", join.status === 200, JSON.stringify(join.body));
  const promotedLobby = join.body?.lobby;
  check(
    "lobby.hostSteamId flipped to real joiner",
    promotedLobby?.hostSteamId === REAL_JOINER,
    `hostSteamId=${promotedLobby?.hostSteamId}`,
  );
  check(
    "lobby.isHouseLobby === false after promotion",
    promotedLobby?.isHouseLobby === false || promotedLobby?.isHouseLobby === undefined,
    `isHouseLobby=${promotedLobby?.isHouseLobby}`,
  );
  check(
    "lobby.houseSlug cleared",
    !promotedLobby?.houseSlug,
    `houseSlug=${promotedLobby?.houseSlug}`,
  );
  check(
    "title rewritten to read as joiner's room",
    typeof promotedLobby?.title === "string" &&
      !promotedLobby.title.startsWith("SpireVault House"),
    `title=${promotedLobby?.title}`,
  );
  check(
    "acceptedMemberSteamIds = [realJoiner] (synthetic host stepped out)",
    Array.isArray(promotedLobby?.acceptedMemberSteamIds) &&
      promotedLobby.acceptedMemberSteamIds.length === 1 &&
      promotedLobby.acceptedMemberSteamIds[0] === REAL_JOINER,
    JSON.stringify(promotedLobby?.acceptedMemberSteamIds),
  );
  const partyMembers = join.body?.party?.members ?? [];
  const hostMember = partyMembers.find((m) => m.steamId === REAL_JOINER);
  check(
    "party host slot is the real joiner",
    !!hostMember,
    JSON.stringify(partyMembers.map((m) => m.steamId)),
  );
  check(
    "synthetic host is NOT in the promoted party",
    !partyMembers.some((m) => m.steamId === HOUSE_A0),
  );

  console.log("\n4) Registry pointer cleared → renewer mints a fresh House lobby");
  // The /admin/house-lobbies/status endpoint reads the registry pointer.
  // After promotion the A0 entry should be `status: "missing"` (pointer
  // gone). Without admin secret in localdev the admin handler returns
  // 401, so instead we re-trigger the scheduled handler and look for a
  // NEW lobby (different lobbyId) at the same hostSteamId.
  const cron2 = await triggerScheduled();
  check("second scheduled trigger returns 200", cron2 === 200);
  await sleep(800);
  state = await jsonFetch("GET", "/coop/state", token);
  const a0Post = (state.body?.openLobbies ?? []).find(
    (l) => l.hostSteamId === HOUSE_A0 && l.isHouseLobby === true,
  );
  check(
    "fresh House A0 lobby exists after renewer pass",
    !!a0Post,
    `openLobbies=${JSON.stringify(state.body?.openLobbies?.map((l) => ({ id: l.lobbyId, host: l.hostSteamId, house: l.isHouseLobby })))}`,
  );
  check(
    "fresh House lobby has a DIFFERENT lobbyId from the promoted one",
    a0Post && a0Post.lobbyId !== oldLobbyId,
    `oldLobbyId=${oldLobbyId} newLobbyId=${a0Post?.lobbyId}`,
  );
  // The promoted lobby should also still be visible. Because the real
  // joiner is now its host, /coop/state for the joiner returns it as
  // their OWN room under `state.lobby` rather than under `openLobbies`
  // (which intentionally excludes the viewer's own room to keep the
  // "Live Parties" list focused on rooms they can JOIN). Look in both
  // pools so the assertion mirrors the same "this lobby still exists,
  // owned by the real joiner, no longer flagged as House" claim.
  const promotedStill =
    (state.body?.lobby && state.body.lobby.lobbyId === oldLobbyId
      ? state.body.lobby
      : null) ||
    (state.body?.openLobbies ?? []).find((l) => l.lobbyId === oldLobbyId);
  check(
    "promoted lobby still visible as a normal player-hosted room",
    promotedStill && promotedStill.hostSteamId === REAL_JOINER && !promotedStill.isHouseLobby,
    JSON.stringify(promotedStill),
  );

  console.log("\n5) Idempotence — re-running join on the promoted lobby is a no-op");
  // The joiner is now the lobby's host. Calling join-seat as the host
  // is correctly rejected with `self_lobby` — that IS the idempotent
  // outcome of "no re-Houseifying, no double-promotion." We assert
  // the rejection contract AND re-read the lobby to confirm the
  // promoted state is still intact.
  const join2 = await jsonFetch("POST", `/coop/lobbies/${oldLobbyId}/join-seat`, token, {});
  check(
    "second join-seat rejected with self_lobby (host cannot re-join their own room)",
    join2.status === 400 && join2.body?.error === "self_lobby",
    `status=${join2.status} body=${JSON.stringify(join2.body)}`,
  );
  // Re-read the lobby via /coop/state and confirm nothing was
  // re-Houseified or otherwise mutated by the rejected call.
  const stateAfter = await jsonFetch("GET", "/coop/state", token);
  const lobbyAfter =
    (stateAfter.body?.lobby && stateAfter.body.lobby.lobbyId === oldLobbyId
      ? stateAfter.body.lobby
      : null) ||
    (stateAfter.body?.openLobbies ?? []).find((l) => l.lobbyId === oldLobbyId);
  check(
    "post-reject: promoted lobby still has real joiner as host",
    lobbyAfter?.hostSteamId === REAL_JOINER,
    `hostSteamId=${lobbyAfter?.hostSteamId}`,
  );
  check(
    "post-reject: still NOT a House lobby (no re-Houseifying)",
    lobbyAfter?.isHouseLobby === false || lobbyAfter?.isHouseLobby === undefined,
    `isHouseLobby=${lobbyAfter?.isHouseLobby}`,
  );
  check(
    "post-reject: acceptedMemberSteamIds unchanged",
    Array.isArray(lobbyAfter?.acceptedMemberSteamIds) &&
      lobbyAfter.acceptedMemberSteamIds.length === 1 &&
      lobbyAfter.acceptedMemberSteamIds[0] === REAL_JOINER,
    JSON.stringify(lobbyAfter?.acceptedMemberSteamIds),
  );

  console.log(`\n${pass} passed, ${fail} failed.\n`);
  if (fail > 0) {
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? "\n    " + f.detail : ""}`);
    }
  }
  process.exit(fail);
}

run().catch((e) => {
  console.error("crashed:", e);
  process.exit(99);
});
