import { createServer } from "node:http"
import pg from "pg"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })

createServer(async (request, response) => {
  if (request.url === "/health") return response.end("ok")
  const { rows } = await pool.query("SELECT current_database() AS database, version() AS version")
  response.end(JSON.stringify({ via: process.env.DATABASE_URL?.replace(/\/\/.*@/, "//"), ...rows[0] }))
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`api on ${process.env.PORT}`))
