// Turns the CC-BY "sculpting a human body" mannequin (assets/characters/sculpting_a_human_body, by Animation-class-k)
// into activity/models/mannequin.glb for the plaza's MannequinKit:
//   • upright, facing +Z, feet on y = 0, pelvis centred, scaled to HEIGHT metres
//   • each of the model's separate pieces (head, neck, chest, abdomen, pelvis, shoulders, upper arms, elbows, forearms,
//     hands + fingers, thighs, knees, shins, feet) labelled with the plaza skeleton bone it belongs to
//   • simplified (meshoptimizer) to keep crowded plazas and phones fast
//   • one mesh per bone (node named after the bone); scene extras carry joint positions and the head's centre/radii
//
//   node activity/tools/build-mannequin.mjs        (re-run only when the source model changes; the output is committed)
import { MeshoptSimplifier } from "meshoptimizer";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const SOURCE = path.join(root, "assets", "characters", "sculpting_a_human_body");
const OUT = path.join(root, "activity", "models", "mannequin.glb");
const HEIGHT = 1.85;          // metres, top of head
const KEEP = 0.12;            // fraction of triangles kept on the big pieces
const SMALL_PIECE = 200;      // pieces with fewer vertices (fingers, neck) are kept as they are

// ───────────── Read the glTF ─────────────

const gltf = JSON.parse(await readFile(path.join(SOURCE, "scene.gltf"), "utf8"));
const bin = await readFile(path.join(SOURCE, "scene.bin"));

function accessor(index) {
  const a = gltf.accessors[index];
  const view = gltf.bufferViews[a.bufferView];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const Type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType];
  const stride = (view.byteStride ?? Type.BYTES_PER_ELEMENT * width) / Type.BYTES_PER_ELEMENT;
  const base = new Type(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0), (a.count - 1) * stride + width);
  const out = new (Type === Float32Array ? Float32Array : Uint32Array)(a.count * width);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = base[i * stride + k];
  return out;
}

// World matrix of the mesh node: product of the matrices on the path from the scene root.
const mul = (a, b) => { // column-major 4x4
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
let world = null;
(function walk(nodeIndex, parent) {
  const node = gltf.nodes[nodeIndex];
  const m = mul(parent, node.matrix ?? IDENTITY);
  if (node.mesh === 0) world = m;
  for (const child of node.children ?? []) walk(child, m);
})(gltf.scenes[0].nodes[0], IDENTITY);

const prim = gltf.meshes[0].primitives[0];
const srcPos = accessor(prim.attributes.POSITION);
const srcIdx = accessor(prim.indices);
const vertexCount = srcPos.length / 3;

const pos = new Float32Array(srcPos.length);
for (let i = 0; i < vertexCount; i++) {
  const [x, y, z] = [srcPos[i * 3], srcPos[i * 3 + 1], srcPos[i * 3 + 2]];
  for (let r = 0; r < 3; r++) pos[i * 3 + r] = world[r] * x + world[4 + r] * y + world[8 + r] * z + world[12 + r];
}

// ───────────── Split into pieces (connected parts, welding duplicated seam vertices) ─────────────

const parent = Int32Array.from({ length: vertexCount }, (_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
for (let t = 0; t < srcIdx.length; t += 3) { unite(srcIdx[t], srcIdx[t + 1]); unite(srcIdx[t], srcIdx[t + 2]); }
const weld = new Map();
for (let i = 0; i < vertexCount; i++) {
  const key = `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
  if (weld.has(key)) unite(weld.get(key), i); else weld.set(key, i);
}
const pieceOf = new Map();
const pieces = [];
for (let i = 0; i < vertexCount; i++) {
  const r = find(i);
  if (!pieceOf.has(r)) { pieceOf.set(r, pieces.length); pieces.push({ verts: [], tris: [] }); }
  pieces[pieceOf.get(r)].verts.push(i);
}
for (let t = 0; t < srcIdx.length; t += 3) pieces[pieceOf.get(find(srcIdx[t]))].tris.push(srcIdx[t], srcIdx[t + 1], srcIdx[t + 2]);

// ───────────── Normalise: upright, facing +Z, feet at 0, centred, scaled ─────────────

const stats = (verts) => {
  const c = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of verts) for (let k = 0; k < 3; k++) {
    const v = pos[i * 3 + k];
    c[k] += v; min[k] = Math.min(min[k], v); max[k] = Math.max(max[k], v);
  }
  return { c: c.map((v) => v / verts.length), min, max };
};
for (const p of pieces) Object.assign(p, stats(p.verts));
const all = stats([...Array(vertexCount).keys()]);
const sizes = [0, 1, 2].map((k) => all.max[k] - all.min[k]);
if (sizes[1] < sizes[0] || sizes[1] < sizes[2]) throw new Error(`expected Y up, got extents ${sizes}`);

const big = pieces.filter((p) => p.verts.length >= SMALL_PIECE).sort((a, b) => b.c[1] - a.c[1]);
const midX = (all.min[0] + all.max[0]) / 2;
const width = sizes[0];
const central = big.filter((p) => Math.abs(p.c[0] - midX) < width * 0.08);
if (central.length !== 4) throw new Error(`expected head, chest, abdomen, pelvis in the middle; found ${central.length} pieces`);
const pelvis = central[central.length - 1]; // the neck is a small piece, labelled later

// Facing: the feet stick out forward from the shins.
const sidePieces = big.filter((p) => !central.includes(p));
const lowest = [...sidePieces].sort((a, b) => a.c[1] - b.c[1]);
const foot = lowest[0];
const shinOfFoot = lowest.find((p) => p !== foot && Math.sign(p.c[0] - midX) === Math.sign(foot.c[0] - midX) && p.max[1] - p.min[1] > (foot.max[1] - foot.min[1]) * 2);
const flip = foot.c[2] < shinOfFoot.c[2] ? -1 : 1; // rotate 180° about Y when the toes point to -Z
const scale = HEIGHT / sizes[1];
const pelvisC = pelvis.c;
for (let i = 0; i < vertexCount; i++) {
  pos[i * 3] = (pos[i * 3] - pelvisC[0]) * scale * flip;
  pos[i * 3 + 1] = (pos[i * 3 + 1] - all.min[1]) * scale;
  pos[i * 3 + 2] = (pos[i * 3 + 2] - pelvisC[2]) * scale * flip;
}
for (const p of pieces) Object.assign(p, stats(p.verts));

// ───────────── Label pieces with bones ─────────────
// Facing +Z, the avatar's left is +X (the plaza skeleton's *_L bones sit at +X).

const label = new Map();
const bigNow = pieces.filter((p) => p.verts.length >= SMALL_PIECE).sort((a, b) => b.c[1] - a.c[1]);
const centre = bigNow.filter((p) => Math.abs(p.c[0]) < HEIGHT * 0.035);
const [headP, ...trunk] = centre;
label.set(headP, "head");
const [chestP, abdomenP, pelvisP] = trunk.slice(-3);
label.set(chestP, "chest");
label.set(abdomenP, "spine");
label.set(pelvisP, "hips");
for (const side of ["L", "R"]) {
  const sign = side === "L" ? 1 : -1;
  const mine = bigNow.filter((p) => !centre.includes(p) && Math.sign(p.c[0]) === sign);
  const hand = mine.reduce((a, b) => (b.verts.length > a.verts.length ? b : a));
  label.set(hand, `hand_${side}`);
  const legs = mine.filter((p) => p !== hand && p.c[1] < pelvisP.c[1]).sort((a, b) => b.c[1] - a.c[1]);
  const arms = mine.filter((p) => p !== hand && !legs.includes(p)).sort((a, b) => b.c[1] - a.c[1]);
  if (legs.length !== 4 || arms.length !== 4) throw new Error(`side ${side}: expected 4 leg + 4 arm pieces, got ${legs.length} + ${arms.length}`);
  ["thigh", "shin", "shin", "foot"].forEach((bone, i) => label.set(legs[i], `${bone}_${side}`));       // thigh, knee, shin, foot
  ["upperArm", "upperArm", "foreArm", "foreArm"].forEach((bone, i) => label.set(arms[i], `${bone}_${side}`)); // shoulder, upper, elbow, fore
  Object.assign(label, { [`__${side}`]: { hand, legs, arms } });
}
// Small pieces: the neck sits between head and chest, fingers belong to the nearest hand.
for (const p of pieces.filter((q) => q.verts.length < SMALL_PIECE)) {
  if (Math.abs(p.c[0]) < HEIGHT * 0.035 && p.c[1] > chestP.c[1]) { label.set(p, "neck"); continue; }
  label.set(p, p.c[0] > 0 ? "hand_L" : "hand_R");
}
if ([...label.keys()].filter((k) => typeof k === "object").length !== pieces.length) throw new Error("some pieces were not labelled");

// ───────────── Joints (bone pivots) measured from the pieces ─────────────

/** Centroid of the piece's vertices in the extreme `share` along a direction. */
function end(p, dir, share = 0.06) {
  const dot = (i) => pos[i * 3] * dir[0] + pos[i * 3 + 1] * dir[1] + pos[i * 3 + 2] * dir[2];
  const sorted = [...p.verts].sort((a, b) => dot(b) - dot(a)).slice(0, Math.max(3, Math.round(p.verts.length * share)));
  return stats(sorted).c;
}
const avg = (a, b) => a.map((v, i) => (v + b[i]) / 2);
const round = (v) => v.map((x) => Math.round(x * 1000) / 1000);
const joints = {};
const neckP = pieces.find((p) => label.get(p) === "neck");
for (const side of ["L", "R"]) {
  const { hand, legs, arms } = label[`__${side}`];
  const [shoulder, , elbow, fore] = arms;
  const [thigh, knee, shin] = legs;
  joints[`upperArm_${side}`] = shoulder.c;
  joints[`foreArm_${side}`] = elbow.c;
  const towardHand = hand.c.map((v, i) => v - elbow.c[i]);
  const len = Math.hypot(...towardHand);
  joints[`hand_${side}`] = end(fore, towardHand.map((v) => v / len));
  joints[`thigh_${side}`] = end(thigh, [0, 1, 0]);
  joints[`shin_${side}`] = knee.c;
  joints[`foot_${side}`] = end(shin, [0, -1, 0]);
}
joints.hips = avg(joints.thigh_L, joints.thigh_R).map((v, i) => (i === 1 ? v - 0.02 : v)); // just under the waist pivot
joints.spine = avg(end(pelvisP, [0, 1, 0]), end(abdomenP, [0, -1, 0]));
joints.chest = avg(end(abdomenP, [0, 1, 0]), end(chestP, [0, -1, 0]));
joints.neck = end(neckP, [0, -1, 0], 0.15);
joints.head = end(neckP, [0, 1, 0], 0.15);
for (const k of Object.keys(joints)) joints[k] = round(joints[k]);
const headStats = stats(headP.verts);
const headCenter = round(headStats.c);
const headRadii = round([0, 1, 2].map((k) => (headStats.max[k] - headStats.min[k]) / 2));

// ───────────── Simplify and gather per bone ─────────────

await MeshoptSimplifier.ready;
const byBone = new Map(); // bone → { positions: number[], indices: number[] }
let trisIn = 0;
let trisOut = 0;
for (const p of pieces) {
  const local = new Map(p.verts.map((v, i) => [v, i]));
  const positions = new Float32Array(p.verts.length * 3);
  p.verts.forEach((v, i) => positions.set(pos.subarray(v * 3, v * 3 + 3), i * 3));
  let indices = Uint32Array.from(p.tris, (v) => local.get(v));
  trisIn += indices.length / 3;
  if (p.verts.length >= SMALL_PIECE) {
    const target = Math.max(36, Math.floor((indices.length * KEEP) / 3) * 3);
    [indices] = MeshoptSimplifier.simplify(indices, positions, 3, target, 0.02, ["LockBorder"]);
  }
  trisOut += indices.length / 3;
  // Compact: keep only vertices still referenced.
  const remap = new Map();
  const outPos = [];
  const outIdx = [];
  for (const v of indices) {
    if (!remap.has(v)) { remap.set(v, outPos.length / 3); outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
    outIdx.push(remap.get(v));
  }
  const bone = label.get(p);
  const entry = byBone.get(bone) ?? { positions: [], indices: [] };
  const offset = entry.positions.length / 3;
  entry.positions.push(...outPos);
  entry.indices.push(...outIdx.map((i) => i + offset));
  byBone.set(bone, entry);
}

// ───────────── Write GLB (normals are recomputed at load: smooth shading per piece) ─────────────

const chunks = [];
const bufferViews = [];
const accessors = [];
let byteLength = 0;
function addView(typed, target) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (bytes.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
  chunks.push(bytes, Buffer.alloc(pad));
  byteLength += bytes.length + pad;
  return bufferViews.length - 1;
}
const meshes = [];
const nodes = [];
for (const [bone, { positions, indices }] of [...byWeight(byBone)]) {
  const p = Float32Array.from(positions);
  const min = [0, 1, 2].map((k) => Math.min(...p.filter((_, i) => i % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...p.filter((_, i) => i % 3 === k)));
  accessors.push({ bufferView: addView(p, 34962), componentType: 5126, count: p.length / 3, type: "VEC3", min, max });
  const posAccessor = accessors.length - 1;
  const idx = Uint16Array.from(indices);
  accessors.push({ bufferView: addView(idx, 34963), componentType: 5123, count: idx.length, type: "SCALAR" });
  meshes.push({ name: bone, primitives: [{ attributes: { POSITION: posAccessor }, indices: accessors.length - 1 }] });
  nodes.push({ name: bone, mesh: meshes.length - 1 });
}
function* byWeight(map) { yield* [...map.entries()].sort(([a], [b]) => a.localeCompare(b)); }

const json = {
  asset: {
    version: "2.0",
    generator: "mexbox build-mannequin.mjs",
    copyright: "\"sculpting a human body\" by Animation-class-k (https://sketchfab.com/Animation-class-k), CC-BY-4.0, simplified and relabelled",
  },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i), extras: { joints, headCenter, headRadii, height: HEIGHT } }],
  nodes,
  meshes,
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
};
const jsonBytes = Buffer.from(JSON.stringify(json));
const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
const binChunk = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunkHeader = (length, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, Buffer.concat([header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk, chunkHeader(binChunk.length, 0x004e4942), binChunk]));

console.log(`pieces ${pieces.length}, bones ${byBone.size}, facing flip ${flip}, triangles ${trisIn} → ${trisOut}`);
console.log("joints", JSON.stringify(joints));
console.log("head", JSON.stringify({ headCenter, headRadii }));
console.log(`wrote ${path.relative(root, OUT)} (${(binChunk.length / 1024).toFixed(0)} KiB of geometry)`);
