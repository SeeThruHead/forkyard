import { readdir, readFile, writeFile } from "node:fs/promises"

const migrations = new URL("./migrations/", import.meta.url)
const files = (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()
const sql = (await Promise.all(files.map((file) => readFile(new URL(file, migrations), "utf8")))).join("\n")
const tables = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1])
await writeFile(new URL("./client.ts", import.meta.url), `export const tables = ${JSON.stringify(tables)} as const\n`)
console.log(`generated billing client for ${tables.join(", ")}`)
