import { defineStack, Env, node, Postgres, Temporal } from "forkyard"

const envFrom = [Env.varlock()]
const routing = (urls: { readonly api: string; readonly shop: string; readonly backoffice: string }) => ({
  API_URL: urls.api,
  SHOP_URL: urls.shop,
  BACKOFFICE_URL: urls.backoffice
})

export default defineStack({
  name: "storefront",
  infra: {
    postgres: Postgres.docker({ scope: "shared", golden: { migrate: node("packages/db/migrate.mjs") } }),
    temporal: Temporal.dev({ scope: "worktree", namespaces: ["orders", "fulfillment", "notifications"] })
  },
  services: {
    migrate: { kind: "task", run: node("packages/db/migrate.mjs"), uses: ["postgres"], envFrom },
    api: {
      kind: "http",
      cwd: "apps/api",
      run: node("server.mjs"),
      uses: ["postgres", "temporal"],
      after: ["migrate"],
      env: routing,
      envFrom
    },
    workers: {
      kind: "worker",
      cwd: "apps/workers",
      run: node("worker.mjs"),
      uses: ["postgres", "temporal"],
      after: ["migrate"],
      env: routing,
      envFrom
    },
    shop: { kind: "http", cwd: "apps/shop", run: node("server.mjs"), after: ["api"], env: routing, envFrom },
    backoffice: { kind: "http", cwd: "apps/backoffice", run: node("server.mjs"), uses: ["temporal"], after: ["api"], env: routing, envFrom }
  }
})
