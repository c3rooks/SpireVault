import type { Env, PresenceEntry } from "./types";

/**
 * Operator-only admin surface. Two endpoints:
 *
 *   GET /admin         → tiny single-file HTML dashboard
 *   GET /admin/stats   → JSON metrics powering the dashboard
 *
 * Both are bearer-gated against `env.ADMIN_TOKEN`. Anyone hitting the
 * surface without the right token (or with no token at all) gets back the
 * exact same JSON 404 the Worker uses for any other unknown route. We do
 * NOT 401: that would advertise the existence of a protected surface.
 *
 * Security posture:
 *  - The token is set via `wrangler secret put ADMIN_TOKEN` — it never
 *    appears in wrangler.toml, the GitHub repo, or any public deploy.
 *  - The HTML dashboard prompts in-page for the same token and stores it in
 *    `sessionStorage` so an operator can refresh without re-typing. Closing
 *    the tab drops it.
 *  - Stats only ever contain aggregates + the operator's own users' Steam
 *    persona names (which they typed publicly). No raw IPs, no auth
 *    cookies, nothing PII.
 *
 * KV layout this surface relies on:
 *
 *   presence:<steamID>          short-TTL presence row (existing)
 *   session:<token>             bearer→steamID (existing)
 *   session-profile:<steamID>   persona+avatar at OpenID time (existing)
 *
 *   user:<steamID>              first-ever-seen marker, no TTL.
 *                               Written once per unique user, ever.
 *   user-meta:<steamID>         {personaName, firstSeen, lastSeen} JSON,
 *                               touched on every successful sign-in.
 *   seen:<YYYYMMDD>:<steamID>   per-user-per-day flag, TTL ~10 days.
 *                               Lets us count DAU without a separate
 *                               analytics service.
 *   signin:<ISO>:<steamID>      sign-in event, TTL 30 days. Powers the
 *                               "recent sign-ins" list.
 */

const ADMIN_PATHS = new Set(["/admin", "/admin/stats"]);

/** Returns true iff this request looks like it's targeting the admin surface. */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.has(pathname);
}

/**
 * 404 with the same JSON shape index.ts already emits for unknown routes,
 * so admin paths are byte-indistinguishable from any other miss.
 */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function tokenIsValid(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  // Accept the token in two places so the dashboard can fetch it from JS
  // (Authorization header) or paste it into a URL once for ad-hoc curling.
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return constantTimeEq(m[1]!, env.ADMIN_TOKEN);
  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  return q ? constantTimeEq(q, env.ADMIN_TOKEN) : false;
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Top-level entry.
 *
 *  /admin       → always returns the gate HTML. The page is content-free
 *                 (just a token prompt) so this doesn't reveal anything an
 *                 attacker couldn't already see in the public source.
 *                 The HTML carries no real metrics; those only come from
 *                 the gated /admin/stats endpoint.
 *
 *  /admin/stats → 404 to anyone without the right bearer token, byte-
 *                 indistinguishable from any other unknown route.
 *                 This is the actual data gate.
 */
export async function handleAdmin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/admin") return adminHTML();
  if (url.pathname === "/admin/stats") {
    if (!tokenIsValid(req, env)) return notFound();
    return adminStats(env);
  }
  return notFound();
}

// MARK: - Stats aggregation --------------------------------------------------

interface AdminStats {
  generatedAt: string;
  online: {
    count: number;
    inSTS2: number;
    entries: Array<{
      steamID: string;
      personaName: string;
      status: string;
      note: string;
      inSTS2: boolean;
      updatedAt: string;
    }>;
  };
  totals: {
    everSignedIn: number;
    activeLast24h: number;
    activeLast7d: number;
    sessionsActive: number;
  };
  daily: Array<{ date: string; activeUsers: number }>;
  recentSignIns: Array<{
    when: string;
    steamID: string;
    personaName: string;
  }>;
}

async function adminStats(env: Env): Promise<Response> {
  const now = new Date();

  // ---- online presence ----
  // Single-roster read; presence layout switched to `presence:roster` JSON to
  // stop the per-poll list() bleed on the public endpoint.
  const onlineEntries: PresenceEntry[] = [];
  {
    const raw = await env.LOBBIES.get("presence:roster");
    if (raw) {
      try {
        const r = JSON.parse(raw) as { entries?: PresenceEntry[] };
        if (Array.isArray(r.entries)) onlineEntries.push(...r.entries);
      } catch {}
    }
  }

  // ---- ever-signed-in count (count keys) ----
  let everSignedIn = 0;
  {
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({ prefix: "user:", cursor, limit: 1000 });
      everSignedIn += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  // ---- daily-active over the last 7 days, plus 24h subset ----
  const days: Array<{ date: string; activeUsers: number }> = [];
  let activeLast24h = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const tag = ymd(d);
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({
        prefix: `seen:${tag}:`,
        cursor,
        limit: 1000,
      });
      count += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    days.push({ date: tag, activeUsers: count });
    if (i === 0) activeLast24h = count;
  }
  const activeLast7d = days.reduce((acc, d) => acc + d.activeUsers, 0);

  // ---- recent sign-ins (last 30) ----
  const signIns: AdminStats["recentSignIns"] = [];
  {
    let cursor: string | undefined;
    const all: Array<{ when: string; steamID: string }> = [];
    do {
      const page = await env.LOBBIES.list({ prefix: "signin:", cursor, limit: 1000 });
      for (const k of page.keys) {
        // key form: signin:<ISO>:<steamID>
        const rest = k.name.slice("signin:".length);
        const splitAt = rest.lastIndexOf(":");
        if (splitAt < 0) continue;
        all.push({ when: rest.slice(0, splitAt), steamID: rest.slice(splitAt + 1) });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    all.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
    const top = all.slice(0, 30);
    for (const e of top) {
      const meta = await env.LOBBIES.get(`user-meta:${e.steamID}`);
      let persona = "Steam User";
      if (meta) {
        try {
          const m = JSON.parse(meta);
          if (m?.personaName) persona = m.personaName;
        } catch {}
      }
      signIns.push({ when: e.when, steamID: e.steamID, personaName: persona });
    }
  }

  // ---- active sessions ----
  let sessionsActive = 0;
  {
    let cursor: string | undefined;
    do {
      const page = await env.LOBBIES.list({ prefix: "session:", cursor, limit: 1000 });
      sessionsActive += page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  const stats: AdminStats = {
    generatedAt: now.toISOString(),
    online: {
      count: onlineEntries.length,
      inSTS2: onlineEntries.filter((e) => e.inSTS2).length,
      entries: onlineEntries
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((e) => ({
          steamID: e.steamID,
          personaName: e.personaName,
          status: e.status,
          note: e.note,
          inSTS2: e.inSTS2,
          updatedAt: e.updatedAt,
        })),
    },
    totals: { everSignedIn, activeLast24h, activeLast7d, sessionsActive },
    daily: days.reverse(),
    recentSignIns: signIns,
  };

  return new Response(JSON.stringify(stats), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// MARK: - User-tracking writes -----------------------------------------------

/**
 * Called once on every successful Steam OpenID callback. Side effects:
 *  - Marks the user as ever-seen (idempotent).
 *  - Updates user-meta with the latest persona/avatar + lastSeen.
 *  - Records a sign-in event for the recent-sign-ins list (TTL 30 days).
 *  - Marks today's "seen" key (TTL 10 days) so DAU counts pick it up.
 */
export async function recordSignIn(
  env: Env,
  steamID: string,
  personaName: string,
  avatarURL: string | undefined
): Promise<void> {
  const now = new Date();
  const nowISO = now.toISOString();
  const day = ymd(now);

  // ever-seen marker, no TTL
  await env.LOBBIES.put(`user:${steamID}`, "1");

  // metadata: read-modify-write so firstSeen survives later sign-ins
  let firstSeen = nowISO;
  try {
    const existing = await env.LOBBIES.get(`user-meta:${steamID}`);
    if (existing) {
      const prev = JSON.parse(existing);
      if (typeof prev?.firstSeen === "string") firstSeen = prev.firstSeen;
    }
  } catch {}

  await env.LOBBIES.put(
    `user-meta:${steamID}`,
    JSON.stringify({ personaName, avatarURL, firstSeen, lastSeen: nowISO })
  );

  // recent-sign-ins event (TTL 30d, keyed for natural sort order)
  await env.LOBBIES.put(`signin:${nowISO}:${steamID}`, "1", {
    expirationTtl: 30 * 86_400,
  });

  // today's DAU marker (TTL 10d so 7-day-back lookback is safe)
  await env.LOBBIES.put(`seen:${day}:${steamID}`, "1", {
    expirationTtl: 10 * 86_400,
  });
}

/**
 * Called on every successful presence heartbeat. Touches the daily-seen marker
 * so DAU stays accurate even for users who came online once today and never
 * re-authed.
 *
 * IMPORTANT: this runs on **every** heartbeat. We read first and only write
 * if the marker isn't already set today. Reads are abundant (100k/day on free
 * tier); writes are scarce (1k/day). One write per user per day, max — instead
 * of one write per heartbeat per user.
 */
export async function recordHeartbeat(env: Env, steamID: string): Promise<void> {
  const day = ymd(new Date());
  const key = `seen:${day}:${steamID}`;
  const existing = await env.LOBBIES.get(key);
  if (existing) return; // already marked today — save the write
  // KV is eventually consistent; setting the same value keeps the TTL fresh.
  await env.LOBBIES.put(`seen:${day}:${steamID}`, "1", {
    expirationTtl: 10 * 86_400,
  });
}

// MARK: - Dashboard HTML -----------------------------------------------------

function adminHTML(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Vault · ops</title>
<style>
  :root {
    --bg:#0c0a14; --bg2:#06040a; --card:#14111e; --card2:#1a1626;
    --bd:#28233a; --gold:#d4af37; --ember:#ff6b1a; --emberHi:#ffa05c;
    --text:#f4eddc; --t2:#b6abc4; --t3:#6c647a; --win:#6dd97c; --loss:#ff5f6d;
  }
  * { box-sizing: border-box; }
  html,body { background: var(--bg); color: var(--text); margin:0; padding:0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  a { color: var(--emberHi); }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 32px 28px 64px; }
  header { display:flex; align-items:center; gap:14px; padding-bottom:22px;
    border-bottom: 1px solid var(--bd); margin-bottom: 28px; }
  header h1 { margin:0; font-size: 18px; letter-spacing:1px; color: var(--gold); }
  header .live { color: var(--win); font-size:12px; }
  header .stamp { color: var(--t3); font-size:12px; margin-left:auto; }
  .grid { display:grid; gap:16px; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); }
  .card { background: var(--card); border:1px solid var(--bd); border-radius: 14px;
    padding: 18px 20px; }
  .card h3 { margin:0 0 6px; font-size: 11px; color: var(--t3); letter-spacing:2px;
    font-weight:700; text-transform:uppercase; }
  .card .v { font-size: 36px; font-weight: 800; letter-spacing:-0.02em; color: var(--text); }
  .card .v.gold { color: var(--gold); }
  .card .v.ember { background:linear-gradient(120deg, var(--emberHi), var(--gold));
    -webkit-background-clip:text; -webkit-text-fill-color: transparent; }
  .card .sub { font-size:11px; color: var(--t3); margin-top: 6px; }
  section { margin-top: 32px; }
  section h2 { margin: 0 0 12px; font-size: 12px; color: var(--gold);
    letter-spacing:2px; text-transform:uppercase; font-weight:800; }
  table { width:100%; border-collapse: collapse; background: var(--card);
    border:1px solid var(--bd); border-radius: 14px; overflow:hidden; }
  th, td { text-align:left; padding: 10px 14px; border-bottom: 1px solid var(--bd);
    font-size: 13px; }
  th { background: var(--card2); font-size:10px; color:var(--t3);
    text-transform:uppercase; letter-spacing:1.5px; }
  tr:last-child td { border-bottom: 0; }
  td.muted { color: var(--t3); font-size:12px; }
  .pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size:10px;
    font-weight:700; letter-spacing:1px; text-transform:uppercase; border:1px solid; }
  .pill.looking { color: var(--win); border-color: rgba(109,217,124,0.4); background: rgba(109,217,124,0.1); }
  .pill.inRun  { color: var(--ember); border-color: rgba(255,107,26,0.4); background: rgba(255,107,26,0.1); }
  .pill.inCoop { color: var(--gold); border-color: rgba(212,175,55,0.4); background: rgba(212,175,55,0.1); }
  .pill.afk    { color: var(--t3); border-color: var(--bd); }
  .spark { display:flex; gap:6px; align-items:flex-end; height:60px; padding:6px 0; }
  .spark .bar { flex:1; min-width:8px; background:linear-gradient(180deg, var(--ember), var(--gold));
    border-radius: 3px 3px 0 0; opacity:0.85; position:relative; }
  .spark .bar:hover { opacity:1; }
  .spark .bar .n { position:absolute; top:-18px; left:50%; transform:translateX(-50%);
    font-size:10px; color: var(--t3); }
  .spark .lbl { font-size:9px; color:var(--t3); text-align:center; letter-spacing:1px; }
  .gate { max-width: 380px; margin: 80px auto; padding: 28px;
    background: var(--card); border:1px solid var(--bd); border-radius:14px; }
  .gate h2 { margin: 0 0 6px; font-size:16px; color: var(--gold); letter-spacing:1px; }
  .gate p { margin: 0 0 16px; color: var(--t3); font-size:13px; }
  .gate input { width:100%; padding: 12px 14px; background: var(--bg2); color: var(--text);
    border:1px solid var(--bd); border-radius: 8px; font-family: inherit; font-size:14px; }
  .gate button { width:100%; margin-top: 12px; padding: 12px; border:0; border-radius:8px;
    background: linear-gradient(120deg, var(--ember), var(--gold)); color:#1a1626;
    font-weight:800; font-size:13px; letter-spacing:1px; cursor:pointer; }
  .err { color: var(--loss); font-size: 12px; margin-top: 8px; min-height: 1em; }
</style>
</head>
<body>
<div id="root"></div>
<script>
(() => {
  const STORAGE_KEY = "vault.admin.t";
  const root = document.getElementById("root");

  function gate(prefill) {
    root.innerHTML = \`
      <div class="gate">
        <h2>Vault · ops</h2>
        <p>Bearer token, please.</p>
        <input id="t" type="password" autocomplete="off" placeholder="token" value="\${prefill||""}" />
        <button id="go">Enter</button>
        <div class="err" id="e"></div>
      </div>\`;
    document.getElementById("t").focus();
    document.getElementById("go").onclick = tryEnter;
    document.getElementById("t").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") tryEnter();
    });
  }

  async function tryEnter() {
    const t = document.getElementById("t").value.trim();
    if (!t) return;
    const ok = await fetchStats(t).catch(() => null);
    if (!ok) {
      document.getElementById("e").textContent = "rejected.";
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, t);
    render(ok);
  }

  async function fetchStats(token) {
    const r = await fetch("/admin/stats", {
      headers: { authorization: "Bearer " + token },
    });
    if (!r.ok) return null;
    return r.json();
  }

  function pill(status) {
    const s = (status || "").toLowerCase();
    const cls = ["looking","inrun","incoop","afk"].includes(s) ? s : "afk";
    return \`<span class="pill \${status}">\${status}</span>\`;
  }

  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return Math.floor(ms / 1000) + "s ago";
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + "m ago";
    if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + "h ago";
    return Math.floor(ms / 86_400_000) + "d ago";
  }

  function fmtDay(yyyymmdd) {
    return yyyymmdd.slice(0,4) + "-" + yyyymmdd.slice(4,6) + "-" + yyyymmdd.slice(6,8);
  }

  function render(s) {
    const max = Math.max(1, ...s.daily.map(d => d.activeUsers));
    const sparkBars = s.daily.map(d => {
      const h = Math.max(2, Math.round(d.activeUsers / max * 56));
      return \`<div style="flex:1;min-width:0">
        <div class="bar" style="height:\${h}px"><span class="n">\${d.activeUsers}</span></div>
        <div class="lbl">\${d.date.slice(6,8)}</div>
      </div>\`;
    }).join("");

    const onlineRows = s.online.entries.length === 0
      ? \`<tr><td colspan="5" class="muted">no one online right now.</td></tr>\`
      : s.online.entries.map(e => \`
        <tr>
          <td>\${escape(e.personaName)}</td>
          <td>\${pill(e.status)}\${e.inSTS2 ? \` <span class="pill inRun">in STS2</span>\` : ""}</td>
          <td class="muted">\${escape(e.note || "—")}</td>
          <td class="muted">\${timeAgo(e.updatedAt)}</td>
          <td class="muted"><a href="https://steamcommunity.com/profiles/\${e.steamID}" target="_blank" rel="noopener">profile</a></td>
        </tr>\`).join("");

    const signinRows = s.recentSignIns.length === 0
      ? \`<tr><td colspan="3" class="muted">no recent sign-ins.</td></tr>\`
      : s.recentSignIns.map(e => \`
        <tr>
          <td>\${escape(e.personaName)}</td>
          <td class="muted">\${timeAgo(e.when)}</td>
          <td class="muted"><a href="https://steamcommunity.com/profiles/\${e.steamID}" target="_blank" rel="noopener">\${e.steamID}</a></td>
        </tr>\`).join("");

    root.innerHTML = \`
      <div class="wrap">
        <header>
          <h1>Vault · ops</h1>
          <span class="live">● live</span>
          <span class="stamp">refreshed \${new Date(s.generatedAt).toLocaleTimeString()}</span>
        </header>

        <div class="grid">
          <div class="card"><h3>Online now</h3>
            <div class="v ember">\${s.online.count}</div>
            <div class="sub">\${s.online.inSTS2} of them in STS2 right now</div>
          </div>
          <div class="card"><h3>Active sessions</h3>
            <div class="v">\${s.totals.sessionsActive}</div>
            <div class="sub">unexpired bearer tokens</div>
          </div>
          <div class="card"><h3>Active · 24h</h3>
            <div class="v">\${s.totals.activeLast24h}</div>
            <div class="sub">unique users seen today</div>
          </div>
          <div class="card"><h3>Active · 7d</h3>
            <div class="v">\${s.totals.activeLast7d}</div>
            <div class="sub">cumulative across the week</div>
          </div>
          <div class="card"><h3>Total Vault users</h3>
            <div class="v gold">\${s.totals.everSignedIn}</div>
            <div class="sub">unique Steam IDs ever signed in</div>
          </div>
        </div>

        <section>
          <h2>Last 7 days</h2>
          <div class="card">
            <div class="spark">\${sparkBars}</div>
          </div>
        </section>

        <section>
          <h2>Online right now</h2>
          <table>
            <thead><tr>
              <th>persona</th><th>status</th><th>note</th><th>last heartbeat</th><th>steam</th>
            </tr></thead>
            <tbody>\${onlineRows}</tbody>
          </table>
        </section>

        <section>
          <h2>Recent sign-ins</h2>
          <table>
            <thead><tr><th>persona</th><th>when</th><th>steam id</th></tr></thead>
            <tbody>\${signinRows}</tbody>
          </table>
        </section>
      </div>\`;
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"
    }[c]));
  }

  async function boot() {
    const cached = sessionStorage.getItem(STORAGE_KEY);
    if (cached) {
      const s = await fetchStats(cached).catch(() => null);
      if (s) {
        render(s);
        // auto-refresh every 30s while the tab is open
        setInterval(async () => {
          const t = sessionStorage.getItem(STORAGE_KEY);
          if (!t) return;
          const ns = await fetchStats(t).catch(() => null);
          if (ns) render(ns);
        }, 30_000);
        return;
      }
      sessionStorage.removeItem(STORAGE_KEY);
    }
    gate("");
  }

  boot();
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });
}
