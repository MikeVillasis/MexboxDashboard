using System.ComponentModel;
using System.Text.Json;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Microsoft.Win32;

namespace Dashboard.Core.Scanners.BattleNet;

/// <summary>
/// Discovery: the Battle.net Agent's C:\ProgramData\Battle.net\Agent\product.db (protobuf: uid, product code, install path),
/// enriched by the Agent's aggregate.json (display name, launch URI, box art) and the Blizzard uninstall keys under
/// HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall.
/// Launch: battlenet://{code} through the client's protocol handler, falling back to Battle.net.exe --exec="launch {code}".
/// </summary>
public sealed class BattleNetScanner : IGameScanner
{
    public const string Platform = "Battle.net";

    private static readonly string AgentDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Battle.net", "Agent");

    // product.db also tracks the Agent and the desktop client themselves.
    private static readonly HashSet<string> NonGameUids = new(StringComparer.OrdinalIgnoreCase) { "agent", "battle.net", "bna" };

    // Fallback titles when neither aggregate.json nor the registry names an install. Keyed by uid and product code.
    private static readonly Dictionary<string, string> KnownTitles = new(StringComparer.OrdinalIgnoreCase)
    {
        ["fenris"] = "Diablo IV",
        ["prometheus"] = "Overwatch 2", ["pro"] = "Overwatch 2",
        ["wow"] = "World of Warcraft",
        ["wow_classic"] = "World of Warcraft Classic", ["wowc"] = "World of Warcraft Classic",
        ["wow_classic_era"] = "World of Warcraft Classic Era",
        ["diablo3"] = "Diablo III", ["d3"] = "Diablo III",
        ["osi"] = "Diablo II: Resurrected",
        ["anbs"] = "Diablo Immortal",
        ["hs_beta"] = "Hearthstone", ["wtcg"] = "Hearthstone",
        ["heroes"] = "Heroes of the Storm", ["hero"] = "Heroes of the Storm",
        ["s2"] = "StarCraft II",
        ["s1"] = "StarCraft: Remastered",
        ["w3"] = "Warcraft III: Reforged",
        ["viper"] = "Call of Duty: Black Ops 4",
        ["odin"] = "Call of Duty: Modern Warfare",
        ["zeus"] = "Call of Duty: Black Ops Cold War",
        ["fore"] = "Call of Duty: Vanguard",
        ["auks"] = "Call of Duty",
        ["lazarus"] = "Call of Duty: Modern Warfare 2 Campaign Remastered",
        ["rtro"] = "Blizzard Arcade Collection",
        ["wlby"] = "Crash Bandicoot 4: It's About Time",
    };

    public string PlatformName => Platform;

    public Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct)
    {
        if (!Directory.Exists(AgentDir))
        {
            Log.Info("Battle.net is not installed");
            return Task.FromResult(Enumerable.Empty<GameEntry>());
        }

        var aggregate = ReadAggregate();
        var uninstall = ReadUninstallKeys();
        var installs = ReadProductDb(out var clientDir);
        var clientExe = clientDir is null ? null : Path.Combine(clientDir, "Battle.net.exe");
        if (clientExe is not null && !File.Exists(clientExe)) clientExe = null;

        var games = new Dictionary<string, GameEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var install in installs)
        {
            ct.ThrowIfCancellationRequested();
            if (NonGameUids.Contains(install.Uid) || !Directory.Exists(install.Path)) continue;

            aggregate.TryGetValue(install.Code, out var agg);
            if (agg is null) aggregate.TryGetValue(install.Uid, out agg);
            uninstall.TryGetValue(install.Uid, out var reg);

            var title = FirstNonEmpty(agg?.Name, reg?.DisplayName, KnownTitles.GetValueOrDefault(install.Uid),
                KnownTitles.GetValueOrDefault(install.Code)) ?? install.Uid;

            var metadata = new Dictionary<string, string>(StringComparer.Ordinal) { ["productCode"] = install.Code };
            if (agg?.BoxArtUri is { } boxArt) metadata[GameMetadataKeys.CoverUrl] = boxArt;
            if (FirstExisting(agg?.IconPath, reg?.DisplayIcon) is { } icon) metadata[GameMetadataKeys.IconSource] = icon;

            games.TryAdd(install.Uid, new GameEntry
            {
                Platform = Platform,
                PlatformGameId = install.Uid,
                Title = title.Trim(),
                InstallPath = install.Path,
                LaunchUri = agg?.LaunchUri ?? $"battlenet://{install.Code}",
                ExecutablePath = clientExe,
                LaunchArguments = $"--exec=\"launch {install.Code}\"",
                Metadata = metadata,
            });
        }

        return Task.FromResult<IEnumerable<GameEntry>>(games.Values.ToList());
    }

    public Task LaunchGameAsync(GameEntry game)
    {
        try
        {
            ShellLauncher.OpenUri(game.LaunchUri ?? $"battlenet://{game.PlatformGameId}");
        }
        catch (Win32Exception ex) when (game.ExecutablePath is not null)
        {
            // battlenet:// is registered by the client installer; repair installs sometimes lose it.
            Log.Warn($"battlenet:// launch failed for {game.Id}; using Battle.net.exe", ex);
            ShellLauncher.StartExecutable(game.ExecutablePath, game.LaunchArguments);
        }
        return Task.CompletedTask;
    }

    /// <summary>
    /// product.db: Database { repeated ProductInstall product_install = 1; }
    /// ProductInstall { string uid = 1; string product_code = 2; UserSettings settings = 3 { string install_path = 1; } }
    /// Throws when the file exists but cannot be parsed, so a half-written database never empties the library.
    /// </summary>
    private static List<ProductInstall> ReadProductDb(out string? clientDir)
    {
        clientDir = null;
        var result = new List<ProductInstall>();
        var path = Path.Combine(AgentDir, "product.db");
        if (!File.Exists(path)) return result;

        byte[] bytes;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            bytes = new byte[stream.Length];
            stream.ReadExactly(bytes);
        }

        var db = new ProtobufReader(bytes);
        while (db.Next())
        {
            if (db.Field != 1 || db.WireType != ProtobufReader.WireLengthDelimited) continue;

            string? uid = null, code = null, installPath = null;
            var install = new ProtobufReader(db.Bytes);
            while (install.Next())
            {
                if (install.WireType != ProtobufReader.WireLengthDelimited) continue;
                switch (install.Field)
                {
                    case 1: uid = install.String; break;
                    case 2: code = install.String; break;
                    case 3:
                        var settings = new ProtobufReader(install.Bytes);
                        while (settings.Next())
                        {
                            if (settings.Field == 1 && settings.WireType == ProtobufReader.WireLengthDelimited)
                                installPath = settings.String;
                        }
                        break;
                }
            }

            if (string.IsNullOrWhiteSpace(uid) || string.IsNullOrWhiteSpace(installPath)) continue;
            var normalized = NormalizePath(installPath);
            if (normalized is null) continue;

            if (string.Equals(uid, "battle.net", StringComparison.OrdinalIgnoreCase)) clientDir = normalized;
            result.Add(new ProductInstall(uid, string.IsNullOrWhiteSpace(code) ? uid : code, normalized));
        }
        return result;
    }

    /// <summary>aggregate.json, written by recent Agents for the Xbox app integration. Optional: missing or bad = empty.</summary>
    private static Dictionary<string, AggregateEntry> ReadAggregate()
    {
        var result = new Dictionary<string, AggregateEntry>(StringComparer.OrdinalIgnoreCase);
        var path = Path.Combine(AgentDir, "aggregate.json");
        try
        {
            if (!File.Exists(path)) return result;
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            if (!doc.RootElement.TryGetProperty("installed", out var installed) || installed.ValueKind != JsonValueKind.Array) return result;

            foreach (var item in installed.EnumerateArray())
            {
                if (GetString(item, "product_id") is not { } productId) continue;
                result[productId] = new AggregateEntry(
                    GetString(item, "name"),
                    GetString(item, "launch_uri"),
                    GetString(item, "box_art_uri"),
                    NormalizePath(GetString(item, "icon_path")));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Log.Warn($"Could not read {path}", ex);
        }
        return result;
    }

    /// <summary>Blizzard uninstall entries keyed by the "--uid=" in their UninstallString.</summary>
    private static Dictionary<string, UninstallEntry> ReadUninstallKeys()
    {
        var result = new Dictionary<string, UninstallEntry>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var root = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall");
            if (root is null) return result;

            foreach (var name in root.GetSubKeyNames())
            {
                using var key = root.OpenSubKey(name);
                if (key?.GetValue("Publisher") is not string publisher ||
                    !publisher.Contains("Blizzard", StringComparison.OrdinalIgnoreCase) ||
                    key.GetValue("UninstallString") is not string uninstall)
                {
                    continue;
                }

                var marker = uninstall.IndexOf("--uid=", StringComparison.OrdinalIgnoreCase);
                if (marker < 0) continue;
                var uid = uninstall[(marker + 6)..].Split(' ', '"')[0];
                if (uid.Length == 0) continue;

                result[uid] = new UninstallEntry(key.GetValue("DisplayName") as string, NormalizePath((key.GetValue("DisplayIcon") as string)?.Split(',')[0]));
            }
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            Log.Warn("Could not read Blizzard uninstall keys", ex);
        }
        return result;
    }

    private static string? NormalizePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            return Path.GetFullPath(path.Trim().Trim('"').Replace('/', Path.DirectorySeparatorChar));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    private static string? GetString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } s
            ? s
            : null;

    private static string? FirstNonEmpty(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));

    private static string? FirstExisting(params string?[] paths) => paths.FirstOrDefault(p => p is not null && File.Exists(p));

    private sealed record ProductInstall(string Uid, string Code, string Path);

    private sealed record AggregateEntry(string? Name, string? LaunchUri, string? BoxArtUri, string? IconPath);

    private sealed record UninstallEntry(string? DisplayName, string? DisplayIcon);
}
