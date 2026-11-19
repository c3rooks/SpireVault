#!/usr/bin/env node
/**
 * Offline checks for the presence heartbeat (`POST /presence`) and the session
 * renewal it shares with `GET /me`: no network, no deployed Worker, no real
 * KV. Requests go through the Worker's own fetch handler, so the routes, the
 * session check and the per-IP limiter are the real ones.
 *
 * What these guard, and why:
 *
 *   · A page that unloads used to send an empty beacon to `POST /presence`.
 *     The Worker parsed it as JSON, threw "Unexpected end of JSON input" and
 *     answered 500, once per page load (seen live on 2026-11-19), after
 *     spending a KV write on the per-IP limiter. A body that says nothing
 *     must be turned away with a 400 and no KV write.
 *
 *   · The Worker runs on about 1,000 KV writes a day shared by every player,
 *     and a heartbeat used to cost four of them every three minutes for
 *     every open tab (limiter key, roster, session, session profile): about
 *     1,900 a day for one tab left open. A heartbeat that changes nothing
 *     must write nothing, the roster row is refreshed once an hour, and a
 *     session is renewed once a day.
 *
 *   · KV takes one write per key per second and throws "KV PUT failed: 429
 *     Too Many Requests" on a second. That is a repeat, not a fault: the
 *     heartbeat must still answer 200, the roster must end up right, and no
 *     write may be added to get there.
 *
 * The KV stand-in below is a Map that throws exactly that error on a second
 * write to one key within a second. There is one clock, moved by hand: the
 * Worker's `Date`, the stand-in's per-key second and the Worker's one wait
 * (before it retries a refused roster write) all read it, so a day of
 * heartbeats runs in a moment and nothing depends on real time.
 *
 * Run: node scripts/verify-presence-burst.mjs   (or `npm run verify:presence`)
 *
 * The source is bundled with esbuild before import, for the reasons given in
 * verify-offline.mjs.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ------------------------------------------------------------ the one clock

const RealDate = Date;
const clock = { now: RealDate.UTC(2026, 10, 19, 12, 0, 0) };
const pass = (ms) => void (clock.now += ms);
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(clock.now);
  }
  static now() {
    return clock.now;
  }
};

// ------------------------------------------------------------ the Worker

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const workDir = mkdtempSync(join(tmpdir(), "vault-verify-presence-"));
process.on("exit", () => rmSync(workDir, { recursive: true, force: true }));

// The entry module pulls in the co-op Durable Object, which extends a class
// only the Workers runtime provides. Nothing here constructs one.
const workersStub = join(workDir, "cloudflare-workers.mjs");
writeFileSync(workersStub, "export class DurableObject {}\n");

const entry = join(workDir, "entry.ts");
writeFileSync(
  entry,
  `export { default as worker } from ${JSON.stringify(join(SRC, "index"))};\n` +
    `export { parsePresenceBody, upsertPresence, deletePresence, timers } from ${JSON.stringify(join(SRC, "presence"))};\n` +
    `export { renewSessionIfDue } from ${JSON.stringify(join(SRC, "auth"))};\n`
);

const bundle = join(workDir, "bundle.mjs");
execFileSync(
  "npx",
  [
    "esbuild",
    entry,
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    `--alias:cloudflare:workers=${workersStub}`,
    `--outfile=${bundle}`,
    "--log-level=error",
  ],
  { stdio: "inherit" }
);

const { worker, parsePresenceBody, upsertPresence, deletePresence, timers, renewSessionIfDue } = await import(
  pathToFileURL(bundle).href
);

const waitByMovingTheClock = async (ms) => pass(ms);
timers.sleep = waitByMovingTheClock;

const ROSTER_KEY = "presence:roster";
const LIMITER_PREFIX = "rl:presence-write:";
const SESSION_PREFIX = "session:";
const PROFILE_PREFIX = "session-profile:";
const KV_WRITE_RATE_MESSAGE = "KV PUT failed: 429 Too Many Requests";
const KV_SAME_KEY_GAP_MS = 1000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The web client sends a heartbeat this often. */
const CLIENT_HEARTBEAT = 3 * MINUTE;
/** A session lives this long after its last renewal. */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** The route lets this many roster joins or changes through in a minute from one address. */
const IP_WRITES_PER_MINUTE = 30;

const steamIdAt = (i) => `7656119800000${String(i).padStart(4, "0")}`;
const tokenFor = (steamID) => `token-for-${steamID}`;
const ALICE = steamIdAt(1);
const BOB = steamIdAt(2);
const HEARTBEAT = JSON.stringify({ status: "looking" });

let passed = 0;

/** Runs one assertion block and records the outcome. Must be awaited. */
async function check(label, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

/**
 * Runs one scenario: the requests it makes, then its checks. A throw while
 * making the requests is reported as a failure instead of ending the run
 * without its summary line.
 */
async function scenario(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`\n  FAILED: ${label} (the scenario itself threw)\n  ${err.stack ?? err}\n`);
    process.exitCode = 1;
  }
}

/**
 * KV stand-in that enforces KV's one-write-per-key-per-second rule. Every
 * player in `players` is signed in, as sessions are on the live Worker today:
 * a session key with no metadata, and a profile beside it.
 *
 * `holdReadsOf` makes every read of one key wait until `count` of them are
 * pending, which is how two requests are made to read the roster before
 * either has written it.
 */
function makeStrictKV({ players = [ALICE, BOB], failWritesWith = null } = {}) {
  const store = new Map();
  const lastWriteAt = new Map();
  const log = { reads: [], writes: [], rejected: [] };
  let hold = null;

  const read = async (key) => {
    log.reads.push(key);
    if (hold && hold.key === key) {
      const held = hold;
      await new Promise((release) => {
        held.waiting.push(release);
        if (held.waiting.length < held.count) return;
        hold = null;
        held.waiting.forEach((go) => go());
      });
    }
    return store.get(key) ?? null;
  };

  const kv = {
    log,
    roster: () => JSON.parse(store.get(ROSTER_KEY)?.value ?? '{"entries":[]}').entries,
    /** Put a value in place as if it had always been there: no write counted. */
    seed: (key, value, metadata = null) => void store.set(key, { value, metadata, expirationTtl: null }),
    readsOf: (key) => log.reads.filter((read) => read === key).length,
    stored: (key) => store.get(key) ?? null,
    holdReadsOf(key, count) {
      hold = { key, count, waiting: [] };
    },
    writesTo: (prefix) => log.writes.filter((key) => key.startsWith(prefix)).length,
    env: {
      PUBLIC_BASE_URL: "https://worker.test",
      STS_APP_ID: "2868840",
      LOBBIES: {
        get: async (key) => (await read(key))?.value ?? null,
        getWithMetadata: async (key) => {
          const held = await read(key);
          return { value: held?.value ?? null, metadata: held?.metadata ?? null };
        },
        put: async (key, value, options = {}) => {
          if (failWritesWith) throw new Error(failWritesWith);
          const last = lastWriteAt.get(key);
          if (last !== undefined && clock.now - last < KV_SAME_KEY_GAP_MS) {
            log.rejected.push(key);
            throw new Error(KV_WRITE_RATE_MESSAGE);
          }
          lastWriteAt.set(key, clock.now);
          store.set(key, { value, metadata: options.metadata ?? null, expirationTtl: options.expirationTtl ?? null });
          log.writes.push(key);
        },
        delete: async (key) => void store.delete(key),
      },
    },
  };
  for (const steamID of players) {
    kv.seed(`${SESSION_PREFIX}${tokenFor(steamID)}`, steamID);
    kv.seed(`${PROFILE_PREFIX}${steamID}`, JSON.stringify({ personaName: `P-${steamID.slice(-4)}` }));
  }
  return kv;
}

/**
 * One request through the Worker's fetch handler, as the Pages proxy sends
 * it. Resolves once the response is in and everything the Worker left running
 * after it (`ctx.waitUntil`) has finished.
 */
async function send(kv, method, path, { steamID, token, body, ip = "203.0.113.7", contentType = "application/json" } = {}) {
  const background = [];
  const ctx = { waitUntil: (promise) => void background.push(promise), passThroughOnException() {} };
  const headers = { "cf-connecting-ip": ip };
  if (body !== undefined) headers["content-type"] = contentType;
  const bearer = token ?? (steamID ? tokenFor(steamID) : null);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await worker.fetch(new Request(`https://worker.test${path}`, { method, headers, body }), kv.env, ctx);
  const text = await response.text();
  await Promise.allSettled(background);
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a plain-text answer, such as the 401 */
  }
  return { status: response.status, headers: response.headers, json, text };
}

/** One `POST /presence`. */
const post = (kv, steamID, body, options = {}) => send(kv, "POST", "/presence", { steamID, body, ...options });

/** Warnings the Worker logs, kept off the preflight output and checked below. */
const warnings = [];
console.warn = (...args) => void warnings.push(args.join(" "));

// --------------------------------------------------------- the body itself

await check("an empty, oversized or meaningless body is not a heartbeat", () => {
  const oversized = JSON.stringify({ status: "looking", note: "x".repeat(5000) });
  for (const raw of ["", "   ", "\n", "{", "not json", "null", "42", '"looking"', "[]", '[{"status":"looking"}]', oversized]) {
    assert.equal(parsePresenceBody(raw), null, `body ${JSON.stringify(raw.slice(0, 30))} should be refused`);
  }
  assert.deepEqual(parsePresenceBody('{"status":"inRun"}'), { status: "inRun" });
  assert.deepEqual(parsePresenceBody("{}"), {});
});

await scenario("the unload beacon", async () => {
  const kv = makeStrictKV();
  const beacon = await post(kv, ALICE, "", { contentType: "text/plain" });
  const cutOff = await post(kv, ALICE, '{"status":');

  await check("the unload beacon (an empty body) gets a 400, not the 500 it used to", () => {
    assert.equal(beacon.status, 400);
    assert.equal(beacon.json.error, "bad_request");
  });
  await check("a body that is not JSON gets the same 400", () => {
    assert.equal(cutOff.status, 400);
  });
  await check("turning them away writes nothing and reads only the session", () => {
    assert.deepEqual(kv.log.writes, []);
    assert.deepEqual([...new Set(kv.log.reads)], [`${SESSION_PREFIX}${tokenFor(ALICE)}`]);
  });

  const stranger = await post(kv, null, HEARTBEAT);

  await check("a heartbeat with no session is still a 401", () => {
    assert.equal(stranger.status, 401);
    assert.deepEqual(kv.log.writes, []);
  });
});

// ------------------------------------------- one player, one tab, over time

await scenario("one tab over an hour", async () => {
  const kv = makeStrictKV();
  const first = await post(kv, ALICE, HEARTBEAT);

  await check("a first heartbeat puts the player on the roster", () => {
    assert.equal(first.status, 200);
    assert.equal(first.json.steamID, ALICE);
    assert.equal(first.json.status, "looking");
    assert.deepEqual(kv.roster(), [first.json]);
  });
  await check("joining the roster writes the roster and the limiter key once each", () => {
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
    assert.equal(kv.writesTo(LIMITER_PREFIX), 1);
  });

  // The rest of a page-load burst: the same player again, at once.
  const writesAfterFirst = kv.log.writes.length;
  const repeat = await post(kv, ALICE, HEARTBEAT);

  await check("a repeat in the same second gets a 200 with the stored row", () => {
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.json, first.json);
  });
  await check("a repeat costs no KV write at all, and KV had nothing to refuse", () => {
    assert.equal(kv.log.writes.length, writesAfterFirst);
    assert.deepEqual(kv.log.rejected, []);
  });

  // The tab stays open: a heartbeat every three minutes for the rest of the hour.
  const quiet = [];
  for (let at = CLIENT_HEARTBEAT; at < HOUR; at += CLIENT_HEARTBEAT) {
    pass(CLIENT_HEARTBEAT);
    quiet.push(await post(kv, ALICE, HEARTBEAT));
  }

  await check("heartbeats that change nothing are answered 200 from the stored row", () => {
    assert.equal(quiet.length, 19);
    assert.ok(quiet.every((answer) => answer.status === 200 && answer.json.updatedAt === first.json.updatedAt));
  });
  await check("an hour of them writes nothing at all", () => {
    assert.equal(kv.log.writes.length, writesAfterFirst);
  });
  await check("and each reads the session once, not a second time to renew it", () => {
    // 21 requests so far: the first reads it again to renew it, the other 20 do not.
    assert.equal(kv.readsOf(`${SESSION_PREFIX}${tokenFor(ALICE)}`), 22);
  });

  pass(CLIENT_HEARTBEAT);
  const refresh = await post(kv, ALICE, HEARTBEAT);

  await check("once the row is an hour old the next heartbeat refreshes it", () => {
    assert.equal(refresh.status, 200);
    assert.equal(Date.parse(refresh.json.updatedAt) - Date.parse(first.json.updatedAt), HOUR);
    assert.deepEqual(kv.roster(), [refresh.json]);
    assert.equal(kv.writesTo(ROSTER_KEY), 2);
  });
  await check("refreshing a player's own row does not touch the limiter or the session", () => {
    assert.equal(kv.writesTo(LIMITER_PREFIX), 1);
    assert.equal(kv.writesTo(SESSION_PREFIX), 1);
    assert.equal(kv.writesTo(PROFILE_PREFIX), 1);
  });
});

await scenario("one tab left open for a day", async () => {
  const kv = makeStrictKV();
  for (let at = 0; at <= DAY; at += CLIENT_HEARTBEAT) {
    const answer = await post(kv, ALICE, HEARTBEAT);
    assert.equal(answer.status, 200, `heartbeat at ${at / MINUTE} min`);
    pass(CLIENT_HEARTBEAT);
  }

  await check("a day of heartbeats refreshes the roster row once an hour", () => {
    assert.equal(kv.writesTo(ROSTER_KEY), 25);
  });
  await check("it renews the session once a day and joins the roster once", () => {
    assert.equal(kv.writesTo(SESSION_PREFIX), 2);
    assert.equal(kv.writesTo(PROFILE_PREFIX), 2);
    assert.equal(kv.writesTo(LIMITER_PREFIX), 1);
  });
  await check("a tab left open for a day costs under 40 KV writes (it was about 1,900)", () => {
    assert.ok(kv.log.writes.length < 40, `${kv.log.writes.length} writes`);
  });
});

await scenario("a heartbeat that changes the row", async () => {
  const kv = makeStrictKV();
  await post(kv, ALICE, HEARTBEAT);
  pass(5 * MINUTE);
  const inRun = await post(kv, ALICE, JSON.stringify({ status: "inRun", note: "act 3" }));

  await check("a new status or note is stored without waiting for the hour", () => {
    assert.equal(inRun.status, 200);
    assert.equal(inRun.json.status, "inRun");
    assert.equal(kv.roster()[0].note, "act 3");
    assert.equal(kv.writesTo(ROSTER_KEY), 2);
  });
  await check("a change is counted by the per-IP limiter, as joining was", () => {
    assert.equal(kv.writesTo(LIMITER_PREFIX), 2);
  });

  pass(20 * SECOND);
  const tooSoon = await post(kv, ALICE, JSON.stringify({ status: "afk" }));

  await check("but never twice within a minute, whatever the body says", () => {
    assert.equal(tooSoon.status, 200);
    assert.equal(tooSoon.json.status, "inRun");
    assert.equal(kv.writesTo(ROSTER_KEY), 2);
  });
});

await scenario("a row from an earlier version", async () => {
  // No note, no stats, a status this version does not know: all read as the defaults.
  const kv = makeStrictKV();
  const tenMinutesAgo = new Date(Date.now() - 10 * MINUTE).toISOString();
  kv.seed(ROSTER_KEY, JSON.stringify({ entries: [{ steamID: ALICE, personaName: "A", status: "browsing", inSTS2: false, updatedAt: tenMinutesAgo }] }));
  const same = await post(kv, ALICE, HEARTBEAT);

  await check("a row missing fields this version writes still counts as unchanged", () => {
    assert.equal(same.status, 200);
    assert.equal(same.json.updatedAt, tenMinutesAgo);
    assert.equal(kv.writesTo(ROSTER_KEY), 0);
  });

  const withStats = await post(kv, ALICE, JSON.stringify({ status: "looking", stats: { totalRuns: 12, wins: 3, maxAscension: 4 } }));

  await check("a body that adds stats to a row without them is a change, and is stored", () => {
    assert.equal(withStats.status, 200);
    assert.deepEqual(kv.roster()[0].stats, { totalRuns: 12, wins: 3, maxAscension: 4 });
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
  });
});

await scenario("a row dated in the future", async () => {
  const kv = makeStrictKV();
  const future = new Date(Date.now() + DAY).toISOString();
  kv.seed(ROSTER_KEY, JSON.stringify({ entries: [{ steamID: ALICE, personaName: "A", status: "looking", note: "", inSTS2: false, updatedAt: future }] }));
  const answer = await post(kv, ALICE, HEARTBEAT);

  await check("a row dated in the future is replaced, not treated as fresh forever", () => {
    assert.equal(answer.status, 200);
    assert.equal(kv.roster()[0].updatedAt, new Date().toISOString());
  });
});

// --------------------------- two heartbeats that race inside the same second

await scenario("two heartbeats racing in one second", async () => {
  // Both requests read the roster before either has written it, so neither
  // sees the other: the page-load burst as KV experiences it.
  const kv = makeStrictKV();
  kv.holdReadsOf(ROSTER_KEY, 2);
  const answers = await Promise.all([post(kv, ALICE, HEARTBEAT), post(kv, ALICE, HEARTBEAT)]);

  await check("two heartbeats racing in one second both get a 200", () => {
    assert.deepEqual(answers.map((a) => a.status), [200, 200]);
    assert.ok(answers.every((a) => a.json.steamID === ALICE));
  });
  await check("KV refused the second write of the roster and of the limiter key", () => {
    assert.equal(kv.log.rejected.filter((key) => key === ROSTER_KEY).length, 1);
    assert.equal(kv.log.rejected.filter((key) => key.startsWith(LIMITER_PREFIX)).length, 1);
  });
  await check("the race costs no more writes than one heartbeat", () => {
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
    assert.equal(kv.writesTo(LIMITER_PREFIX), 1);
    assert.equal(kv.writesTo(SESSION_PREFIX), 1);
    assert.equal(kv.writesTo(PROFILE_PREFIX), 1);
  });
  await check("the roster holds the player exactly once", () => {
    assert.deepEqual(kv.roster().map((e) => e.steamID), [ALICE]);
  });
});

// ------------------------- another player's write lands in the same second

await scenario("another player's write in the same second", async () => {
  const kv = makeStrictKV();
  await post(kv, ALICE, HEARTBEAT, { ip: "203.0.113.1" });
  const bob = await post(kv, BOB, HEARTBEAT, { ip: "203.0.113.2" });

  await check("a roster write KV refuses because someone else just wrote is still a 200", () => {
    assert.equal(bob.status, 200);
    assert.equal(bob.json.steamID, BOB);
    assert.deepEqual(kv.log.rejected, [ROSTER_KEY]);
  });
  await check("the refused row is stored a second later, after the response", () => {
    assert.deepEqual(kv.roster().map((e) => e.steamID), [ALICE, BOB]);
    assert.deepEqual(kv.roster()[1], bob.json);
  });
  await check("that is the one write the heartbeat owed, not an extra one", () => {
    assert.equal(kv.writesTo(ROSTER_KEY), 2);
    assert.deepEqual(warnings, []);
  });
});

await scenario("a roster write refused twice", async () => {
  // The retry lands in a busy second as well: no time passes before it.
  const kv = makeStrictKV();
  await post(kv, ALICE, HEARTBEAT, { ip: "203.0.113.1" });
  timers.sleep = async () => {};
  const bob = await post(kv, BOB, HEARTBEAT, { ip: "203.0.113.2" });
  timers.sleep = waitByMovingTheClock;

  await check("a write refused twice is given up on, with the roster left intact", () => {
    assert.equal(bob.status, 200);
    assert.deepEqual(kv.roster().map((e) => e.steamID), [ALICE]);
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
  });
  await check("giving up is logged, not swallowed in silence", () => {
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /refused twice/);
  });

  pass(CLIENT_HEARTBEAT);
  const bobAgain = await post(kv, BOB, HEARTBEAT, { ip: "203.0.113.2" });

  await check("that player's next heartbeat carries the same data and lands", () => {
    assert.equal(bobAgain.status, 200);
    assert.deepEqual(kv.roster().map((e) => e.steamID), [ALICE, BOB]);
  });
});

// ------------------------------------------ real faults and real floods

await scenario("a KV fault that is not the write-rate limit", async () => {
  const kv = makeStrictKV({ failWritesWith: "KV PUT failed: 500 Internal Server Error" });
  const answer = await post(kv, ALICE, HEARTBEAT);

  await check("a KV failure that is not the write-rate limit is still a 500", () => {
    assert.equal(answer.status, 500);
    assert.match(answer.json.message, /500 Internal Server Error/);
  });
});

await scenario("a flood of new players from one address", async () => {
  // More players behind one address than the route lets join in a minute.
  const players = Array.from({ length: IP_WRITES_PER_MINUTE + 1 }, (_, i) => steamIdAt(100 + i));
  const kv = makeStrictKV({ players });
  const answers = [];
  for (const steamID of players) {
    pass(1100);
    answers.push(await post(kv, steamID, HEARTBEAT));
  }
  const refused = answers.at(-1);

  await check("the per-IP limiter still refuses a flood of new players", () => {
    assert.ok(answers.slice(0, IP_WRITES_PER_MINUTE).every((a) => a.status === 200));
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  });
  await check("a refused heartbeat is not written to the roster", () => {
    assert.equal(kv.roster().length, IP_WRITES_PER_MINUTE);
    assert.equal(kv.writesTo(ROSTER_KEY), IP_WRITES_PER_MINUTE);
  });
});

await scenario("a flood of changes from one address", async () => {
  // The same, by players who are already on the roster and keep changing status.
  const players = Array.from({ length: IP_WRITES_PER_MINUTE + 1 }, (_, i) => steamIdAt(200 + i));
  const kv = makeStrictKV({ players });
  const tenMinutesAgo = new Date(Date.now() - 10 * MINUTE).toISOString();
  const row = (steamID) => ({ steamID, personaName: "P", status: "looking", note: "", inSTS2: false, updatedAt: tenMinutesAgo });
  kv.seed(ROSTER_KEY, JSON.stringify({ entries: players.map(row) }));
  const answers = [];
  for (const steamID of players) {
    pass(1100);
    answers.push(await post(kv, steamID, JSON.stringify({ status: "inRun" })));
  }

  await check("the per-IP limiter also refuses a flood of changes by listed players", () => {
    assert.ok(answers.slice(0, IP_WRITES_PER_MINUTE).every((a) => a.status === 200 && a.json.status === "inRun"));
    assert.equal(answers.at(-1).status, 429);
    assert.equal(kv.writesTo(ROSTER_KEY), IP_WRITES_PER_MINUTE);
  });
});

// ------------------------------------------------------- session renewal

await scenario("a session renewed once a day", async () => {
  const kv = makeStrictKV();
  const sessionKey = `${SESSION_PREFIX}${tokenFor(ALICE)}`;
  const me = await send(kv, "GET", "/me", { steamID: ALICE });

  await check("a session that has never been renewed is renewed by the first request", () => {
    assert.equal(me.status, 200);
    assert.equal(me.json.steamID, ALICE);
    assert.equal(kv.writesTo(SESSION_PREFIX), 1);
    assert.equal(kv.writesTo(PROFILE_PREFIX), 1);
  });
  await check("renewing keeps the session's owner, its 30 days, and notes the time", () => {
    const held = kv.stored(sessionKey);
    assert.equal(held.value, ALICE);
    assert.equal(held.expirationTtl, SESSION_TTL_SECONDS);
    assert.deepEqual(held.metadata, { renewedAt: Date.now() });
    assert.equal(kv.stored(`${PROFILE_PREFIX}${ALICE}`).expirationTtl, SESSION_TTL_SECONDS);
  });

  // A day of use: a page load every hour and the heartbeats in between.
  for (let at = CLIENT_HEARTBEAT; at < DAY; at += CLIENT_HEARTBEAT) {
    pass(CLIENT_HEARTBEAT);
    await post(kv, ALICE, HEARTBEAT);
    if (at % HOUR === 0) await send(kv, "GET", "/me", { steamID: ALICE });
  }

  await check("nothing renews it again for the rest of the day", () => {
    assert.equal(kv.writesTo(SESSION_PREFIX), 1);
    assert.equal(kv.writesTo(PROFILE_PREFIX), 1);
  });

  pass(CLIENT_HEARTBEAT);
  await send(kv, "GET", "/me", { steamID: ALICE });

  await check("a day after the last renewal the next request renews it", () => {
    assert.equal(kv.writesTo(SESSION_PREFIX), 2);
    assert.deepEqual(kv.stored(sessionKey).metadata, { renewedAt: Date.now() });
  });
});

await scenario("a session minted today", async () => {
  const kv = makeStrictKV();
  const sessionKey = `${SESSION_PREFIX}${tokenFor(ALICE)}`;
  kv.seed(sessionKey, ALICE, { renewedAt: Date.now() });
  await send(kv, "GET", "/me", { steamID: ALICE });
  await post(kv, ALICE, HEARTBEAT);
  pass(CLIENT_HEARTBEAT);
  await post(kv, ALICE, HEARTBEAT);

  await check("a session minted today is not renewed again that day", () => {
    assert.equal(kv.writesTo(SESSION_PREFIX), 0);
    assert.equal(kv.writesTo(PROFILE_PREFIX), 0);
  });
  await check("and deciding that costs no KV read beyond the session check itself", () => {
    assert.equal(kv.readsOf(sessionKey), 3);
  });
});

await scenario("one player on two devices", async () => {
  const kv = makeStrictKV();
  const phoneToken = "token-for-alices-phone";
  kv.seed(`${SESSION_PREFIX}${phoneToken}`, ALICE);
  await post(kv, ALICE, HEARTBEAT);
  pass(10 * SECOND);
  const phone = await post(kv, ALICE, HEARTBEAT, { token: phoneToken });

  await check("the second device's heartbeat finds the row fresh and writes no roster", () => {
    assert.equal(phone.status, 200);
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
  });
  await check("its own session is renewed all the same", () => {
    assert.equal(kv.writesTo(`${SESSION_PREFIX}${phoneToken}`), 1);
    assert.deepEqual(kv.stored(`${SESSION_PREFIX}${phoneToken}`).metadata, { renewedAt: Date.now() });
  });
});

await scenario("a session that is gone", async () => {
  const kv = makeStrictKV();
  const signedOut = await renewSessionIfDue(kv.env, "token-that-was-signed-out", ALICE);
  const someoneElses = await renewSessionIfDue(kv.env, tokenFor(BOB), ALICE);

  await check("a session that was signed out meanwhile is not written back", () => {
    assert.equal(signedOut, false);
    assert.equal(someoneElses, false);
    assert.deepEqual(kv.log.writes, []);
  });
});

// -------------------------------------- the sign-in and sign-out roster calls

await scenario("the sign-in and sign-out roster calls", async () => {
  const kv = makeStrictKV();
  const signIn = { status: "looking", note: "" };
  const row = await upsertPresence(kv.env, ALICE, signIn);
  const again = await upsertPresence(kv.env, ALICE, signIn);
  const heartbeat = await post(kv, ALICE, HEARTBEAT);

  await check("signing in puts the player on the roster, once", () => {
    assert.equal(row.steamID, ALICE);
    assert.equal(again.updatedAt, row.updatedAt);
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
  });
  await check("the first heartbeat after signing in finds that row and writes no roster", () => {
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.json.updatedAt, row.updatedAt);
    assert.equal(kv.writesTo(ROSTER_KEY), 1);
    assert.equal(kv.writesTo(LIMITER_PREFIX), 0);
  });

  pass(5 * MINUTE);
  const secondSignIn = await upsertPresence(kv.env, ALICE, signIn);

  await check("signing in again later rewrites the row, as it always did", () => {
    assert.ok(Date.parse(secondSignIn.updatedAt) > Date.parse(row.updatedAt));
    assert.equal(kv.writesTo(ROSTER_KEY), 2);
  });

  pass(5 * SECOND);
  await deletePresence(kv.env, ALICE);

  await check("signing out takes the player off the roster", () => {
    assert.deepEqual(kv.roster(), []);
  });
});

if (process.exitCode) {
  console.error("presence-burst verification FAILED");
} else {
  console.log(`presence-burst: ${passed} checks passed`);
}
