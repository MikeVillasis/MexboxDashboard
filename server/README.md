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

## Thought bubbles (optional, Discord bot)
Avatars show what members are playing / listening to / watching, from their Discord status. This needs a bot:
11. **Bot → Reset Token**, then from this folder: `npx wrangler secret put DISCORD_BOT_TOKEN` (never paste it anywhere else).
12. **Bot → Privileged Gateway Intents → Presence Intent: on.** (Free, no review under 100 servers.)
13. **OAuth2 → URL Generator:** scopes `bot` + `applications.commands`, no permissions; open the generated URL and
    authorize it for your server. The bot must appear in the server's member list (offline is normal): without the
    `bot` scope only the Activity is installed and the bot sees no servers.
14. `npm run deploy` (also creates the PresenceHub Durable Object).
Without the token the hub never connects and nobody gets bubbles; everything else works. Members who turned off
"Share my activity" in Discord never get a bubble. Statuses live in memory only (never in D1).

## Linking the Windows app (pairing)
Members link their Windows dashboard from the Activity: **friends → your pc → link my pc** shows a 6-character code
(10 minutes, single use); in the Windows app, **system → link to discord** and type it. The app keeps a device token
(DPAPI-encrypted, `%AppData%\Xbox360Launcher\activity-device.json`); the server stores only its SHA-256. Unlink from
either side. Redeeming is rate-limited per IP by the `PAIRING` binding in `wrangler.toml` (created on deploy). Local:
`node tools/activity-dev/dev.mjs`, then start the app with `--activity-server=http://localhost:8787`.

## Libraries on gamercards
While linked, the Windows app keeps a WebSocket to its own `DeviceHub` Durable Object (`GET /api/device/ws`) and
publishes a library summary (title, platform, public store cover URL) and what's playing. Any member of the server sees
them on that member's gamercard. Covers load through `/api/game-cover`, which only fetches from Steam and Blizzard CDNs.

## Develop
- `npm test`: runs inside the Workers runtime against a local D1; Discord is mocked.
- `npm run dev`: local Worker + front end at http://localhost:8787 (outside Discord it shows the "open from discord"
  screen over the plaza); copy `.dev.vars.example` to `.dev.vars` first.
- `npm --prefix ../activity test`: unit tests for the Activity's identity helpers.
- Front-end work without Discord: `python3 ../tools/web-stub/serve.py` (stub host, all blades).
- Whole Activity locally, several members, no Discord or Cloudflare account: `node ../tools/activity-dev/dev.mjs`, then
  open `http://localhost:8787/?user=ana&guild=111111111111111111&instance=room1` and the same with `user=ben` in
  another tab (fake Discord API + `activity/dev/fake-sdk.js`; `user=outsider` is in no server). A fake Gateway gives ana
  and ben statuses; change them with `curl "http://127.0.0.1:8788/dev/presence?user=ben&playing=Portal%202"`.

## Endpoints (also reachable with Discord's `/.proxy` prefix)
All except token/health need `Authorization: Bearer <token>` and `X-Guild-Id`.
- `GET /api/avatar` → `{dna|null}`; `PUT /api/avatar {dna}` → the normalised recipe (rules mirror C# `AvatarDna`).
- `GET /api/avatar-image/:code` → a member's Discord profile picture (server avatar, else user avatar, else Discord's
  default), only for members of your own server; images come from Discord's CDN, cached by Cloudflare.
- `GET /api/plaza/members` → members of your server seen in the last 30 days with an avatar (friend code + recipe only).
- `GET /api/room?guild=&instance=` (WebSocket) → the shared plaza for that Activity instance (`src/room.ts`); the first
  message must be `AUTH {token, dna, x, z}`. Rooms also relay `STATUS {code, status}` from `src/presence-hub.ts` (one
  Discord Gateway connection, only while a room has people in it).
- `POST /api/token {code, guildId}` → `{access_token, expires_in, scope, member}`; only for members of an allowlisted guild.
- `GET /api/me` with `Authorization: Bearer <token>` and `X-Guild-Id` → the verified member.
- `GET /api/health`
