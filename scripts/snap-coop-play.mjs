#!/usr/bin/env node
/**
 * Screenshots of every co-op Play state, in both looks, at desktop and phone
 * size, for design review. The page is the real app served by
 * Web/scripts/dev-static.mjs; /api/coop/play is answered from fixtures shaped
 * like Backend/src/coop-play-core.ts, so the images are deterministic.
 *
 *   node scripts/snap-coop-play.mjs            → docs/screenshots/coop-play/*.png
 *   node scripts/snap-coop-play.mjs --out DIR
 *   node scripts/snap-coop-play.mjs --only searching,party-host   (just those states)
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** SNAP_COOP_PORT moves the page server when 8784 is taken by something else. */
const PORT = Number(process.env.SNAP_COOP_PORT) || 8784;
const BASE = `http://127.0.0.1:${PORT}`;
const outIndex = process.argv.indexOf("--out");
const OUT = resolve(outIndex > -1 ? process.argv[outIndex + 1] : join(REPO_ROOT, "docs", "screenshots", "coop-play"));
const onlyIndex = process.argv.indexOf("--only");
const ONLY = onlyIndex > -1 ? new Set(String(process.argv[onlyIndex + 1] || "").split(",").filter(Boolean)) : null;

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

/**
 * Saves for "Your co-op climbs", in the shape the run parser produces. `party`
 * lists every player's climber; a solo run is a party of one.
 */
function savedRun(n, party, extra = {}) {
  const ended = new Date(Date.UTC(2026, 10, 1 + n, 21, 0, 0));
  return {
    id: `snap-${n}`, character: party[0], party, partySize: party.length, ascension: 5, seed: `SNAP${n}`, won: false,
    floorReached: 24, playTimeSeconds: 2400, startedAt: new Date(ended.getTime() - 2400_000).toISOString(), endedAt: ended.toISOString(),
    relics: [], deckAtEnd: [], cardPicks: [], pathByAct: [], sourceFile: `snap-${n}.run`, schemaVersion: 11, gameMode: "standard",
    wasAbandoned: false, modifiers: [], inProgress: false, ...extra,
  };
}
const SOLO_SAVES = [
  savedRun(1, ["silent"], { won: true, floorReached: 51 }),
  savedRun(2, ["ironclad"]),
  savedRun(3, ["defect"], { won: true, floorReached: 51 }),
];
const COOP_SAVES = [
  ...SOLO_SAVES,
  savedRun(4, ["fool", "necrobinder"], { ascension: 3, floorReached: 20 }),
  savedRun(6, ["ironclad", "silent"], { won: true, ascension: 7, floorReached: 51 }),
  savedRun(9, ["defect", "regent", "silent"], { ascension: 5, floorReached: 12, wasAbandoned: true }),
  savedRun(12, ["ironclad", "silent"], { ascension: 9, floorReached: 33 }),
  savedRun(14, ["silent", "ironclad"], { won: true, ascension: 8, floorReached: 51 }),
];

const SHOTS = [
  ["idle-empty", "idle", "/coop"],
  ["idle-live", "idle", "/coop"],
  // Under the card: saves with no co-op runs yet, then with some.
  ["idle-solo-saves", "idle", "/coop", "solo-saves"],
  ["idle-coop-saves", "idle", "/coop", "coop-saves"],
  ["searching", "searching", "/coop"],
  // Right after Share to Discord is tapped: the button says so, and the toast.
  ["searching-shared", "searching", "/coop", "share"],
  ["party-host", "matched", "/coop"],
  ["party-joiner", "matched", "/coop"],
  ["party-full", "matched", "/coop"],
  ["in-game", "in_game", "/coop"],
  ["ended", "idle", "/party/" + "f".repeat(32)],
];
// "/" opens the new look since 2026-11-15: classic has to be asked for.
const LOOKS = [["classic", "?ui=classic"], ["new", "?ui=next"]];
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
        for (const [fixture, state, path, tap] of SHOTS) {
          if (ONLY && !ONLY.has(fixture)) continue;
          const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
          await context.addInitScript((value) => {
            try { localStorage.setItem("vault.web.session", value); } catch { /* ignore */ }
          }, JSON.stringify(SESSION));
          await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
          const answer = view(fixture === "ended" || /-saves$/.test(fixture) ? "idle-empty" : fixture.replace(/-shared$/, ""));
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
          // For the same reason the connection line would read red ("Trouble
          // reaching server") and the card "Session expired". Show what a
          // signed-in player on a working server sees.
          await page.evaluate(() => {
            for (const id of ["status-dot", "status-dot-mobile"]) {
              const dot = document.getElementById(id);
              if (dot) dot.dataset.state = "online";
            }
            for (const id of ["status-label", "status-label-mobile"]) {
              const label = document.getElementById(id);
              if (label) label.textContent = "Live on the feed";
            }
            const tier = document.getElementById("me-pill-tier");
            if (tier) tier.textContent = "Steam connected";
          });
          if (tap === "solo-saves" || tap === "coop-saves") {
            // Loading saves takes the app to Overview; come back to Co-op.
            await page.evaluate((runs) => window.SpireVault.ingestDesktopRuns(runs), tap === "coop-saves" ? COOP_SAVES : SOLO_SAVES);
            await page.waitForFunction(() => window.SpireVault.activeTab() === "overview", null, { timeout: 8000 });
            await page.evaluate(() => window.SpireVault.switchTab("coop"));
            await page.waitForSelector(tap === "coop-saves" ? "#coop-play-root .cp-climbs:not(.is-example) .cp-stats" : '#coop-play-root .cp-climbs-note [data-cp="refresh-saves"]', { timeout: 8000 });
          }
          if (tap === "share") {
            await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
            await page.click('#coop-play-root .cp-card [data-cp="share"]');
            await page.waitForSelector('#coop-play-root .cp-card [data-cp="share"].is-done', { timeout: 5000 });
          }
          await page.waitForTimeout(400);
          // Loading saves makes the app try its cloud copy, which this static
          // server does not have; that error toast is not part of co-op.
          // Hidden at once: left to fade, it shows through the shot as ghost text.
          if (tap !== "share") {
            await page.evaluate(() => {
              const toast = document.getElementById("toast");
              if (!toast) return;
              toast.classList.remove("is-visible");
              toast.style.transition = "none";
              toast.style.visibility = "hidden";
            });
          }
          const file = join(OUT, `${look}-${sizeName}-${fixture}.png`);
          await page.screenshot({ path: file, fullPage: true });
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
