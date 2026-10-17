import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import pg from "pg"

export type Reply = { readonly status?: number; readonly headers?: Readonly<Record<string, string>>; readonly body: unknown }

export type Handler = (request: IncomingMessage, params: Readonly<Record<string, string>>, url: URL) => Promise<Reply>

export const branch = process.env.FORKYARD_BRANCH ?? "local"

export const who = (service: string) => `${service} pid ${process.pid} on ${branch}`

export const ok = (body: unknown, status = 200): Reply => ({ status, body })

export const readJson = async (request: IncomingMessage): Promise<Record<string, any>> => {
  const text = Buffer.concat((await request.toArray()) as Array<Buffer>).toString()
  return text ? JSON.parse(text) : {}
}

export const required = (key: string) => {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is not set`)
  return value
}

export const pool = () =>
  new pg.Pool({
    max: 4,
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          user: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE
        })
  })

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)

const allowCors = (request: IncomingMessage, response: ServerResponse) => {
  const origin = request.headers.origin
  if (!origin) return
  if (!allowedOrigins.includes(origin) && !allowedOrigins.includes("*")) return
  response.setHeader("access-control-allow-origin", origin)
  response.setHeader("access-control-allow-credentials", "true")
  response.setHeader("access-control-allow-headers", "content-type, authorization, x-internal-secret")
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS")
}

const compile = (pattern: string) => {
  const [method, path] = pattern.split(" ") as [string, string]
  const names = [...path.matchAll(/:(\w+)/g)].map((match) => match[1]!)
  const regex = new RegExp(`^${path.replaceAll(/:(\w+)/g, "([^/]+)").replace(/\*$/, "(.*)")}$`)
  return { method, regex, names }
}

const send = (response: ServerResponse, reply: Reply) => {
  const raw = typeof reply.body === "string" || Buffer.isBuffer(reply.body)
  response.writeHead(reply.status ?? 200, { "content-type": raw ? "text/plain" : "application/json", ...reply.headers })
  response.end(raw ? reply.body : JSON.stringify(reply.body))
}

export const serve = (name: string, port: number, routes: Readonly<Record<string, Handler>>) => {
  const table = Object.entries(routes).map(([pattern, handler]) => ({ ...compile(pattern), handler }))

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    allowCors(request, response)
    if (request.method === "OPTIONS") return send(response, { status: 204, body: "" })
    const url = new URL(request.url ?? "/", "http://local")
    const route = table.find((entry) => entry.method === request.method && entry.regex.test(url.pathname))
    if (!route) return send(response, { status: 404, body: { error: `no route for ${request.method} ${url.pathname}` } })
    const values = route.regex.exec(url.pathname)!.slice(1)
    const params = Object.fromEntries(route.names.map((key, index) => [key, decodeURIComponent(values[index] ?? "")]))
    const reply = await route.handler(request, params, url).catch((error: Error) => ({ status: 500, body: { error: error.message } }))
    send(response, reply)
  }

  return createServer((request, response) => void handle(request, response)).listen(port, "127.0.0.1", () =>
    console.log(`${name} listening on ${port}, ${who(name)}`)
  )
}

export const internalSecretOk = (request: IncomingMessage) =>
  request.headers["x-internal-secret"] === process.env.INTERNAL_HTTP_SHARED_SECRET

export const post = async (url: string, body: unknown, headers: Readonly<Record<string, string>> = {}) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`POST ${url} -> ${response.status} ${await response.text()}`)
  return response.json()
}
