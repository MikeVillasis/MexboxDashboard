using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Windows.ApplicationModel;
using Windows.Media.Control;
using GsmtcManager = Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager;
using GsmtcSession = Windows.Media.Control.GlobalSystemMediaTransportControlsSession;
using GsmtcStatus = Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus;

namespace Dashboard.Core.Services;

/// <summary>
/// System-wide "now playing" over WinRT <see cref="GsmtcManager"/> (the same source as the Windows volume flyout).
/// Purely event driven: CurrentSessionChanged / SessionsChanged pick the session, MediaPropertiesChanged re-reads
/// metadata and artwork, PlaybackInfoChanged re-reads state and controls. Nothing polls.
/// <para>
/// The thumbnail array is reused while the track is unchanged, so UI consumers can compare by reference
/// and skip re-decoding on play/pause.
/// </para>
/// </summary>
public sealed class SmtcMediaService : IMediaService
{
    private const ulong MaxThumbnailBytes = 8 * 1024 * 1024;

    // Win32 apps report their process name as the AUMID; give the common ones a readable label.
    private static readonly Dictionary<string, string> KnownApps = new(StringComparer.OrdinalIgnoreCase)
    {
        ["spotify"] = "Spotify",
        ["chrome"] = "Chrome",
        ["msedge"] = "Edge",
        ["firefox"] = "Firefox",
        ["308046B0AF4A39CB"] = "Firefox", // Firefox registers under a hash of its install path; this is the default install.
        ["opera"] = "Opera",
        ["brave"] = "Brave",
        ["vlc"] = "VLC",
        ["foobar2000"] = "foobar2000",
        ["MusicBee"] = "MusicBee",
        ["AIMP"] = "AIMP",
        ["iTunes"] = "iTunes",
    };

    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private readonly object _gate = new();

    private GsmtcManager? _manager;
    private GsmtcSession? _session;
    private TrackInfo? _track;
    private MediaSessionInfo? _current;
    private bool _disposed;

    public MediaSessionInfo? Current
    {
        get { lock (_gate) return _current; }
    }

    public event EventHandler<MediaSessionInfo?>? SessionUpdated;

    public async Task StartAsync(CancellationToken ct)
    {
        try
        {
            var manager = await GsmtcManager.RequestAsync().AsTask(ct).ConfigureAwait(false);
            lock (_gate)
            {
                if (_disposed || _manager is not null) return;
                _manager = manager;
            }

            manager.CurrentSessionChanged += OnSessionsChanged;
            manager.SessionsChanged += OnSessionsChanged;
            Log.Info("Media: listening to system media sessions");
            await SelectSessionAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            // Older or stripped-down Windows builds can lack the API; the Media blade then shows "nothing playing".
            Log.Error("Media: system media sessions are unavailable", ex);
        }
    }

    public Task<bool> TogglePlayPauseAsync() => RunCommandAsync(s => s.TryTogglePlayPauseAsync().AsTask(), "play/pause");

    public Task<bool> NextAsync() => RunCommandAsync(s => s.TrySkipNextAsync().AsTask(), "next");

    public Task<bool> PreviousAsync() => RunCommandAsync(s => s.TrySkipPreviousAsync().AsTask(), "previous");

    public void Dispose()
    {
        GsmtcManager? manager;
        GsmtcSession? session;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            manager = _manager;
            session = _session;
            _manager = null;
            _session = null;
        }

        if (manager is not null)
        {
            manager.CurrentSessionChanged -= OnSessionsChanged;
            manager.SessionsChanged -= OnSessionsChanged;
        }
        Detach(session);
    }

    private void OnSessionsChanged(GsmtcManager sender, object args) => _ = SelectSessionAsync();

    private void OnMediaPropertiesChanged(GsmtcSession sender, MediaPropertiesChangedEventArgs args) =>
        _ = RefreshAsync(sender, readProperties: true);

    private void OnPlaybackInfoChanged(GsmtcSession sender, PlaybackInfoChangedEventArgs args) =>
        _ = RefreshAsync(sender, readProperties: false);

    /// <summary>
    /// Follows Windows' notion of the current session; when it has none (e.g. the last player paused and lost focus)
    /// falls back to any playing session, then to any session at all.
    /// </summary>
    private async Task SelectSessionAsync()
    {
        try
        {
            GsmtcManager? manager;
            lock (_gate) manager = _manager;
            if (manager is null) return;

            var next = manager.GetCurrentSession();
            if (next is null)
            {
                var sessions = manager.GetSessions();
                next = sessions.FirstOrDefault(s => s.GetPlaybackInfo()?.PlaybackStatus == GsmtcStatus.Playing)
                       ?? sessions.FirstOrDefault();
            }

            GsmtcSession? previous;
            bool samePlayer;
            lock (_gate)
            {
                if (_disposed) return;
                previous = _session;
                samePlayer = previous is not null && next is not null && previous.SourceAppUserModelId == next.SourceAppUserModelId;
                _session = next;

                // WinRT hands out a fresh wrapper per call: for the same player keep the track so its artwork array survives.
                if (!samePlayer) _track = null;
            }

            Detach(previous);
            if (next is null)
            {
                Publish(null);
                return;
            }

            next.MediaPropertiesChanged += OnMediaPropertiesChanged;
            next.PlaybackInfoChanged += OnPlaybackInfoChanged;
            if (!samePlayer) Log.Info($"Media: following {next.SourceAppUserModelId}");
            await RefreshAsync(next, readProperties: true).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Warn("Media: could not select a session", ex);
        }
    }

    private async Task RefreshAsync(GsmtcSession session, bool readProperties)
    {
        // Players fire bursts of events (title, then artwork, then state); serialising keeps the snapshots ordered.
        await _refreshLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!IsActive(session)) return;

            TrackInfo? track;
            lock (_gate) track = _track;

            if (readProperties || track is null)
            {
                var properties = await session.TryGetMediaPropertiesAsync().AsTask().ConfigureAwait(false);
                track = await ReadTrackAsync(properties, track).ConfigureAwait(false);
                lock (_gate)
                {
                    if (!ReferenceEquals(_session, session)) return;
                    _track = track;
                }
            }

            var playback = session.GetPlaybackInfo();
            var controls = playback?.Controls;
            var info = new MediaSessionInfo(
                session.SourceAppUserModelId,
                ResolveAppName(session.SourceAppUserModelId),
                track.Title,
                track.Artist,
                track.Album,
                MapState(playback?.PlaybackStatus),
                track.Thumbnail,
                controls?.IsPlayPauseToggleEnabled ?? controls?.IsPlayEnabled ?? false,
                controls?.IsNextEnabled ?? false,
                controls?.IsPreviousEnabled ?? false);

            if (IsActive(session)) Publish(info);
        }
        catch (Exception ex)
        {
            // The player can close between the event and our read; the next SessionsChanged will sort it out.
            Log.Warn($"Media: could not read session {SafeAumid(session)}", ex);
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>Reads metadata; keeps the previous artwork array when the track did not change.</summary>
    private static async Task<TrackInfo> ReadTrackAsync(GlobalSystemMediaTransportControlsSessionMediaProperties? properties, TrackInfo? previous)
    {
        var title = properties?.Title ?? string.Empty;
        var artist = FirstNonEmpty(properties?.Artist, properties?.AlbumArtist) ?? string.Empty;
        var album = properties?.AlbumTitle ?? string.Empty;

        var sameTrack = previous is not null && previous.Title == title && previous.Artist == artist && previous.Album == album;
        if (sameTrack && previous!.Thumbnail is not null) return previous;

        byte[]? thumbnail = null;
        if (properties?.Thumbnail is { } reference)
        {
            try
            {
                using var stream = await reference.OpenReadAsync().AsTask().ConfigureAwait(false);
                if (stream.Size is > 0 and <= MaxThumbnailBytes)
                {
                    await using var input = stream.AsStreamForRead();
                    using var buffer = new MemoryStream((int)stream.Size);
                    await input.CopyToAsync(buffer).ConfigureAwait(false);
                    thumbnail = buffer.ToArray();
                }
            }
            catch (Exception ex)
            {
                Log.Warn("Media: could not read artwork", ex);
            }
        }

        return new TrackInfo(title, artist, album, thumbnail ?? (sameTrack ? previous!.Thumbnail : null));
    }

    private async Task<bool> RunCommandAsync(Func<GsmtcSession, Task<bool>> command, string name)
    {
        GsmtcSession? session;
        lock (_gate) session = _session;
        if (session is null) return false;

        try
        {
            return await command(session).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Warn($"Media: {name} failed for {SafeAumid(session)}", ex);
            return false;
        }
    }

    private void Publish(MediaSessionInfo? info)
    {
        lock (_gate)
        {
            if (_disposed || Equals(_current, info)) return;
            _current = info;
        }
        SessionUpdated?.Invoke(this, info);
    }

    private bool IsActive(GsmtcSession session)
    {
        lock (_gate) return !_disposed && ReferenceEquals(_session, session);
    }

    private void Detach(GsmtcSession? session)
    {
        if (session is null) return;
        try
        {
            session.MediaPropertiesChanged -= OnMediaPropertiesChanged;
            session.PlaybackInfoChanged -= OnPlaybackInfoChanged;
        }
        catch (Exception ex)
        {
            Log.Warn("Media: could not detach from a closed session", ex);
        }
    }

    private static MediaPlaybackState MapState(GsmtcStatus? status) => status switch
    {
        GsmtcStatus.Playing => MediaPlaybackState.Playing,
        GsmtcStatus.Paused => MediaPlaybackState.Paused,
        GsmtcStatus.Stopped or GsmtcStatus.Closed => MediaPlaybackState.Stopped,
        GsmtcStatus.Changing or GsmtcStatus.Opened => MediaPlaybackState.Changing,
        _ => MediaPlaybackState.Unknown,
    };

    /// <summary>Packaged apps resolve through AppInfo; Win32 apps report "name.exe" (or a hash for Firefox).</summary>
    private static string ResolveAppName(string aumid)
    {
        if (string.IsNullOrEmpty(aumid)) return string.Empty;

        if (aumid.Contains('!'))
        {
            try
            {
                var name = AppInfo.GetFromAppUserModelId(aumid)?.DisplayInfo?.DisplayName;
                if (!string.IsNullOrWhiteSpace(name)) return name;
            }
            catch (Exception)
            {
                // Not resolvable for this user; fall through to the package name.
            }
            aumid = aumid[..aumid.IndexOf('!')];
            var underscore = aumid.LastIndexOf('_');
            if (underscore > 0) aumid = aumid[..underscore];
            var dot = aumid.LastIndexOf('.');
            if (dot >= 0 && dot < aumid.Length - 1) aumid = aumid[(dot + 1)..];
        }

        var stem = aumid.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? aumid[..^4] : aumid;
        stem = Path.GetFileName(stem);
        return KnownApps.TryGetValue(stem, out var known) ? known : stem;
    }

    private static string? FirstNonEmpty(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    private static string SafeAumid(GsmtcSession session)
    {
        try { return session.SourceAppUserModelId; }
        catch (Exception) { return "<closed>"; }
    }

    private sealed record TrackInfo(string Title, string Artist, string Album, byte[]? Thumbnail);
}
