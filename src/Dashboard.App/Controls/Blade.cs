using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Dashboard.App.Controls;

/// <summary>
/// One dashboard blade. Hosts a view and carries its theme (accent, glow, backdrop colours).
/// Clicking a blade that is not in front asks the host to bring it forward.
/// </summary>
public sealed class Blade : ContentControl
{
    public static readonly DependencyProperty HeaderProperty = DependencyProperty.Register(
        nameof(Header), typeof(string), typeof(Blade), new PropertyMetadata(string.Empty));

    public static readonly DependencyProperty AccentProperty = DependencyProperty.Register(
        nameof(Accent), typeof(Color), typeof(Blade), new PropertyMetadata(Color.FromRgb(0x10, 0x7C, 0x10)));

    public static readonly DependencyProperty GlowProperty = DependencyProperty.Register(
        nameof(Glow), typeof(Color), typeof(Blade), new PropertyMetadata(Color.FromRgb(0x9B, 0xF0, 0x0B)));

    public static readonly DependencyProperty BackdropTopProperty = DependencyProperty.Register(
        nameof(BackdropTop), typeof(Color), typeof(Blade), new PropertyMetadata(Color.FromRgb(0x0E, 0x3A, 0x0E)));

    public static readonly DependencyProperty BackdropBottomProperty = DependencyProperty.Register(
        nameof(BackdropBottom), typeof(Color), typeof(Blade), new PropertyMetadata(Color.FromRgb(0x01, 0x0A, 0x01)));

    public static readonly DependencyProperty AuraColorProperty = DependencyProperty.Register(
        nameof(AuraColor), typeof(Color), typeof(Blade), new PropertyMetadata(Color.FromRgb(0x77, 0xBB, 0x00)));

    public static readonly DependencyProperty IsActiveProperty = DependencyProperty.Register(
        nameof(IsActive), typeof(bool), typeof(Blade), new PropertyMetadata(false, OnIsActiveChanged));

    public static readonly RoutedEvent ActivationRequestedEvent = EventManager.RegisterRoutedEvent(
        "ActivationRequested", RoutingStrategy.Bubble, typeof(RoutedEventHandler), typeof(Blade));

    private static readonly Duration FadeIn = new(TimeSpan.FromMilliseconds(300));
    private static readonly Duration FadeOut = new(TimeSpan.FromMilliseconds(160));

    private readonly BitmapCache _cache = new() { SnapsToDevicePixels = true, EnableClearType = false };
    private UIElement? _content;

    public Blade()
    {
        // Cache the blade as a texture so slide animations only re-composite.
        CacheMode = _cache;
        Loaded += (_, _) => _cache.RenderAtScale = VisualTreeHelper.GetDpi(this).DpiScaleX;
    }

    /// <summary>
    /// The texture cache only pays off while the blade moves. The front blade drops it once it settles, so focus
    /// animations inside it redraw just the animated elements instead of re-rasterising the whole blade every frame.
    /// </summary>
    internal void SetCached(bool cached) => CacheMode = cached ? _cache : null;

    public event RoutedEventHandler ActivationRequested
    {
        add => AddHandler(ActivationRequestedEvent, value);
        remove => RemoveHandler(ActivationRequestedEvent, value);
    }

    public string Header
    {
        get => (string)GetValue(HeaderProperty);
        set => SetValue(HeaderProperty, value);
    }

    public Color Accent
    {
        get => (Color)GetValue(AccentProperty);
        set => SetValue(AccentProperty, value);
    }

    public Color Glow
    {
        get => (Color)GetValue(GlowProperty);
        set => SetValue(GlowProperty, value);
    }

    public Color BackdropTop
    {
        get => (Color)GetValue(BackdropTopProperty);
        set => SetValue(BackdropTopProperty, value);
    }

    public Color BackdropBottom
    {
        get => (Color)GetValue(BackdropBottomProperty);
        set => SetValue(BackdropBottomProperty, value);
    }

    public Color AuraColor
    {
        get => (Color)GetValue(AuraColorProperty);
        set => SetValue(AuraColorProperty, value);
    }

    /// <summary>Set by <see cref="BladeStackPanel"/>; true for the blade in front.</summary>
    public bool IsActive
    {
        get => (bool)GetValue(IsActiveProperty);
        set => SetValue(IsActiveProperty, value);
    }

    public override void OnApplyTemplate()
    {
        base.OnApplyTemplate();
        _content = GetTemplateChild("PART_Content") as UIElement;
        if (_content is not null) _content.Opacity = IsActive ? 1 : 0;
    }

    private static void OnIsActiveChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        var blade = (Blade)d;
        if (blade._content is null) return;

        var active = (bool)e.NewValue;
        var fade = new DoubleAnimation(active ? 1 : 0, active ? FadeIn : FadeOut)
        {
            BeginTime = active ? TimeSpan.FromMilliseconds(120) : TimeSpan.Zero,
        };
        fade.Freeze();
        blade._content.BeginAnimation(OpacityProperty, fade, HandoffBehavior.SnapshotAndReplace);
    }

    protected override void OnDpiChanged(DpiScale oldDpi, DpiScale newDpi)
    {
        base.OnDpiChanged(oldDpi, newDpi);
        _cache.RenderAtScale = newDpi.DpiScaleX;
    }

    protected override void OnPreviewMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        if (!IsActive)
        {
            RaiseEvent(new RoutedEventArgs(ActivationRequestedEvent, this));
            e.Handled = true;
            return;
        }
        base.OnPreviewMouseLeftButtonDown(e);
    }
}
