import functools, http.server, os, socketserver, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

# usage: python3 devserver.py [port] [directory]
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8742
directory = sys.argv[2] if len(sys.argv) > 2 else './dist'
host = os.getenv('HOST') or '127.0.0.1'
os.makedirs(directory, exist_ok=True)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer((host, port), functools.partial(NoCache, directory=directory)) as httpd:
    print(f"no-cache server on http://{host}:{port} → {directory}")
    httpd.serve_forever()
