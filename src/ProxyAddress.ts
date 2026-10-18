import { Context } from "effect"
import type { Port } from "./Ids.ts"

export class ProxyAddress extends Context.Service<
  ProxyAddress,
  {
    readonly port: Port
    readonly url: (host: string) => string
  }
>()("forkyard/ProxyAddress") {}
