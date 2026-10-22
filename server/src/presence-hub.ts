// One Discord Gateway connection (bot token, GUILD_PRESENCES intent) for the whole app, in a single Durable Object
// ("hub"). It is only connected while some plaza room has people in it: rooms subscribe when someone joins and touch the
// hub every couple of minutes; with no fresh touches for 5 minutes the hub disconnects (stays inside the free tier).
//
// Statuses are kept in memory only, per allowlisted guild, and pushed to that guild's rooms as they change. Members who
// turned off "share my activity" in Discord never appear in presences, so they never get a bubble.

import { DurableObject } from "cloudflare:workers";
import { friendCode } from "../../activity/src/identity.js";
import { allowedGuilds, type Env } from "./env";
import { isSnowflake } from "./http";
import { sameStatus, statusFromPresence, type Status } from "./presence";

const GATEWAY = "https://gateway.discord.gg/?v=10&encoding=json";
const INTENTS = (1 << 0) | (1 << 8); // GUILDS (for GUILD_CREATE with presences) | GUILD_PRESENCES (privileged)
const ROOM_IDLE_MS = 5 * 60 * 1000;
const CHECK_MS = 60 * 1000;
const EMPTY_GRACE_MS = 2 * 60 * 1000;
const CONNECT_WAIT_MS = 5000; // a room join waits at most this long for the gateway before carrying on // a quick relaunch reuses the connection instead of logging the bot in again
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];

type Payload = { op: number; d?: any; s?: number | null; t?: string | null };

export class PresenceHub extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private connecting = false;
  private seq: number | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acked = true;
  private attempt = 0;
  private rooms = new Map<string, { guildId: string; touched: number }>();
  private statuses = new Map<string, Map<string, Status>>(); // guildId → discordId → status
  // Diagnostics (counts and codes only; see health()).
  private lastError: string | null = null;
  private frames = 0;
  private readyAt: number | null = null;
  private snapshots = 0;

  /** Temporary troubleshooting view: no ids, names or statuses. */
  async health() {
    return {
      hasToken: Boolean(this.env.DISCORD_BOT_TOKEN),
      connecting: this.connecting,
      connected: Boolean(this.ws),
      rooms: this.rooms.size,
      frames: this.frames,
      ready: this.readyAt !== null,
      serverSnapshots: this.snapshots,
      statuses: [...this.statuses.values()].reduce((n, m) => n + m.size, 0),
      lastError: this.lastError,
    };
  }

  /** A room with people in it: (re)registers, makes sure the gateway is up, returns the guild's current statuses. */
  async subscribe(room: string, guildId: string): Promise<Record<string, Status>> {
    if (!isSnowflake(guildId) || !allowedGuilds(this.env).has(guildId)) return {};
    this.rooms.set(room, { guildId, touched: Date.now() });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
    if (!this.env.DISCORD_BOT_TOKEN) console.warn("presence: no DISCORD_BOT_TOKEN secret, bubbles are off");
    // Connect inside this call, not after it returns: on Cloudflare, work left running after an invocation finishes
    // isn't reliably carried on (or logged). Capped, so a slow Discord never stalls someone joining a room.
    await Promise.race([this.openGateway(), new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS))]);
    const snapshot: Record<string, Status> = {};
    for (const [id, status] of this.statuses.get(guildId) ?? []) snapshot[friendCode(id)] = status;
    return snapshot;
  }

  async unsubscribe(room: string) {
    this.rooms.delete(room);
    if (this.rooms.size === 0) await this.ctx.storage.setAlarm(Date.now() + EMPTY_GRACE_MS); // alarm() closes if still empty
  }

  async alarm() {
    const now = Date.now();
    for (const [room, info] of this.rooms) if (now - info.touched > ROOM_IDLE_MS) this.rooms.delete(room);
    if (this.rooms.size === 0) { this.closeGateway(); return; }
    await this.ctx.storage.setAlarm(now + CHECK_MS);
    // Also the dependable reconnect path: timers set after an invocation ends may never fire.
    if (!this.ws) await Promise.race([this.openGateway(), new Promise((resolve) => setTimeout(resolve, CONNECT_WAIT_MS))]);
  }

  // ───────────── Gateway ─────────────

  private async openGateway() {
    if (this.ws || this.connecting || !this.env.DISCORD_BOT_TOKEN || this.rooms.size === 0) return;
    this.connecting = true;
    try {
      const response = await fetch(this.env.DISCORD_GATEWAY ?? GATEWAY, {
        headers: { upgrade: "websocket" },
        signal: AbortSignal.timeout(10_000), // never stay "connecting" forever
      });
      const ws = response.webSocket;
      if (!ws) throw new Error(`gateway refused upgrade (${response.status})`);
      ws.accept();
      this.ws = ws;
      console.info("presence: gateway connected");
      ws.addEventListener("message", (event) => {
        try { this.dispatch(JSON.parse(event.data as string)); } catch { /* malformed frame: ignore */ }
      });
      ws.addEventListener("close", (event) => this.closed(event.code));
      ws.addEventListener("error", () => this.closed(1006));
    } catch (err) {
      this.lastError = `connect: ${err instanceof Error ? err.message : "unknown"}`.slice(0, 200);
      console.error("presence:", this.lastError);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private closeGateway() {
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.seq = null;
    this.statuses.clear();
    try { ws?.close(1000, "idle"); } catch { /* already closed */ }
  }

  private closed(code: number) {
    if (!this.ws) return; // we closed it
    console.warn(`presence: gateway closed ${code}`);
    this.lastError = `closed ${code}`;
    this.ws = null;
    this.stopHeartbeat();
    // 4004 bad token, 4013/4014 intents not allowed: retrying won't help until the owner fixes the portal settings.
    if (code === 4004 || code === 4013 || code === 4014) {
      console.error(`presence: gateway closed ${code}; check the bot token and the Presence intent`);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.rooms.size === 0) return;
    const delay = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
    setTimeout(() => void this.openGateway(), delay);
  }

  private send(payload: Payload) {
    try { this.ws?.send(JSON.stringify(payload)); } catch { /* closing */ }
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Gateway frames. Public so tests can drive the hub without a live Discord connection. */
  dispatch(payload: Payload) {
    this.frames++;
    if (typeof payload.s === "number") this.seq = payload.s;
    switch (payload.op) {
      case 10: { // HELLO
        this.stopHeartbeat();
        this.acked = true;
        this.heartbeat = setInterval(() => {
          if (!this.acked) { this.ws?.close(4000, "zombie"); return; } // missed ACK: reconnect
          this.acked = false;
          this.send({ op: 1, d: this.seq });
        }, payload.d?.heartbeat_interval ?? 41250);
        this.send({
          op: 2,
          d: { token: this.env.DISCORD_BOT_TOKEN, intents: INTENTS, properties: { os: "linux", browser: "mexbox", device: "mexbox" } },
        });
        break;
      }
      case 11: this.acked = true; break;
      case 1: this.send({ op: 1, d: this.seq }); break;
      case 7: this.ws?.close(4000, "reconnect requested"); break;
      case 9: this.ws?.close(4000, "invalid session"); break;
      case 0:
        if (payload.t === "READY") { this.attempt = 0; this.readyAt = Date.now(); console.info(`presence: ready, bot in ${payload.d?.guilds?.length ?? 0} server(s)`); }
        else if (payload.t === "GUILD_CREATE") this.guildCreate(payload.d);
        else if (payload.t === "PRESENCE_UPDATE") this.presence(payload.d?.guild_id, payload.d?.user?.id, payload.d);
        break;
    }
  }

  private guildCreate(guild: { id?: unknown; presences?: unknown }) {
    if (!isSnowflake(guild?.id) || !allowedGuilds(this.env).has(guild.id)) { console.info("presence: ignoring a server that isn't allowlisted"); return; }
    this.snapshots++;
    console.info(`presence: server snapshot, ${Array.isArray(guild.presences) ? guild.presences.length : 0} online presence(s)`);
    const previous = this.statuses.get(guild.id) ?? new Map<string, Status>();
    this.statuses.set(guild.id, new Map());
    const seen = new Set<string>();
    for (const p of Array.isArray(guild.presences) ? guild.presences : []) {
      const id = p?.user?.id;
      if (!isSnowflake(id)) continue;
      seen.add(id);
      this.presence(guild.id, id, p);
    }
    for (const id of previous.keys()) if (!seen.has(id)) this.push(guild.id, id, null); // gone while we were away
  }

  private presence(guildId: unknown, userId: unknown, presence: { status?: unknown; activities?: unknown }) {
    if (!isSnowflake(guildId) || !isSnowflake(userId) || !allowedGuilds(this.env).has(guildId)) return;
    const guild = this.statuses.get(guildId) ?? new Map<string, Status>();
    this.statuses.set(guildId, guild);
    const next = statusFromPresence(presence);
    if (sameStatus(guild.get(userId), next)) return;
    if (next) guild.set(userId, next);
    else guild.delete(userId);
    console.info(`presence: status ${next?.kind ?? "cleared"} → ${[...this.rooms.values()].filter((r) => r.guildId === guildId).length} room(s)`);
    this.push(guildId, userId, next);
  }

  private push(guildId: string, userId: string, status: Status | null) {
    const code = friendCode(userId);
    for (const [room, info] of this.rooms) {
      if (info.guildId !== guildId) continue;
      const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(room));
      stub.status(code, status).catch(() => this.rooms.delete(room));
    }
  }
}
