using System.Globalization;
using System.Windows;
using System.Windows.Media;

namespace Dashboard.App.Controls;

/// <summary>
/// Draws the blade body in a single retained OnRender pass: concave leading edge, gradient plastic,
/// ambient bloom, top-half specular gloss, rim light, tab strip and the vertical blade label.
/// Re-renders only on resize or theme change; never per animation frame.
/// </summary>
public sealed class BladeChrome : FrameworkElement
{
    public static readonly DependencyProperty HeaderProperty = DependencyProperty.Register(
        nameof(Header), typeof(string), typeof(BladeChrome),
        new FrameworkPropertyMetadata(string.Empty, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty AccentProperty = DependencyProperty.Register(
        nameof(Accent), typeof(Color), typeof(BladeChrome),
        new FrameworkPropertyMetadata(Colors.Green, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty GlowProperty = DependencyProperty.Register(
        nameof(Glow), typeof(Color), typeof(BladeChrome),
        new FrameworkPropertyMetadata(Colors.LimeGreen, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty LabelBrushProperty = DependencyProperty.Register(
        nameof(LabelBrush), typeof(Brush), typeof(BladeChrome),
        new FrameworkPropertyMetadata(Brushes.White, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty TabWidthProperty = DependencyProperty.Register(
        nameof(TabWidth), typeof(double), typeof(BladeChrome),
        new FrameworkPropertyMetadata(56.0, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty CurveDepthProperty = DependencyProperty.Register(
        nameof(CurveDepth), typeof(double), typeof(BladeChrome),
        new FrameworkPropertyMetadata(22.0, FrameworkPropertyMetadataOptions.AffectsRender));

    private const double CornerRadius = 20;
    private const double LabelSize = 24;
    private const double LabelTop = 34;

    private static readonly Typeface LabelTypeface = new(
        new FontFamily("Segoe UI"), FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal);

    private static readonly Brush ShadowFar = Frozen(new SolidColorBrush(Color.FromArgb(0x26, 0, 0, 0)));
    private static readonly Brush ShadowNear = Frozen(new SolidColorBrush(Color.FromArgb(0x40, 0, 0, 0)));
    private static readonly Brush TabShade = Frozen(new SolidColorBrush(Color.FromArgb(0x26, 0, 0, 0)));
    private static readonly Brush TabDivider = Frozen(new SolidColorBrush(Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF)));
    private static readonly Brush TopLine = Frozen(new SolidColorBrush(Color.FromArgb(0x8C, 0xFF, 0xFF, 0xFF)));

    private static readonly Brush Gloss = Frozen(new LinearGradientBrush(
        new GradientStopCollection
        {
            new GradientStop(Color.FromArgb(0x52, 0xFF, 0xFF, 0xFF), 0.0),
            new GradientStop(Color.FromArgb(0x2E, 0xFF, 0xFF, 0xFF), 0.6),
            new GradientStop(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF), 0.985),
            new GradientStop(Color.FromArgb(0x00, 0xFF, 0xFF, 0xFF), 1.0),
        },
        new Point(0, 0), new Point(0, 1)));

    private static readonly Pen RimPen = Frozen(new Pen(Frozen(new LinearGradientBrush(
        Color.FromArgb(0xB0, 0xFF, 0xFF, 0xFF), Color.FromArgb(0x30, 0xFF, 0xFF, 0xFF), 90)), 1.5));

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

    public Brush LabelBrush
    {
        get => (Brush)GetValue(LabelBrushProperty);
        set => SetValue(LabelBrushProperty, value);
    }

    public double TabWidth
    {
        get => (double)GetValue(TabWidthProperty);
        set => SetValue(TabWidthProperty, value);
    }

    public double CurveDepth
    {
        get => (double)GetValue(CurveDepthProperty);
        set => SetValue(CurveDepthProperty, value);
    }

    protected override void OnRender(DrawingContext dc)
    {
        var w = ActualWidth;
        var h = ActualHeight;
        if (w < CornerRadius * 2 || h < CornerRadius * 2) return;

        var shape = BuildShape(w, h, CurveDepth, CornerRadius);
        var accent = Accent;
        var tab = TabWidth;

        // Cheap two-step drop shadow on the leading edge (separates stacked blades without a pixel shader).
        dc.PushTransform(new TranslateTransform(-12, 0));
        dc.DrawGeometry(ShadowFar, null, shape);
        dc.Pop();
        dc.PushTransform(new TranslateTransform(-5, 0));
        dc.DrawGeometry(ShadowNear, null, shape);
        dc.Pop();

        // Plastic body.
        var body = new LinearGradientBrush(
            new GradientStopCollection
            {
                new GradientStop(Mix(accent, Colors.White, 0.32), 0.0),
                new GradientStop(accent, 0.42),
                new GradientStop(Mix(accent, Colors.Black, 0.5), 1.0),
            },
            new Point(0, 0), new Point(0, 1));
        body.Freeze();
        dc.DrawGeometry(body, null, shape);

        dc.PushClip(shape);

        // Ambient bloom from the blade's glow colour.
        var bloom = new RadialGradientBrush(WithAlpha(Glow, 0x6E), WithAlpha(Glow, 0x00))
        {
            Center = new Point(0.3, 0.0),
            GradientOrigin = new Point(0.3, 0.0),
            RadiusX = 0.65,
            RadiusY = 0.55,
        };
        bloom.Freeze();
        dc.DrawRectangle(bloom, null, new Rect(0, 0, w, h));

        // Tab strip.
        dc.DrawRectangle(TabShade, null, new Rect(0, 0, tab, h));
        dc.DrawRectangle(TabDivider, null, new Rect(tab, 0, 1, h));

        // Specular gloss across the top and a hairline highlight on the lip.
        dc.DrawRectangle(Gloss, null, new Rect(0, 0, w, Math.Min(h * 0.34, 280)));
        dc.DrawRectangle(TopLine, null, new Rect(0, 0, w, 2));

        dc.Pop();

        dc.DrawGeometry(null, RimPen, shape);

        DrawLabel(dc, tab);
    }

    private void DrawLabel(DrawingContext dc, double tab)
    {
        var text = (Header ?? string.Empty).ToLowerInvariant();
        if (text.Length == 0) return;

        var label = new FormattedText(
            text, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, LabelTypeface, LabelSize,
            LabelBrush ?? Brushes.White, VisualTreeHelper.GetDpi(this).PixelsPerDip);

        // Rotate -90° so the label reads bottom-to-top inside the tab strip, anchored near the top.
        var x = (tab - label.Height) / 2 + CurveDepth * 0.15;
        var y = LabelTop + label.WidthIncludingTrailingWhitespace;
        dc.PushTransform(new TranslateTransform(x, y));
        dc.PushTransform(new RotateTransform(-90));
        dc.DrawText(label, new Point(0, 0));
        dc.Pop();
        dc.Pop();
    }

    /// <summary>Rounded rectangle whose leading edge bows inward (the classic concave blade lip).</summary>
    private static StreamGeometry BuildShape(double w, double h, double curve, double r)
    {
        var geometry = new StreamGeometry();
        using (var ctx = geometry.Open())
        {
            ctx.BeginFigure(new Point(r, 0), isFilled: true, isClosed: true);
            ctx.LineTo(new Point(w, 0), true, false);
            ctx.LineTo(new Point(w, h), true, false);
            ctx.LineTo(new Point(r, h), true, false);
            ctx.QuadraticBezierTo(new Point(0, h), new Point(0, h - r), true, true);
            ctx.BezierTo(new Point(curve, h * 0.68), new Point(curve, h * 0.32), new Point(0, r), true, true);
            ctx.QuadraticBezierTo(new Point(0, 0), new Point(r, 0), true, true);
        }
        geometry.Freeze();
        return geometry;
    }

    private static Color Mix(Color a, Color b, double t) => Color.FromArgb(
        a.A,
        (byte)(a.R + (b.R - a.R) * t),
        (byte)(a.G + (b.G - a.G) * t),
        (byte)(a.B + (b.B - a.B) * t));

    private static Color WithAlpha(Color c, byte alpha) => Color.FromArgb(alpha, c.R, c.G, c.B);

    private static T Frozen<T>(T freezable) where T : Freezable
    {
        freezable.Freeze();
        return freezable;
    }
}
