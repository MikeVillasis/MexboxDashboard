export interface Env {
  DB: D1Database;
  /** The built Activity front end (wrangler.toml [assets]). */
  ASSETS: Fetcher;
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
