// Embedded App SDK flow: the Activity calls authorize() → gets a one-time code → POSTs it here → we swap it for an
// access token with the client secret (which never leaves the Worker) → the Activity calls authenticate() with it.

import { spendDiscordCall, verifyMember } from "./auth";
import { discordApi, type Env } from "./env";
import { HttpError } from "./http";

export async function exchangeCode(env: Env, code: unknown, guildId: unknown, ip: string) {
  if (typeof code !== "string" || !/^[A-Za-z0-9]{10,128}$/.test(code)) throw new HttpError(400, "bad_code");

  await spendDiscordCall(env, ip);

  const response = await fetch(`${discordApi(env)}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (response.status === 400 || response.status === 401) throw new HttpError(400, "code_rejected");
  if (response.status === 429) throw new HttpError(503, "discord_busy");
  if (!response.ok) throw new HttpError(502, "discord_error");

  const token = (await response.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (typeof token.access_token !== "string") throw new HttpError(502, "discord_error");

  // Outsiders get nothing back: the token is only returned to members of an allowed guild.
  const member = await verifyMember(env, token.access_token, guildId, ip);
  // The refresh token is dropped on purpose; the Activity re-authorizes per session.
  return { access_token: token.access_token, expires_in: token.expires_in ?? 0, scope: token.scope ?? "", member };
}
