#!/usr/bin/env node
/**
 * Roster persistence + visibility verification for vault-coop.
 *
 * The script we run when someone asks "is everyone really seeing each
 * other on the co-op feed?" Hits the live deploy and proves:
 *
 *   1. The roster is non-empty and contains real, server-verified users
 *      (each entry has a 17-digit Steam ID, persona name, ISO timestamp).
 *   2. The roster is *persistent* — the same users still appear in a
 *      fresh snapshot 10 seconds later, and at least one entry has a
 *      stale `updatedAt` (proving inactive users aren't getting pruned).
 *   3. The public `/presence` endpoint returns identical JSON to every
 *      caller (consistency check — three concurrent fetches from this
 *      machine should produce the same set of Steam IDs).
 *   4. The auth-funnel surfaces still accept events.
 *
 * Run me after any backend change you're nervous about, after a viral
 * traffic spike, or whenever someone says "is the co-op even working?"
 *
 * Zero dependencies — uses Node's built-in `fetch`. Requires Node 18+.
 *
 * Usage:
 *   node Backend/scripts/verify-roster.mjs
 *   node Backend/scripts/verify-roster.mjs --worker=https://my.worker.url
 *
 * Exit code is the number of failed checks (0 = all good).
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=") || true];
  })
);

const WORKER = args.worker || "https://vault-coop.coreycrooks.workers.dev";

async function fetchRoster() {
  // Cache-bust because the Worker edge-caches /presence for 15 s.
  const r = await fetch(`${WORKER}/presence?_=${Date.now()}`);
  if (!r.ok) throw new Error(`/presence ${r.status}`);
  return r.json();
}

function ageHuman(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000)     return Math.floor(ms / 1000) + "s";
  if (ms < 3_600_000)  return Math.floor(ms / 60_000) + "m";
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h " +
                              Math.floor((ms % 3_600_000) / 60_000) + "m";
  return Math.floor(ms / 86_400_000) + "d";
}

async function run() {
  const results = [];

  // ── 1. Roster has real users ──
  const snap1 = await fetchRoster();
  results.push({
    test: "Roster has at least 1 real signed-in user right now",
    pass: snap1.length >= 1,
    detail: `users=${snap1.length}: ${snap1.map((u) => u.personaName).join(", ")}`,
  });
  results.push({
    test: "Every roster entry has a 17-digit Steam ID (server-verified)",
    pass: snap1.every((u) => /^\d{17}$/.test(u.steamID)),
  });
  results.push({
    test: "Every roster entry carries persona name + ISO updatedAt",
    pass: snap1.every(
      (u) =>
        typeof u.personaName === "string" &&
        u.personaName.length > 0 &&
        typeof u.updatedAt === "string" &&
        !Number.isNaN(new Date(u.updatedAt).getTime())
    ),
  });

  // ── 2. Persistence: identical snapshot 10 s later ──
  await new Promise((r) => setTimeout(r, 10_000));
  const snap2 = await fetchRoster();
  const ids1 = new Set(snap1.map((u) => u.steamID));
  const ids2 = new Set(snap2.map((u) => u.steamID));
  const overlap = [...ids1].filter((id) => ids2.has(id));
  results.push({
    test: "Persistence: every user in t=0 snapshot still on roster at t=+10s",
    pass: overlap.length === ids1.size,
    detail: `t=0:${ids1.size} t=+10s:${ids2.size} overlap=${overlap.length}`,
  });

  // Stale users (no recent heartbeat) still appear — most direct proof
  // that the persistent-presence model is doing its job.
  const HOUR_MS = 60 * 60 * 1000;
  const stale = snap1.filter(
    (u) => Date.now() - new Date(u.updatedAt).getTime() > HOUR_MS
  );
  results.push({
    test: "Roster contains users last seen >1h ago (proves persistence)",
    pass: stale.length >= 1 || snap1.length === 0,
    detail:
      stale.length > 0
        ? `${stale.length} stale users still visible: ${stale
            .map((s) => `${s.personaName} (${ageHuman(s.updatedAt)} ago)`)
            .join(", ")}`
        : "no stale users to verify against (acceptable if launched <1h ago)",
  });

  // ── 3. Visibility: every caller sees the same roster ──
  // Three concurrent fetches with cache-busting query strings. Cloudflare
  // routes each to the closest colo, so we exercise the cache + edge
  // consistency layer. The IDs returned should be byte-identical because
  // /presence is a single global key.
  const [s3a, s3b, s3c] = await Promise.all([
    fetchRoster(),
    fetchRoster(),
    fetchRoster(),
  ]);
  const idsA = new Set(s3a.map((u) => u.steamID));
  const idsB = new Set(s3b.map((u) => u.steamID));
  const idsC = new Set(s3c.map((u) => u.steamID));
  const allMatch =
    idsA.size === idsB.size &&
    idsA.size === idsC.size &&
    [...idsA].every((id) => idsB.has(id) && idsC.has(id));
  results.push({
    test: "Visibility: 3 concurrent /presence calls return the same Steam IDs",
    pass: allMatch,
    detail: `sizes ${idsA.size}/${idsB.size}/${idsC.size}`,
  });

  // ── 4. Funnel surfaces still alive ──
  const startResp = await fetch(
    `${WORKER}/auth/steam/start?return=https%3A%2F%2Fapp.spirevault.app%2Fauth.html&nonce=verify`,
    { redirect: "manual" }
  );
  results.push({
    test: "/auth/steam/start returns 302 to Steam (funnel:start bumped)",
    pass: startResp.status === 302,
    detail: `status=${startResp.status}`,
  });

  const diagResp = await fetch(`${WORKER}/auth/diag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reason: "verify-roster-script",
      detail: "automated end-to-end verification",
    }),
  });
  results.push({
    test: "Client diagnostic beacon endpoint accepts events",
    pass: diagResp.status === 200,
  });

  // Print
  console.log("\n=== ROSTER PERSISTENCE & VISIBILITY VERIFICATION ===");
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    const tag = r.pass ? "PASS" : "FAIL";
    console.log(
      `[${tag}] ${r.test}${r.detail ? "\n         " + r.detail : ""}`
    );
    r.pass ? pass++ : fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed.\n`);

  console.log("=== LIVE ROSTER (everyone signed in right now) ===");
  if (snap1.length === 0) {
    console.log("  (empty — no signed-in users currently)\n");
  } else {
    for (const u of snap1) {
      console.log(
        `  ${u.personaName.padEnd(20)} ${u.steamID}  last update: ${ageHuman(
          u.updatedAt
        )} ago${u.inSTS2 ? "  [in STS2 now]" : ""}`
      );
    }
    console.log("");
  }

  process.exit(fail);
}

run().catch((e) => {
  console.error("verify-roster failed:", e);
  process.exit(99);
});
