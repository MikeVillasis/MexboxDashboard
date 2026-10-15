using Dashboard.Core.Models;

namespace Dashboard.Core.Abstractions;

/// <summary>Persistent library store. All members are safe to call from any thread and never block the caller's thread on I/O.</summary>
public interface IGameLibraryCache
{
    Task InitializeAsync(CancellationToken ct);

    Task<IReadOnlyList<GameEntry>> LoadAllAsync(CancellationToken ct);

    /// <summary>Applies a scan delta in a single transaction.</summary>
    Task ApplyChangesAsync(IReadOnlyCollection<GameEntry> upserts, IReadOnlyCollection<string> removedIds, CancellationToken ct);

    Task SetCoverAsync(string gameId, string? coverPath, bool isCustom, CancellationToken ct);

    Task RecordLaunchAsync(string gameId, DateTimeOffset launchedAt, CancellationToken ct);
}
