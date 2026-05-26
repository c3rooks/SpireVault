// party-finder-helpers.js — Co-op Lobby Beta · visual helper functions
// =========================================================================
// Extracted helpers used by party-finder.js to render game-lobby polish:
//   • renderSlotStrip → visual party slot row with character avatars
//   • branchPillHtml / modePillHtml / ascensionPillHtml / goalPillHtml /
//     voicePillHtml / micPillHtml → color-coded attribute pills
//
// These were factored out of party-finder.js so the main module stays
// focused on state + flow while the visual atoms live here.
// =========================================================================

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CHAR_IDS = new Set(["ironclad", "silent", "defect", "necrobinder", "regent"]);
const CHAR_LABELS = {
  ironclad: "Ironclad",
  silent: "Silent",
  defect: "Defect",
  necrobinder: "Necrobinder",
  regent: "Regent",
};

function _normalizeCharId(v) {
  const id = String(v || "").trim().toLowerCase();
  return CHAR_IDS.has(id) ? id : "";
}
function _charLabel(id) {
  return CHAR_LABELS[_normalizeCharId(id)] || "";
}
function _charAsset(id) {
  const slug = _normalizeCharId(id);
  return slug ? "/assets/sts2/characters/" + slug + "-v2.webp" : "";
}

function _ascBucketLabel(min, max) {
  if (min == null && max == null) return "Any level";
  const lo = Math.max(0, min ?? 0);
  const hi = Math.min(10, max ?? 10);
  if (lo === 10 && hi === 10) return "A10";
  if (lo === 0 && hi === 10) return "Any level";
  if (lo === 0 && hi === 3) return "A0-A3";
  if (lo === 4 && hi === 7) return "A4-A7";
  if (lo === 8 && hi === 10) return "A8-A10";
  if (lo === hi) return "A" + lo;
  return "A" + lo + "-A" + hi;
}

function _modeIdOf(l) {
  const m = String(l && l.mode || "standard").toLowerCase();
  return m === "daily" ? "daily" : m === "custom" ? "custom" : "standard";
}

function _goalLabel(g) {
  const m = { any: "Any run", heart: "Heart Attempt", daily: "Daily", learning: "Learning", casual: "Chill climb" };
  return m[String(g || "any").toLowerCase()] || "Any run";
}

function _voiceLabelOf(l) {
  const p = String(l && l.voicePreset || "any").toLowerCase();
  if (p === "none") return "No voice";
  if (p === "any") return "Voice flexible";
  if (p === "custom") return "Custom voice";
  const num = p.match(/^lfg(\d)$/);
  if (num) return "LFG " + num[1];
  return "Voice flexible";
}

function _micLabel(pref) {
  const p = String(pref || "optional").toLowerCase();
  if (p === "yes") return "Mic preferred";
  if (p === "no") return "Quiet \u2014 no mic";
  return "Mic optional";
}

function _lobbyMembers(l) {
  if (!l) return [];
  const a = l.acceptedMemberSteamIds;
  if (Array.isArray(a) && a.length > 0) return a;
  return l.hostSteamId ? [l.hostSteamId] : [];
}
function _lobbySizeOf(l) { const n = l && l.lobbySize; return n === 2 || n === 3 || n === 4 ? n : 4; }
function _hostCharOf(l) {
  const ids = (l && l.preferredCharacters || []).map(_normalizeCharId).filter(Boolean);
  return ids[0] || "";
}

// ──────────────────────────────────────────────────────────────────────
// Pill renderers (color-coded by branch / voice / mic)
// ──────────────────────────────────────────────────────────────────────
export function branchPillHtml(l) {
  const b = String(l && l.branch || "beta").toLowerCase();
  const map = {
    beta: ["pf-pill--branch-beta", "Beta branch"],
    main: ["pf-pill--branch-main", "Main branch"],
    both: ["pf-pill--branch-both", "Main or Beta"],
  };
  const v = map[b] || map.beta;
  return '<span class="pf-pill ' + v[0] + '">' + esc(v[1]) + '</span>';
}

export function modePillHtml(l) {
  const id = _modeIdOf(l);
  const label = id === "daily" ? "Daily" : id === "custom" ? "Custom" : "Standard";
  return '<span class="pf-pill pf-pill--mode">' + esc(label) + '</span>';
}

export function ascensionPillHtml(l) {
  return '<span class="pf-pill pf-pill--asc">' + esc(_ascBucketLabel(l && l.ascensionMin, l && l.ascensionMax)) + '</span>';
}

export function goalPillHtml(l) {
  return '<span class="pf-pill pf-pill--goal">' + esc(_goalLabel(l && l.goal)) + '</span>';
}

export function voicePillHtml(l) {
  const v = String(l && l.voicePreset || "any").toLowerCase();
  const cls = v === "none" ? "pf-pill--voice-none" : "pf-pill--voice";
  return '<span class="pf-pill ' + cls + '" title="Voice">' + esc(_voiceLabelOf(l)) + '</span>';
}

export function micPillHtml(pref) {
  const p = String(pref || "optional").toLowerCase();
  const cls = p === "yes" ? "pf-pill--mic-yes" : "pf-pill--mic-no";
  return '<span class="pf-pill ' + cls + '">' + esc(_micLabel(pref)) + '</span>';
}

// ──────────────────────────────────────────────────────────────────────
// Visual party slot row — character avatars instead of text bullets
// ──────────────────────────────────────────────────────────────────────
export function renderSlotStrip(l, state) {
  const cap = _lobbySizeOf(l);
  const members = _lobbyMembers(l);
  const hostChar = _hostCharOf(l);
  const openPref = (l && l.preferredCharacters || []).slice(1).map(_normalizeCharId);
  const mySid = state && state.presence && state.presence.steamId;
  const slots = [];

  const hostImg = hostChar ? '<img class="pf-slot-img" src="' + esc(_charAsset(hostChar)) + '" alt="" />' : "";
  const hostTitle = "Host: " + esc(l && l.hostPersonaName || "Host");
  slots.push('<div class="pf-slot pf-slot--host" title="' + hostTitle + '">' + hostImg + '<span class="pf-slot-tag">Host</span></div>');

  for (let i = 1; i < cap; i++) {
    if (i < members.length) {
      const sid = members[i];
      const isMe = sid && sid === mySid;
      const cls = isMe ? "pf-slot--mine" : "pf-slot--joined";
      const tag = isMe ? "You" : "In";
      const ttl = isMe ? "You" : "Joined";
      slots.push('<div class="pf-slot ' + cls + '" title="' + ttl + '"><span class="pf-slot-tag">' + tag + '</span></div>');
    } else {
      const pref = openPref[i - 1];
      const img = pref ? '<img class="pf-slot-img" src="' + esc(_charAsset(pref)) + '" alt="" style="opacity:.45;filter:grayscale(.6)" />' : "";
      const lbl = pref ? _charLabel(pref) : "Open";
      slots.push('<div class="pf-slot pf-slot--open" title="Open seat — ' + esc(lbl) + '">' + img + '</div>');
    }
  }
  return '<div class="pf-slots" aria-label="Party slots">' + slots.join("") + '</div>';
}

// ──────────────────────────────────────────────────────────────────────
// Discord deep link helpers (used by Party Hub voice button + LFG copy)
// ──────────────────────────────────────────────────────────────────────
export function discordDeepLink(url) {
  // Discord channel invite URLs:
  //   • https://discord.gg/<code>
  //   • https://discord.com/invite/<code>
  //   • https://discord.com/channels/<guild>/<channel>
  // For the channel form, the `discord://` deep link works in the desktop
  // client. For the gg/invite form, we just return the https URL — Discord
  // handles the OS-level deep link from there.
  const raw = String(url || "").trim();
  if (!raw) return "";
  const m = raw.match(/discord\.com\/channels\/(\d+)\/(\d+)/);
  if (m) return "discord://discord.com/channels/" + m[1] + "/" + m[2];
  return raw;
}

export function buildDiscordLfgPost(opts) {
  const mode = opts.mode || "Standard";
  const goal = opts.goal || "Any";
  const asc = opts.ascension || "Any";
  const filled = opts.filled || 1;
  const size = opts.size || 4;
  const need = Math.max(0, size - filled);
  const host = opts.host || "Host";
  const voice = opts.voice || "Voice flexible";
  const voiceUrl = opts.voiceUrl || "";
  const link = opts.deepLink || "";
  const voiceLine = voiceUrl ? "Voice: " + voice + " " + voiceUrl : "Voice: " + voice;
  const need_line = need > 0 ? "Need +" + need : "Full";
  // Discord's native timestamp tag — channels render <t:UNIX:R> as a
  // live "in 14 minutes" pill that updates without refreshing.
  let startLine = "";
  if (opts.plannedAt instanceof Date && !isNaN(opts.plannedAt.getTime())) {
    const unix = Math.floor(opts.plannedAt.getTime() / 1000);
    startLine = "Starts <t:" + unix + ":R> (<t:" + unix + ":t> your time)";
  } else if (opts.isWhenFull) {
    startLine = "Starts the moment we fill — claim a seat fast.";
  }
  return [
    "STS2 " + mode + " · " + goal + " · " + asc + " · " + filled + "/" + size + " · " + need_line,
    "Host: " + host,
    voiceLine,
    startLine,
    link ? "Join on SpireVault: " + link : "",
  ].filter(Boolean).join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// Character avatar attached to a preference chip (Run Prefs panel)
// ──────────────────────────────────────────────────────────────────────
export function chipWithCharAvatarHtml(charId) {
  const slug = _normalizeCharId(charId);
  const label = slug ? _charLabel(slug) : "Open to any";
  const img = slug ? '<img class="pf-pref-chip-img" src="' + esc(_charAsset(slug)) + '" alt=""/>' : "";
  return '<li class="pf-pref-chip">' + img + '<span class="pf-pref-chip-key">Character</span><span>' + esc(label) + '</span></li>';
}
