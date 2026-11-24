import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { AbsolutePath, BranchSlug, Port, ProjectName, WorktreeId } from "../src/Ids.ts"
import * as Temporal from "../src/infra/Temporal.ts"
import { InfraError, type InfraServer, type InfraTools, type Worktree } from "../src/Stack.ts"

const worktree: Worktree = {
  id: WorktreeId.make("main.shop"),
  project: ProjectName.make("shop"),
  branch: BranchSlug.make("main"),
  root: AbsolutePath.make("/repo"),
  profile: "default",
  domain: "main.shop.localhost",
  proxyPort: Port.make(80)
}

const server: InfraServer = {
  port: Port.make(7233),
  env: { TEMPORAL_HTTP_PORT: "7243" },
  routes: {},
  instance: "temporal",
  urls: {},
  exclusive: (effect) => effect
}

const toolsFailingWith = (message: string): InfraTools => ({
  spawn: () => Effect.die("not used"),
  exec: () => Effect.fail(new InfraError({ infra: "temporal namespace", message }))
})

const tenantWith = (message: string) =>
  Temporal.dev({ scope: "shared", namespaces: ["orders"] })
    .tenant(server, worktree, toolsFailingWith(message))
    .pipe(Effect.scoped, Effect.exit)

describe("temporal namespaces", () => {
  it.effect("carry on when the namespace already exists", () =>
    Effect.gen(function* () {
      expect(Exit.isSuccess(yield* tenantWith("Namespace main.shop-orders already exists"))).toBe(true)
    })
  )

  it.effect("fail the tenant when creating a namespace fails for any other reason", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* tenantWith("connection refused"))).toBe(true)
    })
  )
})
