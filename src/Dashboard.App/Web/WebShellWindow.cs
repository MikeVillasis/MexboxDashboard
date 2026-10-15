using System.Diagnostics;
using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Media;
using Dashboard.App.Audio;
using Dashboard.App.Input;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Models;
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
    private readonly IMediaService _media;
    private readonly WebView2 _webView = new();
    private readonly WebMessageDispatcher _messages;
    private readonly XInputService _gamepad;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Stopwatch _startup = Stopwatch.StartNew();
    private bool _isFullscreen = true;
    private byte[]? _lastArtBytes;
    private string? _lastArtUri;

    public WebShellWindow(GameLibraryService library, IMediaService media, SoundService sounds, SettingsStore settings)
    {
        _library = library;
        _sounds = sounds;
        _settings = settings;
        _media = media;
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
        _gamepad.ActionTriggered += action => PostCommand(action, "gamepad");
        // A game in front: stop polling the pad and let the page pause its WebGL loop.
        Activated += (_, _) =>
        {
            _gamepad.IsSuspended = false;
            _messages.Post("SHELL_ACTIVE", new JsonObject { ["active"] = true });
        };
        Deactivated += (_, _) =>
        {
            _gamepad.IsSuspended = true;
            _messages.Post("SHELL_ACTIVE", new JsonObject { ["active"] = false });
        };

        _library.LibraryChanged += (_, _) => _messages.Post("LIBRARY_CHANGED", new JsonObject { ["count"] = _library.GetSnapshot().Count });
        media.SessionUpdated += (_, info) => _messages.Post("MEDIA_UPDATED", MediaJson(info));

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
            // Covers live in %AppData%; a second host keeps them reachable without file:// URLs. Read-only content.
            core.SetVirtualHostNameToFolderMapping(XboxHostBridge.CoversHostName, AppPaths.CoversDir, CoreWebView2HostResourceAccessKind.Allow);

            // Stay on our origin: external links open in the user's browser instead of replacing the shell.
            core.NavigationStarting += (_, e) =>
            {
                if (e.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                Log.Warn($"Web: blocked navigation to {e.Uri}");
            };
            core.NewWindowRequested += (_, e) => e.Handled = true;

            var actions = new WebShellActions(ToggleFullscreen, Close);
            core.AddHostObjectToScript("xboxBackend", new XboxHostBridge(_library, _sounds, _settings, _media, actions));
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
                    ["media"] = MediaJson(_media.Current),
                    ["soundEnabled"] = _sounds.Enabled,
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
            if (key == "F11") { ToggleFullscreen(); return; }
            if (key is "g" or "G") { _messages.Post("OPEN_GAMERCARD", new JsonObject { ["source"] = "keyboard" }); return; }
            if (MapKey(key, shift) is { } action) PostCommand(action, "keyboard");
        });
    }

    /// <summary>
    /// Translates device-neutral input into the page's command vocabulary. The page owns view state, so it decides what
    /// a d-pad move means on the current blade (e.g. an unhandled left/right switches blades, as in the native shell).
    /// </summary>
    private void PostCommand(NavAction action, string source)
    {
        var (type, payload) = action switch
        {
            NavAction.Up => ("NAVIGATE_DPAD", new JsonObject { ["direction"] = "up" }),
            NavAction.Down => ("NAVIGATE_DPAD", new JsonObject { ["direction"] = "down" }),
            NavAction.Left => ("NAVIGATE_DPAD", new JsonObject { ["direction"] = "left" }),
            NavAction.Right => ("NAVIGATE_DPAD", new JsonObject { ["direction"] = "right" }),
            NavAction.PageUp => ("NAVIGATE_DPAD", new JsonObject { ["direction"] = "pageup" }),
            NavAction.PageDown => ("NAVIGATE_DPAD", new JsonObject { ["direction"] = "pagedown" }),
            NavAction.BladePrevious => ("SWITCH_BLADE", new JsonObject { ["delta"] = -1 }),
            NavAction.BladeNext => ("SWITCH_BLADE", new JsonObject { ["delta"] = 1 }),
            NavAction.Accept => ("SELECT_ITEM", new JsonObject()),
            NavAction.Back => ("BACK", new JsonObject()),
            NavAction.ActionX => ("ACTION_X", new JsonObject()),
            NavAction.ActionY => ("ACTION_Y", new JsonObject()),
            _ => (null, null),
        };
        if (type is null) return;
        payload!["source"] = source;
        _messages.Post(type, payload);
    }

    private void ToggleFullscreen()
    {
        _isFullscreen = !_isFullscreen;
        WindowState = WindowState.Normal; // leave Maximized before changing style or the taskbar stays visible
        if (_isFullscreen)
        {
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowStyle = WindowStyle.SingleBorderWindow;
            ResizeMode = ResizeMode.CanResize;
            Width = 1600;
            Height = 900;
            Left = SystemParameters.WorkArea.Left + (SystemParameters.WorkArea.Width - Width) / 2;
            Top = SystemParameters.WorkArea.Top + (SystemParameters.WorkArea.Height - Height) / 2;
        }
    }

    /// <summary>Album art travels as a data URI, re-encoded only when the track's artwork array changes.</summary>
    private JsonObject? MediaJson(MediaSessionInfo? info)
    {
        if (info is null) return null;
        if (!ReferenceEquals(info.ThumbnailBytes, _lastArtBytes))
        {
            _lastArtBytes = info.ThumbnailBytes;
            _lastArtUri = info.ThumbnailBytes is { Length: > 0 } bytes ? "data:image/jpeg;base64," + Convert.ToBase64String(bytes) : null;
        }
        return new JsonObject
        {
            ["title"] = info.Title,
            ["artist"] = info.Artist,
            ["album"] = info.AlbumTitle,
            ["app"] = info.SourceAppName.ToLowerInvariant(),
            ["playing"] = info.State == MediaPlaybackState.Playing,
            ["canNext"] = info.CanGoNext,
            ["canPrevious"] = info.CanGoPrevious,
            ["art"] = _lastArtUri,
        };
    }

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
