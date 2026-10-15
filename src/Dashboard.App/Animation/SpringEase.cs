using System.Windows;
using System.Windows.Media.Animation;

namespace Dashboard.App.Animation;

/// <summary>
/// Damped-spring ease: fast departure, a small overshoot, then settle. Gives blades their physical "thunk".
/// f(t) = 1 − e^(−Damping·t)·cos(Frequency·t), normalised so f(1) = 1 exactly.
/// </summary>
public sealed class SpringEase : EasingFunctionBase
{
    public static readonly DependencyProperty DampingProperty = DependencyProperty.Register(
        nameof(Damping), typeof(double), typeof(SpringEase), new PropertyMetadata(8.5));

    public static readonly DependencyProperty FrequencyProperty = DependencyProperty.Register(
        nameof(Frequency), typeof(double), typeof(SpringEase), new PropertyMetadata(8.0));

    public SpringEase()
    {
        // EaseInCore below already describes the complete curve; don't let the base class mirror it.
        EasingMode = EasingMode.EaseIn;
    }

    public double Damping
    {
        get => (double)GetValue(DampingProperty);
        set => SetValue(DampingProperty, value);
    }

    public double Frequency
    {
        get => (double)GetValue(FrequencyProperty);
        set => SetValue(FrequencyProperty, value);
    }

    protected override double EaseInCore(double normalizedTime)
    {
        if (normalizedTime <= 0) return 0;
        if (normalizedTime >= 1) return 1;

        var damping = Damping;
        var frequency = Frequency;
        var value = 1 - Math.Exp(-damping * normalizedTime) * Math.Cos(frequency * normalizedTime);
        var end = 1 - Math.Exp(-damping) * Math.Cos(frequency);
        return value / end;
    }

    protected override Freezable CreateInstanceCore() => new SpringEase();
}
