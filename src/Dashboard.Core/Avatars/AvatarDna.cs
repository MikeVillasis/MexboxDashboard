using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Dashboard.Core.Avatars;

/// <summary>
/// An avatar "DNA recipe": the complete, compact description the renderer assembles an avatar from.
/// Serialised it stays well under 250 bytes, so it travels cheaply (local profile file now, P2P sync in phase 5).
/// Part ids index the renderer's part catalogue; unknown ids fall back to part 0 on the JS side.
/// </summary>
public sealed record AvatarDna
{
    public const int SchemaVersion = 1;
    public const int MaxPartId = 15;
    public const int MaxNameLength = 15; // Xbox gamertags are 15 characters

    public int V { get; init; } = SchemaVersion;
    public required string Id { get; init; }
    public required string Name { get; init; }
    public string SkinColor { get; init; } = "#E0AC69";
    public int HeadId { get; init; }
    public int HairId { get; init; } = 1;
    public string HairColor { get; init; } = "#2C1B18";
    public int TorsoId { get; init; }
    public string ShirtColor { get; init; } = "#107C10";
    public int LegsId { get; init; }
    public string LegsColor { get; init; } = "#2B3A55";
    public int EyeUV { get; init; }
    public int MouthUV { get; init; }

    public static AvatarDna CreateDefault(string name) => new() { Id = "local", Name = Clip(name) };

    public string ToJson() => JsonSerializer.Serialize(this, AvatarJsonContext.Default.AvatarDna);

    /// <summary>
    /// Parses untrusted JSON (from the page now, from peers later) into a normalised recipe: colours must be #RRGGBB,
    /// ids are clamped to the catalogue range, strings are trimmed and length-limited. Returns null if it is not a recipe.
    /// </summary>
    public static AvatarDna? TryParse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json) || json.Length > 1024) return null;
        AvatarDna? raw;
        try
        {
            raw = JsonSerializer.Deserialize(json, AvatarJsonContext.Default.AvatarDna);
        }
        catch (JsonException)
        {
            return null;
        }
        if (raw is null || string.IsNullOrWhiteSpace(raw.Id) || string.IsNullOrWhiteSpace(raw.Name)) return null;

        var fallback = CreateDefault(raw.Name);
        return raw with
        {
            V = SchemaVersion,
            Id = raw.Id.Trim().Length > 64 ? raw.Id.Trim()[..64] : raw.Id.Trim(),
            Name = Clip(raw.Name),
            SkinColor = Color(raw.SkinColor, fallback.SkinColor),
            HairColor = Color(raw.HairColor, fallback.HairColor),
            ShirtColor = Color(raw.ShirtColor, fallback.ShirtColor),
            LegsColor = Color(raw.LegsColor, fallback.LegsColor),
            HeadId = Part(raw.HeadId),
            HairId = Part(raw.HairId),
            TorsoId = Part(raw.TorsoId),
            LegsId = Part(raw.LegsId),
            EyeUV = Part(raw.EyeUV),
            MouthUV = Part(raw.MouthUV),
        };
    }

    private static readonly Regex HexColor = new("^#[0-9A-Fa-f]{6}$", RegexOptions.Compiled);

    private static string Color(string? value, string fallback) =>
        value is not null && HexColor.IsMatch(value) ? value.ToUpperInvariant() : fallback;

    private static int Part(int id) => Math.Clamp(id, 0, MaxPartId);

    private static string Clip(string name)
    {
        var trimmed = name.Trim();
        return trimmed.Length > MaxNameLength ? trimmed[..MaxNameLength] : trimmed;
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(AvatarDna))]
internal sealed partial class AvatarJsonContext : JsonSerializerContext;
