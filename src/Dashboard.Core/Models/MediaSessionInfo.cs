namespace Dashboard.Core.Models;

public enum MediaPlaybackState
{
    Unknown,
    Stopped,
    Paused,
    Playing,
    Changing,
}

/// <summary>Snapshot of the current system media session (Spotify, a browser tab, VLC…).</summary>
public sealed record MediaSessionInfo(
    string SourceAppId,
    string SourceAppName,
    string Title,
    string Artist,
    string AlbumTitle,
    MediaPlaybackState State,
    byte[]? ThumbnailBytes,
    bool CanPlayPause,
    bool CanGoNext,
    bool CanGoPrevious);
