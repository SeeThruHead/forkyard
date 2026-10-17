import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const protocolVersion = 1

const ownsPackage = (dir: string) => {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return false
  return JSON.parse(readFileSync(file, "utf8")).name === "forkyard"
}

const findRoot = (dir: string): string => {
  if (ownsPackage(dir)) return dir
  const parent = dirname(dir)
  if (parent === dir) throw new Error("forkyard cannot find its own package.json")
  return findRoot(parent)
}

export const isCompiled = import.meta.url.includes("/$bunfs/")

export const packageRoot = isCompiled ? dirname(realpathSync(process.execPath)) : findRoot(dirname(fileURLToPath(import.meta.url)))

export const packageVersion: string = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version

export const fromPackage = (...parts: ReadonlyArray<string>) => join(packageRoot, ...parts)

export const isSourceCheckout = existsSync(join(packageRoot, ".git"))

export const defaultHome = isSourceCheckout ? fromPackage("run") : join(homedir(), ".forkyard")

const findCli = () => {
  if (isCompiled) return process.execPath
  if (isSourceCheckout) return fromPackage("bin", "forkyard")
  return fromPackage("launcher", "forkyard")
}

export const cliPath = findCli()

export const dashboardDir = fromPackage("dashboard", "dist")

export const telemetryDir = fromPackage("telemetry")
