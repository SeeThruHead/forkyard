import { ok, serve } from "@northwind/kit"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const root = process.env.OBJECT_STORE_DIR ?? join(process.cwd(), ".data")

const fileOf = (bucket: string, key: string) => join(root, bucket, key)

serve("object-store", Number(process.env.OBJECT_STORE_PORT ?? 4425), {
  "GET /_health": async () => ok({ ok: true }),
  "PUT /:bucket/*": async (request, params, url) => {
    const key = url.pathname.split("/").slice(2).join("/")
    const file = fileOf(params.bucket!, key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, Buffer.concat((await request.toArray()) as Array<Buffer>))
    return ok({ stored: `${params.bucket}/${key}` })
  },
  "GET /:bucket/*": async (_request, params, url) => {
    const key = url.pathname.split("/").slice(2).join("/")
    const body = await readFile(fileOf(params.bucket!, key), "utf8").catch(() => undefined)
    return body === undefined ? ok({ error: "NoSuchKey" }, 404) : { status: 200, body }
  }
})
