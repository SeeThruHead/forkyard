import { describe, expect, it } from "@effect/vitest"
import { routeId } from "../src/Router.ts"

describe("route ids", () => {
  it("keep hostnames apart when a dot and a dash swap places", () => {
    expect(routeId("api.a-b.shop.localhost")).not.toBe(routeId("api.a.b-shop.localhost"))
    expect(routeId("web-admin.main.shop.localhost")).not.toBe(routeId("web.admin-main.shop.localhost"))
  })
})
