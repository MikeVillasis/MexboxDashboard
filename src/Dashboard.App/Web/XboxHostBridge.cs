using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Dashboard.App.Audio;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Services;
using Dashboard.Core.Settings;

namespace Dashboard.App.Web;

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
    private readonly GameLibraryService _library;
    private readonly SoundService _sounds;
    private readonly SettingsStore _settings;

    public XboxHostBridge(GameLibraryService library, SoundService sounds, SettingsStore settings)
    {
        _library = library;
        _sounds = sounds;
        _settings = settings;
    }

    /// <summary>Round-trip check used by the page on load.</summary>
    public string Ping(string message)
    {
        Log.Info($"Web: Ping('{message}') from page");
        return $"pong: {message}";
    }

    public string GetVersion() => typeof(XboxHostBridge).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

    /// <summary>The in-memory library snapshot as a JSON array (no disk access).</summary>
    public string GetLibraryJson()
    {
        var games = new JsonArray();
        foreach (var game in _library.GetSnapshot().OrderBy(g => g.SortTitle, StringComparer.CurrentCultureIgnoreCase))
        {
            games.Add(new JsonObject
            {
                ["id"] = game.Id,
                ["title"] = game.Title,
                ["platform"] = game.Platform,
                ["cover"] = game.CoverArtPath,
                ["lastPlayed"] = game.LastPlayed?.ToString("O"),
                ["playCount"] = game.PlayCount,
            });
        }
        return games.ToJsonString();
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
        _ = LaunchAsync();
        return true;

        async Task LaunchAsync()
        {
            try { await _library.LaunchAsync(game); }
            catch (Exception ex) { Log.Error($"Web: launch of {gameId} failed", ex); }
        }
    }

    /// <summary>Plays a UI cue by name ("Navigate", "Select", "Back", "BladeSwoosh", "ChannelChange").</summary>
    public bool PlaySound(string cue)
    {
        if (!Enum.TryParse<SoundCue>(cue, ignoreCase: true, out var parsed)) return false;
        _sounds.Play(parsed);
        return true;
    }
}
