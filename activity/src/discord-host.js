// Discord Activity host for the shared WebAssets front end (see js/bridge.js for the adapter contract).
// Bundled as a classic script and loaded before bridge.js: the adapter has to exist synchronously, so backend calls
// wait on the sign-in promise instead.
//
// Sign-in: SDK ready → authorize (code) → Worker /api/token (secret stays server-side, guild allowlist enforced there)
// → authenticate. The avatar is stored per Discord user by the Worker; the plaza is a shared room per Activity
// instance (RoomTransport); members who aren't in it nap in the plaza (away list from the Worker).

import { DiscordSDK, RPCCloseCodes } from "@discord/embedded-app-sdk";
import { clientIdFromHost, defaultDna, friendCode, SIGN_IN_ERRORS } from "./identity.js";
import { RoomTransport } from "./RoomTransport.js";

/* global DEV_SDK */ // true only in build.mjs --dev (fake SDK, any host); compiled away otherwise
const SCOPES = ["identify", "guilds.members.read"];
const API = "/.proxy/api"; // Discord's documented proxy prefix; the Worker accepts it with or without.
const BLADES = ["friends", "avatar"];

const listeners = [];
const emit = (type, payload = null) => setTimeout(() => listeners.forEach((fn) => fn({ type, payload })), 0);
const loaded = new Promise((resolve) => (document.readyState === "complete" ? resolve() : window.addEventListener("load", resolve, { once: true })));

class SignInError extends Error {}

const session = signIn();
let current = null; // the resolved session, for synchronous hooks (createTransport)
session.then((s) => { current = s; }, () => {});
session.catch((err) => showBlocker(err instanceof SignInError ? err.message : "couldn't start the plaza, close the activity and try again", err));

async function signIn() {
  const clientId = clientIdFromHost(location.hostname) ?? (DEV_SDK ? "000000000000000000" : null);
  if (!clientId || (!DEV_SDK && !new URLSearchParams(location.search).has("frame_id"))) {
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

  const s = { sdk, token: body.access_token, member: body.member, dna: null };
  // First visit: store the starter look, so this member naps in the plaza for others while away.
  const saved = await api(s, "/avatar");
  s.dna = saved.dna ?? (await api(s, "/avatar", { method: "PUT", body: { dna: defaultDna(s.member.discordId, s.member.displayName) } })).dna;
  return s;
}

/** Authenticated Worker call; errors become a SignInError message for the blocker or a rejected promise. */
async function api(s, path, { method = "GET", body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${s.token}`, "x-guild-id": s.sdk.guildId ?? "", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new SignInError(SIGN_IN_ERRORS[json.error] ?? `the plaza server said no (${json.error ?? response.status})`);
  return json;
}

/** Every backend call waits for sign-in; failures surface on the blocker screen, not as page errors. */
const call = (fn) => (...args) => session.then((s) => fn(s, ...args));

const friends = new Map(); // code → recipe as last rendered (the room and the away list are the sources)
const statuses = new Map(); // code → Discord presence for thought bubbles (from the room)
const STATUS_VERB = { playing: "playing", listening: "listening to", watching: "watching" };

const backend = {
  GetVersion: call(() => "activity"),
  GetLibraryJson: call(() => "[]"),
  GetSettingsJson: call(() => JSON.stringify({ soundEnabled: sound.enabled, lastGameId: null })),
  GetProfileJson: call(async (s) => JSON.stringify({
    gamertag: s.dna.name, games: 0, launches: 0, lastPlayed: null, picture: await pictureFor(s, friendCode(s.member.discordId)),
  })),
  FocusGame: call(() => {}),
  LaunchGame: call(() => false),
  Rescan: call(() => {}),

  GetAvatarDnaJson: call((s) => JSON.stringify(s.dna)),
  // The Worker validates and stores; the page renders whatever it accepted ("" = rejected, page reverts).
  SaveAvatarDnaJson: call(async (s, json) => {
    let dna;
    try { dna = JSON.parse(json); } catch { return ""; }
    try {
      s.dna = (await api(s, "/avatar", { method: "PUT", body: { dna } })).dna;
      return JSON.stringify(s.dna);
    } catch (err) {
      console.warn("avatar not saved", err.message);
      return "";
    }
  }),
  InspectAvatar: call(async (s, json) => {
    const dna = JSON.parse(json);
    const local = dna.id === "local";
    // Members have a friend code (yours, or friend_CODE); the plaza's resident NPCs don't, so they keep the silhouette.
    const code = local ? friendCode(s.member.discordId) : /^friend_([A-Z0-9]{6})$/.exec(dna.id ?? "")?.[1];
    emit("OPEN_GAMERCARD", { card: { gamertag: dna.name, color: dna.shirtColor, local,
      picture: code ? await pictureFor(s, code) : null,
      stats: {
        ...(local ? { status: "in the plaza", "signed in as": s.member.displayName } : { status: "plaza resident", zone: "this server" }),
        ...cardStatus(code),
      } } });
    return true;
  }),

  GetFriendCode: call((s) => friendCode(s.member.discordId)),
  // Members of this server who were in the plaza in the last 30 days; they nap until they join (awayAsleep).
  GetFriendsJson: call(async (s) => {
    const { members } = await api(s, "/plaza/members");
    for (const m of members) friends.set(m.code, m.dna);
    return JSON.stringify(members);
  }),
  // Recipes from the room were normalised by the Worker; pin the id to the seat they arrived on.
  RememberFriend: call((s, code, json) => { const dna = { ...JSON.parse(json), id: `friend_${code}` }; friends.set(code, dna); return JSON.stringify(dna); }),
  ForgetFriend: call((s, code) => friends.delete(code)),

  PlaySound: call((s, cue) => sound.play(cue)),
  ToggleSound: call(() => (sound.enabled = !sound.enabled)),
  ToggleFullscreen: call(() => {}),
  Exit: call((s) => s.sdk.close(RPCCloseCodes.CLOSE_NORMAL, "exit")),
  // Credits' links: Discord shows its own "leaving Discord" confirmation. https only.
  OpenExternal: call((s, url) => { if (/^https:\/\//.test(String(url))) s.sdk.commands.openExternalLink({ url: String(url) }); }),
  LogCanvasClick: call(() => {}),
  MediaPlayPause: call(() => {}),
  MediaNext: call(() => {}),
  MediaPrevious: call(() => {}),
};

/**
 * A member's Discord profile picture as a page-local URL. Fetched once per friend code with your sign-in (the Worker
 * only serves members of your server) and kept for the session; null if it can't be loaded.
 */
const pictures = new Map(); // code → Promise<string | null>
function pictureFor(s, code) {
  if (!pictures.has(code)) {
    pictures.set(code, fetch(`${API}/avatar-image/${code}`, { headers: { authorization: `Bearer ${s.token}`, "x-guild-id": s.sdk.guildId ?? "" } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .catch(() => null));
  }
  return pictures.get(code);
}

/** Gamercard line for a member's current Discord activity, if any. */
function cardStatus(code) {
  const status = code && statuses.get(code);
  return status ? { now: `${STATUS_VERB[status.kind] ?? ""} ${status.text}`.trim() } : {};
}

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

// The Windows host maps KEY → commands in C# (WebShellWindow.MapKey); the Activity mirrors that map here, plus H to
// hide the menu. The page decides what a d-pad move means on each blade.
function mapKey(key, shift) {
  switch (key) {
    case "ArrowUp": return ["NAVIGATE_DPAD", { direction: "up" }];
    case "ArrowDown": return ["NAVIGATE_DPAD", { direction: "down" }];
    case "ArrowLeft": return ["NAVIGATE_DPAD", { direction: "left" }];
    case "ArrowRight": return ["NAVIGATE_DPAD", { direction: "right" }];
    case "PageUp": return ["NAVIGATE_DPAD", { direction: "pageup" }];
    case "PageDown": return ["NAVIGATE_DPAD", { direction: "pagedown" }];
    case "Enter": case " ": return ["SELECT_ITEM", null];
    case "Escape": case "Backspace": return ["BACK", null];
    case "q": case "Q": return ["SWITCH_BLADE", { delta: -1 }];
    case "e": case "E": return ["SWITCH_BLADE", { delta: 1 }];
    case "Tab": return ["SWITCH_BLADE", { delta: shift ? -1 : 1 }];
    case "x": case "X": return ["ACTION_X", null];
    case "y": case "Y": return ["ACTION_Y", null];
    case "g": case "G": return ["OPEN_GAMERCARD", null];
    case "h": case "H": return ["TOGGLE_UI", null];
  }
  return null;
}

window.XboxHostAdapter = {
  name: "discord",
  blades: BLADES,
  backend,
  awayAsleep: true,
  inputHints: "keyboard",
  manualFriends: false, // everyone in the Activity is in the room already; codes only identify people
  // Discord passes ?platform=mobile|desktop in the Activity URL: phones start on the light tier, desktops adapt.
  quality: new URLSearchParams(location.search).get("platform") === "mobile" ? "low" : "auto",
  /** Called by main.js after HOST_READY (so sign-in is done): the shared room for this Activity instance. */
  createTransport() {
    const s = current;
    const params = new URLSearchParams({ guild: s.sdk.guildId ?? "", instance: s.sdk.instanceId });
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return new RoomTransport({
      url: `${scheme}://${location.host}${API}/room?${params}`, token: s.token, getDna: () => s.dna,
      onStatus: (code, status) => {
        if (status) statuses.set(code, status); else statuses.delete(code);
        emit("FRIEND_STATUS", { code, status });
      },
    });
  },
  post({ type, payload }) {
    const command = type === "KEY" ? mapKey(payload?.key, payload?.shift) : null;
    if (command) emit(...command);
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
