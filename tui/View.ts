import type { AbsolutePath, WorktreeId } from "../src/Ids.ts"

export type View =
  | { readonly _tag: "Home" }
  | { readonly _tag: "Worktree"; readonly id: WorktreeId }
  | { readonly _tag: "Checkout"; readonly root: AbsolutePath; readonly branch: string }
