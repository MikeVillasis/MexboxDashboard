using System.Collections.ObjectModel;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Services;

namespace Dashboard.App.ViewModels;

/// <summary>Shell operations the System blade can trigger, supplied by MainWindow.</summary>
public sealed record ShellActions(
    Func<Task> Rescan,
    Action ToggleFullscreen,
    Func<bool> ToggleSound,
    Action OpenDataFolder,
    Action Exit);

public sealed class SystemMenuItem : ObservableObject
{
    private string _title;
    private string _description;

    public SystemMenuItem(string title, string description, Action execute)
    {
        _title = title;
        _description = description;
        Execute = execute;
    }

    public string Title
    {
        get => _title;
        set => SetProperty(ref _title, value);
    }

    public string Description
    {
        get => _description;
        set => SetProperty(ref _description, value);
    }

    public Action Execute { get; }
}

public sealed class SystemBladeViewModel : ObservableObject
{
    private readonly GameLibraryService _library;
    private SystemMenuItem? _selectedItem;
    private string _libraryText = string.Empty;
    private string _platformText = string.Empty;
    private string _memoryText = string.Empty;
    private string _lastScanText = string.Empty;

    public SystemBladeViewModel(GameLibraryService library, ShellActions shell, bool soundEnabled)
    {
        _library = library;

        SystemMenuItem? sound = null;
        sound = new SystemMenuItem(SoundTitle(soundEnabled), "blade swooshes and navigation blips", () =>
        {
            sound!.Title = SoundTitle(shell.ToggleSound());
        });

        Items = new ObservableCollection<SystemMenuItem>
        {
            new SystemMenuItem("rescan library", "look for newly installed or removed games", () => _ = shell.Rescan()),
            new SystemMenuItem("toggle fullscreen", "switch between fullscreen and a window (F11)", shell.ToggleFullscreen),
            sound,
            new SystemMenuItem("open data folder", "covers, library cache and logs", shell.OpenDataFolder),
            new SystemMenuItem("exit dashboard", "close the launcher", shell.Exit),
        };
        _selectedItem = Items[0];
    }

    public ObservableCollection<SystemMenuItem> Items { get; }

    public SystemMenuItem? SelectedItem
    {
        get => _selectedItem;
        set => SetProperty(ref _selectedItem, value);
    }

    public string LibraryText { get => _libraryText; private set => SetProperty(ref _libraryText, value); }
    public string PlatformText { get => _platformText; private set => SetProperty(ref _platformText, value); }
    public string MemoryText { get => _memoryText; private set => SetProperty(ref _memoryText, value); }
    public string LastScanText { get => _lastScanText; private set => SetProperty(ref _lastScanText, value); }
    public string DataFolder => AppPaths.DataRoot;
    public string VersionText => $"v{typeof(SystemBladeViewModel).Assembly.GetName().Version?.ToString(3)}";

    public void MoveSelection(int delta)
    {
        var index = SelectedItem is null ? 0 : Items.IndexOf(SelectedItem);
        SelectedItem = Items[Math.Clamp(index + delta, 0, Items.Count - 1)];
    }

    public void ActivateSelected() => SelectedItem?.Execute();

    /// <summary>Cheap: in-memory snapshot plus Environment.WorkingSet, no disk access.</summary>
    public void RefreshStats()
    {
        var games = _library.GetSnapshot();
        LibraryText = games.Count == 1 ? "1 game" : $"{games.Count} games";

        var perPlatform = _library.Scanners
            .Select(s => $"{s.PlatformName.ToLowerInvariant()} {games.Count(g => g.Platform == s.PlatformName)}");
        PlatformText = string.Join("  ·  ", perPlatform);

        MemoryText = $"{Environment.WorkingSet / (1024 * 1024)} MB working set";
        LastScanText = _library.IsScanning
            ? "scanning now…"
            : _library.LastScanCompleted is { } at ? $"last scan {at.LocalDateTime:t}".ToLowerInvariant() : "not scanned yet";
    }

    private static string SoundTitle(bool enabled) => enabled ? "sound effects: on" : "sound effects: off";
}
