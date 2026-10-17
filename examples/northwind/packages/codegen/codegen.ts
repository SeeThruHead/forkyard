import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import pg from "pg"

const target = process.argv[2] ?? "generated/schema.ts"
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
const { rows } = await client.query<{ table_name: string; columns: Array<string> }>(`
  SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
  FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name ORDER BY table_name`)
await client.end()

const body = rows.map((row) => `  ${row.table_name}: ${JSON.stringify(row.columns)}`).join(",\n")
await mkdir(dirname(target), { recursive: true })
await writeFile(target, `export const schema = {\n${body}\n} as const\n`)
console.log(`wrote ${target}: ${rows.length} tables`)
