import { ok, readJson, required, serve } from "@northwind/kit"
import { randomUUID } from "node:crypto"

const issuer = required("ISSUER")
const postLogin = required("DEFAULT_POST_LOGIN_URL")
const clients: ReadonlyArray<{ id: string; redirect_uris: ReadonlyArray<string> }> = JSON.parse(required("CLIENTS_JSON"))
const codes = new Map<string, string>()

serve("auth", Number(required("PORT")), {
  "GET /health": async () => ok({ ok: true }),
  "GET /.well-known/openid-configuration": async () =>
    ok({ issuer, token_endpoint: `${issuer}/token`, authorization_endpoint: `${required("UI_ORIGIN")}/` }),
  "GET /clients": async () => ok(clients),
  "POST /login": async (request) => {
    const { email } = await readJson(request)
    const code = randomUUID()
    codes.set(code, String(email))
    return ok({ redirect: `${postLogin}?code=${code}` })
  },
  "POST /token": async (request) => {
    const { code } = await readJson(request)
    const email = codes.get(String(code))
    if (!email) return ok({ error: "unknown code" }, 400)
    return ok({ email, issuer })
  }
})
