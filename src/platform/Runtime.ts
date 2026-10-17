export type RuntimeName = "node" | "bun"

export const runtimeName: RuntimeName = typeof process.versions.bun === "string" ? "bun" : "node"

export const bunFlags = ["--no-env-file", "--no-install", "--config=/dev/null"]

export const runtimeFlags = runtimeName === "bun" ? bunFlags : ["--no-warnings"]
