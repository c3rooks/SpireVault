#!/usr/bin/env node
/**
 * Screenshots of every co-op Play state, in both looks, at desktop and phone
 * size, for design review. The page is the real app served by
 * Web/scripts/dev-static.mjs; /api/coop/play is answered from fixtures shaped
 * like Backend/src/coop-play-core.ts, so the images are deterministic.
 *
 *   node scripts/snap-coop-play.mjs            → docs/screenshots/coop-play/*.png
 *   node scripts/snap-coop-play.mjs --out DIR
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8784;
const BASE = `http://127.0.0.1:${PORT}`;
const outIndex = process.argv.indexOf("--out");
const OUT = resolve(outIndex > -1 ? process.argv[outIndex + 1] : join(REPO_ROOT, "docs", "screenshots", "coop-play"));

const ME = "76561198000000001";
const SESSION = { steamID: ME, personaName: "c3rooks", sessionToken: "snap-token", signedInAt: "2026-11-01T00:00:00.000Z" };
const PEOPLE = [
  { sid: "76561198000000002", name: "Boble", character: "ironclad" },
  { sid: "76561198000000003", name: "Mako", character: "defect" },
  { sid: "76561198000000004", name: "IAmWeirdAndLong", character: "necrobinder" },
];

function view(state) {
  const base = { ok: true, lookingCount: 0, playingCount: 0, lookingByBranch: { stable: 0, beta: 0 }, pings: { looking: false }, pushOn: false };
  const party = (youHost, extra = {}) => {
    const you = { sid: ME, name: "c3rooks", character: extra.you ?? "silent", isYou: true, steamAdded: false, status: "joined" };
    const others = PEOPLE.slice(0, extra.size ? extra.size - 1 : 1).map((p) => ({ ...p, isYou: false, steamAdded: false, status: "joined" }));
    const members = youHost ? [you, ...others] : [others[0], you, ...others.slice(1)];
    const hostSid = members[0].sid;
    return {
      matchId: extra.matchId ?? "c0ffee".padEnd(32, "0"),
      branch: extra.branch ?? "stable",
      createdAt: Date.now() - 30000,
      youAreHost: youHost,
      hostSid,
      hostHosting: Boolean(extra.hosting),
      locked: Boolean(extra.locked),
      seatsLeft: 4 - members.length,
      members: members.map((m) => ({ ...m, isHost: m.sid === hostSid })),
    };
  };
  switch (state) {
    case "idle-empty": return { ...base, state: "idle" };
    case "idle-live": return { ...base, state: "idle", lookingCount: 2, lookingByBranch: { stable: 2, beta: 0 }, playingCount: 3 };
    case "searching": return { ...base, state: "searching", lookingCount: 1, lookingByBranch: { stable: 1, beta: 0 }, ticket: { createdAt: Date.now() - 42000, character: "silent", branch: "stable", push: false } };
    case "party-host": return { ...base, state: "matched", playingCount: 2, match: party(true) };
    case "party-joiner": return { ...base, state: "matched", playingCount: 3, match: party(false, { size: 3, hosting: true }) };
    case "party-full": return { ...base, state: "matched", playingCount: 4, match: party(true, { size: 4, you: "fool", branch: "beta", hosting: true }) };
    case "in-game": return { ...base, state: "in_game", playingCount: 2, match: party(true, { locked: true }) };
    default: throw new Error(state);
  }
}

const SHOTS = [
  ["idle-empty", "idle", "/coop"],
  ["idle-live", "idle", "/coop"],
  ["searching", "searching", "/coop"],
  ["party-host", "matched", "/coop"],
  ["party-joiner", "matched", "/coop"],
  ["party-full", "matched", "/coop"],
  ["in-game", "in_game", "/coop"],
  ["ended", "idle", "/party/" + "f".repeat(32)],
];
const LOOKS = [["classic", ""], ["new", "?ui=next"]];
const SIZES = [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]];

function startServer() {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "Web", "scripts", "dev-static.mjs"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
    const timer = setTimeout(() => reject(new Error("dev-static did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolveStart(child);
      }
    });
    child.on("error", reject);
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    for (const [look, query] of LOOKS) {
      for (const [sizeName, viewport] of SIZES) {
        for (const [fixture, state, path] of SHOTS) {
          const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
          await context.addInitScript((value) => {
            try { localStorage.setItem("vault.web.session", value); } catch { /* ignore */ }
          }, JSON.stringify(SESSION));
          await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
          const answer = view(fixture === "ended" ? "idle-empty" : fixture);
          await context.route("**/api/coop/play**", (route) =>
            route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) }),
          );
          const page = await context.newPage();
          const sep = query && path.includes("?") ? "&" : "";
          await page.goto(`${BASE}${path}${query ? (sep || "?") + query.slice(1) : ""}`, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(() => window.SpireVault && !window.SpireVault.__isStub, null, { timeout: 20000 });
          await page.evaluate(() => window.SpireVault.switchTab("coop"));
          await page.waitForSelector(`#coop-play-root .cp[data-cp-state="${state}"]`, { timeout: 10000 });
          await page.evaluate(() => Promise.all([...document.querySelectorAll(".cp img")].map((img) => img.decode().catch(() => {}))));
          // The static server has no sign-in backend, so the app shows its
          // "session expired" notice and a server warning. Not part of co-op.
          await page.addStyleTag({ content: ".session-expired-notice{display:none!important}" });
          await page.waitForTimeout(400);
          const file = join(OUT, `${look}-${sizeName}-${fixture}.png`);
          await page.screenshot({ path: file, fullPage: sizeName === "phone" });
          process.stdout.write(`  ${file}\n`);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  process.stderr.write(`snap-coop-play failed: ${err?.stack || err}\n`);
  process.exit(1);
});
