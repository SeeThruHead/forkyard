import { describe, expect, it } from "@effect/vitest"
import { requestsByRoute } from "../src/Activity.ts"

describe("activity", () => {
  it("adds up each route's requests across status codes and methods", () => {
    const metrics = [
      "# HELP traefik_router_requests_total How many HTTP requests are processed on a router",
      'traefik_router_requests_total{code="200",method="GET",protocol="http",router="admin-feat-shop-localhost@file",service="admin-feat-shop-localhost@file"} 12',
      'traefik_router_requests_total{code="404",method="GET",protocol="http",router="admin-feat-shop-localhost@file",service="admin-feat-shop-localhost@file"} 3',
      'traefik_router_requests_total{code="200",method="POST",protocol="http",router="api-feat-shop-localhost@file",service="api-feat-shop-localhost@file"} 1e+00',
      'traefik_service_requests_total{code="200",method="GET",protocol="http",service="admin-feat-shop-localhost@file"} 99'
    ].join("\n")
    expect(requestsByRoute(metrics)).toEqual({ "admin-feat-shop-localhost": 15, "api-feat-shop-localhost": 1 })
  })
})
