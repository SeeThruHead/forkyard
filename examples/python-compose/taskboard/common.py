import colorsys
import html
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BRANCH = os.environ.get("FORKYARD_BRANCH", "local")


def connect():
    connection = sqlite3.connect(os.environ["DATABASE_PATH"], timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def branch_colour():
    hue = sum(ord(char) * (index + 3) for index, char in enumerate(BRANCH)) % 360 / 360
    red, green, blue = colorsys.hls_to_rgb(hue, 0.3, 0.55)
    return f"rgb({int(red * 255)} {int(green * 255)} {int(blue * 255)})"


def page(app, body):
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(os.environ.get('APP_NAME', 'Taskboard'))} {app} ({html.escape(BRANCH)})</title>
<style>*{{box-sizing:border-box}}body{{margin:0;font:14px/1.55 Georgia,serif;color:#1c1917;background:#fff}}
header{{background:#14532d;color:#fff;padding:12px 20px;display:flex;gap:14px;align-items:center;font-family:-apple-system,sans-serif}}
.branch{{padding:3px 10px;border-radius:4px;font-weight:600;font-size:13px;background:{branch_colour()}}}
main{{padding:18px 20px;max-width:960px}}h2{{font-size:17px;margin:20px 0 8px}}
table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{padding:7px 9px;border-bottom:1px solid #e7e5e4;text-align:left}}
code{{font:12px ui-monospace,Menlo,monospace;background:#f5f5f4;padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}}
.panel{{border:1px solid #e7e5e4;border-left:3px solid #15803d;background:#f0fdf4;padding:10px 14px}}
.panel dl{{display:grid;grid-template-columns:max-content 1fr;gap:3px 14px;margin:0}}.panel dt{{color:#57534e}}.panel dd{{margin:0}}
form{{display:flex;gap:8px}}input{{flex:1;padding:7px 9px;border:1px solid #d6d3d1;border-radius:4px;font:inherit}}
button{{background:#15803d;color:#fff;border:0;border-radius:4px;padding:7px 14px;cursor:pointer}}</style></head>
<body><header><b>{html.escape(os.environ.get('APP_NAME', 'Taskboard'))}</b><span>{app}</span><span class="branch">{html.escape(BRANCH)}</span>
<span style="color:#bbf7d0">Python stdlib, docker compose env, SQLite file per worktree</span></header><main>{body}</main></body></html>"""


def panel(rows):
    items = "".join(f"<dt>{html.escape(str(label))}</dt><dd><code>{html.escape(str(value))}</code></dd>" for label, value in rows)
    return f'<div class="panel"><dl>{items}</dl></div>'


def table(columns, rows):
    if not rows:
        return "<p><i>Nothing yet.</i></p>"
    head = "".join(f"<th>{html.escape(column)}</th>" for column in columns)
    body = "".join("<tr>" + "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row) + "</tr>" for row in rows)
    return f"<table><tr>{head}</tr>{body}</table>"


def serve(name, handler_class):
    port = int(os.environ["PORT"])
    print(f"{name} listening on 127.0.0.1:{port} for {os.environ.get('FORKYARD_WORKTREE', '(not under forkyard)')}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), handler_class).serve_forever()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)

    def send(self, status, content_type, body):
        data = body.encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, status, value):
        self.send(status, "application/json", json.dumps(value, indent=2, default=str))

    def redirect(self, location):
        self.send_response(303)
        self.send_header("location", location)
        self.end_headers()

    def body(self):
        length = int(self.headers.get("content-length", "0"))
        return self.rfile.read(length).decode() if length else ""
