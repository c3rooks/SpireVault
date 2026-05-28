// Copyright (c) SpireVault. MIT licensed.
//
// Harmony patches that capture run-lifecycle events. The patches
// update the static `Current` snapshot every time the game ticks one
// of the relevant lifecycle methods. SnapshotBuilder reads `Current`
// when the ingest loop fires.
//
// Why static state instead of an event bus: the ingest loop reads on
// a 2-second cadence and never on the same thread as the game tick.
// A simple ref to the latest values is the lowest-friction path. If
// we ever want to derive deltas (turn-by-turn damage histograms)
// they can live in dedicated modules and the wire format already
// has room for them.

using System.Collections.Generic;
using HarmonyLib;
using SpireVault.Companion.Models;

namespace SpireVault.Companion.Hooks;

/// <summary>
/// Mirror of the in-game run state, refreshed by Harmony patches.
/// Field names match Models/IngestPayload.cs so SnapshotBuilder can
/// pivot 1-to-1 with no remap.
/// </summary>
public sealed class RunSnapshot
{
    public string RunId = "";
    public string CharacterId = "";
    public int Ascension;
    public int Floor;
    public int Act = 1;
    public int Hp;
    public int MaxHp = 1;
    public int Gold;
    public List<RunLiveCard> Deck = new();
    public List<RunLiveRelic> Relics = new();
    public List<RunLivePotion> Potions = new();
    public string Status = "active";
    public string LocalSteamId = "";
    public string LocalPersonaName = "";
}

public static class RunHooks
{
    public static RunSnapshot? Current { get; internal set; }

    /// <summary>
    /// Run-start hook. Replace `GameRunner.StartNewRun` below with
    /// the actual STS2 method once you compile against the real
    /// Assembly-CSharp.dll. The MCP at
    /// https://github.com/elliotttate/sts2-modding-mcp can find the
    /// correct symbol name in a few seconds.
    /// </summary>
    [HarmonyPatch(typeof(object), "StartNewRun")]
    [HarmonyPostfix]
    public static void OnRunStart()
    {
        // Real implementation: read the GameRunner singleton and
        // populate Current with the starting state. v0.1 stub keeps
        // the patch attached so the hook surface compiles.
        Current = new RunSnapshot
        {
            RunId = NewRunId(),
            Status = "active",
        };
        Plugin.Log("Run started: " + Current.RunId);
    }

    /// <summary>
    /// Run-end hook. Marks `Current.Status` so the next ingest tick
    /// is sent with closing=true.
    /// </summary>
    [HarmonyPatch(typeof(object), "EndRun")]
    [HarmonyPostfix]
    public static void OnRunEnd(bool victory)
    {
        if (Current is null) return;
        Current.Status = victory ? "victory" : "death";
        Plugin.Log("Run ended: " + Current.Status);
    }

    private static string NewRunId()
    {
        // ULID-ish: 26 char base32, monotonic-ish via ticks. Good
        // enough for identifying a run within a 30-min window.
        var ticks = System.DateTime.UtcNow.Ticks;
        var rng = new System.Random();
        var buf = new byte[10];
        rng.NextBytes(buf);
        var hex = System.Convert.ToHexString(buf);
        return ticks.ToString("X") + "-" + hex;
    }
}
