#!/usr/bin/env node
/**
 * Dependency-free static dev server for Web/.
 *
 * `make dev` (wrangler pages dev) is still the full-fidelity option — it runs
 * the Pages Functions under /api. This server exists for the cases where that
 * is overkill or unavailable: UI work, screenshot tests, offline. It mirrors
 * the two Cloudflare Pages behaviours the frontend actually depends on:
 *
 *   - `_headers`   → response headers, including the production CSP, so a
 *                    font or script that would be blocked in production is
 *                    blocked here too.
 *   - `_redirects` → 200 rewrites (`/overlay → /index.html`).
 *
 * Cache-Control is forced to `no-store` so edits show up on reload; the
 * immutable caching contract is checked separately by check-asset-versions.
 *
 * Run: node Web/scripts/dev-static.mjs [port]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** Parses Cloudflare Pages `_headers` into [{ pattern, headers }]. */
function parseHeadersFile(path) {
  if (!existsSync(path)) return [];
  const rules = [];
  let current = null;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const idx = raw.indexOf(":");
    if (current && idx > 0) {
      current.headers.push([raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()]);
    }
  }
  return rules;
}

/** Parses `_redirects` and keeps only 200 rewrites, which is all Web/ uses. */
function parseRedirectsFile(path) {
  if (!existsSync(path)) return new Map();
  const rewrites = new Map();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const [from, to, status] = raw.trim().split(/\s+/);
    if (from && to && status === "200" && !from.startsWith("#")) rewrites.set(from, to);
  }
  return rewrites;
}

function patternMatches(pattern, pathname) {
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

const headerRules = parseHeadersFile(join(WEB_ROOT, "_headers"));
const rewrites = parseRedirectsFile(join(WEB_ROOT, "_redirects"));

function headersFor(pathname) {
  const out = {};
  for (const rule of headerRules) {
    if (!patternMatches(rule.pattern, pathname)) continue;
    for (const [name, value] of rule.headers) out[name] = value;
  }
  // HSTS on plain-http localhost pins the browser to https and breaks dev.
  delete out["Strict-Transport-Security"];
  out["Cache-Control"] = "no-store";
  return out;
}

async function resolveFile(pathname) {
  const rewritten = rewrites.get(pathname) || pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rewritten);
  } catch {
    return null; // malformed percent-encoding
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let full = join(WEB_ROOT, safe);
  if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + sep)) return null;
  try {
    const info = await stat(full);
    if (info.isDirectory()) full = join(full, "index.html");
    await stat(full);
    return full;
  } catch {
    // Pages serves the SPA entry for unknown extension-less routes.
    return extname(safe) ? null : join(WEB_ROOT, "index.html");
  }
}

/**
 * True when macOS has evicted the file's contents to iCloud (this repo lives
 * in a synced folder). Such a file still reports its size but owns no disk
 * blocks, and reading it blocks until iCloud hands it back — seconds, or
 * forever when offline. A few of those at once use up Node's file threads and
 * freeze every other request, so they are refused instead of read.
 */
async function isOffloaded(file) {
  // The no-blocks test is specific to iCloud placeholders on macOS; elsewhere
  // a file can legitimately report zero blocks.
  if (process.platform !== "darwin") return false;
  try {
    const info = await stat(file);
    return info.size > 0 && info.blocks === 0;
  } catch {
    return false;
  }
}

const reportedOffloaded = new Set();

/** Says once per path which file was skipped, and how to get it back. */
function reportOffloaded(pathname) {
  if (reportedOffloaded.has(pathname)) return;
  reportedOffloaded.add(pathname);
  if (reportedOffloaded.size === 1) {
    process.stderr.write("dev-static: some files are offloaded to iCloud and are served as 503. `brctl download Web` brings them back.\n");
  }
  process.stderr.write(`dev-static: offloaded, not served: ${pathname}\n`);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);
  const headers = headersFor(pathname);

  if (pathname.startsWith("/api/")) {
    res.writeHead(404, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ success: false, error: "dev-static serves no Pages Functions; use `make dev` for /api" }));
    return;
  }

  const file = await resolveFile(pathname);
  if (!file) {
    res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  if (await isOffloaded(file)) {
    reportOffloaded(pathname);
    res.writeHead(503, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    res.end("This file is offloaded to iCloud and was not served (see the dev-static log).");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`dev-static: serving ${WEB_ROOT} at http://${HOST}:${PORT}\n`);
});
