#!/usr/bin/env node
/**
 * Finds images the app draws bigger than their files: every visible <img> and
 * CSS background image, on every tab, at retina density. An image drawn at
 * more device pixels than it has is stretched, and reads as blurry.
 *
 * Starts Web/scripts/dev-static.mjs on its own port, opens the sample data
 * signed out, and walks each tab (plus the open relic page) in the new look on
 * a 2x laptop and a 3x phone, and in the classic look on a 2x laptop. Prints
 * each stretched image once, worst first, and exits non-zero when any image is
 * stretched past the tolerance.
 *
 *   node scripts/verify-image-sharpness.mjs
 *   node scripts/verify-image-sharpness.mjs --all            # also list images that are fine
 *   node scripts/verify-image-sharpness.mjs --setup classic  # only setups whose name has this
 *
 * Not covered: the Steam-only tabs (co-op, highlights, beta), which need a
 * signed-in account and a live API, and images drawn into a <canvas>.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.VERIFY_SHARP_PORT) || 8813;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 20000;
/** Drawn at up to this many device pixels per file pixel still reads as sharp. */
const TOLERANCE = 1.15;
const NOTICE_KEY = "vault.web.ui.notice";
const TABS = ["overview", "characters", "ascensions", "relics", "cards", "runs", "news", "overlay", "settings"];
const SETUPS = Object.freeze([
  { name: "new look, laptop 2x", path: "/", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  { name: "new look, phone 3x", path: "/", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: "classic, laptop 2x", path: "/?ui=classic", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
]);

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error("dev-static did not start")), BOOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(String(PORT))) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("error", reject);
  });
}

/**
 * Page side: every visible image's drawn size against its file size.
 * @returns {Promise<Array<{ src: string, kind: string, file: string, drawn: string, ratio: number, where: string }>>}
 */
function measureInPage() {
  const dpr = window.devicePixelRatio;
  const px = (value) => parseFloat(value) || 0;
  const visible = (el, rect) =>
    rect.width >= 2 && rect.height >= 2 &&
    rect.bottom > -2000 && rect.top < window.innerHeight + 4000 &&
    (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true }));
  const where = (el) => {
    const parts = [];
    for (let node = el; node && parts.length < 3 && node !== document.body; node = node.parentElement) {
      const cls = [...node.classList].slice(0, 2).join(".");
      parts.unshift(node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (cls ? `.${cls}` : ""));
    }
    return parts.join(" > ");
  };
  /** How big a natW x natH picture is drawn inside a boxW x boxH box. */
  const fitted = (fit, boxW, boxH, natW, natH) => {
    if (fit === "contain" || fit === "scale-down") {
      const s = Math.min(boxW / natW, boxH / natH);
      return fit === "scale-down" && s > 1 ? [natW, natH] : [natW * s, natH * s];
    }
    if (fit === "cover") {
      const s = Math.max(boxW / natW, boxH / natH);
      return [natW * s, natH * s];
    }
    if (fit === "none") return [natW, natH];
    return [boxW, boxH];
  };
  const results = [];
  /** Drawn boxes per <img>; file pixels are resolved below. */
  const drawn = [];

  for (const img of document.images) {
    if (!img.complete || !img.naturalWidth) continue;
    const rect = img.getBoundingClientRect();
    if (!visible(img, rect)) continue;
    const cs = getComputedStyle(img);
    // Rendered size includes transforms (getBoundingClientRect), so a scaled stage counts.
    const scaleX = img.offsetWidth ? rect.width / img.offsetWidth : 1;
    const scaleY = img.offsetHeight ? rect.height / img.offsetHeight : 1;
    const boxW = (img.offsetWidth - px(cs.paddingLeft) - px(cs.paddingRight) - px(cs.borderLeftWidth) - px(cs.borderRightWidth)) * scaleX;
    const boxH = (img.offsetHeight - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth)) * scaleY;
    drawn.push({ img, url: img.currentSrc || img.src, boxW, boxH, fit: cs.objectFit });
  }

  const backgrounds = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (!cs.backgroundImage.includes("url(")) continue;
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect)) continue;
    const urls = [...cs.backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)].map((m) => m[1]);
    const sizes = cs.backgroundSize.split(",").map((s) => s.trim());
    urls.forEach((url, i) => {
      if (url.startsWith("data:image/svg") || /\.svg(\?|$)/.test(url)) return;
      backgrounds.push({ el, rect, url, size: sizes[i] ?? sizes[0] });
    });
  }
  const load = (url) =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  // An <img> picked from a srcset reports a density-corrected naturalWidth
  // (a 3840w file under sizes="1440px" says 1440): load each URL on its own
  // to read the file's real pixels.
  return Promise.all([...drawn.map((d) => load(d.url)), ...backgrounds.map((b) => load(b.url))]).then((loaded) => {
    const files = loaded.slice(0, drawn.length);
    const images = loaded.slice(drawn.length);
    drawn.forEach((d, i) => {
      const file = files[i];
      if (!file || !file.naturalWidth) return;
      const [w, h] = fitted(d.fit, d.boxW, d.boxH, file.naturalWidth, file.naturalHeight);
      results.push({
        src: d.url,
        kind: "img",
        file: `${file.naturalWidth}x${file.naturalHeight}`,
        drawn: `${Math.round(w)}x${Math.round(h)} css`,
        ratio: Math.max((w * dpr) / file.naturalWidth, (h * dpr) / file.naturalHeight),
        where: where(d.img),
      });
    });
    backgrounds.forEach((b, i) => {
      const image = images[i];
      if (!image || !image.naturalWidth) return;
      const natW = image.naturalWidth;
      const natH = image.naturalHeight;
      let w;
      let h;
      if (b.size === "cover" || b.size === "contain") {
        [w, h] = fitted(b.size, b.rect.width, b.rect.height, natW, natH);
      } else {
        const [sw = "auto", sh = "auto"] = b.size.split(/\s+/);
        const dim = (value, box) => (value.endsWith("%") ? (px(value) / 100) * box : value === "auto" ? null : px(value));
        w = dim(sw, b.rect.width);
        h = dim(sh, b.rect.height);
        if (w == null && h == null) [w, h] = [natW, natH];
        else if (w == null) w = (h / natH) * natW;
        else if (h == null) h = (w / natW) * natH;
      }
      results.push({
        src: b.url,
        kind: "background",
        file: `${natW}x${natH}`,
        drawn: `${Math.round(w)}x${Math.round(h)} css`,
        ratio: Math.max((w * dpr) / natW, (h * dpr) / natH),
        where: where(b.el),
      });
    });
    return results;
  });
}

async function openSetup(browser, setup) {
  const { name, path, ...contextOptions } = setup;
  const context = await browser.newContext(contextOptions);
  await context.addInitScript((key) => {
    try { window.localStorage.setItem(key, "seen"); } catch { /* storage blocked */ }
  }, NOTICE_KEY);
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
  await page.waitForSelector("#overview-body .v-ov, #overview-body .kpi-strip", { timeout: BOOT_TIMEOUT_MS });
  return { context, page };
}

/** Scrolls the page top to bottom so lazy images load, then waits for them. */
async function settle(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    // A lazy image that never came near the viewport never loads, and its
    // decode() never settles: wait a moment for the rest, not for those.
    const pending = [...document.images].filter((img) => !img.complete).map((img) => img.decode().catch(() => {}));
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 3000))]);
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

async function audit(browser, setup) {
  const { context, page } = await openSetup(browser, setup);
  /** @type {Array<{ tab: string } & Record<string, unknown>>} */
  const rows = [];
  try {
    for (const tab of TABS) {
      await page.evaluate((id) => window.SpireVault.switchTab(id), tab);
      await page.waitForTimeout(500);
      await settle(page);
      for (const r of await page.evaluate(measureInPage)) rows.push({ ...r, tab });
      if (tab === "relics") {
        const opener = page.locator('[data-action="relic-expand"]').first();
        if (await opener.count()) {
          await opener.click();
          await page.waitForTimeout(700);
          for (const r of await page.evaluate(measureInPage)) rows.push({ ...r, tab: "relics (page open)" });
        }
      }
    }
  } finally {
    await context.close();
  }
  return rows;
}

/** One line per image file: its worst stretch and where that happened. */
function worstPerFile(rows) {
  const byFile = new Map();
  for (const row of rows) {
    const key = row.src.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    const prev = byFile.get(key);
    if (!prev || row.ratio > prev.ratio) byFile.set(key, { ...row, key, tabs: new Set([...(prev?.tabs ?? []), row.tab]) });
    else prev.tabs.add(row.tab);
  }
  return [...byFile.values()].sort((a, b) => b.ratio - a.ratio);
}

async function main() {
  const showAll = process.argv.includes("--all");
  const setupIndex = process.argv.indexOf("--setup");
  const only = setupIndex !== -1 ? process.argv[setupIndex + 1] ?? "" : "";
  const server = await startServer();
  const browser = await chromium.launch();
  let stretched = 0;
  try {
    for (const setup of SETUPS.filter((s) => s.name.includes(only))) {
      const files = worstPerFile(await audit(browser, setup));
      const bad = files.filter((f) => f.ratio > TOLERANCE);
      stretched += bad.length;
      process.stdout.write(`\n== ${setup.name}: ${files.length} images, ${bad.length} stretched past ${TOLERANCE}x\n`);
      for (const f of showAll ? files : bad) {
        process.stdout.write(
          `  ${f.ratio.toFixed(2)}x  ${f.key}  file ${f.file}, drawn ${f.drawn} (${f.kind}) — ${[...f.tabs].join(", ")}\n      at ${f.where}\n`
        );
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  process.exitCode = stretched ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
