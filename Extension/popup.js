// The toolbar popup: one line that says whether sync is working, and the one
// button that fixes it when it is not. Text is set with textContent only.

const $root = document.querySelector(".popup");
const $status = document.getElementById("status");
const $detail = document.getElementById("detail");
const $path = document.getElementById("path");
const $action = document.getElementById("action");

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function ago(at) {
  const minutes = Math.floor(Math.max(0, Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function show({ state, status, detail = "", path = "", button = "", onClick = null }) {
  $root.dataset.state = state;
  $status.textContent = status;
  $detail.textContent = detail;
  $detail.hidden = !detail;
  $path.textContent = path;
  $path.hidden = !path;
  $action.textContent = button;
  $action.hidden = !button;
  $action.onclick = onClick;
}

function send(type) {
  return chrome.runtime.sendMessage({ type }).catch(() => null);
}

async function render() {
  const info = await send("status");
  if (!info || !info.ok) {
    show({ state: "off", status: "Not ready yet", detail: "Close this and open it again in a moment." });
    return;
  }
  if (!info.fileAccess) {
    show({
      state: "off",
      status: "One switch left",
      detail: "Turn on “Allow access to file URLs” so SpireVault Sync can read your save folder.",
      button: "Open the switch",
      onClick: () => { void send("open-settings"); window.close(); },
    });
    return;
  }
  const last = info.lastSync;
  const hasSynced = last && Number.isFinite(last.at) && Number.isFinite(last.runFiles);
  show({
    state: "on",
    status: hasSynced ? `Synced ${ago(last.at)}` : "Ready",
    detail: hasSynced
      ? `${last.runFiles} run${last.runFiles === 1 ? "" : "s"} in your save folder. New runs show up in SpireVault by themselves.`
      : "Open SpireVault and your runs show up by themselves.",
    path: hasSynced && typeof last.folder === "string" ? last.folder : "",
    button: "Open SpireVault",
    onClick: () => { void send("open-app"); window.close(); },
  });
}

void render();
