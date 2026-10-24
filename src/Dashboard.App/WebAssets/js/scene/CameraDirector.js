// Moves the plaza camera between per-blade "shots". Critically damped (exponential) easing on both the camera
// position and its look-at point, so retargeting mid-flight never snaps. follow() tracks one avatar instead (friends
// list selection); framing() shifts tracked subjects right of the side panel, or centres them when the UI is hidden.
// On the plaza shot the player can also move the camera (hosts that enable it): a pan across the ground and a zoom
// along the view, applied on top of the shot; resetView() returns to the authored framing.
import * as THREE from "three";

// Follow shot, relative to the followed avatar: behind-and-above, looking at chest height. FRAMING_X moves camera and
// target sideways together so the subject sits right of the side panel.
const FOLLOW = { position: [0, 2.3, 5.2], target: [0, 1.0, 0], fov: 40 };
const FRAMING_X = -1.7;
const DEG = Math.PI / 180;
const PAN_LIMIT = 16;            // metres from the plaza centre the free camera may look at
const ZOOM_RANGE = [0.3, 1.6];   // multiples of the plaza shot's distance

/// Shots are tuned for landscape. In portrait (phones) keep roughly the same horizontal coverage by widening the
/// vertical field of view, capped so it never fish-eyes.
function fitAspect(fov, aspect) {
  if (aspect >= 1.2) return fov;
  const horizontal = 2 * Math.atan(Math.tan((fov * DEG) / 2) * 1.6);
  const vertical = (2 * Math.atan(Math.tan(horizontal / 2) / aspect)) / DEG;
  return Math.min(78, fov + (vertical - fov) * 0.7);
}

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
    this.following = null;      // Object3D the camera tracks, or null for the blade shot
    this.panelVisible = true;   // false while the dashboard is collapsed
    this.userPan = new THREE.Vector3(); // free camera on the plaza shot (see panTo / zoomBy)
    this.userZoom = 1;
    this.userMoved = false;     // once the player has moved the camera, the idle drift stops until resetView()
    this.direct = false;        // true while dragging: the camera follows the hand instantly instead of easing
    this.set("games", true);
  }

  get userShot() { return this.shot === "friends" && !this.following; }

  /// The player takes the camera: the idle drift stops, and wherever it had swayed to becomes part of the pan, so the
  /// view doesn't jump. Call before panning or zooming.
  beginUserControl() {
    this.takeOver();
    if (this.userMoved || !this.userShot) return;
    this.userPan.x += this.driftX ?? 0;
    this.userMoved = true;
    this.applyShot();
  }

  /// Free camera: look at the plaza shot's point shifted by 'pan' (ground plane, clamped to the plaza).
  panTo(pan) {
    this.userPan.set(pan.x, 0, pan.z);
    if (this.userPan.length() > PAN_LIMIT) this.userPan.setLength(PAN_LIMIT);
    this.userMoved = true;
    this.applyShot();
  }

  /// Free camera: multiply the distance from the look-at point (>1 farther, <1 closer).
  zoomBy(factor) {
    this.beginUserControl();
    this.userZoom = THREE.MathUtils.clamp(this.userZoom * factor, ...ZOOM_RANGE);
    this.userMoved = true;
    this.applyShot();
  }

  setZoom(zoom) {
    this.beginUserControl();
    this.userZoom = THREE.MathUtils.clamp(zoom, ...ZOOM_RANGE);
    this.applyShot();
  }

  resetView() {
    this.userPan.set(0, 0, 0);
    this.userZoom = 1;
    this.userMoved = false;
    this.applyShot();
  }

  /// Leaving follow mode by moving the camera: carry on from where the camera is looking, not from the default shot.
  takeOver() {
    if (!this.following) return;
    const base = SHOTS.friends;
    const baseTarget = new THREE.Vector3(...base.target).add(this.focus);
    const baseDistance = new THREE.Vector3(...base.position).sub(new THREE.Vector3(...base.target)).length();
    this.following = null;
    this.shot = "friends";
    this.fov = base.fov;
    this.userZoom = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.lookAt) / baseDistance, ...ZOOM_RANGE);
    this.panTo(this.lookAt.clone().sub(baseTarget));
  }

  /// The camera as the director intends it at rest (not wherever easing has got to): what ground drags are measured
  /// against, so the grabbed point lands exactly under the pointer once the camera settles.
  viewCamera() {
    const view = this.camera.clone();
    view.position.copy(this.position);
    view.fov = fitAspect(this.fov, this.camera.aspect);
    view.updateProjectionMatrix();
    view.lookAt(this.target);
    view.updateMatrixWorld(true);
    return view;
  }

  /// Recompute the plaza shot's position/target with the player's pan and zoom.
  applyShot() {
    if (!this.userShot) return;
    const shot = SHOTS.friends;
    this.target.set(...shot.target).add(this.focus).add(this.userPan);
    const offset = new THREE.Vector3(...shot.position).sub(new THREE.Vector3(...shot.target)).multiplyScalar(this.userZoom);
    this.position.copy(this.target).add(offset);
  }

  /// Track an avatar's root (null returns to the current blade's shot).
  follow(object) {
    this.following = object;
    if (!object) this.set(this.shot);
  }

  /// Whether the side panel covers the left of the screen (tracked subjects are framed to its right).
  /// On narrow screens the panel covers the whole blade, so subjects are centred either way.
  framing(panelVisible) { this.panelVisible = panelVisible; }

  /// Sideways shift for followed subjects: beside the panel on wide screens, centred on phones or with the UI hidden.
  get offsetX() { return this.panelVisible && this.camera.aspect >= 1.2 ? FRAMING_X : 0; }

  set(shotName, immediate = false) {
    const shot = SHOTS[shotName] ?? SHOTS.games;
    this.shot = shotName;
    this.following = null;
    this.position.set(...shot.position).add(this.focus);
    this.target.set(...shot.target).add(this.focus);
    this.fov = shot.fov;
    this.applyShot(); // the plaza shot keeps the player's pan/zoom across blade changes
    if (immediate) {
      this.camera.position.copy(this.position);
      this.lookAt.copy(this.target);
      this.camera.fov = fitAspect(this.fov, this.camera.aspect);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(this.lookAt);
    }
  }

  update(dt, time) {
    const k = this.direct ? 1 : 1 - Math.exp(-dt * 3.2);
    if (this.following) {
      const p = this.following.position;
      this.position.set(p.x + FOLLOW.position[0] + this.offsetX, FOLLOW.position[1], p.z + FOLLOW.position[2]);
      this.target.set(p.x + FOLLOW.target[0] + this.offsetX, FOLLOW.target[1], p.z + FOLLOW.target[2]);
      this.fov = FOLLOW.fov;
    }
    // The wide shot drifts slowly so the plaza feels alive even when nothing moves.
    this.driftX = this.userShot && !this.userMoved ? Math.sin(time * 0.08) * 2.5 : 0;
    const drift = new THREE.Vector3(this.driftX, 0, 0);
    // A sideways glide (position and look-at together), so folding it into the pan on takeover is exact.
    this.camera.position.lerp(drift.clone().add(this.position), k);
    this.lookAt.lerp(drift.add(this.target), k);
    this.camera.lookAt(this.lookAt);
    const fov = fitAspect(this.fov, this.camera.aspect);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * k;
      this.camera.updateProjectionMatrix();
    }
  }
}
