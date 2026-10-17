import { readdir, readFile } from "node:fs/promises"
import pg from "pg"

const dir = new URL("./migrations/", import.meta.url)
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

await client.connect()
await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((row) => row.name))
const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort()
const pending = files.filter((file) => !applied.has(file))
const database = (await client.query("SELECT current_database() AS name")).rows[0].name

console.log(`${database}: ${applied.size} applied, ${pending.length} pending`)
await pending.reduce(
  (previous, file) =>
    previous.then(async () => {
      const sql = await readFile(new URL(file, dir), "utf8")
      await client.query("BEGIN")
      await client.query(sql)
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file])
      await client.query("COMMIT")
      console.log(`applied ${file}`)
    }),
  Promise.resolve()
)
await client.end()
