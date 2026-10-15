using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Models;

namespace Dashboard.App.ViewModels;

/// <summary>
/// Shared by the Media blade and the "now playing" pill on the Games blade.
/// Service events arrive on worker threads and are marshalled here; thumbnails decode off the UI thread.
/// </summary>
public sealed class MediaViewModel : ObservableObject
{
    private readonly IMediaService _service;
    private readonly Dispatcher _dispatcher;
    private MediaSessionInfo? _session;
    private ImageSource? _thumbnail;
    private byte[]? _thumbnailBytes;

    public MediaViewModel(IMediaService service, Dispatcher dispatcher)
    {
        _service = service;
        _dispatcher = dispatcher;
        _service.SessionUpdated += (_, info) => _dispatcher.InvokeAsync(() => Apply(info));
        Apply(service.Current);
    }

    public bool HasSession => _session is not null;
    public string Title => _session?.Title ?? string.Empty;
    public string Artist => _session?.Artist ?? string.Empty;
    public string Album => _session?.AlbumTitle ?? string.Empty;
    public string SourceApp => (_session?.SourceAppName ?? string.Empty).ToLowerInvariant();
    public bool IsPlaying => _session?.State == MediaPlaybackState.Playing;
    public bool CanGoNext => _session?.CanGoNext ?? false;
    public bool CanGoPrevious => _session?.CanGoPrevious ?? false;

    /// <summary>Segoe Fluent/MDL2 glyph: Pause while playing, Play otherwise.</summary>
    public string PlayPauseGlyph => IsPlaying ? "" : "";

    public ImageSource? Thumbnail
    {
        get => _thumbnail;
        private set => SetProperty(ref _thumbnail, value);
    }

    public Task TogglePlayPauseAsync() => _service.TogglePlayPauseAsync();

    public Task NextAsync() => _service.NextAsync();

    public Task PreviousAsync() => _service.PreviousAsync();

    private async void Apply(MediaSessionInfo? info)
    {
        _session = info;
        OnPropertyChanged(string.Empty);

        var bytes = info?.ThumbnailBytes;
        if (ReferenceEquals(bytes, _thumbnailBytes)) return;
        _thumbnailBytes = bytes;

        if (bytes is null || bytes.Length == 0)
        {
            Thumbnail = null;
            return;
        }

        var decoded = await Task.Run(() => Decode(bytes));
        if (ReferenceEquals(bytes, _thumbnailBytes)) Thumbnail = decoded;
    }

    private static ImageSource? Decode(byte[] bytes)
    {
        try
        {
            using var stream = new MemoryStream(bytes, writable: false);
            var bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
            bitmap.DecodePixelWidth = 400;
            bitmap.StreamSource = stream;
            bitmap.EndInit();
            bitmap.Freeze();
            return bitmap;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
