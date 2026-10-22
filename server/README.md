# Activity server (Cloudflare Worker)

Serves the Discord Activity (static front end built by `../activity`) and its API: OAuth token exchange, guild
allowlist and (later) the plaza rooms. See `.scratch/discord-activity/spec.md`.

## One-time setup (owner)
1. Discord developer portal: create an application, copy the **Application ID** into `DISCORD_CLIENT_ID` in `wrangler.toml`,
   and keep the **Client Secret** for step 4. Enable Activities later in phase 03.
2. Copy your server ID (Discord developer mode → right-click server → Copy Server ID) for step 4. It is kept as a secret, not in this repo.
3. `npx wrangler login`, then `npx wrangler d1 create mexbox` and paste the `database_id` into `wrangler.toml`.
4. From this folder: `npx wrangler secret put DISCORD_CLIENT_SECRET` and `npx wrangler secret put ALLOWED_GUILD_IDS`
5. `npm run migrate:remote && npm run deploy` (deploy builds `../activity` first)

## Turn on the Activity in Discord (owner, developer portal)
6. **OAuth2 → Redirects:** `https://127.0.0.1` (required by `authorize()`, never actually used).
7. **Activities → Settings:** enable Activities.
8. **Activities → URL Mappings:** a single root mapping, prefix `/` → target `mexbox-activity.<your-subdomain>.workers.dev`
   (no `https://`). The page and the API share it.
9. **Installation:** enable Guild Install and add the app to your server with the install link.
10. In a voice channel of that server: Activities (rocket icon) → your app. While unverified, members who can't see it
    need to be added under **App Testers**.

## Develop
- `npm test`: runs inside the Workers runtime against a local D1; Discord is mocked.
- `npm run dev`: local Worker + front end at http://localhost:8787 (outside Discord it shows the "open from discord"
  screen over the plaza); copy `.dev.vars.example` to `.dev.vars` first.
- `npm --prefix ../activity test`: unit tests for the Activity's identity helpers.
- Front-end work without Discord: `python3 ../tools/web-stub/serve.py` (stub host, all blades).
- Whole Activity locally, several members, no Discord or Cloudflare account: `node ../tools/activity-dev/dev.mjs`, then
  open `http://localhost:8787/?user=ana&guild=111111111111111111&instance=room1` and the same with `user=ben` in
  another tab (fake Discord API + `activity/dev/fake-sdk.js`; `user=outsider` is in no server).

## Endpoints (also reachable with Discord's `/.proxy` prefix)
All except token/health need `Authorization: Bearer <token>` and `X-Guild-Id`.
- `GET /api/avatar` → `{dna|null}`; `PUT /api/avatar {dna}` → the normalised recipe (rules mirror C# `AvatarDna`).
- `GET /api/plaza/members` → members of your server seen in the last 30 days with an avatar (friend code + recipe only).
- `GET /api/room?guild=&instance=` (WebSocket) → the shared plaza for that Activity instance (`src/room.ts`); the first
  message must be `AUTH {token, dna, x, z}`.
- `POST /api/token {code, guildId}` → `{access_token, expires_in, scope, member}`; only for members of an allowlisted guild.
- `GET /api/me` with `Authorization: Bearer <token>` and `X-Guild-Id` → the verified member.
- `GET /api/health`
