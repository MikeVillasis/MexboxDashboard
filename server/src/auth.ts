// Identity is never taken from the client: every request carries the user's own Discord access token, and Discord
// tells us who it belongs to and whether they are in an allowed guild (scope guilds.members.read).

import { allowedGuilds, discordApi, type Env } from "./env";
import { HttpError, isSnowflake, sha256Hex } from "./http";

export interface Member {
  guildId: string;
  discordId: string;
  displayName: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
// Per-isolate; keyed by a hash so raw tokens never sit in memory longer than the request.
const cache = new Map<string, { member: Member; expires: number }>();

export async function authenticate(request: Request, env: Env): Promise<Member> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.length > 256) throw new HttpError(401, "missing_token");
  return verifyMember(env, token, request.headers.get("x-guild-id"));
}

export async function verifyMember(env: Env, accessToken: string, guildId: unknown): Promise<Member> {
  if (!isSnowflake(guildId) || !allowedGuilds(env).has(guildId)) throw new HttpError(403, "guild_not_allowed");

  const key = `${await sha256Hex(accessToken)}:${guildId}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.member;

  const response = await fetch(`${discordApi(env)}/users/@me/guilds/${guildId}/member`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 401) throw new HttpError(401, "invalid_token");
  if (response.status === 403 || response.status === 404) throw new HttpError(403, "not_member");
  if (response.status === 429) throw new HttpError(503, "discord_busy");
  if (!response.ok) throw new HttpError(502, "discord_error");

  const body = (await response.json()) as { nick?: string | null; user?: { id?: string; username?: string; global_name?: string | null } };
  const discordId = body.user?.id;
  if (!isSnowflake(discordId)) throw new HttpError(502, "discord_error");
  const member: Member = {
    guildId,
    discordId,
    displayName: (body.nick || body.user?.global_name || body.user?.username || "player").slice(0, 32),
  };

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { member, expires: Date.now() + CACHE_TTL_MS });
  await env.DB.prepare(
    `INSERT INTO members (guild_id, discord_id, display_name, last_seen) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (guild_id, discord_id) DO UPDATE SET display_name = excluded.display_name, last_seen = excluded.last_seen`,
  ).bind(member.guildId, member.discordId, member.displayName, Date.now()).run();
  return member;
}

/** Test hook. */
export const clearAuthCache = () => cache.clear();
