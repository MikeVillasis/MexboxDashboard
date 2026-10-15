// Entry point: wires the C# bridge to the 2D dashboard (layer 10) and the 3D plaza (layer 1).
import { Dashboard } from "./ui/dashboard.js";
import { Plaza } from "./scene/plaza.js";
import { RESIDENTS } from "./avatar/residents.js";

const backend = Xbox.backend;
const dashboard = new Dashboard(backend);
const report = (event, avatar, other) => Xbox.send("PLAZA_EVENT", { event, id: avatar?.id, with: other?.id ?? null });
const plaza = new Plaza(document.getElementById("viewport-3d"), {
  floorClick: (x, z) => backend?.LogCanvasClick(x, z),
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
});
dashboard.addEventListener("avatarpoke", () => {
  plaza.local?.face.express("happy", 2);
  plaza.local?.face.talk(1.6);
  backend.PlaySound("Select");
});

async function loadAvatar() {
  const dna = JSON.parse(await backend.GetAvatarDnaJson());
  dashboard.setAvatar(dna);
  await plaza.setLocalAvatar(dna);
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
