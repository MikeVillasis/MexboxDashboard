using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Microsoft.Win32;

namespace Dashboard.Core.Scanners.Steam;

/// <summary>
/// Reference <see cref="IGameScanner"/> implementation (the other four platforms follow this shape in Phase 3).
/// Discovery: HKCU\Software\Valve\Steam\SteamPath → steamapps\libraryfolders.vdf → appmanifest_*.acf.
/// Launch: steam://rungameid/{AppId}, so Steam handles sign-in, updates and DRM.
/// </summary>
public sealed class SteamScanner : IGameScanner
{
    public const string Platform = "Steam";

    // Tools and runtimes that ship as "apps" but are not games.
    private static readonly HashSet<string> ExcludedAppIds = new(StringComparer.Ordinal)
    {
        "228980",  // Steamworks Common Redistributables
        "1070560", // Steam Linux Runtime 1.0 (scout)
        "1391110", // Steam Linux Runtime 2.0 (soldier)
        "1628350", // Steam Linux Runtime 3.0 (sniper)
        "250820",  // SteamVR
    };

    private const int StateFullyInstalled = 4;
    private const int StateUpdateRequired = 2;

    public string PlatformName => Platform;

    public Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct)
    {
        var steamPath = FindSteamPath();
        if (steamPath is null)
        {
            Log.Info("Steam is not installed");
            return Task.FromResult(Enumerable.Empty<GameEntry>());
        }

        var games = new Dictionary<string, GameEntry>(StringComparer.Ordinal);
        foreach (var library in GetLibraryFolders(steamPath))
        {
            ct.ThrowIfCancellationRequested();
            var steamApps = Path.Combine(library, "steamapps");
            if (!Directory.Exists(steamApps)) continue;

            foreach (var manifest in Directory.EnumerateFiles(steamApps, "appmanifest_*.acf"))
            {
                ct.ThrowIfCancellationRequested();
                var entry = TryReadManifest(manifest, library, steamPath);
                if (entry is not null) games.TryAdd(entry.PlatformGameId, entry);
            }
        }

        return Task.FromResult<IEnumerable<GameEntry>>(games.Values.ToList());
    }

    public Task LaunchGameAsync(GameEntry game)
    {
        ShellLauncher.OpenUri(game.LaunchUri ?? $"steam://rungameid/{game.PlatformGameId}");
        return Task.CompletedTask;
    }

    internal static string? FindSteamPath()
    {
        string? path;
        using (var user = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
        {
            path = user?.GetValue("SteamPath") as string;
        }

        if (string.IsNullOrWhiteSpace(path))
        {
            using var machine = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Valve\Steam");
            path = machine?.GetValue("InstallPath") as string;
        }

        if (string.IsNullOrWhiteSpace(path)) return null;

        // SteamPath is stored with forward slashes, e.g. "c:/program files (x86)/steam".
        path = Path.GetFullPath(path.Replace('/', Path.DirectorySeparatorChar));
        return Directory.Exists(path) ? path : null;
    }

    private static List<string> GetLibraryFolders(string steamPath)
    {
        var folders = new List<string> { steamPath };
        var vdfPath = Path.Combine(steamPath, "steamapps", "libraryfolders.vdf");
        if (!File.Exists(vdfPath)) return folders;

        try
        {
            var root = VdfParser.Parse(File.ReadAllText(vdfPath));
            var libraries = root.Child("libraryfolders");
            if (libraries is null) return folders;

            // Current format: "libraryfolders" { "0" { "path" "C:\\..." "apps" {…} } }
            foreach (var (_, node) in libraries.Children)
                Add(node.Value("path"));

            // Legacy format: "LibraryFolders" { "1" "D:\\SteamLibrary" }
            foreach (var (key, value) in libraries.Values)
            {
                if (int.TryParse(key, out _)) Add(value);
            }
        }
        catch (Exception ex)
        {
            Log.Warn("Could not read Steam libraryfolders.vdf", ex);
        }

        return folders;

        void Add(string? candidate)
        {
            if (string.IsNullOrWhiteSpace(candidate)) return;
            try
            {
                var full = Path.GetFullPath(candidate);
                if (!folders.Contains(full, StringComparer.OrdinalIgnoreCase)) folders.Add(full);
            }
            catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
            {
                Log.Warn($"Ignoring invalid Steam library path '{candidate}'", ex);
            }
        }
    }

    private static GameEntry? TryReadManifest(string manifestPath, string libraryPath, string steamPath)
    {
        try
        {
            var app = VdfParser.Parse(File.ReadAllText(manifestPath)).Child("AppState");
            if (app is null) return null;

            var appId = app.Value("appid");
            var name = app.Value("name");
            if (string.IsNullOrWhiteSpace(appId) || string.IsNullOrWhiteSpace(name)) return null;
            if (ExcludedAppIds.Contains(appId)) return null;

            // Skip first-time downloads; keep installed games even while they are updating.
            if (int.TryParse(app.Value("StateFlags"), out var flags) &&
                (flags & (StateFullyInstalled | StateUpdateRequired)) == 0)
            {
                return null;
            }

            var installDir = app.Value("installdir");
            var metadata = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["library"] = libraryPath,
                [GameMetadataKeys.SteamAppId] = appId,
            };
            if (app.Value("SizeOnDisk") is { Length: > 0 } size) metadata["sizeOnDisk"] = size;
            if (FindLocalCover(steamPath, appId) is { } cover) metadata[GameMetadataKeys.CoverSource] = cover;

            return new GameEntry
            {
                Platform = Platform,
                PlatformGameId = appId,
                Title = name.Trim(),
                InstallPath = string.IsNullOrWhiteSpace(installDir) ? null : Path.Combine(libraryPath, "steamapps", "common", installDir),
                LaunchUri = $"steam://rungameid/{appId}",
                Metadata = metadata,
            };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"Could not read {manifestPath}", ex);
            return null;
        }
    }

    /// <summary>
    /// Steam's own 600x900 portrait capsule if the client has cached it, else its 460x215 header
    /// (the cover pipeline fits landscape art onto a portrait backdrop).
    /// </summary>
    private static string? FindLocalCover(string steamPath, string appId)
    {
        try
        {
            var cacheDir = Path.Combine(steamPath, "appcache", "librarycache");

            // Pre-2024 clients: flat files.
            var legacy = Path.Combine(cacheDir, $"{appId}_library_600x900.jpg");
            if (File.Exists(legacy)) return legacy;

            // Newer clients: one folder per app, usually with hashed sub-folders per asset.
            var appDir = Path.Combine(cacheDir, appId);
            if (Directory.Exists(appDir))
            {
                foreach (var pattern in new[] { "library_600x900*.jpg", "library_capsule*.jpg", "library_header*.jpg", "header*.jpg" })
                {
                    var match = Directory.EnumerateFiles(appDir, pattern, SearchOption.AllDirectories).FirstOrDefault();
                    if (match is not null) return match;
                }
            }

            var legacyHeader = Path.Combine(cacheDir, $"{appId}_header.jpg");
            return File.Exists(legacyHeader) ? legacyHeader : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
