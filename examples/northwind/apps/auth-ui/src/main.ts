const origin = import.meta.env.VITE_AUTH_API_ORIGIN as string
document.querySelector("#origin")!.textContent = origin
document.querySelector("#branch")!.textContent = location.hostname.split(".")[1] ?? ""

document.querySelector<HTMLFormElement>("#login")!.addEventListener("submit", async (event) => {
  event.preventDefault()
  const email = String(new FormData(event.target as HTMLFormElement).get("email"))
  const response = await fetch(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email })
  })
  location.href = (await response.json()).redirect
})
