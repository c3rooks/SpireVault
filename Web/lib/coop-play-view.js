// Co-op Play — markup for each state of the one card on the Co-op tab.
//
// Pure functions: (view model) → HTML string. No fetches, no timers, no DOM
// reads, so every state can be rendered and screenshotted in isolation.
// Every string that came from another player (Steam names, avatars) goes
// through esc() before it reaches the page.

import { STAGE_ACTOR_ART } from "/lib/ui/stage-actors.js?v=2";
import { STAGE_BACKDROPS } from "/lib/ui/stage-backdrops.js?v=1";
import { canShare } from "/lib/coop-play-share.js?v=5";

/** The playable climbers, in the game's own order. The Fool is beta-only. */
export const CLIMBERS = Object.freeze([
  Object.freeze({ id: "ironclad", name: "Ironclad", beta: false }),
  Object.freeze({ id: "silent", name: "Silent", beta: false }),
  Object.freeze({ id: "defect", name: "Defect", beta: false }),
  Object.freeze({ id: "regent", name: "Regent", beta: false }),
  Object.freeze({ id: "necrobinder", name: "Necrobinder", beta: false }),
  Object.freeze({ id: "fool", name: "The Fool", beta: true }),
]);

const MAX_PARTY = 4;

/**
 * Where a long name may break when a picker tile is too narrow for it: at a
 * soft hyphen ("Necro-binder" over two lines), never cut with an ellipsis.
 * The picker goes to two rows before its tiles get that narrow (coop-play.css,
 * .cp-field--pick), so this is only the last resort. Trusted markup, keyed by
 * climber id.
 */
const PICK_NAME_BREAKS = Object.freeze({
  ironclad: "Iron&shy;clad",
  necrobinder: "Necro&shy;binder",
});

/**
 * Three of the inked climbers are seated poses (the game's rest-site art).
 * Like the header stage, they get a drum of fallen column to sit on, as
 * fractions of the figure's own box. Same numbers as ACTOR_STAGING in
 * lib/ui/stage.js; keep them in step if the sprites are rebuilt.
 */
const SEATED = Object.freeze({
  ironclad: Object.freeze({ left: -0.04, top: 0.5, width: 0.6, height: 0.44 }),
  silent: Object.freeze({ left: 0.02, top: 0.52, width: 0.62, height: 0.4 }),
  necrobinder: Object.freeze({ left: -0.02, top: 0.56, width: 0.66, height: 0.36 }),
});

/**
 * Where each climber's head is across its own picture, 0 (left) to 1: the
 * host's crown floats over it. Measured on the built sprites (the middle of
 * what is opaque in the top tenth of the art, the Silent's between her
 * antlers and her hood); measure again if the sprites are redrawn.
 */
const HEAD_X = Object.freeze({ ironclad: 0.52, silent: 0.4, defect: 0.44, regent: 0.34, necrobinder: 0.4, fool: 0.52 });

const pct = (n) => `${(n * 100).toFixed(1)}%`;

/** Width ÷ height of what stands on the floor (climber art, a blank, a seat). */
const BLANK_ASPECT = 0.5;
const SEAT_ASPECT = 0.42;
const FLOOR_GAP = 0.03;
function figureAspect(id) {
  const art = id ? STAGE_ACTOR_ART[id] : null;
  return art && art.kind === "climber" ? art.width / art.height : BLANK_ASPECT;
}

/**
 * How many figure-heights of width the floor has to hold. CSS divides the
 * floor's width by this (container units) so a full party of wide climbers
 * shrinks to fit instead of spilling out of the room.
 */
function floorSum(members, openSeats) {
  const items = members.length + openSeats;
  const widths = members.reduce((n, m) => n + figureAspect(m.character), 0) + openSeats * SEAT_ASPECT;
  return (widths / Math.max(0.5, 1 - FLOOR_GAP * Math.max(0, items - 1))).toFixed(3);
}

function seatStoneHtml(id) {
  const seat = id ? SEATED[id] : null;
  if (!seat) return "";
  return `<span class="cp-stone" style="left:${pct(seat.left)};top:${pct(seat.top)};width:${pct(seat.width)};height:${pct(seat.height)}" aria-hidden="true"></span>`;
}

/**
 * Ties a sentence's last two words with a no-break space, so the line never
 * ends on one word alone at any width ("does.", "Play."). text-wrap: pretty
 * (coop-play.css) shapes the rest of the rag; this is the guarantee, since
 * browsers apply pretty only as a heuristic.
 * @param {string} text
 */
export function tieLastWords(text) {
  return String(text).replace(/ (\S+)$/, "\u00a0$1");
}

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** @param {string | undefined} id */
export function climberName(id) {
  return CLIMBERS.find((c) => c.id === id)?.name ?? "Any climber";
}

/** @param {number} ms */
export function formatWait(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Same room for everyone in a party: picked from the match id. */
function roomFor(matchId) {
  let h = 0;
  for (const ch of String(matchId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return STAGE_BACKDROPS[h % STAGE_BACKDROPS.length];
}

function spriteHtml(id, extraClass = "") {
  const art = id ? STAGE_ACTOR_ART[id] : null;
  if (!art || art.kind !== "climber") {
    return `<span class="cp-figure-blank ${extraClass}" aria-hidden="true">?</span>`;
  }
  return `<img class="cp-figure-img ${extraClass}" src="${esc(art.src)}" width="${art.width}" height="${art.height}" alt="" loading="lazy" decoding="async">`;
}

/**
 * The host's crown, over the head of whoever hosts (a blank figure wears it
 * in the middle). It stands on the figure, not in the name tag, so a tag is
 * only ever as wide as its name.
 * @param {string | undefined} id the host's climber
 */
function crownHtml(id) {
  const art = id ? STAGE_ACTOR_ART[id] : null;
  const drawn = Boolean(art && art.kind === "climber");
  const x = drawn ? (HEAD_X[/** @type {keyof typeof HEAD_X} */ (id)] ?? 0.5) : 0.5;
  return `<span class="cp-crown${drawn ? "" : " cp-crown--blank"}" style="left:${pct(x)}" title="Host">${ICON.crown}<span class="cp-sr">Host</span></span>`;
}

function avatarHtml(member) {
  if (member.avatar) {
    return `<img class="cp-avatar" src="${esc(member.avatar)}" width="28" height="28" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  const initial = esc((member.name || "?").trim().charAt(0).toUpperCase() || "?");
  return `<span class="cp-avatar cp-avatar--initial" aria-hidden="true">${initial}</span>`;
}

export const ICON = Object.freeze({
  steam: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-9.96 9.04l5.35 2.21a2.83 2.83 0 0 1 1.6-.49l2.39-3.46v-.05a3.78 3.78 0 1 1 3.78 3.78h-.09l-3.4 2.43a2.84 2.84 0 0 1-5.62.6L2.3 14.5A10 10 0 1 0 12 2Zm-4.73 15.17-1.23-.51a2.13 2.13 0 1 0 1.17-2.9l1.27.52a1.57 1.57 0 1 1-1.2 2.9Zm10.04-7.72a2.52 2.52 0 1 0-2.52 2.52 2.52 2.52 0 0 0 2.52-2.52Zm-4.4 0a1.89 1.89 0 1 1 1.89 1.89 1.89 1.89 0 0 1-1.9-1.89Z"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  crown: `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>`,
  link: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
  discord: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>`,
});

// MARK: - Share to Discord

/**
 * The button that copies a Discord post (lib/coop-play-share.js). The card
 * shows it only while a friend could still take a seat; the "Bring someone"
 * panel under the card (coop-play-more.js) always has one. For a moment
 * after a tap it says what just happened instead.
 * @param {string | undefined} shared what the last tap did: "copied", "shared" or neither
 */
export function shareButtonHtml(shared) {
  const done = shared === "copied" ? "Post copied" : shared === "shared" ? "Shared" : "";
  // Both faces sit in one grid cell (coop-play.css), so the button keeps the
  // width of its label while it says what happened and its neighbours stay put.
  return `<button type="button" class="cp-btn cp-btn--discord${done ? " is-done" : ""}" data-cp="share" data-analytics-cta="coop-share">
      <span class="cp-share-face">${ICON.discord}<span>Share to Discord</span></span>
      ${done ? `<span class="cp-share-face cp-share-face--done"><span class="cp-btn-done">${ICON.check}</span><span>${done}</span></span>` : ""}
    </button>`;
}

// MARK: - Live line

/**
 * The honest live line. Counts only the chosen branch, because players on
 * the other branch cannot join you.
 */
export function liveLineHtml(view, branch) {
  const looking = view?.lookingByBranch?.[branch] ?? 0;
  const playing = view?.playingCount ?? 0;
  if (looking > 0) {
    const who = looking === 1 ? "1 player is" : `${looking} players are`;
    return `<p class="cp-live cp-live--on"><span class="cp-live-dot" aria-hidden="true"></span>${tieLastWords(`${who} looking right now. Tap Play to team up.`)}</p>`;
  }
  const tail = playing > 0 ? ` ${playing} ${playing === 1 ? "player is" : "players are"} in a party right now.` : "";
  return `<p class="cp-live"><span class="cp-live-dot" aria-hidden="true"></span>${tieLastWords(`Nobody's looking yet. Tap Play and you'll be matched with the next person who does.${tail}`)}</p>`;
}

// MARK: - Idle

/**
 * @param {{ view: any, me: any, prefs: { character?: string, branch: "stable"|"beta" }, push: { supported: boolean, on: boolean, reason?: string }, busy: boolean, around?: { inGame: number, faces: Array<{ name: string, avatar?: string }> } }} m
 */
export function idleHtml(m) {
  const { prefs } = m;
  const choices = CLIMBERS.filter((c) => !c.beta || prefs.branch === "beta");
  const pick = [
    `<button type="button" class="cp-pick-opt cp-pick-opt--any" role="radio" aria-checked="${!prefs.character}" data-cp-pick="">
       <span class="cp-pick-art"><span class="cp-figure-blank" aria-hidden="true">?</span></span>
       <span class="cp-pick-name">Any</span>
     </button>`,
    ...choices.map(
      (c) => `<button type="button" class="cp-pick-opt" role="radio" aria-checked="${prefs.character === c.id}" data-cp-pick="${c.id}">
         <span class="cp-pick-art">${spriteHtml(c.id)}</span>
         <span class="cp-pick-name">${PICK_NAME_BREAKS[c.id] ?? esc(c.name)}</span>
       </button>`,
    ),
  ].join("");

  // In the how-to steps a no-break space ties each step's last two words, so
  // a step never ends on "Steam" or "STS2" alone (WebKit's balance can leave one).
  return `
    <div class="cp-card cp-card--idle">
      <div class="cp-main">
        <header class="cp-head">
          <p class="cp-eyebrow">Co-op &middot; Slay the Spire 2</p>
          <h2 class="cp-title" id="cp-title">Play co-op</h2>
          ${liveLineHtml(m.view, prefs.branch)}
        </header>

        <div class="cp-field cp-field--pick">
          <p class="cp-label" id="cp-pick-label">Your climber</p>
          <div class="cp-pick" style="--cp-pick-n:${choices.length + 1}" data-cp-n="${choices.length + 1}" role="radiogroup" aria-labelledby="cp-pick-label">${pick}</div>
        </div>

        <div class="cp-field">
          <p class="cp-label" id="cp-branch-label">Game version</p>
          <div class="cp-branch" role="radiogroup" aria-labelledby="cp-branch-label">
            <button type="button" role="radio" class="cp-branch-opt" aria-checked="${prefs.branch === "stable"}" data-cp-branch="stable">Stable</button>
            <button type="button" role="radio" class="cp-branch-opt" aria-checked="${prefs.branch === "beta"}" data-cp-branch="beta">Beta branch</button>
          </div>
        </div>

        <button type="button" class="cp-play" data-cp="play" data-analytics-cta="coop-play" ${m.busy ? "disabled" : ""}>
          ${ICON.play}<span>Play</span>
        </button>

        ${pingAreaHtml(m)}
      </div>

      <div class="cp-side">
        ${soloScene(m.me, prefs.character, false, skyHtml(m.view, prefs.branch, m.around))}
        <ol class="cp-howto" aria-label="How co-op works">
          <li><span class="cp-howto-n">1</span><span>Tap&nbsp;Play</span></li>
          <li><span class="cp-howto-n">2</span><span>Add each other on&nbsp;Steam</span></li>
          <li><span class="cp-howto-n">3</span><span>Play together in&nbsp;STS2</span></li>
        </ol>
      </div>
    </div>`;
}

/** How long a search lasts after you step away, with pings on (Backend STAY_CHOICES_MIN). */
export const STAY_CHOICES = Object.freeze([
  { min: 30, label: "30 min", phrase: "30 minutes" },
  { min: 60, label: "1 hour", phrase: "an hour" },
  { min: 120, label: "2 hours", phrase: "two hours" },
]);
export const DEFAULT_STAY_MIN = 60;

function stayPhrase(min) {
  return (STAY_CHOICES.find((c) => c.min === min) ?? STAY_CHOICES[1]).phrase;
}

/**
 * The ping switch, and once something can ping you: how long to keep looking
 * after you step away, and which devices get the pings.
 * @param {{ push: { supported: boolean, on: boolean, here?: boolean, account?: boolean, reason?: string }, prefs: { stay?: number }, devices?: Array<{ id: string, label: string }>, thisDevice?: string, devicesOpen?: boolean }} m
 */
function pingAreaHtml(m) {
  const { push } = m;
  const toggle = push.supported
    ? `
    <label class="cp-ping">
      <input type="checkbox" class="cp-ping-input" data-cp="ping" ${push.on ? "checked" : ""}>
      <span class="cp-ping-switch" aria-hidden="true"></span>
      <span class="cp-ping-text">${ICON.bell}<span>Ping me when someone's looking or I'm matched, even with this tab&nbsp;closed</span></span>
    </label>`
    : push.account
      ? `<p class="cp-ping cp-ping--off">${ICON.bell}<span>${esc(tieLastWords("This browser can't show pings, but your other devices will get them."))}</span></p>`
      : `<p class="cp-ping cp-ping--off">${ICON.bell}<span>${esc(tieLastWords(push.reason || "This browser can't ping you, so keep the tab open while you wait."))}</span></p>`;
  if (!push.account) return toggle;
  return `${toggle}${stayFieldHtml(m.prefs.stay ?? DEFAULT_STAY_MIN)}${devicesHtml(m.devices ?? [], m.thisDevice ?? "", Boolean(m.devicesOpen))}`;
}

function stayFieldHtml(stay) {
  const opts = STAY_CHOICES.map(
    (c) => `<button type="button" role="radio" class="cp-branch-opt cp-stay-opt" aria-checked="${stay === c.min}" data-cp-stay="${c.min}">${c.label}</button>`,
  ).join("");
  return `
    <div class="cp-field cp-field--stay">
      <p class="cp-label" id="cp-stay-label">If you step away, keep looking for</p>
      <div class="cp-branch cp-stay" role="radiogroup" aria-labelledby="cp-stay-label">${opts}</div>
    </div>`;
}

/** "this browser", "this browser and Safari on iPhone", "3 devices". */
function devicesSummary(devices, thisDevice) {
  const names = devices.map((d) => (d.id === thisDevice ? "this browser" : d.label));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} devices`;
}

function devicesHtml(devices, thisDevice, open) {
  if (devices.length === 0) return "";
  const rows = devices
    .map((d) => {
      const here = d.id === thisDevice;
      return `
        <li class="cp-device">
          <span class="cp-device-who">
            <span class="cp-device-name">${esc(d.label)}</span>
            ${here ? `<span class="cp-device-here">This browser</span>` : ""}
          </span>
          <button type="button" class="cp-btn cp-btn--quiet cp-device-remove" data-cp="device-remove" data-device="${esc(d.id)}" aria-label="Stop pings on ${esc(here ? "this browser" : d.label)}">Remove</button>
        </li>`;
    })
    .join("");
  return `
    <details class="cp-help cp-devices"${open ? " open" : ""}>
      <summary>Pings go to ${esc(devicesSummary(devices, thisDevice))}</summary>
      <ul class="cp-devices-list">${rows}</ul>
      <p>${esc(tieLastWords("Turn pings on in SpireVault on your phone or another computer and it joins this list."))}</p>
    </details>`;
}

// MARK: - Searching

const NOTICE_TEXT = Object.freeze({
  partner_left: "Your partner left before the run started. You're back in line at your old spot.",
  host_changed: "The host left. The player who waited longest is the new host.",
  expired: "You were away too long, so you left the line.",
});

function noticeHtml(view) {
  const text = view.notice ? NOTICE_TEXT[view.notice] : "";
  return text ? `<p class="cp-notice" role="status">${esc(text)}</p>` : "";
}

/**
 * @param {{ view: any, me: any, push: { supported: boolean, on: boolean, here?: boolean, account?: boolean }, now: number, shared?: "" | "copied" | "shared", around?: { inGame: number, faces: Array<{ name: string, avatar?: string }> } }} m
 */
export function searchingHtml(m) {
  const t = m.view.ticket;
  const wait = formatWait(m.now - (t?.createdAt ?? m.now));
  // The server says whether this search has pings (any device) and how long
  // it keeps going after you leave the page.
  const pinged = Boolean(t?.push);
  const stay = stayPhrase(Math.round((t?.stayMs ?? DEFAULT_STAY_MIN * 60_000) / 60_000));
  const hint = pinged
    ? `We'll ping ${m.push.on ? "you" : "your other devices"} the moment someone joins. You can close this tab: we keep looking for ${stay} after you leave it.`
    : "Keep this tab open. You'll hear a chime when someone joins.";
  const others = Math.max(0, (m.view.lookingByBranch?.[t?.branch ?? "stable"] ?? 1) - 1);
  return `
    <div class="cp-card cp-card--searching">
      <div class="cp-main">
        ${noticeHtml(m.view)}
        <header class="cp-head">
          <p class="cp-eyebrow">${esc(climberName(t?.character))} &middot; ${t?.branch === "beta" ? "Beta branch" : "Stable"}</p>
          <h2 class="cp-title" id="cp-title">Looking for a partner&hellip;</h2>
        </header>
        <p class="cp-timer"><span class="cp-live-dot" aria-hidden="true"></span><span data-cp-timer aria-label="Time waiting">${wait}</span></p>
        <p class="cp-hint">${esc(hint)}</p>
        ${others > 0 ? `<p class="cp-hint">${others} other ${others === 1 ? "player is" : "players are"} waiting too.</p>` : ""}
        <div class="cp-actions">
          ${canShare(m.view) ? shareButtonHtml(m.shared) : ""}
          ${m.push.supported && !pinged ? `<button type="button" class="cp-btn" data-cp="ping-on">${ICON.bell}<span>Ping me instead</span></button>` : ""}
          <button type="button" class="cp-btn cp-btn--quiet" data-cp="cancel" data-analytics-cta="coop-cancel">Stop looking</button>
        </div>
      </div>
      <div class="cp-side">
        ${soloScene(m.me, t?.character, true, skyHtml(m.view, t?.branch ?? "stable", m.around))}
      </div>
    </div>`;
}

// MARK: - Party (matched / in game)

/**
 * The party standing in a game room. Everyone in a party sees the same room
 * (picked from the match id); before a match it's picked from your Steam ID.
 * @param {{ seed: string, members: Array<any>, openSeats: number, searching?: boolean, sky?: string }} m
 */
function sceneHtml(m) {
  const room = roomFor(m.seed);
  const figures = m.members
    .map(
      (mem) => `
      <figure class="cp-climber${mem.isYou ? " is-you" : ""}${mem.isHost ? " is-host" : ""}">
        <span class="cp-climber-art">${seatStoneHtml(mem.character)}${spriteHtml(mem.character)}${mem.isHost ? crownHtml(mem.character) : ""}</span>
        <figcaption class="cp-tag">
          ${avatarHtml(mem)}
          <span class="cp-tag-name">${esc(mem.name)}</span>
        </figcaption>
      </figure>`,
    )
    .join("");
  const seats = Array.from({ length: Math.max(0, m.openSeats) })
    .map(() => `<span class="cp-seat" aria-hidden="true"><span class="cp-seat-mark">+</span></span>`)
    .join("");
  // The room is a picture: only the sign in its sky (when there is one) is read out.
  const classes = `cp-scene${m.searching ? " is-searching" : ""}${m.sky ? " has-sky" : ""}`;
  return `
    <div class="${classes}" style="--cp-foot:${room.foot}"${m.sky ? "" : ` aria-hidden="true"`}>
      <img class="cp-scene-room" src="${esc(room.planes.base)}" width="${room.width}" height="${room.height}" alt="" decoding="async">
      ${room.planes.front ? `<img class="cp-scene-room cp-scene-front" src="${esc(room.planes.front)}" width="${room.width}" height="${room.height}" alt="" decoding="async">` : ""}
      <span class="cp-scene-veil" aria-hidden="true"></span>
      ${m.sky ?? ""}
      <div class="cp-scene-floor" style="--cp-sum:${floorSum(m.members, Math.max(0, m.openSeats))}" aria-hidden="true">${figures}${seats}</div>
    </div>`;
}

// MARK: - Right now, in the sky

/** Faces on the sign before the rest become "+N": wide rooms, and phones. */
const SKY_FACES = 4;
const SKY_FACES_NARROW = 2;

/**
 * The sign in the sky of your room before a match: who is looking on your
 * game version, who is in a party, and who Steam shows in Slay the Spire 2
 * right now, with their faces. Before a match the seats stand low in a tall
 * room, and the sky above them was bare; this puts the people who are
 * actually around up there. `around` is the app's own roster poll
 * (script.js pullFeed), without you. Each count carries the live dot: grey
 * at zero, green when someone is there. Long labels give way to short ones
 * in a narrow room (coop-play.css), so no label wraps or is cut.
 * @param {any} view the server's Play view
 * @param {"stable"|"beta"} branch the game version you picked
 * @param {{ inGame: number, faces: Array<{ name: string, avatar?: string }> }} around
 */
export function skyHtml(view, branch, around) {
  const other = branch === "beta" ? "stable" : "beta";
  const looking = view?.lookingByBranch?.[branch] ?? 0;
  const elsewhere = view?.lookingByBranch?.[other] ?? 0;
  const playing = view?.playingCount ?? 0;
  const inGame = Math.max(0, around?.inGame ?? 0);
  const faces = (around?.faces ?? []).slice(0, Math.min(SKY_FACES, inGame));
  const versionName = (b) => (b === "beta" ? "Beta" : "Stable");
  const lookingLong = `looking on ${versionName(branch)}${elsewhere > 0 ? `, ${elsewhere} on ${versionName(other)}` : ""}`;
  // Every count stands alone, centred over its label. The faces lead the
  // STS2 label in place of its live dot ("4" over "[faces] in STS2"), so all
  // three numbers line up.
  const item = (n, long, short, faces = "") => `
        <li class="cp-sky-item${n > 0 ? " is-on" : ""}${faces ? " has-faces" : ""}">
          <span class="cp-sky-count"><b class="cp-sky-n">${n}</b></span>
          <span class="cp-sky-label">${faces}<span class="cp-live-dot" aria-hidden="true"></span><span class="cp-sky-long">${long}</span><span class="cp-sky-brief">${short}</span></span>
        </li>`;
  const more = (shown, cls) => (inGame > shown ? `<span class="cp-sky-more ${cls}">+${inGame - shown}</span>` : "");
  const faceRow = faces.length
    ? `<span class="cp-sky-faces" title="${esc(faces.map((f) => f.name).filter(Boolean).join(", "))}" aria-hidden="true">${faces
        .map((f, i) => `<span class="cp-sky-face${i >= SKY_FACES_NARROW ? " cp-sky-wide" : ""}">${avatarHtml(f)}</span>`)
        .join("")}${more(faces.length, "cp-sky-wide")}${more(Math.min(faces.length, SKY_FACES_NARROW), "cp-sky-tight")}</span>`
    : "";
  return `
    <div class="cp-sky">
      <p class="cp-sky-title" aria-hidden="true">Right now</p>
      <ul class="cp-sky-list" aria-label="Right now">
        ${item(looking, lookingLong, "looking")}
        ${item(playing, "in a party", "in a party")}
        ${item(inGame, "in Slay the Spire 2", "in STS2", faceRow)}
      </ul>
    </div>`;
}

// MARK: - Name tags

/** Space between neighbouring name tags, and from a tag to the room's frame (CSS px). */
const TAG_GAP_PX = 8;
const TAG_EDGE_PX = 8;
/** The narrowest a tag gets in the tightest room; the name truncates inside it. */
const TAG_MIN_PX = 40;
/** A tag may slide off-centre, but at least this much of it stays over its climber's middle. */
const TAG_HOLD_PX = 12;
/**
 * Gap from the figure's feet down to its tag, and between the two rows when
 * a crowded party stacks its tags (CSS px). The same numbers as
 * --cp-tag-drop and --cp-tag-row-gap in coop-play.css; change them together.
 */
const TAG_DROP_PX = 6;
const TAG_ROW_GAP_PX = 6;
/** On the room while its tags stand in two rows: the floor leaves space for both. */
const STACKED_CLASS = "is-stacked";

/**
 * Sizes the name tags in every party room under `root`. The whole party
 * shares one width: the longest name, whole, whenever the room has space for
 * it. Each tag sits under its climber's feet. Two climbers standing shoulder
 * to shoulder push their tags apart by equal amounts, and a tag by the wall
 * slides inward, so neighbours always keep the same gap and no tag touches,
 * overlaps or leaves the room. Only when the row cannot hold the names at
 * full width does the shared width shrink and the longest name truncate; and
 * when your own name or most of the names would be cut (a full party on a
 * narrow phone), every second tag steps down one row, which doubles the room
 * each name has; the floor then leaves space for both rows (.is-stacked).
 * Runs after every render, whenever a room changes size and whenever a font
 * finishes loading (lib/coop-play.js).
 * @param {ParentNode} root
 */
export function fitPartyTags(root) {
  for (const scene of root.querySelectorAll(".cp-scene")) fitSceneTags(/** @type {HTMLElement} */ (scene));
}

/**
 * The never-decreasing list closest to `values`: every stretch that falls is
 * levelled to its average.
 * @param {number[]} values
 * @returns {number[]}
 */
function levelFalls(values) {
  /** @type {Array<{ sum: number, count: number }>} */
  const start = [];
  const blocks = values.reduce((done, value) => {
    let block = { sum: value, count: 1 };
    let kept = done;
    while (kept.length > 0 && kept[kept.length - 1].sum / kept[kept.length - 1].count > block.sum / block.count) {
      const last = kept[kept.length - 1];
      block = { sum: last.sum + block.sum, count: last.count + block.count };
      kept = kept.slice(0, -1);
    }
    return [...kept, block];
  }, start);
  return blocks.flatMap((block) => Array.from({ length: block.count }, () => block.sum / block.count));
}

/**
 * Left edges for one row of tags, each `width` wide and as near to centred
 * over its climber as the row allows: neighbours keep the gap, the row stays
 * inside the frame. Null when the row cannot fit at this width, or when a tag
 * would have to move off its own climber to make it fit.
 * @param {number[]} centres each climber's middle, left to right
 * @param {number} frameWidth
 * @param {number} width
 * @returns {number[] | null}
 */
function placeRow(centres, frameWidth, width) {
  const pitch = width + TAG_GAP_PX;
  const lowest = TAG_EDGE_PX;
  const highest = frameWidth - TAG_EDGE_PX - width - (centres.length - 1) * pitch;
  if (highest < lowest) return null;
  // With one pitch taken off per place in the row, "neighbours keep the gap"
  // reads "the values never fall": level the falls, then keep the row in the frame.
  const wanted = centres.map((centre, i) => centre - width / 2 - i * pitch);
  const lefts = levelFalls(wanted).map((value, i) => Math.min(highest, Math.max(lowest, value)) + i * pitch);
  const held = lefts.every((left, i) => Math.abs(left + width / 2 - centres[i]) <= width / 2 - TAG_HOLD_PX);
  return held ? lefts : null;
}

/**
 * The widest a shared tag width can be, up to `natural`, with the tags in
 * `rows` rows (every `rows`-th tag shares a row).
 * @param {number[]} centres @param {number} frameWidth @param {number} natural @param {number} rows
 * @returns {{ width: number, lefts: number[] }}
 */
function widestFit(centres, frameWidth, natural, rows) {
  for (let width = natural; width > TAG_MIN_PX; width -= 1) {
    const placed = Array.from({ length: rows }, (_, row) => placeRow(centres.filter((_c, i) => i % rows === row), frameWidth, width));
    if (placed.every((row) => row !== null)) {
      return { width, lefts: centres.map((_c, i) => /** @type {number[]} */ (placed[i % rows])[Math.floor(i / rows)]) };
    }
  }
  return { width: TAG_MIN_PX, lefts: centres.map((centre) => centre - TAG_MIN_PX / 2) };
}

/** @param {HTMLElement} scene */
function fitSceneTags(scene) {
  const tags = /** @type {HTMLElement[]} */ ([...scene.querySelectorAll(".cp-climber > .cp-tag")]);
  if (!tags.length) return;
  const frame = scene.getBoundingClientRect();
  if (frame.width === 0) return; // a hidden tab: fitted again when it shows
  scene.classList.remove(STACKED_CLASS);
  for (const tag of tags) {
    tag.style.width = "max-content";
    tag.style.minWidth = "";
    tag.style.top = "";
    tag.style.transform = "";
  }
  // The band the floor keeps under the feet is as tall as a tag really is.
  // A reader's larger text makes a tag taller than the stylesheet's figure,
  // and a second row of taller tags would run out of the room.
  const tagHeight = Math.ceil(Math.max(...tags.map((tag) => tag.getBoundingClientRect().height)));
  scene.style.setProperty("--cp-tag-h", `${tagHeight}px`);
  // Measured in fractions and rounded up, with a pixel to spare: a tag a
  // third of a pixel narrower than its name is drawn with an ellipsis.
  const needs = tags.map((tag) => Math.ceil(tag.getBoundingClientRect().width));
  const natural = Math.max(...needs) + 1;
  const middles = () =>
    tags.map((tag) => {
      const box = /** @type {HTMLElement} */ (tag.parentElement).getBoundingClientRect();
      return box.left + box.width / 2 - frame.left;
    });
  let centres = middles();
  let fit = widestFit(centres, frame.width, natural, 1);
  const you = tags.findIndex((tag) => tag.parentElement?.classList.contains("is-you"));
  const cut = needs.filter((need) => need > fit.width).length;
  const staggered = tags.length >= 3 && ((you >= 0 && needs[you] > fit.width) || cut * 2 > tags.length);
  if (staggered) {
    // Two rows under the feet need a taller band: the floor rises, the
    // figures shrink with it, so everyone's middle is measured again.
    scene.classList.add(STACKED_CLASS);
    centres = middles();
    fit = widestFit(centres, frame.width, natural, 2);
  }
  const drop = TAG_DROP_PX + tagHeight + TAG_ROW_GAP_PX;
  const roomy = fit.width >= natural;
  tags.forEach((tag, i) => {
    // With room for every name the width is only a floor: a name that grows
    // afterwards (a web font landing late) widens its tag instead of being cut.
    if (roomy) tag.style.minWidth = `${fit.width}px`;
    else tag.style.width = `${fit.width}px`;
    const shift = Math.round((fit.lefts[i] - (centres[i] - fit.width / 2)) * 10) / 10;
    if (shift) tag.style.transform = `translateX(calc(-50% + ${shift}px))`;
    if (staggered && i % 2 === 1) tag.style.top = `calc(100% + ${drop}px)`;
  });
}

/**
 * A room with these climbers standing in it, each tagged with the climber's
 * name. Used by "Your co-op climbs" (coop-play-more.js), where a party is a
 * set of climbers from a save file and there are no player names to show.
 * @param {Array<string | null>} party @param {string} seed picks the room
 */
export function partySceneHtml(party, seed) {
  return sceneHtml({
    seed,
    members: party.map((c, i) => ({ sid: `climber-${i}`, name: c ? climberName(c) : "Unknown", character: c ?? undefined })),
    openSeats: 0,
  });
}

/** One climber's sprite at list size (a dashed blank when the climber is unknown). */
export function miniClimberHtml(id) {
  return spriteHtml(id ?? undefined, "cp-mini");
}

/** You, alone, before a match, with who is around right now in the sky. */
function soloScene(me, character, searching, sky) {
  return sceneHtml({
    seed: me?.sid || "spirevault",
    members: [{ sid: me?.sid, name: me?.name || "You", avatar: me?.avatar, character, isYou: true }],
    openSeats: MAX_PARTY - 1,
    searching,
    sky,
  });
}

function matchScene(match) {
  return sceneHtml({
    seed: match.matchId,
    members: match.members,
    openSeats: match.locked ? 0 : MAX_PARTY - match.members.length,
  });
}

function steamAddButtons(match) {
  const you = match.members.find((m) => m.isYou);
  const targets = match.youAreHost
    ? match.members.filter((m) => !m.isYou)
    : match.members.filter((m) => m.isHost);
  return targets
    .map(
      (t) => `<button type="button" class="cp-btn cp-btn--steam" data-cp="steam-add" data-sid="${esc(t.sid)}" data-analytics-cta="coop-steam-add">
        ${ICON.steam}<span>Add ${esc(t.name)}</span>${you?.steamAdded ? `<span class="cp-btn-done">${ICON.check}</span>` : ""}
      </button>`,
    )
    .join("");
}

/** @param {{ view: any, shared?: "" | "copied" | "shared" }} m */
export function partyHtml(m) {
  const match = m.view.match;
  const share = canShare(m.view) ? shareButtonHtml(m.shared) : "";
  const host = match.members.find((x) => x.isHost);
  const you = match.members.find((x) => x.isYou);
  const branch = match.branch === "beta" ? "Beta branch" : "Stable";
  const seats = match.seatsLeft > 0
    ? `Up to ${match.seatsLeft} more can join until the host starts the run.`
    : "The party is full.";
  // Someone pinged while away tapped "On my way" on the ping: say so, so
  // the others wait for them instead of leaving.
  const coming = match.members.filter((x) => x.coming && !x.isYou).map((x) => x.name);
  const comingLine = coming.length
    ? `<p class="cp-live cp-live--on cp-coming" role="status"><span class="cp-live-dot" aria-hidden="true"></span><span>${esc(coming.length === 1 ? coming[0] : `${coming.slice(0, -1).join(", ")} and ${coming[coming.length - 1]}`)} ${coming.length === 1 ? "is" : "are"} on the way.</span></p>`
    : "";

  const startText = match.youAreHost
    ? "Open STS2, choose Multiplayer, then Host. Tap the button below once you're on character select."
    : `Open STS2, choose Multiplayer, then Join, and pick ${esc(host?.name ?? "the host")}.`;
  const hostingLine = !match.youAreHost
    ? `<p class="cp-step-status${match.hostHosting ? " is-ready" : ""}">${match.hostHosting ? `${ICON.check}${esc(host?.name ?? "The host")} is hosting now. Refresh the Join list.` : `Waiting for ${esc(host?.name ?? "the host")} to host&hellip;`}</p>`
    : "";

  return `
    <div class="cp-card cp-card--party">
      <div class="cp-main">
      ${noticeHtml(m.view)}
      <header class="cp-head">
        <p class="cp-eyebrow">Party found &middot; ${branch}</p>
        <h2 class="cp-title" id="cp-title">You're in a party</h2>
        <p class="cp-sub">${esc(seats)}</p>
        ${comingLine}
        ${share ? `<div class="cp-actions cp-invite">${share}</div>` : ""}
      </header>
      <ol class="cp-steps">
        <li class="cp-step${you?.steamAdded ? " is-done" : ""}">
          <span class="cp-step-n">1</span>
          <div class="cp-step-body">
            <h3 class="cp-step-title">Add each other on Steam</h3>
            <p class="cp-step-text">STS2 only lets Steam friends join. ${match.youAreHost ? "Add each player below; they'll add you too." : "Add the host; they'll add you too."} When you both press Add, you become friends.</p>
            <div class="cp-step-actions">${steamAddButtons(match)}</div>
          </div>
        </li>
        <li class="cp-step${match.hostHosting ? " is-done" : ""}">
          <span class="cp-step-n">2</span>
          <div class="cp-step-body">
            <h3 class="cp-step-title">${match.youAreHost ? "Host the game" : "Join the host"}</h3>
            <p class="cp-step-text">${startText}</p>
            <div class="cp-step-actions">
              <a class="cp-btn" href="steam://run/2868840" data-cp="launch" data-analytics-cta="coop-launch">${ICON.play}<span>Launch STS2</span></a>
              ${match.youAreHost && !match.hostHosting ? `<button type="button" class="cp-btn" data-cp="hosting">I'm hosting</button>` : ""}
            </div>
            ${hostingLine}
          </div>
        </li>
        <li class="cp-step">
          <span class="cp-step-n">3</span>
          <div class="cp-step-body">
            <h3 class="cp-step-title">Start the run</h3>
            <p class="cp-step-text">${match.youAreHost ? "Once everyone's in your lobby, start the run and tap We're in." : "Tap We're in once you're in the host's lobby."}</p>
            <div class="cp-step-actions">
              <button type="button" class="cp-btn cp-btn--primary" data-cp="in-game" data-analytics-cta="coop-in-game">We're in</button>
            </div>
          </div>
        </li>
      </ol>
      <div class="cp-foot">
        <details class="cp-help">
          <summary>STS2 says "No friends currently playing multiplayer"?</summary>
          <p>Open Steam and accept the friend request (or send one back), then go back to Multiplayer &rarr; Join and refresh once the host is on character select. Both of you need to be on the same game version.</p>
        </details>
        <div class="cp-actions">
          <button type="button" class="cp-btn cp-btn--quiet" data-cp="leave">Leave party</button>
        </div>
      </div>
      </div>
      <div class="cp-side">${matchScene(match)}</div>
    </div>`;
}

/** @param {{ view: any }} m */
export function inGameHtml(m) {
  return `
    <div class="cp-card cp-card--ingame">
      <div class="cp-main">
      <header class="cp-head">
        <p class="cp-eyebrow">In the Spire</p>
        <h2 class="cp-title" id="cp-title">Have a good climb</h2>
        <p class="cp-sub">You're playing with ${esc(m.view.match.members.filter((x) => !x.isYou).map((x) => x.name).join(", ") || "your party")}.</p>
      </header>
      <div class="cp-actions">
        <button type="button" class="cp-btn" data-cp="leave">Done, back to co-op</button>
      </div>
      </div>
      <div class="cp-side">${matchScene(m.view.match)}</div>
    </div>`;
}

/** A /party/<id> link to a party that no longer exists (or isn't yours). */
export function endedHtml() {
  return `
    <div class="cp-card cp-card--ended">
      <header class="cp-head">
        <p class="cp-eyebrow">Co-op</p>
        <h2 class="cp-title" id="cp-title">That party has ended</h2>
        <p class="cp-sub">Parties only last while their players are around. Tap Play to find a new one.</p>
      </header>
      <div class="cp-actions">
        <button type="button" class="cp-play" data-cp="dismiss-ended">${ICON.play}<span>Play co-op</span></button>
      </div>
    </div>`;
}

export function loadingHtml() {
  return `<div class="cp-card cp-card--loading" aria-busy="true"><p class="cp-sub">Checking who's around&hellip;</p></div>`;
}

/** @param {string} message */
export function errorHtml(message) {
  return `
    <div class="cp-card cp-card--error" role="alert">
      <h2 class="cp-title" id="cp-title">Co-op is unreachable</h2>
      <p class="cp-sub">${esc(message)}</p>
      <div class="cp-actions"><button type="button" class="cp-btn" data-cp="retry">Try again</button></div>
    </div>`;
}

/** The small pill on other tabs while you wait or are in a party. */
export function floatHtml(view, now) {
  if (view?.state === "searching") {
    return `<button type="button" class="cp-float" data-cp="goto"><span class="cp-live-dot" aria-hidden="true"></span><span>Looking <span data-cp-timer>${formatWait(now - (view.ticket?.createdAt ?? now))}</span></span></button>
      <button type="button" class="cp-float-x" data-cp="cancel" aria-label="Stop looking">&times;</button>`;
  }
  if (view?.state === "matched") {
    return `<button type="button" class="cp-float cp-float--found" data-cp="goto"><span class="cp-live-dot" aria-hidden="true"></span><span>Party found &middot; open co-op</span></button>`;
  }
  return "";
}
