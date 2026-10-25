import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";

const GUILD = "111111111111111111";
const USER = "333333333333333333";
const OTHER_USER = "444444444444444444";
const ORIGIN = "https://123456789012345678.discordsays.com";
const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

let ipCounter = 0;
const call = (path: string, init: RequestInit = {}, ip?: string) =>
  worker.fetch(new Request(`https://api.test${path}`, {
    ...init,
    headers: { "cf-connecting-ip": ip ?? `10.0.0.${++ipCounter % 250}`, ...(init.headers as Record<string, string>) },
  }), testEnv);

/** The Activity, signed in as Ana (or Ben with "ben-token"). */
const activity = (path: string, method = "GET", token = "user-token") =>
  call(path, { method, headers: { origin: ORIGIN, authorization: `Bearer ${token}`, "x-guild-id": GUILD } });

/** The Windows app: no Origin header, device token if it has one. */
const desktop = (path: string, method = "GET", body?: unknown, token?: string, ip?: string) =>
  call(path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, ip);

function mockDiscord() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const member = url.match(/\/users\/@me\/guilds\/(\d+)\/member$/);
    if (member && member[1] === GUILD) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer user-token") return Response.json({ nick: null, user: { id: USER, username: "ana", global_name: "Ana" } });
      if (auth === "Bearer ben-token") return Response.json({ nick: null, user: { id: OTHER_USER, username: "ben", global_name: "Ben" } });
      return new Response("{}", { status: 401 });
    }
    return new Response("unexpected", { status: 500 });
  });
}

async function newCode(token = "user-token"): Promise<string> {
  const res = await activity("/api/pair", "POST", token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

async function pair(name = "living room pc") {
  const code = await newCode();
  const res = await desktop("/api/pair/redeem", "POST", { code, name });
  expect(res.status).toBe(201);
  return (await res.json()) as { deviceId: string; token: string; name: string; displayName: string };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  clearAuthCache();
  testEnv.DISCORD_CLIENT_ID = "123456789012345678";
  testEnv.DISCORD_CLIENT_SECRET = "test-secret";
  testEnv.ALLOWED_GUILD_IDS = GUILD;
  testEnv.EXTRA_ORIGINS = "";
  await testEnv.DB.batch([testEnv.DB.prepare("DELETE FROM devices"), testEnv.DB.prepare("DELETE FROM pairing_codes")]);
  mockDiscord();
});

afterEach(() => vi.restoreAllMocks());

describe("pairing", () => {
  it("issues a 6-character code that a desktop redeems once for a device token", async () => {
    const code = await newCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    const res = await desktop("/api/pair/redeem", "POST", { code: code.toLowerCase(), name: "  living room pc  " });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    expect(body.token).toMatch(/^mxd_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ name: "living room pc", displayName: "Ana" });

    const again = await desktop("/api/pair/redeem", "POST", { code, name: "x" });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "invalid_code" });
  });

  it("stores only a hash of the device token", async () => {
    const { deviceId, token } = await pair();
    const row = await testEnv.DB.prepare("SELECT * FROM devices WHERE id = ?").bind(deviceId).first<Record<string, string>>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token.slice(4));
  });

  it("refuses expired, unknown and malformed codes", async () => {
    const code = await newCode();
    await testEnv.DB.prepare("UPDATE pairing_codes SET expires_at = 1 WHERE code = ?").bind(code).run();
    expect((await desktop("/api/pair/redeem", "POST", { code })).status).toBe(404);
    expect((await desktop("/api/pair/redeem", "POST", { code: "ZZZZZZ" })).status).toBe(404);
    expect((await desktop("/api/pair/redeem", "POST", { code: "AB0O1I" })).status).toBe(400);
    expect((await desktop("/api/pair/redeem", "POST", { code: 123456 })).status).toBe(400);
  });

  it("a new code replaces the member's previous one", async () => {
    const first = await newCode();
    const second = await newCode();
    expect((await desktop("/api/pair/redeem", "POST", { code: first })).status).toBe(404);
    expect((await desktop("/api/pair/redeem", "POST", { code: second })).status).toBe(201);
  });

  it("needs a signed-in member to start pairing", async () => {
    const res = await call("/api/pair", { method: "POST", headers: { origin: ORIGIN, "x-guild-id": GUILD } });
    expect(res.status).toBe(401);
  });

  it("caps devices per member", async () => {
    for (let i = 0; i < 5; i++) await pair(`pc ${i}`);
    const res = await desktop("/api/pair/redeem", "POST", { code: await newCode(), name: "one too many" });
    expect(res.status).toBe(409);
  });

  it("rate-limits redeeming per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await desktop("/api/pair/redeem", "POST", { code: "ZZZZZZ" }, undefined, "203.0.113.9")).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("linked devices", () => {
  it("lets the desktop check its link and unlink itself", async () => {
    const { token, deviceId } = await pair();
    const me = await desktop("/api/device", "GET", undefined, token);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ deviceId, name: "living room pc", displayName: "Ana" });

    expect((await desktop("/api/device", "DELETE", undefined, token)).status).toBe(204);
    expect((await desktop("/api/device", "GET", undefined, token)).status).toBe(401);
  });

  it("rejects missing and unknown device tokens", async () => {
    expect((await desktop("/api/device")).status).toBe(401);
    expect((await desktop("/api/device", "GET", undefined, "mxd_nope")).status).toBe(401);
    expect((await desktop("/api/device", "GET", undefined, "user-token")).status).toBe(401);
  });

  it("lists the member's devices in the Activity and lets them unlink one", async () => {
    const { deviceId, token } = await pair();
    const list = (await (await activity("/api/devices")).json()) as { devices: { id: string; name: string }[] };
    expect(list.devices.map((d) => [d.id, d.name])).toEqual([[deviceId, "living room pc"]]);

    expect((await activity(`/api/devices/${deviceId}`, "DELETE")).status).toBe(204);
    expect((await desktop("/api/device", "GET", undefined, token)).status).toBe(401);
  });

  it("never shows or unlinks someone else's device", async () => {
    const { deviceId, token } = await pair();
    const list = (await (await activity("/api/devices", "GET", "ben-token")).json()) as { devices: unknown[] };
    expect(list.devices).toEqual([]);
    expect((await activity(`/api/devices/${deviceId}`, "DELETE", "ben-token")).status).toBe(404);
    expect((await desktop("/api/device", "GET", undefined, token)).status).toBe(200);
  });

  it("stops working when the server is removed from the allowlist", async () => {
    const { token } = await pair();
    testEnv.ALLOWED_GUILD_IDS = "999999999999999999";
    expect((await desktop("/api/device", "GET", undefined, token)).status).toBe(403);
  });
});
