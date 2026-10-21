# 06 Desktop pairing
Status: ready-for-agent
Blocked by: 02, 03

- Activity shows a short-lived 6-char code; Windows app settings has 'link to discord' + code entry.
- Server issues a device token (stored hashed); app stores it under %AppData%. Unlink from either side.
- `ActivityBridgeService` off by default; app unchanged with it off.
- Windows PC unavailable: build the server half now; the desktop half waits (Status stays ready-for-agent for server work only).
