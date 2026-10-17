import os

from taskboard.common import connect

with connect() as connection:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'todo',
          estimated_by TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
print(f"migrated {os.environ['DATABASE_PATH']}", flush=True)
