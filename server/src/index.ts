import { authenticate } from "./auth";
import { allowedOrigins, type Env } from "./env";
import { HttpError, json, readJson } from "./http";
import { exchangeCode } from "./oauth";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      const response = await route(request, env);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      return response;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, cors);
      console.error("unhandled", err instanceof Error ? err.message : "unknown"); // never log request bodies or tokens
      return json({ error: "internal" }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);

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
