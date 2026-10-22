# 11 Thought bubbles from Discord status
Status: in-progress (deployed; bubbles NOT working in production yet, see 2026-10-22 debugging)
Blocked by: 04

Requested 2026-10-22: show what members are playing / listening to above their avatars, visible to everyone, for
present and away (napping) members. Source: Discord presence via a bot with the Presence intent (owner's choice).

## Comments
- 2026-10-22: `server/src/presence.ts` (status from presence: game > music "song – artist" > watching; custom statuses
  ignored; 48 chars), `server/src/presence-hub.ts` (single Gateway connection, HELLO/IDENTIFY/heartbeat/reconnect,
  allowlisted guilds only, pushes to rooms, 2-minute grace), rooms: WELCOME.statuses + STATUS. Client: RoomTransport
  onStatus → host event FRIEND_STATUS → bubble sprite (constant screen size, lower while napping), friends list line,
  gamercard "now". Tests: 38 server (parsing, hub → room → client, allowlist). Local end to end with the fake Gateway:
  identify, initial statuses, live change, clear, gamercard. Windows path unchanged.
- 2026-10-22 debugging in production (bot token set, bot added, Presence intent on, Spotify linked): no bubbles.
  Logs: rooms call PresenceHub.subscribe OK, but none of the hub's console lines ever appear. Made subscribe await the
  connection (5 s cap), alarm reconnects, fetch has a 10 s timeout, and added TEMPORARY `GET /api/presence/health`
  (counts/flags/last error only). After a relaunch it read hasToken=true, rooms=0, frames=0, lastError=null: the
  gateway connection is never even attempted (a timeout or Discord rejection would have set lastError / frames).
  Next: suspect `subscribe`'s early return (allowlist/snowflake check on guildId) in production. Add the early-return
  reason and a subscribe counter to health(), reproduce with the owner, fix, then REMOVE /api/presence/health.
