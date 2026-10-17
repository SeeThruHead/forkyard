import { defineStack, node, Sqlite } from "forkyard"

export default defineStack({
  name: "typo",
  infra: { sqlite: Sqlite.file() },
  services: {
    migrate: { kind: "task", run: node("migrate.mjs"), uses: ["sqlite"] },
    // @ts-expect-error
    api: { kind: "http", run: node("api.mjs"), uses: ["sqlit"], after: ["migrat"] }
  }
})
