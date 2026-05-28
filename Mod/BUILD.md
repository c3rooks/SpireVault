# Building the SpireVault Companion mod locally

The scaffold compiles against the Slay the Spire 2 game DLLs and
[BaseLib-StS2](https://www.nexusmods.com/slaythespire2/mods/3). You
need both installed locally before `dotnet build` will succeed.

## 1. Install the .NET 9.0 SDK

```bash
# macOS (Apple Silicon)
brew install --cask dotnet-sdk
# or download from https://dotnet.microsoft.com/download/dotnet/9.0
```

## 2. Install BaseLib-StS2

Follow the upstream install instructions:
<https://www.nexusmods.com/slaythespire2/mods/3>

By default it lands in:

- macOS: `~/Library/Application Support/Steam/steamapps/common/SlayTheSpire2/mods/BaseLib-StS2/`
- Windows: `C:\Program Files (x86)\Steam\steamapps\common\SlayTheSpire2\mods\BaseLib-StS2\`

## 3. Point the build at your STS2 install

The csproj reads `STS2_PATH` from your environment so we never
hard-code a path that depends on your machine layout.

```bash
# macOS / Linux
export STS2_PATH="$HOME/Library/Application Support/Steam/steamapps/common/SlayTheSpire2"

# Windows (PowerShell)
$env:STS2_PATH = "C:\Program Files (x86)\Steam\steamapps\common\SlayTheSpire2"
```

## 4. Build

```bash
cd Mod/SpireVaultCompanion
dotnet restore
dotnet build -c Release
```

Outputs land in `bin/Release/`:

```
SpireVaultCompanion.dll
mod_manifest.json
LICENSE
CHANGELOG.md
0Harmony.dll          # bundled by the Harmony NuGet
```

## 5. Install into the game

Zip those files together as `SpireVaultCompanion-v0.1.zip` and copy
into:

- macOS: `~/Library/Application Support/SlayTheSpire2/mods/SpireVaultCompanion/`
- Windows: `%APPDATA%\SlayTheSpire2\mods\SpireVaultCompanion\`

Or use the BaseLib-StS2 mod installer UI if you prefer.

## 6. Bind a SpireVault session

For development, paste a session token from your browser into your
shell:

```bash
export SPIREVAULT_SESSION="$(your_browser_cookie)"
export SPIREVAULT_STEAM_ID="76561199xxxxxxxxx"
```

For production, the desktop SpireVault app writes
`~/.spirevault/companion.json` automatically when it sees the mod
installed. (Desktop bridge ships in v0.1 release notes.)

## 7. Verify the loop

Launch STS2, start any run, and watch the Companion ModConfig tab
for the "Last upload" timestamp to update every ~2s. The
`https://spirevault.app/watch?runId=<runId>` URL should populate
within ~2 seconds of run start.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `MissingMethodException` on hook attach | The STS2 method symbol changed in a patch. Run the [sts2-modding-mcp](https://github.com/elliotttate/sts2-modding-mcp) `find_method` tool, update `[HarmonyPatch(...)]` in the relevant `Hooks/*.cs`. |
| `no_session` error stays sticky | Either no token bound yet (set ENV vars) OR the session expired (sign in to spirevault.app again, restart the desktop SpireVault app). |
| `http_429` | The per-IP rate limit hit. Default is 60 ingests/min/IP — way above the 30/min the mod produces, so this means another tool on the same IP is also hitting the worker. Wait 60s, restart STS2. |
| HTTP timeouts | The 8s tick timeout is generous, but a flaky network can still trip it. The next tick is only 2s away; spectators just see a 2s blip. |
