// Checks that need their own browser session: every tab at 375 and the phone
// bar (2b, 11), the empty state (14), and the full history (6c and its import).

import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  OUT, DESKTOP, PHONE, TABS, STATS_TABS, THEMES, ROSTER, CLIMBERS, PHONE_BAR_TABS, PHONE_SHEET_TABS,
  RELIC_MIN_RUNS, RELIC_TOP_N, RUNS_PAGE, KEYBOARD_TAB_STOPS, BOOT_TIMEOUT_MS, IMPORT_TIMEOUT_MS, PROD_HOST, PROD_PORT,
} from "./config.mjs";
import {
  check, watch, settle, waitBoot, session, gotoTab, overviewCount, importFolder, loadImages, inspectTab,
  startStatic, toastText, reload, plural, parseRecord, rawLabel, KNOWN_NO_ART,
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
export async function sessionChecks(ctx) {
  const { browser, page, data, exp, fullExp, historyDir, knownCards, knownRelics } = ctx;
  // 2b + 11. Phone ----------------------------------------------------------------
  const phone = await session(browser, { viewport: PHONE, phone: true });
  const pp = phone.page;
  await check("2b. every tab renders with the real data at 375", async ({ expect, use }) => {
    use(pp);
    await importFolder(pp, data.dir, exp.total);
    for (const tab of TABS) {
      await gotoTab(pp, tab);
      await settle(pp, tab === "coop" ? 1500 : 300);
      (await inspectTab(pp, tab)).forEach((p) => expect(false, `${tab}: ${p}`));
      const broken = await loadImages(pp, `.tab-panel[data-tab="${tab}"]`);
      expect(broken.length === 0, `${tab}: broken images ${broken.slice(0, 5).join(", ")}`);
      if (STATS_TABS.includes(tab)) expect(!(await pp.locator(`#${tab}-body .v-empty, #${tab}-body .demo-banner`).count()), `${tab}: empty/sample state with data loaded`);
      await pp.screenshot({ path: join(OUT, "tabs", `375-${tab}.png`) });
    }
  });

  await check("11. phone: bottom bar (4 tabs + More); the More sheet opens, closes and every entry navigates", async ({ expect, use }) => {
    use(pp);
    await gotoTab(pp, "overview");
    const bar = await pp.evaluate(() => {
      const nav = document.querySelector(".sidebar-nav");
      const r = nav.getBoundingClientRect();
      const visible = [...nav.querySelectorAll(".nav-row")].filter((el) => getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 8).map((el) => el.dataset.tab);
      const more = nav.querySelector(".v-mnav-more");
      return { position: getComputedStyle(nav).position, gap: Math.round(window.innerHeight - r.bottom), visible, more: !!more && more.offsetParent !== null };
    });
    expect(bar.position === "fixed" && bar.gap === 0, `bar is ${bar.position}, ${bar.gap}px off the bottom`);
    expect(bar.visible.join() === PHONE_BAR_TABS.join(), `bar tabs [${bar.visible.join(", ")}], expected [${PHONE_BAR_TABS.join(", ")}]`);
    expect(bar.more, "no More button");
    for (const tab of PHONE_BAR_TABS) {
      await pp.click(`.sidebar-nav .nav-row[data-tab="${tab}"]`);
      await settle(pp, 250);
      expect(await pp.evaluate(() => window.SpireVault.activeTab()) === tab, `bar ${tab} did not navigate`);
    }
    const isOpen = () => pp.evaluate(() => document.getElementById("v-mnav-sheet")?.open === true);
    for (const how of ["close button", "Escape", "scrim"]) {
      await pp.click(".v-mnav-more");
      await settle(pp, 300);
      expect(await isOpen(), `More did not open (before closing via ${how})`);
      if (how === "close button") await pp.click(".v-mnav-sheet .v-mnav-close");
      else if (how === "Escape") await pp.keyboard.press("Escape");
      else await pp.mouse.click(187, 30);
      await settle(pp, 450);
      expect(!(await isOpen()), `More sheet did not close via ${how}`);
    }
    for (const tab of PHONE_SHEET_TABS) {
      await pp.click(".v-mnav-more");
      await settle(pp, 300);
      const tile = pp.locator(`#v-mnav-sheet [data-mnav-tab="${tab}"]`);
      if (!(await tile.count())) { expect(false, `More has no ${tab} entry`); continue; }
      await tile.click();
      await settle(pp, 400);
      const state = await pp.evaluate(() => ({ tab: window.SpireVault.activeTab(), open: document.getElementById("v-mnav-sheet").open }));
      expect(state.tab === tab && !state.open, `More → ${tab}: active ${state.tab}, sheet open ${state.open}`);
      (await inspectTab(pp, tab)).forEach((p) => expect(false, `More → ${tab}: ${p}`));
    }
    await pp.click(".v-mnav-more");
    await pp.click('#v-mnav-sheet [data-mnav-action="themes"]');
    await settle(pp, 300);
    expect(await pp.locator("#v-mnav-sheet [data-mnav-themes] [data-theme-id]").count() === THEMES.length, "theme row in More does not list 8 themes");
    await pp.click('#v-mnav-sheet [data-mnav-themes] [data-theme-id="defect"]');
    await settle(pp, 300);
    expect(await pp.evaluate(() => document.documentElement.dataset.theme) === "defect", "picking a theme in More did not apply it");
    await pp.keyboard.press("Escape");
  });
  await phone.context.close();

  // 14. Empty state and sample data ------------------------------------------------
  await check("14. empty state: fresh profile shows sample data + import path; no runs shows the empty state", async ({ expect, use, note }) => {
    const fresh = await session(browser);
    const fp = fresh.page;
    use(fp);
    await gotoTab(fp, "overview");
    const sample = await fp.evaluate(() => ({
      pill: !document.querySelector('.tab-panel[data-tab="overview"] [data-toolbar-empty]').hidden,
      banner: !!document.querySelector("#overview-body .demo-banner"),
      cta: [...document.querySelectorAll("#overview-body .demo-banner [data-action]")].map((b) => b.dataset.action),
      runs: document.querySelector("#overview-body .v-nums dd")?.dataset.count,
    }));
    expect(sample.pill, "fresh profile: no sample-data pill");
    expect(sample.banner, "fresh profile: no sample-data banner on Overview");
    expect(sample.cta.includes("upload") || sample.cta.includes("scan"), `sample banner CTAs [${sample.cta.join(", ")}]`);
    note(`fresh profile shows ${sample.runs} sample runs`);
    if (sample.cta.length) {
      const chooser = fp.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
      await fp.click(`#overview-body .demo-banner [data-action="${sample.cta.includes("scan") ? "scan" : "upload"}"]`);
      expect(await chooser, "the sample banner's import button opened no picker");
    }
    await gotoTab(fp, "settings");
    await fp.click('#settings-body [data-action="settings-clear-local"]');
    await settle(fp, 600);
    await gotoTab(fp, "overview");
    const empty = await fp.evaluate(() => ({
      empty: !!document.querySelector("#overview-body .v-empty"),
      title: document.querySelector("#overview-body .v-empty-title")?.textContent.trim(),
      ctas: [...document.querySelectorAll("#overview-body .v-empty [data-action]")].map((b) => b.dataset.action),
      pill: !document.querySelector('.tab-panel[data-tab="overview"] [data-toolbar-empty]').hidden,
      os: !!document.querySelector("#overview-body .v-empty-os"),
    }));
    expect(empty.empty, "no empty state after clearing every run");
    expect(empty.ctas.includes("scan") || empty.ctas.includes("upload"), `empty state CTAs [${empty.ctas.join(", ")}]`);
    expect(empty.os, "empty state has no 'Where your saves live' panel");
    expect(!empty.pill, "\"Showing sample data\" pill is shown while there is no data at all");
    // The fresh context closes inside this check, so keep its empty state on disk.
    const emptyShot = join(OUT, "14-empty-state.png");
    await fp.screenshot({ path: emptyShot });
    note(`empty state screenshot: ${emptyShot}`);
    note(`empty state title: "${empty.title}"`);
    for (const tab of STATS_TABS.slice(1)) {
      await gotoTab(fp, tab);
      expect(await fp.locator(`#${tab}-body .v-empty`).count() === 1, `${tab}: no empty state with zero runs`);
    }
    await gotoTab(fp, "overview");
    await fp.click("#overview-body .v-empty-more[data-alt-paths-panel] > summary");
    expect(await fp.evaluate(() => document.querySelector("#overview-body .v-empty-more[data-alt-paths-panel]").open), "'My saves are somewhere else' did not open");
    const chooser = fp.waitForEvent("filechooser", { timeout: 5000 });
    await fp.click(`#overview-body .v-empty .v-empty-cta`);
    const fc = await chooser.catch(() => null);
    expect(fc, "the empty state's main button opened no picker");
    if (fc) {
      await fc.setFiles(data.dir);
      const ok = await fp.waitForFunction((n) => document.querySelector("#overview-body .v-nums dd")?.dataset.count === String(n), exp.total, { timeout: IMPORT_TIMEOUT_MS }).then(() => true).catch(() => false);
      expect(ok, "importing from the empty state did not load the runs");
    }
    await reload(fp);
    note(`after a reload the Overview shows ${await overviewCount(fp) ?? "no count"} runs`);
    await fresh.context.close();
  });

  // Full history -----------------------------------------------------------------
  const all = await session(browser);
  await check(`full history: all ${fullExp.total} runs import and every stats tab holds up`, async ({ expect, use, note }) => {
    use(all.page);
    const started = Date.now();
    await importFolder(all.page, historyDir, fullExp.total);
    note(`imported ${fullExp.total} runs in ${((Date.now() - started) / 1000).toFixed(1)}s (the folder also holds .run.backup files, which are skipped)`);
    const nums = await all.page.$$eval("#overview-body .v-nums dd", (els) => els.map((d) => d.dataset.count));
    expect(nums.join("/") === `${fullExp.total}/${fullExp.wins}/${fullExp.losses}`, `runs/wins/losses ${nums.join("/")}, expected ${fullExp.total}/${fullExp.wins}/${fullExp.losses}`);
    for (const tab of STATS_TABS) {
      const t0 = Date.now();
      await gotoTab(all.page, tab);
      const ms = Date.now() - t0;
      if (ms > 1500) note(`${tab} took ${ms}ms to render`);
      (await inspectTab(all.page, tab)).forEach((p) => expect(false, `${tab}: ${p}`));
      const broken = await loadImages(all.page, `.tab-panel[data-tab="${tab}"]`);
      expect(broken.length === 0, `${tab}: broken images ${broken.slice(0, 5).join(", ")}`);
    }
    const banners = await all.page.$$eval("#characters-body .v-cb:not(.is-unplayed)", (els) => els.map((el) => el.dataset.char));
    expect(banners.length === Object.keys(fullExp.byChar).length, `${banners.length} played banners, expected ${Object.keys(fullExp.byChar).length}`);
    await gotoTab(all.page, "runs");
    expect((await all.page.textContent("#runs-body .v-runs-summary"))?.includes(`All ${fullExp.total} runs`), "Recent Runs total is wrong");
    await gotoTab(all.page, "ascensions");
    expect(await all.page.locator(`#ascensions-body .v-asc-st.is-peak [data-asc-jump="${fullExp.peak}"]`).count() === 1, `peak is not A${fullExp.peak}`);
  });

  await check(`6c. every run's page (all ${fullExp.total}): each relic and card shows a real name and its art`, async ({ expect, use, note }) => {
    const pg = all.page;
    use(pg);
    await gotoTab(pg, "overview");
    if (await overviewCount(pg) !== String(fullExp.total)) await importFolder(pg, historyDir, fullExp.total);
    await gotoTab(pg, "runs");
    const more = pg.locator('#runs-body [data-action="runs-show-all"]');
    if (await more.count()) { await more.click(); await settle(pg, 800); }
    const ids = await pg.$$eval("#runs-body .run-row", (els) => els.map((el) => el.dataset.runId));
    expect(ids.length === fullExp.total, `Show all lists ${ids.length} runs`);
    /** @type {Map<string, { kind: string, why: string, runs: number, chars: Set<string> }>} */
    const bad = new Map();
    const gaps = new Set();
    let opened = 0;
    for (const id of ids) {
      await pg.evaluate((rid) => document.querySelector(`#runs-body .run-row[data-run-id="${rid}"]`)?.click(), id);
      const ok = await pg.waitForSelector("#run-detail-modal:not([hidden]) .v-rd", { timeout: 3000 }).then(() => true).catch(() => false);
      if (!ok) { expect(false, `${id}: run page did not open`); continue; }
      opened += 1;
      await loadImages(pg, "#run-detail-body");
      const items = await pg.evaluate(() => {
        const rd = document.querySelector("#run-detail-body .v-rd");
        return {
          char: rd.dataset.char,
          relics: [...rd.querySelectorAll(".v-rd-relic")].map((r) => ({ label: r.querySelector(".v-rd-relic-name")?.textContent.trim() || "", img: !!r.querySelector("img:not([hidden])")?.naturalWidth })),
          cards: [...rd.querySelectorAll(".v-rd-card")].map((c) => ({ label: (c.querySelector(".v-sr")?.textContent || "").replace(/, \d+ copies$/, "").replace(/\+$/, "").trim(), img: !!c.querySelector("img:not([hidden])")?.naturalWidth })),
        };
      });
      for (const [kind, list, known] of [["relic", items.relics, knownRelics], ["card", items.cards, knownCards]]) {
        for (const item of list) {
          const knownGap = kind === "card" && !item.img && Object.prototype.hasOwnProperty.call(KNOWN_NO_ART, item.label);
          const why = [!item.img && !knownGap ? "no image" : "", rawLabel(item.label, known)].filter(Boolean).join(", ");
          if (knownGap) gaps.add(item.label);
          if (!why) continue;
          const key = `${kind}:${item.label}`;
          const entry = bad.get(key) || { kind, why, runs: 0, chars: new Set() };
          entry.runs += 1;
          entry.chars.add(items.char);
          bad.set(key, entry);
        }
      }
      await pg.keyboard.press("Escape");
      await pg.waitForSelector("#run-detail-modal[hidden]", { state: "attached", timeout: 2000 }).catch(() => {});
    }
    note(`opened ${opened} run pages`);
    gaps.forEach((label) => note(`known gap: "${label}" has no art (${KNOWN_NO_ART[label]})`));
    for (const kind of ["relic", "card"]) {
      const list = [...bad.entries()].filter(([, e]) => e.kind === kind).sort((a, b) => b[1].runs - a[1].runs);
      expect(list.length === 0, `${list.length} ${kind}s with a raw name or no image: ${list.map(([k, e]) => `"${k.slice(kind.length + 1)}" (${e.why}; ${e.runs} run${e.runs === 1 ? "" : "s"}; ${[...e.chars].join("/")})`).join("; ")}`);
    }
  });
  await all.context.close();
}
