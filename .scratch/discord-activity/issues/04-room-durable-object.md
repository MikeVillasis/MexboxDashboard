# 04 Authoritative room
Status: ready-for-agent
Blocked by: 03

- Room Durable Object per Activity instance id, WebSocket hibernation.
- Port JOIN_SYNC / MOVE / EMOTE / DNA_UPDATE; shape/size/rate checks and DNA validation move server-side.
- DNA persisted per Discord user in D1; avatar editor saves through the server.
- Done when: two Discord accounts see and move each other in one instance.
- Away NPCs: guild members not in the instance appear asleep (no wandering), recipes from D1 per guild.
- Every join verified: Discord token → user, guild allowlist, instance membership (see spec Security).
