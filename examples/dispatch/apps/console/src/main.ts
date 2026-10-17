type DeliveryEvent = { readonly step: string; readonly namespace: string; readonly handledBy: string }
type Delivery = {
  readonly id: number
  readonly address: string
  readonly courier: string | null
  readonly events: ReadonlyArray<DeliveryEvent>
}

const rows = document.querySelector<HTMLTableSectionElement>("#rows")!
const form = document.querySelector<HTMLFormElement>("#create")!

document.querySelector("#branch")!.textContent = location.hostname.split(".")[1] ?? ""

const eventLine = (event: DeliveryEvent) => `<div>${event.step} <code>${event.namespace}, ${event.handledBy}</code></div>`

const row = (delivery: Delivery) =>
  `<tr><td>${delivery.id}</td><td>${delivery.address}</td><td>${delivery.courier ?? ""}</td><td>${delivery.events.map(eventLine).join("")}</td></tr>`

const refresh = async () => {
  const deliveries: ReadonlyArray<Delivery> = await fetch("/api/deliveries").then((response) => response.json())
  rows.innerHTML = deliveries.map(row).join("")
}

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  const address = String(new FormData(form).get("address"))
  await fetch("/api/deliveries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) })
  await refresh()
})

setInterval(refresh, 1000)
await refresh()
