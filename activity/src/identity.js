// Deterministic defaults for a Discord member: the same user always gets the same starter avatar and friend code
// until they customise it (saved server-side from phase 04).

const SKIN = ["#FFDBC4", "#F1C27D", "#E0AC69", "#C68642", "#8D5524", "#5C3A21"];
const HAIR = ["#2C1B18", "#4A2C1A", "#B7372A", "#E6C27A", "#3B5BDB", "#1F1F1F"];
const SHIRT = ["#107C10", "#1B6AC9", "#E3008C", "#FFB900", "#00B7C3", "#5B2A86", "#D83B01"];
const LEGS = ["#2B2B2B", "#3C3C3C", "#1F5F3A", "#5B2A86", "#7A5C3E", "#1B3A6B"];
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // matches NetworkManager's code pattern

/** FNV-1a over the id plus a salt: stable, fast, good enough spread for picking parts. */
function hash(text, salt) {
  let h = 0x811c9dc5;
  for (const ch of `${salt}:${text}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const pick = (list, id, salt) => list[hash(id, salt) % list.length];
const part = (count, id, salt) => hash(id, salt) % count;

/** Gamertag rules from C# AvatarDna: trimmed, at most 15 characters. */
export function gamertag(displayName) {
  const clean = String(displayName ?? "").replace(/[\u0000-\u001f]/g, "").trim();
  return (clean || "player").slice(0, 15);
}

export function defaultDna(discordId, displayName) {
  return {
    v: 1,
    id: "local",
    name: gamertag(displayName),
    skinColor: pick(SKIN, discordId, "skin"),
    headId: part(4, discordId, "head"),
    hairId: part(6, discordId, "hair"),
    hairColor: pick(HAIR, discordId, "hairColor"),
    torsoId: part(4, discordId, "torso"),
    shirtColor: pick(SHIRT, discordId, "shirt"),
    legsId: part(3, discordId, "legs"),
    legsColor: pick(LEGS, discordId, "legsColor"),
    eyeUV: part(4, discordId, "eyes"),
    mouthUV: part(4, discordId, "mouth"),
  };
}

export function friendCode(discordId) {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[hash(discordId, `code${i}`) % CODE_ALPHABET.length];
  return code;
}

/** Discord serves the Activity from <application id>.discordsays.com; anything else is not inside Discord. */
export function clientIdFromHost(hostname) {
  const match = /^(\d{17,20})\.discordsays\.com$/.exec(hostname);
  return match ? match[1] : null;
}

/** Server error codes → lowercase copy for the sign-in screen. */
export const SIGN_IN_ERRORS = {
  guild_not_allowed: "this plaza only opens in its home server",
  not_member: "you need to be a member of this server to enter the plaza",
  code_rejected: "discord sign-in expired, close the activity and try again",
  discord_busy: "discord is busy right now, try again in a minute",
  origin_not_allowed: "this page has to be opened from discord",
};
