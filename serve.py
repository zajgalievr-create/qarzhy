#!/usr/bin/env python3
"""Қаржы — локальді дамыту сервері.

    python3 serve.py           # http://localhost:4321
    python3 serve.py 8080      # басқа порт

Vercel-ге бұл файл керек емес, тек жергілікті тексеру үшін.
"""
import functools
import http.server
import os
import socketserver
import sys

DIR = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4321


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # дамыту кезінде кэш кедергі жасамасын
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
handler = functools.partial(Handler, directory=DIR)

with socketserver.TCPServer(("127.0.0.1", PORT), handler) as httpd:
    print("Қаржы: http://localhost:%d" % PORT)
    print("Тоқтату: Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nТоқтады.")
