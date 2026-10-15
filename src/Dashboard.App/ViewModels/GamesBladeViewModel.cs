using System.Collections.ObjectModel;
using System.Globalization;
using Dashboard.App.Audio;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
using Dashboard.Core.Services;

namespace Dashboard.App.ViewModels;

/// <summary>
/// Games blade state. All members must be called on the UI thread; library deltas arrive via <see cref="ApplyChanges"/>
/// already marshalled by the shell. The list is kept sorted incrementally, never rebuilt on a delta.
/// </summary>
public sealed class GamesBladeViewModel : ObservableObject
{
    private static readonly StringComparer SortComparer = StringComparer.Create(CultureInfo.CurrentCulture, ignoreCase: true);

    private readonly GameLibraryService _library;
    private readonly ICoverArtService _covers;
    private readonly SoundService _sounds;
    private readonly Dictionary<string, GameItemViewModel> _byId = new(StringComparer.OrdinalIgnoreCase);

    private ObservableCollection<GameItemViewModel> _games = new();
    private GameItemViewModel? _selectedGame;
    private string? _statusText;
    private bool _isScanning;
    private int _statusToken;

    public GamesBladeViewModel(GameLibraryService library, ICoverArtService covers, SoundService sounds, MediaViewModel media)
    {
        _library = library;
        _covers = covers;
        _sounds = sounds;
        Media = media;
    }

    public MediaViewModel Media { get; }

    public ObservableCollection<GameItemViewModel> Games
    {
        get => _games;
        private set => SetProperty(ref _games, value);
    }

    public GameItemViewModel? SelectedGame
    {
        get => _selectedGame;
        set => SetProperty(ref _selectedGame, value);
    }

    public bool HasGames => Games.Count > 0;

    public bool IsScanning
    {
        get => _isScanning;
        set
        {
            if (SetProperty(ref _isScanning, value))
            {
                OnPropertyChanged(nameof(Summary));
                OnPropertyChanged(nameof(EmptyHint));
            }
        }
    }

    public string? StatusText
    {
        get => _statusText;
        private set
        {
            if (SetProperty(ref _statusText, value)) OnPropertyChanged(nameof(Summary));
        }
    }

    public string Summary
    {
        get
        {
            if (StatusText is not null) return StatusText;
            var count = Games.Count == 1 ? "1 game" : $"{Games.Count} games";
            return IsScanning ? $"{count}  ·  checking your launchers…" : count;
        }
    }

    public string EmptyHint => IsScanning
        ? "scanning your launchers for installed games…"
        : "install a game from a supported launcher, then rescan from the system blade.";

    public bool IsSupportedCover(string path) => _covers.IsSupportedImage(path);

    /// <summary>Initial population from the cache: one collection swap instead of N change notifications.</summary>
    /// <param name="preferredId">Game to focus when nothing is selected yet (the one focused when the dashboard last closed).</param>
    public void ReplaceAll(IEnumerable<GameEntry> entries, string? preferredId = null)
    {
        var previousId = SelectedGame?.Id ?? preferredId;
        _byId.Clear();

        var items = entries.Select(e => new GameItemViewModel(e)).ToList();
        items.Sort((a, b) => SortComparer.Compare(a.SortKey, b.SortKey));
        foreach (var item in items) _byId[item.Id] = item;

        Games = new ObservableCollection<GameItemViewModel>(items);
        SelectedGame = (previousId is not null && _byId.TryGetValue(previousId, out var keep)) ? keep : Games.FirstOrDefault();
        RaiseCountChanged();
    }

    public void ApplyChanges(LibraryChangedEventArgs change)
    {
        foreach (var id in change.RemovedIds)
        {
            if (!_byId.Remove(id, out var item)) continue;
            var index = Games.IndexOf(item);
            Games.RemoveAt(index);
            if (ReferenceEquals(SelectedGame, item))
                SelectedGame = Games.Count == 0 ? null : Games[Math.Min(index, Games.Count - 1)];
        }

        foreach (var entry in change.Added.Concat(change.Updated))
        {
            if (_byId.TryGetValue(entry.Id, out var existing))
            {
                if (existing.Update(entry))
                {
                    var wasSelected = ReferenceEquals(SelectedGame, existing);
                    Games.Remove(existing);
                    Insert(existing);
                    if (wasSelected) SelectedGame = existing;
                }
            }
            else
            {
                var item = new GameItemViewModel(entry);
                _byId[item.Id] = item;
                Insert(item);
            }
        }

        SelectedGame ??= Games.FirstOrDefault();
        RaiseCountChanged();
    }

    public void MoveSelection(int delta)
    {
        if (Games.Count == 0) return;
        var current = SelectedGame is null ? -1 : Games.IndexOf(SelectedGame);
        var next = Math.Clamp(current + delta, 0, Games.Count - 1);
        SelectedGame = Games[next];
    }

    /// <summary>Pointer hover: focuses <paramref name="game"/> with the same tick as keyboard navigation.</summary>
    public void FocusGame(GameItemViewModel game)
    {
        if (ReferenceEquals(SelectedGame, game)) return;
        SelectedGame = game;
        _sounds.Play(SoundCue.Navigate);
    }

    public async Task LaunchSelectedAsync()
    {
        var game = SelectedGame;
        if (game is null) return;

        _sounds.Play(SoundCue.ChannelChange);
        ShowStatus($"starting {game.Title}…");
        try
        {
            await _library.LaunchAsync(game.Entry);
        }
        catch (Exception ex)
        {
            Log.Error($"Launch failed for {game.Id}", ex);
            ShowStatus($"couldn't start {game.Title}: {ex.Message}");
        }
    }

    public async Task SetCustomCoverAsync(GameItemViewModel game, string imagePath)
    {
        try
        {
            var cached = await _covers.ImportCustomCoverAsync(game.Entry, imagePath, CancellationToken.None);
            await _library.SetCoverAsync(game.Id, cached, isCustom: true, CancellationToken.None);
            _sounds.Play(SoundCue.Select);
            ShowStatus("cover art updated");
        }
        catch (Exception ex)
        {
            Log.Error($"Custom cover failed for {game.Id}", ex);
            ShowStatus($"couldn't use that image: {ex.Message}");
        }
    }

    private void Insert(GameItemViewModel item)
    {
        // Binary search for the sorted slot.
        int lo = 0, hi = Games.Count;
        while (lo < hi)
        {
            var mid = (lo + hi) / 2;
            if (SortComparer.Compare(Games[mid].SortKey, item.SortKey) <= 0) lo = mid + 1;
            else hi = mid;
        }
        Games.Insert(lo, item);
    }

    private async void ShowStatus(string text)
    {
        var token = ++_statusToken;
        StatusText = text;
        await Task.Delay(TimeSpan.FromSeconds(4));
        if (token == _statusToken) StatusText = null;
    }

    private void RaiseCountChanged()
    {
        OnPropertyChanged(nameof(HasGames));
        OnPropertyChanged(nameof(Summary));
    }
}
