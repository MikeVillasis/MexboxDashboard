using System.Windows;
using System.Windows.Media.Animation;

namespace Dashboard.App.Animation;

/// <summary>CSS-style cubic-bezier(x1, y1, x2, y2) easing for WPF animations.</summary>
public sealed class CubicBezierEase : EasingFunctionBase
{
    public static readonly DependencyProperty X1Property = DependencyProperty.Register(nameof(X1), typeof(double), typeof(CubicBezierEase), new PropertyMetadata(0.25));
    public static readonly DependencyProperty Y1Property = DependencyProperty.Register(nameof(Y1), typeof(double), typeof(CubicBezierEase), new PropertyMetadata(0.1));
    public static readonly DependencyProperty X2Property = DependencyProperty.Register(nameof(X2), typeof(double), typeof(CubicBezierEase), new PropertyMetadata(0.25));
    public static readonly DependencyProperty Y2Property = DependencyProperty.Register(nameof(Y2), typeof(double), typeof(CubicBezierEase), new PropertyMetadata(1.0));

    public CubicBezierEase()
    {
        EasingMode = EasingMode.EaseIn;
    }

    public CubicBezierEase(double x1, double y1, double x2, double y2) : this()
    {
        X1 = x1;
        Y1 = y1;
        X2 = x2;
        Y2 = y2;
    }

    public double X1 { get => (double)GetValue(X1Property); set => SetValue(X1Property, value); }
    public double Y1 { get => (double)GetValue(Y1Property); set => SetValue(Y1Property, value); }
    public double X2 { get => (double)GetValue(X2Property); set => SetValue(X2Property, value); }
    public double Y2 { get => (double)GetValue(Y2Property); set => SetValue(Y2Property, value); }

    protected override double EaseInCore(double normalizedTime)
    {
        if (normalizedTime <= 0) return 0;
        if (normalizedTime >= 1) return 1;

        double x1 = X1, y1 = Y1, x2 = X2, y2 = Y2;

        // Solve bezierX(s) = t for s with Newton-Raphson, falling back to bisection.
        var s = normalizedTime;
        for (var i = 0; i < 6; i++)
        {
            var x = Bezier(s, x1, x2) - normalizedTime;
            var dx = BezierDerivative(s, x1, x2);
            if (Math.Abs(x) < 1e-5) return Bezier(s, y1, y2);
            if (Math.Abs(dx) < 1e-6) break;
            s -= x / dx;
        }

        double lo = 0, hi = 1;
        s = normalizedTime;
        for (var i = 0; i < 20; i++)
        {
            var x = Bezier(s, x1, x2);
            if (Math.Abs(x - normalizedTime) < 1e-5) break;
            if (x < normalizedTime) lo = s; else hi = s;
            s = (lo + hi) / 2;
        }
        return Bezier(s, y1, y2);
    }

    protected override Freezable CreateInstanceCore() => new CubicBezierEase();

    private static double Bezier(double t, double p1, double p2)
    {
        var u = 1 - t;
        return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
    }

    private static double BezierDerivative(double t, double p1, double p2)
    {
        var u = 1 - t;
        return 3 * u * u * p1 + 6 * u * t * (p2 - p1) + 3 * t * t * (1 - p2);
    }
}
