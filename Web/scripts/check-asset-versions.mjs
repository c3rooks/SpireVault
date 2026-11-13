#!/usr/bin/env node
/**
 * Guards the immutable-caching contract in Web/_headers.
 *
 * /script.js, the three stylesheets (/styles.css, /styles.next.css,
 * /styles.mobile.css), /run-coach.js and everything under /lib/* are
 * served `max-age=31536000, immutable`. That is only safe because every
 * reference to them carries a `?v=` token: a version-pinned URL is a distinct
 * cache entry, so bumping the token is what delivers new code.
 *
 * An unversioned reference to one of those paths is a latent year-long stale
 * cache for every user who loads it once. This script fails the build on that,
 * and on the subtler failure mode of the same file being referenced at two
 * different tokens — which under ES module semantics also produces two
 * separate module instances with two copies of module-level state.
 *
 * It also guards the other half of the contract — "the token must be bumped
 * whenever the file changes" — with a lock file, asset-versions.lock.json,
 * that records the token and content hash of every immutable file as of the
 * last deploy. If a file's content differs from the lock while its token is
 * still the one that was deployed, returning visitors would keep the old copy
 * for a year; that fails the build. Files not yet in the lock have never been
 * deployed and may change freely. `--record` rewrites the lock and is run by
 * `make deploy` after a successful deploy.
 *
 * Run:    node Web/scripts/check-asset-versions.mjs   (or `npm run check:asset-versions`)
 * Record: node Web/scripts/check-asset-versions.mjs --record
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

/** VAULT_WEB_ROOT lets the lock be seeded from another checkout (git worktree). */
const WEB_ROOT = process.env.VAULT_WEB_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_FILE = join(dirname(fileURLToPath(import.meta.url)), "asset-versions.lock.json");
const RECORD = process.argv.includes("--record");

/** Path prefixes served with `immutable` in _headers. */
const IMMUTABLE = [
  /^\/lib\//,
  /^\/script\.js$/,
  /^\/styles\.css$/,
  /^\/styles\.next\.css$/,
  /^\/styles\.mobile\.css$/,
  /^\/run-coach\.js$/,
];

function isImmutablePath(p) {
  return IMMUTABLE.some((re) => re.test(p));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "assets" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Resolves a reference as written in `file` to a site-absolute path, so that
 * `./coop-sandbox.js` inside /lib and `/lib/coop-sandbox.js` from the root
 * compare equal — they are the same cache entry and the same module.
 */
function toAbsolute(ref, file) {
  const [path] = ref.split("?");
  if (path.startsWith("/")) return path;
  if (!path.startsWith(".")) return null; // bare specifier / external URL
  const fromDir = "/" + relative(WEB_ROOT, dirname(file)).split("\\").join("/");
  const parts = (fromDir === "/" ? "" : fromDir).split("/").filter(Boolean);
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/**
 * Blanks out comments so prose can't be mistaken for code.
 *
 * This file's own docs contain strings like `<script src="/script.js?v=NN">`,
 * and flagging those would train people to ignore the checker. Replaces
 * comment bodies with spaces rather than deleting them so byte offsets — and
 * therefore any future line-number reporting — stay accurate.
 *
 * Tracks quotes and template literals well enough that a `//` inside a URL
 * string is not mistaken for a line comment. It does not attempt to
 * distinguish a regex literal from division; the failure mode there is a
 * missed reference inside a regex, which is not a thing this codebase does.
 */
function stripComments(src, isHtml) {
  if (isHtml) return src.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  let out = "";
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let k = i; k < stop; k++) out += src[k] === "\n" ? "\n" : " ";
      i = stop;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Every way this codebase names a JS/CSS file: static import, dynamic import,
// re-export, <script src>, <link href>, and string literals handed to
// document.createElement("script").src.
const PATTERNS = [
  /(?:^|[\s{}])(?:import|export)[^;'"]*?from\s+["']([^"']+\.(?:js|mjs|css))(\?[^"']*)?["']/g,
  /\bimport\(\s*["']([^"']+\.(?:js|mjs|css))(\?[^"']*)?["']\s*\)/g,
  /(?:src|href)\s*=\s*["']([^"']+\.(?:js|mjs|css))(\?[^"']*)?["']/g,
  /\.(?:src|href)\s*=\s*["']([^"']+\.(?:js|mjs|css))(\?[^"']*)?["']/g,
  // CSS `@import url("/styles.css?v=N") layer(legacy)` — how the new UI loads
  // the legacy sheet into a cascade layer (index.html, lib/ui/legacy-layer.js).
  /\burl\(\s*["']?([^"')\s]+\.css)(\?[^"')\s]*)?["']?\s*\)/g,
];

const errors = [];
/** absolute path → Map<token, Set<referencing file>> */
const tokensByPath = new Map();

for (const file of walk(WEB_ROOT)) {
  const rel = relative(WEB_ROOT, file);
  const src = stripComments(readFileSync(file, "utf8"), file.endsWith(".html"));

  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const query = m[2] || "";
      const abs = toAbsolute(m[1], file);
      if (!abs || !isImmutablePath(abs)) continue;

      const token = /[?&]v=([^&]+)/.exec(query)?.[1];
      if (!token) {
        errors.push(
          `${rel}: "${m[1]}" resolves to ${abs}, which is served immutable, ` +
            `but carries no ?v= token. Users who load it once are pinned to ` +
            `that copy for a year.`
        );
        continue;
      }
      if (!tokensByPath.has(abs)) tokensByPath.set(abs, new Map());
      const byToken = tokensByPath.get(abs);
      if (!byToken.has(token)) byToken.set(token, new Set());
      byToken.get(token).add(rel);
    }
  }
}

for (const [abs, byToken] of tokensByPath) {
  if (byToken.size <= 1) continue;
  const detail = [...byToken.entries()]
    .map(([tok, files]) => `    v=${tok}  <- ${[...files].join(", ")}`)
    .join("\n");
  errors.push(
    `${abs} is referenced at ${byToken.size} different versions. Each is a ` +
      `separate download and, for ES modules, a separate instance with its own ` +
      `module state.\n${detail}`
  );
}

// ---- Content vs. token ---------------------------------------------------------
/** @type {Record<string, { v: string, sha256: string }>} */
const lock = existsSync(LOCK_FILE) ? JSON.parse(readFileSync(LOCK_FILE, "utf8")) : {};
/** @type {Record<string, { v: string, sha256: string }>} */
const current = {};

for (const [abs, byToken] of tokensByPath) {
  if (byToken.size !== 1) continue; // already reported above
  const [token] = byToken.keys();
  const file = join(WEB_ROOT, abs);
  if (!existsSync(file)) {
    errors.push(`${abs} is referenced (v=${token}) but does not exist on disk.`);
    continue;
  }
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  current[abs] = { v: token, sha256 };
  const deployed = lock[abs];
  if (deployed && deployed.sha256 !== sha256 && deployed.v === token) {
    errors.push(
      `${abs} has changed since the last deploy but is still referenced at v=${token}. ` +
        `It is cached immutable, so returning visitors would never receive the change. ` +
        `Bump its ?v= token everywhere it is referenced.`
    );
  }
}

if (RECORD) {
  if (errors.length > 0) {
    console.error("Refusing to record asset versions while the check is failing.");
  } else {
    const sorted = Object.fromEntries(Object.keys(current).sort().map((key) => [key, current[key]]));
    writeFileSync(LOCK_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`Recorded ${Object.keys(sorted).length} deployed asset versions in asset-versions.lock.json.`);
  }
}

if (errors.length > 0) {
  console.error(`\nAsset version check failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n`);
  for (const e of errors) console.error(`  • ${e}\n`);
  process.exit(1);
}

console.log(`Asset version check passed — ${tokensByPath.size} immutable files, all consistently versioned.`);
