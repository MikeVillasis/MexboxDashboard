using System.IO;
using System.Windows;
using System.Windows.Threading;
using Dashboard.App.Audio;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Data;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Scanners.BattleNet;
using Dashboard.Core.Scanners.Epic;
using Dashboard.Core.Scanners.Riot;
using Dashboard.Core.Scanners.Steam;
using Dashboard.Core.Scanners.Xbox;
using Dashboard.Core.Services;
using Dashboard.Core.Settings;

namespace Dashboard.App;

/// <summary>
/// Composition root. Hand-wired on purpose: a DI container costs startup time we don't have in a 500 ms budget.
/// </summary>
public partial class App : Application
{
    private IMediaService? _media;
    private SettingsStore? _settings;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        AppPaths.EnsureCreated();
        Log.Initialize(AppPaths.LogPath);
        Log.Info($"Starting dashboard {typeof(App).Assembly.GetName().Version}");

        // Read off the UI thread while the rest of the graph is built; awaited just before the window is created.
        _settings = new SettingsStore(AppPaths.SettingsPath);
        var settingsLoad = _settings.LoadAsync();

        DispatcherUnhandledException += OnDispatcherUnhandledException;
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Log.Error("Unobserved task exception", args.Exception);
            args.SetObserved();
        };

        // ── Plugins: add new storefronts here. ──
        IGameScanner[] scanners =
        {
            new SteamScanner(),
            new XboxScanner(),
            new EpicScanner(),
            new BattleNetScanner(),
            new RiotScanner(),
        };

        var covers = new CoverArtPipeline(AppPaths.CoversDir, CoverArtPipeline.LoadSteamGridDbApiKey(AppPaths.SteamGridDbKeyPath));
        var library = new GameLibraryService(scanners, new SqliteGameLibraryCache(AppPaths.DatabasePath), covers);
        _media = new SmtcMediaService();

        var sounds = new SoundService(Path.Combine(AppContext.BaseDirectory, "Assets", "Sounds"));
        sounds.PreloadInBackground();

        await settingsLoad;
        var window = new MainWindow(library, _media, sounds, covers, _settings);
        MainWindow = window;
        window.Show();
        _ = window.InitializeAsync();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _media?.Dispose();
        _settings?.Flush(TimeSpan.FromMilliseconds(500));
        Log.Info("Dashboard exiting");
        Log.Shutdown(TimeSpan.FromMilliseconds(500));
        base.OnExit(e);
    }

    private static void OnDispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // A launcher should survive a bad cover file or a flaky plugin; log and keep the dashboard up.
        Log.Error("Unhandled UI exception", e.Exception);
        e.Handled = true;
    }
}
