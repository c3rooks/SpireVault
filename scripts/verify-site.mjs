#!/usr/bin/env node
/**
 * Checks for the landing page in Site/ (spirevault.app). Exits 1 if any fail.
 *
 * Serves Site/ through scripts/dev-site.mjs, so the page runs under its real
 * headers and content-security-policy, with the two endpoints it calls
 * (presence, GitHub release) answered by stubs.
 *
 *   layout   no sideways scroll, nothing off-screen, cut or covered, no broken
 *            pictures; on phones 44px tap targets and 11px text
 *   fold     the whole first screen (headline, buttons, featured card, hand)
 *            fits in 1440x760, 1454x816 and 1728x950
 *   hand     each climber the roll can feature: their card, painting and line;
 *            the other five (The Fool among them) in the hand; all on screen
 *   sharp    no picture on the page is drawn past its own pixels at 2x
 *   health   no console errors, failed requests, CSP violations or requests
 *            to hosts the CSP does not list
 *   content  old brand names gone, Mega Crit notice and anchors present, every
 *            asset reference exists and is versioned, one shared ?v=
 *   links    every external link the old page had is still there
 *   wiring   live count, release links and version pills in three cases
 *            (people signed up, nobody, both endpoints down); the screenshot
 *            buttons; a link to an answer opens it
 *   motion   nothing runs under reduced motion; otherwise only transform /
 *            opacity animate and the hero ignores the pointer
 *   perf     fonts load, layout shift under 0.1, first-screen weight inside
 *            its budget
 *   contrast body text and button labels reach 4.5:1 (3:1 when large)
 *
 *   node scripts/verify-site.mjs
 *   node scripts/verify-site.mjs --only wiring,content
 *   node scripts/verify-site.mjs --engines chromium,webkit --widths 320,390,1440
 *   node scripts/verify-site.mjs --base-url http://127.0.0.1:8791
 */

import { chromium, firefox, webkit } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startSiteServer } from "./site-server.mjs";
import { heroGeometry, lowContrast } from "./verify-site-page.mjs";
import { checkFold, checkHand, checkSharp } from "./verify-site-hero.mjs";
import { RELEASE, RELEASES_PAGE, SCENARIOS, SITE_ROOT, existsExactly, loadLazy, openPage } from "./verify-site-harness.mjs";
import { collectFindings } from "./mobile-audit/page-checks.mjs";

const OWN_PORT = 8797;
const ENGINES = Object.freeze({ chromium, firefox, webkit });
const GROUPS = Object.freeze(["layout", "fold", "hand", "sharp", "health", "content", "links", "wiring", "motion", "perf", "contrast", "resilience"]);
const HEIGHTS = Object.freeze({ 320: 568, 375: 812, 390: 844, 768: 1024, 1024: 768, 1100: 720, 1280: 720, 1366: 768, 1440: 900, 1728: 1000, 1920: 1080, 2560: 1300 });
const DEFAULT_WIDTHS = "320,375,390,768,1024,1100,1280,1366,1440,1728,1920,2560";
/** The duel is checked at a phone and the two review windows, whatever --widths says. */
const HAND_WIDTHS = Object.freeze([320, 390, 768, 1024, 1100, 1280, 1454, 1728]);
/** Screens the sharpness check looks at, all at 2x. */
const SHARP_SCREENS = Object.freeze([
  { width: 390, height: 844, phone: true },
  { width: 1024, height: 768 },
  { width: 1454, height: 816 },
  { width: 1728, height: 1000 },
]);
/** Every screen button's picture must exist in these sizes. */
const SHOT_FILES = Object.freeze(["960", "1440", "1920", "2880", "phone-780", "phone-1170"]);
const PHONE_MAX_W = 480;
/** Widths where the viewer's buttons sit beside the picture, and how far the picture may be cropped. */
const VIEWER_WIDTHS = Object.freeze([1100, 1280, 1440, 1728]);
const VIEWER_MIN_RATIO = 1.5;
const DESKTOP_MIN_W = 1100;
/** Windows the first screen must fit whole: a 1440 laptop and his 1728 Safari. */
const FOLDS = Object.freeze([{ width: 1440, height: 760 }, { width: 1454, height: 816 }, { width: 1728, height: 950 }]);
const OLD_BRAND = /\bThe Vault\b|\bSpire Vault\b/i;
/** Asset files that keep an unversioned name on purpose (old links point at them). */
const UNVERSIONED_OK = Object.freeze(["/assets/vault-mark.svg", "/assets/og.png"]);
/** Every external link today's page has: the new page must keep each. */
const REQUIRED_LINKS = Object.freeze([
  "https://github.com/c3rooks/SpireVault",
  "https://app.spirevault.app",
  "https://github.com/c3rooks/SpireVault/blob/main/SECURITY.md",
  "https://github.com/c3rooks/SpireVault/releases/latest",
  "https://github.com/c3rooks/SpireVault/blob/main/LICENSE",
  "https://github.com/c3rooks/SpireVault/issues/new",
  "https://github.com/c3rooks/SpireVault#build-from-source",
  "https://github.com/c3rooks/SpireVault#run-coach-beta",
  "https://coreycrooks.com",
  "https://apps.apple.com/us/app/ascension-companion/id6761977581",
]);
/**
 * Addresses that must redirect, and where to. The last one is the Mac
 * installer's old address: the installer is no longer served from this site,
 * and without a rule Cloudflare Pages would answer that address with the
 * landing page itself (it serves index.html for any unknown path).
 */
const REDIRECTS = Object.freeze([
  ["/download", "/#install"],
  ["/coop", "/#coop"],
  ["/github", "https://github.com/c3rooks/SpireVault"],
  ["/assets/The.Vault.dmg", "https://github.com/c3rooks/SpireVault/releases/latest"],
]);
const REQUIRED_IDS = Object.freeze(["main", "features", "showcase", "coop", "trust", "install", "install-web", "install-mac", "install-win", "faq", "runcoach"]);
const FIRST_SCREEN_BUDGET = Object.freeze({ desktop: 520 * 1024, phone: 400 * 1024 });
/** Everything fetched before scrolling, lazy pictures included, may be this many times the budget. */
const LAZY_HEADROOM = 1.5;
const PHONE_LIMITS = Object.freeze({ ignore: "", minTapPx: 44, goodTapPx: 44, minTextPx: 11, goodTextPx: 12, zoomSafeInputPx: 16, maxSamples: 6, maxCoveredProbes: 300 });
const DESKTOP_LIMITS = Object.freeze({ ...PHONE_LIMITS, minTapPx: 24 });


const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const list = (name, fallback) => String(arg(name, fallback)).split(",").map((s) => s.trim()).filter(Boolean);

// ---- Check groups ---------------------------------------------------------------

/** @returns {Promise<string[]>} */
async function checkLayout(browser, baseUrl, engine, width) {
  const phone = width <= PHONE_MAX_W;
  const { page, context, log } = await openPage(browser, baseUrl, { width, height: HEIGHTS[width] || 900, phone });
  const failures = [];
  try {
    await loadLazy(page);
    const report = await page.evaluate(collectFindings, phone ? PHONE_LIMITS : DESKTOP_LIMITS);
    const names = (bucket) => (bucket.samples || []).map((s) => `${s.el || ""} "${s.text || ""}"`).join("; ");
    if (report.pageOverflowPx > 0) failures.push(`page scrolls sideways by ${report.pageOverflowPx}px`);
    for (const key of ["offscreen", "clipped", "truncated", "covered", "brokenImages"]) {
      if (report[key].count > 0) failures.push(`${key}: ${report[key].count} (${names(report[key])})`);
    }
    if (phone && report.targetsTooSmall.count > 0) failures.push(`tap targets under 44px: ${report.targetsTooSmall.count} (${names(report.targetsTooSmall)})`);
    if (report.textTooSmall.count > 0) failures.push(`text under 11px: ${report.textTooSmall.count} (${names(report.textTooSmall)})`);
    const emptyImages = await page.evaluate(() =>
      Array.from(document.images)
        .filter((img) => img.getBoundingClientRect().width > 0 && (!img.complete || img.naturalWidth === 0))
        .map((img) => img.getAttribute("src")),
    );
    if (emptyImages.length) failures.push(`pictures that did not load: ${emptyImages.join(", ")}`);
    if (log.failed.length) failures.push(`failed requests: ${[...new Set(log.failed)].join("; ")}`);
    if (width >= DESKTOP_MIN_W) {
      const geo = await page.evaluate(heroGeometry);
      if (geo.lastCopyChild && geo.hero && geo.lastCopyChild.bottom > geo.hero.bottom - 8) failures.push("hero copy runs into the hero's bottom edge");
    }
  } finally {
    await context.close();
  }
  return failures;
}

async function checkHealth(browser, baseUrl) {
  const { page, context, log } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad" });
  const failures = [];
  try {
    await loadLazy(page);
    await page.waitForTimeout(600);
    const csp = await page.evaluate(() => window.__csp || []);
    if (csp.length) failures.push(`content-security-policy violations: ${[...new Set(csp)].join("; ")}`);
    if (log.console.length) failures.push(`console errors: ${[...new Set(log.console)].join("; ")}`);
    if (log.failed.length) failures.push(`failed requests: ${[...new Set(log.failed)].join("; ")}`);
    if (log.hosts.length) failures.push(`requests to hosts the CSP does not list: ${[...new Set(log.hosts)].join(", ")}`);
    const inline = await page.evaluate(() => ({ styles: document.querySelectorAll("[style]").length, styleTags: document.querySelectorAll("style").length, scripts: document.querySelectorAll("script:not([src])").length }));
    if (inline.styleTags || inline.scripts) failures.push(`inline <style> or <script> in the page (${inline.styleTags}/${inline.scripts})`);
    if (inline.styles) failures.push(`${inline.styles} element(s) carry a style attribute, which the CSP would block`);
  } finally {
    await context.close();
  }
  return failures;
}

async function checkContent(browser, baseUrl) {
  const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900 });
  const failures = [];
  try {
    const found = await page.evaluate(() => {
      const attrs = [];
      document.querySelectorAll("[alt], [title], [aria-label], meta[content]").forEach((el) => {
        for (const name of ["alt", "title", "aria-label", "content"]) {
          const value = el.getAttribute(name);
          if (value) attrs.push(value);
        }
      });
      const refs = new Set();
      document.querySelectorAll("[src], link[href], [srcset]").forEach((el) => {
        for (const name of ["src", "href"]) {
          const value = el.getAttribute(name);
          if (value && value.startsWith("/")) refs.add(value);
        }
        const srcset = el.getAttribute("srcset");
        if (srcset) srcset.split(",").forEach((part) => refs.add(part.trim().split(/\s+/)[0]));
      });
      // Link-preview pictures are absolute URLs on the live host: check the file they name.
      document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]').forEach((meta) => {
        try {
          const url = new URL(meta.getAttribute("content") || "");
          if (url.hostname === "spirevault.app") refs.add(url.pathname + url.search);
        } catch {
          refs.add("(unreadable link-preview picture URL)");
        }
      });
      return {
        text: document.body.innerText,
        title: document.title,
        attrs,
        refs: [...refs],
        ids: Array.from(document.querySelectorAll("[id]"), (el) => el.id),
        h1: document.querySelectorAll("h1").length,
      };
    });
    const everything = [found.title, found.text, ...found.attrs].join("\n");
    const brand = OLD_BRAND.exec(everything);
    if (brand) failures.push(`old brand name on the page: "${brand[0]}"`);
    if (!/Not affiliated with Mega Crit/i.test(found.text)) failures.push("Mega Crit notice missing");
    if (!/SpireVault/.test(found.title)) failures.push("title does not say SpireVault");
    if (found.h1 !== 1) failures.push(`expected one h1, found ${found.h1}`);
    for (const id of REQUIRED_IDS) if (!found.ids.includes(id)) failures.push(`anchor #${id} missing`);
    const dupes = found.ids.filter((id, i) => found.ids.indexOf(id) !== i);
    if (dupes.length) failures.push(`duplicate ids: ${[...new Set(dupes)].join(", ")}`);

    // Every local reference, in the page and in the stylesheets, must exist;
    // everything under /assets/ must carry a version in its name.
    const cssRefs = [];
    for (const ref of found.refs.filter((r) => /\.css(\?|$)/.test(r))) {
      const file = join(SITE_ROOT, ref.split("?")[0]);
      if (!existsSync(file)) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/url\(["']?(\/[^"')]+)["']?\)/g)) cssRefs.push(m[1]);
    }
    const versions = new Set();
    for (const ref of [...new Set([...found.refs, ...cssRefs])]) {
      const [path, query] = ref.split("?");
      if (!existsExactly(join(SITE_ROOT, path))) failures.push(`missing file (or wrong letter case): ${ref}`);
      if (path.startsWith("/assets/") && !UNVERSIONED_OK.includes(path) && !/-v\d+\.[a-z0-9]+$/.test(path)) failures.push(`asset without a version in its name: ${path}`);
      if (/\.(css|js)$/.test(path)) versions.add(query || "(none)");
    }
    if (versions.size !== 1 || versions.has("(none)")) failures.push(`CSS and JS must share one ?v=; found ${[...versions].join(", ")}`);
  } finally {
    await context.close();
  }
  return failures;
}

async function checkLinks(browser, baseUrl) {
  const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, scenario: SCENARIOS.down });
  const failures = [];
  try {
    const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]"), (a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel })));
    const all = hrefs.map((h) => (h.href || "").replace(/\/$/, ""));
    for (const want of REQUIRED_LINKS) if (!all.includes(want)) failures.push(`link missing: ${want}`);
    for (const h of hrefs) {
      if (h.target === "_blank" && !/noopener/.test(h.rel)) failures.push(`new-tab link without rel=noopener: ${h.href}`);
      if (/^https?:/.test(h.href || "") && !/^https:\/\/(github\.com\/c3rooks\/SpireVault|app\.spirevault\.app|coreycrooks\.com|apps\.apple\.com\/us\/app\/ascension-companion)/.test(h.href)) failures.push(`unexpected external link: ${h.href}`);
    }
  } finally {
    await context.close();
  }
  // The short addresses, asked for without following them.
  for (const [from, to] of REDIRECTS) {
    try {
      const response = await fetch(`${baseUrl}${from}`, { redirect: "manual" });
      const location = response.headers.get("location") || "";
      const lands = location.startsWith("http") ? location : new URL(location || "/", baseUrl).href.slice(new URL(baseUrl).origin.length);
      if (response.status < 300 || response.status >= 400) failures.push(`${from} answers ${response.status} instead of redirecting to ${to}`);
      else if (lands !== to) failures.push(`${from} redirects to ${location || "nowhere"}, expected ${to}`);
    } catch (error) {
      failures.push(`${from}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

async function checkWiring(browser, baseUrl) {
  const failures = [];
  const read = (page) =>
    page.evaluate(() => {
      const text = (id) => (document.getElementById(id)?.textContent || "").trim();
      const link = (id) => {
        const a = document.getElementById(id);
        return a ? { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") } : null;
      };
      return {
        presence: text("presence-text"),
        count: text("presence-count"),
        label: text("presence-label"),
        ingame: text("presence-ingame"),
        empty: document.getElementById("coop-card")?.classList.contains("is-empty"),
        pills: ["hero-version", "hero-version-win", "install-version", "install-version-win"].map(text),
        dmg: link("dmg-link"),
        macCta: link("download-cta-mac"),
        exe: link("exe-link"),
        winCta: link("download-cta-win"),
      };
    });
  const expect = (where, label, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${where}: ${label} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };
  const cases = [
    ["busy", SCENARIOS.busy, (s) => {
      expect("busy", "hero line", s.presence, "7 signed up · 2 currently in Slay the Spire 2");
      expect("busy", "count", [s.count, s.label, s.ingame, s.empty], ["7", "players signed up", "2", false]);
      expect("busy", "version pills", s.pills, ["v9.9.9-test", "v9.9.9-test", "v9.9.9-test", "v9.9.9-test"]);
      expect("busy", "macOS download", s.dmg, { href: RELEASE.dmg, target: "_blank", rel: "noopener" });
      expect("busy", "hero macOS link", s.macCta, { href: RELEASE.dmg, target: "_blank", rel: "noopener" });
      expect("busy", "Windows download", s.exe, { href: RELEASE.exe, target: "_blank", rel: "noopener" });
      expect("busy", "hero Windows link", s.winCta, { href: RELEASE.exe, target: "_blank", rel: "noopener" });
    }],
    ["empty", SCENARIOS.empty, (s) => {
      expect("empty", "hero line", s.presence, "Be the first to sign up.");
      expect("empty", "count", [s.count, s.label, s.ingame, s.empty], ["—", "no one signed up yet · be the first", "—", true]);
      // A release with no installers attached shows no version on either
      // platform: a pill names a version only where that installer exists.
      expect("empty", "version pills", s.pills, ["", "", "", ""]);
      expect("empty", "macOS download", s.dmg?.href, RELEASES_PAGE);
      expect("empty", "hero macOS link", s.macCta?.href, "#install-mac");
      expect("empty", "Windows download", s.exe?.href, RELEASES_PAGE);
      expect("empty", "hero Windows link", s.winCta?.href, "#install-win");
    }],
    ["down", SCENARIOS.down, (s) => {
      expect("down", "hero line", s.presence, "Live count unavailable right now.");
      expect("down", "count", [s.count, s.label, s.ingame, s.empty], ["—", "live count unavailable right now", "—", true]);
      expect("down", "version pills", s.pills, ["", "", "", ""]);
      expect("down", "macOS download", s.dmg?.href, RELEASES_PAGE);
      expect("down", "Windows download", s.exe?.href, RELEASES_PAGE);
    }],
  ];
  for (const [name, scenario, assert] of cases) {
    const { page, context, log } = await openPage(browser, baseUrl, { width: 1440, height: 900, scenario });
    try {
      await page.waitForTimeout(500);
      assert(await read(page));
      if (log.console.length && name !== "down") failures.push(`${name}: console errors: ${log.console.join("; ")}`);
    } finally {
      await context.close();
    }
  }

  // The screenshot buttons: each one swaps the picture, by click and by arrow key.
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900 });
    try {
      const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".viewer-tab"), (t) => t.dataset.shot));
      if (tabs.length < 5) failures.push(`viewer: expected at least 5 screen buttons, found ${tabs.length}`);
      for (const shot of tabs) {
        await page.click(`.viewer-tab[data-shot="${shot}"]`);
        const state = await page.evaluate((name) => {
          const tab = document.querySelector(`.viewer-tab[data-shot="${name}"]`);
          const img = document.getElementById("viewer-shot");
          return { selected: tab.getAttribute("aria-selected"), src: img.getAttribute("src"), alt: img.getAttribute("alt"), others: document.querySelectorAll('.viewer-tab[aria-selected="true"]').length, labelledby: document.getElementById("viewer-panel").getAttribute("aria-labelledby"), id: tab.id };
        }, shot);
        await page
          .waitForFunction((name) => {
            const img = document.getElementById("viewer-shot");
            return img.complete && img.naturalWidth > 0 && img.currentSrc.includes(`/assets/shots/${name}-`);
          }, shot, { timeout: 20_000 })
          .catch(() => failures.push(`viewer: the ${shot} picture did not load`));
        for (const size of SHOT_FILES) {
          const shotFile = `${shot}-${size}-v3.webp`;
          if (!existsSync(join(SITE_ROOT, "assets", "shots", shotFile))) failures.push(`viewer: missing file assets/shots/${shotFile}`);
        }
        if (state.selected !== "true" || state.others !== 1) failures.push(`viewer: ${shot} not the one selected button`);
        if (!state.src.includes(`/assets/shots/${shot}-`)) failures.push(`viewer: ${shot} shows ${state.src}`);
        if (!state.alt || state.alt.length < 20) failures.push(`viewer: ${shot} has no description`);
        if (state.labelledby !== state.id) failures.push(`viewer: panel not labelled by the ${shot} button`);
      }
      await page.focus(`.viewer-tab[data-shot="${tabs[0]}"]`);
      await page.keyboard.press("ArrowDown");
      const moved = await page.evaluate(() => document.activeElement?.dataset?.shot || "");
      if (moved !== tabs[1]) failures.push(`viewer: ArrowDown from the first button lands on "${moved}"`);
    } finally {
      await context.close();
    }
  }

  // A link to an answer opens it.
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 390, height: 844, query: "climber=ironclad&motion=off#runcoach", phone: true });
    try {
      const open = await page.evaluate(() => document.getElementById("runcoach")?.open === true);
      if (!open) failures.push("a link to #runcoach does not open that answer");
    } finally {
      await context.close();
    }
  }

  return failures;
}

async function checkMotion(browser, baseUrl) {
  const failures = [];
  const ALLOWED = ["transform", "translate", "rotate", "scale", "opacity", "clipPath", "filter", "offset", "computedOffset", "easing", "composite"];
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad", reducedMotion: "reduce" });
    try {
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
      if (running > 0) failures.push(`reduced motion: ${running} animation(s) still running`);
      const hidden = await page.evaluate(() => Array.from(document.querySelectorAll("[data-reveal]")).filter((el) => getComputedStyle(el).opacity !== "1").length);
      if (hidden > 0) failures.push(`reduced motion: ${hidden} section(s) left invisible`);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad" });
    try {
      const report = await page.evaluate((allowed) => {
        const animations = document.getAnimations();
        const bad = new Set();
        for (const animation of animations) {
          const frames = animation.effect && animation.effect.getKeyframes ? animation.effect.getKeyframes() : [];
          for (const frame of frames) for (const key of Object.keys(frame)) if (!allowed.includes(key)) bad.add(key);
        }
        const inHand = animations.filter((a) => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest(".hero-stage")).length;
        return { running: inHand, bad: [...bad] };
      }, ALLOWED);
      if (report.running < 5) failures.push(`motion: only ${report.running} of the hand's five cards are moving`);
      if (report.bad.length) failures.push(`motion: animating layout properties: ${report.bad.join(", ")}`);

      // The hero must not answer the pointer: freeze the clocks, move the mouse, compare.
      // pause() only takes hold on the next frame, so wait for it before measuring.
      await page.evaluate(async () => {
        const all = document.getAnimations();
        all.forEach((a) => a.pause());
        await Promise.all(all.map((a) => a.ready.catch(() => null)));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      });
      const snapshot = () => page.evaluate(() => Array.from(document.querySelectorAll(".hero .featured, .hero .hand-card, .hero .hand-tag"), (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10)).join(","); }).join("|"));
      const before = await snapshot();
      // Hover the middle of the featured card and of every hand card, and look
      // after each move: a lift that drops back when the pointer leaves would
      // slip past a single look at the end.
      const points = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".hero .featured, .hero .hand-card")).filter((el) => el.getClientRects().length > 0).map((el) => {
          const r = el.getBoundingClientRect();
          return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
        }),
      );
      if (points.length < 6) failures.push(`motion: the pointer test found only ${points.length} hero pieces to hover`);
      let moved = false;
      for (const [x, y] of points) {
        await page.mouse.move(x, y, { steps: 3 });
        await page.waitForTimeout(80);
        if ((await snapshot()) !== before) moved = true;
      }
      if (moved) failures.push("motion: something in the hero moved with the pointer");
    } finally {
      await context.close();
    }
  }
  return failures;
}

async function checkPerf(browser, baseUrl) {
  const failures = [];
  for (const [label, width, height, budget] of [["desktop", 1440, 900, FIRST_SCREEN_BUDGET.desktop], ["phone", 390, 844, FIRST_SCREEN_BUDGET.phone]]) {
    const { page, context, log } = await openPage(browser, baseUrl, { width, height, query: "climber=ironclad", phone: label === "phone" });
    try {
      await page.waitForTimeout(800);
      const state = await page.evaluate(() => ({
        fonts: ['900 40px "Grenze Gotisch"', '500 16px "Figtree"'].map((f) => document.fonts.check(f)),
        cls: window.__cls,
        lazy: Array.from(document.querySelectorAll('img[loading="lazy"]'), (img) => (img.currentSrc ? new URL(img.currentSrc).pathname : "")).filter(Boolean),
      }));
      if (state.fonts.includes(false)) failures.push(`${label}: a font did not load`);
      if (state.cls >= 0.1) failures.push(`${label}: layout shift ${state.cls.toFixed(3)}`);
      // Lazy pictures further down are fetched early by some browsers and not
      // by others; they are weighed apart, with a looser ceiling on the lot.
      const lazyBytes = log.responses.filter((r) => state.lazy.includes(new URL(r.url).pathname)).reduce((sum, r) => sum + r.bytes, 0);
      const needed = log.bytes - lazyBytes;
      const kb = (n) => Math.round(n / 1024);
      if (needed > budget) failures.push(`${label}: first screen weighs ${kb(needed)} KB, budget ${kb(budget)} KB`);
      if (log.bytes > budget * LAZY_HEADROOM) failures.push(`${label}: ${kb(log.bytes)} KB fetched before any scrolling, ceiling ${kb(budget * LAZY_HEADROOM)} KB`);
      process.stdout.write(`    ${label}: first screen ${kb(needed)} KB + ${kb(lazyBytes)} KB of lazy pictures fetched early, ${log.responses.length} requests, shift ${Number(state.cls).toFixed(3)}\n`);
    } finally {
      await context.close();
    }
  }
  return failures;
}

/**
 * Two states a visitor can be in that the other groups never load: the page
 * with JavaScript off, and the first paint on a window tall enough to show
 * the section under the hero before anyone scrolls.
 */
async function checkResilience(browser, baseUrl) {
  const failures = [];
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: "load" });
      const state = await page.evaluate(() => {
        const shown = (id) => {
          const el = document.getElementById(id);
          return el && el.getClientRects().length > 0 ? (el.textContent || "").trim() : null;
        };
        return {
          chip: shown("presence-text"),
          count: shown("presence-count"),
          hidden: Array.from(document.querySelectorAll("[data-reveal]")).filter((el) => getComputedStyle(el).opacity !== "1").length,
          featured: Array.from(document.querySelectorAll(".featured")).filter((el) => el.getClientRects().length > 0).length,
          hand: Array.from(document.querySelectorAll(".hand-card")).filter((el) => el.getClientRects().length > 0).length,
        };
      });
      if (state.chip !== null) failures.push(`without JavaScript the hero still shows "${state.chip}", which nothing will ever replace`);
      if (state.count !== null) failures.push(`without JavaScript the live-count ticket still shows "${state.count}"`);
      if (state.hidden) failures.push(`without JavaScript ${state.hidden} block(s) are invisible`);
      if (state.featured !== 1 || state.hand !== 5) failures.push(`without JavaScript the hero shows ${state.featured} featured card(s) and ${state.hand} hand cards`);
    } finally {
      await context.close();
    }
  }
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 1500, query: "climber=ironclad" });
    try {
      await page.waitForTimeout(1500);
      const unseen = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-reveal]"))
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.top < window.innerHeight && box.bottom > 0 && Number(getComputedStyle(el).opacity) < 0.99;
          })
          .map((el) => el.className || el.tagName),
      );
      if (unseen.length) failures.push(`on a tall window ${unseen.length} block(s) on screen at load stay invisible until scrolled: ${unseen.join(", ")}`);
    } finally {
      await context.close();
    }
  }
  // A climber the roll does not know (or The Fool, who is never featured) still gives one card and five.
  for (const wanted of ["bogus", "fool"]) {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: `climber=${wanted}&motion=off` });
    try {
      const shown = await page.evaluate(() => ({
        featured: Array.from(document.querySelectorAll(".featured")).filter((el) => el.getClientRects().length > 0).length,
        hand: Array.from(document.querySelectorAll(".hand-card")).filter((el) => el.getClientRects().length > 0).map((el) => el.dataset.c),
      }));
      if (shown.featured !== 1 || shown.hand.length !== 5) failures.push(`?climber=${wanted}: ${shown.featured} featured card(s) and ${shown.hand.length} hand cards`);
      if (!shown.hand.includes("fool")) failures.push(`?climber=${wanted}: The Fool is not in the hand`);
    } finally {
      await context.close();
    }
  }
  // ?motion=off on its own (the class, without the system setting) must still everything too.
  {
    const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900, query: "climber=ironclad&motion=off" });
    try {
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
      if (running > 0) failures.push(`?motion=off: ${running} animation(s) still running`);
    } finally {
      await context.close();
    }
  }
  // The screenshot viewer: the picture keeps its shape and the block does not
  // change height as screens are chosen, at the widths where the buttons sit beside it.
  for (const width of VIEWER_WIDTHS) {
    const { page, context } = await openPage(browser, baseUrl, { width, height: 900 });
    try {
      await loadLazy(page);
      const measure = () =>
        page.evaluate(() => {
          const frame = document.querySelector(".viewer-frame").getBoundingClientRect();
          const picture = document.querySelector(".viewer-picture").getBoundingClientRect();
          const tabs = document.querySelector(".viewer-tabs").getBoundingClientRect();
          return { frame: Math.round(frame.height), tabs: Math.round(tabs.height), ratio: picture.width / picture.height };
        });
      const heights = [];
      const shots = await page.evaluate(() => Array.from(document.querySelectorAll(".viewer-tab[data-shot]"), (tab) => tab.getAttribute("data-shot")));
      if (shots.length < 2) failures.push(`viewer at ${width}: found ${shots.length} screen button(s)`);
      for (const shot of shots) {
        await page.click(`.viewer-tab[data-shot="${shot}"]`);
        const m = await measure();
        heights.push(m.frame);
        if (m.ratio < VIEWER_MIN_RATIO) failures.push(`viewer at ${width}, ${shot}: the picture is cropped to ${m.ratio.toFixed(2)}:1 (its own shape is 1.60:1)`);
        if (Math.abs(m.tabs - m.frame) > 2) failures.push(`viewer at ${width}, ${shot}: buttons ${m.tabs}px tall beside a ${m.frame}px picture frame`);
      }
      if (Math.max(...heights) - Math.min(...heights) > 2) failures.push(`viewer at ${width}: the block changes height between screens (${Math.min(...heights)} to ${Math.max(...heights)}px)`);
    } finally {
      await context.close();
    }
  }
  return failures;
}

async function checkContrast(browser, baseUrl) {
  const { page, context } = await openPage(browser, baseUrl, { width: 1440, height: 900 });
  try {
    await loadLazy(page);
    // Open every answer, so its text is measured too.
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
    return await page.evaluate(lowContrast);
  } finally {
    await context.close();
  }
}

// ---- Runner ---------------------------------------------------------------------

async function main() {
  const only = list("only", GROUPS.join(","));
  const engines = list("engines", "chromium");
  const widths = list("widths", DEFAULT_WIDTHS).map(Number);
  for (const group of only) if (!GROUPS.includes(group)) throw new Error(`unknown group: ${group} (have: ${GROUPS.join(", ")})`);
  for (const engine of engines) if (!ENGINES[engine]) throw new Error(`unknown engine: ${engine}`);

  const external = arg("base-url");
  const server = external ? { baseUrl: external.replace(/\/$/, ""), stop: () => {} } : await startSiteServer(OWN_PORT);
  let failed = 0;
  let passed = 0;
  const run = async (name, check) => {
    let failures;
    try {
      failures = await check();
    } catch (error) {
      failures = [`check crashed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`];
    }
    if (failures.length) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}\n${failures.map((f) => `       - ${f}`).join("\n")}\n`);
    } else {
      passed += 1;
      process.stdout.write(`  ok   ${name}\n`);
    }
  };

  try {
    for (const engine of engines) {
      process.stdout.write(`${engine}\n`);
      const browser = await ENGINES[engine].launch();
      try {
        const want = (group) => only.includes(group);
        if (want("layout")) for (const width of widths) await run(`layout ${width}`, () => checkLayout(browser, server.baseUrl, engine, width));
        if (want("fold")) await run("fold", () => checkFold(browser, server.baseUrl, FOLDS));
        if (want("hand")) await run("hand", () => checkHand(browser, server.baseUrl, HAND_WIDTHS, HEIGHTS, PHONE_MAX_W));
        if (want("sharp")) await run("sharp", () => checkSharp(browser, server.baseUrl, SHARP_SCREENS));
        if (want("health")) await run("health", () => checkHealth(browser, server.baseUrl));
        if (want("content")) await run("content", () => checkContent(browser, server.baseUrl));
        if (want("links")) await run("links", () => checkLinks(browser, server.baseUrl));
        if (want("wiring")) await run("wiring", () => checkWiring(browser, server.baseUrl));
        if (want("motion")) await run("motion", () => checkMotion(browser, server.baseUrl));
        if (want("perf") && engine === "chromium") await run("perf", () => checkPerf(browser, server.baseUrl));
        if (want("resilience")) await run("resilience", () => checkResilience(browser, server.baseUrl));
        if (want("contrast")) await run("contrast", () => checkContrast(browser, server.baseUrl));
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.stop();
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (passed + failed === 0) {
    process.stderr.write("verify-site: no check ran for that combination of --only and --engines\n");
    process.exitCode = 1;
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`verify-site failed to run: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
