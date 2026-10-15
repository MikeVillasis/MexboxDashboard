// Entry point: wires the C# bridge to the 2D dashboard (layer 10) and the 3D plaza (layer 1).
import { Dashboard } from "./ui/dashboard.js";
import { Plaza } from "./scene/plaza.js";

const backend = Xbox.backend;
const dashboard = new Dashboard(backend);
const plaza = new Plaza(document.getElementById("viewport-3d"), (x, z) => backend?.LogCanvasClick(x, z));

dashboard.addEventListener("bladechange", (e) => plaza.setBlade(e.detail.blade));

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
  });
  Xbox.on("LIBRARY_CHANGED", loadLibrary);
  Xbox.on("MEDIA_UPDATED", (media) => dashboard.setMedia(media));
  Xbox.on("SHELL_ACTIVE", (p) => plaza.setRunning(p.active)); // idle the GPU while a game is in front

  for (const type of ["SWITCH_BLADE", "NAVIGATE_DPAD", "SELECT_ITEM", "BACK", "ACTION_X", "ACTION_Y", "OPEN_GAMERCARD"]) {
    Xbox.on(type, (payload) => dashboard.handleCommand(type, payload));
  }

  backend.GetProfileJson().then((json) => dashboard.setGamertag(JSON.parse(json).gamertag));

  // The browser has keyboard focus; forward keys so C# maps them exactly like controller input.
  document.addEventListener("keydown", (e) => {
    if (["Tab", " ", "Backspace", "ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(e.key)) e.preventDefault();
    Xbox.send("KEY", { key: e.key, shift: e.shiftKey });
  });
}
