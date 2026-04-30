# Releasing The Vault

End-to-end checklist for cutting a public release. Three things ship in lockstep:

1. **macOS app** (`VaultApp/`) → `.dmg` on GitHub Releases
2. **Worker backend** (`Backend/`) → Cloudflare Workers production environment
3. **CLI** (`TheVault/`) → tag the same version (no separate distribution channel for now)

## 0. Prerequisites (one-time)

- Xcode 16+, `brew install xcodegen`, `brew install create-dmg` (optional;
  the Makefile uses `hdiutil` by default).
- Cloudflare account with a deployed Worker. See `Backend/README.md`.
- A Steam Web API key set as the Worker secret `STEAM_WEB_API_KEY`.
- (Optional, no-Gatekeeper-warning path) Apple Developer account, an
  installed `Developer ID Application` cert, and an `xcrun notarytool`
  keychain profile named `vault-notary`.

## 1. Bump the version

Edit `VaultApp/project.yml`:

```yaml
settings:
  base:
    MARKETING_VERSION: 0.2.0
    CURRENT_PROJECT_VERSION: 2
```

Pick the next semver:

- **Patch** (`0.1.x`) — fixes / copy
- **Minor** (`0.x.0`) — new feature, backwards-compatible
- **Major** (`x.0.0`) — wire-format break (rare; Worker types live in `Backend/src/types.ts` and must move in lockstep)

Commit:

```bash
git commit -am "chore: bump VaultApp to 0.2.0"
```

## 2. Deploy the Worker

Only required when you've changed anything under `Backend/`. The macOS app
talks to whatever's live in production at the URL baked into
`VaultApp/App/Coop/AppConfig.swift::defaultServerURL`.

```bash
cd Backend
make deploy
```

Smoke test from your laptop:

```bash
curl https://vault-coop.<your-subdomain>.workers.dev
# → vault-coop online

curl https://vault-coop.<your-subdomain>.workers.dev/presence
# → []  (or an array of live entries)
```

If the URL changed, also update `defaultServerURL` and rebuild the app.

## 3. Build the DMG

Ad-hoc signed (free; users see "right-click → Open" once):

```bash
cd VaultApp
make dmg
# → build/The-Vault-0.2.0.dmg
```

Notarized (no Gatekeeper warning; requires Apple Developer account):

```bash
cd VaultApp
CODE_SIGN_IDENTITY="Developer ID Application: Corey Crooks (TEAMID)" make dmg
xcrun notarytool submit build/The-Vault-0.2.0.dmg \
  --keychain-profile vault-notary --wait
xcrun stapler staple build/The-Vault-0.2.0.dmg
```

## 4. Tag and push

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --tags
```

If the GitHub Action is enabled (see `.github/workflows/release.yml`),
pushing the tag triggers an automated build + draft release. Otherwise:

## 5. Manual GitHub release

1. Go to `Releases → Draft a new release` on GitHub.
2. Choose tag `v0.2.0`.
3. Upload `build/The-Vault-0.2.0.dmg`.
4. Paste the relevant section from `TheVault/CHANGELOG.md` as the body.
5. Publish.

## 6. Post-release

- Verify the DMG mounts and the app launches on a clean macOS account.
- Open Co-op → Sign in with Steam → confirm presence appears in the feed.
- Update the install link in the README if it points to a specific tag.

## Known sharp edges

- **First-launch Gatekeeper.** Ad-hoc signed builds require the
  right-click → Open dance the very first time. The DMG window has the
  Applications symlink so users drag-to-install correctly; the README
  spells out the step.
- **CFBundleVersion gotcha.** XcodeGen sets `CURRENT_PROJECT_VERSION`
  from `project.yml`. If you forget to bump it on a same-MARKETING-VERSION
  rebuild, Sparkle/Squirrel-style updaters won't see the change. We
  don't ship an updater right now, so this is purely a convention.
- **Worker URL change = client rebuild.** End users only get the new URL
  when they download a new app build. There's an Advanced Settings escape
  hatch for self-hosters and contributors mid-migration.
