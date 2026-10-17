import { existsSync, readFileSync } from "node:fs"
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

export const packageRoot = findRoot(dirname(fileURLToPath(import.meta.url)))

export const packageVersion: string = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version

export const fromPackage = (...parts: ReadonlyArray<string>) => join(packageRoot, ...parts)

const isSourceCheckout = existsSync(join(packageRoot, ".git"))

export const defaultHome = isSourceCheckout ? fromPackage("run") : join(homedir(), ".forkyard")

export const cliPath = isSourceCheckout ? fromPackage("bin", "forkyard") : fromPackage("dist", "bin", "forkyard.js")

export const dashboardDir = fromPackage("dashboard", "dist")

export const telemetryDir = fromPackage("telemetry")
