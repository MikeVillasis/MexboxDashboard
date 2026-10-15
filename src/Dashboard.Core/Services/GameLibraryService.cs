using System.Diagnostics;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;

namespace Dashboard.Core.Services;

/// <summary>
/// Orchestrates the scanner plugins and the cache:
/// boot from cache instantly → run every scanner in parallel on the thread pool → diff → persist → publish a delta.
/// </summary>
public sealed class GameLibraryService
{
    private readonly IReadOnlyList<IGameScanner> _scanners;
    private readonly IGameLibraryCache _cache;
    private readonly ICoverArtService? _covers;
    private readonly Dictionary<string, GameEntry> _games = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _gate = new();
    private readonly SemaphoreSlim _scanLock = new(1, 1);
    private readonly SemaphoreSlim _coverPassLock = new(1, 1);
    private readonly SemaphoreSlim _coverWriteLock = new(1, 1);
    private int _coversDirty;

    /// <param name="covers">When set, every scan is followed by a background cover pass that builds missing 400x600 covers.</param>
    public GameLibraryService(IEnumerable<IGameScanner> scanners, IGameLibraryCache cache, ICoverArtService? covers = null)
    {
        _scanners = scanners.ToArray();
        _cache = cache;
        _covers = covers;

        var duplicate = _scanners.GroupBy(s => s.PlatformName, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1);
        if (duplicate is not null)
            throw new ArgumentException($"Two scanners share the platform name '{duplicate.Key}'.", nameof(scanners));
    }

    /// <summary>Raised on a worker thread. UI subscribers must marshal to their dispatcher.</summary>
    public event EventHandler<LibraryChangedEventArgs>? LibraryChanged;

    public IReadOnlyList<IGameScanner> Scanners => _scanners;

    public bool IsScanning { get; private set; }

    public DateTimeOffset? LastScanCompleted { get; private set; }

    public IReadOnlyList<GameEntry> GetSnapshot()
    {
        lock (_gate) return _games.Values.ToArray();
    }

    /// <summary>Loads the persisted library. Call once at startup, before <see cref="RefreshAsync"/>.</summary>
    public async Task<IReadOnlyList<GameEntry>> LoadCacheAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await _cache.InitializeAsync(ct).ConfigureAwait(false);
        var cached = await _cache.LoadAllAsync(ct).ConfigureAwait(false);

        lock (_gate)
        {
            _games.Clear();
            foreach (var game in cached) _games[game.Id] = game;
        }

        Log.Info($"Loaded {cached.Count} cached games in {sw.ElapsedMilliseconds} ms");
        return cached;
    }

    /// <summary>
    /// Runs every scanner in parallel and applies the delta. If a scan is already running this returns immediately.
    /// Platforms whose scanner throws keep their cached games.
    /// </summary>
    public async Task RefreshAsync(CancellationToken ct)
    {
        if (!await _scanLock.WaitAsync(0, ct).ConfigureAwait(false)) return;
        IsScanning = true;
        var sw = Stopwatch.StartNew();
        try
        {
            var results = await Task.WhenAll(_scanners.Select(s => ScanOneAsync(s, ct))).ConfigureAwait(false);

            var added = new List<GameEntry>();
            var updated = new List<GameEntry>();
            var removed = new List<string>();

            lock (_gate)
            {
                foreach (var result in results)
                {
                    if (!result.Succeeded) continue;

                    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var scanned in result.Games)
                    {
                        if (!seen.Add(scanned.Id)) continue;

                        if (_games.TryGetValue(scanned.Id, out var existing))
                        {
                            var merged = MergeUserData(scanned, existing);
                            if (!existing.HasSameScanData(merged))
                            {
                                _games[merged.Id] = merged;
                                updated.Add(merged);
                            }
                        }
                        else
                        {
                            _games[scanned.Id] = scanned;
                            added.Add(scanned);
                        }
                    }

                    foreach (var game in _games.Values.Where(g => g.Platform == result.Platform && !seen.Contains(g.Id)).ToList())
                    {
                        _games.Remove(game.Id);
                        removed.Add(game.Id);
                    }
                }
            }

            if (added.Count + updated.Count + removed.Count > 0)
            {
                await _cache.ApplyChangesAsync(added.Concat(updated).ToList(), removed, ct).ConfigureAwait(false);
                LibraryChanged?.Invoke(this, new LibraryChangedEventArgs(added, updated, removed));
            }

            LastScanCompleted = DateTimeOffset.Now;
            Log.Info($"Library scan: +{added.Count} ~{updated.Count} -{removed.Count} in {sw.ElapsedMilliseconds} ms");
        }
        finally
        {
            IsScanning = false;
            _scanLock.Release();
        }

        // Covers trickle in afterwards; the scan result is already on screen.
        if (_covers is not null) _ = RunCoverPassInBackgroundAsync(ct);
    }

    /// <summary>
    /// Builds or refreshes generated covers for every game without a custom one. Overlapping calls coalesce:
    /// a request made while a pass is running schedules exactly one more pass.
    /// </summary>
    public async Task RefreshCoversAsync(CancellationToken ct)
    {
        if (_covers is null) return;

        Interlocked.Exchange(ref _coversDirty, 1);
        while (Volatile.Read(ref _coversDirty) == 1 && await _coverPassLock.WaitAsync(0, ct).ConfigureAwait(false))
        {
            try
            {
                while (Interlocked.Exchange(ref _coversDirty, 0) == 1)
                    await CoverPassAsync(_covers, ct).ConfigureAwait(false);
            }
            finally
            {
                _coverPassLock.Release();
            }
        }
    }

    private async Task RunCoverPassInBackgroundAsync(CancellationToken ct)
    {
        try
        {
            await Task.Run(() => RefreshCoversAsync(ct), ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Error("Cover pass failed", ex);
        }
    }

    private async Task CoverPassAsync(ICoverArtService covers, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var changed = 0;
        var games = GetSnapshot().Where(g => !g.HasCustomCover).ToList();

        // Two at a time: decode/encode is CPU-bound and the dashboard must stay smooth while this runs.
        await Parallel.ForEachAsync(games, new ParallelOptions { MaxDegreeOfParallelism = 2, CancellationToken = ct }, async (game, token) =>
        {
            string? path;
            try
            {
                path = await covers.EnsureCoverAsync(game, token).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                Log.Warn($"Cover generation failed for {game.Id}", ex);
                return;
            }

            if (path is null || string.Equals(path, game.CoverArtPath, StringComparison.OrdinalIgnoreCase)) return;
            if (await ApplyCoverAsync(game.Id, path, isCustom: false, token).ConfigureAwait(false)) Interlocked.Increment(ref changed);
        }).ConfigureAwait(false);

        covers.PruneGeneratedCovers(GetSnapshot().Select(g => g.CoverArtPath));
        Log.Info($"Cover pass: {changed} of {games.Count} updated in {sw.ElapsedMilliseconds} ms");
    }

    public async Task LaunchAsync(GameEntry game)
    {
        var scanner = _scanners.FirstOrDefault(s => string.Equals(s.PlatformName, game.Platform, StringComparison.Ordinal))
                      ?? throw new InvalidOperationException($"No scanner is registered for platform '{game.Platform}'.");

        // ShellExecute can stall for a moment while the parent launcher wakes up: keep it off the UI thread.
        await Task.Run(() => scanner.LaunchGameAsync(game)).ConfigureAwait(false);

        var now = DateTimeOffset.Now;
        GameEntry? updated = null;
        lock (_gate)
        {
            if (_games.TryGetValue(game.Id, out var current))
            {
                updated = current with { LastPlayed = now, PlayCount = current.PlayCount + 1 };
                _games[game.Id] = updated;
            }
        }

        if (updated is null) return;
        try
        {
            await _cache.RecordLaunchAsync(game.Id, now, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Log.Warn($"Could not record launch of {game.Id}", ex);
        }
        LibraryChanged?.Invoke(this, new LibraryChangedEventArgs(Array.Empty<GameEntry>(), new[] { updated }, Array.Empty<string>()));
    }

    public Task SetCoverAsync(string gameId, string coverPath, bool isCustom, CancellationToken ct) =>
        ApplyCoverAsync(gameId, coverPath, isCustom, ct);

    /// <summary>
    /// Serialised with every other cover write so a generated cover can never land on top of a custom one
    /// that the user picked while the cover pass was busy.
    /// </summary>
    private async Task<bool> ApplyCoverAsync(string gameId, string coverPath, bool isCustom, CancellationToken ct)
    {
        await _coverWriteLock.WaitAsync(ct).ConfigureAwait(false);
        GameEntry? updated = null;
        try
        {
            lock (_gate)
            {
                if (_games.TryGetValue(gameId, out var current) && (isCustom || !current.HasCustomCover))
                {
                    updated = current with { CoverArtPath = coverPath, HasCustomCover = isCustom };
                    _games[gameId] = updated;
                }
            }

            if (updated is null) return false;
            await _cache.SetCoverAsync(gameId, coverPath, isCustom, ct).ConfigureAwait(false);
        }
        finally
        {
            _coverWriteLock.Release();
        }

        LibraryChanged?.Invoke(this, new LibraryChangedEventArgs(Array.Empty<GameEntry>(), new[] { updated }, Array.Empty<string>()));
        return true;
    }

    /// <summary>Keeps what the user owns (custom cover, play history) when a fresh scan replaces an entry.</summary>
    private static GameEntry MergeUserData(GameEntry scanned, GameEntry existing) => scanned with
    {
        CoverArtPath = existing.HasCustomCover ? existing.CoverArtPath : scanned.CoverArtPath ?? existing.CoverArtPath,
        HasCustomCover = existing.HasCustomCover,
        LastPlayed = existing.LastPlayed,
        PlayCount = existing.PlayCount,
    };

    private static async Task<ScanResult> ScanOneAsync(IGameScanner scanner, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var games = await Task.Run(() => scanner.ScanInstalledGamesAsync(ct), ct).ConfigureAwait(false);
            var list = games
                .Where(g => string.Equals(g.Platform, scanner.PlatformName, StringComparison.Ordinal))
                .ToList();
            Log.Info($"{scanner.PlatformName}: {list.Count} games in {sw.ElapsedMilliseconds} ms");
            return new ScanResult(scanner.PlatformName, true, list);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            Log.Error($"{scanner.PlatformName} scan failed; keeping cached entries", ex);
            return new ScanResult(scanner.PlatformName, false, Array.Empty<GameEntry>());
        }
    }

    private sealed record ScanResult(string Platform, bool Succeeded, IReadOnlyList<GameEntry> Games);
}
