// One authoritative plaza per Discord Activity instance (Durable Object named "<guild>:<instance>"), using WebSocket
// hibernation so an idle room costs nothing. Per-socket state lives in the socket attachment and survives hibernation.
//
// Client → room                          Room → client
//   AUTH { token, dna, x, z }  (first)     WELCOME { you, peers: [{ code, dna, x, z }], statuses: { code: status } }
//   MOVE { x, z }                          JOIN { code, dna, x, z } · LEAVE { code }
//   EMOTE { emote }                        MOVE { code, x, z } · EMOTE { code, emote } · DNA { code, dna }
//   DNA { dna }                            STATUS { code, status|null }  (Discord "playing/listening", any member)
//                                          ERROR { error }  (then the socket closes)
//
// Statuses come from the PresenceHub (presence-hub.ts): the room subscribes while anyone is in it and refreshes that
// every couple of minutes from its alarm.
//
// Clients are identified by the socket they authenticated on, never by ids inside packets. Every packet is size, shape
// and rate checked; recipes are normalised; positions clamped to the plaza.

import { DurableObject } from "cloudflare:workers";
import { friendCode } from "../../activity/src/identity.js";
import { verifyMember } from "./auth";
import { normaliseDna, parseStoredDna, type AvatarDna } from "./dna";
import type { Env } from "./env";
import { HttpError } from "./http";
import type { Status } from "./presence";

const MAX_MESSAGE = 2048;
const MAX_PER_SECOND = 20;
const ROOM_LIMIT = 16;
const AUTH_TIMEOUT_MS = 10_000;
const EMOTES = new Set(["wave", "laugh", "nod"]);
const HUB_TOUCH_MS = 2 * 60 * 1000;

export const CLOSE = { auth: 4001, replaced: 4002, full: 4003, protocol: 4004, timeout: 4005 } as const;

interface Seat {
  room: string;
  guildId: string;
  ip: string;
  opened: number;
  authed: boolean;
  replaced?: boolean;
  discordId?: string;
  code?: string;
  dna?: AvatarDna;
  x: number;
  z: number;
  windowStart: number;
  count: number;
}

const clamp = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-9, Math.min(9, n)) : 0;
};

export class PlazaRoom extends DurableObject<Env> {
  /** The Worker has already checked origin, guild allowlist and the Upgrade header; it passes guild and client IP. */
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const seat: Seat = {
      room: request.headers.get("x-room-name") ?? "",
      guildId: request.headers.get("x-guild-id") ?? "",
      ip: request.headers.get("x-client-ip") ?? "unknown",
      opened: Date.now(),
      authed: false,
      x: 0, z: 0, windowStart: 0, count: 0,
    };
    server.serializeAttachment(seat);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const seat = ws.deserializeAttachment() as Seat;
    if (typeof message !== "string" || message.length > MAX_MESSAGE) return this.reject(ws, CLOSE.protocol, "bad_message");

    const now = Date.now();
    if (now - seat.windowStart > 1000) { seat.windowStart = now; seat.count = 0; }
    if (++seat.count > MAX_PER_SECOND) { ws.serializeAttachment(seat); return; } // muted for the rest of this second

    let packet: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      packet = parsed;
    } catch {
      return this.reject(ws, CLOSE.protocol, "bad_message");
    }

    if (!seat.authed) return this.authenticate(ws, seat, packet);

    switch (packet.type) {
      case "MOVE":
        if (!Number.isFinite(packet.x) || !Number.isFinite(packet.z)) break;
        seat.x = clamp(packet.x);
        seat.z = clamp(packet.z);
        this.broadcast({ type: "MOVE", code: seat.code, x: seat.x, z: seat.z }, ws);
        break;
      case "EMOTE":
        if (typeof packet.emote === "string" && EMOTES.has(packet.emote)) this.broadcast({ type: "EMOTE", code: seat.code, emote: packet.emote }, ws);
        break;
      case "DNA": {
        const dna = normaliseDna(packet.dna, `friend_${seat.code}`);
        if (!dna) break;
        seat.dna = dna;
        this.broadcast({ type: "DNA", code: seat.code, dna }, ws);
        break;
      }
    }
    ws.serializeAttachment(seat);
  }

  private async authenticate(ws: WebSocket, seat: Seat, packet: Record<string, unknown>) {
    if (packet.type !== "AUTH" || typeof packet.token !== "string") return this.reject(ws, CLOSE.protocol, "auth_required");

    let member;
    try {
      member = await verifyMember(this.env, packet.token, seat.guildId, seat.ip);
    } catch (err) {
      return this.reject(ws, CLOSE.auth, err instanceof HttpError ? err.code : "auth_failed");
    }

    const code = friendCode(member.discordId);
    let dna = normaliseDna(packet.dna, `friend_${code}`);
    if (!dna) {
      const row = await this.env.DB.prepare("SELECT avatar_dna FROM members WHERE guild_id = ?1 AND discord_id = ?2")
        .bind(member.guildId, member.discordId).first<{ avatar_dna: string | null }>();
      dna = parseStoredDna(row?.avatar_dna, `friend_${code}`);
    }
    if (!dna) return this.reject(ws, CLOSE.protocol, "bad_dna");

    // One seat per person: a reconnect (or a second window) replaces the old socket without a LEAVE/JOIN flicker.
    const others = this.seats().filter(([other]) => other !== ws);
    let replacing = false;
    for (const [other, otherSeat] of others) {
      if (otherSeat.authed && otherSeat.discordId === member.discordId) {
        otherSeat.replaced = true;
        other.serializeAttachment(otherSeat);
        other.close(CLOSE.replaced, "replaced");
        replacing = true;
      }
    }
    const present = others.filter(([, s]) => s.authed && !s.replaced && s.discordId !== member.discordId);
    if (present.length >= ROOM_LIMIT) return this.reject(ws, CLOSE.full, "room_full");

    Object.assign(seat, { authed: true, discordId: member.discordId, code, dna, x: clamp(packet.x), z: clamp(packet.z) });
    ws.serializeAttachment(seat);

    const statuses = await this.hub().subscribe(seat.room, seat.guildId).catch(() => ({}));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HUB_TOUCH_MS);
    this.send(ws, { type: "WELCOME", you: code, peers: present.map(([, s]) => ({ code: s.code, dna: s.dna, x: s.x, z: s.z })), statuses });
    const joined = { code, dna, x: seat.x, z: seat.z };
    this.broadcast(replacing ? { type: "DNA", code, dna } : { type: "JOIN", ...joined }, ws);
    if (replacing) this.broadcast({ type: "MOVE", code, x: seat.x, z: seat.z }, ws);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.leave(ws);
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    this.leave(ws);
  }

  /** Drops sockets that never authenticated; while anyone is here, keeps the presence subscription fresh. */
  async alarm() {
    let pending = false;
    let present: Seat | null = null;
    for (const [ws, seat] of this.seats()) {
      if (seat.authed && !seat.replaced) { present = seat; continue; }
      if (seat.authed) continue;
      if (Date.now() - seat.opened >= AUTH_TIMEOUT_MS) this.reject(ws, CLOSE.timeout, "auth_timeout");
      else pending = true;
    }
    if (present) await this.hub().subscribe(present.room, present.guildId).catch(() => {});
    const next = pending ? AUTH_TIMEOUT_MS : present ? HUB_TOUCH_MS : null;
    if (next) await this.ctx.storage.setAlarm(Date.now() + next);
  }

  /** From the PresenceHub: a member's Discord activity changed. Everyone here sees it, present or away. */
  async status(code: string, status: Status | null) {
    this.broadcast({ type: "STATUS", code, status });
  }

  private hub() {
    return this.env.PRESENCE.get(this.env.PRESENCE.idFromName("hub"));
  }

  private leave(ws: WebSocket) {
    const seat = ws.deserializeAttachment() as Seat | null;
    if (!seat?.authed || seat.replaced) return;
    seat.authed = false;
    ws.serializeAttachment(seat);
    this.broadcast({ type: "LEAVE", code: seat.code }, ws);
    const anyoneLeft = this.seats().some(([other, s]) => other !== ws && s.authed && !s.replaced);
    if (!anyoneLeft) this.hub().unsubscribe(seat.room).catch(() => {});
  }

  private seats(): [WebSocket, Seat][] {
    return this.ctx.getWebSockets().map((ws) => [ws, ws.deserializeAttachment() as Seat]);
  }

  private broadcast(packet: object, except?: WebSocket) {
    const text = JSON.stringify(packet);
    for (const [ws, seat] of this.seats()) {
      if (ws === except || !seat.authed || seat.replaced) continue;
      try { ws.send(text); } catch { /* closing */ }
    }
  }

  private send(ws: WebSocket, packet: object) {
    try { ws.send(JSON.stringify(packet)); } catch { /* closing */ }
  }

  private reject(ws: WebSocket, closeCode: number, error: string) {
    this.send(ws, { type: "ERROR", error });
    try { ws.close(closeCode, error); } catch { /* already closed */ }
  }
}
