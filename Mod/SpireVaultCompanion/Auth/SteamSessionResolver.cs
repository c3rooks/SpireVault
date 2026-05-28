// Copyright (c) SpireVault. MIT licensed.
//
// Finds the SpireVault session token + Steam profile for the local
// user. Steam itself doesn't expose a session credential we can use
// — we piggy-back on the SpireVault web sign-in.
//
// Three resolution strategies, tried in order:
//
//   1. ENV: SPIREVAULT_SESSION + SPIREVAULT_STEAM_ID. Used by mod
//      developers + automated tests so a checked-in token never
//      escapes to the public release. (Mod developers paste a dev
//      session in their shell; production users never set these.)
//
//   2. Local file at ~/.spirevault/companion.json. Written by the
//      desktop SpireVault app once it sees the mod is installed.
//      JSON format:
//        { "token": "...", "steamId": "...", "personaName": "...",
//          "avatarUrl": "..." }
//      The file is mode 0600 on POSIX.
//
//   3. As a last resort, browser cookie scrape. STS2 is a desktop
//      app; we ship without this strategy in v0.1 because the
//      desktop app should always own the session handoff.
//
// If none of the strategies returns a token, the mod is effectively
// idle: no uploads happen, no error toast, no spam. The user can
// still play with no SpireVault integration. This is a deliberately
// silent degraded mode so a Companion mod install never breaks a
// player's offline run.

using System;
using System.IO;
using System.Text.Json;

namespace SpireVault.Companion.Auth;

public sealed class SteamSession
{
    public required string Token { get; init; }
    public required string SteamId { get; init; }
    public string PersonaName { get; init; } = "";
    public string? AvatarUrl { get; init; }
}

public static class SteamSessionResolver
{
    private static SteamSession? _cache;
    private static DateTime _cacheExpires = DateTime.MinValue;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    public static SteamSession? Resolve()
    {
        if (_cache is not null && DateTime.UtcNow < _cacheExpires) return _cache;

        var s = ResolveFromEnv() ?? ResolveFromFile();
        _cache = s;
        _cacheExpires = DateTime.UtcNow + CacheTtl;
        return s;
    }

    public static void Clear()
    {
        _cache = null;
        _cacheExpires = DateTime.MinValue;
    }

    private static SteamSession? ResolveFromEnv()
    {
        var token = Environment.GetEnvironmentVariable("SPIREVAULT_SESSION");
        var sid = Environment.GetEnvironmentVariable("SPIREVAULT_STEAM_ID");
        if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(sid)) return null;
        if (sid.Length != 17) return null;
        return new SteamSession
        {
            Token = token,
            SteamId = sid,
            PersonaName = Environment.GetEnvironmentVariable("SPIREVAULT_PERSONA") ?? "Steam User",
            AvatarUrl = Environment.GetEnvironmentVariable("SPIREVAULT_AVATAR"),
        };
    }

    private static SteamSession? ResolveFromFile()
    {
        try
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var path = Path.Combine(home, ".spirevault", "companion.json");
            if (!File.Exists(path)) return null;

            var json = File.ReadAllText(path);
            var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var token = root.GetProperty("token").GetString();
            var sid = root.GetProperty("steamId").GetString();
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(sid) || sid.Length != 17) return null;
            return new SteamSession
            {
                Token = token,
                SteamId = sid,
                PersonaName = root.TryGetProperty("personaName", out var pn) ? pn.GetString() ?? "" : "",
                AvatarUrl = root.TryGetProperty("avatarUrl", out var av) ? av.GetString() : null,
            };
        }
        catch
        {
            return null;
        }
    }
}
