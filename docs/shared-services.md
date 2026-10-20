# Sharing services between worktrees

## Why

One a large monorepo worktree costs about 4.8 GB, or about 2.7 GB without the TypeScript watchers. Most worktrees change one or two services, yet each one runs the whole stack. On a 24 GB machine that stops at two or three worktrees. The goal is ten.

## The idea

Every service gets a fingerprint: a hash of everything that decides how it behaves. Worktrees whose service has the same fingerprint share one running process. A worktree whose fingerprint differs runs its own. Nothing is special about `main`; whichever worktrees match, share.

A worktree that only touches the admin UI runs one Vite server and shares everything else. A worktree that adds a migration gets its own database and its own copy of every service that reads it.

## What goes into a fingerprint

- **Code.** The service's inputs, hashed by content, uncommitted edits included. Forkyard does not know which files those are; the config tells it through a hook (below).
- **Env.** The service's resolved env, with forkyard's own per-worktree values left out (`PORT`, `FORKYARD_*`, the worktree's hostnames).
- **What it calls.** A value that points at another service's URL is replaced by that service's fingerprint. If graph diverges, api (whose env points at graph) diverges too, so a shared api never calls a graph running different code. Services that call each other in a cycle get one fingerprint for the whole cycle.
- **Infra state.** Each infra piece has a fingerprint too: its spec, plus for a database the inputs that shape its schema (the migrations). A service's fingerprint includes the fingerprints of the infra it uses.

Infra follows the same rule. Redis, NATS and Temporal are shared by every worktree whose infra fingerprint matches, instead of one per worktree. A database is shared the same way: worktrees with the same migrations use one database.

## The inputs hook

Forkyard never calls a build tool. The config gives it one function:

```ts
make("shop", stack, { inputs: moonInputs() })

type Inputs = { readonly files: ReadonlyArray<string> } | { readonly hash: string }
type InputsHook = (service: { readonly name: ServiceName; readonly project?: string }) => Effect<Inputs>
```

- A service names its project (`project: "api"`) when the hook needs it.
- Adapters live outside forkyard's core and shell out to their tool: `forkyard/inputs/moon` first, then Nx, Turborepo or Bazel. A plain glob list is the simplest adapter.
- The moon adapter answers with the service project's source folder plus the source folders of every project it depends on, transitively, from `moon query projects`. a large monorepo's globs stay in moon; nothing is written twice.
- A service the hook has no answer for is never shared. That is today's behavior, so sharing is opt-in.

## Running shared instances

- Instances live in an `RcMap` keyed by fingerprint, the same mechanism shared infra uses today. A worktree holds a lease on each instance it uses; the last lease to go stops the instance.
- Each worktree keeps its own URLs. The router points `api.<branch>.shop.localhost` at whichever instance that worktree uses.
- Env rewriting points a worktree's services at the URLs of the instances it uses.

## When code changes

1. Forkyard already watches each worktree. On a change, it recomputes the fingerprints whose inputs include the changed files.
2. For each service whose fingerprint changed, it starts the new instance, or joins an existing one with that fingerprint.
3. The worktree's route stays on the old instance until the new one is healthy, then moves. During the boot the worktree sees the old code; that is accepted.
4. The worktree releases its lease on the old instance.
5. Reverting a change, or another worktree reaching the same code, makes fingerprints match again. The worktree rejoins the shared instance and its own copy stops.

## Shared state

Worktrees that share a backend share its data and its queues: rows written through one worktree are visible in the others, and one worker consumes jobs for all of them. That follows from sharing the process and is the trade for memory. A worktree that needs isolated data opts out (`isolate: true` on `up`), which gives it its own fingerprints and therefore its own database, queues and processes.

## Building it, in order

1. **Fingerprints, read-only.** Compute and show them in the status, the TUI and the dashboard ("api: shared with main"), without changing what runs. This checks the hook and the moon adapter against real worktrees.
2. **Sharing at start.** Services and infra start once per fingerprint and are leased by worktrees.
3. **Live switch.** Copy-on-write and rejoin as code changes.
4. **Measure.** Ten worktrees on this machine, with the numbers recorded.
