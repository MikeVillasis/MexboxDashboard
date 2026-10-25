# 08 Remote launch to own device
Status: done (tested in Discord 2026-10-25)
Blocked by: 07

- 'launch on my pc' on your own gamercard only → Device DO → app → existing URI launch path.
- Server rejects other users' devices and game ids not in the last published library; app shows a confirm toast.
- Windows PC unavailable: build the server half now; the desktop half waits (Status stays ready-for-agent for server work only).

## Comments
- 2026-10-25 (Windows): built. Server `src/launch.ts`: `POST /api/launch { gameId }` (signed-in member; `LAUNCHES`
  rate limit 6/min per member; only the caller's own devices whose last published library contains the id, most
  recently updated first; offline PCs skipped). `DeviceHub.launch()` (RPC) sends `LAUNCH { requestId, gameId }` down the
  PC's socket and waits ≤ 6 s for `LAUNCH_RESULT { ok, reason }` → `launched` / `failed` / `sent` / `offline`. 6 tests
  (70/70 pass). Desktop: `ActivityBridgeService` handles LAUNCH: re-checks the id in the PC's own library ("not
  installed" otherwise), raises `RemoteLaunch` (native: games blade status "starting X from discord…" + launch sound;
  web shell: TOAST), launches via `GameLibraryService.LaunchAsync` (store URI / bootstrapper), answers through the
  publisher's outbox. Activity: your own gamercard (`card.launchable`) makes covers clickable, hint "click a game to
  start it on your pc", toasts the outcome.
  Tested locally with a harness using a fake scanner (nothing really launched): Activity click → Worker → hub → PC →
  "launched" toast both ends; offline PC → "isn't connected" toast.
- 2026-10-25: deployed (version 81b80d92, `LAUNCHES` rate limit); owner launched a game on their PC from Discord.
