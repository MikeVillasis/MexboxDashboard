// Layer 1: the 3D plaza behind the dashboard. Phase 2 placeholder: floor, sky, idle stand-in figures, click raycasting.
// Avatars (phase 3) and the plaza AI (phase 4) build on this scene.
import * as THREE from "three";

const BLADE_TINT = {
  games: { sky: 0x2f7a1a, floor: 0x1f5a10, light: 0xc8ff9a },
  media: { sky: 0x1a5a96, floor: 0x103a66, light: 0xa8d8ff },
  system: { sky: 0x6a6252, floor: 0x4a4436, light: 0xfff0d0 },
};

export class Plaza {
  constructor(canvas, onFloorClick) {
    this.canvas = canvas;
    this.onFloorClick = onFloorClick;
    this.clock = new THREE.Clock();
    this.running = true;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    // Cap the backing store: the plaza sits behind blurred glass, full 4K buys nothing but GPU time.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BLADE_TINT.games.sky);
    this.scene.fog = new THREE.Fog(BLADE_TINT.games.sky, 14, 42);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 4.2, 12);
    this.camera.lookAt(0, 1, 0);

    this.hemi = new THREE.HemisphereLight(BLADE_TINT.games.light, 0x0a1a05, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(6, 12, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
    this.scene.add(this.sun);

    this.floorMaterial = new THREE.MeshStandardMaterial({ color: BLADE_TINT.games.floor, roughness: 0.85 });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(30, 64), this.floorMaterial);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.figures = this.addStandIns();
    this.marker = this.addMarker();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    canvas.addEventListener("pointerdown", (e) => this.handleClick(e));
    window.addEventListener("resize", () => this.resize());
    document.addEventListener("visibilitychange", () => this.setRunning(!document.hidden));
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /// Placeholder figures (capsule body + sphere head) until the avatar pipeline exists.
  addStandIns() {
    const colors = [0x9bf00b, 0x5cc3ff, 0xffb347, 0xff6b9d, 0xe8dcc0];
    const bodyGeo = new THREE.CapsuleGeometry(0.32, 0.8, 6, 16);
    const headGeo = new THREE.SphereGeometry(0.3, 24, 16);
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0ac69, roughness: 0.6 });

    return colors.map((color, i) => {
      const figure = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
      body.position.y = 0.72;
      const head = new THREE.Mesh(headGeo, skin);
      head.position.y = 1.62;
      for (const mesh of [body, head]) { mesh.castShadow = true; figure.add(mesh); }

      const angle = (i / colors.length) * Math.PI * 2 + 0.4;
      const radius = 3 + (i % 2) * 2.2;
      figure.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius - 1);
      figure.rotation.y = -angle + Math.PI / 2;
      figure.userData.phase = i * 1.7;
      this.scene.add(figure);
      return figure;
    });
  }

  addMarker() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.36, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    this.scene.add(ring);
    return ring;
  }

  /// Only clicks that fell through empty dashboard glass reach the canvas.
  handleClick(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.floor)[0];
    if (!hit) return;

    this.marker.position.set(hit.point.x, 0.01, hit.point.z);
    this.marker.material.opacity = 1;
    this.marker.scale.setScalar(0.4);
    console.log(`3D canvas click at floor (${hit.point.x.toFixed(2)}, ${hit.point.z.toFixed(2)})`);
    this.onFloorClick?.(hit.point.x, hit.point.z);
  }

  /// Blade change → tint the world to match (smoothly, in frame()). The camera director arrives in phase 3.
  setBlade(blade) {
    this.target = BLADE_TINT[blade] ?? BLADE_TINT.games;
  }

  setRunning(running) {
    this.running = running;
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

    for (const f of this.figures) {
      const p = f.userData.phase;
      f.position.y = Math.abs(Math.sin(t * 1.6 + p)) * 0.06;
      f.rotation.z = Math.sin(t * 0.8 + p) * 0.03;
    }

    if (this.marker.material.opacity > 0) {
      this.marker.material.opacity = Math.max(0, this.marker.material.opacity - dt * 0.8);
      this.marker.scale.setScalar(this.marker.scale.x + dt * 1.6);
    }

    if (this.target) {
      const k = 1 - Math.exp(-dt * 4);
      this.scene.background.lerp(new THREE.Color(this.target.sky), k);
      this.scene.fog.color.copy(this.scene.background);
      this.floorMaterial.color.lerp(new THREE.Color(this.target.floor), k);
      this.hemi.color.lerp(new THREE.Color(this.target.light), k);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
