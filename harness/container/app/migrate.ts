import { writeFileSync } from "node:fs"

writeFileSync("data.json", JSON.stringify({ migratedAt: new Date().toISOString() }))
console.log("migrated")
