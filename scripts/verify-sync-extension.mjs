#!/usr/bin/env node
/**
 * End-to-end checks for SpireVault Sync: the browser extension (Extension/)
 * and the page bridge (Web/lib/sync-bridge*.js), together, in a real browser.
 *
 * Starts Web/scripts/dev-static.mjs, loads the unpacked extension into
 * Playwright's Chromium with a throwaway profile, and points it at a copy of
 * the fixture save folder (Extension/tests/fixtures/saves). Nothing here
 * reads a real save folder and nothing leaves the machine.
 *
 *   node scripts/verify-sync-extension.mjs
 *   VERIFY_SYNC_WEB=/path/to/Web node scripts/verify-sync-extension.mjs   # another build of the page
 *   VERIFY_SYNC_MATCH="minute" node scripts/verify-sync-extension.mjs    # only checks whose name matches
 *
 * Covers: runs appear with no clicks (first read, then a new file within
 * about a minute, in every open tab), every profile and the modded save set, backups skipped,
 * the Steam copy receives the new runs, the file switch off and on again
 * without a reload, the setup card in both looks, browsers without the
 * extension, the signed-in account's folder only, clearing the runs pausing
 * sync, and the automatic pull of the Steam copy.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = process.env.VERIFY_SYNC_WEB || join(REPO_ROOT, "Web");
const EXTENSION = join(REPO_ROOT, "Extension");
const FIXTURE = join(EXTENSION, "tests", "fixtures", "saves");
const PORT = Number(process.env.VERIFY_SYNC_PORT) || 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 20_000;
const SYNC_TIMEOUT_MS = 15_000;
/** The page asks the extension every 45 seconds while it is visible. */
const NEXT_SYNC_TIMEOUT_MS = 80_000;
const NOTICE_KEY = "vault.web.ui.notice";
const ACCOUNT = "76561190000000001";
const OTHER_ACCOUNT = "76561190000000002";
const SESSION = Object.freeze({ steamID: ACCOUNT, personaName: "TestClimber", sessionToken: "test-token", signedInAt: "2026-11-01T00:00:00.000Z" });
const PILL = '.tab-panel[data-tab="overview"] [data-sync-pill]';
const SETUP_BUTTON = '.tab-panel[data-tab="overview"] [data-action="sync-setup"]';
/** Builds from v249 on send the Steam copy only what it lacks; older ones re-sent the merged set after a pull that brought runs in. */
const SENDS_ONLY_WHAT_COPY_LACKS = existsSync(join(WEB_ROOT, "lib", "cloud-run-wire.js"));
const NAME_FILTER = process.env.VERIFY_SYNC_MATCH ? new RegExp(process.env.VERIFY_SYNC_MATCH) : null;

let passed = 0;
const cleanups = [];

async function check(name, fn) {
  if (NAME_FILTER && !NAME_FILTER.test(name)) return;
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    process.stdout.write(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(WEB_ROOT, "scripts", "dev-static.mjs"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
    const timer = setTimeout(() => reject(new Error("dev-static did not start")), 10_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) { clearTimeout(timer); resolve(child); }
    });
    child.on("error", reject);
  });
}

/** A private copy of the fixture save folder, with the test account used most recently. */
function makeSaves() {
  const dir = mkdtempSync(join(tmpdir(), "sv-sync-saves-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(FIXTURE, dir, { recursive: true });
  const root = join(dir, "SlayTheSpire2");
  utimesSync(join(root, "steam", OTHER_ACCOUNT), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(root, "steam", ACCOUNT), new Date("2026-06-01"), new Date("2026-06-01"));
  const history = join(root, "steam", ACCOUNT, "profile1", "saves", "history");
  return {
    root,
    rootUrl: `${pathToFileURL(root).href}/`,
    /** Writes one more finished run, as the game does when a run ends. */
    addRun(startTime) {
      const run = JSON.parse(readFileSync(join(history, "1777000000.run"), "utf8"));
      writeFileSync(join(history, `${startTime}.run`), JSON.stringify({ ...run, start_time: startTime, seed: `NEW${startTime}` }));
    },
  };
}

/** The Steam copy, as the static server cannot provide it: answers GET /api/runs and records what is uploaded. */
function mockSteamCopy(context) {
  const copy = { runs: [], uploads: [], gets: 0 };
  context.route("**/api/runs", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      copy.gets += 1;
      await route.fulfill({ json: { runs: copy.runs, count: copy.runs.length, updatedAt: new Date().toISOString() } });
    } else if (request.method() === "POST") {
      const body = request.postDataJSON();
      const runs = Array.isArray(body?.runs) ? body.runs : [];
      copy.uploads.push(runs.map((run) => run.id));
      for (const run of runs) if (!copy.runs.some((kept) => kept.id === run.id)) copy.runs.push(run);
      await route.fulfill({ json: { ok: true, stored: copy.runs.length, added: runs.length, count: copy.runs.length } });
    } else {
      await route.fulfill({ json: { ok: true } });
    }
  });
  return copy;
}

async function prepare(context, { signedIn = false } = {}) {
  // The look notice and the Overview's first-visit tour are answered up
  // front, as verify-ui-next does: the tour dims the page and takes clicks.
  await context.addInitScript((keys) => {
    try { keys.forEach((key) => window.localStorage.setItem(key, "seen")); } catch { /* storage blocked */ }
  }, [NOTICE_KEY, "vault.web.overview.tour.v1"]);
  if (signedIn) {
    await context.addInitScript((value) => {
      try { window.localStorage.setItem("vault.web.session", value); } catch { /* storage blocked */ }
    }, JSON.stringify(typeof signedIn === "object" ? signedIn : SESSION));
  }
  // Everything the extension tells the page, kept so a check can read it back.
  await context.addInitScript(() => {
    window.__fromExtension = [];
    window.addEventListener("message", (event) => {
      if (event.source === window && event.data?.source === "spirevault-sync") window.__fromExtension.push(JSON.stringify(event.data));
    });
  });
  // Hermetic: nothing leaves the machine.
  await context.route((url) => url.protocol.startsWith("http") && url.hostname !== "127.0.0.1", (route) => route.abort());
}

async function openApp(context, path) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
  return { page, errors };
}

/**
 * A browser with the unpacked extension in a throwaway profile, already told
 * where the fixture saves are (as if the player had pasted the folder).
 */
async function launchWithExtension({ saves, signedIn = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "sv-sync-profile-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  cleanups.push(async () => { await context.close().catch(() => {}); rmSync(profile, { recursive: true, force: true }); });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  if (saves) await worker.evaluate((rootUrl) => chrome.storage.local.set({ "pastedRoot.v1": rootUrl }), saves.rootUrl);
  await prepare(context, { signedIn });
  return { context, extensionId, profile };
}

/** The browser's extension settings page, where the file switch lives; used to flip it as a player would. */
async function fileSwitch(context, extensionId) {
  const page = await context.newPage();
  await page.goto("chrome://extensions");
  await page.evaluate(() => new Promise((done) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, done)));
  return {
    page,
    set: (isOn) => page.evaluate(({ id, isOn }) => new Promise((done) => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: isOn }, done)), { id: extensionId, isOn }),
  };
}

const pillText = (page) => page.locator(PILL).innerText().then((text) => text.replace(/\s+/g, " ").trim());
const waitForPill = (page, pattern, timeout = SYNC_TIMEOUT_MS) =>
  page.waitForFunction(({ selector, source }) => new RegExp(source).test((document.querySelector(selector)?.textContent || "").replace(/\s+/g, " ")), { selector: PILL, source: pattern.source }, { timeout });
/** The bridge's state. waitForFunction does not wait for a promise, so the module is put on the window first. */
async function bridge(page) {
  await page.evaluate(async () => { window.__syncBridge = window.__syncBridge || await import("/lib/sync-bridge.js?v=1"); });
}
async function phase(page) {
  await bridge(page);
  return page.evaluate(() => window.__syncBridge.snapshot().phase);
}
async function waitForPhase(page, phases, timeout = SYNC_TIMEOUT_MS) {
  await bridge(page);
  await page.waitForFunction((wanted) => wanted.includes(window.__syncBridge.snapshot().phase), phases, { timeout });
}
const toastText = (page) => page.evaluate(() => document.getElementById("toast")?.textContent || "");

async function main() {
  const server = await startServer();
  cleanups.push(() => server.kill());

  // ── With the extension, signed out ────────────────────────────────────
  {
    const saves = makeSaves();
    const { context, extensionId } = await launchWithExtension({ saves });
    const { page, errors } = await openApp(context, "/?ui=classic");

    await check("with the extension, the runs load by themselves: no import, no clicks", async () => {
      await waitForPill(page, /Synced just now ?· 4 runs/);
      assert.equal(await page.locator("#overview-body .empty-state").count(), 0, "no import screen");
      assert.match(await toastText(page), /Auto-sync is on/);
      assert.equal(await page.locator('.tab-panel[data-tab="overview"] [data-toolbar-empty]').isVisible(), false, "no \"sample data\" pill beside real runs");
    });

    await check("every profile and the modded save set are read; backups and other accounts are not", async () => {
      const known = await page.evaluate(() => JSON.parse(localStorage.getItem("vault.sync.known.v1:guest")).files);
      assert.deepEqual(Object.keys(known).sort(), [
        "modded/profile1/saves/history/1777020000.run",
        "profile1/saves/history/1777000000.run",
        "profile1/saves/history/1777003600.run",
        "profile2/saves/history/1777010000.run",
      ]);
    });

    await check("the page is given the runs, never the folder's path", async () => {
      const messages = await page.evaluate(() => window.__fromExtension);
      assert.ok(messages.some((text) => text.includes("start_time")), "run files arrived");
      const folderName = saves.root.split("/").at(-2);
      assert.equal(messages.some((text) => text.includes(folderName) || text.includes("file://")), false, "no path in any message");
    });

    await check("once connected, the toolbar offers no setup and Refresh opens no folder picker", async () => {
      assert.equal(await page.locator(SETUP_BUTTON).count(), 0);
      let pickerOpened = false;
      page.once("filechooser", () => { pickerOpened = true; });
      await page.locator('.tab-panel[data-tab="overview"] [data-action="reload-saves"]').click();
      await page.waitForFunction(() => /Already up to date/.test(document.getElementById("toast")?.textContent || ""), null, { timeout: SYNC_TIMEOUT_MS });
      assert.equal(pickerOpened, false);
    });

    await check("a background sync leaves the player on the tab they are on", async () => {
      await page.evaluate(() => window.SpireVault.switchTab("news"));
      saves.addRun(1777050000);
      // Coming back to the tab asks the extension at once, unless it was asked in the last five seconds.
      await page.waitForTimeout(5_500);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("vault.sync.known.v1:guest")).files).length === 5, null, { timeout: SYNC_TIMEOUT_MS });
      assert.equal(await page.evaluate(() => window.SpireVault.activeTab()), "news");
      await page.evaluate(() => window.SpireVault.switchTab("overview"));
      await waitForPill(page, /· 5 runs/);
    });

    await check("a new run file shows up within about a minute, with no clicks", async () => {
      const started = Date.now();
      saves.addRun(1777060000);
      await waitForPill(page, /· 6 runs/, NEXT_SYNC_TIMEOUT_MS);
      assert.match(await toastText(page), /1 new run/);
      process.stdout.write(`      (appeared after ${Math.round((Date.now() - started) / 1000)} s)\n`);
    });

    await check("turning the file switch off says so, and offers the one step that is left", async () => {
      const toggle = await fileSwitch(context, extensionId);
      await toggle.set(false);
      await waitForPhase(page, ["needs-switch"]);
      await page.bringToFront();
      const button = page.locator(SETUP_BUTTON);
      await button.waitFor({ state: "visible" });
      assert.equal(await button.evaluate((node) => node.classList.contains("is-attention")), true);
      assert.doesNotMatch(await pillText(page), /Synced/, "the status line no longer claims sync");
      await button.click();
      const dialog = page.locator("dialog.svs-dialog");
      await dialog.waitFor({ state: "visible" });
      assert.equal(await dialog.locator('[data-step="install"]').getAttribute("data-state"), "done");
      assert.equal(await dialog.locator('[data-step="allow"]').getAttribute("data-state"), "now");
      assert.match(await dialog.locator('[data-step="allow"]').innerText(), /Allow access to file URLs/);

      const [settings] = await Promise.all([
        context.waitForEvent("page", { timeout: SYNC_TIMEOUT_MS }),
        dialog.getByRole("button", { name: "Open the switch" }).click(),
      ]);
      await settings.waitForURL(`chrome://extensions/?id=${extensionId}`);

      // The player flips the switch on that page: the extension restarts and the open tab reconnects by itself.
      await toggle.set(true);
      await page.waitForFunction(() => document.querySelector('dialog.svs-dialog [data-step="sync"]')?.dataset.state === "done", null, { timeout: SYNC_TIMEOUT_MS });
      assert.match(await dialog.locator('[data-step="sync"]').innerText(), /Synced just now · 6 runs/);
      await dialog.getByRole("button", { name: "Done" }).click();
      assert.equal(await dialog.isVisible(), false);
      assert.equal(await page.locator(SETUP_BUTTON).isVisible(), false);
    });

    await check("two open tabs both get a new run", async () => {
      const second = (await openApp(context, "/?ui=classic")).page;
      await waitForPill(second, /· 6 runs/);
      saves.addRun(1777070000);
      await page.waitForTimeout(5_500);
      for (const tab of [page, second]) await tab.evaluate(() => window.dispatchEvent(new Event("focus")));
      await waitForPill(page, /· 7 runs/, NEXT_SYNC_TIMEOUT_MS);
      await waitForPill(second, /· 7 runs/, NEXT_SYNC_TIMEOUT_MS);
      await second.close();
    });

    await check("clearing the runs from this browser turns auto-sync off until the player turns it back on", async () => {
      await page.bringToFront();
      await page.evaluate(() => window.SpireVault.switchTab("settings"));
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator('[data-action="settings-clear-local"]').first().click();
      await waitForPhase(page, ["paused"]);
      await page.evaluate(() => window.SpireVault.switchTab("overview"));
      // Nothing comes back by itself: not on the timer's next turn, not when the tab is shown again.
      await page.waitForTimeout(6_000);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(2_000);
      assert.equal(await phase(page), "paused");
      assert.equal(await page.locator("#overview-body .empty-state").count(), 1, "the import screen, with no runs");
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("vault.sync.known"))), false);

      await page.locator(SETUP_BUTTON).click();
      const dialog = page.locator("dialog.svs-dialog");
      assert.match(await dialog.locator('[data-step="sync"]').innerText(), /Auto-sync is off because you cleared your runs/);
      await dialog.getByRole("button", { name: "Turn auto-sync back on" }).click();
      await page.waitForFunction(() => document.querySelector('dialog.svs-dialog [data-step="sync"]')?.dataset.state === "done", null, { timeout: SYNC_TIMEOUT_MS });
      await dialog.getByRole("button", { name: "Done" }).click();
      await waitForPill(page, /Synced just now ?· 7 runs/);
    });

    await check("the page reported no script errors", async () => {
      assert.deepEqual(errors, []);
    });
    await context.close();
  }

  // ── With the extension, signed in ─────────────────────────────────────
  {
    const saves = makeSaves();
    const { context } = await launchWithExtension({ saves, signedIn: true });
    const copy = mockSteamCopy(context);
    const { page } = await openApp(context, "/");

    await check("signed in, the new look: the account's runs load and go up to the Steam copy", async () => {
      await waitForPill(page, /Synced just now ?· 4 runs/);
      const deadline = Date.now() + SYNC_TIMEOUT_MS;
      while (copy.runs.length < 4 && Date.now() < deadline) await page.waitForTimeout(200);
      assert.deepEqual(copy.runs.map((run) => run.id).sort(), ["sts2-1777000000", "sts2-1777003600", "sts2-1777010000", "sts2-1777020000"]);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.ui), "next");
    });

    await check("only the signed-in account's folder is read", async () => {
      const known = await page.evaluate((account) => JSON.parse(localStorage.getItem(`vault.sync.known.v1:${account}`)).files, ACCOUNT);
      assert.equal(Object.keys(known).length, 4);
      assert.equal(copy.runs.some((run) => run.id === "sts2-1777030000"), false, "the other account's run stayed on disk");
    });
    await context.close();
  }

  {
    const saves = makeSaves();
    const stranger = { ...SESSION, steamID: "76561190000000009" };
    const { context } = await launchWithExtension({ saves, signedIn: stranger });
    mockSteamCopy(context);
    const { page } = await openApp(context, "/?ui=classic");

    await check("signed in as an account with no saves on this computer: nothing is read, and the card says why", async () => {
      await waitForPhase(page, ["no-account"]);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("vault.sync.known"))), false);
      await page.locator(SETUP_BUTTON).click();
      assert.match(await page.locator('dialog.svs-dialog [data-step="sync"]').innerText(), /no saves for the Steam account/);
    });
    await context.close();
  }

  // ── The folder cannot be found: paste it ──────────────────────────────
  {
    const saves = makeSaves();
    const { context } = await launchWithExtension({ signedIn: true });
    mockSteamCopy(context);
    // A machine that has the real game in the standard place answers "no saves
    // for this account" here. Turn that one answer into "no save folder", which
    // is what a machine with the game somewhere else gets, so the paste path is
    // checked everywhere. Every other message is the extension's own.
    await context.addInitScript(() => {
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (event.source !== window || !data || data.source !== "spirevault-sync" || data.type !== "reply" || data.isRewritten) return;
        if (data.reply?.reason !== "no-account-folder") return;
        event.stopImmediatePropagation();
        window.postMessage({ ...data, isRewritten: true, reply: { ok: false, reason: "no-save-folder" } }, window.location.origin);
      }, true);
    });
    const { page } = await openApp(context, "/?ui=classic");

    await check("when the save folder is not found, pasting its path connects", async () => {
      await waitForPhase(page, ["no-folder"]);
      await page.locator(SETUP_BUTTON).click();
      const dialog = page.locator("dialog.svs-dialog");
      const input = dialog.locator(".svs-input");
      await input.waitFor({ state: "visible" });
      assert.match(await dialog.locator('[data-step="sync"]').innerText(), /couldn't find your Slay the Spire 2 saves/);
      assert.equal(await input.getAttribute("placeholder"), "~/Library/Application Support/SlayTheSpire2");

      await input.fill("/definitely/not/here");
      await dialog.getByRole("button", { name: "Use this folder" }).click();
      await dialog.locator(".svs-error").filter({ hasText: /isn't a SlayTheSpire2 folder/ }).waitFor();
      await input.fill("/definitely/not/here/SlayTheSpire2");
      await dialog.getByRole("button", { name: "Use this folder" }).click();
      await dialog.locator(".svs-error").filter({ hasText: /No Slay the Spire 2 saves found there/ }).waitFor();

      // Any path inside the game folder will do.
      await input.fill(join(saves.root, "steam", ACCOUNT, "profile1", "saves", "history"));
      await dialog.getByRole("button", { name: "Use this folder" }).click();
      await page.waitForFunction(() => document.querySelector('dialog.svs-dialog [data-step="sync"]')?.dataset.state === "done", null, { timeout: SYNC_TIMEOUT_MS });
      assert.match(await dialog.locator('[data-step="sync"]').innerText(), /Synced just now · 4 runs/);
    });
    await context.close();
  }

  // ── Without the extension ─────────────────────────────────────────────
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());

  await check("without the extension and before it is in a store, nothing new shows", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await prepare(context);
    const { page } = await openApp(context, "/?ui=classic");
    await waitForPhase(page, ["absent"]);
    assert.equal(await page.locator('[data-action="sync-setup"]').count(), 0);
    assert.equal(await page.locator("link[data-svs-styles]").count(), 0);
    assert.equal(await page.locator(".svs-nudge").count(), 0);
    await context.close();
  });

  for (const [look, path] of [["classic", "/?ui=classic&sync=1"], ["new", "/?sync=1"]]) {
    await check(`${look} look: the setup card opens from the toolbar and starts at step one`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await prepare(context);
      const { page, errors } = await openApp(context, path);
      const button = page.locator(SETUP_BUTTON);
      await button.waitFor({ state: "visible", timeout: SYNC_TIMEOUT_MS });
      assert.equal(await button.innerText(), "Auto-sync");
      await button.click();
      const dialog = page.locator("dialog.svs-dialog");
      await dialog.waitFor({ state: "visible" });
      assert.deepEqual(await dialog.locator(".svs-step").evaluateAll((steps) => steps.map((step) => step.dataset.state)), ["now", "todo", "todo"]);
      assert.equal(await dialog.locator(".svs-title").innerText(), "Auto-sync your runs");
      // Inside the window at a laptop size, with the look's own colors.
      const box = await dialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900, "the card fits the window");
      const background = await dialog.evaluate((node) => getComputedStyle(node).backgroundColor);
      assert.notEqual(background, "rgba(0, 0, 0, 0)");
      await page.keyboard.press("Escape");
      assert.equal(await dialog.isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
    });

    await check(`${look} look: the import screen offers auto-sync in one line`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await prepare(context, { signedIn: true });
      mockSteamCopy(context);
      const { page } = await openApp(context, path);
      const nudge = page.locator("#overview-body .empty-state .svs-nudge");
      await nudge.waitFor({ state: "visible", timeout: SYNC_TIMEOUT_MS });
      assert.match(await nudge.innerText(), /skip the folder/i);
      await nudge.getByRole("button", { name: "Set up auto-sync" }).click();
      await page.locator("dialog.svs-dialog").waitFor({ state: "visible" });
      await context.close();
    });
  }

  await check("a phone is never offered the extension", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36",
    });
    await prepare(context);
    const { page } = await openApp(context, "/?sync=1");
    await waitForPhase(page, ["unsupported"]);
    assert.equal(await page.locator('[data-action="sync-setup"]').count(), 0);
    await context.close();
  });

  // ── The Steam copy is pulled again by itself ──────────────────────────
  await check("a signed-in tab pulls the Steam copy again by itself, and stays still when nothing changed", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await prepare(context, { signedIn: true });
    const copy = mockSteamCopy(context);
    const stored = (id, day) => ({
      id: `sts2-${id}`, character: "ironclad", ascension: 5, won: true, floorReached: 48, playTimeSeconds: 1500,
      startedAt: `2026-10-${day}T10:00:00.000Z`, endedAt: `2026-10-${day}T10:25:00.000Z`, relics: [], deckAtEnd: [], seed: `S${id}`,
    });
    copy.runs.push(stored(1790000000, "01"), stored(1790086400, "02"));
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${BASE}/?ui=classic`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await page.waitForSelector("#overview-body .kpi-strip", { timeout: BOOT_TIMEOUT_MS });
    const getsAtBoot = copy.gets;
    assert.ok(getsAtBoot >= 1, "the copy is read at boot");

    // Nothing changed: the pull happens, the page is not redrawn.
    await page.evaluate(() => { document.querySelector("#overview-body .kpi-strip").dataset.probe = "kept"; });
    const uploadsBefore = copy.uploads.length;
    await page.clock.fastForward("05:30");
    await page.waitForTimeout(500);
    assert.equal(copy.gets, getsAtBoot + 1, "one pull after five minutes");
    assert.equal(await page.locator('#overview-body .kpi-strip[data-probe="kept"]').count(), 1, "no redraw when nothing changed");
    assert.equal(copy.uploads.length, uploadsBefore, "no upload when nothing changed");

    // A run arrives from another device: it shows up with a quiet notice.
    copy.runs.push(stored(1790172800, "03"));
    await page.clock.fastForward("05:30");
    await page.waitForFunction(() => /1 run from your other device/.test(document.getElementById("toast")?.textContent || ""), null, { timeout: SYNC_TIMEOUT_MS });
    assert.equal(copy.gets, getsAtBoot + 2);
    if (SENDS_ONLY_WHAT_COPY_LACKS) assert.equal(copy.uploads.length, 0, "pulling never uploads when the copy already has everything");

    // Coming back to the tab pulls too, but not within two minutes of the last pull.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
    assert.equal(copy.gets, getsAtBoot + 2, "a focus right after a pull does not pull again");
    await page.clock.fastForward("02:30");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(500);
    assert.equal(copy.gets, getsAtBoot + 3, "a focus two minutes later does");
    await context.close();
  });

  await check("a signed-out tab never asks for a Steam copy", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await prepare(context);
    const copy = mockSteamCopy(context);
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${BASE}/?ui=classic`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: BOOT_TIMEOUT_MS });
    await page.clock.fastForward("11:00");
    await page.waitForTimeout(300);
    assert.equal(copy.gets, 0);
    await context.close();
  });

  console.log(`\nall ${passed} checks passed`);
}

try {
  await main();
} catch {
  process.exitCode = 1;
} finally {
  for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
}
