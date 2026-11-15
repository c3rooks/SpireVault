#!/usr/bin/env node
/**
 * Dependency-free static dev server for Site/ (the spirevault.app landing
 * page). Same idea as Web/scripts/dev-static.mjs, for the other deploy:
 *
 *   - `_headers`   → response headers, including the production CSP, so a
 *                    font, image or style that would be blocked live is
 *                    blocked here too.
 *   - `_redirects` → 301/302 redirects and 200 rewrites.
 *   - no SPA fallback: an unknown path is a 404, as on Cloudflare Pages for
 *     a site with no 404.html... minus the index fallback, on purpose, so a
 *     wrong asset path shows up as a failure instead of a page.
 *
 * Like Pages, it does not serve its own control files (`_headers`,
 * `_redirects`) or dotfiles, and it only answers requests addressed to this
 * machine (a page on another site cannot read the folder through a DNS trick).
 *
 * Cache-Control is forced to `no-store` so edits show on reload. Files that
 * iCloud has offloaded are answered with 503 instead of being read (a read
 * blocks until iCloud hands the file back, which can be never).
 *
 * Run: node scripts/dev-site.mjs [port] [--root <dir>]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 8791;
const HOST = "127.0.0.1";

const MIME = Object.freeze({
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
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".dmg": "application/x-apple-diskimage",
});

/**
 * @param {string[]} argv
 * @returns {{ port: number, root: string }}
 */
function parseArgs(argv) {
  let port = Number(process.env.PORT || DEFAULT_PORT);
  let root = join(REPO_ROOT, "Site");
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--root") {
      root = resolve(argv[i + 1] || "");
      i += 1;
    } else if (/^\d+$/.test(token)) {
      port = Number(token);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`dev-site: not a usable port: ${port}`);
  }
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`dev-site: no index.html under ${root}`);
  }
  return { port, root };
}

/**
 * Parses Cloudflare Pages `_headers` into [{ pattern, headers }].
 * @param {string} path
 * @returns {Array<{ pattern: string, headers: Array<[string, string]> }>}
 */
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

/**
 * Parses `_redirects` into a map of path → { to, status }.
 * @param {string} path
 * @returns {Map<string, { to: string, status: number }>}
 */
function parseRedirectsFile(path) {
  const rules = new Map();
  if (!existsSync(path)) return rules;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [from, to, status] = line.split(/\s+/);
    if (from && to) rules.set(from, { to, status: Number(status) || 301 });
  }
  return rules;
}

/** Pages control files and dotfiles are never served. @param {string} pathname */
function isPrivatePath(pathname) {
  return pathname.split("/").some((part) => part.startsWith(".") || part === "_headers" || part === "_redirects");
}

/** @param {string} pattern @param {string} pathname */
function patternMatches(pattern, pathname) {
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  return pattern === pathname;
}

/**
 * True when macOS has evicted the file's contents to iCloud: it still
 * reports a size but owns no disk blocks.
 * @param {string} file
 */
async function isOffloaded(file) {
  if (process.platform !== "darwin") return false;
  try {
    const info = await stat(file);
    return info.size > 0 && info.blocks === 0;
  } catch {
    return false;
  }
}

function main() {
  const { port, root } = parseArgs(process.argv.slice(2));
  const headerRules = parseHeadersFile(join(root, "_headers"));
  const redirects = parseRedirectsFile(join(root, "_redirects"));
  const reportedOffloaded = new Set();

  /** @param {string} pathname */
  const headersFor = (pathname) => {
    const out = {};
    for (const rule of headerRules) {
      if (!patternMatches(rule.pattern, pathname)) continue;
      for (const [name, value] of rule.headers) out[name] = value;
    }
    // HSTS on plain-http localhost pins the browser to https and breaks dev.
    delete out["Strict-Transport-Security"];
    out["Cache-Control"] = "no-store";
    return out;
  };

  /** @param {string} pathname @returns {Promise<string | null>} */
  const resolveFile = async (pathname) => {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    let full = join(root, safe);
    if (full !== root && !full.startsWith(root + sep)) return null;
    try {
      const info = await stat(full);
      if (info.isDirectory()) full = join(full, "index.html");
      await stat(full);
      return full;
    } catch {
      return null;
    }
  };

  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url || "/", `http://${HOST}:${port}`);
    const headers = headersFor(pathname);
    const text = { ...headers, "Content-Type": "text/plain; charset=utf-8" };

    const host = String(req.headers.host || "");
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, text);
      res.end("dev-site only answers requests for 127.0.0.1 or localhost");
      return;
    }
    if (isPrivatePath(pathname)) {
      res.writeHead(404, text);
      res.end("Not found");
      return;
    }

    const redirect = redirects.get(pathname);
    if (redirect && redirect.status >= 300 && redirect.status < 400) {
      res.writeHead(redirect.status, { ...headers, Location: redirect.to });
      res.end();
      return;
    }

    const file = await resolveFile(redirect ? redirect.to : pathname);
    if (!file) {
      res.writeHead(404, text);
      res.end("Not found");
      return;
    }
    if (await isOffloaded(file)) {
      if (!reportedOffloaded.has(pathname)) {
        reportedOffloaded.add(pathname);
        process.stderr.write(`dev-site: offloaded to iCloud, not served: ${pathname} (brctl download brings it back)\n`);
      }
      res.writeHead(503, text);
      res.end("This file is offloaded to iCloud and was not served (see the dev-site log).");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { ...headers, "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream" });
      res.end(body);
    } catch (error) {
      res.writeHead(500, text);
      res.end(`Read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.on("error", (error) => {
    process.stderr.write(`dev-site: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    process.stdout.write(`dev-site: serving ${root} at http://${HOST}:${port}\n`);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
