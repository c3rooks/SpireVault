// scripts/launch-smoke.mjs
// =========================================================================
// End-to-end smoke test that runs against the LIVE deployment, not local code.
// Re-run before any deploy or before any major reddit/HN post. Exits non-zero
// on any failure so it can wrap a CI job later.
//
// Usage:
//   cd scripts && npm i -D playwright && npx playwright install chromium
//   node launch-smoke.mjs
//
// Bars it has to clear:
//
//   1. Both surfaces (spirevault.app, app.spirevault.app) load with zero
//      console errors and zero failed network requests.
//   2. The "Can I self-host my own copy?" and "I cover hosting" FAQ copy is
//      actually deployed, not just sitting on disk.
//   3. The browser-side Stats engine, fed the EXACT shape VaultCore's
//      HistoryStore writes on macOS, produces hand-verifiable numbers. This
//      is the macOS-vs-web parity claim with a receipt.
//   4. IndexedDB persists across a hard reload (the "drag-drop once" promise).
//   5. Public Worker endpoints return the right status + CORS + cache-control.

import { chromium } from "playwright";

const SITE_URL = "https://spirevault.app/";
const APP_URL  = "https://app.spirevault.app/";
const API_URL  = "https://vault-coop.coreycrooks.workers.dev";

const log  = (s) => console.log(`\x1b[36m${s}\x1b[0m`);
const ok   = (s) => console.log(`\x1b[32m✓ ${s}\x1b[0m`);
const fail = (s) => { console.log(`\x1b[31m✗ ${s}\x1b[0m`); process.exitCode = 1; };

// Mirror of HistoryStore.Document on disk: { header, runs }. Field names are the
// CANONICAL Vault schema (won, endedAt, character, ascension, relics, cardPicks)
// — not the raw STS2 save format. The macOS app's parser normalizes raw saves
// into this shape before writing history.json. Browsers read this same file.
const TODAY = new Date();
const dayBefore = (n) => new Date(TODAY.getTime() - n * 86400_000).toISOString();
const SYNTH_HISTORY = {
  header: {
    schemaVersion: 1,
    generatedAt: TODAY.toISOString(),
    vault: "TheVault/0.1.0-test",
  },
  runs: [
    // 2 wins on Ironclad A0
    { id: "ic-w1", sourceFile: "synth", parsedAt: dayBefore(3), character: "ironclad",
      ascension: 0, won: true,  endedAt: dayBefore(3), seed: "AAA",
      relics: ["burning_blood", "akabeko"], deckAtEnd: ["strike", "bash"], cardPicks: [
        { floor: 1, offered: ["pommel_strike", "thunderclap", "anger"], picked: "pommel_strike" },
        { floor: 4, offered: ["pommel_strike", "uppercut", "headbutt"],  picked: "pommel_strike" },
        { floor: 7, offered: ["spot_weakness", "rampage", "anger"],      picked: null }, // skipped
      ]
    },
    { id: "ic-w2", sourceFile: "synth", parsedAt: dayBefore(2), character: "ironclad",
      ascension: 0, won: true,  endedAt: dayBefore(2), seed: "BBB",
      relics: ["burning_blood", "anchor"], deckAtEnd: ["strike", "bash"], cardPicks: [
        { floor: 1, offered: ["pommel_strike", "anger", "headbutt"],     picked: "pommel_strike" },
      ]
    },
    // 1 loss on Silent A5
    { id: "si-l1", sourceFile: "synth", parsedAt: dayBefore(1), character: "silent",
      ascension: 5, won: false, endedAt: dayBefore(1), seed: "CCC",
      relics: ["ring_of_the_snake"], deckAtEnd: ["strike", "neutralize"], cardPicks: []
    },
  ],
};

async function checkPublicEndpoints() {
  log("\n— public Worker endpoints —");
  const probes = [
    { path: "/",                 expect: 200, hint: "health"        },
    { path: "/presence",         expect: 200, hint: "feed (cached)" },
    { path: "/invites/messages", expect: 200, hint: "msg catalog"   },
    { path: "/invites/inbox",    expect: 401, hint: "auth-gated"    },
  ];
  for (const p of probes) {
    const r = await fetch(API_URL + p.path);
    if (r.status !== p.expect) fail(`${p.path} → ${r.status}, expected ${p.expect}`);
    else                       ok(`${p.path} → ${r.status} (${p.hint})`);
    if (!r.headers.get("access-control-allow-origin"))
      fail(`${p.path} missing access-control-allow-origin`);
  }
  const presence = await fetch(API_URL + "/presence");
  const cc = presence.headers.get("cache-control") || "";
  if (!/max-age=15/.test(cc)) fail(`/presence cache-control missing max-age=15: "${cc}"`);
  else                        ok(`/presence cache-control: ${cc}`);
}

async function checkMarketingSite(browser) {
  log("\n— marketing site (spirevault.app) —");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [], failedReqs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("requestfailed", (r) => failedReqs.push(`${r.url()} (${r.failure()?.errorText})`));

  await page.goto(SITE_URL + "?cb=launch", { waitUntil: "networkidle", timeout: 30000 });

  // Use textContent — innerText excludes text inside collapsed <details>,
  // which is exactly where our cost FAQ lives. Then normalize whitespace.
  const text = await page.evaluate(() => document.body.textContent.replace(/\s+/g, " "));
  if (!/Can I self-host my own copy\?/.test(text)) fail("self-host FAQ entry missing");
  else                                              ok("self-host FAQ entry present");
  if (!/I cover hosting/.test(text))               fail("honest cost FAQ copy missing");
  else                                              ok("honest cost FAQ copy present");
  if (!/Refresh interval 30/.test(text))           fail("refresh interval not '30 s'");
  else                                              ok("refresh interval shows 30 s");

  if (errors.length)     fail(`console errors: ${errors.join(" | ")}`);
  else                   ok("zero console errors");
  if (failedReqs.length) fail(`failed requests: ${failedReqs.join(" | ")}`);
  else                   ok("zero failed requests");

  await ctx.close();
}

async function checkWebCompanionGate(browser) {
  log("\n— web companion gate (app.spirevault.app, signed-out) —");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [], failedReqs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("requestfailed", (r) => failedReqs.push(`${r.url()} (${r.failure()?.errorText})`));

  await page.goto(APP_URL + "?cb=launch", { waitUntil: "networkidle", timeout: 30000 });
  const text = await page.evaluate(() => document.body.innerText);
  if (!/Sign in with Steam/i.test(text)) fail("Sign in with Steam button missing");
  else                                    ok("signed-out gate renders Sign in with Steam");

  const html = await page.content();
  if (!/styles\.css\?v=5/.test(html)) fail("styles.css cache-buster not v=5");
  else                                ok("styles.css ?v=5 live");
  if (!/script\.js\?v=5/.test(html))  fail("script.js cache-buster not v=5");
  else                                ok("script.js ?v=5 live");

  // Make sure the confusing broadcast-note dropdown isn't lurking in the
  // shipped HTML anywhere. The id was `me-note`; if it exists on the page,
  // the old form leaked back in via a bad cache or partial deploy.
  const noteSelectExists = await page.locator("#me-note").count();
  if (noteSelectExists !== 0) fail(`stale #me-note dropdown still present (${noteSelectExists})`);
  else                        ok("broadcast Note dropdown removed");

  // The new How co-op works hint must replace it.
  const howtoExists = await page.locator(".me-howto").count();
  // It's hidden until signed-in, so just verify the markup is in the DOM.
  if (howtoExists !== 1) fail(`How co-op works hint missing or duplicated (count=${howtoExists})`);
  else                   ok("How co-op works hint shipped");

  // No em-dashes in user-visible prose. We only look at what the user can
  // actually see: the signed-out hero. The signed-in shell is in the DOM but
  // `hidden`, and its placeholder cells use "—" as a "no data yet" sentinel,
  // which is a normal UI convention rather than the AI tell to weed out.
  const visibleText = await page.evaluate(() =>
    document.querySelector("main#main-public")?.textContent ?? ""
  );
  if (/—/.test(visibleText)) {
    const sample = visibleText.match(/.{0,40}—.{0,40}/)?.[0]?.trim() ?? "?";
    fail(`em-dash leaked into visible prose near: "${sample}"`);
  } else {
    ok("no em-dashes in visible prose");
  }

  if (errors.length)     fail(`console errors: ${errors.join(" | ")}`);
  else                   ok("zero console errors");
  if (failedReqs.length) fail(`failed requests: ${failedReqs.join(" | ")}`);
  else                   ok("zero failed requests");

  await ctx.close();
}

async function checkStatsEngineParity(browser) {
  log("\n— Stats engine parity (canonical Vault schema → JS engine) —");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(APP_URL + "?cb=launch", { waitUntil: "networkidle", timeout: 30000 });

  const result = await page.evaluate(async (raw) => {
    const Stats = await import("/lib/stats-engine.js?v=4");
    const ext = Stats.extractRuns(raw);
    if (!ext.ok) return { ok: false, err: ext.error };
    const summary = Stats.summarize(ext.runs);
    // Pull just the fields we want to verify, by .find() on the bucket arrays.
    const ironcladBucket = summary.byCharacter.find((b) => b.key === "ironclad") ?? null;
    const silentBucket   = summary.byCharacter.find((b) => b.key === "silent")   ?? null;
    return {
      ok: true,
      extractedCount: ext.runs.length,
      totalRuns: summary.totalRuns,
      totalWins: summary.totalWins,
      overallWinrate: summary.overallWinrate,
      byAscensionKeys: summary.byAscension.map((b) => b.key),
      ironclad: ironcladBucket,
      silent:   silentBucket,
      relicCount: summary.byRelic.length,
      pickedTop:  summary.topPickedCards.map((c) => c.key),
    };
  }, SYNTH_HISTORY);

  if (!result.ok) { fail(`extractRuns failed: ${result.err}`); await ctx.close(); return; }
  ok(`extractRuns returned ${result.extractedCount} normalized runs`);

  const expectations = [
    ["totalRuns",                                3, "totalRuns = 3"],
    ["totalWins",                                2, "totalWins = 2"],
    ["overallWinrate",                  2/3,         "overallWinrate ≈ 0.667"],
    ["ironclad.runs",                            2, "ironclad runs = 2"],
    ["ironclad.wins",                            2, "ironclad wins = 2"],
    ["ironclad.winrate",                       1.0, "ironclad winrate = 1.0"],
    ["silent.runs",                              1, "silent runs = 1"],
    ["silent.wins",                              0, "silent wins = 0"],
    ["silent.winrate",                         0.0, "silent winrate = 0.0"],
  ];
  const get = (path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), result);
  for (const [path, want, msg] of expectations) {
    const got = get(path);
    const passes = typeof want === "number"
      ? Math.abs(got - want) < 0.01
      : got === want;
    if (passes) ok(`${msg} (got ${got})`);
    else        fail(`${msg} (got ${got})`);
  }

  // byAscension should include both A0 and A5, and be sorted ascending.
  const ascSeq = result.byAscensionKeys.join(",");
  if (ascSeq === "A0,A5") ok("byAscension sorted as A0,A5");
  else                    fail(`byAscension expected "A0,A5", got "${ascSeq}"`);

  // burning_blood was held in 2/3 runs (both wins) → minSample default = 3, so
  // *no* relic clears the threshold yet. That's correct behavior — assert it.
  if (result.relicCount === 0) ok("byRelic correctly empty under default minSample (3)");
  else                          fail(`byRelic expected 0 buckets, got ${result.relicCount}`);

  // pommel_strike was picked 3 times across the synthetic data, so it should
  // appear in topPickedCards under the default minSample of 3.
  if (result.pickedTop.includes("pommel_strike"))
    ok("topPickedCards includes pommel_strike (3 picks)");
  else
    fail(`topPickedCards missing pommel_strike; got ${JSON.stringify(result.pickedTop)}`);

  await ctx.close();
}

async function checkIndexedDBPersistence(browser) {
  log("\n— IndexedDB persistence (the 'drag-drop once' promise) —");
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(APP_URL + "?cb=idb", { waitUntil: "networkidle", timeout: 30000 });

  await page.evaluate(async (raw) => {
    const HistoryStore = await import("/lib/history-store.js?v=4");
    const Stats        = await import("/lib/stats-engine.js?v=4");
    const ext = Stats.extractRuns(raw);
    if (!ext.ok) throw new Error("seed extract failed: " + ext.error);
    await HistoryStore.saveHistory({ runs: ext.runs, savedAt: Date.now() });
  }, SYNTH_HISTORY);

  await page.reload({ waitUntil: "networkidle" });
  const survived = await page.evaluate(async () => {
    const HistoryStore = await import("/lib/history-store.js?v=4");
    const cached = await HistoryStore.loadHistory();
    return cached?.runs?.length ?? 0;
  });
  if (survived === 3) ok(`IndexedDB persisted 3 runs across hard reload`);
  else                fail(`IndexedDB survived only ${survived} runs after reload`);

  // And data is gone after we clear it (rules out stale-cache false positives).
  await page.evaluate(async () => {
    const HistoryStore = await import("/lib/history-store.js?v=4");
    await HistoryStore.clearHistory();
  });
  await page.reload({ waitUntil: "networkidle" });
  const afterClear = await page.evaluate(async () => {
    const HistoryStore = await import("/lib/history-store.js?v=3");
    const cached = await HistoryStore.loadHistory();
    return cached?.runs?.length ?? 0;
  });
  if (afterClear === 0) ok("clearHistory() actually clears");
  else                  fail(`clearHistory left ${afterClear} runs behind`);

  await ctx.close();
}

(async () => {
  log("══ SpireVault launch-readiness smoke (v2) ══");
  await checkPublicEndpoints();
  const browser = await chromium.launch({ headless: true });
  try {
    await checkMarketingSite(browser);
    await checkWebCompanionGate(browser);
    await checkStatsEngineParity(browser);
    await checkIndexedDBPersistence(browser);
  } finally {
    await browser.close();
  }
  log("\n══ done ══");
  if (process.exitCode) console.log("\n\x1b[31mFAIL — see above. Do not launch.\x1b[0m");
  else                  console.log("\n\x1b[32mPASS — launch green-light.\x1b[0m");
})();
