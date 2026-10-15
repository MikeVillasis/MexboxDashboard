namespace Dashboard.Core.Models;

/// <summary>
/// Well-known <see cref="GameEntry.Metadata"/> keys. Scanners describe where art can be found; the cover pipeline
/// turns that into the uniform 400x600 file stored in <see cref="GameEntry.CoverArtPath"/>.
/// </summary>
public static class GameMetadataKeys
{
    /// <summary>Local image from the platform's own cache (Steam librarycache, Appx logo, Riot .ico…).</summary>
    public const string CoverSource = "coverSource";

    /// <summary>Remote image published by the platform itself (e.g. Battle.net box art). Downloaded once.</summary>
    public const string CoverUrl = "coverUrl";

    /// <summary>Executable whose icon is the last-resort cover.</summary>
    public const string IconSource = "iconSource";

    /// <summary>Backdrop colour ("#RRGGBB") for art that does not fill a portrait cover (square logos, icons).</summary>
    public const string CoverBackground = "coverBackground";

    /// <summary>Steam AppId, used for exact SteamGridDB lookups.</summary>
    public const string SteamAppId = "steamAppId";
}
