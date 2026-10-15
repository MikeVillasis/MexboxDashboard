using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Imaging;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;

namespace Dashboard.Core.Services;

/// <summary>
/// Cover pipeline: every cover the UI shows is a 400x600 JPEG in the covers folder.
/// Source priority per game: platform cache file → platform-published URL → SteamGridDB (API key only) → executable icon.
/// <para>
/// File names encode where a cover came from: "{game}~g{hash}.jpg" for generated covers (hash of the source identity, so a
/// changed source regenerates and an unchanged one is a single File.Exists), "{game}~c{ticks}.jpg" for custom imports,
/// and "{game}~sgdb.miss" to remember that SteamGridDB has nothing for a game.
/// </para>
/// </summary>
public sealed class CoverArtPipeline : ICoverArtService
{
    private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".ico", ".jfif",
    };

    private const long MaxDownloadBytes = 20 * 1024 * 1024;

    private readonly string _coversDir;
    private readonly HttpClient _http;
    private readonly SteamGridDbClient? _steamGridDb;

    // Network sources that failed this session (offline, 5xx…) are not retried until the next launch.
    private readonly ConcurrentDictionary<string, byte> _failedThisSession = new(StringComparer.OrdinalIgnoreCase);

    public CoverArtPipeline(string coversDir, string? steamGridDbApiKey)
    {
        _coversDir = coversDir;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"Xbox360Dashboard/{typeof(CoverArtPipeline).Assembly.GetName().Version}");
        if (!string.IsNullOrWhiteSpace(steamGridDbApiKey)) _steamGridDb = new SteamGridDbClient(_http, steamGridDbApiKey);

        Log.Info(_steamGridDb is null ? "Cover pipeline: SteamGridDB disabled (no API key)" : "Cover pipeline: SteamGridDB enabled");
    }

    /// <summary>STEAMGRIDDB_API_KEY, else the contents of <paramref name="keyFile"/>; null disables SteamGridDB.</summary>
    public static string? LoadSteamGridDbApiKey(string keyFile) => SteamGridDbClient.LoadApiKey(keyFile);

    public bool IsSupportedImage(string path) =>
        !string.IsNullOrWhiteSpace(path) && SupportedExtensions.Contains(Path.GetExtension(path));

    public async Task<string> ImportCustomCoverAsync(GameEntry game, string sourcePath, CancellationToken ct)
    {
        if (!IsSupportedImage(sourcePath))
            throw new NotSupportedException($"'{Path.GetExtension(sourcePath)}' is not a supported cover format.");

        Directory.CreateDirectory(_coversDir);
        var stem = MakeSafeFileName(game.Id);

        // Unique name per import so image caches keyed by path never show a stale picture.
        var destination = Path.Combine(_coversDir, $"{stem}~c{DateTime.UtcNow.Ticks}.jpg");
        await Task.Run(() => CoverTranscoder.TranscodeFileAsync(sourcePath, destination, null, ct), ct).ConfigureAwait(false);

        DeleteSiblings(stem + "~*", destination);
        Log.Info($"Custom cover for {game.Id} → {destination}");
        return destination;
    }

    public async Task<string?> EnsureCoverAsync(GameEntry game, CancellationToken ct)
    {
        if (game.HasCustomCover) return game.CoverArtPath;

        Directory.CreateDirectory(_coversDir);
        var stem = MakeSafeFileName(game.Id);
        var background = CoverTranscoder.ParseColor(game.Metadata.GetValueOrDefault(GameMetadataKeys.CoverBackground));

        foreach (var source in GetSources(game))
        {
            var target = Path.Combine(_coversDir, $"{stem}~g{Hash(source.Identity)}.jpg");
            if (File.Exists(target)) return target;
            if (source.IsNetwork && _failedThisSession.ContainsKey(source.Identity)) continue;

            try
            {
                var produced = await source.Produce(target, background, ct).ConfigureAwait(false);
                if (!produced) continue;

                DeleteSiblings(stem + "~g*", target);
                Log.Info($"Cover for {game.Id} from {source.Kind}");
                return target;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                if (source.IsNetwork) _failedThisSession[source.Identity] = 0;
                Log.Warn($"Cover source {source.Kind} failed for {game.Id}", ex);
            }
        }

        // Nothing new could be built: keep whatever generated cover the game already has.
        return game.CoverArtPath is { } current && IsOwnFile(current) && File.Exists(current) ? current : null;
    }

    /// <summary>Deletes generated covers no game references any more (uninstalled games, replaced sources).</summary>
    public void PruneGeneratedCovers(IEnumerable<string?> referencedPaths)
    {
        var keep = new HashSet<string>(referencedPaths.OfType<string>(), StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var file in Directory.EnumerateFiles(_coversDir, "*~g*.jpg"))
            {
                if (!keep.Contains(file)) TryDelete(file);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn("Could not prune the cover cache", ex);
        }
    }

    private IEnumerable<CoverSource> GetSources(GameEntry game)
    {
        var meta = game.Metadata;
        var stem = MakeSafeFileName(game.Id);

        if (meta.TryGetValue(GameMetadataKeys.CoverSource, out var local) && TryStat(local) is { } localStamp)
        {
            yield return new CoverSource("platform cache", $"file|{local}|{localStamp}", false,
                async (target, bg, ct) =>
                {
                    await CoverTranscoder.TranscodeFileAsync(local, target, bg, ct).ConfigureAwait(false);
                    return true;
                });
        }

        if (meta.TryGetValue(GameMetadataKeys.CoverUrl, out var url) && Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
            uri.Scheme == Uri.UriSchemeHttps)
        {
            yield return new CoverSource("platform url", $"url|{url}", true,
                async (target, bg, ct) =>
                {
                    await CoverTranscoder.TranscodeBytesAsync(await DownloadAsync(uri, ct).ConfigureAwait(false), target, bg, ct).ConfigureAwait(false);
                    return true;
                });
        }

        var missMarker = Path.Combine(_coversDir, stem + "~sgdb.miss");
        if (_steamGridDb is not null && !File.Exists(missMarker))
        {
            yield return new CoverSource("steamgriddb", $"sgdb|{game.Id}", true,
                async (target, bg, ct) =>
                {
                    var gridUrl = await _steamGridDb.FindGridUrlAsync(game, ct).ConfigureAwait(false);
                    if (gridUrl is null || !Uri.TryCreate(gridUrl, UriKind.Absolute, out var gridUri))
                    {
                        await File.WriteAllTextAsync(missMarker, DateTime.UtcNow.ToString("O"), ct).ConfigureAwait(false);
                        return false;
                    }
                    await CoverTranscoder.TranscodeBytesAsync(await DownloadAsync(gridUri, ct).ConfigureAwait(false), target, bg, ct).ConfigureAwait(false);
                    return true;
                });
        }

        if (meta.TryGetValue(GameMetadataKeys.IconSource, out var exe) && TryStat(exe) is { } exeStamp)
        {
            yield return new CoverSource("executable icon", $"icon|{exe}|{exeStamp}", false,
                async (target, bg, ct) =>
                {
                    await CoverTranscoder.TranscodeExecutableIconAsync(exe, target, bg, ct).ConfigureAwait(false);
                    return true;
                });
        }
    }

    private async Task<byte[]> DownloadAsync(Uri uri, CancellationToken ct)
    {
        using var response = await _http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > MaxDownloadBytes) throw new InvalidDataException($"Cover at {uri} is too large.");

        await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await body.ReadAsync(chunk, ct).ConfigureAwait(false)) > 0)
        {
            if (buffer.Length + read > MaxDownloadBytes) throw new InvalidDataException($"Cover at {uri} is too large.");
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    /// <summary>"length|mtime" so an updated platform image regenerates the cover; null when the file is gone.</summary>
    private static string? TryStat(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? $"{info.Length}|{info.LastWriteTimeUtc.Ticks}" : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    private bool IsOwnFile(string path) =>
        string.Equals(Path.GetDirectoryName(path), _coversDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    private void DeleteSiblings(string pattern, string keep)
    {
        try
        {
            foreach (var old in Directory.EnumerateFiles(_coversDir, pattern))
            {
                if (string.Equals(old, keep, StringComparison.OrdinalIgnoreCase) || old.EndsWith(".miss", StringComparison.OrdinalIgnoreCase))
                    continue;
                TryDelete(old);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"Could not clean old covers matching {pattern}", ex);
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException ex) { Log.Warn($"Could not delete old cover {path}", ex); }
        catch (UnauthorizedAccessException ex) { Log.Warn($"Could not delete old cover {path}", ex); }
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)), 0, 8).ToLowerInvariant();

    private static string MakeSafeFileName(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var chars = value.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            if (Array.IndexOf(invalid, chars[i]) >= 0 || chars[i] == '~' || chars[i] == '*' || chars[i] == '?') chars[i] = '_';
        }
        return new string(chars);
    }

    private sealed record CoverSource(
        string Kind,
        string Identity,
        bool IsNetwork,
        Func<string, uint?, CancellationToken, Task<bool>> Produce);
}
