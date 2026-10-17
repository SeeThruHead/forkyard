import { html, json, listen, page, panel, readJson, table } from "@storefront/ui"
import { createServer } from "node:http"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const startedAt = new Date().toISOString()
const branch = process.env.FORKYARD_BRANCH ?? "local"

const query = async (sql, params = []) => (await pool.query(sql, params)).rows

const hasTable = async (name) => (await query("SELECT to_regclass($1) IS NOT NULL AS present", [name]))[0].present

const temporalNamespaces = async () => {
  try {
    const response = await fetch(`${process.env.TEMPORAL_HTTP_URL}/api/v1/namespaces`)
    const body = await response.json()
    return body.namespaces.map((namespace) => namespace.namespaceInfo.name).filter((name) => name !== "temporal-system")
  } catch (error) {
    return [`unreachable: ${error.message}`]
  }
}

const info = async () => ({
  app: "api",
  worktree: process.env.FORKYARD_WORKTREE ?? null,
  branch,
  pid: process.pid,
  port: Number(process.env.PORT),
  startedAt,
  database: (await query("SELECT current_database() AS name"))[0].name,
  migrations: (await query("SELECT name FROM schema_migrations ORDER BY name")).map((row) => row.name),
  temporal: { address: process.env.TEMPORAL_ADDRESS, namespaces: await temporalNamespaces(), ui: process.env.TEMPORAL_UI_URL },
  auth: { issuer: process.env.AUTH_ISSUER_URL, client: process.env.AUTH_CLIENT_ID },
  urls: {
    api: process.env.API_URL,
    shop: process.env.SHOP_URL,
    backoffice: process.env.BACKOFFICE_URL,
    graphql: process.env.API_GRAPHQL_URL
  }
})

const routes = {
  "GET /health": async (_request, response) => json(response, 200, { ok: true }),
  "GET /api/info": async (_request, response) => json(response, 200, await info()),
  "GET /api/products": async (_request, response) => json(response, 200, await query("SELECT * FROM products ORDER BY id")),
  "GET /api/orders": async (_request, response) =>
    json(
      response,
      200,
      await query(
        "SELECT orders.*, products.name AS product FROM orders JOIN products ON products.id = orders.product_id ORDER BY orders.id DESC"
      )
    ),
  "POST /api/orders": async (request, response) => {
    const { productId, note } = await readJson(request)
    const [order] = await query("INSERT INTO orders (product_id, quantity, note) VALUES ($1, 1, $2) RETURNING *", [
      Number(productId),
      String(note ?? "").slice(0, 200)
    ])
    console.log(`order ${order.id} placed for product ${order.product_id}`)
    json(response, 201, order)
  },
  "GET /api/jobs": async (_request, response) => json(response, 200, await query("SELECT * FROM jobs ORDER BY id DESC")),
  "POST /api/jobs": async (request, response) => {
    const { kind } = await readJson(request)
    const [job] = await query("INSERT INTO jobs (kind) VALUES ($1) RETURNING *", [String(kind ?? "recount inventory")])
    console.log(`job ${job.id} queued: ${job.kind}`)
    json(response, 201, job)
  },
  "GET /api/gift-cards": async (_request, response) =>
    (await hasTable("gift_cards"))
      ? json(response, 200, await query("SELECT * FROM gift_cards ORDER BY id"))
      : json(response, 404, { error: "no gift_cards table on this branch" }),
  "GET /": async (_request, response) => {
    const about = await info()
    html(
      response,
      page({
        app: "api",
        title: "api",
        branch,
        body: `<h2>This process</h2>${panel([
          ["worktree", about.worktree],
          ["pid / port", `${about.pid} / ${about.port}`],
          ["database", about.database],
          ["migrations", about.migrations.join(", ")],
          ["temporal", `${about.temporal.address} (${about.temporal.namespaces.join(", ")})`],
          ["auth issuer", about.auth.issuer],
          ["graphql url", about.urls.graphql]
        ])}<h2>Endpoints</h2>${table(
          ["Path", ""],
          [
            ["/api/info", "what this api is connected to"],
            ["/api/products", "seed data"],
            ["/api/orders", "orders placed from the shop"],
            ["/api/jobs", "queued from the backoffice, run by workers"],
            ["/api/gift-cards", "only on branches with the gift cards migration"]
          ]
        )}`
      })
    )
  }
}

listen(
  createServer((request, response) => {
    const handler = routes[`${request.method} ${new URL(request.url, "http://x").pathname}`]
    if (!handler) return json(response, 404, { error: "not found" })
    return handler(request, response).catch((error) => {
      console.error(error)
      json(response, 500, { error: error.message })
    })
  }),
  "api"
)
