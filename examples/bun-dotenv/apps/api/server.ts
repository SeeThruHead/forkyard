import { queueKey } from "@shortly/shared"
import { RedisClient, SQL } from "bun"

const sql = new SQL(process.env.DATABASE_URL!)
const redis = new RedisClient(process.env.REDIS_URL!)
const branch = process.env.FORKYARD_BRANCH ?? "local"

const code = () => Math.random().toString(36).slice(2, 8)

const info = async () => {
  const [{ name }] = await sql`SELECT current_database() AS name`
  return {
    app: "api",
    branch,
    pid: process.pid,
    database: name,
    redis: process.env.REDIS_URL,
    queue: queueKey(),
    linkTtlDays: Number(process.env.LINK_TTL_DAYS),
    qrCodes: process.env.FEATURE_QR_CODES === "true"
  }
}

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  routes: {
    "/health": new Response("ok"),
    "/api/info": async () => Response.json(await info()),
    "/api/links": {
      GET: async () => Response.json(await sql`SELECT * FROM links ORDER BY created_at DESC`),
      POST: async (request) => {
        const body = (await request.json()) as { target?: string }
        const [link] = await sql`INSERT INTO links (code, target) VALUES (${code()}, ${String(body.target ?? "")}) RETURNING *`
        await redis.send("RPUSH", [queueKey(), link.code])
        console.log(`shortened ${link.target} as ${link.code}, queued check`)
        return Response.json(link, { status: 201 })
      }
    },
    "/r/:code": async (request) => {
      const [link] = await sql`UPDATE links SET clicks = clicks + 1 WHERE code = ${request.params.code} RETURNING target`
      return link ? Response.redirect(link.target, 302) : new Response("unknown link", { status: 404 })
    }
  }
})

console.log(`api listening on ${process.env.PORT} for ${process.env.FORKYARD_WORKTREE ?? "(not under forkyard)"}`)
