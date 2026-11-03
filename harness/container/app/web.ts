import { createServer } from "node:http"

createServer(async (request, response) => {
  if (request.url === "/health") return response.end("ok")
  const result = await fetch(`${process.env.API_URL}/from-web`)
    .then((reply) => reply.text())
    .catch(
      (error: Error) => `could not reach ${process.env.API_URL}: ${error.cause instanceof Error ? error.cause.message : error.message}`
    )
  response.end(`web sees api: ${result}`)
}).listen(Number(process.env.PORT), "127.0.0.1", () => console.log(`web on ${process.env.PORT}, api at ${process.env.API_URL}`))
