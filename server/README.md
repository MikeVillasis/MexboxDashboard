# Activity server (Cloudflare Worker)

OAuth token exchange, guild allowlist and (later) the plaza rooms for the Discord Activity. See `.scratch/discord-activity/spec.md`.

## One-time setup (owner)
1. Discord developer portal: create an application, copy the **Application ID** into `DISCORD_CLIENT_ID` in `wrangler.toml`,
   and keep the **Client Secret** for step 4. Enable Activities later in phase 03.
2. Copy your server ID (Discord developer mode → right-click server → Copy Server ID) for step 4. It is kept as a secret, not in this repo.
3. `npx wrangler login`, then `npx wrangler d1 create mexbox` and paste the `database_id` into `wrangler.toml`.
4. From this folder: `npx wrangler secret put DISCORD_CLIENT_SECRET` and `npx wrangler secret put ALLOWED_GUILD_IDS`
5. `npm run migrate:remote && npm run deploy`

## Develop
- `npm test`: runs inside the Workers runtime against a local D1; Discord is mocked.
- `npm run dev`: local Worker; copy `.dev.vars.example` to `.dev.vars` first.

## Endpoints
- `POST /api/token {code, guildId}` → `{access_token, expires_in, scope, member}`; only for members of an allowlisted guild.
- `GET /api/me` with `Authorization: Bearer <token>` and `X-Guild-Id` → the verified member.
- `GET /api/health`
