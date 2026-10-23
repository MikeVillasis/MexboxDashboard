# 12 Mannequin avatar body
Status: done
Blocked by: 04

Requested 2026-10-23: replace the procedural avatar body with the owner's model
(`assets/characters/sculpting_a_human_body`, glTF, CC-BY-4.0 by Animation-class-k). Owner chose: keep all customiser
options by painting segments, credit in README + avatar blade.

## Comments
- 2026-10-23: the model is a 53-piece segmented mannequin (no rig). `activity/tools/build-mannequin.mjs` orients it,
  scales to 1.85 m, labels each piece with a skeleton bone, measures joints from the pieces, simplifies 73k → 9k
  triangles and writes `activity/models/mannequin.glb` (148 KB). `MannequinKit` rigs the pieces to the procedural
  skeleton placed at those joints (all animation layers reused), paints torso/legs styles, fits procedural hair and
  face shells to the head. All 288 style combinations build (60 ms, 20 shared shapes, no geometry leak); wave and
  nap verified visually; ~10k triangles per avatar (procedural ~8k). Activity-only: Windows keeps procedural (no GLB).
  Not FBX: three.js loads glTF natively; FBX would need Blender and a heavier loader.
- 2026-10-23: deployed and confirmed in Discord by the owner.
