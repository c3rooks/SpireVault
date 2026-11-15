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
    `export * as Push from ${JSON.stringify(join(SRC, "coop-play-push"))};\n`,
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
    cancel(sid) {
      return w.run(P.cancel(w.state, sid, w.ctx()));
    },
    act(sid, action) {
      return w.run(P.act(w.state, sid, action, w.ctx()));
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

// 6. Tickets expire after 90 s without a poll, or 10 minutes with push on.
await check("waiting players expire: 90 s without push, 10 min with push", () => {
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
  w.advance(10 * MIN);
  assert.equal(w.poll("x").lookingCount, 0, "p expired after 10 min");
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

console.log(`coop-play: ${passed} checks passed${process.exitCode ? " (with failures above)" : ""}`);
