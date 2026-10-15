// Test plaza residents (DNA recipes in the same format C# stores for the local player).
// Phase 4 gives them wandering/socialising AI; phase 5 replaces them with friends' cached recipes.
export const RESIDENTS = [
  { v: 1, id: "npc_ace", name: "AceOfSpades", skinColor: "#F1C27D", headId: 1, hairId: 2, hairColor: "#E6C27A", torsoId: 2, shirtColor: "#1B6AC9", legsId: 0, legsColor: "#3C3C3C", eyeUV: 1, mouthUV: 2 },
  { v: 1, id: "npc_juno", name: "JunoBloom", skinColor: "#8D5524", headId: 2, hairId: 5, hairColor: "#2C1B18", torsoId: 3, shirtColor: "#E3008C", legsId: 2, legsColor: "#5B2A86", eyeUV: 3, mouthUV: 1 },
  { v: 1, id: "npc_rex", name: "RexRunner", skinColor: "#FFDBC4", headId: 3, hairId: 4, hairColor: "#B7372A", torsoId: 0, shirtColor: "#FFB900", legsId: 1, legsColor: "#7A5C3E", eyeUV: 0, mouthUV: 3 },
  { v: 1, id: "npc_mika", name: "MikaWaves", skinColor: "#C68642", headId: 0, hairId: 3, hairColor: "#3B5BDB", torsoId: 1, shirtColor: "#00B7C3", legsId: 0, legsColor: "#1F5F3A", eyeUV: 2, mouthUV: 0 },
];

// Where they stand until phase 4 lets them roam (x, z, facing).
export const RESIDENT_SPOTS = [[-2.6, -1.2, 0.5], [2.8, -0.6, -0.6], [-1.4, -3.6, 0.2], [1.6, -3.2, -0.3]];
