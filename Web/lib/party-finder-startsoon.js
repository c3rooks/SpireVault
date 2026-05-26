// party-finder-startsoon.js — pure logic for "Starting soon" / countdown.
// =========================================================================
// No DOM, no globals, no side effects. Importable from ESM modules and
// reachable from classic scripts via window.__pfStartSoon.
//
// Strategy: piggyback the planned-start onto the lobby's existing `note`
// field as a bracketed prefix so the feature works WITHOUT any backend
// schema change. The prefix passes the backend's sanitizeText() because
// none of [ ] = - : T Z are stripped, and whitespace inside the bracket
// is impossible. Total prefix length is ~33 chars, leaving ~127 chars
// of the 160-char note budget for the player's actual note.
//
// Wire shape examples:
//   "[start=2026-05-25T11:45:00Z] Trying for a clean heart run."
//   "[start=full] Whenever we fill up."
//
// Decode is tolerant: any malformed bracket is treated as user text.
// =========================================================================

const START_RE = /^\s*\[start=([^\]]{1,40})\]\s*/i;

// Encode a planned start onto an existing note. Pass null/undefined to
// clear; pass "full" for the "when full" mode. Returns a string ≤ 160.
export function encodeStart(note, planned) {
  const clean = stripStart(note || "");
  if (!planned) return clean;
  let token;
  if (planned === "full") token = "full";
  else if (planned instanceof Date && !isNaN(planned.getTime())) {
    token = planned.toISOString().replace(/\.\d{3}Z$/, "Z");
  } else if (typeof planned === "string" && planned.length) {
    token = planned;
  } else {
    return clean;
  }
  const prefix = `[start=${token}]`;
  const sep = clean ? " " : "";
  return (prefix + sep + clean).slice(0, 160);
}

// Strip a [start=...] prefix from a note string and return the visible
// remainder. Idempotent and safe on null/undefined.
export function stripStart(note) {
  const s = String(note || "");
  const m = START_RE.exec(s);
  if (!m) return s.trim();
  return s.slice(m[0].length).trim();
}

// Parse a lobby's note into { plannedAt, isWhenFull, cleanNote }.
// plannedAt is a Date when the host set a concrete time; isWhenFull is
// true when the host chose "When full"; cleanNote is the visible text.
export function decodeStart(note) {
  const s = String(note || "");
  const m = START_RE.exec(s);
  if (!m) return { plannedAt: null, isWhenFull: false, cleanNote: s.trim() };
  const raw = m[1].trim().toLowerCase();
  const rest = s.slice(m[0].length).trim();
  if (raw === "full" || raw === "when_full" || raw === "whenfull") {
    return { plannedAt: null, isWhenFull: true, cleanNote: rest };
  }
  // Strict ISO 8601 with Z or ±hh:mm offset. Reject anything else.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/i.test(m[1].trim())) {
    return { plannedAt: null, isWhenFull: false, cleanNote: rest };
  }
  const d = new Date(m[1].trim());
  if (isNaN(d.getTime())) return { plannedAt: null, isWhenFull: false, cleanNote: rest };
  return { plannedAt: d, isWhenFull: false, cleanNote: rest };
}

// Take a "Now" / "15m" / "30m" / "1h" preset and resolve to a concrete
// planned Date. "now" gets a 45-second buffer so every client lands in
// the GO countdown together rather than blowing past zero immediately.
// "full" stays symbolic — returns the string "full".
export function presetToPlanned(presetId, now = new Date()) {
  switch (String(presetId || "").toLowerCase()) {
    case "now":   return new Date(now.getTime() + 45 * 1000);
    case "5m":    return new Date(now.getTime() + 5  * 60 * 1000);
    case "15m":   return new Date(now.getTime() + 15 * 60 * 1000);
    case "30m":   return new Date(now.getTime() + 30 * 60 * 1000);
    case "1h":    return new Date(now.getTime() + 60 * 60 * 1000);
    case "2h":    return new Date(now.getTime() + 2 * 60 * 60 * 1000);
    case "full":  return "full";
    default:      return null;
  }
}

// Render a countdown into a compact human label and a tier used for
// styling, sorting, and notification triggers.
//
// Tier ladder (a "soonness" gradient):
//   future-calm   →  > 15 min away
//   future-warn   →  2-15 min away
//   future-hot    →  30 s - 2 min away
//   now-soon      →  10-30 s away (T-30s window)
//   now-go        →  ≤10 s out and ≤30 s past (GO moment)
//   past          →  > 30 s past the start (we still show briefly)
//   gone          →  > 5 min past (hide entirely)
export function formatCountdown(target, now = new Date()) {
  if (!(target instanceof Date) || isNaN(target.getTime())) {
    return { kind: "unknown", text: "", tier: "unknown", deltaMs: 0 };
  }
  const delta = target.getTime() - now.getTime();
  const abs = Math.abs(delta);
  const sec = Math.floor(abs / 1000);

  if (delta <= -5 * 60 * 1000) {
    return { kind: "gone", text: "", tier: "gone", deltaMs: delta };
  }
  if (delta <= -30 * 1000) {
    return { kind: "past", text: humanAgo(sec), tier: "past", deltaMs: delta };
  }
  if (delta <= 10 * 1000) {
    // GO window: -30s ≤ delta ≤ +10s. Show countdown then "GO".
    if (delta <= 0) {
      return { kind: "now-go", text: "GO! Launch Steam now", tier: "now-go", deltaMs: delta };
    }
    return { kind: "now-go", text: `Starting in ${sec}s`, tier: "now-go", deltaMs: delta };
  }
  if (delta <= 30 * 1000) {
    return { kind: "now-soon", text: `Starting in ${sec}s`, tier: "now-soon", deltaMs: delta };
  }
  if (delta <= 2 * 60 * 1000) {
    return { kind: "future-hot", text: `Starts in ${humanFuture(sec)}`, tier: "future-hot", deltaMs: delta };
  }
  if (delta <= 15 * 60 * 1000) {
    return { kind: "future-warn", text: `Starts in ${humanFuture(sec)}`, tier: "future-warn", deltaMs: delta };
  }
  return { kind: "future-calm", text: `Starts in ${humanFuture(sec)}`, tier: "future-calm", deltaMs: delta };
}

// Human-friendly future duration with a sane unit cap.
function humanFuture(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 5)  return s ? `${m}m ${s}s` : `${m}m`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function humanAgo(sec) {
  if (sec < 60) return `Started ${sec}s ago`;
  const m = Math.floor(sec / 60);
  return `Started ${m}m ago`;
}

// Should this lobby show a countdown right now? Centralizes the "is the
// time set and not yet expired" check so renderers and sorters agree.
export function lobbyHasLiveStart(lobby, now = new Date()) {
  if (!lobby) return false;
  const { plannedAt, isWhenFull } = decodeStart(lobby.note);
  if (isWhenFull) return true;
  if (!plannedAt) return false;
  return plannedAt.getTime() - now.getTime() > -5 * 60 * 1000;
}

// Stable sort key — smaller value = sooner. Used so "starting soon"
// lobbies float to the top of Live Parties.
export function startSortKey(lobby, now = new Date()) {
  const d = decodeStart(lobby && lobby.note);
  if (d.isWhenFull) {
    // "When full" rooms get a competitive but not top slot. Once full,
    // they jump to the very top via the auto-now branch below.
    const full = isLobbyFull(lobby);
    if (full) return -1;
    return Number.MAX_SAFE_INTEGER - 1000;
  }
  if (!d.plannedAt) return Number.MAX_SAFE_INTEGER;
  return d.plannedAt.getTime() - now.getTime();
}

function isLobbyFull(lobby) {
  if (!lobby) return false;
  const cap = lobby.lobbySize || 4;
  const filled = Array.isArray(lobby.partyMembers) ? lobby.partyMembers.length : 1;
  return filled >= cap;
}

// Expose the API on window so classic IIFE scripts (the runtime ticker)
// can call into the same encode/decode without re-implementing it.
if (typeof window !== "undefined") {
  window.__pfStartSoon = Object.freeze({
    encode: encodeStart,
    strip: stripStart,
    decode: decodeStart,
    presetToPlanned,
    formatCountdown,
    lobbyHasLiveStart,
    startSortKey,
  });
}
