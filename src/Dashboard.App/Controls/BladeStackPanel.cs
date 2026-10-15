using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Dashboard.App.Animation;

namespace Dashboard.App.Controls;

/// <summary>
/// Lays blades out like the 2005 dashboard: blades before the selected one collapse to their tab on the left,
/// blades after it collapse to their tab on the right, and the selected blade fills the gap.
/// Every child is arranged once at a fixed size; switching blades only animates a TranslateTransform
/// (render-thread compositing of cached bitmaps, no layout pass).
/// </summary>
public sealed class BladeStackPanel : Panel
{
    /// <summary>Visible width of a collapsed blade's tab strip.</summary>
    public const double TabWidth = 56;

    /// <summary>How far each blade extends under the next blade's tab (hides the concave lip gap).</summary>
    public const double Overlap = 64;

    public static readonly DependencyProperty SelectedIndexProperty = DependencyProperty.Register(
        nameof(SelectedIndex), typeof(int), typeof(BladeStackPanel),
        new FrameworkPropertyMetadata(0, OnSelectedIndexChanged));

    private static readonly Duration SlideDuration = new(TimeSpan.FromMilliseconds(640));

    private readonly SpringEase _ease;
    private Size _arrangedSize;
    private int _arrangedCount;

    public BladeStackPanel()
    {
        ClipToBounds = true;
        _ease = new SpringEase { Damping = 8.5, Frequency = 8.0 };
        _ease.Freeze();
    }

    public int SelectedIndex
    {
        get => (int)GetValue(SelectedIndexProperty);
        set => SetValue(SelectedIndexProperty, value);
    }

    protected override Size MeasureOverride(Size availableSize)
    {
        var size = new Size(
            double.IsInfinity(availableSize.Width) ? 1280 : availableSize.Width,
            double.IsInfinity(availableSize.Height) ? 720 : availableSize.Height);

        var childSize = GetChildSize(size);
        foreach (UIElement child in InternalChildren) child.Measure(childSize);
        return size;
    }

    protected override Size ArrangeOverride(Size finalSize)
    {
        var childSize = GetChildSize(finalSize);
        foreach (UIElement child in InternalChildren)
        {
            child.Arrange(new Rect(new Point(0, 0), childSize));
            EnsureTransform(child);
        }

        // Re-seat instantly on resize or when blades are added; animate only on selection changes.
        if (finalSize != _arrangedSize || InternalChildren.Count != _arrangedCount)
        {
            _arrangedSize = finalSize;
            _arrangedCount = InternalChildren.Count;
            UpdatePositions(animate: false);
        }

        return finalSize;
    }

    private Size GetChildSize(Size panel)
    {
        var collapsedTabs = Math.Max(0, InternalChildren.Count - 1) * TabWidth;
        return new Size(Math.Max(0, panel.Width - collapsedTabs + Overlap), panel.Height);
    }

    private static void OnSelectedIndexChanged(DependencyObject d, DependencyPropertyChangedEventArgs e) =>
        ((BladeStackPanel)d).UpdatePositions(animate: true);

    private void UpdatePositions(bool animate)
    {
        var count = InternalChildren.Count;
        if (count == 0 || _arrangedSize.Width <= 0) return;

        var selected = Math.Clamp(SelectedIndex, 0, count - 1);
        for (var i = 0; i < count; i++)
        {
            var child = InternalChildren[i];
            var target = i <= selected
                ? i * TabWidth
                : _arrangedSize.Width - (count - i) * TabWidth;

            var transform = EnsureTransform(child);
            if (animate)
            {
                var slide = new DoubleAnimation(target, SlideDuration) { EasingFunction = _ease };
                slide.Freeze();
                transform.BeginAnimation(TranslateTransform.XProperty, slide, HandoffBehavior.SnapshotAndReplace);
            }
            else
            {
                transform.BeginAnimation(TranslateTransform.XProperty, null);
                transform.X = target;
            }

            if (child is Blade blade) blade.IsActive = i == selected;
        }
    }

    private static TranslateTransform EnsureTransform(UIElement child)
    {
        if (child.RenderTransform is TranslateTransform existing && !existing.IsFrozen) return existing;
        var transform = new TranslateTransform();
        child.RenderTransform = transform;
        return transform;
    }
}
