// Host-neutral wrapper over whatever embeds the page. The page never talks to a host API directly.
//
//   Xbox.backend      -> host calls (see BACKEND CONTRACT below); every call returns a Promise.
//   Xbox.on(type, fn) -> host → JS envelopes { type, payload }.
//   Xbox.send(type, payload) -> JS → host envelopes.
//
// Hosts:
//   webview2  the Windows app: C# XboxHostBridge (AddHostObjectToScript "xboxBackend"), envelopes via
//             PostWebMessageAsJson / WebMessageDispatcher. Picked automatically when window.chrome.webview exists.
//   adapter   any other host (Discord Activity, browser stub) sets window.XboxHostAdapter before this script runs:
//             { name, backend, post(envelope), listen(fn(envelope)), blades? }
//             blades: names of the blades this host supports (omitted = all of them).
//
// BACKEND CONTRACT (method names match C# XboxHostBridge; a host may leave out what it can't do, callers use ?.):
//   GetVersion GetLibraryJson GetSettingsJson GetProfileJson FocusGame(id) LaunchGame(id) Rescan
//   GetAvatarDnaJson SaveAvatarDnaJson(json) InspectAvatar(dnaJson)
//   GetFriendCode GetFriendsJson RememberFriend(code, dnaJson) ForgetFriend(code)
//   PlaySound(cue) ToggleSound ToggleFullscreen Exit LogCanvasClick(x, z)
//   MediaPlayPause MediaNext MediaPrevious
(function () {
  "use strict";

  function webview2() {
    const webview = window.chrome && window.chrome.webview;
    if (!webview) return null;
    return {
      name: "webview2",
      backend: webview.hostObjects.xboxBackend,
      post: (envelope) => webview.postMessage(envelope),
      listen: (fn) => webview.addEventListener("message", (event) => fn(event.data)),
    };
  }

  const host = webview2() || window.XboxHostAdapter || null;
  const handlers = new Map();

  if (host) {
    // Uncaught page errors (including failed module imports) reach the host log, not just DevTools.
    const report = (message, where) => host.post({ type: "JS_ERROR", payload: { message: String(message), where: String(where || "") } });
    window.addEventListener("error", (e) => report(e.message, `${e.filename}:${e.lineno}`));
    window.addEventListener("unhandledrejection", (e) => report(e.reason && (e.reason.stack || e.reason), "promise"));

    host.listen((data) => {
      const { type, payload } = data || {};
      const list = handlers.get(type);
      if (!list) return;
      for (const fn of list) {
        try { fn(payload); } catch (err) { console.error(`handler for ${type} failed`, err); }
      }
    });
  }

  window.Xbox = Object.freeze({
    isHosted: Boolean(host),
    host: host ? host.name : null,
    blades: (host && host.blades) || null,

    backend: host ? host.backend : null,

    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },

    send(type, payload = null) {
      if (host) host.post({ type, payload });
    },
  });
})();
