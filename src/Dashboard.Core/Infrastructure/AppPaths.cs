namespace Dashboard.Core.Infrastructure;

/// <summary>Well-known locations under %AppData%\Xbox360Launcher.</summary>
public static class AppPaths
{
    public static string DataRoot { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Xbox360Launcher");

    public static string DatabasePath => Path.Combine(DataRoot, "library.db");

    public static string CoversDir => Path.Combine(DataRoot, "Covers");

    public static string LogPath => Path.Combine(DataRoot, "dashboard.log");

    public static string SettingsPath => Path.Combine(DataRoot, "settings.json");

    /// <summary>The local player's avatar DNA recipe.</summary>
    public static string LocalProfilePath => Path.Combine(DataRoot, "localProfile.json");

    public static string FriendsPath => Path.Combine(DataRoot, "friends.json");

    /// <summary>"localProfile.json" → "localProfile-{profile}.json" for side-by-side test profiles (--profile=name).</summary>
    public static string ForProfile(string path, string? profile) =>
        string.IsNullOrEmpty(profile) ? path : Path.Combine(Path.GetDirectoryName(path)!, $"{Path.GetFileNameWithoutExtension(path)}-{profile}{Path.GetExtension(path)}");

    /// <summary>Optional SteamGridDB API key (plain text). STEAMGRIDDB_API_KEY overrides it.</summary>
    public static string SteamGridDbKeyPath => Path.Combine(DataRoot, "steamgriddb.key");

    public static void EnsureCreated()
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(CoversDir);
    }
}
