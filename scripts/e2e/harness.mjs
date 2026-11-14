// Check runner (soft assertions, per-check error capture, screenshots) and the
// page helpers every new-look end-to-end check uses.

import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  BASE, OUT, ONLY, OUR_ORIGINS, REPO_ROOT, BOOT_TIMEOUT_MS, IMPORT_TIMEOUT_MS, SETTLE_MS, DESKTOP,
} from "./config.mjs";

/** @type {{ name: string, ok: boolean, problems: string[], notes: string[], shot: string|null, ms: number }[]} */
export const results = [];
/** @type {string[]|null} errors seen by watched pages during the current check */
let sink = null;
/** @type {import("playwright").Page|null} page to screenshot if the check fails */
let shotPage = null;

/** @param {import("playwright").Page} page */
export function watch(page) {
  page.on("pageerror", (error) => sink?.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource/.test(text)) return; // tracked per URL below
    sink?.push(`console.error: ${text.slice(0, 220)}`);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!OUR_ORIGINS.has(url.origin) || url.pathname.startsWith("/api/")) return;
    if (response.status() >= 400) sink?.push(`HTTP ${response.status()} ${url.pathname}`);
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const failure = request.failure()?.errorText || "";
    if (!OUR_ORIGINS.has(url.origin) || url.pathname.startsWith("/api/") || /ERR_ABORTED/.test(failure)) return;
    sink?.push(`request failed: ${url.pathname} (${failure})`);
  });
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);

/**
 * @param {string} name
 * @param {(t: { expect: (cond: unknown, msg: string) => void, note: (msg: string) => void, use: (page: import("playwright").Page) => void }) => Promise<void>} fn
 */
export async function check(name, fn) {
  if (ONLY.length && !ONLY.some((needle) => name.toLowerCase().includes(needle))) return;
  const problems = [];
  const notes = [];
  sink = [];
  shotPage = null;
  const started = Date.now();
  try {
    await fn({
      expect: (cond, msg) => { if (!cond) problems.push(msg); },
      note: (msg) => notes.push(msg),
      use: (page) => { shotPage = page; },
    });
  } catch (error) {
    problems.push(`threw: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const errors = [...new Set(sink)];
  if (errors.length) problems.push(...errors.slice(0, 12).map((e) => `[error] ${e}`), ...(errors.length > 12 ? [`[error] +${errors.length - 12} more`] : []));
  sink = null;
  let shot = null;
  if (problems.length && shotPage && !shotPage.isClosed()) {
    shot = join(OUT, `FAIL-${slug(name)}.png`);
    await shotPage.screenshot({ path: shot, fullPage: false }).catch(() => { shot = null; });
  }
  const result = { name, ok: problems.length === 0, problems, notes, shot, ms: Date.now() - started };
  results.push(result);
  process.stdout.write(`${result.ok ? "  ok " : "FAIL "} ${name} (${(result.ms / 1000).toFixed(1)}s)\n`);
  problems.forEach((p) => process.stdout.write(`        - ${p}\n`));
  notes.forEach((n) => process.stdout.write(`        · ${n}\n`));
  if (shot) process.stdout.write(`        screenshot: ${shot}\n`);
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

export const settle = (page, ms = SETTLE_MS) => page.waitForTimeout(ms);

/** @param {import("playwright").Page} page */
export async function waitBoot(page) {
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
  await page.waitForFunction(() => document.documentElement.dataset.ui !== "next" || !!document.querySelector(".v-theme-btn"), null, { timeout: BOOT_TIMEOUT_MS });
  await settle(page, 600);
}

/**
 * A fresh, storage-isolated session on the new look.
 * @param {import("playwright").Browser} browser
 * @param {{ viewport?: {width: number, height: number}, phone?: boolean, path?: string }} [opts]
 */
export async function session(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || DESKTOP,
    acceptDownloads: true,
    ...(opts.phone ? { hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  // Hermetic: fonts and analytics stay off the network.
  await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost", (route) => route.abort());
  const page = await context.newPage();
  watch(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`${BASE}${opts.path || "/?ui=next"}`, { waitUntil: "domcontentloaded" });
  await waitBoot(page);
  return { context, page };
}

/** @param {import("playwright").Page} page @param {string} tab */
export async function gotoTab(page, tab) {
  await page.evaluate((t) => window.SpireVault.switchTab(t), tab);
  await page.waitForFunction((t) => {
    const panel = document.querySelector(`.tab-panel[data-tab="${t}"]`);
    return panel && !panel.hidden;
  }, tab);
  await settle(page);
}

/** @param {import("playwright").Page} page */
export const overviewCount = (page) => page.evaluate(() => document.querySelector("#overview-body .v-nums dd")?.dataset.count ?? null);

/**
 * Imports a folder through the app's own Import button and its folder picker.
 * @param {import("playwright").Page} page @param {string} dir @param {number} expected
 */
export async function importFolder(page, dir, expected) {
  await gotoTab(page, "overview");
  let button = page.locator('.tab-panel[data-tab="overview"] [data-action="upload"]:visible').first();
  if (!(await button.count())) {
    await gotoTab(page, "settings");
    button = page.locator('#settings-body [data-action="upload"]:visible').first();
  }
  const chooser = page.waitForEvent("filechooser", { timeout: 8000 });
  await button.click();
  await (await chooser).setFiles(dir);
  await gotoTab(page, "overview");
  await page.waitForFunction((n) => document.querySelector("#overview-body .v-nums dd")?.dataset.count === String(n), expected, { timeout: IMPORT_TIMEOUT_MS });
  await settle(page, 800);
}

/**
 * Forces every image under a root to load, waits, and reports the broken ones.
 * @param {import("playwright").Page} page @param {string} root
 */
export async function loadImages(page, root) {
  await page.evaluate((sel) => document.querySelectorAll(`${sel} img`).forEach((img) => { img.loading = "eager"; }), root);
  await page.waitForFunction((sel) => [...document.querySelectorAll(`${sel} img`)].every((img) => img.complete || !img.getAttribute("src")), root, { timeout: 15000 }).catch(() => {});
  return page.evaluate((sel) => [...document.querySelectorAll(`${sel} img`)]
    .filter((img) => img.getAttribute("src") && img.complete && img.naturalWidth === 0)
    .map((img) => img.getAttribute("src")), root);
}

/** Layout problems on a visible tab. @param {import("playwright").Page} page @param {string} tab */
export function inspectTab(page, tab) {
  return page.evaluate((t) => {
    const problems = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${vw}px)`);
    const panel = document.querySelector(`.tab-panel[data-tab="${t}"]`);
    if (!panel || panel.hidden) return [...problems, "panel not shown"];
    const body = panel.querySelector(`#${t}-body`) || panel;
    if (body.innerText.trim().length < 10) problems.push("tab body is empty");
    return problems;
  }, tab);
}

/** Starts Web/scripts/dev-static.mjs on a port and resolves once it is serving. @param {number} port */
export function startStatic(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`dev-static did not start on ${port}`)); }, 10000);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("serving")) { clearTimeout(timer); resolve(child); } });
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`dev-static exited (${code}) on ${port}`)); });
  });
}

/** @param {import("playwright").Page} page */
export const toastText = (page) => page.evaluate(() => {
  const t = document.getElementById("toast");
  return t && t.classList.contains("is-visible") ? t.textContent.trim() : "";
});

/** @param {import("playwright").Page} page */
export async function reload(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitBoot(page);
}

export const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** "2W · 58L · 60 runs" / "2W58L60 runs" → numbers. @param {string} text */
export function parseRecord(text) {
  const m = /(\d+)\s*W\D*?(\d+)\s*L\D*?(\d+)\s*runs?/.exec(text || "");
  return m ? { wins: Number(m[1]), losses: Number(m[2]), runs: Number(m[3]) } : null;
}

/** Labels that read like an internal id rather than a name. @param {string} label @param {Set<string>} known */
export function rawLabel(label, known) {
  if (!label) return "empty label";
  // A curated name is a name even when it is written like an id ("TURBO", "FTL").
  if (known.has(label) || known.has(label.replace(/\+\d*$/, ""))) return "";
  if (/_|^(CARD|RELIC|CHARACTER)\.|^[A-Z0-9_]+$|^[a-z0-9_+]+$/.test(label)) return "raw id";
  if (known.size) return "no curated label (prettified id)";
  return "";
}

/**
 * Cards that appear in real run histories but have no art anywhere: the
 * current game files no longer contain them. Reported as notes, not failures.
 */
export const KNOWN_NO_ART = Object.freeze({
  Scare: "renamed Sidestep in v0.110; the v0.113 game files have no Scare art",
});
