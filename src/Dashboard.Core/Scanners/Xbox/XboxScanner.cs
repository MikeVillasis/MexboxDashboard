using System.Text;
using System.Xml.Linq;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Windows.ApplicationModel;
using Windows.Management.Deployment;

namespace Dashboard.Core.Scanners.Xbox;

/// <summary>
/// Discovery: WinRT <see cref="PackageManager.FindPackagesForUser(string)"/> for the current user, keeping Store-signed,
/// non-framework packages that are games: they ship a MicrosoftGame.config (GDK titles) or live under a folder listed
/// in a drive's .GamingRoot file (the Xbox app's install locations, e.g. C:\XboxGames).
/// Launch: shell:AppsFolder\{PackageFamilyName}!{AppId}, so the Gaming Services / Xbox app handle sign-in and licensing.
/// </summary>
public sealed class XboxScanner : IGameScanner
{
    public const string Platform = "Xbox";

    public string PlatformName => Platform;

    public Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct)
    {
        var gamingRoots = ReadGamingRoots();
        var games = new Dictionary<string, GameEntry>(StringComparer.OrdinalIgnoreCase);

        // An empty user SID means "the current user", which needs no elevation.
        foreach (var package in new PackageManager().FindPackagesForUser(string.Empty))
        {
            ct.ThrowIfCancellationRequested();
            var entry = TryReadPackage(package, gamingRoots);
            if (entry is not null) games.TryAdd(entry.PlatformGameId, entry);
        }

        return Task.FromResult<IEnumerable<GameEntry>>(games.Values.ToList());
    }

    public Task LaunchGameAsync(GameEntry game)
    {
        ShellLauncher.OpenUri(game.LaunchUri ?? $@"shell:AppsFolder\{game.PlatformGameId}");
        return Task.CompletedTask;
    }

    private static GameEntry? TryReadPackage(Package package, IReadOnlyList<string> gamingRoots)
    {
        try
        {
            if (package.IsFramework || package.IsResourcePackage || package.IsBundle) return null;
            if (package.SignatureKind != PackageSignatureKind.Store) return null;
            if (!package.Status.VerifyIsOK()) return null;

            var installPath = package.InstalledPath;
            if (string.IsNullOrEmpty(installPath) || !Directory.Exists(installPath)) return null;

            var gameConfigPath = Path.Combine(installPath, "MicrosoftGame.config");
            var hasGameConfig = File.Exists(gameConfigPath);
            var mutablePath = TryGetMutablePath(package);
            if (!hasGameConfig && !IsUnderGamingRoot(installPath, gamingRoots) && !IsUnderGamingRoot(mutablePath, gamingRoots))
                return null;

            var app = package.GetAppListEntries().FirstOrDefault();
            if (app is null) return null;

            var aumid = app.AppUserModelId;
            var config = hasGameConfig ? TryLoadXml(gameConfigPath) : null;
            var title = FirstUsable(app.DisplayInfo.DisplayName, package.DisplayName, ConfigAttribute(config, "ShellVisuals", "DefaultDisplayName"));
            if (title is null) return null;

            var metadata = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["packageFamilyName"] = package.Id.FamilyName,
            };
            if (FindBestLogo(installPath, config) is { } logo) metadata[GameMetadataKeys.CoverSource] = logo;
            if (ConfigAttribute(config, "ShellVisuals", "BackgroundColor") is { } background && background.StartsWith('#'))
                metadata[GameMetadataKeys.CoverBackground] = background;

            return new GameEntry
            {
                Platform = Platform,
                PlatformGameId = aumid,
                Title = title.Trim(),
                InstallPath = mutablePath ?? installPath,
                LaunchUri = $@"shell:AppsFolder\{aumid}",
                Metadata = metadata,
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Some system packages refuse property reads for non-admin callers; they are never games.
            Log.Warn($"Skipping package {SafeFullName(package)}", ex);
            return null;
        }
    }

    /// <summary>
    /// Each fixed drive may carry a .GamingRoot file: "RGBX", a uint32 count, then NUL-terminated UTF-16 folder names
    /// relative to that drive (e.g. "XboxGames").
    /// </summary>
    private static List<string> ReadGamingRoots()
    {
        var roots = new List<string>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                var file = Path.Combine(drive.RootDirectory.FullName, ".GamingRoot");
                if (!File.Exists(file)) continue;

                var bytes = File.ReadAllBytes(file);
                if (bytes.Length < 8 || Encoding.ASCII.GetString(bytes, 0, 4) != "RGBX") continue;

                foreach (var folder in Encoding.Unicode.GetString(bytes, 8, (bytes.Length - 8) & ~1).Split('\0', StringSplitOptions.RemoveEmptyEntries))
                    roots.Add(Path.GetFullPath(Path.Combine(drive.RootDirectory.FullName, folder)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                Log.Warn($"Could not read .GamingRoot on {drive.Name}", ex);
            }
        }
        return roots;
    }

    private static bool IsUnderGamingRoot(string? path, IReadOnlyList<string> roots)
    {
        if (string.IsNullOrEmpty(path)) return false;
        foreach (var root in roots)
        {
            if (path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string? TryGetMutablePath(Package package)
    {
        try
        {
            var path = package.MutableLocation?.Path;
            return string.IsNullOrEmpty(path) ? null : path;
        }
        catch (Exception)
        {
            return null; // Only packages with a mutable folder (most GDK games) have one.
        }
    }

    /// <summary>
    /// Picks the largest square logo the package ships. Asset references omit the MRT qualifier, so
    /// "Resources\Logo.png" may exist only as "Resources\Logo.scale-200.png".
    /// </summary>
    private static string? FindBestLogo(string installPath, XDocument? gameConfig)
    {
        var references = new List<string>();
        foreach (var name in new[] { "Square480x480Logo", "Square150x150Logo", "StoreLogo" })
        {
            if (ConfigAttribute(gameConfig, "ShellVisuals", name) is { } value) references.Add(value);
        }

        var manifest = TryLoadXml(Path.Combine(installPath, "AppxManifest.xml"));
        if (manifest is not null)
        {
            foreach (var element in manifest.Descendants().Where(e => e.Name.LocalName == "VisualElements"))
            {
                foreach (var name in new[] { "Square310x310Logo", "Square150x150Logo" })
                {
                    if (element.Attribute(name)?.Value is { Length: > 0 } value) references.Add(value);
                }
            }
            if (manifest.Descendants().FirstOrDefault(e => e.Name.LocalName == "Logo")?.Value is { Length: > 0 } storeLogo)
                references.Add(storeLogo);
        }

        string? best = null;
        long bestSize = 0;
        foreach (var reference in references.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            foreach (var candidate in ResolveQualifiedAsset(installPath, reference))
            {
                var size = new FileInfo(candidate).Length;
                if (size > bestSize)
                {
                    best = candidate;
                    bestSize = size;
                }
            }
        }
        return best;
    }

    private static IEnumerable<string> ResolveQualifiedAsset(string installPath, string reference)
    {
        string full;
        try
        {
            full = Path.GetFullPath(Path.Combine(installPath, reference));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            yield break;
        }

        if (File.Exists(full)) yield return full;

        var dir = Path.GetDirectoryName(full);
        if (dir is null || !Directory.Exists(dir)) yield break;

        // Logo.scale-200.png, Logo.targetsize-256.png, Logo.scale-100_contrast-black.png…
        var pattern = Path.GetFileNameWithoutExtension(full) + ".*" + Path.GetExtension(full);
        foreach (var file in Directory.EnumerateFiles(dir, pattern))
        {
            if (!file.Contains("contrast-", StringComparison.OrdinalIgnoreCase)) yield return file;
        }
    }

    private static XDocument? TryLoadXml(string path)
    {
        try
        {
            return File.Exists(path) ? XDocument.Load(path) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            Log.Warn($"Could not read {path}", ex);
            return null;
        }
    }

    private static string? ConfigAttribute(XDocument? doc, string element, string attribute) =>
        doc?.Descendants().FirstOrDefault(e => e.Name.LocalName == element)?.Attribute(attribute)?.Value is { Length: > 0 } value
            ? value
            : null;

    /// <summary>Unresolved "ms-resource:" strings are useless as titles.</summary>
    private static string? FirstUsable(params string?[] values) =>
        values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v) && !v.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase));

    private static string SafeFullName(Package package)
    {
        try { return package.Id.FullName; }
        catch (Exception) { return "<unknown>"; }
    }
}
