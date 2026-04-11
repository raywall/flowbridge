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

import os
import json
import socket
import sys
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler


SERVICE_BY_PORT = {
    4200: "flowbridge-shared",
    4210: "flowbridge-vendas",
    4220: "flowbridge-estoque",
}


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def datadog_tag(value) -> str:
    return str(value).replace(",", "_").replace("|", "_").replace(":", "_")


class DogStatsD:
    """Cliente DogStatsD mínimo para enviar métricas ao Datadog Agent via UDP."""

    def __init__(self, service: str, port: int, directory: str):
        self.enabled = env_flag("DD_METRICS_ENABLED", True)
        self.address = (
            os.getenv("DD_AGENT_HOST", "127.0.0.1"),
            int(os.getenv("DD_DOGSTATSD_PORT", "8125")),
        )
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.base_tags = [
            f"service:{datadog_tag(service)}",
            f"env:{datadog_tag(os.getenv('DD_ENV', 'local'))}",
            f"port:{port}",
            f"directory:{datadog_tag(os.path.basename(directory) or directory)}",
        ]
        version = os.getenv("DD_VERSION")
        if version:
            self.base_tags.append(f"version:{datadog_tag(version)}")

    def increment(self, metric: str, tags=None):
        self._send(metric, 1, "c", tags)

    def timing(self, metric: str, value_ms: float, tags=None):
        self._send(metric, f"{value_ms:.2f}", "ms", tags)

    def gauge(self, metric: str, value: float, tags=None):
        self._send(metric, value, "g", tags)

    def _send(self, metric: str, value, metric_type: str, tags=None):
        if not self.enabled:
            return
        metric_tags = self.base_tags + (tags or [])
        payload = f"{metric}:{value}|{metric_type}|#{','.join(metric_tags)}"
        try:
            self.socket.sendto(payload.encode("utf-8"), self.address)
        except OSError:
            pass


def log_event(server, level: str, message: str, **fields):
    """Emite logs humanos por padrão ou JSON quando DD_LOGS_JSON=1."""
    service = getattr(server, "datadog_service", "flowbridge")
    port = server.server_address[1]

    if env_flag("DD_LOGS_JSON", False):
        event = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "status": level,
            "message": message,
            "service": service,
            "ddsource": "python",
            "ddtags": f"env:{os.getenv('DD_ENV', 'local')},port:{port}",
            **fields,
        }
        version = os.getenv("DD_VERSION")
        if version:
            event["version"] = version
        print(json.dumps(event, ensure_ascii=False), flush=True)
        return

    prefix = f"  [:{port}]"
    print(f"{prefix} {message}", flush=True)


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

    def send_response(self, code, message=None):
        self._status_code = code
        super().send_response(code, message)

    def handle_one_request(self):
        self._request_started_at = time.perf_counter()
        self._status_code = 0
        super().handle_one_request()
        self._record_datadog_metrics()

    def _record_datadog_metrics(self):
        if not getattr(self, "command", None):
            return

        duration_ms = (time.perf_counter() - self._request_started_at) * 1000
        status_code = getattr(self, "_status_code", 0) or 0
        status_family = f"{status_code // 100}xx" if status_code else "unknown"
        tags = [
            f"method:{datadog_tag(self.command)}",
            f"status_code:{status_code}",
            f"status_family:{status_family}",
        ]

        self.server.datadog.increment("flowbridge.http.requests", tags)
        self.server.datadog.timing("flowbridge.http.request.duration", duration_ms, tags)

    def log_message(self, format, *args):
        """Formata o log com a porta para facilitar leitura no terminal."""
        log_event(
            self.server,
            "info",
            format % args,
            http={
                "method": getattr(self, "command", None),
                "url": getattr(self, "path", None),
                "status_code": getattr(self, "_status_code", None),
                "client_ip": self.client_address[0],
            },
        )


def run(port: int, directory: str = "."):
    directory = os.path.abspath(directory)
    os.chdir(directory)
    server = HTTPServer(("127.0.0.1", port), CORSRequestHandler)
    service = os.getenv("DD_SERVICE", SERVICE_BY_PORT.get(port, "flowbridge"))
    server.datadog_service = service
    server.datadog = DogStatsD(service, port, directory)
    server.datadog.gauge("flowbridge.server.up", 1)

    print(f"  Servindo '{directory}' em http://localhost:{port}")
    print(f"  Datadog service: {service}")
    print(f"  Ctrl+C para encerrar.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.datadog.gauge("flowbridge.server.up", 0)
        print(f"\n  Servidor :{port} encerrado.")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    port = int(sys.argv[1])
    directory = sys.argv[2] if len(sys.argv) > 2 else "."
    run(port, directory)
