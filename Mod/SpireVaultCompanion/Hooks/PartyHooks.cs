// Copyright (c) SpireVault. MIT licensed.
//
// Co-op party state hooks. v0.1 captures party member SteamIDs only;
// teammate decks land in v0.2 once we wire the network sync. The
// wire format already supports the richer payload so v0.2 is purely
// a producer-side change.

using System.Collections.Generic;
using HarmonyLib;
using SpireVault.Companion.Models;

namespace SpireVault.Companion.Hooks;

public static class PartyHooks
{
    public static List<RunLivePartyMember> Current { get; internal set; } = new();

    [HarmonyPatch(typeof(object), "OnPartyChanged")]
    [HarmonyPostfix]
    public static void OnPartyChanged()
    {
        // v0.1 stub: leaves the list untouched. The real
        // implementation reads the network-sync'd peer Steam IDs and
        // adds one RunLivePartyMember per peer.
    }
}
