// Desktop pairing (phase 06): a member links their Windows app to their Discord identity in this server.
//
//   Activity (Discord sign-in)          POST /api/pair            → { code, expiresAt }   short-lived, single use
//   Windows app (no account yet)        POST /api/pair/redeem     { code, name } → { deviceId, token, ... }
//   Windows app (device token)          GET /api/device           → who it's linked to (also "is my token still good?")
//                                       DELETE /api/device        → unlink from the PC
//   Activity (Discord sign-in)          GET /api/devices          → my linked PCs
//                                       DELETE /api/devices/:id   → unlink from Discord
//
// Device tokens are random 256-bit secrets shown to the app once; only their SHA-256 is stored. Codes are deleted on
// use and expire after 10 minutes; redeeming has its own per-IP rate limit, so guessing a live code is hopeless.

import { authenticate, clientIp } from "./auth";
import { allowedGuilds, type Env } from "./env";
import { HttpError, json, readJson, sha256Hex } from "./http";

// Same alphabet as friend codes (no 0/O/1/I): easy to read off the screen and type.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICES = 5;          // per member per server
const TOKEN_PREFIX = "mxd_";
const LAST_SEEN_EVERY_MS = 5 * 60 * 1000; // don't write last_seen on every request

export interface Device {
  id: string;
  guildId: string;
  discordId: string;
  name: string;
  displayName: string;
}

const randomCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(""); // 256 % 32 == 0: unbiased
};

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Activity: a fresh code for the signed-in member (any earlier unused code of theirs stops working). */
export async function startPairing(request: Request, env: Env): Promise<Response> {
  const member = await authenticate(request, env);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?1").bind(now),
    env.DB.prepare("DELETE FROM pairing_codes WHERE guild_id = ?1 AND discord_id = ?2").bind(member.guildId, member.discordId),
  ]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const expiresAt = now + CODE_TTL_MS;
    const inserted = await env.DB.prepare(
      "INSERT INTO pairing_codes (code, guild_id, discord_id, expires_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (code) DO NOTHING",
    ).bind(code, member.guildId, member.discordId, expiresAt).run();
    if (inserted.meta.changes === 1) return json({ code, expiresAt });
  }
  throw new HttpError(503, "try_again");
}

/** Windows app: trade a code for a device token. The code is consumed whether or not the rest succeeds. */
export async function redeemPairing(request: Request, env: Env): Promise<Response> {
  const { success } = await env.PAIRING.limit({ key: clientIp(request) });
  if (!success) throw new HttpError(429, "rate_limited");

  const body = await readJson<{ code?: unknown; name?: unknown }>(request);
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code)) throw new HttpError(400, "bad_code");
  const name = typeof body.name === "string" ? body.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";

  const claimed = await env.DB.prepare(
    "DELETE FROM pairing_codes WHERE code = ?1 AND expires_at > ?2 RETURNING guild_id, discord_id",
  ).bind(code, Date.now()).first<{ guild_id: string; discord_id: string }>();
  if (!claimed) throw new HttpError(404, "invalid_code");
  if (!allowedGuilds(env).has(claimed.guild_id)) throw new HttpError(403, "guild_not_allowed");

  const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE guild_id = ?1 AND discord_id = ?2")
    .bind(claimed.guild_id, claimed.discord_id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_DEVICES) throw new HttpError(409, "too_many_devices");

  const id = crypto.randomUUID();
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO devices (id, guild_id, discord_id, token_hash, name, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
  ).bind(id, claimed.guild_id, claimed.discord_id, await sha256Hex(token), name || "windows pc", now).run();

  const member = await env.DB.prepare("SELECT display_name FROM members WHERE guild_id = ?1 AND discord_id = ?2")
    .bind(claimed.guild_id, claimed.discord_id).first<{ display_name: string }>();
  return json({ deviceId: id, token, name: name || "windows pc", displayName: member?.display_name ?? "player" }, 201);
}

/** Resolves the device behind a `Bearer mxd_…` token, or 401. Also refuses devices of servers no longer allowlisted. */
export async function authenticateDevice(request: Request, env: Env): Promise<Device> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) throw new HttpError(401, "missing_token");

  const row = await env.DB.prepare(
    `SELECT d.id, d.guild_id, d.discord_id, d.name, d.last_seen, m.display_name
       FROM devices d JOIN members m ON m.guild_id = d.guild_id AND m.discord_id = d.discord_id
      WHERE d.token_hash = ?1`,
  ).bind(await sha256Hex(token)).first<{ id: string; guild_id: string; discord_id: string; name: string; last_seen: number; display_name: string }>();
  if (!row) throw new HttpError(401, "unknown_device");
  if (!allowedGuilds(env).has(row.guild_id)) throw new HttpError(403, "guild_not_allowed");

  const now = Date.now();
  if (now - row.last_seen > LAST_SEEN_EVERY_MS) {
    await env.DB.prepare("UPDATE devices SET last_seen = ?1 WHERE id = ?2").bind(now, row.id).run();
  }
  return { id: row.id, guildId: row.guild_id, discordId: row.discord_id, name: row.name, displayName: row.display_name };
}

export async function getDevice(request: Request, env: Env): Promise<Response> {
  const device = await authenticateDevice(request, env);
  return json({ deviceId: device.id, name: device.name, displayName: device.displayName });
}

/** Unlink from the PC side: the token stops working immediately. */
export async function deleteDevice(request: Request, env: Env): Promise<Response> {
  const device = await authenticateDevice(request, env);
  await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(device.id).run();
  return new Response(null, { status: 204 });
}

export async function listDevices(request: Request, env: Env): Promise<Response> {
  const member = await authenticate(request, env);
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, last_seen FROM devices WHERE guild_id = ?1 AND discord_id = ?2 ORDER BY created_at",
  ).bind(member.guildId, member.discordId).all<{ id: string; name: string; created_at: number; last_seen: number }>();
  return json({ devices: results.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeen: d.last_seen })) });
}

/** Unlink from the Activity: only the owner's own devices (anything else looks like it doesn't exist). */
export async function unlinkDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const member = await authenticate(request, env);
  if (!/^[0-9a-f-]{36}$/.test(deviceId)) throw new HttpError(404, "not_found");
  const removed = await env.DB.prepare("DELETE FROM devices WHERE id = ?1 AND guild_id = ?2 AND discord_id = ?3")
    .bind(deviceId, member.guildId, member.discordId).run();
  if (removed.meta.changes !== 1) throw new HttpError(404, "not_found");
  return new Response(null, { status: 204 });
}
