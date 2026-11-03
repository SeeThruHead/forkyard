import { Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const protocolVersion = 1

const nameOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ name: Schema.optional(Schema.String) })))

const versionOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))

const ownsPackage = (dir: string) => {
  const file = join(dir, "package.json")
  if (!existsSync(file)) return false
  return nameOf(readFileSync(file, "utf8")).name === "forkyard"
}

const findRoot = (dir: string): string => {
  if (ownsPackage(dir)) return dir
  const parent = dirname(dir)
  if (parent === dir) throw new Error("forkyard cannot find its own package.json")
  return findRoot(parent)
}

const throughBrewOpt = (root: string) => root.replace(/\/Cellar\/forkyard\/[^/]+\//, "/opt/forkyard/")

export const packageRoot = throughBrewOpt(findRoot(dirname(fileURLToPath(import.meta.url))))

export const packageVersion = versionOf(readFileSync(join(packageRoot, "package.json"), "utf8")).version

export const fromPackage = (...parts: ReadonlyArray<string>) => join(packageRoot, ...parts)

export const isSourceCheckout = existsSync(join(packageRoot, ".git"))

export const defaultHome = isSourceCheckout ? fromPackage("run") : join(homedir(), ".forkyard")

export const cliPath = isSourceCheckout ? fromPackage("bin", "forkyard") : fromPackage("launcher", "forkyard")

export const dashboardDir = fromPackage("dashboard", "dist")

export const httpPortFile = (home: string) => join(home, "http-port")
