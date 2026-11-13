// The no-runs empty state for the new UI — the activation funnel: the first
// screen a new player sees after linking an empty folder or signing in with
// no runs. Pure function: model in, HTML out. Styles: surfaces/empty.css.
//
// Every control keeps the classic data-action contract, so the handlers that
// renderStatsTab wires on the classic markup work unchanged:
//   scan / upload / restore-from-cloud / signin-cta
//   copy-alt-path (+ data-path)            — wireAltPathsPanel
//   data-alt-paths-panel / -input / -personalized, alt-paths-use
// The OS switch in the path card is radio inputs + CSS, so it needs no
// handler of its own.

import { esc } from "./html.js?v=1";

/** @typedef {"mac"|"windows"|"linux"} OsKey */

/**
 * @typedef {Object} EmptyModel
 * @property {string} uid                 unique per render (ids, radio group name)
 * @property {OsKey|"other"} platform     detected OS
 * @property {boolean} hasDirPicker       Chromium folder picker available
 * @property {boolean} signedIn
 * @property {string} personaName
 * @property {number} backupCount         runs this device held before (0 = none)
 * @property {Record<OsKey, { folder: string, full: string }>} paths
 * @property {ReadonlyArray<{ label: string, path: string }>} altPaths   for the detected OS
 */

const OS_ORDER = /** @type {const} */ (["mac", "windows", "linux"]);
const OS_LABEL = Object.freeze({ mac: "macOS", windows: "Windows", linux: "Linux · Deck" });
const STEAM_ID = "<your-steam-id>";
const CTA_LABEL = "Find my STS2 saves";

const ICONS = Object.freeze({
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.2h6.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="currentColor"/>',
  drop: '<path d="M12 3v10m0 0-4-4m4 4 4-4M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  steam: '<path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z" fill="currentColor"/>',
  cloud: '<path d="M21 4v6h-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.5 15A8.5 8.5 0 1 1 18.4 6.1L21 10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="currentColor"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="2.4"/>',
  warn: '<path d="M12 3.5 2.8 19.5h18.4z" fill="currentColor"/><path class="v-empty-warn-mark" d="M12 10v4.2M12 16.8v.1" fill="none" stroke-width="2.2" stroke-linecap="round"/>',
  apple: '<path d="M16.4 1.7c0 1.3-.5 2.6-1.4 3.5-.9 1-2.5 1.7-3.7 1.6-.2-1.3.5-2.6 1.3-3.5.9-1 2.5-1.7 3.8-1.6zM20 17.4c-.6 1.3-.9 1.9-1.6 3-1 1.6-2.5 3.6-4.4 3.6-1.6 0-2.1-1-4.3-1-2.2 0-2.7 1-4.3 1-1.9 0-3.3-1.8-4.4-3.4-2.9-4.5-3.2-9.7-1.4-12.5C1 6 3 4.6 5 4.6c2 0 3.3 1.1 4.9 1.1 1.6 0 2.6-1.1 5-1.1 1.7 0 3.6.9 4.9 2.5-4.3 2.4-3.6 8.6 0 10.3z" fill="currentColor"/>',
  windows: '<path d="M3 5l8-1.1V11H3V5zm0 7h8v7.1L3 18V12zm9 7.2V12h9v8L12 19.2zM12 11V3.9L21 3v8h-9z" fill="currentColor"/>',
  linux: '<path d="M12 2.5c1.6 0 2.8 1.3 2.8 3 0 .7-.2 1.3-.5 1.8 1.4.8 2.4 2.5 2.4 4.4 0 .8-.2 1.6-.5 2.3 1.4.7 2.3 2.1 2.3 3.8 0 2.2-1.6 3.7-3.4 3.7-.6 0-1.2-.2-1.7-.5-.4.3-.9.5-1.4.5s-1-.2-1.4-.5c-.5.3-1.1.5-1.7.5-1.8 0-3.4-1.5-3.4-3.7 0-1.7.9-3.1 2.3-3.8-.3-.7-.5-1.5-.5-2.3 0-1.9 1-3.6 2.4-4.4-.3-.5-.5-1.1-.5-1.8 0-1.7 1.2-3 2.8-3z" fill="currentColor"/>',
});

/** @param {keyof typeof ICONS} name */
function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

/** @param {...string} keys */
function kbd(...keys) {
  return keys.map((key) => `<kbd>${esc(key)}</kbd>`).join("");
}

/** A final key and its full stop, kept on one line. @param {string} key */
function tail(key) {
  return `<span class="v-empty-nowrap">${kbd(key)}.</span>`;
}

/** @param {OsKey} os */
function pasteStep(os) {
  if (os === "mac") return `Press ${kbd("⌘", "⇧", "G")}, paste, press ${tail("Return")}`;
  if (os === "windows") return `Click the address bar, paste, press ${tail("Enter")}`;
  return `Press ${kbd("Ctrl", "L")}, paste, press ${tail("Enter")}`;
}

/**
 * The path after the copied folder, as a breadcrumb, with the Steam ID
 * placeholder marked so nobody pastes it literally.
 * @param {{ folder: string, full: string }} paths
 */
function insideCrumbs(paths) {
  const sep = paths.full.includes("\\") ? "\\" : "/";
  const rest = paths.full.slice(paths.folder.length).split(sep).filter(Boolean);
  return rest
    .map((part) => (part === STEAM_ID ? '<span class="v-empty-ph">your Steam ID</span>' : `<span>${esc(part)}</span>`))
    .join('<i aria-hidden="true">›</i>');
}

/**
 * @param {EmptyModel} model
 * @param {OsKey} os
 * @param {boolean} isDetected
 */
function osPanel(model, os, isDetected) {
  const paths = model.paths[os];
  return `
    <div class="v-empty-os-panel" data-os="${os}">
      <p class="v-empty-path-label">Copy this, then open the picker${isDetected ? "" : ` on ${esc(OS_LABEL[os])}`}</p>
      <div class="v-empty-path">
        <code>${esc(paths.folder)}</code>
        <button class="v-btn v-empty-copy" type="button" data-action="copy-alt-path" data-path="${esc(paths.folder)}"
                aria-label="Copy the ${esc(OS_LABEL[os])} save folder path">Copy path</button>
      </div>
      <ol class="v-empty-steps">
        <li><span>Click <b>${CTA_LABEL}</b>.</span></li>
        <li><span>${pasteStep(os)}</span></li>
        <li><span>Choose <b>SlayTheSpire2</b> — we find every run inside, no Steam ID needed.</span></li>
      </ol>
      <p class="v-empty-inside"><span class="v-empty-inside-k">Runs live in</span> ${insideCrumbs(paths)}</p>
    </div>`;
}

/** @param {EmptyModel} model */
function whereCard(model) {
  const detected = model.platform === "other" ? null : model.platform;
  const checkedOs = detected || "windows";
  const name = `v-empty-os-${model.uid}`;
  // Radios sit beside the panels (not inside the labels) so CSS can show
  // the checked OS with sibling selectors alone — no :has() needed.
  const inputs = OS_ORDER.map((os) => `
          <input class="v-empty-os-input v-sr" type="radio" name="${name}" id="${name}-${os}" value="${os}"
                 aria-label="${esc(OS_LABEL[os])}${os === detected ? ", detected" : ""}"${os === checkedOs ? " checked" : ""}>`).join("");
  const tabs = OS_ORDER.map((os) => `
            <label class="v-empty-os-tab" for="${name}-${os}" data-os="${os}">
              ${icon(os === "mac" ? "apple" : os)}<span>${esc(OS_LABEL[os])}</span>${os === detected ? '<em class="v-empty-detected" title="Detected from this browser">yours</em>' : ""}
            </label>`).join("");
  return `
    <aside class="v-empty-where" aria-labelledby="${name}-title">
      <header class="v-empty-where-band">
        <span class="v-empty-where-orb" aria-hidden="true">${icon("folder")}</span>
        <h3 id="${name}-title">Where your saves live</h3>
      </header>
      <div class="v-empty-where-body">
        <fieldset class="v-empty-os">
          <legend class="v-sr">Your computer</legend>
          ${inputs}
          <div class="v-empty-os-tabs" aria-hidden="true">${tabs}</div>
          ${OS_ORDER.map((os) => osPanel(model, os, os === detected)).join("")}
        </fieldset>
        <p class="v-empty-warn">${icon("warn")}<span>Not Steam's <b>Browse local files</b> — that opens the game's install folder, not your saves.</span></p>
      </div>
    </aside>`;
}

/** @param {EmptyModel} model */
function intro(model) {
  const scanAction = model.hasDirPicker ? "scan" : "upload";
  const findBtn = (variant) => `
    <button class="v-btn ${variant} v-empty-cta" type="button" data-action="${scanAction}">
      ${icon("folder")}<span>${CTA_LABEL}</span>
    </button>`;
  const pickFiles = model.hasDirPicker
    ? '<button class="v-btn v-empty-alt" type="button" data-action="upload">Pick files instead</button>'
    : "";
  const actions = model.signedIn
    ? `<button class="v-btn v-btn--primary v-empty-cta" type="button" data-action="restore-from-cloud">${icon("cloud")}<span>Restore my runs from Steam</span></button>
       ${findBtn("v-empty-alt")}`
    : `${findBtn("v-btn--primary")}${pickFiles}`;
  const title = model.signedIn ? "Restore your runs" : "Bring in your climbs";
  const lede = model.signedIn
    ? `Signed in as <b>${esc(model.personaName)}</b>. Pull the copy synced to your Steam account, or point us at your save folder once and we'll sync it — you only do this once.`
    : "Point SpireVault at your Slay the Spire 2 save folder once. We read every run on disk and keep them in this browser — nothing uploads.";
  const backup = model.backupCount > 0
    ? `<p class="v-empty-backup" role="note">${icon("cloud")}<span>This device held <b>${model.backupCount}</b> runs before. Restore from Steam or reconnect your save folder — no need to start over.</span></p>`
    : "";
  const signIn = model.signedIn
    ? ""
    : `<li>${icon("steam")}<span><button class="v-empty-link" type="button" data-action="signin-cta">Sign in with Steam</button> to keep your history and sync it across devices. Optional.</span></li>`;
  return `
    <div class="v-empty-intro">
      <p class="v-empty-kicker">${model.signedIn ? "Welcome back" : "One-time setup · no sign-in needed"}</p>
      <h2 class="v-empty-title" id="v-empty-title-${model.uid}">${title}</h2>
      <p class="v-empty-lede">${lede}</p>
      ${backup}
      <div class="v-empty-actions">${actions}</div>
      <ul class="v-empty-also">
        <li>${icon("drop")}<span>Or <b>drag the SlayTheSpire2 folder</b> (or any <code>.run</code> files) onto this page — works from any drive.</span></li>
        ${pickFiles && model.signedIn ? `<li>${icon("folder")}<span>${pickFiles} if the folder picker won't open.</span></li>` : ""}
        ${signIn}
        <li>${icon("lock")}<span>Runs stay on this device. Import once — they're here next visit.</span></li>
      </ul>
    </div>`;
}

/** @param {EmptyModel} model */
function altPathsPanel(model) {
  const rows = model.altPaths.map((alt) => `
        <li class="v-empty-alt-row">
          <span class="v-empty-alt-label">${esc(alt.label)}</span>
          <code>${esc(alt.path)}</code>
          <button class="v-btn v-empty-copy" type="button" data-action="copy-alt-path" data-path="${esc(alt.path)}"
                  aria-label="Copy the ${esc(alt.label)} path">Copy</button>
        </li>`).join("");
  const inputId = `alt-paths-paste-input-${model.uid}`;
  return `
    <details class="v-empty-more" data-alt-paths-panel>
      <summary>
        <span class="v-empty-more-title">My saves are somewhere else</span>
        <span class="v-empty-more-hint">Portable Steam, another drive, a custom path</span>
      </summary>
      <div class="v-empty-more-body">
        <p class="v-empty-more-lede">Steam can keep STS2 on any drive. These are the usual spots — copy the one that matches and paste it into the picker.</p>
        <ul class="v-empty-alt-list">${rows}</ul>
        <div class="v-empty-paste">
          <label for="${inputId}">Or paste your own save folder</label>
          <div class="v-empty-paste-row">
            <input id="${inputId}" class="v-empty-paste-input" type="text" spellcheck="false" autocomplete="off"
                   autocapitalize="off" autocorrect="off" placeholder="e.g. F:\\Games\\SlayTheSpire2\\saves\\history" data-alt-paths-input>
            <button class="v-btn v-btn--primary" type="button" data-action="alt-paths-use" disabled>Use this path</button>
          </div>
          <p class="v-empty-paste-note">Browsers can't open a typed path directly, so we copy it and show you where to paste it in the picker.</p>
          <div class="v-empty-personal" data-alt-paths-personalized hidden></div>
        </div>
      </div>
    </details>`;
}

function troubleshooting() {
  return `
    <details class="v-empty-more">
      <summary>
        <span class="v-empty-more-title">I still can't find them</span>
        <span class="v-empty-more-hint">Steam Cloud copies and other checks</span>
      </summary>
      <div class="v-empty-more-body">
        <ul class="v-empty-faq">
          <li><b>Look for <code>.run</code> files.</b> Inside <code>history</code> there is one per game, named like <code>1735689420.run</code>. Picking that folder directly works too.</li>
          <li><b>Steam Cloud copy (Mac).</b> If the usual folder is empty, try <code>~/Library/Application Support/Steam/userdata/&lt;your-id&gt;/2868840/remote/</code>.</li>
          <li><b>Steam Cloud copy (Windows).</b> <code>%PROGRAMFILES(X86)%\\Steam\\userdata\\&lt;your-id&gt;\\2868840\\remote\\</code></li>
          <li><b>Old Vault export?</b> A <code>history.json</code> from the macOS Vault CLI still works — just drop it in.</li>
        </ul>
      </div>
    </details>`;
}

/**
 * The no-runs body for every stats tab.
 * @param {EmptyModel} model
 * @returns {string}
 */
export function emptyStateHtml(model) {
  return `
    <section class="v-empty empty-state${model.signedIn ? " is-authed" : ""}" aria-labelledby="v-empty-title-${model.uid}">
      <div class="v-empty-hero" data-reveal style="--r:0">
        ${intro(model)}
        ${whereCard(model)}
      </div>
      <div class="v-empty-help" data-reveal style="--r:2">
        ${altPathsPanel(model)}
        ${troubleshooting()}
      </div>
    </section>`;
}
