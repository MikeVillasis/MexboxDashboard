namespace Dashboard.Core.Models;

/// <summary>Delta produced by a background scan, launch, or cover change. Raised on a worker thread.</summary>
public sealed class LibraryChangedEventArgs : EventArgs
{
    public LibraryChangedEventArgs(
        IReadOnlyList<GameEntry> added,
        IReadOnlyList<GameEntry> updated,
        IReadOnlyList<string> removedIds)
    {
        Added = added;
        Updated = updated;
        RemovedIds = removedIds;
    }

    public IReadOnlyList<GameEntry> Added { get; }
    public IReadOnlyList<GameEntry> Updated { get; }
    public IReadOnlyList<string> RemovedIds { get; }

    public bool IsEmpty => Added.Count == 0 && Updated.Count == 0 && RemovedIds.Count == 0;
}
