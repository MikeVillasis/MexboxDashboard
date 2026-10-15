// 2D blades layer. Owns view state only (which blade, which item); every real action goes to C# via Xbox.backend.
// Input arrives as C# commands (NAVIGATE_DPAD, SWITCH_BLADE, SELECT_ITEM, BACK, ACTION_X/Y, OPEN_GAMERCARD) or as
// pointer events on elements marked .interactive.

const TAB = 56;
const PAGE = 8;
const $ = (id) => document.getElementById(id);

export class Dashboard extends EventTarget {
  constructor(backend) {
    super();
    this.backend = backend;
    this.blades = [...document.querySelectorAll(".blade")];
    this.selected = 0;
    this.games = [];
    this.gameIndex = 0;
    this.systemIndex = 0;
    this.media = null;
    this.soundEnabled = true;
    this.lastPointer = null;

    this.buildHeader();
    this.buildSystemMenu();
    this.bindPointer();
    this.layout(false);
    new ResizeObserver(() => this.layout(false)).observe($("blade-stack"));
    this.tickClock();
  }

  // ───────────── Commands from C# ─────────────

  handleCommand(type, payload) {
    if (!$("gamercard").hidden && type !== "OPEN_GAMERCARD") {
      if (type === "BACK" || type === "SELECT_ITEM") this.closeGamercard();
      return;
    }

    switch (type) {
      case "SWITCH_BLADE": this.selectBlade(this.selected + payload.delta); break;
      case "NAVIGATE_DPAD": this.navigate(payload.direction); break;
      case "SELECT_ITEM": this.activate(); break;
      case "BACK":
        if (this.selected !== 0) { this.sound("Back"); this.selectBlade(0); }
        break;
      case "ACTION_X": if (this.bladeName() === "media") this.mediaCommand("MediaPrevious"); break;
      case "ACTION_Y":
        if (this.bladeName() === "media") this.mediaCommand("MediaNext");
        else if (this.bladeName() === "games") this.toast("custom cover art is set from the native shell for now");
        break;
      case "OPEN_GAMERCARD": $("gamercard").hidden ? this.openGamercard() : this.closeGamercard(); break;
    }
  }

  navigate(direction) {
    const blade = this.bladeName();
    const vertical = { up: -1, down: 1, pageup: -PAGE, pagedown: PAGE }[direction];

    if (vertical !== undefined) {
      if (blade === "games") this.focusGame(this.gameIndex + vertical, true);
      else if (blade === "system") this.focusSystem(this.systemIndex + vertical);
      return;
    }
    // Left/right are free on every blade, so they switch blades (as in the native shell).
    this.selectBlade(this.selected + (direction === "left" ? -1 : 1));
  }

  activate() {
    switch (this.bladeName()) {
      case "games": this.launchFocused(); break;
      case "media": this.mediaCommand("MediaPlayPause"); break;
      case "system": this.runSystemItem(this.systemIndex); break;
    }
  }

  // ───────────── Blades ─────────────

  bladeName() { return this.blades[this.selected].dataset.blade; }

  selectBlade(index, animate = true) {
    index = Math.max(0, Math.min(this.blades.length - 1, index));
    if (index === this.selected) return;
    this.selected = index;
    this.layout(animate);
    this.sound("BladeSwoosh");
    this.dispatchEvent(new CustomEvent("bladechange", { detail: { blade: this.bladeName() } }));
  }

  // Same geometry as the WPF BladeStackPanel: blades up to the selected one fan out as tabs on the left, the rest on the right.
  layout(animate) {
    const width = $("blade-stack").clientWidth;
    const count = this.blades.length;
    const bladeWidth = width - (count - 1) * TAB;
    this.blades.forEach((blade, i) => {
      const x = i <= this.selected ? i * TAB : width - (count - i) * TAB;
      if (!animate) blade.style.transition = "none";
      blade.style.setProperty("--blade-width", `${bladeWidth}px`);
      blade.style.setProperty("--x", `${x}px`);
      blade.classList.toggle("active", i === this.selected);
      if (!animate) { void blade.offsetWidth; blade.style.transition = ""; }
    });
    [...$("blade-names").children].forEach((b, i) => b.classList.toggle("active", i === this.selected));
    this.updateHints();
  }

  buildHeader() {
    this.blades.forEach((blade, i) => {
      const name = document.createElement("button");
      name.textContent = blade.dataset.label;
      name.addEventListener("click", () => this.selectBlade(i));
      $("blade-names").append(name);
      blade.querySelector(".blade-tab").addEventListener("click", () => this.selectBlade(i));
    });
  }

  updateHints() {
    const blade = this.bladeName();
    const set = (id, text) => { $(id).hidden = !text; $(id).querySelector("em").textContent = text || ""; };
    set("hint-x", blade === "media" ? "previous" : "");
    set("hint-y", blade === "media" ? "next track" : blade === "games" ? "cover art" : "");
  }

  // ───────────── Games ─────────────

  setLibrary(games, preferredId) {
    const previous = this.games[this.gameIndex]?.id ?? preferredId;
    this.games = games;
    const list = $("game-list");
    list.replaceChildren(...games.map((game, i) => {
      const li = document.createElement("li");
      li.dataset.index = i;
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (game.cover) thumb.style.backgroundImage = `url("${game.cover}")`;
      else thumb.textContent = initials(game.title);
      const text = document.createElement("div");
      text.className = "text";
      text.innerHTML = `<div class="title"></div><div class="meta"></div>`;
      text.querySelector(".title").textContent = game.title;
      text.querySelector(".meta").textContent = game.platform;
      li.append(thumb, text);
      return li;
    }));

    $("games-summary").textContent = games.length === 1 ? "1 game" : `${games.length} games`;
    $("games-empty").hidden = games.length > 0;
    $("game-preview").hidden = games.length === 0;
    const keep = games.findIndex((g) => g.id === previous);
    this.focusGame(keep >= 0 ? keep : 0, false, true);
  }

  focusGame(index, withSound, force = false) {
    if (this.games.length === 0) return;
    index = Math.max(0, Math.min(this.games.length - 1, index));
    if (index === this.gameIndex && !force) return;
    this.gameIndex = index;

    const items = $("game-list").children;
    for (const li of items) li.classList.toggle("focused", Number(li.dataset.index) === index);
    items[index]?.scrollIntoView({ block: "nearest" });

    const game = this.games[index];
    for (const id of ["preview-cover", "preview-reflection"]) {
      const el = $(id);
      el.style.backgroundImage = game.cover ? `url("${game.cover}")` : "";
      el.textContent = game.cover ? "" : game.title;
    }
    $("preview-title").textContent = game.title;
    $("preview-details").textContent = `${game.platform}  ·  ${relativePlayed(game.lastPlayed)}`;

    const preview = $("game-preview");
    if (!force) { preview.classList.remove("settle"); void preview.offsetWidth; preview.classList.add("settle"); }
    if (withSound) this.sound("Navigate");
    this.backend?.FocusGame(game.id);
  }

  launchFocused() {
    const game = this.games[this.gameIndex];
    if (!game) return;
    this.toast(`starting ${game.title}…`);
    this.backend.LaunchGame(game.id); // plays the launch cue in C#
  }

  // ───────────── Media ─────────────

  setMedia(media) {
    const trackChanged = media && (!this.media || media.title !== this.media.title || media.artist !== this.media.artist);
    this.media = media;
    $("media-session").hidden = !media;
    $("media-empty").hidden = Boolean(media);
    $("media-app").textContent = media ? media.app : "";
    if (!media) return;

    $("media-title").textContent = media.title;
    $("media-artist").textContent = media.artist;
    $("media-album").textContent = media.album;
    $("media-art").style.backgroundImage = media.art ? `url("${media.art}")` : "";
    $("media-toggle").textContent = media.playing ? "⏸" : "▶";
    $("media-next").disabled = !media.canNext;
    $("media-prev").disabled = !media.canPrevious;
    if (trackChanged) { const s = $("media-session"); s.classList.remove("settle"); void s.offsetWidth; s.classList.add("settle"); }
  }

  mediaCommand(method) {
    if (!this.media) return;
    this.sound("Select");
    this.backend[method]();
  }

  // ───────────── System ─────────────

  buildSystemMenu() {
    this.systemItems = [
      { title: "rescan library", description: "look for newly installed or removed games", run: () => { this.backend.Rescan(); this.toast("checking your launchers…"); } },
      { title: "toggle fullscreen", description: "switch between fullscreen and a window (F11)", run: () => this.backend.ToggleFullscreen() },
      { title: () => `sound effects: ${this.soundEnabled ? "on" : "off"}`, description: "blade swooshes and navigation blips",
        run: async () => { this.soundEnabled = await this.backend.ToggleSound(); this.renderSystemMenu(); } },
      { title: "gamercard", description: "your profile summary (G)", run: () => this.openGamercard() },
      { title: "exit dashboard", description: "close the launcher", run: () => this.backend.Exit() },
    ];
    this.renderSystemMenu();
  }

  renderSystemMenu() {
    $("system-list").replaceChildren(...this.systemItems.map((item, i) => {
      const li = document.createElement("li");
      li.dataset.index = i;
      li.classList.toggle("focused", i === this.systemIndex);
      const title = typeof item.title === "function" ? item.title() : item.title;
      li.innerHTML = `<div class="text"><div class="title"></div><div class="meta"></div></div>`;
      li.querySelector(".title").textContent = title;
      li.querySelector(".meta").textContent = item.description;
      return li;
    }));
  }

  focusSystem(index) {
    index = Math.max(0, Math.min(this.systemItems.length - 1, index));
    if (index === this.systemIndex) return;
    this.systemIndex = index;
    for (const li of $("system-list").children) li.classList.toggle("focused", Number(li.dataset.index) === index);
    this.sound("Navigate");
  }

  runSystemItem(index) {
    this.sound("Select");
    this.systemItems[index].run();
  }

  // ───────────── Gamercard ─────────────

  async openGamercard() {
    const profile = JSON.parse(await this.backend.GetProfileJson());
    $("gc-gamertag").textContent = profile.gamertag;
    const stats = [["games", profile.games], ["launches", profile.launches], ["last played", profile.lastPlayed ?? "—"]];
    $("gc-stats").replaceChildren(...stats.flatMap(([k, v]) => {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v;
      return [dt, dd];
    }));
    $("gamercard").hidden = false;
    this.sound("Select");
  }

  closeGamercard() {
    $("gamercard").hidden = true;
    this.sound("Back");
  }

  setGamertag(tag) { $("gamertag").textContent = tag; }

  // ───────────── Pointer ─────────────

  bindPointer() {
    const games = $("game-list");
    // Focus follows real pointer movement (not wheel scrolling), like the native shell.
    games.addEventListener("pointermove", (e) => {
      if (this.lastPointer && Math.abs(this.lastPointer.x - e.clientX) < 1 && Math.abs(this.lastPointer.y - e.clientY) < 1) return;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      const li = e.target.closest("li");
      if (li) this.focusGame(Number(li.dataset.index), true);
    });
    games.addEventListener("dblclick", (e) => { if (e.target.closest("li")) this.launchFocused(); });
    $("play-button").addEventListener("click", () => this.launchFocused());

    $("system-list").addEventListener("click", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      this.systemIndex = Number(li.dataset.index);
      this.renderSystemMenu();
      this.runSystemItem(this.systemIndex);
    });

    $("media-prev").addEventListener("click", () => this.mediaCommand("MediaPrevious"));
    $("media-toggle").addEventListener("click", () => this.mediaCommand("MediaPlayPause"));
    $("media-next").addEventListener("click", () => this.mediaCommand("MediaNext"));

    $("gamertag").addEventListener("click", () => this.openGamercard());
    $("gamercard").addEventListener("click", (e) => { if (e.target === $("gamercard")) this.closeGamercard(); });
  }

  // ───────────── Helpers ─────────────

  sound(cue) { if (this.backend) this.backend.PlaySound(cue); }

  toast(text) {
    const toast = $("toast");
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  tickClock() {
    const now = new Date();
    $("clock").textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
    setTimeout(() => this.tickClock(), 60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 20);
  }
}

function initials(title) {
  return title.split(/[\s:_-]+/).filter((w) => /\w/.test(w[0])).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}

function relativePlayed(iso) {
  if (!iso) return "not played from the dashboard yet";
  const minutes = (Date.now() - new Date(iso).getTime()) / 60000;
  if (minutes < 2) return "played just now";
  if (minutes < 60) return `played ${Math.floor(minutes)} minutes ago`;
  const hours = minutes / 60;
  if (hours < 24) return hours < 2 ? "played an hour ago" : `played ${Math.floor(hours)} hours ago`;
  const days = hours / 24;
  if (days < 2) return "played yesterday";
  if (days < 30) return `played ${Math.floor(days)} days ago`;
  return `played ${new Date(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }).toLowerCase()}`;
}
