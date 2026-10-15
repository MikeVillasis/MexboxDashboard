// Modular avatar assembly: one shared skeleton per avatar, body parts as SkinnedMeshes bound to it, swapped
// independently when the DNA recipe changes.
//
// Two kits produce the same Avatar interface:
//   • GLTF kit  — used when WebAssets/models/base_rig.glb exists: the rig is cloned with SkeletonUtils.clone() and part
//                 files (models/{slot}_{id}.glb, e.g. hair_3.glb) are rebound bone-by-name onto the shared skeleton.
//   • Procedural kit — the fallback (and today's default): a code-built humanoid skeleton with rigidly skinned
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
    try {
      const probe = await fetch("models/base_rig.glb", { method: "HEAD" });
      if (probe.ok) {
        this.kit = new GltfKit();
        await this.kit.init();
        console.info("avatars: using GLTF kit (models/base_rig.glb)");
        return this;
      }
    } catch (err) {
      console.warn("avatars: GLTF kit unavailable, using procedural kit", err);
    }
    this.kit = new ProceduralKit();
    console.info("avatars: using procedural kit (no models/base_rig.glb)");
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
    this.motion = { walk: 0, walkPhase: 0, gesture: null, gestureTime: 0, dangle: 0 };
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
      old.traverse((o) => o.geometry?.dispose());
    }
    if (part) {
      part.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      this.root.add(part);
      this.parts.set(slot, part);
    } else {
      this.parts.delete(slot);
    }
  }

  /// Plays a gesture ("wave" | "laugh" | "nod") once; the face reacts to match.
  gesture(name) {
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
    this.face.update(dt);
    this.kit.animate(this.rig, this.time, m);
  }

  dispose() {
    this.root.traverse((o) => o.geometry?.dispose());
    for (const m of Object.values(this.materials)) m.dispose();
    this.faceTextures.eyes.dispose();
    this.faceTextures.mouth.dispose();
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
  createRig(root) {
    const bones = BONES.map(([name]) => Object.assign(new THREE.Bone(), { name }));
    BONES.forEach(([, parent, pos], i) => {
      const bone = bones[i];
      const world = new THREE.Vector3(...pos);
      if (parent) {
        const p = BONE_INDEX[parent];
        bone.position.copy(world).sub(P[parent]);
        bones[p].add(bone);
      } else {
        bone.position.copy(world);
        root.add(bone);
      }
    });
    // Inverses are taken with the avatar root at the origin; parts bind with an identity bind matrix (see bindPart).
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    return { skeleton, bones: Object.fromEntries(bones.map((b) => [b.name, b])), rest: bones.map((b) => b.quaternion.clone()) };
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
      b.hips.position.y = P.hips.y + Math.abs(Math.cos(p)) * 0.03 * w;
    } else {
      b.hips.position.y = P.hips.y;
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
  }
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

function group(...objects) { const g = new THREE.Group(); objects.forEach((o) => g.add(o)); return g; }

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
