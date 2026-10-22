# 04 Authoritative room
Status: done
Blocked by: 03

- Room Durable Object per Activity instance id, WebSocket hibernation.
- Port JOIN_SYNC / MOVE / EMOTE / DNA_UPDATE; shape/size/rate checks and DNA validation move server-side.
- DNA persisted per Discord user in D1; avatar editor saves through the server.
- Done when: two Discord accounts see and move each other in one instance.
- Away NPCs: guild members not in the instance appear asleep (no wandering), recipes from D1 per guild.
- Every join verified: Discord token → user, guild allowlist, instance membership (see spec Security).

## Comments
- 2026-10-22: `server/src/room.ts` PlazaRoom DO (hibernating WebSockets, AUTH-first, one seat per member, 16 per room,
  per-socket size/rate checks, LEAVE suppressed when a second window replaces the first). `server/src/dna.ts` mirrors C#
  AvatarDna. `GET/PUT /api/avatar`, `GET /api/plaza/members` (30-day away list, friend code + recipe only).
  Client: `activity/src/RoomTransport.js` (PeerTransport contract), adapter saves avatars server-side, `awayAsleep`
  hosts make away members nap (sit, eyes shut, "z z"); Windows/stub path unchanged (PeerJS, roaming NPCs).
  Instance membership is not verified (needs a bot token); see spec Decisions.
  Tests: 33 server (incl. live WebSocket rooms), 5 identity. Local multi-user run: `node tools/activity-dev/dev.mjs`
  (fake Discord API + fake SDK + real Worker/room/D1) checked two members seeing each other, moves relayed to a third
  client, leave → asleep with z's, outsider blocked, away list. Stub host self-test still passes.
- 2026-10-22: deployed and tested in Discord by the owner; follow-up UI notes handled (scrolling panels, hide menu, camera follow, keyboard hints).
