import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { readFileSync } from "node:fs"
import { DaemonInfo, Snapshot, UsageMap } from "../src/Model.ts"
import { protocolVersion } from "../src/Package.ts"
import { ForkyardRpcs } from "../src/Protocol.ts"

const fixture = (version: number, name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./protocol/v${version}/${name}.json`, import.meta.url), "utf8"))

const publicRpcs = ["Info", "Status", "Usage", "Up", "Down", "Restart", "Own", "Share", "Runs", "RunLog", "Env", "DaemonLogs", "Logs"]

describe("public protocol", () => {
  it("keeps every public RPC", () => {
    const tags = [...ForkyardRpcs.requests.keys()]
    expect(publicRpcs.filter((tag) => !tags.includes(tag))).toEqual([])
  })

  it("still reads what protocol 1 daemons sent", () => {
    expect(() => Schema.decodeUnknownSync(Snapshot)(fixture(1, "status"))).not.toThrow()
    expect(() => Schema.decodeUnknownSync(UsageMap)(fixture(1, "usage"))).not.toThrow()
    expect(() => Schema.decodeUnknownSync(DaemonInfo)(fixture(1, "info"))).not.toThrow()
  })

  it("has a fixture for the current protocol version", () => {
    expect(() => fixture(protocolVersion, "status")).not.toThrow()
  })
})
