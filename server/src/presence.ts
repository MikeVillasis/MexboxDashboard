// What a thought bubble shows, derived from a Discord presence (Gateway PRESENCE_UPDATE / GUILD_CREATE presences).
// Only the activity kind and a short line of text ever leave the Worker; nothing is stored.

export type StatusKind = "playing" | "listening" | "watching";
export interface Status { kind: StatusKind; text: string }

const MAX_TEXT = 48;

interface Activity { type?: number; name?: unknown; details?: unknown; state?: unknown }

const clean = (value: unknown) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim() : "";
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

/**
 * Discord activity types: 0 playing, 1 streaming, 2 listening, 3 watching, 4 custom status, 5 competing.
 * Games win over media (you're more likely playing with music on than the reverse); custom statuses are ignored.
 */
export function statusFromPresence(presence: { status?: unknown; activities?: unknown }): Status | null {
  if (presence.status === "offline" || !Array.isArray(presence.activities)) return null;
  const activities = presence.activities as Activity[];

  const game = activities.find((a) => a.type === 0 || a.type === 5 || a.type === 1);
  if (game) {
    const text = clean(game.type === 1 ? game.details || game.name : game.name);
    if (text) return { kind: "playing", text: clip(text) };
  }
  const listening = activities.find((a) => a.type === 2);
  if (listening) {
    const song = clean(listening.details);
    const artist = clean(listening.state);
    const text = song && artist ? `${song} – ${artist}` : song || clean(listening.name);
    if (text) return { kind: "listening", text: clip(text) };
  }
  const watching = activities.find((a) => a.type === 3);
  if (watching) {
    const text = clean(watching.details) || clean(watching.name);
    if (text) return { kind: "watching", text: clip(text) };
  }
  return null;
}

export const sameStatus = (a: Status | null | undefined, b: Status | null | undefined) =>
  (a?.kind ?? null) === (b?.kind ?? null) && (a?.text ?? null) === (b?.text ?? null);
