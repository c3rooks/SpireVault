// Co-op Play — what sits under the Play card.
//
//   · Right now          who is looking on each game version, who is in a party
//   · Bring someone      the Discord post as friends will see it, Share and Copy link
//   · Your co-op climbs  numbers from the player's own saves (lib/coop-climbs.js)
//
// Pure functions: (view model) → HTML string, like coop-play-view.js. Every
// player's name goes through esc() before it reaches the page.

import { esc, tieLastWords, CLIMBERS, ICON, shareButtonHtml, partySceneHtml, miniClimberHtml } from "/lib/coop-play-view.js?v=7";
import { EMBED } from "/lib/coop-play-share.js?v=4";

/** A climber's name; one the app does not know is "Unknown". */
function nameOf(id) {
  return CLIMBERS.find((c) => c.id === id)?.name ?? "Unknown";
}

/**
 * "Defect + Regent + Silent", each name held together with the "+" after it
 * (.cp-party-name is nowrap in coop-play.css), so when the names take two
 * lines on a phone the break comes after a "+", never before it. The text
 * reads the same as a plain join.
 */
function partyNamesHtml(party) {
  return party.map((id, i) => `<span class="cp-party-name">${esc(nameOf(id))}${i < party.length - 1 ? " +" : ""}</span>`).join(" ");
}

/** Pieces of a run's line ("Nov 13", "A8", "Floor 51") that never split inside, nor before their dot. */
function metaLine(pieces) {
  return pieces.filter(Boolean).map((p) => p.replace(/ /g, "\u00a0")).join("\u00a0&middot; ");
}

// MARK: - Right now

/** @param {any} view the server's Play view */
function nowHtml(view) {
  const stable = view.lookingByBranch?.stable ?? 0;
  const beta = view.lookingByBranch?.beta ?? 0;
  const playing = view.playingCount ?? 0;
  // Every count carries the same dot: grey at zero, green when someone is there.
  const item = (n, words) =>
    `<li class="cp-now-item${n > 0 ? " is-on" : ""}"><span class="cp-live-dot" aria-hidden="true"></span><b>${n}</b> ${words}</li>`;
  return `
    <ul class="cp-now" aria-label="Right now">
      <li class="cp-now-label" aria-hidden="true">Right now</li>
      ${item(stable, "looking on Stable")}
      ${item(beta, "looking on Beta")}
      ${item(playing, `${playing === 1 ? "player" : "players"} in a party`)}
    </ul>`;
}

// MARK: - Bring someone

const BRING_LEAD = Object.freeze({
  idle: "Other players aren't always around. Post this where your friends are, then tap Play.",
  searching: "Post this where your friends are. Whoever taps Play first joins you.",
});

/**
 * The Copy link button; for a moment after a tap it says so. Both faces are
 * always in the button (one hidden), so it is as wide as the longer one and
 * never changes size.
 */
function copyLinkButtonHtml(done) {
  return `<button type="button" class="cp-btn cp-btn--flip${done ? " is-done" : ""}" data-cp="copy-link" data-analytics-cta="coop-copy-link">
      <span class="cp-share-face">${ICON.link}<span>Copy link</span></span>
      <span class="cp-share-face cp-share-face--done"><span class="cp-btn-done">${ICON.check}</span><span>Link copied</span></span>
    </button>`;
}

/**
 * @param {{ view: any, post: { url: string, preview: { title: string, tail: string, who: string, cta: string, url: string } } | null, shared: string }} m
 */
/** On screen only (the shared text is untouched): "Slay the Spire 2" never splits before its "2". */
function gameName(text) {
  return text.replace(/Spire 2/g, "Spire\u00a02");
}

function bringHtml(m) {
  if (!m.post) return "";
  const p = m.post.preview;
  const seats = m.view.match?.seatsLeft ?? 0;
  const lead = BRING_LEAD[m.view.state] ?? `${seats} ${seats === 1 ? "seat is" : "seats are"} open. Post this and a friend can take one before the run starts.`;
  return `
    <section class="cp-panel cp-bring" aria-labelledby="cp-bring-title">
      <header class="cp-panel-head">
        <p class="cp-eyebrow">Invite</p>
        <h3 class="cp-panel-title" id="cp-bring-title">Bring someone</h3>
        <p class="cp-sub">${esc(tieLastWords(lead))}</p>
      </header>
      <figure class="cp-post">
        <figcaption class="cp-post-cap">${ICON.discord}<span>What gets posted</span></figcaption>
        <p class="cp-post-line"><b>${esc(gameName(p.title))}</b> &middot; ${esc(p.tail)}</p>
        <p class="cp-post-line">${esc(p.who)}</p>
        <p class="cp-post-line">${esc(p.cta)} <span class="cp-post-link">${esc(p.url)}</span></p>
        <div class="cp-post-embed">
          <p class="cp-post-embed-text"><b>${esc(gameName(EMBED.title))}</b><span>${esc(gameName(EMBED.description))}</span></p>
          <img class="cp-post-art" src="${esc(EMBED.image)}" width="1200" height="630" alt="" loading="lazy" decoding="async">
        </div>
      </figure>
      <div class="cp-actions">
        ${shareButtonHtml(m.shared)}
        ${copyLinkButtonHtml(m.shared === "link")}
      </div>
    </section>`;
}

// MARK: - Your co-op climbs

const RESULT_LABEL = Object.freeze({ won: "Won", lost: "Lost", abandoned: "Abandoned" });

/**
 * What the panel shows while a player has no co-op runs to show: the same
 * shape as real numbers, drawn dimmed under an "Example" tag, so the panel
 * says what it is for instead of sitting empty.
 */
const EXAMPLE_CLIMBS = Object.freeze({
  known: true,
  runs: 12,
  wins: 5,
  abandoned: 1,
  winRate: 5 / 12,
  bestFloor: 51,
  bestParty: Object.freeze({ party: Object.freeze(["ironclad", "silent"]), wins: 3, runs: 5 }),
  recent: Object.freeze([
    Object.freeze({ id: "example-1", when: null, result: "won", floor: 51, ascension: 8, party: Object.freeze(["ironclad", "silent"]) }),
    Object.freeze({ id: "example-2", when: null, result: "lost", floor: 33, ascension: 9, party: Object.freeze(["defect", "regent", "silent"]) }),
    Object.freeze({ id: "example-3", when: null, result: "won", floor: 51, ascension: 6, party: Object.freeze(["necrobinder", "ironclad"]) }),
  ]),
});

/** @param {Date | null} when */
function shortDate(when) {
  return when ? when.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

/** @param {number | null} rate 0–1 */
function percent(rate) {
  return rate === null ? "&ndash;" : `${Math.round(rate * 100)}%`;
}

/** @param {number} n @param {string} one @param {string} many */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The party as sprites, with its climbers named for screen readers. */
function minisHtml(party) {
  return `<span class="cp-minis" role="img" aria-label="${esc(party.map(nameOf).join(", "))}">${party.map((c) => miniClimberHtml(c)).join("")}</span>`;
}

/**
 * Why the panel shows an example, and the way out of it.
 * @param {import("/lib/coop-climbs.js").CoopClimbs | null} climbs
 * @param {boolean} hasRuns whether any saves are loaded at all
 */
function exampleNoteHtml(climbs, hasRuns) {
  const why = !hasRuns
    ? "This is an example. Import your saves to see your own co-op runs here."
    : !climbs?.known
      ? "This is an example. Your saves were last read before co-op parties were counted. Refresh to read them again."
      : "This is an example. Your saves have no co-op runs yet: finish a climb with a party, then refresh.";
  // "co-op" is held on one line (a nowrap span; the text reads the same), so
  // classic never breaks it after its hyphen.
  return `
    <div class="cp-climbs-note">
      <p>${why.replace(/co-op/g, `<span class="cp-nowrap">co-op</span>`)}</p>
      <button type="button" class="cp-btn" data-cp="${hasRuns ? "refresh-saves" : "import-saves"}">${ICON.refresh}<span>${hasRuns ? "Refresh" : "Import saves"}</span></button>
    </div>`;
}

/**
 * The numbers, the party standing in a room, and the latest runs. The room
 * is the part that grows, so the panel fills the height of its neighbour.
 * @param {import("/lib/coop-climbs.js").CoopClimbs} climbs real numbers or the example
 */
function climbsBodyHtml(climbs) {
  const stat = (label, value) => `<div class="cp-stat"><dt>${label}</dt><dd>${value}</dd></div>`;
  // The party with the most wins; before any win, the latest party.
  const best = climbs.bestParty;
  const latest = climbs.recent[0];
  const feature = best
    ? { label: "Most wins together", detail: `${count(best.wins, "win", "wins")} in ${count(best.runs, "run", "runs")}`, party: best.party }
    : { label: "Your latest party", detail: `Floor ${latest.floor}`, party: latest.party };
  const recent = climbs.recent
    .map(
      (r) => `
      <li class="cp-recent-row">
        ${minisHtml(r.party)}
        <span class="cp-recent-names">${partyNamesHtml(r.party)}</span>
        <span class="cp-result cp-result--${r.result}">${RESULT_LABEL[r.result]}</span>
        <span class="cp-recent-meta">${metaLine([esc(shortDate(r.when)), r.ascension === null ? "" : `A${r.ascension}`, `Floor ${r.floor}`])}</span>
      </li>`,
    )
    .join("");
  return `
    <dl class="cp-stats">
      ${stat("Co-op runs", climbs.runs)}
      ${stat("Wins", climbs.wins)}
      ${stat("Win rate", percent(climbs.winRate))}
      ${stat("Best floor", climbs.bestFloor)}
    </dl>
    <div class="cp-best">
      <p class="cp-best-head"><span class="cp-best-label">${feature.label}</span><span class="cp-best-detail">${partyNamesHtml(feature.party)} &middot; ${feature.detail}</span></p>
      ${partySceneHtml(feature.party, feature.party.map((c) => c ?? "unknown").join("-"))}
    </div>
    <ol class="cp-recent" aria-label="Latest co-op runs">${recent}</ol>`;
}

/**
 * @param {{ climbs: import("/lib/coop-climbs.js").CoopClimbs | null, hasRuns: boolean }} m
 */
function climbsHtml(m) {
  const real = m.climbs?.known && m.climbs.runs > 0;
  return `
    <section class="cp-panel cp-climbs${real ? "" : " is-example"}" aria-labelledby="cp-climbs-title">
      <header class="cp-panel-head">
        <p class="cp-eyebrow">From your saves</p>
        <h3 class="cp-panel-title" id="cp-climbs-title">Your co-op climbs${real ? "" : ` <span class="cp-example-tag">Example</span>`}</h3>
      </header>
      ${real ? "" : exampleNoteHtml(m.climbs, m.hasRuns)}
      <div class="cp-climbs-body"${real ? "" : ` aria-label="An example of what shows here"`}>
        ${climbsBodyHtml(real ? m.climbs : EXAMPLE_CLIMBS)}
      </div>
    </section>`;
}

// MARK: - Whole section

/**
 * @param {{ view: any, post: object | null, shared: string, climbs: object | null, hasRuns: boolean }} m
 */
export function moreHtml(m) {
  const bring = bringHtml(m);
  return `
    <div class="cp-more${bring ? "" : " cp-more--solo"}">
      ${nowHtml(m.view)}
      <div class="cp-more-grid">
        ${bring}
        ${climbsHtml(m)}
      </div>
    </div>`;
}
