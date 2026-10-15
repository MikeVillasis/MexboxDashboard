using System.Text.Json;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Microsoft.Win32;

namespace Dashboard.Core.Scanners.Epic;

/// <summary>
/// Discovery: the launcher's per-install JSON manifests in {AppDataPath}\Manifests\*.item
/// (AppDataPath from HKLM\SOFTWARE\WOW6432Node\Epic Games\EpicGamesLauncher, default C:\ProgramData\Epic\EpicGamesLauncher\Data).
/// Launch: com.epicgames.launcher://apps/{namespace}%3A{catalogItemId}%3A{appName}?action=launch&amp;silent=true,
/// so the Epic launcher handles sign-in, ownership checks and EOS anti-cheat.
/// </summary>
public sealed class EpicScanner : IGameScanner
{
    public const string Platform = "Epic";

    private const string DefaultDataPath = @"C:\ProgramData\Epic\EpicGamesLauncher\Data";

    public string PlatformName => Platform;

    public Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct)
    {
        var manifestsDir = Path.Combine(FindDataPath(), "Manifests");
        if (!Directory.Exists(manifestsDir))
        {
            Log.Info("Epic Games Launcher is not installed");
            return Task.FromResult(Enumerable.Empty<GameEntry>());
        }

        var games = new Dictionary<string, GameEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var manifest in Directory.EnumerateFiles(manifestsDir, "*.item"))
        {
            ct.ThrowIfCancellationRequested();
            var entry = TryReadManifest(manifest);
            if (entry is not null) games.TryAdd(entry.PlatformGameId, entry);
        }

        return Task.FromResult<IEnumerable<GameEntry>>(games.Values.ToList());
    }

    public Task LaunchGameAsync(GameEntry game)
    {
        ShellLauncher.OpenUri(game.LaunchUri ?? $"com.epicgames.launcher://apps/{game.PlatformGameId}?action=launch&silent=true");
        return Task.CompletedTask;
    }

    private static string FindDataPath()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Epic Games\EpicGamesLauncher");
        return key?.GetValue("AppDataPath") is string path && !string.IsNullOrWhiteSpace(path) ? path : DefaultDataPath;
    }

    private static GameEntry? TryReadManifest(string manifestPath)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(manifestPath),
                new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
            var root = doc.RootElement;

            var displayName = GetString(root, "DisplayName");
            var appName = GetString(root, "AppName");
            var installLocation = GetString(root, "InstallLocation");
            var ns = GetString(root, "CatalogNamespace");
            var itemId = GetString(root, "CatalogItemId");
            if (displayName is null || appName is null || ns is null || itemId is null) return null;

            if (root.TryGetProperty("bIsIncompleteInstall", out var incomplete) && incomplete.ValueKind == JsonValueKind.True) return null;

            // DLC manifests point at their base game; only the base game is launchable.
            var mainApp = GetString(root, "MainGameAppName");
            if (mainApp is not null && !string.Equals(mainApp, appName, StringComparison.OrdinalIgnoreCase)) return null;

            // Engines, plugins and asset packs share the manifest format but are not tagged "games".
            if (!HasCategory(root, "games")) return null;

            if (installLocation is null || !Directory.Exists(installLocation)) return null;

            var metadata = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["catalogNamespace"] = ns,
                ["catalogItemId"] = itemId,
            };
            if (GetString(root, "LaunchExecutable") is { } exe)
            {
                var exePath = Path.GetFullPath(Path.Combine(installLocation, exe));
                if (File.Exists(exePath)) metadata[GameMetadataKeys.IconSource] = exePath;
            }

            var id = $"{ns}%3A{itemId}%3A{appName}";
            return new GameEntry
            {
                Platform = Platform,
                PlatformGameId = appName,
                Title = displayName.Trim(),
                InstallPath = installLocation,
                LaunchUri = $"com.epicgames.launcher://apps/{id}?action=launch&silent=true",
                Metadata = metadata,
            };
        }
        catch (JsonException ex)
        {
            Log.Warn($"Ignoring malformed Epic manifest {manifestPath}", ex);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"Could not read {manifestPath}", ex);
            return null;
        }
    }

    private static string? GetString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } s
            ? s
            : null;

    private static bool HasCategory(JsonElement root, string category)
    {
        if (!root.TryGetProperty("AppCategories", out var categories) || categories.ValueKind != JsonValueKind.Array) return false;
        foreach (var item in categories.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && string.Equals(item.GetString(), category, StringComparison.OrdinalIgnoreCase))
                return true;
        }
        return false;
    }
}
