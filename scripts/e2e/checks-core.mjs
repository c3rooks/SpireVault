// Checks 1–7 and the climber picker gate (15a, 15b) on one desktop session
// with the staged runs: import, every tab at 1440, Overview, Characters,
// Ascensions, Relics, Cards, Recent Runs.

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  OUT, DESKTOP, PHONE, TABS, STATS_TABS, THEMES, ROSTER, CLIMBERS, PHONE_BAR_TABS, PHONE_SHEET_TABS,
  RELIC_MIN_RUNS, RELIC_TOP_N, RUNS_PAGE, KEYBOARD_TAB_STOPS, BOOT_TIMEOUT_MS, IMPORT_TIMEOUT_MS, PROD_HOST, PROD_PORT,
} from "./config.mjs";
import {
  check, watch, settle, waitBoot, session, gotoTab, overviewCount, importFolder, loadImages, inspectTab,
  startStatic, toastText, reload, plural, parseRecord, rawLabel,
} from "./harness.mjs";
import { charKey, floorsOf } from "./history.mjs";

/**
 * @param {{
 *   browser: import("playwright").Browser,
 *   page: import("playwright").Page,
 *   data: { dir: string, exp: any, runs: any[], endTimes: Map<number, number> },
 *   exp: any, fullExp: any, historyDir: string,
 *   knownCards: Set<string>, knownRelics: Set<string>,
 * }} ctx
 */
export async function coreChecks(ctx) {
  const { browser, page, data, exp, fullExp, historyDir, knownCards, knownRelics } = ctx;
  // 15 (part): before Fool runs exist, the picker must not offer The Fool.
  await check("15a. header stage: no Fool in the climber picker before any Fool run", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "overview");
    const ids = await page.$$eval('.tab-panel[data-tab="overview"] .companion-picker [data-companion-id]', (els) => els.map((el) => el.dataset.companionId));
    expect(ids.length >= 6, `picker lists ${ids.length} options`);
    expect(!ids.includes("fool"), "The Fool is listed with sample data only (it is beta-gated on having Fool runs)");
  });

  // 1. Import ------------------------------------------------------------------
  await check("1. import: runs come in through the Import button; sample pill goes; counts match", async ({ expect, use, note }) => {
    use(page);
    const pillBefore = await page.locator('.tab-panel[data-tab="overview"] [data-toolbar-empty]').isVisible();
    expect(pillBefore, "the sample-data pill is not shown on a fresh profile");
    const started = Date.now();
    await importFolder(page, data.dir, exp.total);
    note(`imported ${exp.total} runs in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await page.waitForFunction(() => [...document.querySelectorAll("[data-toolbar-empty]")].every((p) => p.hidden || p.offsetParent === null), null, { timeout: 5000 }).catch(() => {});
    const pills = await page.$$eval("[data-toolbar-empty]", (els) => els.map((p) => ({ tab: p.closest(".tab-panel")?.dataset.tab, shown: !p.hidden })));
    const shown = pills.filter((p) => p.shown).map((p) => p.tab);
    expect(shown.length === 0, `"Showing sample data" pill still not hidden after import on: ${shown.join(", ")}`);
    expect(!(await page.locator("#overview-body .demo-banner").count()), "sample-data banner still on Overview after import");
    expect(await overviewCount(page) === String(exp.total), `Overview Runs is ${await overviewCount(page)}, expected ${exp.total}`);
    await gotoTab(page, "runs");
    const summary = (await page.textContent("#runs-body .v-runs-summary"))?.replace(/\s+/g, " ").trim();
    expect(summary === `All ${exp.total} runs`, `Recent Runs says "${summary}", expected "All ${exp.total} runs"`);
    await gotoTab(page, "settings");
    const loaded = (await page.textContent("#settings-body .settings-stat-value"))?.trim();
    expect(loaded === String(exp.total), `Settings "Runs loaded" is ${loaded}, expected ${exp.total}`);
    await gotoTab(page, "overview");
    const toast = await toastText(page);
    if (toast) note(`toast after import: "${toast}"`);
  });

  // Later checks need the runs even when --only skipped the import check.
  if (await overviewCount(page) !== String(exp.total)) await importFolder(page, data.dir, exp.total);

  // 15 (part): right after import, the picker should know about The Fool.
  await check("15b. header stage: climber picker lists The Fool right after Fool runs are imported", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "overview");
    const now = await page.$$eval('.tab-panel[data-tab="overview"] .companion-picker [data-companion-id]', (els) => els.map((el) => el.dataset.companionId));
    expect(now.includes("fool"), `picker on Overview right after import: [${now.join(", ")}] (no Fool until something re-renders the stage)`);
    await gotoTab(page, "characters");
    await gotoTab(page, "overview");
    const later = await page.$$eval('.tab-panel[data-tab="overview"] .companion-picker [data-companion-id]', (els) => els.map((el) => el.dataset.companionId));
    note(`after a tab switch: [${later.join(", ")}]`);
    expect(later.includes("fool"), "The Fool is still missing from the picker after a tab switch");
  });

  // 2. Every tab at 1440 -----------------------------------------------------
  await check("2a. every tab renders with the real data at 1440", async ({ expect, use }) => {
    use(page);
    mkdirSync(join(OUT, "tabs"), { recursive: true });
    for (const tab of TABS) {
      await gotoTab(page, tab);
      await settle(page, tab === "coop" ? 1500 : 300);
      (await inspectTab(page, tab)).forEach((p) => expect(false, `${tab}: ${p}`));
      const broken = await loadImages(page, `.tab-panel[data-tab="${tab}"]`);
      expect(broken.length === 0, `${tab}: broken images ${broken.slice(0, 5).join(", ")}`);
      if (STATS_TABS.includes(tab)) {
        expect(!(await page.locator(`#${tab}-body .v-empty, #${tab}-body .demo-banner`).count()), `${tab}: shows the empty state or sample banner with data loaded`);
      }
      await page.screenshot({ path: join(OUT, "tabs", `1440-${tab}.png`) });
    }
  });

  // 3. Overview ----------------------------------------------------------------
  await check("3. overview: totals, form, streaks and character mix match the files", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "overview");
    const ov = await page.evaluate(() => ({
      nums: [...document.querySelectorAll("#overview-body .v-nums dd")].map((d) => d.dataset.count),
      pct: document.querySelector("#overview-body .v-ring-pct [data-count]")?.dataset.count,
      form: document.querySelector("#overview-body .v-path-head span")?.textContent.trim(),
      nodes: document.querySelectorAll("#overview-body .v-path-node").length,
      best: document.querySelector("#overview-body .v-wr-best b")?.dataset.char || null,
      highest: document.querySelector('#overview-body .v-wr-chips .v-chip')?.textContent.replace(/\s+/g, " ").trim(),
      chars: Object.fromEntries([...document.querySelectorAll("#overview-body .v-char")].map((c) => [c.dataset.char, c.querySelector(".v-char-rec").textContent.trim()])),
      kpis: Object.fromEntries([...document.querySelectorAll("#overview-body .v-hand .v-card")].map((c) => [c.querySelector(".v-card-band").textContent.trim(), c.querySelector(".v-card-value").textContent.trim()])),
    }));
    expect(ov.nums.join("/") === `${exp.total}/${exp.wins}/${exp.losses}`, `runs/wins/losses ${ov.nums.join("/")}, expected ${exp.total}/${exp.wins}/${exp.losses}`);
    expect(ov.pct === exp.winratePct, `win rate ring ${ov.pct}%, expected ${exp.winratePct}%`);
    expect(ov.form === `${exp.last10.wins}W · ${exp.last10.losses}L in the last 10`, `form line "${ov.form}", expected ${exp.last10.wins}W · ${exp.last10.losses}L`);
    expect(ov.nodes === Math.min(20, exp.total), `recent path has ${ov.nodes} nodes`);
    expect(ov.best === exp.bestChar, `best character ${ov.best}, expected ${exp.bestChar}`);
    expect(ov.highest === `Highest A${exp.peak} · ${plural(exp.byAsc[exp.peak].runs, "run")}`, `highest chip "${ov.highest}", expected A${exp.peak} · ${exp.byAsc[exp.peak].runs} runs`);
    for (const [key, b] of Object.entries(exp.byChar)) {
      const want = `${b.wins}W · ${b.runs - b.wins}L · ${plural(b.runs, "run")}`;
      expect(ov.chars[key] === want, `${key} banner "${ov.chars[key] ?? "missing"}", expected "${want}"`);
    }
    ROSTER.filter((k) => !exp.byChar[k]).forEach((k) => expect(ov.chars[k] === "No runs yet", `${k} (no runs) banner "${ov.chars[k]}"`));
    if (exp.lossStreak > 0) expect(ov.kpis["Loss streak"] === String(exp.lossStreak), `"Loss streak" card ${ov.kpis["Loss streak"]}, expected ${exp.lossStreak}`);
    else expect("Win streak" in ov.kpis, "newest run is a win but there is no Win streak card");
    expect(String(parseInt(ov.kpis["Best streak"], 10)) === String(exp.bestStreak), `"Best streak" card ${ov.kpis["Best streak"]}, expected ${exp.bestStreak}`);
    expect(ov.kpis["Best floor"] === String(exp.bestFloor), `"Best floor" card ${ov.kpis["Best floor"]}, expected ${exp.bestFloor}`);
    expect(ov.kpis["Recent form"] === `${Math.round((exp.last10.wins / 10) * 100)}%`, `"Recent form" card ${ov.kpis["Recent form"]}`);
  });

  // 4. Characters ----------------------------------------------------------------
  await check("4. characters: a banner per played character (The Fool too); codex opens; sections open", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "characters");
    const broken = await loadImages(page, "#characters-body");
    expect(broken.length === 0, `broken banner art: ${broken.join(", ")}`);
    const banners = await page.$$eval("#characters-body .v-cb", (els) => els.map((b) => ({
      key: b.dataset.char, action: b.dataset.charKey, rec: b.querySelector(".v-cb-rec").textContent,
      art: !!b.querySelector("img") && b.querySelector("img").naturalWidth > 0,
    })));
    for (const [key, b] of Object.entries(exp.byChar)) {
      const banner = banners.find((x) => x.key === key);
      if (!banner) { expect(false, `no banner for ${key} (${b.runs} runs)`); continue; }
      const rec = parseRecord(banner.rec);
      expect(rec && rec.runs === b.runs && rec.wins === b.wins, `${key} banner record "${banner.rec}", expected ${b.wins}W ${b.runs} runs`);
      expect(banner.art, `${key} banner has no portrait art`);
    }
    for (const banner of banners) {
      await page.click(`#characters-body .v-cb[data-char="${banner.key}"]`);
      const opened = await page.waitForSelector(`#char-detail-slot [data-char-detail][data-char="${banner.key}"]`, { timeout: 3000 }).catch(() => null);
      if (!opened) { expect(false, `${banner.key}: codex page did not open`); continue; }
      const page2 = await page.evaluate(() => {
        const cx = document.querySelector("#char-detail-slot .v-cx");
        return {
          bare: cx.classList.contains("is-bare"),
          nums: [...cx.querySelectorAll(".v-cx-nums dd")].map((d) => d.textContent.trim()),
          accs: cx.querySelectorAll("details.v-cx-acc").length,
          art: !!cx.querySelector(".v-cx-art img") && cx.querySelector(".v-cx-art img").naturalWidth > 0,
        };
      });
      const b = exp.byChar[banner.key];
      if (b) expect(page2.nums.join("/") === `${b.runs}/${b.wins}/${b.runs - b.wins}`, `${banner.key} codex record ${page2.nums.join("/")}, expected ${b.runs}/${b.wins}/${b.runs - b.wins}`);
      if (page2.bare) note(`${banner.key}: no codex entry ("No codex entry yet"), so there are no sections to open`);
      const closed = await page.$$(`#char-detail-slot details.v-cx-acc:not([open]) > summary`);
      for (const summary of closed) await summary.click();
      const stillClosed = await page.locator("#char-detail-slot details.v-cx-acc:not([open])").count();
      expect(stillClosed === 0, `${banner.key}: ${stillClosed} codex section(s) did not open`);
      await page.click('#char-detail-slot [data-action="char-collapse"]');
      await settle(page, 200);
      expect(!(await page.locator("#char-detail-slot [data-char-detail]").count()), `${banner.key}: close button left the codex open`);
    }
  });

  // 5. Ascensions ----------------------------------------------------------------
  await check("5. ascensions: every storey's numbers match; tapping one opens its row", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "ascensions");
    const storeys = await page.$$eval("#ascensions-body .v-asc-st", (els) => els.map((el) => ({
      level: Number(el.querySelector("[data-asc-jump]").dataset.ascJump),
      runs: el.querySelector(".v-asc-st-runs")?.textContent.trim() || null,
      wr: el.querySelector(".v-asc-st-wr")?.textContent.replace(/\s/g, "") || null,
      peak: el.classList.contains("is-peak"),
    })));
    expect(storeys.length === 11, `${storeys.length} storeys, expected A0–A10`);
    for (const st of storeys) {
      const b = exp.byAsc[st.level];
      if (b) {
        expect(st.runs === plural(b.runs, "run"), `A${st.level} storey says "${st.runs}", expected ${plural(b.runs, "run")}`);
        expect(st.wr === `${((b.wins / b.runs) * 100).toFixed(1)}%`, `A${st.level} storey win rate ${st.wr}, expected ${((b.wins / b.runs) * 100).toFixed(1)}%`);
      } else expect(st.runs === null, `A${st.level} has no runs but its storey shows "${st.runs}"`);
      expect(st.peak === (st.level === exp.peak), `A${st.level} peak flag ${st.peak}`);
    }
    for (const level of Object.keys(exp.byAsc).map(Number)) {
      await page.click(`#ascensions-body [data-asc-jump="${level}"]`);
      await settle(page, 250);
      const row = await page.evaluate((l) => {
        const d = document.querySelector(`#ascensions-body details.v-asc-row[data-asc="${l}"]`);
        return d && { open: d.open, rec: d.querySelector(".v-asc-row-rec")?.textContent.trim(), focused: document.activeElement === d.querySelector("summary") };
      }, level);
      const b = exp.byAsc[level];
      expect(row && row.open, `tapping A${level} did not open its row`);
      expect(row && row.rec === `${b.wins}W / ${plural(b.runs, "run")}`, `A${level} row says "${row?.rec}", expected ${b.wins}W / ${plural(b.runs, "run")}`);
      expect(row && row.focused, `A${level}: focus did not move to the opened row`);
    }
  });

  // 6. Relics ----------------------------------------------------------------------
  await check("6a. relics: podium + ledger, detail opens, art loads, every name is a real name", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "relics");
    const podium = await page.locator("#relics-body .v-rl-podium .v-rl-top").count();
    const ledger = await page.locator("#relics-body .v-rl-row").count();
    expect(podium === Math.min(3, exp.relicCount), `podium has ${podium}, expected ${Math.min(3, exp.relicCount)}`);
    expect(podium + ledger === exp.relicCount, `podium+ledger list ${podium + ledger} relics, expected ${exp.relicCount} (relics seen in ≥${RELIC_MIN_RUNS} runs, top ${RELIC_TOP_N})`);
    const broken = await loadImages(page, "#relics-body");
    expect(broken.length === 0, `broken relic images: ${broken.join(", ")}`);
    const entries = await page.$$eval("#relics-body [data-action=\"relic-expand\"]", (els) => els.map((el) => ({
      key: el.dataset.relicKey,
      label: (el.querySelector(".v-rl-top-name, .v-rl-name")?.textContent || "").trim(),
      img: !!el.querySelector("img") && el.querySelector("img").naturalWidth > 0,
    })));
    const bad = entries.map((e) => ({ ...e, why: [!e.img ? "no image" : "", rawLabel(e.label, knownRelics)].filter(Boolean).join(", ") })).filter((e) => e.why);
    expect(bad.length === 0, `relics with a raw id or no image: ${bad.map((e) => `${e.key} "${e.label}" (${e.why})`).join("; ")}`);
    for (const selector of ["#relics-body .v-rl-podium .v-rl-top", "#relics-body .v-rl-row"]) {
      const first = page.locator(selector).first();
      if (!(await first.count())) continue;
      const key = await first.getAttribute("data-relic-key");
      await first.click();
      const opened = await page.waitForSelector(`#relic-detail-slot [data-relic-detail="${key}"]`, { timeout: 3000 }).catch(() => null);
      expect(opened, `opening ${key} showed no detail page`);
      if (!opened) continue;
      const detail = await page.evaluate(() => ({
        name: document.querySelector("#relic-detail-slot .v-rl-page-name")?.textContent.trim(),
        picked: document.querySelector("#relic-detail-slot .v-rl-record-nums dd")?.textContent.replace(/\s+/g, " ").trim(),
        bare: !!document.querySelector("#relic-detail-slot .v-rl-page-body.is-bare"),
      }));
      const entry = entries.find((e) => e.key === key);
      expect(detail.name && detail.name === entry?.label, `${key}: detail title "${detail.name}" vs list "${entry?.label}"`);
      expect(/^\d+ runs?$/.test(detail.picked || ""), `${key}: detail record "${detail.picked}"`);
      if (detail.bare) note(`${key}: no in-game effect copy on file`);
      await page.click('#relic-detail-slot [data-action="relic-collapse"]');
      await settle(page, 200);
      expect(!(await page.locator("#relic-detail-slot [data-relic-detail]").count()), `${key}: close left the detail open`);
    }
  });

  await check("6b. cards: podium + ledgers render, art loads, every name is a real name", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "cards");
    expect(await page.locator("#cards-body .v-cd-podium .v-cd-step").count() > 0, "no most-picked podium");
    expect(await page.locator("#cards-body .v-cd-row").count() > 0, "no card ledger rows");
    const broken = await loadImages(page, "#cards-body");
    expect(broken.length === 0, `broken card images: ${broken.join(", ")}`);
    const items = await page.evaluate(() => [
      ...[...document.querySelectorAll("#cards-body .v-cd-step")].map((el) => ({ where: "podium", label: el.querySelector(".v-cd-top-name")?.textContent.trim(), img: !el.querySelector(".v-cd-top-card.is-missing") && !!el.querySelector(".v-cd-top-card img")?.naturalWidth })),
      ...[...document.querySelectorAll("#cards-body .v-cd-row")].map((el) => ({ where: el.closest(".v-cd-sec--skip") ? "skipped" : "picked", label: el.querySelector(".v-cd-name")?.textContent.trim(), img: !el.querySelector(".v-cd-thumb.is-missing") && !!el.querySelector(".v-cd-thumb img")?.naturalWidth })),
    ]);
    const bad = items.map((i) => ({ ...i, why: [!i.img ? "no image" : "", rawLabel(i.label, knownCards)].filter(Boolean).join(", ") })).filter((i) => i.why);
    expect(bad.length === 0, `cards with a raw id or no image: ${bad.map((i) => `"${i.label}" [${i.where}] (${i.why})`).join("; ")}`);
  });

  // 7. Recent Runs ----------------------------------------------------------------
  const runsSummary = async () => (await page.textContent("#runs-body .v-runs-summary"))?.replace(/\s+/g, " ").replace(" Clear filters", "").trim();
  const rowCount = () => page.locator("#runs-body .run-row").count();
  const clickChip = async (kind, value) => {
    await page.click(`#runs-body .v-runs-chip[data-filter-kind="${kind}"][data-filter-value="${value}"]`);
    await settle(page, 250);
  };
  const clearFilters = async () => {
    const clear = page.locator('#runs-body [data-action="clear-filters"]').first();
    if (await clear.count()) await clear.click();
    const search = page.locator('#runs-body input[data-filter-kind="search"]');
    if (await search.count() && (await search.inputValue())) { await search.fill(""); }
    await settle(page, 400);
  };

  await check("7a. runs: character chips (The Fool included) filter to the right runs", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "runs");
    await clearFilters();
    const chips = await page.$$eval('#runs-body .v-runs-chip[data-filter-kind="character"]', (els) => els.map((el) => el.dataset.filterValue));
    const want = ["all", ...Object.keys(exp.byChar)].sort();
    expect([...chips].sort().join(",") === want.join(","), `character chips [${chips.join(", ")}], expected [${want.join(", ")}]`);
    for (const [key, b] of Object.entries(exp.byChar)) {
      if (!chips.includes(key)) continue;
      await clickChip("character", key);
      const summary = await runsSummary();
      expect(summary === `Showing ${b.runs} of ${exp.total} runs`, `${key} chip: "${summary}", expected ${b.runs} of ${exp.total}`);
      const chars = await page.$$eval("#runs-body .run-row", (els) => [...new Set(els.map((el) => el.dataset.char))]);
      expect(chars.length === 1 && chars[0] === key, `${key} chip shows rows for [${chars.join(", ")}]`);
      expect(await page.getAttribute(`#runs-body .v-runs-chip[data-filter-kind="character"][data-filter-value="${key}"]`, "aria-pressed") === "true", `${key} chip not pressed`);
    }
    await clickChip("character", "all");
  });

  await check("7b. runs: outcome, ascension and search filters; mode filter", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "runs");
    await clearFilters();
    await clickChip("outcome", "wins");
    expect(await runsSummary() === `Showing ${exp.wins} of ${exp.total} runs`, `Wins: "${await runsSummary()}", expected ${exp.wins}`);
    expect((await page.$$eval("#runs-body .run-row", (els) => els.every((el) => el.dataset.result === "win"))), "Wins filter shows a non-win row");
    await clickChip("outcome", "losses");
    expect(await runsSummary() === `Showing ${exp.losses} of ${exp.total} runs`, `Losses: "${await runsSummary()}", expected ${exp.losses}`);
    await clickChip("outcome", "all");
    for (const [tier, n] of Object.entries(exp.tiers)) {
      await clickChip("ascensionTier", tier);
      const summary = await runsSummary();
      expect(summary === `Showing ${n} of ${exp.total} runs`, `ascension ${tier}: "${summary}", expected ${n}`);
      if (n === 0) expect(await page.locator("#runs-body .v-runs-empty").count() === 1, `ascension ${tier}: no "Nothing matches" empty state`);
    }
    await clickChip("ascensionTier", "all");
    const search = page.locator('#runs-body input[data-filter-kind="search"]');
    const target = exp.newestWin;
    if (target) {
      await search.fill(target.json.seed);
      await settle(page, 600);
      expect(await rowCount() === 1, `search by seed ${target.json.seed}: ${await rowCount()} rows, expected 1`);
      expect(await page.locator(`#runs-body .run-row[data-run-id="sts2-${target.json.start_time}"]`).count() === 1, "seed search did not find that run");
    }
    await search.fill("victory");
    await settle(page, 600);
    expect(await runsSummary() === `Showing ${exp.wins} of ${exp.total} runs`, `search "victory": "${await runsSummary()}", expected ${exp.wins}`);
    await search.fill("fool");
    await settle(page, 600);
    expect(await runsSummary() === `Showing ${exp.foolRuns.length} of ${exp.total} runs`, `search "fool": "${await runsSummary()}", expected ${exp.foolRuns.length}`);
    expect(await page.$eval('#runs-body input[data-filter-kind="search"]', (el) => el === document.activeElement), "search box lost focus while typing (re-render)");
    await clearFilters();
    expect(await runsSummary() === `All ${exp.total} runs`, `Clear filters left "${await runsSummary()}"`);
    const modeChips = await page.locator('#runs-body [data-filter-kind="mode"], #runs-body [data-filter-kind="gameMode"]').count();
    note(`modes in this data: ${exp.modes.join(", ")}; mode filter chips present: ${modeChips ? "yes" : "no"} (no Blitz/Dread runs exist to exercise one)`);
  });

  await check("7c. runs: Show more and Show all page through every run", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "runs");
    await clearFilters();
    expect(await rowCount() === Math.min(RUNS_PAGE, exp.total), `first page has ${await rowCount()} rows`);
    await page.click('#runs-body [data-action="runs-show-more"]');
    await settle(page);
    expect(await rowCount() === Math.min(RUNS_PAGE * 2, exp.total), `after Show more: ${await rowCount()} rows`);
    const focused = await page.evaluate(() => document.activeElement?.classList.contains("run-row"));
    expect(focused, "focus did not move to the first newly shown run");
    await page.click('#runs-body [data-action="runs-show-all"]');
    await settle(page, 600);
    expect(await rowCount() === exp.total, `after Show all: ${await rowCount()} rows, expected ${exp.total}`);
    expect((await page.textContent("#runs-body .v-runs-more"))?.includes(`All ${exp.total} runs shown`), "no \"All N runs shown\" footer");
    const ids = await page.$$eval("#runs-body .run-row", (els) => els.map((el) => Number(el.dataset.runId.replace("sts2-", ""))));
    const sorted = ids.every((id, i) => i === 0 || data.endTimes.get(ids[i - 1]) >= data.endTimes.get(id));
    expect(sorted, "runs are not newest first");
  });

  await check("7d. runs: opening a run shows its map path, deck and relics", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "runs");
    await clearFilters();
    const targets = [exp.newestWin, exp.foolRuns.find((r) => floorsOf(r) > 1) || exp.foolRuns[0]].filter(Boolean);
    for (const target of targets) {
      const id = `sts2-${target.json.start_time}`;
      await page.locator('#runs-body input[data-filter-kind="search"]').fill(target.json.seed);
      await settle(page, 600);
      await page.click(`#runs-body .run-row[data-run-id="${id}"]`);
      await page.waitForSelector("#run-detail-modal:not([hidden]) .v-rd", { timeout: 4000 });
      await loadImages(page, "#run-detail-body");
      const d = await page.evaluate(() => {
        const rd = document.querySelector("#run-detail-body .v-rd");
        return {
          name: rd.querySelector(".v-rd-name")?.textContent.trim(),
          stamp: rd.querySelector(".v-rd-stamp")?.textContent.trim(),
          meta: rd.querySelector(".v-rd-meta")?.textContent.replace(/\s+/g, " "),
          stats: Object.fromEntries([...rd.querySelectorAll(".v-rd-stats > div")].map((s) => [s.querySelector("dt").textContent, s.querySelector("dd").textContent])),
          acts: rd.querySelectorAll(".v-act").length,
          nodes: rd.querySelectorAll(".v-node").length,
          relics: [...rd.querySelectorAll(".v-rd-relic")].map((r) => ({ label: r.querySelector(".v-rd-relic-name")?.textContent.trim(), img: !!r.querySelector("img:not([hidden])")?.naturalWidth })),
          deck: [...rd.querySelectorAll(".v-rd-card")].map((c) => ({ label: c.querySelector(".v-sr")?.textContent.replace(/, \d+ copies$/, "").trim(), img: !!c.querySelector("img:not([hidden])")?.naturalWidth })),
          deckCount: rd.querySelector(".v-rd-sec-head .v-rd-count") && [...rd.querySelectorAll(".v-rd-sec")].find((s) => /Final deck/.test(s.textContent))?.querySelector(".v-rd-count")?.textContent,
          plate: !!rd.querySelector(".v-rd-plate img")?.naturalWidth,
          url: location.search,
        };
      });
      const p = target.json.players[0];
      const label = `${charKey(target)} ${target.json.start_time}`;
      expect(d.stamp === (target.json.win ? "Victory" : target.json.was_abandoned ? "Abandoned" : "Defeat"), `${label}: stamp "${d.stamp}"`);
      expect(d.meta?.includes(target.json.seed), `${label}: seed missing from the page`);
      expect(d.acts === target.json.map_point_history.length, `${label}: ${d.acts} acts drawn, file has ${target.json.map_point_history.length}`);
      expect(d.nodes === floorsOf(target), `${label}: ${d.nodes} path nodes, file has ${floorsOf(target)} rooms`);
      expect(d.stats.Floor === String(floorsOf(target)), `${label}: Floor stat ${d.stats.Floor}`);
      expect(d.stats.Deck === String(p.deck.length) && d.deckCount === plural(p.deck.length, "card"), `${label}: deck says ${d.stats.Deck} / "${d.deckCount}", file has ${p.deck.length}`);
      expect(d.relics.length === p.relics.length, `${label}: ${d.relics.length} relics shown, file has ${p.relics.length}`);
      expect(d.plate, `${label}: character plate art missing`);
      expect(/run=/.test(d.url), `${label}: URL does not carry the open run`);
      const why = (item, known) => [!item.img ? "no image" : "", rawLabel(item.label.replace(/\+$/, ""), known)].filter(Boolean).join(", ");
      const badRelics = d.relics.map((r) => ({ ...r, why: why(r, knownRelics) })).filter((r) => r.why);
      const badCards = d.deck.map((c) => ({ ...c, why: why(c, knownCards) })).filter((c) => c.why);
      expect(badRelics.length === 0, `${label}: relics with a raw name or no image: ${badRelics.map((r) => `"${r.label}" (${r.why})`).join("; ")}`);
      expect(badCards.length === 0, `${label}: deck cards with a raw name or no image: ${[...new Set(badCards.map((c) => `"${c.label}" (${c.why})`))].join("; ")}`);
      await page.keyboard.press("Escape");
      await settle(page, 300);
      expect(await page.locator("#run-detail-modal").isHidden(), `${label}: Escape did not close the run page`);
    }
    note(`opened ${targets.map((t) => `${charKey(t)} ${t.json.start_time}`).join(" and ")}`);
    await clearFilters();
  });

  await check("7e. runs: compare 2 and 3 runs (and a 4th is refused)", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "runs");
    await clearFilters();
    await page.click('#runs-body [data-action="compare-toggle"]');
    await settle(page);
    expect(await page.getAttribute('#runs-body [data-action="compare-toggle"]', "aria-pressed") === "true", "Compare toggle not pressed");
    expect(await page.locator("#compare-bar").isVisible(), "compare bar not shown");
    const rows = page.locator("#runs-body .run-row");
    const names = [];
    for (let i = 0; i < 2; i += 1) { await rows.nth(i).click(); names.push(await rows.nth(i).getAttribute("data-run-id")); }
    expect((await page.textContent("#compare-bar-count"))?.trim() === "2 runs selected", `bar says "${await page.textContent("#compare-bar-count")}"`);
    expect(await page.isEnabled("#compare-bar-go"), "Compare button disabled with 2 selected");
    await page.click("#compare-bar-go");
    await page.waitForSelector("#run-compare-modal:not([hidden]) .v-cmp", { timeout: 4000 });
    expect(await page.locator("#run-compare-body .v-cmp-col").count() === 2, `compare shows ${await page.locator("#run-compare-body .v-cmp-col").count()} columns, expected 2`);
    await page.keyboard.press("Escape");
    await settle(page);
    expect(await page.locator("#run-compare-modal").isHidden(), "Escape did not close compare");
    await rows.nth(2).click();
    await page.click("#compare-bar-go");
    await page.waitForSelector("#run-compare-modal:not([hidden]) .v-cmp", { timeout: 4000 });
    expect(await page.locator("#run-compare-body .v-cmp-col").count() === 3, `compare shows ${await page.locator("#run-compare-body .v-cmp-col").count()} columns, expected 3`);
    const broken = await loadImages(page, "#run-compare-body");
    expect(broken.length === 0, `compare: broken images ${broken.slice(0, 4).join(", ")}`);
    await page.click("#run-compare-close");
    await settle(page);
    await rows.nth(3).click();
    expect((await page.textContent("#compare-bar-count"))?.trim() === "3 runs selected", `a 4th pick changed the count: "${await page.textContent("#compare-bar-count")}"`);
    await page.click('#runs-body [data-action="compare-toggle"]');
    await settle(page);
    expect(await page.getAttribute("#runs-body .run-row", "role") === "button", "leaving compare mode left rows as checkboxes");
  });

}
