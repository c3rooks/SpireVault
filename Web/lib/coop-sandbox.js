// coop-sandbox.js — local-only Co-op Lobby Beta test harness UI.
// Never loaded or shown on production hostnames.

const LS_SANDBOX = "spirevault.dev.coopSandbox";
const LS_PERSONA = "spirevault.dev.activePersona";
const LS_SCENARIO = "spirevault.dev.seedScenario";
const LS_SHOW_SANDBOX = "spirevault.dev.showSandboxLobbies";
const LS_INCLUDE_DEMO = "spirevault.dev.includeDemoUsers";
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

/** Sandbox seed personas use `local-*` Steam IDs. */
export function isSandboxSteamId(steamId) {
  return /^local-[a-z0-9_-]+$/i.test(String(steamId || ""));
}

/** Real signed-in Steam account (17-digit id). */
export function isRealSteamUser(steamId) {
  return /^\d{17}$/.test(String(steamId || ""));
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

function readBoolLs(key, defaultVal) {
  const v = readLs(key);
  if (v === "1") return true;
  if (v === "0") return false;
  return defaultVal;
}

/** Loopback dev hosts default sandbox rows ON; production preview keeps them OFF for real Steam users. */
function loopbackSandboxDefaultsOn() {
  return isLocalCoopDevHost();
}

/** Default: ON on localhost/127.0.0.1; OFF for real Steam users on preview hosts. */
export function shouldShowSandboxLobbies(mySteamId) {
  if (!isCoopSandboxEnabled()) return true;
  const explicit = readLs(LS_SHOW_SANDBOX);
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  return loopbackSandboxDefaultsOn() || isSandboxSteamId(mySteamId);
}

export function shouldIncludeDemoUsers(mySteamId) {
  if (!isCoopSandboxEnabled()) return true;
  const explicit = readLs(LS_INCLUDE_DEMO);
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  return loopbackSandboxDefaultsOn() || isSandboxSteamId(mySteamId);
}

/** Persist loopback defaults the first time the Dev Sandbox panel opens. */
export function ensureLoopbackSandboxDefaults() {
  if (!loopbackSandboxDefaultsOn()) return;
  if (readLs(LS_SHOW_SANDBOX) == null) writeLs(LS_SHOW_SANDBOX, "1");
  if (readLs(LS_INCLUDE_DEMO) == null) writeLs(LS_INCLUDE_DEMO, "1");
}

export function setShowSandboxLobbies(on) {
  writeLs(LS_SHOW_SANDBOX, on ? "1" : "0");
}

export function setIncludeDemoUsers(on) {
  writeLs(LS_INCLUDE_DEMO, on ? "1" : "0");
}

export function filterOpenLobbiesForViewer(lobbies, mySteamId) {
  const rows = lobbies || [];
  if (!isCoopSandboxEnabled() || shouldShowSandboxLobbies(mySteamId)) {
    return rows;
  }
  return rows.filter((l) => !isSandboxSteamId(l.hostSteamId));
}

export function filterRecommendationsForViewer(recs, mySteamId) {
  const rows = recs || [];
  if (!isCoopSandboxEnabled() || shouldIncludeDemoUsers(mySteamId)) {
    return rows;
  }
  return rows.filter((r) => !isSandboxSteamId(r.steamId));
}

function hasLeftoverSandboxData(counts) {
  if (!counts) return false;
  const scenario = counts.scenario;
  if (scenario && scenario !== "" && scenario !== "—") return true;
  const sandboxLobbies = Number(counts.sandboxLobbiesCount ?? 0);
  const openLobbies = Number(counts.openLobbiesCount ?? 0);
  const registryKeys = Number(counts.registryKeys ?? 0);
  return sandboxLobbies > 0 || openLobbies > 0 || registryKeys > 0;
}

function isKvEmpty(counts) {
  if (!counts) return true;
  return !hasLeftoverSandboxData(counts);
}

function defaultScenarioId() {
  return loopbackSandboxDefaultsOn() ? "B" : "A";
}

function toggleStatusLabel(on) {
  return on ? "ON" : "OFF";
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

function panelHtml(personas = [], mySteamId = "") {
  const opts = personas
    .map((p) => {
      const sel = readLs(LS_PERSONA) === p.steamId ? " selected" : "";
      return `<option value="${esc(p.steamId)}"${sel}>${esc(p.name)}</option>`;
    })
    .join("");
  const scenarioOpts = SCENARIOS.map((s) => {
    const sel = (readLs(LS_SCENARIO) || defaultScenarioId()) === s.id ? " selected" : "";
    return `<option value="${s.id}"${sel}>${esc(s.label)}</option>`;
  }).join("");

  const c = sandboxCounts || {};
  const kvEmpty = isKvEmpty(c);
  const leftover = hasLeftoverSandboxData(c);
  const showSandbox = shouldShowSandboxLobbies(mySteamId);
  const includeDemo = shouldIncludeDemoUsers(mySteamId);
  const viewerLabel = isRealSteamUser(mySteamId)
    ? "Real Steam user"
    : isSandboxSteamId(mySteamId)
      ? "Sandbox persona"
      : "Signed out";

  return `
    <div class="coop-sandbox-panel" id="coop-sandbox-panel" hidden>
      <header class="coop-sandbox-head">
        <strong>Dev Sandbox</strong>
        <button type="button" class="coop-sandbox-close" id="coop-sandbox-close" aria-label="Collapse">×</button>
      </header>
      <div class="coop-sandbox-body" id="coop-sandbox-body">
        ${kvEmpty ? `
        <div class="coop-sandbox-empty" role="status">
          <strong>No sandbox data</strong> — click <em>Seed scenario B</em> below to load 3 demo lobbies.
        </div>` : leftover ? `
        <div class="coop-sandbox-warn" role="status">
          <strong>Sandbox data loaded</strong> — ${Number(c.openLobbiesCount ?? c.sandboxLobbiesCount ?? 0)} open lobbies in KV.
          Use <em>Reset sandbox</em> for a clean board.
        </div>` : ""}
        <p class="coop-sandbox-row"><span>Environment</span><code>${esc(envLabel())}</code></p>
        <p class="coop-sandbox-row"><span>Viewer</span><code>${esc(viewerLabel)}</code></p>
        <p class="coop-sandbox-row"><span>Origin</span><code>${esc(window.location.origin)}</code></p>
        <p class="coop-sandbox-row"><span>API base</span><code>${esc(bootCtx?.api ?? "")}</code></p>
        <p class="coop-sandbox-row"><span>Sandbox</span><code>${isCoopSandboxEnabled() ? "on" : "off"}</code></p>
        <hr class="coop-sandbox-hr" />
        <div class="coop-sandbox-toggle-status">
          <p class="coop-sandbox-row"><span>Show sandbox lobbies</span><code class="coop-sandbox-state${showSandbox ? " is-on" : " is-off"}">${toggleStatusLabel(showSandbox)}</code></p>
          <p class="coop-sandbox-row"><span>Include demo users</span><code class="coop-sandbox-state${includeDemo ? " is-on" : " is-off"}">${toggleStatusLabel(includeDemo)}</code></p>
        </div>
        <label class="coop-sandbox-check">
          <input type="checkbox" id="coop-sandbox-show-lobbies"${showSandbox ? " checked" : ""} />
          Show sandbox lobbies on board
        </label>
        <label class="coop-sandbox-check">
          <input type="checkbox" id="coop-sandbox-include-demo"${includeDemo ? " checked" : ""} />
          Include demo users in Best Matches
        </label>
        <hr class="coop-sandbox-hr" />
        <label class="coop-sandbox-label">Act as (demo only)
          <select id="coop-sandbox-persona" class="coop-sandbox-select">${opts}</select>
        </label>
        <label class="coop-sandbox-label">Seed scenario
          <select id="coop-sandbox-scenario" class="coop-sandbox-select">${scenarioOpts}</select>
        </label>
        <p class="coop-sandbox-hint">Scenarios seed only when you click a seed button — never on page load.</p>
        <div class="coop-sandbox-counts" id="coop-sandbox-counts">
          <p class="coop-sandbox-row"><span>Scenario</span><code>${esc(String(c.scenario || readLs(LS_SCENARIO) || "—"))}</code></p>
          <p class="coop-sandbox-row"><span>Open lobbies</span><code>${esc(String(c.openLobbiesCount ?? "—"))}</code></p>
          <p class="coop-sandbox-row"><span>Sandbox lobbies</span><code>${esc(String(c.sandboxLobbiesCount ?? "—"))}</code></p>
          <p class="coop-sandbox-row"><span>Looking</span><code>${esc(String(c.playersLookingCount ?? "—"))}</code></p>
        </div>
        <div class="coop-sandbox-scenarios" role="group" aria-label="Seed scenarios">
          <button type="button" class="btn-ghost btn-xs" data-sandbox-scenario="A">Empty</button>
          <button type="button" class="btn-ghost btn-xs" data-sandbox-scenario="B">Open lobbies</button>
          <button type="button" class="btn-ghost btn-xs" data-sandbox-scenario="C">You hosting</button>
          <button type="button" class="btn-ghost btn-xs" data-sandbox-scenario="D">Pending request</button>
          <button type="button" class="btn-ghost btn-xs" data-sandbox-scenario="E">Accepted party</button>
        </div>
        <div class="coop-sandbox-actions">
          <button type="button" class="btn-ghost btn-xs" id="coop-sandbox-seed">Seed selected</button>
          <button type="button" class="btn-ghost btn-xs" id="coop-sandbox-reset">Reset sandbox</button>
          <button type="button" class="btn-ghost btn-xs" id="coop-sandbox-act-as">Switch persona</button>
        </div>
        <div class="coop-sandbox-actions coop-sandbox-actions--party">
          <button type="button" class="btn-primary btn-xs" id="coop-sandbox-party-host">Open Party Room (host)</button>
          <button type="button" class="btn-ghost btn-xs" id="coop-sandbox-party-joiner">Open Party Room (joiner)</button>
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
        <p class="coop-sandbox-row"><span>Scenario</span><code>${esc(String(c.scenario || readLs(LS_SCENARIO) || "—"))}</code></p>
        <p class="coop-sandbox-row"><span>Open lobbies</span><code>${esc(String(c.openLobbiesCount ?? "—"))}</code></p>
        <p class="coop-sandbox-row"><span>Sandbox lobbies</span><code>${esc(String(c.sandboxLobbiesCount ?? "—"))}</code></p>
        <p class="coop-sandbox-row"><span>Looking</span><code>${esc(String(c.playersLookingCount ?? "—"))}</code></p>`;
    }
    syncSandboxBanner();
  } catch {
    sandboxCounts = null;
  }
}

function syncSandboxBanner() {
  const $body = document.getElementById("coop-sandbox-body");
  if (!$body) return;
  const $empty = $body.querySelector(".coop-sandbox-empty");
  const $warn = $body.querySelector(".coop-sandbox-warn");
  const kvEmpty = isKvEmpty(sandboxCounts);
  const leftover = hasLeftoverSandboxData(sandboxCounts);

  if (kvEmpty) {
    if (!$empty) {
      const div = document.createElement("div");
      div.className = "coop-sandbox-empty";
      div.setAttribute("role", "status");
      div.innerHTML = `
        <strong>No sandbox data</strong> — click <em>Seed scenario B</em> below to load 3 demo lobbies.`;
      $body.insertBefore(div, $body.firstChild);
    }
    $warn?.remove();
  } else if (leftover) {
    $empty?.remove();
    const openN = Number(sandboxCounts?.openLobbiesCount ?? sandboxCounts?.sandboxLobbiesCount ?? 0);
    if (!$warn) {
      const div = document.createElement("div");
      div.className = "coop-sandbox-warn";
      div.setAttribute("role", "status");
      $body.insertBefore(div, $body.firstChild);
    }
    const banner = $body.querySelector(".coop-sandbox-warn");
    if (banner) {
      banner.innerHTML = `
        <strong>Sandbox data loaded</strong> — ${openN} open lobbies in KV.
        Use <em>Reset sandbox</em> for a clean board.`;
    }
  } else {
    $empty?.remove();
    $warn?.remove();
  }
}

function syncToggleStatusLabels() {
  const mySteamId = bootCtx?.session?.steamID || "";
  const showOn = shouldShowSandboxLobbies(mySteamId);
  const demoOn = shouldIncludeDemoUsers(mySteamId);
  document.querySelectorAll(".coop-sandbox-toggle-status .coop-sandbox-state").forEach((el, i) => {
    const on = i === 0 ? showOn : demoOn;
    el.textContent = toggleStatusLabel(on);
    el.classList.toggle("is-on", on);
    el.classList.toggle("is-off", !on);
  });
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

async function seedScenario(scenarioOverride) {
  const scenario =
    scenarioOverride ||
    document.getElementById("coop-sandbox-scenario")?.value ||
    defaultScenarioId();
  const hostSteamId = document.getElementById("coop-sandbox-persona")?.value;
  writeLs(LS_SCENARIO, scenario);
  writeLs(LS_SANDBOX, "1");
  const $scenario = document.getElementById("coop-sandbox-scenario");
  if ($scenario) $scenario.value = scenario;
  await sandboxFetch("/_debug/coop-sandbox/seed", {
    method: "POST",
    body: { scenario, hostSteamId },
  });
  bootCtx?.deps?.toast?.(`Seeded scenario ${scenario}`);
  await refreshSandboxCounts();
  bootCtx?.onReseed?.();
}

async function fetchCoopStateForSandbox() {
  const base = (bootCtx?.api ?? "/api").replace(/\/$/, "");
  const res = await fetch(`${base}/coop/state`, {
    credentials: "include",
    cache: "no-store",
    headers: { authorization: "Bearer __cookie__" },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function openSandboxPartyAs(role) {
  const hostSid = document.getElementById("coop-sandbox-persona")?.value;
  await seedScenario("E", hostSid);
  if (role === "joiner") {
    await actAsPersona("local-boble");
    return;
  }
  bootCtx?.onReseed?.();
  const state = await fetchCoopStateForSandbox();
  const pid = state?.party?.partyId || state?.lobby?.partyId;
  if (pid) window.location.assign(`/party/${pid}`);
  else bootCtx?.deps?.toast?.("Seed Accepted party first, then open Party Room.");
}

async function resetSandbox() {
  await sandboxFetch("/_debug/coop-sandbox/reset", { method: "POST" });
  writeLs(LS_SCENARIO, null);
  writeLs(LS_PERSONA, null);
  writeLs(LS_SHOW_SANDBOX, null);
  writeLs(LS_INCLUDE_DEMO, null);
  try {
    localStorage.removeItem(LS_VAULT_SESSION);
    localStorage.removeItem("vault_session");
  } catch { /* ignore */ }
  document.cookie = "vault_session=; Path=/; Max-Age=0";
  bootCtx?.deps?.toast?.("Sandbox reset");
  await refreshSandboxCounts();
  window.location.reload();
}

function wirePanel(mySteamId = "") {
  document.getElementById("coop-sandbox-toggle")?.addEventListener("click", () => {
    ensureLoopbackSandboxDefaults();
    const $p = document.getElementById("coop-sandbox-panel");
    if ($p) $p.hidden = !$p.hidden;
    if ($p && !$p.hidden) syncToggleStatusLabels();
  });
  document.getElementById("coop-sandbox-close")?.addEventListener("click", () => {
    const $p = document.getElementById("coop-sandbox-panel");
    if ($p) $p.hidden = true;
  });
  document.getElementById("coop-sandbox-act-as")?.addEventListener("click", () => {
    const sid = document.getElementById("coop-sandbox-persona")?.value;
    if (sid) void actAsPersona(sid).catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.querySelectorAll("[data-sandbox-scenario]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.sandboxScenario;
      void seedScenario(id).catch((e) => bootCtx?.deps?.toast?.(e.message));
    });
  });
  document.getElementById("coop-sandbox-party-host")?.addEventListener("click", () => {
    void openSandboxPartyAs("host").catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.getElementById("coop-sandbox-party-joiner")?.addEventListener("click", () => {
    void openSandboxPartyAs("joiner").catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.getElementById("coop-sandbox-seed")?.addEventListener("click", () => {
    void seedScenario().catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.getElementById("coop-sandbox-reset")?.addEventListener("click", () => {
    void resetSandbox().catch((e) => bootCtx?.deps?.toast?.(e.message));
  });
  document.getElementById("coop-sandbox-show-lobbies")?.addEventListener("change", (e) => {
    setShowSandboxLobbies(!!e.target.checked);
    syncToggleStatusLabels();
    bootCtx?.onReseed?.();
  });
  document.getElementById("coop-sandbox-include-demo")?.addEventListener("change", (e) => {
    setIncludeDemoUsers(!!e.target.checked);
    syncToggleStatusLabels();
    bootCtx?.onReseed?.();
  });
}

/** Open the floating panel (mounts first if needed). */
export function openCoopSandboxPanel(ctx) {
  ensureCoopSandboxMounted(ctx);
  ensureLoopbackSandboxDefaults();
  const $p = document.getElementById("coop-sandbox-panel");
  if ($p) $p.hidden = false;
  syncToggleStatusLabels();
  document.getElementById("coop-sandbox-toggle")?.scrollIntoView({ block: "nearest" });
}

export function ensureCoopSandboxMounted(ctx) {
  if (!isCoopSandboxEnabled()) return;
  mountCoopSandbox(ctx || bootCtx || { api: "/api", deps: {} });
}

export function mountCoopSandbox(ctx) {
  if (!isCoopSandboxEnabled()) return;
  bootCtx = ctx || bootCtx || { api: "/api", deps: {} };
  ensureLoopbackSandboxDefaults();
  const mySteamId = bootCtx?.session?.steamID || "";
  if (panelMounted) {
    void refreshSandboxCounts();
    return;
  }
  panelMounted = true;

  const wrap = document.createElement("div");
  wrap.className = "coop-sandbox-wrap";
  wrap.innerHTML = `
    <button type="button" class="coop-sandbox-toggle" id="coop-sandbox-toggle">Dev Sandbox</button>
    ${panelHtml([], mySteamId)}`;
  document.body.appendChild(wrap);

  void sandboxFetch("/_debug/coop-sandbox/state")
    .then((data) => {
      sandboxCounts = data;
      const personas = data.personas || [];
      const $panel = document.getElementById("coop-sandbox-panel");
      if ($panel) {
        $panel.outerHTML = panelHtml(personas, mySteamId);
      }
      wirePanel(mySteamId);
      void refreshSandboxCounts();
    })
    .catch(() => {
      wirePanel(mySteamId);
    });
}

export function refreshSandboxFromState(state) {
  if (!isCoopSandboxEnabled() || !state) return;
  const $counts = document.getElementById("coop-sandbox-counts");
  if (!$counts) return;
  const mySid = state.presence?.steamId;
  const visible = lobbiesForBoard(state, mySid).length;
  const myLobby = state.lobby;
  const hosted =
    myLobby && myLobby.hostSteamId === mySid && myLobby.status !== "closed";
  $counts.innerHTML = `
    <p class="coop-sandbox-row"><span>Scenario</span><code>${esc(readLs(LS_SCENARIO) || sandboxCounts?.scenario || "—")}</code></p>
    <p class="coop-sandbox-row"><span>Visible board</span><code>${visible}</code></p>
    <p class="coop-sandbox-row"><span>Hosted (you)</span><code>${hosted ? "yes" : "no"}</code></p>
    <p class="coop-sandbox-row"><span>Pending reqs</span><code>${(state.incomingJoinRequests || []).length}</code></p>`;
}

/** Mirrors coop-lobbies board merge for debug counts. */
export function lobbiesForBoard(state, mySteamId) {
  const open = filterOpenLobbiesForViewer(
    (state.openLobbies || []).filter(
      (l) => l.status === "open" || l.status === "full",
    ),
    mySteamId ?? state.presence?.steamId,
  );
  const myLobby = state.lobby;
  const mySid = mySteamId ?? state.presence?.steamId;
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

export const COOP_SANDBOX_LS_KEYS = [
  LS_SANDBOX,
  LS_PERSONA,
  LS_SCENARIO,
  LS_SHOW_SANDBOX,
  LS_INCLUDE_DEMO,
];
