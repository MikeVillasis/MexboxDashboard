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

  it("answers unknown paths with 404", async () => {
    expect((await call("/nope")).status).toBe(404);
  });
});
