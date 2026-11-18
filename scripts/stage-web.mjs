#!/usr/bin/env node
/**
 * Stages the web app (Web/) for a Cloudflare Pages deploy: copies it into a
 * clean folder outside iCloud, so local-only files are never published.
 *
 * Everything in the folder handed to `wrangler pages deploy` becomes public.
 * Web/ also holds .dev.vars (local Worker overrides), .dev.vars.preview-bak,
 * .wrangler/ (local state, ~200 MB) and .audit-screenshots/. This script
 * leaves out every dot-file and dot-folder at any depth, and iCloud's
 * conflict copies ("script 2.js"). It refuses to run while any file is
 * offloaded to iCloud (reading one would stall the copy), and it fails if
 * the staged folder contains anything that looks like a secret.
 *
 * Preview builds: --preview-host <host> rewrites the absolute og:image
 * addresses (https://app.spirevault.app/assets/...) to that host in the
 * staged copy only. A link unfurler (Discord, iMessage) reading a preview
 * page would otherwise fetch not-yet-deployed images from production, and
 * production answers an unknown /assets/ path with the app's HTML under a
 * year-long immutable cache header.
 *
 *   node scripts/stage-web.mjs --list
 *   node scripts/stage-web.mjs --name prod
 *   node scripts/stage-web.mjs --name rc-1117 --preview-host rc-1117.vault-web-e90.pages.dev
 *
 * Layout of the stage, the same shape `make -C Web deploy` deploys from:
 *   <stage>/wrangler.toml   Web/wrangler.toml with pages_build_output_dir = "public"
 *   <stage>/functions/      the Pages Functions (/api proxy, /coop, /share, /admin)
 *   <stage>/public/         every published file
 * wrangler finds Functions in ./functions of the folder it runs in, never
 * inside the uploaded folder, so deploy from <stage> itself; its scratch
 * folder (.wrangler/) then lands beside public/, not in it.
 *
 * Then: cd <stage> && npx --yes wrangler@4 pages deploy --project-name=vault-web --branch=<branch> --commit-dirty=true
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(REPO_ROOT, "Web");
/** The only place a stage may be written (and so the only place this script deletes). */
const CACHE_ROOT = join(homedir(), "Library", "Caches", "spirevault-web");
const PROD_ORIGIN = "https://app.spirevault.app";
/** Files whose absolute production asset links a preview must not keep. */
const OG_REWRITE = /\.(html|js)$/;
const HOST_SHAPE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const CONFLICT_COPY = / \d+(\.[^/]+)?$/;
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/, // a private JWK
  /\b(ADMIN_TOKEN|HOUSE_LOBBY_ADMIN_SECRET|VAPID_PRIVATE_JWK|STEAM_API_KEY)\s*=\s*\S{8,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
]);

function fail(message) {
  process.stderr.write(`stage-web: ${message}\n`);
  process.exit(1);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { list: false, name: "prod", previewHost: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--list") options.list = true;
    else if (token === "--name") options.name = argv[(i += 1)] || "";
    else if (token === "--preview-host") options.previewHost = (argv[(i += 1)] || "").toLowerCase();
    else fail(`unknown option: ${token}`);
  }
  if (!/^[a-z0-9-]+$/.test(options.name)) fail(`--name must be lowercase letters, digits and hyphens`);
  if (options.previewHost && !HOST_SHAPE.test(options.previewHost)) fail(`--preview-host is not a host name`);
  if (options.previewHost === "app.spirevault.app") fail(`--preview-host must not be production`);
  return options;
}

/** Every publishable file under Web/, relative, forward slashes; plus what was left out. */
function plan() {
  const publish = [];
  const leftOut = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(WEB_ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || CONFLICT_COPY.test(entry.name)) {
        leftOut.push(entry.isDirectory() ? `${rel}/` : rel);
        continue;
      }
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) publish.push(rel);
    }
  };
  walk("");
  return { publish: publish.sort(), leftOut: leftOut.sort() };
}

/** Files iCloud has offloaded (reading them would block on a download). */
function offloaded() {
  try {
    const out = execFileSync("find", [WEB_ROOT, "-not", "-path", "*/.*", "-flags", "+dataless"], { encoding: "utf8" });
    return out.split("\n").filter(Boolean).map((p) => relative(WEB_ROOT, p));
  } catch (error) {
    fail(`could not check for offloaded files: ${error.message}`);
    return [];
  }
}

function stage({ name, previewHost }, files) {
  const out = join(CACHE_ROOT, `stage-${name}`);
  if (!resolve(out).startsWith(CACHE_ROOT + sep)) fail(`refusing to write outside ${CACHE_ROOT}`);
  rmSync(out, { recursive: true, force: true });
  let rewritten = 0;
  for (const rel of files) {
    const isFunction = rel.startsWith("functions/");
    if (rel === "wrangler.toml") continue; // written below, pointed at public/
    const dest = isFunction ? join(out, rel) : join(out, "public", rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(WEB_ROOT, rel), dest);
    if (!previewHost || !OG_REWRITE.test(rel)) continue;
    const text = readFileSync(dest, "utf8");
    const next = text.split(`${PROD_ORIGIN}/assets/`).join(`https://${previewHost}/assets/`);
    if (next !== text) {
      writeFileSync(dest, next);
      rewritten += 1;
    }
  }
  const toml = readFileSync(join(WEB_ROOT, "wrangler.toml"), "utf8");
  if (!/^pages_build_output_dir = "\."$/m.test(toml)) fail("Web/wrangler.toml no longer sets pages_build_output_dir = \".\"");
  writeFileSync(join(out, "wrangler.toml"), toml.replace(/^pages_build_output_dir = "\."$/m, 'pages_build_output_dir = "public"'));
  return { out, rewritten };
}

function scanForSecrets(out, files) {
  const hits = [];
  for (const rel of files) {
    if (rel === "wrangler.toml") continue;
    const path = rel.startsWith("functions/") ? join(out, rel) : join(out, "public", rel);
    if (statSync(path).size > 2_000_000) continue; // images, fonts
    const text = readFileSync(path, "utf8");
    for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) hits.push(`${rel} (${pattern.source.slice(0, 40)})`);
  }
  return hits;
}

const options = parseArgs(process.argv.slice(2));
const { publish, leftOut } = plan();
if (options.list) {
  process.stdout.write(`${publish.length} files would be published.\nLeft out:\n${leftOut.map((p) => `  ${p}`).join("\n")}\n`);
  process.exit(0);
}
const evicted = offloaded();
if (evicted.length) fail(`${evicted.length} files are offloaded to iCloud (first: ${evicted[0]}); open them or download the folder first`);
const { out, rewritten } = stage(options, publish);
const secrets = scanForSecrets(out, publish);
if (secrets.length) {
  rmSync(out, { recursive: true, force: true });
  fail(`staged copy looked like it held secrets, so it was deleted:\n  ${secrets.join("\n  ")}`);
}
process.stdout.write(
  `Staged ${publish.length} files in ${out} (public/, functions/, wrangler.toml)\n` +
    `Left out: ${leftOut.join(", ")}\n` +
    (options.previewHost ? `Preview: og:image links rewritten to https://${options.previewHost}/assets/ in ${rewritten} files\n` : ""),
);
