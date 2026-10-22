// 2D blades layer. Owns view state only (which blade, which item); every real action goes to C# via Xbox.backend.
// Input arrives as C# commands (NAVIGATE_DPAD, SWITCH_BLADE, SELECT_ITEM, BACK, ACTION_X/Y, OPEN_GAMERCARD) or as
// pointer events on elements marked .interactive.

import { CATALOG, PALETTES } from "../avatar/AvatarBuilder.js";
import { EYE_STYLE_NAMES, MOUTH_STYLE_NAMES } from "../avatar/FaceController.js";

const TAB = 56; // default; the live value comes from the CSS --tab variable (narrower on phones)

// Customiser rows: each edits one DNA field, either an index into a catalogue list or a colour from a palette.
const AVATAR_OPTIONS = [
  { key: "skinColor", label: "skin tone", palette: PALETTES.skin },
  { key: "headId", label: "head", names: CATALOG.head },
  { key: "eyeUV", label: "eyes", names: EYE_STYLE_NAMES },
  { key: "mouthUV", label: "mouth", names: MOUTH_STYLE_NAMES },
  { key: "hairId", label: "hair", names: CATALOG.hair },
  { key: "hairColor", label: "hair colour", palette: PALETTES.hair },
  { key: "torsoId", label: "top", names: CATALOG.torso },
  { key: "shirtColor", label: "top colour", palette: PALETTES.shirt },
  { key: "legsId", label: "bottoms", names: CATALOG.legs },
  { key: "legsColor", label: "bottoms colour", palette: PALETTES.legs },
];
const PAGE = 8;

/// One line for a Discord presence in lists ("playing halo infinite"); the bubble over the avatar shows the same.
function statusLine(status) {
  const verb = { playing: "playing", listening: "listening to", watching: "watching" }[status.kind] ?? "";
  return `${verb} ${status.text}`.trim();
}
const $ = (id) => document.getElementById(id);

export class Dashboard extends EventTarget {
  /// options.blades: names the host supports (null = all). Others stay in the DOM, hidden, so their elements still resolve.
  /// options.inputHints: "controller" (default) or "keyboard" footer.
  /// options.manualFriends: false hides "add a friend" (hosts where everyone present is connected automatically).
  constructor(backend, options = {}) {
    super();
    this.backend = backend;
    this.blades = [...document.querySelectorAll(".blade")].filter((blade) => {
      const keep = !options.blades || options.blades.includes(blade.dataset.blade);
      if (!keep) blade.style.display = "none";
      return keep;
    });
    this.selected = 0;
    this.games = [];
    this.gameIndex = 0;
    this.systemIndex = 0;
    this.avatarIndex = 0;
    this.dna = null;
    this.media = null;
    this.soundEnabled = true;
    this.lastPointer = null;
    this.collapsed = false;
    this.focusedAvatarId = null; // friend/resident the camera is following (friends blade)
    const input = options.inputHints === "keyboard" ? "keyboard" : "controller";
    for (const footer of document.querySelectorAll(".hints[data-input]")) footer.hidden = footer.dataset.input !== input;
    if (options.manualFriends === false) for (const el of document.querySelectorAll("[data-manual-friends]")) el.hidden = true;

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
    // Collapsed: Back (or the toggle) brings the menu back; everything else still works on the hidden blades.
    if (this.collapsed && (type === "BACK" || type === "TOGGLE_UI")) { this.setCollapsed(false); return; }

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
      case "TOGGLE_UI": if (this.bladeName() === "friends") this.setCollapsed(true); break;
      case "OPEN_GAMERCARD":
        if (payload?.card) this.openGamercard(payload.card);       // a plaza avatar, summarised by C#
        else $("gamercard").hidden ? this.openGamercard() : this.closeGamercard();
        break;
    }
  }

  navigate(direction) {
    const blade = this.bladeName();
    const vertical = { up: -1, down: 1, pageup: -PAGE, pagedown: PAGE }[direction];

    if (vertical !== undefined) {
      if (blade === "games") this.focusGame(this.gameIndex + vertical, true);
      else if (blade === "system") this.focusSystem(this.systemIndex + vertical);
      else if (blade === "avatar") this.focusAvatarOption(this.avatarIndex + Math.sign(vertical));
      return;
    }
    // On the customiser left/right edit the focused option; LB/RB and B still leave the blade.
    if (blade === "avatar" && this.dna) { this.stepAvatarOption(this.avatarIndex, direction === "left" ? -1 : 1); return; }
    // Left/right are free on every blade, so they switch blades (as in the native shell).
    this.selectBlade(this.selected + (direction === "left" ? -1 : 1));
  }

  activate() {
    switch (this.bladeName()) {
      case "games": this.launchFocused(); break;
      case "media": this.mediaCommand("MediaPlayPause"); break;
      case "system": this.runSystemItem(this.systemIndex); break;
      case "avatar": this.dispatchEvent(new CustomEvent("avatarpoke")); break;
    }
  }

  // ───────────── Blades ─────────────

  bladeName() { return this.blades[this.selected].dataset.blade; }

  selectBlade(index, animate = true) {
    index = Math.max(0, Math.min(this.blades.length - 1, index));
    if (index === this.selected) return;
    this.selected = index;
    this.setCollapsed(false);
    this.focusAvatar(null);
    this.layout(animate);
    this.sound("BladeSwoosh");
    this.dispatchEvent(new CustomEvent("bladechange", { detail: { blade: this.bladeName() } }));
  }

  selectBladeByName(name, animate = true) {
    const index = this.blades.findIndex((b) => b.dataset.blade === name);
    if (index < 0) return;
    if (!animate) { this.selected = index; this.layout(false); this.dispatchEvent(new CustomEvent("bladechange", { detail: { blade: name } })); }
    else this.selectBlade(index);
  }

  // Same geometry as the WPF BladeStackPanel: blades up to the selected one fan out as tabs on the left, the rest on the right.
  layout(animate) {
    const width = $("blade-stack").clientWidth;
    const count = this.blades.length;
    const tab = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tab")) || TAB;
    const bladeWidth = width - (count - 1) * tab;
    this.blades.forEach((blade, i) => {
      const x = i <= this.selected ? i * tab : width - (count - i) * tab;
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
    const hints = (name) => document.querySelectorAll(`.hints [data-hint="${name}"]`);
    const set = (name, text) => { for (const el of hints(name)) { el.hidden = !text; el.querySelector("em").textContent = text || ""; } };
    set("x", blade === "media" ? "previous" : "");
    set("y", blade === "media" ? "next track" : blade === "games" ? "cover art" : "");
    for (const el of hints("dpad")) el.hidden = blade !== "avatar";
    for (const el of hints("hide")) el.hidden = blade !== "friends";
  }

  /// Slides the blades off to the left so the plaza is on its own; a handle on the left edge brings them back.
  setCollapsed(collapsed) {
    if (collapsed === this.collapsed) return;
    this.collapsed = collapsed;
    $("dashboard-ui").classList.toggle("collapsed", collapsed);
    $("expand-ui").hidden = !collapsed;
    this.sound(collapsed ? "BladeSwoosh" : "Back");
    this.dispatchEvent(new CustomEvent("collapsechange", { detail: { collapsed } }));
  }

  /// Friends/residents list selection → main.js points the camera at that avatar (null = back to the wide shot).
  focusAvatar(id) {
    if (id === this.focusedAvatarId) return;
    this.focusedAvatarId = id;
    for (const li of document.querySelectorAll(".plain-list.selectable li")) li.classList.toggle("selected", Boolean(id) && li.dataset.avatarId === id);
    this.dispatchEvent(new CustomEvent("focusavatar", { detail: { id } }));
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

  // ───────────── Avatar customiser ─────────────

  setAvatar(dna) {
    this.dna = { ...dna };
    $("avatar-name").textContent = dna.name;
    this.setGamertag(dna.name);
    this.renderAvatarOptions();
  }

  renderAvatarOptions() {
    $("avatar-options").replaceChildren(...AVATAR_OPTIONS.map((option, i) => {
      const li = document.createElement("li");
      li.dataset.index = i;
      li.classList.toggle("focused", i === this.avatarIndex);
      const value = this.dna?.[option.key];
      const shown = option.palette
        ? `<i class="swatch" style="background:${value}"></i>`
        : `<span>${escapeHtml(option.names[value] ?? option.names[0])}</span>`;
      li.innerHTML = `<span class="label"></span><span class="value"><button class="step" data-step="-1">&#x25C0;</button>${shown}<button class="step" data-step="1">&#x25B6;</button></span>`;
      li.querySelector(".label").textContent = option.label;
      return li;
    }));
  }

  focusAvatarOption(index) {
    index = Math.max(0, Math.min(AVATAR_OPTIONS.length - 1, index));
    if (index === this.avatarIndex) return;
    this.avatarIndex = index;
    for (const li of $("avatar-options").children) li.classList.toggle("focused", Number(li.dataset.index) === index);
    $("avatar-options").children[index]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.sound("Navigate");
  }

  /// Cycles one option and emits the full new recipe; main.js re-dresses the avatar and persists it through C#.
  stepAvatarOption(index, delta) {
    const option = AVATAR_OPTIONS[index];
    const list = option.palette ?? option.names;
    const current = option.palette
      ? Math.max(0, list.findIndex((c) => c.toUpperCase() === String(this.dna[option.key]).toUpperCase()))
      : this.dna[option.key];
    const next = (current + delta + list.length) % list.length;
    this.dna = { ...this.dna, [option.key]: option.palette ? list[next] : next };
    this.renderAvatarOptions();
    this.sound("Navigate");
    this.dispatchEvent(new CustomEvent("avatarchange", { detail: { dna: this.dna } }));
  }

  // ───────────── Friends ─────────────

  setFriendCode(code) { $("friend-code").textContent = code; }

  setNetStatus(status) { $("net-status").textContent = status; }

  /// friends: [{ code, name, online, color, status? }]
  setFriends(friends) {
    const list = $("friend-list");
    if (friends.length === 0) { list.innerHTML = `<li class="subtitle">no friends yet. share your code!</li>`; return; }
    list.replaceChildren(...friends.map((f) => {
      const li = document.createElement("li");
      li.dataset.avatarId = `friend_${f.code}`;
      li.classList.toggle("selected", li.dataset.avatarId === this.focusedAvatarId);
      li.innerHTML = `<i class="dot"></i><i class="swatch"></i><span></span><em></em>`;
      li.querySelector(".dot").classList.toggle("online", f.online);
      li.querySelector(".swatch").style.background = f.color;
      li.querySelector("span").textContent = f.name;
      li.querySelector("em").textContent = f.status ? statusLine(f.status) : f.online ? "in your plaza" : f.code;
      return li;
    }));
  }

  setPlazaResidents(residents) {
    $("plaza-list").replaceChildren(...residents.map((dna) => {
      const li = document.createElement("li");
      li.dataset.avatarId = dna.id;
      li.innerHTML = `<i class="swatch"></i><span></span>`;
      li.querySelector(".swatch").style.background = dna.shirtColor;
      li.querySelector("span").textContent = dna.name;
      return li;
    }));
  }

  // ───────────── Gamercard ─────────────

  /// Without a card: the local profile. With one: the summary C# built for a clicked plaza avatar.
  async openGamercard(card = null) {
    let stats;
    if (card) {
      $("gc-gamertag").textContent = card.gamertag;
      stats = Object.entries(card.stats ?? {});
      document.querySelector(".gamercard-picture").style.setProperty("--card-color", card.color);
    } else {
      const profile = JSON.parse(await this.backend.GetProfileJson());
      $("gc-gamertag").textContent = profile.gamertag;
      stats = [["games", profile.games], ["launches", profile.launches], ["last played", profile.lastPlayed ?? "—"]];
      document.querySelector(".gamercard-picture").style.setProperty("--card-color", this.dna?.shirtColor ?? "#9bf00b");
    }
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

    $("avatar-options").addEventListener("click", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      const index = Number(li.dataset.index);
      this.focusAvatarOption(index);
      const step = e.target.closest(".step");
      if (step) this.stepAvatarOption(index, Number(step.dataset.step));
    });

    // Click a friend or resident to follow them with the camera; click again to go back to the wide shot.
    for (const list of document.querySelectorAll(".plain-list.selectable")) {
      list.addEventListener("click", (e) => {
        const id = e.target.closest("li")?.dataset.avatarId;
        if (!id) return;
        this.sound("Select");
        this.focusAvatar(id === this.focusedAvatarId ? null : id);
      });
    }
    // Touch: a clear horizontal swipe on the blades (panels, tabs, header) switches blades, like LB/RB. Vertical moves
    // stay native panel scrolling (touch-action: pan-y), so only sideways swipes arrive here as pointer events.
    let swipe = null;
    const stack = $("blade-stack");
    stack.addEventListener("pointerdown", (e) => { swipe = e.pointerType === "touch" ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null; });
    stack.addEventListener("pointercancel", () => { swipe = null; });
    stack.addEventListener("pointerup", (e) => {
      if (!swipe || e.pointerId !== swipe.id) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) this.selectBlade(this.selected + (dx < 0 ? 1 : -1));
    });

    $("collapse-ui").addEventListener("click", () => this.setCollapsed(true));
    $("expand-ui").addEventListener("click", () => this.setCollapsed(false));

    $("add-friend").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("friend-input");
      const code = input.value.trim().toUpperCase();
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) { this.toast("friend codes are 6 letters/digits (no 0, 1, I or O)"); return; }
      input.value = "";
      input.blur();
      this.dispatchEvent(new CustomEvent("connectfriend", { detail: { code } }));
      this.toast(`calling ${code}…`);
    });

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

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
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
