# Adding forkyard to a repo: steps for coding agents

Follow these steps in order. Each step says what to run and what you should see. Forkyard runs one copy of the repo's stack per checkout, each at its own URLs, so several branches (and several agents) can run at once.

## 1. Check the machine

```sh
node --version        # v24 or newer (or have bun installed)
docker info --format '{{.ServerVersion}}'   # prints a version; forkyard's proxy runs in Docker
```

macOS, Linux or WSL. Native Windows is not supported.

## 2. Install forkyard in the repo

From the repo root, with the repo's package manager (pnpm shown):

```sh
pnpm add -D forkyard effect typescript
```

forkyard 0.1 works with `effect` 4.1. If the repo already pins another `effect` minor version, pnpm warns about the peer dependency; tell the person you work for instead of changing their `effect`.

If the repo pins tools outside its root `package.json`, put forkyard and `effect` in `tools/forkyard/package.json` instead, run `pnpm install` there, and write the config in step 3 as `tools/forkyard/forkyard.config.ts` (so it can import `forkyard`). Paths in the config stay relative to the repo root. The `forkyard` command finds both there.

Check it runs:

```sh
pnpm forkyard --version
```

```
forkyard v0.1.0
```

If `forkyard` is installed globally (`npm install -g forkyard`), plain `forkyard` works anywhere in the repo and runs the repo's pinned copy. The rest of this guide writes `forkyard`; use `pnpm forkyard` if it is not installed globally.

## 3. Write forkyard.config.ts

Read the repo first: how each app starts in development (its `dev` script), which port it listens on, which databases or queues it needs, and which env vars point at them. Then write `forkyard.config.ts` at the repo root.

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

Rules for the config:

- `name` is the project name; it becomes part of every hostname. Lowercase letters, digits and dashes.
- `kind: "http"` services must listen on the port in `PORT` (forkyard picks a free one) and answer `GET /health` with a 2xx status; forkyard waits up to 60 seconds for that before calling the service ready. They are reachable at `http://<service>.<branch>.<name>.localhost`.
- `kind: "worker"` is a long-running process with no URL. `kind: "task"` runs once (migrations, seeds); services list it in `after` to wait for it.
- `run` is a shell command string (`"pnpm --filter api dev"`) or a helper such as `node("file.mjs")`. `cwd` sets the folder it runs in, relative to the repo root.
- `uses` lists infra the service needs; the infra's `env` adds its location to the service's environment. `env: (urls) => ({ API_URL: urls.api })` passes other services' URLs.
- `envFrom: [Env.dotenv(".env", ".env.local")]` or `[Env.compose({ service: "api" })]` reads the env the repo already has.
- Infra: `Sqlite.file`, `Postgres.docker`, `Redis.native`, `Temporal.dev`, `Nats`, `Process`. `scope: "shared"` shares one server between checkouts (each gets its own database); `scope: "worktree"` runs one per checkout.

The examples in the forkyard repo (`examples/`) show pnpm and Bun workspaces, Postgres, Redis, Temporal and Python.

## 4. Check the config

Service and infra names are typed, so a typo is a type error. Add a typecheck script if the repo has none (`"typecheck": "tsc --noEmit"` in `package.json`, with `forkyard.config.ts` included in `tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["forkyard.config.ts"]
}
```

```sh
pnpm run typecheck
```

No output means the config is valid. A typo looks like this:

```
forkyard.config.ts(18,15): error TS2820: Type '"migrat"' is not assignable to type '"api" | "migrate"'. Did you mean '"migrate"'?
```

Add `.forkyard/` (where per-checkout files such as SQLite databases live) to `.gitignore`.

## 5. Make sure the daemon runs

```sh
forkyard status
```

If it prints `forkyard: forkyard is not running. Start it with: forkyard daemon`, start it. Do not start a second daemon if one is running.

```sh
forkyard daemon                 # foreground, in its own terminal
forkyard service install        # or as a login service, if the person you work for wants that
```

## 6. Start the stack

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

Every service should reach `ready` (or `done` for tasks). The branch comes from git; `forkyard up --branch <name>` overrides it. Check a URL:

```sh
curl -s http://api.main.hello.localhost/
```

## 7. Read status, env and logs

```sh
forkyard status         # every running checkout and its services
forkyard env api        # each variable api got, where it came from, and what it replaced
forkyard logs api       # follows api's output; stop with Ctrl-C, or wrap it: timeout 5 forkyard logs api
```

```
DATABASE_PATH       infra:sqlite    /home/dev/hello/.forkyard/hello.sqlite
FORKYARD_BRANCH     forkyard        main
FORKYARD_WORKTREE   forkyard        main.hello
PORT                forkyard        36619
```

```
run #1 (pid 2351119) of main.hello/api
api listening on 36619
GET /health
```

When a service is not ready: read its logs first, then its env. A service that listens on a fixed port instead of `PORT`, or has no `/health` route, never becomes ready.

## 8. Stop

```sh
forkyard down
```

```
main.hello stopped
```

## When it goes wrong

- `does not provide an export named ...` or a missing `effect/dist/...` file at startup: the repo's `effect` is not the 4.1 that forkyard 0.1 uses. `pnpm add -D effect@~4.1.5`.
- Installing forkyard from GitHub instead of npm needs build scripts allowed; see Troubleshooting in the README.
- `forkyard --help` and `forkyard <command> --help` list every command and flag.
