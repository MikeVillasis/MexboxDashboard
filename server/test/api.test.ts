import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";

const GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const USER = "333333333333333333";
const ORIGIN = "https://123456789012345678.discordsays.com";
const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, init), testEnv);

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body) });

/** Fake Discord: one valid code, one valid token, USER is a member of GUILD only. */
function mockDiscord() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/oauth2/token")) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("code") !== "goodcode123" || form.get("client_secret") !== "test-secret") return new Response("{}", { status: 400 });
      return Response.json({ access_token: "user-token", refresh_token: "refresh", expires_in: 604800, scope: "identify guilds.members.read" });
    }
    const member = url.match(/\/users\/@me\/guilds\/(\d+)\/member$/);
    if (member) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer user-token") return new Response("{}", { status: 401 });
      if (member[1] !== GUILD) return new Response("{}", { status: 404 });
      return Response.json({ nick: null, user: { id: USER, username: "ana", global_name: "Ana" } });
    }
    return new Response("unexpected", { status: 500 });
  });
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(() => {
  clearAuthCache();
  testEnv.DISCORD_CLIENT_ID = "123456789012345678";
  testEnv.DISCORD_CLIENT_SECRET = "test-secret";
  testEnv.ALLOWED_GUILD_IDS = GUILD;
  testEnv.EXTRA_ORIGINS = "";
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/token", () => {
  it("exchanges a code for a member of an allowed guild and records them", async () => {
    mockDiscord();
    const res = await post("/api/token", { code: "goodcode123", guildId: GUILD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.access_token).toBe("user-token");
    expect(body).not.toHaveProperty("refresh_token");
    expect(body.member).toEqual({ guildId: GUILD, discordId: USER, displayName: "Ana" });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const row = await testEnv.DB.prepare("SELECT display_name FROM members WHERE guild_id = ? AND discord_id = ?").bind(GUILD, USER).first();
    expect(row?.display_name).toBe("Ana");
  });

  it("withholds the token from a server that is not allowlisted", async () => {
    mockDiscord();
    const res = await post("/api/token", { code: "goodcode123", guildId: OTHER_GUILD });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "guild_not_allowed" });
  });

  it("withholds the token when the user is not in the guild", async () => {
    mockDiscord();
    testEnv.ALLOWED_GUILD_IDS = `${GUILD},${OTHER_GUILD}`;
    const res = await post("/api/token", { code: "goodcode123", guildId: OTHER_GUILD });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_member" });
  });

  it("rejects a bad code and malformed input without calling Discord twice", async () => {
    const fetch = mockDiscord();
    expect((await post("/api/token", { code: "wrongcode999", guildId: GUILD })).status).toBe(400);
    expect((await post("/api/token", { code: "x;drop", guildId: GUILD })).status).toBe(400);
    const raw = await call("/api/token", { method: "POST", headers: { origin: ORIGIN }, body: "not json" });
    expect(raw.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses oversized bodies", async () => {
    mockDiscord();
    const res = await post("/api/token", { code: "goodcode123", guildId: GUILD, pad: "x".repeat(5000) });
    expect(res.status).toBe(413);
  });

  it("stops reading a streamed body without Content-Length at the cap", async () => {
    const fetch = mockDiscord();
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 1000) { controller.close(); return; } // 1000 x 1 KiB would be ~1 MiB if fully read
        controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const res = await call("/api/token", { method: "POST", headers: { origin: ORIGIN }, body, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("turns away a caller over the limit before reaching Discord, keyed by client IP", async () => {
    const fetch = mockDiscord();
    const limit = vi.spyOn(testEnv.DISCORD_CALLS, "limit").mockResolvedValue({ success: false });
    const res = await post("/api/token", { code: "goodcode123", guildId: GUILD }, { "cf-connecting-ip": "203.0.113.9" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the real limiter allows 60 Discord calls a minute per IP, then refuses", async () => {
    mockDiscord();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const headers = { authorization: `Bearer unknown-${i}`, "x-guild-id": GUILD, "cf-connecting-ip": "198.51.100.77" };
      statuses.push((await call("/api/me", { headers })).status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true); // within budget: Discord says the token is bad
    expect(statuses[60]).toBe(429);
    const otherIp = await call("/api/me", { headers: { authorization: "Bearer unknown-x", "x-guild-id": GUILD, "cf-connecting-ip": "198.51.100.78" } });
    expect(otherIp.status).toBe(401);
  });

  it("does not spend budget on cached sign-ins or requests without a token", async () => {
    mockDiscord();
    const headers = { authorization: "Bearer user-token", "x-guild-id": GUILD, "cf-connecting-ip": "198.51.100.90" };
    await call("/api/me", { headers });
    const limit = vi.spyOn(testEnv.DISCORD_CALLS, "limit");
    for (let i = 0; i < 5; i++) await call("/api/me", { headers });
    await call("/api/me", { headers: { "x-guild-id": GUILD } });
    expect(limit).not.toHaveBeenCalled();
  });

  it("does not count health checks or static files", async () => {
    const limit = vi.spyOn(testEnv.DISCORD_CALLS, "limit");
    await call("/api/health");
    await call("/");
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("origin and auth", () => {
  it("refuses requests from a foreign web page", async () => {
    const fetch = mockDiscord();
    const res = await post("/api/token", { code: "goodcode123", guildId: GUILD }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a token for /api/me", async () => {
    expect((await call("/api/me", { headers: { "x-guild-id": GUILD } })).status).toBe(401);
  });

  it("verifies /api/me with Discord once, then serves it from cache", async () => {
    const fetch = mockDiscord();
    const headers = { authorization: "Bearer user-token", "x-guild-id": GUILD };
    const first = await call("/api/me", { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ guildId: GUILD, discordId: USER, displayName: "Ana" });
    expect((await call("/api/me", { headers })).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not trust a cached identity for a different guild", async () => {
    mockDiscord();
    testEnv.ALLOWED_GUILD_IDS = `${GUILD},${OTHER_GUILD}`;
    await call("/api/me", { headers: { authorization: "Bearer user-token", "x-guild-id": GUILD } });
    const res = await call("/api/me", { headers: { authorization: "Bearer user-token", "x-guild-id": OTHER_GUILD } });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid token", async () => {
    mockDiscord();
    const res = await call("/api/me", { headers: { authorization: "Bearer stolen", "x-guild-id": GUILD } });
    expect(res.status).toBe(401);
  });

  it("answers unknown API paths with 404", async () => {
    expect((await call("/api/nope")).status).toBe(404);
  });
});

describe("Discord proxy and static front end", () => {
  it("accepts API calls with the /.proxy prefix", async () => {
    mockDiscord();
    expect(await (await call("/.proxy/api/health")).json()).toEqual({ ok: true });
    const res = await post("/.proxy/api/token", { code: "goodcode123", guildId: GUILD });
    expect(res.status).toBe(200);
  });

  it("serves the Activity page from / and /.proxy/", async () => {
    for (const path of ["/", "/.proxy/"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<script src="discord-host.js"></script>');
      expect(html).not.toContain("importmap");
    }
  });

  it("serves static files to any origin but keeps the API origin-locked", async () => {
    const asset = await call("/app.js", { headers: { origin: "https://elsewhere.example" } });
    expect(asset.status).toBe(200);
    const api = await call("/api/health", { headers: { origin: "https://elsewhere.example" } });
    expect(api.status).toBe(403);
  });
});
