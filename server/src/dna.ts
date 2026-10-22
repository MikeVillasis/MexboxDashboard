// Server-side twin of C# Core/Avatars/AvatarDna.TryParse: untrusted recipes are normalised (colours #RRGGBB, part ids
// clamped, name trimmed to 15) or rejected. Keep the two in step.

export const MAX_DNA_JSON = 1024;
const MAX_PART_ID = 15;
const MAX_NAME_LENGTH = 15;
const HEX = /^#[0-9A-Fa-f]{6}$/;

export interface AvatarDna {
  v: 1;
  id: string;
  name: string;
  skinColor: string;
  headId: number;
  hairId: number;
  hairColor: string;
  torsoId: number;
  shirtColor: string;
  legsId: number;
  legsColor: string;
  eyeUV: number;
  mouthUV: number;
}

const DEFAULTS = { skinColor: "#E0AC69", hairColor: "#2C1B18", shirtColor: "#107C10", legsColor: "#2B3A55", hairId: 1 };

const color = (value: unknown, fallback: string) => (typeof value === "string" && HEX.test(value) ? value.toUpperCase() : fallback);
const part = (value: unknown, fallback = 0) => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(MAX_PART_ID, Math.max(0, n));
};
const clip = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);

/** Returns a normalised recipe with the given id, or null when it is not a recipe. */
export function normaliseDna(raw: unknown, id: string): AvatarDna | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  let size: number;
  try { size = JSON.stringify(raw).length; } catch { return null; }
  if (size > MAX_DNA_JSON) return null;

  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !clip(r.name)) return null;
  return {
    v: 1,
    id,
    name: clip(r.name),
    skinColor: color(r.skinColor, DEFAULTS.skinColor),
    headId: part(r.headId),
    hairId: part(r.hairId, DEFAULTS.hairId),
    hairColor: color(r.hairColor, DEFAULTS.hairColor),
    torsoId: part(r.torsoId),
    shirtColor: color(r.shirtColor, DEFAULTS.shirtColor),
    legsId: part(r.legsId),
    legsColor: color(r.legsColor, DEFAULTS.legsColor),
    eyeUV: part(r.eyeUV),
    mouthUV: part(r.mouthUV),
  };
}

/** Recipes from D1 were normalised on the way in; this only guards against a corrupt row. */
export function parseStoredDna(json: unknown, id: string): AvatarDna | null {
  if (typeof json !== "string") return null;
  try { return normaliseDna(JSON.parse(json), id); } catch { return null; }
}
