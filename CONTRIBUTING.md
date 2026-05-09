# Contributing to Spire Vault

Thanks for taking the time to contribute. This project is intentionally
small and easy to hack on. The whole stack is:

- **`VaultApp/`** — native macOS app (SwiftUI, Xcode 16+)
- **`TheVault/`** — Swift package: `VaultCore` library + `vault` CLI
- **`Backend/`** — Cloudflare Worker (TypeScript) + KV
- **`Site/`** — marketing landing page (static HTML/CSS/JS)
- **`Web/`** — browser companion at `app.spirevault.app` (static HTML/CSS/JS)

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Ways to contribute

- **Report a bug** — use the [Bug report template](.github/ISSUE_TEMPLATE/bug_report.yml).
- **Request a feature** — use the [Feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
- **Send a pull request** — see the [PR workflow](#pull-request-workflow) below.
- **Improve docs** — typos, broken links, and clearer wording are always welcome.
- **Report a security issue** — please don't open a public issue. Follow
  the disclosure process in [SECURITY.md](SECURITY.md) instead.

If you want to add something non-trivial and aren't sure I'd merge it,
**open an issue first** and we'll talk it through. I'd rather say "yes, but
go this way" than have you spend a weekend on something I'd close.

---

## Development setup

### macOS app (`VaultApp/`, `TheVault/`)

```bash
git clone https://github.com/c3rooks/SpireVault.git
cd SpireVault/VaultApp
brew install xcodegen   # one-time, generates the .xcodeproj
make run
```

Requirements:

- Xcode 16 or later (macOS 13+ deployment target)
- `xcodegen` (one Homebrew install away)
- macOS on Apple Silicon or Intel

The CLI lives at `TheVault/` and builds independently with `swift build`
inside that directory.

### Web companion / marketing site (`Web/`, `Site/`)

Both are pure-static — no build step, no `node_modules`. You can serve
them with any static server:

```bash
cd Web      # or: cd Site
python3 -m http.server 8080
# open http://localhost:8080
```

### Backend Worker (`Backend/`)

```bash
cd Backend
npm install
npm run dev          # local Wrangler dev server
npm run typecheck    # tsc --noEmit
```

Deploy uses `wrangler deploy`. You don't need to deploy to develop
against it — point the client at `http://localhost:8787` instead.

---

## Pull request workflow

1. **Fork** the repo and create a topic branch off `main`:
   ```
   git checkout -b feature/short-descriptive-name
   ```
2. **Make focused commits.** One logical change per commit. Imperative
   subject line, ~72 chars, e.g. `web: fix folder picker on Safari`.
3. **Test what you changed.** See [Testing](#testing) below.
4. **Open a PR** against `main`. Fill out the PR template — what changed,
   why, how you tested it, and any screenshots if it's UI work.
5. **Be patient.** I review PRs as I have time. If it's been a week with
   no response, feel free to ping the issue.

Small, well-scoped PRs merge faster than large ones. If you find yourself
touching five sub-projects, split it.

### Things that will get a PR sent back

- New runtime dependencies in `Web/` or `Site/` (both must stay pure-static).
- New analytics, telemetry, or tracking pixels — anywhere.
- Changes that send run history off the user's machine without explicit
  consent. The privacy posture is the product. See [SECURITY.md](SECURITY.md).
- Auto-update / remote code execution paths in the macOS app.

---

## Testing

Run whatever applies to the area you touched:

```bash
# Swift package + CLI
cd TheVault && swift test

# macOS app build sanity
cd VaultApp && make run

# Backend Worker typecheck
cd Backend && npm run typecheck

# Backend live smoke (hits prod)
make smoke
```

If you're adding a new feature, please add or update a test where it
makes sense. The bar isn't 100% coverage — it's "the next person who
touches this won't accidentally break it."

---

## Code style

We don't enforce a formatter via CI; just match the surrounding code.

- **Swift** — follow the existing style in `TheVault/Sources/`. 4-space
  indent, descriptive names, prefer `let` and value types.
- **TypeScript (`Backend/`)** — strict mode is on. No `any` without a
  reason. Keep handlers small and pure where possible.
- **JavaScript (`Web/`, `Site/`)** — vanilla ES modules, no framework.
  Keep DOM updates surgical; the app is a single-page app rendered by
  hand. New CSS goes through the existing custom-property theming.
- **Markdown** — wrap at ~80 chars where reasonable.

Avoid drive-by reformatting in feature PRs. If you want to reformat a
file, that's a separate PR.

---

## Commit messages

Imperative, present tense, ~72 chars on the subject line. Use a prefix
that hints at the area:

```
web: persist folder handle across sign-out
worker: rate-limit /presence to 1 req / 2s / session
mac: fix run import on macOS 13.5
docs: clarify cross-device sync wording
```

Multi-line bodies are great when the "why" isn't obvious from the diff.

---

## Reporting bugs

Use the [Bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). The
short version: tell me what you did, what you expected, what happened
instead, and which client (macOS app / web / iOS) plus version.

For the web companion, the build version is shown in the footer
(e.g. `v111-2026-05-07-…`). Including it makes triage 10× faster.

---

## Security issues

**Please don't open a public issue for security bugs.** Follow the
disclosure process in [SECURITY.md](SECURITY.md). I'll respond within a
few days and credit you in the release notes if you'd like.

---

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](LICENSE), the same as the rest of the project. There is
no CLA.

---

## Questions?

Open a [Discussion](https://github.com/c3rooks/SpireVault/discussions) or
ping me through the channels listed in the [README](README.md#who-built-this).
