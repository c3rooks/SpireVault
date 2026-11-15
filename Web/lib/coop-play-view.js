// Co-op Play — markup for each state of the one card on the Co-op tab.
//
// Pure functions: (view model) → HTML string. No fetches, no timers, no DOM
// reads, so every state can be rendered and screenshotted in isolation.
// Every string that came from another player (Steam names, avatars) goes
// through esc() before it reaches the page.

import { STAGE_ACTOR_ART } from "/lib/ui/stage-actors.js?v=1";
import { STAGE_BACKDROPS } from "/lib/ui/stage-backdrops.js?v=1";

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

function avatarHtml(member) {
  if (member.avatar) {
    return `<img class="cp-avatar" src="${esc(member.avatar)}" width="28" height="28" alt="" loading="lazy" referrerpolicy="no-referrer">`;
  }
  const initial = esc((member.name || "?").trim().charAt(0).toUpperCase() || "?");
  return `<span class="cp-avatar cp-avatar--initial" aria-hidden="true">${initial}</span>`;
}

const ICON = Object.freeze({
  steam: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-9.96 9.04l5.35 2.21a2.83 2.83 0 0 1 1.6-.49l2.39-3.46v-.05a3.78 3.78 0 1 1 3.78 3.78h-.09l-3.4 2.43a2.84 2.84 0 0 1-5.62.6L2.3 14.5A10 10 0 1 0 12 2Zm-4.73 15.17-1.23-.51a2.13 2.13 0 1 0 1.17-2.9l1.27.52a1.57 1.57 0 1 1-1.2 2.9Zm10.04-7.72a2.52 2.52 0 1 0-2.52 2.52 2.52 2.52 0 0 0 2.52-2.52Zm-4.4 0a1.89 1.89 0 1 1 1.89 1.89 1.89 1.89 0 0 1-1.9-1.89Z"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5Z"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  crown: `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`,
});

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
    return `<p class="cp-live cp-live--on"><span class="cp-live-dot" aria-hidden="true"></span>${who} looking right now. Tap Play to team up.</p>`;
  }
  const tail = playing > 0 ? ` ${playing} ${playing === 1 ? "player is" : "players are"} in a party right now.` : "";
  return `<p class="cp-live"><span class="cp-live-dot" aria-hidden="true"></span>Nobody's looking yet. Tap Play and you'll be matched with the next person who does.${tail}</p>`;
}

// MARK: - Idle

/**
 * @param {{ view: any, me: any, prefs: { character?: string, branch: "stable"|"beta" }, push: { supported: boolean, on: boolean, reason?: string }, busy: boolean }} m
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
         <span class="cp-pick-name">${esc(c.name)}</span>
       </button>`,
    ),
  ].join("");

  return `
    <div class="cp-card cp-card--idle">
      <div class="cp-main">
        <header class="cp-head">
          <p class="cp-eyebrow">Co-op &middot; Slay the Spire 2</p>
          <h2 class="cp-title" id="cp-title">Play co-op</h2>
          ${liveLineHtml(m.view, prefs.branch)}
        </header>

        <div class="cp-field">
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

        ${pingToggleHtml(m.push)}
      </div>

      <div class="cp-side">
        ${soloScene(m.me, prefs.character, false)}
        <ol class="cp-howto" aria-label="How co-op works">
          <li><span class="cp-howto-n">1</span><span>Tap Play</span></li>
          <li><span class="cp-howto-n">2</span><span>Add each other on Steam</span></li>
          <li><span class="cp-howto-n">3</span><span>Play together in STS2</span></li>
        </ol>
      </div>
    </div>`;
}

function pingToggleHtml(push) {
  if (!push.supported) {
    return `<p class="cp-ping cp-ping--off">${ICON.bell}<span>${esc(push.reason || "This browser can't ping you, so keep the tab open while you wait.")}</span></p>`;
  }
  return `
    <label class="cp-ping">
      <input type="checkbox" class="cp-ping-input" data-cp="ping" ${push.on ? "checked" : ""}>
      <span class="cp-ping-switch" aria-hidden="true"></span>
      <span class="cp-ping-text">${ICON.bell}<span>Ping me when someone's looking or I'm matched, even with this tab closed</span></span>
    </label>`;
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
 * @param {{ view: any, me: any, push: { supported: boolean, on: boolean }, now: number }} m
 */
export function searchingHtml(m) {
  const t = m.view.ticket;
  const wait = formatWait(m.now - (t?.createdAt ?? m.now));
  const hint = m.push.on
    ? "We'll ping you the moment someone joins. You can close this tab."
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
          ${m.push.supported && !m.push.on ? `<button type="button" class="cp-btn" data-cp="ping-on">${ICON.bell}<span>Ping me instead</span></button>` : ""}
          <button type="button" class="cp-btn cp-btn--quiet" data-cp="cancel" data-analytics-cta="coop-cancel">Stop looking</button>
        </div>
      </div>
      <div class="cp-side">
        ${soloScene(m.me, t?.character, true)}
      </div>
    </div>`;
}

// MARK: - Party (matched / in game)

/**
 * The party standing in a game room. Everyone in a party sees the same room
 * (picked from the match id); before a match it's picked from your Steam ID.
 * @param {{ seed: string, members: Array<any>, openSeats: number, searching?: boolean }} m
 */
function sceneHtml(m) {
  const room = roomFor(m.seed);
  const figures = m.members
    .map(
      (mem) => `
      <figure class="cp-climber${mem.isYou ? " is-you" : ""}${mem.isHost ? " is-host" : ""}">
        <span class="cp-climber-art">${seatStoneHtml(mem.character)}${spriteHtml(mem.character)}</span>
        <figcaption class="cp-tag">
          ${avatarHtml(mem)}
          <span class="cp-tag-name">${esc(mem.name)}</span>
          ${mem.isHost ? `<span class="cp-tag-badge" title="Host">${ICON.crown}<span class="cp-sr">Host</span></span>` : ""}
        </figcaption>
      </figure>`,
    )
    .join("");
  const seats = Array.from({ length: Math.max(0, m.openSeats) })
    .map(() => `<span class="cp-seat" aria-hidden="true"><span class="cp-seat-mark">+</span></span>`)
    .join("");
  return `
    <div class="cp-scene${m.searching ? " is-searching" : ""}" style="--cp-foot:${room.foot}" aria-hidden="true">
      <img class="cp-scene-room" src="${esc(room.planes.base)}" width="${room.width}" height="${room.height}" alt="" decoding="async">
      ${room.planes.front ? `<img class="cp-scene-room cp-scene-front" src="${esc(room.planes.front)}" width="${room.width}" height="${room.height}" alt="" decoding="async">` : ""}
      <span class="cp-scene-veil"></span>
      <div class="cp-scene-floor" style="--cp-sum:${floorSum(m.members, Math.max(0, m.openSeats))}">${figures}${seats}</div>
    </div>`;
}

/** You, alone, before a match. */
function soloScene(me, character, searching) {
  return sceneHtml({
    seed: me?.sid || "spirevault",
    members: [{ sid: me?.sid, name: me?.name || "You", avatar: me?.avatar, character, isYou: true }],
    openSeats: MAX_PARTY - 1,
    searching,
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

/** @param {{ view: any }} m */
export function partyHtml(m) {
  const match = m.view.match;
  const host = match.members.find((x) => x.isHost);
  const you = match.members.find((x) => x.isYou);
  const branch = match.branch === "beta" ? "Beta branch" : "Stable";
  const seats = match.seatsLeft > 0
    ? `Up to ${match.seatsLeft} more can join until the host starts the run.`
    : "The party is full.";

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
      <details class="cp-help">
        <summary>STS2 says "No friends currently playing multiplayer"?</summary>
        <p>Open Steam and accept the friend request (or send one back), then go back to Multiplayer &rarr; Join and refresh once the host is on character select. Both of you need to be on the same game version.</p>
      </details>
      <div class="cp-actions">
        <button type="button" class="cp-btn cp-btn--quiet" data-cp="leave">Leave party</button>
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
