"""Static server for local preview that refuses to be cached.

The stock http.server sends Last-Modified and browsers then hold assets across
reloads, which makes a design preview show yesterday's stylesheet. Everything
here is no-store so what you see is what is on disk.
"""
import functools, http.server, socketserver, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8742
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", port), functools.partial(NoCache, directory=".")) as httpd:
    print(f"no-cache server on {port}")
    httpd.serve_forever()
