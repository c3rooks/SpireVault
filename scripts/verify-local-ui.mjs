// scripts/verify-local-ui.mjs
// =========================================================================
// Headless UI verification against the LOCAL dev stack (127.0.0.1:8788 web,
// 127.0.0.1:8787 worker). Start it with ./scripts/dev-local.sh first.
//
// Covers what a release-blocking manual click-through would: boot without
// JS errors, the game-sync badge, the newest news post, relic drill-down
// text sourced from the game DB, card art rendering, and the co-op
// scheduled-play (intents) panel end to end with a dev session.
//
// Usage: node scripts/verify-local-ui.mjs   (screenshots land in /tmp)
// =========================================================================

import { chromium } from "playwright";

const APP = "http://127.0.0.1:8788";

const ok = (s) => console.log(`\x1b[32m\u2713 ${s}\x1b[0m`);
const fail = (s) => { console.log(`\x1b[31m\u2717 ${s}\x1b[0m`); process.exitCode = 1; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !/favicon|analytics|googletagmanager|net::|Failed to load resource/i.test(m.text())) {
    jsErrors.push(m.text());
  }
});

// ---- 1. boot as a GUEST -------------------------------------------------------
// Stats tabs are tested signed OUT on purpose: demo mode (the sample-data
// first impression) only activates for guests, and it's the only state
// where the relic/card grids are guaranteed populated on a fresh machine.
await page.goto(`${APP}/`, { waitUntil: "networkidle" }).catch(() => {});
await page.waitForTimeout(2500);

// ---- 2. boot errors ----------------------------------------------------------
if (jsErrors.length === 0) ok("boot: no JS errors");
else fail(`boot: JS errors: ${jsErrors.join(" | ").slice(0, 500)}`);

// ---- 3. game-sync badge -------------------------------------------------------
const badge = page.locator("#game-sync-badge");
try {
  await badge.waitFor({ state: "visible", timeout: 5000 });
  const text = (await badge.textContent())?.trim();
  if (text?.includes("v0.107.1") && text.includes("v0.111.0")) ok(`badge: "${text}"`);
  else fail(`badge text wrong: "${text}"`);
  await page.screenshot({ path: "/tmp/ui-badge.png", clip: { x: 0, y: 640, width: 260, height: 260 } });
  await badge.click();
  await page.waitForTimeout(800);
} catch (e) {
  fail(`badge not visible: ${e.message.split("\n")[0]}`);
}

// ---- 4. news post -------------------------------------------------------------
// The master/detail view shows one article at a time; the badge click lands
// on the NEWEST post, so assert that one. (Older posts are reachable via the
// list rail — the pill checks below prove list wiring separately.)
try {
  const article = page.locator("#news-011");
  await article.waitFor({ state: "visible", timeout: 5000 });
  const body = await article.textContent();
  if (body.includes("When are you free") && body.includes("thank you")) {
    ok("news: newest post renders with expected content");
  } else fail("news: newest post missing expected phrases");
  await page.screenshot({ path: "/tmp/ui-news.png", fullPage: false });
} catch (e) {
  fail(`news: newest post not visible after badge click: ${e.message.split("\n")[0]}`);
}

// ---- 4b. News NEW-pill lifecycle ------------------------------------------------
// The sidebar's "NEW" badge must: show for anyone who hasn't read the latest
// post (including returning users who read the PREVIOUS one), clear when the
// News tab opens, and stay cleared across reloads.
{
  const pill = page.locator("#nav-news-count");
  // We are currently ON the news tab (badge click above), so it was just
  // marked read. Simulate a returning user who last read the previous post.
  await page.evaluate(() => localStorage.setItem("vault.web.news.lastRead", "post-010-2026-08-23-beta-0110-0111-data-pass"));
  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1500);
  if (await pill.isVisible()) ok("news pill: shows for a returning reader of the previous post");
  else fail("news pill: did NOT show after a new post was published");

  await page.click('[data-tab="news"]');
  await page.waitForTimeout(600);
  if (!(await pill.isVisible())) ok("news pill: clears when the News tab is opened");
  else fail("news pill: still visible after opening News");

  await page.reload({ waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1500);
  if (!(await pill.isVisible())) ok("news pill: stays cleared across reloads");
  else fail("news pill: reappeared after reload despite being read");

  // Banner art on the newest post must actually load (see the post-007
  // CDN-caches-the-fallback incident for why this check exists).
  await page.click('[data-tab="news"]');
  await page.waitForTimeout(800);
  const bannerOk = await page.locator("#news-011 .news-post-banner img")
    .evaluate((el) => el.complete && el.naturalWidth > 100).catch(() => false);
  if (bannerOk) ok("news: post 011 banner art loads");
  else fail("news: post 011 banner image missing or broken");
}

// ---- 5. Top Relics drill-down (demo data) --------------------------------------
await page.click('[data-tab="relics"]');
await page.waitForTimeout(1500);
try {
  // Scope to the relics panel — a bare ".relic-card" can match a hidden
  // element on another tab and stall the visibility wait.
  const grid = page.locator('.tab-panel[data-tab="relics"]');
  await grid.locator(".relic-card").first().waitFor({ state: "visible", timeout: 8000 });
  // Any relic card in the grid; prefer Snecko Eye if present.
  const snecko = grid.locator(".relic-card.is-clickable", { hasText: "Snecko Eye" }).first();
  const target = (await snecko.count()) > 0 ? snecko : grid.locator(".relic-card.is-clickable").first();
  await target.click({ timeout: 5000 });
  await page.waitForTimeout(900);
  const detail = await page.locator(".relic-detail, [class*='relic-detail']").first().textContent();
  if ((await snecko.count()) > 0) {
    if (detail.includes("draw 2 additional cards") && /ancient/i.test(detail)) {
      ok("relics: Snecko Eye shows STS2 text + ancient tier");
    } else fail(`relics: Snecko Eye detail unexpected: ${detail.slice(0, 220)}`);
  } else if (detail && detail.length > 40 && !detail.includes("undefined")) {
    ok("relics: drill-down renders real copy");
  } else fail(`relics: drill-down looks broken: ${String(detail).slice(0, 200)}`);
  await page.screenshot({ path: "/tmp/ui-relic-detail.png" });
} catch (e) {
  fail(`relics drill-down failed: ${e.message.split("\n")[0]}`);
}

// ---- 6. Cards art --------------------------------------------------------------
await page.click('[data-tab="cards"]');
await page.waitForTimeout(2000);
{
  const imgs = page.locator('[data-tab-panel="cards"] img, .tab-panel[data-tab="cards"] img');
  const n = await imgs.count();
  let loaded = 0;
  for (let i = 0; i < Math.min(n, 40); i++) {
    if (await imgs.nth(i).evaluate((el) => el.complete && el.naturalWidth > 8).catch(() => false)) loaded++;
  }
  if (n > 0 && loaded >= Math.min(n, 40) * 0.7) ok(`cards: art renders (${loaded}/${Math.min(n, 40)} sampled images loaded)`);
  else if (n === 0) fail("cards: no card images found in panel");
  else fail(`cards: only ${loaded}/${Math.min(n, 40)} sampled images loaded`);
}

// ---- 7. Co-op intents panel (signed in) -------------------------------------------
// Fresh context: co-op needs a session, and the first-run "Welcome to the
// campfire" onboarding modal must be dismissed before anything is clickable.
const coopPage = await ctx.newPage();
coopPage.on("pageerror", (e) => jsErrors.push(String(e)));
await coopPage.goto(`${APP}/api/_dev-login?as=c3rooks`, { waitUntil: "domcontentloaded" });
// Land on the app root and let the HttpOnly-cookie session rehydrate first —
// deep-linking ?tab=coop before rehydration bounces to Overview by design
// (the auth wall). Then click the nav row like a person would.
await coopPage.goto(`${APP}/`, { waitUntil: "networkidle" }).catch(() => {});
await coopPage.waitForTimeout(3000);
await coopPage.click('[data-tab="coop"]');
await coopPage.waitForTimeout(4000); // rt modules load + first poll
try {
  const maybeLater = coopPage.getByText("Maybe later", { exact: true });
  if (await maybeLater.count()) {
    await maybeLater.first().click();
    await coopPage.waitForTimeout(800);
  }
  const panel = coopPage.locator("#pf-intents");
  await panel.waitFor({ state: "visible", timeout: 12000 });
  ok("coop: scheduled-play panel mounted");
  const preset = panel.locator(".pf-intent-preset").first();
  await preset.click();
  await coopPage.waitForTimeout(2500);
  const rows = await panel.locator(".pf-intent-row").count();
  if (rows > 0) ok(`coop: preset click saved a window (${rows} row(s) rendered)`);
  else fail("coop: preset click did not render a saved window row");
  await panel.screenshot({ path: "/tmp/ui-intents.png" });
  // Clean up so repeated runs don't hit the 5-window cap.
  const removes = panel.locator(".pf-intent-remove");
  const rc = await removes.count();
  for (let i = 0; i < rc; i++) { await removes.first().click(); await coopPage.waitForTimeout(600); }
} catch (e) {
  fail(`coop intents panel: ${e.message.split("\n")[0]}`);
  await coopPage.screenshot({ path: "/tmp/ui-coop-fail.png" });
}

// ---- 8. accumulated errors -------------------------------------------------------
const late = jsErrors.length;
if (late === 0) ok("navigation: no accumulated JS errors");
else fail(`navigation: ${late} JS error(s): ${jsErrors.join(" | ").slice(0, 600)}`);

await browser.close();
console.log(process.exitCode ? "\nUI verification FAILED" : "\nUI verification passed");
