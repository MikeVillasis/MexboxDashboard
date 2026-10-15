using System.Text.Json;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;

namespace Dashboard.Core.Scanners.Riot;

/// <summary>
/// Discovery: C:\ProgramData\Riot Games\Metadata\{product}.{patchline}\{product}.{patchline}.product_settings.yaml
/// (product_install_full_path), with the Riot Client bootstrapper located through RiotClientInstalls.json.
/// Launch: RiotClientServices.exe --launch-product={product} --launch-patchline={patchline}, so the Riot Client
/// handles sign-in, patching and Vanguard.
/// </summary>
public sealed class RiotScanner : IGameScanner
{
    public const string Platform = "Riot";

    private static readonly string RiotDataDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Riot Games");

    private static readonly Dictionary<string, string> KnownTitles = new(StringComparer.OrdinalIgnoreCase)
    {
        ["league_of_legends"] = "League of Legends",
        ["valorant"] = "VALORANT",
        ["bacon"] = "Legends of Runeterra",
        ["lion"] = "2XKO",
        ["teamfighttactics"] = "Teamfight Tactics",
    };

    public string PlatformName => Platform;

    public Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct)
    {
        var metadataDir = Path.Combine(RiotDataDir, "Metadata");
        if (!Directory.Exists(metadataDir))
        {
            Log.Info("Riot Client is not installed");
            return Task.FromResult(Enumerable.Empty<GameEntry>());
        }

        var clients = ReadClientInstalls();
        var games = new List<GameEntry>();

        foreach (var productDir in Directory.EnumerateDirectories(metadataDir))
        {
            ct.ThrowIfCancellationRequested();

            // "{product}.{patchline}"; skips "Riot Client" and helper folders such as "league_of_legends.live.game_patch".
            var key = Path.GetFileName(productDir);
            var parts = key.Split('.');
            if (parts.Length != 2) continue;
            var (product, patchline) = (parts[0], parts[1]);

            var installPath = ReadInstallPath(Path.Combine(productDir, key + ".product_settings.yaml"));
            if (installPath is null || !Directory.Exists(installPath)) continue;

            var client = clients.ForInstall(installPath);
            if (client is null)
            {
                Log.Warn($"Riot: {key} is installed but RiotClientServices.exe was not found");
                continue;
            }

            var title = KnownTitles.GetValueOrDefault(product) ?? product.Replace('_', ' ');
            if (!string.Equals(patchline, "live", StringComparison.OrdinalIgnoreCase)) title += $" ({patchline.ToUpperInvariant()})";

            var metadata = new Dictionary<string, string>(StringComparer.Ordinal) { ["patchline"] = patchline };
            var icon = Path.Combine(productDir, key + ".ico");
            if (File.Exists(icon)) metadata[GameMetadataKeys.CoverSource] = icon;

            games.Add(new GameEntry
            {
                Platform = Platform,
                PlatformGameId = key,
                Title = title,
                InstallPath = installPath,
                ExecutablePath = client,
                LaunchArguments = $"--launch-product={product} --launch-patchline={patchline}",
                Metadata = metadata,
            });
        }

        return Task.FromResult<IEnumerable<GameEntry>>(games);
    }

    public Task LaunchGameAsync(GameEntry game)
    {
        if (game.ExecutablePath is null) throw new InvalidOperationException($"No Riot Client is recorded for {game.Id}.");
        ShellLauncher.StartExecutable(game.ExecutablePath, game.LaunchArguments);
        return Task.CompletedTask;
    }

    private static string? ReadInstallPath(string yamlPath)
    {
        if (!File.Exists(yamlPath)) return null;
        try
        {
            foreach (var line in File.ReadLines(yamlPath))
            {
                var trimmed = line.Trim();
                if (!trimmed.StartsWith("product_install_full_path:", StringComparison.Ordinal)) continue;
                return NormalizePath(trimmed["product_install_full_path:".Length..]);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"Could not read {yamlPath}", ex);
        }
        return null;
    }

    private static ClientInstalls ReadClientInstalls()
    {
        var path = Path.Combine(RiotDataDir, "RiotClientInstalls.json");
        var associated = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var defaults = new List<string>();
        try
        {
            if (File.Exists(path))
            {
                using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
                var root = doc.RootElement;

                if (root.TryGetProperty("associated_client", out var map) && map.ValueKind == JsonValueKind.Object)
                {
                    foreach (var pair in map.EnumerateObject())
                    {
                        if (NormalizePath(pair.Name) is { } install && NormalizePath(pair.Value.GetString()) is { } exe)
                            associated[install.TrimEnd('\\')] = exe;
                    }
                }

                foreach (var name in new[] { "rc_default", "rc_live", "rc_beta" })
                {
                    if (root.TryGetProperty(name, out var value) && NormalizePath(value.GetString()) is { } exe) defaults.Add(exe);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            Log.Warn($"Could not read {path}", ex);
        }

        // Older installs only have the client in its default folder.
        defaults.Add(Path.Combine(Path.GetPathRoot(Environment.SystemDirectory) ?? @"C:\", "Riot Games", "Riot Client", "RiotClientServices.exe"));
        return new ClientInstalls(associated, defaults);
    }

    private static string? NormalizePath(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        try
        {
            return Path.GetFullPath(value.Trim().Trim('"').Replace('/', Path.DirectorySeparatorChar));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    private sealed record ClientInstalls(Dictionary<string, string> Associated, List<string> Defaults)
    {
        public string? ForInstall(string installPath)
        {
            if (Associated.TryGetValue(installPath.TrimEnd('\\'), out var exe) && File.Exists(exe)) return exe;
            return Defaults.FirstOrDefault(File.Exists);
        }
    }
}
