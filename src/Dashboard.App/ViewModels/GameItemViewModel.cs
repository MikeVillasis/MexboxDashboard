using Dashboard.Core.Models;

namespace Dashboard.App.ViewModels;

public sealed class GameItemViewModel : ObservableObject
{
    private GameEntry _entry;

    public GameItemViewModel(GameEntry entry)
    {
        _entry = entry;
        SortKey = entry.SortTitle;
    }

    public GameEntry Entry => _entry;

    public string Id => _entry.Id;

    public string Title => _entry.Title;

    public string PlatformLabel => _entry.Platform.ToLowerInvariant();

    public string? CoverPath => _entry.CoverArtPath;

    public bool HasCustomCover => _entry.HasCustomCover;

    public string SortKey { get; private set; }

    public string Details
    {
        get
        {
            var played = _entry.LastPlayed is { } last ? $"played {Relative(last)}" : "not played from the dashboard yet";
            return $"{PlatformLabel}  ·  {played}";
        }
    }

    /// <summary>Swaps in fresh data; returns true when the sort position may have changed.</summary>
    public bool Update(GameEntry entry)
    {
        var sortChanged = !string.Equals(entry.SortTitle, SortKey, StringComparison.Ordinal);
        _entry = entry;
        SortKey = entry.SortTitle;
        OnPropertyChanged(string.Empty);
        return sortChanged;
    }

    private static string Relative(DateTimeOffset when)
    {
        var span = DateTimeOffset.Now - when;
        if (span.TotalMinutes < 2) return "just now";
        if (span.TotalHours < 1) return $"{(int)span.TotalMinutes} minutes ago";
        if (span.TotalDays < 1) return span.TotalHours < 2 ? "an hour ago" : $"{(int)span.TotalHours} hours ago";
        if (span.TotalDays < 2) return "yesterday";
        if (span.TotalDays < 30) return $"{(int)span.TotalDays} days ago";
        return when.LocalDateTime.ToString("MMM d, yyyy").ToLowerInvariant();
    }
}
