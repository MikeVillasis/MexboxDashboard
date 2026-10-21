# Discord Activity: plaza + desktop bridge

Status: ready-for-human (plan under review)
Branch: `feature/discord-activity` (short-lived, merges into `main`)

## Goal
Run the Three.js plaza (avatars, AI, gamercards) as a Discord Activity inside a server, hosted on Cloudflare
at ~$0/month for under 50 users. Optionally link the Windows app so a user's library and "now playing" show
on their gamercard, and they can launch their own games from the Activity.

## Non-goals
- No game scanning, launching or media control inside Discord itself (sandboxed iframe, impossible).
- No change in behaviour to the Windows app when the bridge is off. Native WPF shell and `--web` shell stay as today.
- No monetization, no app verification (needed only past 100 servers).

## Hard rules
1. **Windows app untouched by default.** The bridge is a new opt-in service, off unless enabled in settings.
   `main` must build and run identically with it off.
2. **One shared front end.** `WebAssets/js` stays the single source. Only `js/bridge.js` knows the host; it gets
   two implementations: WebView2 (existing) and Discord.
3. **Server is authoritative.** Clients never trust peers. All packet shape/size/rate checks from
   `NetworkManager.js` and DNA validation from `Core/Avatars/AvatarDna` move to the server.
4. **Remote launch is only to yourself.** A launch request may target only the requester's own paired device and
   only a game id present in that device's last published library. The desktop app confirms with a toast.
5. **Free tier only.** Cloudflare Workers (+ static assets), Durable Objects (WebSocket hibernation), D1. No paid add-ons.

## Architecture
```
Discord client (iframe, *.discordsays.com proxy)
  └─ one URL mapping "/" → mexbox-activity.<subdomain>.workers.dev
        │  static front end: activity/dist (esbuild bundle of shared WebAssets + discord-host.js), Workers static assets
        │  /api  → Worker
        │  /ws   → Worker → Durable Object "Room" (one per Activity instance id)
server/ (Cloudflare Worker, TypeScript)
  ├─ POST /api/token        OAuth code → access token (client secret lives only here)
  ├─ Room DO                 JOIN_SYNC / MOVE / EMOTE / DNA_UPDATE, authoritative, hibernating
  ├─ D1                      users(discord_id, dna), devices(id, discord_id, token_hash), libraries, pairing codes
  └─ Device DO               one per paired desktop; holds its outbound WebSocket, relays LAUNCH
Windows app (Dashboard.App)
  └─ Services/ActivityBridgeService (opt-in): outbound WSS to server; publishes library summary + now playing;
     receives LAUNCH → existing URI launch path
```

## Repo layout (new)
- `activity/` front-end host: `build.mjs` (esbuild), `src/discord-host.js` adapter (SDK sign-in), mobile tweaks.
- `server/` Worker + DOs + D1 migrations, `wrangler.toml`. Secrets via `wrangler secret`.
- `src/Dashboard.App/Services/ActivityBridgeService.cs` + settings toggle. Nothing in `Core` touches the network
  beyond a plain DTO for the library summary.

## Phases (one ticket each, see `issues/`)
1. Decouple the front end from WebView2 (`bridge.js` interface, PeerJS behind a transport interface).
2. Server skeleton on Cloudflare: Worker, OAuth token exchange, D1 schema, deploy to `workers.dev`.
3. Activity host: Discord SDK handshake, URL mappings, runs in a test server with the procedural plaza.
4. Room Durable Object: authoritative multiplayer replacing PeerJS in the Activity; DNA stored per Discord user.
5. Mobile and performance pass: avatar cap, quality tiers, touch input.
6. Pairing: Activity shows a code, Windows app redeems it, device token issued and stored hashed.
7. Desktop publish: library summary + now playing on the gamercard.
8. Remote launch: Activity → Device DO → desktop, with the self-only rules and a confirm toast.
9. Docs: README/CLAUDE.md status, setup guide (Discord portal, wrangler, secrets), merge to `main`.

## Costs
- Cloudflare: $0 within free tiers (Workers 100k req/day, static asset requests free, DO free tier with hibernation, D1 free tier).
- Discord: $0. SDK, API and Activities have no fees; only rate limits.
- Optional: a custom domain (~$10/yr). Not needed; Discord proxies a `workers.dev`/`pages.dev` origin.

## Decisions
- **Away NPCs:** server members who have played before but are not in the instance appear as NPCs in an "away"
  state: avatar asleep (sitting/lying, eyes closed, z's), no wandering. Recipes come from D1, scoped to the guild.
- **Library visibility:** a linked user's library is visible to the whole server (guild-scoped, not instance-scoped).
- **No controller support** in the Activity. Mouse/touch/keyboard only.
- **Windows PC unavailable for now:** do the Discord-side work first (01 JS-only, 02-05, server halves of 06-08).
  Desktop pieces wait; anything touching `Dashboard.App` is unverified until it's tested on Windows.

- **Front end served by the Worker** (Workers static assets) instead of Pages: one origin, one Discord URL mapping,
  one deploy. Decided in phase 03.

## Security
Threat model: keep server data (members, avatars, libraries) inside the allowed guild; never leak secrets or tokens.
1. **Guild allowlist.** The Worker holds `ALLOWED_GUILD_IDS`; every request outside them is rejected, even if the
   app gets added to another server.
2. **Identity is verified server-side, never trusted from the client.** The client sends its Discord access token;
   the Worker resolves the user with `/users/@me` and guild membership with `/users/@me/guilds/{id}/member`
   (scope `guilds.members.read`), and caches the result briefly. Room joins also check the user is in that
   activity instance (Discord's activity-instance endpoint).
3. **Minimal scopes:** `identify`, `guilds.members.read`. The app cannot read messages, channels or member lists
   beyond the people in it.
4. **Secrets:** client secret and token pepper only in `wrangler secret`, never in the repo or front end.
   Device tokens stored hashed. No tokens in logs.
5. **Data minimisation:** stored = Discord user id, display name, avatar DNA, library summary, device token hash.
   Everything keyed by guild id; deleting a user or unlinking removes their rows.
6. **Input hardening:** server-side shape/size/rate checks on every packet and API body; DNA validated; CORS limited
   to the Discord proxy origin.
7. **Account hygiene (owner):** 2FA on Cloudflare and the Discord developer account. These are the realistic
   points of compromise; the free tier has the same platform security as paid.
