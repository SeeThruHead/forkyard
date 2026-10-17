import { NodeCrypto, NodeFileSystem, NodePath, NodeStdio, NodeTerminal } from "@effect/platform-node"
import { Layer } from "effect"

export const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, NodeStdio.layer, NodeTerminal.layer)
