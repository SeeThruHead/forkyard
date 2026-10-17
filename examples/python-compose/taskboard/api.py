import json
import os

from taskboard.common import BRANCH, Handler, connect, page, panel, serve


def info():
    return {
        "app": "api",
        "branch": BRANCH,
        "pid": os.getpid(),
        "database": os.environ["DATABASE_PATH"],
        "app_name": os.environ.get("APP_NAME"),
        "timezone": os.environ.get("TIMEZONE"),
        "log_level": os.environ.get("LOG_LEVEL"),
        "web_url": os.environ.get("WEB_URL"),
    }


class Api(Handler):
    def do_GET(self):
        if self.path == "/health":
            return self.send(200, "text/plain", "ok")
        if self.path == "/api/info":
            return self.send_json(200, info())
        if self.path == "/api/tasks":
            with connect() as connection:
                rows = [dict(row) for row in connection.execute("SELECT * FROM tasks ORDER BY id DESC")]
            return self.send_json(200, rows)
        about = info()
        return self.send(200, "text/html", page("api", "<h2>This process</h2>" + panel(about.items())))

    def do_POST(self):
        if self.path != "/api/tasks":
            return self.send_json(404, {"error": "not found"})
        title = json.loads(self.body() or "{}").get("title", "")[:200]
        with connect() as connection:
            task_id = connection.execute("INSERT INTO tasks (title) VALUES (?)", (title,)).lastrowid
        print(f"task {task_id} created: {title}", flush=True)
        return self.send_json(201, {"id": task_id, "title": title})


serve("api", Api)
