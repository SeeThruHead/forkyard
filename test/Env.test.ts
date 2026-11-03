import { describe, expect, it } from "@effect/vitest"
import { Effect, Option, Schema } from "effect"
import { dotenv, type EnvLoadContext, varlock } from "../src/EnvSource.ts"
import { mergeEnv } from "../src/Env.ts"

const files: Readonly<Record<string, string>> = {
  "/repo/.env":
    "DATABASE_URL=postgres://localhost:5432/app\nLINK_TTL_DAYS=30\nSESSION_SECRET=abc123xyz\nANALYTICS_URL=http://localhost:8787\n",
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
    Effect.gen(function* () {
      const env = yield* dotenv(".env", ".env.local", ".env.missing").load(context).pipe(Effect.scoped)
      expect(env.LINK_TTL_DAYS?.value).toBe("7")
      expect(env.SESSION_SECRET?.sensitive).toBe(true)
      expect(env.DATABASE_URL?.sensitive).toBe(false)
    })
  )

  it("forkyard's values win, keep what they replaced, and fixed ports are flagged", () => {
    const sourced = {
      DATABASE_URL: { value: "postgres://localhost:5432/app", sensitive: false, source: ".env" },
      ANALYTICS_URL: { value: "http://localhost:8787", sensitive: false, source: ".env" },
      GRAPHQL_URL: { value: "http://api.main.app.localhost/graphql", sensitive: false, source: "varlock" }
    }
    const pristine = { ...sourced, GRAPHQL_URL: { value: "http://localhost:4000/graphql", sensitive: false, source: "varlock" } }
    const owned = { DATABASE_URL: { value: "postgres://127.0.0.1:6000/app_main", source: "infra:postgres" } }
    const vars = Object.fromEntries(mergeEnv(sourced, pristine, owned).map((entry) => [entry.key, entry]))
    expect(vars.DATABASE_URL).toMatchObject({
      value: "postgres://127.0.0.1:6000/app_main",
      source: "infra:postgres",
      replaced: "postgres://localhost:5432/app"
    })
    expect(vars.GRAPHQL_URL).toMatchObject({ source: "varlock", replaced: "http://localhost:4000/graphql" })
    expect(vars.ANALYTICS_URL?.warning).toContain("fixed port")
    expect(vars.DATABASE_URL?.warning).toBeUndefined()
  })

  it("forkyard's telemetry settings are defaults: a service's own exporter keeps winning", () => {
    const sourced = { OTEL_EXPORTER_OTLP_ENDPOINT: { value: "http://127.0.0.1:14319", sensitive: false, source: "varlock" } }
    const owned = {
      OTEL_EXPORTER_OTLP_ENDPOINT: { value: "http://127.0.0.1:4318", source: "forkyard:otel" },
      OTEL_SERVICE_NAME: { value: "api", source: "forkyard:otel" }
    }
    const vars = Object.fromEntries(mergeEnv(sourced, {}, owned).map((entry) => [entry.key, entry]))
    expect(vars.OTEL_EXPORTER_OTLP_ENDPOINT).toMatchObject({ value: "http://127.0.0.1:14319", source: "varlock" })
    expect(vars.OTEL_SERVICE_NAME).toMatchObject({ value: "api", source: "forkyard:otel" })
  })

  it.effect("varlock items without a value (unset @optional keys) are skipped, not an error", () =>
    Effect.gen(function* () {
      const output = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        config: {
          DB_PORT: { value: 6111, isSensitive: false },
          HEALTH_PORT: { isSensitive: false },
          API_KEY: { value: "k", isSensitive: true }
        }
      })
      const withVarlock: EnvLoadContext = {
        ...context,
        readFile: (path) => Effect.succeed(path.endsWith("/varlock") ? Option.some("") : Option.none()),
        exec: () => Effect.succeed(output)
      }
      const env = yield* varlock({ schema: "env/.env.api.schema" }).load(withVarlock).pipe(Effect.scoped)
      expect(env.DB_PORT?.value).toBe("6111")
      expect(env.API_KEY?.sensitive).toBe(true)
      expect("HEALTH_PORT" in env).toBe(false)
    })
  )
})
