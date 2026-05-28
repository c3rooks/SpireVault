// Copyright (c) SpireVault. MIT licensed.
//
// Wire format for /coop/mod/ingest. Mirror Backend/src/coop-mod-stream.ts
// EXACTLY. When you change a field here, change it there in the same PR.
//
// We use System.Text.Json with camelCase naming so the JSON wire
// shape matches the TypeScript types without manual rename attributes
// on every property.

using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace SpireVault.Companion.Models;

public sealed class IngestPayload
{
    [JsonPropertyName("schemaVersion")] public int SchemaVersion { get; set; } = 1;
    [JsonPropertyName("runId")]         public string RunId { get; set; } = "";
    [JsonPropertyName("modVersion")]    public string ModVersion { get; set; } = Plugin.Version;
    [JsonPropertyName("snapshot")]      public RunLiveSnapshot Snapshot { get; set; } = new();

    /// <summary>
    /// True only on the final upload after the run ends. Bumps the
    /// cloud row to the post-run TTL so the share / replay / Coach
    /// narrative paths can read the closed run for ~30 minutes.
    /// </summary>
    [JsonPropertyName("closing")] public bool Closing { get; set; }
}

public sealed class RunLiveSnapshot
{
    [JsonPropertyName("schemaVersion")]  public int SchemaVersion { get; set; } = 1;
    [JsonPropertyName("runId")]          public string RunId { get; set; } = "";
    [JsonPropertyName("hostSteamId")]    public string HostSteamId { get; set; } = "";
    [JsonPropertyName("hostPersonaName")]public string HostPersonaName { get; set; } = "";
    [JsonPropertyName("hostAvatarUrl")]  public string? HostAvatarUrl { get; set; }
    [JsonPropertyName("characterId")]    public string CharacterId { get; set; } = "";
    [JsonPropertyName("ascension")]      public int Ascension { get; set; }
    [JsonPropertyName("floor")]          public int Floor { get; set; }
    [JsonPropertyName("act")]            public int Act { get; set; }
    [JsonPropertyName("hp")]             public int Hp { get; set; }
    [JsonPropertyName("maxHp")]          public int MaxHp { get; set; }
    [JsonPropertyName("gold")]           public int Gold { get; set; }
    [JsonPropertyName("deck")]           public List<RunLiveCard> Deck { get; set; } = new();
    [JsonPropertyName("relics")]         public List<RunLiveRelic> Relics { get; set; } = new();
    [JsonPropertyName("potions")]        public List<RunLivePotion> Potions { get; set; } = new();
    [JsonPropertyName("combat")]         public RunLiveCombat? Combat { get; set; }
    [JsonPropertyName("party")]          public List<RunLivePartyMember> Party { get; set; } = new();

    /// <summary>"active" | "victory" | "death" | "abandoned".</summary>
    [JsonPropertyName("status")] public string Status { get; set; } = "active";

    /// <summary>Server stamps on receipt; we don't bother filling client-side.</summary>
    [JsonPropertyName("updatedAt")] public string UpdatedAt { get; set; } = "";
}

public sealed class RunLiveCard
{
    [JsonPropertyName("id")]       public string Id { get; set; } = "";
    [JsonPropertyName("name")]     public string Name { get; set; } = "";
    [JsonPropertyName("upgrades")] public int Upgrades { get; set; }
    [JsonPropertyName("cost")]     public int Cost { get; set; }
    /// <summary>"attack" | "skill" | "power" | "status" | "curse".</summary>
    [JsonPropertyName("type")]     public string Type { get; set; } = "";
}

public sealed class RunLiveRelic
{
    [JsonPropertyName("id")]          public string Id { get; set; } = "";
    [JsonPropertyName("name")]        public string Name { get; set; } = "";
    [JsonPropertyName("description")] public string Description { get; set; } = "";
    [JsonPropertyName("counter")]     public int? Counter { get; set; }
}

public sealed class RunLivePotion
{
    [JsonPropertyName("id")]   public string Id { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
}

public sealed class RunLiveCombat
{
    /// <summary>"in_combat" | "between_combats" | "map" | "shop" | "rest" | "event" | "boss" | "victory" | "death" | null.</summary>
    [JsonPropertyName("scene")]     public string? Scene { get; set; }
    [JsonPropertyName("turn")]      public int? Turn { get; set; }
    [JsonPropertyName("energy")]    public int? Energy { get; set; }
    [JsonPropertyName("energyMax")] public int? EnergyMax { get; set; }
    [JsonPropertyName("hand")]      public List<RunLiveCard> Hand { get; set; } = new();
    [JsonPropertyName("block")]     public int? Block { get; set; }
    [JsonPropertyName("enemies")]   public List<RunLiveEnemy> Enemies { get; set; } = new();
}

public sealed class RunLiveEnemy
{
    [JsonPropertyName("name")]         public string Name { get; set; } = "";
    [JsonPropertyName("hp")]           public int Hp { get; set; }
    [JsonPropertyName("maxHp")]        public int MaxHp { get; set; }
    [JsonPropertyName("intent")]       public string? Intent { get; set; }
    [JsonPropertyName("intentDamage")] public int? IntentDamage { get; set; }
}

public sealed class RunLivePartyMember
{
    [JsonPropertyName("steamId")]      public string SteamId { get; set; } = "";
    [JsonPropertyName("personaName")]  public string? PersonaName { get; set; }
    [JsonPropertyName("characterId")]  public string? CharacterId { get; set; }
    [JsonPropertyName("hp")]           public int? Hp { get; set; }
    [JsonPropertyName("maxHp")]        public int? MaxHp { get; set; }
    [JsonPropertyName("block")]        public int? Block { get; set; }
    [JsonPropertyName("hand")]         public List<RunLiveCard>? Hand { get; set; }
    [JsonPropertyName("deckSize")]     public int? DeckSize { get; set; }
    [JsonPropertyName("topRelicIds")]  public List<string>? TopRelicIds { get; set; }
}
