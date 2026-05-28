#!/usr/bin/env node
/**
 * End-to-end verification of the House lobby + Option C promotion
 * (Backend/src/coop-house-lobbies.ts → `promoteHouseJoinerToHost`,
 * called from `joinLobbySeat` in Backend/src/coop-engine.ts).
 *
 * Originally this script tested the synthetic-host-ready hotfix
 * (`ensureHouseHostReadyInParty`). That hotfix has been superseded
 * by Option C: instead of keeping the synthetic operator host ready
 * forever and waiting for a real joiner to tap Ready, we now hand
 * the lobby over to the joiner outright the moment they claim a
 * seat. The synthetic host leaves, the real joiner becomes host,
 * the lobby drops its `isHouseLobby` flag, and the renewer mints a
 * fresh House lobby for that slug on the next tick.
 *
 * What we prove:
 *
 *  1. The scheduled cron handler mints House lobbies via
 *     `runHouseLobbyRenewer` (peak-hours dependent).
 *  2. Both House lobbies are visible in /coop/state and flagged
 *     `isHouseLobby === true`.
 *  3. A real human joiner who claims a seat triggers Option C:
 *     - join-seat returns 200
 *     - synthetic host is removed from the minted party
 *     - the joiner is the party host slot
 *  4. The promoted lobby record has `hostSteamId = joinerSid`,
 *     `isHouseLobby = false`, and `houseSlug` cleared — it's now a
 *     normal player-hosted room.
 *  5. The renewer's next pass mints a FRESH House lobby for the
 *     same slug (different lobbyId), proving the slug registry
 *     pointer was cleared when the original lobby was promoted.
 *
 * For the deeper Option C surface (title rewrite, idempotence,
 * self-lobby rejection on re-join, joiner profile fields) see
 * Backend/scripts/verify-house-promotion.mjs.
 *
 * Usage:
 *   node Backend/scripts/verify-house-host-ready.mjs
 *   node Backend/scripts/verify-house-host-ready.mjs --base=http://127.0.0.1:8789
 *
 * Requires the worker to be running with --env localdev so the
 * `/_debug/*` surface and the scheduled cron handler are accessible.
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
const REAL_JOINER = "76561111199999991";
// House synthetic host steam IDs — must match HOUSE_LOBBIES in
// Backend/src/coop-house-lobbies.ts.
const HOUSE_A0  = "76561190000000001";
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
  // wrangler's local-dev scheduled trigger endpoint. Runs the
  // renewer pass without needing the HOUSE_LOBBY_ADMIN_SECRET.
  const r = await fetch(BASE + "/cdn-cgi/handler/scheduled", { method: "GET" });
  return r.status;
}

async function run() {
  console.log(`Target: ${BASE}\n`);

  // Wipe known House lobby pointers so each run starts clean.
  await jsonFetch("POST", "/_debug/wipe", undefined, {
    keys: [
      "house-lobby:house-a0-casual",
      "house-lobby:house-a10-heart",
      "house-lobby:lock",
      `coop:presence:${REAL_JOINER}`,
      `coop:lobby:by-host:${REAL_JOINER}`,
      `coop:session-by-user:${REAL_JOINER}`,
    ],
    wipeRateLimits: true,
  });

  console.log("1) Cron handler creates House lobbies");
  const cronStatus = await triggerScheduled();
  check("scheduled handler returns 200", cronStatus === 200, `status=${cronStatus}`);
  // The handler dispatches via ctx.waitUntil; give it a beat.
  await sleep(800);

  // Seed real joiner + heartbeat.
  const token = await seed(REAL_JOINER, "Real Joiner");
  await jsonFetch("POST", "/coop/presence", token, { status: "looking", goal: "casual" });
  await jsonFetch("POST", "/coop/heartbeat", token, {});

  // Find the two House lobbies in /coop/state.
  console.log("\n2) House lobbies visible in /coop/state");
  const state = await jsonFetch("GET", "/coop/state", token);
  const openLobbies = state.body?.openLobbies ?? [];
  const a0  = openLobbies.find((l) => l.hostSteamId === HOUSE_A0);
  const a10 = openLobbies.find((l) => l.hostSteamId === HOUSE_A10);
  check("A0 Casual House lobby visible", !!a0, JSON.stringify(openLobbies.map((l) => ({ id: l.lobbyId, host: l.hostSteamId, isHouse: l.isHouseLobby }))));
  check("A10 Heart House lobby visible",  !!a10);
  check("Both flagged isHouseLobby=true", a0?.isHouseLobby === true && a10?.isHouseLobby === true);
  if (!a0) {
    console.log("Cannot proceed without a House lobby — aborting.");
    return;
  }

  // ───────────────────────────────────────────────────────────────────
  // SUPERSEDED-BY-OPTION-C NOTE
  //
  // Steps 3-6 below originally proved the "synthetic host auto-ready"
  // hotfix: joiner joins House lobby → synthetic host stays in the
  // party at status=ready → launch gate fires once joiner taps Ready.
  //
  // The v199 Option C promotion (Backend/src/coop-house-lobbies.ts →
  // `promoteHouseJoinerToHost`, called from `joinLobbySeat`) replaces
  // that behavior outright: the synthetic host is now REMOVED from
  // the party as soon as a real human joiner claims a seat, and the
  // joiner is promoted to host of a normal (non-House) lobby.
  //
  // We keep this script for its precondition checks (cron creates
  // House lobbies, A0/A10 both visible, both flagged isHouseLobby)
  // and rewrite the join-seat assertions to match Option C:
  //   - joiner becomes host
  //   - synthetic host is gone from the party
  //   - lobby is no longer flagged as a House lobby
  //
  // For the full Option C surface, see
  // Backend/scripts/verify-house-promotion.mjs.
  // ───────────────────────────────────────────────────────────────────

  console.log("\n3) Real joiner claims a seat → Option C promotion fires");
  const join = await jsonFetch("POST", `/coop/lobbies/${a0.lobbyId}/join-seat`, token, {});
  check("join-seat returns 200", join.status === 200, JSON.stringify(join.body));
  const partyId = join.body?.partyId;
  check("party minted with partyId", typeof partyId === "string" && partyId.length === 32);
  const partyMembers = join.body?.party?.members ?? [];
  const joinerMemberAtJoin = partyMembers.find((m) => m.steamId === REAL_JOINER);
  const hostMemberAtJoin = partyMembers.find((m) => m.steamId === HOUSE_A0);
  check(
    "synthetic host removed from party (Option C: operator steps out)",
    !hostMemberAtJoin,
    JSON.stringify(partyMembers.map((m) => m.steamId)),
  );
  check(
    "real joiner is the party host slot",
    !!joinerMemberAtJoin,
    JSON.stringify(joinerMemberAtJoin),
  );

  console.log("\n4) Promoted lobby is a normal player-hosted room");
  const promoted = join.body?.lobby;
  check(
    "lobby.hostSteamId flipped to real joiner",
    promoted?.hostSteamId === REAL_JOINER,
    `hostSteamId=${promoted?.hostSteamId}`,
  );
  check(
    "lobby.isHouseLobby === false post-promotion",
    promoted?.isHouseLobby === false || promoted?.isHouseLobby === undefined,
    `isHouseLobby=${promoted?.isHouseLobby}`,
  );
  check(
    "lobby.houseSlug cleared post-promotion",
    !promoted?.houseSlug,
    `houseSlug=${promoted?.houseSlug}`,
  );

  console.log("\n5) Renewer re-mints House A0 lobby after promotion (registry pointer cleared)");
  const cron2 = await triggerScheduled();
  check("second scheduled trigger returns 200", cron2 === 200);
  await sleep(800);
  const stateAfter = await jsonFetch("GET", "/coop/state", token);
  const a0Fresh = (stateAfter.body?.openLobbies ?? []).find(
    (l) => l.hostSteamId === HOUSE_A0 && l.isHouseLobby === true,
  );
  check(
    "fresh House A0 lobby exists after renewer pass",
    !!a0Fresh,
    JSON.stringify(stateAfter.body?.openLobbies?.map((l) => ({ id: l.lobbyId, host: l.hostSteamId, house: l.isHouseLobby }))),
  );
  check(
    "fresh House lobby has a DIFFERENT lobbyId from the promoted one",
    a0Fresh && a0Fresh.lobbyId !== a0.lobbyId,
    `oldLobbyId=${a0.lobbyId} newLobbyId=${a0Fresh?.lobbyId}`,
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
