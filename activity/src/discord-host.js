// Discord Activity host for the shared WebAssets front end (see js/bridge.js for the adapter contract).
// Bundled as a classic script and loaded before bridge.js: the adapter has to exist synchronously, so backend calls
// wait on the sign-in promise instead.
//
// Sign-in: SDK ready → authorize (code) → Worker /api/token (secret stays server-side, guild allowlist enforced there)
// → authenticate. Phase 03 keeps the avatar for the session only; phase 04 stores it and adds the shared room.

import { DiscordSDK, RPCCloseCodes } from "@discord/embedded-app-sdk";
import { clientIdFromHost, defaultDna, friendCode, gamertag, SIGN_IN_ERRORS } from "./identity.js";

const SCOPES = ["identify", "guilds.members.read"];
const API = "/.proxy/api"; // Discord's documented proxy prefix; the Worker accepts it with or without.
const BLADES = ["friends", "avatar"];

const listeners = [];
const emit = (type, payload = null) => setTimeout(() => listeners.forEach((fn) => fn({ type, payload })), 0);
const loaded = new Promise((resolve) => (document.readyState === "complete" ? resolve() : window.addEventListener("load", resolve, { once: true })));

class SignInError extends Error {}

const session = signIn();
session.catch((err) => showBlocker(err instanceof SignInError ? err.message : "couldn't start the plaza, close the activity and try again", err));

async function signIn() {
  const clientId = clientIdFromHost(location.hostname);
  if (!clientId || !new URLSearchParams(location.search).has("frame_id")) {
    throw new SignInError("open the plaza from discord: start the activity in a voice channel");
  }
  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({ client_id: clientId, response_type: "code", state: "", prompt: "none", scope: SCOPES });
  const response = await fetch(`${API}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, guildId: sdk.guildId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SignInError(SIGN_IN_ERRORS[body.error] ?? `couldn't sign in (${body.error ?? response.status})`);
  await sdk.commands.authenticate({ access_token: body.access_token });

  return { sdk, member: body.member, dna: defaultDna(body.member.discordId, body.member.displayName) };
}

/** Every backend call waits for sign-in; failures surface on the blocker screen, not as page errors. */
const call = (fn) => (...args) => session.then((s) => fn(s, ...args));

const friends = new Map(); // code → recipe, session only until phase 04

const backend = {
  GetVersion: call(() => "activity"),
  GetLibraryJson: call(() => "[]"),
  GetSettingsJson: call(() => JSON.stringify({ soundEnabled: sound.enabled, lastGameId: null })),
  GetProfileJson: call((s) => JSON.stringify({ gamertag: s.dna.name, games: 0, launches: 0, lastPlayed: null })),
  FocusGame: call(() => {}),
  LaunchGame: call(() => false),
  Rescan: call(() => {}),

  GetAvatarDnaJson: call((s) => JSON.stringify(s.dna)),
  // Shape-checked here for the session; phase 04 moves validation and storage to the server.
  SaveAvatarDnaJson: call((s, json) => {
    let next;
    try { next = JSON.parse(json); } catch { return ""; }
    if (!next || typeof next !== "object" || json.length > 1024) return "";
    s.dna = { ...s.dna, ...next, v: 1, id: "local", name: gamertag(next.name ?? s.dna.name) };
    return JSON.stringify(s.dna);
  }),
  InspectAvatar: call((s, json) => {
    const dna = JSON.parse(json);
    const local = dna.id === "local";
    emit("OPEN_GAMERCARD", { card: { gamertag: dna.name, color: dna.shirtColor, local,
      stats: local ? { status: "in the plaza", "signed in as": s.member.displayName } : { status: "plaza resident", zone: "this server" } } });
    return true;
  }),

  GetFriendCode: call((s) => friendCode(s.member.discordId)),
  GetFriendsJson: call(() => JSON.stringify([...friends].map(([code, dna]) => ({ code, lastSeen: new Date().toISOString(), dna })))),
  RememberFriend: call((s, code, json) => { const dna = { ...JSON.parse(json), id: `friend_${code}` }; friends.set(code, dna); return JSON.stringify(dna); }),
  ForgetFriend: call((s, code) => friends.delete(code)),

  PlaySound: call((s, cue) => sound.play(cue)),
  ToggleSound: call(() => (sound.enabled = !sound.enabled)),
  ToggleFullscreen: call(() => {}),
  Exit: call((s) => s.sdk.close(RPCCloseCodes.CLOSE_NORMAL, "exit")),
  LogCanvasClick: call(() => {}),
  MediaPlayPause: call(() => {}),
  MediaNext: call(() => {}),
  MediaPrevious: call(() => {}),
};

/** The Windows app plays these through C#; here they are the same WAVs through the page. */
const sound = {
  enabled: true,
  cache: new Map(),
  play(cue) {
    if (!this.enabled || !/^[A-Za-z]+$/.test(cue)) return false;
    const file = cue.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    let audio = this.cache.get(file);
    if (!audio) { audio = new Audio(`sounds/${file}.wav`); audio.volume = 0.6; this.cache.set(file, audio); }
    audio.currentTime = 0;
    audio.play().catch(() => {}); // blocked until the first user gesture; harmless
    return true;
  },
};

// The Windows host maps KEY → controller commands in C#; the Activity does the same mapping here.
const KEYS = {
  ArrowLeft: ["SWITCH_BLADE", { delta: -1 }], ArrowRight: ["SWITCH_BLADE", { delta: 1 }],
  PageUp: ["SWITCH_BLADE", { delta: -1 }], PageDown: ["SWITCH_BLADE", { delta: 1 }],
  ArrowUp: ["NAVIGATE_DPAD", { direction: "up" }], ArrowDown: ["NAVIGATE_DPAD", { direction: "down" }],
  Enter: ["SELECT_ITEM", null], " ": ["SELECT_ITEM", null], Escape: ["BACK", null], Backspace: ["BACK", null],
};

window.XboxHostAdapter = {
  name: "discord",
  blades: BLADES,
  backend,
  post({ type, payload }) {
    if (type === "KEY" && KEYS[payload?.key]) emit(...KEYS[payload.key]);
    else if (type === "JS_ERROR") console.error("page error", payload);
  },
  listen(fn) {
    listeners.push(fn);
    // Like WebView2's NavigationCompleted: HOST_READY once the modules have subscribed and sign-in is done.
    if (listeners.length === 1) {
      Promise.all([loaded, session]).then(() => emit("HOST_READY", {
        soundEnabled: sound.enabled, media: null, version: "activity", connectTo: null, startBlade: "friends", plazaSelfTest: false,
      }), () => {});
    }
  },
};

function showBlocker(message, err) {
  if (err && !(err instanceof SignInError)) console.error("activity sign-in failed", err);
  loaded.then(() => {
    const el = document.createElement("div");
    el.id = "activity-blocker";
    el.setAttribute("role", "alert");
    el.textContent = message;
    document.body.append(el);
  });
}
