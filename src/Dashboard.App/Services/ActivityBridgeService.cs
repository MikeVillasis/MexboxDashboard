using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Dashboard.Core.Infrastructure;

namespace Dashboard.App.Services;

/// <summary>Who this PC is linked to in the Discord Activity.</summary>
public sealed record ActivityLink(string Server, string DeviceId, string Name, string DisplayName);

/// <summary>Outcome of a link attempt, with copy ready for the UI.</summary>
public sealed record ActivityLinkResult(bool Success, string Message);

/// <summary>
/// Links this Windows dashboard to the owner's Discord identity in the Activity (ticket 06). Opt-in: until a code is
/// redeemed there is no file and no network traffic at all; the rest of the app behaves exactly as before.
/// <para>
/// The device token is a bearer secret: it lives only in memory and in %AppData%\Xbox360Launcher\activity-device.json,
/// encrypted with DPAPI for the current Windows user. All network and disk work runs on the thread pool; <see cref="Changed"/>
/// is raised on a worker thread.
/// </para>
/// </summary>
public sealed class ActivityBridgeService
{
    public const string DefaultServer = "https://mexbox-activity.miguelvillasism.workers.dev";

    private static readonly Regex CodeFormat = new("^[A-HJ-NP-Z2-9]{6}$", RegexOptions.Compiled);
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Xbox360Launcher.ActivityDevice.v1");
    private static readonly HttpClient Http = CreateClient();

    private readonly string _path;
    private readonly string _server;
    private readonly object _gate = new();
    private ActivityLink? _link;
    private string? _token;

    /// <param name="server">The Activity's Worker; links remember the server they were made on.</param>
    public ActivityBridgeService(string path, string? server = null)
    {
        _path = path;
        _server = (server ?? DefaultServer).TrimEnd('/');
    }

    public event EventHandler? Changed;

    public ActivityLink? Link
    {
        get { lock (_gate) return _link; }
    }

    /// <summary>
    /// Reads the saved link (if any) and, only if there is one, checks it with the server in the background: a link the
    /// owner removed from the Activity is forgotten here too. Offline is fine; the link is kept.
    /// </summary>
    public async Task LoadAsync()
    {
        var saved = await Task.Run(ReadFile).ConfigureAwait(false);
        if (saved is null) return;
        lock (_gate)
        {
            _link = saved.Value.Link;
            _token = saved.Value.Token;
        }
        Changed?.Invoke(this, EventArgs.Empty);
        await VerifyAsync().ConfigureAwait(false);
    }

    /// <summary>Trades a code from the Activity's "link my pc" for a device token.</summary>
    public async Task<ActivityLinkResult> LinkAsync(string code)
    {
        code = (code ?? string.Empty).Trim().ToUpperInvariant();
        if (!CodeFormat.IsMatch(code)) return new(false, "codes are 6 letters and digits (no 0, 1, i or o)");

        try
        {
            var name = Environment.MachineName.ToLowerInvariant();
            using var response = await Http.PostAsJsonAsync($"{_server}/api/pair/redeem", new { code, name }).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.Created) return new(false, ErrorMessage(await ErrorCodeAsync(response).ConfigureAwait(false)));

            var body = JsonNode.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
            var token = body?["token"]?.GetValue<string>();
            var deviceId = body?["deviceId"]?.GetValue<string>();
            if (token is null || deviceId is null) return new(false, "the activity server sent an unexpected reply");

            var link = new ActivityLink(_server, deviceId, body?["name"]?.GetValue<string>() ?? name, body?["displayName"]?.GetValue<string>() ?? "you");
            await Task.Run(() => WriteFile(link, token)).ConfigureAwait(false);
            lock (_gate)
            {
                _link = link;
                _token = token;
            }
            Log.Info($"Activity: linked as device {deviceId} for {link.DisplayName}");
            Changed?.Invoke(this, EventArgs.Empty);
            return new(true, $"linked to {link.DisplayName}");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or IOException or CryptographicException)
        {
            Log.Warn("Activity: link failed", ex);
            return new(false, "couldn't reach the activity server. check your connection and try again");
        }
    }

    /// <summary>Unlinks from this side: tells the server (best effort) and forgets the token either way.</summary>
    public async Task UnlinkAsync()
    {
        ActivityLink? link;
        string? token;
        lock (_gate)
        {
            link = _link;
            token = _token;
            _link = null;
            _token = null;
        }
        if (link is not null && token is not null)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Delete, $"{link.Server}/api/device");
                request.Headers.Authorization = new("Bearer", token);
                using var _ = await Http.SendAsync(request).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            {
                Log.Warn("Activity: couldn't tell the server about the unlink (it can be removed from the activity too)", ex);
            }
        }
        await Task.Run(DeleteFile).ConfigureAwait(false);
        Log.Info("Activity: unlinked");
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private async Task VerifyAsync()
    {
        ActivityLink? link;
        string? token;
        lock (_gate)
        {
            link = _link;
            token = _token;
        }
        if (link is null || token is null) return;

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{link.Server}/api/device");
            request.Headers.Authorization = new("Bearer", token);
            using var response = await Http.SendAsync(request).ConfigureAwait(false);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                Log.Info("Activity: this pc was unlinked from the activity; forgetting the link");
                lock (_gate)
                {
                    _link = null;
                    _token = null;
                }
                await Task.Run(DeleteFile).ConfigureAwait(false);
                Changed?.Invoke(this, EventArgs.Empty);
                return;
            }
            if (!response.IsSuccessStatusCode) return;

            // Pick up a renamed Discord display name.
            var name = JsonNode.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false))?["displayName"]?.GetValue<string>();
            if (name is not null && name != link.DisplayName)
            {
                link = link with { DisplayName = name };
                await Task.Run(() => WriteFile(link, token)).ConfigureAwait(false);
                lock (_gate) _link = link;
                Changed?.Invoke(this, EventArgs.Empty);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or IOException or CryptographicException)
        {
            Log.Warn("Activity: couldn't check the link (offline?); keeping it", ex);
        }
    }

    private static async Task<string?> ErrorCodeAsync(HttpResponseMessage response)
    {
        try { return JsonNode.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false))?["error"]?.GetValue<string>(); }
        catch (JsonException) { return null; }
    }

    private static string ErrorMessage(string? code) => code switch
    {
        "invalid_code" => "that code didn't work (they expire after 10 minutes). get a new one in the activity",
        "bad_code" => "codes are 6 letters and digits (no 0, 1, i or o)",
        "rate_limited" => "too many tries. wait a minute and try again",
        "too_many_devices" => "you've linked 5 pcs already. unlink one in the activity first",
        "guild_not_allowed" => "that discord server isn't set up for the activity",
        _ => $"the activity server said no ({code ?? "unknown error"})",
    };

    // ───────────── Storage (DPAPI, current user) ─────────────

    private (ActivityLink Link, string Token)? ReadFile()
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var node = JsonNode.Parse(File.ReadAllText(_path));
            var server = node?["server"]?.GetValue<string>();
            var deviceId = node?["deviceId"]?.GetValue<string>();
            var protectedToken = node?["token"]?.GetValue<string>();
            if (server is null || deviceId is null || protectedToken is null) return null;

            var token = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(protectedToken), Entropy, DataProtectionScope.CurrentUser));
            return (new ActivityLink(server, deviceId, node?["name"]?.GetValue<string>() ?? "this pc", node?["displayName"]?.GetValue<string>() ?? "you"), token);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or FormatException or CryptographicException or InvalidOperationException)
        {
            // Unreadable, or copied from another Windows account (DPAPI won't decrypt it): treat as not linked.
            Log.Warn($"Activity: ignoring unreadable {_path}", ex);
            return null;
        }
    }

    private void WriteFile(ActivityLink link, string token)
    {
        var protectedToken = Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token), Entropy, DataProtectionScope.CurrentUser));
        var json = new JsonObject
        {
            ["server"] = link.Server,
            ["deviceId"] = link.DeviceId,
            ["name"] = link.Name,
            ["displayName"] = link.DisplayName,
            ["token"] = protectedToken,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        var temp = _path + ".tmp";
        File.WriteAllText(temp, json);
        File.Move(temp, _path, overwrite: true);
    }

    private void DeleteFile()
    {
        try { File.Delete(_path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Log.Warn($"Activity: couldn't delete {_path}", ex); }
    }

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd($"Xbox360Dashboard/{typeof(ActivityBridgeService).Assembly.GetName().Version}");
        return client;
    }
}
