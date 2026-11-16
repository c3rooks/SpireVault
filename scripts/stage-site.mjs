#!/usr/bin/env node
/**
 * Stages the landing page (Site/) for a deploy: copies only the files the
 * page serves into a clean folder outside iCloud, so nothing else in Site/
 * is published.
 *
 * Everything in the folder handed to Cloudflare Pages becomes public. Site/
 * also holds a Makefile, a README, the pictures the GitHub README embeds and
 * an old Mac installer, none of which the page needs. This script publishes
 * by whitelist instead:
 *
 *   index.html, boot.js, script.js, _headers, _redirects
 *   css/*.css
 *   assets/**   except assets/screenshots/ (README pictures) and any installer
 *
 * No installer is ever published: downloads come from the GitHub release, and
 * the installer's old address (/assets/The.Vault.dmg) redirects there
 * (Site/_redirects).
 *
 *   node scripts/stage-site.mjs --list          what would be published
 *   node scripts/stage-site.mjs                 stage into the default folder
 *   node scripts/stage-site.mjs --out <dir>     stage somewhere else under the cache folder
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_ROOT = join(REPO_ROOT, "Site");
/** The only place a stage may be written (and so the only place this script deletes). */
const CACHE_ROOT = join(homedir(), "Library", "Caches", "spirevault-site");
const DEFAULT_OUT = join(CACHE_ROOT, "stage");

const TOP_LEVEL_FILES = Object.freeze(["index.html", "boot.js", "script.js", "_headers", "_redirects"]);
const CSS_DIR = "css";
const ASSETS_DIR = "assets";
/** Under assets/, left out on purpose. */
const ASSET_EXCLUDES = Object.freeze(["assets/screenshots/"]);
const INSTALLER = /\.(dmg|exe|pkg|msi)$/i;

function fail(message) {
  process.stderr.write(`stage-site: ${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { list: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--list") options.list = true;
    else if (token === "--out") options.out = resolve(argv[(i += 1)] || "");
    else fail(`unknown option: ${token}`);
  }
  return options;
}

/** Every file under a folder, as paths relative to Site/ with forward slashes. */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(join(SITE_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) found.push(...walk(rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

/** The files the page serves, and the ones under Site/ that are being left out. */
function plan() {
  const publish = [];
  for (const name of TOP_LEVEL_FILES) {
    if (!existsSync(join(SITE_ROOT, name))) fail(`Site/${name} is missing`);
    publish.push(name);
  }
  publish.push(...walk(CSS_DIR).filter((file) => file.endsWith(".css")));
  const leftOut = [];
  for (const file of walk(ASSETS_DIR)) {
    if (INSTALLER.test(file) || ASSET_EXCLUDES.some((prefix) => file.startsWith(prefix))) leftOut.push(file);
    else publish.push(file);
  }
  return { publish: publish.sort(), leftOut: leftOut.sort() };
}

/** macOS reports a size but no disk blocks for a file iCloud has offloaded. */
function isOffloaded(file) {
  const info = statSync(file);
  return process.platform === "darwin" && info.size > 0 && info.blocks === 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const { publish, leftOut } = plan();
  const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
  const total = publish.reduce((sum, file) => sum + statSync(join(SITE_ROOT, file)).size, 0);
  const leftOutNote = `left out: ${leftOut.join(", ") || "nothing"}`;

  if (options.list) {
    process.stdout.write(`${publish.join("\n")}\n\n${publish.length} file(s), ${kb(total)}, would be published\n${leftOutNote}\n`);
    return;
  }

  const out = options.out;
  if (out === CACHE_ROOT) fail("--out must be a folder inside the cache folder, not the cache folder itself");
  if (!out.startsWith(CACHE_ROOT + sep)) fail(`--out must be under ${CACHE_ROOT} (this script empties the folder it stages into)`);

  const offloaded = publish.filter((file) => isOffloaded(join(SITE_ROOT, file)));
  if (offloaded.length) fail(`offloaded to iCloud, bring them back first (brctl download): ${offloaded.join(", ")}`);

  rmSync(out, { recursive: true, force: true });
  for (const file of publish) {
    const dest = join(out, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(SITE_ROOT, file), dest);
  }
  process.stdout.write(`stage-site: ${publish.length} file(s), ${kb(total)}, staged in ${out}\nstage-site: ${leftOutNote}\n`);
}

main();
