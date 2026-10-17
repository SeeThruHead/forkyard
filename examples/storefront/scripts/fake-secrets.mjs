const values = {
  "auth/issuer-url": "https://auth.example.dev/realms/storefront-dev",
  "auth/client-id": "storefront-local-client",
  "payments/secret-key": "sk_test_example_not_a_real_key",
  "app/session-secret": "local-session-secret-from-secret-manager"
}

const key = process.argv[2] ?? ""
const value = values[key]
if (value === undefined) {
  console.error(`fake-secrets: no value for ${key}`)
  process.exit(1)
}
setTimeout(() => process.stdout.write(value), 40)
