using System.Collections.ObjectModel;

namespace Dashboard.Core.Models;

/// <summary>
/// One installed game, as discovered by an <see cref="Abstractions.IGameScanner"/> and persisted in the library cache.
/// Immutable: scanners and services produce new instances with <c>with</c> expressions.
/// </summary>
public sealed record GameEntry
{
    private static readonly IReadOnlyDictionary<string, string> NoMetadata =
        new ReadOnlyDictionary<string, string>(new Dictionary<string, string>());

    /// <summary>Must equal the owning scanner's <see cref="Abstractions.IGameScanner.PlatformName"/>.</summary>
    public required string Platform { get; init; }

    /// <summary>Platform-native identifier: Steam AppId, Xbox PackageFamilyName!AppId, Epic AppName, Battle.net product code…</summary>
    public required string PlatformGameId { get; init; }

    public required string Title { get; init; }

    /// <summary>Globally unique key: "{Platform}:{PlatformGameId}".</summary>
    public string Id => MakeId(Platform, PlatformGameId);

    /// <summary>Title normalised for alphabetical sorting ("The Witcher 3" sorts under W).</summary>
    public string SortTitle => TitleSort.MakeKey(Title);

    public string? InstallPath { get; init; }

    /// <summary>Preferred launch route: the platform URI protocol (steam://, com.epicgames.launcher://, battlenet://, shell:AppsFolder\…).</summary>
    public string? LaunchUri { get; init; }

    /// <summary>Bootstrapper executable for platforms that need one (e.g. RiotClientServices.exe).</summary>
    public string? ExecutablePath { get; init; }

    public string? LaunchArguments { get; init; }

    /// <summary>Absolute path to the best known cover image (platform cache or the user's custom override).</summary>
    public string? CoverArtPath { get; init; }

    /// <summary>True when <see cref="CoverArtPath"/> was chosen by the user; scans never overwrite it.</summary>
    public bool HasCustomCover { get; init; }

    /// <summary>Scanner-specific extras (library folder, catalog namespace, size on disk…).</summary>
    public IReadOnlyDictionary<string, string> Metadata { get; init; } = NoMetadata;

    public DateTimeOffset? LastPlayed { get; init; }

    public int PlayCount { get; init; }

    public static string MakeId(string platform, string platformGameId) => string.Concat(platform, ":", platformGameId);

    /// <summary>Compares only the fields a scanner owns, so the delta scan can tell "changed on disk" from "same as cached".</summary>
    public bool HasSameScanData(GameEntry other) =>
        string.Equals(Title, other.Title, StringComparison.Ordinal) &&
        string.Equals(InstallPath, other.InstallPath, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(LaunchUri, other.LaunchUri, StringComparison.Ordinal) &&
        string.Equals(ExecutablePath, other.ExecutablePath, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(LaunchArguments, other.LaunchArguments, StringComparison.Ordinal) &&
        string.Equals(CoverArtPath, other.CoverArtPath, StringComparison.OrdinalIgnoreCase) &&
        HasCustomCover == other.HasCustomCover &&
        MetadataEquals(Metadata, other.Metadata);

    private static bool MetadataEquals(IReadOnlyDictionary<string, string> a, IReadOnlyDictionary<string, string> b)
    {
        if (ReferenceEquals(a, b)) return true;
        if (a.Count != b.Count) return false;
        foreach (var (key, value) in a)
        {
            if (!b.TryGetValue(key, out var other) || !string.Equals(value, other, StringComparison.Ordinal))
                return false;
        }
        return true;
    }
}
