import { escape, html, listen, page, panel, readForm, redirect, table } from "@storefront/ui"
import { createServer } from "node:http"

const api = process.env.API_URL
const branch = process.env.FORKYARD_BRANCH ?? "local"

const get = async (path) => {
  const response = await fetch(`${api}${path}`)
  return response.ok ? response.json() : undefined
}

const home = async (response) => {
  const [about, products, orders, giftCards] = await Promise.all([
    get("/api/info"),
    get("/api/products"),
    get("/api/orders"),
    get("/api/gift-cards")
  ])
  const giftCardSection = giftCards
    ? `<h2>Gift cards <span class="muted">(only on this branch)</span></h2>${table(
        ["Code", "Balance", "Status"],
        giftCards.map((card) => [card.code, `$${card.balance}`, card.status])
      )}`
    : ""
  const options = products.map((product) => `<option value="${product.id}">${escape(product.name)}</option>`).join("")
  html(
    response,
    page({
      app: "shop",
      title: "shop",
      branch,
      body: `<h2>This worktree</h2>${panel([
        ["shop pid", process.pid],
        ["talks to api at", api],
        ["api pid", about.pid],
        ["database", about.database],
        ["migrations", about.migrations.join(", ")],
        ["auth issuer (shared)", about.auth.issuer]
      ])}
      <h2>Place an order</h2>
      <form method="post" action="/orders"><select name="productId">${options}</select><input name="note" placeholder="A note, stored in this worktree's database"><button>Order</button></form>
      ${table(
        ["#", "Product", "Note", "Placed"],
        orders.map((order) => [order.id, order.product, order.note, new Date(order.created_at).toLocaleTimeString()])
      )}
      ${giftCardSection}
      <h2>Products</h2>${table(
        ["SKU", "Product", "Price", "Stock"],
        products.map((product) => [product.sku, product.name, `$${product.price}`, product.stock])
      )}
      <p class="muted">Server-rendered by the shop; every value above came from the api at <code>${escape(api)}</code>.</p>`
    })
  )
}

listen(
  createServer(async (request, response) => {
    try {
      if (request.url === "/health") return html(response, "ok")
      if (request.method === "POST" && request.url === "/orders") {
        const form = await readForm(request)
        await fetch(`${api}/api/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) })
        return redirect(response, "/")
      }
      return await home(response)
    } catch (error) {
      console.error(error)
      response.writeHead(502, { "content-type": "text/plain" })
      response.end(`shop could not reach the api at ${api}: ${error.message}`)
    }
  }),
  "shop"
)
