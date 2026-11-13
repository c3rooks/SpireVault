#!/usr/bin/env node
/**
 * End-to-end sweep of the new look: every tab x every width x every theme.
 *
 * For each combination it fails on:
 *   - the page scrolling sideways, or a visible element sticking out past the
 *     right edge of the viewport
 *   - an image that failed to load (naturalWidth 0 after load)
 *   - a console error or uncaught exception (failed /api/* requests are
 *     expected on the static dev server and ignored)
 *   - a tab whose body is empty after render
 * and, per tab and width, on a theme switch that
 *   - makes any network request (themes must be an attribute swap)
 *   - moves the layout (no element in the tab panel may shift position)
 *   - leaves the page unchanged (the tab must actually recolour)
 *
 * Writes one viewport screenshot per tab x width (Inked) to --out.
 *
 *   node scripts/verify-ui-next-matrix.mjs --base-url http://127.0.0.1:8788
 *   node scripts/verify-ui-next-matrix.mjs --tabs runs,coop --widths 375,1440 --themes inked,vault
 */

import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TABS = ["overview", "characters", "ascensions", "relics", "cards", "runs", "coop", "highlights", "news", "beta", "settings"];
const WIDTHS = [320, 375, 768, 1024, 1440, 1920];
const THEMES = ["inked", "vault", "auto", "ironclad", "silent", "defect", "regent", "necrobinder"];
const SETTLE_MS = 900;
/** A theme swap may nudge sub-pixel text metrics; anything more is a shift. */
const SHIFT_TOLERANCE_PX = 1.5;
/**
 * Themes that deliberately change metrics: Classic Vault draws today's
 * palette on 1px gold outlines with its own heading face (see the plan's
 * theme list), so boxes move by a pixel or two when it is picked. Every other
 * theme is a pure colour swap and must not move anything.
 */
const METRIC_THEMES = new Set(["vault"]);
/** Third-party beacons (GA4 theme_change / page_view) are expected traffic. */
const EXPECTED_HOSTS = /google-analytics\.com|googletagmanager\.com|\/api\//;

/** @param {string} name @param {string} fallback */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

const options = {
  baseUrl: arg("base-url", "http://127.0.0.1:8788"),
  tabs: list(arg("tabs", TABS.join(","))),
  widths: list(arg("widths", WIDTHS.join(","))).map(Number),
  themes: list(arg("themes", THEMES.join(","))),
  engine: arg("engine", "chromium"),
  out: arg("out", join(REPO_ROOT, "docs", "screenshots", "ui-next", "matrix")),
};

/** Runs in the page: layout problems on the visible tab. @param {string} tab */
function inspect(tab) {
  const problems = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) {
    problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
  }
  const panel = document.querySelector(`.tab-panel[data-tab="${tab}"]`);
  if (!panel || panel.hidden || getComputedStyle(panel).display === "none") {
    return { problems: [...problems, "tab panel not shown"], positions: [] };
  }
  const body = panel.querySelector(`#${tab}-body`) || panel;
  if (body.textContent.trim().length < 2 && !body.querySelector("img, svg, canvas")) {
    problems.push("tab body is empty");
  }
  const offenders = [];
  panel.querySelectorAll("*").forEach((el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // Inside a horizontal scroller (a swipe strip) is fine.
    let scroller = el.parentElement;
    while (scroller && scroller !== panel) {
      const s = getComputedStyle(scroller);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return;
      scroller = scroller.parentElement;
    }
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").filter(Boolean).slice(0, 2).join(".")} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
  });
  if (offenders.length) problems.push(`off-screen: ${offenders.slice(0, 4).join("; ")}${offenders.length > 4 ? ` (+${offenders.length - 4})` : ""}`);
  const broken = [...panel.querySelectorAll("img")].filter(
    (img) => img.complete && img.naturalWidth === 0 && img.getAttribute("src") && getComputedStyle(img).display !== "none",
  );
  if (broken.length) problems.push(`broken images: ${broken.slice(0, 3).map((i) => i.getAttribute("src")).join(", ")}`);
  // Positions of the first 400 visible elements, for the shift check.
  const positions = [...panel.querySelectorAll("*")]
    .slice(0, 4000)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .slice(0, 400)
    .map((r) => [Math.round(r.left * 2) / 2, Math.round(r.top * 2) / 2, Math.round(r.width * 2) / 2]);
  return { problems, positions };
}

/** A cheap fingerprint of the tab's colours, to prove a theme swap repainted. */
function colourPrint(tab) {
  const panel = document.querySelector(`.tab-panel[data-tab="${tab}"]`);
  const els = [document.body, ...[...(panel ? panel.querySelectorAll("*") : [])].slice(0, 300)];
  return els.map((el) => {
    const s = getComputedStyle(el);
    return `${s.color}|${s.backgroundColor}|${s.borderTopColor}`;
  }).join(";");
}

async function main() {
  mkdirSync(options.out, { recursive: true });
  const engine = options.engine === "webkit" ? webkit : chromium;
  const browser = await engine.launch();
  const failures = [];
  let checks = 0;
  for (const width of options.widths) {
    const context = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, reducedMotion: "reduce" });
    await context.addInitScript(() => {
      try { window.localStorage.setItem("vault.web.companion.v2", "ironclad"); } catch { /* none */ }
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/Failed to load resource: the server responded with a status of 404/.test(text)) return;
      consoleErrors.push(text.slice(0, 160));
    });
    page.on("pageerror", (err) => consoleErrors.push(`uncaught: ${String(err.message).slice(0, 160)}`));
    page.on("requestfailed", (req) => {
      if (!EXPECTED_HOSTS.test(req.url())) consoleErrors.push(`request failed: ${req.url()}`);
    });
    page.on("response", (res) => {
      const url = res.url();
      if (res.status() >= 400 && !EXPECTED_HOSTS.test(url)) consoleErrors.push(`HTTP ${res.status()}: ${url}`);
    });
    await page.goto(`${options.baseUrl}/?ui=next&theme=inked`, { waitUntil: "load" });
    await page.waitForFunction(() => window.SpireVault && document.querySelector(".v-duel"), null, { timeout: 20000 });
    for (const tab of options.tabs) {
      await page.evaluate((t) => window.SpireVault.switchTab(t), tab);
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => window.SpireVault.setTheme("inked"));
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(options.out, `${tab}-${width}.png`) });
      const base = await page.evaluate(inspect, tab);
      const basePrint = await page.evaluate(colourPrint, tab);
      for (const theme of options.themes) {
        checks += 1;
        const label = `${tab} ${width}px ${theme}`;
        const requests = [];
        const onRequest = (req) => requests.push(req.url());
        page.on("request", onRequest);
        const errorsBefore = consoleErrors.length;
        await page.evaluate((t) => window.SpireVault.setTheme(t), theme);
        await page.waitForTimeout(250);
        page.off("request", onRequest);
        const now = await page.evaluate(inspect, tab);
        const problems = [...now.problems];
        // Requests the app makes on its own timers (presence, rooms) are not
        // the theme's doing; only flag non-API requests.
        const themeRequests = requests.filter((u) => !EXPECTED_HOSTS.test(u));
        if (themeRequests.length) problems.push(`theme switch fetched: ${themeRequests.slice(0, 3).join(", ")}`);
        const shifted = now.positions.findIndex((p, i) => {
          const q = base.positions[i];
          return !q || Math.abs(p[0] - q[0]) > SHIFT_TOLERANCE_PX || Math.abs(p[1] - q[1]) > SHIFT_TOLERANCE_PX || Math.abs(p[2] - q[2]) > SHIFT_TOLERANCE_PX;
        });
        if (!METRIC_THEMES.has(theme) && (shifted !== -1 || now.positions.length !== base.positions.length)) {
          problems.push(`layout moved on theme switch (element #${shifted}, ${base.positions.length} -> ${now.positions.length} boxes)`);
        }
        if (theme !== "inked" && theme !== "auto" && (await page.evaluate(colourPrint, tab)) === basePrint) {
          problems.push("theme switch did not recolour the tab");
        }
        if (consoleErrors.length > errorsBefore) problems.push(...consoleErrors.slice(errorsBefore));
        if (problems.length) failures.push(`${label}:\n  - ${problems.join("\n  - ")}`);
      }
    }
    if (consoleErrors.length) {
      const early = consoleErrors.filter((e) => !failures.some((f) => f.includes(e)));
      if (early.length) failures.push(`${width}px page load:\n  - ${early.slice(0, 6).join("\n  - ")}`);
    }
    await context.close();
  }
  await browser.close();
  failures.forEach((f) => console.log(`FAIL ${f}`));
  console.log(`${checks - failures.length}/${checks} tab x width x theme combinations clean (${options.engine}); screenshots in ${options.out}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
