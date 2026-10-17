const propertyName = (member) => (member.property.type === "Identifier" ? member.property.name : String(member.property.value))

const isEffectMember = (node, names) =>
  node?.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === "Effect" &&
  names.includes(propertyName(node))

const isEffectCall = (node, names) => node?.type === "CallExpression" && isEffectMember(node.callee, names)

const fileIs = (context, suffix) => context.filename.replaceAll("\\", "/").endsWith(suffix)

const unscopedRunners = [
  "runFork",
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
  "runCallback",
  "forkDetach",
  "forkDaemon",
  "forkIn"
]

const spawnerModules = ["effect/process", "node:child_process", "child_process"]

const spawnerExports = ["NodeServices", "NodeChildProcessSpawner"]

const scopedProcesses = {
  meta: {
    type: "problem",
    docs: {
      description: "Only Proc may start processes, nothing may run or fork work outside a scope, and only the reaper may send signals"
    }
  },
  create: (context) => ({
    ImportDeclaration: (node) => {
      if (fileIs(context, "src/Proc.ts")) return
      if (spawnerModules.includes(node.source.value))
        context.report({
          node,
          message: `Only src/Proc.ts may import ${node.source.value}. Start processes through Proc so their lifetime is scoped.`
        })
      node.specifiers
        .filter((specifier) => specifier.type === "ImportSpecifier" && spawnerExports.includes(specifier.imported.name))
        .forEach((specifier) =>
          context.report({
            node: specifier,
            message: `${specifier.imported.name} carries the process spawner. Use Platform.layer, and start processes through Proc.`
          })
        )
    },
    MemberExpression: (node) => {
      if (isEffectMember(node, unscopedRunners))
        context.report({
          node,
          message: `Effect.${propertyName(node)} runs work outside a scope. Use forkScoped, a FiberMap, or run the program once at the entry point.`
        })
      if (
        node.object.type === "Identifier" &&
        node.object.name === "process" &&
        propertyName(node) === "kill" &&
        !fileIs(context, "src/Registry.ts")
      ) {
        context.report({ node, message: "Only the Registry's reaper may signal processes. Close the process's scope instead." })
      }
    }
  })
}

const isGenWrapperBody = (body) => {
  if (isEffectCall(body, ["gen"])) return true
  return (
    body?.type === "CallExpression" &&
    body.callee.type === "MemberExpression" &&
    propertyName(body.callee) === "pipe" &&
    isEffectCall(body.callee.object, ["gen"])
  )
}

const returnedExpression = (fn) => {
  if (fn.body.type !== "BlockStatement") return fn.body
  const [only] = fn.body.body
  return fn.body.body.length === 1 && only.type === "ReturnStatement" ? only.argument : undefined
}

const isNamedFunction = (node) => {
  if (node.type === "FunctionDeclaration") return true
  return ["VariableDeclarator", "Property", "PropertyDefinition", "MethodDefinition"].includes(node.parent?.type)
}

const noGenWrapper = {
  meta: {
    type: "suggestion",
    docs: { description: "A function that only returns Effect.gen should be Effect.fn (traced) or Effect.fnUntraced" }
  },
  create: (context) => {
    const check = (node) => {
      if (node.generator) return
      if (!isNamedFunction(node)) return
      if (isGenWrapperBody(returnedExpression(node)))
        context.report({
          node,
          message: 'This function only wraps Effect.gen. Write it as Effect.fn("Module.name")(function*(...) {...}) or Effect.fnUntraced.'
        })
    }
    return { ArrowFunctionExpression: check, FunctionExpression: check, FunctionDeclaration: check }
  }
}

export default {
  meta: { name: "forkyard" },
  rules: {
    "scoped-processes": scopedProcesses,
    "no-gen-wrapper": noGenWrapper
  }
}
