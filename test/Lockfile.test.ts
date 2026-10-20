import { describe, expect, it } from "@effect/vitest"
import { type Lock, sliceHash } from "../src/inputs/Lockfile.ts"

const lockWith = (barVersion: string): Lock => ({
  importers: {
    ".": { devDependencies: { typescript: { specifier: "^5", version: "5.9.0" } } },
    api: {
      dependencies: {
        foo: { specifier: "^1", version: "1.0.0" },
        "@shop/shared": { specifier: "workspace:*", version: "link:../packages/shared" }
      }
    },
    "apps/admin": { dependencies: { baz: { specifier: "^1", version: "1.0.0" } } }
  },
  snapshots: {
    "typescript@5.9.0": {},
    "foo@1.0.0": { dependencies: { bar: barVersion } },
    [`bar@${barVersion}`]: {},
    "baz@1.0.0": null
  }
})

describe("lockfile slices", () => {
  it("a transitive version change reaches only the services that resolve it", () => {
    const before = lockWith("2.0.0")
    const after = lockWith("2.1.0")
    expect(sliceHash(after, [".", "api"])).not.toEqual(sliceHash(before, [".", "api"]))
    expect(sliceHash(after, [".", "apps/admin"])).toEqual(sliceHash(before, [".", "apps/admin"]))
  })

  it("workspace links count the same wherever the checkout lives", () => {
    const here = lockWith("2.0.0")
    const api = here.importers["api"]!
    const elsewhere = {
      ...here,
      importers: {
        ...here.importers,
        api: {
          dependencies: { ...api.dependencies, "@shop/shared": { specifier: "workspace:*", version: "link:../../../packages/shared" } }
        }
      }
    }
    expect(sliceHash(elsewhere, ["api"])).toEqual(sliceHash(here, ["api"]))
  })

  it("importers missing from the lockfile are ignored", () => {
    const lock = lockWith("2.0.0")
    expect(sliceHash(lock, ["apps/admin", "packages/none"])).toEqual(sliceHash(lock, ["apps/admin"]))
  })
})
