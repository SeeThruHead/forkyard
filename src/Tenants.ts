import { Clock, Context, Effect, Layer, Ref, Schema, type Scope } from "effect"
import { SqlClient } from "effect/sql"
import { AbsolutePath, BranchSlug, type InfraName, Port, ProjectName, WorktreeId } from "./Ids.ts"
import { reapable } from "./infra/Reaping.ts"
import type { Worktree } from "./Stack.ts"

const StoredWorktree = Schema.Struct({
  id: WorktreeId,
  project: ProjectName,
  branch: BranchSlug,
  root: AbsolutePath,
  profile: Schema.String,
  domain: Schema.String,
  proxyPort: Port
})

const decodeWorktree = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredWorktree))

const TenantRow = Schema.Struct({
  tenant: Schema.String,
  worktree: Schema.String,
  root: Schema.String,
  last_used: Schema.Number
})

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(TenantRow))

const liveKey = (infra: InfraName, instance: string, tenant: string) => `${infra}|${instance}|${tenant}`

const adjust = (key: string, by: number) => (live: Readonly<Record<string, number>>) => {
  const count = (live[key] ?? 0) + by
  if (count > 0) return { ...live, [key]: count }
  return Object.fromEntries(Object.entries(live).filter(([other]) => other !== key))
}

export class Tenants extends Context.Service<
  Tenants,
  {
    readonly use: (infra: InfraName, instance: string, tenant: Worktree) => Effect.Effect<void, never, Scope.Scope>
    readonly unused: (infra: InfraName, instance: string, graceMillis: number) => Effect.Effect<ReadonlyArray<Worktree>>
    readonly forget: (infra: InfraName, instance: string, tenant: string) => Effect.Effect<void>
  }
>()("forkyard/Tenants") {
  static readonly layer = Layer.effect(
    Tenants,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const live = yield* Ref.make<Readonly<Record<string, number>>>({})

      const stamp = (infra: InfraName, instance: string, tenant: Worktree) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(
            (now) =>
              sql`INSERT INTO infra_tenants (infra, instance, tenant, worktree, root, last_used)
                VALUES (${infra}, ${instance}, ${tenant.id}, ${JSON.stringify(tenant)}, ${tenant.root}, ${now})
                ON CONFLICT (infra, instance, tenant, root) DO UPDATE SET last_used = excluded.last_used, worktree = excluded.worktree`
          ),
          Effect.orDie,
          Effect.asVoid
        )

      const use = (infra: InfraName, instance: string, tenant: Worktree) => {
        const key = liveKey(infra, instance, tenant.id)
        return Effect.acquireRelease(Ref.update(live, adjust(key, 1)).pipe(Effect.andThen(stamp(infra, instance, tenant))), () =>
          Ref.update(live, adjust(key, -1)).pipe(Effect.andThen(stamp(infra, instance, tenant)))
        )
      }

      const rowsOf = (infra: InfraName, instance: string) =>
        sql`SELECT tenant, worktree, root, last_used FROM infra_tenants WHERE infra = ${infra} AND instance = ${instance}`.pipe(
          Effect.flatMap(decodeRows),
          Effect.orDie
        )

      const liveTenants = (infra: InfraName, instance: string) =>
        Ref.get(live).pipe(
          Effect.map(
            (all) =>
              new Set(
                Object.keys(all)
                  .filter((key) => key.startsWith(liveKey(infra, instance, "")))
                  .map((key) => key.slice(liveKey(infra, instance, "").length))
              )
          )
        )

      const unused = Effect.fn("Tenants.unused")(function* (infra: InfraName, instance: string, graceMillis: number) {
        const rows = yield* rowsOf(infra, instance)
        const usages = rows.map((row) => ({ tenant: row.tenant, root: row.root, lastUsed: row.last_used }))
        const now = yield* Clock.currentTimeMillis
        const doomed = reapable(usages, yield* liveTenants(infra, instance), now, graceMillis)
        return yield* Effect.forEach(doomed, (tenant) =>
          decodeWorktree(rows.find((row) => row.tenant === tenant)?.worktree ?? "").pipe(Effect.orDie)
        )
      })

      const forget = (infra: InfraName, instance: string, tenant: string) =>
        sql`DELETE FROM infra_tenants WHERE infra = ${infra} AND instance = ${instance} AND tenant = ${tenant}`.pipe(
          Effect.orDie,
          Effect.asVoid
        )

      return Tenants.of({ use, unused, forget })
    })
  )
}
