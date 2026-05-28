// Copyright (c) SpireVault. MIT licensed.
//
// ModConfig integration. ModConfig is a popular STS2 mod that
// renders a unified settings tab; if it's installed, our toggles
// appear there. If not, the defaults are used silently.
//
// We avoid hard-binding to ModConfig at compile time so the mod can
// load when ModConfig is missing. The optional integration ships in
// a follow-up: this v0.1 file just owns the in-memory settings shape
// + the URL constants so the rest of the codebase has a single place
// to look.

using System;

namespace SpireVault.Companion.Settings;

public sealed class ModSettings
{
    /// <summary>Streaming live run is opt-out (default ON). The user
    /// can flip this any time from ModConfig and the next ingest tick
    /// honours the new value without restarting.</summary>
    public bool StreamLiveRun { get; set; } = true;

    /// <summary>Optional X-Mod-Token sent with every upload. Set by
    /// the user only if the operator has bound a COMPANION_MOD_SECRET
    /// on the worker side. Otherwise empty and no token header is
    /// added.</summary>
    public string ModSecret { get; set; } = "";

    /// <summary>Last successful upload timestamp (UTC). Surfaced in
    /// the diagnostics field of ModConfig so testers can confirm the
    /// loop is running.</summary>
    public DateTime? LastUploadAt { get; set; }

    /// <summary>Last error code, e.g. "no_session" or "http_429".
    /// Cleared on the next successful upload.</summary>
    public string? LastError { get; set; }

    public static ModSettings Current { get; private set; } = new();

    public static string IngestUrl { get; } =
        "https://vault-coop.coreycrooks.workers.dev/coop/mod/ingest";

    /// <summary>
    /// Load settings. v0.1 just rehydrates defaults. Once we wire the
    /// optional ModConfig dependency, this method reads the saved
    /// JSON and updates Current in place.
    /// </summary>
    public static void Load()
    {
        Current = new ModSettings();
    }
}
