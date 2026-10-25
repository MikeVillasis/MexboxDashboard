using System.IO;
using System.Net;
using System.Net.Http;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Dashboard.Core.Services;

namespace Dashboard.App.Services;

/// <summary>
/// While this PC is linked (ticket 07), keeps one WebSocket to its DeviceHub and publishes a library summary and
/// "now playing", so the Activity's gamercards can show them. Runs entirely on the thread pool.
/// <list type="bullet">
/// <item>Library: sent on connect, then again ~2 s after the library settles (and at most every 6 s; the hub drops faster ones).</item>
/// <item>Now playing: title / artist / app / playing only (no artwork), debounced to the last change within 300 ms.</item>
/// <item>Covers: only public store URLs (Steam CDN, Battle.net box art). Nothing from the PC's disk is uploaded.</item>
/// <item>Keep-alive "ping" every 30 s; reconnect with exponential backoff (2 s → 2 min, jittered).</item>
/// </list>
/// </summary>
internal sealed class ActivityPublisher : IDisposable
{
    private const int MaxGames = 500;
    private static readonly TimeSpan PingEvery = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan LibraryDebounce = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan LibraryMinGap = TimeSpan.FromSeconds(6);
    private static readonly TimeSpan MediaDebounce = TimeSpan.FromMilliseconds(300);

    private readonly GameLibraryService _library;
    private readonly IMediaService _media;
    private readonly Func<Task> _onRevoked;
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private readonly object _gate = new();
    private CancellationTokenSource? _run;
    private Task? _loop;
    private int _libraryDirty;
    private int _mediaDirty;
    private readonly ConcurrentQueue<JsonObject> _outbox = new();

    /// <summary>Raised (worker thread) when the hub answers, e.g. to log or, in phase 08, to deliver launch requests.</summary>
    public event Action<JsonNode>? MessageReceived;

    /// <param name="onRevoked">The server no longer knows this device (unlinked in the Activity): forget the link.</param>
    public ActivityPublisher(GameLibraryService library, IMediaService media, Func<Task> onRevoked)
    {
        _library = library;
        _media = media;
        _onRevoked = onRevoked;
        _library.LibraryChanged += (_, _) => MarkDirty(ref _libraryDirty);
        _media.SessionUpdated += (_, _) => MarkDirty(ref _mediaDirty);
    }

    public void Start(string server, string token)
    {
        lock (_gate)
        {
            if (_run is not null) return;
            _run = new CancellationTokenSource();
            var ct = _run.Token;
            _loop = Task.Run(() => RunAsync(server, token, ct));
        }
    }

    public void Stop()
    {
        CancellationTokenSource? run;
        lock (_gate)
        {
            run = _run;
            _run = null;
            _loop = null;
        }
        run?.Cancel();
        _wake.Release();
    }

    public void Dispose() => Stop();

    /// <summary>Queues a packet for the hub (e.g. LAUNCH_RESULT); sent on the open connection, dropped if there's none.</summary>
    public void Send(JsonObject packet)
    {
        _outbox.Enqueue(packet);
        _wake.Release();
    }

    private void MarkDirty(ref int flag)
    {
        Interlocked.Exchange(ref flag, 1);
        _wake.Release();
    }

    private async Task RunAsync(string server, string token, CancellationToken ct)
    {
        var uri = new Uri(server.Replace("https://", "wss://").Replace("http://", "ws://") + "/api/device/ws");
        var backoff = TimeSpan.FromSeconds(2);
        while (!ct.IsCancellationRequested)
        {
            var wait = backoff;
            try
            {
                using var ws = new ClientWebSocket();
                ws.Options.SetRequestHeader("Authorization", $"Bearer {token}");
                ws.Options.CollectHttpResponseDetails = true;
                ws.Options.KeepAliveInterval = TimeSpan.Zero; // our own text "ping", which the hub answers without waking up
                try
                {
                    await ws.ConnectAsync(uri, ct).ConfigureAwait(false);
                }
                catch (WebSocketException) when (ws.HttpStatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                {
                    Log.Info("Activity: the server no longer accepts this pc's token; forgetting the link");
                    await _onRevoked().ConfigureAwait(false);
                    return;
                }

                Log.Info("Activity: publishing connected");
                backoff = TimeSpan.FromSeconds(2);
                var closeCode = await SessionAsync(ws, ct).ConfigureAwait(false);
                if (closeCode == 4002) wait = TimeSpan.FromMinutes(2); // another copy of the app took over; don't fight it
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex) when (ex is WebSocketException or HttpRequestException or IOException or OperationCanceledException)
            {
                Log.Warn($"Activity: publishing disconnected ({ex.Message}); retrying in {wait.TotalSeconds:0} s");
            }

            if (ct.IsCancellationRequested) return;
            await Task.Delay(Jitter(wait), ct).ContinueWith(_ => { }, TaskScheduler.Default).ConfigureAwait(false);
            backoff = TimeSpan.FromSeconds(Math.Min(120, backoff.TotalSeconds * 2));
        }
    }

    /// <summary>One connection: send everything, then react to changes until the socket closes. Returns the close code.</summary>
    private async Task<int> SessionAsync(ClientWebSocket ws, CancellationToken ct)
    {
        using var session = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var receive = ReceiveAsync(ws, session.Token);

        Interlocked.Exchange(ref _libraryDirty, 1);
        Interlocked.Exchange(ref _mediaDirty, 1);
        _outbox.Clear(); // answers meant for an earlier connection are stale
        var lastLibrary = DateTime.MinValue;
        var nextPing = DateTime.UtcNow + PingEvery;
        DateTime? libraryDue = DateTime.UtcNow; // first library goes out right away
        DateTime? mediaDue = DateTime.UtcNow;

        try
        {
            while (ws.State == WebSocketState.Open && !receive.IsCompleted)
            {
                var now = DateTime.UtcNow;
                if (Interlocked.Exchange(ref _libraryDirty, 0) == 1 && libraryDue is null) libraryDue = now + LibraryDebounce;
                if (Interlocked.Exchange(ref _mediaDirty, 0) == 1) mediaDue = now + MediaDebounce;

                if (libraryDue <= now && now - lastLibrary >= LibraryMinGap)
                {
                    await SendAsync(ws, new JsonObject { ["type"] = "LIBRARY", ["games"] = LibrarySummary() }, session.Token).ConfigureAwait(false);
                    lastLibrary = now;
                    libraryDue = null;
                }
                if (mediaDue <= now)
                {
                    await SendAsync(ws, new JsonObject { ["type"] = "NOW_PLAYING", ["media"] = NowPlaying() }, session.Token).ConfigureAwait(false);
                    mediaDue = null;
                }
                while (_outbox.TryDequeue(out var packet))
                    await SendAsync(ws, packet, session.Token).ConfigureAwait(false);
                if (now >= nextPing)
                {
                    await ws.SendAsync(Encoding.UTF8.GetBytes("ping"), WebSocketMessageType.Text, true, session.Token).ConfigureAwait(false);
                    nextPing = now + PingEvery;
                }

                // Sleep until the next deadline or a change, whichever comes first.
                var until = new[] { nextPing, libraryDue ?? DateTime.MaxValue, mediaDue ?? DateTime.MaxValue }.Min();
                if (libraryDue is not null && lastLibrary + LibraryMinGap > until) until = lastLibrary + LibraryMinGap;
                var delay = until - DateTime.UtcNow;
                if (delay > TimeSpan.Zero)
                {
                    await Task.WhenAny(_wake.WaitAsync(delay, session.Token), receive).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            session.Cancel();
            if (ws.State == WebSocketState.Open)
            {
                try { await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None).ConfigureAwait(false); }
                catch (WebSocketException) { }
            }
        }
        return (int?)ws.CloseStatus ?? 1006;
    }

    private async Task ReceiveAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                var builder = new StringBuilder();
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    builder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                } while (!result.EndOfMessage && builder.Length < 64 * 1024);

                var text = builder.ToString();
                if (text == "pong") continue;
                try
                {
                    if (JsonNode.Parse(text) is { } node) MessageReceived?.Invoke(node);
                }
                catch (System.Text.Json.JsonException) { }
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException) { }
    }

    private static Task SendAsync(ClientWebSocket ws, JsonObject packet, CancellationToken ct) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(packet.ToJsonString()), WebSocketMessageType.Text, true, ct);

    /// <summary>id / title / platform / public cover URL, most recently played first.</summary>
    private JsonArray LibrarySummary()
    {
        var games = new JsonArray();
        foreach (var game in _library.GetSnapshot()
                     .OrderByDescending(g => g.LastPlayed ?? DateTimeOffset.MinValue)
                     .ThenBy(g => g.SortTitle, StringComparer.CurrentCultureIgnoreCase)
                     .Take(MaxGames))
        {
            games.Add(new JsonObject
            {
                ["id"] = game.Id,
                ["title"] = game.Title,
                ["platform"] = game.Platform,
                ["cover"] = PublicCover(game),
            });
        }
        return games;
    }

    private static string? PublicCover(GameEntry game)
    {
        if (game.Metadata.TryGetValue(GameMetadataKeys.SteamAppId, out var appId) && appId.All(char.IsDigit))
            return $"https://cdn.cloudflare.steamstatic.com/steam/apps/{appId}/library_600x900.jpg";
        if (game.Metadata.TryGetValue(GameMetadataKeys.CoverUrl, out var url) && url.StartsWith("https://", StringComparison.Ordinal))
            return url; // e.g. Battle.net box art; the server keeps it only if the host is an allowed store CDN
        return null;
    }

    private JsonObject? NowPlaying()
    {
        var info = _media.Current;
        if (info is null || string.IsNullOrWhiteSpace(info.Title)) return null;
        return new JsonObject
        {
            ["title"] = info.Title,
            ["artist"] = info.Artist,
            ["app"] = info.SourceAppName,
            ["playing"] = info.State == MediaPlaybackState.Playing,
        };
    }

    private static TimeSpan Jitter(TimeSpan wait) => wait * (0.8 + Random.Shared.NextDouble() * 0.4);
}
