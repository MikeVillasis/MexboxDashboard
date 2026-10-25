// One Durable Object per linked Windows PC (phase 07): the app keeps a WebSocket here and publishes what's on it.
// Phase 08 relays launch requests back down the same socket.
//
// App → hub                                         stored (D1 `libraries`, one row per device)
//   LIBRARY { games: [{ id, title, platform, cover }] }   games_json (validated, ≤ 500 games)
//   NOW_PLAYING { media: { title, artist, app, playing } | null }   now_playing (cleared when the PC disconnects)
//   "ping"  →  "pong"  (answered by the runtime without waking the hub, so an idle link costs nothing)
//   LAUNCH_RESULT { requestId, ok, reason? }       answer to a LAUNCH (phase 08)
//
// Hub → app (phase 08)
//   LAUNCH { requestId, gameId }   sent when the owner asks from the Activity (the Worker checked owner + library)
//
// The Worker authenticates the device token (Authorization header) before the upgrade reaches the hub; the hub
// trusts only the device id it was named for. Everything from the app is shape/size checked and rate limited, since a
// leaked token must not let anyone fill the guild's gamercards with junk.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const MAX_MESSAGE = 96 * 1024;   // a 500-game library is ~60 KB of JSON
const MAX_GAMES = 500;
const LIBRARY_EVERY_MS = 5_000;  // the app debounces; this stops a misbehaving one hammering D1
const MEDIA_EVERY_MS = 500;
const LAUNCH_ANSWER_MS = 6_000;  // how long the Activity waits for the PC to say "launching" / "not found"

export const DEVICE_CLOSE = { replaced: 4002, protocol: 4004 } as const;

// Covers must come from stores' public CDNs; the Activity loads them through /api/game-cover with the same list.
export const COVER_HOSTS = new Set([
  "cdn.cloudflare.steamstatic.com",
  "shared.cloudflare.steamstatic.com",
  "cdn.akamai.steamstatic.com",
  "shared.akamai.steamstatic.com",
  "steamcdn-a.akamaihd.net",
  "bnetxboxassets.akamaized.net",
]);

export interface PublishedGame { id: string; title: string; platform: string; cover: string | null }
export interface NowPlaying { title: string; artist: string; app: string; playing: boolean }

interface Link {
  deviceId: string;
  lastLibrary: number;
  lastMedia: number;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";

const GAME_ID = /^[A-Za-z0-9 _.:!~@+-]{1,160}$/;

export function coverUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && COVER_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export function normaliseLibrary(raw: unknown): PublishedGame[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_GAMES) return null;
  const games: PublishedGame[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const g = item as Record<string, unknown>;
    if (typeof g.id !== "string" || !GAME_ID.test(g.id) || seen.has(g.id)) continue;
    const title = text(g.title, 100);
    if (!title) continue;
    seen.add(g.id);
    games.push({ id: g.id, title, platform: text(g.platform, 20).toLowerCase() || "pc", cover: coverUrl(g.cover) });
  }
  return games;
}

export function normaliseNowPlaying(raw: unknown): NowPlaying | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const title = text(m.title, 100);
  if (!title) return null;
  return { title, artist: text(m.artist, 100), app: text(m.app, 40).toLowerCase(), playing: m.playing === true };
}

export type LaunchOutcome = { result: "launched" } | { result: "failed"; reason: string } | { result: "sent" } | { result: "offline" };

export class DeviceHub extends DurableObject<Env> {
  /** Launches waiting for the PC's LAUNCH_RESULT (in memory: the hub stays awake while a request is waiting). */
  private pending = new Map<string, (outcome: LaunchOutcome) => void>();

  /**
   * Phase 08: relay a launch to the connected PC and wait briefly for its answer. The Worker has already checked that
   * the caller owns this device and that the game is in its last published library.
   */
  async launch(gameId: string): Promise<LaunchOutcome> {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) return { result: "offline" };
    const requestId = crypto.randomUUID();
    const answer = new Promise<LaunchOutcome>((resolve) => {
      this.pending.set(requestId, resolve);
      setTimeout(() => { if (this.pending.delete(requestId)) resolve({ result: "sent" }); }, LAUNCH_ANSWER_MS);
    });
    try {
      ws.send(JSON.stringify({ type: "LAUNCH", requestId, gameId }));
    } catch {
      this.pending.delete(requestId);
      return { result: "offline" };
    }
    return answer;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The Worker has verified the device token and passes the device id; a newer connection replaces an older one. */
  async fetch(request: Request): Promise<Response> {
    const deviceId = request.headers.get("x-device-id") ?? "";
    for (const old of this.ctx.getWebSockets()) old.close(DEVICE_CLOSE.replaced, "replaced");

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ deviceId, lastLibrary: 0, lastMedia: 0 } satisfies Link);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const link = ws.deserializeAttachment() as Link;
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return ws.close(DEVICE_CLOSE.protocol, "bad_message");

    let packet: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      packet = parsed;
    } catch {
      return ws.close(DEVICE_CLOSE.protocol, "bad_message");
    }

    const now = Date.now();
    switch (packet.type) {
      case "LIBRARY": {
        if (now - link.lastLibrary < LIBRARY_EVERY_MS) return; // too soon: the app sends again on its next change
        const games = normaliseLibrary(packet.games);
        if (!games) return ws.close(DEVICE_CLOSE.protocol, "bad_library");
        link.lastLibrary = now;
        await this.env.DB.prepare(
          `INSERT INTO libraries (device_id, games_json, now_playing, updated_at) VALUES (?1, ?2, NULL, ?3)
           ON CONFLICT (device_id) DO UPDATE SET games_json = excluded.games_json, updated_at = excluded.updated_at`,
        ).bind(link.deviceId, JSON.stringify(games), now).run();
        ws.send(JSON.stringify({ type: "OK", what: "LIBRARY", games: games.length }));
        break;
      }
      case "LAUNCH_RESULT": {
        const resolve = typeof packet.requestId === "string" ? this.pending.get(packet.requestId) : undefined;
        if (!resolve) break;
        this.pending.delete(packet.requestId as string);
        resolve(packet.ok === true ? { result: "launched" } : { result: "failed", reason: text(packet.reason, 60) || "failed" });
        break;
      }
      case "NOW_PLAYING": {
        if (now - link.lastMedia < MEDIA_EVERY_MS) return;
        link.lastMedia = now;
        const media = normaliseNowPlaying(packet.media);
        await this.setNowPlaying(link.deviceId, media ? JSON.stringify(media) : null);
        break;
      }
    }
    ws.serializeAttachment(link);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const link = ws.deserializeAttachment() as Link;
    // A replaced socket hands over to the new one; otherwise the PC went away and its "now playing" is stale.
    if (code !== DEVICE_CLOSE.replaced && this.ctx.getWebSockets().every((s) => s === ws)) await this.setNowPlaying(link.deviceId, null);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1006);
  }

  private async setNowPlaying(deviceId: string, json: string | null) {
    // Only updates an existing row: now playing arrives after the first LIBRARY, which creates it.
    await this.env.DB.prepare("UPDATE libraries SET now_playing = ?2, updated_at = ?3 WHERE device_id = ?1")
      .bind(deviceId, json, Date.now()).run();
  }
}
