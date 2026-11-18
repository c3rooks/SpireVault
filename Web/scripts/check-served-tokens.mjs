#!/usr/bin/env node
/**
 * The other half of the immutable-cache contract, for tokens that have been
 * committed but not deployed.
 *
 * script.js, the stylesheets, run-coach.js and everything under /lib/* are
 * served `max-age=31536000, immutable`, locally too (wrangler pages dev and
 * dev-static apply Web/_headers). check-asset-versions.mjs guards the tokens
 * that went live; this guards the ones that went into a commit. Once a
 * commit references `stage.js?v=2`, anyone who ran that commit (the owner
 * testing locally, another session's browser) holds that file for a year.
 * If the file then changes and the token does not, they never see the
 * change: on 2026-11-16 the header's torches kept their old layout for the
 * owner after three fixes landed under the same token.
 *
 * For every cache-forever file referenced from index.html, auth.html,
 * script.js or /lib/*, this finds the first commit on the branch (since it
 * left main) that referenced its current token, and fails when the file now
 * differs from that commit's copy. Tokens never committed are left alone.
 * Skipped outside a git checkout (a deploy staging copy).
 *
 * Run: node Web/scripts/check-served-tokens.mjs   (part of `make preflight`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(WEB, "..");
const IMMUTABLE = /^Web\/(script\.js|styles(\.next|\.mobile)?\.css|run-coach\.js|lib\/.+\.(js|css))$/;
const REFERENCE = /["'(`]((?:\/|\.\/)?(?:lib\/[\w./-]+|[\w.-]+)\.(?:js|css))\?v=(\d+)\b/g;

/** @param {string[]} args */
function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** @param {string} ref @param {string} path @returns {string|null} the file at that commit */
function showAt(ref, path) {
  try { return git("show", `${ref}:${path}`); } catch { return null; }
}

let base;
try {
  base = git("merge-base", "HEAD", "main").trim();
} catch {
  console.log("✓ served-token check skipped (not a git checkout with main)");
  process.exit(0);
}

const referrers = [join(WEB, "index.html"), join(WEB, "auth.html"), join(WEB, "script.js"), ...walk(join(WEB, "lib")).filter((p) => /\.(js|css)$/.test(p))];
/** @type {Map<string, { token: string, referrer: string, written: string }>} */
const current = new Map();
for (const file of referrers) {
  for (const match of readFileSync(file, "utf8").matchAll(REFERENCE)) {
    const written = match[1];
    const target = written.startsWith("/") ? join(WEB, written) : written.startsWith("./") ? join(dirname(file), written) : join(WEB, written);
    const rel = relative(ROOT, target);
    if (IMMUTABLE.test(rel) && existsSync(target)) current.set(rel, { token: match[2], referrer: relative(ROOT, file), written });
  }
}

const problems = [];
for (const [rel, { token, referrer, written }] of current) {
  const needle = `${written}?v=${token}`;
  const commits = git("log", "--reverse", "--format=%h", `${base}..HEAD`, "--", referrer).trim().split("\n").filter(Boolean);
  const first = [base, ...commits].find((commit) => showAt(commit, referrer)?.includes(needle));
  if (!first) continue;
  const then = showAt(first, rel);
  if (then !== null && then !== readFileSync(join(ROOT, rel), "utf8")) {
    problems.push(`${rel} changed since ?v=${token} was committed (${first}): bump the token where ${referrer} references it, and anything that references ${referrer} in turn.`);
  }
}

if (problems.length) {
  console.error(`Served-token check failed (${problems.length}):\n\n${problems.map((p) => `  • ${p}`).join("\n")}\n`);
  process.exit(1);
}
console.log(`✓ served tokens fresh (${current.size} cache-forever files)`);
