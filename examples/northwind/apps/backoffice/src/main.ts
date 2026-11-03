const $ = (selector: string) => document.querySelector<HTMLElement>(selector)!
const json = (url: string, init?: RequestInit) => fetch(url, init).then((response) => response.json())

type Charge = { readonly id: number; readonly order_id: number; readonly status: string; readonly handled_by: string }

const flagsUrl = String(process.env.FLAGS_BASE_URL)
$("#branch").textContent = location.hostname.split(".")[1] ?? ""
$("#flags-url").textContent = flagsUrl

const renderFlags = (flags: Record<string, boolean>) => {
  $("#flags").innerHTML = Object.entries(flags)
    .map(([key, on]) => `<label><input type="checkbox" data-flag="${key}" ${on ? "checked" : ""}/> ${key}</label> `)
    .join("")
}

$("#flags").addEventListener("change", async (event) => {
  const box = event.target as HTMLInputElement
  renderFlags(
    await json(`${flagsUrl}/flags/${box.dataset.flag}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: box.checked })
    })
  )
})

const refresh = async () => {
  const charges: ReadonlyArray<Charge> = await json(`${process.env.BILLING_API_URL}/charges`)
  $("#charges").innerHTML = charges
    .map(
      (charge) =>
        `<tr><td>${charge.id}</td><td>${charge.order_id}</td><td>${charge.status}</td><td><code>${charge.handled_by}</code></td></tr>`
    )
    .join("")
  $("#kyc").textContent = JSON.stringify(await json(`${process.env.REACT_APP_API_URL}/kyc`), null, 1)
  const graph = await json(`${process.env.GRAPH_API_URL}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ orders }" })
  })
  $("#graph").textContent = JSON.stringify(graph.data, null, 1)
}

renderFlags(await json(`${flagsUrl}/flags`))
setInterval(refresh, 2000)
await refresh()
