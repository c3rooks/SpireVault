#!/usr/bin/env node
/**
 * End-to-end check of one-tap co-op Play against a local `wrangler dev
 * --env localdev` Worker (sandbox routes on, LOCAL_DEBUG=1). Never point this
 * at production: it resets the sandbox and the Play queue.
 *
 *   node scripts/verify-coop-play-flow.mjs [baseUrl]   (default http://127.0.0.1:8787)
 *
 * Covers: pulse, first player searching, a seeded persona matching, host
 * choice, party steps, lock on "we're in", partner leaving re-queues the
 * survivor, cancel, and that /coop/rooms no longer counts house rooms.
 */

import assert from "node:assert/strict";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error(`refusing to run against ${BASE}: local Workers only`);
  process.exit(2);
}

let passed = 0;
async function step(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

async function call(method, path, { token, body } = {}) {
  const resp = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: resp.status, data };
}

async function sessionFor(persona) {
  const r = await call("POST", "/_debug/coop-sandbox/act-as", { body: { persona } });
  assert.equal(r.status, 200, `act-as ${persona}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

await step("sandbox reset clears the Play queue", async () => {
  const r = await call("POST", "/_debug/coop-sandbox/reset");
  assert.equal(r.status, 200);
  const p = await call("GET", "/coop/play/pulse");
  assert.equal(p.data.lookingCount, 0);
  assert.equal(p.data.playingCount, 0);
});

const corey = await sessionFor("local-corey");
const mako = await sessionFor("local-mako");

await step("signed-out callers get 401 on the queue", async () => {
  const r = await call("GET", "/coop/play");
  assert.equal(r.status, 401);
});

await step("first Play waits in line", async () => {
  const r = await call("POST", "/coop/play", { token: corey, body: { character: "silent", branch: "stable" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state, "searching");
  assert.equal(r.data.ticket.character, "silent");
  const p = await call("GET", "/coop/play/pulse");
  assert.equal(p.data.lookingCount, 1);
});

await step("cancel leaves the queue", async () => {
  const r = await call("DELETE", "/coop/play", { token: corey });
  assert.equal(r.data.state, "idle");
});

await step("a seeded persona waiting means Play matches instantly", async () => {
  const seed = await call("POST", "/_debug/coop-sandbox/play-seed", {
    body: { persona: "Boble", branch: "stable", character: "ironclad" },
  });
  assert.equal(seed.data.view?.state, "searching", JSON.stringify(seed.data));
  const r = await call("POST", "/coop/play", { token: corey, body: { character: "silent" } });
  assert.equal(r.data.state, "matched", JSON.stringify(r.data));
  assert.equal(r.data.match.hostSid, "local-boble", "the persona waited longer, so it hosts");
  assert.equal(r.data.match.youAreHost, false);
  assert.deepEqual(r.data.match.members.map((m) => m.sid), ["local-boble", "local-corey"]);
  assert.equal(r.data.match.seatsLeft, 2);
});

await step("a third player joins the gathering party", async () => {
  const r = await call("POST", "/coop/play", { token: mako });
  assert.equal(r.data.state, "matched");
  assert.equal(r.data.match.members.length, 3);
});

await step("party steps: Steam add is recorded", async () => {
  const r = await call("POST", "/coop/play/action", { token: corey, body: { action: "steam_add" } });
  assert.equal(r.data.match.members.find((m) => m.isYou).steamAdded, true);
  const bad = await call("POST", "/coop/play/action", { token: corey, body: { action: "explode" } });
  assert.equal(bad.status, 400);
});

await step("host leaving hands the role on", async () => {
  await call("POST", "/_debug/coop-sandbox/play-act", { body: { persona: "Boble", action: "leave" } });
  const r = await call("GET", "/coop/play", { token: corey });
  assert.equal(r.data.state, "matched");
  assert.equal(r.data.match.hostSid, "local-corey", "corey queued before mako");
  assert.equal(r.data.notice, "host_changed");
  assert.equal(r.data.pushOn, false);
});

await step("partner leaving re-queues the survivor", async () => {
  await call("POST", "/coop/play/action", { token: mako, body: { action: "leave" } });
  const r = await call("GET", "/coop/play", { token: corey });
  assert.equal(r.data.state, "searching");
  assert.equal(r.data.notice, "partner_left");
});

await step("host saying 'we're in' locks the party", async () => {
  await call("POST", "/_debug/coop-sandbox/play-seed", { body: { persona: "Mega" } });
  const m = await call("GET", "/coop/play", { token: corey });
  assert.equal(m.data.state, "matched", "corey (re-queued) matched with Mega on the next pass");
  await call("POST", "/_debug/coop-sandbox/play-act", { body: { persona: "Mega", action: "poll" } });
  const host = m.data.match.hostSid;
  const lock = host === "local-corey"
    ? await call("POST", "/coop/play/action", { token: corey, body: { action: "in_game" } })
    : await call("POST", "/_debug/coop-sandbox/play-act", { body: { persona: "Mega", action: "in_game" } });
  assert.equal(lock.status, 200);
  const r = await call("GET", "/coop/play", { token: corey });
  assert.equal(r.data.state, "in_game");
  const blocked = await call("POST", "/coop/play", { token: mako });
  assert.equal(blocked.data.state, "searching", "a locked party is never joined");
  await call("DELETE", "/coop/play", { token: mako });
});

let pushEnabled = false;
await step("push config answers even without VAPID keys", async () => {
  const r = await call("GET", "/coop/play/push/config");
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.enabled, "boolean");
  pushEnabled = r.data.enabled;
});

// Pings switched on or off while waiting change the ticket in place. Turning
// them on needs VAPID keys (start the worker with them to cover that half).
let makoQueuedAt = 0;
await step("pings switched off mid-search take the long lifetime off the ticket", async () => {
  const play = await call("POST", "/coop/play", { token: mako, body: { branch: "beta", push: true } });
  assert.equal(play.data.ticket.push, true);
  makoQueuedAt = play.data.ticket.createdAt;
  const off = await call("DELETE", "/coop/play/push", { token: mako });
  assert.equal(off.data.state, "searching", "still in line");
  assert.equal(off.data.ticket.push, false);
  assert.equal(off.data.ticket.createdAt, makoQueuedAt, "same place in line");
});

if (pushEnabled) {
  await step("pings switched on mid-search upgrade the waiting ticket", async () => {
    const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/verify-flow", keys: { p256dh: "p", auth: "a" } };
    const on = await call("POST", "/coop/play/push", { token: mako, body: { subscription, looking: true, branch: "beta" } });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.state, "searching");
    assert.equal(on.data.ticket.push, true);
    assert.equal(on.data.ticket.createdAt, makoQueuedAt, "same place in line");
    assert.equal(on.data.pushOn, true);
  });
} else {
  console.log("  skip pings switched on mid-search upgrade the waiting ticket (no VAPID keys on this worker)");
}

await step("the two sign-out calls drop the subscription and leave the line", async () => {
  await call("DELETE", "/coop/play/push", { token: mako });
  const left = await call("DELETE", "/coop/play", { token: mako });
  assert.equal(left.data.state, "idle");
  const after = await call("GET", "/coop/play", { token: mako });
  assert.equal(after.data.state, "idle");
  assert.equal(after.data.pushOn, false);
  assert.equal(after.data.pings.looking, false);
});

await step("peek reads your view and needs a session", async () => {
  const anonymous = await call("GET", "/coop/play/peek");
  assert.equal(anonymous.status, 401);
  const r = await call("GET", "/coop/play/peek", { token: corey });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.state, "in_game");
  assert.equal(r.data.match.members.some((m) => m.isYou), true);
});

await step("leaving the line and changing pings are rate limited like every other call", async () => {
  const weird = await sessionFor("local-iamweird");
  const cancels = await Promise.all(Array.from({ length: 70 }, () => call("DELETE", "/coop/play", { token: weird })));
  assert.ok(cancels.some((r) => r.status === 429), "70 cancels in a row hit the limit");
  const push = await call("DELETE", "/coop/play/push", { token: weird });
  assert.equal(push.status, 429, "and the same budget covers the push settings");
  assert.equal(push.data.error, "rate_limited");
});

await step("house rooms no longer appear or count on /coop/rooms", async () => {
  const r = await call("GET", "/coop/rooms");
  assert.equal(r.status, 200);
  assert.equal((r.data.rooms ?? []).filter((x) => x.isHouseLobby).length, 0);
});

await call("POST", "/_debug/coop-sandbox/reset");
console.log(`coop-play flow: ${passed} steps passed${process.exitCode ? " (with failures)" : ""}`);
