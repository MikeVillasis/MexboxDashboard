// Saved avatars and the guild's away list. Everything is scoped to the caller's verified guild; other members are
// exposed only by friend code + avatar recipe (no Discord ids or display names).

import { friendCode } from "../../activity/src/identity.js";
import { authenticate } from "./auth";
import { normaliseDna, parseStoredDna } from "./dna";
import type { Env } from "./env";
import { HttpError, json, readJson } from "./http";

const AWAY_DAYS = 30;
const AWAY_LIMIT = 24;

export async function getAvatar(request: Request, env: Env): Promise<Response> {
  const me = await authenticate(request, env);
  const row = await env.DB.prepare("SELECT avatar_dna FROM members WHERE guild_id = ?1 AND discord_id = ?2")
    .bind(me.guildId, me.discordId).first<{ avatar_dna: string | null }>();
  return json({ dna: parseStoredDna(row?.avatar_dna, "local") });
}

export async function putAvatar(request: Request, env: Env): Promise<Response> {
  const me = await authenticate(request, env);
  const body = await readJson<{ dna?: unknown }>(request);
  const dna = normaliseDna(body.dna, "local");
  if (!dna) throw new HttpError(400, "bad_dna");
  await env.DB.prepare("UPDATE members SET avatar_dna = ?3 WHERE guild_id = ?1 AND discord_id = ?2")
    .bind(me.guildId, me.discordId, JSON.stringify(dna)).run();
  return json({ dna });
}

/** Members of this guild who have been in the plaza recently: they nap there while away. */
export async function getMembers(request: Request, env: Env): Promise<Response> {
  const me = await authenticate(request, env);
  const since = Date.now() - AWAY_DAYS * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    `SELECT discord_id, avatar_dna, last_seen FROM members
     WHERE guild_id = ?1 AND discord_id != ?2 AND avatar_dna IS NOT NULL AND last_seen > ?3
     ORDER BY last_seen DESC LIMIT ?4`,
  ).bind(me.guildId, me.discordId, since, AWAY_LIMIT).all<{ discord_id: string; avatar_dna: string; last_seen: number }>();

  const members = [];
  for (const row of results) {
    const code = friendCode(row.discord_id);
    const dna = parseStoredDna(row.avatar_dna, `friend_${code}`);
    if (dna) members.push({ code, dna, lastSeen: new Date(row.last_seen).toISOString() });
  }
  return json({ members });
}
