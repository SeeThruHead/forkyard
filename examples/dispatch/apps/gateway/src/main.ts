import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { ServerLive } from "./Server.ts"
import { TelemetryLive } from "./Telemetry.ts"

NodeRuntime.runMain(Layer.launch(ServerLive.pipe(Layer.provide(TelemetryLive))))
