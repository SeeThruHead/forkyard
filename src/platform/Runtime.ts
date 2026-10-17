export type RuntimeName = "node" | "bun"

export const runtimeName: RuntimeName = typeof process.versions.bun === "string" ? "bun" : "node"
