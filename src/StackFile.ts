import { Effect, type FileSystem, Option, type Path } from "effect"
import { AbsolutePath } from "./Ids.ts"

export const stackFileLocations = ["forkyard.config.ts", "tools/forkyard/forkyard.config.ts"] as const

export const findStackFile = (fs: FileSystem.FileSystem, path: Path.Path, root: string) =>
  Effect.findFirst(
    stackFileLocations.map((location) => path.join(root, location)),
    (file) => fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  ).pipe(Effect.map(Option.map(AbsolutePath.make)))
