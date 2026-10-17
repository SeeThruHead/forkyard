import { SQL } from "bun"

const sql = new SQL(process.env.DATABASE_URL!)
await sql`CREATE TABLE IF NOT EXISTS links (
  code text PRIMARY KEY,
  target text NOT NULL,
  clicks integer NOT NULL DEFAULT 0,
  checked_by text,
  created_at timestamptz NOT NULL DEFAULT now()
)`
const [{ name }] = await sql`SELECT current_database() AS name`
console.log(`migrated ${name}`)
await sql.close()
