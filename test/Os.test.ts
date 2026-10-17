import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { layerFor, openUrlCommand, Os, osName, unsupportedHere } from "../src/platform/Os.ts"

const script = { shell: "pnpm run dev" }
const binary = { command: "node", args: ["server.ts"] }

const onOs = (name: "darwin" | "linux") => Os.useSync((os) => os).pipe(Effect.provide(layerFor(name)))

describe("platform layers", () => {
  it("maps Node's platform names", () => {
    expect([osName("darwin"), osName("linux"), osName("freebsd")]).toEqual(["darwin", "linux", "linux"])
    expect(unsupportedHere("win32")).toMatch(/WSL/)
    expect(unsupportedHere("linux")).toBeUndefined()
  })

  it.effect("macOS and Linux run shell scripts with /bin/sh in their own process group", () =>
    Effect.gen(function* () {
      const os = yield* onOs("linux")
      expect(os.commandFor(script)).toEqual({ command: "/bin/sh", args: ["-c", "pnpm run dev"] })
      expect(os.commandFor(binary)).toEqual(binary)
      expect(os.spawnGroup.detached).toBe(true)
      expect(os.ipcPath("/home/dev/.forkyard")).toBe("/home/dev/.forkyard/forkyard.sock")
    })
  )

  it.effect("the Docker proxy shares the host network only on Linux", () =>
    Effect.gen(function* () {
      expect((yield* onOs("linux")).dockerProxy(80).args).toEqual(["--network", "host"])
      expect((yield* onOs("darwin")).dockerProxy(80).args).toEqual(["-p", "80:80"])
      expect((yield* onOs("darwin")).dockerUpstream).toBe("host.docker.internal")
    })
  )

  it("opens URLs the way each OS does", () => {
    expect(openUrlCommand("http://x", "darwin").command).toBe("open")
    expect(openUrlCommand("http://x", "linux").command).toBe("xdg-open")
  })
})
