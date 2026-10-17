import os
import time

from taskboard.common import connect

who = f"worker pid {os.getpid()}"
poll = float(os.environ.get("POLL_SECONDS", "1"))
print(f"worker started on {os.environ['DATABASE_PATH']}, polling every {poll}s", flush=True)


def tick():
    with connect() as connection:
        row = connection.execute("SELECT id, title FROM tasks WHERE estimated_by IS NULL ORDER BY id LIMIT 1").fetchone()
        if row is None:
            return
        connection.execute("UPDATE tasks SET estimated_by = ?, status = 'estimated' WHERE id = ?", (who, row["id"]))
        print(f"estimated task {row['id']}: {row['title']}", flush=True)


while True:
    tick()
    time.sleep(poll)
