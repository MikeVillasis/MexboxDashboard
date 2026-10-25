// Remote launch (phase 08): from your own gamercard in the Activity, start a game on your own linked PC.
//
//   POST /api/launch { gameId } → { result: "launched" | "sent" | "failed" | "offline", reason?, device? }
//
// Rules (spec hard rule 4): only the caller's own devices, only a game id present in that device's last published
// library, rate limited per member. The PC re-checks the id against its own library and launches through the store's
// own URI/bootstrapper, exactly like pressing play on the PC.

import { authenticate } from "./auth";
import type { PublishedGame } from "./device-hub";
import type { Env } from "./env";
import { HttpError, json, readJson } from "./http";

const GAME_ID = /^[A-Za-z0-9 _.:!~@+-]{1,160}$/;

export async function launchGame(request: Request, env: Env): Promise<Response> {
  const me = await authenticate(request, env);
  const { success } = await env.LAUNCHES.limit({ key: `${me.guildId}:${me.discordId}` });
  if (!success) throw new HttpError(429, "rate_limited");

  const body = await readJson<{ gameId?: unknown }>(request);
  if (typeof body.gameId !== "string" || !GAME_ID.test(body.gameId)) throw new HttpError(400, "bad_game");
  const gameId = body.gameId;

  // The caller's own PCs that published this game, most recently updated first.
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.name, l.games_json FROM devices d JOIN libraries l ON l.device_id = d.id
      WHERE d.guild_id = ?1 AND d.discord_id = ?2 ORDER BY l.updated_at DESC`,
  ).bind(me.guildId, me.discordId).all<{ id: string; name: string; games_json: string }>();
  const candidates = results.filter((row) => {
    try { return (JSON.parse(row.games_json) as PublishedGame[]).some((g) => g.id === gameId); } catch { return false; }
  });
  if (candidates.length === 0) throw new HttpError(404, "game_not_in_library");

  // First connected PC wins; a PC that's off just gets skipped.
  for (const device of candidates) {
    const outcome = await env.DEVICES.get(env.DEVICES.idFromName(device.id)).launch(gameId);
    if (outcome.result !== "offline") return json({ ...outcome, device: device.name });
  }
  return json({ result: "offline", device: candidates[0].name });
}
