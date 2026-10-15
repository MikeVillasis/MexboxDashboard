using Dashboard.Core.Models;

namespace Dashboard.Core.Abstractions;

/// <summary>
/// System-wide "now playing" source. Phase 4 implements this over WinRT
/// GlobalSystemMediaTransportControlsSessionManager (event driven, no polling).
/// </summary>
public interface IMediaService : IDisposable
{
    MediaSessionInfo? Current { get; }

    /// <summary>Raised on a worker thread whenever the session, its metadata, or playback state changes. Null = nothing playing.</summary>
    event EventHandler<MediaSessionInfo?>? SessionUpdated;

    Task StartAsync(CancellationToken ct);

    Task<bool> TogglePlayPauseAsync();

    Task<bool> NextAsync();

    Task<bool> PreviousAsync();
}
