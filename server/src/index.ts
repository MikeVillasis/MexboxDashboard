import { authenticate } from "./auth";
import { allowedOrigins, type Env } from "./env";
import { HttpError, json, readJson } from "./http";
import { exchangeCode } from "./oauth";

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
        headers: { ...cors, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, x-guild-id", "access-control-max-age": "600" },
      });
    }

    try {
      const response = await route(url.pathname, request, env);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, cors);
      console.error("unhandled", err instanceof Error ? err.message : "unknown"); // never log request bodies or tokens
      return json({ error: "internal" }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;

/** Routes that may call Discord; each one counts against the caller's per-IP budget. */
const DISCORD_ROUTES = new Set(["/api/token", "/api/me"]);

async function route(pathname: string, request: Request, env: Env): Promise<Response> {
  if (DISCORD_ROUTES.has(pathname)) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.DISCORD_CALLS.limit({ key: ip });
    if (!success) throw new HttpError(429, "rate_limited");
  }

  if (pathname === "/api/token" && request.method === "POST") {
    const body = await readJson<{ code?: unknown; guildId?: unknown }>(request);
    return json(await exchangeCode(env, body.code, body.guildId));
  }

  if (pathname === "/api/me" && request.method === "GET") {
    return json(await authenticate(request, env));
  }

  if (pathname === "/api/health") return json({ ok: true });

  throw new HttpError(404, "not_found");
}
