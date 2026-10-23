import { authenticate, clientIp } from "./auth";
import { allowedGuilds, allowedOrigins, type Env } from "./env";
import { HttpError, isSnowflake, json, readJson } from "./http";
import { exchangeCode } from "./oauth";
import { getAvatar, getMembers, putAvatar } from "./plaza";

export { PresenceHub } from "./presence-hub";
export { PlazaRoom } from "./room";

/** Discord's documented prefix for proxied requests; accepted so the Activity works whether or not the proxy strips it. */
const PROXY_PREFIX = "/.proxy";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(`${PROXY_PREFIX}/`)) {
      url.pathname = url.pathname.slice(PROXY_PREFIX.length) || "/";
    }

    // Everything outside /api is the Activity's static front end (public code, no data).
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(new Request(url, request));
    }

    const origin = request.headers.get("origin");
    // Browsers always send Origin on cross-origin and POST requests; a foreign page is refused outright.
    if (origin && !allowedOrigins(env).has(origin)) return json({ error: "origin_not_allowed" }, 403);
    const cors: HeadersInit = origin
      ? { "access-control-allow-origin": origin, vary: "origin" }
      : {};

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "GET, POST, PUT", "access-control-allow-headers": "authorization, content-type, x-guild-id", "access-control-max-age": "600" },
      });
    }

    try {
      const response = await route(url.pathname, request, env);
      if (response.webSocket) return response; // 101: headers are immutable and CORS doesn't apply
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, cors);
      console.error("unhandled", err instanceof Error ? err.message : "unknown"); // never log request bodies or tokens
      return json({ error: "internal" }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,100}$/;

async function route(pathname: string, request: Request, env: Env): Promise<Response> {
  if (pathname === "/api/token" && request.method === "POST") {
    const body = await readJson<{ code?: unknown; guildId?: unknown }>(request);
    return json(await exchangeCode(env, body.code, body.guildId, clientIp(request)));
  }

  if (pathname === "/api/me" && request.method === "GET") {
    return json(await authenticate(request, env));
  }

  if (pathname === "/api/avatar" && request.method === "GET") return getAvatar(request, env);
  if (pathname === "/api/avatar" && request.method === "PUT") return putAvatar(request, env);
  if (pathname === "/api/plaza/members" && request.method === "GET") return getMembers(request, env);

  // The shared plaza: one room per Activity instance. Browsers can't set headers on a WebSocket, so the token arrives
  // in the first message (never in the URL, which could end up in logs) and the room verifies it.
  if (pathname === "/api/room" && request.method === "GET") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "websocket_required");
    const params = new URL(request.url).searchParams;
    const guildId = params.get("guild");
    const instanceId = params.get("instance");
    if (!isSnowflake(guildId) || !allowedGuilds(env).has(guildId)) throw new HttpError(403, "guild_not_allowed");
    if (!instanceId || !INSTANCE_ID.test(instanceId)) throw new HttpError(400, "bad_instance");
    const headers = new Headers(request.headers);
    headers.set("x-guild-id", guildId);
    headers.set("x-client-ip", clientIp(request));
    headers.set("x-room-name", `${guildId}:${instanceId}`);
    const room = env.ROOMS.get(env.ROOMS.idFromName(`${guildId}:${instanceId}`));
    return room.fetch(new Request(request.url, { headers }));
  }

  if (pathname === "/api/health") return json({ ok: true });

  throw new HttpError(404, "not_found");
}
