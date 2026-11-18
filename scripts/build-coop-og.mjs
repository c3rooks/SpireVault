#!/usr/bin/env node
/**
 * Renders the link preview for /coop, the address the "Share to Discord"
 * post carries (Web/lib/coop-play-share.js). Same family as the app's own
 * preview (scripts/build-brand-og.mjs): the crest, the gold blackletter and
 * the campfire scene. On the right stands a co-op party in a game room,
 * drawn by the app's real Play card code, with one seat still open.
 *
 *   node scripts/build-coop-og.mjs     → Web/assets/og-coop-v<VERSION>.jpg (1200x630)
 *
 * /assets is cached as immutable: bump VERSION here, COOP_EMBED.image in
 * Web/functions/_shared/coop-embed.js and EMBED.image in
 * Web/lib/coop-play-share.js when the picture changes.
 *
 * A name is spent the moment anyone requests it on production, deployed or
 * not: v1 was fetched from app.spirevault.app before it existed, so the CDN
 * cached the app's HTML under that URL for a year. Never ask production for
 * a new name before the deploy that carries the file.
 * COOP_OG_PORT moves the page server when 8785 is taken.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO, "package.json"));
const { chromium } = require("playwright");

const VERSION = 2;
const WIDTH = 1200;
const HEIGHT = 630;
const JPEG_QUALITY = 90;
const PORT = Number(process.env.COOP_OG_PORT) || 8785;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(REPO, "Web", "assets", `og-coop-v${VERSION}.jpg`);

/** The room the party stands in, and who is in it. Tags name the climbers, not people. */
const ROOM = { room: "hive", take: "c" };
const PARTY = [
  { sid: "1", name: "Ironclad", character: "ironclad", isHost: true },
  { sid: "2", name: "Silent", character: "silent" },
  { sid: "3", name: "Defect", character: "defect" },
];

const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/lib/coop-play.css">
<style>
@font-face{font-family:"Grenze Gotisch";src:url(/assets/fonts/grenze-gotisch-latin-var-v1.woff2) format("woff2");font-weight:100 900}
@font-face{font-family:Figtree;src:url(/assets/fonts/figtree-latin-var-v1.woff2) format("woff2");font-weight:300 900}
*{margin:0;box-sizing:border-box}
body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0f0a22;font-family:Figtree,sans-serif}
.scene{position:absolute;inset:0;background:url(/assets/stage/scenes/campfire-3840-v1.webp) left center/auto 100% no-repeat}
.veil{position:absolute;inset:0;background:linear-gradient(90deg,rgba(10,6,22,.9) 0%,rgba(10,6,22,.74) 52%,rgba(10,6,22,.5) 100%),linear-gradient(0deg,rgba(10,6,22,.55),rgba(10,6,22,0) 30%)}
.copy{position:absolute;left:64px;top:50%;transform:translateY(-50%);width:480px}
.brand{display:flex;align-items:center;gap:16px}
.brand img{width:76px;height:76px;filter:drop-shadow(3px 3px 0 #0a0616)}
.brand b{font:900 50px/1 "Grenze Gotisch",serif;color:#ffd24a;text-shadow:3px 3px 0 #0a0616}
h1{margin-top:26px;font:900 116px/0.9 "Grenze Gotisch",serif;color:#ffd24a;text-shadow:5px 5px 0 #0a0616;transform:rotate(-2deg);transform-origin:left center;white-space:nowrap}
p{margin-top:24px;font:800 31px/1.22 Figtree,sans-serif;color:#fff1cf;text-shadow:2px 2px 0 #0a0616}
small{display:block;margin-top:16px;font:700 21px/1 Figtree,sans-serif;letter-spacing:.06em;color:#b7abe0;text-shadow:2px 2px 0 #0a0616}
/* The app's party scene, inked like the new look. */
.room{position:absolute;right:60px;top:50%;transform:translateY(-50%);width:560px;--cp-font:Figtree,sans-serif}
.room .cp-scene{aspect-ratio:16/10;min-height:0;border:5px solid #0a0616;border-radius:24px;box-shadow:9px 9px 0 #0a0616}
</style>
<div class="scene"></div><div class="veil"></div>
<div class="copy">
  <div class="brand"><img src="/assets/brand/crest-icon-512-v1.png" alt=""><b>SpireVault</b></div>
  <h1>Play co-op</h1>
  <p>Slay the Spire 2 with a party.<br>One tap to get matched.</p>
  <small>APP.SPIREVAULT.APP/COOP</small>
</div>
<section class="room cp" id="room"></section>
<script type="module">
  import * as View from "/lib/coop-play-view.js";
  import { STAGE_BACKDROPS } from "/lib/ui/stage-backdrops.js";
  const want = ${JSON.stringify(ROOM)};
  const index = STAGE_BACKDROPS.findIndex((b) => b.room === want.room && b.take === want.take);
  if (index < 0) throw new Error("no such room: " + JSON.stringify(want));
  // The card picks a party's room from its match id; find an id that lands on ours.
  const roomOf = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % STAGE_BACKDROPS.length; };
  let n = 0;
  while (roomOf("og" + n) !== index) n += 1;
  const members = ${JSON.stringify(PARTY)}.map((m) => ({ isYou: false, isHost: false, steamAdded: false, status: "joined", ...m }));
  const view = { state: "matched", match: { matchId: "og" + n, branch: "stable", youAreHost: false, hostSid: "1", hostHosting: false, locked: false, seatsLeft: 4 - members.length, members } };
  const holder = document.createElement("div");
  holder.innerHTML = View.partyHtml({ view });
  document.getElementById("room").appendChild(holder.querySelector(".cp-scene"));
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => {})));
  View.fitPartyTags(document);
  window.__ready = true;
</script>`;

function startServer() {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [join(REPO, "Web", "scripts", "dev-static.mjs"), String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
    const timer = setTimeout(() => reject(new Error("dev-static did not start")), 15000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("serving")) {
        clearTimeout(timer);
        resolveStart(child);
      }
    });
    child.on("error", reject);
  });
}

const server = await startServer();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const problems = [];
  page.on("pageerror", (err) => problems.push(err.message));
  await page.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  await page.route("**/__coop-og", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto(`${BASE}/__coop-og`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 }).catch(() => {
    throw new Error(`the page never finished: ${problems.join("; ") || "no error reported"}`);
  });
  await page.screenshot({ path: OUT, type: "jpeg", quality: JPEG_QUALITY });
  process.stdout.write(`${OUT.slice(REPO.length + 1)}\n`);
} finally {
  await browser.close();
  server.kill();
}
