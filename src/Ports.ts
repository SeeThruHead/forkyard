import { Effect, Predicate, Schema } from "effect"
import { createServer } from "node:net"
import { Port } from "./Ids.ts"

export class PortError extends Schema.TaggedError<PortError>()("PortError", {
  message: Schema.String
}) {}

const listeningPort = (address: ReturnType<ReturnType<typeof createServer>["address"]>) =>
  Predicate.isNullish(address) || Predicate.isString(address) ? 0 : address.port

export const allocatePort = Effect.callback<Port, PortError>((resume) => {
  const server = createServer()
  server.once("error", (error) => resume(Effect.fail(new PortError({ message: error.message }))))
  server.listen(0, "127.0.0.1", () => {
    const port = listeningPort(server.address())
    server.close(() => resume(Port.makeEffect(port).pipe(Effect.mapError(() => new PortError({ message: `no port allocated (${port})` })))))
  })
})

export const takenOnLoopback = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createServer()
    server.once("error", (error: NodeJS.ErrnoException) => resume(Effect.succeed(error.code === "EADDRINUSE")))
    server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.succeed(false))))
  })
