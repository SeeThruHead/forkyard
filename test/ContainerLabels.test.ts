import { describe, expect, it } from "@effect/vitest"
import { labelledContainer } from "../src/ContainerLabels.ts"
import { DaemonId } from "../src/Ids.ts"
import { cmd, shell } from "../src/Stack.ts"

const labels = { daemon: DaemonId.make("d1"), run: "d1-7" }

describe("container labels", () => {
  it("label every docker run with the daemon and the run that started it", () => {
    expect(labelledContainer(cmd("docker", "run", "--rm", "redis:8"), labels)).toEqual(
      cmd("docker", "run", "--label", "forkyard.daemon=d1", "--label", "forkyard.run=d1-7", "--rm", "redis:8")
    )
    expect(labelledContainer(cmd("/usr/bin/docker", "run", "redis:8"), labels)).toEqual(
      cmd("/usr/bin/docker", "run", "--label", "forkyard.daemon=d1", "--label", "forkyard.run=d1-7", "redis:8")
    )
  })

  it("leave other commands alone", () => {
    expect(labelledContainer(cmd("docker", "stop", "x"), labels)).toEqual(cmd("docker", "stop", "x"))
    expect(labelledContainer(cmd("node", "run"), labels)).toEqual(cmd("node", "run"))
    expect(labelledContainer(shell("docker run redis"), labels)).toEqual(shell("docker run redis"))
  })
})
