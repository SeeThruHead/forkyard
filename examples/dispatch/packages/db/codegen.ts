import { readdir, readFile, writeFile } from "node:fs/promises"

const migrations = new URL("./migrations/", import.meta.url)
const target = new URL("./src/tables.ts", import.meta.url)

const tableNames = (sql: string) => [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])

const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()
const sources = await Promise.all(files.map((file) => readFile(new URL(file, migrations), "utf8")))
const tables = sources.flatMap(tableNames)

const generated = `export const tables = ${JSON.stringify(tables)} as const\n\nexport type Table = (typeof tables)[number]\n`
const current = await readFile(target, "utf8").catch(() => "")

if (current === generated) console.log(`tables.ts already lists ${tables.length} tables`)
if (current !== generated) await writeFile(target, generated)
if (current !== generated) console.log(`wrote tables.ts with ${tables.length} tables: ${tables.join(", ")}`)
