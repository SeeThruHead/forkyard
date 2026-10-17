import { Env, Infra, logLine, make, Nats, node, Postgres, Process, Redis, Service, Temporal, url, watch } from "forkyard"
import { Effect } from "effect"

const schema = (file: string) => [Env.varlock({ schema: file })]

const portOf = (redisUrl: string) => new URL(redisUrl).port

export default make(
  "northwind",
  Effect.gen(function* () {
    const postgresSpec = Postgres.docker({
      scope: "shared",
      golden: { snapshot: { worktree: "main" } },
      env: (db) => ({ DATABASE_URL: db.url, DB_HOST: db.host, DB_PORT: String(db.port), DB_DATABASE: db.database })
    })
    const postgres = yield* Infra(postgresSpec)
    const billingPostgres = yield* Infra(
      Postgres.docker({
        name: "billing-postgres",
        scope: "shared",
        golden: { migrate: node("apps/billing-api/db/migrate.ts") },
        env: (db) => ({ DB_HOST: db.host, DB_PORT: String(db.port), DB_NAME: db.database })
      })
    )
    const redis = yield* Infra(
      Redis.native({
        scope: "worktree",
        env: (tenant) => ({ REDIS_HOST: "127.0.0.1", REDIS_PORT: portOf(tenant.url), REDIS_URL: tenant.url })
      })
    )
    const nats = yield* Infra(Nats.docker({ scope: "worktree" }))
    const temporal = yield* Infra(
      Temporal.dev({
        scope: "worktree",
        namespaces: ["platform", "crons", "bulk-actions"],
        env: (tenant) => ({
          TEMPORAL_PLATFORM_ADDRESS: tenant.address,
          TEMPORAL_CRONS_ADDRESS: tenant.address,
          TEMPORAL_BULK_ADDRESS: tenant.address
        })
      })
    )
    const billingTemporal = yield* Infra(
      Temporal.dev({
        name: "billing-temporal",
        scope: "worktree",
        namespaces: ["billing"],
        env: (tenant) => ({ TEMPORAL_ADDRESS: tenant.address })
      })
    )

    const mailpit = yield* Infra(
      Process.infra({
        name: "mailpit",
        scope: "shared",
        run: "exec docker run --rm -p 127.0.0.1:$MAILPIT_PORT:8025 axllent/mailpit:v1.27",
        port: "MAILPIT_PORT",
        health: "/readyz",
        provides: (mail) => ({ MAILPIT_URL: mail.url })
      })
    )
    const objectStoreSpec = Process.infra({
      name: "object-store",
      scope: "shared",
      run: "pnpm --filter @northwind/object-store run dev",
      port: "OBJECT_STORE_PORT",
      health: "/_health",
      provides: (store, worktree) => ({ OBJECT_STORE_URL: store.url, IMAGE_BUCKET: `images-${worktree.branch}` })
    })
    const objectStore = yield* Infra(objectStoreSpec)
    const catalog = yield* Infra(
      Process.infra({
        name: "catalog",
        scope: "shared",
        uses: [objectStoreSpec],
        run: "pnpm --filter @northwind/catalog run dev",
        port: "CATALOG_PORT",
        provides: (tool) => ({ CATALOG_URL: tool.url })
      })
    )
    const flags = yield* Infra(
      Process.infra({
        name: "flags",
        scope: "worktree",
        run: "pnpm --filter @northwind/flags run dev",
        port: "FLAGS_PORT",
        env: { ALLOWED_ORIGINS: "*" },
        provides: (tool) => ({ FLAGS_BASE_URL: tool.routedUrl, FLAGS_STREAM_URL: tool.routedUrl, FLAGS_EVENTS_URL: tool.routedUrl })
      })
    )
    yield* Infra(
      Process.infra({
        name: "schema-viewer",
        scope: "shared",
        uses: [postgresSpec],
        run: "pnpm --filter @northwind/schema-viewer run dev",
        port: "SCHEMA_VIEWER_PORT"
      })
    )
    yield* Infra(
      Process.infra({ name: "log-viewer", scope: "shared", run: "pnpm --filter @northwind/log-viewer run dev", port: "LOG_VIEWER_PORT" })
    )
    yield* Infra(
      Process.infra({
        name: "dev-home",
        scope: "shared",
        run: "pnpm --filter @northwind/dev-home run dev",
        port: "DEV_HOME_PORT",
        health: "/"
      })
    )

    const coreApiUrl = yield* url("core-api")
    const portalUrl = yield* url("portal")
    const backofficeUrl = yield* url("backoffice")
    const authUiUrl = yield* url("auth-ui")
    const browserApps = [portalUrl, backofficeUrl].join(",")

    const migrate = yield* Service.task("migrate", {
      run: node("packages/db/migrate.ts"),
      uses: [postgres],
      watch: watch("packages/db/migrations/**")
    })
    const natsSetup = yield* Service.task("nats-setup", { run: "pnpm --filter @northwind/messaging run setup-streams", uses: [nats] })
    const codegen = yield* Service.task("codegen", {
      run: node("packages/codegen/codegen.ts", { args: ["apps/portal/src/generated/schema.ts"] }),
      uses: [postgres],
      after: [migrate],
      watch: watch("packages/db/migrations/**")
    })
    const codegenBackoffice = yield* Service.task("codegen-backoffice", {
      run: node("packages/codegen/codegen.ts", { args: ["apps/backoffice/src/generated/schema.ts"] }),
      uses: [postgres],
      after: [migrate],
      watch: watch("packages/db/migrations/**")
    })
    const billingCodegen = yield* Service.task("billing-codegen", {
      run: "pnpm --filter @northwind/billing-api run db:generate-client",
      watch: watch("apps/billing-api/db/migrations/**")
    })
    yield* Service.task("billing-webhooks", {
      run: "pnpm --filter @northwind/billing-api run provider:subscribe-webhooks",
      envFrom: schema("env/.env.billing.schema"),
      env: { BILLING_PUBLIC_URL: yield* url("billing-api") }
    })

    const coreApi = yield* Service.http("core-api", {
      run: "pnpm --filter @northwind/core-api run dev",
      health: "/public/health",
      uses: [postgres, redis, nats, temporal, flags, catalog],
      after: [migrate, natsSetup],
      envFrom: schema("env/.env.core-api.schema"),
      env: {
        API_URL: coreApiUrl,
        PORTAL_URL: portalUrl,
        IMAGE_API_URL: yield* url("image-api"),
        MAIL_API_BASE: yield* url("mail-shim"),
        AUTH_ISSUER: yield* url("auth"),
        ALLOWED_ORIGINS: browserApps
      }
    })
    yield* Service.worker("jobs", {
      run: "pnpm --filter @northwind/jobs run dev",
      uses: [postgres, redis],
      after: [migrate],
      envFrom: schema("env/.env.core-api.schema"),
      env: { MAIL_API_BASE: yield* url("mail-shim") },
      ready: logLine(/jobs ready/),
      watch: watch("apps/jobs/src/**")
    })
    const graph = yield* Service.http("graph", {
      run: "pnpm --filter @northwind/graph run dev",
      uses: [postgres, redis, flags],
      after: [migrate],
      envFrom: schema("env/.env.graph.schema"),
      env: { ALLOWED_ORIGINS: browserApps },
      watch: watch("apps/graph/src/**")
    })
    const billingApi = yield* Service.http("billing-api", {
      run: "pnpm --filter @northwind/billing-api run dev",
      uses: [billingPostgres, billingTemporal, nats, flags],
      after: [billingCodegen],
      envFrom: schema("env/.env.billing.schema"),
      env: { CORE_API_URL: coreApiUrl, ALLOWED_ORIGINS: browserApps },
      watch: watch("apps/billing-api/src/**")
    })
    yield* Service.worker("billing-worker", {
      run: "pnpm --filter @northwind/billing-api run worker",
      uses: [billingPostgres, billingTemporal, nats, flags],
      after: [billingCodegen],
      envFrom: schema("env/.env.billing.schema"),
      env: { CORE_API_URL: coreApiUrl },
      ports: ["HEALTH_PORT"],
      ready: logLine(/billing-worker ready/),
      watch: watch("apps/billing-api/src/**")
    })
    yield* Service.worker("platform-worker", {
      run: "pnpm --filter @northwind/platform-worker run dev",
      uses: [postgres, temporal, flags],
      after: [migrate],
      envFrom: schema("env/.env.platform-worker.schema"),
      env: { BILLING_API_URL: yield* url("billing-api"), CORE_API_URL: coreApiUrl },
      ready: logLine(/platform-worker ready/),
      watch: watch("apps/platform-worker/src/**")
    })
    yield* Service.worker("event-handlers", {
      run: "pnpm --filter @northwind/event-handlers run dev",
      uses: [postgres, nats, flags],
      after: [migrate, natsSetup],
      envFrom: schema("env/.env.event-handlers.schema"),
      ready: logLine(/event-handlers ready/),
      watch: watch("apps/event-handlers/src/**")
    })
    yield* Service.worker("outbox", {
      run: "pnpm --filter @northwind/outbox run dev",
      uses: [postgres, nats],
      after: [migrate, natsSetup],
      envFrom: schema("apps/outbox/.env.schema"),
      ports: ["HEALTH_PORT"],
      ready: logLine(/outbox ready/),
      watch: watch("apps/outbox/src/**")
    })
    yield* Service.http("image-api", {
      run: "pnpm --filter @northwind/image-api run dev",
      uses: [objectStore],
      envFrom: schema("apps/image-api/.env.schema"),
      env: { ALLOWED_ORIGINS: browserApps },
      watch: watch("apps/image-api/src/**")
    })
    yield* Service.http("mail-shim", {
      run: "pnpm --filter @northwind/mail-shim run dev",
      uses: [mailpit],
      watch: watch("apps/mail-shim/src/**")
    })
    yield* Service.http("fake-kyc", {
      run: "pnpm --filter @northwind/fake-kyc run dev",
      env: { API_URL: coreApiUrl },
      watch: watch("apps/fake-kyc/src/**")
    })
    const auth = yield* Service.http("auth", {
      run: "pnpm --filter @northwind/auth run dev",
      uses: [redis],
      envFrom: schema("env/.env.auth.schema"),
      env: {
        ISSUER: yield* url("auth"),
        UI_ORIGIN: authUiUrl,
        DEFAULT_POST_LOGIN_URL: `${portalUrl}/login`,
        CLIENTS_JSON: JSON.stringify([{ id: "portal", redirect_uris: [`${portalUrl}/login`] }]),
        ALLOWED_ORIGINS: authUiUrl
      },
      watch: watch("apps/auth/src/**")
    })
    yield* Service.http("auth-ui", {
      run: "pnpm --filter @northwind/auth-ui run dev",
      health: "/",
      after: [auth],
      envFrom: schema("env/.env.auth-ui.schema"),
      env: { VITE_AUTH_API_ORIGIN: yield* url("auth") }
    })
    yield* Service.http("portal", {
      run: "pnpm --filter @northwind/portal run dev",
      health: "/",
      uses: [flags],
      after: [codegen, coreApi, graph],
      envFrom: schema("env/.env.portal.schema"),
      env: {
        CORE_API_URL: coreApiUrl,
        GRAPH_API_URL: yield* url("graph"),
        BILLING_API_URL: yield* url("billing-api"),
        IMAGE_API_URL: yield* url("image-api"),
        SIGN_IN_URL: authUiUrl
      },
      watch: watch("apps/portal/vite.config.ts")
    })
    yield* Service.http("backoffice", {
      run: "pnpm --filter @northwind/backoffice run dev",
      health: "/",
      uses: [flags],
      after: [codegenBackoffice, coreApi, graph, billingApi],
      envFrom: schema("env/.env.backoffice.schema"),
      env: { REACT_APP_API_URL: coreApiUrl, GRAPH_API_URL: yield* url("graph"), BILLING_API_URL: yield* url("billing-api") }
    })
  })
)
