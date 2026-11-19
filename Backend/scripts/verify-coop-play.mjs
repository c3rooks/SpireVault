#!/usr/bin/env node
/**
 * Offline checks for one-tap co-op matchmaking (src/coop-play-core.ts).
 *
 * Pure functions with an injected clock and id maker — no network, no KV, no
 * Durable Object. Bundled with esbuild first, like verify-offline.mjs, because
 * the Worker sources use extensionless imports.
 *
 * Run: node scripts/verify-coop-play.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const workDir = mkdtempSync(join(tmpdir(), "vault-play-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

const entry = join(workDir, "entry.ts");
writeFileSync(
  entry,
  `export * from ${JSON.stringify(join(SRC, "coop-play-core"))};\n` +
    `export * as Push from ${JSON.stringify(join(SRC, "coop-play-push"))};\n` +
    `export * as PushQ from ${JSON.stringify(join(SRC, "coop-play-pushq"))};\n` +
    `export * as Dev from ${JSON.stringify(join(SRC, "coop-play-devices"))};\n`,
);
const bundle = join(workDir, "bundle.mjs");
execFileSync(
  "npx",
  ["esbuild", entry, "--bundle", "--format=esm", "--platform=neutral", `--outfile=${bundle}`, "--log-level=error"],
  { stdio: "inherit" },
);
const P = await import(pathToFileURL(bundle).href);

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 10, 14, 20, 0, 0);

/** A tiny world: a state, a clock, and a deterministic id maker. */
function world() {
  let n = 0;
  const w = {
    state: P.emptyState(),
    now: T0,
    events: [],
    ctx() {
      return { now: w.now, newId: () => `m${String(++n).padStart(31, "0")}` };
    },
    run(result) {
      w.state = result.state;
      w.events.push(...result.events);
      return result.view;
    },
    play(sid, req = {}) {
      return w.run(P.play(w.state, who(sid), req, w.ctx()));
    },
    poll(sid) {
      return w.run(P.poll(w.state, sid, w.ctx()));
    },
    /** A tab in the background polling (document.visibilityState === "hidden"). */
    hiddenPoll(sid) {
      return w.run(P.poll(w.state, sid, w.ctx(), false));
    },
    cancel(sid) {
      return w.run(P.cancel(w.state, sid, w.ctx()));
    },
    act(sid, action) {
      return w.run(P.act(w.state, sid, action, w.ctx()));
    },
    /** A ping's button, sent by the service worker: not a page in view. */
    pingAct(sid, action) {
      return w.run(P.act(w.state, sid, action, w.ctx(), false));
    },
    leaveEverything(sid) {
      return w.run(P.leaveEverything(w.state, sid, w.ctx()));
    },
    pings(sid, on, branch = "stable") {
      return w.run(P.setLookingPings(w.state, sid, on, branch, w.ctx()));
    },
    /** What the Durable Object does when a push subscription is saved or dropped. */
    pushFlag(sid, on) {
      w.state = P.setPushFlag(w.state, sid, on);
    },
    advance(ms) {
      w.now += ms;
    },
    count(key) {
      return w.events.filter((e) => e.type === "count" && e.key === key).length;
    },
  };
  return w;
}

function who(sid) {
  return { sid, name: sid.toUpperCase(), avatar: "" };
}

const PS = (sids) => sids.map((s) => s).join(",");

// 1. First Play searches; second Play matches with the first as host.
await check("first player searches, second matches with first as host", () => {
  const w = world();
  const a = w.play("a");
  assert.equal(a.state, "searching");
  assert.equal(a.lookingCount, 1);
  w.advance(12 * SEC);
  const b = w.play("b");
  assert.equal(b.state, "matched");
  assert.equal(b.match.hostSid, "a");
  assert.equal(b.match.youAreHost, false);
  assert.equal(PS(b.match.members.map((m) => m.sid)), "a,b");
  assert.equal(b.match.seatsLeft, 2);
  const a2 = w.poll("a");
  assert.equal(a2.state, "matched");
  assert.equal(a2.match.youAreHost, true);
  assert.equal(w.count("matched"), 1);
  assert.equal(w.count("wait_lt30s"), 1, "a waited 12s");
  assert.equal(w.count("wait_lt10s"), 1, "b matched instantly");
  assert.equal(a2.lookingCount, 0);
  assert.equal(a2.playingCount, 2);
});

// 2. Repeat taps are idempotent; nobody matches themselves.
await check("repeat taps are idempotent and never self-match", () => {
  const w = world();
  w.play("a");
  w.advance(5 * SEC);
  const again = w.play("a");
  assert.equal(again.state, "searching");
  assert.equal(again.ticket.createdAt, T0, "keeps original queue time");
  assert.equal(again.lookingCount, 1);
  assert.equal(Object.keys(w.state.matches).length, 0);
  w.play("b");
  const matchId = Object.keys(w.state.matches)[0];
  const tapAgain = w.play("b");
  assert.equal(tapAgain.match.matchId, matchId, "same match returned");
  assert.equal(Object.keys(w.state.matches).length, 1);
  assert.equal(w.count("play_tap"), 3, "repeat tap while matched is not a new tap");
});

// 3. Players 3 and 4 join the open match; player 5 gets a new ticket.
await check("players 3 and 4 join the gathering party, player 5 waits", () => {
  const w = world();
  w.play("a");
  w.play("b");
  w.advance(30 * SEC);
  assert.equal(w.play("c").state, "matched");
  const d = w.play("d");
  assert.equal(d.match.members.length, 4);
  assert.equal(d.match.seatsLeft, 0);
  const e = w.play("e");
  assert.equal(e.state, "searching");
  assert.equal(w.count("joined_party"), 2);
});

// 4. A locked match is never joined.
await check("a party that started its run is never joined", () => {
  const w = world();
  w.play("a");
  w.play("b");
  const started = w.act("a", "in_game");
  assert.equal(started.state, "in_game");
  assert.equal(started.match.locked, true);
  assert.equal(w.play("c").state, "searching");
});

// 5. Players on different branches never match.
await check("stable and beta players never match", () => {
  const w = world();
  w.play("a", { branch: "stable" });
  const b = w.play("b", { branch: "beta" });
  assert.equal(b.state, "searching");
  assert.equal(b.lookingByBranch.stable, 1);
  assert.equal(b.lookingByBranch.beta, 1);
  assert.equal(w.play("c", { branch: "beta" }).match.hostSid, "b");
});

// 6. Tickets expire after 90 s without a poll, or after the chosen stay with pings on.
await check("waiting players expire: 90 s without push, the default hour with push", () => {
  const w = world();
  w.play("a");
  w.play("p", { branch: "beta", push: true });
  w.advance(60 * SEC);
  w.poll("a");
  w.advance(60 * SEC);
  assert.equal(w.poll("a").state, "searching", "polling keeps a alive");
  w.advance(91 * SEC);
  assert.equal(w.poll("x").lookingCount, 1, "a expired, p still waiting");
  assert.ok(!w.state.tickets.a);
  w.advance(P.DEFAULT_STAY_MIN * MIN - 5 * MIN); // 58.5 minutes since p tapped Play
  assert.equal(w.poll("x").lookingCount, 1, "p is still in line just before the hour");
  w.advance(3 * MIN);
  assert.equal(w.poll("x").lookingCount, 0, "p expired after the default hour");
  assert.equal(w.count("expired"), 2);
});

// 7. When the host leaves, the host role passes on.
await check("host leaving hands the role to the next-earliest player", () => {
  const w = world();
  w.play("a");
  w.advance(SEC);
  w.play("b");
  w.advance(SEC);
  w.play("c");
  w.act("a", "hosting");
  const left = w.act("a", "leave");
  assert.equal(left.state, "idle", "the leaver is not put back in line");
  const b = w.poll("b");
  assert.equal(b.match.hostSid, "b");
  assert.equal(b.match.youAreHost, true);
  assert.equal(b.match.hostHosting, false);
  assert.equal(b.notice, "host_changed");
  assert.equal(b.match.members.length, 2);
});

// 8. A dissolved match re-queues the survivor at their original queue time.
await check("a party that falls apart re-queues the survivor at their old place", () => {
  const w = world();
  w.play("a");
  w.advance(40 * SEC);
  w.play("b");
  w.act("b", "leave");
  const a = w.poll("a");
  assert.equal(a.state, "searching");
  assert.equal(a.ticket.createdAt, T0);
  assert.equal(a.notice, "partner_left");
  assert.equal(w.count("partner_left"), 1);
  w.advance(5 * SEC);
  const c = w.play("c");
  assert.equal(c.match.hostSid, "a", "a waited longest, so a hosts");
});

await check("a re-queued survivor is matched with someone already waiting", () => {
  const w = world();
  w.play("a", { branch: "beta" });
  w.play("b", { branch: "beta" });
  w.play("c", { branch: "stable" });
  w.play("d", { branch: "stable" });
  w.play("e", { branch: "beta" }); // joins a+b's party
  w.act("a", "leave");
  w.act("b", "leave"); // only e is left in the beta party → dissolve
  const e = w.poll("e");
  assert.equal(e.state, "searching");
  w.play("f", { branch: "beta" });
  assert.equal(w.poll("e").match.hostSid, "e");
});

// 9. in_game is counted once per match.
await check("starting the run counts once and writes history for everyone", () => {
  const w = world();
  w.play("a");
  w.play("b");
  w.act("b", "in_game");
  assert.equal(w.poll("b").state, "matched", "a joiner alone does not lock");
  w.act("a", "in_game");
  w.act("a", "in_game");
  w.act("b", "in_game");
  assert.equal(w.count("in_game"), 1);
  const history = w.events.filter((e) => e.type === "history");
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((h) => h.role).sort(), ["host", "member"]);
});

await check("every member saying 'we're in' locks the party too", () => {
  const w = world();
  w.play("a");
  w.play("b");
  w.act("b", "in_game");
  w.act("a", "in_game");
  assert.equal(w.poll("b").state, "in_game");
});

// 10. Member timeout applies only before the run starts.
await check("silent members time out before the run, not during it", () => {
  const w = world();
  w.play("a");
  w.play("b");
  w.play("c");
  w.advance(2 * MIN);
  w.poll("a");
  w.poll("b");
  w.advance(2 * MIN); // c silent for 4 min > 3 min
  const a = w.poll("a");
  assert.equal(a.match.members.length, 2);
  assert.ok(!a.match.members.some((m) => m.sid === "c"));

  w.act("a", "in_game");
  w.advance(60 * MIN);
  assert.equal(w.poll("a").state, "in_game", "no liveness checks once in game");
});

await check("someone matched while away gets a push and a longer grace", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(2 * MIN); // a closed the tab
  w.play("b");
  const pushes = w.events.filter((e) => e.type === "push_matched");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].sid, "a");
  w.advance(4 * MIN);
  w.poll("b");
  assert.equal(w.poll("a").state, "matched", "a still has a seat after 4 min");
  w.advance(4 * MIN);
  w.poll("b");
  const b = w.poll("b");
  assert.equal(b.state, "searching", "a never came back; b re-queued");
});

// The service worker asks "what happened?" when a push arrives. That read
// must not count as the player coming back, or it cuts their grace short.
await check("a peek shows your party without marking you as back", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(2 * MIN); // a closed the tab
  w.play("b"); // matched while away: a gets a push and five minutes to return
  const before = JSON.stringify(w.state);
  const seen = P.peek(w.state, "a");
  assert.equal(seen.state, "matched");
  assert.equal(seen.match.members.length, 2);
  assert.equal(JSON.stringify(w.state), before, "peeking changes nothing");
  w.advance(4 * MIN);
  w.poll("b");
  assert.equal(P.peek(w.state, "a").state, "matched", "four minutes on, a still has the seat");

  // The same story with a poll at the moment of the push, which is what the
  // service worker used to do: the shorter three-minute clock starts.
  const polled = world();
  polled.play("a", { push: true });
  polled.advance(2 * MIN);
  polled.play("b");
  polled.poll("a");
  polled.advance(4 * MIN);
  assert.equal(polled.poll("b").state, "searching", "a was dropped after three minutes and b went back in line");
});

await check("nobody gets a push while they are watching", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(5 * SEC);
  w.play("b", { push: true });
  assert.equal(w.events.filter((e) => e.type === "push_matched").length, 0);
});

// Pings switched on (or off) while already waiting change the ticket in place.
await check("pings turned on mid-search keep the place in line, last 10 min and push", () => {
  const w = world();
  w.play("a"); // tapped Play without pings: a 90 s ticket
  w.advance(30 * SEC);
  w.poll("a");
  w.pushFlag("a", true); // "Ping me instead"
  const a = w.poll("a");
  assert.equal(a.state, "searching");
  assert.equal(a.ticket.push, true);
  assert.equal(a.ticket.createdAt, T0, "same place in line");
  assert.equal(w.count("play_tap"), 1, "not counted as a second tap");
  w.advance(5 * MIN); // a closed the tab, as the card said they could
  assert.equal(w.poll("x").lookingCount, 1, "still in line after 5 min of silence");
  const b = w.play("b");
  assert.equal(b.match.hostSid, "a", "a waited longest, so a hosts");
  const pushes = w.events.filter((e) => e.type === "push_matched");
  assert.deepEqual(pushes.map((p) => p.sid), ["a"], "a is told the party formed");
});

await check("pings turned off mid-search put the ticket back on the 90 s clock", () => {
  const w = world();
  w.play("a", { push: true });
  w.pushFlag("a", false);
  assert.equal(w.poll("a").ticket.push, false);
  w.advance(91 * SEC);
  assert.equal(w.poll("x").lookingCount, 0, "no pings and no polls: out of line");
});

await check("a party seat follows the push flag too, and strangers are untouched", () => {
  const w = world();
  w.play("a", { push: true });
  w.play("b");
  w.pushFlag("a", false); // a signed out: nothing left to ping
  w.pushFlag("nobody", true);
  w.act("b", "leave"); // the party dissolves and a is put back in line
  assert.equal(w.state.tickets.a.push, false, "re-queued without the long lifetime");
  assert.equal(w.state.tickets.nobody, undefined);
});

// 11. Push throttles hold.
await check("'someone is looking' pings are throttled per recipient and sender", () => {
  const w = world();
  w.pings("r1", true);
  w.pings("r2", true);
  w.pings("rb", true, "beta");
  w.play("a");
  let looks = w.events.filter((e) => e.type === "push_looking");
  assert.equal(looks.length, 1);
  assert.deepEqual([...looks[0].sids].sort(), ["r1", "r2"], "only same-branch subscribers");
  w.cancel("a");
  w.advance(MIN);
  w.play("a");
  looks = w.events.filter((e) => e.type === "push_looking");
  assert.equal(looks.length, 1, "sender cooldown");
  w.cancel("a");
  w.advance(11 * MIN);
  w.play("a");
  looks = w.events.filter((e) => e.type === "push_looking");
  assert.equal(looks.length, 1, "recipient cooldown still holds at 12 min");
  w.cancel("a");
  w.advance(20 * MIN);
  w.play("a");
  looks = w.events.filter((e) => e.type === "push_looking");
  assert.equal(looks.length, 2, "after 30 min recipients can be pinged again");
});

await check("no ping when someone is already waiting, and never to yourself", () => {
  const w = world();
  w.pings("a", true);
  w.pings("r", true);
  w.play("x", { branch: "beta" });
  w.play("a");
  const looks = w.events.filter((e) => e.type === "push_looking");
  assert.equal(looks.length, 1);
  assert.deepEqual(looks[0].sids, ["r"]);
  w.play("b"); // matches a, no new ping
  assert.equal(w.events.filter((e) => e.type === "push_looking").length, 1);
});

await check("input is cleaned: unknown hero and branch fall back safely", () => {
  const w = world();
  const v = w.play("a", { character: "<script>", branch: "nightly", push: "yes" });
  assert.equal(v.ticket.character, undefined);
  assert.equal(v.ticket.branch, "stable");
  assert.equal(v.ticket.push, false);
  assert.equal(w.play("b", { character: "Fool" }).match.members[1].character, "fool");
});

await check("cancel removes the ticket and counts once", () => {
  const w = world();
  w.play("a");
  assert.equal(w.cancel("a").state, "idle");
  w.cancel("a");
  assert.equal(w.count("cancel"), 1);
  assert.equal(P.isQuiet(w.state), true);
});

await check("old matches are forgotten after 4 hours", () => {
  const w = world();
  w.play("a");
  w.play("b");
  w.act("a", "in_game");
  w.advance(4 * 60 * MIN + SEC);
  assert.equal(w.poll("a").state, "idle");
  assert.equal(P.isQuiet(w.state), true);
});

// Push: the VAPID header must verify against the public key, and stored
// endpoints must be real push services (no SSRF through a saved URL).
await check("push requests carry a valid VAPID signature and no payload", async () => {
  const { webcrypto } = await import("node:crypto");
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = Buffer.from(new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey))).toString("base64url");
  const env = { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_JWK: JSON.stringify(await webcrypto.subtle.exportKey("jwk", pair.privateKey)) };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(null, { status: 201 });
  };
  try {
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc123", savedAt: "" };
    assert.equal(await P.Push.sendPush(env, sub), "sent");
    assert.equal(seen.length, 1);
    const auth = seen[0].init.headers.authorization;
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
    assert.ok(m, `header shape: ${auth}`);
    assert.equal(m[4], pub);
    const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.sub, "https://spirevault.app");
    assert.ok(claims.exp > Date.now() / 1000);
    const ok = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      Buffer.from(m[3], "base64url"),
      new TextEncoder().encode(`${m[1]}.${m[2]}`),
    );
    assert.ok(ok, "signature verifies with the public key");
    assert.equal(seen[0].init.body, undefined, "no payload");

    globalThis.fetch = async () => new Response(null, { status: 410 });
    assert.equal(await P.Push.sendPush(env, sub), "gone", "410 means drop the subscription");
    assert.equal(await P.Push.sendPush({}, sub), "disabled", "no keys → nothing sent");
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("only real push services are accepted as endpoints", () => {
  assert.equal(P.Push.isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/x"), true);
  assert.equal(P.Push.isAllowedPushEndpoint("https://web.push.apple.com/abc"), true);
  assert.equal(P.Push.isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x"), true);
  assert.equal(P.Push.isAllowedPushEndpoint("https://evil.example/fcm.googleapis.com"), false);
  assert.equal(P.Push.isAllowedPushEndpoint("http://fcm.googleapis.com/x"), false);
  assert.equal(P.Push.isAllowedPushEndpoint("https://169.254.169.254/latest"), false);
  assert.equal(P.Push.isAllowedPushEndpoint(42), false);
});

// ---- Push queue: pings go out in batches under the subrequest cap ----------
// Cloudflare caps outbound requests per invocation (50 on Workers Free, 1,000
// on Paid). A "someone's looking" ping fans out to every opted-in player, so
// the Durable Object sends at most PUSH_BATCH_SIZE per invocation and drains
// the rest from its alarm.

/** A fake subscription store and push service that counts sends per invocation. */
function pushWorld(sids, goneSids = []) {
  const subs = new Map(sids.map((sid) => [sid, { endpoint: `https://fcm.googleapis.com/fcm/send/${sid}`, keys: {} }]));
  const sent = [];
  const deleted = [];
  let invocation = 0;
  const perInvocation = [];
  const deps = {
    getSub: async (sid) => subs.get(sid) ?? null,
    deleteSub: async (sid) => { subs.delete(sid); deleted.push(sid); },
    send: async (sub) => {
      const sid = sub.endpoint.split("/").pop();
      sent.push(sid);
      perInvocation[invocation] = (perInvocation[invocation] ?? 0) + 1;
      return goneSids.includes(sid) ? "gone" : "sent";
    },
  };
  return { subs, sent, deleted, perInvocation, deps, next: () => { invocation++; } };
}

const sidsN = (n, p = "7656119800000") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, "0")}`);

await check("the push batch stays under the Free plan's 50 subrequests, with headroom", () => {
  assert.ok(P.PushQ.PUSH_BATCH_SIZE >= 10 && P.PushQ.PUSH_BATCH_SIZE <= 45, `batch ${P.PushQ.PUSH_BATCH_SIZE}`);
});

await check("a queued player is pinged once, and a match jumps ahead of looking pings", () => {
  let q = P.PushQ.enqueuePushes([], [["a", "looking"], ["b", "looking"], ["c", "looking"]]);
  q = P.PushQ.enqueuePushes(q, [["a", "looking"], ["b", "matched"], ["d", "matched"]]);
  assert.deepEqual(q.map((e) => `${e.sid}:${e.kind}`), ["b:matched", "d:matched", "a:looking", "c:looking"]);
  const again = P.PushQ.enqueuePushes(q, [["b", "looking"]]);
  assert.deepEqual(again.map((e) => `${e.sid}:${e.kind}`), ["b:matched", "d:matched", "a:looking", "c:looking"], "a match is never downgraded");
  assert.deepEqual(q.map((e) => e.sid), ["b", "d", "a", "c"], "enqueue returns a new queue, never edits the old one");
});

await check("takeBatch takes at most one batch and leaves the rest in order", () => {
  const q = P.PushQ.enqueuePushes([], sidsN(95).map((sid) => [sid, "looking"]));
  const { batch, rest } = P.PushQ.takeBatch(q);
  assert.equal(batch.length, P.PushQ.PUSH_BATCH_SIZE);
  assert.equal(rest.length, 95 - P.PushQ.PUSH_BATCH_SIZE);
  assert.equal(rest[0].sid, q[P.PushQ.PUSH_BATCH_SIZE].sid);
  assert.deepEqual(P.PushQ.takeBatch([]), { batch: [], rest: [] });
});

await check("120 looking subscribers are all pinged exactly once, never more than one batch per invocation", async () => {
  const sids = sidsN(120);
  const w = pushWorld(sids);
  let q = P.PushQ.enqueuePushes([], sids.map((sid) => [sid, "looking"]));
  let invocations = 0;
  while (q.length > 0) {
    const { batch, rest } = P.PushQ.takeBatch(q);
    q = rest;
    await P.PushQ.sendPushBatch(batch, w.deps);
    invocations++;
    w.next();
    assert.ok(invocations < 50, "the queue drains");
  }
  assert.equal(invocations, Math.ceil(120 / P.PushQ.PUSH_BATCH_SIZE));
  assert.ok(w.perInvocation.every((n) => n <= P.PushQ.PUSH_BATCH_SIZE), `per invocation: ${w.perInvocation.join(", ")}`);
  assert.equal(w.sent.length, 120);
  assert.equal(new Set(w.sent).size, 120, "nobody pinged twice");
});

await check("a match during a big looking fan-out goes out in the very next batch", async () => {
  const sids = sidsN(300);
  const w = pushWorld([...sids, "76561198999999999"]);
  let q = P.PushQ.enqueuePushes([], sids.map((sid) => [sid, "looking"]));
  ({ rest: q } = P.PushQ.takeBatch(q));
  q = P.PushQ.enqueuePushes(q, [["76561198999999999", "matched"]]);
  const { batch } = P.PushQ.takeBatch(q);
  assert.equal(batch[0].sid, "76561198999999999");
  await P.PushQ.sendPushBatch(batch, w.deps);
  assert.equal(w.sent[0], "76561198999999999");
});

await check("a gone subscription is deleted and a missing one costs no request", async () => {
  const w = pushWorld(["s1", "s2", "s3"], ["s2"]);
  const q = P.PushQ.enqueuePushes([], [["s1", "looking"], ["s2", "looking"], ["nosub", "looking"], ["s3", "matched"]]);
  const out = await P.PushQ.sendPushBatch(q, w.deps);
  assert.deepEqual(w.sent, ["s3", "s1", "s2"], "matched first; no request for a player without a subscription");
  assert.deepEqual(w.deleted, ["s2"]);
  assert.deepEqual(out, { sent: 2, gone: 1, skipped: 1, failed: 0 });
});

await check("one failing push does not stop the rest of its batch", async () => {
  const w = pushWorld(["s1", "s2"]);
  const deps = { ...w.deps, send: async (sub) => { if (sub.endpoint.endsWith("s1")) throw new Error("network"); return w.deps.send(sub); } };
  const out = await P.PushQ.sendPushBatch(P.PushQ.enqueuePushes([], [["s1", "looking"], ["s2", "looking"]]), deps);
  assert.deepEqual(w.sent, ["s2"]);
  assert.deepEqual(out, { sent: 1, gone: 0, skipped: 0, failed: 1 });
});

// ---- Walking away: visible presence, the chosen stay, "On my way" ----------
// The case Corey named: queue on desktop, walk away, find out on the phone.
// A tab in the background keeps polling, so "away" has to mean "the page is
// not in view", not "no poll lately".

await check("a hidden tab holds the place, and the match still pings the player", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(30 * SEC);
  w.hiddenPoll("a"); // a walked away with the tab open behind other windows
  assert.equal(w.hiddenPoll("a").state, "searching");
  w.play("b");
  const pushes = w.events.filter((e) => e.type === "push_matched");
  assert.deepEqual(pushes.map((p) => p.sid), ["a"], "a is pinged even though the tab still polls");
});

await check("a page in view is never pinged, hidden polls or not", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(10 * SEC);
  w.poll("a");
  w.play("b");
  assert.equal(w.events.filter((e) => e.type === "push_matched").length, 0);
});

await check("hidden polls don't stretch a pinged search past the stay; it ends with one ping", () => {
  const w = world();
  w.play("a", { push: true, stay: 30 });
  assert.equal(w.poll("a").ticket.stayMs, 30 * MIN);
  for (let t = 0; t < 29; t++) {
    w.advance(MIN);
    w.hiddenPoll("a");
  }
  assert.equal(w.hiddenPoll("a").state, "searching", "29 minutes after the last look: still in line");
  w.advance(2 * MIN);
  const after = w.hiddenPoll("a");
  assert.equal(after.state, "idle", "31 minutes after the last look: the search is over");
  assert.equal(after.endedAt, w.now, "the view says when it ended");
  const ended = w.events.filter((e) => e.type === "push_ended");
  assert.deepEqual(ended.map((e) => e.sid), ["a"], "exactly one 'search ended' ping");
  assert.equal(P.peek(w.state, "a").endedAt, w.now, "the service worker's peek sees it too");
  w.advance(P.ENDED_NOTICE_MS + MIN);
  w.poll("x");
  assert.equal(P.peek(w.state, "a").endedAt, undefined, "the notice is forgotten after a while");
});

await check("tapping Play again clears 'search ended'", () => {
  const w = world();
  w.play("a", { push: true, stay: 30 });
  w.advance(31 * MIN);
  w.poll("x");
  assert.ok(P.peek(w.state, "a").endedAt);
  const again = w.play("a", { push: true });
  assert.equal(again.state, "searching");
  assert.equal(again.endedAt, undefined);
});

await check("looking at the page restarts the stay", () => {
  const w = world();
  w.play("a", { push: true, stay: 30 });
  w.advance(25 * MIN);
  w.poll("a"); // came back to the desk and looked
  w.advance(25 * MIN);
  assert.equal(w.hiddenPoll("a").state, "searching", "50 minutes in, 25 after the last look");
});

await check("without pings a background tab keeps the ticket, and nothing pings when it lapses", () => {
  const w = world();
  w.play("a");
  for (let t = 0; t < 10; t++) {
    w.advance(MIN);
    w.hiddenPoll("a");
  }
  assert.equal(w.hiddenPoll("a").state, "searching", "the old rule: any poll keeps a ticket without pings");
  w.advance(91 * SEC);
  w.poll("x");
  assert.ok(!w.state.tickets.a);
  assert.equal(w.events.filter((e) => e.type === "push_ended").length, 0, "no pings were on, so no ping");
});

await check("only the offered stays are accepted; anything else is the default hour", () => {
  for (const min of P.STAY_CHOICES_MIN) assert.equal(P.sanitizeStay(min), min * MIN);
  assert.equal(P.sanitizeStay("120"), 120 * MIN);
  for (const bad of [0, 5, 59, 1e9, -30, "lots", null, undefined, {}]) {
    assert.equal(P.sanitizeStay(bad), P.DEFAULT_STAY_MIN * MIN, `rejects ${JSON.stringify(bad)}`);
  }
  const w = world();
  assert.equal(w.play("a", { push: true, stay: 1e9 }).ticket.stayMs, P.DEFAULT_STAY_MIN * MIN);
  assert.equal(w.play("b2", { branch: "beta" }).ticket.stayMs, undefined, "no pings, no stay");
});

await check("pinged while away: hidden polls don't hold the seat past the grace", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(MIN);
  w.hiddenPoll("a");
  w.play("b"); // matched while a's tab is in the background
  for (let t = 0; t < 14; t++) {
    w.advance(20 * SEC);
    w.hiddenPoll("a");
    w.poll("b");
  }
  assert.equal(w.poll("b").state, "matched", "4 min 40 s in: a still has the grace");
  w.advance(40 * SEC);
  w.hiddenPoll("a");
  const b = w.poll("b");
  assert.equal(b.state, "searching", "5 min 20 s and a never looked: b goes back in line instead of waiting all night");
});

await check("without pings, a hidden tab still holds the seat after a match made while it was hidden", () => {
  const w = world();
  w.play("a"); // no pings
  w.advance(30 * SEC);
  w.hiddenPoll("a"); // tabbed out to the game, page still polling
  w.play("b");
  assert.equal(w.events.filter((e) => e.type === "push_matched").length, 0, "nobody to ping");
  for (let t = 0; t < 30; t++) {
    w.advance(20 * SEC);
    w.hiddenPoll("a");
    w.poll("b");
  }
  assert.equal(w.poll("b").state, "matched", "ten minutes of hidden polls: a was never told, so a keeps the seat");
});

await check("On my way restarts the grace once, not every tap", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(2 * MIN);
  w.play("b");
  w.advance(4 * MIN);
  w.poll("b");
  w.pingAct("a", "omw");
  w.advance(4 * MIN);
  w.poll("b");
  w.pingAct("a", "omw"); // again, hoping to hold the seat longer
  w.advance(2 * MIN);
  assert.equal(w.poll("b").state, "searching", "6 minutes after the first On my way: dropped");
});

await check("a hidden poll on a ticket saved before visibility doesn't stretch its stay", () => {
  const old = {
    tickets: { a: { sid: "a", name: "A", branch: "stable", push: true, createdAt: T0, lastSeenAt: T0 } },
    matches: {},
    pings: {},
    fanouts: {},
  };
  const ctx = (now) => ({ now, newId: () => "m".padEnd(32, "0") });
  const polled = P.poll(old, "a", ctx(T0 + 30 * MIN), false);
  assert.equal(polled.state.tickets.a.lastVisibleAt, T0, "last in view stays at the old lastSeenAt");
  const later = P.poll(polled.state, "a", ctx(T0 + 61 * MIN), false);
  assert.equal(later.view.state, "idle", "the hour ran from the last real look, not from the hidden poll");
});

await check("someone who looked keeps the seat while tabbed out to Steam or the game", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(5 * SEC);
  w.play("b");
  w.poll("a"); // both had the page in view at the match
  for (let t = 0; t < 30; t++) {
    w.advance(20 * SEC);
    w.hiddenPoll("a"); // launching the game, adding friends on Steam
    w.poll("b");
  }
  assert.equal(w.poll("b").state, "matched", "ten minutes of hidden polls: a's seat holds");
});

await check("On my way: the party sees it and the grace starts again", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(2 * MIN); // a closed the tab
  w.play("b");
  w.advance(4 * MIN);
  w.poll("b");
  const omw = w.pingAct("a", "omw");
  assert.equal(omw.state, "matched");
  const seenByB = w.poll("b").match.members.find((m) => m.sid === "a");
  assert.equal(seenByB.coming, true, "b sees a coming");
  w.advance(4 * MIN);
  assert.equal(w.poll("b").state, "matched", "8 minutes after the match, 4 after On my way: still a party");
  const back = w.poll("a"); // a reached the desk
  assert.equal(back.match.members.find((m) => m.sid === "a").coming, false, "back at the page: no longer 'coming'");
  w.advance(4 * MIN);
  assert.equal(w.poll("b").state, "searching", "a looked once and then went silent for 4 minutes: dropped, b back in line");
});

await check("Pass on a ping gives the seat back at once", () => {
  const w = world();
  w.play("a", { push: true });
  w.advance(2 * MIN);
  w.play("b");
  const passed = w.pingAct("a", "leave");
  assert.equal(passed.state, "idle", "a is out");
  assert.equal(w.poll("b").state, "searching", "b is back in line right away, not after five minutes");
});

await check("signed out everywhere: out of line and out of an unstarted party, a run under way untouched", () => {
  const w = world();
  w.play("a");
  assert.equal(w.leaveEverything("a").state, "idle");
  assert.ok(!w.state.tickets.a);

  w.play("b");
  w.play("c");
  w.leaveEverything("b");
  assert.equal(w.poll("c").state, "searching", "the party dissolved and c went back in line");

  w.play("d");
  w.act("c", "in_game");
  assert.equal(w.poll("c").state, "in_game");
  w.leaveEverything("c");
  assert.equal(w.poll("d").state, "in_game", "a run already under way is left as it is");
});

await check("state saved before visibility existed still behaves (lastSeenAt stands in, no 'ended' map)", () => {
  const old = {
    tickets: { a: { sid: "a", name: "A", branch: "stable", push: true, createdAt: T0, lastSeenAt: T0 } },
    matches: {},
    pings: {},
    fanouts: {},
  };
  const kept = P.poll(old, "x", { now: T0 + 30 * MIN, newId: () => "m".padEnd(32, "0") });
  assert.equal(kept.view.lookingCount, 1, "an old pinged ticket gets the default hour");
  const gone = P.poll(old, "x", { now: T0 + 61 * MIN, newId: () => "m".padEnd(32, "0") });
  assert.equal(gone.view.lookingCount, 0);
  assert.ok(gone.state.ended.a, "the ended map is created on the fly");
});

// ---- Devices: every place a player turned pings on ------------------------

const sub = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dev-${n}`, keys: {}, savedAt: new Date(T0).toISOString() });
async function device(n, seenAt = T0) {
  return { id: await P.Dev.deviceIdFor(sub(n).endpoint), kind: "webpush", sub: sub(n), label: `Device ${n}`, createdAt: seenAt, lastSeenAt: seenAt };
}

await check("a device id is a stable 16-hex hash of its endpoint", async () => {
  const a1 = await P.Dev.deviceIdFor(sub(1).endpoint);
  assert.match(a1, /^[0-9a-f]{16}$/);
  assert.equal(await P.Dev.deviceIdFor(sub(1).endpoint), a1, "same endpoint, same id");
  assert.notEqual(await P.Dev.deviceIdFor(sub(2).endpoint), a1);
  assert.equal(P.Dev.isDeviceId(a1), true);
  assert.equal(P.Dev.isDeviceId("../../etc"), false);
  assert.equal(P.Dev.isDeviceId(a1 + "0"), false);
});

await check("turning pings on twice in one browser refreshes it; a second browser is added", async () => {
  const desk = await device(1, T0);
  let list = P.Dev.upsertDevice([], desk);
  const frozen = JSON.stringify(list);
  const again = P.Dev.upsertDevice(list, { ...desk, label: "Chrome on Mac", lastSeenAt: T0 + MIN, createdAt: T0 + MIN });
  assert.equal(again.length, 1, "same endpoint: still one device");
  assert.equal(again[0].createdAt, T0, "first-seen time kept");
  assert.equal(again[0].label, "Chrome on Mac");
  assert.equal(JSON.stringify(list), frozen, "the old list is never edited");
  list = P.Dev.upsertDevice(again, await device(2, T0 + 2 * MIN));
  assert.equal(list.length, 2);
  assert.equal(list[0].label, "Device 2", "most recently seen first");
  assert.equal(P.Dev.removeDevice(list, list[0].id).length, 1);
  assert.equal(P.Dev.findDevice(list, again[0].id).label, "Chrome on Mac");
});

await check("past eight devices the one seen longest ago falls off", async () => {
  let list = [];
  for (let n = 0; n < P.Dev.MAX_DEVICES + 2; n++) list = P.Dev.upsertDevice(list, await device(n, T0 + n * MIN));
  assert.equal(list.length, P.Dev.MAX_DEVICES);
  const labels = list.map((d) => d.label);
  assert.ok(!labels.includes("Device 0") && !labels.includes("Device 1"), "the two oldest are gone");
  assert.ok(labels.includes(`Device ${P.Dev.MAX_DEVICES + 1}`));
});

await check("the old single subscription becomes the first device", async () => {
  const legacy = { endpoint: "https://web.push.apple.com/abc", keys: {}, savedAt: new Date(T0 - 3 * 86_400_000).toISOString() };
  const d = P.Dev.legacyDevice(legacy, "0123456789abcdef", T0);
  assert.equal(d.createdAt, T0 - 3 * 86_400_000);
  assert.equal(d.kind, "webpush");
  assert.equal(P.Dev.legacyDevice({ ...legacy, savedAt: "garbage" }, "0123456789abcdef", T0).createdAt, T0);
});

await check("the Devices list never shows endpoints or keys", async () => {
  const views = P.Dev.deviceViews([await device(1)]);
  assert.deepEqual(Object.keys(views[0]).sort(), ["createdAt", "id", "kind", "label", "lastSeenAt"]);
});

await check("device names come from the browser, short and never the raw User-Agent", () => {
  const cases = [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome on Mac"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", "Firefox on Linux"],
    ["", "A browser"],
    [null, "A browser"],
  ];
  for (const [ua, want] of cases) assert.equal(P.Dev.deviceLabel(ua), want, String(ua).slice(0, 40));
});

await check("a player with pings on in two places is queued once per device", () => {
  let q = P.PushQ.enqueuePushes([], [["a", "looking", "desk"], ["a", "looking", "phone"], ["b", "looking", "phone"]]);
  q = P.PushQ.enqueuePushes(q, [["a", "matched", "desk"], ["a", "matched", "phone"], ["c", "ended", "laptop"]]);
  assert.deepEqual(
    q.map((e) => `${e.sid}:${e.device}:${e.kind}`),
    ["a:desk:matched", "a:phone:matched", "c:laptop:ended", "b:phone:looking"],
    "matched first, then ended, then looking; one entry per device",
  );
  const again = P.PushQ.enqueuePushes(q, [["c", "looking", "laptop"], ["a", "looking", "phone"]]);
  assert.equal(JSON.stringify(again), JSON.stringify(q), "a less urgent ping never downgrades a queued one");
});

await check("a batch counts requests (devices), so many devices never pass the cap", () => {
  const targets = sidsN(30).flatMap((sid) => ["desk", "phone", "tablet"].map((d) => [sid, "looking", d]));
  const q = P.PushQ.enqueuePushes([], targets);
  assert.equal(q.length, 90);
  assert.equal(P.PushQ.takeBatch(q).batch.length, P.PushQ.PUSH_BATCH_SIZE);
});

await check("a gone subscription forgets only that device", async () => {
  const subs = new Map([["a|desk", sub("desk")], ["a|phone", sub("phone")]]);
  const sent = [];
  const deleted = [];
  const deps = {
    getSub: async (sid, d) => subs.get(`${sid}|${d}`) ?? null,
    deleteSub: async (sid, d) => { subs.delete(`${sid}|${d}`); deleted.push(`${sid}|${d}`); },
    send: async (s) => { sent.push(s.endpoint); return s.endpoint.endsWith("desk") ? "gone" : "sent"; },
  };
  const out = await P.PushQ.sendPushBatch(P.PushQ.enqueuePushes([], [["a", "matched", "desk"], ["a", "matched", "phone"]]), deps);
  assert.deepEqual(out, { sent: 1, gone: 1, skipped: 0, failed: 0 });
  assert.deepEqual(deleted, ["a|desk"]);
  assert.ok(subs.has("a|phone"), "the phone still gets pings");
});

console.log(`coop-play: ${passed} checks passed${process.exitCode ? " (with failures above)" : ""}`);
