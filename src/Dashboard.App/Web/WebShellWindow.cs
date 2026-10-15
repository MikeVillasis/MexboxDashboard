using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media;
using Dashboard.App.Audio;
using Dashboard.App.Input;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Services;
using Dashboard.Core.Settings;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Dashboard.App.Web;

/// <summary>
/// Hybrid shell (start with <c>--web</c>): one borderless window filled by a WebView2 that renders the dashboard from
/// <c>https://xbox.local/</c>, a virtual host mapped to the WebAssets folder (no HTTP server, no CORS issues).
/// C# stays authoritative: library, launching, media, settings, sounds and controller input all live in the existing
/// services; the page reaches them through <see cref="XboxHostBridge"/> and receives events via <see cref="WebMessageDispatcher"/>.
/// </summary>
public sealed class WebShellWindow : Window
{
    public const string HostName = "xbox.local";
    public const string Origin = "https://" + HostName + "/";

    private readonly GameLibraryService _library;
    private readonly SoundService _sounds;
    private readonly SettingsStore _settings;
    private readonly WebView2 _webView = new();
    private readonly WebMessageDispatcher _messages;
    private readonly XInputService _gamepad;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Stopwatch _startup = Stopwatch.StartNew();

    public WebShellWindow(GameLibraryService library, IMediaService media, SoundService sounds, SettingsStore settings)
    {
        _library = library;
        _sounds = sounds;
        _settings = settings;
        _sounds.Enabled = settings.Current.SoundEnabled;
        _messages = new WebMessageDispatcher(Dispatcher);

        Title = "Xbox 360 Dashboard";
        Background = Brushes.Black;
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        WindowState = WindowState.Maximized;

        // Transparent so the page owns every pixel; the window's black shows only before the first frame.
        _webView.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        Content = _webView;

        _gamepad = new XInputService(Dispatcher);
        _gamepad.ActionTriggered += action => PostNav(action, "gamepad");
        Activated += (_, _) => _gamepad.IsSuspended = false;
        Deactivated += (_, _) => _gamepad.IsSuspended = true;

        _library.LibraryChanged += (_, _) => _messages.Post("LIBRARY_CHANGED", new JsonObject { ["count"] = _library.GetSnapshot().Count });
        media.SessionUpdated += (_, info) => _messages.Post("MEDIA_UPDATED", info is null ? null : new JsonObject
        {
            ["title"] = info.Title,
            ["artist"] = info.Artist,
            ["app"] = info.SourceAppName,
            ["state"] = info.State.ToString(),
        });

        Loaded += async (_, _) => await InitializeAsync();
        Closed += (_, _) =>
        {
            _shutdown.Cancel();
            _gamepad.Dispose();
            _webView.Dispose();
        };
    }

    private async Task InitializeAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: Path.Combine(AppPaths.DataRoot, "WebView2"));
            await _webView.EnsureCoreWebView2Async(environment);
            var core = _webView.CoreWebView2;

            // Console shell, not a browser.
            var s = core.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
#if DEBUG
            s.AreDevToolsEnabled = true;
            s.AreBrowserAcceleratorKeysEnabled = true;
#else
            s.AreDevToolsEnabled = false;
            s.AreBrowserAcceleratorKeysEnabled = false;
#endif

            var assets = Path.Combine(AppContext.BaseDirectory, "WebAssets");
            core.SetVirtualHostNameToFolderMapping(HostName, assets, CoreWebView2HostResourceAccessKind.Allow);

            // Stay on our origin: external links open in the user's browser instead of replacing the shell.
            core.NavigationStarting += (_, e) =>
            {
                if (e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                Log.Warn($"Web: blocked navigation to {e.Uri}");
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;

            core.AddHostObjectToScript("xboxBackend", new XboxHostBridge(_library, _sounds, _settings));
            _messages.Attach(core);
            RegisterHandlers();

            core.NavigationCompleted += (_, e) =>
            {
                Log.Info($"Web: page loaded ({(e.IsSuccess ? "ok" : e.WebErrorStatus.ToString())}) {_startup.ElapsedMilliseconds} ms after window creation");
                if (!e.IsSuccess) return;
                _webView.Focus(); // the browser needs keyboard focus, not just the window
                _messages.Post("HOST_READY", new JsonObject
                {
                    ["version"] = typeof(WebShellWindow).Assembly.GetName().Version?.ToString(3),
                    ["games"] = _library.GetSnapshot().Count,
                });
            };

            core.Navigate(Origin + "index.html");
            _ = LoadLibraryAsync();
        }
        catch (WebView2RuntimeNotFoundException ex)
        {
            Log.Error("Web: the WebView2 runtime is not installed", ex);
            MessageBox.Show(this, "The Microsoft Edge WebView2 Runtime is required for --web mode.", Title);
            Close();
        }
        catch (Exception ex)
        {
            Log.Error("Web: shell failed to start", ex);
        }
    }

    private void RegisterHandlers()
    {
        // Ping/pong over the message channel (the host-object path is tested separately by the page).
        _messages.On("PING", payload =>
        {
            Log.Info($"Web: PING received ({payload?["sent"]})");
            _messages.Post("PONG", new JsonObject { ["echo"] = payload?["sent"]?.DeepClone(), ["host"] = "csharp" });
        });

        _messages.On("PONG_ACK", payload => Log.Info($"Web: page confirmed PONG, round trip {payload?["roundTripMs"]} ms"));

        // The browser owns keyboard focus, so the page forwards raw keys and C# decides what they mean.
        _messages.On("KEY", payload =>
        {
            var key = payload?["key"]?.GetValue<string>();
            var shift = payload?["shift"]?.GetValue<bool>() ?? false;
            if (key == "F11") return; // fullscreen toggle arrives with the Phase 2 shell
            if (MapKey(key, shift) is { } action) PostNav(action, "keyboard");
        });
    }

    private void PostNav(NavAction action, string source) =>
        _messages.Post("NAV", new JsonObject { ["action"] = action.ToString(), ["source"] = source });

    private async Task LoadLibraryAsync()
    {
        try
        {
            await _library.LoadCacheAsync(_shutdown.Token);
            _messages.Post("LIBRARY_CHANGED", new JsonObject { ["count"] = _library.GetSnapshot().Count });
            await _library.RefreshAsync(_shutdown.Token);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Error("Web: library load failed", ex);
        }
    }

    /// <summary>Same bindings as the native shell (see README controls table), from DOM <c>KeyboardEvent.key</c> names.</summary>
    private static NavAction? MapKey(string? key, bool shift) => key switch
    {
        "ArrowUp" => NavAction.Up,
        "ArrowDown" => NavAction.Down,
        "ArrowLeft" => NavAction.Left,
        "ArrowRight" => NavAction.Right,
        "PageUp" => NavAction.PageUp,
        "PageDown" => NavAction.PageDown,
        "Enter" or " " => NavAction.Accept,
        "Escape" or "Backspace" => NavAction.Back,
        "x" or "X" => NavAction.ActionX,
        "y" or "Y" or "F2" => NavAction.ActionY,
        "q" or "Q" => NavAction.BladePrevious,
        "e" or "E" => NavAction.BladeNext,
        "Tab" => shift ? NavAction.BladePrevious : NavAction.BladeNext,
        _ => null,
    };
}
