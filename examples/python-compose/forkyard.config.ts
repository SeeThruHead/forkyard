import { cmd, defineStack, Env, Sqlite } from "forkyard"

const python = (module: string) => cmd("python3", "-u", "-m", module)

export default defineStack({
  name: "taskboard",
  infra: {
    sqlite: Sqlite.file({ file: "taskboard.sqlite", env: ({ path }) => ({ DATABASE_PATH: path }) })
  },
  services: {
    migrate: { kind: "task", run: python("taskboard.migrate"), uses: ["sqlite"], envFrom: [Env.compose({ service: "migrate" })] },
    api: {
      kind: "http",
      run: python("taskboard.api"),
      uses: ["sqlite"],
      after: ["migrate"],
      envFrom: [Env.compose({ service: "api" })],
      env: (urls) => ({ WEB_URL: urls.web, LOG_LEVEL: "debug" })
    },
    worker: { kind: "worker", run: python("taskboard.worker"), uses: ["sqlite"], after: ["migrate"], envFrom: [Env.compose({ service: "worker" })] },
    web: { kind: "http", run: python("taskboard.web"), after: ["api"], envFrom: [Env.compose({ service: "web" })], env: (urls) => ({ API_URL: urls.api }) }
  }
})
