// Copyright (c) SpireVault. MIT licensed.
//
// Skada-style damage meter. The local meter renders inside the game
// (delegated to BaseLib-StS2's overlay surface). The numbers we
// track here are also surfaced on the spectator URL so a teammate
// can see them from their phone — that's the differentiator vs
// every other STS2 damage meter that's existed.
//
// v0.1 is local-only and tracks five buckets. v0.2 forwards the
// bucket totals onto the wire format (they already have a slot
// reserved in IngestPayload's combat field for `damageMeter`).

using System.Collections.Generic;

namespace SpireVault.Companion.Combat;

public sealed class DamageBucket
{
    public string Owner { get; set; } = "";
    public int Outgoing { get; set; }
    public int Incoming { get; set; }
    public int Healing { get; set; }
    public int Block { get; set; }
    public int Vulnerable { get; set; }
}

public static class DamageMeter
{
    private static readonly Dictionary<string, DamageBucket> _buckets = new();

    public static IReadOnlyDictionary<string, DamageBucket> Snapshot() => _buckets;

    public static void Reset() => _buckets.Clear();

    public static void RecordOutgoing(string owner, int amount)
    {
        var b = Bucket(owner);
        b.Outgoing += amount;
    }

    public static void RecordIncoming(string owner, int amount)
    {
        var b = Bucket(owner);
        b.Incoming += amount;
    }

    public static void RecordHealing(string owner, int amount) => Bucket(owner).Healing += amount;
    public static void RecordBlock(string owner, int amount)   => Bucket(owner).Block    += amount;
    public static void RecordVulnerable(string owner, int n)   => Bucket(owner).Vulnerable += n;

    private static DamageBucket Bucket(string owner)
    {
        if (!_buckets.TryGetValue(owner, out var b))
        {
            b = new DamageBucket { Owner = owner };
            _buckets[owner] = b;
        }
        return b;
    }
}
