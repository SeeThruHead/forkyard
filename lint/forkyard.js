const propertyName = (member) => (member.property.type === "Identifier" ? member.property.name : String(member.property.value))

const isEffectMember = (node, names) =>
  node?.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === "Effect" &&
  names.includes(propertyName(node))

const isEffectCall = (node, names) => node?.type === "CallExpression" && isEffectMember(node.callee, names)

const isFunction = (node) => ["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"].includes(node?.type)

const genConstructors = ["gen", "fn", "fnUntraced"]

const isEffectGenerator = (node) => {
  if (node?.type !== "FunctionExpression" || !node.generator) return false
  const call = node.parent
  if (call?.type !== "CallExpression") return false
  if (isEffectMember(call.callee, genConstructors)) return true
  return isEffectCall(call.callee, ["fn", "fnUntraced"])
}

const enclosingFunction = (context, node) => context.sourceCode.getAncestors(node).filter(isFunction).at(-1)

const insideEffectGenerator = (context, node) => isEffectGenerator(enclosingFunction(context, node))

const anyAncestorIsEffectGenerator = (context, node) => context.sourceCode.getAncestors(node).some(isEffectGenerator)

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

const maxSteps = 10

const containsOwnYield = (node) => {
  if (!node || typeof node !== "object") return false
  if (node.type === "YieldExpression") return true
  if (isFunction(node)) return false
  return Object.entries(node)
    .filter(([key]) => key !== "parent")
    .some(([, value]) => (Array.isArray(value) ? value.some(containsOwnYield) : containsOwnYield(value)))
}

const isStep = (statement) => statement.type !== "VariableDeclaration" || containsOwnYield(statement)

const flatOrchestration = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Effect generator bodies stay at one level of abstraction: no nested Effect.gen, no try, no else, no multi-statement if blocks, and a statement cap"
    }
  },
  create: (context) => ({
    FunctionExpression: (node) => {
      if (!isEffectGenerator(node)) return
      const steps = node.body.body.filter(isStep).length
      if (steps > maxSteps) {
        context.report({
          node,
          message: `This generator has ${steps} steps. Extract named steps until it reads as one level of orchestration (at most ${maxSteps}).`
        })
      }
    },
    CallExpression: (node) => {
      if (isEffectCall(node, ["gen"]) && anyAncestorIsEffectGenerator(context, node)) {
        context.report({
          node,
          message: "Nested Effect.gen inside an Effect generator mixes levels of abstraction. Extract it into a named Effect.fn."
        })
      }
    },
    TryStatement: (node) => {
      if (anyAncestorIsEffectGenerator(context, node))
        context.report({ node, message: "No try/catch inside Effect code. Model the failure as a typed error and handle it at the edge." })
    },
    IfStatement: (node) => {
      if (!insideEffectGenerator(context, node)) return
      if (node.alternate)
        context.report({
          node: node.alternate,
          message: "No else inside an Effect generator. Return early, or extract a function that decides."
        })
      if (node.consequent.type === "BlockStatement" && node.consequent.body.length > 1) {
        context.report({
          node: node.consequent,
          message: "An if block inside an Effect generator should be a single statement. Extract the branch into a named step."
        })
      }
      if (
        node.parent?.type === "IfStatement" ||
        context.sourceCode.getAncestors(node).some((ancestor) => ancestor.type === "IfStatement")
      ) {
        context.report({ node, message: "No nested if statements. Use guard clauses or a named predicate." })
      }
    }
  })
}

const logCalls = ["log", "logInfo", "logWarning", "logError", "logDebug", "logTrace", "logFatal"]

const recoveryCalls = [
  "catch",
  "catchTag",
  "catchTags",
  "catchCause",
  "catchIf",
  "catchDefect",
  "orElse",
  "orElseSucceed",
  "orElseFail",
  "tapError",
  "tapCause",
  "ignore",
  "ignoreLogged"
]

const edgesOnly = {
  meta: {
    type: "suggestion",
    docs: { description: "Logging and error handling belong at the edges of an Effect function, as combinators, not between its steps" }
  },
  create: (context) => ({
    CallExpression: (node) => {
      if (!insideEffectGenerator(context, node)) return
      if (isEffectCall(node, logCalls)) {
        context.report({
          node,
          message:
            "Logging in the middle of an Effect generator. Log at the edge: pass Effect.tap(...) as a combinator to Effect.fn, or log where the effect is run."
        })
      }
    },
    MemberExpression: (node) => {
      if (!insideEffectGenerator(context, node)) return
      if (isEffectMember(node, recoveryCalls)) {
        context.report({
          node,
          message: `Effect.${propertyName(node)} inside a generator body handles errors in the middle. Handle them at the function's edge with a combinator.`
        })
      }
    }
  })
}

const idNames = ["id", "pid", "port", "runId", "worktreeId"]

const primitiveTypes = ["TSStringKeyword", "TSNumberKeyword"]

const isPrimitiveAnnotation = (annotation) => primitiveTypes.includes(annotation?.typeAnnotation?.type)

const brandedIds = {
  meta: {
    type: "problem",
    docs: { description: "Identifiers named like ids, pids and ports must use the branded types from src/Ids.ts" }
  },
  create: (context) => {
    const report = (node, name) =>
      context.report({
        node,
        message: `"${name}" is typed as a bare primitive. Use the branded type from src/Ids.ts so it cannot be mixed up with other strings or numbers.`
      })
    return {
      Identifier: (node) => {
        if (!idNames.includes(node.name)) return
        if (isPrimitiveAnnotation(node.typeAnnotation)) report(node, node.name)
      },
      TSPropertySignature: (node) => {
        const name = node.key.type === "Identifier" ? node.key.name : undefined
        if (!idNames.includes(name)) return
        if (isPrimitiveAnnotation(node.typeAnnotation)) report(node, name)
      }
    }
  }
}

export default {
  meta: { name: "forkyard" },
  rules: {
    "scoped-processes": scopedProcesses,
    "no-gen-wrapper": noGenWrapper,
    "flat-orchestration": flatOrchestration,
    "edges-only": edgesOnly,
    "branded-ids": brandedIds
  }
}
