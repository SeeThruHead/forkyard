const target = `${process.env.BILLING_PUBLIC_URL ?? "http://localhost:3100"}/webhooks/provider`
console.log(`registered provider webhook -> ${target} (key ${String(process.env.PROVIDER_API_KEY).slice(0, 5)}...)`)
