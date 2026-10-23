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

const CDN = "https://cdn.discordapp.com";
const CODE = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * A member's Discord profile picture for gamercards, looked up by friend code within the caller's own server only.
 * Served from our origin (Discord's sandbox may block its CDN in Activities, and Discord ids never reach the page);
 * Cloudflare caches the CDN fetch. Falls back to Discord's default avatar.
 */
export async function getAvatarImage(request: Request, env: Env, code: string): Promise<Response> {
  const me = await authenticate(request, env);
  if (!CODE.test(code)) throw new HttpError(400, "bad_code");
  const { results } = await env.DB.prepare("SELECT discord_id, avatar_hash, guild_avatar_hash FROM members WHERE guild_id = ?1")
    .bind(me.guildId).all<{ discord_id: string; avatar_hash: string | null; guild_avatar_hash: string | null }>();
  const row = results.find((r) => friendCode(r.discord_id) === code);
  if (!row) throw new HttpError(404, "not_found");

  const fallback = `${CDN}/embed/avatars/${Number((BigInt(row.discord_id) >> 22n) % 6n)}.png`;
  const url = row.guild_avatar_hash
    ? `${CDN}/guilds/${me.guildId}/users/${row.discord_id}/avatars/${row.guild_avatar_hash}.png?size=256`
    : row.avatar_hash ? `${CDN}/avatars/${row.discord_id}/${row.avatar_hash}.png?size=256` : fallback;

  const cached = { cf: { cacheEverything: true, cacheTtl: 86400 } } as RequestInit;
  let image = await fetch(url, cached);
  if (!image.ok && url !== fallback) image = await fetch(fallback, cached);
  if (!image.ok) throw new HttpError(502, "image_unavailable");
  return new Response(image.body, {
    headers: { "content-type": image.headers.get("content-type") ?? "image/png", "cache-control": "private, max-age=3600" },
  });
}
