using System.Collections.ObjectModel;
using System.Windows;
using Dashboard.App.Services;
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
    private readonly ActivityBridgeService _activity;
    private readonly SystemMenuItem _discord;
    private bool _isLinkPanelOpen;
    private bool _isLinkBusy;
    private string _linkStatus = string.Empty;
    private DateTime _unlinkArmedUntil;

    public SystemBladeViewModel(GameLibraryService library, ShellActions shell, bool soundEnabled, ActivityBridgeService activity)
    {
        _library = library;
        _activity = activity;
        _discord = new SystemMenuItem(string.Empty, string.Empty, OnDiscordItem);
        UpdateDiscordItem();
        // Raised on a worker thread (load, background check, unlink from the Activity side).
        activity.Changed += (_, _) => Application.Current?.Dispatcher.InvokeAsync(UpdateDiscordItem);

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
            _discord,
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

    // ───────────── Discord Activity link (ticket 06) ─────────────

    /// <summary>The code-entry panel is showing (the view focuses its text box).</summary>
    public bool IsLinkPanelOpen { get => _isLinkPanelOpen; private set => SetProperty(ref _isLinkPanelOpen, value); }

    public bool IsLinkBusy { get => _isLinkBusy; private set => SetProperty(ref _isLinkBusy, value); }

    public string LinkStatus { get => _linkStatus; private set => SetProperty(ref _linkStatus, value); }

    public async Task SubmitLinkCodeAsync(string code)
    {
        if (IsLinkBusy) return;
        IsLinkBusy = true;
        LinkStatus = "linking…";
        var result = await _activity.LinkAsync(code); // network + disk off the UI thread; resumes here
        IsLinkBusy = false;
        LinkStatus = result.Message;
        if (result.Success) IsLinkPanelOpen = false;
        UpdateDiscordItem();
    }

    public void CancelLink()
    {
        IsLinkPanelOpen = false;
        LinkStatus = string.Empty;
    }

    /// <summary>Not linked: open the code panel. Linked: unlink, but only on a second press within a few seconds.</summary>
    private void OnDiscordItem()
    {
        if (_activity.Link is null)
        {
            LinkStatus = "in discord, open the activity → friends → link my pc, then type the code here";
            IsLinkPanelOpen = true;
            return;
        }
        if (DateTime.UtcNow > _unlinkArmedUntil)
        {
            _unlinkArmedUntil = DateTime.UtcNow.AddSeconds(4);
            _discord.Description = "press again to unlink this pc";
            return;
        }
        _unlinkArmedUntil = DateTime.MinValue;
        _discord.Description = "unlinking…";
        _ = _activity.UnlinkAsync(); // raises Changed when done
    }

    private void UpdateDiscordItem()
    {
        var link = _activity.Link;
        _discord.Title = link is null ? "link to discord" : $"discord: linked as {link.DisplayName}";
        _discord.Description = link is null
            ? "show your games in the discord activity"
            : $"this pc ({link.Name}) is linked · press twice to unlink";
    }

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
