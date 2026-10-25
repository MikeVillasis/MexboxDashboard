export interface Env {
  DB: D1Database;
  /** The built Activity front end (wrangler.toml [assets]). */
  ASSETS: Fetcher;
  /** Per-IP limiter for API calls that reach Discord (wrangler.toml [[ratelimits]]). */
  DISCORD_CALLS: RateLimit;
  /** Per-IP limiter for redeeming pairing codes (phase 06): keeps code guessing hopeless. */
  PAIRING: RateLimit;
  /** One PlazaRoom Durable Object per Activity instance. */
  ROOMS: DurableObjectNamespace<import("./room").PlazaRoom>;
  /** The single Discord Gateway connection for presences (thought bubbles). */
  PRESENCE: DurableObjectNamespace<import("./presence-hub").PresenceHub>;
  /** One DeviceHub per linked Windows PC (phase 07): its WebSocket, library and now playing. */
  DEVICES: DurableObjectNamespace<import("./device-hub").DeviceHub>;
  /** Secret; without it the hub never connects and nobody gets bubbles. */
  DISCORD_BOT_TOKEN?: string;
  /** Overridable for local dev / tests only. */
  DISCORD_GATEWAY?: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  ALLOWED_GUILD_IDS?: string;
  EXTRA_ORIGINS: string;
  /** Overridable for tests only. */
  DISCORD_API?: string;
}

export const discordApi = (env: Env) => env.DISCORD_API ?? "https://discord.com/api/v10";

export const allowedGuilds = (env: Env) =>
  new Set((env.ALLOWED_GUILD_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** The Activity is served from the Discord proxy; nothing else may call this API from a browser. */
export const allowedOrigins = (env: Env) =>
  new Set([`https://${env.DISCORD_CLIENT_ID}.discordsays.com`, ...env.EXTRA_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)]);
