// Reading what linked PCs published (phase 07). Libraries are visible to the whole guild (spec decision); members are
// addressed by friend code only, like the rest of the plaza API, so Discord ids never reach the page.

import { friendCode } from "../../activity/src/identity.js";
import { authenticate } from "./auth";
import { COVER_HOSTS, type NowPlaying, type PublishedGame } from "./device-hub";
import type { Env } from "./env";
import { HttpError, json } from "./http";

const CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const MAX_COVER_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/library/:code → { games, nowPlaying, updatedAt, devices } for a member of the caller's guild. A member with
 * several linked PCs gets one merged list; now playing comes from whichever PC reported most recently.
 */
export async function getLibrary(request: Request, env: Env, code: string): Promise<Response> {
  const me = await authenticate(request, env);
  if (!CODE.test(code)) throw new HttpError(400, "bad_code");

  const { results } = await env.DB.prepare(
    `SELECT d.discord_id, l.games_json, l.now_playing, l.updated_at
       FROM devices d JOIN libraries l ON l.device_id = d.id
      WHERE d.guild_id = ?1
      ORDER BY l.updated_at DESC`,
  ).bind(me.guildId).all<{ discord_id: string; games_json: string; now_playing: string | null; updated_at: number }>();

  const rows = results.filter((r) => friendCode(r.discord_id) === code);
  const games = new Map<string, PublishedGame>();
  let nowPlaying: NowPlaying | null = null;
  for (const row of rows) {
    for (const game of safeParse<PublishedGame[]>(row.games_json) ?? []) if (!games.has(game.id)) games.set(game.id, game);
    nowPlaying ??= safeParse<NowPlaying>(row.now_playing);
  }
  return json({
    games: [...games.values()], // as the PC sent them: most recently played first
    nowPlaying,
    updatedAt: rows[0]?.updated_at ?? null,
    devices: rows.length,
  });
}

/**
 * GET /api/game-cover?url=… : store box art through our origin (Discord's Activity sandbox blocks other hosts).
 * Signed-in members only, store CDNs only, images only; Cloudflare caches the upstream fetch.
 */
export async function getGameCover(request: Request, env: Env): Promise<Response> {
  await authenticate(request, env);
  const raw = new URL(request.url).searchParams.get("url") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "bad_url");
  }
  if (url.protocol !== "https:" || !COVER_HOSTS.has(url.hostname)) throw new HttpError(400, "host_not_allowed");

  const upstream = await fetch(url.href, { cf: { cacheEverything: true, cacheTtl: 7 * 86400 } } as RequestInit);
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !type.startsWith("image/")) throw new HttpError(404, "cover_unavailable");
  if (Number(upstream.headers.get("content-length") ?? 0) > MAX_COVER_BYTES) throw new HttpError(413, "cover_too_large");
  return new Response(upstream.body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
}

function safeParse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}
