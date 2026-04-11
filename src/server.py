#!/usr/bin/env python3
"""
server.py — Servidor HTTP estático com suporte a CORS.
Substitui `python3 -m http.server` adicionando o header
Access-Control-Allow-Origin: * em todas as respostas.

Uso:
    python3 server.py <porta> [diretorio]

Exemplos:
    python3 server.py 4210
    python3 server.py 4220 ./estoque
    python3 server.py 4200 ./shared
"""

import sys
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class CORSRequestHandler(SimpleHTTPRequestHandler):

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        """Responde preflight requests do browser."""
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        """Formata o log com a porta para facilitar leitura no terminal."""
        port = self.server.server_address[1]
        print(f"  [:{port}] {format % args}")


def run(port: int, directory: str = "."):
    directory = os.path.abspath(directory)
    os.chdir(directory)
    server = HTTPServer(("127.0.0.1", port), CORSRequestHandler)
    print(f"  Servindo '{directory}' em http://localhost:{port}")
    print(f"  Ctrl+C para encerrar.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n  Servidor :{port} encerrado.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    port = int(sys.argv[1])
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    run(port, directory)
