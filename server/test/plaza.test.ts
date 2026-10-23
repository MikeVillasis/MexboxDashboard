import { applyD1Migrations, env, runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { friendCode } from "../../activity/src/identity.js";
import { clearAuthCache } from "../src/auth";
import { normaliseDna } from "../src/dna";
import { statusFromPresence } from "../src/presence";
import type { PresenceHub } from "../src/presence-hub";
import type { Env } from "../src/env";
import worker from "../src/index";

const GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const ORIGIN = "https://123456789012345678.discordsays.com";
// token → [discord id, guild they belong to, display name]
const USERS: Record<string, [string, string, string]> = {
  "token-ana": ["300000000000000001", GUILD, "Ana"],
  "token-ben": ["300000000000000002", GUILD, "Ben"],
  "token-cy": ["300000000000000003", GUILD, "Cy"],
  "token-out": ["300000000000000009", OTHER_GUILD, "Outsider"],
};
const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
const ANA_AVATAR = "0123456789abcdef0123456789abcdef";
const BEN_GUILD_AVATAR = "a_fedcba9876543210fedcba9876543210";
const DNA = { v: 1, id: "local", name: "Ana", skinColor: "#e0ac69", headId: 1, hairId: 2, hairColor: "#2C1B18", torsoId: 0, shirtColor: "#107C10", legsId: 0, legsColor: "#2B3A55", eyeUV: 0, mouthUV: 0 };

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://api.test${path}`, init), testEnv);
const auth = (token: string) => ({ authorization: `Bearer ${token}`, "x-guild-id": GUILD, origin: ORIGIN });

function mockDiscord() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    // Fake CDN: answers with the URL it was asked for, so tests can see which picture was chosen.
    if (url.startsWith("https://cdn.discordapp.com/")) {
      if (url.includes("broken")) return new Response("nope", { status: 404 });
      return new Response(url, { headers: { "content-type": "image/png" } });
    }
    const member = url.match(/\/users\/@me\/guilds\/(\d+)\/member$/);
    if (!member) return new Response("unexpected", { status: 500 });
    const token = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
    const user = USERS[token];
    if (!user) return new Response("{}", { status: 401 });
    if (user[1] !== member[1]) return new Response("{}", { status: 404 });
    return Response.json({
      nick: null,
      avatar: token === "token-ben" ? BEN_GUILD_AVATAR : null,
      user: { id: user[0], username: user[2].toLowerCase(), global_name: user[2], avatar: token === "token-ana" ? ANA_AVATAR : null },
    });
  });
}

beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
beforeEach(() => {
  clearAuthCache();
  testEnv.DISCORD_CLIENT_ID = "123456789012345678";
  testEnv.ALLOWED_GUILD_IDS = `${GUILD},${OTHER_GUILD}`;
  testEnv.EXTRA_ORIGINS = "";
  mockDiscord();
});
afterEach(() => vi.restoreAllMocks());

describe("avatar recipes", () => {
  it("normalises like C# AvatarDna: colours, clamped parts, 15-char names", () => {
    const dna = normaliseDna({ ...DNA, skinColor: "red", hairId: 99, headId: -3, name: "  a very long gamertag  ", extra: "dropped" }, "friend_X");
    expect(dna).toEqual({ ...DNA, id: "friend_X", name: "a very long gam", skinColor: "#E0AC69", hairId: 15, headId: 0 });
    expect(dna).not.toHaveProperty("extra");
  });

  it("rejects things that are not recipes", () => {
    expect(normaliseDna(null, "x")).toBeNull();
    expect(normaliseDna([], "x")).toBeNull();
    expect(normaliseDna({ ...DNA, name: "   " }, "x")).toBeNull();
    expect(normaliseDna({ ...DNA, pad: "x".repeat(2000) }, "x")).toBeNull();
  });

  it("saves and returns your avatar, normalised", async () => {
    await call("/api/me", { headers: auth("token-ana") });
    expect(await (await call("/api/avatar", { headers: auth("token-ana") })).json()).toEqual({ dna: null });

    const put = await call("/api/avatar", { method: "PUT", headers: { ...auth("token-ana"), "content-type": "application/json" }, body: JSON.stringify({ dna: { ...DNA, id: "spoofed" } }) });
    expect(put.status).toBe(200);
    const saved = { ...DNA, skinColor: "#E0AC69" };
    expect(await put.json()).toEqual({ dna: saved });
    expect(await (await call("/api/avatar", { headers: auth("token-ana") })).json()).toEqual({ dna: saved });
  });

  it("refuses a junk avatar", async () => {
    const res = await call("/api/avatar", { method: "PUT", headers: { ...auth("token-ana"), "content-type": "application/json" }, body: JSON.stringify({ dna: "nope" }) });
    expect(res.status).toBe(400);
  });
});

describe("away list", () => {
  it("lists other members of your server who have an avatar, by friend code only", async () => {
    for (const token of ["token-ana", "token-ben", "token-cy"]) await call("/api/me", { headers: auth(token) });
    await call("/api/avatar", { method: "PUT", headers: { ...auth("token-ben"), "content-type": "application/json" }, body: JSON.stringify({ dna: { ...DNA, name: "Ben" } }) });
    await call("/api/avatar", { method: "PUT", headers: { ...auth("token-ana"), "content-type": "application/json" }, body: JSON.stringify({ dna: DNA }) });
    // Outsider is in another (allowed) guild with an avatar: must never show up here.
    await call("/api/avatar", { method: "PUT", headers: { ...auth("token-out"), "x-guild-id": OTHER_GUILD, "content-type": "application/json" }, body: JSON.stringify({ dna: { ...DNA, name: "Out" } }) });

    const body = await (await call("/api/plaza/members", { headers: auth("token-ana") })).json() as { members: { code: string; dna: { id: string; name: string } }[] };
    const benCode = friendCode(USERS["token-ben"][0]);
    expect(body.members.map((m) => m.dna.name)).toEqual(["Ben"]); // not me, not Cy (no avatar), not the other guild
    expect(body.members[0].code).toBe(benCode);
    expect(body.members[0].dna.id).toBe(`friend_${benCode}`);
    expect(JSON.stringify(body)).not.toContain(USERS["token-ben"][0]); // no Discord ids leak
  });
});

// ───────────── Room (Durable Object over WebSocket) ─────────────

type Msg = Record<string, any>;

async function openRoom(instance: string, guild = GUILD) {
  const res = await call(`/api/room?guild=${guild}&instance=${instance}`, { headers: { upgrade: "websocket", origin: ORIGIN } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Msg[] = [];
  let closed: { code: number } | null = null;
  ws.addEventListener("message", (e) => { inbox.push(JSON.parse(e.data as string)); });
  ws.addEventListener("close", (e) => { closed = { code: e.code }; });
  const until = async <T>(check: () => T | undefined, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const hit = check();
      if (hit !== undefined) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}; inbox: ${JSON.stringify(inbox)}`);
  };
  return {
    ws,
    inbox,
    send: (packet: Msg) => ws.send(JSON.stringify(packet)),
    next: (type: string, match: (m: Msg) => boolean = () => true) => until(() => inbox.find((m) => m.type === type && match(m)), type),
    closed: () => until(() => closed ?? undefined, "close"),
    count: (type: string) => inbox.filter((m) => m.type === type).length,
  };
}

async function join(instance: string, token: string, extra: Msg = {}) {
  const client = await openRoom(instance);
  client.send({ type: "AUTH", token, dna: { ...DNA, name: USERS[token][2] }, x: 1, z: 2, ...extra });
  await client.next("WELCOME");
  return client;
}

describe("plaza room", () => {
  it("welcomes you with who is there and tells them you joined", async () => {
    const ana = await join("r1", "token-ana");
    expect((await ana.next("WELCOME")).peers).toEqual([]);
    const ben = await join("r1", "token-ben");
    const welcome = await ben.next("WELCOME");
    const anaCode = friendCode(USERS["token-ana"][0]);
    expect(welcome.you).toBe(friendCode(USERS["token-ben"][0]));
    expect(welcome.peers).toEqual([{ code: anaCode, dna: expect.objectContaining({ id: `friend_${anaCode}`, name: "Ana" }), x: 1, z: 2 }]);
    expect(await ana.next("JOIN")).toMatchObject({ code: welcome.you, dna: { name: "Ben" } });
  });

  it("relays moves (clamped), emotes and recipe changes from the sender's own seat only", async () => {
    const ana = await join("r2", "token-ana");
    const ben = await join("r2", "token-ben");
    const anaCode = friendCode(USERS["token-ana"][0]);

    ana.send({ type: "MOVE", x: 500, z: -3, code: "SPOOF1" });
    expect(await ben.next("MOVE")).toEqual({ type: "MOVE", code: anaCode, x: 9, z: -3 });
    ana.send({ type: "EMOTE", emote: "explode" });
    ana.send({ type: "EMOTE", emote: "wave" });
    expect(await ben.next("EMOTE")).toEqual({ type: "EMOTE", code: anaCode, emote: "wave" });
    expect(ben.count("EMOTE")).toBe(1);
    ana.send({ type: "DNA", dna: { ...DNA, shirtColor: "#ff0000", name: "Ana2" } });
    expect(await ben.next("DNA")).toMatchObject({ code: anaCode, dna: { id: `friend_${anaCode}`, shirtColor: "#FF0000", name: "Ana2" } });
  });

  it("announces when someone leaves", async () => {
    const ana = await join("r3", "token-ana");
    const ben = await join("r3", "token-ben");
    ben.ws.close(1000, "bye");
    expect(await ana.next("LEAVE")).toEqual({ type: "LEAVE", code: friendCode(USERS["token-ben"][0]) });
  });

  it("a second window replaces the first without a leave", async () => {
    const ana = await join("r4", "token-ana");
    const ben1 = await join("r4", "token-ben");
    const ben2 = await join("r4", "token-ben");
    expect((await ben1.closed()).code).toBe(4002);
    expect((await ben2.next("WELCOME")).peers.map((p: Msg) => p.code)).toEqual([friendCode(USERS["token-ana"][0])]);
    await ana.next("DNA");
    expect(ana.count("LEAVE")).toBe(0);
    expect(ana.count("JOIN")).toBe(1);
  });

  it("closes sockets that send anything before a valid AUTH", async () => {
    const early = await openRoom("r5");
    early.send({ type: "MOVE", x: 0, z: 0 });
    expect(await early.next("ERROR")).toEqual({ type: "ERROR", error: "auth_required" });
    expect((await early.closed()).code).toBe(4004);

    const bad = await openRoom("r5");
    bad.send({ type: "AUTH", token: "stolen", dna: DNA });
    expect(await bad.next("ERROR")).toEqual({ type: "ERROR", error: "invalid_token" });
    expect((await bad.closed()).code).toBe(4001);
  });

  it("refuses members of another server, even an allowed one, at the room door", async () => {
    const res = await call(`/api/room?guild=${OTHER_GUILD}&instance=r6`, { headers: { upgrade: "websocket", origin: ORIGIN } });
    const ws = res.webSocket!;
    ws.accept();
    const messages: Msg[] = [];
    ws.addEventListener("message", (e) => { messages.push(JSON.parse(e.data as string)); });
    ws.send(JSON.stringify({ type: "AUTH", token: "token-ana", dna: DNA })); // Ana's token, wrong guild for her
    for (let i = 0; i < 100 && !messages.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(messages[0]).toEqual({ type: "ERROR", error: "not_member" });
  });

  it("checks the door before opening a room", async () => {
    testEnv.ALLOWED_GUILD_IDS = GUILD;
    expect((await call(`/api/room?guild=${OTHER_GUILD}&instance=x`, { headers: { upgrade: "websocket", origin: ORIGIN } })).status).toBe(403);
    expect((await call(`/api/room?guild=${GUILD}&instance=bad/../id`, { headers: { upgrade: "websocket", origin: ORIGIN } })).status).toBe(400);
    expect((await call(`/api/room?guild=${GUILD}&instance=x`, { headers: { origin: ORIGIN } })).status).toBe(426);
    expect((await call(`/api/room?guild=${GUILD}&instance=x`, { headers: { upgrade: "websocket", origin: "https://evil.example" } })).status).toBe(403);
  });

  it("drops oversized and malformed messages", async () => {
    const ana = await join("r7", "token-ana");
    ana.send({ type: "DNA", dna: { ...DNA, pad: "x".repeat(3000) } });
    expect((await ana.closed()).code).toBe(4004);
  });

  it("mutes a flooding client without relaying the excess", async () => {
    const ana = await join("r8", "token-ana");
    const ben = await join("r8", "token-ben");
    for (let i = 0; i < 40; i++) ana.send({ type: "EMOTE", emote: "nod" });
    await ben.next("EMOTE");
    await new Promise((r) => setTimeout(r, 200));
    expect(ben.count("EMOTE")).toBeLessThanOrEqual(20);
  });
});

// ───────────── Thought bubbles (Discord presences) ─────────────

describe("statuses from Discord presences", () => {
  it("prefers games, then music (song – artist), then watching; ignores custom statuses and offline", () => {
    expect(statusFromPresence({ status: "online", activities: [{ type: 4, name: "Custom Status", state: "brb" }, { type: 0, name: "Halo Infinite" }] }))
      .toEqual({ kind: "playing", text: "Halo Infinite" });
    expect(statusFromPresence({ status: "online", activities: [{ type: 2, name: "Spotify", details: "Still Alive", state: "GLaDOS" }] }))
      .toEqual({ kind: "listening", text: "Still Alive – GLaDOS" });
    expect(statusFromPresence({ status: "dnd", activities: [{ type: 2, name: "Spotify", details: "Song" }, { type: 0, name: "Portal 2" }] }))
      .toEqual({ kind: "playing", text: "Portal 2" });
    expect(statusFromPresence({ status: "idle", activities: [{ type: 3, name: "YouTube", details: "a video" }] }))
      .toEqual({ kind: "watching", text: "a video" });
    expect(statusFromPresence({ status: "online", activities: [{ type: 4, state: "just vibing" }] })).toBeNull();
    expect(statusFromPresence({ status: "offline", activities: [{ type: 0, name: "Halo" }] })).toBeNull();
  });

  it("cleans and clips text", () => {
    const status = statusFromPresence({ status: "online", activities: [{ type: 0, name: `  ${"x".repeat(80)}\n\u0007 ` }] });
    expect(status?.text.length).toBe(48);
    expect(status?.text.endsWith("…")).toBe(true);
  });
});

describe("thought bubbles in the room", () => {
  const hub = () => testEnv.PRESENCE.get(testEnv.PRESENCE.idFromName("hub"));
  const presence = (guild: string, user: string, activities: unknown[], status = "online") =>
    runInDurableObject(hub(), (h: PresenceHub) => h.dispatch({ op: 0, t: "PRESENCE_UPDATE", d: { guild_id: guild, user: { id: user }, status, activities } }));
  const BEN = USERS["token-ben"][0];
  const benCode = friendCode(BEN);

  it("pushes a member's activity to everyone in their server's rooms, present or away", async () => {
    const ana = await join("b1", "token-ana");
    await presence(GUILD, BEN, [{ type: 0, name: "Halo Infinite" }]); // Ben isn't even in the room: he's away
    expect(await ana.next("STATUS")).toEqual({ type: "STATUS", code: benCode, status: { kind: "playing", text: "Halo Infinite" } });

    await presence(GUILD, BEN, [{ type: 0, name: "Halo Infinite" }]); // unchanged: no duplicate push
    await presence(GUILD, BEN, [], "offline");
    expect(await ana.next("STATUS", (m) => m.status === null)).toEqual({ type: "STATUS", code: benCode, status: null });
    expect(ana.count("STATUS")).toBe(2);
  });

  it("hands newcomers the current statuses in WELCOME", async () => {
    await join("b2", "token-cy"); // someone in the room keeps the hub subscribed for this server
    await presence(GUILD, BEN, [{ type: 2, name: "Spotify", details: "Still Alive", state: "GLaDOS" }]);
    const ben = await join("b2", "token-ben");
    expect((await ben.next("WELCOME")).statuses[benCode]).toEqual({ kind: "listening", text: "Still Alive – GLaDOS" });
  });

  it("never leaks presences from servers that aren't allowlisted", async () => {
    const ana = await join("b3", "token-ana");
    testEnv.ALLOWED_GUILD_IDS = GUILD; // OTHER_GUILD no longer allowed
    await presence(OTHER_GUILD, BEN, [{ type: 0, name: "Secret Game" }]);
    await presence(GUILD, USERS["token-cy"][0], [{ type: 0, name: "Tetris" }]);
    await ana.next("STATUS", (m) => m.status?.text === "Tetris");
    expect(ana.inbox.some((m) => m.status?.text === "Secret Game")).toBe(false);
  });
});

// ───────────── Profile pictures (gamercards) ─────────────

describe("profile pictures", () => {
  const picture = (code: string, token = "token-ana") => call(`/api/avatar-image/${code}`, { headers: auth(token) });
  const [ANA, BEN, CY, OUT] = ["token-ana", "token-ben", "token-cy", "token-out"].map((t) => USERS[t][0]);

  beforeEach(async () => { for (const token of ["token-ana", "token-ben", "token-cy"]) await call("/api/me", { headers: auth(token) }); });

  it("serves a member's own Discord avatar, preferring their server avatar, else Discord's default", async () => {
    const ana = await picture(friendCode(ANA));
    expect(ana.status).toBe(200);
    expect(ana.headers.get("content-type")).toBe("image/png");
    expect(await ana.text()).toBe(`https://cdn.discordapp.com/avatars/${ANA}/${ANA_AVATAR}.png?size=256`);
    expect(await (await picture(friendCode(BEN))).text()).toBe(`https://cdn.discordapp.com/guilds/${GUILD}/users/${BEN}/avatars/${BEN_GUILD_AVATAR}.png?size=256`);
    expect(await (await picture(friendCode(CY))).text()).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
  });

  it("falls back to the default avatar when the CDN doesn't have the picture", async () => {
    await testEnv.DB.prepare("UPDATE members SET avatar_hash = ?1 WHERE discord_id = ?2").bind("broken", ANA).run();
    // "broken" isn't a valid hash on sign-in, but simulate a stale row the CDN no longer serves.
    expect(await (await picture(friendCode(ANA))).text()).toMatch(/embed\/avatars\/[0-5]\.png$/);
  });

  it("only finds members of your own server, and needs a signed-in member", async () => {
    await call("/api/me", { headers: { ...auth("token-out"), "x-guild-id": OTHER_GUILD } });
    expect((await picture(friendCode(OUT))).status).toBe(404); // exists, but in another server
    expect((await call(`/api/avatar-image/${friendCode(ANA)}`)).status).toBe(401);
    expect((await picture("bad!!")).status).toBe(400);
  });

  it("never stores anything but well-formed hashes", async () => {
    const row = await testEnv.DB.prepare("SELECT avatar_hash, guild_avatar_hash FROM members WHERE discord_id = ?1").bind(BEN).first();
    expect(row).toEqual({ avatar_hash: null, guild_avatar_hash: BEN_GUILD_AVATAR });
  });
});
