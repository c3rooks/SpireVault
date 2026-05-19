// coop-sandbox.js — local-only Co-op Lobby Beta test harness UI.
// Never loaded or shown on production hostnames.

const LS_SANDBOX = "spirevault.dev.coopSandbox";
const LS_PERSONA = "spirevault.dev.activePersona";
const LS_SCENARIO = "spirevault.dev.seedScenario";
/** Must match `STORAGE_SESSION` in script.js */
const LS_VAULT_SESSION = "vault.web.session";

const PROD_HOSTS = new Set([
  "spirevault.app",
  "app.spirevault.app",
  "www.spirevault.app",
]);

const SCENARIOS = [
  { id: "A", label: "A — Empty" },
  { id: "B", label: "B — Open lobbies" },
  { id: "C", label: "C — You hosting" },
  { id: "D", label: "D — Pending request" },
  { id: "E", label: "E — Accepted party" },
  { id: "F", label: "F — Full lobby" },
  { id: "G", label: "G — In run" },
];

let panelMounted = false;
let bootCtx = null;
let sandboxCounts = null;

export function isLocalCoopDevHost() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (PROD_HOSTS.has(host)) return false;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  // wrangler pages dev (http://127.0.0.1:8788)
  const port = window.location.port;
  if (
    window.location.protocol === "http:" &&
    (port === "8788" || port === "8080" || port === "3000")
  ) {
    return true;
  }
  return false;
}

export function isCoopSandboxEnabled() {
  if (typeof window === "undefined") return false;
  if (isLocalCoopDevHost()) return true;
  try {
    if (localStorage.getItem(LS_SANDBOX) === "1") return true;
  } catch { /* ignore */ }
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("coopSandbox") === "1") return true;
  } catch { /* ignore */ }
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) return true;
  return false;
}

async function sandboxFetch(path, opts = {}) {
  const base = (bootCtx?.api ?? "/api").replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const init = {
    method: opts.method || "GET",
    credentials: "include",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  };
  if (opts.body != null) init.body = JSON.stringify(opts.body);
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

function envLabel() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "local";
  if (host.endsWith(".workers.dev") || host.includes("pages.dev")) return "preview";
  return "other";
}

function readLs(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeLs(key, val) {
  try {
    if (val == null) localStorage.removeItem(key);
    else localStorage.setItem(key, val);
  } catch { /* ignore */ }
}

function panelHtml(personas = []) {
  const opts = personas
    .map((p) => {
      const sel = readLs(LS_PERSONA) === p.steamId ? " selected" : "";
      return `<option value="${esc(p.steamId)}"${sel}>${esc(p.name)}</option>`;
    })
    .join("");
  const scenarioOpts = SCENARIOS.map((s) => {
    const sel = readLs(LS_SCENARIO) === s.id ? " selected" : "";
    return `<option value="${s.id}"${sel}>${esc(s.label)}</option>`;
  }).join("");

  const c = sandboxCounts || {};
  return `
    <div class="coop-sandbox-panel" id="coop-sandbox-panel" hidden>
      <header class="coop-sandbox-head">
        <strong>Dev Sandbox</strong>
        <button type="button" class="coop-sandbox-close" id="coop-sandbox-close" aria-label="Collapse">×</button>
      </header>
      <div class="coop-sandbox-body" id="coop-sandbox-body">
        <p class="coop-sandbox-row"><span>Environment</span><code>${esc(envLabel())}</code></p>
        <p class="coop-sandbox-row"><span>Origin</span><code>${esc(window.location.origin)}</code></p>
        <p class="coop-sandbox-row"><span>API base</span><code>${esc(bootCtx?.api ?? "")}</code></p>
        <p class="coop-sandbox-row"><span>Sandbox</span><code>${isCoopSandboxEnabled() ? "on" : "off"}</code></p>
        <hr class="coop-sandbox-hr" />
        <label class="coop-sandbox-label">Act as
          <select id="coop-sandbox-persona" class="coop-sandbox-select">${opts}</select>
        </label>
        <label class="coop-sandbox-label">Seed scenario
          <select id="coop-sandbox-scenario" class="coop-sandbox-select">${scenarioOpts}</select>
        </label>
        <div class="coop-sandbox-counts" id="coop-sandbox-counts">
          <p class="coop-sandbox-row"><span>Scenario</span><code>${esc(String(c.scenario ?? "—"))}</code></p>
          <p class="coop-sandbox-row"><span>Open lobbies</span><code>${esc(String(c.openLobbiesCount ?? "—"))}</code></p>
          <p class="coop-sandbox-row"><span>Sandbox lobbies</span><code>${esc(String(c.sandboxLobbiesCount ?? "—"))}</code></p>
          <p class="coop-sandbox-row"><span>Looking</span><code>${esc(String(c.playersLookingCount ?? "—"))}</code></p>
        </div>
        <div class="coop-sandbox-actions">
          <button type="button" class="btn-ghost btn-xs" id="coop-sandbox-seed">Seed scenario</button>
          <button type="button" class="btn-ghost btn-xs" id="coop-sandbox-reset">Reset sandbox</button>
          <button type="button" class="btn-primary btn-xs" id="coop-sandbox-act-as">Switch persona</button>
        </div>
      </div>
    </div>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refreshSandboxCounts() {
  try {
    sandboxCounts = await sandboxFetch("/_debug/coop-sandbox/state");
    const $counts = document.getElementById("coop-sandbox-counts");
    if ($counts && sandboxCounts) {
      const c = sandboxCounts;
      $counts.innerHTML = `
        <p class="coop-sandbox-row"><span>Scenario</span><code>${esc(String(c.scenario ?? "—"))}</code></p>
        <p class="coop-sandbox-row"><span>Open lobbies</span><code>${esc(String(c.openLobbiesCount ?? "—"))}</code></p>
        <p class="coop-sandbox-row"><span>Sandbox lobbies</span><code>${esc(String(c.sandboxLobbiesCount ?? "—"))}</code></p>
        <p class="coop-sandbox-row"><span>Looking</span><code>${esc(String(c.playersLookingCount ?? "—"))}</code></p>`;
    }
  } catch {
    sandboxCounts = null;
  }
}

async function actAsPersona(steamId) {
  const data = await sandboxFetch("/_debug/coop-sandbox/act-as", {
    method: "POST",
    body: { steamId },
  });
  writeLs(LS_PERSONA, data.steamID);
  writeLs(LS_SANDBOX, "1");
  if (data.token) {
    const sess = {
      steamID: data.steamID,
      personaName: data.personaName || data.steamID,
      avatarURL: data.avatarURL || undefined,
      sessionToken: data.token,
      signedInAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(LS_VAULT_SESSION, JSON.stringify(sess));
    } catch { /* ignore */ }
    document.cookie = `vault_session=${encodeURIComponent(data.token)}; Path=/; SameSite=Lax`;
  }
  bootCtx?.deps?.toast?.(`Acting as ${data.personaName || data.steamID}`);
  window.location.reload();
}

async function seedScenario() {
  const scenario = document.getElementById("coop-sandbox-scenario")?.value || "A";
  const hostSteamId = document.getElementById("coop-sandbox-persona")?.value;
  writeLs(LS_SCENARIO, scenario);
  writeLs(LS_SANDBOX, "1");
  await sandboxFetch("/_debug/coop-sandbox/seed", {
    method: "POST",
    body: { scenario, hostSteamId },
  });
  bootCtx?.deps?.toast?.(`Seeded scenario ${scenario}`);
  await refreshSandboxCounts();
  bootCtx?.onReseed?.();
}

async function resetSandbox() {
  await sandboxFetch("/_debug/coop-sandbox/reset", { method: "POST" });
  writeLs(LS_SCENARIO, null);
  writeLs(LS_PERSONA, null);
  try {
    localStorage.removeItem(LS_VAULT_SESSION);
    localStorage.removeItem("vault_session");
  } catch { /* ignore */ }
  document.cookie = "vault_session=; Path=/; Max-Age=0";
  bootCtx?.deps?.toast?.("Sandbox reset");
  await refreshSandboxCounts();
  window.location.reload();
}

function wirePanel() {
  document.getElementById("coop-sandbox-toggle")?.addEventListener("click", () => {
    const $p = document.getElementById("coop-sandbox-panel");
    if ($p) $p.hidden = !$p.hidden;
  });
  document.getElementById("coop-sandbox-close")?.addEventListener("click", () => {
    const $p = document.getElementById("coop-sandbox-panel");
    if ($p) $p.hidden = true;
  });
  document.getElementById("coop-sandbox-act-as")?.addEventListener("click", () => {
    const sid = document.getElementById("coop-sandbox-persona")?.value;
    if (sid) void actAsPersona(sid).catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.getElementById("coop-sandbox-seed")?.addEventListener("click", () => {
    void seedScenario().catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.getElementById("coop-sandbox-reset")?.addEventListener("click", () => {
    void resetSandbox().catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
}

/** Open the floating panel (mounts first if needed). */
export function openCoopSandboxPanel(ctx) {
  ensureCoopSandboxMounted(ctx);
  const $p = document.getElementById("coop-sandbox-panel");
  if ($p) $p.hidden = false;
  document.getElementById("coop-sandbox-toggle")?.scrollIntoView({ block: "nearest" });
}

export function ensureCoopSandboxMounted(ctx) {
  if (!isCoopSandboxEnabled()) return;
  mountCoopSandbox(ctx || bootCtx || { api: "/api", deps: {} });
}

export function mountCoopSandbox(ctx) {
  if (!isCoopSandboxEnabled()) return;
  bootCtx = ctx || bootCtx || { api: "/api", deps: {} };
  if (panelMounted) {
    void refreshSandboxCounts();
    return;
  }
  panelMounted = true;
  writeLs(LS_SANDBOX, "1");

  const wrap = document.createElement("div");
  wrap.className = "coop-sandbox-wrap";
  wrap.innerHTML = `
    <button type="button" class="coop-sandbox-toggle" id="coop-sandbox-toggle">Dev Sandbox</button>
    ${panelHtml()}`;
  document.body.appendChild(wrap);

  void sandboxFetch("/_debug/coop-sandbox/state")
    .then((data) => {
      sandboxCounts = data;
      const personas = data.personas || [];
      const $panel = document.getElementById("coop-sandbox-panel");
      if ($panel) {
        $panel.outerHTML = panelHtml(personas);
      }
      wirePanel();
      void refreshSandboxCounts();
    })
    .catch(() => {
      wirePanel();
    });
}

export function refreshSandboxFromState(state) {
  if (!isCoopSandboxEnabled() || !state) return;
  const $counts = document.getElementById("coop-sandbox-counts");
  if (!$counts) return;
  const lobbies = state.openLobbies || [];
  const myLobby = state.lobby;
  const mySid = state.presence?.steamId;
  const hosted =
    myLobby && myLobby.hostSteamId === mySid && myLobby.status !== "closed";
  const visible = lobbiesForBoard(state).length;
  $counts.innerHTML = `
    <p class="coop-sandbox-row"><span>Scenario</span><code>${esc(readLs(LS_SCENARIO) || "—")}</code></p>
    <p class="coop-sandbox-row"><span>Visible board</span><code>${visible}</code></p>
    <p class="coop-sandbox-row"><span>Hosted (you)</span><code>${hosted ? "yes" : "no"}</code></p>
    <p class="coop-sandbox-row"><span>Pending reqs</span><code>${(state.incomingJoinRequests || []).length}</code></p>`;
}

/** Mirrors coop-lobbies board merge for debug counts. */
export function lobbiesForBoard(state) {
  const open = (state.openLobbies || []).filter(
    (l) => l.status === "open" || l.status === "full",
  );
  const myLobby = state.lobby;
  const mySid = state.presence?.steamId;
  if (
    myLobby &&
    myLobby.hostSteamId === mySid &&
    myLobby.status !== "closed" &&
    myLobby.status !== "expired" &&
    !open.some((l) => l.lobbyId === myLobby.lobbyId)
  ) {
    return [myLobby, ...open];
  }
  return open;
}

export const COOP_SANDBOX_LS_KEYS = [LS_SANDBOX, LS_PERSONA, LS_SCENARIO];
