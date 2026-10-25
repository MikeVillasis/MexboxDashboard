// Entry point: wires the host bridge (C# WebView2 or another adapter, see bridge.js) to the 2D dashboard (layer 10) and the 3D plaza (layer 1).
import { Dashboard } from "./ui/dashboard.js";
import { Plaza } from "./scene/plaza.js";
import { RESIDENTS } from "./avatar/residents.js";
import { NetworkManager } from "./net/NetworkManager.js";
import { DEFAULT_SKY, SKIES } from "./scene/Sky.js";

const backend = Xbox.backend;
const dashboard = new Dashboard(backend, { blades: Xbox.blades, inputHints: Xbox.inputHints, manualFriends: Xbox.manualFriends, cameraControls: Xbox.cameraControls, pairing: Xbox.pairing });
const report = (event, avatar, other) => Xbox.send("PLAZA_EVENT", { event, id: avatar?.id, with: other?.id ?? null });
const plaza = new Plaza(document.getElementById("viewport-3d"), {
  // A floor click sends your avatar walking there (and tells your friends, so theirs walks too).
  floorClick: (x, z) => { backend?.LogCanvasClick(x, z); if (plaza.local) plaza.ai.walkTo(plaza.local, x, z, true); },
  avatarClick: (dna) => backend?.InspectAvatar(JSON.stringify(dna)), // C# answers with OPEN_GAMERCARD
  grab: (avatar) => { report("grab", avatar); backend?.PlaySound("Select"); },
  drop: (avatar) => { report("drop", avatar); backend?.PlaySound("Back"); },
  plazaEvent: report,
  // You took the camera (drag/zoom): stop following whoever was selected in the friends list.
  cameraMoved: () => dashboard.focusAvatar(null),
}, { quality: Xbox.quality, cameraControls: Xbox.cameraControls });

dashboard.addEventListener("bladechange", (e) => plaza.setBlade(e.detail.blade));

// Plaza sky: picked in the plaza menu, remembered per viewer (local storage may be unavailable: then it's per session).
const SKY_KEY = "mexbox.sky";
function applySky(name) {
  const applied = plaza.setSky(name);
  dashboard.setSkies(Object.entries(SKIES).map(([id, sky]) => ({ id, label: sky.label })), applied);
  dashboard.setSkyCredit(SKIES[applied].credit?.html ?? null);
  try { localStorage.setItem(SKY_KEY, applied); } catch { /* private mode / blocked storage */ }
}
applySky((() => { try { return localStorage.getItem(SKY_KEY); } catch { return null; } })() ?? DEFAULT_SKY);
dashboard.addEventListener("skychange", (e) => applySky(e.detail.name));
// The WebView2 host object answers any method name, so a missing OpenExternal shows up as a rejected call: fall back.
dashboard.addEventListener("openlink", (e) => {
  const open = () => window.open(e.detail.href, "_blank", "noopener");
  if (!backend?.OpenExternal) { open(); return; }
  Promise.resolve().then(() => backend.OpenExternal(e.detail.href)).catch(open);
});
dashboard.addEventListener("focusavatar", (e) => { if (!plaza.focusAvatar(e.detail.id) && e.detail.id) dashboard.toast("they haven't arrived in the plaza yet"); });
// Collapsed: the plaza fills the screen, so a followed avatar is centred instead of framed beside the panel.
dashboard.addEventListener("collapsechange", (e) => plaza.director.framing(!e.detail.collapsed));
dashboard.setPlazaResidents(RESIDENTS);
plaza.spawnResidents();

// Avatar edits: re-dress immediately for feedback, then let C# validate and persist; render whatever C# accepted.
dashboard.addEventListener("avatarchange", async (e) => {
  const avatar = await plaza.setLocalAvatar(e.detail.dna);
  avatar.face.express("happy", 1.2);
  const saved = await backend.SaveAvatarDnaJson(JSON.stringify(e.detail.dna));
  if (!saved) { console.warn("C# rejected the avatar recipe; reverting"); await loadAvatar(); return; }
  const normalised = JSON.parse(saved);
  if (JSON.stringify(normalised) !== JSON.stringify(e.detail.dna)) { dashboard.setAvatar(normalised); plaza.setLocalAvatar(normalised); }
  net?.broadcast({ type: "DNA_UPDATE", dna: normalised });
});
dashboard.addEventListener("avatarpoke", () => {
  plaza.local?.face.express("happy", 2);
  plaza.local?.face.talk(1.6);
  backend.PlaySound("Select");
});

async function loadAvatar() {
  const dna = JSON.parse(await backend.GetAvatarDnaJson());
  dashboard.setAvatar(dna);
  const avatar = await plaza.setLocalAvatar(dna);
  avatar.onGesture = (emote) => net?.broadcast({ type: "EMOTE", emote });
}

// ───────────── P2P friends ─────────────

let net = null;
let myCode = null;
const friends = new Map(); // code → { code, name, color, online, status? }
const friendAvatar = (code) => plaza.avatars.get(`friend_${code}`);
const logNet = (event, peer = "", detail = "") => Xbox.send("NET_EVENT", { event, peer, detail });

function renderFriends() { dashboard.setFriends([...friends.values()].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name))); }

/// Friends met before roam the plaza as NPCs from their cached recipes, even while they're offline.
async function loadFriends() {
  for (const f of JSON.parse(await backend.GetFriendsJson())) {
    friends.set(f.code, { ...friends.get(f.code), code: f.code, name: f.dna.name, color: f.dna.shirtColor, online: false });
    plaza.upsertFriend(f.dna, { asleep: Xbox.awayAsleep });
  }
  renderFriends();
}

/// A peer's recipe (JOIN_SYNC / DNA_UPDATE) only renders after C# has validated it.
async function acceptRecipe(code, dna, position) {
  const json = await backend.RememberFriend(code, JSON.stringify(dna));
  if (!json) { logNet("rejected-recipe", code); return null; }
  const clean = JSON.parse(json);
  await plaza.upsertFriend(clean, { live: true, ...position });
  friends.set(code, { ...friends.get(code), code, name: clean.name, color: clean.shirtColor, online: true }); // keeps any status
  renderFriends();
  return clean;
}

async function startNetwork(connectTo) {
  const code = await backend.GetFriendCode();
  myCode = code;
  dashboard.setFriendCode(code);
  net = new NetworkManager(code, logNet, Xbox.createTransport?.(code) ?? undefined);
  // Wherever the local avatar decides to walk (its own AI, a floor click, the customiser sending it home), peers follow.
  plaza.ai.onTarget = (agent, x, z) => { if (agent.avatar === plaza.local) net.broadcast({ type: "MOVE", x, z }); };

  net.addEventListener("status", (e) => {
    dashboard.setNetStatus(e.detail.status);
    if (e.detail.status === "online" && connectTo) { net.connect(connectTo); connectTo = null; }
  });
  // Both sides introduce themselves as soon as the data channel opens.
  net.addEventListener("peeropen", ({ detail }) => {
    const me = plaza.local;
    net.send(detail.code, { type: "JOIN_SYNC", dna: dashboard.dna, x: me?.root.position.x ?? 0, z: me?.root.position.z ?? 0 });
  });
  net.addEventListener("join", async ({ detail }) => {
    const dna = await acceptRecipe(detail.code, detail.dna, { x: detail.x, z: detail.z });
    if (!dna) return;
    logNet("join", detail.code, dna.name);
    dashboard.toast(`${dna.name} joined your plaza`);
    backend.PlaySound("Select");
  });
  net.addEventListener("move", ({ detail }) => {
    const avatar = friendAvatar(detail.code);
    if (avatar && plaza.ai.get(avatar)?.remote) { plaza.ai.walkTo(avatar, detail.x, detail.z); logNet("move", detail.code, `${detail.x.toFixed(2)},${detail.z.toFixed(2)}`); }
  });
  net.addEventListener("emote", ({ detail }) => {
    friendAvatar(detail.code)?.gesture(detail.emote);
    logNet("emote", detail.code, detail.emote);
  });
  net.addEventListener("dna", async ({ detail }) => {
    const dna = await acceptRecipe(detail.code, detail.dna);
    if (dna) logNet("dna-update", detail.code, dna.name);
  });
  // Gone offline: they keep wandering your plaza as an NPC (or nap there, if the host says away friends sleep).
  net.addEventListener("peerleave", ({ detail }) => {
    plaza.setAway(`friend_${detail.code}`, Xbox.awayAsleep);
    const f = friends.get(detail.code);
    if (f) { f.online = false; renderFriends(); dashboard.toast(`${f.name} left`); }
  });
  net.addEventListener("connectfailed", ({ detail }) => dashboard.toast(`${detail.code || "that friend"} isn't online right now`));
  dashboard.addEventListener("connectfriend", (e) => net.connect(e.detail.code));

  net.start();
}

async function loadLibrary() {
  const [games, settings] = await Promise.all([backend.GetLibraryJson(), backend.GetSettingsJson()]);
  dashboard.setLibrary(JSON.parse(games), JSON.parse(settings).lastGameId);
}

if (backend) {
  // HOST_READY carries current state because pushes sent before the page loaded are lost.
  Xbox.on("HOST_READY", (p) => {
    dashboard.soundEnabled = p.soundEnabled;
    dashboard.renderSystemMenu();
    dashboard.setMedia(p.media);
    document.getElementById("system-version").textContent = `v${p.version}`;
    dashboard.refreshDevices().catch((err) => console.warn("could not list linked pcs", err));
    if (Xbox.host === "webview2") backend.GetActivityLinkJson().then((json) => dashboard.setActivityLink(JSON.parse(json)));
    loadLibrary();
    loadAvatar();
    loadFriends().then(() => startNetwork(p.connectTo));
    if (p.startBlade) dashboard.selectBladeByName(p.startBlade, false);
    if (p.plazaSelfTest) { selfTest = true; plaza.setRunning(true); setTimeout(plazaSelfTest, 8000); }
  });
  Xbox.on("LIBRARY_CHANGED", loadLibrary);
  Xbox.on("ACTIVITY_LINK", (state) => dashboard.setActivityLink(state)); // Windows: linking to the Discord Activity
  Xbox.on("TOAST", (p) => dashboard.toast(p.text)); // Windows: e.g. a game launched from Discord
  // Back to the authored plaza framing (key R in the Activity).
  Xbox.on("RESET_VIEW", () => { dashboard.focusAvatar(null); plaza.resetView(); });
  // Hosts with a presence feed (the Discord Activity) report what members are playing / listening to: a thought
  // bubble over their avatar, yours included, and a line in the friends list.
  Xbox.on("FRIEND_STATUS", ({ code, status }) => {
    plaza.setThought(code === myCode ? "local" : `friend_${code}`, status);
    const f = friends.get(code);
    if (f) { f.status = status; renderFriends(); }
  });
  Xbox.on("MEDIA_UPDATED", (media) => dashboard.setMedia(media));
  // Idle the GPU while a game is in front (the self-test keeps simulating so it can run unattended in the background).
  let selfTest = false;
  Xbox.on("SHELL_ACTIVE", (p) => { if (!selfTest) plaza.setRunning(p.active); });

  for (const type of ["SWITCH_BLADE", "NAVIGATE_DPAD", "SELECT_ITEM", "BACK", "ACTION_X", "ACTION_Y", "OPEN_GAMERCARD", "TOGGLE_UI"]) {
    Xbox.on(type, (payload) => dashboard.handleCommand(type, payload));
  }


  // The browser has keyboard focus; forward keys so C# maps them exactly like controller input.
  document.addEventListener("keydown", (e) => {
    // Typing a friend code is text entry, not navigation (Escape leaves the field).
    if (e.target instanceof HTMLInputElement) { if (e.key === "Escape") e.target.blur(); return; }
    if (["Tab", " ", "Backspace", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key)) e.preventDefault();
    Xbox.send("KEY", { key: e.key, shift: e.shiftKey });
  });
}

/// --plaza-selftest: the same grab/drag/drop/inspect calls the pointer handlers make, minus the hit-test.
async function plazaSelfTest() {
  const [a, b] = ["npc_ace", "npc_juno"].map((id) => plaza.avatars.get(id));
  if (!a || !b) { report("selftest-missing-avatars"); return; }
  report("selftest-start", a, b);
  plaza.ai.grab(a);
  plaza.callbacks.grab(a);
  const target = b.root.position.clone().add({ x: 0.9, y: 0, z: 0.3 });
  plaza.ai.drag(a, target);
  await new Promise((r) => setTimeout(r, 1500));
  report(`selftest-holding-y=${a.root.position.y.toFixed(2)}-dangle=${a.motion.dangle.toFixed(2)}`, a);
  plaza.ai.drop(a);
  plaza.callbacks.drop(a);
  await new Promise((r) => setTimeout(r, 1500));
  report(`selftest-after-drop-state=${plaza.ai.get(a).state}-partner=${plaza.ai.get(a).partner?.id ?? "none"}-y=${a.root.position.y.toFixed(2)}`, a);
  plaza.callbacks.avatarClick(a.dna);
}
