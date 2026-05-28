#!/usr/bin/env node
/**
 * End-to-end regression of the SpireVault co-op
 *   create → list → join → party → ready → re-advertise
 * flow, exercised against an isolated local-dev worker (preview KV,
 * `--env localdev --local`). Production KV is NEVER touched — the
 * worker runs in Miniflare's in-memory KV.
 *
 * This script was added during the v196–v202 regression pass to give
 * confidence that real people can create and join lobbies after a
 * week of changes to the create/join path (three-stage redesign,
 * Stage A one-tap, House lobbies, rank-sort boost, party-hub
 * lobby-TTL-refresh + re-advertise endpoint + /coop/parties rewrite,
 * mutate-in-place render refactor).
 *
 * Usage:
 *   node Backend/scripts/verify-coop-full-flow.mjs
 *   node Backend/scripts/verify-coop-full-flow.mjs --base=http://127.0.0.1:8799
 *   node Backend/scripts/verify-coop-full-flow.mjs --no-boot   # use a running worker
 *
 * Exit code = number of failed assertions (0 = all good).
 * Zero npm deps — Node 18+ built-in fetch.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  }),
);

const BASE = args.base || "http://127.0.0.1:8799";
const PORT = new URL(BASE).port || "8799";
const AUTO_BOOT = args["no-boot"] ? false : true;

// Synthetic 17-digit Steam IDs (pass the /^\d{17}$/ validator).
const HOST = "76561000000000101"; // happy-path host
const JOINER = "76561000000000102"; // happy-path joiner
const VIEWER = "76561000000000103"; // anonymous third browser
const AP_HOST = "76561000000000201"; // approval-path host
const AP_JOINER = "76561000000000202"; // approval-path joiner
const FULL_HOST = "76561000000000301"; // full-lobby host
const FULL_J1 = "76561000000000302";
const FULL_J2 = "76561000000000303"; // the one who should be rejected
const LEAVE_HOST = "76561000000000401";
const LEAVE_JOINER = "76561000000000402";
const RA_NONHOST = "76561000000000403"; // non-host re-advertise attempt

const ALL_SIDS = [
  HOST, JOINER, VIEWER, AP_HOST, AP_JOINER,
  FULL_HOST, FULL_J1, FULL_J2, LEAVE_HOST, LEAVE_JOINER, RA_NONHOST,
];

// ---------- Tiny harness ----------

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

async function tryFetch(url, init, retries = 12, delayMs = 500) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      await sleep(delayMs);
    }
  }
  throw last;
}

async function jsonFetch(method, pathStr, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await tryFetch(BASE + pathStr, init);
  let data;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, body: data };
}

// ---------- Boot wrangler dev if necessary ----------

let wranglerProc = null;

async function ensureWorkerRunning() {
  try {
    const r = await fetch(BASE + "/", { method: "GET" });
    if (r.ok || r.status === 404) {
      console.log(`Using already-running worker at ${BASE}`);
      return;
    }
  } catch { /* not up yet */ }
  if (!AUTO_BOOT) throw new Error(`No worker at ${BASE} and --no-boot was set.`);
  console.log(`Booting wrangler dev (env=localdev, --local) on :${PORT}…`);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  wranglerProc = spawn(
    "npx",
    ["wrangler", "dev", "--env", "localdev", "--port", PORT, "--local"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none" },
    },
  );
  wranglerProc.stdout.on("data", (b) => process.stderr.write("[wrangler] " + b));
  wranglerProc.stderr.on("data", (b) => process.stderr.write("[wrangler] " + b));
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + "/", { method: "GET" });
      if (r.ok || r.status === 404) return;
    } catch { /* keep waiting */ }
    await sleep(500);
  }
  throw new Error("wrangler dev failed to come up within 40s");
}

// ---------- KV helpers via /_debug ----------

async function seed(steamID, personaName) {
  const r = await jsonFetch("POST", "/_debug/seed-session", undefined, {
    steamID, personaName,
  });
  if (r.status !== 200) throw new Error("seed-session failed: " + JSON.stringify(r));
  return r.body.token;
}

async function wipeAll() {
  const keys = [];
  for (const sid of ALL_SIDS) {
    keys.push(
      `coop:presence:${sid}`,
      `coop:inbox:${sid}`,
      `coop:outbox:${sid}`,
      `coop:user-joins:${sid}`,
      `coop:session-by-user:${sid}`,
      `coop:party-by-user:${sid}`,
      `coop:lobby:by-host:${sid}`,
    );
  }
  await jsonFetch("POST", "/_debug/wipe", undefined, { keys, wipeRateLimits: true });
}

async function deleteKeys(keys) {
  await jsonFetch("POST", "/_debug/wipe", undefined, { keys, wipeRateLimits: false });
}

// ---------- The flow ----------

async function runTests() {
  await wipeAll();

  const tokenHost = await seed(HOST, "FlowHost");
  const tokenJoiner = await seed(JOINER, "FlowJoiner");
  const tokenViewer = await seed(VIEWER, "FlowViewer");

  // Make presence rows real so freshness gates pass.
  await jsonFetch("POST", "/coop/presence", tokenHost, { status: "looking", goal: "heart" });
  await jsonFetch("POST", "/coop/presence", tokenJoiner, { status: "looking", goal: "heart" });
  await jsonFetch("POST", "/coop/presence", tokenViewer, { status: "looking", goal: "heart" });

  let partyId, lobbyId;

  // ── 2. Host creates a lobby ──
  console.log("\n2) Host creates an open lobby");
  {
    const r = await jsonFetch("POST", "/coop/lobbies", tokenHost, {
      title: "Regression A20 Heart",
      goal: "heart",
      lobbySize: 4,
      ascensionMin: 20,
      ascensionMax: 20,
      voicePreference: "optional",
    });
    check(
      "POST /coop/lobbies → 200 with open lobby",
      r.status === 200 && r.body?.lobby?.lobbyId && r.body.lobby.status === "open",
      JSON.stringify(r.body),
    );
    check(
      "lobby fields correct (host, title, size, accepted=[host])",
      r.body?.lobby?.hostSteamId === HOST &&
        r.body?.lobby?.title === "Regression A20 Heart" &&
        r.body?.lobby?.lobbySize === 4 &&
        Array.isArray(r.body?.lobby?.acceptedMemberSteamIds) &&
        r.body.lobby.acceptedMemberSteamIds.length === 1 &&
        r.body.lobby.acceptedMemberSteamIds[0] === HOST,
      JSON.stringify(r.body?.lobby),
    );
    lobbyId = r.body?.lobby?.lobbyId;
  }
  if (!lobbyId) {
    console.log("Cannot continue without a lobby id.");
    return;
  }

  // ── 3. Third user lists it ──
  console.log("\n3) Third (viewer) user sees the lobby in /coop/state");
  {
    const s = await jsonFetch("GET", "/coop/state", tokenViewer);
    const l = (s.body?.openLobbies || []).find((x) => x.lobbyId === lobbyId);
    check(
      "openLobbies contains the new lobby with correct host/title/size",
      !!l && l.hostSteamId === HOST && l.title === "Regression A20 Heart" && l.lobbySize === 4,
      `openLobbies=${JSON.stringify((s.body?.openLobbies || []).map((x) => x.lobbyId))}`,
    );
    check(
      "lobby exposes a seat/member count after v202 render refactor",
      !!l && Array.isArray(l.acceptedMemberSteamIds) && Array.isArray(l.memberSteamIds),
      JSON.stringify(l),
    );
  }

  // ── 4. Joiner claims a seat ──
  console.log("\n4) Joiner claims a seat (open join)");
  {
    const r = await jsonFetch("POST", `/coop/lobbies/${lobbyId}/join-seat`, tokenJoiner, {
      selectedCharacter: "silent",
    });
    check("join-seat → 200", r.status === 200, JSON.stringify(r.body));
    check("party minted with 32-char partyId", typeof r.body?.partyId === "string" && r.body.partyId.length === 32);
    partyId = r.body?.partyId;
    const members = r.body?.party?.members ?? [];
    check(
      "party has both host and joiner as members",
      members.some((m) => m.steamId === HOST) && members.some((m) => m.steamId === JOINER),
      JSON.stringify(members.map((m) => m.steamId)),
    );
  }
  if (!partyId) {
    console.log("Cannot continue without a party id.");
    return;
  }

  // ── 4b. Idempotent re-join ──
  console.log("\n4b) Re-joining an already-joined lobby is idempotent");
  {
    const r = await jsonFetch("POST", `/coop/lobbies/${lobbyId}/join-seat`, tokenJoiner, {});
    check(
      "second join-seat returns 200 with the same partyId (idempotent)",
      r.status === 200 && r.body?.partyId === partyId,
      JSON.stringify({ status: r.status, partyId: r.body?.partyId }),
    );
  }

  // ── 5. Host reads the party (v201 rewrite) ──
  console.log("\n5) Host GET /coop/parties/:id (v201 rewrite + TTL refresh)");
  let beforeExpiry, afterExpiry;
  {
    // Read current lobby expiry directly from state to confirm refresh later.
    const beforeState = await jsonFetch("GET", "/coop/state", tokenHost);
    beforeExpiry = beforeState.body?.lobby?.expiresAt;
    const r = await jsonFetch("GET", `/coop/parties/${partyId}`, tokenHost);
    check("party GET → 200", r.status === 200, JSON.stringify(r.body));
    check("party returned with both members", (r.body?.party?.members ?? []).length === 2);
    check("lobbyMissing === false while lobby alive", r.body?.lobbyMissing === false, JSON.stringify({ lobbyMissing: r.body?.lobbyMissing }));
    check("linked lobby payload present", !!r.body?.lobby && r.body.lobby.lobbyId === lobbyId);
    afterExpiry = r.body?.lobby?.expiresAt;
    // Note: TTL refresh only re-stamps when within 10 min of expiry, so a
    // freshly created lobby (35 min TTL) is NOT re-stamped here. We assert
    // the lobby is at least still alive and far from expiry.
    const msLeft = afterExpiry ? Date.parse(afterExpiry) - Date.now() : 0;
    check(
      "linked lobby has a healthy TTL (far from expiry)",
      msLeft > 20 * 60 * 1000,
      `msLeft=${msLeft}`,
    );
  }

  // ── 5b. Non-member cannot read the party ──
  console.log("\n5b) Non-member is rejected from the party room");
  {
    const r = await jsonFetch("GET", `/coop/parties/${partyId}`, tokenViewer);
    check("viewer GET party → 403 not_participant", r.status === 403 && r.body?.error === "not_participant", JSON.stringify(r.body));
  }

  // ── 6/7. Ready-up gate with 2 real members ──
  console.log("\n6+7) Ready-up gate: both members mark ready");
  {
    const j = await jsonFetch("POST", `/coop/parties/${partyId}/status`, tokenJoiner, { status: "ready" });
    check("joiner ready → 200", j.status === 200, JSON.stringify(j.body));
    const jm = (j.body?.party?.members ?? []).find((m) => m.steamId === JOINER);
    check("joiner status propagated to 'ready' with readyAt stamp", jm?.status === "ready" && !!jm?.readyAt, JSON.stringify(jm));

    const h = await jsonFetch("POST", `/coop/parties/${partyId}/status`, tokenHost, { status: "ready" });
    check("host ready → 200", h.status === 200, JSON.stringify(h.body));
    const members = h.body?.party?.members ?? [];
    const live = members.filter((m) => m.status !== "left");
    const allReady = live.length >= 2 && live.every((m) => m.status === "ready" || m.status === "in_game");
    check(
      "all-ready launch gate passes (every live member ready/in_game)",
      allReady,
      JSON.stringify(members.map((m) => ({ s: m.steamId.slice(-3), st: m.status }))),
    );
  }

  // ── 8. Simulate 35-min lobby expiry → lobbyMissing ──
  console.log("\n8) Delete lobby record (simulate expiry) → lobbyMissing=true");
  {
    await deleteKeys([`coop:lobby:${lobbyId}`]);
    const r = await jsonFetch("GET", `/coop/parties/${partyId}`, tokenHost);
    check("party still readable after lobby gone", r.status === 200, JSON.stringify(r.body));
    check("lobbyMissing flips to true", r.body?.lobbyMissing === true, JSON.stringify({ lobbyMissing: r.body?.lobbyMissing, lobby: r.body?.lobby }));
  }

  // ── 9. Re-advertise (v201 new, host-only) ──
  console.log("\n9) Host re-advertises → fresh lobby minted + re-linked + back on board");
  {
    const r = await jsonFetch("POST", `/coop/parties/${partyId}/re-advertise`, tokenHost, {});
    check("re-advertise → 200 with new lobby", r.status === 200 && !!r.body?.lobby?.lobbyId, JSON.stringify(r.body));
    const newLobbyId = r.body?.lobby?.lobbyId;
    check("new lobby id differs from the expired one", newLobbyId && newLobbyId !== lobbyId, `old=${lobbyId} new=${newLobbyId}`);
    check("re-advertised lobby preserves title from lobbyMeta snapshot", r.body?.lobby?.title === "Regression A20 Heart", JSON.stringify(r.body?.lobby?.title));
    check("party re-linked to the new lobby", r.body?.party?.lobbyId === newLobbyId, JSON.stringify({ partyLobby: r.body?.party?.lobbyId, newLobbyId }));

    // Confirm it's back on the public board for a third viewer.
    const s = await jsonFetch("GET", "/coop/state", tokenViewer);
    const back = (s.body?.openLobbies || []).find((x) => x.lobbyId === newLobbyId);
    check(
      "re-advertised lobby reappears in /coop/state openLobbies",
      !!back,
      `openLobbies=${JSON.stringify((s.body?.openLobbies || []).map((x) => x.lobbyId))}`,
    );
    lobbyId = newLobbyId;
  }

  // ── 9b. Non-host cannot re-advertise ──
  console.log("\n9b) Non-host re-advertise is rejected (403)");
  {
    // JOINER is a party member but not host.
    const r = await jsonFetch("POST", `/coop/parties/${partyId}/re-advertise`, tokenJoiner, {});
    check("joiner re-advertise → 403 not_host", r.status === 403 && r.body?.error === "not_host", JSON.stringify(r.body));
    // A complete stranger should also be blocked (404 not a participant gate
    // is fine; the route still requires host).
    const tokenStranger = await seed(RA_NONHOST, "Stranger");
    const r2 = await jsonFetch("POST", `/coop/parties/${partyId}/re-advertise`, tokenStranger, {});
    check("stranger re-advertise → 403/404 (not host)", (r2.status === 403 || r2.status === 404), JSON.stringify(r2.body));
  }

  // ── Tear down the happy-path party so its members are free. ──
  await jsonFetch("POST", `/coop/parties/${partyId}/end`, tokenHost, {});

  // ── 10. Approval path ──
  console.log("\n10) Approval-required path: request → accept → seat granted");
  {
    const tHost = await seed(AP_HOST, "ApprovalHost");
    const tJoin = await seed(AP_JOINER, "ApprovalJoiner");
    await jsonFetch("POST", "/coop/presence", tHost, { status: "looking", goal: "heart" });
    await jsonFetch("POST", "/coop/presence", tJoin, { status: "looking", goal: "heart" });

    const created = await jsonFetch("POST", "/coop/lobbies", tHost, {
      title: "Approval Room",
      goal: "heart",
      lobbySize: 4,
      approvalRequired: true,
    });
    check("approval lobby created with approvalRequired=true", created.status === 200 && created.body?.lobby?.approvalRequired === true, JSON.stringify(created.body?.lobby));
    const apLobbyId = created.body?.lobby?.lobbyId;

    // Open-join must be refused on an approval lobby.
    const wrongJoin = await jsonFetch("POST", `/coop/lobbies/${apLobbyId}/join-seat`, tJoin, {});
    check("join-seat refused on approval lobby (409 approval_required)", wrongJoin.status === 409 && wrongJoin.body?.error === "approval_required", JSON.stringify(wrongJoin.body));

    const reqd = await jsonFetch("POST", `/coop/lobbies/${apLobbyId}/request`, tJoin, { selectedCharacter: "silent" });
    check("join request created", reqd.status === 200 && reqd.body?.request?.fromSteamId === AP_JOINER, JSON.stringify(reqd.body));

    // Host sees incoming request.
    const hostState = await jsonFetch("GET", "/coop/state", tHost);
    check("host sees incoming join request", (hostState.body?.incomingJoinRequests || []).some((j) => j.fromSteamId === AP_JOINER), JSON.stringify(hostState.body?.incomingJoinRequests));

    const acc = await jsonFetch("POST", `/coop/lobbies/${apLobbyId}/accept`, tHost, { fromSteamId: AP_JOINER });
    check("host accepts → 200 with party + session", acc.status === 200 && !!acc.body?.partyId && !!acc.body?.session?.sessionId, JSON.stringify(acc.body));
    const apMembers = acc.body?.party?.members ?? [];
    check("accepted joiner is a party member", apMembers.some((m) => m.steamId === AP_JOINER), JSON.stringify(apMembers.map((m) => m.steamId)));

    // Clean up.
    if (acc.body?.partyId) await jsonFetch("POST", `/coop/parties/${acc.body.partyId}/end`, tHost, {});
  }

  // ── 11a. Join a full lobby → clean rejection ──
  console.log("\n11a) Join a full lobby → clean rejection (no crash)");
  {
    const tH = await seed(FULL_HOST, "FullHost");
    const t1 = await seed(FULL_J1, "FullJoiner1");
    const t2 = await seed(FULL_J2, "FullJoiner2");
    await jsonFetch("POST", "/coop/presence", tH, { status: "looking" });
    await jsonFetch("POST", "/coop/presence", t1, { status: "looking" });
    await jsonFetch("POST", "/coop/presence", t2, { status: "looking" });

    const created = await jsonFetch("POST", "/coop/lobbies", tH, { title: "Two Seater", goal: "casual", lobbySize: 2 });
    const fullLobbyId = created.body?.lobby?.lobbyId;
    const j1 = await jsonFetch("POST", `/coop/lobbies/${fullLobbyId}/join-seat`, t1, {});
    check("first joiner fills the 2-seat lobby", j1.status === 200, JSON.stringify(j1.body));
    const j2 = await jsonFetch("POST", `/coop/lobbies/${fullLobbyId}/join-seat`, t2, {});
    check(
      "second joiner cleanly rejected from full lobby (409)",
      j2.status === 409 && (j2.body?.error === "lobby_full" || j2.body?.error === "lobby_closed"),
      JSON.stringify(j2.body),
    );
    // Clean up the party that the first join minted.
    if (j1.body?.partyId) await jsonFetch("POST", `/coop/parties/${j1.body.partyId}/end`, tH, {});
  }

  // ── 11b. Leave a party → seat frees, presence updates ──
  console.log("\n11b) Leave a party → seat frees + presence cleared");
  {
    const tH = await seed(LEAVE_HOST, "LeaveHost");
    const tJ = await seed(LEAVE_JOINER, "LeaveJoiner");
    await jsonFetch("POST", "/coop/presence", tH, { status: "looking" });
    await jsonFetch("POST", "/coop/presence", tJ, { status: "looking" });

    const created = await jsonFetch("POST", "/coop/lobbies", tH, { title: "Leave Test", goal: "casual", lobbySize: 4 });
    const lid = created.body?.lobby?.lobbyId;
    const joined = await jsonFetch("POST", `/coop/lobbies/${lid}/join-seat`, tJ, {});
    const pid = joined.body?.partyId;
    check("setup: joiner joined the leave-test lobby", joined.status === 200 && !!pid, JSON.stringify(joined.body));

    const left = await jsonFetch("POST", `/coop/parties/${pid}/leave`, tJ, {});
    check("leave → 200 left=true", left.status === 200 && left.body?.left === true, JSON.stringify(left.body));

    // Joiner's presence/party pointer is cleared.
    const js = await jsonFetch("GET", "/coop/state", tJ);
    check("joiner has no active party after leaving (state.party === null)", js.body?.party === null && js.body?.presence?.currentPartyId == null, JSON.stringify({ party: js.body?.party, cur: js.body?.presence?.currentPartyId }));

    // The leaver must be free to create/join a NEW lobby. With a stale
    // party-by-user pointer this returns 409 in_party — the regression
    // this assertion guards against.
    const recreate = await jsonFetch("POST", "/coop/lobbies", tJ, { title: "Post-leave room", goal: "casual", lobbySize: 4 });
    check(
      "leaver can create a new lobby (not falsely blocked by 409 in_party)",
      recreate.status === 200 && !!recreate.body?.lobby?.lobbyId,
      JSON.stringify({ status: recreate.status, error: recreate.body?.error }),
    );
    if (recreate.body?.lobby?.lobbyId) {
      await jsonFetch("POST", `/coop/lobbies/${recreate.body.lobby.lobbyId}/close`, tJ, {});
    }

    // Seat freed on the lobby (host can see it back to open with 1 accepted member).
    const hs = await jsonFetch("GET", "/coop/state", tH);
    const myLobby = hs.body?.lobby;
    check(
      "seat frees on the lobby (accepted back to just the host)",
      !!myLobby && (myLobby.acceptedMemberSteamIds || []).length === 1 && myLobby.acceptedMemberSteamIds[0] === LEAVE_HOST,
      JSON.stringify(myLobby?.acceptedMemberSteamIds),
    );
    // Clean up: close the lobby.
    if (lid) await jsonFetch("POST", `/coop/lobbies/${lid}/close`, tH, {});
  }

  // ── Final cleanup ──
  await wipeAll();

  console.log(`\n${pass} passed, ${fail} failed.\n`);
  if (fail > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? "\n    " + f.detail : ""}`);
  }
  return fail;
}

(async () => {
  let code = 1;
  try {
    await ensureWorkerRunning();
    code = await runTests();
  } catch (e) {
    console.error("verify-coop-full-flow crashed:", e);
    code = 99;
  } finally {
    if (wranglerProc) {
      try { wranglerProc.kill("SIGINT"); } catch {}
    }
  }
  process.exit(code);
})();
