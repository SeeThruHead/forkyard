import { branch, ok, serve } from "@northwind/kit"

const store = `${process.env.OBJECT_STORE_URL}/${process.env.IMAGE_BUCKET}`

const avatar = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="60"><rect width="220" height="60" rx="8" fill="#1f4bd8"/>` +
  `<text x="110" y="37" font-family="sans-serif" font-size="16" fill="white" text-anchor="middle">${text}</text></svg>`

await fetch(`${store}/banner.svg`, { method: "PUT", body: avatar(`image-api on ${branch}`) })

serve("image-api", Number(process.env.PORT ?? 4401), {
  "GET /health": async () => ok({ ok: true }),
  "GET /images/:name": async (_request, params) => {
    const response = await fetch(`${store}/${params.name}`)
    return { status: response.status, headers: { "content-type": "image/svg+xml" }, body: await response.text() }
  }
})
