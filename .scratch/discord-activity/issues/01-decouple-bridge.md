# 01 Decouple the front end from WebView2
Status: in-progress (browser verified; WebView2 check pending on Windows)
Blocked by: none

- Define the host interface in `js/bridge.js` (calls + event subscribe); move the WebView2 implementation behind it.
- Put PeerJS behind a transport interface in `js/net` so a WebSocket transport can replace it.
- Done when: `--web` shell behaves exactly as before (plaza self-test passes, two-profile P2P still works).
- Windows PC unavailable: verify in a plain browser with a stub bridge now; WebView2 check pending on Windows.

## Comments
- 2026-10-21: host adapter in bridge.js, PeerTransport split out. Browser stub: `python3 tools/web-stub/serve.py`. Verified plaza self-test, library, gamercard and two-tab P2P. Still to do on Windows: run `--web` and `--plaza-selftest`.
