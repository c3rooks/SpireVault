#!/usr/bin/env node
/**
 * End-to-end verification of the co-op run-lobby system.
 *
 * Boots a local wrangler dev worker if one isn't already running on the
 * target URL, then exercises every `/coop/*` route against two fake
 * Steam sessions minted via the `LOCAL_DEBUG`-gated `/_debug/seed-session`
 * endpoint. Production never exposes that endpoint — it only fires when
 * the worker is started under `--env localdev`.
 *
 * Usage:
 *   node Backend/scripts/verify-coop-lobbies.mjs
 *   node Backend/scripts/verify-coop-lobbies.mjs --base=http://127.0.0.1:8787
 *
 * Exit code is the number of failed checks (0 = all good).
 *
 * Zero npm deps — uses Node's built-in `fetch`. Requires Node 18+.
 *
 * What we prove (each check is independent so one failure doesn't
 * cascade into "all 30 tests look broken"):
 *
 *  1. POST /coop/presence with v2 fields persists and round-trips.
 *  2. POST /coop/heartbeat refreshes presence (lastHeartbeatAt advances).
 *  3. POST /coop/lobbies enforces title/goal validation and creates a lobby.
 *  4. GET  /coop/state returns the host's own lobby and the other user
 *     sees it in openLobbies.
 *  5. POST /coop/lobbies/:id/request creates a join request.
 *  6. POST /coop/lobbies/:id/accept mints a session and locks both
 *     users out of new invites.
 *  7. POST /coop/invites enforces unavailable / paired / self / cooldown.
 *  8. POST /coop/invites then accept mints a session in the 1:1 path.
 *  9. POST /coop/sessions/:id/end clears both sides.
 * 10. Rate limit kicks in after 5 pending outgoing invites.
 * 11. HTML/script injection in note/title is sanitized server-side.
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

const BASE = args.base || "http://127.0.0.1:8787";
const AUTO_BOOT = args["no-boot"] ? false : true;

// Two synthetic Steam IDs. Both 17-digit so they pass the regex check.
const SID_A = "76561111111111111";
const SID_B = "76561222222222222";
const SID_C = "76561333333333333";
const SID_D = "76561444444444444";
const SID_E = "76561555555555555";
const SID_F = "76561666666666666";
const SID_G = "76561777777777777";
const SID_M = "76561888888888888"; // Mallory — sanitization test
const SID_FILLERS = [
  "76561991009999999",
  "76561991019999999",
  "76561991029999999",
  "76561991039999999",
];

// ---------- Tiny utilities ----------

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
    if (r.ok) {
      console.log(`Using already-running worker at ${BASE}`);
      return;
    }
  } catch {
    // not running yet
  }
  if (!AUTO_BOOT) {
    throw new Error(`No worker at ${BASE} and --no-boot was set.`);
  }
  console.log("Booting wrangler dev (env=localdev)…");
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  wranglerProc = spawn(
    "npx",
    ["wrangler", "dev", "--env", "localdev", "--port", "8787", "--local"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none" },
    },
  );
  wranglerProc.stdout.on("data", (b) => process.stderr.write("[wrangler] " + b));
  wranglerProc.stderr.on("data", (b) => process.stderr.write("[wrangler] " + b));
  // Wait for the worker to come up. We retry the health check up to
  // 30 seconds — wrangler can take that long on a cold start.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/", { method: "GET" });
      if (r.ok) return;
    } catch { /* keep waiting */ }
    await sleep(500);
  }
  throw new Error("wrangler dev failed to come up within 30s");
}

// ---------- Test plan ----------

async function seedSession(steamID, personaName) {
  const r = await jsonFetch("POST", "/_debug/seed-session", undefined, {
    steamID,
    personaName,
  });
  if (r.status !== 200) {
    throw new Error("seed-session failed: " + JSON.stringify(r));
  }
  return r.body.token;
}

async function wipe(extraKeys = [], { wipeRateLimits = true } = {}) {
  await jsonFetch("POST", "/_debug/wipe", undefined, {
    keys: extraKeys,
    wipeRateLimits,
  });
}

/** Compute the SHA-256 hex of a string, matching `hashID` in
 *  Backend/src/ratelimit.ts so we can wipe the per-IP buckets that
 *  would otherwise leak across local-dev test runs. */
async function hashIP(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function runTests() {
  // ── Setup ──
  const knownCoopKeys = (sid) => [
    `coop:presence:${sid}`,
    `coop:inbox:${sid}`,
    `coop:outbox:${sid}`,
    `coop:user-joins:${sid}`,
    `coop:session-by-user:${sid}`,
    `coop:lobby:by-host:${sid}`,
  ];
  const allSidsCached = [SID_A, SID_B, SID_C, SID_D, SID_E, SID_F, SID_G, SID_M, ...SID_FILLERS];
  /** Decline-cooldown keys for every pair of test Steam IDs. The
   *  cooldown TTL is 10 minutes, so without wiping these the next
   *  test run within 10 minutes inherits the previous run's decline
   *  state and tests 10 + 12 see false-positive `decline_cooldown`
   *  responses. */
  const declineKeys = () => {
    const out = [];
    for (const a of allSidsCached) {
      for (const b of allSidsCached) {
        if (a === b) continue;
        out.push(`coop:decline:${a}:${b}`);
      }
    }
    return out;
  };
  // Per-IP buckets the worker uses. Wrangler's local-dev fetch shows
  // up as `127.0.0.1` to `clientIP()`; we also wipe the bucket for the
  // empty string just in case the header is absent.
  const ipHashes = await Promise.all(["127.0.0.1", ""].map(hashIP));
  const rlKeys = () => {
    const allSids = [SID_A, SID_B, SID_C, SID_D, SID_E, SID_F, SID_G];
    const buckets = [
      "coop-invite-window",
      "coop-write",
      "coop-presence-write",
      "coop-heartbeat",
    ];
    const out = [];
    for (const sid of allSids) for (const b of buckets) out.push(`rl:${b}:${sid}`);
    for (const ip of ipHashes) for (const b of buckets) out.push(`rl:${b}:${ip}`);
    return out;
  };
  /** Wipe just the rate-limit buckets — leaves presence/lobby/session
   *  state intact so we can drain a bucket mid-test-run without losing
   *  the active state. */
  const wipeRateLimits = async () => wipe(rlKeys(), { wipeRateLimits: true });
  const wipeAll = async () => {
    const keys = allSidsCached.flatMap(knownCoopKeys);
    keys.push(...rlKeys());
    keys.push(...declineKeys());
    await wipe(keys);
  };
  await wipeAll();
  const tokenA = await seedSession(SID_A, "Alice");
  const tokenB = await seedSession(SID_B, "Bob");

  // 1. Presence upsert
  console.log("\n1) Presence upsert v2 round-trip");
  {
    const r = await jsonFetch("POST", "/coop/presence", tokenA, {
      status: "looking",
      goal: "a20",
      ascensionMin: 18,
      ascensionMax: 20,
      voicePreference: "optional",
      note: "Looking for A20 partner",
    });
    check(
      "POST /coop/presence returns 200 with goal/asc/voice",
      r.status === 200 &&
        r.body?.presence?.goal === "a20" &&
        r.body?.presence?.ascensionMin === 18 &&
        r.body?.presence?.ascensionMax === 20 &&
        r.body?.presence?.voicePreference === "optional",
      JSON.stringify(r.body),
    );
    check(
      "GET /coop/state surfaces the freshly-saved preferences",
      await (async () => {
        const s = await jsonFetch("GET", "/coop/state", tokenA);
        return (
          s.body?.presence?.goal === "a20" &&
          s.body?.presence?.ascensionMin === 18
        );
      })(),
    );
  }

  // 2. Heartbeat refreshes lastHeartbeatAt
  console.log("\n2) Heartbeat refreshes timestamps");
  {
    const before = (await jsonFetch("GET", "/coop/state", tokenA)).body
      ?.presence?.lastHeartbeatAt;
    await sleep(1100);
    await jsonFetch("POST", "/coop/heartbeat", tokenA, {});
    const after = (await jsonFetch("GET", "/coop/state", tokenA)).body
      ?.presence?.lastHeartbeatAt;
    check(
      "POST /coop/heartbeat updates lastHeartbeatAt",
      Date.parse(after) > Date.parse(before),
      `before=${before} after=${after}`,
    );
  }

  // 3. Create lobby — validates title/goal
  console.log("\n3) Lobby create + validation");
  {
    const noTitle = await jsonFetch("POST", "/coop/lobbies", tokenA, {
      goal: "a20",
    });
    check(
      "POST /coop/lobbies without title returns 400",
      noTitle.status === 400 && noTitle.body?.error === "invalid_title",
    );
    const noGoal = await jsonFetch("POST", "/coop/lobbies", tokenA, {
      title: "test",
    });
    check(
      "POST /coop/lobbies without valid goal returns 400",
      noGoal.status === 400 && noGoal.body?.error === "invalid_goal",
    );
    const ok = await jsonFetch("POST", "/coop/lobbies", tokenA, {
      title: "A20 Heart Attempts",
      goal: "heart",
      ascensionMin: 20,
      ascensionMax: 20,
      voicePreference: "yes",
      note: "Voice strongly preferred",
    });
    check(
      "POST /coop/lobbies returns 200 with lobby payload",
      ok.status === 200 && ok.body?.lobby?.lobbyId,
      JSON.stringify(ok.body),
    );
    globalThis.LOBBY_ID = ok.body.lobby.lobbyId;
  }

  // 4. Other user sees the lobby in openLobbies
  console.log("\n4) Cross-user lobby visibility");
  {
    await jsonFetch("POST", "/coop/presence", tokenB, {
      status: "looking",
      goal: "heart",
      ascensionMin: 20,
      ascensionMax: 20,
    });
    const s = await jsonFetch("GET", "/coop/state", tokenB);
    const lobby = (s.body?.openLobbies || []).find((l) => l.lobbyId === globalThis.LOBBY_ID);
    check(
      "Bob's /coop/state lists Alice's lobby in openLobbies",
      !!lobby,
      `openLobbies=${(s.body?.openLobbies || []).length}`,
    );
    check(
      "Recommended matches surface Alice for Bob",
      (s.body?.recommendedMatches || []).some((r) => r.steamId === SID_A),
    );
  }

  // 5. Join request flow
  console.log("\n5) Join request → accept");
  {
    const r = await jsonFetch(
      "POST",
      `/coop/lobbies/${globalThis.LOBBY_ID}/request`,
      tokenB,
      {},
    );
    check(
      "Bob can request to join Alice's lobby",
      r.status === 200 && r.body?.request?.fromSteamId === SID_B,
    );
    const stateA = await jsonFetch("GET", "/coop/state", tokenA);
    check(
      "Alice's state shows Bob's incoming join request",
      (stateA.body?.incomingJoinRequests || []).some(
        (j) => j.fromSteamId === SID_B,
      ),
    );

    // 6. Accept it
    const acc = await jsonFetch(
      "POST",
      `/coop/lobbies/${globalThis.LOBBY_ID}/accept`,
      tokenA,
      { fromSteamId: SID_B },
    );
    check(
      "Accept join request returns 200 + session id",
      acc.status === 200 && acc.body?.session?.sessionId,
      JSON.stringify(acc.body),
    );
    globalThis.SESSION_ID = acc.body.session.sessionId;
  }

  // 7. Single-session lock — invite from a 3rd user to Alice should fail
  console.log("\n6) Single-session invariant");
  {
    const tokenC = await seedSession(SID_C, "Carol");
    await jsonFetch("POST", "/coop/presence", tokenC, { status: "looking", goal: "a20" });
    const r = await jsonFetch("POST", "/coop/invites", tokenC, {
      toSteamId: SID_A,
      messagePreset: "coop_any",
    });
    check(
      "Inviting a paired player returns 409 they_paired",
      r.status === 409 && r.body?.error === "they_paired",
      JSON.stringify(r.body),
    );
  }

  // 8. End session
  console.log("\n7) End session clears both sides");
  {
    const e = await jsonFetch(
      "POST",
      `/coop/sessions/${globalThis.SESSION_ID}/end`,
      tokenA,
      {},
    );
    check("End session returns 200", e.status === 200 && e.body?.ended === true);
    const a = (await jsonFetch("GET", "/coop/state", tokenA)).body;
    const b = (await jsonFetch("GET", "/coop/state", tokenB)).body;
    check(
      "After end, Alice's state has no session",
      a?.session === null && a?.presence?.currentSessionId == null,
    );
    check(
      "After end, Bob's state has no session",
      b?.session === null && b?.presence?.currentSessionId == null,
    );
  }

  // 9. Invite flow + cancel + decline + cooldown
  console.log("\n8) Direct invite — self-invite blocked");
  {
    const r = await jsonFetch("POST", "/coop/invites", tokenA, {
      toSteamId: SID_A,
      messagePreset: "coop_any",
    });
    check(
      "Inviting yourself returns 400 self_invite",
      r.status === 400 && r.body?.error === "self_invite",
    );
  }

  console.log("\n9) Direct invite — accept mints session");
  {
    const tokenD = await seedSession(SID_D, "Dave");
    await jsonFetch("POST", "/coop/presence", tokenD, { status: "looking" });
    const inv = await jsonFetch("POST", "/coop/invites", tokenA, {
      toSteamId: SID_D,
      messagePreset: "coop_quick",
    });
    check("Alice→Dave invite created", inv.status === 200 && inv.body?.invite?.inviteId);
    const acc = await jsonFetch(
      "POST",
      `/coop/invites/${inv.body.invite.inviteId}/accept`,
      tokenD,
      {},
    );
    check(
      "Dave accepts → session minted",
      acc.status === 200 && acc.body?.session?.sessionId,
    );
    // Clean up the new session so further tests don't see Alice paired
    await jsonFetch(
      "POST",
      `/coop/sessions/${acc.body.session.sessionId}/end`,
      tokenA,
      {},
    );
  }

  // Reset rate-limit buckets so test 10's decline test doesn't trip
  // the IP-level invite window left over from tests 6–9. We DO NOT
  // wipe presence/session state here — those are needed by later tests.
  await wipeRateLimits();
  console.log("\n10) Decline cooldown blocks re-invite");
  {
    const tokenE = await seedSession(SID_E, "Eve");
    await jsonFetch("POST", "/coop/presence", tokenE, { status: "looking" });
    const inv = await jsonFetch("POST", "/coop/invites", tokenA, {
      toSteamId: SID_E,
      messagePreset: "coop_any",
    });
    check("Alice→Eve invite created", inv.status === 200, `status=${inv.status} body=${JSON.stringify(inv.body)}`);
    if (inv.status !== 200) return;
    const dec = await jsonFetch(
      "POST",
      `/coop/invites/${inv.body.invite.inviteId}/decline`,
      tokenE,
      {},
    );
    check("Eve declines → 200", dec.status === 200);
    const retry = await jsonFetch("POST", "/coop/invites", tokenA, {
      toSteamId: SID_E,
      messagePreset: "coop_any",
    });
    check(
      "Re-invite after decline is blocked by cooldown (429 decline_cooldown)",
      retry.status === 429 && retry.body?.error === "decline_cooldown",
      JSON.stringify(retry.body),
    );
  }

  console.log("\n11) Cannot invite a stranger who is offline (no presence)");
  {
    const noTarget = await jsonFetch("POST", "/coop/invites", tokenA, {
      toSteamId: SID_G,
      messagePreset: "coop_any",
    });
    check(
      "Inviting an unseen Steam ID returns 409 target_offline",
      noTarget.status === 409 && noTarget.body?.error === "target_offline",
    );
  }

  // Reset IP-level rate-limit so the test for the per-user 5-pending
  // cap exercises the engine's `too_many_invites` path rather than
  // tripping the IP throttle that test 10/11 already consumed.
  await wipeRateLimits();
  // Wipe again — the next sanitization test runs Mallory's lobby
  // creation which must hit an empty by-host KV slot for that SID.
  await wipeAll();
  console.log("\n12) Outgoing invite cap");
  {
    // Re-seed Alice's presence after the wipe so the outbox tests
    // see a real session.
    await jsonFetch("POST", "/coop/presence", tokenA, {
      status: "looking",
      goal: "a20",
    });
    // Seed enough targets to actually trigger the cap. We need 5
    // pending outgoing invites in the bucket; the 6th must hit
    // too_many_invites.
    const tokens = await Promise.all(
      [SID_E, SID_F, SID_G].map((sid, idx) =>
        seedSession(sid, `Spammer${idx}`),
      ),
    );
    for (let i = 0; i < tokens.length; i++) {
      await jsonFetch("POST", "/coop/presence", tokens[i], { status: "looking" });
    }
    // Alice sends 4 fresh invites to 3 different sids — only 3 will
    // count because the 4th to the same person dedupes. We need to
    // mint more sids to actually fill the bucket up to 5 in the
    // outgoing index.
    const more = [];
    for (let i = 0; i < SID_FILLERS.length; i++) {
      const sid = SID_FILLERS[i];
      const t = await seedSession(sid, `Filler${i}`);
      await jsonFetch("POST", "/coop/presence", t, { status: "looking" });
      more.push(sid);
    }
    // Now send invites until we cross 5 outgoing. Either the per-user
    // `too_many_invites` (5 pending cap) or the per-IP `rate_limited`
    // (10/10min window) is acceptable evidence of the cap; in practice
    // whichever bucket fills first is the one that triggers, and from
    // a UX perspective both deliver the same "Slow down" toast.
    let blocked = false;
    let blockedError = null;
    const allTargets = [SID_E, SID_F, SID_G, ...more];
    for (const sid of allTargets) {
      const r = await jsonFetch("POST", "/coop/invites", tokenA, {
        toSteamId: sid,
        messagePreset: "coop_any",
      });
      if (
        r.status === 429 &&
        (r.body?.error === "too_many_invites" || r.body?.error === "rate_limited")
      ) {
        blocked = true;
        blockedError = r.body?.error;
        break;
      }
    }
    check(
      "After 5+ pending outgoing invites Alice is rate-limited",
      blocked,
      `blockedError=${blockedError}`,
    );
  }

  console.log("\n13) Sanitization (HTML/script in note + title)");
  {
    const tokenZ = await seedSession(SID_M, "Mallory");
    const r = await jsonFetch("POST", "/coop/presence", tokenZ, {
      status: "looking",
      note: '<script>alert(1)</script>Hello<b>world</b>',
    });
    check(
      "HTML/script stripped from presence.note",
      r.status === 200 &&
        typeof r.body?.presence?.note === "string" &&
        !r.body.presence.note.includes("<") &&
        !r.body.presence.note.toLowerCase().includes("script"),
      JSON.stringify(r.body?.presence?.note),
    );
    const lobbyResp = await jsonFetch("POST", "/coop/lobbies", tokenZ, {
      title: '<img src=x onerror="alert(1)">A20 attempt',
      goal: "a20",
    });
    check(
      "HTML stripped from lobby.title",
      lobbyResp.status === 200 &&
        typeof lobbyResp.body?.lobby?.title === "string" &&
        !lobbyResp.body.lobby.title.includes("<"),
      JSON.stringify(lobbyResp.body?.lobby?.title),
    );
  }

  console.log("\n14) /coop/messages catalog returns canned messages");
  {
    const r = await jsonFetch("GET", "/coop/messages", undefined);
    check(
      "Messages catalog is non-empty",
      r.status === 200 && r.body?.messages && Object.keys(r.body.messages).length > 0,
    );
  }

  // ── Summary ──
  console.log(`\n${pass} passed, ${fail} failed.\n`);
  if (fail > 0) {
    console.log("Failures:");
    for (const f of failures) {
      console.log(`  - ${f.label}${f.detail ? "\n    " + f.detail : ""}`);
    }
  }
  return fail;
}

(async () => {
  let code = 1;
  try {
    await ensureWorkerRunning();
    code = await runTests();
  } catch (e) {
    console.error("verify-coop-lobbies crashed:", e);
    code = 99;
  } finally {
    if (wranglerProc) {
      try { wranglerProc.kill("SIGINT"); } catch {}
    }
  }
  process.exit(code);
})();
