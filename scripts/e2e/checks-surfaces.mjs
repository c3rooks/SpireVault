// Checks 8–10, 12, 13 and 15c on the same desktop session: co-op offline,
// Highlights/News/Beta/Settings persistence, themes and the layout round
// trip, keyboard, export/refresh, and every climber on the header stage.

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
export async function surfaceChecks(ctx) {
  const { browser, page, data, exp, fullExp, historyDir, knownCards, knownRelics } = ctx;
  // 8. Co-op without a server ---------------------------------------------------
  await check("8. co-op without a server: the offline state renders and nothing throws", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "coop");
    await settle(page, 2500);
    const text = await page.evaluate(() => document.querySelector('.tab-panel[data-tab="coop"]').innerText.replace(/\s+/g, " "));
    expect(text.length > 80, "co-op panel is nearly empty");
    expect(/unavailable|can.t reach|offline|sign in/i.test(text), `no offline/sign-in message: "${text.slice(0, 160)}"`);
    (await inspectTab(page, "coop")).forEach((p) => expect(false, p));
  });

  // 9. Highlights, News, Beta, Settings — persistence ----------------------------
  await check("9a. highlights: filter and sort persist across a reload", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "highlights");
    await page.click('.h-filter-chip[data-h-filter="week"]');
    await page.selectOption("#h-sort-select", "floor");
    await settle(page);
    expect(await page.getAttribute('.h-filter-chip[data-h-filter="week"]', "aria-pressed") === "true", "This week chip not pressed after click");
    await reload(page);
    await gotoTab(page, "highlights");
    expect(await page.getAttribute('.h-filter-chip[data-h-filter="week"]', "aria-pressed") === "true", "filter did not survive the reload");
    expect(await page.inputValue("#h-sort-select") === "floor", "sort did not survive the reload");
    expect((await page.textContent("#highlights-feed"))?.trim().length > 10, "highlights feed is empty (no message either)");
    await page.click('.h-filter-chip[data-h-filter="all"]');
    await page.selectOption("#h-sort-select", "recent");
  });

  await check("9b. news: every post opens (015 release and 014 included) with its own URL hash", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "news");
    const ids = await page.$$eval("#news-list .news-list-item", (els) => els.map((el) => el.dataset.newsId));
    const posts = await page.$$eval("#news-detail .news-post[data-news-id]", (els) => els.map((el) => el.dataset.newsId));
    expect(ids.length === posts.length && ids.length > 0, `list has ${ids.length} items, ${posts.length} posts`);
    expect(ids.includes("015") && ids.includes("014"), `posts 015/014 missing from the list: [${ids.join(", ")}]`);
    for (const id of ids) {
      await page.click(`#news-list .news-list-item[data-news-id="${id}"]`);
      await settle(page, 200);
      const state = await page.evaluate((nid) => {
        const visible = [...document.querySelectorAll("#news-detail .news-post")].filter((p) => !p.hidden).map((p) => p.dataset.newsId);
        const post = document.getElementById(`news-${nid}`);
        return { visible, title: post?.querySelector(".news-post-title")?.textContent.trim(), pressed: document.querySelector(`#news-list [data-news-id="${nid}"]`).getAttribute("aria-pressed"), hash: location.hash };
      }, id);
      expect(state.visible.length === 1 && state.visible[0] === id, `post ${id}: visible posts [${state.visible.join(", ")}]`);
      expect(state.title, `post ${id}: no title`);
      expect(state.pressed === "true", `post ${id}: list item not pressed`);
      expect(state.hash === `#news-${id}`, `post ${id}: hash is "${state.hash}"`);
      const broken = await loadImages(page, `#news-${id}`);
      expect(broken.length === 0, `post ${id}: broken images ${broken.join(", ")}`);
    }
    // On a local dev host a guest's first paint always switches to Overview,
    // which also clears the #news- hash (bootShellFirstPaint). Reload
    // persistence of the News tab and post is checked on a production-style
    // host in 9e; here only record what the local reload does.
    await page.click('#news-list .news-list-item[data-news-id="015"]');
    await reload(page);
    const after = await page.evaluate(() => ({ tab: window.SpireVault.activeTab(), hash: location.hash }));
    note(`local dev host: reload on post 015 lands on tab "${after.tab}" with hash "${after.hash}" (known localhost first-paint quirk)`);
    await gotoTab(page, "news");
  });

  await check("9e. news post and last tab survive a reload (production boot path)", async ({ expect, use, note }) => {
    const server = await startStatic(PROD_PORT);
    const prodBrowser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${PROD_HOST} 127.0.0.1`] });
    try {
      const context = await prodBrowser.newContext({ viewport: DESKTOP });
      await context.route((url) => url.hostname !== PROD_HOST, (route) => route.abort());
      const pg = await context.newPage();
      watch(pg);
      use(pg);
      await pg.goto(`http://${PROD_HOST}:${PROD_PORT}/?ui=next`, { waitUntil: "domcontentloaded" });
      await waitBoot(pg);
      const local = await pg.evaluate(() => document.documentElement.classList.contains("vault-local-dev"));
      expect(!local, "the production-style host was still treated as local dev");
      await gotoTab(pg, "news");
      for (const id of ["015", "014"]) {
        await pg.click(`#news-list .news-list-item[data-news-id="${id}"]`);
        await settle(pg, 300);
        await reload(pg);
        await settle(pg, 500);
        const after = await pg.evaluate(() => ({ tab: window.SpireVault.activeTab(), url: location.pathname + location.search + location.hash, visible: [...document.querySelectorAll("#news-detail .news-post")].filter((p) => !p.hidden).map((p) => p.dataset.newsId) }));
        expect(after.tab === "news" && after.visible.join() === id, `reload on post ${id}: tab "${after.tab}", showing [${after.visible.join(", ")}], url ${after.url}`);
        if (after.tab !== "news") await gotoTab(pg, "news");
      }
      for (const tab of ["characters", "settings"]) {
        await gotoTab(pg, tab);
        await reload(pg);
        const now = await pg.evaluate(() => window.SpireVault.activeTab());
        expect(now === tab, `reload on ${tab} came back on "${now}"`);
      }
      await context.close();
    } finally {
      await prodBrowser.close();
      server.kill();
    }
  });

  await check("9c. beta tab: its switches persist across a reload", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "beta");
    const shot = '#beta-body [data-rc-action="set-screenshot"]';
    const coop = '#beta-body [data-rc-action="set-coop-beta"]';
    const before = { shot: await page.isChecked(shot), coop: (await page.locator(coop).count()) ? await page.isChecked(coop) : null };
    await page.locator(shot).setChecked(!before.shot, { force: true });
    await page.click('#beta-body [data-rc-action="set-provider"][data-provider="anthropic"]');
    await settle(page);
    if (before.coop !== null) { await page.locator(coop).click({ force: true }); await settle(page, 500); }
    await reload(page);
    await gotoTab(page, "beta");
    expect(await page.isChecked(shot) === !before.shot, "screenshot switch did not survive the reload");
    expect(await page.getAttribute('#beta-body [data-rc-action="set-provider"][data-provider="anthropic"]', "aria-checked") === "true", "provider choice did not survive the reload");
    if (before.coop !== null) {
      await page.waitForSelector(coop, { timeout: 3000 }).catch(() => {});
      expect(await page.isChecked(coop) === !before.coop, "Co-op Lobby Beta switch did not survive the reload");
    } else note("no Co-op Lobby Beta switch on this build");
    expect(await page.locator('#beta-body [data-ui-beta-card] [data-action="ui-set"][data-ui="classic"]').count() === 1, "Beta tab has no layout switch back to classic");
    // Put things back.
    await page.locator(shot).click({ force: true });
    await page.click('#beta-body [data-rc-action="set-provider"][data-provider="openai"]');
    if (before.coop !== null) { await page.locator(coop).click({ force: true }); await settle(page, 500); }
  });

  await check("9d. settings: every preference toggle persists across a reload", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "settings");
    const keys = await page.$$eval("#settings-body [data-pref-key]", (els) => els.map((el) => el.dataset.prefKey));
    expect(keys.length >= 3, `only ${keys.length} preference toggles`);
    const before = {};
    for (const key of keys) {
      before[key] = await page.isChecked(`#settings-body [data-pref-key="${key}"]`);
      await page.click(`#settings-body [data-pref-key="${key}"]`, { force: true });
    }
    const classes = await page.evaluate(() => [...document.documentElement.classList]);
    if (keys.includes("reducedMotion")) expect(classes.includes("prefer-reduced-motion") === !before.reducedMotion, "Reduced motion did not toggle the <html> class");
    if (keys.includes("compactDensity")) expect(classes.includes("prefer-compact-density") === !before.compactDensity, "Compact tiles did not toggle the <html> class");
    await reload(page);
    await gotoTab(page, "settings");
    for (const key of keys) expect(await page.isChecked(`#settings-body [data-pref-key="${key}"]`) === !before[key], `${key} did not survive the reload`);
    const after = await page.evaluate(() => [...document.documentElement.classList]);
    if (keys.includes("compactDensity")) expect(after.includes("prefer-compact-density") === !before.compactDensity, "Compact tiles not re-applied after reload");
    for (const key of keys) await page.click(`#settings-body [data-pref-key="${key}"]`, { force: true });
  });

  // 10. Themes and layout round trip --------------------------------------------
  await check("10a. theme picker: all 8 themes apply; Auto follows the most-played hero; T cycles", async ({ expect, use }) => {
    use(page);
    await gotoTab(page, "overview");
    await page.click(".sidebar-brand .v-theme-btn");
    await page.waitForSelector("#v-theme-pop");
    const ids = await page.$$eval("#v-theme-pop [data-theme-id]", (els) => els.map((el) => el.dataset.themeId));
    expect(ids.join() === THEMES.join(), `picker themes [${ids.join(", ")}]`);
    const seen = new Set();
    for (const id of ids) {
      await page.click(`#v-theme-pop [data-theme-id="${id}"]`);
      await settle(page, 250);
      const state = await page.evaluate(() => ({
        painted: document.documentElement.dataset.theme,
        stored: localStorage.getItem("vault.web.theme"),
        checked: document.querySelector('#v-theme-pop [aria-checked="true"]')?.dataset.themeId,
        bg: getComputedStyle(document.documentElement).getPropertyValue("--v-bg").trim(),
      }));
      const want = id === "auto" ? exp.mostPlayed : id;
      expect(state.painted === want, `${id}: painted "${state.painted}", expected "${want}"`);
      expect(state.stored === id && state.checked === id, `${id}: stored ${state.stored}, checked ${state.checked}`);
      seen.add(state.bg);
      if (!(await page.locator("#v-theme-pop").count())) await page.click(".sidebar-brand .v-theme-btn");
    }
    expect(seen.size >= 7, `only ${seen.size} distinct backgrounds across 8 themes`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.SpireVault.setTheme("inked"));
    await page.evaluate(() => document.activeElement?.blur());
    const order = [];
    for (let i = 0; i < THEMES.length; i += 1) {
      await page.keyboard.press("t");
      await settle(page, 120);
      order.push(await page.evaluate(() => localStorage.getItem("vault.web.theme")));
    }
    const wantOrder = [...THEMES.slice(1), THEMES[0]];
    expect(order.join() === wantOrder.join(), `T cycled [${order.join(", ")}], expected [${wantOrder.join(", ")}]`);
  });

  await check("10b. layout: next → classic → next keeps the data and the theme", async ({ expect, use }) => {
    use(page);
    await page.evaluate(() => window.SpireVault.setTheme("regent"));
    await page.click(".sidebar-brand .v-theme-btn");
    await page.waitForSelector("#v-theme-pop");
    await page.click('#v-theme-pop [data-action="ui-set"][data-ui="classic"]');
    await page.waitForFunction(() => document.documentElement.dataset.ui === "classic" && window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    await gotoTab(page, "overview");
    await page.waitForSelector("#overview-body .kpi-strip, #overview-body .hero-overview", { timeout: BOOT_TIMEOUT_MS }).catch(() => {});
    const classicText = await page.evaluate(() => document.querySelector("#overview-body").innerText);
    expect(new RegExp(`\\b${exp.total}\\b`).test(classicText), `classic Overview does not show ${exp.total} runs`);
    expect(!(await page.locator(".v-stage-bg, .v-theme-btn").count()), "classic still has new-look chrome");
    await gotoTab(page, "settings");
    await page.click('#settings-body [data-ui-beta-card] [data-action="ui-set"][data-ui="next"]');
    await page.waitForFunction(() => document.documentElement.dataset.ui === "next" && window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await waitBoot(page);
    await gotoTab(page, "overview");
    await page.waitForSelector("#overview-body .v-ov", { timeout: BOOT_TIMEOUT_MS });
    expect(await overviewCount(page) === String(exp.total), `back on the new look Overview shows ${await overviewCount(page)} runs`);
    expect(await page.evaluate(() => document.documentElement.dataset.theme) === "regent", `theme after the round trip is "${await page.evaluate(() => document.documentElement.dataset.theme)}", expected "regent"`);
    await page.evaluate(() => window.SpireVault.setTheme("inked"));
  });

  // 12. Keyboard ------------------------------------------------------------------
  await check("12. keyboard: Tab reaches header and body with visible focus; Enter/Space work", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "overview");
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
    const stops = [];
    for (let i = 0; i < KEYBOARD_TAB_STOPS; i += 1) {
      await page.keyboard.press("Tab");
      stops.push(await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
        const r = el.getBoundingClientRect();
        return {
          id: `${el.tagName.toLowerCase()}${el.dataset.action ? `[${el.dataset.action}]` : ""}${el.dataset.tab ? `[tab=${el.dataset.tab}]` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : ""}`,
          region: el.closest(".sidebar") ? "rail" : el.closest(".panel-head") ? "header" : el.closest(".tab-panel") ? "body" : "other",
          ring: !!ring,
          visibleBox: r.width > 0 && r.height > 0,
        };
      }));
    }
    const real = stops.filter(Boolean);
    expect(real.some((s) => s.region === "rail" && /nav-row/.test(s.id)), "Tab never reached a sidebar tab");
    expect(real.some((s) => /v-theme-open/.test(s.id)), "Tab never reached the theme button");
    expect(real.some((s) => s.region === "header" && /upload/.test(s.id)), "Tab never reached the Import button");
    expect(real.some((s) => s.region === "body"), `Tab never reached the Overview body in ${KEYBOARD_TAB_STOPS} presses`);
    const noRing = [...new Set(real.filter((s) => !s.ring).map((s) => `${s.id} (${s.region})`))];
    expect(noRing.length === 0, `focused with no visible focus ring: ${noRing.join(", ")}`);
    const hidden = [...new Set(real.filter((s) => !s.visibleBox).map((s) => s.id))];
    expect(hidden.length === 0, `focus landed on invisible elements: ${hidden.join(", ")}`);
    note(`tab order (first 25): ${real.slice(0, 25).map((s) => s.id).join(" → ")}`);

    await page.focus('.nav-row[data-tab="characters"]');
    await page.keyboard.press("Enter");
    await settle(page);
    expect(await page.evaluate(() => window.SpireVault.activeTab()) === "characters", "Enter on a sidebar tab did not switch to it");
    await page.focus("#characters-body .v-cb");
    await page.keyboard.press(" ");
    await settle(page);
    expect(await page.locator("#char-detail-slot [data-char-detail]").count() === 1, "Space on a character banner did not open its codex");
    await gotoTab(page, "runs");
    await page.focus("#runs-body .run-row");
    await page.keyboard.press("Enter");
    await settle(page);
    expect(await page.locator("#run-detail-modal").isVisible(), "Enter on a run row did not open it");
    await page.keyboard.press("Escape");
    await settle(page);
    await page.focus('#runs-body [data-action="compare-toggle"]');
    await page.keyboard.press(" ");
    await settle(page);
    expect(await page.getAttribute('#runs-body [data-action="compare-toggle"]', "aria-pressed") === "true", "Space on Compare did not enter compare mode");
    await page.focus("#runs-body .run-row");
    await page.keyboard.press(" ");
    expect((await page.textContent("#compare-bar-count"))?.trim() === "1 run selected", "Space on a row in compare mode did not select it");
    await page.keyboard.press("Escape");
    await settle(page);
    await page.focus(".sidebar-brand .v-theme-btn");
    await page.keyboard.press("Enter");
    expect(await page.locator("#v-theme-pop").count() === 1, "Enter on the theme button did not open the picker");
    await page.keyboard.press("Escape");
    await gotoTab(page, "overview");
  });

  // 13. Export and Refresh ----------------------------------------------------------
  await check("13. export downloads every run; Refresh re-reads instead of claiming nothing is linked", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "overview");
    const toolbar = '.tab-panel[data-tab="overview"] > .panel-head';
    for (const format of ["json", "csv"]) {
      await page.click(`${toolbar} [data-action="toggle-export"]`);
      expect(await page.locator(`${toolbar} .app-toolbar-export-menu`).isVisible(), "export menu did not open");
      const download = page.waitForEvent("download", { timeout: 6000 });
      await page.click(`${toolbar} [data-action="export-${format}"]`);
      const file = await download;
      const text = readFileSync(await file.path(), "utf8");
      expect(new RegExp(`^spirevault-runs-\\d{4}-\\d{2}-\\d{2}\\.${format}$`).test(file.suggestedFilename()), `${format} file named ${file.suggestedFilename()}`);
      if (format === "json") {
        const json = JSON.parse(text);
        expect(json.runCount === exp.total && json.runs.length === exp.total, `JSON export has ${json.runCount}/${json.runs?.length} runs, expected ${exp.total}`);
      } else {
        const lines = text.split(/\r\n/).filter(Boolean);
        expect(lines.length === exp.total + 1 && lines[0].startsWith("id,character"), `CSV export has ${lines.length} lines, expected ${exp.total + 1}`);
      }
    }
    await gotoTab(page, "settings");
    for (const format of ["json", "csv"]) {
      const download = page.waitForEvent("download", { timeout: 6000 });
      await page.click(`#settings-body [data-action="settings-export-${format}"]`);
      expect((await download).suggestedFilename().endsWith(`.${format}`), `Settings Export ${format} did not download`);
    }
    const sub = await page.evaluate(() => [...document.querySelectorAll("#settings-body .settings-card")].find((c) => /Save data/.test(c.querySelector("h3")?.textContent || ""))?.querySelector(".settings-card-sub")?.textContent.replace(/\s+/g, " ").trim());
    const refreshState = await page.evaluate(() => {
      const b = document.querySelector('#settings-body [data-action="reload-saves"]');
      return b ? (b.disabled ? "disabled" : "enabled") : "missing";
    });
    note(`Settings save-data card says: "${sub}"; its Refresh button is ${refreshState}`);
    await gotoTab(page, "overview");
    await page.evaluate(() => { document.querySelector("#overview-body .v-ov").dataset.e2eMark = "before-refresh"; });
    await page.click(`${toolbar} [data-action="reload-saves"]`);
    await settle(page, 1200);
    const toast = await toastText(page);
    note(`toast after Refresh: "${toast}"`);
    expect(!/Nothing linked/i.test(toast), `Refresh right after importing a folder says "${toast}" (the toolbar offers Refresh and Settings says the folder is linked)`);
    expect(await overviewCount(page) === String(exp.total), "Refresh changed the run count");
  });

  // 15. Header stage: every climber ------------------------------------------------
  await check("15c. header stage: picking each climber renders its inked art", async ({ expect, use, note }) => {
    use(page);
    await gotoTab(page, "characters");
    await gotoTab(page, "overview");
    const slot = '.tab-panel[data-tab="overview"]';
    let coveredShot = "";
    for (const id of [...CLIMBERS, "random"]) {
      await page.click(`${slot} [data-action="companion-toggle"]`);
      const option = page.locator(`${slot} .companion-picker:not([hidden]) [data-companion-id="${id}"]`);
      if (!(await option.count())) { expect(false, `${id}: not in the picker`); await page.keyboard.press("Escape"); continue; }
      await option.scrollIntoViewIfNeeded().catch(() => {});
      const probe = await option.evaluate((el) => {
        const img = el.querySelector("img");
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const cover = hit && !el.contains(hit) ? hit.closest("[class]") : null;
        return {
          img: img ? img.complete && img.naturalWidth > 0 : null,
          covered: cover ? `${cover.tagName.toLowerCase()}.${String(cover.className).trim().split(/\s+/).slice(0, 2).join(".")}` : "",
        };
      });
      if (id !== "random") expect(probe.img, `${id}: picker option has no loaded image`);
      if (probe.covered) {
        expect(false, `${id}: picker option is covered by ${probe.covered} and cannot be clicked`);
        if (!coveredShot) { coveredShot = join(OUT, "FAIL-15c-picker-option-covered.png"); await page.screenshot({ path: coveredShot }); }
        await option.dispatchEvent("click");
      } else {
        await option.click({ timeout: 5000 });
      }
      await settle(page, 400);
      await page.waitForFunction((s) => [...document.querySelectorAll(`${s} .v-actor img`)].every((img) => img.complete), slot, { timeout: 5000 }).catch(() => {});
      const actor = await page.evaluate((s) => {
        const climber = document.querySelector(`${s} .v-actor--climber`);
        const img = climber?.querySelector("img.v-actor-art");
        return { src: img?.getAttribute("src") || null, ok: !!img && img.naturalWidth > 0, glyph: !!climber?.querySelector(".v-actor-glyph"), stored: localStorage.getItem("vault.web.companion") };
      }, slot);
      if (id === "random") {
        expect(actor.ok && ROSTER.some((c) => actor.src?.includes(`/${c}-ink-`)), `random rolled "${actor.src}"`);
      } else {
        expect(actor.ok && actor.src?.includes(`/${id}-ink-`), `${id}: climber art ${actor.glyph ? "is a letter glyph (no art)" : `"${actor.src}" (loaded: ${actor.ok})`}`);
      }
    }
    if (coveredShot) note(`covered picker screenshot: ${coveredShot}`);
  });

}
