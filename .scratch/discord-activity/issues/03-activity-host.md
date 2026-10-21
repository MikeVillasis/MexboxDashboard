# 03 Activity host
Status: done
Blocked by: 01, 02

- `activity/`: Vite build of shared `WebAssets/js` + Discord `bridge.js` (SDK ready/authorize/authenticate).
- URL mappings for /api and /ws; deploy to Pages; vendored three.js served via the proxy.
- Done when: the Activity opens in a test server and shows your procedural avatar in the plaza.

## Comments
- 2026-10-21: `activity/` (esbuild bundle + `src/discord-host.js`), served by the Worker via static assets (no Pages). Host declares blades friends + avatar; sign-in errors show a blocker screen. 14 Worker tests + 5 identity tests pass; local wrangler dev shows the blocker over a working plaza outside Discord. Remaining: owner enables Activities + URL mapping, deploys, launches in a voice channel.
- 2026-10-21: deployed and confirmed working inside Discord by the owner.
