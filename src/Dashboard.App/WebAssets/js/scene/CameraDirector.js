// Moves the plaza camera between per-blade "shots". Critically damped (exponential) easing on both the camera
// position and its look-at point, so retargeting mid-flight never snaps.
import * as THREE from "three";

// Shots are relative to the local avatar's position (it stands at the plaza centre).
const SHOTS = {
  // Waist-up portrait. The look-at point sits left of the avatar so it frames on the right, beside the customiser panel.
  avatar: { position: [-0.62, 1.45, 3.3], target: [-0.64, 1.28, 0], fov: 36 },
  // Wide plaza: everyone in view.
  friends: { position: [0, 7.5, 16], target: [0, 0.6, -1], fov: 42 },
  games: { position: [0, 3.4, 10.5], target: [0, 1.1, 0], fov: 42 },
  media: { position: [-5.5, 2.4, 7.5], target: [0, 1.2, 0], fov: 42 },
  system: { position: [6, 3, 8.5], target: [0, 1, 0], fov: 42 },
};

export class CameraDirector {
  constructor(camera, focus = new THREE.Vector3()) {
    this.camera = camera;
    this.focus = focus;
    this.position = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.fov = camera.fov;
    this.set("games", true);
  }

  set(shotName, immediate = false) {
    const shot = SHOTS[shotName] ?? SHOTS.games;
    this.shot = shotName;
    this.position.set(...shot.position).add(this.focus);
    this.target.set(...shot.target).add(this.focus);
    this.fov = shot.fov;
    if (immediate) {
      this.camera.position.copy(this.position);
      this.lookAt.copy(this.target);
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.lookAt);
    }
  }

  update(dt, time) {
    const k = 1 - Math.exp(-dt * 3.2);
    // The wide shot drifts slowly so the plaza feels alive even when nothing moves.
    const drift = this.shot === "friends" ? new THREE.Vector3(Math.sin(time * 0.08) * 2.5, 0, 0) : new THREE.Vector3();
    this.camera.position.lerp(drift.add(this.position), k);
    this.lookAt.lerp(this.target, k);
    this.camera.lookAt(this.lookAt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov += (this.fov - this.camera.fov) * k;
      this.camera.updateProjectionMatrix();
    }
  }
}
