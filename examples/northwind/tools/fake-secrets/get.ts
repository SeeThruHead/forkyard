import { readFileSync } from "node:fs"

const [secretId, key] = process.argv.slice(2)
const store = JSON.parse(readFileSync(new URL("./secrets.json", import.meta.url), "utf8"))
const value = store[secretId ?? ""]?.[key ?? ""]
if (value === undefined) throw new Error(`no secret ${secretId} ${key}`)
process.stdout.write(value)
