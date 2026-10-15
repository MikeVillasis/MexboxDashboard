using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Dashboard.App.Audio;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Avatars;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Services;
using Dashboard.Core.Settings;

namespace Dashboard.App.Web;

/// <summary>Window-level operations the bridge can trigger, supplied by <see cref="WebShellWindow"/>.</summary>
public sealed record WebShellActions(Action ToggleFullscreen, Action Exit);

/// <summary>
/// Backend surface exposed to the page as <c>window.chrome.webview.hostObjects.xboxBackend</c>.
/// Thin by design: every member forwards to an existing C# service; no business logic lives here or in JS.
/// <para>
/// Calls arrive on the UI thread, so members only touch in-memory state or start background work. Anything structured
/// is returned as a JSON string (COM can't marshal records); the page parses it. From JS every call returns a Promise.
/// </para>
/// </summary>
[ComVisible(true)]
[ClassInterface(ClassInterfaceType.AutoDual)]
public sealed class XboxHostBridge
{
    public const string CoversHostName = "covers.xbox.local";

    private readonly GameLibraryService _library;
    private readonly SoundService _sounds;
    private readonly SettingsStore _settings;
    private readonly IMediaService _media;
    private readonly WebShellActions _shell;
    private readonly AvatarProfileStore _avatar;
    private readonly string _coversDir = AppPaths.CoversDir.TrimEnd('\\');

    public XboxHostBridge(GameLibraryService library, SoundService sounds, SettingsStore settings, IMediaService media, WebShellActions shell, AvatarProfileStore avatar)
    {
        _avatar = avatar;
        _library = library;
        _sounds = sounds;
        _settings = settings;
        _media = media;
        _shell = shell;
    }

    /// <summary>Round-trip check used by the page on load.</summary>
    public string Ping(string message)
    {
        Log.Info($"Web: Ping('{message}') from page");
        return $"pong: {message}";
    }

    public string GetVersion() => typeof(XboxHostBridge).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>The in-memory library snapshot as a JSON array (no disk access). Covers come as https://covers.xbox.local/ URLs.</summary>
    public string GetLibraryJson()
    {
        var games = new JsonArray();
        foreach (var game in _library.GetSnapshot().OrderBy(g => g.SortTitle, StringComparer.CurrentCultureIgnoreCase))
        {
            games.Add(new JsonObject
            {
                ["id"] = game.Id,
                ["title"] = game.Title,
                ["platform"] = game.Platform.ToLowerInvariant(),
                ["cover"] = CoverUrl(game.CoverArtPath),
                ["lastPlayed"] = game.LastPlayed?.ToString("O"),
                ["playCount"] = game.PlayCount,
            });
        }
        return games.ToJsonString();
    }

    /// <summary>Profile summary for the gamercard; the gamertag is the avatar recipe's name.</summary>
    public string GetProfileJson()
    {
        var games = _library.GetSnapshot();
        return new JsonObject
        {
            ["gamertag"] = _avatar.Current.Name,
            ["games"] = games.Count,
            ["launches"] = games.Sum(g => g.PlayCount),
            ["lastPlayed"] = games.Where(g => g.LastPlayed is not null).MaxBy(g => g.LastPlayed)?.Title,
        }.ToJsonString();
    }

    /// <summary>The local player's avatar DNA recipe (localProfile.json).</summary>
    public string GetAvatarDnaJson() => _avatar.Current.ToJson();

    /// <summary>
    /// Stores an edited recipe (debounced write). C# validates it: bad colours/ids are normalised, junk is rejected.
    /// Returns the normalised recipe the page should render, or an empty string when rejected.
    /// </summary>
    public string SaveAvatarDnaJson(string json)
    {
        var saved = _avatar.Update(json);
        if (saved is null) Log.Warn("Web: rejected an invalid avatar recipe");
        return saved?.ToJson() ?? string.Empty;
    }

    public string GetSettingsJson()
    {
        var s = _settings.Current;
        return new JsonObject { ["soundEnabled"] = s.SoundEnabled, ["lastGameId"] = s.LastGameId }.ToJsonString();
    }

    /// <summary>Launches through the platform's own URI / bootstrapper (same path as the native shell). False if unknown.</summary>
    public bool LaunchGame(string gameId)
    {
        var game = _library.GetSnapshot().FirstOrDefault(g => string.Equals(g.Id, gameId, StringComparison.OrdinalIgnoreCase));
        if (game is null) return false;

        _sounds.Play(SoundCue.ChannelChange);
        _ = Run(() => _library.LaunchAsync(game), $"launch of {gameId}");
        return true;
    }

    public void FocusGame(string gameId) => _settings.Update(s => s with { LastGameId = gameId });

    /// <summary>Plays a UI cue by name ("Navigate", "Select", "Back", "BladeSwoosh", "ChannelChange").</summary>
    public bool PlaySound(string cue)
    {
        if (!Enum.TryParse<SoundCue>(cue, ignoreCase: true, out var parsed)) return false;
        _sounds.Play(parsed);
        return true;
    }

    public void MediaPlayPause() => _ = Run(_media.TogglePlayPauseAsync, "media play/pause");

    public void MediaNext() => _ = Run(_media.NextAsync, "media next");

    public void MediaPrevious() => _ = Run(_media.PreviousAsync, "media previous");

    public void Rescan() => _ = Run(() => _library.RefreshAsync(CancellationToken.None), "rescan");

    public bool ToggleSound()
    {
        _sounds.Enabled = !_sounds.Enabled;
        _settings.Update(s => s with { SoundEnabled = _sounds.Enabled });
        return _sounds.Enabled;
    }

    public void ToggleFullscreen() => _shell.ToggleFullscreen();

    public void Exit() => _shell.Exit();

    /// <summary>Debug hook for the 3D layer: lets the page prove a canvas click reached C#.</summary>
    public void LogCanvasClick(double x, double z) => Log.Info($"Web: 3D canvas click at floor ({x:0.00}, {z:0.00})");

    /// <summary>Only files inside the covers folder are reachable; anything else has no URL.</summary>
    private string? CoverUrl(string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        if (!string.Equals(Path.GetDirectoryName(path), _coversDir, StringComparison.OrdinalIgnoreCase)) return null;
        return $"https://{CoversHostName}/{Uri.EscapeDataString(Path.GetFileName(path))}";
    }

    private static async Task Run<T>(Func<Task<T>> action, string what)
    {
        try { await action(); }
        catch (Exception ex) { Log.Error($"Web: {what} failed", ex); }
    }

    private static async Task Run(Func<Task> action, string what)
    {
        try { await action(); }
        catch (Exception ex) { Log.Error($"Web: {what} failed", ex); }
    }
}
