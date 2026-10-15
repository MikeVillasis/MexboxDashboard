// Thin wrapper over the WebView2 interop surface. The page never talks to window.chrome.webview directly.
//
//   Xbox.backend      -> C# XboxHostBridge (AddHostObjectToScript "xboxBackend"); every call returns a Promise.
//   Xbox.on(type, fn) -> C# → JS envelopes { type, payload } sent with PostWebMessageAsJson.
//   Xbox.send(type, payload) -> JS → C# envelopes, routed by WebMessageDispatcher.
(function () {
  "use strict";

  const webview = window.chrome && window.chrome.webview;
  const handlers = new Map();

  if (webview) {
    // Uncaught page errors (including failed module imports) land in dashboard.log, not just DevTools.
    const report = (message, where) => webview.postMessage({ type: "JS_ERROR", payload: { message: String(message), where: String(where || "") } });
    window.addEventListener("error", (e) => report(e.message, `${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => report(e.reason && (e.reason.stack || e.reason), "promise"));

    webview.addEventListener("message", (event) => {
      const { type, payload } = event.data || {};
      const list = handlers.get(type);
      if (!list) return;
      for (const fn of list) {
        try { fn(payload); } catch (err) { console.error(`handler for ${type} failed`, err); }
      }
    });
  }

  window.Xbox = Object.freeze({
    isHosted: Boolean(webview),

    backend: webview ? webview.hostObjects.xboxBackend : null,

    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },

    send(type, payload = null) {
      if (webview) webview.postMessage({ type, payload });
    },
  });
})();
