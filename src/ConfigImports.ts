import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { fromPackage, packageRoot } from "./Package.ts"

const fromDaemon = pathToFileURL(fromPackage("package.json")).href

const rootUrl = pathToFileURL(`${packageRoot}/`).href

const isForkyard = (specifier: string) => specifier === "forkyard" || specifier.startsWith("forkyard/")

const isEffect = (specifier: string) => specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@effect/")

const fromOutside = (parentURL: string | undefined) => !parentURL?.startsWith(rootUrl)

export const supplyConfigImports = () =>
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      if (isForkyard(specifier)) return nextResolve(specifier, { ...context, parentURL: fromDaemon })
      if (isEffect(specifier) && fromOutside(context.parentURL)) return nextResolve(specifier, { ...context, parentURL: fromDaemon })
      return nextResolve(specifier, context)
    }
  })
