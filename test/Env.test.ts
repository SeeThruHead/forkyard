import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { dotenv, type EnvLoadContext } from "../src/EnvSource.ts"
import { mergeEnv } from "../src/Supervisor.ts"

const files: Readonly<Record<string, string>> = {
  "/repo/.env": "DATABASE_URL=postgres://localhost:5432/app\nLINK_TTL_DAYS=30\nSESSION_SECRET=abc123xyz\nANALYTICS_URL=http://localhost:8787\n",
  "/repo/.env.local": "LINK_TTL_DAYS=7\n"
}

const context: EnvLoadContext = {
  root: "/repo",
  cwd: "/repo/apps/api",
  overrides: {},
  readFile: (path) => Effect.succeed(Option.fromNullishOr(files[path])),
  exec: () => Effect.die("not used")
}

describe("env", () => {
  it.effect("dotenv files load from the repo root, later files win", () =>
    Effect.gen(function*() {
      const env = yield* dotenv(".env", ".env.local", ".env.missing").load(context).pipe(Effect.scoped)
      expect(env.LINK_TTL_DAYS?.value).toBe("7")
      expect(env.SESSION_SECRET?.sensitive).toBe(true)
      expect(env.DATABASE_URL?.sensitive).toBe(false)
    }))

  it("forkyard's values win, keep what they replaced, and fixed ports are flagged", () => {
    const sourced = {
      DATABASE_URL: { value: "postgres://localhost:5432/app", sensitive: false, source: ".env" },
      ANALYTICS_URL: { value: "http://localhost:8787", sensitive: false, source: ".env" },
      GRAPHQL_URL: { value: "http://api.main.app.localhost/graphql", sensitive: false, source: "varlock" }
    }
    const pristine = { ...sourced, GRAPHQL_URL: { value: "http://localhost:4000/graphql", sensitive: false, source: "varlock" } }
    const owned = { DATABASE_URL: { value: "postgres://127.0.0.1:6000/app_main", source: "infra:postgres" } }
    const vars = Object.fromEntries(mergeEnv(sourced, pristine, owned).map((entry) => [entry.key, entry]))
    expect(vars.DATABASE_URL).toMatchObject({ value: "postgres://127.0.0.1:6000/app_main", source: "infra:postgres", replaced: "postgres://localhost:5432/app" })
    expect(vars.GRAPHQL_URL).toMatchObject({ source: "varlock", replaced: "http://localhost:4000/graphql" })
    expect(vars.ANALYTICS_URL?.warning).toContain("fixed port")
    expect(vars.DATABASE_URL?.warning).toBeUndefined()
  })
})
