#!/usr/bin/env node
/**
 * Offline checks for co-op Play's "Share to Discord":
 *
 *   · lib/coop-play-share.js      the post text, the link, name safety
 *   · functions/_shared/coop-embed.js   the link-preview tags served on /coop
 *
 * Both are plain modules with no imports, so they load straight into Node.
 *
 * Run: node Web/scripts/verify-coop-share.mjs   (part of `make preflight`)
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const Share = await import(join(WEB, "lib", "coop-play-share.js"));
const Embed = await import(join(WEB, "functions", "_shared", "coop-embed.js"));

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`\n  FAILED: ${label}\n  ${err.message}\n`);
    process.exitCode = 1;
  }
}

const NAMES = { silent: "Silent", ironclad: "Ironclad", defect: "Defect", fool: "The Fool" };
const climberName = (id) => NAMES[id] ?? "Any climber";
const ME = { sid: "1", name: "c3rooks" };
const base = { lookingCount: 0, playingCount: 0, lookingByBranch: { stable: 0, beta: 0 } };

const searching = (ticket) => ({ ...base, state: "searching", ticket: { createdAt: 1, branch: "stable", push: false, ...ticket } });
const party = (members, extra = {}) => ({
  ...base,
  state: extra.locked ? "in_game" : "matched",
  match: {
    matchId: "ab".repeat(16), branch: "stable", locked: false, seatsLeft: 4 - members.length,
    members: members.map((m, i) => ({ isYou: i === 0, isHost: i === 0, ...m })),
    ...extra,
  },
});
const post = (view) => Share.discordPost({ view, me: ME, climberName });

// ---- when the button is offered ---------------------------------------------

await check("sharing is offered while looking and in a party with open seats, nowhere else", () => {
  assert.equal(Share.canShare(searching({})), true);
  assert.equal(Share.canShare(party([{ name: "a" }, { name: "b" }])), true);
  assert.equal(Share.canShare(party([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }])), false, "a full party");
  assert.equal(Share.canShare(party([{ name: "a" }, { name: "b" }], { locked: true })), false, "a run already under way");
  assert.equal(Share.canShare({ ...base, state: "idle" }), false, "the card has no Share button before you tap Play");
  assert.equal(Share.canShare(null), false);
});

await check("an invite makes sense at idle too, but never for a full party or a run under way", () => {
  assert.equal(Share.canInvite({ ...base, state: "idle" }), true);
  assert.equal(Share.canInvite(searching({})), true);
  assert.equal(Share.canInvite(party([{ name: "a" }, { name: "b" }])), true);
  const full = party([{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]);
  const started = party([{ name: "a" }, { name: "b" }], { locked: true });
  for (const view of [full, started, null]) {
    assert.equal(Share.canInvite(view), false);
    assert.equal(post(view), null);
  }
});

await check("at idle the post invites without claiming you are in line", () => {
  const idle = { ...base, state: "idle" };
  const beta = Share.discordPost({ view: idle, me: ME, prefs: { branch: "beta", character: "fool" }, climberName });
  assert.equal(
    beta.text,
    [
      "**Slay the Spire 2 co-op** · who's up for a run?",
      "c3rooks wants to climb · The Fool · Beta branch · up to 4 in a party",
      "Tap Play to get matched: https://app.spirevault.app/coop?branch=beta",
    ].join("\n"),
  );
  const plain = Share.discordPost({ view: idle, me: ME, climberName });
  assert.match(plain.text, /c3rooks wants to climb · Any climber · Stable version · up to 4 in a party/);
  assert.match(plain.text, /\?branch=stable$/);
  assert.ok(!/waiting|right now/.test(plain.text), "nothing says you are waiting");
});

await check("the preview is the post as Discord draws it: bold title, names as written", () => {
  const p = post(party([{ name: "c3rooks", character: "silent" }, { name: "**Bob** @here", character: "ironclad" }]));
  assert.deepEqual(p.preview, {
    title: "Slay the Spire 2 co-op",
    tail: "2 seats open",
    who: "c3rooks (Silent) and **Bob** @here (Ironclad) are gathering a party · Stable version",
    cta: "Tap Play to join before the run starts:",
    url: "https://app.spirevault.app/coop?branch=stable",
  });
  assert.match(p.text, /\\\*\\\*Bob\\\*\\\* @\u200bhere \(Ironclad\)/, "the pasted text is the escaped one");
  const s = post(searching({ character: "silent" })).preview;
  assert.deepEqual([s.tail, s.who, s.cta], ["looking for a partner right now", "c3rooks is waiting · Silent · Stable version · 3 seats open", "Tap Play to team up:"]);
});

await check("the preview's link card is the one /coop serves", () => {
  assert.equal(Share.EMBED.title, Embed.COOP_EMBED.title);
  assert.equal(Share.EMBED.description, Embed.COOP_EMBED.description);
  assert.equal(Share.SHARE_ORIGIN + Share.EMBED.image, Embed.COOP_EMBED.image);
});

// ---- the post ------------------------------------------------------------------

await check("while looking: who, climber, game version, seats and the link", () => {
  const p = post(searching({ character: "silent" }));
  assert.equal(
    p.text,
    [
      "**Slay the Spire 2 co-op** · looking for a partner right now",
      "c3rooks is waiting · Silent · Stable version · 3 seats open",
      "Tap Play to team up: https://app.spirevault.app/coop?branch=stable",
    ].join("\n"),
  );
  assert.equal(p.url, "https://app.spirevault.app/coop?branch=stable");
});

await check("the beta branch and 'any climber' are said plainly", () => {
  const p = post(searching({ branch: "beta" }));
  assert.match(p.text, /c3rooks is waiting · Any climber · Beta branch · 3 seats open/);
  assert.match(p.text, /https:\/\/app\.spirevault\.app\/coop\?branch=beta$/);
});

await check("in a party: everyone with their climber, seats left, and the link last", () => {
  const two = post(party([{ name: "c3rooks", character: "silent" }, { name: "Boble", character: "ironclad" }]));
  assert.equal(
    two.text,
    [
      "**Slay the Spire 2 co-op** · 2 seats open",
      "c3rooks (Silent) and Boble (Ironclad) are gathering a party · Stable version",
      "Tap Play to join before the run starts: https://app.spirevault.app/coop?branch=stable",
    ].join("\n"),
  );
  const three = post(
    party([{ name: "c3rooks", character: "fool" }, { name: "Boble" }, { name: "Mako", character: "defect" }], { branch: "beta" }),
  );
  assert.match(three.text, /^\*\*Slay the Spire 2 co-op\*\* · 1 seat open\n/);
  assert.match(three.text, /c3rooks \(The Fool\), Boble and Mako \(Defect\) are gathering a party · Beta branch/);
  assert.match(three.text, /\?branch=beta$/, "nothing follows the link, so Discord reads it whole");
});

// ---- other players' names are untrusted text -----------------------------------

await check("a Steam name cannot ping, format, link or break the post", () => {
  assert.equal(Share.discordSafe("@everyone"), "@\u200beveryone");
  assert.equal(Share.discordSafe("**bold** _it_ ~x~ `c` ||s||"), "\\*\\*bold\\*\\* \\_it\\_ \\~x\\~ \\`c\\` \\|\\|s\\|\\|");
  assert.equal(Share.discordSafe("<@123456> <#9> <t:1:R>"), "@\u200b123456 #9 t:1:R");
  assert.equal(Share.discordSafe("[free](https://evil.example)"), "\\[free\\](https:/\u200b/evil.\u200bexample)");
  assert.equal(Share.discordSafe("discord.gg/abc"), "discord.\u200bgg/abc");
  assert.equal(Share.discordSafe("line\none\ttwo  three"), "line one two three");
  assert.equal(Share.discordSafe("x".repeat(80)).length, 40);
  assert.equal(Share.discordSafe(""), "A player");
  assert.equal(Share.discordSafe(undefined), "A player");

  // A name can open line two, so it must not start a heading, subtext or list.
  assert.equal(Share.discordSafe("# HUGE"), "\\# HUGE");
  assert.equal(Share.discordSafe("### small"), "\\### small");
  assert.equal(Share.discordSafe("-# subtext"), "\\-# subtext");
  assert.equal(Share.discordSafe("- item"), "\\- item");
  assert.equal(Share.discordSafe("+ item"), "\\+ item");
  assert.equal(Share.discordSafe("1. first"), "1\\. first");
  assert.equal(Share.discordSafe("12) twelfth"), "12\\) twelfth");
  // Text-direction controls would flip the rest of the line.
  assert.equal(Share.discordSafe("a\u202Eb\u2066c\u200Fd\u061Ce"), "abcde");
  // Cut on whole characters, never through the middle of an emoji.
  assert.equal(Share.discordSafe("x".repeat(39) + "\u{1F525}\u{1F525}"), "x".repeat(39) + "\u{1F525}");
  assert.equal(Share.discordSafe("next\u0085line"), "next line");

  const hosted = post(party([{ name: "# Loud host" }, { name: "c3rooks" }]));
  assert.match(hosted.text.split("\n")[1], /^\\# Loud host and c3rooks are gathering a party/, "a host's name cannot turn line two into a heading");

  const p = post(party([{ name: "c3rooks" }, { name: "@here\nJoin discord.gg/spam" }]));
  assert.equal(p.text.split("\n").length, 3, "still three lines");
  assert.ok(!/@here/.test(p.text), "no working mention");
  assert.ok(!/discord\.gg\//.test(p.text), "no working invite link");
});

// ---- how it leaves the page ----------------------------------------------------

const fakeEnv = ({ share, clipboard, coarse = false, execCopies = false }) => {
  const calls = { shared: [], copied: [], exec: 0 };
  return {
    calls,
    env: {
      navigator: {
        ...(share ? { share: async (data) => { calls.shared.push(data); return share(data); } } : {}),
        ...(clipboard ? { clipboard: { writeText: async (text) => { calls.copied.push(text); return clipboard(text); } } } : {}),
      },
      window: { matchMedia: () => ({ matches: coarse }) },
      document: {
        body: { appendChild() {}, removeChild() {} },
        createElement: () => ({ style: {}, setAttribute() {}, select() {}, value: "" }),
        execCommand: () => { calls.exec += 1; return execCopies; },
      },
    },
  };
};
const POST = { text: "post text https://app.spirevault.app/coop?branch=stable", url: "https://app.spirevault.app/coop?branch=stable" };

await check("a desktop copies the post; a phone opens the share sheet", async () => {
  const desk = fakeEnv({ share: async () => {}, clipboard: async () => {} });
  assert.equal(await Share.sendPost(POST, desk.env), "copied");
  assert.deepEqual(desk.calls.copied, [POST.text]);
  assert.equal(desk.calls.shared.length, 0, "a mouse-and-keyboard browser never gets the share sheet");

  const phone = fakeEnv({ share: async () => {}, clipboard: async () => {}, coarse: true });
  assert.equal(await Share.sendPost(POST, phone.env), "shared");
  assert.deepEqual(phone.calls.shared, [{ text: POST.text }], "the whole post goes to the sheet, link included");
  assert.equal(phone.calls.copied.length, 0);
});

await check("closing the share sheet is not an error; a broken sheet falls back to copying", async () => {
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const closed = fakeEnv({ share: async () => { throw abort; }, clipboard: async () => {}, coarse: true });
  assert.equal(await Share.sendPost(POST, closed.env), "cancelled");
  assert.equal(closed.calls.copied.length, 0);

  const broken = fakeEnv({ share: async () => { throw new Error("NotAllowedError"); }, clipboard: async () => {}, coarse: true });
  assert.equal(await Share.sendPost(POST, broken.env), "copied");
});

await check("no clipboard API: the old copy command is tried, and failure is reported", async () => {
  const old = fakeEnv({ execCopies: true });
  assert.equal(await Share.sendPost(POST, old.env), "copied");
  assert.equal(old.calls.exec, 1);

  const blocked = fakeEnv({ clipboard: async () => { throw new Error("denied"); }, execCopies: false });
  assert.equal(await Share.sendPost(POST, blocked.env), "failed");
});

await check("Copy link puts just the link on the clipboard", async () => {
  const desk = fakeEnv({ clipboard: async () => {} });
  assert.equal(await Share.copyText(POST.url, desk.env), true);
  assert.deepEqual(desk.calls.copied, [POST.url]);
  const blocked = fakeEnv({ clipboard: async () => { throw new Error("denied"); }, execCopies: false });
  assert.equal(await Share.copyText(POST.url, blocked.env), false);
});

await check("a shared link's game version is read strictly", () => {
  assert.equal(Share.inviteBranch("beta"), "beta");
  assert.equal(Share.inviteBranch("stable"), "stable");
  assert.equal(Share.inviteBranch("nightly"), null);
  assert.equal(Share.inviteBranch(null), null);
});

// ---- the link preview on /coop ---------------------------------------------------

const indexHtml = readFileSync(join(WEB, "index.html"), "utf8");
const metaOf = (html, attr, key) => {
  const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};

await check("the /coop page carries co-op preview tags and is otherwise the same page", () => {
  const out = Embed.withCoopEmbed(indexHtml);
  for (const [attr, key] of [["property", "og:title"], ["name", "twitter:title"]]) {
    assert.equal(metaOf(out, attr, key), Embed.COOP_EMBED.title, key);
  }
  for (const [attr, key] of [["property", "og:description"], ["name", "twitter:description"]]) {
    assert.equal(metaOf(out, attr, key), Embed.COOP_EMBED.description, key);
  }
  for (const [attr, key] of [["property", "og:image"], ["name", "twitter:image"]]) {
    assert.equal(metaOf(out, attr, key), Embed.COOP_EMBED.image, key);
  }
  assert.equal(metaOf(out, "property", "og:url"), Embed.COOP_EMBED.url);
  assert.equal(metaOf(out, "property", "og:image:width"), "1200");
  assert.equal(metaOf(out, "property", "og:image:height"), "630");

  // Nothing but those seven tags changed. The browser-tab title and the
  // search description stay the app's own.
  const before = indexHtml.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length);
  const changed = after.filter((line, i) => line !== before[i]);
  assert.equal(changed.length, 7, `${changed.length} lines changed`);
  assert.ok(changed.every((line) => /<meta (property="og:|name="twitter:)/.test(line)), "only preview tags changed");
  assert.equal(/<title>[^<]*<\/title>/.exec(out)[0], /<title>[^<]*<\/title>/.exec(indexHtml)[0]);
});

await check("the preview text is honest and fits Discord's card", () => {
  const { title, description, image, url } = Embed.COOP_EMBED;
  assert.ok(title.length <= 60, `title is ${title.length} characters`);
  assert.ok(description.length <= 160, `description is ${description.length} characters`);
  assert.equal(url, "https://app.spirevault.app/coop");
  assert.match(image, /^https:\/\/app\.spirevault\.app\/assets\/og-coop-v\d+\.(png|jpg)$/);
  assert.ok(!/["<>&]/.test(title + description), "no characters that need escaping in an attribute");
  const file = join(WEB, new URL(image).pathname);
  assert.ok(existsSync(file), `${file} exists`);
});

const Handler = await import(join(WEB, "functions", "coop.js"));
const serve = (response) => Handler.onRequestGet({ next: async () => response });
const htmlHeaders = {
  "content-type": "text/html; charset=utf-8", "content-length": String(indexHtml.length), etag: '"abc"',
  "content-encoding": "identity", "content-security-policy": "default-src 'self'", "cache-control": "public, max-age=0, must-revalidate",
};

await check("GET /coop serves the page with co-op tags and keeps its own headers", async () => {
  const out = await serve(new Response(indexHtml, { status: 200, headers: htmlHeaders }));
  assert.equal(out.status, 200);
  assert.equal(await out.text(), Embed.withCoopEmbed(indexHtml));
  assert.equal(out.headers.get("content-security-policy"), "default-src 'self'", "security headers pass through");
  assert.equal(out.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.match(out.headers.get("content-type"), /^text\/html/);
  for (const gone of ["etag", "content-encoding"]) assert.equal(out.headers.get(gone), null, `${gone} belonged to the stored file`);
  assert.notEqual(out.headers.get("content-length"), String(indexHtml.length), "the old length is not reused");
});

await check("GET /coop passes anything that is not the page straight through", async () => {
  const notFound = new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
  assert.equal(await serve(notFound), notFound);
  const notModified = new Response(null, { status: 304 });
  assert.equal(await serve(notModified), notModified);
  const json = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  assert.equal(await serve(json), json);
});

await check("a page without the tags comes back untouched", () => {
  assert.equal(Embed.withCoopEmbed("<html><head></head></html>"), "<html><head></head></html>");
});

console.log(`coop-share: ${passed} checks passed${process.exitCode ? " (with failures above)" : ""}`);
