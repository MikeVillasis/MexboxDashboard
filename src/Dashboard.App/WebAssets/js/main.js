// Entry point: wires the C# bridge to the 2D dashboard (layer 10) and the 3D plaza (layer 1).
import { Dashboard } from "./ui/dashboard.js";
import { Plaza } from "./scene/plaza.js";
import { RESIDENTS } from "./avatar/residents.js";

const backend = Xbox.backend;
const dashboard = new Dashboard(backend);
const plaza = new Plaza(document.getElementById("viewport-3d"), (x, z) => backend?.LogCanvasClick(x, z));

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
  });
  Xbox.on("LIBRARY_CHANGED", loadLibrary);
  Xbox.on("MEDIA_UPDATED", (media) => dashboard.setMedia(media));
  Xbox.on("SHELL_ACTIVE", (p) => plaza.setRunning(p.active)); // idle the GPU while a game is in front

  for (const type of ["SWITCH_BLADE", "NAVIGATE_DPAD", "SELECT_ITEM", "BACK", "ACTION_X", "ACTION_Y", "OPEN_GAMERCARD"]) {
    Xbox.on(type, (payload) => dashboard.handleCommand(type, payload));
  }


  // The browser has keyboard focus; forward keys so C# maps them exactly like controller input.
  document.addEventListener("keydown", (e) => {
    if (["Tab", " ", "Backspace", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key)) e.preventDefault();
    Xbox.send("KEY", { key: e.key, shift: e.shiftKey });
  });
}
