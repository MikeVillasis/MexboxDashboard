# 06 Desktop pairing
Status: done (tested in Discord 2026-10-25)
Blocked by: 02, 03

- Activity shows a short-lived 6-char code; Windows app settings has 'link to discord' + code entry.
- Server issues a device token (stored hashed); app stores it under %AppData%. Unlink from either side.
- `ActivityBridgeService` off by default; app unchanged with it off.
- Windows PC unavailable: build the server half now; the desktop half waits (Status stays ready-for-agent for server work only).

## Comments
- 2026-10-25 (Windows): built both halves.
  Server `src/devices.ts`: `POST /api/pair` (Activity, 6-char code, 10 min, single use, replaces the member's previous
  code), `POST /api/pair/redeem` (desktop, no Origin; own `PAIRING` rate limit 10/min/IP), device token `mxd_…` (256-bit,
  only SHA-256 stored), `GET`/`DELETE /api/device` (desktop), `GET /api/devices` + `DELETE /api/devices/:id` (Activity,
  owner only), 5 devices per member, allowlist re-checked. 12 tests (`test/devices.test.ts`); 54/54 server tests pass.
  Activity: "your pc" in the friends panel (host option `pairing`): link my pc → code + countdown, polls until redeemed,
  device list with unlink. Desktop: `Dashboard.App/Services/ActivityBridgeService` (DPAPI-encrypted token in
  activity-device.json; no file = no network), native System blade "link to discord" + code panel (MainWindow leaves
  typing alone while a TextBox has focus), web shell system item (prompt) via bridge `LinkActivity`/`UnlinkActivity` +
  ACTIVITY_LINK messages. `--activity-server=<url>` for local dev. `tools/activity-dev/dev.mjs` now runs on Windows.
  Tested locally (activity-dev + console harness): link, no plaintext token on disk, reload, code single-use, Activity
  shows the PC and toasts, unlink from desktop, unlink from Activity → desktop forgets the link on next start; native
  panel typing (Q/E don't switch blades) and server error message. Not yet exercised: the web shell's prompt-based item.
- 2026-10-25: deployed (version fb8b9e1a, new `PAIRING` rate limit); owner linked a PC from Discord successfully.
