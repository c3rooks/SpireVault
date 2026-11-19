// Co-op Play — "Share to Discord".
//
// Builds a post a player can paste into a Discord channel to bring friends
// into the line or into a party's open seats, and sends it out: the system
// share sheet on phones, the clipboard everywhere else.
//
// The link points at co-op Play itself with the game version preselected.
// There is no link that joins one particular party: Play puts the next
// player into the oldest party gathering on that version, which at this size
// is the sharer's. /party/<id> shows "that party has ended" to anyone who is
// not already in it, so it is never shared.
//
// No imports and nothing touched at module scope, so
// Web/scripts/verify-coop-share.mjs loads this file straight into Node.

/** Where shared links point, whatever host this copy of the app runs on. */
export const SHARE_ORIGIN = "https://app.spirevault.app";

/**
 * The card Discord draws under the link. Same words and picture as the tags
 * Web/functions/_shared/coop-embed.js serves on /coop; the share check fails
 * if the two drift.
 */
export const EMBED = Object.freeze({
  title: "Play Slay the Spire 2 co-op · SpireVault",
  description:
    "Tap Play and get matched with other Slay the Spire 2 players, up to four in a party. Add each other on Steam and climb together. Free.",
  image: "/assets/og-coop-v3.jpg",
});

const TITLE = "Slay the Spire 2 co-op";
const MAX_PARTY = 4;
const NAME_MAX = 40;
/** Zero-width space: breaks a mention or a link without changing how a name reads. */
const ZWSP = "\u200b";
/** Text-direction controls: one of these would flip how the rest of a line reads. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * @typedef {{ name?: string, character?: string, isYou?: boolean }} ShareMember
 * @typedef {{ title: string, tail: string, who: string, cta: string, url: string }} PostPreview
 *   the post as Discord will draw it: `title` in bold, names as written
 * @typedef {{ text: string, url: string, preview: PostPreview }} DiscordPost
 */

/**
 * True while there is a seat a friend could take right now: you are in line,
 * or in a party that has not started and is not full. This is when the Play
 * card itself carries the Share button.
 * @param {any} view the server's Play view
 * @returns {boolean}
 */
export function canShare(view) {
  if (view?.state === "searching") return true;
  return view?.state === "matched" && !view.match?.locked && (view.match?.seatsLeft ?? 0) > 0;
}

/**
 * True whenever a post makes sense: the cases above, and before you tap Play
 * (then it invites without claiming you are in line).
 * @param {any} view
 * @returns {boolean}
 */
export function canInvite(view) {
  return view?.state === "idle" || canShare(view);
}

/**
 * A game version from a shared link, or null for anything else.
 * @param {unknown} raw
 * @returns {"stable" | "beta" | null}
 */
export function inviteBranch(raw) {
  return raw === "stable" || raw === "beta" ? raw : null;
}

/**
 * @param {"stable" | "beta"} branch
 * @param {string} [origin]
 * @returns {string} a link that opens co-op Play on that game version
 */
export function shareUrl(branch, origin = SHARE_ORIGIN) {
  return `${origin}/coop?branch=${branch === "beta" ? "beta" : "stable"}`;
}

/**
 * A Steam name as plain text: one line, no text-direction tricks, no angle
 * brackets, at most 40 characters. This is how the name reads in Discord.
 * @param {unknown} name
 * @returns {string}
 */
function plainName(name) {
  const cleaned = String(name ?? "")
    .replace(BIDI, "")
    .replace(/[\s\u0000-\u001f\u007f\u0085]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
  // By whole characters, so an emoji at the cut is kept or dropped, never halved.
  return Array.from(cleaned).slice(0, NAME_MAX).join("").trim() || "A player";
}

/**
 * A Steam name made safe to sit in a Discord post. Names are other players'
 * text, and the post goes out under the sharer's account, so a name must not
 * be able to ping a channel, format the post, add a link or start a new line.
 * A name can also open a line of the post, so it cannot start a heading,
 * subtext or a list either.
 * @param {unknown} name
 * @returns {string}
 */
export function discordSafe(name) {
  return plainName(name)
    .replace(/[\\*_~`|[\]]/g, "\\$&")
    .replace(/:\/\//g, `:/${ZWSP}/`)
    .replace(/@/g, `@${ZWSP}`)
    .replace(/\.(?=\S)/g, `.${ZWSP}`)
    .replace(/^(?=[#+-])/, "\\")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/** @param {string[]} items @returns {string} "a", "a and b", "a, b and c" */
function listOf(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** @param {number} n */
function seatsOpen(n) {
  return `${n} ${n === 1 ? "seat" : "seats"} open`;
}

/** @param {"stable" | "beta"} branch */
function branchLabel(branch) {
  return branch === "beta" ? "Beta branch" : "Stable version";
}

/**
 * The words of the post for one state. `name` formats a player's name: once
 * escaped for the text that is pasted, once plain for the preview.
 * @param {{ view: any, me: { name?: string } | null, prefs?: { character?: string, branch?: string } | null, climberName: (id?: string) => string }} m
 * @param {(name: unknown) => string} name
 * @returns {{ branch: "stable" | "beta", tail: string, who: string, cta: string }}
 */
function wording({ view, me, prefs, climberName }, name) {
  if (view.state === "idle") {
    const branch = prefs?.branch === "beta" ? "beta" : "stable";
    return {
      branch,
      tail: "who's up for a run?",
      who: `${name(me?.name)} wants to climb · ${[climberName(prefs?.character), branchLabel(branch), `up to ${MAX_PARTY} in a party`].join(" · ")}`,
      cta: "Tap Play to get matched:",
    };
  }
  if (view.state === "searching") {
    const branch = view.ticket?.branch === "beta" ? "beta" : "stable";
    return {
      branch,
      tail: "looking for a partner right now",
      who: `${name(me?.name)} is waiting · ${[climberName(view.ticket?.character), branchLabel(branch), seatsOpen(MAX_PARTY - 1)].join(" · ")}`,
      cta: "Tap Play to team up:",
    };
  }
  const match = view.match;
  const branch = match.branch === "beta" ? "beta" : "stable";
  /** @type {ShareMember[]} */
  const members = Array.isArray(match.members) ? match.members : [];
  const who = members.map((m) => (m.character ? `${name(m.name)} (${climberName(m.character)})` : name(m.name)));
  return {
    branch,
    tail: seatsOpen(match.seatsLeft),
    who: `${listOf(who)} ${who.length === 1 ? "is" : "are"} gathering a party · ${branchLabel(branch)}`,
    cta: "Tap Play to join before the run starts:",
  };
}

/**
 * The post for the state you are in, or null when there is nothing to share
 * (a full party, a run under way). Three lines; the link is always last so
 * Discord unfurls it.
 * @param {{ view: any, me: { name?: string } | null, prefs?: { character?: string, branch?: string } | null, climberName: (id?: string) => string, origin?: string }} m
 * @returns {DiscordPost | null}
 */
export function discordPost(m) {
  if (!canInvite(m.view)) return null;
  const pasted = wording(m, discordSafe);
  const shown = wording(m, plainName);
  const url = shareUrl(pasted.branch, m.origin ?? SHARE_ORIGIN);
  return {
    url,
    text: [`**${TITLE}** · ${pasted.tail}`, pasted.who, `${pasted.cta} ${url}`].join("\n"),
    preview: { title: TITLE, tail: shown.tail, who: shown.who, cta: shown.cta, url },
  };
}

// MARK: - Sending it

/**
 * @typedef {{ navigator: any, window: any, document: any }} ShareEnv
 * @typedef {"shared" | "copied" | "cancelled" | "failed"} ShareOutcome
 */

/** @returns {ShareEnv} */
function pageEnv() {
  return { navigator: globalThis.navigator, window: globalThis.window, document: globalThis.document };
}

/**
 * Phones and tablets have a share sheet that reaches the Discord app
 * directly. A desktop browser may have `navigator.share` too, but there
 * pasting into Discord is the faster path, so touch decides.
 * @param {ShareEnv} env
 */
function prefersShareSheet(env) {
  return typeof env.navigator?.share === "function" && env.window?.matchMedia?.("(pointer: coarse)")?.matches === true;
}

/**
 * Put text on the clipboard. Never throws.
 * @param {string} text
 * @param {ShareEnv} [env]
 * @returns {Promise<boolean>} whether it was copied
 */
export async function copyText(text, env = pageEnv()) {
  try {
    if (env.navigator?.clipboard?.writeText) {
      await env.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked (permissions, an embedded webview): try the old command below */
  }
  try {
    const doc = env.document;
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    doc.body.appendChild(area);
    area.select();
    const done = doc.execCommand("copy") === true;
    doc.body.removeChild(area);
    return done;
  } catch {
    return false;
  }
}

/**
 * Send the post out. Never throws.
 * @param {DiscordPost} post
 * @param {ShareEnv} [env]
 * @returns {Promise<ShareOutcome>}
 */
export async function sendPost(post, env = pageEnv()) {
  if (prefersShareSheet(env)) {
    try {
      // Text only: with a separate `url`, several share targets drop the text.
      await env.navigator.share({ text: post.text });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      /* the sheet refused (no user gesture, unsupported data): copy instead */
    }
  }
  return (await copyText(post.text, env)) ? "copied" : "failed";
}
