# 01 Decouple the front end from WebView2
Status: done
Blocked by: none

- Define the host interface in `js/bridge.js` (calls + event subscribe); move the WebView2 implementation behind it.
- Put PeerJS behind a transport interface in `js/net` so a WebSocket transport can replace it.
- Done when: `--web` shell behaves exactly as before (plaza self-test passes, two-profile P2P still works).
- Windows PC unavailable: verify in a plain browser with a stub bridge now; WebView2 check pending on Windows.

## Comments
- 2026-10-21: host adapter in bridge.js, PeerTransport split out. Browser stub: `python3 tools/web-stub/serve.py`. Verified plaza self-test, library, gamercard and two-tab P2P. Still to do on Windows: run `--web` and `--plaza-selftest`.
- 2026-10-25 (Windows): `dotnet build` clean. `--web --plaza-selftest`: page loads, grab → dangle (y 0.90) → drop into chat
  → inspect gamercard all pass, no page errors; Mac-side UI (sky picker, hide menu) renders in WebView2. Two-profile P2P
  (`--profile=p2ptest --connect=CODE`): connect, JOIN_SYNC both ways, MOVE and EMOTE both ways. Test files removed.
