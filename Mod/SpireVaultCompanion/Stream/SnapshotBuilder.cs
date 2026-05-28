// Copyright (c) SpireVault. MIT licensed.
//
// Translates the in-game Run / Combat / Player objects into the wire
// format defined in Models/IngestPayload.cs.
//
// IMPORTANT FOR REVIEWERS: the symbol names below (`GameRunner`,
// `RunService`, `Player`, `CombatRoom`, etc.) are placeholders that
// match the BaseLib-StS2 + sts2-modding-mcp documented surface as of
// the v0.1 scaffold. Once the project compiles against the real
// `Assembly-CSharp.dll` from your local STS2 install, swap any
// mismatched names. The shape of the snapshot doesn't change — only
// the accessor calls do.
//
// We deliberately keep this module side-effect free: it only reads
// the game state and produces an IngestPayload. All HTTP work lives
// in IngestClient so unit tests can build snapshots without a
// network or auth layer.

using System;
using System.Collections.Generic;
using SpireVault.Companion.Auth;
using SpireVault.Companion.Combat;
using SpireVault.Companion.Hooks;
using SpireVault.Companion.Models;

namespace SpireVault.Companion.Stream;

public static class SnapshotBuilder
{
    /// <summary>
    /// Returns null when the game isn't currently in a run we should
    /// stream (main menu, settings screen, replay viewer).
    /// </summary>
    public static IngestPayload? TryBuild()
    {
        var state = GameState.Capture();
        if (state is null) return null;

        var session = SteamSessionResolver.Resolve();
        var hostSteamId = session?.SteamId ?? state.LocalSteamId;
        if (string.IsNullOrEmpty(hostSteamId)) return null;

        var payload = new IngestPayload
        {
            SchemaVersion = 1,
            RunId = state.RunId,
            ModVersion = Plugin.Version,
            Closing = state.Status != "active",
            Snapshot = new RunLiveSnapshot
            {
                SchemaVersion = 1,
                RunId = state.RunId,
                HostSteamId = hostSteamId,
                HostPersonaName = session?.PersonaName ?? state.LocalPersonaName,
                HostAvatarUrl = session?.AvatarUrl,
                CharacterId = state.CharacterId,
                Ascension = state.Ascension,
                Floor = state.Floor,
                Act = state.Act,
                Hp = state.Hp,
                MaxHp = state.MaxHp,
                Gold = state.Gold,
                Deck = state.Deck,
                Relics = state.Relics,
                Potions = state.Potions,
                Combat = state.Combat,
                Party = state.Party,
                Status = state.Status,
            },
        };
        return payload;
    }
}

/// <summary>
/// A frozen snapshot of every in-game value the wire format needs.
/// Captured all at once so the payload can't tear if the game state
/// ticks halfway through serialization.
/// </summary>
internal sealed class GameState
{
    public string RunId { get; init; } = "";
    public string CharacterId { get; init; } = "";
    public int Ascension { get; init; }
    public int Floor { get; init; }
    public int Act { get; init; } = 1;
    public int Hp { get; init; }
    public int MaxHp { get; init; }
    public int Gold { get; init; }
    public List<RunLiveCard> Deck { get; init; } = new();
    public List<RunLiveRelic> Relics { get; init; } = new();
    public List<RunLivePotion> Potions { get; init; } = new();
    public RunLiveCombat? Combat { get; init; }
    public List<RunLivePartyMember> Party { get; init; } = new();
    public string Status { get; init; } = "active";
    public string LocalSteamId { get; init; } = "";
    public string LocalPersonaName { get; init; } = "";

    public static GameState? Capture()
    {
        // Stub. Replaced wholesale by the real implementation once the
        // project compiles against Assembly-CSharp + BaseLib-StS2.
        // The hook classes (Hooks/RunHooks, Hooks/CombatHooks,
        // Hooks/PartyHooks) update RunHooks.Current / CombatHooks.Current
        // / PartyHooks.Current as the game ticks; this method just
        // pivots their last-seen values into the wire shape.
        var run = RunHooks.Current;
        if (run is null || string.IsNullOrEmpty(run.RunId)) return null;

        return new GameState
        {
            RunId = run.RunId,
            CharacterId = run.CharacterId,
            Ascension = run.Ascension,
            Floor = run.Floor,
            Act = run.Act,
            Hp = run.Hp,
            MaxHp = run.MaxHp,
            Gold = run.Gold,
            Deck = run.Deck,
            Relics = run.Relics,
            Potions = run.Potions,
            Combat = CombatHooks.Current,
            Party = PartyHooks.Current,
            Status = run.Status,
            LocalSteamId = run.LocalSteamId,
            LocalPersonaName = run.LocalPersonaName,
        };
    }
}
