# Examples

Three small repos with different tooling. Each describes itself in a `forkyard.config.ts`; forkyard knows nothing else about them.

| Folder            | Runtime                 | Env comes from                                                      | Data                                                                                             |
| ----------------- | ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `storefront/`     | Node, pnpm workspace    | varlock `.env.schema`, secrets from a stand-in secret manager       | shared Postgres, database per branch cloned from a golden template; a Temporal server per branch |
| `bun-dotenv/`     | Bun workspaces          | `.env` then `.env.local`                                            | shared Postgres, empty database per branch plus a migrate task; a Redis process per branch       |
| `python-compose/` | Python standard library | `docker-compose.yml` (`environment`, `env_file`, `${VAR:-default}`) | a SQLite file inside each checkout                                                               |

## Run one

```sh
alias forkyard="$PWD/../bin/forkyard"   # from this folder
forkyard daemon                         # in its own terminal; owns Traefik on port 80 and Maple
cd storefront && forkyard up --branch main
forkyard status
forkyard env api                        # every variable, where it came from, what it replaced
forkyard logs api
```

The dashboard is at http://forkyard.localhost and telemetry at http://maple.localhost. Every web service is at `http://<service>.<branch>.<repo>.localhost`.

## Run the tour

`pnpm run tour` (from the repo root, with the daemon running) copies each example into `run/worktrees/<repo>/<branch>` for seven branches, applies the branch changes in `harness/branches/`, starts them all, checks that they are independent and that their telemetry reached Maple, and prints the tour link: http://forkyard.localhost/#/tour/1
