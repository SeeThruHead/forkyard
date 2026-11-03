import { NodeCrypto, NodeFileSystem, NodePath, NodeStdio, NodeTerminal } from "@effect/platform-node"
import { Layer } from "effect"
import * as Os from "./platform/Os.ts"

export const layer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeCrypto.layerSecureRandom,
  NodeStdio.layer,
  NodeTerminal.layer,
  Os.layer
)
