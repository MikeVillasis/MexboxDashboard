// Entry point: wires the host bridge (C# WebView2 or another adapter, see bridge.js) to the 2D dashboard (layer 10) and the 3D plaza (layer 1).
import { Dashboard } from "./ui/dashboard.js";
import { Plaza } from "./scene/plaza.js";
import { RESIDENTS } from "./avatar/residents.js";
import { NetworkManager } from "./net/NetworkManager.js";

const backend = Xbox.backend;
const dashboard = new Dashboard(backend, { blades: Xbox.blades });
const report = (event, avatar, other) => Xbox.send("PLAZA_EVENT", { event, id: avatar?.id, with: other?.id ?? null });
const plaza = new Plaza(document.getElementById("viewport-3d"), {
  // A floor click sends your avatar walking there (and tells your friends, so theirs walks too).
  floorClick: (x, z) => { backend?.LogCanvasClick(x, z); if (plaza.local) plaza.ai.walkTo(plaza.local, x, z, true); },
  avatarClick: (dna) => backend?.InspectAvatar(JSON.stringify(dna)), // C# answers with OPEN_GAMERCARD
  grab: (avatar) => { report("grab", avatar); backend?.PlaySound("Select"); },
  drop: (avatar) => { report("drop", avatar); backend?.PlaySound("Back"); },
  plazaEvent: report,
});

dashboard.addEventListener("bladechange", (e) => plaza.setBlade(e.detail.blade));
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
const friends = new Map(); // code → { code, name, color, online }
const friendAvatar = (code) => plaza.avatars.get(`friend_${code}`);
const logNet = (event, peer = "", detail = "") => Xbox.send("NET_EVENT", { event, peer, detail });

function renderFriends() { dashboard.setFriends([...friends.values()].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name))); }

/// Friends met before roam the plaza as NPCs from their cached recipes, even while they're offline.
async function loadFriends() {
  for (const f of JSON.parse(await backend.GetFriendsJson())) {
    friends.set(f.code, { code: f.code, name: f.dna.name, color: f.dna.shirtColor, online: false });
    plaza.upsertFriend(f.dna);
  }
  renderFriends();
}

/// A peer's recipe (JOIN_SYNC / DNA_UPDATE) only renders after C# has validated it.
async function acceptRecipe(code, dna, position) {
  const json = await backend.RememberFriend(code, JSON.stringify(dna));
  if (!json) { logNet("rejected-recipe", code); return null; }
  const clean = JSON.parse(json);
  await plaza.upsertFriend(clean, { live: true, ...position });
  friends.set(code, { code, name: clean.name, color: clean.shirtColor, online: true });
  renderFriends();
  return clean;
}

async function startNetwork(connectTo) {
  const code = await backend.GetFriendCode();
  dashboard.setFriendCode(code);
  net = new NetworkManager(code, logNet);
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
  // Gone offline: they keep wandering your plaza as an NPC.
  net.addEventListener("peerleave", ({ detail }) => {
    const avatar = friendAvatar(detail.code);
    if (avatar) plaza.ai.setRemote(avatar, false);
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
    loadLibrary();
    loadAvatar();
    loadFriends().then(() => startNetwork(p.connectTo));
    if (p.startBlade) dashboard.selectBladeByName(p.startBlade, false);
    if (p.plazaSelfTest) { selfTest = true; plaza.setRunning(true); setTimeout(plazaSelfTest, 8000); }
  });
  Xbox.on("LIBRARY_CHANGED", loadLibrary);
  Xbox.on("MEDIA_UPDATED", (media) => dashboard.setMedia(media));
  // Idle the GPU while a game is in front (the self-test keeps simulating so it can run unattended in the background).
  let selfTest = false;
  Xbox.on("SHELL_ACTIVE", (p) => { if (!selfTest) plaza.setRunning(p.active); });

  for (const type of ["SWITCH_BLADE", "NAVIGATE_DPAD", "SELECT_ITEM", "BACK", "ACTION_X", "ACTION_Y", "OPEN_GAMERCARD"]) {
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
