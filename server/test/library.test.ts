import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { friendCode } from "../../activity/src/identity.js";
import { clearAuthCache } from "../src/auth";
import type { Env } from "../src/env";
import worker from "../src/index";

const GUILD = "111111111111111111";
const USER = "333333333333333333";      // Ana: owns the PC
const OTHER_USER = "444444444444444444"; // Ben: same server, reads Ana's gamercard
const ORIGIN = "https://123456789012345678.discordsays.com";
const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

let ip = 0;
const call = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, {
    ...init, headers: { "cf-connecting-ip": `10.1.0.${++ip % 250}`, ...(init.headers as Record<string, string>) },
  }), testEnv);

const activity = (path: string, method = "GET", token = "user-token") =>
  call(path, { method, headers: { origin: ORIGIN, authorization: `Bearer ${token}`, "x-guild-id": GUILD } });

function mockDiscord() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const member = url.match(/\/users\/@me\/guilds\/(\d+)\/member$/);
    if (member && member[1] === GUILD) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer user-token") return Response.json({ nick: null, user: { id: USER, username: "ana", global_name: "Ana" } });
      if (auth === "Bearer ben-token") return Response.json({ nick: null, user: { id: OTHER_USER, username: "ben", global_name: "Ben" } });
      return new Response("{}", { status: 401 });
    }
    if (url.startsWith("https://cdn.cloudflare.steamstatic.com/")) return new Response("jpeg", { headers: { "content-type": "image/jpeg" } });
    return real(input, init);
  });
}

async function pairPc(token = "user-token"): Promise<string> {
  const { code } = (await (await activity("/api/pair", "POST", token)).json()) as { code: string };
  const res = await call("/api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "pc" }) });
  return ((await res.json()) as { token: string }).token;
}

/** The Windows app's socket to its DeviceHub. */
async function connect(token: string) {
  const res = await call("/api/device/ws", { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Record<string, unknown>[] = [];
  let closed: number | null = null;
  ws.addEventListener("message", (e) => { if (e.data !== "pong") inbox.push(JSON.parse(e.data as string)); else inbox.push({ type: "pong" }); });
  ws.addEventListener("close", (e) => { closed = e.code; });
  const next = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const at = inbox.findIndex((m) => m.type === type);
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type}`);
  };
  return { ws, next, send: (p: unknown) => ws.send(JSON.stringify(p)), closed: () => closed };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

const GAMES = [
  { id: "Steam:1086940", title: "Baldur's Gate 3", platform: "Steam", cover: "https://cdn.cloudflare.steamstatic.com/steam/apps/1086940/library_600x900.jpg" },
  { id: "Battle.net:fenris", title: "Diablo IV", platform: "Battle.net", cover: "https://evil.example/x.jpg" },
  { id: "bad id <script>", title: "nope", platform: "x", cover: null },
  { id: "Riot:valorant.live", title: "", platform: "Riot", cover: null },
];

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
  await activity("/api/me", "GET", "ben-token"); // Ben has signed in to this server
});

afterEach(() => vi.restoreAllMocks());

describe("publishing from a linked PC", () => {
  it("stores a validated library that other members of the server can read", async () => {
    const pc = await connect(await pairPc());
    pc.send({ type: "LIBRARY", games: GAMES });
    expect(await pc.next("OK")).toMatchObject({ what: "LIBRARY", games: 2 });

    const res = await activity(`/api/library/${friendCode(USER)}`, "GET", "ben-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: Record<string, unknown>[]; devices: number };
    expect(body.devices).toBe(1);
    expect(body.games).toEqual([
      { id: "Steam:1086940", title: "Baldur's Gate 3", platform: "steam", cover: GAMES[0].cover },
      { id: "Battle.net:fenris", title: "Diablo IV", platform: "battle.net", cover: null }, // foreign cover host dropped
    ]);
  });

  it("shows now playing while the PC is connected and clears it when it disconnects", async () => {
    const pc = await connect(await pairPc());
    pc.send({ type: "LIBRARY", games: GAMES.slice(0, 1) });
    await pc.next("OK");
    pc.send({ type: "NOW_PLAYING", media: { title: "Song", artist: "Band", app: "Spotify", playing: true, extra: "x" } });
    await settle();
    const lib = async () => (await (await activity(`/api/library/${friendCode(USER)}`)).json()) as { nowPlaying: unknown };
    expect((await lib()).nowPlaying).toEqual({ title: "Song", artist: "Band", app: "spotify", playing: true });

    pc.ws.close(1000, "bye");
    await settle();
    expect((await lib()).nowPlaying).toBeNull();
  });

  it("answers keep-alive pings", async () => {
    const pc = await connect(await pairPc());
    pc.ws.send("ping");
    expect(await pc.next("pong")).toEqual({ type: "pong" });
  });

  it("ignores a second library within the rate window", async () => {
    const pc = await connect(await pairPc());
    pc.send({ type: "LIBRARY", games: GAMES.slice(0, 1) });
    await pc.next("OK");
    pc.send({ type: "LIBRARY", games: GAMES.slice(0, 2) });
    await settle();
    const body = (await (await activity(`/api/library/${friendCode(USER)}`)).json()) as { games: unknown[] };
    expect(body.games).toHaveLength(1);
  });

  it("closes the socket on junk", async () => {
    const pc = await connect(await pairPc());
    pc.ws.send("not json");
    await settle();
    expect(pc.closed()).toBe(4004);
  });

  it("a new connection from the same PC replaces the old one", async () => {
    const token = await pairPc();
    const first = await connect(token);
    await connect(token);
    await settle();
    expect(first.closed()).toBe(4002);
  });

  it("refuses the socket without a valid device token", async () => {
    expect((await call("/api/device/ws", { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect((await call("/api/device/ws", { headers: { upgrade: "websocket", authorization: "Bearer mxd_nope" } })).status).toBe(401);
    expect((await call("/api/device/ws", { headers: { authorization: "Bearer mxd_nope" } })).status).toBe(426);
  });
});

describe("reading libraries", () => {
  it("returns an empty library for a member without a linked PC", async () => {
    const body = await (await activity(`/api/library/${friendCode(OTHER_USER)}`)).json();
    expect(body).toEqual({ games: [], nowPlaying: null, updatedAt: null, devices: 0 });
  });

  it("needs a signed-in member and a well-formed code", async () => {
    expect((await call(`/api/library/${friendCode(USER)}`, { headers: { origin: ORIGIN } })).status).toBe(401);
    expect((await activity("/api/library/bad")).status).toBe(400);
  });

  it("proxies covers from store CDNs only", async () => {
    const ok = await activity(`/api/game-cover?url=${encodeURIComponent(GAMES[0].cover!)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect((await activity(`/api/game-cover?url=${encodeURIComponent("https://evil.example/x.jpg")}`)).status).toBe(400);
    expect((await activity(`/api/game-cover?url=${encodeURIComponent("http://cdn.cloudflare.steamstatic.com/x.jpg")}`)).status).toBe(400);
  });
});

describe("remote launch", () => {
  const launch = (gameId: string, token = "user-token") =>
    call("/api/launch", { method: "POST", headers: { origin: ORIGIN, authorization: `Bearer ${token}`, "x-guild-id": GUILD, "content-type": "application/json" }, body: JSON.stringify({ gameId }) });

  async function publishedPc(token = "user-token") {
    const pc = await connect(await pairPc(token));
    pc.send({ type: "LIBRARY", games: GAMES.slice(0, 2) });
    await pc.next("OK");
    return pc;
  }

  it("relays a launch of a published game to the owner's PC and reports its answer", async () => {
    const pc = await publishedPc();
    const pending = launch("Steam:1086940");
    const request = await pc.next("LAUNCH");
    expect(request.gameId).toBe("Steam:1086940");
    pc.send({ type: "LAUNCH_RESULT", requestId: request.requestId, ok: true });
    expect(await (await pending).json()).toEqual({ result: "launched", device: "pc" });
  });

  it("passes on the PC's refusal", async () => {
    const pc = await publishedPc();
    const pending = launch("Battle.net:fenris");
    const request = await pc.next("LAUNCH");
    pc.send({ type: "LAUNCH_RESULT", requestId: request.requestId, ok: false, reason: "not installed" });
    expect(await (await pending).json()).toEqual({ result: "failed", reason: "not installed", device: "pc" });
  });

  it("refuses games that aren't in the published library", async () => {
    await publishedPc();
    const res = await launch("Steam:999999");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "game_not_in_library" });
  });

  it("never reaches someone else's PC", async () => {
    const pc = await publishedPc(); // Ana's
    const res = await launch("Steam:1086940", "ben-token");
    expect(res.status).toBe(404);
    await settle();
    await expect(pc.next("LAUNCH")).rejects.toThrow("no LAUNCH");
  });

  it("says when the PC is offline", async () => {
    const pc = await publishedPc();
    pc.ws.close(1000, "bye");
    await settle();
    expect(await (await launch("Steam:1086940")).json()).toEqual({ result: "offline", device: "pc" });
  });

  it("rejects malformed ids and rate-limits per member", async () => {
    expect((await launch("bad <id>", "ben-token")).status).toBe(400);
    await publishedPc("ben-token");
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await launch("Steam:999999", "ben-token")).status);
    expect(statuses).toContain(429);
  });
});
