import { ok, serve } from "@northwind/kit"

const object = `${process.env.OBJECT_STORE_URL}/catalog/skus.json`
const seed = [
  { sku: "MUG-01", name: "Ceramic mug", price: 14 },
  { sku: "LAMP-03", name: "Desk lamp", price: 48 },
  { sku: "TOTE-05", name: "Canvas tote", price: 18 }
]

const existing = await fetch(object)
if (!existing.ok) await fetch(object, { method: "PUT", body: JSON.stringify(seed) })

serve("catalog", Number(process.env.CATALOG_PORT ?? 4424), {
  "GET /health": async () => ok({ ok: true }),
  "GET /skus": async () => ok(await (await fetch(object)).json())
})
