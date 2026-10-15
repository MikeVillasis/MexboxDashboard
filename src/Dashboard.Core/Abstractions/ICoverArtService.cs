using Dashboard.Core.Models;

namespace Dashboard.Core.Abstractions;

/// <summary>
/// Owns the on-disk cover cache (%AppData%\Xbox360Launcher\Covers). Every file it produces is a uniform 400x600 JPEG,
/// so the UI can decode covers at a fixed size.
/// </summary>
public interface ICoverArtService
{
    bool IsSupportedImage(string path);

    /// <summary>Imports a user-chosen image for <paramref name="game"/> and returns the cached file path.</summary>
    Task<string> ImportCustomCoverAsync(GameEntry game, string sourcePath, CancellationToken ct);

    /// <summary>
    /// Makes sure <paramref name="game"/> has an up-to-date generated cover, building one from the sources its scanner
    /// reported (platform cache → platform URL → SteamGridDB → executable icon). Returns the cover path to store,
    /// which equals <see cref="GameEntry.CoverArtPath"/> when nothing changed, or null when no art could be produced.
    /// Never call for games with a custom cover.
    /// </summary>
    Task<string?> EnsureCoverAsync(GameEntry game, CancellationToken ct);

    /// <summary>Deletes generated covers that none of <paramref name="referencedPaths"/> point at. Custom covers are never touched.</summary>
    void PruneGeneratedCovers(IEnumerable<string?> referencedPaths);
}
