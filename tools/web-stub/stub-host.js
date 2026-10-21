// Browser stub host for developing WebAssets without Windows/WebView2 (served by serve.py, never shipped).
// Implements the bridge.js BACKEND CONTRACT in memory with fake data; every call returns a Promise like WebView2.
(function () {
  "use strict";

  const listeners = [];
  const emit = (type, payload) => setTimeout(() => listeners.forEach((fn) => fn({ type, payload })), 0);
  const log = (...args) => console.info("[stub]", ...args);

  const params = new URLSearchParams(location.search);
  const friendCode = (params.get("code") || "STUB22").toUpperCase();
  let dna = { v: 1, id: "local", name: params.get("name") || "StubPlayer", skinColor: "#E0AC69", headId: 0, hairId: 1, hairColor: "#4A2C1A",
              torsoId: 1, shirtColor: "#107C10", legsId: 0, legsColor: "#2B2B2B", eyeUV: 0, mouthUV: 0 };
  let soundEnabled = true;
  let lastGameId = "stub-halo";
  const games = [
    { id: "stub-halo", title: "Halo Infinite", platform: "xbox", cover: null, lastPlayed: new Date(Date.now() - 3600e3).toISOString(), playCount: 12 },
    { id: "stub-portal", title: "Portal 2", platform: "steam", cover: null, lastPlayed: null, playCount: 0 },
    { id: "stub-rocket", title: "Rocket League", platform: "epic", cover: null, lastPlayed: new Date(Date.now() - 86400e3 * 3).toISOString(), playCount: 40 },
  ];
  const friends = new Map(); // code → dna

  const call = (fn) => (...args) => Promise.resolve().then(() => fn(...args));
  const backend = {
    GetVersion: call(() => "0.0.0-stub"),
    GetLibraryJson: call(() => JSON.stringify(games)),
    GetSettingsJson: call(() => JSON.stringify({ soundEnabled, lastGameId })),
    GetProfileJson: call(() => JSON.stringify({ gamertag: dna.name, games: games.length, launches: 52, lastPlayed: games[0].title })),
    FocusGame: call((id) => { lastGameId = id; }),
    LaunchGame: call((id) => { log("launch", id); return games.some((g) => g.id === id); }),
    Rescan: call(() => emit("LIBRARY_CHANGED")),
    GetAvatarDnaJson: call(() => JSON.stringify(dna)),
    SaveAvatarDnaJson: call((json) => { dna = { ...JSON.parse(json), id: "local" }; return JSON.stringify(dna); }),
    InspectAvatar: call((json) => {
      const d = JSON.parse(json);
      emit("OPEN_GAMERCARD", { card: { gamertag: d.name, color: d.shirtColor, local: d.id === "local",
        stats: d.id === "local" ? { games: games.length, launches: 52, "last played": games[0].title } : { status: "plaza resident", zone: "your plaza" } } });
      return true;
    }),
    GetFriendCode: call(() => friendCode),
    GetFriendsJson: call(() => JSON.stringify([...friends].map(([code, d]) => ({ code, lastSeen: new Date().toISOString(), dna: d })))),
    RememberFriend: call((code, json) => { const d = { ...JSON.parse(json), id: `friend_${code}` }; friends.set(code, d); return JSON.stringify(d); }),
    ForgetFriend: call((code) => friends.delete(code)),
    PlaySound: call((cue) => soundEnabled),
    ToggleSound: call(() => (soundEnabled = !soundEnabled)),
    ToggleFullscreen: call(() => log("toggle fullscreen")),
    Exit: call(() => log("exit")),
    LogCanvasClick: call((x, z) => log("floor click", x.toFixed(2), z.toFixed(2))),
    MediaPlayPause: call(() => log("media play/pause")),
    MediaNext: call(() => log("media next")),
    MediaPrevious: call(() => log("media previous")),
  };

  // Keys: the WebView2 host maps KEY → NAV commands in C#; the stub does the same minimal mapping.
  const KEYS = { ArrowLeft: ["SWITCH_BLADE", { delta: -1 }], ArrowRight: ["SWITCH_BLADE", { delta: 1 }],
                 ArrowUp: ["NAVIGATE_DPAD", { direction: "up" }], ArrowDown: ["NAVIGATE_DPAD", { direction: "down" }],
                 Enter: ["SELECT_ITEM", null], Escape: ["BACK", null] };

  window.XboxHostAdapter = {
    name: "stub",
    backend,
    post({ type, payload }) {
      if (type === "KEY" && KEYS[payload.key]) { emit(...KEYS[payload.key]); return; }
      if (type === "JS_ERROR") console.error("[stub] page error", payload);
      else log(type, payload);
    },
    listen(fn) {
      listeners.push(fn);
      // Like WebView2's NavigationCompleted: modules (main.js) have subscribed by the window load event.
      if (listeners.length === 1) window.addEventListener("load", () => {
        emit("HOST_READY", { soundEnabled, media: { app: "stub", title: "Still Alive", artist: "GLaDOS", album: "Portal", art: null, playing: true, canNext: true, canPrevious: true },
          version: "0.0.0-stub", connectTo: params.get("connect"), startBlade: params.get("blade"), plazaSelfTest: params.has("selftest") });
      });
    },
  };
})();
