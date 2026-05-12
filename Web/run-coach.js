/**
 * Run Coach — Cluely-style cloud overlay (v0.9 Beta)
 * ====================================================
 *
 * What this is
 * ------------
 * A floating, always-on-top assistant the user can launch from the Web
 * app while playing Slay the Spire 2. It mirrors the macOS app's "Run
 * Coach" but runs entirely in the browser via the Document
 * Picture-in-Picture API.
 *
 * Why Document PiP
 * ----------------
 * A regular browser tab is trapped inside the browser window — it can't
 * float over a fullscreen game. The Document Picture-in-Picture API
 * (Chrome/Edge/Brave/Opera/Arc/Vivaldi 116+) lets us spawn a real,
 * native, always-on-top OS window that hosts arbitrary HTML. That's the
 * only browser primitive today that gets us close to the desktop
 * experience (true overlay, sits over fullscreen apps).
 *
 * What we lose vs. the macOS app
 * ------------------------------
 *  - Screen-recording / streamer privacy: the desktop uses
 *    NSWindow.sharingType=.none so OBS can't see the overlay. Browsers
 *    have no equivalent — the PiP window is just an OS window. We tell
 *    the user this on the Beta tab; streamers should keep using the app.
 *  - Persistence: when the launching tab closes, the overlay closes.
 *  - Keychain storage: keys live in localStorage. We tell the user.
 *  - Safari + Firefox: no Document PiP. Falls back to a "use Chrome /
 *    Edge / Brave / Opera / Arc, or download the macOS app" CTA.
 *
 * Storage
 * -------
 * Browser-only state (provider, model, key, prefs) lives in
 * localStorage under the `vault.runcoach.*` namespace. Keys never
 * leave the browser; we POST directly from the page to the chosen
 * provider's API.
 */
(function () {
  "use strict";

  const NS = "vault.runcoach.";
  const KEY_PROVIDER = NS + "provider";       // "openai" | "anthropic"
  const KEY_MODEL    = NS + "model";          // string, provider-specific default
  const KEY_API_KEY  = NS + "apiKey";         // raw user-supplied key
  const KEY_INCLUDE_SCREENSHOT = NS + "includeScreenshot"; // "1" | "0"
  const KEY_HAS_SEEN_DISCLOSURE = NS + "seenDisclosure";   // "1" once acknowledged
  const KEY_SYSTEM_PROMPT = NS + "systemPrompt";

  const DEFAULT_OPENAI_MODEL    = "gpt-4o-mini";
  const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-20241022";

  // ─────────────────────────────────────────────────────────────────────
  //  Browser support detection
  // ─────────────────────────────────────────────────────────────────────

  function supportsDocumentPiP() {
    return typeof window !== "undefined"
      && "documentPictureInPicture" in window
      && typeof window.documentPictureInPicture?.requestWindow === "function";
  }
  function supportsScreenCapture() {
    return typeof navigator !== "undefined"
      && navigator.mediaDevices
      && typeof navigator.mediaDevices.getDisplayMedia === "function";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  State
  // ─────────────────────────────────────────────────────────────────────

  function readState() {
    return {
      provider: localStorage.getItem(KEY_PROVIDER) || "openai",
      model: localStorage.getItem(KEY_MODEL) || "",
      apiKey: localStorage.getItem(KEY_API_KEY) || "",
      includeScreenshot: localStorage.getItem(KEY_INCLUDE_SCREENSHOT) !== "0",
      systemPrompt: localStorage.getItem(KEY_SYSTEM_PROMPT) || "",
      seenDisclosure: localStorage.getItem(KEY_HAS_SEEN_DISCLOSURE) === "1",
    };
  }
  function writeState(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, "provider"))
      localStorage.setItem(KEY_PROVIDER, patch.provider);
    if (Object.prototype.hasOwnProperty.call(patch, "model"))
      localStorage.setItem(KEY_MODEL, patch.model);
    if (Object.prototype.hasOwnProperty.call(patch, "apiKey"))
      localStorage.setItem(KEY_API_KEY, patch.apiKey);
    if (Object.prototype.hasOwnProperty.call(patch, "includeScreenshot"))
      localStorage.setItem(KEY_INCLUDE_SCREENSHOT, patch.includeScreenshot ? "1" : "0");
    if (Object.prototype.hasOwnProperty.call(patch, "systemPrompt"))
      localStorage.setItem(KEY_SYSTEM_PROMPT, patch.systemPrompt);
    if (Object.prototype.hasOwnProperty.call(patch, "seenDisclosure"))
      localStorage.setItem(KEY_HAS_SEEN_DISCLOSURE, patch.seenDisclosure ? "1" : "0");
  }
  function defaultModelFor(provider) {
    return provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL;
  }
  function effectiveModel(s) {
    return s.model || defaultModelFor(s.provider);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Beta tab rendering
  // ─────────────────────────────────────────────────────────────────────

  function renderBetaTab() {
    const $body = document.getElementById("beta-body");
    if (!$body) return;
    const s = readState();
    const pip = supportsDocumentPiP();
    const cap = supportsScreenCapture();
    const browser = detectBrowser();
    const overlayActive = isOverlayOpen();

    $body.innerHTML = `
      <div class="beta-grid">
        <section class="beta-card beta-hero">
          <div class="beta-hero-head">
            <div class="beta-hero-icon" aria-hidden="true">
              <img src="/assets/vault-mark.svg" alt="" />
            </div>
            <div class="beta-hero-text">
              <div class="beta-hero-kicker">CLOUD OVERLAY · BETA</div>
              <h3>Run Coach</h3>
              <p>A Cluely-style floating coach that watches your screen and answers what to play next. Bring your own key, click Launch, drag it anywhere over Slay the Spire 2.</p>
            </div>
          </div>
          ${renderSupportBanner(pip, cap, browser)}
        </section>

        ${renderCoopLobbyBetaCard()}

        <section class="beta-card">
          <header class="beta-card-head">
            <h4>Provider &amp; key</h4>
            <p class="beta-card-sub">Bring your own OpenAI or Anthropic key — we never proxy it.</p>
          </header>
          <div class="beta-form">
            <label class="beta-field">
              <span class="beta-label">Provider</span>
              <div class="beta-seg" role="radiogroup" aria-label="AI provider">
                <button type="button" role="radio" aria-checked="${s.provider === "openai"}"
                        data-rc-action="set-provider" data-provider="openai"
                        ${s.provider === "openai" ? 'aria-pressed="true"' : ""}>OpenAI</button>
                <button type="button" role="radio" aria-checked="${s.provider === "anthropic"}"
                        data-rc-action="set-provider" data-provider="anthropic"
                        ${s.provider === "anthropic" ? 'aria-pressed="true"' : ""}>Anthropic</button>
              </div>
            </label>
            <label class="beta-field">
              <span class="beta-label">Model</span>
              <input class="beta-input" type="text" id="rc-model"
                     placeholder="${defaultModelFor(s.provider)}" value="${escapeAttr(s.model)}"
                     data-rc-action="set-model" autocomplete="off" spellcheck="false" />
              <span class="beta-hint">Leave blank for the default. Models with vision recommended when screenshot is on.</span>
            </label>
            <label class="beta-field">
              <span class="beta-label">API key</span>
              <div class="beta-key-row">
                <input class="beta-input beta-key" type="password" id="rc-key"
                       placeholder="${s.provider === "anthropic" ? "sk-ant-…" : "sk-…"}"
                       value="${escapeAttr(s.apiKey)}"
                       data-rc-action="set-key" autocomplete="off" spellcheck="false" />
                <button type="button" class="btn-ghost sm" data-rc-action="reveal-key"
                        aria-label="Show or hide the API key" title="Show / hide">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
                ${s.apiKey ? '<button type="button" class="btn-ghost sm" data-rc-action="clear-key" title="Forget key">Clear</button>' : ""}
              </div>
              <span class="beta-hint">
                Stored in your browser only (<code>localStorage</code>). Calls go directly from this tab to ${s.provider === "anthropic" ? "Anthropic" : "OpenAI"} — Vault never sees the request or the key.
              </span>
            </label>
          </div>
        </section>

        <section class="beta-card">
          <header class="beta-card-head">
            <h4>Behavior</h4>
            <p class="beta-card-sub">What the coach is allowed to send to the AI.</p>
          </header>
          <div class="beta-toggle-list">
            <label class="beta-toggle">
              <input type="checkbox" data-rc-action="set-screenshot" ${s.includeScreenshot ? "checked" : ""} />
              <span class="beta-toggle-track" aria-hidden="true"></span>
              <span class="beta-toggle-text">
                <strong>Include a screenshot with each question</strong>
                <span>You'll be prompted by the browser to share your screen the first time. Disable this to use text-only chat.</span>
              </span>
            </label>
          </div>
          <details class="beta-advanced">
            <summary>Advanced — custom system prompt</summary>
            <textarea class="beta-textarea" rows="4"
                      placeholder="You are an expert STS2 coach. Speak in 1–2 short sentences. Prioritize survival on tier-3 elites…"
                      data-rc-action="set-system">${escapeText(s.systemPrompt)}</textarea>
            <span class="beta-hint">Replaces the built-in system prompt. Leave blank to use the tuned default.</span>
          </details>
        </section>

        <section class="beta-card">
          <header class="beta-card-head">
            <h4>Launch</h4>
            <p class="beta-card-sub">Open the floating coach. It'll sit on top of every window — including STS2.</p>
          </header>
          <div class="beta-launch">
            ${pip
              ? `<button class="btn-primary beta-launch-btn" type="button" data-rc-action="launch"
                          ${overlayActive ? 'disabled aria-disabled="true"' : ""}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
                  <span>${overlayActive ? "Coach is running" : "Launch Run Coach"}</span>
                </button>
                ${overlayActive ? '<button class="btn-ghost" type="button" data-rc-action="focus">Bring to front</button>' : ""}
                ${overlayActive ? '<button class="btn-ghost" type="button" data-rc-action="close-overlay">Close coach</button>' : ""}`
              : `<button class="btn-ghost beta-launch-btn" type="button" disabled aria-disabled="true">
                  <span>Browser doesn't support floating windows</span>
                </button>`}
          </div>
          ${pip ? `
            <ul class="beta-trust-list">
              <li><strong>Direct to provider.</strong> Your key + your prompts go straight to ${s.provider === "anthropic" ? "Anthropic" : "OpenAI"} from this tab. Vault never sees them.</li>
              <li><strong>Screen captures stay local.</strong> Frames live in memory just long enough to upload to the model — no recording, no replay.</li>
              <li><strong>Streamer-safe?</strong> Not in the browser — the overlay window <em>is</em> visible to OBS / QuickTime. The macOS app hides itself from screen recordings; <a class="action-link" href="/" target="_blank" rel="noopener">grab the .dmg</a> if you stream.</li>
              <li><strong>Closes with this tab.</strong> If you close this Vault tab, the overlay closes too.</li>
            </ul>
          ` : ""}
        </section>
      </div>
    `;

    wireBetaTab($body);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Co-op Lobby Beta toggle — surfaced on the Beta features tab so
  //  users can flip the new Co-op surface on/off from a single place.
  //  The actual state, kill switch, and CSS plumbing live in
  //  script.js (see ENABLE_COOP_LOBBY_BETA, isCoopLobbyBetaEnabled).
  //  We just paint the row and forward toggles into the shared API
  //  exposed via window.__VAULT_COOP_BETA__.
  // ─────────────────────────────────────────────────────────────────────
  function coopBetaApi() {
    return (typeof window !== "undefined" && window.__VAULT_COOP_BETA__) || null;
  }

  function renderCoopLobbyBetaCard() {
    const api = coopBetaApi();
    if (!api) return "";
    const killed  = !api.killSwitch();
    const enabled = api.isEnabled();
    // Kill switch off: hide the toggle entirely so users can't even
    // see the option. Classic Co-op stays the only surface.
    if (killed) return "";
    return `
      <section class="beta-card" data-coop-beta-card>
        <header class="beta-card-head">
          <h4>Co-op Lobby Beta</h4>
          <p class="beta-card-sub">Try the new lobby-based co-op page. Post runs, quick match with compatible players, and browse open run lobbies. You can switch back anytime.</p>
        </header>
        <div class="beta-toggle-list">
          <label class="beta-toggle">
            <input type="checkbox" data-rc-action="set-coop-beta" ${enabled ? "checked" : ""} />
            <span class="beta-toggle-track" aria-hidden="true"></span>
            <span class="beta-toggle-text">
              <strong>Enable Co-op Lobby Beta</strong>
              <span>When off, you see Classic Co-op. Both surfaces talk to the same live matchmaking — Classic and Beta players can still see, invite, and pair with each other.</span>
            </span>
          </label>
        </div>
      </section>
    `;
  }

  function renderSupportBanner(pip, cap, browser) {
    if (pip && cap) return "";
    const name = browser?.name || "your browser";
    return `
      <div class="beta-support-warn">
        <div class="beta-support-icon" aria-hidden="true">!</div>
        <div class="beta-support-body">
          <strong>${pip ? "Screen capture unavailable" : "Floating windows unavailable"} in ${escapeText(name)}.</strong>
          <p>${pip
            ? "We can't ask the browser to share your screen, so the coach would only see your text — no game vision."
            : "The Run Coach uses Document Picture-in-Picture, which Safari and Firefox don't ship yet."}</p>
          <p>For the full experience, open Vault in <strong>Chrome, Edge, Brave, Opera, or Arc</strong>, or install the <a class="action-link" href="/" target="_blank" rel="noopener">macOS app</a> — it's the streamer-safe build.</p>
        </div>
      </div>
    `;
  }

  function detectBrowser() {
    const ua = navigator.userAgent || "";
    if (/firefox\//i.test(ua)) return { name: "Firefox", chromium: false };
    if (/edg\//i.test(ua))     return { name: "Edge",    chromium: true  };
    if (/opr\//i.test(ua))     return { name: "Opera",   chromium: true  };
    if (/arc\//i.test(ua))     return { name: "Arc",     chromium: true  };
    if (/brave/i.test(ua) || (navigator.brave && navigator.brave.isBrave)) return { name: "Brave", chromium: true };
    if (/chrome\//i.test(ua))  return { name: "Chrome",  chromium: true  };
    if (/safari\//i.test(ua))  return { name: "Safari",  chromium: false };
    return { name: "this browser", chromium: false };
  }

  function wireBetaTab(root) {
    root.querySelectorAll("[data-rc-action]").forEach((node) => {
      if (node.dataset.rcWired) return;
      node.dataset.rcWired = "1";
      const action = node.dataset.rcAction;
      const onTrigger = (ev) => betaAction(node, action, ev);
      // Inputs commit on input + change so the value is captured
      // even if the user clicks Launch before blurring the field.
      if (node.tagName === "INPUT" || node.tagName === "TEXTAREA") {
        node.addEventListener("input", onTrigger);
        node.addEventListener("change", onTrigger);
      } else {
        node.addEventListener("click", onTrigger);
      }
    });
  }

  function betaAction(node, action, ev) {
    if (action === "set-provider") {
      const p = node.dataset.provider;
      if (!p) return;
      writeState({ provider: p, model: "" });
      renderBetaTab();
      return;
    }
    if (action === "set-model")   { writeState({ model: node.value.trim() }); return; }
    if (action === "set-key")     { writeState({ apiKey: node.value.trim() }); return; }
    if (action === "reveal-key") {
      const $key = document.getElementById("rc-key");
      if ($key) $key.type = $key.type === "password" ? "text" : "password";
      return;
    }
    if (action === "clear-key") {
      writeState({ apiKey: "" });
      renderBetaTab();
      return;
    }
    if (action === "set-screenshot") {
      writeState({ includeScreenshot: !!node.checked });
      return;
    }
    if (action === "set-coop-beta") {
      const api = coopBetaApi();
      if (api) api.setEnabled(!!node.checked);
      // setEnabled() already re-renders this tab; no extra call needed.
      return;
    }
    if (action === "set-system") {
      writeState({ systemPrompt: node.value });
      return;
    }
    if (action === "launch") {
      ev?.preventDefault?.();
      void launchOverlay();
      return;
    }
    if (action === "focus") {
      _overlay?.window?.focus?.();
      return;
    }
    if (action === "close-overlay") {
      closeOverlay();
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Document PiP overlay lifecycle
  // ─────────────────────────────────────────────────────────────────────

  let _overlay = null;          // { window, doc, history, captureStream, captureVideo }

  function isOverlayOpen() {
    return !!(_overlay && _overlay.window && !_overlay.window.closed);
  }

  async function launchOverlay() {
    if (isOverlayOpen()) {
      _overlay.window.focus?.();
      return;
    }
    if (!supportsDocumentPiP()) {
      alert("Floating windows aren't supported in this browser. Try Chrome, Edge, Brave, Opera, or Arc — or install the macOS app.");
      return;
    }
    const s = readState();
    if (!s.apiKey) {
      alert("Add your " + (s.provider === "anthropic" ? "Anthropic" : "OpenAI") + " API key in the Beta tab before launching the coach.");
      return;
    }

    let pipWindow;
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 360,
        height: 540,
      });
    } catch (err) {
      console.error("Document PiP requestWindow failed", err);
      alert("Couldn't open the floating window: " + (err?.message || err));
      return;
    }

    // Hand the window a fully-styled chat shell. We deliberately inline
    // styles + script so the PiP document is self-contained and works
    // even if the parent tab navigates while the overlay is open.
    pipWindow.document.documentElement.lang = "en";
    pipWindow.document.head.innerHTML = `
      <meta charset="utf-8" />
      <title>Run Coach</title>
      <style>${OVERLAY_CSS}</style>
    `;
    pipWindow.document.body.innerHTML = OVERLAY_HTML;

    _overlay = {
      window: pipWindow,
      doc: pipWindow.document,
      history: [],
      captureStream: null,
      captureVideo: null,
    };

    wireOverlay(pipWindow);
    pipWindow.addEventListener("pagehide", onOverlayClose, { once: true });
    pipWindow.addEventListener("unload",   onOverlayClose, { once: true });
    renderBetaTab();
  }

  function onOverlayClose() {
    closeOverlay();
  }

  function closeOverlay() {
    if (!_overlay) return;
    try { _overlay.captureStream?.getTracks?.().forEach((t) => t.stop()); } catch {}
    try { _overlay.window.close(); } catch {}
    _overlay = null;
    try { renderBetaTab(); } catch {}
  }

  function wireOverlay(win) {
    const doc = win.document;
    const $expand = doc.getElementById("rc-expand");
    const $pill   = doc.getElementById("rc-pill");
    const $close  = doc.getElementById("rc-close");
    const $form   = doc.getElementById("rc-form");
    const $input  = doc.getElementById("rc-input");
    const $log    = doc.getElementById("rc-log");
    const $shoot  = doc.getElementById("rc-shoot");
    const $hide   = doc.getElementById("rc-hide");

    let expanded = true;
    function applyExpanded() {
      doc.body.dataset.expanded = expanded ? "1" : "0";
      const $expandedBlock = doc.getElementById("rc-expanded");
      const $compactBlock  = doc.getElementById("rc-compact");
      if ($expandedBlock) $expandedBlock.hidden = !expanded;
      if ($compactBlock)  $compactBlock.hidden  = expanded;
    }
    applyExpanded();

    $hide?.addEventListener("click", () => { expanded = false; applyExpanded(); });
    $pill?.addEventListener("click", () => { expanded = true;  applyExpanded(); });
    $close?.addEventListener("click", () => closeOverlay());

    // Quick-action chips
    doc.querySelectorAll("[data-rc-quick]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.rcQuick;
        const s = readState();
        if (kind === "assist")
          submitMessage("What's the best play right now?", { withScreenshot: s.includeScreenshot });
        else if (kind === "recap")
          submitMessage("Recap this run so far in one short paragraph.", { withScreenshot: false });
        else if (kind === "explain")
          submitMessage("What should I watch for in the next encounter?", { withScreenshot: s.includeScreenshot });
      });
    });

    $shoot?.addEventListener("click", () => {
      const s = readState();
      writeState({ includeScreenshot: !s.includeScreenshot });
      $shoot.dataset.on = !s.includeScreenshot ? "1" : "0";
    });
    $shoot.dataset.on = readState().includeScreenshot ? "1" : "0";

    $form?.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = $input.value.trim();
      if (!text) return;
      const s = readState();
      $input.value = "";
      submitMessage(text, { withScreenshot: s.includeScreenshot });
    });
  }

  function pushOverlayMessage(role, text, opts = {}) {
    if (!_overlay) return;
    _overlay.history.push({ role, text, ts: Date.now() });
    const $log = _overlay.doc.getElementById("rc-log");
    if (!$log) return;
    const row = _overlay.doc.createElement("div");
    row.className = "rc-msg rc-msg-" + role + (opts.pending ? " rc-msg-pending" : "");
    row.innerHTML = `
      <div class="rc-msg-bubble">${escapeText(text).replace(/\n/g, "<br/>")}</div>
    `;
    if (opts.id) row.dataset.id = opts.id;
    $log.appendChild(row);
    $log.scrollTop = $log.scrollHeight;
    return row;
  }
  function replaceOverlayMessage(row, text, role) {
    if (!row) return;
    row.classList.remove("rc-msg-pending");
    row.className = "rc-msg rc-msg-" + (role || "ai");
    row.innerHTML = `<div class="rc-msg-bubble">${escapeText(text).replace(/\n/g, "<br/>")}</div>`;
    const $log = row.parentElement;
    if ($log) $log.scrollTop = $log.scrollHeight;
  }

  async function submitMessage(text, opts = {}) {
    const s = readState();
    if (!isOverlayOpen()) return;
    if (!s.apiKey) {
      pushOverlayMessage("ai", "No API key set. Open the Beta tab to add one.");
      return;
    }
    pushOverlayMessage("user", text);
    const pendingRow = pushOverlayMessage("ai", "Thinking…", { pending: true });

    let imageDataUrl = null;
    if (opts.withScreenshot && supportsScreenCapture()) {
      try {
        imageDataUrl = await grabScreenshot();
      } catch (err) {
        console.warn("Screenshot capture failed", err);
        replaceOverlayMessage(pendingRow, "Couldn't capture the screen — sending your message text-only.\n\n(" + (err?.message || err) + ")", "ai");
        return askAI(s, text, null).then((ans) => pushOverlayMessage("ai", ans))
          .catch((e) => pushOverlayMessage("ai", "AI request failed: " + (e?.message || e)));
      }
    }

    try {
      const ans = await askAI(s, text, imageDataUrl);
      replaceOverlayMessage(pendingRow, ans, "ai");
    } catch (err) {
      replaceOverlayMessage(pendingRow, "AI request failed: " + (err?.message || err), "ai");
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Screen capture
  // ─────────────────────────────────────────────────────────────────────

  async function ensureCaptureStream() {
    if (!_overlay) throw new Error("Overlay isn't open.");
    if (_overlay.captureStream) {
      // Stream may have been ended by the user via the browser's
      // share-bar "Stop sharing" button. If so, drop the cached
      // reference and re-prompt below.
      const tracks = _overlay.captureStream.getTracks?.() || [];
      const live = tracks.some((t) => t.readyState === "live");
      if (live) return _overlay.captureStream;
      _overlay.captureStream = null;
      _overlay.captureVideo = null;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 8 },
      audio: false,
    });
    _overlay.captureStream = stream;
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    _overlay.captureVideo = video;
    // Auto-clear if the user stops sharing from the browser bar.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      _overlay.captureStream = null;
      _overlay.captureVideo = null;
    });
    return stream;
  }

  async function grabScreenshot() {
    await ensureCaptureStream();
    const video = _overlay.captureVideo;
    if (!video || !video.videoWidth) throw new Error("Capture stream isn't ready yet.");
    // Downscale to 1280px wide max to keep payloads small + cheap.
    const maxW = 1280;
    const scale = Math.min(1, maxW / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  AI client (browser-side, direct to provider)
  // ─────────────────────────────────────────────────────────────────────

  function buildSystemPrompt(s) {
    if (s.systemPrompt && s.systemPrompt.trim().length > 8) return s.systemPrompt.trim();
    return [
      "You are 'Vault Run Coach', a Slay the Spire 2 expert advising the player live.",
      "Speak in 1-3 short sentences. No bullet lists unless explicitly asked.",
      "Prioritize: 1) survival on this floor, 2) deck identity, 3) future scaling.",
      "When given a screenshot, extract the run state from it (HP, gold, deck composition, current node, current map fork) before answering.",
      "If you can't see the relevant info, say so in one sentence and ask the smallest possible clarifying question.",
      "Never include 'as an AI' boilerplate. Never apologize. Never repeat the question back.",
    ].join(" ");
  }

  async function askAI(s, prompt, imageDataUrl) {
    if (s.provider === "anthropic") return askAnthropic(s, prompt, imageDataUrl);
    return askOpenAI(s, prompt, imageDataUrl);
  }

  async function askOpenAI(s, prompt, imageDataUrl) {
    const model = effectiveModel(s);
    const userContent = imageDataUrl
      ? [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ]
      : [{ type: "text", text: prompt }];
    const body = {
      model,
      messages: [
        { role: "system", content: buildSystemPrompt(s) },
        { role: "user", content: userContent },
      ],
      max_tokens: 400,
    };
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 240)}`);
    }
    const json = await res.json();
    return (json?.choices?.[0]?.message?.content || "(empty response)").trim();
  }

  async function askAnthropic(s, prompt, imageDataUrl) {
    const model = effectiveModel(s);
    const content = [{ type: "text", text: prompt }];
    if (imageDataUrl) {
      // Anthropic wants raw base64 + media type, not a data URL.
      const m = imageDataUrl.match(/^data:(image\/[a-z]+);base64,(.*)$/i);
      if (m) {
        content.unshift({
          type: "image",
          source: { type: "base64", media_type: m[1], data: m[2] },
        });
      }
    }
    const body = {
      model,
      max_tokens: 400,
      system: buildSystemPrompt(s),
      messages: [{ role: "user", content }],
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 240)}`);
    }
    const json = await res.json();
    const blocks = json?.content || [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return text || "(empty response)";
  }

  async function safeText(res) {
    try { return await res.text(); } catch { return ""; }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Overlay HTML + CSS (lives inside the PiP document)
  // ─────────────────────────────────────────────────────────────────────

  const OVERLAY_HTML = `
    <div class="rc-shell">
      <header class="rc-head" id="rc-pill" tabindex="0" role="button" aria-label="Run Coach">
        <span class="rc-mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.39 6.95H22l-5.93 4.31L18.46 22 12 17.27 5.54 22l2.39-8.74L2 8.95h7.61z"/></svg>
        </span>
        <strong>Run Coach</strong>
        <span class="rc-spacer"></span>
        <button class="rc-iconbtn" type="button" id="rc-hide" title="Collapse" aria-label="Collapse">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <button class="rc-iconbtn" type="button" id="rc-close" title="Close" aria-label="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </header>

      <section id="rc-expanded" class="rc-expanded">
        <div class="rc-quickrow" role="toolbar" aria-label="Quick prompts">
          <button type="button" class="rc-chip" data-rc-quick="assist">What should I do?</button>
          <button type="button" class="rc-chip" data-rc-quick="explain">Next encounter</button>
          <button type="button" class="rc-chip" data-rc-quick="recap">Recap</button>
        </div>
        <div class="rc-log" id="rc-log" role="log" aria-live="polite">
          <div class="rc-msg rc-msg-system"><div class="rc-msg-bubble">
            Tap a chip or type a question. Your screen + question go straight to your chosen provider — Vault doesn't see either.
          </div></div>
        </div>
        <form class="rc-form" id="rc-form">
          <button type="button" class="rc-iconbtn rc-shoot" id="rc-shoot" title="Toggle screenshot" aria-label="Toggle screenshot">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
          <input id="rc-input" class="rc-input" type="text" autocomplete="off" placeholder="Ask the coach…" />
          <button type="submit" class="rc-send" id="rc-send" aria-label="Send">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </form>
      </section>

      <section id="rc-compact" class="rc-compact" hidden>
        <p>Run Coach is collapsed. Click the bar to bring it back.</p>
      </section>
    </div>
  `;

  const OVERLAY_CSS = `
    :root {
      color-scheme: dark;
      --bg: #0b0d12;
      --bg-2: #11151c;
      --border: rgba(255,255,255,0.08);
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #f59e0b;
      --accent-2: #fbbf24;
      --user: #1f2937;
      --ai: #0f172a;
      --shadow: 0 14px 40px rgba(0,0,0,0.6);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: transparent;
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
      font-size: 13px;
    }
    body {
      background: linear-gradient(160deg, rgba(20,22,30,0.96), rgba(11,13,18,0.96));
      backdrop-filter: blur(24px) saturate(140%);
    }
    .rc-shell { display: flex; flex-direction: column; height: 100%; }
    .rc-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(245,158,11,0.10), rgba(245,158,11,0));
      cursor: pointer;
      user-select: none;
    }
    .rc-mark {
      width: 22px; height: 22px;
      border-radius: 6px;
      background: linear-gradient(160deg, rgba(245,158,11,0.35), rgba(251,191,36,0.15));
      display: grid; place-items: center;
      color: var(--accent-2);
    }
    .rc-head strong {
      font-size: 12px; letter-spacing: 1px; text-transform: uppercase;
      color: var(--text);
    }
    .rc-spacer { flex: 1; }
    .rc-iconbtn {
      width: 22px; height: 22px;
      display: grid; place-items: center;
      background: transparent;
      color: var(--muted);
      border: 1px solid transparent;
      border-radius: 6px;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    }
    .rc-iconbtn:hover { background: rgba(255,255,255,0.06); color: var(--text); border-color: var(--border); }
    .rc-expanded { display: flex; flex-direction: column; flex: 1; min-height: 0; }
    .rc-quickrow { display: flex; gap: 6px; padding: 10px 12px 6px; flex-wrap: wrap; }
    .rc-chip {
      font-size: 11px; font-weight: 700;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    .rc-chip:hover { background: rgba(245,158,11,0.14); border-color: rgba(245,158,11,0.40); }
    .rc-chip:active { transform: translateY(1px); }
    .rc-log {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 6px 12px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .rc-msg { display: flex; }
    .rc-msg-user { justify-content: flex-end; }
    .rc-msg-system, .rc-msg-ai { justify-content: flex-start; }
    .rc-msg-bubble {
      max-width: 86%;
      padding: 8px 11px;
      border-radius: 12px;
      line-height: 1.45;
      white-space: pre-wrap; word-wrap: break-word;
      font-size: 12.5px;
    }
    .rc-msg-user .rc-msg-bubble {
      background: var(--user);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .rc-msg-ai .rc-msg-bubble {
      background: var(--ai);
      border: 1px solid rgba(245,158,11,0.18);
    }
    .rc-msg-system .rc-msg-bubble {
      background: rgba(255,255,255,0.04);
      border: 1px dashed var(--border);
      color: var(--muted);
      font-size: 11.5px;
    }
    .rc-msg-pending .rc-msg-bubble { opacity: 0.7; }
    .rc-form {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px 10px;
      border-top: 1px solid var(--border);
    }
    .rc-shoot[data-on="1"] { color: var(--accent-2); border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.10); }
    .rc-input {
      flex: 1; min-width: 0;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      font-size: 12.5px;
      outline: none;
    }
    .rc-input:focus { border-color: rgba(245,158,11,0.55); }
    .rc-send {
      width: 30px; height: 30px;
      display: grid; place-items: center;
      background: linear-gradient(180deg, var(--accent-2), var(--accent));
      color: #1c1410;
      border: none;
      border-radius: 8px;
      cursor: pointer;
    }
    .rc-send:hover { filter: brightness(1.05); }
    .rc-compact {
      padding: 14px;
      color: var(--muted);
      font-size: 12px;
    }
    .rc-compact p { margin: 0; }
  `;

  // ─────────────────────────────────────────────────────────────────────
  //  HTML escape helpers
  // ─────────────────────────────────────────────────────────────────────

  function escapeText(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(v) {
    return escapeText(v).replace(/"/g, "&quot;");
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Public API + cleanup on tab unload
  // ─────────────────────────────────────────────────────────────────────

  window.addEventListener("beforeunload", () => closeOverlay());

  window.RunCoach = {
    renderBetaTab,
    launchOverlay,
    closeOverlay,
    isOpen: isOverlayOpen,
    supportsDocumentPiP,
  };
})();
