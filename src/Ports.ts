import { Context, Effect, Layer, Predicate, Schema } from "effect"
import { createServer } from "node:net"

export class PortError extends Schema.TaggedError<PortError>()("PortError", {
  message: Schema.String
}) {}

export const allocatePort = Effect.callback<number, PortError>((resume) => {
  const server = createServer()
  server.once("error", (error) => resume(Effect.fail(new PortError({ message: error.message }))))
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    const port = Predicate.isNullish(address) || Predicate.isString(address) ? 0 : address.port
    server.close(() => resume(Effect.succeed(port)))
  })
})

export class Ports extends Context.Service<Ports, {
  readonly allocate: Effect.Effect<number, PortError>
}>()("forkyard/Ports") {
  static readonly layer = Layer.succeed(
    Ports,
    Ports.of({ allocate: allocatePort })
  )
}
