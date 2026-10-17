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
