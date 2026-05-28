// Copyright (c) SpireVault. MIT licensed.
//
// HTTP client + background loop for posting RunLiveSnapshot batches to
// /coop/mod/ingest. Why HTTP rather than WebSocket: see
// Backend/src/coop-mod-stream.ts for the reasoning. Briefly: cheaper
// on Cloudflare, simpler to debug, fits the spectator's natural pull
// cadence, and the schema is already locked so a v2 WebSocket can
// ship later without a wire-format change.

using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SpireVault.Companion.Auth;
using SpireVault.Companion.Models;
using SpireVault.Companion.Settings;

namespace SpireVault.Companion.Stream;

public sealed class IngestLoop
{
    /// <summary>2-second cadence — generous given the spectator UI
    /// pulls on the same interval and the server caches reads at the
    /// edge for 2s. Faster ticks waste KV writes; slower ticks make
    /// the spectator feel laggy.</summary>
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(2);

    /// <summary>If a tick takes longer than this, we drop the next
    /// one to avoid overlapping uploads.</summary>
    private static readonly TimeSpan TickTimeout = TimeSpan.FromSeconds(8);

    private static readonly HttpClient Http = new HttpClient
    {
        Timeout = TimeSpan.FromSeconds(8),
    };

    private readonly CancellationToken _outerToken;
    private CancellationTokenSource? _innerCts;
    private Task? _loopTask;

    public IngestLoop(CancellationToken outerToken)
    {
        _outerToken = outerToken;
    }

    public void Start()
    {
        _innerCts = CancellationTokenSource.CreateLinkedTokenSource(_outerToken);
        _loopTask = Task.Run(() => RunLoop(_innerCts.Token), _innerCts.Token);
    }

    public void Stop()
    {
        try { _innerCts?.Cancel(); }
        catch { /* best-effort */ }
    }

    private async Task RunLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (ModSettings.Current.StreamLiveRun)
                {
                    var payload = SnapshotBuilder.TryBuild();
                    if (payload is not null)
                    {
                        await SendAsync(payload, ct).WaitAsync(TickTimeout, ct);
                    }
                }
            }
            catch (OperationCanceledException) { /* expected on shutdown */ }
            catch (Exception ex)
            {
                ModSettings.Current.LastError = ex.GetType().Name;
                Plugin.Log("Ingest tick failed: " + ex.Message);
            }

            try { await Task.Delay(TickInterval, ct); }
            catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// Single POST. Returns true on 2xx. Caller is responsible for
    /// rate-pacing — we don't retry on this layer because the next
    /// tick is only 2s away.
    /// </summary>
    public static async Task<bool> SendAsync(IngestPayload payload, CancellationToken ct)
    {
        var session = SteamSessionResolver.Resolve();
        if (session is null)
        {
            // No SpireVault session bound to the local Steam install.
            // We log once-per-startup; spamming on every tick wastes
            // the user's console.
            ModSettings.Current.LastError = "no_session";
            return false;
        }

        using var req = new HttpRequestMessage(HttpMethod.Post, ModSettings.IngestUrl);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.Token);
        if (!string.IsNullOrEmpty(ModSettings.Current.ModSecret))
        {
            req.Headers.Add("X-Mod-Token", ModSettings.Current.ModSecret);
        }
        req.Content = JsonContent.Create(payload, options: JsonOpts);

        using var resp = await Http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.IsSuccessStatusCode)
        {
            ModSettings.Current.LastUploadAt = DateTime.UtcNow;
            ModSettings.Current.LastError = null;
            return true;
        }
        ModSettings.Current.LastError = "http_" + (int)resp.StatusCode;
        return false;
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };
}
