using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Dashboard.App.Audio;
using Dashboard.App.Services;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Avatars;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Services;
using Dashboard.Core.Settings;

namespace Dashboard.App.Web;

/// <summary>Window-level operations the bridge can trigger, supplied by <see cref="WebShellWindow"/>.</summary>
public sealed record WebShellActions(Action ToggleFullscreen, Action Exit, Action<JsonObject> OpenGamercard, Action<JsonObject> ActivityLinkResult);

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
    private readonly FriendStore _friends;
    private readonly ActivityBridgeService _activity;
    private readonly string _coversDir = AppPaths.CoversDir.TrimEnd('\\');

    public XboxHostBridge(GameLibraryService library, SoundService sounds, SettingsStore settings, IMediaService media, WebShellActions shell, AvatarProfileStore avatar, FriendStore friends, ActivityBridgeService activity)
    {
        _activity = activity;
        _avatar = avatar;
        _friends = friends;
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

    /// <summary>
    /// A plaza avatar was clicked: C# validates its recipe, builds the gamercard summary (library stats for the local
    /// player) and pushes OPEN_GAMERCARD to the page. False if the recipe is invalid.
    /// </summary>
    public bool InspectAvatar(string dnaJson)
    {
        var dna = AvatarDna.TryParse(dnaJson);
        if (dna is null) return false;

        var isLocal = dna.Id == "local";
        var card = new JsonObject
        {
            ["gamertag"] = dna.Name,
            ["color"] = dna.ShirtColor,
            ["local"] = isLocal,
        };
        if (isLocal)
        {
            var games = _library.GetSnapshot();
            card["stats"] = new JsonObject
            {
                ["games"] = games.Count,
                ["launches"] = games.Sum(g => g.PlayCount),
                ["last played"] = games.Where(g => g.LastPlayed is not null).MaxBy(g => g.LastPlayed)?.Title ?? "—",
            };
        }
        else
        {
            card["stats"] = new JsonObject { ["status"] = "plaza resident", ["zone"] = "your plaza" };
        }
        Log.Info($"Web: inspect avatar {dna.Id} ({dna.Name})");
        _shell.OpenGamercard(card);
        return true;
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

    // ───────────── P2P friends (phase 5) ─────────────

    /// <summary>This player's friend code (also their PeerJS id suffix).</summary>
    public string GetFriendCode() => _friends.FriendCode;

    /// <summary>Cached friends: [{ code, lastSeen, dna }]. Offline friends roam the plaza as NPCs from these.</summary>
    public string GetFriendsJson()
    {
        var list = new JsonArray();
        foreach (var f in _friends.Friends)
        {
            list.Add(new JsonObject
            {
                ["code"] = f.Code,
                ["lastSeen"] = f.LastSeen.ToString("O"),
                ["dna"] = JsonNode.Parse(f.Dna.ToJson()),
            });
        }
        return list.ToJsonString();
    }

    /// <summary>
    /// A peer sent its recipe (JOIN_SYNC / DNA_UPDATE). Untrusted: C# validates, normalises, pins id = friend_CODE and
    /// caches it. Returns the recipe to render, or an empty string to drop the peer's message.
    /// </summary>
    public string RememberFriend(string code, string dnaJson)
    {
        var dna = _friends.Remember(code, dnaJson);
        if (dna is null) { Log.Warn($"Web: rejected recipe from peer '{code}'"); return string.Empty; }
        return dna.ToJson();
    }

    public bool ForgetFriend(string code) => _friends.Forget(code);

    // ───────────── Discord Activity link (ticket 06) ─────────────

    /// <summary>{ linked, displayName, name }: whether this PC is linked to the Activity, and as whom.</summary>
    public string GetActivityLinkJson() => ActivityLinkJson(_activity.Link).ToJsonString();

    /// <summary>Redeems a code from the Activity. Returns at once; the outcome arrives as an ACTIVITY_LINK message.</summary>
    public void LinkActivity(string code)
    {
        _ = Task.Run(async () =>
        {
            var result = await _activity.LinkAsync(code);
            var json = ActivityLinkJson(_activity.Link);
            json["success"] = result.Success;
            json["message"] = result.Message;
            _shell.ActivityLinkResult(json);
        });
    }

    /// <summary>Unlinks this PC; the new state arrives as an ACTIVITY_LINK message.</summary>
    public void UnlinkActivity() => _ = Task.Run(_activity.UnlinkAsync);

    public static JsonObject ActivityLinkJson(ActivityLink? link) => new()
    {
        ["linked"] = link is not null,
        ["displayName"] = link?.DisplayName,
        ["name"] = link?.Name,
    };

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
