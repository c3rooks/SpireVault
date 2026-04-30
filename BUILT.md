# How this was built

Some people on Reddit are (rightly) skeptical of any new project that
shows up looking polished. The pattern is real: someone vibes a
companion app together with an LLM in a weekend, ships it as if a real
team built it, and the community ends up with another half-working
derivative on the pile.

This isn't that, but I can't prove it with prose. So here's the candid
version — what AI helped with, what it didn't, and how you can verify
both yourself.

## What AI did help with

- **First-pass copy** for the marketing site. I wrote the structure and
  the specific examples; an LLM helped me phrase things less awkwardly.
  I read every line and rewrote the parts that sounded like a press
  release. (The "two paths in. Both free." rhythm I kept; the "we
  obsess over your experience" stuff I deleted on sight.)
- **Cloudflare Worker boilerplate.** Routing, KV access patterns,
  TypeScript types for the Steam OpenID response shape. The actual auth
  logic, threat model, and rate-limiting were my decisions, but writing
  the 200 lines of "open the request, switch on the path, return JSON"
  was faster with an assist.
- **Refactors I would have done eventually.** When a SwiftUI view got
  past 400 lines, I'd ask for a structural suggestion, eyeball it,
  apply the parts I agreed with, and discard the rest.
- **README and FAQ phrasing.** Same as above — structure and specifics
  are mine, polish is shared.

## What AI did not do

- **Architecture.** The split between `VaultApp` (SwiftUI), `TheVault`
  (reusable Swift package + CLI), `Backend` (Cloudflare Worker), and
  `Site` / `Web` (static Pages deployments) is mine. So is the decision
  to keep run-history fully local and only put presence on the wire.
- **The threat model.** [SECURITY.md](SECURITY.md) is a thinking
  exercise about what an attacker would actually do, not a generic
  checklist. Things like "what stops someone from heartbeating with a
  forged SteamID" are answered with the specific defense (Steam OpenID
  signature verification on every write, never trusting a SteamID from
  the client) because I sat down and reasoned about it.
- **Product calls.** "Should the run tracker have cloud sync? No, that
  betrays the privacy promise. Should we host the actual game session?
  No, Steam's friend gate is the right primitive. Should the web
  companion have run tracking too? Eventually yes, but only via local
  file picker — never as a backend upload." Nobody else made these
  calls.
- **The choice not to ship a Windows native build.** A weaker version
  of me would have started a Tauri or Electron port to feel
  cross-platform. I shipped the web companion because it's actually
  what Windows users need *today*, and it costs nothing to maintain.
- **Real-world validation.** When the OpenID round-trip silently failed
  in Safari but worked in Chrome, no LLM caught it. I caught it
  because I tested both browsers, swore at my laptop for ten minutes,
  and tracked it down to a cookie SameSite issue. That story is in the
  commit log if you want to read it.

## How you can verify all this yourself

- **Read the code.** `git clone` the repo and skim it. AI-generated code
  has tells: over-abstracted helper functions used once, comments that
  narrate what the code already says, defensive null checks in places
  null can't reach, README sections that describe features that don't
  exist. If you see those, open an issue and call me out.
- **Read the commit history.** Look for fix-up commits, reverts, "oops
  broke X" messages, and small refactors after the fact. AI-only
  projects tend to land as a single immaculate "Initial release" commit
  and never look back. The
  [CHANGELOG](CHANGELOG.md) walks through the iteration in plain
  English.
- **Try it.** Download the
  [v0.1.0 DMG](https://github.com/c3rooks/SpireVault/releases/tag/v0.1.0),
  install it, sign in with Steam, see if the live feed responds. The
  app is the proof.
- **Ask me.** Open an issue, find me on
  [Reddit](https://reddit.com/user/c3rooks)
  or X, whatever. I'll answer technical questions about why something
  is the way it is. If I can't answer, that's the tell.

## On using AI honestly

I'm not interested in pretending AI wasn't involved. Anyone shipping a
solo project in 2026 who claims to write everything from scratch by
hand is either lying or moving too slowly to matter. The honest version
is: AI is a power tool. I used it the way a contractor uses a nail gun
— it makes me faster at the parts I already know how to do, and it
makes me more dangerous on the parts I don't unless I check the work.

For Spire Vault, I checked the work. The architecture, the privacy
posture, the "this is a finder, not a matchmaker" product framing, and
the decision to keep this free forever — those are mine. Everything
else is auditable in this repo.

If you find something that feels off, open an issue. If you want to
fork it and run your own version, the MIT license is at the top of the
repo. That's the whole deal.

— c3rooks
