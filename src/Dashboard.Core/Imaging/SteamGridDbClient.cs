using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Dashboard.Core.Models;

namespace Dashboard.Core.Imaging;

/// <summary>
/// Optional SteamGridDB v2 lookup for portrait grids (600x900 family). Enabled only when the user supplies an API key
/// (STEAMGRIDDB_API_KEY or %AppData%\Xbox360Launcher\steamgriddb.key); without one the pipeline never touches the network for it.
/// </summary>
internal sealed class SteamGridDbClient
{
    private const string BaseUrl = "https://www.steamgriddb.com/api/v2/";
    private const string GridQuery = "?dimensions=600x900,342x482,660x930&types=static&nsfw=false&humor=false";

    private readonly HttpClient _http;
    private readonly string _apiKey;

    public SteamGridDbClient(HttpClient http, string apiKey)
    {
        _http = http;
        _apiKey = apiKey;
    }

    public static string? LoadApiKey(string keyFile)
    {
        var fromEnv = Environment.GetEnvironmentVariable("STEAMGRIDDB_API_KEY");
        if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv.Trim();
        try
        {
            return File.Exists(keyFile) && File.ReadAllText(keyFile).Trim() is { Length: > 0 } key ? key : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Returns the best grid image URL, or null when SteamGridDB has no portrait art for the game.</summary>
    public async Task<string?> FindGridUrlAsync(GameEntry game, CancellationToken ct)
    {
        if (game.Metadata.TryGetValue(GameMetadataKeys.SteamAppId, out var appId))
        {
            var bySteamId = await GetFirstUrlAsync($"grids/steam/{Uri.EscapeDataString(appId)}{GridQuery}", ct).ConfigureAwait(false);
            if (bySteamId is not null) return bySteamId;
        }

        using var search = await GetJsonAsync($"search/autocomplete/{Uri.EscapeDataString(game.Title)}", ct).ConfigureAwait(false);
        if (search is null || !TryGetData(search.RootElement, out var results)) return null;

        foreach (var result in results.EnumerateArray())
        {
            if (!result.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.Number) continue;
            return await GetFirstUrlAsync($"grids/game/{id.GetInt64()}{GridQuery}", ct).ConfigureAwait(false);
        }
        return null;
    }

    private async Task<string?> GetFirstUrlAsync(string path, CancellationToken ct)
    {
        using var doc = await GetJsonAsync(path, ct).ConfigureAwait(false);
        if (doc is null || !TryGetData(doc.RootElement, out var grids)) return null;

        foreach (var grid in grids.EnumerateArray())
        {
            if (grid.TryGetProperty("url", out var url) && url.GetString() is { Length: > 0 } value) return value;
        }
        return null;
    }

    /// <summary>Null for 404 (unknown game); throws for other failures so the caller can retry next session.</summary>
    private async Task<JsonDocument?> GetJsonAsync(string path, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, BaseUrl + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();

        await using var body = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(body, cancellationToken: ct).ConfigureAwait(false);
    }

    private static bool TryGetData(JsonElement root, out JsonElement data) =>
        root.TryGetProperty("data", out data) && data.ValueKind == JsonValueKind.Array;
}
