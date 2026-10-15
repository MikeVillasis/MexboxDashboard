using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace Dashboard.App.Animation;

/// <summary>
/// Focus-change flourish: the element settles in from slightly smaller and dimmer. Animates only a render transform and
/// opacity, so it costs compositing, not layout. Restarting mid-flight continues from the current values.
/// </summary>
internal static class FocusPop
{
    private static readonly Duration Duration = new(TimeSpan.FromMilliseconds(260));
    private static readonly IEasingFunction Ease = Frozen(new CubicBezierEase(0.2, 0.8, 0.2, 1.0));

    public static void Play(UIElement target, double fromScale = 0.95, double fromOpacity = 0.35)
    {
        if (target.RenderTransform is not ScaleTransform scale || scale.IsFrozen)
        {
            scale = new ScaleTransform();
            target.RenderTransform = scale;
            target.RenderTransformOrigin = new Point(0.5, 0.5);
        }

        var grow = new DoubleAnimation(fromScale, 1.0, Duration) { EasingFunction = Ease };
        grow.Freeze();
        var fade = new DoubleAnimation(fromOpacity, 1.0, Duration) { EasingFunction = Ease };
        fade.Freeze();

        scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow, HandoffBehavior.SnapshotAndReplace);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow, HandoffBehavior.SnapshotAndReplace);
        target.BeginAnimation(UIElement.OpacityProperty, fade, HandoffBehavior.SnapshotAndReplace);
    }

    private static IEasingFunction Frozen(CubicBezierEase ease)
    {
        ease.Freeze();
        return ease;
    }
}
