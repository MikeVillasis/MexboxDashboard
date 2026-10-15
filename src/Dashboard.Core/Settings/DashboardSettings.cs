using System.Text.Json.Serialization;

namespace Dashboard.Core.Settings;

/// <summary>User preferences persisted to %AppData%\Xbox360Launcher\settings.json. Immutable; update with <c>with</c>.</summary>
public sealed record DashboardSettings
{
    public static DashboardSettings Default { get; } = new();

    public bool SoundEnabled { get; init; } = true;

    public bool Fullscreen { get; init; } = true;

    /// <summary>Last windowed-mode bounds in device-independent pixels; null until the user has used windowed mode.</summary>
    public WindowBounds? WindowBounds { get; init; }

    /// <summary>The game that had focus when the dashboard closed, restored on the next start.</summary>
    public string? LastGameId { get; init; }
}

public sealed record WindowBounds(double Left, double Top, double Width, double Height, bool Maximized);

[JsonSourceGenerationOptions(WriteIndented = true, PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DashboardSettings))]
internal sealed partial class SettingsJsonContext : JsonSerializerContext;
