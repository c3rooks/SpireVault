/**
 * /share/coop/<shareId> — Pages Function that renders an HTML share
 * card for a captured co-op run. v0.11.1.
 *
 * Spec: docs/coop-post-run-shared-report-spec.md
 *
 * Flow:
 *   1. Pull `shareId` from the path.
 *   2. Fetch `/coop/share/:shareId` from the worker (public endpoint,
 *      no auth required, 5-min server cache).
 *   3. Render a small HTML page with OG meta tags so pasted links
 *      preview correctly on Discord / X / Reddit / iMessage.
 *
 * Notes:
 *
 *   - The share card contains *no Steam IDs*. The worker already strips
 *     them; we just render display names.
 *   - We DO NOT render error details on missing/expired cards — just a
 *     friendly "this card has expired or doesn't exist" page. That way
 *     stale share links degrade nicely.
 *   - Cache headers on the response are coarser than the upstream
 *     (15 min vs 5 min) because HTML rendering is more expensive than
 *     the JSON round-trip and the card content is by definition
 *     immutable once captured.
 */

import { getWorkerOrigin } from "../../_shared/cookie.js";

const PAGE_TITLE_FALLBACK = "Co-op Run · SpireVault";
const PAGE_DESC_FALLBACK = "A shared co-op Slay the Spire 2 run from SpireVault.";

const CHARACTER_LABEL = {
  ironclad:    "Ironclad",
  silent:      "Silent",
  defect:      "Defect",
  regent:      "Regent",
  necrobinder: "Necrobinder",
};

const OUTCOME_LABEL = {
  in_game:          "Played",
  left:             "Left mid-run",
  ready:            "Ready",
  joined:           "Joined",
  character_select: "Picking character",
};

function escapeHTML(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escAttr(s) {
  return escapeHTML(s);
}

function characterLabel(slug) {
  return CHARACTER_LABEL[slug] || (slug ? slug : "Any character");
}

function outcomeLabel(status) {
  return OUTCOME_LABEL[status] || status || "Played";
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toUTCString().replace(" GMT", " UTC");
  } catch {
    return "";
  }
}

function durationLabel(startedAt, endedAt) {
  if (!startedAt || !endedAt) return "";
  const a = new Date(startedAt).getTime();
  const b = new Date(endedAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return "";
  const mins = Math.round((b - a) / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function renderNotFound(shareId) {
  const title = "Share card expired · SpireVault";
  const desc = "This co-op share card has expired or doesn't exist.";
  const safeId = escapeHTML((shareId || "").slice(0, 64));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
<meta name="description" content="${escAttr(desc)}">
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SpireVault">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escAttr(title)}">
<meta name="twitter:description" content="${escAttr(desc)}">
<link rel="icon" href="/favicon.ico">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; padding: 0; background: #0c0918; color: #e8e2ff;
               font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 560px; margin: 6vh auto; padding: 32px 24px; text-align: center; }
  h1 { font-size: 28px; margin: 0 0 12px; }
  p { font-size: 16px; color: rgba(232,226,255,0.78); line-height: 1.5; margin: 0 0 24px; }
  small { color: rgba(232,226,255,0.45); font-size: 12px; }
  a.btn { display: inline-block; padding: 12px 22px; border-radius: 12px;
          background: rgba(155,131,255,0.18); color: #e8e2ff; text-decoration: none;
          border: 1px solid rgba(155,131,255,0.55); font-weight: 700; }
  a.btn:hover { background: rgba(155,131,255,0.28); }
</style>
</head>
<body>
<main>
  <h1>This share card has expired</h1>
  <p>Co-op share cards live for 30 days after capture. The card you're looking for is gone &mdash; either it expired, or the ID doesn't exist.</p>
  <p><a class="btn" href="/?tab=coop">Open the Co-op Lobby</a></p>
  <small>Share ID: ${safeId}</small>
</main>
</body>
</html>`;
}

function renderCard(card, baseUrl) {
  const caption = card.caption ? card.caption : null;
  const members = Array.isArray(card.members) ? card.members.slice(0, 4) : [];
  const host = members.find((m) => m.role === "host") || members[0] || null;
  const others = members.filter((m) => m !== host);
  const hostLine = host
    ? `${escapeHTML(host.personaName)} (${escapeHTML(characterLabel(host.character))})`
    : "Anonymous host";
  const memberNames = others
    .map((m) => `${escapeHTML(m.personaName)} (${escapeHTML(characterLabel(m.character))})`)
    .join(", ");
  const subtitle = others.length === 0
    ? `Solo co-op session hosted by ${hostLine}`
    : others.length === 1
    ? `${hostLine} + ${memberNames}`
    : `${hostLine} + ${others.length} co-op partners`;
  const dailyBadge = card.dailyDate
    ? `<span class="daily-pill">Daily Challenge · ${escapeHTML(card.dailyDate)}</span>`
    : "";
  const startedAt = formatDate(card.startedAt);
  const endedAt = formatDate(card.endedAt);
  const duration = durationLabel(card.startedAt, card.endedAt);
  const title = caption ? caption : `Co-op run with ${hostLine}`;
  const desc = (caption ? `${caption} · ` : "") +
    (others.length === 0
      ? `Solo host: ${hostLine}.`
      : `${members.length} players. ${subtitle}.`) +
    (duration ? ` Lasted ${duration}.` : "");
  const memberRows = members.map((m) => {
    const isHost = m.role === "host";
    return `
      <li class="member ${isHost ? "member--host" : ""}">
        <div class="member-name">
          ${escapeHTML(m.personaName)}
          ${isHost ? '<span class="host-tag">Host</span>' : ""}
        </div>
        <div class="member-meta">
          <span>${escapeHTML(characterLabel(m.character))}</span>
          <span class="dot">·</span>
          <span>${escapeHTML(outcomeLabel(m.outcome))}</span>
        </div>
      </li>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)} · SpireVault</title>
<meta name="description" content="${escAttr(desc)}">

<!-- Open Graph -->
<meta property="og:title" content="${escAttr(title)}">
<meta property="og:description" content="${escAttr(desc)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="SpireVault">
<meta property="og:url" content="${escAttr(baseUrl)}">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escAttr(title)}">
<meta name="twitter:description" content="${escAttr(desc)}">
<meta name="twitter:site" content="@spirevault">

<link rel="icon" href="/favicon.ico">
<style>
  :root { color-scheme: dark; }
  html, body {
    margin: 0; padding: 0;
    background: radial-gradient(ellipse at top, #1a1230 0%, #0c0918 60%);
    min-height: 100vh;
    color: #e8e2ff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  main {
    max-width: 640px;
    margin: 5vh auto;
    padding: 28px 22px;
  }
  .header { text-align: center; margin-bottom: 22px; }
  .eyebrow {
    text-transform: uppercase; letter-spacing: 0.14em; font-size: 11px;
    color: rgba(212, 175, 55, 0.92); font-weight: 700;
  }
  h1 { font-size: 26px; line-height: 1.25; margin: 8px 0 6px; }
  .subtitle { color: rgba(232,226,255,0.72); font-size: 14px; }
  .caption {
    display: block; margin: 18px 0 4px;
    padding: 14px 16px;
    border: 1px solid rgba(155,131,255,0.35);
    background: rgba(155,131,255,0.07);
    border-radius: 12px;
    color: rgba(232,226,255,0.92); font-style: italic;
    line-height: 1.5;
  }
  .meta-row {
    display: flex; flex-wrap: wrap; gap: 10px;
    justify-content: center; align-items: center;
    color: rgba(232,226,255,0.62); font-size: 12px;
    margin: 12px 0 22px;
  }
  .meta-row .sep { opacity: 0.4; }
  .daily-pill {
    display: inline-block; padding: 4px 10px; border-radius: 999px;
    background: rgba(212,175,55,0.10);
    border: 1px solid rgba(212,175,55,0.45);
    color: #d4af37; font-weight: 700; font-size: 11px;
    letter-spacing: 0.04em;
  }
  ul.members { list-style: none; padding: 0; margin: 0; display: grid;
                grid-template-columns: 1fr 1fr; gap: 10px; }
  @media (max-width: 480px) { ul.members { grid-template-columns: 1fr; } }
  li.member {
    padding: 14px 16px;
    border-radius: 14px;
    background: rgba(232,226,255,0.04);
    border: 1px solid rgba(232,226,255,0.10);
  }
  li.member--host {
    background: rgba(212,175,55,0.07);
    border-color: rgba(212,175,55,0.35);
  }
  .member-name { font-weight: 700; font-size: 15px; display: flex;
                  align-items: center; gap: 8px; }
  .host-tag {
    font-size: 10px; font-weight: 800; letter-spacing: 0.08em;
    color: #d4af37; border: 1px solid rgba(212,175,55,0.55);
    padding: 2px 6px; border-radius: 999px; text-transform: uppercase;
  }
  .member-meta {
    color: rgba(232,226,255,0.62); font-size: 12px; margin-top: 4px;
    display: flex; gap: 6px; align-items: center;
  }
  .member-meta .dot { opacity: 0.5; }
  .cta-row {
    margin-top: 32px; text-align: center;
  }
  a.btn {
    display: inline-block; padding: 12px 22px; border-radius: 12px;
    background: rgba(155,131,255,0.18); color: #e8e2ff; text-decoration: none;
    border: 1px solid rgba(155,131,255,0.55); font-weight: 700;
  }
  a.btn:hover { background: rgba(155,131,255,0.28); }
  footer.foot {
    margin-top: 28px; text-align: center;
    color: rgba(232,226,255,0.42); font-size: 11px;
  }
  footer.foot a { color: rgba(155,131,255,0.85); text-decoration: none; }
</style>
</head>
<body>
<main>
  <header class="header">
    <div class="eyebrow">Co-op Run</div>
    <h1>${escapeHTML(title)}</h1>
    <div class="subtitle">${escapeHTML(subtitle)}</div>
  </header>

  ${caption ? `<div class="caption">${escapeHTML(caption)}</div>` : ""}

  <div class="meta-row">
    ${dailyBadge}
    ${dailyBadge && (startedAt || endedAt) ? '<span class="sep">·</span>' : ""}
    ${startedAt ? `<span>Started ${escapeHTML(startedAt)}</span>` : ""}
    ${startedAt && endedAt ? '<span class="sep">·</span>' : ""}
    ${endedAt ? `<span>Captured ${escapeHTML(endedAt)}</span>` : ""}
    ${duration ? `<span class="sep">·</span><span>${escapeHTML(duration)}</span>` : ""}
  </div>

  <ul class="members">${memberRows}</ul>

  <div class="cta-row">
    <a class="btn" href="/?tab=coop">Find your own co-op match &rarr;</a>
  </div>

  <footer class="foot">
    Captured by <a href="/">SpireVault</a>. Co-op share cards expire 30 days
    after capture.
  </footer>
</main>
</body>
</html>`;
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const url = new URL(request.url);
  // params.shareId can be array or string depending on Pages runtime;
  // mirror the api/[[path]].js normalization pattern.
  const rawId = Array.isArray(params.shareId) ? params.shareId[0] : params.shareId;
  const shareId = String(rawId || "").replace(/[^0-9A-Za-z_-]/g, "").slice(0, 64);
  if (!shareId) {
    return new Response(renderNotFound(""), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const upstream = `${getWorkerOrigin(env)}/coop/share/${encodeURIComponent(shareId)}`;
  let res;
  try {
    res = await fetch(upstream, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    return new Response(renderNotFound(shareId), {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (!res.ok) {
    return new Response(renderNotFound(shareId), {
      status: res.status === 404 ? 404 : 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return new Response(renderNotFound(shareId), {
      status: 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (!body || !body.ok || !body.card) {
    return new Response(renderNotFound(shareId), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const html = renderCard(body.card, url.toString());
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 15 min browser cache. Share cards are immutable once captured.
      "cache-control": "public, max-age=900",
    },
  });
}
