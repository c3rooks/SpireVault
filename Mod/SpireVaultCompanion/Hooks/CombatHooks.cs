// Copyright (c) SpireVault. MIT licensed.
//
// Combat-state Harmony patches. Same pattern as RunHooks: the patches
// keep a static `Current` value updated in real time, the ingest loop
// reads it on its 2s tick.

using HarmonyLib;
using SpireVault.Companion.Models;

namespace SpireVault.Companion.Hooks;

public static class CombatHooks
{
    public static RunLiveCombat? Current { get; internal set; }

    /// <summary>
    /// Combat-enter. Replace `CombatRoom.OnEnterCombat` with the real
    /// symbol once compiling against Assembly-CSharp. v0.1 stub keeps
    /// the hook attached so the build doesn't break before the real
    /// references are wired.
    /// </summary>
    [HarmonyPatch(typeof(object), "OnEnterCombat")]
    [HarmonyPostfix]
    public static void OnEnterCombat()
    {
        Current = new RunLiveCombat
        {
            Scene = "in_combat",
            Turn = 0,
            Energy = 3,
            EnergyMax = 3,
        };
    }

    /// <summary>
    /// Combat-tick. Real implementation reads the player + combat
    /// fields and refreshes Current. v0.1 stub.
    /// </summary>
    [HarmonyPatch(typeof(object), "OnCombatTick")]
    [HarmonyPostfix]
    public static void OnCombatTick()
    {
        // Replace with real per-tick refresh.
    }

    /// <summary>
    /// Combat-exit. Sets scene null so SnapshotBuilder treats us as
    /// being on the map / event / shop screen.
    /// </summary>
    [HarmonyPatch(typeof(object), "OnExitCombat")]
    [HarmonyPostfix]
    public static void OnExitCombat()
    {
        Current = new RunLiveCombat { Scene = "between_combats" };
    }
}
