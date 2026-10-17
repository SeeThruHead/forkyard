# taskboard (python-compose)

A team that normally runs everything with `docker compose up`. No Node at all: Python standard library only.

- `taskboard/api.py`, `web.py`, `worker.py`, `migrate.py` (http.server and sqlite3).
- `docker-compose.yml` is where the env lives: `env_file: .env.compose`, per-service `environment`, `${LOG_LEVEL:-info}` interpolation, and compose-only addresses like `API_URL: http://api:8000`.

`forkyard.config.ts` (the typed-object config style) reads each service's environment out of the compose file with `docker compose config`, runs the same Python natively, replaces `API_URL` and `WEB_URL` with the branch's names, and gives each branch a SQLite file inside its own checkout.
