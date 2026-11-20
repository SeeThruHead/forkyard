# forkyard

Forkyard runs many worktrees of the same repo side by side. Each worktree gets its own copy of the stack (services, databases, queues) at its own URLs, such as `http://api.my-branch.shop.localhost`, so you or several agents can work on different branches at the same time without them stepping on each other.

One daemon per machine starts and supervises every worktree's processes, routes their hostnames through Traefik, and serves a dashboard at http://forkyard.localhost. Large projects can share services between worktrees, so a branch only runs what it changed. On macOS a menu bar app shows the same state.

## Requirements

- macOS or Linux. On Windows, use WSL (native Windows stops at startup and points you to WSL).
- Node 24 or newer, or Bun.
- Docker, for the Traefik proxy and any infra a config runs in containers (`Postgres.docker`, for example).

## Install

Add forkyard to the repo as a dev dependency, next to `effect`. forkyard 0.1 needs `effect` 4.0.x:

```sh
pnpm add -D forkyard effect@~4.0.5
```

To type `forkyard` instead of `pnpm forkyard`, install the same package globally. Inside a repo it hands off to the repo's pinned copy (`node_modules/forkyard`, or `tools/forkyard/node_modules/forkyard`), so each repo runs the version it pinned; elsewhere it runs itself:

```sh
npm install -g forkyard
```

The menu bar app (macOS only):

```sh
brew install seethruhead/tap/forkyard-bar
```

## A first config

A repo describes its stack in `forkyard.config.ts` at its root. This is the `python-compose` example: a SQLite file, a migration task, an API, a worker and a web front end, with env read from `docker-compose.yml`.

```ts
import { defineStack, Env, Sqlite, watch } from "forkyard"

export default defineStack({
  name: "taskboard",
  infra: {
    sqlite: Sqlite.file({ file: "taskboard.sqlite", env: ({ path }) => ({ DATABASE_PATH: path }) })
  },
  services: {
    migrate: {
      kind: "task",
      run: "python3 -u -m taskboard.migrate",
      uses: ["sqlite"],
      envFrom: [Env.compose({ service: "migrate" })],
      watch: watch("taskboard/migrate.py")
    },
    api: {
      kind: "http",
      run: "python3 -u -m taskboard.api",
      uses: ["sqlite"],
      after: ["migrate"],
      envFrom: [Env.compose({ service: "api" })],
      env: (urls) => ({ WEB_URL: urls.web, LOG_LEVEL: "debug" })
    },
    worker: {
      kind: "worker",
      run: "python3 -u -m taskboard.worker",
      uses: ["sqlite"],
      after: ["migrate"],
      envFrom: [Env.compose({ service: "worker" })]
    },
    web: {
      kind: "http",
      run: "python3 -u -m taskboard.web",
      after: ["api"],
      envFrom: [Env.compose({ service: "web" })],
      env: (urls) => ({ API_URL: urls.api })
    }
  }
})
```

Every `http` service gets a free port in `PORT` and a hostname of the form `<service>.<branch>.<name>.localhost`. Configs can also be written as an Effect program with `make`, as in `examples/bun-dotenv`. [examples/README.md](examples/README.md) lists the other examples (pnpm and Bun workspaces, shared Postgres with a database per branch, Temporal, Redis).

## Day to day

Start the daemon once, in its own terminal:

```sh
forkyard daemon
```

or run it as a login service (launchd on macOS, systemd on Linux and WSL):

```sh
forkyard service install
```

Then, in a worktree:

```sh
forkyard up              # start this worktree's stack
forkyard status          # every running worktree, its services and URLs
forkyard env api         # each variable api got, where it came from, what it replaced
forkyard logs api        # follow api's logs
forkyard attach          # terminal UI for this worktree
forkyard down            # stop this worktree's stack
```

`forkyard up --branch <name>` uses a name other than the git branch, and `--profile <name>` picks a profile from the config. `forkyard --help` lists every command, including `own`, `share`, `start`, `stop` and `shared update` for shared services, and `update` to upgrade forkyard and the running daemon.

## How it fits together

- The daemon keeps its state in one SQLite file in its home directory, `~/.forkyard` (`FORKYARD_HOME` changes it). It reaps processes left behind by a previous daemon on startup.
- The CLI, the terminal UI, the dashboard and the menu bar app all talk to the daemon over the RPC protocol in `src/Protocol.ts`, on a socket in the home directory.
- Traefik (in Docker by default, or a local `traefik` binary with `FORKYARD_PROXY=binary`) routes each `*.localhost` hostname to the right process.

[AGENTS.md](AGENTS.md) covers how forkyard starts, which module owns which table, and the protocol's compatibility rules. [docs/shared-services.md](docs/shared-services.md) explains sharing services between worktrees.

## Development

[just](https://just.systems) is installed as a dev dependency; `just` lists the recipes.

```sh
just setup   # install dependencies, the example repos and the git hooks
just check   # format, lint, typecheck and tests
just daemon  # run the daemon from source
```

## License

MIT
