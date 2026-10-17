type Event = { readonly step: string; readonly by: string }
type Order = { readonly id: number; readonly sku: string; readonly status: string; readonly events: ReadonlyArray<Event> }

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const json = (url: string, init?: RequestInit) => fetch(url, init).then((response) => response.json())
const api = String(process.env.REACT_APP_API_URL)
const graph = String(process.env.GRAPH_URL)
const billing = String(process.env.BILLING_API_URL)

$("#branch").textContent = location.hostname.split(".")[1] ?? ""
$("#api-url").textContent = api
$("#graph-url").textContent = graph
$("#billing-url").textContent = billing
$<HTMLImageElement>("#banner").src = `${process.env.IMAGE_API_URL}/images/banner.svg`
$<HTMLAnchorElement>("#signin").href = String(process.env.SIGN_IN_URL)

const code = new URLSearchParams(location.search).get("code")
if (code) {
  const user = await json(`${api}/auth/callback?code=${code}`)
  localStorage.setItem("user", user.email ?? "")
  history.replaceState(null, "", "/")
}
$("#user").textContent = localStorage.getItem("user") ? `signed in as ${localStorage.getItem("user")}` : "not signed in"

const flags = await json(`${process.env.FLAGS_BASE_URL}/flags`)
$("#flags").textContent = `flags: ${Object.entries(flags)
  .map(([key, on]) => `${key}=${on}`)
  .join(", ")}`

const skus: ReadonlyArray<{ sku: string; name: string }> = await json(`${api}/skus`)
$("#skus").innerHTML = skus.map((item) => `<option value="${item.sku}">${item.name}</option>`).join("")

const row = (order: Order) =>
  `<tr><td>${order.id}</td><td>${order.sku}</td><td>${order.status}</td><td>${order.events.map((event) => `<div>${event.step} <code>${event.by}</code></div>`).join("")}</td></tr>`

const refresh = async () => {
  const orders: ReadonlyArray<Order> = await json(`${api}/orders`)
  $("#orders").innerHTML = orders.map(row).join("")
  $("#charges").textContent = JSON.stringify(await json(`${billing}/charges`), null, 1)
  const result = await json(`${graph}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ meta orders }" })
  })
  $("#graph").textContent = JSON.stringify(result.data, null, 1)
}

$<HTMLFormElement>("#order").addEventListener("submit", async (event) => {
  event.preventDefault()
  const sku = String(new FormData(event.target as HTMLFormElement).get("sku"))
  await json(`${api}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku, email: localStorage.getItem("user") || "guest@example.com" })
  })
  await refresh()
})

setInterval(refresh, 1500)
await refresh()
