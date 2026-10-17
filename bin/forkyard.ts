#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { packageRoot } from "../src/Package.ts"
import { runInstead } from "../src/platform/Os.ts"
import { runtimeName } from "../src/platform/Runtime.ts"

const centralCommands = ["daemon", "service", "update"]

const installedAbove = (dir: string): string | undefined => {
  const candidate = join(dir, "node_modules", "forkyard")
  if (existsSync(candidate)) return realpathSync(candidate)
  const parent = dirname(dir)
  if (parent === dir) return undefined
  return installedAbove(parent)
}

const tooOld = (repoCopy: string) => {
  console.error(`forkyard: this repo's forkyard (${repoCopy}) is too old to hand over to, using the global one`)
  return undefined
}

const repoLauncher = () => {
  if (centralCommands.includes(process.argv[2] ?? "")) return undefined
  const repoCopy = installedAbove(process.cwd())
  if (!repoCopy) return undefined
  if (repoCopy === realpathSync(packageRoot)) return undefined
  const launcher = join(repoCopy, "launcher", "forkyard")
  if (!existsSync(launcher)) return tooOld(repoCopy)
  return launcher
}

const launcher = repoLauncher()

if (launcher) process.exit(runInstead(launcher, process.argv.slice(2), { FORKYARD_RUNTIME: runtimeName }))

await import("./cli.ts")
