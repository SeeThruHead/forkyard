import json
import os
import urllib.parse
import urllib.request

from taskboard.common import BRANCH, Handler, page, panel, serve, table

API = os.environ["API_URL"]


def fetch(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(API + path, data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


class Web(Handler):
    def do_GET(self):
        if self.path == "/health":
            return self.send(200, "text/plain", "ok")
        about = fetch("/api/info")
        tasks = fetch("/api/tasks")
        body = (
            "<h2>This worktree</h2>"
            + panel([("web pid", os.getpid()), ("talks to api at", API), ("database file", about["database"]), ("from .env.compose", about["app_name"]), ("LOG_LEVEL", about["log_level"])])
            + '<h2>Add a task</h2><form method="post" action="/tasks"><input name="title" placeholder="Something to do on this branch" required><button>Add</button></form>'
            + "<h2>Tasks</h2>"
            + table(["#", "Title", "Status", "Estimated by"], [[task["id"], task["title"], task["status"], task["estimated_by"] or "waiting"] for task in tasks])
        )
        return self.send(200, "text/html", page("web", body))

    def do_POST(self):
        form = urllib.parse.parse_qs(self.body())
        fetch("/api/tasks", {"title": form.get("title", [""])[0]})
        return self.redirect("/")


serve("web", Web)
