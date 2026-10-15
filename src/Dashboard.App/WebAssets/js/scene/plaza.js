// Layer 1: the 3D plaza behind the dashboard: floor, sky, avatars, camera director, click raycasting.
// Phase 4 adds the plaza AI on top of the avatars spawned here.
import * as THREE from "three";
import { AvatarBuilder } from "../avatar/AvatarBuilder.js";
import { RESIDENTS, RESIDENT_SPOTS } from "../avatar/residents.js";
import { CameraDirector } from "./CameraDirector.js";
import { PlazaAI } from "../avatar/AvatarAI.js";

const DRAG_THRESHOLD = 6; // px of pointer travel before a press on an avatar becomes a grab

const BLADE_TINT = {
  games: { sky: 0x2f7a1a, floor: 0x1f5a10, light: 0xc8ff9a },
  media: { sky: 0x1a5a96, floor: 0x103a66, light: 0xa8d8ff },
  friends: { sky: 0x3a8ac0, floor: 0x3d7a2a, light: 0xffffff },
  avatar: { sky: 0x8a6ac8, floor: 0x4a3a78, light: 0xfff0ff },
  system: { sky: 0x6a6252, floor: 0x4a4436, light: 0xfff0d0 },
};

export class Plaza {
  /// callbacks: { floorClick(x, z), avatarClick(dna) }
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.ai = new PlazaAI();
    this.ai.onEvent = (event, a, b) => callbacks.plazaEvent?.(event, a.avatar, b?.avatar);
    this.press = null; // pointer press in progress: { avatar, x, y, grabbed }
    this.clock = new THREE.Clock();
    this.avatars = new Map(); // id → Avatar
    this.local = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    // Cap the backing store: the plaza mostly sits behind blurred glass, full 4K buys nothing but GPU time.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BLADE_TINT.games.sky);
    this.scene.fog = new THREE.Fog(BLADE_TINT.games.sky, 16, 46);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.director = new CameraDirector(this.camera);

    this.hemi = new THREE.HemisphereLight(BLADE_TINT.games.light, 0x0a1a05, 1.1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(5, 11, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
    this.scene.add(sun);
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

    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => this.setRunning(!document.hidden));
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
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
    return this.local;
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
    const roots = [...this.avatars.values()].map((a) => a.root);
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
    if (running) this.clock.getDelta(); // drop the paused interval
  }

  resize() {
    const { innerWidth: w, innerHeight: h } = window;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    this.ai.update(dt);
    for (const avatar of this.avatars.values()) avatar.update(dt);
    this.director.update(dt, t);

    if (this.marker.material.opacity > 0) {
      this.marker.material.opacity = Math.max(0, this.marker.material.opacity - dt * 0.8);
      this.marker.scale.setScalar(this.marker.scale.x + dt * 1.6);
    }

    if (this.tint) {
      const k = 1 - Math.exp(-dt * 4);
      this.scene.background.lerp(new THREE.Color(this.tint.sky), k);
      this.scene.fog.color.copy(this.scene.background);
      this.floorMaterial.color.lerp(new THREE.Color(this.tint.floor), k);
      this.hemi.color.lerp(new THREE.Color(this.tint.light), k);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
