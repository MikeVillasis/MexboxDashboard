// Layer 1: the 3D plaza behind the dashboard: floor, sky, avatars, camera director, click raycasting.
// Phase 4 adds the plaza AI on top of the avatars spawned here.
import * as THREE from "three";
import { AvatarBuilder } from "../avatar/AvatarBuilder.js";
import { RESIDENTS, RESIDENT_SPOTS } from "../avatar/residents.js";
import { CameraDirector } from "./CameraDirector.js";
import { PlazaAI } from "../avatar/AvatarAI.js";
import { FrameMonitor, TIERS, TIER_ORDER } from "./Quality.js";
import { DEFAULT_SKY, SkyDome, SKIES } from "./Sky.js";

const DRAG_THRESHOLD = 6; // px of pointer travel before a press on an avatar becomes a grab

// Lights for tinted (classic) skies; the blade tint supplies sky, floor and light colours on top.
const CLASSIC_LIGHTS = { ground: 0x0a1a05, sun: 0xffffff, sunIntensity: 1.7, hemiIntensity: 1.1 };

const BLADE_TINT = {
  games: { sky: 0x2f7a1a, floor: 0x1f5a10, light: 0xc8ff9a },
  media: { sky: 0x1a5a96, floor: 0x103a66, light: 0xa8d8ff },
  friends: { sky: 0x3a8ac0, floor: 0x3d7a2a, light: 0xffffff },
  avatar: { sky: 0x8a6ac8, floor: 0x4a3a78, light: 0xfff0ff },
  system: { sky: 0x6a6252, floor: 0x4a4436, light: 0xfff0d0 },
};

export class Plaza {
  /// callbacks: { floorClick(x, z), avatarClick(dna) }
  /// options.quality: "high" (default), "medium", "low", or "auto" (start high, step down while frames are slow).
  constructor(canvas, callbacks = {}, { quality = "high" } = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.ai = new PlazaAI();
    this.ai.onEvent = (event, a, b) => callbacks.plazaEvent?.(event, a.avatar, b?.avatar);
    this.press = null; // pointer press in progress: { avatar, x, y, grabbed }
    this.clock = new THREE.Clock();
    this.avatars = new Map(); // id → Avatar
    this.local = null;
    this.spawning = new Map(); // id → Promise<Avatar> while a friend's avatar is being built
    this.roles = new Map();    // id → latest requested { live, asleep, x, z } for a friend
    this.thoughts = new Map(); // id → thought bubble status (applied when the avatar exists or appears)

    this.tier = TIERS[quality] ? quality : "high";
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.tier !== "low", powerPreference: "high-performance" });
    this.renderer.shadowMap.enabled = true;
    // "auto" steps down from high when the device can't hold the frame rate (Discord on a low-end laptop).
    this.monitor = quality === "auto" ? new FrameMonitor((fps) => this.stepDown(fps)) : null;
    this.visibilityCheck = 0;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BLADE_TINT.games.sky);
    this.scene.fog = new THREE.Fog(BLADE_TINT.games.sky, 16, 46);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.director = new CameraDirector(this.camera);

    this.hemi = new THREE.HemisphereLight(BLADE_TINT.games.light, 0x0a1a05, 1.1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    this.sun = sun;
    sun.position.set(5, 11, 8);
    sun.castShadow = true;
    sun.shadow.bias = -0.0005;
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
    this.scene.add(sun);
    this.skyDome = new SkyDome(this.scene);
    this.sky = SKIES[DEFAULT_SKY];
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-4, 3, 6);
    this.scene.add(fill);

    this.floorMaterial = new THREE.MeshStandardMaterial({ color: BLADE_TINT.games.floor, roughness: 0.85 });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), this.floorMaterial);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.marker = this.addMarker();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.builder = new AvatarBuilder().init();

    this.applyTier(this.tier, false);

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => this.setRunning(!document.hidden));
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ───────────── Quality ─────────────

  /// Pixel ratio, shadows and the avatar cap for a tier (see Quality.js). Shadow changes recompile materials once.
  applyTier(name, live = true) {
    const tier = TIERS[name];
    this.tier = name;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.pixelRatio));
    this.renderer.shadowMap.type = tier.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = tier.shadows;
    this.sun.shadow.mapSize.set(tier.shadowSize, tier.shadowSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null; // reallocated at the new size on the next render
    if (live) {
      this.scene.traverse((o) => { for (const m of [o.material].flat()) if (m) m.needsUpdate = true; });
      this.resize();
    }
    this.refreshVisibility();
    this.skyDome?.setDetail(name !== "low");
  }

  /// Switches the plaza sky (see Sky.js). Returns the preset actually applied (unknown names fall back to classic).
  setSky(name) {
    this.sky = this.skyDome.set(name);
    this.floor.scale.setScalar(this.sky.floorScale ?? 1); // some skies make the plaza a smaller rooftop
    this.skyDome.setDetail(this.tier !== "low");
    return this.skyDome.name;
  }

  stepDown(fps) {
    const next = TIER_ORDER[TIER_ORDER.indexOf(this.tier) + 1];
    if (!next) { this.monitor = null; return; }
    console.info(`plaza: ${fps.toFixed(0)} fps, quality ${this.tier} → ${next}`);
    this.applyTier(next);
    this.monitor.reset();
  }

  /// Draws at most the tier's avatar cap, nearest to you first: yourself and whoever the camera follows, live
  /// friends, away members, then residents. Hidden avatars keep their AI (cheap) but skip skinning and drawing.
  refreshVisibility() {
    const cap = TIERS[this.tier].avatarCap;
    const following = this.director.following;
    const rank = (avatar) => {
      if (avatar === this.local || avatar.root === following) return 0;
      const agent = this.ai.get(avatar);
      if (agent?.remote) return 1;
      if (String(avatar.id).startsWith("friend_")) return 2;
      return 3;
    };
    [...this.avatars.values()]
      .sort((a, b) => rank(a) - rank(b))
      .forEach((avatar, i) => { avatar.root.visible = i < cap; });
  }

  // ───────────── Avatars ─────────────

  /// Spawns (or re-dresses) the local player from the recipe C# provided.
  async setLocalAvatar(dna) {
    if (this.local) { await this.local.applyDna(dna); return this.local; }
    const builder = await this.builder;
    this.local = await builder.build(dna);
    this.local.root.position.set(0, 0, 0);
    this.scene.add(this.local.root);
    this.avatars.set(dna.id, this.local);
    this.ai.add(this.local);
    this.ai.setAnchored(this.local, this.blade === "avatar");
    this.local.setThought(this.thoughts.get("local") ?? null);
    return this.local;
  }

  /// A friend's avatar: spawned once, re-dressed on DNA updates. Offline friends roam as NPCs (or nap, when the host
  /// asks for asleep); live ones follow their peer and are woken up.
  ///
  /// Calls can overlap (the away list spawns a napper while the room reports them present): they share one build, and
  /// whichever role was requested last is applied once it's ready, so nobody is left as a duplicate asleep forever.
  ///
  /// Presence beats the away list: a non-live upsert (cached/away recipe) never demotes someone the room says is here;
  /// only setAway (they left) does.
  async upsertFriend(dna, { live = false, asleep = false, x, z } = {}) {
    const previous = this.roles.get(dna.id);
    this.roles.set(dna.id, live || !previous?.live ? { live, asleep: asleep && !live, x, z } : previous);
    // Synchronous check-and-claim: an `await` before claiming would let an overlapping call start a second build.
    let avatar = this.avatars.get(dna.id);
    const pending = avatar ? null : this.spawning.get(dna.id);
    if (pending) {
      avatar = await pending;
      await avatar.applyDna(dna);
    } else if (avatar) {
      await avatar.applyDna(dna);
    } else {
      const spawn = this.spawnFriend(dna, x, z);
      this.spawning.set(dna.id, spawn);
      try { avatar = await spawn; } finally { this.spawning.delete(dna.id); }
    }
    this.applyRole(avatar);
    return avatar;
  }

  async spawnFriend(dna, x, z) {
    const builder = await this.builder;
    const avatar = await builder.build(dna);
    const angle = Math.random() * Math.PI * 2;
    avatar.root.position.set(x ?? Math.cos(angle) * 5, 0, z ?? Math.sin(angle) * 5);
    this.scene.add(avatar.root);
    this.avatars.set(dna.id, avatar);
    this.ai.add(avatar);
    avatar.setThought(this.thoughts.get(dna.id) ?? null);
    return avatar;
  }

  /// What someone is playing / listening to (host presence feed); null clears the bubble. Kept for avatars that spawn
  /// later (an away member's status can arrive before their napping avatar is built).
  setThought(id, status) {
    if (status) this.thoughts.set(id, status);
    else this.thoughts.delete(id);
    this.avatars.get(id)?.setThought(status ?? null);
  }

  /// A friend went away (peer left): no longer driven by their peer; naps or roams as the host prefers.
  setAway(id, asleep) {
    this.roles.set(id, { live: false, asleep });
    const avatar = this.avatars.get(id);
    if (avatar) this.applyRole(avatar);
  }

  applyRole(avatar) {
    const role = this.roles.get(avatar.id);
    if (!role) return;
    this.ai.setAsleep(avatar, role.asleep);
    this.ai.setRemote(avatar, role.live);
    if (role.live && role.x !== undefined) this.ai.walkTo(avatar, role.x, role.z);
  }

  async spawnResidents() {
    const builder = await this.builder;
    await Promise.all(RESIDENTS.map(async (dna, i) => {
      const avatar = await builder.build(dna);
      const [x, z, facing] = RESIDENT_SPOTS[i % RESIDENT_SPOTS.length];
      avatar.root.position.set(x, 0, z);
      avatar.root.rotation.y = facing;
      this.scene.add(avatar.root);
      this.avatars.set(dna.id, avatar);
      this.ai.add(avatar);
    }));
  }

  // ───────────── Interaction ─────────────

  addMarker() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.36, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);
    return ring;
  }

  // Only presses that fell through empty dashboard glass reach the canvas.
  //   press + release on an avatar          → inspect (gamercard via C#)
  //   press + drag on an avatar             → grab: it dangles above the floor point under the pointer, drop on release
  //   press on the floor                    → floor marker (logged to C#)

  setPointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /// The avatar under the pointer: nearest hit among avatar roots (skinned meshes raycast in their posed shape).
  pickAvatar() {
    const roots = [...this.avatars.values()].map((a) => a.root).filter((root) => root.visible);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    if (!hit) return null;
    for (let o = hit.object; o; o = o.parent) {
      const avatar = [...this.avatars.values()].find((a) => a.root === o);
      if (avatar) return avatar;
    }
    return null;
  }

  floorPoint() { return this.raycaster.intersectObject(this.floor)[0]?.point ?? null; }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.setPointer(event);
    const avatar = this.pickAvatar();
    const agent = avatar && this.ai.get(avatar);
    if (agent && (agent.remote || agent.asleep)) { // live friends would desync, nappers stay put: inspect only
      avatar.face.express("happy", 1.2);
      this.callbacks.avatarClick?.(avatar.dna);
      return;
    }
    if (avatar) {
      this.press = { avatar, x: event.clientX, y: event.clientY, grabbed: false };
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    const point = this.floorPoint();
    if (!point) return;
    this.marker.position.set(point.x, 0.01, point.z);
    this.marker.material.opacity = 1;
    this.marker.scale.setScalar(0.4);
    this.callbacks.floorClick?.(point.x, point.z);
  }

  onPointerMove(event) {
    const press = this.press;
    if (!press) {
      // Hover feedback: a grab cursor over avatars.
      this.setPointer(event);
      this.canvas.style.cursor = this.pickAvatar() ? "grab" : "";
      return;
    }
    if (!press.grabbed && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD) {
      press.grabbed = true;
      this.ai.grab(press.avatar);
      this.canvas.style.cursor = "grabbing";
      this.callbacks.grab?.(press.avatar);
    }
    if (press.grabbed) {
      this.setPointer(event);
      const point = this.floorPoint();
      if (point) this.ai.drag(press.avatar, point);
    }
  }

  onPointerUp(event) {
    const press = this.press;
    if (!press) return;
    this.press = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.canvas.style.cursor = "";
    if (press.grabbed) {
      this.ai.drop(press.avatar);
      this.callbacks.drop?.(press.avatar);
    } else if (event.type === "pointerup") {
      press.avatar.face.express("happy", 1.2);
      this.callbacks.avatarClick?.(press.avatar.dna);
    }
  }

  /// Point the camera at one avatar (friends list selection); null or an unknown id returns to the blade shot.
  focusAvatar(id) {
    const avatar = id ? this.avatars.get(id) : null;
    if (avatar) avatar.root.visible = true; // whoever you're looking at is always drawn
    this.director.follow(avatar?.root ?? null);
    avatar?.face.express("happy", 1.2);
    return Boolean(avatar);
  }

  /// Blade change → camera shot + world tint.
  setBlade(blade) {
    this.blade = blade;
    this.tint = BLADE_TINT[blade] ?? BLADE_TINT.games;
    this.director.set(blade);
    // The customiser portrait needs the local avatar home and facing the camera.
    if (this.local) this.ai.setAnchored(this.local, blade === "avatar");
  }

  setRunning(running) {
    this.renderer.setAnimationLoop(running ? () => this.frame() : null);
    if (running) { this.clock.getDelta(); this.monitor?.reset(); } // drop the paused interval, don't judge it
  }

  resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const t = this.clock.elapsedTime;
    this.monitor?.sample(rawDt);
    // Membership changes (joins, leaves, follow) reshuffle who's drawn; once a second is plenty.
    if ((this.visibilityCheck -= dt) <= 0) { this.visibilityCheck = 1; this.refreshVisibility(); }

    this.ai.update(dt);
    for (const avatar of this.avatars.values()) if (avatar.root.visible) avatar.update(dt);
    this.director.update(dt, t);

    if (this.marker.material.opacity > 0) {
      this.marker.material.opacity = Math.max(0, this.marker.material.opacity - dt * 0.8);
      this.marker.scale.setScalar(this.marker.scale.x + dt * 1.6);
    }

    // Ease the world towards its target look: the blade's tint for tinted skies, or the sky preset's fixed look.
    const look = this.sky.tinted
      ? this.tint && { ...CLASSIC_LIGHTS, sky: this.tint.sky, floor: this.tint.floor, light: this.tint.light }
      : this.sky.look;
    if (look) {
      const k = 1 - Math.exp(-dt * 4);
      this.scene.background.lerp(new THREE.Color(look.sky), k);
      this.scene.fog.color.copy(this.scene.background);
      this.floorMaterial.color.lerp(new THREE.Color(look.floor), k);
      this.hemi.color.lerp(new THREE.Color(look.light), k);
      this.hemi.groundColor.lerp(new THREE.Color(look.ground), k);
      this.hemi.intensity += (look.hemiIntensity - this.hemi.intensity) * k;
      this.sun.color.lerp(new THREE.Color(look.sun), k);
      this.sun.intensity += (look.sunIntensity - this.sun.intensity) * k;
    }
    this.skyDome.update(t, this.camera);

    this.renderer.render(this.scene, this.camera);
  }
}
