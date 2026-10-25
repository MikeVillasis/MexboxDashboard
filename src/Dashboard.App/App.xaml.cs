using System.IO;
using System.Windows;
using System.Windows.Threading;
using Dashboard.App.Audio;
using Dashboard.App.Services;
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
        // A --profile instance (P2P testing) logs separately: two processes appending to one file clobber each other.
        Log.Initialize(AppPaths.ForProfile(AppPaths.LogPath, ArgValue(e.Args, "--profile=")));
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

        // Discord Activity link (ticket 06): opt-in. With no saved link this reads one missing file and never touches the
        // network. --activity-server=<url> points it at another Worker (local dev: http://localhost:8787).
        var activity = new ActivityBridgeService(
            AppPaths.ForProfile(AppPaths.ActivityDevicePath, ArgValue(e.Args, "--profile=")), ActivityServer(e.Args));
        activity.AttachSources(library, _media); // ticket 07: publishes library + now playing only while linked
        _ = activity.LoadAsync();

        // Hybrid WebView2 shell (in development): same services, HTML/WebGL front end.
        if (e.Args.Contains("--web", StringComparer.OrdinalIgnoreCase))
        {
            var web = new Web.WebShellWindow(library, _media, sounds, _settings, activity)
            {
                // --blade=avatar opens on a given blade (handy for testing and desktop shortcuts).
                Profile = ArgValue(e.Args, "--profile="),
                ConnectTo = ArgValue(e.Args, "--connect=")?.ToUpperInvariant(),
                PlazaSelfTest = e.Args.Contains("--plaza-selftest", StringComparer.OrdinalIgnoreCase),
                StartBlade = e.Args.FirstOrDefault(a => a.StartsWith("--blade=", StringComparison.OrdinalIgnoreCase))?[8..],
            };
            MainWindow = web;
            web.Show();
            _ = _media.StartAsync(CancellationToken.None);
            return;
        }

        var window = new MainWindow(library, _media, sounds, covers, _settings, activity);
        MainWindow = window;
        window.Show();
        _ = window.InitializeAsync();
    }

    /// <summary>--activity-server=https://… (or http://localhost:… for local dev); anything else is ignored.</summary>
    private static string? ActivityServer(string[] args)
    {
        var value = args.FirstOrDefault(a => a.StartsWith("--activity-server=", StringComparison.OrdinalIgnoreCase))?[18..];
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return null;
        var ok = uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback);
        return ok ? uri.GetLeftPart(UriPartial.Authority) : null;
    }

    private static string? ArgValue(string[] args, string prefix) =>
        args.FirstOrDefault(a => a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))?[prefix.Length..] is { Length: > 0 } v
            ? new string(v.Where(char.IsLetterOrDigit).ToArray())
            : null;

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
