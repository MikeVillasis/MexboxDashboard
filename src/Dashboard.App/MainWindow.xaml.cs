using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using Dashboard.App.Animation;
using Dashboard.App.Audio;
using Dashboard.App.Controls;
using Dashboard.App.Imaging;
using Dashboard.App.Input;
using Dashboard.App.ViewModels;
using Dashboard.Core.Abstractions;
using Dashboard.Core.Infrastructure;
using Dashboard.Core.Services;

namespace Dashboard.App;

/// <summary>
/// The shell: owns the blade stack, the animated backdrop, and input routing.
/// Keyboard, mouse and gamepad all become <see cref="NavAction"/>s; the front blade's view gets first refusal,
/// unhandled Left/Right/LB/RB switch blades.
/// </summary>
public partial class MainWindow : Window
{
    private static readonly TimeSpan RescanWhenReturningAfter = TimeSpan.FromMinutes(2);

    private readonly GameLibraryService _library;
    private readonly IMediaService _media;
    private readonly SoundService _sounds;
    private readonly XInputService _gamepad;
    private readonly GamesBladeViewModel _gamesVm;
    private readonly MediaViewModel _mediaVm;
    private readonly SystemBladeViewModel _systemVm;
    private readonly List<Blade> _blades = new();
    private readonly List<TextBlock> _headerItems = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly DispatcherTimer _clockTimer;
    private readonly CubicBezierEase _fadeEase = new(0.4, 0.0, 0.2, 1.0);

    private AnimationClock? _auraClockX;
    private AnimationClock? _auraClockY;
    private int _selected = -1;
    private bool _isFullscreen = true;
    private DateTime _lastScanUtc = DateTime.MinValue;

    public MainWindow(GameLibraryService library, IMediaService media, SoundService sounds, ICoverArtService covers)
    {
        InitializeComponent();

        _library = library;
        _media = media;
        _sounds = sounds;
        _fadeEase.Freeze();

        _mediaVm = new MediaViewModel(media, Dispatcher);
        _gamesVm = new GamesBladeViewModel(library, covers, sounds, _mediaVm);
        _systemVm = new SystemBladeViewModel(
            library,
            new ShellActions(RescanAsync, ToggleFullscreen, ToggleSound, OpenDataFolder, Close),
            sounds.Enabled);

        GamesView.DataContext = _gamesVm;
        MediaView.DataContext = _mediaVm;
        SystemView.DataContext = _systemVm;

        foreach (var child in BladeStack.Children)
        {
            if (child is Blade blade) _blades.Add(blade);
        }
        BuildHeader();
        BladeStack.AddHandler(Blade.ActivationRequestedEvent, new RoutedEventHandler(OnBladeActivationRequested));

        NoiseLayer.Fill = NoiseTexture.CreateBrush();
        StartAura();

        UserText.Text = Environment.UserName.ToLowerInvariant();
        _clockTimer = new DispatcherTimer(DispatcherPriority.Background);
        _clockTimer.Tick += (_, _) => UpdateClock();
        UpdateClock();
        _clockTimer.Start();

        _library.LibraryChanged += (_, change) => Dispatcher.InvokeAsync(() =>
        {
            _gamesVm.ApplyChanges(change);
            _systemVm.RefreshStats();
        });

        _gamepad = new XInputService(Dispatcher);
        _gamepad.ActionTriggered += OnGamepadAction;

        Activated += OnWindowActivated;
        Deactivated += OnWindowDeactivated;
        StateChanged += (_, _) => SetAmbientPaused(WindowState == WindowState.Minimized);
        Closed += OnWindowClosed;

        SelectBlade(0, animate: false);
    }

    /// <summary>Cache first (instant), then a background delta scan.</summary>
    public async Task InitializeAsync()
    {
        try
        {
            var startup = Stopwatch.StartNew();
            var cached = await _library.LoadCacheAsync(_shutdown.Token);
            _gamesVm.ReplaceAll(cached);
            _systemVm.RefreshStats();
            Log.Info($"Library on screen {startup.ElapsedMilliseconds} ms after window creation");

            _ = _media.StartAsync(_shutdown.Token);
            await RescanAsync();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Error("Startup failed", ex);
        }
    }

    // ───────────────────────────── Blades ─────────────────────────────

    private IBladeView? ActiveView => _selected >= 0 ? _blades[_selected].Content as IBladeView : null;

    private void SelectBlade(int index, bool animate = true)
    {
        if (index < 0 || index >= _blades.Count || index == _selected) return;

        ActiveView?.OnBladeDeactivated();
        _selected = index;
        BladeStack.SelectedIndex = index;

        for (var i = 0; i < _headerItems.Count; i++)
        {
            var item = _headerItems[i];
            var isCurrent = i == index;
            item.FontSize = isCurrent ? 40 : 24;
            item.Opacity = isCurrent ? 1.0 : 0.45;
        }

        var blade = _blades[index];
        AnimateStop(BackdropTopStop, blade.BackdropTop, animate);
        AnimateStop(BackdropBottomStop, blade.BackdropBottom, animate);
        AnimateStop(AuraInnerStop, WithAlpha(blade.AuraColor, 0x70), animate);
        AnimateStop(AuraOuterStop, WithAlpha(blade.AuraColor, 0x00), animate);

        YHint.Text = index switch
        {
            0 => "cover art",
            1 => "next track",
            _ => "—",
        };

        if (animate) _sounds.Play(SoundCue.BladeSwoosh);
        ActiveView?.OnBladeActivated();
    }

    private void BuildHeader()
    {
        for (var i = 0; i < _blades.Count; i++)
        {
            var index = i;
            var text = new TextBlock
            {
                Text = _blades[i].Header.ToLowerInvariant(),
                FontSize = 24,
                Opacity = 0.45,
                Margin = new Thickness(0, 0, 30, 0),
                VerticalAlignment = VerticalAlignment.Bottom,
                Cursor = Cursors.Hand,
            };
            text.MouseLeftButtonUp += (_, _) => SelectBlade(index);
            HeaderStrip.Children.Add(text);
            _headerItems.Add(text);
        }
    }

    private void OnBladeActivationRequested(object sender, RoutedEventArgs e)
    {
        if (e.OriginalSource is Blade blade)
        {
            var index = _blades.IndexOf(blade);
            if (index >= 0) SelectBlade(index);
        }
        e.Handled = true;
    }

    // ───────────────────────────── Input ─────────────────────────────

    private void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.F11)
        {
            ToggleFullscreen();
            e.Handled = true;
            return;
        }

        var action = MapKey(e.Key, Keyboard.Modifiers);
        if (action is null) return;
        if (e.IsRepeat && action is NavAction.Accept or NavAction.ActionX or NavAction.ActionY or NavAction.Back) return;

        Dispatch(action.Value);
        e.Handled = true;
    }

    private static NavAction? MapKey(Key key, ModifierKeys modifiers) => key switch
    {
        Key.Up => NavAction.Up,
        Key.Down => NavAction.Down,
        Key.Left => NavAction.Left,
        Key.Right => NavAction.Right,
        Key.PageUp => NavAction.PageUp,
        Key.PageDown => NavAction.PageDown,
        Key.Enter or Key.Space => NavAction.Accept,
        Key.Escape or Key.Back => NavAction.Back,
        Key.X => NavAction.ActionX,
        Key.Y or Key.F2 => NavAction.ActionY,
        Key.Q => NavAction.BladePrevious,
        Key.E => NavAction.BladeNext,
        Key.Tab => (modifiers & ModifierKeys.Shift) != 0 ? NavAction.BladePrevious : NavAction.BladeNext,
        _ => null,
    };

    private void OnGamepadAction(NavAction action)
    {
        if (IsActive) Dispatch(action);
    }

    private void Dispatch(NavAction action)
    {
        switch (action)
        {
            case NavAction.BladePrevious:
                SelectBlade(_selected - 1);
                return;
            case NavAction.BladeNext:
                SelectBlade(_selected + 1);
                return;
        }

        if (ActiveView?.HandleAction(action) == true)
        {
            PlayCue(action);
            return;
        }

        switch (action)
        {
            case NavAction.Left:
                SelectBlade(_selected - 1);
                break;
            case NavAction.Right:
                SelectBlade(_selected + 1);
                break;
            case NavAction.Back when _selected != 0:
                _sounds.Play(SoundCue.Back);
                SelectBlade(0);
                break;
        }
    }

    private void PlayCue(NavAction action)
    {
        switch (action)
        {
            case NavAction.Up or NavAction.Down or NavAction.PageUp or NavAction.PageDown:
                _sounds.Play(SoundCue.Navigate);
                break;
            case NavAction.Accept when _selected != 0: // the Games blade plays its own launch cue
                _sounds.Play(SoundCue.Select);
                break;
            case NavAction.Back:
                _sounds.Play(SoundCue.Back);
                break;
        }
    }

    // ───────────────────────────── Shell actions ─────────────────────────────

    private async Task RescanAsync()
    {
        if (_library.IsScanning) return;
        _gamesVm.IsScanning = true;
        _systemVm.RefreshStats();
        try
        {
            await _library.RefreshAsync(_shutdown.Token);
            _lastScanUtc = DateTime.UtcNow;
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Error("Library scan failed", ex);
        }
        finally
        {
            _gamesVm.IsScanning = false;
            _systemVm.RefreshStats();
        }
    }

    private void ToggleFullscreen()
    {
        _isFullscreen = !_isFullscreen;
        if (_isFullscreen)
        {
            WindowState = WindowState.Normal; // must leave Maximized before changing style or the taskbar stays visible
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
        }
        else
        {
            WindowState = WindowState.Normal;
            WindowStyle = WindowStyle.SingleBorderWindow;
            ResizeMode = ResizeMode.CanResize;
            Width = 1600;
            Height = 900;
        }
    }

    private bool ToggleSound()
    {
        _sounds.Enabled = !_sounds.Enabled;
        return _sounds.Enabled;
    }

    private void OpenDataFolder()
    {
        try
        {
            using var _ = Process.Start(new ProcessStartInfo("explorer.exe", $"\"{AppPaths.DataRoot}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log.Warn("Could not open data folder", ex);
        }
    }

    // ───────────────────────────── Window lifecycle ─────────────────────────────

    private void OnWindowActivated(object? sender, EventArgs e)
    {
        _gamepad.IsSuspended = false;
        SetAmbientPaused(false);

        // Coming back from a game or the desktop: pick up anything installed meanwhile.
        if (_lastScanUtc != DateTime.MinValue && DateTime.UtcNow - _lastScanUtc > RescanWhenReturningAfter)
            _ = RescanAsync();
    }

    private void OnWindowDeactivated(object? sender, EventArgs e)
    {
        // A game is probably in front: stop reading the pad and stop animating.
        _gamepad.IsSuspended = true;
        SetAmbientPaused(true);
    }

    private void OnWindowClosed(object? sender, EventArgs e)
    {
        _shutdown.Cancel();
        _gamepad.Dispose();
        _clockTimer.Stop();
    }

    // ───────────────────────────── Ambient visuals ─────────────────────────────

    private void StartAura()
    {
        var breathe = new DoubleAnimation(0.92, 1.08, TimeSpan.FromSeconds(9))
        {
            AutoReverse = true,
            RepeatBehavior = RepeatBehavior.Forever,
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        breathe.Freeze();

        _auraClockX = breathe.CreateClock();
        _auraClockY = breathe.CreateClock();
        AuraScale.ApplyAnimationClock(ScaleTransform.ScaleXProperty, _auraClockX);
        AuraScale.ApplyAnimationClock(ScaleTransform.ScaleYProperty, _auraClockY);
    }

    /// <summary>The only perpetual animation; pausing it lets WPF's render loop go fully idle.</summary>
    private void SetAmbientPaused(bool paused)
    {
        foreach (var clock in new[] { _auraClockX, _auraClockY })
        {
            if (clock?.Controller is null) continue;
            if (paused) clock.Controller.Pause();
            else clock.Controller.Resume();
        }
    }

    private void AnimateStop(GradientStop stop, Color to, bool animate)
    {
        if (!animate)
        {
            stop.BeginAnimation(GradientStop.ColorProperty, null);
            stop.Color = to;
            return;
        }

        var fade = new ColorAnimation(to, TimeSpan.FromMilliseconds(700)) { EasingFunction = _fadeEase };
        fade.Freeze();
        stop.BeginAnimation(GradientStop.ColorProperty, fade, HandoffBehavior.SnapshotAndReplace);
    }

    private void UpdateClock()
    {
        var now = DateTime.Now;
        ClockText.Text = now.ToString("t", CultureInfo.CurrentCulture).ToLowerInvariant();
        _clockTimer.Interval = TimeSpan.FromMilliseconds(60_000 - (now.Second * 1000 + now.Millisecond) + 20);
    }

    private static Color WithAlpha(Color color, byte alpha) => Color.FromArgb(alpha, color.R, color.G, color.B);
}
