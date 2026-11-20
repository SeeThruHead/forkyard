# forkyard

Forkyard runs many checkouts of the same repo side by side. Each branch gets its own copy of the stack (services, databases, queues) at its own URLs, such as `http://api.my-branch.shop.localhost`, so you, or several coding agents, can work on different branches at once without fighting over ports, databases or env files.

You describe the stack once, in a `forkyard.config.ts` at the repo root. One daemon per machine reads it for every checkout. It starts and supervises the processes, gives each one a free port, routes its hostname through Traefik, and tells each process where its databases and neighbours are through its environment. A dashboard at http://forkyard.localhost and a macOS menu bar app show what runs where.

For coding agents there is a step-by-step guide: [docs/agents.md](docs/agents.md).

## Requirements

- macOS or Linux. On Windows, use WSL (native Windows stops at startup and points you to WSL).
- Node 24 or newer, or Bun.
- Docker, for the Traefik proxy and for any infra a config runs in containers (`Postgres.docker`, for example). A local `traefik` binary also works, with `FORKYARD_PROXY=binary`.

## Install

Pin forkyard in the repo as a dev dependency, next to `effect` (forkyard 0.1 works with `effect` 4.1):

```sh
pnpm add -D forkyard effect
```

Then install the same package globally, so you can type `forkyard` anywhere:

```sh
npm install -g forkyard
```

The global command hands off to the repo's pinned copy: from the current folder it walks up looking for `node_modules/forkyard`, and then for `tools/forkyard/node_modules/forkyard`. So each repo runs the version it pinned, and outside a repo the global copy runs itself. Without the global install, `pnpm forkyard <command>` does the same inside the repo.

### Pinning it under tools/forkyard

Some repos keep forkyard out of the root `package.json` and pin it in a small package of its own, with the config next to it so its imports resolve from that package:

```
my-repo/
  tools/forkyard/package.json          { "private": true, "devDependencies": { "forkyard": "0.1.0", "effect": "4.1.5" } }
  tools/forkyard/forkyard.config.ts
  tools/forkyard/node_modules/forkyard
```

```sh
cd tools/forkyard && pnpm install
```

The global `forkyard`, run from anywhere in `my-repo`, finds and runs that copy. Forkyard looks for `forkyard.config.ts` at the repo root first and then at `tools/forkyard/forkyard.config.ts`; either way the repo root is the checkout, and every path in the config (`cwd`, `watch`, files) is relative to it.

### The menu bar app (macOS)

```sh
brew install seethruhead/tap/forkyard-bar
```

## A first config

This is a small repo with a migration task and an API, both Node scripts, sharing a SQLite file. It is the repo the commands below were run in.

```ts
import { defineStack, node, Sqlite, watch } from "forkyard"

export default defineStack({
  name: "hello",
  infra: {
    sqlite: Sqlite.file({ file: "hello.sqlite", env: ({ path }) => ({ DATABASE_PATH: path }) })
  },
  services: {
    migrate: {
      kind: "task",
      run: node("api/migrate.mjs"),
      uses: ["sqlite"]
    },
    api: {
      kind: "http",
      run: node("api/server.mjs"),
      uses: ["sqlite"],
      after: ["migrate"],
      watch: watch("api/**")
    }
  }
})
```

- `kind` is `http` (gets a port in `PORT` and a hostname; it is ready once it answers `GET /health`), `worker` (a long-running process with no hostname) or `task` (runs once; things `after` it wait for it to finish).
- `uses` names the infra a service reads, and the infra's `env` puts its location in the service's environment.
- `watch` restarts the service when those files change.
- Names are typed: a typo such as `after: ["migrat"]` is a TypeScript error, so typecheck the config (`tsc --noEmit` with `forkyard.config.ts` included).

For more, see [examples/](examples/README.md): pnpm and Bun workspaces, env from `.env`, varlock or `docker-compose.yml`, shared Postgres with a database per branch cloned from a golden copy, Redis, Temporal, and configs written as an Effect program with `make`.

## Day to day

Start the daemon once, in its own terminal:

```sh
forkyard daemon
```

```
[14:46:39.234] INFO (#36): reaped 0 orphaned processes from a previous daemon
[14:46:39.330] INFO (#74): forkyard on /home/dev/.forkyard/forkyard.sock, dashboard at http://forkyard.localhost
```

Or run it as a login service (launchd on macOS, systemd on Linux and WSL): `forkyard service install`, and `forkyard service status`, `restart` and `uninstall`.

In a checkout:

```sh
forkyard up
```

```
main.hello starting from /home/dev/hello
  sqlite         ready
  migrate        done
  api            ready      http://api.main.hello.localhost
dashboard: http://forkyard.localhost/#/wt/main.hello
```

A second checkout on another branch runs next to it, with its own port, its own SQLite file and its own hostname:

```sh
cd ../hello-feature && forkyard up && forkyard status
```

```
main.hello  (/home/dev/hello)
  sqlite         ready
  migrate        done
  api            ready      http://api.main.hello.localhost

feature.hello  (/home/dev/hello-feature)
  sqlite         ready
  migrate        done
  api            ready      http://api.feature.hello.localhost
```

What a service was started with, and where each value came from:

```sh
forkyard env api
```

```
DATABASE_PATH       infra:sqlite    /home/dev/hello/.forkyard/hello.sqlite
FORKYARD_BRANCH     forkyard        main
FORKYARD_SERVICE    forkyard        api
FORKYARD_WORKTREE   forkyard        main.hello
PORT                forkyard        36619
```

A value a config replaced shows what it was, for example `PORT ... 46339 (was 8000)` when `docker-compose.yml` set 8000.

Its logs, followed until Ctrl-C:

```sh
forkyard logs api
```

```
run #1 (pid 2351119) of main.hello/api
api listening on 36619
GET /health
GET /
```

The rest:

```sh
forkyard attach        # terminal UI: every service's output, restart, env, open in the browser
forkyard down          # stop this checkout's stack
forkyard up --branch x # use a name other than the git branch
forkyard --help        # every command
```

`forkyard update` upgrades forkyard, the menu bar app if it was installed with brew, and the running daemon.

## Shared services

A large monorepo can need gigabytes of memory per checkout when every checkout runs the whole stack. With sharing turned on, forkyard keeps one shared stack per project at a ref such as `origin/main`, and each checkout runs only what its branch changed. Everything else comes from the shared stack, starting on the first request to its hostname and sleeping again after a quiet spell.

```ts
export default make("shop", program, {
  inputs: moon({ services: { api: "api", web: "web" } }),
  shared: { ref: "origin/main", sleepAfter: "20 minutes" }
})
```

```sh
forkyard own api       # run this checkout's own api even though the branch did not change it
forkyard share api     # undo own
forkyard start web     # start a service this checkout needs (here or in the shared stack)
forkyard stop web      # undo start
forkyard shared update # move the shared stack to the latest commit of its ref
```

[docs/shared-services.md](docs/shared-services.md) explains what runs where and why.

## The dashboard and the menu bar app

The dashboard, at http://forkyard.localhost, lists every checkout with its services, their state, URLs and logs; `forkyard up` prints the link to its checkout's page. The menu bar app (`forkyard-bar`, macOS) shows the same state from the menu bar. Both, like the CLI and `forkyard attach`, talk to the one daemon, so they always agree.

## How it fits together

- The daemon keeps its state in one SQLite file in its home directory, `~/.forkyard` (`FORKYARD_HOME` changes it), and reaps processes left behind by a previous daemon when it starts.
- Clients talk to it over the RPC protocol in `src/Protocol.ts`, on a socket in that directory. Older clients keep working with newer daemons.
- Traefik routes each `*.localhost` hostname to the process serving it.

[AGENTS.md](AGENTS.md) covers how forkyard starts, which module owns which table, and the protocol's compatibility rules.

## Troubleshooting

**`forkyard: forkyard is not running. Start it with: forkyard daemon`.** Start the daemon in another terminal, or install it as a service with `forkyard service install`.

**Installing from GitHub instead of npm.** A git dependency (`pnpm add -D github:SeeThruHead/forkyard#<commit>`) is built on install, so pnpm must be allowed to run its scripts. With pnpm 10, in the consuming repo's `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - forkyard
```

pnpm 11 and newer use `allowBuilds`, and for a git dependency the key is the full name pnpm prints in its error, not just `forkyard`:

```yaml
allowBuilds:
  forkyard@https://codeload.github.com/SeeThruHead/forkyard/tar.gz/<commit sha>: true
```

**`Building forkyard's dashboard needs Bun, and bun is not on PATH`.** Building forkyard (a git dependency, or a clone) builds the dashboard with Bun. Install it from https://bun.sh and install again. Installs from npm come built and do not need Bun.

**forkyard fails at startup with `does not provide an export named ...` or a missing `effect/dist/...` file.** The repo has an `effect` that does not match forkyard's. forkyard 0.1 uses `effect` 4.1: `pnpm add -D effect@~4.1.5`.

## Development

[just](https://just.systems) comes with the dev dependencies; `just` lists the recipes.

```sh
just setup   # install dependencies, the example repos and the git hooks
just check   # format, lint, typecheck and tests
just daemon  # run the daemon from source
```

## License

MIT
