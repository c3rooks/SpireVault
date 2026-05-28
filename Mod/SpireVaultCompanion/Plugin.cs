// Copyright (c) SpireVault. MIT licensed.
//
// Main entry point for the SpireVault Companion mod.
//
// Lifecycle:
//
//   1. STS2 boot calls Initialize() once after Assembly-CSharp + BaseLib
//      have loaded.
//   2. We hook the game's run lifecycle via Harmony patches in `Hooks/`.
//   3. On Run.Start, we begin a 2-second tick that captures a
//      RunLiveSnapshot via SnapshotBuilder and POSTs it to
//      `https://vault-coop.coreycrooks.workers.dev/coop/mod/ingest`
//      using IngestClient.
//   4. On Run.End (victory/death/abandon) we send one final snapshot
//      with `closing: true` so the cloud row gets the post-run TTL
//      bump (30 minutes) for the share / replay / Coach narrative
//      surfaces.
//   5. ModConfig (optional dependency) lets the user toggle streaming
//      per-run without leaving the game.
//
// Why this lives in Plugin.cs rather than a static initializer on
// individual hook classes: BaseLib-StS2's mod loader expects a stable
// entry symbol. Centralising lifecycle here also lets us bail out
// cleanly if any hook fails to attach — no half-initialised state.

using System;
using System.Threading;
using HarmonyLib;
using SpireVault.Companion.Auth;
using SpireVault.Companion.Settings;
using SpireVault.Companion.Stream;

namespace SpireVault.Companion;

public static class Plugin
{
    public const string ModId = "SpireVaultCompanion";
    public const string Version = "0.1.0";

    private static Harmony? _harmony;
    private static IngestLoop? _ingestLoop;
    private static CancellationTokenSource? _cts;

    /// <summary>
    /// Called once by the BaseLib-StS2 mod loader after the game has
    /// finished booting and Assembly-CSharp is available. Safe to do
    /// reflection-based hook attachment from here.
    /// </summary>
    public static void Initialize()
    {
        try
        {
            ModSettings.Load();
            Log("Initializing SpireVault Companion v" + Version);

            _harmony = new Harmony("app.spirevault.companion");
            _harmony.PatchAll(typeof(Plugin).Assembly);

            _cts = new CancellationTokenSource();
            _ingestLoop = new IngestLoop(_cts.Token);
            _ingestLoop.Start();

            Log("Hooks attached. Streaming will begin on next run start.");
        }
        catch (Exception ex)
        {
            Log("Initialization failed: " + ex);
        }
    }

    /// <summary>
    /// Called by BaseLib-StS2 on game shutdown. Best-effort cleanup —
    /// the OS will reclaim everything regardless, but we'd like the
    /// last in-flight upload to drain.
    /// </summary>
    public static void Shutdown()
    {
        try
        {
            _cts?.Cancel();
            _ingestLoop?.Stop();
            _harmony?.UnpatchAll("app.spirevault.companion");
            SteamSessionResolver.Clear();
            Log("Shutdown complete.");
        }
        catch (Exception ex)
        {
            Log("Shutdown error: " + ex);
        }
    }

    /// <summary>
    /// Single shared logger so every module routes through one channel.
    /// We do not depend on BaseLib-StS2's logger directly because that
    /// reference doesn't exist at compile time when STS2_PATH isn't
    /// set; instead we write to stderr which is captured by the game's
    /// console + the mod loader's log file.
    /// </summary>
    public static void Log(string message)
    {
        Console.Error.WriteLine("[SpireVault] " + message);
    }
}
