#!/usr/bin/env node
/**
 * Renders the web app's link preview (Discord, Slack, iMessage, X):
 * the crest and the gold blackletter wordmark over the campfire header scene.
 *
 *   node scripts/build-brand-og.mjs        → Web/assets/og-v<VERSION>.png (1200x630)
 *
 * Run scripts/build-brand-icons.mjs first (it writes the crest this uses).
 * /assets is cached as immutable: bump VERSION, and the og:image and
 * twitter:image URLs in Web/index.html, when the picture changes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO, "package.json"));
const { chromium } = require("playwright");

const VERSION = 2;
const WIDTH = 1200;
const HEIGHT = 630;
const OUT = join(REPO, "Web", "assets", `og-v${VERSION}.png`);
const asset = (path) => pathToFileURL(join(REPO, "Web", "assets", path)).href;

// The campfire scene is ember against navy, the crest's own palette. The
// scene is 3:1; at 630px tall the fire sits about 700-950px in, right of
// the lettering.
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:"Grenze Gotisch";src:url(${asset("fonts/grenze-gotisch-latin-var-v1.woff2")}) format("woff2");font-weight:100 900}
@font-face{font-family:Figtree;src:url(${asset("fonts/figtree-latin-var-v1.woff2")}) format("woff2");font-weight:300 900}
*{margin:0;box-sizing:border-box}
body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#0f0a22}
.scene{position:absolute;inset:0;background:url(${asset("stage/scenes/campfire-3840-v1.webp")}) left center/auto 100% no-repeat}
.veil{position:absolute;inset:0;background:linear-gradient(90deg,rgba(10,6,22,.86) 0%,rgba(10,6,22,.62) 46%,rgba(10,6,22,0) 78%),linear-gradient(0deg,rgba(10,6,22,.55),rgba(10,6,22,0) 30%)}
.lockup{position:absolute;left:76px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:34px}
.crest{width:250px;height:250px;filter:drop-shadow(5px 5px 0 #0a0616)}
h1{font:900 128px/0.9 "Grenze Gotisch",serif;color:#ffd24a;text-shadow:5px 5px 0 #0a0616;transform:rotate(-2deg);transform-origin:left center}
p{margin-top:22px;font:800 33px/1.2 Figtree,sans-serif;color:#fff1cf;text-shadow:2px 2px 0 #0a0616}
small{display:block;margin-top:14px;font:700 22px/1 Figtree,sans-serif;letter-spacing:.06em;color:#b7abe0;text-shadow:2px 2px 0 #0a0616}
</style>
<div class="scene"></div><div class="veil"></div>
<div class="lockup">
  <img class="crest" src="${asset("brand/crest-icon-512-v1.png")}" alt="">
  <div><h1>SpireVault</h1><p>Slay the Spire 2 stats, runs<br>and a partner to climb with</p><small>APP.SPIREVAULT.APP</small></div>
</div>`;

// A file:// page, so it may load the fonts, scene and crest from the repo.
const dir = mkdtempSync(join(tmpdir(), "og-"));
const pagePath = join(dir, "og.html");
writeFileSync(pagePath, html);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(pagePath).href, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT, type: "png" });
  process.stdout.write(`${OUT.slice(REPO.length + 1)}\n`);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
