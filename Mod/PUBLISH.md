# Publishing the SpireVault Companion mod

This is the operator-facing checklist for shipping a new build of the
Companion mod to Nexus Mods + Steam Workshop. Production secrets and
account credentials are NOT in the repo — fill them in your local
shell each release.

## Pre-flight

- [ ] Build runs clean: `cd Mod/SpireVaultCompanion && dotnet build -c Release`
- [ ] `mod_manifest.json` `version` bumped (e.g. 0.1.0 → 0.1.1)
- [ ] `CHANGELOG.md` entry added under the new version
- [ ] Wire-format changes (if any) are mirrored on the backend in
      `Backend/src/coop-mod-stream.ts` and the bumped backend is
      already deployed
- [ ] Smoke test: install the local zip into your own STS2, run a
      single combat, confirm the snapshot lands at
      `https://spirevault.app/watch/<runId>` within 2 seconds

## Pack the release artifact

```bash
cd Mod/SpireVaultCompanion/bin/Release
ZIP_NAME="SpireVaultCompanion-v$(jq -r .version ../../mod_manifest.json).zip"
zip -r "../../$ZIP_NAME" SpireVaultCompanion.dll mod_manifest.json LICENSE CHANGELOG.md 0Harmony.dll
```

Upload this single zip to both stores. **Do not include the source
.cs files in the public release.** Source is hosted in this repo.

## Nexus Mods

1. Sign in: <https://www.nexusmods.com/slaythespire2/mods/add>
2. Game: Slay the Spire 2
3. Title: `SpireVault Companion`
4. Tagline: `Streams live STS2 run state to the cloud — damage meter,
   spectator URLs, OBS overlay, AI Coach`
5. Description: paste from `Mod/README.md` "What it does" section.
   Expand with the spectator + OBS + Coach screenshots once we ship
   them.
6. Tags: `multiplayer`, `damage meter`, `tools`, `qol`, `presence`
7. Permissions: source on GitHub (link this repo), modifications
   allowed with attribution
8. Upload the `.zip` from above
9. Set version (matches mod_manifest.json)
10. Hit "Save" — you can edit the page after publishing

## Steam Workshop

1. Sign in to Steam, open SlayTheSpire2 → Workshop → Submit a new
   item
2. Title + tagline + description: same as Nexus
3. Preview image: `Web/assets/og.png` works as a placeholder until we
   take native screenshots
4. Tags: `Tools`, `Multiplayer`, `Co-op`
5. Visibility: Public
6. Upload the `.zip`
7. Set the change-notes from CHANGELOG.md
8. Publish

## Post-publish

- [ ] Add the Nexus + Workshop links to `Web/companion-mod.html`
      (currently shows "private beta" copy)
- [ ] Add a news post at `Web/index.html` → news section pinning the
      release
- [ ] Cross-post to the SpireVault Discord `#announcements` channel
- [ ] Tweet from `@spirevault` with a 30-second screen recording of
      `/watch/<runId>` updating live

## Rollback

If a release is broken (uploads start failing, or the wire format
breaks an older live build):

1. On Nexus: archive the broken version, leave the previous one
   downloadable
2. On Workshop: roll back to the previous version (Workshop keeps
   history)
3. Backend: bump `COMPANION_MOD_SECRET` if needed to kill all live
   ingest from the broken build (`wrangler secret put
   COMPANION_MOD_SECRET`)
