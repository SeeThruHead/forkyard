import { readFileSync } from "node:fs"
import { createServer } from "node:http"

const data = JSON.parse(readFileSync("data.json", "utf8"))
createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(
    JSON.stringify({ path: request.url, greeting: process.env.GREETING, migratedAt: data.migratedAt, branch: process.env.FORKYARD_BRANCH })
  )
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`api on ${process.env.PORT}`))
