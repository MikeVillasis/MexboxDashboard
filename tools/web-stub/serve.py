"""Serve src/Dashboard.App/WebAssets in a plain browser with the stub host injected (no Windows, no WebView2).

    python3 tools/web-stub/serve.py [port]       then open http://localhost:8360/?name=Ana&code=ANA222&blade=avatar

Query params (read by stub-host.js): name, code (6-char friend code), connect (code to join), blade, selftest.
"""
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ASSETS = ROOT / "src" / "Dashboard.App" / "WebAssets"
STUB = pathlib.Path(__file__).resolve().parent / "stub-host.js"
INJECT = b'<script src="/__stub/stub-host.js"></script>\n  <script src="js/bridge.js"></script>'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ASSETS), **kwargs)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            html = (ASSETS / "index.html").read_bytes().replace(b'<script src="js/bridge.js"></script>', INJECT, 1)
            return self.respond(html, "text/html; charset=utf-8")
        if path == "/__stub/stub-host.js":
            return self.respond(STUB.read_bytes(), "text/javascript; charset=utf-8")
        return super().do_GET()

    def respond(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8360
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        sys.exit(f"port {port} is busy (another stub server?). Open http://localhost:{port}/ or pass a port: serve.py 8361")
    print(f"WebAssets + stub host on http://localhost:{port}/")
    server.serve_forever()
