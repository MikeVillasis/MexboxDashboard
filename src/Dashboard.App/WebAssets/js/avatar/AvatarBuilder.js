// Modular avatar assembly: one shared skeleton per avatar, body parts as SkinnedMeshes bound to it, swapped
// independently when the DNA recipe changes.
//
// Three kits produce the same Avatar interface (the first whose files exist wins):
//   • GLTF kit  — models/base_rig.glb: the rig is cloned with SkeletonUtils.clone() and part files
//                 (models/{slot}_{id}.glb, e.g. hair_3.glb) are rebound bone-by-name onto the shared skeleton.
//   • Mannequin kit — models/mannequin.glb (activity/tools/build-mannequin.mjs): a segmented mannequin body whose pieces
//                 are rigidly skinned to the procedural skeleton placed at the mannequin's joints; clothing colours
//                 paint its segments, and the procedural hair and face are fitted to its head. Discord Activity only.
//   • Procedural kit — the fallback (the Windows app today): a code-built humanoid skeleton with rigidly skinned
//                 primitive parts, so the whole pipeline works before any art exists.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { FaceController, createFaceTextures } from "./FaceController.js";

// Part catalogue shared by the customiser and both kits. DNA ids index these lists (unknown ids → 0).
export const CATALOG = {
  head: ["round", "wide", "tall", "square"],
  hair: ["bald", "short", "spiky", "long", "mohawk", "bun"],
  torso: ["tee", "long sleeve", "hoodie", "tank top"],
  legs: ["jeans", "shorts", "skirt"],
};

export const PALETTES = {
  skin: ["#FFDBC4", "#F1C27D", "#E0AC69", "#C68642", "#8D5524", "#5C3A1E"],
  hair: ["#2C1B18", "#5A3825", "#A56B46", "#E6C27A", "#B7372A", "#E8E8E8", "#3B5BDB", "#9B30C8"],
  shirt: ["#107C10", "#1B6AC9", "#D83B01", "#FFB900", "#E3008C", "#F2F2F2", "#2D2D2D", "#00B7C3"],
  legs: ["#2B3A55", "#3C3C3C", "#7A5C3E", "#C9B79C", "#5B2A86", "#1F5F3A"],
};

const pick = (list, id) => list[id] ?? list[0];

export const GESTURE_SECONDS = { wave: 1.8, laugh: 1.6, nod: 1.1 };

export class AvatarBuilder {
  constructor() {
    this.kit = null;
  }

  /// Picks the kit once: art if present, procedural otherwise.
  async init() {
    for (const [file, Kit, name] of [["models/base_rig.glb", GltfKit, "GLTF"], ["models/mannequin.glb", MannequinKit, "mannequin"]]) {
      try {
        const probe = await fetch(file, { method: "HEAD" });
        if (!probe.ok) continue;
        this.kit = new Kit();
        await this.kit.init();
        console.info(`avatars: using ${name} kit (${file})`);
        return this;
      } catch (err) {
        console.warn(`avatars: ${name} kit unavailable`, err);
      }
    }
    this.kit = new ProceduralKit();
    console.info("avatars: using procedural kit (no avatar models found)");
    return this;
  }

  /// Returns a ready Avatar for a DNA recipe object.
  async build(dna) {
    const avatar = new Avatar(this.kit);
    await avatar.applyDna(dna);
    return avatar;
  }
}

// ═══════════════════════════════ Avatar ═══════════════════════════════

export class Avatar {
  constructor(kit) {
    this.kit = kit;
    this.root = new THREE.Group();
    this.dna = null;
    this.parts = new Map(); // slot → Object3D
    this.materials = {
      skin: new THREE.MeshStandardMaterial({ roughness: 0.65 }),
      hair: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
      shirt: new THREE.MeshStandardMaterial({ roughness: 0.75 }),
      legs: new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      shoes: new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.5 }),
    };
    this.faceTextures = createFaceTextures();
    this.face = new FaceController(this.faceTextures, 0, 0);
    this.rig = kit.createRig(this.root);
    this.time = Math.random() * 10;
    // Motion state written by the plaza AI each frame and read by the kit's procedural animation.
    this.motion = { walk: 0, walkPhase: 0, gesture: null, gestureTime: 0, dangle: 0, sleep: 0 };
    this.asleep = false;
    this.snore = null; // floating "z z" sprite, created on first nap
    this.thought = null; // thought bubble sprite (what they're playing / listening to), null when there's nothing
  }

  get id() { return this.dna?.id; }

  /// Swaps only what changed: colours are material edits, part ids rebuild that slot's meshes.
  async applyDna(dna) {
    const previous = this.dna;
    this.dna = { ...dna };
    this.materials.skin.color.set(dna.skinColor);
    this.materials.hair.color.set(dna.hairColor);
    this.materials.shirt.color.set(dna.shirtColor);
    this.materials.legs.color.set(dna.legsColor ?? "#2B3A55");
    this.face.setStyles(dna.eyeUV, dna.mouthUV);
    this.root.name = dna.name;

    const slots = {
      body: 0, // skin: neck, arms, hands, bare legs — always present
      head: dna.headId,
      hair: dna.hairId,
      torso: dna.torsoId,
      legs: dna.legsId,
      shoes: 0,
    };
    for (const [slot, id] of Object.entries(slots)) {
      const unchanged = previous && this.parts.has(slot) && partKey(previous, slot) === partKey(dna, slot);
      if (unchanged) continue;
      const part = await this.kit.buildPart(slot, id, this);
      this.replacePart(slot, part);
    }
  }

  replacePart(slot, part) {
    const old = this.parts.get(slot);
    if (old) {
      this.root.remove(old);
      old.traverse((o) => { if (!o.geometry?.userData.shared) o.geometry?.dispose(); }); // kit caches stay alive
    }
    if (part) {
      part.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      this.root.add(part);
      this.parts.set(slot, part);
    } else {
      this.parts.delete(slot);
    }
  }

  /// Napping (away members): sits down, closes eyes, floats a "z z". The pose blends in and out in update().
  setAsleep(asleep) {
    this.asleep = asleep;
    this.face.sleeping = asleep;
    if (asleep && !this.snore) {
      this.snore = new THREE.Sprite(new THREE.SpriteMaterial({ map: snoreTexture(), transparent: true, depthWrite: false, opacity: 0 }));
      this.snore.scale.set(0.42, 0.21, 1);
      this.root.add(this.snore);
    }
  }

  /// Thought bubble from the host's presence feed: { kind: "playing" | "listening" | "watching", text } or null.
  /// Drawn at a constant on-screen size so it stays readable in the wide plaza shot.
  setThought(status) {
    if (this.thought) {
      this.root.remove(this.thought);
      this.thought.material.map.dispose();
      this.thought.material.dispose();
      this.thought = null;
    }
    if (!status?.text) return;
    const { texture, aspect } = thoughtTexture(status);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false });
    this.thought = new THREE.Sprite(material);
    this.thought.center.set(0.18, 0); // the tail (bottom-left) sits over the head
    this.thought.scale.set(0.09 * aspect, 0.09, 1);
    this.thought.renderOrder = 10;
    this.root.add(this.thought);
  }

  /// Plays a gesture ("wave" | "laugh" | "nod") once; the face reacts to match.
  gesture(name) {
    this.onGesture?.(name); // the local avatar's gestures are broadcast to peers
    this.motion.gesture = name;
    this.motion.gestureTime = 0;
    if (name === "laugh") { this.face.express("happy", 1.6); this.face.talk(1.4); }
    else if (name === "wave") this.face.express("happy", 1.4);
    else if (name === "nod") this.face.talk(0.6);
  }

  /// Procedural animation: idle breathing always, then walk / gesture / dangle layers driven by this.motion.
  update(dt) {
    this.time += dt;
    const m = this.motion;
    if (m.gesture) {
      m.gestureTime += dt;
      if (m.gestureTime > GESTURE_SECONDS[m.gesture]) m.gesture = null;
    }
    m.sleep = this.asleep ? Math.min(1, m.sleep + dt * 0.8) : Math.max(0, m.sleep - dt * 2);
    // Bubble over the head; it settles lower while napping, beside the "z z".
    if (this.thought) this.thought.position.set(0.12, 2.0 - m.sleep * 0.5 + Math.sin(this.time * 1.2) * 0.02, 0);
    if (this.snore) {
      this.snore.material.opacity = Math.max(0, m.sleep - 0.5) * 2 * (0.65 + Math.sin(this.time * 1.6) * 0.35);
      this.snore.position.set(0.18, 1.32 + Math.sin(this.time * 0.8) * 0.05, 0.05);
      this.snore.visible = this.snore.material.opacity > 0.01;
    }
    this.face.update(dt);
    this.kit.animate(this.rig, this.time, m);
  }

  dispose() {
    this.root.traverse((o) => { if (!o.geometry?.userData.shared) o.geometry?.dispose(); });
    for (const m of Object.values(this.materials)) m.dispose();
    this.faceTextures.eyes.dispose();
    this.faceTextures.mouth.dispose();
    this.setThought(null);
  }
}

/// Which DNA fields a slot's geometry depends on (head shape also reshapes the face shells).
function partKey(dna, slot) {
  switch (slot) {
    case "head": return `${dna.headId}`;
    case "hair": return `${dna.hairId}|${dna.headId}`;
    case "torso": return `${dna.torsoId}`;
    case "legs": return `${dna.legsId}`;
    default: return "fixed";
  }
}

// ═══════════════════════════════ Procedural kit ═══════════════════════════════

// Bind pose in avatar space (metres, facing +Z). Cartoon proportions: big head, short body, like 360 avatars.
const BONES = [
  ["hips", null, [0, 0.92, 0]],
  ["spine", "hips", [0, 1.04, 0]],
  ["chest", "spine", [0, 1.24, 0]],
  ["neck", "chest", [0, 1.42, 0]],
  ["head", "neck", [0, 1.5, 0]],
  ["upperArm_L", "chest", [0.21, 1.37, 0]],
  ["foreArm_L", "upperArm_L", [0.25, 1.08, 0]],
  ["hand_L", "foreArm_L", [0.27, 0.84, 0.02]],
  ["upperArm_R", "chest", [-0.21, 1.37, 0]],
  ["foreArm_R", "upperArm_R", [-0.25, 1.08, 0]],
  ["hand_R", "foreArm_R", [-0.27, 0.84, 0.02]],
  ["thigh_L", "hips", [0.1, 0.88, 0]],
  ["shin_L", "thigh_L", [0.1, 0.48, 0]],
  ["foot_L", "shin_L", [0.1, 0.08, 0]],
  ["thigh_R", "hips", [-0.1, 0.88, 0]],
  ["shin_R", "thigh_R", [-0.1, 0.48, 0]],
  ["foot_R", "shin_R", [-0.1, 0.08, 0]],
];
const BONE_INDEX = Object.fromEntries(BONES.map(([name], i) => [name, i]));
const P = Object.fromEntries(BONES.map(([name, , pos]) => [name, new THREE.Vector3(...pos)]));
const HEAD_CENTER = new THREE.Vector3(0, 1.71, 0.01);
const HEAD_RADIUS = 0.27;
const HEAD_SCALE = [
  new THREE.Vector3(1, 1, 1),
  new THREE.Vector3(1.1, 0.94, 1),
  new THREE.Vector3(0.93, 1.1, 0.96),
  new THREE.Vector3(1.02, 1, 1),
];

class ProceduralKit {
  /// Joint positions (avatar space) the skeleton is built from; the mannequin kit supplies its own.
  get joints() { return P; }

  createRig(root) {
    const joints = this.joints;
    const bones = BONES.map(([name]) => Object.assign(new THREE.Bone(), { name }));
    BONES.forEach(([name, parent], i) => {
      const bone = bones[i];
      const world = joints[name];
      if (parent) {
        const p = BONE_INDEX[parent];
        bone.position.copy(world).sub(joints[parent]);
        bones[p].add(bone);
      } else {
        bone.position.copy(world);
        root.add(bone);
      }
    });
    // Inverses are taken with the avatar root at the origin; parts bind with an identity bind matrix (see bindPart).
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    return { skeleton, bones: Object.fromEntries(bones.map((b) => [b.name, b])), rest: bones.map((b) => b.quaternion.clone()), restHipsY: joints.hips.y };
  }

  async buildPart(slot, id, avatar) {
    const m = avatar.materials;
    const s = avatar.rig.skeleton;
    switch (slot) {
      case "body": return group(bindPart(bodyGeometry(), m.skin, s));
      case "head": return headPart(id, avatar);
      case "hair": return hairPart(id, avatar.dna.headId, m.hair, s);
      case "torso": return group(bindPart(torsoGeometry(id), m.shirt, s));
      case "legs": return group(bindPart(legsGeometry(id), m.legs, s));
      case "shoes": return group(bindPart(shoesGeometry(), m.shoes, s));
    }
    return null;
  }

  /// Layers, each written absolutely every frame: idle → walk (blended by m.walk) → gesture → dangle (blended).
  animate(rig, t, m) {
    const b = rig.bones;
    for (const bone of Object.values(b)) bone.rotation.set(0, 0, 0);

    // Idle.
    b.chest.rotation.x = Math.sin(t * 1.9) * 0.025;
    b.spine.rotation.z = Math.sin(t * 0.7) * 0.02;
    b.head.rotation.y = Math.sin(t * 0.45) * 0.18 * (1 - m.walk);
    b.head.rotation.x = Math.sin(t * 0.9 + 1) * 0.04;
    b.upperArm_L.rotation.z = 0.06 + Math.sin(t * 1.3) * 0.04;
    b.upperArm_R.rotation.z = -0.06 - Math.sin(t * 1.3 + 0.5) * 0.04;
    b.foreArm_L.rotation.x = -0.12;
    b.foreArm_R.rotation.x = -0.12;

    // Walk: legs and opposite arms swing with the stride phase.
    if (m.walk > 0.001) {
      const p = m.walkPhase;
      const w = m.walk;
      b.thigh_L.rotation.x = Math.sin(p) * 0.55 * w;
      b.thigh_R.rotation.x = -Math.sin(p) * 0.55 * w;
      b.shin_L.rotation.x = Math.max(0, -Math.sin(p + 0.9)) * 0.7 * w;
      b.shin_R.rotation.x = Math.max(0, Math.sin(p + 0.9)) * 0.7 * w;
      b.upperArm_L.rotation.x = -Math.sin(p) * 0.45 * w;
      b.upperArm_R.rotation.x = Math.sin(p) * 0.45 * w;
      b.spine.rotation.y = Math.sin(p) * 0.08 * w;
      b.hips.position.y = rig.restHipsY + Math.abs(Math.cos(p)) * 0.03 * w;
    } else {
      b.hips.position.y = rig.restHipsY;
    }

    // Gestures.
    const g = m.gesture;
    const k = g ? envelope(m.gestureTime, GESTURE_SECONDS[g]) : 0;
    if (g === "wave") {
      b.upperArm_R.rotation.z = lerp(b.upperArm_R.rotation.z, -2.7, k);
      b.foreArm_R.rotation.x = lerp(-0.12, 0, k);
      b.foreArm_R.rotation.z = Math.sin(t * 13) * 0.45 * k;
      b.head.rotation.z = 0.08 * k;
    } else if (g === "laugh") {
      b.chest.rotation.x = lerp(b.chest.rotation.x, -0.18 + Math.sin(t * 22) * 0.05, k);
      b.head.rotation.x = lerp(b.head.rotation.x, -0.25, k);
      b.upperArm_L.rotation.z = lerp(b.upperArm_L.rotation.z, 0.35, k);
      b.upperArm_R.rotation.z = lerp(b.upperArm_R.rotation.z, -0.35, k);
      b.foreArm_L.rotation.x = lerp(-0.12, -1.2, k);
      b.foreArm_R.rotation.x = lerp(-0.12, -1.2, k);
    } else if (g === "nod") {
      b.head.rotation.x = Math.sin(m.gestureTime * 9) * 0.28 * k;
    }

    // Dangle (held by the pointer): arms up, legs kicking, head lolling.
    if (m.dangle > 0.001) {
      const d = m.dangle;
      b.upperArm_L.rotation.z = lerp(b.upperArm_L.rotation.z, 2.5, d);
      b.upperArm_R.rotation.z = lerp(b.upperArm_R.rotation.z, -2.5, d);
      b.thigh_L.rotation.x = Math.sin(t * 7) * 0.45 * d;
      b.thigh_R.rotation.x = -Math.sin(t * 7) * 0.45 * d;
      b.shin_L.rotation.x = (0.4 + Math.sin(t * 7 + 1) * 0.3) * d;
      b.shin_R.rotation.x = (0.4 - Math.sin(t * 7 + 1) * 0.3) * d;
      b.head.rotation.z = Math.sin(t * 2.5) * 0.25 * d;
    }

    // Asleep (away members): sitting on the floor, legs out, slumped forward, slow breathing.
    if (m.sleep > 0.001) {
      const s = m.sleep;
      const breathe = Math.sin(t * 1.1) * 0.03;
      b.hips.position.y = lerp(b.hips.position.y, 0.2, s);
      b.thigh_L.rotation.x = lerp(b.thigh_L.rotation.x, -1.45, s);
      b.thigh_R.rotation.x = lerp(b.thigh_R.rotation.x, -1.45, s);
      b.thigh_L.rotation.z = lerp(b.thigh_L.rotation.z, 0.12, s);
      b.thigh_R.rotation.z = lerp(b.thigh_R.rotation.z, -0.12, s);
      b.shin_L.rotation.x = lerp(b.shin_L.rotation.x, 0.3, s);
      b.shin_R.rotation.x = lerp(b.shin_R.rotation.x, 0.3, s);
      b.spine.rotation.x = lerp(b.spine.rotation.x, 0.25, s);
      b.chest.rotation.x = lerp(b.chest.rotation.x, 0.2 + breathe, s);
      b.head.rotation.x = lerp(b.head.rotation.x, 0.5, s);
      b.head.rotation.y *= 1 - s;
      b.head.rotation.z = lerp(b.head.rotation.z, 0.15, s);
      b.upperArm_L.rotation.x = lerp(b.upperArm_L.rotation.x, -0.55, s);
      b.upperArm_R.rotation.x = lerp(b.upperArm_R.rotation.x, -0.55, s);
      b.foreArm_L.rotation.x = lerp(b.foreArm_L.rotation.x, -0.6, s);
      b.foreArm_R.rotation.x = lerp(b.foreArm_R.rotation.x, -0.6, s);
    }
  }
}

const THOUGHT_ICON = { playing: "\u{1F3AE}", listening: "\u{1F3B5}", watching: "\u{1F4FA}" };

/// A cloud-shaped thought bubble with trailing puffs, an icon and one line of text (lowercase UI copy for the verb,
/// the game/song as Discord reports it).
function thoughtTexture({ kind, text }) {
  const scale = 2; // drawn at 2x for crisp text
  const font = `600 ${22 * scale}px 'Segoe UI', system-ui, sans-serif`;
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = font;
  const label = `${THOUGHT_ICON[kind] ?? ""} ${text}`;
  const textWidth = Math.min(measure.measureText(label).width, 360 * scale);
  const pad = 18 * scale;
  const bubbleW = textWidth + pad * 2;
  const bubbleH = 46 * scale;
  const tail = 30 * scale; // room below the bubble for the trailing puffs
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(bubbleW + 8 * scale);
  canvas.height = Math.ceil(bubbleH + tail + 8 * scale);
  const ctx = canvas.getContext("2d");
  const x0 = 4 * scale;
  const y0 = 4 * scale;

  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.roundRect(x0, y0, bubbleW, bubbleH, bubbleH / 2);
  ctx.fill();
  ctx.stroke();
  for (const [cx, cy, r] of [[0.2, 1.22, 7], [0.13, 1.5, 4.5]]) { // puffs trailing down towards the head
    ctx.beginPath();
    ctx.arc(x0 + bubbleW * cx, y0 + bubbleH * cy, r * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.font = font;
  ctx.fillStyle = "#1d1d1d";
  ctx.textBaseline = "middle";
  let shown = label;
  while (ctx.measureText(shown).width > textWidth && shown.length > 4) shown = `${shown.slice(0, -2)}…`;
  ctx.fillText(shown, x0 + pad, y0 + bubbleH / 2 + scale);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, aspect: canvas.width / canvas.height };
}

/// Shared "z z" texture for napping avatars (drawn once).
let snoreMap = null;
function snoreTexture() {
  if (snoreMap) return snoreMap;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.lineWidth = 4;
  for (const [text, x, y, size] of [["z", 18, 54, 26], ["z", 52, 40, 32], ["Z", 88, 30, 40]]) {
    ctx.font = `600 ${size}px 'Segoe UI', system-ui, sans-serif`;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  snoreMap = new THREE.CanvasTexture(canvas);
  snoreMap.colorSpace = THREE.SRGBColorSpace;
  return snoreMap;
}

// ── Geometry helpers (all in bind-pose avatar space, rigidly weighted to one bone each) ──

const UP = new THREE.Vector3(0, 1, 0);

/// A tapered cylinder from point a to b.
function segment(a, b, rA, rB, radial = 14) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const geo = new THREE.CylinderGeometry(rB, rA, dir.length(), radial, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  geo.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return geo;
}

function sphere(center, r, scale = new THREE.Vector3(1, 1, 1), w = 20, h = 14) {
  const geo = new THREE.SphereGeometry(r, w, h);
  geo.applyMatrix4(new THREE.Matrix4().compose(center, new THREE.Quaternion(), scale));
  return geo;
}

function at(geo, x, y, z) { geo.translate(x, y, z); return geo; }

/// Rigid skinning: every vertex 100 % on one bone.
function weighted(geo, bone) {
  const n = geo.attributes.position.count;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { index[i * 4] = BONE_INDEX[bone]; weight[i * 4] = 1; }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
  return geo;
}

function merge(pieces) {
  const list = pieces.map(([geo, bone]) => {
    const g = geo.index ? geo : geo; // all three.js primitives used here are indexed
    return weighted(g, bone);
  });
  const merged = mergeGeometries(list, false);
  list.forEach((g) => g.dispose());
  return merged;
}

/// Identity bind matrix: with bindMode "attached" three.js re-derives bindMatrixInverse from the mesh's world matrix
/// every frame, so parts rebuilt after the avatar has moved still line up with the shared skeleton.
function bindPart(geometry, material, skeleton) {
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.bind(skeleton, new THREE.Matrix4());
  return mesh;
}

function lerp(a, b, k) { return a + (b - a) * k; }

/// 0 → 1 → 0 over a gesture's duration with ~0.25 s ease in and out.
function envelope(time, total) {
  const ramp = 0.25;
  return Math.min(1, time / ramp, Math.max(0, (total - time) / ramp));
}

function group(...objects) { const g = new THREE.Group(); objects.forEach((o) => o && g.add(o)); return g; }

function arm(side, upperR, foreR) {
  const s = side;
  return [
    [segment(P[`upperArm_${s}`], P[`foreArm_${s}`], upperR, upperR * 0.9), `upperArm_${s}`],
    [segment(P[`foreArm_${s}`], P[`hand_${s}`], foreR, foreR * 0.85), `foreArm_${s}`],
  ];
}

function bodyGeometry() {
  return merge([
    [segment(P.chest.clone().setY(1.36), P.head.clone().setY(1.52), 0.075, 0.07), "neck"],
    ...arm("L", 0.062, 0.055), ...arm("R", 0.062, 0.055),
    [sphere(P.hand_L.clone().add(new THREE.Vector3(0.005, -0.06, 0)), 0.07, new THREE.Vector3(0.9, 1.1, 0.8)), "hand_L"],
    [sphere(P.hand_R.clone().add(new THREE.Vector3(-0.005, -0.06, 0)), 0.07, new THREE.Vector3(0.9, 1.1, 0.8)), "hand_R"],
    // Bare legs; clothing parts sit slightly outside these.
    [segment(P.thigh_L, P.shin_L, 0.085, 0.07), "thigh_L"],
    [segment(P.shin_L, P.foot_L, 0.068, 0.055), "shin_L"],
    [segment(P.thigh_R, P.shin_R, 0.085, 0.07), "thigh_R"],
    [segment(P.shin_R, P.foot_R, 0.068, 0.055), "shin_R"],
  ]);
}

function torsoGeometry(id) {
  const style = id % CATALOG.torso.length;
  const pieces = [
    // Rounded trunk: chest to hips.
    [at(new THREE.CapsuleGeometry(0.19, 0.3, 8, 18).scale(1, 1, 0.78), 0, 1.18, 0), "chest"],
    [at(new THREE.CylinderGeometry(0.175, 0.16, 0.22, 18).scale(1, 1, 0.8), 0, 0.98, 0), "spine"],
  ];
  if (style === 0 || style === 1 || style === 2) { // sleeves
    for (const s of ["L", "R"]) {
      const shoulder = P[`upperArm_${s}`];
      const elbow = P[`foreArm_${s}`];
      const sleeveEnd = style === 0 ? shoulder.clone().lerp(elbow, 0.55) : elbow;
      pieces.push([segment(shoulder, sleeveEnd, 0.085, 0.078), `upperArm_${s}`]);
      pieces.push([sphere(shoulder, 0.088), `upperArm_${s}`]);
      if (style !== 0) pieces.push([segment(elbow, P[`hand_${s}`].clone().lerp(elbow, 0.12), 0.074, 0.066), `foreArm_${s}`]);
    }
  }
  if (style === 2) { // hood bunched behind the neck
    pieces.push([at(new THREE.TorusGeometry(0.12, 0.05, 10, 24).rotateX(Math.PI / 2 - 0.25).scale(1.2, 1, 1), 0, 1.4, -0.06), "chest"]);
  }
  return merge(pieces);
}

function legsGeometry(id) {
  const style = id % CATALOG.legs.length;
  const pieces = [[at(new THREE.CylinderGeometry(0.17, 0.18, 0.14, 18).scale(1, 1, 0.82), 0, 0.88, 0), "hips"]];
  for (const s of ["L", "R"]) {
    if (style === 0) { // jeans
      pieces.push([segment(P[`thigh_${s}`], P[`shin_${s}`], 0.1, 0.085), `thigh_${s}`]);
      pieces.push([segment(P[`shin_${s}`], P[`foot_${s}`].clone().setY(0.12), 0.083, 0.075), `shin_${s}`]);
    } else if (style === 1) { // shorts
      pieces.push([segment(P[`thigh_${s}`], P[`thigh_${s}`].clone().lerp(P[`shin_${s}`], 0.65), 0.1, 0.092), `thigh_${s}`]);
    }
  }
  if (style === 2) { // skirt
    pieces.push([at(new THREE.CylinderGeometry(0.17, 0.27, 0.36, 22, 1, true), 0, 0.72, 0), "hips"]);
  }
  return merge(pieces);
}

function shoesGeometry() {
  return merge(["L", "R"].map((s) => [
    at(new THREE.CapsuleGeometry(0.065, 0.12, 6, 12).rotateX(Math.PI / 2).scale(1, 0.75, 1), P[`foot_${s}`].x, 0.055, 0.05),
    `foot_${s}`,
  ]));
}

function headPart(id, avatar) {
  const scale = HEAD_SCALE[id] ?? HEAD_SCALE[0];
  const s = avatar.rig.skeleton;
  const m = avatar.materials;
  const head = sphere(HEAD_CENTER, HEAD_RADIUS, scale, 32, 24);
  const ears = ["L", "R"].map((side) => sphere(
    new THREE.Vector3((side === "L" ? 1 : -1) * HEAD_RADIUS * scale.x * 0.97, HEAD_CENTER.y - 0.02, 0),
    0.055, new THREE.Vector3(0.5, 1, 0.8), 10, 8));
  const nose = sphere(new THREE.Vector3(0, HEAD_CENTER.y - 0.04, HEAD_CENTER.z + HEAD_RADIUS * scale.z * 0.98), 0.035, new THREE.Vector3(1, 0.9, 0.8), 10, 8);
  const skinMesh = bindPart(merge([[head, "head"], ...ears.map((e) => [e, "head"]), [nose, "head"]]), m.skin, s);

  // Face shells: patches of a sphere just outside the head, textured from the UV atlases.
  const eyes = faceShell(scale, Math.PI * 0.3, Math.PI * 0.4, Math.PI * 0.34, Math.PI * 0.16, avatar.faceTextures.eyes, s);
  const mouth = faceShell(scale, Math.PI * 0.39, Math.PI * 0.22, Math.PI * 0.58, Math.PI * 0.12, avatar.faceTextures.mouth, s);
  return group(skinMesh, eyes, mouth);
}

/// A front-facing patch of a slightly larger sphere (phi centred on +Z), carrying a transparent atlas texture.
function faceShell(scale, phiStart, phiLength, thetaStart, thetaLength, texture, skeleton) {
  const geo = new THREE.SphereGeometry(HEAD_RADIUS * 1.012, 16, 8, phiStart, phiLength, thetaStart, thetaLength);
  geo.applyMatrix4(new THREE.Matrix4().compose(HEAD_CENTER, new THREE.Quaternion(), scale));
  const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.6, depthWrite: false });
  const mesh = bindPart(weighted(geo, "head"), material, skeleton);
  mesh.renderOrder = 1;
  return mesh;
}

function hairPart(id, headId, material, skeleton) {
  const style = id % CATALOG.hair.length;
  if (style === 0) return null; // bald
  const scale = HEAD_SCALE[headId] ?? HEAD_SCALE[0];
  const r = HEAD_RADIUS * 1.06;
  const cap = () => {
    const geo = new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.42);
    geo.rotateX(-0.28); // sweep back so the fringe clears the eyes
    geo.applyMatrix4(new THREE.Matrix4().compose(HEAD_CENTER.clone().add(new THREE.Vector3(0, 0.01, -0.015)), new THREE.Quaternion(), scale));
    return geo;
  };
  const top = HEAD_CENTER.y + HEAD_RADIUS * scale.y;
  const pieces = [];
  switch (style) {
    case 1: pieces.push(cap()); break;
    case 2: // spiky
      pieces.push(cap());
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const spike = new THREE.ConeGeometry(0.06, 0.16, 8);
        const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(a) * 0.7 - 0.3, 0, -Math.cos(a) * 0.7));
        spike.applyMatrix4(new THREE.Matrix4().compose(
          new THREE.Vector3(Math.cos(a) * 0.11 * scale.x, top - 0.02, Math.sin(a) * 0.11 - 0.03), tilt, new THREE.Vector3(1, 1, 1)));
        pieces.push(spike);
      }
      break;
    case 3: // long
      pieces.push(cap());
      pieces.push(at(new THREE.CylinderGeometry(0.24 * scale.x, 0.2 * scale.x, 0.42, 22, 1, true, Math.PI * 0.62, Math.PI * 1.76), 0, HEAD_CENTER.y - 0.12, -0.02));
      break;
    case 4: // mohawk
      pieces.push(at(new THREE.BoxGeometry(0.06, 0.12, r * 1.7), 0, top + 0.02, -0.02));
      break;
    case 5: // bun
      pieces.push(cap());
      pieces.push(sphere(new THREE.Vector3(0, top - 0.04, -0.2 * scale.z), 0.1));
      break;
  }
  return group(bindPart(merge(pieces.map((g) => [g, "head"])), material, skeleton));
}

// ═══════════════════════════════ Mannequin kit ═══════════════════════════════
// models/mannequin.glb: one mesh per bone (node named after the bone) in avatar space, plus scene extras with the
// joints and the head's centre/radii. Pieces are rigidly skinned like the procedural parts, so every animation layer
// (walk, gestures, dangle, sleep) works unchanged. Body model: "sculpting a human body" by Animation-class-k, CC-BY-4.0.

// Which segments each clothing style paints; anything in the slot's region that isn't painted shows skin.
const MANNEQUIN_TORSO = [ // index = torsoId: tee, long sleeve, hoodie, tank top
  { shirt: ["chest", "spine", "upperArm_L", "upperArm_R"], skin: ["foreArm_L", "foreArm_R"] },
  { shirt: ["chest", "spine", "upperArm_L", "upperArm_R", "foreArm_L", "foreArm_R"], skin: [] },
  { shirt: ["chest", "spine", "upperArm_L", "upperArm_R", "foreArm_L", "foreArm_R"], skin: [], hood: true },
  { shirt: ["chest", "spine"], skin: ["upperArm_L", "upperArm_R", "foreArm_L", "foreArm_R"] },
];
const MANNEQUIN_LEGS = [ // index = legsId: jeans, shorts, skirt
  { legs: ["hips", "thigh_L", "thigh_R", "shin_L", "shin_R"], skin: [] },
  { legs: ["hips", "thigh_L", "thigh_R"], skin: ["shin_L", "shin_R"] },
  { legs: ["hips"], skin: ["thigh_L", "thigh_R", "shin_L", "shin_R"], skirt: true },
];

class MannequinKit extends ProceduralKit {
  async init() {
    const gltf = await new GLTFLoader().loadAsync("models/mannequin.glb");
    const extras = gltf.scene.userData;
    this.positions = Object.fromEntries(Object.entries(extras.joints).map(([bone, v]) => [bone, new THREE.Vector3(...v)]));
    this.headCenter = new THREE.Vector3(...extras.headCenter);
    this.headRadii = new THREE.Vector3(...extras.headRadii);
    this.pieces = new Map();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const geo = o.geometry.clone();
      geo.computeVertexNormals();
      this.pieces.set(o.name, geo);
    });
    this.cache = new Map(); // "slot|style|role" → shared, already-weighted geometry
  }

  get joints() { return this.positions; }

  /// Merged, rigidly weighted geometry for a list of bone pieces (+ extra [geometry, bone] pairs), cached and shared
  /// by every avatar wearing the same thing.
  region(key, bones, extra = []) {
    if (this.cache.has(key)) return this.cache.get(key);
    // Indexed throughout (smooth shading); extras drop their UVs so every piece has the same attributes to merge.
    const parts = [
      ...bones.map((bone) => [this.pieces.get(bone).clone(), bone]),
      ...extra.map(([g, bone]) => { g.deleteAttribute("uv"); return [g, bone]; }),
    ];
    const geo = parts.length ? merge(parts) : null;
    if (geo) geo.userData.shared = true;
    this.cache.set(key, geo);
    return geo;
  }

  /// Procedural head-space (HEAD_CENTER, HEAD_RADIUS) → the mannequin's head, so hair and face shells fit it.
  headFit(pad = 1) {
    const r = this.headRadii.clone().multiplyScalar(pad / HEAD_RADIUS);
    return new THREE.Matrix4().makeTranslation(this.headCenter.x, this.headCenter.y, this.headCenter.z)
      .multiply(new THREE.Matrix4().makeScale(r.x, r.y, r.z))
      .multiply(new THREE.Matrix4().makeTranslation(-HEAD_CENTER.x, -HEAD_CENTER.y, -HEAD_CENTER.z));
  }

  async buildPart(slot, id, avatar) {
    const m = avatar.materials;
    const s = avatar.rig.skeleton;
    const mesh = (geo, material) => (geo ? bindPart(geo, material, s) : null);
    switch (slot) {
      case "body": return group(mesh(this.region("body", ["neck", "hand_L", "hand_R"]), m.skin));
      case "shoes": return group(mesh(this.region("shoes", ["foot_L", "foot_R"]), m.shoes));
      case "head": {
        const style = HEAD_SCALE[id] ? id : 0;
        const scale = HEAD_SCALE[style];
        // Head shape: stretch the mannequin's head about its centre (same factors as the procedural heads).
        const shape = new THREE.Matrix4().makeTranslation(this.headCenter.x, this.headCenter.y, this.headCenter.z)
          .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
          .multiply(new THREE.Matrix4().makeTranslation(-this.headCenter.x, -this.headCenter.y, -this.headCenter.z));
        const key = `head|${style}`;
        if (!this.cache.has(key)) {
          const geo = merge([[this.pieces.get("head").clone().applyMatrix4(shape), "head"]]);
          geo.userData.shared = true;
          this.cache.set(key, geo);
        }
        // Face shells: the procedural ones (eyes/mouth atlases), fitted a touch outside the egg-shaped head.
        const fit = this.headFit(1.06);
        const eyes = faceShell(scale, Math.PI * 0.3, Math.PI * 0.4, Math.PI * 0.34, Math.PI * 0.16, avatar.faceTextures.eyes, s);
        const mouth = faceShell(scale, Math.PI * 0.39, Math.PI * 0.22, Math.PI * 0.58, Math.PI * 0.12, avatar.faceTextures.mouth, s);
        for (const shell of [eyes, mouth]) shell.geometry.applyMatrix4(fit);
        return group(mesh(this.cache.get(key), m.skin), eyes, mouth);
      }
      case "hair": {
        const hair = hairPart(id, avatar.dna.headId, m.hair, s);
        hair?.traverse((o) => o.geometry?.applyMatrix4(this.headFit(1.0)));
        return hair;
      }
      case "torso": {
        const style = id % MANNEQUIN_TORSO.length;
        const look = MANNEQUIN_TORSO[style];
        const hood = look.hood ? [[at(new THREE.TorusGeometry(0.07, 0.03, 8, 20).rotateX(Math.PI / 2 - 0.25).scale(1.2, 1, 1),
          0, this.positions.neck.y - 0.03, this.positions.neck.z - 0.05), "chest"]] : [];
        return group(
          mesh(this.region(`torso|${style}|shirt`, look.shirt, hood), m.shirt),
          mesh(this.region(`torso|${style}|skin`, look.skin), m.skin),
        );
      }
      case "legs": {
        const style = id % MANNEQUIN_LEGS.length;
        const look = MANNEQUIN_LEGS[style];
        const hips = this.positions.hips;
        const skirt = look.skirt ? [[at(new THREE.CylinderGeometry(0.15, 0.24, 0.36, 22, 1, true), 0, hips.y - 0.12, hips.z), "hips"]] : [];
        return group(
          mesh(this.region(`legs|${style}|legs`, look.legs, skirt), m.legs),
          mesh(this.region(`legs|${style}|skin`, look.skin), m.skin),
        );
      }
    }
    return null;
  }
}

// ═══════════════════════════════ GLTF kit ═══════════════════════════════
// Expected art: models/base_rig.glb (armature + optional default skin) and models/{slot}_{id}.glb part files whose
// SkinnedMeshes are weighted to bones with the same names. Materials named skin/hair/shirt/legs are tinted from DNA;
// materials named face_eyes / face_mouth receive the UV atlases.

class GltfKit {
  async init() {
    this.loader = new GLTFLoader();
    this.base = await this.loader.loadAsync("models/base_rig.glb");
    this.cache = new Map();
  }

  createRig(root) {
    const rig = SkeletonUtils.clone(this.base.scene);
    root.add(rig);
    const bones = {};
    rig.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    root.updateMatrixWorld(true);
    return { bones, find: (re) => Object.values(bones).find((b) => re.test(b.name)) };
  }

  async load(url) {
    if (!this.cache.has(url)) this.cache.set(url, this.loader.loadAsync(url).catch(() => null));
    return this.cache.get(url);
  }

  async buildPart(slot, id, avatar) {
    const gltf = (await this.load(`models/${slot}_${id}.glb`)) ?? (await this.load(`models/${slot}_0.glb`));
    if (!gltf) return null;
    const part = new THREE.Group();
    gltf.scene.traverse((source) => {
      if (!source.isSkinnedMesh) return;
      const bones = source.skeleton.bones.map((b) => avatar.rig.bones[b.name]);
      if (bones.some((b) => !b)) { console.warn(`avatars: ${slot}_${id} references bones missing from the rig`); return; }
      const mesh = new THREE.SkinnedMesh(source.geometry, this.material(source.material, avatar));
      mesh.bind(new THREE.Skeleton(bones, source.skeleton.boneInverses), source.bindMatrix);
      part.add(mesh);
    });
    return part;
  }

  material(source, avatar) {
    const name = (source.name || "").toLowerCase();
    if (name === "face_eyes") return Object.assign(source.clone(), { map: avatar.faceTextures.eyes, transparent: true });
    if (name === "face_mouth") return Object.assign(source.clone(), { map: avatar.faceTextures.mouth, transparent: true });
    return avatar.materials[name] ?? source;
  }

  /// Without clips in the art yet, GLTF avatars only get the idle layer; walk/gesture need authored animations.
  animate(rig, t) {
    const head = rig.find(/head/i);
    const chest = rig.find(/spine2|chest|upperchest/i);
    if (head) head.rotation.y = Math.sin(t * 0.45) * 0.18;
    if (chest) chest.rotation.x = Math.sin(t * 1.9) * 0.025;
  }
}
