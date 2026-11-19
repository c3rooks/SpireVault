// SpireVault Sync, page side: what the player sees.
//
//   - an "Auto-sync" button in the toolbar, beside Refresh, until sync is set up
//   - the setup card (a dialog): get the extension, flip one switch, done
//   - one line on the import screen that offers the same card
//
// Everything is built with DOM calls and textContent; nothing from the
// extension or the save folder is ever written as HTML. Structure and both
// looks' paint live in lib/sync-bridge.css.

import { agoLabel, runsLabel } from "/lib/sync-bridge-core.js?v=1";

const SVG_NS = "http://www.w3.org/2000/svg";
const SWITCH_NAME = "Allow access to file URLs";

/** Where the saves live, as a player would type it, per system. */
const FOLDER_HINT = Object.freeze({
  mac: "~/Library/Application Support/SlayTheSpire2",
  win: "%APPDATA%\\SlayTheSpire2",
  linux: "~/.local/share/SlayTheSpire2",
});

function el(tag, { className = "", text = "", attrs = {} } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

/** The two-arrows sync mark, drawn like the toolbar's other icons. */
function syncIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  })) svg.setAttribute(name, value);
  for (const d of ["M21 12a9 9 0 0 1-15.5 6.2", "M3 12a9 9 0 0 1 15.5-6.2", "M18.5 2v4h-4", "M5.5 22v-4h4"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Which of the three steps is done, current or still ahead, for a phase. */
export function stepStates(phase) {
  if (phase === "connected") return { install: "done", allow: "done", sync: "done" };
  if (["reading", "no-folder", "no-account", "paused"].includes(phase)) return { install: "done", allow: "done", sync: "now" };
  if (phase === "needs-switch") return { install: "done", allow: "now", sync: "todo" };
  return { install: "now", allow: "todo", sync: "todo" };
}

/** True while the toolbar should offer setup: the extension is missing or cannot read yet. */
export function needsSetup(phase) {
  return ["absent", "needs-switch", "no-folder", "no-account", "paused"].includes(phase);
}

/**
 * @param {{
 *   getState: () => { phase: string, os: string, lastOkAt: number },
 *   runCount: () => number,
 *   storeUrl: string,
 *   storeName: string,
 *   actions: { openSettings: () => void, setFolder: (path: string) => Promise<{ ok: boolean, reason?: string }>, recheck: () => void, resume: () => void },
 * }} options
 */
export function createView({ getState, runCount, storeUrl, storeName, actions }) {
  /** @type {HTMLDialogElement | null} */
  let dialog = null;
  /** @type {Record<string, HTMLElement>} */
  const parts = {};
  let folderError = "";

  function step(key, number, title) {
    const mark = el("span", { className: "svs-step-mark", text: String(number), attrs: { "aria-hidden": "true" } });
    const body = el("div", { className: "svs-step-body" }, [el("h3", { className: "svs-step-title", text: title })]);
    const item = el("li", { className: "svs-step", attrs: { "data-step": key } }, [mark, body]);
    parts[`${key}Item`] = item;
    parts[`${key}Mark`] = mark;
    parts[`${key}Body`] = body;
    return item;
  }

  function buildDialog() {
    const node = /** @type {HTMLDialogElement} */ (el("dialog", { className: "svs svs-dialog", attrs: { "aria-labelledby": "svs-title" } }));
    const close = el("button", { className: "svs-close", text: "×", attrs: { type: "button", "aria-label": "Close" } });
    close.addEventListener("click", () => node.close());

    const install = step("install", 1, "Get the extension");
    parts.installText = el("p", { className: "svs-step-text" });
    parts.installLink = el("a", { className: "svs-btn", text: "Get SpireVault Sync", attrs: { target: "_blank", rel: "noopener" } });
    parts.installBody.append(parts.installText, parts.installLink);

    const allow = step("allow", 2, "Flip one switch");
    const allowText = el("p", { className: "svs-step-text" });
    allowText.append("We open the page for you. Turn on ", el("strong", { text: SWITCH_NAME }), " and you're brought straight back.");
    parts.allowButton = el("button", { className: "svs-btn", text: "Open the switch", attrs: { type: "button" } });
    parts.allowButton.addEventListener("click", () => actions.openSettings());
    parts.allowBody.append(allowText, parts.allowButton);

    const sync = step("sync", 3, "That's it");
    parts.syncText = el("p", { className: "svs-step-text", attrs: { role: "status", "aria-live": "polite" } });
    parts.folderForm = buildFolderForm();
    parts.resumeButton = el("button", { className: "svs-btn", text: "Turn auto-sync back on", attrs: { type: "button" } });
    parts.resumeButton.addEventListener("click", () => actions.resume());
    parts.doneButton = el("button", { className: "svs-btn", text: "Done", attrs: { type: "button" } });
    parts.doneButton.addEventListener("click", () => node.close());
    parts.syncBody.append(parts.syncText, parts.folderForm, parts.resumeButton, parts.doneButton);

    node.append(
      close,
      el("h2", { className: "svs-title", text: "Auto-sync your runs", attrs: { id: "svs-title" } }),
      el("p", { className: "svs-lead", text: "Set this up once and new runs show up here by themselves. No more picking your save folder." }),
      el("ol", { className: "svs-steps" }, [install, allow, sync]),
      el("p", { className: "svs-foot", text: "It only reads your Slay the Spire 2 save folder and never changes your files. Works in Chrome, Edge, Brave, Arc and Opera on a computer." }),
    );
    // A click on the backdrop closes, like the app's other dialogs.
    node.addEventListener("click", (event) => { if (event.target === node) node.close(); });
    document.body.append(node);
    return node;
  }

  function buildFolderForm() {
    const input = /** @type {HTMLInputElement} */ (el("input", {
      className: "svs-input",
      attrs: { type: "text", name: "save-folder", autocomplete: "off", spellcheck: "false", "aria-label": "Your Slay the Spire 2 save folder" },
    }));
    const submit = el("button", { className: "svs-btn svs-btn-quiet", text: "Use this folder", attrs: { type: "submit" } });
    const error = el("p", { className: "svs-error", attrs: { role: "alert" } });
    const form = el("form", { className: "svs-folder" }, [input, submit, error]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const path = input.value.trim();
      if (!path) return;
      submit.setAttribute("disabled", "");
      const result = await actions.setFolder(path);
      submit.removeAttribute("disabled");
      folderError = result.ok ? "" : result.reason === "bad-path"
        ? "That isn't a SlayTheSpire2 folder. Paste the path that ends in SlayTheSpire2."
        : "No Slay the Spire 2 saves found there. Check the path and try again.";
      render();
    });
    parts.folderInput = input;
    parts.folderError = error;
    return form;
  }

  function renderDialog() {
    if (!dialog) return;
    const state = getState();
    const steps = stepStates(state.phase);
    for (const key of ["install", "allow", "sync"]) {
      parts[`${key}Item`].dataset.state = steps[key];
      parts[`${key}Mark`].textContent = steps[key] === "done" ? "✓" : String({ install: 1, allow: 2, sync: 3 }[key]);
    }
    // Step 1
    const hasStore = Boolean(storeUrl);
    parts.installText.textContent = steps.install === "done"
      ? "Added."
      : hasStore
        ? `Free in the ${storeName}. One click to add.`
        : "Not in the store yet. To try it now: open chrome://extensions, turn on Developer mode, choose Load unpacked and pick the repo's Extension folder.";
    parts.installLink.hidden = steps.install === "done" || !hasStore;
    if (hasStore) parts.installLink.setAttribute("href", storeUrl);
    // Step 2
    parts.allowButton.hidden = steps.allow !== "now";
    // Step 3
    const count = runCount();
    const syncText = {
      connected: `Synced ${agoLabel(state.lastOkAt)} · ${runsLabel(count)}. New runs show up by themselves.`,
      reading: "Reading your saves…",
      "no-folder": "We couldn't find your Slay the Spire 2 saves on this computer. Paste the folder path:",
      "no-account": "The game is here, but it has no saves for the Steam account you're signed in with. Sign in with the account you play on.",
      paused: "Auto-sync is off because you cleared your runs from this browser. Your save files were not touched.",
    }[state.phase] || "Your runs load, and stay up to date after every game.";
    if (parts.syncText.textContent !== syncText) parts.syncText.textContent = syncText;
    parts.folderForm.hidden = state.phase !== "no-folder";
    if (state.phase === "no-folder" && !parts.folderInput.value && !parts.folderInput.placeholder) {
      parts.folderInput.placeholder = FOLDER_HINT[state.os] || FOLDER_HINT.win;
    }
    parts.folderError.textContent = state.phase === "no-folder" ? folderError : "";
    parts.resumeButton.hidden = state.phase !== "paused";
    parts.doneButton.hidden = state.phase !== "connected";
  }

  function open() {
    if (!dialog) dialog = buildDialog();
    actions.recheck();
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  function isOpen() {
    return Boolean(dialog && dialog.open);
  }

  /** One button per toolbar, before Refresh. Shown only while setup is still needed. */
  function renderToolbar() {
    const state = getState();
    const isShown = needsSetup(state.phase);
    document.querySelectorAll('.app-toolbar-right [data-action="reload-saves"]').forEach((refresh) => {
      let button = refresh.parentElement.querySelector('[data-action="sync-setup"]');
      if (!button) {
        if (!isShown) return;
        button = el("button", {
          className: "btn-ghost btn-icon-text svs-toolbar-btn",
          attrs: { type: "button", "data-action": "sync-setup", title: "New runs show up by themselves" },
        }, [syncIcon(), el("span", { text: "Auto-sync" })]);
        button.addEventListener("click", open);
        refresh.before(button);
      }
      button.hidden = !isShown;
      // The extension is in but cannot read yet: mark the button so it reads as unfinished.
      button.classList.toggle("is-attention", isShown && state.phase !== "absent");
    });
  }

  /** On the import screen (no runs yet): one line offering the same card. */
  function renderNudges() {
    const state = getState();
    const isShown = needsSetup(state.phase) && runCount() === 0;
    document.querySelectorAll(".panel-body .empty-state").forEach((root) => {
      let nudge = root.querySelector(".svs-nudge");
      if (!isShown) { nudge?.remove(); return; }
      if (nudge) return;
      const anchor = root.querySelector(".empty-state-actions, .v-empty-hero");
      if (!anchor) return;
      const button = el("button", { className: "svs-btn svs-btn-quiet", text: "Set up auto-sync", attrs: { type: "button" } });
      button.addEventListener("click", open);
      nudge = el("div", { className: "svs svs-nudge" }, [
        el("p", { className: "svs-nudge-text" }, [
          el("strong", { text: "Or skip the folder. " }),
          document.createTextNode("SpireVault Sync finds your saves, loads your runs and keeps them up to date after every game."),
        ]),
        button,
      ]);
      anchor.insertAdjacentElement("afterend", nudge);
    });
  }

  function render() {
    renderToolbar();
    renderNudges();
    renderDialog();
  }

  return { render, open, isOpen };
}
