using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Threading;
using Dashboard.Core.Infrastructure;
using Microsoft.Web.WebView2.Core;

namespace Dashboard.App.Web;

/// <summary>
/// The single C# → JS channel. Every message is an envelope <c>{ "type": "...", "payload": {...} }</c> sent with
/// <see cref="CoreWebView2.PostWebMessageAsJson"/>; the page receives it on <c>window.chrome.webview</c>'s "message" event.
/// Safe to call from any thread (it marshals to the WebView's dispatcher); messages sent before the page is ready are dropped.
/// Also routes JS → C# envelopes (posted with <c>chrome.webview.postMessage</c>) to registered handlers.
/// </summary>
public sealed class WebMessageDispatcher
{
    private readonly Dispatcher _dispatcher;
    private readonly Dictionary<string, Action<JsonNode?>> _handlers = new(StringComparer.Ordinal);
    private CoreWebView2? _core;

    public WebMessageDispatcher(Dispatcher dispatcher) => _dispatcher = dispatcher;

    public void Attach(CoreWebView2 core)
    {
        _core = core;
        core.WebMessageReceived += OnWebMessageReceived;
    }

    /// <summary>Registers the handler for a JS → C# message type. Handlers run on the UI thread.</summary>
    public void On(string type, Action<JsonNode?> handler) => _handlers[type] = handler;

    public void Post(string type, JsonNode? payload = null)
    {
        var envelope = new JsonObject { ["type"] = type, ["payload"] = payload };
        var json = envelope.ToJsonString();

        if (_dispatcher.CheckAccess()) Send(json);
        else _dispatcher.InvokeAsync(() => Send(json));
    }

    private void Send(string json)
    {
        try
        {
            _core?.PostWebMessageAsJson(json);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            // The page is navigating or the WebView is closing; UI events are fire-and-forget.
            Log.Warn("Web: could not post message", ex);
        }
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only trust our own origin; anything else (e.g. a page navigated away by a bad link) is ignored.
        if (!e.Source.StartsWith(WebShellWindow.Origin, StringComparison.OrdinalIgnoreCase)) return;

        JsonNode? message;
        try
        {
            message = JsonNode.Parse(e.WebMessageAsJson);
        }
        catch (JsonException ex)
        {
            Log.Warn("Web: malformed message from page", ex);
            return;
        }

        var type = message?["type"]?.GetValue<string>();
        if (type is null || !_handlers.TryGetValue(type, out var handler))
        {
            Log.Warn($"Web: unhandled message type '{type}'");
            return;
        }

        try
        {
            handler(message?["payload"]);
        }
        catch (Exception ex)
        {
            Log.Error($"Web: handler for '{type}' failed", ex);
        }
    }
}
