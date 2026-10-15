using Dashboard.Core.Models;

namespace Dashboard.Core.Abstractions;

/// <summary>
/// Strategy/plugin for one storefront or emulator. Adding a platform = one new class + one line in the composition root.
/// <para>
/// Contract:
/// <list type="bullet">
/// <item>Called on a worker thread; never touch UI objects.</item>
/// <item>Returning normally means "this is the complete installed set": games missing from the result are removed from the cache.</item>
/// <item>Throwing means "scan failed": the cache for this platform is left untouched.</item>
/// <item>Every returned <see cref="GameEntry.Platform"/> must equal <see cref="PlatformName"/>.</item>
/// </list>
/// </para>
/// </summary>
public interface IGameScanner
{
    /// <summary>Stable platform key (e.g. "Steam"). Persisted in the cache, so never rename it once shipped.</summary>
    string PlatformName { get; }

    Task<IEnumerable<GameEntry>> ScanInstalledGamesAsync(CancellationToken ct);

    /// <summary>
    /// Launch through the platform's official URI protocol or bootstrapper so the parent client wakes up,
    /// handles sign-in, and provides DRM / anti-cheat context.
    /// </summary>
    Task LaunchGameAsync(GameEntry game);
}
