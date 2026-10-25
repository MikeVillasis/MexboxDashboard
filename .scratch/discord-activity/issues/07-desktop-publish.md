# 07 Publish library and now playing
Status: in-progress (deployed 2026-10-25, version 3c1629ed; not yet tested in Discord)
Blocked by: 06

- Outbound WSS from the app to a Device DO; push library summary (id, title, platform, cover url) and now playing.
- Off the UI thread; reconnect with backoff; debounce on library changes.
- Gamercard in the Activity shows the linked user's games.
- Library is visible to the whole guild, not just the instance.
- Windows PC unavailable: build the server half now; the desktop half waits (Status stays ready-for-agent for server work only).
- 2026-10-22: phone blade space follow-up filed as ticket 10 (with phase 07).

## Comments
- 2026-10-25 (Windows): built. Server: `src/device-hub.ts` DeviceHub DO per device (WebSocket via `GET /api/device/ws`,
  device token in the Authorization header checked by the Worker; hibernation; "ping"→"pong" auto-response; LIBRARY
  ≤ 500 games validated, ≥ 5 s apart; NOW_PLAYING ≥ 0.5 s apart; now playing cleared on disconnect; newer socket
  replaces older, 4002). `src/library.ts`: `GET /api/library/:code` (whole guild, merged across a member's PCs, order as
  sent = most recently played first) and `GET /api/game-cover?url=` (signed-in members, Steam/Blizzard CDNs only).
  Wrangler: `DEVICES` binding + DO migration v3. 10 tests (`test/library.test.ts`), 64/64 pass.
  Desktop: `Services/ActivityPublisher.cs` (started/stopped by `ActivityBridgeService.AttachSources` with the link;
  library on connect + 2 s after changes, ≥ 6 s apart; now playing debounced 300 ms; ping 30 s; backoff 2 s → 2 min;
  401/403 on connect → forget link; covers only public store URLs). Activity: gamercard shows "games N", "on their pc
  ▶ title – artist", and a strip of 6 covers/titles + "+N".
  Tested locally (activity-dev + app with --profile=t07 linked to it): connect, 19 games published, Steam + Battle.net
  covers through the proxy, now playing shown and cleared when the app closed. Test profile files removed.
