// Shared client utilities for Showtime / Race / Tournaments / Coach /
// Companion mod pages. Kept tiny on purpose — these pages must boot fast
// without waiting on the SPA bundle.

export const SHOWTIME_VERSION = "v1-2026-05-26";

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pull the trailing path segment for a route like /watch/foo. */
export function lastPathSegment() {
  const p = (location.pathname || "").replace(/\/+$/, "");
  const parts = p.split("/");
  return parts[parts.length - 1] || "";
}

/** Pull all path segments after the route prefix. */
export function pathAfter(prefix) {
  const p = (location.pathname || "").replace(/\/+$/, "");
  if (!p.startsWith(prefix)) return "";
  return p.slice(prefix.length).replace(/^\/+/, "");
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + String(s).padStart(2, "0");
}

export function fmtRel(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const delta = Math.floor((Date.now() - t) / 1000);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  // Stay relative beyond a day instead of falling back to an absolute
  // toLocaleDateString() like "5/9/2026", which reads as stale on the
  // "Most recent" hero metric (D07).
  const days = Math.floor(delta / 86400);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Tiny fetch wrapper that always returns parsed JSON or null on failure. */
export async function api(path, opts = {}) {
  // Pages function proxy strips /api and forwards to the worker. So
  // /api/coop/foo -> worker /coop/foo. We always go through /api/* so
  // cookie auth works (see Web/functions/api/[[path]].js).
  const url = path.startsWith("/api/") ? path : "/api" + (path.startsWith("/") ? path : "/" + path);
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  const r = await fetch(url, { ...opts, headers, credentials: "include" });
  if (!r.ok) {
    let err = null;
    try { err = await r.json(); } catch {}
    return { ok: false, status: r.status, error: err?.error ?? "http_error", message: err?.message ?? r.statusText, data: null };
  }
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: true, status: r.status, error: null, message: null, data };
}

/** Cookie-based session. Returns { steamID, personaName, avatarURL } or null. */
export async function getSession() {
  try {
    const r = await fetch("/api/_session", { credentials: "include" });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || !data.steamID) return null;
    return data;
  } catch { return null; }
}

/** Render a stat tile. */
export function statTile(label, value, opts = {}) {
  const safeLabel = esc(label);
  const safeValue = esc(value);
  const bar = opts.fillPct != null
    ? `<div class="sv-stat-bar"><span style="width:${Math.max(0, Math.min(100, opts.fillPct))}%"></span></div>`
    : "";
  const tile = document.createElement("div");
  tile.className = "sv-stat";
  tile.innerHTML = `<div class="sv-stat-label">${safeLabel}</div><div class="sv-stat-value">${safeValue}</div>${bar}`;
  return tile;
}

/** Compact deck list renderer used by spectator + overlay + coach. */
export function renderDeck(container, deck) {
  container.innerHTML = "";
  if (!deck || deck.length === 0) {
    container.innerHTML = `<div class="sv-empty">Deck not yet streamed.</div>`;
    return;
  }
  // Sort: upgraded first, then alpha.
  const sorted = [...deck].sort((a, b) => (b.upgrades - a.upgrades) || a.name.localeCompare(b.name));
  for (const c of sorted) {
    const node = document.createElement("div");
    node.className = "sv-deck-card" + (c.upgrades > 0 ? " is-upgrade" : "");
    const cost = c.cost === -1 ? "X" : c.cost;
    node.innerHTML = `<span class="sv-deck-cost">${esc(String(cost))}</span><span class="sv-deck-name">${esc(c.name)}${c.upgrades > 0 ? "+" : ""}</span>`;
    container.appendChild(node);
  }
}

/** Polls a function on an interval; returns a stop fn. Pauses when tab hidden. */
export function poll(fn, intervalMs) {
  let stopped = false;
  let inflight = false;
  async function loop() {
    if (stopped) return;
    if (document.visibilityState === "visible" && !inflight) {
      inflight = true;
      try { await fn(); } catch {}
      inflight = false;
    }
    if (!stopped) setTimeout(loop, intervalMs);
  }
  loop();
  return () => { stopped = true; };
}

/** Emit a non-blocking GA event when gtag is around. */
export function track(name, params = {}) {
  try {
    if (typeof window.gtag === "function") window.gtag("event", name, params);
  } catch {}
}
